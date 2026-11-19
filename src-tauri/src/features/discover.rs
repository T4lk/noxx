//! Discover: artist pages, SoundCloud "For you" mixes, My Wave and song radio.
//!
//! Commands (JS: `riff.call('discover.<cmd>', args)`):
//! - `artist {id?, url?, trackId?, name?, refresh?}` → profile, popular tracks, latest uploads, albums, playlists
//!   (+ `banners`, `plays {trackId: count}`, `tracksNext`, `related` artists, `following` true/false/null)
//! - `artist_tracks {id, next?}` → one page of an artist's uploads `{tracks, plays, next}` (hydrated)
//! - `follow_state {id}` → `{loggedIn, following: bool|null}` for the signed-in account
//! - `follow {id, on}` → follows / unfollows an artist (needs login) → `{following}`
//! - `set {id}` → one album / playlist with hydrated tracks (order kept)
//! - `for_you {refresh?}` → SoundCloud system playlists (needs login)
//! - `system_playlist {urn}` → tracks of one system playlist (hydrated, order kept)
//! - `radio {seed, played?, avoid?, limit?}` → related tracks that stay in the seed's genre family
//! - `wave {seeds: [{id, weight}], heard?, avoid?, limit?, refresh?}` → My Wave picks from related tracks
//! - `search_extras {q, artists?, albums?}` → artists and albums matching a search (riff's search rows)
//! - `style {text}` → genre families found in a piece of text (debug / selftest)
//!
//! Network results are cached in memory (artists / sets / mixes / related lists
//! for 10 min, radio style profiles for 6 h) so revisiting a page is instant.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use futures::future::join_all;
use regex::Regex;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::soundcloud::{artwork, collection, id_of, listable, map_track, playable, str_of, unwrap_item, SoundCloud, Track};

const PAGE_TTL: Duration = Duration::from_secs(10 * 60);
const PROFILE_TTL: Duration = Duration::from_secs(6 * 60 * 60);
const WAVE_TTL: Duration = Duration::from_secs(10 * 60);

pub fn setup(_app: &AppHandle) {}

pub async fn handle(app: &AppHandle, cmd: &str, args: Value) -> super::Out {
    let sc: Arc<SoundCloud> = app.state::<crate::AppState>().sc.clone();
    match cmd {
        "artist" => artist(&sc, &args).await,
        "artist_tracks" => artist_tracks(&sc, &args).await,
        "follow_state" => follow_state(&sc, &arg_str(&args, "id")).await,
        "follow" => follow(&sc, &arg_str(&args, "id"), args["on"].as_bool().unwrap_or(true)).await,
        "set" => set_tracks(&sc, &arg_str(&args, "id")).await,
        "for_you" => for_you(&sc, args["refresh"].as_bool().unwrap_or(false)).await,
        "system_playlist" => system_playlist(&sc, &arg_str(&args, "urn")).await,
        "radio" => radio(&sc, &args).await,
        "wave" => wave(&sc, &args).await,
        "search_extras" => search_extras(&sc, &args).await,
        "trending_for" => trending_for(&sc, &args).await,
        "style" => {
            let text = arg_str(&args, "text");
            Ok(json!({ "families": detect_families(&text), "edit": is_edit(&text), "notASong": is_not_a_song(&text) }))
        }
        _ => Err(format!("discover: unknown command {cmd}")),
    }
}

// ------------------------------------------------------------------
// trending in the user's own genres
// ------------------------------------------------------------------

static TREND_CACHE: LazyLock<Mutex<HashMap<String, (Instant, Vec<Track>)>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
const TREND_TTL: Duration = Duration::from_secs(60 * 60);

/// `trending_for {genres: ["hardtekk", "frenchcore", …], limit?}` → `[{genre, tracks}]`.
/// SoundCloud's global chart is mostly mainstream, so for each genre this searches tracks
/// uploaded in the last month and ranks them by plays (ties: likes). Cached for an hour.
async fn trending_for(sc: &SoundCloud, args: &Value) -> super::Out {
    let limit = args["limit"].as_u64().unwrap_or(24).clamp(5, 50) as usize;
    let genres: Vec<String> = args["genres"]
        .as_array()
        .map(|a| a.iter().filter_map(|g| g.as_str()).map(|g| g.trim().to_string()).filter(|g| !g.is_empty()).take(4).collect())
        .unwrap_or_default();
    let rows = join_all(genres.iter().map(|g| async move {
        let key = g.to_lowercase();
        if let Some((at, list)) = TREND_CACHE.lock().unwrap().get(&key) {
            if at.elapsed() < TREND_TTL {
                return json!({ "genre": g, "tracks": list });
            }
        }
        let params = [
            ("q", g.clone()),
            ("filter.created_at", "last_month".to_string()),
            ("limit", "100".to_string()),
        ];
        let mut raw: Vec<Value> = match sc.api("/search/tracks", &params).await {
            Ok(v) => collection(&v).iter().map(|i| unwrap_item(i, "track").clone()).filter(|t| playable(t)).collect(),
            Err(_) => Vec::new(),
        };
        let score = |t: &Value| (t["playback_count"].as_u64().unwrap_or(0), t["likes_count"].as_u64().unwrap_or(0));
        raw.sort_by(|a, b| score(b).cmp(&score(a)));
        let mut seen = HashSet::new();
        let list: Vec<Track> = raw
            .iter()
            .map(map_track)
            .filter(|t| t.duration >= 60 && seen.insert(format!("{}|{}", t.artist.to_lowercase(), t.title.to_lowercase())))
            .take(limit)
            .collect();
        if !list.is_empty() {
            TREND_CACHE.lock().unwrap().insert(key, (Instant::now(), list.clone()));
        }
        json!({ "genre": g, "tracks": list })
    }))
    .await;
    Ok(Value::Array(rows))
}

// ------------------------------------------------------------------
// small helpers
// ------------------------------------------------------------------

fn arg_str(args: &Value, key: &str) -> String {
    match &args[key] {
        Value::String(s) => s.trim().to_string(),
        Value::Number(n) => n.to_string(),
        _ => String::new(),
    }
}

fn is_num_id(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

/// Ids from `["1", 2, {id}]`.
fn ids_of(v: &Value) -> HashSet<String> {
    v.as_array()
        .map(|a| {
            a.iter()
                .filter_map(|x| match x {
                    Value::String(s) => Some(s.clone()),
                    Value::Number(n) => Some(n.to_string()),
                    _ => id_of(x),
                })
                .collect()
        })
        .unwrap_or_default()
}

fn e(err: impl std::fmt::Display) -> String {
    err.to_string()
}

/// Small xorshift so ranking gets a bit of variety without a `rand` dependency.
fn random() -> f64 {
    static SEED: LazyLock<Mutex<u64>> = LazyLock::new(|| {
        let n = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos() as u64).unwrap_or(0x9e37_79b9_7f4a_7c15);
        Mutex::new(n | 1)
    });
    let mut s = SEED.lock().unwrap();
    let mut x = *s;
    x ^= x << 13;
    x ^= x >> 7;
    x ^= x << 17;
    *s = x;
    (x >> 11) as f64 / (1u64 << 53) as f64
}

/// A small cache with one TTL; its lock is never held across an `.await`.
struct Ttl<V> {
    map: HashMap<String, (Instant, V)>,
    ttl: Duration,
    cap: usize,
}

