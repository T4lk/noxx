//! Spotify: public links through the embed page (no login), and the user's own
//! library through the official Web API with their own app's Client ID (PKCE).

use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use regex::Regex;
use serde_json::{json, Value};

use super::{http, Item, Remote, UA};

pub const REDIRECT_PORT: u16 = 43827;
pub const REDIRECT_URI: &str = "http://127.0.0.1:43827/callback";
const SCOPES: &str = "user-library-read playlist-read-private playlist-read-collaborative";

static LINK: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?:open\.spotify\.com/(?:intl-[a-zA-Z-]+/)?(?:embed/)?|spotify:)(playlist|album|track)[/:]([A-Za-z0-9]{22})").unwrap()
});
static NEXT_DATA: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)</script>"#).unwrap());

pub fn parse_link(text: &str) -> Option<(String, String)> {
    let c = LINK.captures(text)?;
    Some((c[1].to_string(), c[2].to_string()))
}

fn secs(ms: &Value) -> u64 {
    ms.as_f64().map(|v| (v / 1000.0).round() as u64).unwrap_or(0)
}

fn s(v: &Value) -> String {
    v.as_str().unwrap_or("").trim().to_string()
}

/// Public playlist/album/track. Uses the Web API when an account is connected (full lists),
/// otherwise the embed page (playlists stop at 100 tracks there).
pub async fn fetch(data_dir: &Path, kind: &str, id: &str) -> Result<Remote, String> {
    if Auth::connected(data_dir) {
        match web_fetch(data_dir, kind, id).await {
            Ok(r) if !r.tracks.is_empty() => return Ok(r),
            Ok(_) => {}
            Err(e) => eprintln!("[imports] spotify web api {kind}/{id}: {e}"),
        }
    }
    embed(kind, id).await
}

pub async fn embed(kind: &str, id: &str) -> Result<Remote, String> {
    let url = format!("https://open.spotify.com/embed/{kind}/{id}");
    let mut res = None;
    for ua in [UA, "Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0"] {
        let r = http()
            .get(&url)
            .header("User-Agent", ua)
            .header("Accept-Language", "en-US,en;q=0.9")
            .header("Referer", "https://open.spotify.com/")
            .send()
            .await
            .map_err(|e| format!("Network error connecting to Spotify: {e}"))?;
        let st = r.status().as_u16();
        if st == 403 || st == 429 {
            tokio::time::sleep(Duration::from_millis(800)).await;
            res = Some((st, String::new()));
            continue;
        }
        res = Some((st, r.text().await.map_err(|e| e.to_string())?));
        break;
    }
    let (status, body) = res.unwrap_or((0, String::new()));
    match status {
        200 => {}
        404 => return Err("Spotify: not found. Check the link.".into()),
        403 => return Err("Spotify refused the request (403). Try again in a bit.".into()),
        429 => return Err("Spotify is rate limiting. Try again in a minute.".into()),
        s => return Err(format!("Spotify returned status {s}")),
    }
    parse_embed(kind, &body)
}

