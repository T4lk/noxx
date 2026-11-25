//! Whole public playlists without a Spotify account, the way open.spotify.com loads them:
//! an anonymous web-player token (TOTP signed with the secret shipped in the web player's
//! JS), then the `fetchPlaylistContents` pathfinder query, 100 tracks per page.
//! The secret, query hash and client version are read from the live web player, so a
//! Spotify deploy doesn't need a noxx release. This is not a public API: callers fall
//! back to the embed page (first 100 tracks) when it fails.
//!
//! Signed in (the `sp_dc` cookie from a Spotify login in noxx, see `web_login`), the same
//! token request returns the user's own web-player token, which also reads Liked Songs
//! (`fetchLibraryTracks`) and the profile name (`profileAttributes`).

use std::sync::{LazyLock, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures::{stream, StreamExt};
use regex::Regex;
use serde_json::{json, Value};

use super::super::{http, Item, UA};
use super::{random, s, secs};

const PAGE: usize = 100;
const MAX_TRACKS: usize = 10_000;
const PARALLEL_PAGES: usize = 4;
/// Used only when the web player JS no longer names them.
const FALLBACK_HASH: &str = "21ea11a6ac75a5f3e01fd365d29c18e0a4a8b7dc09f89bbb5d73910190c6acaf";
const FALLBACK_VERSION: &str = "1.2.70.0";
const WEB_CLIENT_ID: &str = "d8a5ed958d274c2e8ee717e6a4b0971d";
const FALLBACK_LIKED_HASH: &str = "087278b20b743578a6262c2b0b4bcd20d879c503cc359a2285baf083ef944240";
const FALLBACK_PROFILE_HASH: &str = "08ffb4730af3746e04a8301396f20875dbbce10c75243803091a9274eacc8ac0";
const LIKED_PAGE: usize = 50;

static SCRIPT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"https://open\.spotifycdn\.com/cdn/build/(?:mobile-)?web-player/(?:mobile-)?web-player\.[a-f0-9]+\.js").unwrap()
});
static SECRET: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"\{secret:(?:'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)"),version:(\d+)\}"#).unwrap()
});
static UNESCAPE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\\(.)").unwrap());
static HASH: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#""fetchPlaylistContents","query","([a-f0-9]{64})""#).unwrap());
static LIKED_HASH: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#""fetchLibraryTracks","query","([a-f0-9]{64})""#).unwrap());
static PROFILE_HASH: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#""profileAttributes","query","([a-f0-9]{64})""#).unwrap());
static VERSION: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#""?clientVersion"?:"([0-9][^"]{2,40})""#).unwrap());

#[derive(Clone)]
struct Guest {
    access: String,
    client_token: String,
    hash: String,
    liked_hash: String,
    profile_hash: String,
    version: String,
    expires_ms: u64,
}

static SESSION: LazyLock<Mutex<Option<Guest>>> = LazyLock::new(Default::default);
/// The signed-in session: (sp_dc it was made from, token).
static USER: LazyLock<Mutex<Option<(String, Guest)>>> = LazyLock::new(Default::default);

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Newest `{secret, version}` in the web player JS.
fn extract_secret(js: &str) -> Option<(String, u32)> {
    SECRET
        .captures_iter(js)
        .filter_map(|c| {
            let raw = c.get(1).or(c.get(2))?.as_str();
            Some((UNESCAPE.replace_all(raw, "$1").into_owned(), c[3].parse::<u32>().ok()?))
        })
        .max_by_key(|(_, v)| *v)
}

fn secret_key(secret: &str) -> Vec<u8> {
    secret
        .chars()
        .enumerate()
        .map(|(i, c)| ((c as u32) ^ ((i as u32 % 33) + 9)).to_string())
        .collect::<String>()
        .into_bytes()
}

