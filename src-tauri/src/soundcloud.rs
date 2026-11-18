//! SoundCloud api-v2 client.
//!
//! Uses the same `client_id` the soundcloud.com web player uses (scraped from
//! its JS bundles) plus an optional OAuth token from the `oauth_token` cookie.
//!
//! Things this client gets right on purpose:
//! - Playlist / resolve payloads only carry full objects for the first few
//!   tracks; the rest are `{id, kind}` stubs. Those are fetched 50 at a time
//!   through `/tracks?ids=` (in parallel) and put back in playlist order.
//! - An expired OAuth token makes *every* request 401, even public ones. On a
//!   401 we refresh the client_id once; if it still fails with a token, we drop
//!   the token, retry anonymously and flag the session as expired.
//! - Likes are walked through `next_href` cursors (offsets are rejected).
//! - Streams: transcodings are ranked (progressive aac/mp3 first, encrypted
//!   HLS and snipped previews skipped) and `track_authorization` is sent.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex as StdMutex, OnceLock, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use futures::{stream, StreamExt};
use regex::Regex;
use reqwest::header::{ACCEPT, AUTHORIZATION, REFERER};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::Mutex;
use url::Url;

const WEB_BASE: &str = "https://soundcloud.com";
const API_BASE: &str = "https://api-v2.soundcloud.com";
const API_HOST: &str = "api-v2.soundcloud.com";
pub const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const CLIENT_ID_TTL_SECS: u64 = 12 * 60 * 60;
const RETRY_DELAYS_MS: [u64; 2] = [280, 800];
const STREAM_CACHE_TTL: Duration = Duration::from_secs(60);
const HYDRATE_BATCH: usize = 50;
const HYDRATE_PARALLEL: usize = 6;

static SCRIPT_SRC: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"<script[^>]+src="([^"]+)""#).unwrap());
static CLIENT_ID_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"client_id\s*[:=]\s*"([A-Za-z0-9]{20,})""#).unwrap());
static ART_SIZE_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"-(?:\d+x\d+|large|t\d+x\d+)(\.\w+)(\?.*)?$").unwrap());

// ------------------------------------------------------------------
// errors
// ------------------------------------------------------------------

#[derive(Debug, thiserror::Error)]
pub enum ScError {
    #[error("{0}")]
    Msg(String),
    #[error("SoundCloud answered {0}")]
    Status(u16),
    #[error("Connect SoundCloud first.")]
    NotLoggedIn,
}

impl Serialize for ScError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

pub type Result<T> = std::result::Result<T, ScError>;

fn msg(text: impl Into<String>) -> ScError {
    ScError::Msg(text.into())
}

