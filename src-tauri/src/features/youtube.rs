//! YouTube + YouTube Music: search (InnerTube), link lookup and playback.
//!
//! Commands (`riff.call('youtube.<cmd>', args)`):
//!   search  { source: 'youtube'|'ytmusic', query, offset } -> Track[]   (20 per page, continuation tokens kept here)
//!   link    { text }                                       -> Track[]   (pasted youtube.com / youtu.be / music.youtube.com link)
//!   resolve { id, fresh? }                                 -> { url, protocol, method, ms }   (url = localhost proxy)
//!   prefetch{ id }                                         -> null      (warms the stream link in the background)
//!   download{ id, path }                                   -> { path, bytes, mime, itag }   (audio file, m4a = itag 140 usually)
//!   tools                                                  -> { ytdlp, status, percent, error }
//!   install                                                -> starts the yt-dlp download (events: "youtube-tools")
//!   open    { url }                                        -> opens a youtube.com / music.youtube.com page in the browser
//!
//! Playback: InnerTube player (VISIONOS client, then ANDROID_VR: plain audio URLs, no
//! cipher / JS runtime) first, yt-dlp as fallback. Links are cached until googlevideo's
//! `expire=`. The audio element gets a 127.0.0.1 proxy URL because googlevideo has no CORS
//! for our origin (see proxy.rs).

mod innertube;
mod proxy;
pub(crate) mod sha256;
mod ytdlp;

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::soundcloud::Track;
pub use innertube::Src;

const PAGE: usize = 20;
const SEARCH_TTL: Duration = Duration::from_secs(300);

#[derive(Clone, Debug)]
pub struct Stream {
    pub url: String,
    /// unix seconds (googlevideo `expire=`), 0 = unknown
    pub expire: u64,
    pub clen: Option<u64>,
    pub mime: String,
    pub itag: Option<u32>,
    pub method: &'static str,
    pub at: Instant,
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

impl Stream {
    fn from_url(url: String, method: &'static str, itag: Option<u32>, mime: Option<String>, clen: Option<u64>) -> Stream {
        let expire = innertube::expire_of(&url).unwrap_or(0);
        let clen = clen.or_else(|| innertube::url_param(&url, "clen").and_then(|s| s.parse().ok()));
        let itag = itag.or_else(|| innertube::url_param(&url, "itag").and_then(|s| s.parse().ok()));
        let mime = mime.filter(|m| !m.is_empty()).or_else(|| innertube::url_param(&url, "mime")).unwrap_or_default();
        Stream { url, expire, clen, mime, itag, method, at: Instant::now() }
    }
    /// Good for at least five more minutes.
    fn fresh(&self) -> bool {
        if self.expire > 0 {
            self.expire > now_secs() + 300
        } else {
            self.at.elapsed() < Duration::from_secs(1800)
        }
    }
}

pub struct Yt {
    pub http: reqwest::Client,
    visitor: Mutex<(String, Option<Instant>)>,
    streams: Mutex<HashMap<String, Stream>>,
    locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    no_direct: Mutex<HashSet<String>>,
    conts: Mutex<HashMap<String, String>>,
    cache: Mutex<HashMap<String, (Instant, Vec<Track>)>>,
    app_bin: Mutex<Option<PathBuf>>,
    tools: Mutex<Value>,
    proxy: OnceLock<(u16, String)>,
}

static YT: OnceLock<Yt> = OnceLock::new();

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn ms(t: Instant) -> u64 {
    t.elapsed().as_millis() as u64
}

pub const YTDLP_MISSING: &str = "YTDLP_MISSING";

impl Yt {
    pub fn global() -> &'static Yt {
        YT.get_or_init(|| Yt {
            http: reqwest::Client::builder()
                .gzip(true)
                .brotli(true)
                .connect_timeout(Duration::from_secs(8))
                .read_timeout(Duration::from_secs(20))
                .pool_idle_timeout(Duration::from_secs(120))
                .build()
                .expect("reqwest client"),
            visitor: Mutex::new((String::new(), None)),
            streams: Mutex::new(HashMap::new()),
            locks: Mutex::new(HashMap::new()),
            no_direct: Mutex::new(HashSet::new()),
            conts: Mutex::new(HashMap::new()),
            cache: Mutex::new(HashMap::new()),
            app_bin: Mutex::new(None),
            tools: Mutex::new(json!({ "status": "idle", "percent": 0, "error": "" })),
            proxy: OnceLock::new(),
        })
    }