pub fn parse_embed(kind: &str, body: &str) -> Result<Remote, String> {
    let raw = NEXT_DATA.captures(body).ok_or_else(|| {
        if body.to_lowercase().contains("private") { "This Spotify playlist is private." } else { "Could not read the Spotify page." }.to_string()
    })?;
    let data: Value = serde_json::from_str(&raw[1]).map_err(|_| "Could not read the Spotify page.")?;
    let pp = &data["props"]["pageProps"];
    if pp["status"].as_u64() == Some(404) {
        return Err("Spotify: not found. Check the link.".into());
    }
    let e = &pp["state"]["data"]["entity"];
    let name = [&e["name"], &e["title"], &pp["title"]].iter().map(|v| s(v)).find(|v| !v.is_empty()).unwrap_or_else(|| "Spotify playlist".into());
    let cover = e["coverArt"]["sources"]
        .as_array()
        .and_then(|a| a.iter().max_by_key(|x| x["width"].as_u64().unwrap_or(0)))
        .map(|x| s(&x["url"]))
        .or_else(|| e["images"][0]["url"].as_str().map(str::to_string))
        .unwrap_or_default();
    let mut tracks: Vec<Item> = Vec::new();
    if let Some(list) = e["trackList"].as_array() {
        for t in list {
            let title = s(&t["title"]).to_string();
            if title.is_empty() {
                continue;
            }
            tracks.push(Item::new(title, s(&t["subtitle"]), secs(&t["duration"])));
        }
    }
    if tracks.is_empty() && kind == "track" {
        let artist = e["artists"].as_array().map(|a| a.iter().map(|x| s(&x["name"])).filter(|x| !x.is_empty()).collect::<Vec<_>>().join(", ")).unwrap_or_default();
        let title = s(&e["name"]);
        if !title.is_empty() {
            tracks.push(Item::new(title, artist, secs(&e["duration"])));
        }
    }
    if tracks.is_empty() {
        return Err("Spotify didn't show any tracks for this link (private or region locked?).".into());
    }
    let partial = kind == "playlist" && tracks.len() >= 100;
    let total = tracks.len();
    Ok(Remote {
        name,
        cover,
        source: "spotify",
        total,
        partial,
        note: if partial {
            "Without an account Spotify only shows the first 100 tracks. Connect Spotify in Settings → Integrations to import the whole playlist.".into()
        } else {
            String::new()
        },
        tracks,
    })
}

// ------------------------------------------------------------ account (PKCE)

#[derive(Default)]
struct Session {
    client_id: String,
    refresh: String,
    access: String,
    expires: Option<Instant>,
    loaded: bool,
}

static SESSION: LazyLock<Mutex<Session>> = LazyLock::new(Default::default);

pub struct Auth;

fn auth_path(dir: &Path) -> PathBuf {
    dir.join("spotify-auth.json")
}

fn load(dir: &Path) {
    let mut g = SESSION.lock().unwrap();
    if g.loaded {
        return;
    }
    g.loaded = true;
    if let Some(v) = std::fs::read(auth_path(dir)).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()) {
        g.client_id = s(&v["clientId"]);
        g.refresh = s(&v["refreshToken"]);
    }
}

fn save(dir: &Path, g: &Session) {
    let _ = std::fs::write(auth_path(dir), json!({ "clientId": g.client_id, "refreshToken": g.refresh }).to_string());
}

impl Auth {
    pub fn connected(dir: &Path) -> bool {
        load(dir);
        !SESSION.lock().unwrap().refresh.is_empty()
    }

    pub fn status(dir: &Path) -> Value {
        load(dir);
        let g = SESSION.lock().unwrap();
        json!({ "connected": !g.refresh.is_empty(), "clientId": g.client_id, "redirectUri": REDIRECT_URI })
    }

    pub fn logout(dir: &Path) {
        load(dir);
        let mut g = SESSION.lock().unwrap();
        g.refresh.clear();
        g.access.clear();
        g.expires = None;
        let _ = std::fs::remove_file(auth_path(dir));
    }
}

fn random(n: usize) -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    const ABC: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
    let mut out = String::with_capacity(n);
    let mut i = 0u64;
    while out.len() < n {
        let mut h = RandomState::new().build_hasher();
        h.write_u64(i);
        h.write_u128(SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
        let mut x = h.finish();
        for _ in 0..8 {
            if out.len() >= n {
                break;
            }
            out.push(ABC[(x % ABC.len() as u64) as usize] as char);
            x /= ABC.len() as u64;
        }
        i += 1;
    }
    out
}

fn b64url(bytes: &[u8]) -> String {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::new();
    for c in bytes.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        let k = c.len() + 1;
        for i in 0..k {
            out.push(T[((n >> (18 - 6 * i)) & 63) as usize] as char);
        }
    }
    out
}

fn challenge(verifier: &str) -> String {
    let mut h = crate::features::youtube::sha256::Sha256::new();
    h.update(verifier.as_bytes());
    let hex = h.hex();
    let bytes: Vec<u8> = (0..hex.len()).step_by(2).map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap_or(0)).collect();
    b64url(&bytes)
}