// ------------------------------------------------------------------
// public data
// ------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Track {
    pub id: String,
    pub title: String,
    pub artist: String,
    /// seconds
    pub duration: u64,
    pub artwork: String,
    pub url: String,
    /// SoundCloud user id of the uploader (for artist pages / radio).
    #[serde(default)]
    pub artist_id: String,
    /// Uploader's profile URL.
    #[serde(default)]
    pub artist_url: String,
    #[serde(default)]
    pub genre: String,
    /// Genre / tags / title words, used by song radio to stay on style.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub style: String,
    /// "" for SoundCloud, otherwise e.g. "local" (feature modules).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub source: String,
    /// File path for local / downloaded tracks.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    pub oauth_token: String,
    pub user_id: String,
    pub username: String,
    pub avatar: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub logged_in: bool,
    pub expired: bool,
    pub username: String,
    pub avatar: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistSummary {
    pub id: String,
    pub title: String,
    pub track_count: u64,
    pub artwork: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct StreamInfo {
    pub url: String,
    /// "progressive" or "hls"
    pub protocol: String,
    pub preset: String,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
struct StoredClientId {
    client_id: String,
    at: u64,
}

// ------------------------------------------------------------------
// client
// ------------------------------------------------------------------

pub struct SoundCloud {
    pub(crate) http: reqwest::Client,
    dir: PathBuf,
    client_id: Mutex<StoredClientId>,
    session: RwLock<Option<Session>>,
    /// Token SoundCloud answered 401 to. While it matches the saved one,
    /// requests go out anonymously and the session reads as expired.
    rejected_token: RwLock<String>,
    streams: StdMutex<HashMap<String, (Instant, StreamInfo)>>,
    on_expired: OnceLock<Box<dyn Fn() + Send + Sync>>,
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &PathBuf) -> Option<T> {
    std::fs::read(path).ok().and_then(|b| serde_json::from_slice(&b).ok())
}

pub fn write_json<T: Serialize>(path: &PathBuf, value: &T) {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(bytes) = serde_json::to_vec(value) {
        let tmp = path.with_extension("tmp");
        if std::fs::write(&tmp, bytes).is_ok() {
            let _ = std::fs::rename(&tmp, path);
        }
    }
}

impl SoundCloud {
    pub fn new(dir: PathBuf) -> Self {
        let http = reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .timeout(Duration::from_secs(12))
            .connect_timeout(Duration::from_secs(6))
            .pool_idle_timeout(Duration::from_secs(90))
            .gzip(true)
            .brotli(true)
            .build()
            .expect("http client");
        let client_id = read_json::<StoredClientId>(&dir.join("soundcloud-client.json")).unwrap_or_default();
        let session = read_json::<Session>(&dir.join("soundcloud-session.json")).filter(|s| !s.oauth_token.trim().is_empty());
        Self {
            http,
            dir,
            client_id: Mutex::new(client_id),
            session: RwLock::new(session),
            rejected_token: RwLock::new(String::new()),
            streams: StdMutex::new(HashMap::new()),
            on_expired: OnceLock::new(),
        }
    }

    /// Called once when the saved token gets rejected (so the UI can offer a reconnect).
    pub fn set_on_expired(&self, f: impl Fn() + Send + Sync + 'static) {
        let _ = self.on_expired.set(Box::new(f));
    }

    // ---------------- client id ----------------

    pub(crate) async fn client_id(&self, force: bool) -> Result<String> {
        if let Ok(env) = std::env::var("SOUNDCLOUD_CLIENT_ID") {
            if !env.trim().is_empty() {
                return Ok(env.trim().to_string());
            }
        }
        // Holding the lock across the scrape means concurrent callers wait for
        // one resolve instead of each scraping soundcloud.com.
        let mut cached = self.client_id.lock().await;
        let age = now_secs().saturating_sub(cached.at);
        let fresh = !cached.client_id.is_empty() && age <= CLIENT_ID_TTL_SECS;
        // A forced refresh that another request already did seconds ago is reused.
        if fresh && (!force || age < 15) {
            return Ok(cached.client_id.clone());
        }
        let id = self.scrape_client_id().await?;
        *cached = StoredClientId { client_id: id.clone(), at: now_secs() };
        write_json(&self.dir.join("soundcloud-client.json"), &*cached);
        Ok(id)
    }

    async fn scrape_client_id(&self) -> Result<String> {
        let html = self
            .http
            .get(format!("{WEB_BASE}/discover"))
            .header(ACCEPT, "text/html")
            .send()
            .await
            .map_err(|e| msg(format!("Could not reach soundcloud.com: {e}")))?
            .text()
            .await
            .map_err(|e| msg(format!("Could not read soundcloud.com: {e}")))?;
        let mut scripts: Vec<String> = SCRIPT_SRC
            .captures_iter(&html)
            .map(|c| c[1].to_string())
            .filter(|src| src.contains("sndcdn.com"))
            .collect();
        // The id lives in one of the late bundles, so check from the back.
        scripts.reverse();
        let http = &self.http;
        let mut bundles = stream::iter(scripts)
            .map(|src| async move {
                let res = http.get(&src).send().await.ok()?;
                if !res.status().is_success() {
                    return None;
                }
                res.text().await.ok()
            })
            .buffered(4);
        while let Some(body) = bundles.next().await {
            if let Some(cap) = body.as_deref().and_then(|b| CLIENT_ID_RE.captures(b)) {
                return Ok(cap[1].to_string());
            }
        }
        Err(msg("Could not find a SoundCloud client id in the web player bundles."))
    }

    // ---------------- session ----------------

    fn saved_token(&self) -> Option<String> {
        self.session.read().unwrap().as_ref().map(|s| s.oauth_token.clone())
    }

    /// The token to send, or None when logged out or the token was rejected.
    pub(crate) fn token(&self) -> Option<String> {
        let token = self.saved_token()?;
        if *self.rejected_token.read().unwrap() == token {
            None
        } else {
            Some(token)
        }
    }

    fn reject_token(&self, token: &str) {
        let mut rejected = self.rejected_token.write().unwrap();
        if rejected.as_str() != token {
            *rejected = token.to_string();
            drop(rejected);
            if let Some(cb) = self.on_expired.get() {
                cb();
            }
        }
    }

    pub fn status(&self) -> Status {
        let session = self.session.read().unwrap();
        match session.as_ref() {
            None => Status { logged_in: false, expired: false, username: String::new(), avatar: String::new() },
            Some(s) => Status {
                logged_in: true,
                expired: *self.rejected_token.read().unwrap() == s.oauth_token,
                username: s.username.clone(),
                avatar: s.avatar.clone(),
            },
        }
    }

    pub fn is_logged_in(&self) -> bool {
        self.session.read().unwrap().is_some()
    }

    pub(crate) fn user_id(&self) -> Result<String> {
        let session = self.session.read().unwrap();
        let s = session.as_ref().ok_or(ScError::NotLoggedIn)?;
        if s.user_id.is_empty() {
            return Err(msg("The saved SoundCloud session has no user id. Reconnect it."));
        }
        Ok(s.user_id.clone())
    }

    /// Validates a token with /me and saves it as the session.
    pub async fn login_with_token(&self, token: &str) -> Result<Status> {
        let token = token.trim();
        if token.is_empty() {
            return Err(msg("Empty token"));
        }
        let mut client_id = self.client_id(false).await?;
        let mut refreshed = false;
        let me: Value = loop {
            let mut url = Url::parse(&format!("{API_BASE}/me")).unwrap();
            url.query_pairs_mut().append_pair("client_id", &client_id);
            let res = self
                .http
                .get(url)
                .header(ACCEPT, "application/json")
                .header(AUTHORIZATION, format!("OAuth {token}"))
                .send()
                .await
                .map_err(|e| msg(format!("SoundCloud request failed: {e}")))?;
            let status = res.status().as_u16();
            if res.status().is_success() {
                break res.json().await.map_err(|e| msg(format!("Bad /me answer: {e}")))?;
            }
            if (status == 401 || status == 403) && !refreshed {
                refreshed = true;
                client_id = self.client_id(true).await?;
                continue;
            }
            return Err(msg(format!("SoundCloud did not accept that sign-in ({status}).")));
        };
        let session = Session {
            oauth_token: token.to_string(),
            user_id: id_of(&me).unwrap_or_default(),
            username: str_of(&me, "username").or_else(|| str_of(&me, "full_name")).unwrap_or_default(),
            avatar: str_of(&me, "avatar_url").unwrap_or_default(),
        };
        write_json(&self.dir.join("soundcloud-session.json"), &session);
        *self.session.write().unwrap() = Some(session);
        self.rejected_token.write().unwrap().clear();
        Ok(self.status())
    }

    pub fn logout(&self) {
        *self.session.write().unwrap() = None;
        self.rejected_token.write().unwrap().clear();
        let _ = std::fs::remove_file(self.dir.join("soundcloud-session.json"));
    }

    // ---------------- request core ----------------

    fn build_url(endpoint: &str, params: &[(&str, String)], client_id: &str) -> Result<Url> {
        // Cursor links (next_href) arrive as absolute URLs; keep their path and
        // query but always send our own client_id.
        let mut url = if endpoint.starts_with("http") {
            Url::parse(endpoint).map_err(|e| msg(format!("Bad URL: {e}")))?
        } else {
            Url::parse(&format!("{API_BASE}{endpoint}")).map_err(|e| msg(format!("Bad URL: {e}")))?
        };
        let _ = url.set_scheme("https");
        let _ = url.set_host(Some(API_HOST));
        let keep: Vec<(String, String)> = url
            .query_pairs()
            .filter(|(k, _)| k != "client_id" && !params.iter().any(|(p, _)| p == k))
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect();
        {
            let mut q = url.query_pairs_mut();
            q.clear();
            for (k, v) in &keep {
                q.append_pair(k, v);
            }
            for (k, v) in params {
                if !v.is_empty() {
                    q.append_pair(k, v);
                }
            }
            q.append_pair("client_id", client_id);
        }
        Ok(url)
    }

    pub(crate) async fn api(&self, endpoint: &str, params: &[(&str, String)]) -> Result<Value> {
        let mut client_id = self.client_id(false).await?;
        let mut token = self.token();
        let mut refreshed = false;
        let mut dropped_token = false;
        let mut attempt = 0usize;
        loop {
            let url = Self::build_url(endpoint, params, &client_id)?;
            let mut req = self.http.get(url).header(ACCEPT, "application/json");
            if let Some(t) = &token {
                req = req.header(AUTHORIZATION, format!("OAuth {t}"));
            }
            let res = match req.send().await {
                Ok(r) => r,
                Err(e) => {
                    if attempt < RETRY_DELAYS_MS.len() {
                        tokio::time::sleep(Duration::from_millis(RETRY_DELAYS_MS[attempt])).await;
                        attempt += 1;
                        continue;
                    }
                    return Err(msg(format!("SoundCloud request failed: {e}")));
                }
            };
            let status = res.status().as_u16();
            if res.status().is_success() {
                return res.json::<Value>().await.map_err(|e| msg(format!("Bad SoundCloud answer: {e}")));
            }
            // A stale client_id is the most common 401/403: refresh it once.
            if (status == 401 || status == 403) && !refreshed {
                refreshed = true;
                if let Ok(id) = self.client_id(true).await {
                    client_id = id;
                    continue;
                }
            }
            // Still 401 with a fresh client_id: the saved login is dead. Flag it
            // and go anonymous so public requests keep working.
            if status == 401 && !dropped_token {
                if let Some(t) = token.take() {
                    dropped_token = true;
                    self.reject_token(&t);
                    continue;
                }
            }
            if (status == 403 || status == 429 || status >= 500) && attempt < RETRY_DELAYS_MS.len() {
                tokio::time::sleep(Duration::from_millis(RETRY_DELAYS_MS[attempt])).await;
                attempt += 1;
                continue;
            }
            return Err(ScError::Status(status));
        }
    }

    // ---------------- hydration ----------------

    /// Replaces `{id, kind}` stubs with full track objects, keeping order.
    /// Stubs SoundCloud won't return (deleted / private) are dropped.
    pub(crate) async fn hydrate(&self, tracks: &Value) -> Vec<Value> {
        let list: Vec<Value> = tracks
            .as_array()
            .map(|a| a.iter().filter(|t| id_of(t).is_some()).cloned().collect())
            .unwrap_or_default();
        let missing: Vec<String> = list.iter().filter(|t| !is_full(t)).filter_map(id_of).collect();
        if missing.is_empty() {
            return list;
        }
        let batches: Vec<String> = missing.chunks(HYDRATE_BATCH).map(|c| c.join(",")).collect();
        let results: Vec<Result<Value>> = stream::iter(batches)
            .map(|ids| async move { self.api("/tracks", &[("ids", ids)]).await })
            .buffer_unordered(HYDRATE_PARALLEL)
            .collect()
            .await;
        let mut by_id: HashMap<String, Value> = HashMap::new();
        for batch in results.into_iter().flatten() {
            if let Value::Array(items) = batch {
                for t in items {
                    if let Some(id) = id_of(&t) {
                        by_id.insert(id, t);
                    }
                }
            }
        }
        list.into_iter()
            .filter_map(|t| if is_full(&t) { Some(t) } else { by_id.remove(&id_of(&t)?) })
            .collect()
    }

    // ---------------- public calls ----------------

    pub async fn search(&self, query: &str, offset: u32) -> Result<Vec<Track>> {
        let q = query.trim();
        if q.starts_with("http://") || q.starts_with("https://") {
            return self.resolve(q).await;
        }
        let data = self
            .api("/search/tracks", &[("q", q.to_string()), ("limit", "50".into()), ("offset", offset.to_string())])
            .await?;
        Ok(collection(&data).iter().map(|i| unwrap_item(i, "track")).filter(|t| listable(t)).map(map_track).collect())
    }

    pub async fn trending(&self) -> Result<Vec<Track>> {
        let data = self
            .api(
                "/charts",
                &[("kind", "trending".into()), ("genre", "soundcloud:genres:all-music".into()), ("limit", "50".into())],
            )
            .await?;
        Ok(collection(&data).iter().map(|i| &i["track"]).filter(|t| playable(t)).map(map_track).collect())
    }

    pub async fn resolve(&self, link: &str) -> Result<Vec<Track>> {
        let data = self.api("/resolve", &[("url", link.to_string())]).await?;
        match data["kind"].as_str() {
            Some("track") => Ok(vec![map_track(&data)]),
            Some("playlist") => Ok(self.hydrate(&data["tracks"]).await.iter().filter(|t| playable(t)).map(map_track).collect()),
            other => Err(msg(format!("Unsupported SoundCloud link type: {}", other.unwrap_or("unknown")))),
        }
    }

    pub async fn my_playlists(&self) -> Result<Vec<PlaylistSummary>> {
        let user_id = self.user_id()?;
        let mut out = Vec::new();
        let mut next = String::new();
        for _ in 0..10 {
            let data = if next.is_empty() {
                self.api(&format!("/users/{user_id}/playlists"), &[("limit", "50".into())]).await?
            } else {
                self.api(&next, &[]).await?
            };
            for pl in collection(&data) {
                if pl["kind"].as_str() != Some("playlist") {
                    continue;
                }
                out.push(PlaylistSummary {
                    id: id_of(pl).unwrap_or_default(),
                    title: str_of(pl, "title").unwrap_or_else(|| "Untitled playlist".into()),
                    track_count: pl["track_count"].as_u64().unwrap_or(0),
                    artwork: artwork(&str_of(pl, "artwork_url").unwrap_or_default(), "t300x300"),
                });
            }
            next = str_of(&data, "next_href").unwrap_or_default();
            if next.is_empty() || collection(&data).is_empty() {
                break;
            }
        }
        Ok(out)
    }

    pub async fn playlist_tracks(&self, playlist_id: &str) -> Result<Vec<Track>> {
        if playlist_id.is_empty() || !playlist_id.bytes().all(|b| b.is_ascii_digit()) {
            return Err(msg("Not a SoundCloud playlist id"));
        }
        let data = self.api(&format!("/playlists/{playlist_id}"), &[]).await?;
        Ok(self.hydrate(&data["tracks"]).await.iter().filter(|t| listable(t)).map(map_track).collect())
    }

    /// All liked tracks in SoundCloud's order (newest like first).
    pub async fn liked_tracks(&self, max: usize) -> Result<Vec<Track>> {
        let user_id = self.user_id()?;
        self.liked_tracks_of(&user_id, max).await
    }

    async fn liked_tracks_of(&self, user_id: &str, max: usize) -> Result<Vec<Track>> {
        let mut out = Vec::new();
        let mut next = String::new();
        while out.len() < max {
            let data = if next.is_empty() {
                self.api(&format!("/users/{user_id}/track_likes"), &[("limit", "200".into())]).await?
            } else {
                self.api(&next, &[]).await?
            };
            let raw = collection(&data);
            out.extend(raw.iter().map(|i| unwrap_item(i, "track")).filter(|t| listable(t)).map(map_track));
            next = str_of(&data, "next_href").unwrap_or_default();
            if next.is_empty() || raw.is_empty() {
                break;
            }
        }
        out.truncate(max);
        Ok(out)
    }

    /// Drops a cached stream link (used when playback hit an expired one).
    pub fn forget_stream(&self, track_id: &str) {
        self.streams.lock().unwrap().remove(track_id);
    }

    /// Settings → Clear cache: drop resolved stream URLs and the scraped
    /// client_id (the next request scrapes a fresh one).
    pub async fn clear_caches(&self) {
        self.streams.lock().unwrap().clear();
        *self.client_id.lock().await = StoredClientId::default();
        let _ = std::fs::remove_file(self.dir.join("soundcloud-client.json"));
    }

    pub async fn stream(&self, track_id: &str) -> Result<StreamInfo> {
        if track_id.is_empty() || !track_id.bytes().all(|b| b.is_ascii_digit()) {
            return Err(msg("Not a SoundCloud track id"));
        }
        if let Some((at, info)) = self.streams.lock().unwrap().get(track_id) {
            if at.elapsed() < STREAM_CACHE_TTL {
                return Ok(info.clone());
            }
        }
        let track = self.api(&format!("/tracks/{track_id}"), &[]).await?;
        if track["kind"].as_str() != Some("track") {
            return Err(msg("SoundCloud has no such track"));
        }
        let token = self.token();
        let policy = track["policy"].as_str().unwrap_or("");
        if policy == "SNIP" || track["snipped"].as_bool() == Some(true) {
            return Err(msg(if token.is_some() {
                "This track needs a SoundCloud Go+ subscription."
            } else {
                "This track only offers a preview without a SoundCloud subscription."
            }));
        }
        if policy == "BLOCK" {
            return Err(msg("This track is region-locked on SoundCloud."));
        }
        let ranked = rank_transcodings(&track["media"]["transcodings"]);
        if ranked.is_empty() {
            return Err(msg("No playable stream for this track."));
        }
        let client_id = self.client_id(false).await?;
        let auth = str_of(&track, "track_authorization");
        let mut last = String::from("SoundCloud refused to hand out a stream for this track.");
        // Fall through the list: one refused transcoding shouldn't fail the track.
        for tc in ranked {
            let Some(mut url) = tc["url"].as_str().and_then(|u| Url::parse(u).ok()) else { continue };
            {
                let mut q = url.query_pairs_mut();
                q.append_pair("client_id", &client_id);
                if let Some(a) = &auth {
                    q.append_pair("track_authorization", a);
                }
            }
            let mut req = self.http.get(url).header(ACCEPT, "application/json").header(REFERER, format!("{WEB_BASE}/"));
            if let Some(t) = &token {
                req = req.header(AUTHORIZATION, format!("OAuth {t}"));
            }
            let res = match req.send().await {
                Ok(r) => r,
                Err(e) => {
                    last = format!("Stream request failed: {e}");
                    continue;
                }
            };
            if !res.status().is_success() {
                last = format!("SoundCloud answered {} for the stream", res.status().as_u16());
                continue;
            }
            let Ok(body) = res.json::<Value>().await else { continue };
            let Some(stream_url) = str_of(&body, "url") else { continue };
            let protocol = tc["format"]["protocol"].as_str().unwrap_or("").to_ascii_lowercase();
            let info = StreamInfo {
                url: stream_url,
                protocol: if protocol == "hls" { "hls".into() } else { "progressive".into() },
                preset: str_of(tc, "preset").unwrap_or_default(),
            };
            self.streams.lock().unwrap().insert(track_id.to_string(), (Instant::now(), info.clone()));
            return Ok(info);
        }
        Err(msg(last))
    }
}

// ------------------------------------------------------------------
// helpers / mapping
// ------------------------------------------------------------------

pub(crate) fn id_of(v: &Value) -> Option<String> {
    match &v["id"] {
        Value::Number(n) => Some(n.to_string()),
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        _ => None,
    }
}

pub(crate) fn str_of(v: &Value, key: &str) -> Option<String> {
    v[key].as_str().map(str::trim).filter(|s| !s.is_empty()).map(String::from)
}

pub(crate) fn collection(v: &Value) -> &[Value] {
    v["collection"].as_array().map(Vec::as_slice).unwrap_or(&[])
}

/// Search / likes items are sometimes wrapped (`{track: {...}}`).
pub(crate) fn unwrap_item<'a>(item: &'a Value, key: &str) -> &'a Value {
    if item[key].is_object() {
        &item[key]
    } else {
        item
    }
}