impl<V: Clone> Ttl<V> {
    fn new(ttl: Duration, cap: usize) -> Self {
        Self { map: HashMap::new(), ttl, cap }
    }
    fn get(&self, key: &str) -> Option<V> {
        self.map.get(key).filter(|(at, _)| at.elapsed() < self.ttl).map(|(_, v)| v.clone())
    }
    fn put(&mut self, key: String, v: V) {
        if self.map.len() >= self.cap && !self.map.contains_key(&key) {
            let ttl = self.ttl;
            self.map.retain(|_, (at, _)| at.elapsed() < ttl);
            if self.map.len() >= self.cap {
                if let Some(oldest) = self.map.iter().min_by_key(|(_, (at, _))| *at).map(|(k, _)| k.clone()) {
                    self.map.remove(&oldest);
                }
            }
        }
        self.map.insert(key, (Instant::now(), v));
    }
}

static PAGES: LazyLock<Mutex<Ttl<Value>>> = LazyLock::new(|| Mutex::new(Ttl::new(PAGE_TTL, 200)));

fn cached(key: &str) -> Option<Value> {
    PAGES.lock().unwrap().get(key)
}
fn remember(key: &str, v: &Value) {
    PAGES.lock().unwrap().put(key.to_string(), v.clone());
}

// Same matching key riff uses to spot one song uploaded twice.
static KEY_OFFICIAL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\s*\([^)]*official[^)]*\)").unwrap());
static KEY_BRACKET: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s*\[[^\]]*\]").unwrap());
static KEY_MEDIA: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\s*\([^)]*(video|audio|remaster(ed)?|lyrics?|visualizer)[^)]*\)").unwrap());
static KEY_FEAT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\s*\b(feat\.?|ft\.?)\s+[^(\[-]+").unwrap());
static KEY_FEAT_PAREN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\s*\((feat\.?|ft\.?)[^)]*\)").unwrap());
static KEY_FEAT_ARTIST: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\s*\b(feat\.?|ft\.?)\s+.*$").unwrap());
static NON_WORD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[^\p{L}\p{N}\s]").unwrap());
static SPACES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+").unwrap());

fn squash(s: &str) -> String {
    SPACES.replace_all(&NON_WORD.replace_all(s, " "), " ").trim().to_string()
}

fn track_key(artist: &str, title: &str) -> String {
    let mut t = title.to_lowercase();
    for re in [&*KEY_OFFICIAL, &*KEY_BRACKET, &*KEY_MEDIA, &*KEY_FEAT_PAREN, &*KEY_FEAT] {
        t = re.replace_all(&t, "").into_owned();
    }
    let a = KEY_FEAT_ARTIST.replace_all(&artist.to_lowercase(), "").into_owned();
    format!("{}::{}", squash(&a), squash(&t))
}

static ARTIST_JUNK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\b(official|vevo|records|topic)\b").unwrap());
static ARTIST_SYM: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[^\w\s&-]").unwrap());

fn artist_key(name: &str) -> String {
    let s = ARTIST_JUNK.replace_all(name, "");
    SPACES.replace_all(&ARTIST_SYM.replace_all(&s, " "), " ").trim().to_lowercase()
}

// ------------------------------------------------------------------
// artist pages
// ------------------------------------------------------------------

async fn resolve_user_id(sc: &SoundCloud, args: &Value) -> Result<String, String> {
    let id = arg_str(args, "id");
    if is_num_id(&id) {
        return Ok(id);
    }
    let url = arg_str(args, "url");
    if url.starts_with("https://soundcloud.com/") || url.starts_with("http://soundcloud.com/") {
        if let Ok(v) = sc.api("/resolve", &[("url", url.clone())]).await {
            let uid = if v["kind"].as_str() == Some("user") { id_of(&v) } else { id_of(&v["user"]) };
            if let Some(uid) = uid {
                return Ok(uid);
            }
        }
    }
    let track_id = arg_str(args, "trackId");
    if is_num_id(&track_id) {
        if let Ok(v) = sc.api(&format!("/tracks/{track_id}"), &[]).await {
            if let Some(uid) = id_of(&v["user"]) {
                return Ok(uid);
            }
        }
    }
    let name = arg_str(args, "name");
    if !name.is_empty() && !name.eq_ignore_ascii_case("unknown artist") {
        let key = format!("name:{}", name.to_lowercase());
        if let Some(v) = cached(&key) {
            return v.as_str().map(String::from).ok_or_else(|| "Artist not found".to_string());
        }
        let data = sc.api("/search/users", &[("q", name.clone()), ("limit", "10".into())]).await.map_err(e)?;
        let users = collection(&data);
        let wanted = artist_key(&name);
        let best = users
            .iter()
            .find(|u| str_of(u, "username").is_some_and(|n| artist_key(&n) == wanted))
            .or_else(|| users.first());
        if let Some(uid) = best.and_then(id_of) {
            remember(&key, &json!(uid));
            return Ok(uid);
        }
    }
    Err("Artist not found".into())
}

/// Album / playlist card data.
fn release_of(pl: &Value) -> Option<Value> {
    let id = id_of(pl)?;
    let tracks = pl["tracks"].as_array();
    let art = str_of(pl, "artwork_url")
        .or_else(|| tracks.and_then(|t| t.iter().find_map(|x| str_of(x, "artwork_url"))))
        .or_else(|| str_of(&pl["user"], "avatar_url"))
        .unwrap_or_default();
    let date = str_of(pl, "release_date")
        .or_else(|| str_of(pl, "display_date"))
        .or_else(|| str_of(pl, "published_at"))
        .or_else(|| str_of(pl, "created_at"))
        .unwrap_or_default();
    let kind = str_of(pl, "set_type").unwrap_or_else(|| {
        if pl["is_album"].as_bool() == Some(true) { "album".into() } else { "playlist".into() }
    });
    let count = pl["track_count"].as_u64().unwrap_or_else(|| tracks.map(|t| t.len() as u64).unwrap_or(0));
    Some(json!({
        "id": id,
        "title": str_of(pl, "title").unwrap_or_else(|| "Untitled".into()),
        "artist": str_of(&pl["user"], "username").unwrap_or_default(),
        "artwork": artwork(&art, "t300x300"),
        "trackCount": count,
        "year": date.get(..4).unwrap_or(""),
        "kind": kind,
        "url": str_of(pl, "permalink_url").unwrap_or_default(),
        "likes": pl["likes_count"].as_u64().unwrap_or(0),
    }))
}

/// Raw track objects of a list answer, stubs hydrated, order kept, unplayable ones dropped.
async fn raw_tracks_of(sc: &SoundCloud, v: &Result<Value, String>) -> Vec<Value> {
    let Ok(data) = v else { return Vec::new() };
    let items: Vec<Value> = collection(data).iter().map(|i| unwrap_item(i, "track").clone()).collect();
    if items.is_empty() {
        return Vec::new();
    }
    sc.hydrate(&Value::Array(items)).await.into_iter().filter(listable).collect()
}

/// Play counts by track id (riff's "plays" column on Popular).
fn plays_of(raw: &[Value], into: &mut serde_json::Map<String, Value>) {
    for t in raw {
        if let (Some(id), Some(n)) = (id_of(t), t["playback_count"].as_u64()) {
            into.insert(id, json!(n));
        }
    }
}

/// Round artist card (search rows, "Fans also like").
fn artist_card(u: &Value) -> Option<Value> {
    let id = id_of(u)?;
    let avatar = artwork(&str_of(u, "avatar_url").unwrap_or_default(), "t300x300");
    Some(json!({
        "id": id,
        "name": str_of(u, "username").unwrap_or_else(|| "Artist".into()),
        "avatar": if avatar.contains("default_avatar") { String::new() } else { avatar },
        "followers": u["followers_count"].as_u64().unwrap_or(0),
        "verified": u["verified"].as_bool().unwrap_or(false) || u["badges"]["verified"].as_bool().unwrap_or(false),
        "url": str_of(u, "permalink_url").unwrap_or_default(),
    }))
}

/// Every banner image of a profile (riff's banner carousel), first one = main banner.
fn banners_of(user: &Value) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for v in user["visuals"]["visuals"].as_array().map(Vec::as_slice).unwrap_or(&[]) {
        if let Some(u) = str_of(v, "visual_url") {
            if !out.contains(&u) {
                out.push(u);
            }
        }
    }
    out
}