    fn proxy(&self) -> Result<(u16, String), String> {
        if let Some(p) = self.proxy.get() {
            return Ok(p.clone());
        }
        let p = proxy::start().map_err(|e| format!("audio proxy: {e}"))?;
        Ok(self.proxy.get_or_init(|| p).clone())
    }

    pub fn ytdlp_bin(&self) -> Option<PathBuf> {
        let app_bin = lock(&self.app_bin).clone();
        ytdlp::find(app_bin.as_deref())
    }

    // ------------------------------------------------------------ InnerTube plumbing

    fn note_visitor(&self, v: &Value) {
        if let Some(vd) = v["responseContext"]["visitorData"].as_str().filter(|s| !s.is_empty()) {
            let mut g = lock(&self.visitor);
            if g.0.is_empty() {
                *g = (innertube::percent_decode(vd), Some(Instant::now()));
            }
        }
    }

    /// Visitor data (anonymous session id) - InnerTube's player wants one for most videos now.
    async fn visitor(&self) -> String {
        {
            let g = lock(&self.visitor);
            if !g.0.is_empty() && g.1.map(|t| t.elapsed() < Duration::from_secs(6 * 3600)).unwrap_or(false) {
                return g.0.clone();
            }
        }
        let body = json!({ "context": innertube::web_context("") });
        match self.post("www.youtube.com", "visitor_id", &body, None).await {
            Ok(v) => {
                if let Some(vd) = v["responseContext"]["visitorData"].as_str().filter(|s| !s.is_empty()) {
                    let vd = innertube::percent_decode(vd);
                    *lock(&self.visitor) = (vd.clone(), Some(Instant::now()));
                    return vd;
                }
                String::new()
            }
            Err(e) => {
                eprintln!("[youtube] visitor_id: {e}");
                String::new()
            }
        }
    }

    async fn post(&self, host: &str, endpoint: &str, body: &Value, client: Option<&innertube::PlayerClient>) -> Result<Value, String> {
        let url = format!("https://{host}/youtubei/v1/{endpoint}?prettyPrint=false");
        let mut req = self.http.post(&url).json(body).timeout(Duration::from_secs(10)).header("Origin", format!("https://{host}"));
        match client {
            Some(c) => {
                req = req.header("User-Agent", c.ua).header("X-YouTube-Client-Name", c.id).header("X-YouTube-Client-Version", c.version);
                if let Some(vd) = body["context"]["client"]["visitorData"].as_str() {
                    req = req.header("X-Goog-Visitor-Id", vd);
                }
            }
            None => {
                req = req.header("User-Agent", innertube::BROWSER_UA).header("Referer", format!("https://{host}/"));
            }
        }
        let res = req.send().await.map_err(|e| format!("{host}: {e}"))?;
        let status = res.status();
        if !status.is_success() {
            return Err(format!("{host} {endpoint}: HTTP {}", status.as_u16()));
        }
        res.json::<Value>().await.map_err(|e| format!("{host} {endpoint}: {e}"))
    }

    // ------------------------------------------------------------ search