fn totp(key: &[u8], ms: u64) -> String {
    let h = hmac_sha1(key, &(ms / 1000 / 30).to_be_bytes());
    let o = (h[19] & 0xf) as usize;
    let code = u32::from_be_bytes([h[o] & 0x7f, h[o + 1], h[o + 2], h[o + 3]]);
    format!("{:06}", code % 1_000_000)
}

async fn get_text(url: &str) -> Result<String, String> {
    let r = http().get(url).header("User-Agent", UA).header("Accept-Language", "en-US,en;q=0.9").send().await.map_err(|e| e.to_string())?;
    if !r.status().is_success() {
        return Err(format!("{url}: HTTP {}", r.status().as_u16()));
    }
    r.text().await.map_err(|e| e.to_string())
}

/// A web-player token: anonymous, or the user's own with their `sp_dc` cookie.
async fn login(sp_dc: Option<&str>) -> Result<Guest, String> {
    let html = get_text("https://open.spotify.com/").await?;
    let script = SCRIPT.find(&html).ok_or("web player script not found")?.as_str().to_string();
    let js = get_text(&script).await?;
    let (secret, ver) = extract_secret(&js).ok_or("web player secret not found")?;
    let hash = HASH.captures(&js).map(|c| c[1].to_string()).unwrap_or_else(|| FALLBACK_HASH.into());
    let liked_hash = LIKED_HASH.captures(&js).map(|c| c[1].to_string()).unwrap_or_else(|| FALLBACK_LIKED_HASH.into());
    let profile_hash = PROFILE_HASH.captures(&js).map(|c| c[1].to_string()).unwrap_or_else(|| FALLBACK_PROFILE_HASH.into());
    let version = VERSION.captures(&html).or_else(|| VERSION.captures(&js)).map(|c| c[1].to_string()).unwrap_or_else(|| FALLBACK_VERSION.into());

    let key = secret_key(&secret);
    let local = totp(&key, now_ms());
    let server = match http().get("https://open.spotify.com/api/server-time").header("User-Agent", UA).send().await {
        Ok(r) => r.json::<Value>().await.ok().and_then(|v| v["serverTime"].as_f64()).map(|t| totp(&key, (t * 1000.0) as u64)),
        Err(_) => None,
    }
    .unwrap_or_else(|| "unavailable".into());

    let ver_s = ver.to_string();
    let mut req = http()
        .get("https://open.spotify.com/api/token")
        .query(&[("reason", "init"), ("productType", "web-player"), ("totp", local.as_str()), ("totpServer", server.as_str()), ("totpVer", ver_s.as_str())])
        .header("User-Agent", UA)
        .header("Accept", "application/json");
    if let Some(c) = sp_dc {
        req = req.header("Cookie", format!("sp_dc={c}"));
    }
    let r = req.send().await.map_err(|e| e.to_string())?;
    let st = r.status().as_u16();
    let v: Value = r.json().await.unwrap_or(Value::Null);
    let access = s(&v["accessToken"]);
    if sp_dc.is_some() && matches!(st, 400 | 401 | 403) {
        return Err("SIGNED_OUT: your Spotify sign-in has expired. Sign in again.".into());
    }
    if access.is_empty() {
        return Err(format!("{} token: HTTP {st}", if sp_dc.is_some() { "Spotify sign-in" } else { "guest" }));
    }
    // A cookie Spotify no longer accepts gives an anonymous token instead of an error.
    if sp_dc.is_some() && v["isAnonymous"].as_bool() != Some(false) {
        return Err("SIGNED_OUT: your Spotify sign-in has expired. Sign in again.".into());
    }
    let expires_ms = v["accessTokenExpirationTimestampMs"].as_u64().unwrap_or_else(|| now_ms() + 3_500_000);
    let client_id = v["clientId"].as_str().filter(|c| !c.is_empty()).unwrap_or(WEB_CLIENT_ID);

    // Optional: pathfinder usually answers without it, but the web player always sends one.
    let body = json!({ "client_data": {
        "client_version": version,
        "client_id": client_id,
        "js_sdk_data": {
            "device_brand": "unknown", "device_model": "unknown", "os": "windows", "os_version": "NT 10.0",
            "device_id": random(32), "device_type": "computer"
        }
    }});
    let client_token = match http().post("https://clienttoken.spotify.com/v1/clienttoken").header("Accept", "application/json").json(&body).send().await {
        Ok(r) => r.json::<Value>().await.ok().map(|v| s(&v["granted_token"]["token"])).unwrap_or_default(),
        Err(_) => String::new(),
    };
    Ok(Guest { access, client_token, hash, liked_hash, profile_hash, version, expires_ms })
}