/// Artists and albums for a search query (riff's "Show artists in search" / "Albums").
async fn search_extras(sc: &SoundCloud, args: &Value) -> super::Out {
    let q = arg_str(args, "q");
    if q.trim().is_empty() || q.starts_with("http") {
        return Ok(json!({ "artists": [], "albums": [] }));
    }
    let key = format!("sx:{}", q.to_lowercase());
    if let Some(v) = cached(&key) {
        return Ok(v);
    }
    let want_artists = args["artists"].as_bool().unwrap_or(true);
    let want_albums = args["albums"].as_bool().unwrap_or(true);
    let lim = [("q", q.clone()), ("limit", "12".to_string())];
    let (users, albums) = futures::join!(
        async { if want_artists { sc.api("/search/users", &lim).await.map_err(e) } else { Ok(json!({})) } },
        async { if want_albums { sc.api("/search/albums", &lim).await.map_err(e) } else { Ok(json!({})) } },
    );
    let artists: Vec<Value> = users
        .as_ref()
        .map(|d| {
            collection(d)
                .iter()
                .filter_map(|u| {
                    let id = id_of(u)?;
                    let avatar = artwork(&str_of(u, "avatar_url").unwrap_or_default(), "t300x300");
                    Some(json!({
                        "id": id,
                        "name": str_of(u, "username").unwrap_or_else(|| "Artist".into()),
                        "avatar": if avatar.contains("default_avatar") { String::new() } else { avatar },
                        "followers": u["followers_count"].as_u64().unwrap_or(0),
                        "url": str_of(u, "permalink_url").unwrap_or_default(),
                    }))
                })
                .collect()
        })
        .unwrap_or_default();
    let albums: Vec<Value> = albums.as_ref().map(|d| collection(d).iter().filter_map(release_of).collect()).unwrap_or_default();
    let out = json!({ "artists": artists, "albums": albums });
    remember(&key, &out);
    Ok(out)
}

/// The artist page plus `following` (true / false for the signed-in account,
/// null when logged out or unknown). The page is cached; the flag has its own
/// short cache that `follow` updates.
async fn artist(sc: &SoundCloud, args: &Value) -> super::Out {
    let mut out = artist_page(sc, args).await?;
    let uid = out["id"].as_str().unwrap_or_default().to_string();
    let following = if sc.token().is_some() && is_num_id(&uid) {
        follow_state(sc, &uid).await.map(|s| s["following"].clone()).unwrap_or(Value::Null)
    } else {
        Value::Null
    };
    out["following"] = following;
    Ok(out)
}

async fn artist_page(sc: &SoundCloud, args: &Value) -> super::Out {
    let uid = resolve_user_id(sc, args).await?;
    let key = format!("artist:{uid}");
    if !args["refresh"].as_bool().unwrap_or(false) {
        if let Some(v) = cached(&key) {
            return Ok(v);
        }
    }
    let (p_user, p_top, p_tracks, p_albums, p_lists) = (
        format!("/users/{uid}"),
        format!("/users/{uid}/toptracks"),
        format!("/users/{uid}/tracks"),
        format!("/users/{uid}/albums"),
        format!("/users/{uid}/playlists_without_albums"),
    );
    let p_related = format!("/users/{uid}/relatedartists");
    let q10 = [("limit", "10".to_string())];
    let q50 = [("limit", "50".to_string()), ("linked_partitioning", "1".to_string())];
    let q30 = [("limit", "30".to_string())];
    let q_rel = [("limit", "12".to_string()), ("page_items", "12".to_string()), ("creators_only", "false".to_string())];
    let (user, top, latest, albums, playlists, related) = futures::join!(
        sc.api(&p_user, &[]),
        sc.api(&p_top, &q10),
        sc.api(&p_tracks, &q50),
        sc.api(&p_albums, &q30),
        sc.api(&p_lists, &q30),
        sc.api(&p_related, &q_rel),
    );
    let user = user.map_err(|err| format!("Couldn't load this artist ({err})"))?;
    let (top, latest, albums, playlists) = (top.map_err(e), latest.map_err(e), albums.map_err(e), playlists.map_err(e));

    let (raw_latest, mut raw_top) = futures::join!(raw_tracks_of(sc, &latest), raw_tracks_of(sc, &top));
    if raw_top.is_empty() {
        // No "top tracks" for small artists: rank their uploads by plays instead.
        raw_top = raw_latest.clone();
        raw_top.sort_by_key(|t| std::cmp::Reverse(t["playback_count"].as_u64().unwrap_or(0)));
        raw_top.truncate(10);
    }
    let mut plays = serde_json::Map::new();
    plays_of(&raw_latest, &mut plays);
    plays_of(&raw_top, &mut plays);
    let latest_tracks: Vec<Track> = raw_latest.iter().map(map_track).collect();
    let top_tracks: Vec<Track> = raw_top.iter().map(map_track).collect();
    let tracks_next = latest.as_ref().ok().and_then(|d| str_of(d, "next_href")).unwrap_or_default();
    let related: Vec<Value> = related
        .as_ref()
        .map(|d| collection(d).iter().map(|i| unwrap_item(i, "user")).filter(|u| id_of(u).as_deref() != Some(uid.as_str())).filter_map(artist_card).collect())
        .unwrap_or_default();
    let releases =
        |r: &Result<Value, String>| -> Vec<Value> { r.as_ref().map(|d| collection(d).iter().filter_map(release_of).collect()).unwrap_or_default() };
    let banners = banners_of(&user);
    let banner = banners.first().cloned().unwrap_or_default();
    let avatar = artwork(&str_of(&user, "avatar_url").unwrap_or_default(), "t500x500");
    let out = json!({
        "id": uid,
        "name": str_of(&user, "username").unwrap_or_else(|| "Artist".into()),
        "fullName": str_of(&user, "full_name").unwrap_or_default(),
        "avatar": if avatar.contains("default_avatar") { String::new() } else { avatar },
        "banner": banner,
        "followers": user["followers_count"].as_u64().unwrap_or(0),
        "trackCount": user["track_count"].as_u64().unwrap_or(0),
        "description": str_of(&user, "description").unwrap_or_default(),
        "city": str_of(&user, "city").unwrap_or_default(),
        "country": str_of(&user, "country_code").unwrap_or_default(),
        "verified": user["verified"].as_bool().unwrap_or(false) || user["badges"]["verified"].as_bool().unwrap_or(false),
        "url": str_of(&user, "permalink_url").unwrap_or_default(),
        "top": top_tracks,
        "tracks": latest_tracks,
        "albums": releases(&albums),
        "playlists": releases(&playlists),
        "banners": banners,
        "plays": plays,
        "tracksNext": tracks_next,
        "related": related,
        "likes": user["likes_count"].as_u64().unwrap_or(0),
        "followings": user["followings_count"].as_u64().unwrap_or(0),
    });
    remember(&key, &out);
    Ok(out)
}