    async fn search_page(&self, src: Src, query: &str, cont: Option<&str>) -> Result<(Vec<Track>, Option<String>), String> {
        let visitor = lock(&self.visitor).0.clone();
        let (host, mut body) = match src {
            Src::Youtube => ("www.youtube.com", json!({ "context": innertube::web_context(&visitor) })),
            Src::Music => ("music.youtube.com", json!({ "context": innertube::ytm_context(&visitor) })),
        };
        match cont {
            Some(c) => body["continuation"] = json!(c),
            None => {
                body["query"] = json!(query);
                body["params"] = json!(if src == Src::Music { innertube::YTM_SONGS_PARAMS } else { innertube::YT_VIDEOS_PARAMS });
            }
        }
        let v = self.post(host, "search", &body, None).await?;
        self.note_visitor(&v);
        let tracks = match src {
            Src::Youtube => innertube::parse_yt_videos(&v),
            Src::Music => innertube::parse_ytm_songs(&v),
        };
        Ok((tracks, innertube::continuation(&v)))
    }

    pub async fn search(&self, src: Src, query: &str, offset: usize) -> Result<Vec<Track>, String> {
        let q = query.trim();
        if q.is_empty() {
            return Ok(vec![]);
        }
        let key = |off: usize| format!("{}\u{1}{}\u{1}{off}", src.key(), q.to_lowercase());
        if let Some((at, t)) = lock(&self.cache).get(&key(offset)) {
            if at.elapsed() < SEARCH_TTL {
                return Ok(t.clone());
            }
        }
        let mut token = if offset == 0 {
            None
        } else {
            match lock(&self.conts).get(&key(offset)).cloned() {
                Some(t) => Some(t),
                None => return Ok(vec![]),
            }
        };
        let started = Instant::now();
        let mut out: Vec<Track> = Vec::new();
        // a page is ~20 results; top up from the next continuation if filtering left it short
        for round in 0..3 {
            if round > 0 && token.is_none() {
                break;
            }
            let (tracks, next) = self.search_page(src, q, token.as_deref()).await?;
            for t in tracks {
                if !out.iter().any(|o| o.id == t.id) {
                    out.push(t);
                }
            }
            token = next;
            if out.len() >= PAGE * 3 / 4 || token.is_none() {
                break;
            }
        }
        println!("[youtube] search {} \"{q}\" @{offset}: {} tracks in {}ms", src.key(), out.len(), ms(started));
        if let Some(t) = token {
            let mut c = lock(&self.conts);
            if c.len() > 200 {
                c.clear();
            }
            c.insert(key(offset + PAGE), t);
        }
        let mut c = lock(&self.cache);
        if c.len() > 60 {
            c.retain(|_, (at, _)| at.elapsed() < SEARCH_TTL);
        }
        c.insert(key(offset), (Instant::now(), out.clone()));
        Ok(out)
    }

    // ------------------------------------------------------------ links

    pub async fn link(&self, text: &str) -> Result<Vec<Track>, String> {
        let l = innertube::parse_link(text).ok_or("Not a YouTube link")?;
        if let Some(list) = l.list.as_deref().filter(|id| !id.starts_with("RD")) {
            match self.playlist(list, l.music).await {
                Ok(t) if !t.is_empty() => return Ok(t),
                Ok(_) => {}
                Err(e) => eprintln!("[youtube] playlist {list}: {e}"),
            }
        }
        let vid = l.video.ok_or("This YouTube playlist could not be loaded")?;
        let (stream, player) = self.player(&vid).await?;
        self.store(&vid, stream);
        let t = innertube::track_from_player(&player, l.music).ok_or("Video not found")?;
        Ok(vec![t])
    }

    /// Playlist via YouTube Music's browse (www's playlist page moved to lockupViewModel; YTM still has plain rows).
    async fn playlist(&self, list: &str, music: bool) -> Result<Vec<Track>, String> {
        let visitor = lock(&self.visitor).0.clone();
        let mut body = json!({ "context": innertube::ytm_context(&visitor), "browseId": format!("VL{list}") });
        let mut out: Vec<Track> = Vec::new();
        for _ in 0..20 {
            let v = self.post("music.youtube.com", "browse", &body, None).await?;
            let before = out.len();
            for mut t in innertube::parse_ytm_songs(&v) {
                if !music {
                    t.url = t.url.replace("music.youtube.com", "www.youtube.com");
                }
                if !out.iter().any(|o| o.id == t.id) {
                    out.push(t);
                }
            }
            match innertube::continuation(&v) {
                Some(c) if out.len() > before => body = json!({ "context": innertube::ytm_context(&visitor), "continuation": c }),
                _ => break,
            }
        }
        Ok(out)
    }