fn form(pairs: &[(&str, &str)]) -> String {
    let mut f = url::form_urlencoded::Serializer::new(String::new());
    for (k, v) in pairs {
        f.append_pair(k, v);
    }
    f.finish()
}

async fn token_request(body: String) -> Result<Value, String> {
    let r = http()
        .post("https://accounts.spotify.com/api/token")
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let st = r.status().as_u16();
    let v: Value = r.json().await.unwrap_or(Value::Null);
    if st != 200 || v["access_token"].as_str().is_none() {
        let why = v["error_description"].as_str().or(v["error"].as_str()).unwrap_or("").to_string();
        return Err(format!("Spotify token request failed (HTTP {st}) {why}").trim().to_string());
    }
    Ok(v)
}

/// Blocks until the browser hits the loopback redirect (or 5 minutes pass). Returns `code`.
fn wait_for_code(listener: TcpListener, state: &str) -> Result<String, String> {
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let end = Instant::now() + Duration::from_secs(300);
    while Instant::now() < end {
        match listener.accept() {
            Ok((mut sock, _)) => {
                let _ = sock.set_nonblocking(false);
                let _ = sock.set_read_timeout(Some(Duration::from_secs(5)));
                let mut buf = [0u8; 4096];
                let n = sock.read(&mut buf).unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]);
                let path = req.split_whitespace().nth(1).unwrap_or("");
                if !path.starts_with("/callback") {
                    let _ = sock.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                    continue;
                }
                let q = url::Url::parse(&format!("http://x{path}")).ok();
                let get = |k: &str| q.as_ref().and_then(|u| u.query_pairs().find(|(a, _)| a == k).map(|(_, v)| v.to_string()));
                let (msg, res) = match (get("code"), get("state"), get("error")) {
                    (_, _, Some(e)) => ("Spotify login was cancelled. You can close this tab.", Err(format!("Spotify login: {e}"))),
                    (Some(c), Some(s), _) if s == state => ("Spotify is connected. You can close this tab and go back to riff-rs.", Ok(c)),
                    _ => ("Something went wrong. Close this tab and try again.", Err("Spotify login: bad callback".to_string())),
                };
                let html = format!("<!doctype html><meta charset=utf-8><title>riff-rs</title><body style=\"font:16px system-ui;background:#111;color:#eee;display:grid;place-items:center;height:90vh\">{msg}</body>");
                let _ = sock.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{html}", html.len()).as_bytes());
                return res;
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(150)),
            Err(e) => return Err(e.to_string()),
        }
    }
    Err("Spotify login timed out".into())
}

pub async fn login(dir: &Path, client_id: &str) -> Result<Value, String> {
    let client_id = client_id.trim().to_string();
    if client_id.len() != 32 || !client_id.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("That doesn't look like a Spotify Client ID (32 hex characters).".into());
    }
    let listener = TcpListener::bind(("127.0.0.1", REDIRECT_PORT))
        .map_err(|e| format!("Port {REDIRECT_PORT} is busy ({e}). Close whatever uses it and try again."))?;
    let verifier = random(64);
    let state = random(16);
    let url = format!(
        "https://accounts.spotify.com/authorize?{}",
        form(&[
            ("response_type", "code"),
            ("client_id", &client_id),
            ("scope", SCOPES),
            ("redirect_uri", REDIRECT_URI),
            ("state", &state),
            ("code_challenge_method", "S256"),
            ("code_challenge", &challenge(&verifier)),
        ])
    );
    tauri_plugin_opener::open_url(url, None::<&str>).map_err(|e| e.to_string())?;
    let st = state.clone();
    let code = tauri::async_runtime::spawn_blocking(move || wait_for_code(listener, &st)).await.map_err(|e| e.to_string())??;
    let v = token_request(form(&[
        ("grant_type", "authorization_code"),
        ("code", &code),
        ("redirect_uri", REDIRECT_URI),
        ("client_id", &client_id),
        ("code_verifier", &verifier),
    ]))
    .await?;
    load(dir);
    {
        let mut g = SESSION.lock().unwrap();
        g.client_id = client_id;
        g.refresh = s(&v["refresh_token"]);
        g.access = s(&v["access_token"]);
        g.expires = Some(Instant::now() + Duration::from_secs(v["expires_in"].as_u64().unwrap_or(3600)));
        save(dir, &g);
    }
    Ok(Auth::status(dir))
}