/// One page of an artist's uploads (the "All tracks" category). `next` is the
/// cursor from the previous page (`tracksNext` / `next`); it must point at this user's tracks.
async fn artist_tracks(sc: &SoundCloud, args: &Value) -> super::Out {
    let uid = arg_str(args, "id");
    if !is_num_id(&uid) {
        return Err("Not a SoundCloud artist id".into());
    }
    let next = arg_str(args, "next");
    let own = format!("api-v2.soundcloud.com/users/{uid}/tracks");
    let endpoint = if !next.is_empty() && next.contains(&own) { next } else { format!("/users/{uid}/tracks") };
    let key = format!("atracks:{endpoint}");
    if let Some(v) = cached(&key) {
        return Ok(v);
    }
    let page: Result<Value, String> =
        Ok(sc.api(&endpoint, &[("limit", "50".to_string()), ("linked_partitioning", "1".to_string())]).await.map_err(e)?);
    let raw = raw_tracks_of(sc, &page).await;
    let mut plays = serde_json::Map::new();
    plays_of(&raw, &mut plays);
    let tracks: Vec<Track> = raw.iter().map(map_track).collect();
    let next = page.as_ref().ok().and_then(|d| str_of(d, "next_href")).unwrap_or_default();
    let out = json!({ "tracks": tracks, "plays": plays, "next": next });
    remember(&key, &out);
    Ok(out)
}

// ---------------- follow / unfollow ----------------
//
// Own requests (not `sc.api`): a 401 here can mean "this token may not do
// that", which must not mark the whole session expired.

const API_V2: &str = "https://api-v2.soundcloud.com";

async fn me_request(sc: &SoundCloud, method: reqwest::Method, endpoint: &str) -> Result<(u16, Value), String> {
    let token = sc.token().ok_or("Connect SoundCloud first.")?;
    let client_id = sc.client_id(false).await.map_err(e)?;
    let sep = if endpoint.contains('?') { '&' } else { '?' };
    let url = format!("{API_V2}{endpoint}{sep}client_id={client_id}");
    let res = sc
        .http
        .request(method, url)
        .header(reqwest::header::ACCEPT, "application/json")
        .header(reqwest::header::AUTHORIZATION, format!("OAuth {token}"))
        .header(reqwest::header::ORIGIN, "https://soundcloud.com")
        .header(reqwest::header::REFERER, "https://soundcloud.com/")
        .send()
        .await
        .map_err(|err| format!("SoundCloud request failed: {err}"))?;
    let status = res.status().as_u16();
    let body = res.json::<Value>().await.unwrap_or(Value::Null);
    Ok((status, body))
}

fn follow_key(uid: &str) -> String {
    format!("follow:{uid}")
}

/// Whether the signed-in account follows `uid`. `following` is null when it can't tell.
async fn follow_state(sc: &SoundCloud, uid: &str) -> super::Out {
    if !is_num_id(uid) {
        return Err("Not a SoundCloud artist id".into());
    }
    let (Some(_), Ok(me)) = (sc.token(), sc.user_id()) else {
        return Ok(json!({ "loggedIn": false, "following": null }));
    };
    if me == uid {
        return Ok(json!({ "loggedIn": true, "following": null, "self": true }));
    }
    if let Some(v) = cached(&follow_key(uid)) {
        return Ok(v);
    }
    // Direct check first: 200 = following, 404 = not.
    let mut following: Option<bool> = None;
    let mut via = "me/followings";
    if let Ok((status, _)) = me_request(sc, reqwest::Method::GET, &format!("/me/followings/{uid}")).await {
        if (200..300).contains(&status) {
            following = Some(true);
        } else if status == 404 {
            following = Some(false);
        }
    }
    if following.is_none() {
        // Fall back to the id list of everyone the account follows.
        via = "followings/ids";
        if let Ok((200, body)) = me_request(sc, reqwest::Method::GET, &format!("/users/{me}/followings/ids?limit=5000")).await {
            following = Some(ids_of(&body["collection"]).contains(uid));
        }
    }
    let out = json!({ "loggedIn": true, "following": following, "via": via });
    if following.is_some() {
        remember(&follow_key(uid), &out);
    }
    Ok(out)
}

async fn follow(sc: &SoundCloud, uid: &str, on: bool) -> super::Out {
    if !is_num_id(uid) {
        return Err("Not a SoundCloud artist id".into());
    }
    if sc.token().is_none() {
        return Err("Connect SoundCloud to follow artists.".into());
    }
    let path = format!("/me/followings/{uid}");
    let mut status = 0u16;
    // PUT / DELETE /me/followings/{uid}; POST is the web player's older verb, tried if PUT isn't accepted.
    let methods: &[reqwest::Method] =
        if on { &[reqwest::Method::PUT, reqwest::Method::POST] } else { &[reqwest::Method::DELETE] };
    for m in methods {
        status = me_request(sc, m.clone(), &path).await?.0;
        if (200..300).contains(&status) || (!on && status == 404) || !(status == 404 || status == 405) {
            break;
        }
    }
    if (200..300).contains(&status) || (!on && status == 404) {
        let out = json!({ "loggedIn": true, "following": on, "via": "set" });
        remember(&follow_key(uid), &out);
        return Ok(json!({ "following": on }));
    }
    Err(match status {
        401 | 403 => "SoundCloud didn't allow that. Reconnect your account and try again.".to_string(),
        429 => "SoundCloud is rate limiting. Try again in a minute.".to_string(),
        s => format!("SoundCloud answered {s}"),
    })
}

async fn set_tracks(sc: &SoundCloud, id: &str) -> super::Out {
    if !is_num_id(id) {
        return Err("Not a SoundCloud playlist id".into());
    }
    let key = format!("set:{id}");
    if let Some(v) = cached(&key) {
        return Ok(v);
    }
    let data = sc.api(&format!("/playlists/{id}"), &[]).await.map_err(e)?;
    let tracks: Vec<Track> = sc.hydrate(&data["tracks"]).await.iter().filter(|t| listable(t)).map(map_track).collect();
    let mut out = release_of(&data).unwrap_or_else(|| json!({ "id": id }));
    out["tracks"] = json!(tracks);
    out["description"] = json!(str_of(&data, "description").unwrap_or_default());
    out["artistId"] = json!(id_of(&data["user"]).unwrap_or_default());
    remember(&key, &out);
    Ok(out)
}

// ------------------------------------------------------------------
// For you (system playlists)
// ------------------------------------------------------------------

/// Made for you (Daily Drops, Weekly Wave, mixes), Your moods and artist
/// Stations. Only listed here; tracks are fetched on demand.
const FOR_YOU_SELECTIONS: [&str; 3] = ["made-for-you", "your-moods", "artist-stations"];

fn parse_for_you(data: &Value) -> Vec<Value> {
    let mut out: Vec<(u8, Value)> = Vec::new();
    for sel in collection(data) {
        let urn = sel["urn"].as_str().unwrap_or("");
        let Some(group) = FOR_YOU_SELECTIONS.iter().find(|g| urn.contains(&format!("selections:{g}"))) else { continue };
        let group = if *group == "artist-stations" { "station" } else { "mix" };
        for item in collection(&sel["items"]) {
            if item["kind"].as_str() != Some("system-playlist") {
                continue;
            }
            let Some(item_urn) = str_of(item, "urn") else { continue };
            let art = str_of(item, "calculated_artwork_url").or_else(|| str_of(item, "artwork_url")).unwrap_or_default();
            let count = item["tracks"].as_array().map(|t| t.len() as u64).or_else(|| item["track_count"].as_u64()).unwrap_or(0);
            // Daily Drops and Weekly Wave first, then mixes, then stations.
            let rank = if item_urn.contains("new-for-you") {
                0
            } else if item_urn.contains(":weekly:") {
                1
            } else if group == "mix" {
                2
            } else {
                3
            };
            out.push((
                rank,
                json!({
                    "urn": item_urn,
                    "group": group,
                    "featured": rank < 2,
                    "title": str_of(item, "title").or_else(|| str_of(item, "short_title")).unwrap_or_else(|| "SoundCloud mix".into()),
                    "description": str_of(item, "short_description").unwrap_or_default(),
                    "trackCount": count,
                    "artwork": artwork(&art, "t300x300"),
                }),
            ));
        }
    }
    out.sort_by_key(|(r, _)| *r);
    out.into_iter().map(|(_, v)| v).collect()
}