    // ------------------------------------------------------------ streams

    /// InnerTube player: first client that returns a playable plain audio URL.
    async fn player(&self, vid: &str) -> Result<(Stream, Value), String> {
        let visitor = self.visitor().await;
        let mut last = String::from("no player client worked");
        for c in innertube::PLAYER_CLIENTS.iter() {
            let body = innertube::player_body(c, vid, &visitor);
            let v = match self.post("www.youtube.com", "player", &body, Some(c)).await {
                Ok(v) => v,
                Err(e) => {
                    last = e;
                    continue;
                }
            };
            if let Err(e) = innertube::playable(&v) {
                last = format!("{}: {e}", c.name);
                continue;
            }
            if let Some(f) = innertube::pick_audio(&v) {
                let s = Stream::from_url(f.url, "innertube", Some(f.itag), Some(f.mime), f.clen);
                return Ok((s, v));
            }
            last = format!("{}: no audio formats", c.name);
        }
        Err(last)
    }

    async fn ytdlp_stream(&self, vid: &str, itag: Option<u32>) -> Result<Stream, String> {
        let bin = self.ytdlp_bin().ok_or_else(|| format!("{YTDLP_MISSING}: YouTube needs yt-dlp for this track"))?;
        let id = vid.to_string();
        let url = tauri::async_runtime::spawn_blocking(move || ytdlp::stream_url(&bin, &id, itag))
            .await
            .map_err(|e| e.to_string())??;
        Ok(Stream::from_url(url, "ytdlp", None, None, None))
    }

    fn store(&self, vid: &str, s: Stream) {
        let mut g = lock(&self.streams);
        if g.len() > 300 {
            g.retain(|_, s| s.fresh());
        }
        g.insert(vid.to_string(), s);
    }

    fn id_lock(&self, vid: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut g = lock(&self.locks);
        if g.len() > 500 {
            g.retain(|_, l| Arc::strong_count(l) > 1);
        }
        g.entry(vid.to_string()).or_default().clone()
    }

    /// Cached stream link, or a new one (InnerTube first, then yt-dlp). Concurrent calls share one lookup.
    pub async fn stream(&self, vid: &str, fresh: bool) -> Result<Stream, String> {
        if !fresh {
            if let Some(s) = lock(&self.streams).get(vid).filter(|s| s.fresh()).cloned() {
                return Ok(s);
            }
        }
        let l = self.id_lock(vid);
        let _g = l.lock().await;
        if !fresh {
            if let Some(s) = lock(&self.streams).get(vid).filter(|s| s.fresh()).cloned() {
                return Ok(s); // someone else just resolved it
            }
        } else if let Some(s) = lock(&self.streams).get(vid).filter(|s| s.at.elapsed() < Duration::from_secs(5)).cloned() {
            return Ok(s); // a "fresh" request right after a resolve: reuse it
        }
        let started = Instant::now();
        let mut direct_err = String::new();
        if !lock(&self.no_direct).contains(vid) {
            match self.player(vid).await {
                Ok((s, _)) => {
                    println!("[youtube] stream {vid}: innertube itag {:?} in {}ms", s.itag, ms(started));
                    self.store(vid, s.clone());
                    return Ok(s);
                }
                Err(e) => direct_err = e,
            }
        }
        match self.ytdlp_stream(vid, None).await {
            Ok(s) => {
                println!("[youtube] stream {vid}: yt-dlp in {}ms (direct: {direct_err})", ms(started));
                self.store(vid, s.clone());
                Ok(s)
            }
            Err(e) if e.starts_with(YTDLP_MISSING) => Err(if direct_err.is_empty() { e } else { format!("{e} ({direct_err})") }),
            Err(e) => Err(if direct_err.is_empty() { e } else { format!("{direct_err}; yt-dlp: {e}") }),
        }
    }