async fn session(fresh: bool) -> Result<Guest, String> {
    if !fresh {
        if let Some(g) = SESSION.lock().unwrap().clone().filter(|g| now_ms() + 60_000 < g.expires_ms) {
            return Ok(g);
        }
    }
    let g = login(None).await?;
    *SESSION.lock().unwrap() = Some(g.clone());
    Ok(g)
}

async fn user_session(sp_dc: &str, fresh: bool) -> Result<Guest, String> {
    if !fresh {
        if let Some((c, g)) = USER.lock().unwrap().clone() {
            if c == sp_dc && now_ms() + 60_000 < g.expires_ms {
                return Ok(g);
            }
        }
    }
    let g = login(Some(sp_dc)).await?;
    *USER.lock().unwrap() = Some((sp_dc.to_string(), g.clone()));
    Ok(g)
}

/// One pathfinder query as the signed-in user (retries a stale token, waits out 429s).
async fn user_query(sp_dc: &str, op: &str, hash_of: fn(&Guest) -> &str, vars: Value) -> Result<Value, String> {
    let mut g = user_session(sp_dc, false).await?;
    let mut last = String::new();
    for attempt in 1..=3u64 {
        let ext = json!({ "persistedQuery": { "version": 1, "sha256Hash": hash_of(&g) } }).to_string();
        let vars_s = vars.to_string();
        let mut req = http()
            .get("https://api-partner.spotify.com/pathfinder/v1/query")
            .query(&[("operationName", op), ("variables", vars_s.as_str()), ("extensions", ext.as_str())])
            .bearer_auth(&g.access)
            .header("Accept", "application/json")
            .header("App-Platform", "WebPlayer")
            .header("Spotify-App-Version", &g.version);
        if !g.client_token.is_empty() {
            req = req.header("Client-Token", &g.client_token);
        }
        let r = match req.send().await {
            Ok(r) => r,
            Err(e) => {
                last = e.to_string();
                tokio::time::sleep(Duration::from_millis(500 * attempt)).await;
                continue;
            }
        };
        let st = r.status().as_u16();
        match st {
            429 => {
                let wait = r.headers().get("retry-after").and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<u64>().ok()).unwrap_or(3).min(15);
                tokio::time::sleep(Duration::from_secs(wait)).await;
                last = "rate limited".into();
                continue;
            }
            401 | 403 => {
                g = user_session(sp_dc, true).await?;
                last = format!("HTTP {st}");
                continue;
            }
            _ => {}
        }
        let v: Value = r.json().await.unwrap_or(Value::Null);
        if v["data"].is_object() {
            return Ok(v);
        }
        if v["errors"].is_array() {
            *USER.lock().unwrap() = None; // a new hash after a Spotify deploy: re-read the JS
        }
        last = format!("HTTP {st}: {}", v.to_string().chars().take(200).collect::<String>());
        tokio::time::sleep(Duration::from_millis(500 * attempt)).await;
    }
    Err(format!("spotify {op}: {last}"))
}