async fn for_you(sc: &SoundCloud, refresh: bool) -> super::Out {
    if sc.token().is_none() {
        return Err("Connect SoundCloud to see mixes made for you.".into());
    }
    if !refresh {
        if let Some(v) = cached("for_you") {
            return Ok(v);
        }
    }
    let data = sc.api("/mixed-selections", &[("limit", "20".into())]).await.map_err(e)?;
    let out = Value::Array(parse_for_you(&data));
    remember("for_you", &out);
    Ok(out)
}

static URN_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^soundcloud:system-playlists:[\w:-]+$").unwrap());

async fn system_playlist(sc: &SoundCloud, urn: &str) -> super::Out {
    if sc.token().is_none() {
        return Err("Connect SoundCloud to play this mix.".into());
    }
    if !URN_RE.is_match(urn) {
        return Err("Not a SoundCloud system playlist".into());
    }
    let key = format!("sys:{urn}");
    if let Some(v) = cached(&key) {
        return Ok(v);
    }
    let data = sc.api(&format!("/system-playlists/{}", urn.replace(':', "%3A")), &[]).await.map_err(e)?;
    // The playlist only carries track ids: hydrate them, keeping order.
    let tracks: Vec<Track> = sc.hydrate(&data["tracks"]).await.iter().filter(|t| playable(t)).map(map_track).collect();
    let art = str_of(&data, "calculated_artwork_url").or_else(|| str_of(&data, "artwork_url")).unwrap_or_default();
    let out = json!({
        "urn": urn,
        "title": str_of(&data, "title").unwrap_or_else(|| "SoundCloud mix".into()),
        "description": str_of(&data, "short_description").or_else(|| str_of(&data, "description")).unwrap_or_default(),
        "artwork": artwork(&art, "t300x300"),
        "tracks": tracks,
    });
    remember(&key, &out);
    Ok(out)
}

// ------------------------------------------------------------------
// genre families (port of riff's radio-style.js)
// ------------------------------------------------------------------

const FAMILIES: &[(&str, &[&str])] = &[
    ("harddance", &["tekk", "tekno", "hardstyle", "jumpstyle", "rawstyle", "schranz", "gabber", "hardcore", "frenchcore", "uptempo", "speedcore", "hard dance", "harddance", "hardbass", "hard techno", "hardtechno", "mylancore", "rave"]),
    ("techno", &["techno", "minimal", "acid", "industrial", "ebm"]),
    ("house", &["house", "deep house", "tech house", "garage", "ukg", "disco", "baile", "jersey club", "jersey", "club"]),
    ("trance", &["trance", "psytrance", "psy", "goa"]),
    ("dnb", &["drum and bass", "drum & bass", "drum n bass", "dnb", "jungle", "breakcore", "breakbeat", "breaks", "liquid"]),
    ("bass", &["dubstep", "riddim", "bass music", "brostep", "trap edm", "future bass", "wave", "drift"]),
    ("phonk", &["phonk", "drift phonk", "cowbell", "montagem", "funk", "brazilian funk", "baile funk"]),
    ("rap", &["hip hop", "hip-hop", "hiphop", "rap", "trap", "drill", "grime", "plugg", "pluggnb", "rage", "opium", "opiumcore", "jerk", "hoodtrap", "boom bap", "cloud rap"]),
    ("hyperpop", &["hyperpop", "digicore", "glitchcore", "nightcore", "pc music"]),
    ("pop", &["pop", "dance pop", "k-pop", "kpop", "j-pop", "synthpop", "electropop"]),
    ("rnb", &["r&b", "rnb", "soul", "neo soul"]),
    ("rock", &["rock", "punk", "emo", "grunge", "shoegaze", "post-punk", "indie rock", "alternative"]),
    ("metal", &["metal", "metalcore", "deathcore", "djent", "nu metal", "black metal", "doom"]),
    ("ambient", &["ambient", "lofi", "lo-fi", "chill", "downtempo", "drone", "piano", "classical", "soundtrack", "cinematic"]),
    ("latin", &["reggaeton", "latin", "cumbia", "bachata", "salsa", "dembow", "corrido"]),
    ("jazz", &["jazz", "swing", "blues", "bossa"]),
    ("folk", &["folk", "country", "acoustic", "singer-songwriter", "bluegrass"]),
];

/// Stems artists glue into names and titles ("tekk" in "HUMPSTEKK"): matched anywhere.
const INSIDE_WORD: &[&str] = &[
    "tekk", "tekno", "hardstyle", "jumpstyle", "rawstyle", "schranz", "gabber", "frenchcore", "speedcore", "mylancore", "hardbass", "phonk", "dubstep",
    "breakcore", "techno", "trance", "psytrance", "hyperpop", "digicore", "glitchcore", "reggaeton", "metalcore", "deathcore", "opiumcore", "hoodtrap",
];

/// Families close enough that a radio may move between them.
const NEIGHBOURS: &[(&str, &[&str])] = &[
    ("harddance", &["techno"]),
    ("techno", &["harddance", "house", "trance"]),
    ("house", &["techno"]),
    ("trance", &["techno"]),
    ("dnb", &["bass"]),
    ("bass", &["dnb"]),
    ("phonk", &["rap"]),
    ("rap", &["phonk", "rnb"]),
    ("rnb", &["rap", "pop"]),
    ("pop", &["rnb", "hyperpop"]),
    ("hyperpop", &["pop"]),
    ("rock", &["metal"]),
    ("metal", &["rock"]),
];

enum Stem {
    Inside(&'static str),
    Word(Regex),
}

static STEMS: LazyLock<Vec<(&'static str, Vec<Stem>)>> = LazyLock::new(|| {
    FAMILIES
        .iter()
        .map(|(family, stems)| {
            let list = stems
                .iter()
                .map(|stem| {
                    if INSIDE_WORD.contains(stem) {
                        Stem::Inside(stem)
                    } else {
                        // Whole word, allowing a plural "s".
                        Stem::Word(Regex::new(&format!(r"(^|[^\p{{L}}\p{{N}}]){}s?([^\p{{L}}\p{{N}}]|$)", regex::escape(stem))).unwrap())
                    }
                })
                .collect();
            (*family, list)
        })
        .collect()
});

static SEPARATORS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[_/|•·]+").unwrap());
/// Re-uploaded edits ("slowed + reverb", "sped up"…) form their own crowd on SoundCloud.
static EDIT_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(slowed|sped[\s._-]*up|speed[\s._-]*up|bass[\s._-]*boost(ed)?|reverb|nightcore|8d[\s._-]*audio|daycore|tiktok[\s._-]*(ver(sion)?|edit)?)\b").unwrap()
});
/// Uploads that are not songs: sample packs, preset demos, tutorials.
static NOT_A_SONG_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(sample\s*pack|soundbank|sound\s*bank|presets?|sylenth1?|serum\s*presets?|drum\s*kit|loop\s*kit|construction\s*kit|tutorial|stems?\s*pack)\b").unwrap()
});

type Profile = HashMap<String, f64>;

fn detect_families(text: &str) -> Profile {
    let t = format!(" {} ", SEPARATORS.replace_all(&text.to_lowercase(), " "));
    let mut found = Profile::new();
    for (family, stems) in STEMS.iter() {
        let hit = stems.iter().any(|s| match s {
            Stem::Inside(stem) => t.contains(stem),
            Stem::Word(re) => re.is_match(&t),
        });
        if hit {
            found.insert((*family).to_string(), 1.0);
        }
    }
    found
}