fn is_full(t: &Value) -> bool {
    t["title"].as_str().is_some_and(|s| !s.is_empty()) && t["user"].is_object()
}

pub(crate) fn listable(t: &Value) -> bool {
    t["kind"].as_str() == Some("track")
        && t["streamable"].as_bool() != Some(false)
        && t["policy"].as_str() != Some("BLOCK")
        && t["snipped"].as_bool() != Some(true)
}

pub(crate) fn playable(t: &Value) -> bool {
    listable(t) && t["policy"].as_str() != Some("SNIP")
}

pub fn artwork(url: &str, size: &str) -> String {
    if url.is_empty() {
        return String::new();
    }
    ART_SIZE_RE.replace(url, format!("-{size}$1$2").as_str()).into_owned()
}

pub(crate) fn map_track(t: &Value) -> Track {
    let user = &t["user"];
    let ms = t["full_duration"].as_u64().or_else(|| t["duration"].as_u64()).unwrap_or(0);
    let art = str_of(t, "artwork_url").or_else(|| str_of(user, "avatar_url")).unwrap_or_default();
    let url = str_of(t, "permalink_url").unwrap_or_else(|| {
        format!(
            "{WEB_BASE}/{}/{}",
            user["permalink"].as_str().unwrap_or(""),
            t["permalink"].as_str().unwrap_or("")
        )
    });
    Track {
        id: id_of(t).unwrap_or_default(),
        title: str_of(t, "title").unwrap_or_else(|| "untitled".into()),
        artist: str_of(user, "username")
            .or_else(|| str_of(&t["publisher_metadata"], "artist"))
            .unwrap_or_else(|| "unknown artist".into()),
        duration: (ms + 500) / 1000,
        artwork: artwork(&art, "t500x500"),
        url,
        artist_id: id_of(user).unwrap_or_default(),
        artist_url: str_of(user, "permalink_url").unwrap_or_default(),
        genre: str_of(t, "genre").unwrap_or_default(),
        style: format!(
            "{} {} {}",
            t["title"].as_str().unwrap_or(""),
            t["genre"].as_str().unwrap_or(""),
            t["tag_list"].as_str().unwrap_or("")
        )
        .trim()
        .to_string(),
        source: String::new(),
        path: String::new(),
    }
}