/// A Liked Songs entry: `{ addedAt, track: { _uri, data: Track } }`.
fn map_liked(it: &Value) -> Option<Item> {
    let t = &it["track"]["data"];
    if t["__typename"].as_str() != Some("Track") {
        return None;
    }
    let title = s(&t["name"]);
    if title.is_empty() {
        return None;
    }
    let artist = t["artists"]["items"]
        .as_array()
        .map(|a| a.iter().map(|x| if x["profile"]["name"].is_string() { s(&x["profile"]["name"]) } else { s(&x["name"]) }).filter(|n| !n.is_empty()).collect::<Vec<_>>().join(", "))
        .unwrap_or_default();
    let ms = if t["duration"]["totalMilliseconds"].is_number() { &t["duration"]["totalMilliseconds"] } else { &t["trackDuration"]["totalMilliseconds"] };
    Some(Item::new(title, artist, secs(ms)))
}

/// The signed-in user's Liked Songs, newest first: (tracks, how many Spotify says there are).
pub async fn liked(sp_dc: &str) -> Result<(Vec<Item>, usize), String> {
    let mut out = Vec::new();
    let mut offset = 0;
    let mut total = usize::MAX;
    while offset < total && offset < MAX_TRACKS {
        let v = user_query(sp_dc, "fetchLibraryTracks", |g| &g.liked_hash, json!({ "offset": offset, "limit": LIKED_PAGE })).await?;
        let page = &v["data"]["me"]["library"]["tracks"];
        if !page.is_object() {
            return Err(format!("spotify liked songs: unexpected answer {}", v.to_string().chars().take(200).collect::<String>()));
        }
        total = page["totalCount"].as_u64().unwrap_or(0) as usize;
        let items = page["items"].as_array().cloned().unwrap_or_default();
        if items.is_empty() {
            break;
        }
        out.extend(items.iter().filter_map(map_liked));
        offset += items.len();
    }
    let total = if total == usize::MAX { out.len() } else { total };
    Ok((out, total))
}

/// Display name and picture URL of the signed-in user ("" when Spotify doesn't say).
pub async fn profile(sp_dc: &str) -> Result<(String, String), String> {
    let v = user_query(sp_dc, "profileAttributes", |g| &g.profile_hash, json!({})).await?;
    let p = &v["data"]["me"]["profile"];
    // The smallest picture that is still sharp at 34 px (sources come in several sizes).
    let avatar = p["avatar"]["sources"]
        .as_array()
        .and_then(|a| a.iter().filter(|x| x["url"].is_string()).min_by_key(|x| x["width"].as_u64().map(|w| if w >= 64 { w } else { w + 10_000 }).unwrap_or(5_000)))
        .map(|x| s(&x["url"]))
        .unwrap_or_default();
    Ok((s(&p["name"]), avatar))
}

fn map_item(it: &Value) -> Option<Item> {
    let t = &it["itemV2"]["data"];
    if t["__typename"].as_str() != Some("Track") {
        return None;
    }
    let title = s(&t["name"]);
    if title.is_empty() {
        return None;
    }
    let artist = t["artists"]["items"]
        .as_array()
        .map(|a| a.iter().map(|x| if x["profile"]["name"].is_string() { s(&x["profile"]["name"]) } else { s(&x["name"]) }).filter(|n| !n.is_empty()).collect::<Vec<_>>().join(", "))
        .unwrap_or_default();
    Some(Item::new(title, artist, secs(&t["trackDuration"]["totalMilliseconds"])))
}