fn is_edit(text: &str) -> bool {
    EDIT_RE.is_match(text)
}

fn is_not_a_song(text: &str) -> bool {
    NOT_A_SONG_RE.is_match(text)
}

fn add_profile(profile: &mut Profile, families: &Profile, weight: f64) {
    for (f, w) in families {
        *profile.entry(f.clone()).or_insert(0.0) += w * weight;
    }
}

/// How well a candidate fits a radio's style profile: 1 = same family,
/// 0.4 = a neighbour that is a real part of the profile, 0 = unrelated,
/// None = the candidate has no detectable genre.
fn style_fit(profile: &Profile, cand: &Profile) -> Option<f64> {
    if cand.is_empty() {
        return None;
    }
    let sum: f64 = profile.values().sum();
    let total = if sum > 0.0 { sum } else { 1.0 };
    let mut best: f64 = 0.0;
    for f in cand.keys() {
        match profile.get(f).copied().filter(|w| *w > 0.0) {
            Some(w) => best = best.max(0.5 + 0.5 * (w / total * 2.0).min(1.0)),
            None => {
                // A neighbouring genre counts only if it is a real part of the profile, not a stray tag.
                let near = NEIGHBOURS.iter().find(|(n, _)| *n == f.as_str()).map(|(_, l)| *l).unwrap_or(&[]);
                if near.iter().any(|n| profile.get(*n).copied().unwrap_or(0.0) / total >= 0.25) {
                    best = best.max(0.4);
                }
            }
        }
    }
    Some(best)
}

// ------------------------------------------------------------------
// song radio (port of riff's recommendRadioTracks)
// ------------------------------------------------------------------

#[derive(Clone)]
struct Anchor {
    profile: Profile,
    is_edit: bool,
    duration: u64,
}

/// Bounded insertion-ordered set.
struct Recent {
    order: VecDeque<String>,
    set: HashSet<String>,
    cap: usize,
}

impl Recent {
    fn new(cap: usize) -> Self {
        Self { order: VecDeque::new(), set: HashSet::new(), cap }
    }
    fn has(&self, k: &str) -> bool {
        self.set.contains(k)
    }
    fn add(&mut self, k: String) {
        if self.set.insert(k.clone()) {
            self.order.push_back(k);
            while self.order.len() > self.cap {
                if let Some(old) = self.order.pop_front() {
                    self.set.remove(&old);
                }
            }
        }
    }
}

struct RadioMem {
    anchors: Ttl<Anchor>,
    /// style text of tracks radio handed out (track id -> text)
    style_by_id: HashMap<String, String>,
    style_order: VecDeque<String>,
    /// anchor id -> ids of handed-out tracks that clearly fit its style
    good: HashMap<String, Vec<String>>,
    recent_ids: Recent,
    recent_keys: Recent,
}

static RADIO: LazyLock<Mutex<RadioMem>> = LazyLock::new(|| {
    Mutex::new(RadioMem {
        anchors: Ttl::new(PROFILE_TTL, 50),
        style_by_id: HashMap::new(),
        style_order: VecDeque::new(),
        good: HashMap::new(),
        recent_ids: Recent::new(100),
        recent_keys: Recent::new(100),
    })
});

/// SoundCloud's "related tracks" for one track (cached).
async fn related(sc: &SoundCloud, id: &str, limit: u32) -> Vec<Track> {
    let key = format!("rel:{id}:{limit}");
    if let Some(v) = cached(&key) {
        return serde_json::from_value(v).unwrap_or_default();
    }
    let Ok(data) = sc.api(&format!("/tracks/{id}/related"), &[("limit", limit.to_string())]).await else { return Vec::new() };
    let list: Vec<Track> = collection(&data).iter().filter(|t| playable(t)).map(map_track).collect();
    remember(&key, &json!(list));
    list
}

/// Style profile for the anchor plus its uploader's other tracks: many uploads
/// have no genre of their own, but the artist's catalogue usually does.
async fn anchor_for(sc: &SoundCloud, id: &str) -> Anchor {
    let hit = RADIO.lock().unwrap().anchors.get(id);
    if let Some(a) = hit {
        return a;
    }
    let mut profile = Profile::new();
    let mut anchor_edit = false;
    let mut duration = 0;
    if let Ok(track) = sc.api(&format!("/tracks/{id}"), &[]).await {
        let t = map_track(&track);
        add_profile(&mut profile, &detect_families(&t.style), 3.0);
        anchor_edit = is_edit(&t.style);
        duration = t.duration;
        if let Some(uid) = id_of(&track["user"]) {
            if let Ok(data) = sc.api(&format!("/users/{uid}/tracks"), &[("limit", "30".into())]).await {
                for u in collection(&data) {
                    add_profile(&mut profile, &detect_families(&map_track(u).style), 1.0);
                }
            }
        }
    }
    let a = Anchor { profile, is_edit: anchor_edit, duration };
    RADIO.lock().unwrap().anchors.put(id.to_string(), a.clone());
    a
}

struct Cand {
    t: Track,
    key: String,
    score: f64,
    fit: Option<f64>,
}

async fn radio(sc: &SoundCloud, args: &Value) -> super::Out {
    let seed = &args["seed"];
    let anchor_id = arg_str(seed, "id");
    if !is_num_id(&anchor_id) {
        return Err("Song radio works with SoundCloud tracks".into());
    }
    let limit = args["limit"].as_u64().unwrap_or(10).clamp(1, 40) as usize;
    let avoid = ids_of(&args["avoid"]);
    let played: Vec<String> = args["played"]
        .as_array()
        .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from).or_else(|| id_of(x))).collect())
        .unwrap_or_default();

    let anchor = anchor_for(sc, &anchor_id).await;
    let has_profile = !anchor.profile.is_empty();
    // Hour-long DJ sets sit in the same genre but aren't songs; skip them unless the radio started from one.
    let max_duration = 600u64.max(anchor.duration * 3 / 2);

    // Branch out only from radio songs that clearly fit the style (a song with no
    // genre info would pull its own off-genre list in); top up from earlier good picks.
    let branch_ids: Vec<String> = {
        let mem = RADIO.lock().unwrap();
        let fit_of = |id: &str| -> f64 {
            match mem.style_by_id.get(id) {
                Some(text) if has_profile => style_fit(&anchor.profile, &detect_families(text)).unwrap_or(0.0),
                _ => 0.0,
            }
        };
        let mut branch: Vec<String> =
            played.iter().rev().take(2).filter(|id| is_num_id(id) && **id != anchor_id && fit_of(id) >= 0.9).cloned().collect();
        let mut good: Vec<String> = mem.good.get(&anchor_id).cloned().unwrap_or_default().into_iter().filter(|id| !branch.contains(id)).collect();
        while branch.len() < 2 && !good.is_empty() {
            let i = ((random() * good.len() as f64) as usize).min(good.len() - 1);
            branch.push(good.swap_remove(i));
        }
        branch
    };

    // Candidate lists: the anchor's related tracks count fully, branch songs' lists less.
    let mut sources: Vec<(String, f64, bool)> = vec![(anchor_id.clone(), 1.0, true)];
    sources.extend(branch_ids.into_iter().take(2).map(|id| (id, 0.6, false)));
    let lists = join_all(sources.iter().map(|(id, _, _)| related(sc, id, 50))).await;

    let anchor_key = track_key(&arg_str(seed, "artist"), &arg_str(seed, "title"));
    let ranked: Vec<Cand> = {
        let mem = RADIO.lock().unwrap();
        let mut by_id: HashMap<String, Cand> = HashMap::new();
        for (li, list) in lists.iter().enumerate() {
            let (_, weight, is_anchor) = sources[li];
            for (rank, t) in list.iter().enumerate() {
                let key = track_key(&t.artist, &t.title);
                if t.id == anchor_id || key == anchor_key || avoid.contains(&t.id) {
                    continue;
                }
                if mem.recent_ids.has(&t.id) || mem.recent_keys.has(&key) {
                    continue;
                }
                if (!anchor.is_edit && is_edit(&t.style)) || is_not_a_song(&t.style) || t.duration > max_duration {
                    continue;
                }
                let fit = if has_profile { style_fit(&anchor.profile, &detect_families(&t.style)) } else { None };
                if fit == Some(0.0) {
                    continue; // a different genre
                }
                // No genre info: trust only the anchor's own list, and only near its top.
                if fit.is_none() && (!is_anchor || rank >= 12) {
                    continue;
                }
                let score = (fit.unwrap_or(0.3) + (1.0 - rank as f64 / 50.0) * 0.5) * weight + random() * 0.1;
                if by_id.get(&t.id).is_none_or(|p| score > p.score) {
                    by_id.insert(t.id.clone(), Cand { t: t.clone(), key, score, fit });
                }
            }
        }
        let mut v: Vec<Cand> = by_id.into_values().collect();
        v.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
        v
    };

    // Better a short batch than a wrong one: the app asks again before the queue runs out.
    let mut mem = RADIO.lock().unwrap();
    let mut per_artist: HashMap<String, u32> = HashMap::new();
    let mut good = mem.good.remove(&anchor_id).unwrap_or_default();
    let mut out = Vec::new();
    for c in ranked {
        let n = per_artist.entry(artist_key(&c.t.artist)).or_insert(0);
        if *n >= 2 {
            continue;
        }
        *n += 1;
        if mem.style_by_id.insert(c.t.id.clone(), c.t.style.clone()).is_none() {
            mem.style_order.push_back(c.t.id.clone());
        }
        if c.fit.unwrap_or(0.0) >= 0.9 {
            good.push(c.t.id.clone());
        }
        mem.recent_ids.add(c.t.id.clone());
        mem.recent_keys.add(c.key);
        out.push(c.t);
        if out.len() >= limit {
            break;
        }
    }
    let keep = good.len().saturating_sub(60);
    if mem.good.len() >= 50 {
        if let Some(k) = mem.good.keys().next().cloned() {
            mem.good.remove(&k);
        }
    }
    mem.good.insert(anchor_id, good.split_off(keep));
    while mem.style_order.len() > 1000 {
        if let Some(old) = mem.style_order.pop_front() {
            mem.style_by_id.remove(&old);
        }
    }
    drop(mem);
    Ok(json!(out))
}