fn transcoding_score(tc: &Value) -> i32 {
    let preset = tc["preset"].as_str().unwrap_or("").to_ascii_lowercase();
    let protocol = tc["format"]["protocol"].as_str().unwrap_or("").to_ascii_lowercase();
    let quality = if preset.contains("aac_256") || preset.contains("aac_1_0") {
        40
    } else if preset.contains("aac_160") {
        30
    } else if preset.contains("aac_96") {
        25
    } else if preset.contains("mp3") {
        20
    } else if preset.contains("opus") {
        5
    } else if preset.contains("abr") {
        // abr_sq is listed on most tracks but its stream endpoint answers 404.
        1
    } else {
        0
    };
    // Progressive plays natively and starts/seeks faster than HLS.
    quality + if protocol == "progressive" { 100 } else { 0 }
}

/// Usable transcodings, best first. Encrypted HLS can't be played and snipped
/// ones are 30-second previews.
fn rank_transcodings(list: &Value) -> Vec<&Value> {
    let mut out: Vec<&Value> = list
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[])
        .iter()
        .filter(|tc| tc["url"].as_str().is_some_and(|u| !u.is_empty()))
        .filter(|tc| tc["preset"].as_str().is_some_and(|p| !p.is_empty()))
        .filter(|tc| tc["snipped"].as_bool() != Some(true))
        .filter(|tc| !tc["format"]["protocol"].as_str().unwrap_or("").to_ascii_lowercase().contains("encrypted"))
        .collect();
    out.sort_by_key(|tc| std::cmp::Reverse(transcoding_score(tc)));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn ranks_progressive_first_and_skips_encrypted_and_snipped() {
        let list = json!([
            {"url": "a", "preset": "aac_160k", "format": {"protocol": "hls"}},
            {"url": "b", "preset": "aac_160k", "format": {"protocol": "ctr-encrypted-hls"}},
            {"url": "c", "preset": "mp3_1_0", "format": {"protocol": "progressive"}},
            {"url": "d", "preset": "mp3_1_0", "format": {"protocol": "progressive"}, "snipped": true},
            {"url": "e", "preset": "opus_0_0", "format": {"protocol": "hls"}},
        ]);
        let ranked: Vec<&str> = rank_transcodings(&list).iter().map(|t| t["url"].as_str().unwrap()).collect();
        assert_eq!(ranked, vec!["c", "a", "e"]);
    }

    #[test]
    fn artwork_resizes() {
        assert_eq!(
            artwork("https://i1.sndcdn.com/artworks-abc-large.jpg", "t500x500"),
            "https://i1.sndcdn.com/artworks-abc-t500x500.jpg"
        );
        assert_eq!(
            artwork("https://i1.sndcdn.com/avatars-x-000-large.jpg?abc", "t300x300"),
            "https://i1.sndcdn.com/avatars-x-000-t300x300.jpg?abc"
        );
    }

    #[test]
    fn cursor_urls_keep_query_and_swap_client_id() {
        let url = SoundCloud::build_url(
            "https://api-v2.soundcloud.com/users/1/track_likes?offset=abc&limit=200&client_id=OLD",
            &[],
            "NEW",
        )
        .unwrap();
        assert_eq!(url.as_str(), "https://api-v2.soundcloud.com/users/1/track_likes?offset=abc&limit=200&client_id=NEW");
    }

    /// Hits the real API. Run with: cargo test -- --ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn live_search_stream_and_playlist_hydration() {
        let dir = std::env::temp_dir().join("riff-rs-live-test");
        let sc = SoundCloud::new(dir);
        let started = Instant::now();
        let found = sc.search("lofi hip hop", 0).await.expect("search");
        println!("search: {} tracks in {:?}", found.len(), started.elapsed());
        assert!(!found.is_empty());

        let mut streamed = false;
        for t in found.iter().take(5) {
            let started = Instant::now();
            match sc.stream(&t.id).await {
                Ok(s) => {
                    println!("stream {} -> {} {} in {:?}", t.title, s.protocol, s.preset, started.elapsed());
                    let head = sc.http.get(&s.url).header("Range", "bytes=0-1023").send().await.expect("fetch stream");
                    assert!(head.status().is_success(), "stream url answered {}", head.status());
                    streamed = true;
                    break;
                }
                Err(e) => println!("stream {} failed: {e}", t.title),
            }
        }
        assert!(streamed, "no track could be streamed");

        let lists = sc.api("/search/playlists", &[("q", "lofi".into()), ("limit", "10".into())]).await.expect("playlists");
        let pl = collection(&lists).iter().find(|p| p["track_count"].as_u64().unwrap_or(0) >= 20).expect("big playlist");
        let id = id_of(pl).unwrap();
        let count = pl["track_count"].as_u64().unwrap();
        let started = Instant::now();
        let tracks = sc.playlist_tracks(&id).await.expect("playlist tracks");
        println!("playlist {id}: {}/{} tracks hydrated in {:?}", tracks.len(), count, started.elapsed());
        assert!(tracks.len() as u64 > count / 2);
        assert!(tracks.iter().all(|t| t.title != "untitled" && t.artist != "unknown artist" && t.duration > 0));
    }

    /// Likes walk next_href cursors past the first page, newest first.
    #[tokio::test]
    #[ignore]
    async fn live_likes_paging() {
        let sc = SoundCloud::new(std::env::temp_dir().join("riff-rs-live-test"));
        let user = sc.api("/resolve", &[("url", "https://soundcloud.com/lofi_girl".into())]).await.expect("resolve user");
        let id = id_of(&user).unwrap();
        println!("user {id} likes_count={}", user["likes_count"]);
        let started = Instant::now();
        let likes = sc.liked_tracks_of(&id, 450).await.expect("likes");
        println!("likes: {} in {:?}; first: {} / {}", likes.len(), started.elapsed(), likes[0].title, likes[0].artist);
        assert!(!likes.is_empty());
        let unique: std::collections::HashSet<_> = likes.iter().map(|t| &t.id).collect();
        assert_eq!(unique.len(), likes.len(), "duplicate tracks across pages");
        assert!(likes.iter().all(|t| t.title != "untitled" && t.duration > 0));
    }

    /// A dead token must not break public requests; the session reads as expired.
    #[tokio::test]
    #[ignore]
    async fn live_expired_token_falls_back_to_anonymous() {
        let dir = std::env::temp_dir().join("riff-rs-live-test-expired");
        let sc = SoundCloud::new(dir);
        *sc.session.write().unwrap() = Some(Session {
            oauth_token: "2-000000-000000-deadtokendeadtoken".into(),
            user_id: "1".into(),
            username: "x".into(),
            avatar: String::new(),
        });
        let fired = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let f = fired.clone();
        sc.set_on_expired(move || f.store(true, std::sync::atomic::Ordering::SeqCst));
        let found = sc.search("house", 0).await.expect("search should still work anonymously");
        assert!(!found.is_empty());
        assert!(sc.status().expired);
        assert!(fired.load(std::sync::atomic::Ordering::SeqCst));
    }

    #[test]
    fn maps_track_fields() {
        let t = json!({"id": 5, "kind": "track", "title": "Song", "duration": 61500,
            "user": {"username": "dj", "avatar_url": "https://i1.sndcdn.com/avatars-1-large.jpg"},
            "permalink_url": "https://soundcloud.com/dj/song"});
        let m = map_track(&t);
        assert_eq!((m.id.as_str(), m.title.as_str(), m.artist.as_str(), m.duration), ("5", "Song", "dj", 62));
        assert!(m.artwork.ends_with("t500x500.jpg"));
    }
}