/// One page: (tracks, entries on the page, totalCount).
async fn page(id: &str, offset: usize) -> Result<(Vec<Item>, usize, usize), String> {
    let mut g = session(false).await?;
    let mut last = String::new();
    for attempt in 1..=3u64 {
        let vars = json!({ "uri": format!("spotify:playlist:{id}"), "offset": offset, "limit": PAGE }).to_string();
        let ext = json!({ "persistedQuery": { "version": 1, "sha256Hash": g.hash } }).to_string();
        let mut req = http()
            .get("https://api-partner.spotify.com/pathfinder/v1/query")
            .query(&[("operationName", "fetchPlaylistContents"), ("variables", vars.as_str()), ("extensions", ext.as_str())])
            .bearer_auth(&g.access)
            .header("Accept", "application/json")
            .header("App-Platform", "WebPlayer")
            .header("Spotify-App-Version", &g.version);
        if !g.client_token.is_empty() {
            req = req.header("Client-Token", &g.client_token);
        }
        let r = match req.send().await {
            Ok(r) => r,
            Err(e) => {
                last = e.to_string();
                tokio::time::sleep(Duration::from_millis(500 * attempt)).await;
                continue;
            }
        };
        let st = r.status().as_u16();
        match st {
            429 => {
                let wait = r.headers().get("retry-after").and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<u64>().ok()).unwrap_or(3).min(15);
                tokio::time::sleep(Duration::from_secs(wait)).await;
                last = "rate limited".into();
                continue;
            }
            401 | 403 => {
                g = session(true).await?;
                last = format!("HTTP {st}");
                continue;
            }
            _ => {}
        }
        let v: Value = r.json().await.unwrap_or(Value::Null);
        let content = &v["data"]["playlistV2"]["content"];
        if !content.is_object() {
            // Unknown hash after a Spotify deploy: next login re-reads it from the JS.
            if v["errors"].is_array() {
                *SESSION.lock().unwrap() = None;
            }
            let kind = v["data"]["playlistV2"]["__typename"].as_str().unwrap_or("no playlistV2");
            last = format!("HTTP {st}, {kind}");
            if st == 404 || kind == "NotFound" {
                break;
            }
            tokio::time::sleep(Duration::from_millis(500 * attempt)).await;
            continue;
        }
        let total = content["totalCount"].as_u64().unwrap_or(0) as usize;
        let raw = content["items"].as_array().cloned().unwrap_or_default();
        return Ok((raw.iter().filter_map(map_item).collect(), raw.len(), total));
    }
    Err(format!("spotify pathfinder page {offset}: {last}"))
}

/// Every track of a public playlist: (tracks, how many tracks Spotify has). Local files and
/// removed songs come back on the pages but can't be imported, so they don't count as missing.
pub async fn playlist(id: &str) -> Result<(Vec<Item>, usize), String> {
    let (mut tracks, mut seen, total) = page(id, 0).await?;
    let mut skipped = seen - tracks.len();
    let want = total.min(MAX_TRACKS);
    let offsets: Vec<usize> = (PAGE..want).step_by(PAGE).collect();
    let rest: Vec<Result<(Vec<Item>, usize, usize), String>> = stream::iter(offsets).map(|o| async move { page(id, o).await }).buffered(PARALLEL_PAGES).collect().await;
    for r in rest {
        match r {
            Ok((items, n, _)) if n > 0 => {
                seen += n;
                skipped += n - items.len();
                tracks.extend(items);
            }
            Ok(_) => break,
            Err(e) => {
                eprintln!("[imports] {e}");
                break;
            }
        }
    }
    if skipped > 0 {
        eprintln!("[imports] spotify {id}: {skipped} local/unavailable entries skipped ({seen} of {total} read)");
    }
    Ok((tracks, total.saturating_sub(skipped)))
}

// ------------------------------------------------------------ HMAC-SHA1 (RFC 2104 / FIPS 180-1)

fn sha1(data: &[u8]) -> [u8; 20] {
    let mut h: [u32; 5] = [0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0];
    let mut msg = data.to_vec();
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&((data.len() as u64) * 8).to_be_bytes());
    for block in msg.chunks(64) {
        let mut w = [0u32; 80];
        for i in 0..16 {
            w[i] = u32::from_be_bytes([block[4 * i], block[4 * i + 1], block[4 * i + 2], block[4 * i + 3]]);
        }
        for i in 16..80 {
            w[i] = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1);
        }
        let [mut a, mut b, mut c, mut d, mut e] = h;
        for (i, wi) in w.iter().enumerate() {
            let (f, k) = match i {
                0..=19 => ((b & c) | (!b & d), 0x5A827999),
                20..=39 => (b ^ c ^ d, 0x6ED9EBA1),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8F1BBCDC),
                _ => (b ^ c ^ d, 0xCA62C1D6),
            };
            let t = a.rotate_left(5).wrapping_add(f).wrapping_add(e).wrapping_add(k).wrapping_add(*wi);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = t;
        }
        for (x, y) in h.iter_mut().zip([a, b, c, d, e]) {
            *x = x.wrapping_add(y);
        }
    }
    let mut out = [0u8; 20];
    for (i, x) in h.iter().enumerate() {
        out[4 * i..4 * i + 4].copy_from_slice(&x.to_be_bytes());
    }
    out
}