// ------------------------------------------------------------------
// My Wave: a personal mix from the related tracks of a few weighted seeds
// ------------------------------------------------------------------

static WAVES: LazyLock<Mutex<Ttl<Vec<Track>>>> = LazyLock::new(|| Mutex::new(Ttl::new(WAVE_TTL, 20)));

/// Weighted pick without replacement (like riff's pickWeightedSeeds).
fn pick_weighted(mut pool: Vec<(String, f64)>, count: usize) -> Vec<(String, f64)> {
    let mut picked = Vec::new();
    while picked.len() < count && !pool.is_empty() {
        let total: f64 = pool.iter().map(|(_, w)| w).sum();
        let mut r = random() * total;
        let mut idx = pool.len() - 1;
        for (i, (_, w)) in pool.iter().enumerate() {
            r -= w;
            if r <= 0.0 {
                idx = i;
                break;
            }
        }
        picked.push(pool.swap_remove(idx));
    }
    picked
}

/// Merges related lists into one ranked, de-duplicated wave.
fn rank_wave(lists: &[(f64, Vec<Track>)], skip: &HashSet<String>, limit: usize, jitter: impl Fn() -> f64) -> Vec<Track> {
    let mut best: HashMap<String, (f64, Track)> = HashMap::new();
    for (weight, list) in lists {
        let n = list.len().max(1) as f64;
        for (rank, t) in list.iter().enumerate() {
            if skip.contains(&t.id) || is_edit(&t.style) || is_not_a_song(&t.style) || t.duration > 900 || t.duration < 45 {
                continue;
            }
            let key = track_key(&t.artist, &t.title);
            let score = weight * (1.0 - rank as f64 / n) + jitter() * 0.35;
            // Showing up in several seeds' lists is a strong signal.
            best.entry(key).and_modify(|e| e.0 = e.0.max(score) + 0.3).or_insert((score, t.clone()));
        }
    }
    let mut v: Vec<(f64, Track)> = best.into_values().collect();
    v.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    let mut per_artist: HashMap<String, u32> = HashMap::new();
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for (_, t) in v {
        let n = per_artist.entry(artist_key(&t.artist)).or_insert(0);
        if *n >= 2 || !seen.insert(t.id.clone()) {
            continue;
        }
        *n += 1;
        out.push(t);
        if out.len() >= limit {
            break;
        }
    }
    out
}

async fn wave(sc: &SoundCloud, args: &Value) -> super::Out {
    let limit = args["limit"].as_u64().unwrap_or(30).clamp(1, 60) as usize;
    let refresh = args["refresh"].as_bool().unwrap_or(false);
    let avoid = ids_of(&args["avoid"]);
    let pool: Vec<(String, f64)> = args["seeds"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|s| {
                    let id = arg_str(s, "id");
                    is_num_id(&id).then(|| (id, s["weight"].as_f64().unwrap_or(1.0).max(0.1)))
                })
                .collect()
        })
        .unwrap_or_default();
    if pool.is_empty() {
        return Err("Like or play a few SoundCloud tracks to tune My Wave.".into());
    }
    let mut ids: Vec<&str> = pool.iter().map(|(id, _)| id.as_str()).collect();
    ids.sort_unstable();
    let cache_key = ids.join(",");
    if !refresh && avoid.is_empty() {
        let hit = WAVES.lock().unwrap().get(&cache_key);
        if let Some(v) = hit {
            return Ok(json!(v));
        }
    }
    let seeds = pick_weighted(pool, 4);
    let lists: Vec<(f64, Vec<Track>)> = join_all(seeds.iter().map(|(id, w)| async move { (*w, related(sc, id, 30).await) })).await;
    let mut skip = ids_of(&args["heard"]);
    skip.extend(avoid.iter().cloned());
    skip.extend(seeds.iter().map(|(id, _)| id.clone()));
    let out = rank_wave(&lists, &skip, limit, random);
    if out.is_empty() {
        return Err("Couldn't tune My Wave right now. Try again in a moment.".into());
    }
    if avoid.is_empty() {
        WAVES.lock().unwrap().put(cache_key, out.clone());
    }
    Ok(json!(out))
}