    /// The link in `dead` stopped working (403 mid-stream): get another for the same itag.
    pub async fn replace_dead(&self, vid: &str, dead: &Stream) -> Result<Stream, String> {
        let l = self.id_lock(vid);
        let _g = l.lock().await;
        if let Some(s) = lock(&self.streams).get(vid).filter(|s| s.url != dead.url && s.fresh()).cloned() {
            return Ok(s);
        }
        if dead.method == "innertube" {
            lock(&self.no_direct).insert(vid.to_string());
        }
        let s = match self.ytdlp_stream(vid, dead.itag).await {
            Ok(s) => s,
            Err(e) if e.starts_with(YTDLP_MISSING) && dead.method == "innertube" => self.player(vid).await?.0,
            Err(e) => return Err(e),
        };
        self.store(vid, s.clone());
        Ok(s)
    }

    pub async fn fetch_range(&self, url: &str, a: u64, b: u64) -> reqwest::Result<reqwest::Response> {
        self.http
            .get(url)
            .header("Range", format!("bytes={a}-{b}"))
            .header("User-Agent", innertube::BROWSER_UA)
            .header("Accept-Encoding", "identity")
            .send()
            .await
    }

    /// Total size from `Content-Range` of a 1-byte request (None = link is dead).
    pub async fn probe_len(&self, url: &str) -> Option<u64> {
        let r = self.fetch_range(url, 0, 0).await.ok()?;
        if !r.status().is_success() {
            return None;
        }
        r.headers().get("content-range")?.to_str().ok()?.rsplit('/').next()?.parse().ok()
    }

    /// Saves the audio (same itag the player uses) to `path` in ranged chunks. For the downloads feature.
    pub async fn download(&self, vid: &str, path: &std::path::Path) -> Result<Value, String> {
        use std::io::Write;
        let started = Instant::now();
        let mut s = self.stream(vid, false).await?;
        let total = match s.clen {
            Some(n) => n,
            None => self.probe_len(&s.url).await.ok_or("stream unavailable")?,
        };
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let tmp = path.with_extension("part");
        let mut file = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
        let mut pos = 0u64;
        let mut fails = 0;
        while pos < total {
            let end = (pos + (8 << 20) - 1).min(total - 1);
            let ok = match self.fetch_range(&s.url, pos, end).await {
                Ok(r) if r.status().as_u16() == 206 => match r.bytes().await {
                    Ok(b) if !b.is_empty() => {
                        file.write_all(&b).map_err(|e| e.to_string())?;
                        pos += b.len() as u64;
                        true
                    }
                    _ => false,
                },
                Ok(r) if r.status().is_client_error() => {
                    s = self.replace_dead(vid, &s).await?;
                    false
                }
                _ => false,
            };
            if !ok {
                fails += 1;
                if fails > 4 {
                    drop(file);
                    let _ = std::fs::remove_file(&tmp);
                    return Err("YouTube download failed".into());
                }
            }
        }
        drop(file);
        std::fs::rename(&tmp, path).map_err(|e| e.to_string())?;
        println!("[youtube] downloaded {vid}: {total} bytes in {}ms", ms(started));
        Ok(json!({ "path": path.to_string_lossy(), "bytes": total, "mime": s.mime, "itag": s.itag }))
    }

    pub fn proxy_url(&self, vid: &str, bust: u64) -> Result<String, String> {
        let (port, token) = self.proxy()?;
        Ok(if bust > 0 { format!("http://127.0.0.1:{port}/yt/{token}/{vid}?n={bust}") } else { format!("http://127.0.0.1:{port}/yt/{token}/{vid}") })
    }
}