fn hmac_sha1(key: &[u8], msg: &[u8]) -> [u8; 20] {
    let mut k = [0u8; 64];
    if key.len() > 64 {
        k[..20].copy_from_slice(&sha1(key));
    } else {
        k[..key.len()].copy_from_slice(key);
    }
    let mut inner: Vec<u8> = k.iter().map(|b| b ^ 0x36).collect();
    inner.extend_from_slice(msg);
    let mut outer: Vec<u8> = k.iter().map(|b| b ^ 0x5c).collect();
    outer.extend_from_slice(&sha1(&inner));
    sha1(&outer)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(b: &[u8]) -> String {
        b.iter().map(|x| format!("{x:02x}")).collect()
    }

    #[test]
    fn sha1_vectors() {
        assert_eq!(hex(&sha1(b"abc")), "a9993e364706816aba3e25717850c26c9cd0d89d");
        assert_eq!(hex(&sha1(b"")), "da39a3ee5e6b4b0d3255bfef95601890afd80709");
        assert_eq!(hex(&sha1(&[b'a'; 1000])), "291e9a6c66994949b57ba5e650361e98fc36b1ba");
    }

    #[test]
    fn totp_rfc6238() {
        // RFC 6238 appendix B, SHA-1, last 6 digits.
        let key = b"12345678901234567890";
        assert_eq!(totp(key, 59_000), "287082");
        assert_eq!(totp(key, 1_111_111_109_000), "081804");
        assert_eq!(totp(key, 2_000_000_000_000), "279037");
    }

    #[test]
    fn liked_items_map() {
        let it = json!({ "addedAt": { "isoString": "2024-01-01T00:00:00Z" }, "track": { "_uri": "spotify:track:x", "data": {
            "__typename": "Track", "name": "Get Lucky", "duration": { "totalMilliseconds": 248413 },
            "artists": { "items": [{ "profile": { "name": "Daft Punk" } }, { "profile": { "name": "Pharrell Williams" } }] } } } });
        let t = map_liked(&it).expect("track");
        assert_eq!((t.title.as_str(), t.artist.as_str(), t.duration), ("Get Lucky", "Daft Punk, Pharrell Williams", 248));
        assert!(map_liked(&json!({ "track": { "data": { "__typename": "Episode", "name": "x" } } })).is_none());
    }

    #[tokio::test]
    #[ignore = "network"]
    async fn live_signed_out_cookie_is_refused() {
        let e = user_session("not-a-real-cookie", true).await.err().unwrap_or_default();
        println!("{e}");
        assert!(e.contains("SIGNED_OUT") || e.contains("token"), "{e}");
    }

    #[test]
    fn secret_from_js() {
        let js = r#"x=[{secret:'a\'b',version:3},{secret:"zz",version:7},{secret:'q',version:5}]"#;
        assert_eq!(extract_secret(js), Some(("zz".into(), 7)));
        assert_eq!(extract_secret(r#"{secret:'a\'b',version:3}"#), Some(("a'b".into(), 3)));
    }

    #[tokio::test]
    #[ignore = "network"]
    async fn live_big_playlist() {
        let (t, total) = playlist("6yPiKpy7evrwvZodByKvM9").await.expect("pathfinder");
        println!("{} of {} tracks; first: {} / {} / {}s", t.len(), total, t[0].title, t[0].artist, t[0].duration);
        assert!(t.len() > 100);
        assert_eq!(t.len(), total, "every importable track");
    }
}