async fn access(dir: &Path, force: bool) -> Result<String, String> {
    load(dir);
    let (client_id, refresh) = {
        let g = SESSION.lock().unwrap();
        if !force && !g.access.is_empty() && g.expires.is_some_and(|e| Instant::now() + Duration::from_secs(60) < e) {
            return Ok(g.access.clone());
        }
        if g.refresh.is_empty() {
            return Err("Spotify isn't connected.".into());
        }
        (g.client_id.clone(), g.refresh.clone())
    };
    let v = match token_request(form(&[("grant_type", "refresh_token"), ("refresh_token", &refresh), ("client_id", &client_id)])).await {
        Ok(v) => v,
        Err(e) if e.contains("invalid_grant") || e.contains("HTTP 400") => {
            Auth::logout(dir);
            return Err("Spotify login expired. Connect your account again.".into());
        }
        Err(e) => return Err(e),
    };
    let mut g = SESSION.lock().unwrap();
    g.access = s(&v["access_token"]);
    g.expires = Some(Instant::now() + Duration::from_secs(v["expires_in"].as_u64().unwrap_or(3600)));
    if let Some(r) = v["refresh_token"].as_str().filter(|r| !r.is_empty()) {
        g.refresh = r.to_string();
        save(dir, &g);
    }
    Ok(g.access.clone())
}

async fn api(dir: &Path, url: &str) -> Result<(u16, Value), String> {
    let mut token = access(dir, false).await?;
    for attempt in 0..4 {
        let r = http().get(url).bearer_auth(&token).send().await.map_err(|e| e.to_string())?;
        let st = r.status().as_u16();
        if st == 401 && attempt == 0 {
            token = access(dir, true).await?;
            continue;
        }
        if st == 429 && attempt < 3 {
            let wait = r.headers().get("retry-after").and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<u64>().ok()).unwrap_or(1);
            if wait > 30 {
                return Err("Spotify rate limited the request. Try again later.".into());
            }
            tokio::time::sleep(Duration::from_secs(wait)).await;
            continue;
        }
        return Ok((st, r.json().await.unwrap_or(Value::Null)));
    }
    Err("Spotify rate limited the request. Try again later.".into())
}

fn api_err(st: u16, v: &Value, what: &str) -> String {
    let d = v["error"]["message"].as_str().or(v["error"].as_str()).unwrap_or("");
    format!("Spotify {what}: HTTP {st}{}{d}", if d.is_empty() { "" } else { ": " })
}

fn web_item(it: &Value) -> Option<Item> {
    let t = if it["track"].is_object() { &it["track"] } else if it["item"].is_object() { &it["item"] } else { it };
    if t["is_local"].as_bool() == Some(true) || t["type"].as_str() == Some("episode") {
        return None;
    }
    let title = s(&t["name"]);
    if title.is_empty() {
        return None;
    }
    let artist = t["artists"].as_array().map(|a| a.iter().map(|x| s(&x["name"])).collect::<Vec<_>>().join(", ")).unwrap_or_default();
    Some(Item::new(title, artist, secs(&t["duration_ms"])))
}

/// Walks a paged Web API list (`items` + `next`).
async fn pages(dir: &Path, first: &str, cap: usize, what: &str) -> Result<Vec<Item>, (u16, String)> {
    let mut out = Vec::new();
    let mut next = Some(first.to_string());
    while let Some(u) = next.take() {
        let (st, v) = api(dir, &u).await.map_err(|e| (0, e))?;
        if !(200..300).contains(&st) {
            return Err((st, api_err(st, &v, what)));
        }
        out.extend(v["items"].as_array().into_iter().flatten().filter_map(web_item));
        if out.len() < cap {
            next = v["next"].as_str().map(str::to_string);
        }
    }
    Ok(out)
}