// ------------------------------------------------------------------
// tests
// ------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn fam(text: &str) -> Vec<String> {
        let mut v: Vec<String> = detect_families(text).into_keys().collect();
        v.sort();
        v
    }

    fn track(id: &str, artist: &str, title: &str, style: &str) -> Track {
        Track {
            id: id.into(),
            title: title.into(),
            artist: artist.into(),
            duration: 200,
            artwork: String::new(),
            url: String::new(),
            artist_id: String::new(),
            artist_url: String::new(),
            genre: String::new(),
            style: style.into(),
            source: String::new(),
            path: String::new(),
        }
    }

    #[test]
    fn detects_families_like_riff() {
        assert_eq!(fam("HUMPSTEKK"), vec!["harddance"]);
        assert_eq!(fam("Deep House Mix"), vec!["house"]);
        assert!(fam("housewife").is_empty());
        assert_eq!(fam("drum & bass liquid"), vec!["dnb"]);
        assert_eq!(fam("lofi_beats/chill"), vec!["ambient"]);
        assert!(fam("hip-hop").contains(&"rap".to_string()));
        assert!(fam("Raps").contains(&"rap".to_string()));
    }

    #[test]
    fn spots_edits_and_non_songs() {
        assert!(is_edit("Song (Slowed + Reverb)"));
        assert!(is_edit("track sped up"));
        assert!(!is_edit("Speed of light"));
        assert!(is_not_a_song("Free Serum Presets Vol 2"));
        assert!(!is_not_a_song("Presence"));
    }

    #[test]
    fn style_fit_scores() {
        let mut p = Profile::new();
        add_profile(&mut p, &detect_families("techno"), 3.0);
        add_profile(&mut p, &detect_families("hard techno"), 1.0);
        assert_eq!(style_fit(&p, &detect_families("berlin techno")), Some(1.0));
        assert_eq!(style_fit(&p, &detect_families("country")), Some(0.0));
        assert_eq!(style_fit(&p, &detect_families("")), None);
        // house neighbours techno, which is most of the profile
        assert_eq!(style_fit(&p, &detect_families("tech house")), Some(0.4));
    }

    #[test]
    fn track_keys_match_reuploads() {
        assert_eq!(track_key("Artist feat. X", "Song (Official Video)"), track_key("Artist", "Song"));
        assert_eq!(track_key("A", "Song [HQ] ft. B"), "a::song");
        assert_eq!(track_key("A", "Left Behind"), "a::left behind");
    }

    #[test]
    fn for_you_parsing_orders_featured_first() {
        let data = json!({ "collection": [
            { "urn": "soundcloud:selections:artist-stations", "items": { "collection": [
                { "kind": "system-playlist", "urn": "soundcloud:system-playlists:artist-stations:1", "title": "Station A", "tracks": [{"id": 1}] }
            ]}},
            { "urn": "soundcloud:selections:made-for-you", "items": { "collection": [
                { "kind": "system-playlist", "urn": "soundcloud:system-playlists:your-mix:9", "title": "Mix 1" },
                { "kind": "system-playlist", "urn": "soundcloud:system-playlists:weekly:5", "title": "Weekly Wave" },
                { "kind": "system-playlist", "urn": "soundcloud:system-playlists:new-for-you:5", "title": "Daily Drops" },
                { "kind": "playlist", "urn": "x" }
            ]}},
            { "urn": "soundcloud:selections:charts", "items": { "collection": [
                { "kind": "system-playlist", "urn": "soundcloud:system-playlists:charts:1", "title": "Ignored" }
            ]}}
        ]});
        let list = parse_for_you(&data);
        let titles: Vec<&str> = list.iter().map(|p| p["title"].as_str().unwrap()).collect();
        assert_eq!(titles, vec!["Daily Drops", "Weekly Wave", "Mix 1", "Station A"]);
        assert_eq!(list[3]["group"], "station");
        assert_eq!(list[3]["trackCount"], 1);
        assert!(URN_RE.is_match("soundcloud:system-playlists:weekly:5"));
        assert!(!URN_RE.is_match("soundcloud:system-playlists:../x"));
    }

    #[test]
    fn wave_ranking_dedupes_and_caps_artists() {
        let a = vec![
            track("1", "A", "One", "house"),
            track("2", "A", "Two", "house"),
            track("3", "A", "Three", "house"),
            track("4", "B", "Four (slowed)", "Four slowed"),
            track("5", "C", "Five", "house"),
        ];
        let b = vec![track("5", "C", "Five", "house"), track("6", "D", "Six", "")];
        let skip: HashSet<String> = ["6".to_string()].into();
        let out = rank_wave(&[(1.0, a), (1.0, b)], &skip, 10, || 0.0);
        let ids: Vec<&str> = out.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(ids.iter().filter(|i| ["1", "2", "3"].contains(i)).count(), 2, "max two per artist");
        assert!(!ids.contains(&"4"), "edits are skipped");
        assert!(!ids.contains(&"6"), "heard tracks are skipped");
        assert_eq!(ids[0], "5", "a track in several lists ranks first");
    }

    #[test]
    fn weighted_pick_takes_distinct() {
        let pool = vec![("1".to_string(), 3.0), ("2".to_string(), 1.0), ("3".to_string(), 1.0)];
        let mut got: Vec<String> = pick_weighted(pool, 5).into_iter().map(|(id, _)| id).collect();
        got.sort();
        assert_eq!(got, vec!["1", "2", "3"]);
    }

    #[test]
    fn release_card_fields() {
        let r = release_of(&json!({ "id": 7, "title": "LP", "set_type": "album", "release_date": "2021-03-01T00:00:00Z",
            "tracks": [{ "id": 1 }, { "id": 2, "artwork_url": "https://i1.sndcdn.com/artworks-x-large.jpg" }], "user": { "username": "U" } }))
        .unwrap();
        assert_eq!(r["year"], "2021");
        assert_eq!(r["kind"], "album");
        assert_eq!(r["trackCount"], 2);
        assert_eq!(r["artwork"], "https://i1.sndcdn.com/artworks-x-t300x300.jpg");
    }

    #[test]
    fn artist_page_parts() {
        let user = json!({ "visuals": { "visuals": [{ "visual_url": "https://a/1.jpg" }, { "visual_url": "https://a/2.jpg" }, { "visual_url": "https://a/1.jpg" }] } });
        assert_eq!(banners_of(&user), vec!["https://a/1.jpg", "https://a/2.jpg"]);
        assert!(banners_of(&json!({})).is_empty());
        let c = artist_card(&json!({ "id": 5, "username": "Fan", "avatar_url": "https://i1.sndcdn.com/default_avatar_large.png",
            "followers_count": 12, "badges": { "verified": true } }))
        .unwrap();
        assert_eq!(c["name"], "Fan");
        assert_eq!(c["avatar"], "");
        assert_eq!(c["verified"], true);
        let mut plays = serde_json::Map::new();
        plays_of(&[json!({ "id": 1, "playback_count": 900 }), json!({ "id": 2 })], &mut plays);
        assert_eq!(plays.get("1"), Some(&json!(900)));
        assert!(plays.get("2").is_none());
    }

    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn live_artist_radio_and_wave() {
        let dir = std::env::temp_dir().join("riff-rs-discover-test");
        let _ = std::fs::create_dir_all(&dir);
        let sc = SoundCloud::new(dir);
        let trending = sc.trending().await.expect("trending");
        let seed = &trending[0];
        let a = artist(&sc, &json!({ "id": seed.artist_id })).await.expect("artist");
        println!(
            "artist {} followers {} top {} latest {} albums {} playlists {}",
            a["name"],
            a["followers"],
            a["top"].as_array().unwrap().len(),
            a["tracks"].as_array().unwrap().len(),
            a["albums"].as_array().unwrap().len(),
            a["playlists"].as_array().unwrap().len()
        );
        assert!(!a["top"].as_array().unwrap().is_empty() || !a["tracks"].as_array().unwrap().is_empty());
        let by_name = resolve_user_id(&sc, &json!({ "name": seed.artist })).await.expect("by name");
        println!("by name {} -> {by_name}", seed.artist);
        let r = radio(&sc, &json!({ "seed": seed, "limit": 10 })).await.expect("radio");
        println!("radio from {} ({}): {} tracks", seed.title, seed.genre, r.as_array().unwrap().len());
        let seeds: Vec<Value> = trending.iter().take(6).map(|t| json!({ "id": t.id, "weight": 1 })).collect();
        let w = wave(&sc, &json!({ "seeds": seeds })).await.expect("wave");
        println!("wave {} tracks", w.as_array().unwrap().len());
        assert!(!w.as_array().unwrap().is_empty());
    }
}