fn vid_of(args: &Value) -> Result<String, String> {
    let raw = args["id"].as_str().unwrap_or("");
    let id = raw.strip_prefix("yt:").unwrap_or(raw);
    if innertube::valid_id(id) {
        Ok(id.to_string())
    } else {
        Err(format!("youtube: bad video id {raw:?}"))
    }
}

fn tools_status(yt: &Yt) -> Value {
    let mut v = lock(&yt.tools).clone();
    v["ytdlp"] = json!(yt.ytdlp_bin().map(|p| p.to_string_lossy().into_owned()));
    v["target"] = json!(lock(&yt.app_bin).as_ref().map(|p| p.join(ytdlp::exe_name()).to_string_lossy().into_owned()));
    v["source"] = json!(ytdlp::asset_url(ytdlp::asset_name()));
    v
}

pub fn setup(app: &AppHandle) {
    let yt = Yt::global();
    if let Some(state) = app.try_state::<crate::AppState>() {
        *lock(&yt.app_bin) = Some(state.data_dir.join("bin"));
    }
    if let Err(e) = yt.proxy() {
        eprintln!("[youtube] {e}");
    }
    // Warm TLS connections + visitor data so the first search / play skips the handshakes.
    tauri::async_runtime::spawn(async move {
        let yt = Yt::global();
        let started = Instant::now();
        let ytm = async {
            let body = json!({ "context": innertube::ytm_context("") });
            let _ = yt.post("music.youtube.com", "visitor_id", &body, None).await;
        };
        let _ = futures::join!(yt.visitor(), ytm);
        println!("[youtube] warm-up in {}ms", ms(started));
    });
}