async fn playlist_items(dir: &Path, id: &str, what: &str) -> Result<Vec<Item>, (u16, String)> {
    let base = format!("https://api.spotify.com/v1/playlists/{id}");
    match pages(dir, &format!("{base}/items?limit=50"), 10_000, what).await {
        Err((400 | 404, _)) => pages(dir, &format!("{base}/tracks?limit=50"), 10_000, what).await,
        r => r,
    }
}

async fn web_fetch(dir: &Path, kind: &str, id: &str) -> Result<Remote, String> {
    let (st, meta) = api(dir, &format!("https://api.spotify.com/v1/{kind}s/{id}")).await?;
    if !(200..300).contains(&st) {
        return Err(api_err(st, &meta, kind));
    }
    let tracks = match kind {
        "track" => web_item(&meta).into_iter().collect(),
        "album" => pages(dir, &format!("https://api.spotify.com/v1/albums/{id}/tracks?limit=50"), 10_000, "album").await.map_err(|e| e.1)?,
        _ => playlist_items(dir, id, "playlist").await.map_err(|e| e.1)?,
    };
    let cover = meta["images"][0]["url"].as_str().or(meta["album"]["images"][0]["url"].as_str()).unwrap_or("").to_string();
    Ok(Remote { name: s(&meta["name"]), cover, source: "spotify", total: tracks.len(), partial: false, note: String::new(), tracks })
}

/// The connected user's liked songs and playlists.
pub async fn library(dir: &Path, likes: bool, playlists: bool) -> Result<Value, String> {
    let mut out_likes = Vec::new();
    let mut out_pls = Vec::new();
    let mut skipped = Vec::new();
    if likes {
        out_likes = pages(dir, "https://api.spotify.com/v1/me/tracks?limit=50", 10_000, "saved tracks").await.map_err(|e| e.1)?;
    }
    if playlists {
        let mut list = Vec::new();
        let mut next = Some("https://api.spotify.com/v1/me/playlists?limit=50".to_string());
        while let Some(u) = next.take() {
            let (st, v) = api(dir, &u).await?;
            if !(200..300).contains(&st) {
                return Err(api_err(st, &v, "playlists"));
            }
            for p in v["items"].as_array().into_iter().flatten() {
                if let (Some(id), Some(name)) = (p["id"].as_str(), p["name"].as_str()) {
                    list.push((id.to_string(), name.to_string(), p["images"][0]["url"].as_str().unwrap_or("").to_string()));
                }
            }
            next = v["next"].as_str().map(str::to_string);
        }
        for (id, name, cover) in list {
            match playlist_items(dir, &id, &format!("playlist items ({name})")).await {
                Ok(t) => out_pls.push(json!({ "name": name, "cover": cover, "tracks": t })),
                Err((403, e)) => skipped.push(json!({ "name": name, "error": e })),
                Err((_, e)) => return Err(e),
            }
        }
    }
    Ok(json!({ "likes": out_likes, "playlists": out_pls, "skipped": skipped }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn links() {
        assert_eq!(parse_link("https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=x"), Some(("playlist".into(), "37i9dQZF1DXcBWIGoYBM5M".into())));
        assert_eq!(parse_link("https://open.spotify.com/intl-de/album/4m2880jivSbbyEGAKfITCa"), Some(("album".into(), "4m2880jivSbbyEGAKfITCa".into())));
        assert_eq!(parse_link("spotify:track:2Foc5Q5nqNiosCNqttzHof"), Some(("track".into(), "2Foc5Q5nqNiosCNqttzHof".into())));
        assert!(parse_link("https://example.com").is_none());
    }

    #[test]
    fn pkce() {
        // RFC 7636 appendix B
        assert_eq!(challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
        assert_eq!(random(64).len(), 64);
    }
}