pub async fn handle(app: &AppHandle, cmd: &str, args: Value) -> super::Out {
    let yt = Yt::global();
    match cmd {
        "search" => {
            let src = Src::parse(args["source"].as_str().unwrap_or("youtube"));
            let query = args["query"].as_str().unwrap_or("");
            let offset = args["offset"].as_u64().unwrap_or(0) as usize;
            if innertube::is_link(query) {
                return if offset == 0 { Ok(json!(yt.link(query).await?)) } else { Ok(json!([])) };
            }
            Ok(json!(yt.search(src, query, offset).await?))
        }
        "link" => Ok(json!(yt.link(args["text"].as_str().unwrap_or("")).await?)),
        "resolve" => {
            let vid = vid_of(&args)?;
            let fresh = args["fresh"].as_bool().unwrap_or(false);
            let started = Instant::now();
            let s = yt.stream(&vid, fresh).await?;
            let bust = if fresh { now_secs() } else { 0 };
            Ok(json!({ "url": yt.proxy_url(&vid, bust)?, "protocol": "progressive", "method": s.method, "itag": s.itag, "mime": s.mime, "ms": ms(started) }))
        }
        "prefetch" => {
            let vid = vid_of(&args)?;
            tauri::async_runtime::spawn(async move {
                if let Err(e) = Yt::global().stream(&vid, false).await {
                    eprintln!("[youtube] prefetch {vid}: {e}");
                }
            });
            Ok(Value::Null)
        }
        "download" => {
            let vid = vid_of(&args)?;
            let path = args["path"].as_str().filter(|p| !p.is_empty()).ok_or("youtube.download: path missing")?;
            yt.download(&vid, std::path::Path::new(path)).await
        }
        "tools" => Ok(tools_status(yt)),
        "install" => {
            if lock(&yt.tools)["status"] == "downloading" {
                return Ok(tools_status(yt));
            }
            let bin_dir = lock(&yt.app_bin).clone().ok_or("app data folder unknown")?;
            *lock(&yt.tools) = json!({ "status": "downloading", "percent": 0, "error": "" });
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let yt = Yt::global();
                let emit = || {
                    let _ = app.emit("youtube-tools", tools_status(yt));
                };
                emit();
                let res = ytdlp::install(&yt.http, &bin_dir, |p| {
                    lock(&yt.tools)["percent"] = json!(p);
                    emit();
                })
                .await;
                let v = match res {
                    Ok(path) => {
                        println!("[youtube] yt-dlp installed at {}", path.display());
                        lock(&yt.no_direct).clear();
                        json!({ "status": "done", "percent": 100, "error": "" })
                    }
                    Err(e) => {
                        eprintln!("[youtube] yt-dlp install failed: {e}");
                        json!({ "status": "error", "percent": 0, "error": e })
                    }
                };
                *lock(&yt.tools) = v;
                emit();
            });
            Ok(tools_status(yt))
        }
        "open" => {
            let url = args["url"].as_str().unwrap_or("");
            let ok = url::Url::parse(url)
                .ok()
                .filter(|u| u.scheme() == "https" && matches!(u.host_str(), Some("www.youtube.com" | "music.youtube.com" | "youtube.com" | "youtu.be")))
                .is_some();
            if !ok {
                return Err("youtube.open: not a YouTube URL".into());
            }
            tauri_plugin_opener::open_url(url, None::<&str>).map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        _ => Err(format!("youtube: unknown command {cmd}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn youtube_stream_freshness() {
        let s = Stream::from_url(format!("https://x.googlevideo.com/videoplayback?expire={}&itag=140&mime=audio%2Fmp4&clen=99", now_secs() + 3600), "innertube", None, None, None);
        assert!(s.fresh());
        assert_eq!((s.itag, s.clen, s.mime.as_str()), (Some(140), Some(99), "audio/mp4"));
        let old = Stream::from_url(format!("https://x.googlevideo.com/videoplayback?expire={}", now_secs() + 60), "innertube", None, None, None);
        assert!(!old.fresh());
        assert_eq!(vid_of(&json!({ "id": "yt:dQw4w9WgXcQ" })).unwrap(), "dQw4w9WgXcQ");
        assert!(vid_of(&json!({ "id": "12345" })).is_err());
    }

    // ---- live network: cargo test youtube -- --ignored --nocapture --test-threads=1

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap()
    }

    #[test]
    #[ignore]
    fn youtube_live_search_both() {
        rt().block_on(async {
            let yt = Yt::global();
            let t = Instant::now();
            yt.visitor().await;
            println!("visitor_id (cold TLS) {}ms", ms(t));
            for src in [Src::Youtube, Src::Music] {
                let t = Instant::now();
                let r = yt.search(src, "daft punk", 0).await.unwrap();
                println!("{} page1: {} tracks in {}ms; first: {:?}", src.key(), r.len(), ms(t), r.first().map(|x| (&x.title, &x.artist, x.duration, &x.artwork)));
                assert!(r.len() >= 10, "{} too few", src.key());
                assert!(r.iter().all(|x| x.id.starts_with("yt:") && x.source == "youtube" && x.duration > 0));
                let t = Instant::now();
                let r2 = yt.search(src, "daft punk", PAGE).await.unwrap();
                println!("{} page2: {} tracks in {}ms", src.key(), r2.len(), ms(t));
                assert!(!r2.is_empty());
                let t = Instant::now();
                let r3 = yt.search(src, "lofi beats", 0).await.unwrap();
                println!("{} warm search: {} tracks in {}ms", src.key(), r3.len(), ms(t));
            }
        });
    }

    #[test]
    #[ignore]
    fn youtube_live_resolve_and_proxy() {
        rt().block_on(async {
            let yt = Yt::global();
            for vid in ["kJQP7kiw5Fk", "mqgEYRtWMJU"] {
                let t = Instant::now();
                let s = yt.stream(vid, false).await.unwrap();
                println!("{vid}: {} itag {:?} {} clen {:?} in {}ms", s.method, s.itag, s.mime, s.clen, ms(t));
                assert!(s.fresh());
                let t = Instant::now();
                let url = yt.proxy_url(vid, 0).unwrap();
                let total = s.clen.unwrap_or(0);
                let mid = total / 2;
                let r = yt.http.get(&url).header("Range", format!("bytes={mid}-")).header("Origin", "http://tauri.localhost").send().await.unwrap();
                assert_eq!(r.status().as_u16(), 206);
                assert_eq!(r.headers().get("access-control-allow-origin").unwrap(), "*");
                let body = r.bytes().await.unwrap();
                println!("{vid}: proxy seek to middle -> {} bytes in {}ms", body.len(), ms(t));
                assert_eq!(body.len() as u64, total - mid);
                let t = Instant::now();
                let mut r = yt.http.get(&url).header("Range", "bytes=0-").send().await.unwrap();
                let first = r.chunk().await.unwrap().unwrap();
                println!("{vid}: proxy first bytes in {}ms ({} bytes)", ms(t), first.len());
                let mut n = first.len() as u64;
                while let Some(c) = r.chunk().await.unwrap() {
                    n += c.len() as u64;
                }
                println!("{vid}: proxy full {} bytes in {}ms", n, ms(t));
                assert_eq!(n, total);
            }
            // direct googlevideo CORS check
            let s = yt.stream("kJQP7kiw5Fk", false).await.unwrap();
            let r = yt.http.get(&s.url).header("Range", "bytes=0-10").header("Origin", "http://tauri.localhost").send().await.unwrap();
            println!("googlevideo ACAO for Origin http://tauri.localhost: {:?}", r.headers().get("access-control-allow-origin"));
        });
    }

    #[test]
    #[ignore]
    fn youtube_live_dead_link_fallback() {
        rt().block_on(async {
            let yt = Yt::global();
            let vid = "a5uQMwRMHcs";
            let good = yt.stream(vid, false).await.unwrap();
            // pretend the direct link died mid-stream: the cache holds a dead URL for this id
            let mut dead = good.clone();
            dead.url = good.url.replace("expire=", "expire=1&x=");
            yt.store(vid, dead.clone());
            let t = Instant::now();
            let s = yt.replace_dead(vid, &dead).await.unwrap();
            println!("replace_dead -> {} itag {:?} clen {:?} (was {:?}) in {}ms", s.method, s.itag, s.clen, good.clen, ms(t));
            assert_eq!(s.itag, good.itag);
            assert_eq!(s.clen, good.clen, "same itag must give the same bytes");
            assert!(lock(&yt.no_direct).contains(vid));
            lock(&yt.no_direct).remove(vid);
        });
    }

    #[test]
    #[ignore]
    fn youtube_live_download() {
        rt().block_on(async {
            let path = std::env::temp_dir().join("riff-rs-youtube-test.m4a");
            let t = Instant::now();
            let r = Yt::global().download("mqgEYRtWMJU", &path).await.unwrap();
            let len = std::fs::metadata(&path).unwrap().len();
            println!("download -> {r} ({len} bytes) in {}ms", ms(t));
            assert_eq!(Some(len), r["bytes"].as_u64());
            let _ = std::fs::remove_file(&path);
        });
    }

    #[test]
    #[ignore]
    fn youtube_live_ytdlp_and_link() {
        rt().block_on(async {
            let yt = Yt::global();
            println!("yt-dlp: {:?}", yt.ytdlp_bin());
            let t = Instant::now();
            match yt.ytdlp_stream("dQw4w9WgXcQ", Some(140)).await {
                Ok(s) => println!("yt-dlp stream itag {:?} clen {:?} in {}ms", s.itag, s.clen, ms(t)),
                Err(e) => println!("yt-dlp failed: {e}"),
            }
            let t = Instant::now();
            let l = yt.link("https://youtu.be/dQw4w9WgXcQ?si=x").await.unwrap();
            println!("link -> {:?} in {}ms", l.first().map(|x| (&x.title, &x.artist, x.duration)), ms(t));
            assert_eq!(l[0].id, "yt:dQw4w9WgXcQ");
            let t = Instant::now();
            match yt.link("https://www.youtube.com/playlist?list=PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI").await {
                Ok(p) => println!("playlist link -> {} tracks in {}ms", p.len(), ms(t)),
                Err(e) => println!("playlist link failed: {e}"),
            }
        });
    }
}
