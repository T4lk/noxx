//! Downloads: saves SoundCloud tracks as tagged audio files, natively (riff
//! shells out to yt-dlp; here it's plain HTTP).
//!
//! - The stream comes from the core resolver (`sc.stream(id)`). Progressive
//!   links are fetched in one go; HLS playlists are walked segment by segment
//!   (several in flight, kept in order). fMP4 renditions (EXT-X-MAP) are
//!   rebuilt into a normal `.m4a` (see `downloads/mp4.rs`), MPEG-TS is
//!   demuxed to `.aac` / `.mp3`, packed audio is concatenated.
//! - Title, artist, album, genre, comment (track URL) and cover art are written
//!   with lofty before the file gets its final name, so a half-written file is
//!   never mistaken for a finished one.
//! - At most `PARALLEL` tracks download at once; the rest wait in line.
//!   Progress goes to the UI as `download-progress` {id, done, total, state}.
//! - `downloads.json` in the data dir maps track id → file, and the download
//!   folder is allowed in the asset protocol scope so the UI can play files
//!   straight from disk.

mod media;
mod mp4;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use futures::stream::{self, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Semaphore;
use url::Url;

use crate::soundcloud::{write_json, Track, USER_AGENT};

const PARALLEL: usize = 3;
const SEGMENTS_IN_FLIGHT: usize = 6;
const INDEX_FILE: &str = "downloads.json";
const EVENT: &str = "download-progress";
const EMIT_EVERY: Duration = Duration::from_millis(150);

// ------------------------------------------------------------------ state

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Entry {
    track: Track,
    path: String,
    #[serde(default)]
    size: u64,
    #[serde(default)]
    at: u64,
}

#[derive(Default, Serialize, Deserialize)]
struct Index {
    /// Custom folder; empty = default (Music/riff-rs).
    #[serde(default)]
    folder: String,
    #[serde(default)]
    items: Vec<Entry>,
}

#[derive(Debug, Clone, Serialize)]
struct JobView {
    id: String,
    track: Track,
    /// queued | downloading | saving | done | error | cancelled
    state: &'static str,
    done: u64,
    total: u64,
    #[serde(skip_serializing_if = "String::is_empty")]
    error: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    path: String,
}

struct Job {
    view: JobView,
    album: String,
    cancel: Arc<AtomicBool>,
}

struct Inner {
    folder: String,
    items: HashMap<String, Entry>,
    jobs: Vec<Job>,
}

struct Dl {
    data_dir: PathBuf,
    default_folder: PathBuf,
    inner: Mutex<Inner>,
    slots: Semaphore,
    http: reqwest::Client,
    save_lock: Mutex<()>,
}

static DL: OnceLock<Arc<Dl>> = OnceLock::new();

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn dl(app: &AppHandle) -> Arc<Dl> {
    DL.get_or_init(|| {
        let data_dir = app.state::<crate::AppState>().data_dir.clone();
        let default_folder = app
            .path()
            .audio_dir()
            .or_else(|_| app.path().download_dir())
            .unwrap_or_else(|_| data_dir.clone())
            .join("riff-rs");
        let saved: Index = std::fs::read(data_dir.join(INDEX_FILE))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        let items = saved.items.into_iter().map(|e| (e.track.id.clone(), e)).collect();
        let http = reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .connect_timeout(Duration::from_secs(10))
            .read_timeout(Duration::from_secs(30))
            .build()
            .unwrap_or_default();
        Arc::new(Dl {
            data_dir,
            default_folder,
            inner: Mutex::new(Inner { folder: saved.folder, items, jobs: Vec::new() }),
            slots: Semaphore::new(PARALLEL),
            http,
            save_lock: Mutex::new(()),
        })
    })
    .clone()
}

impl Dl {
    fn folder(&self) -> PathBuf {
        let custom = self.inner.lock().unwrap().folder.clone();
        if custom.trim().is_empty() {
            self.default_folder.clone()
        } else {
            PathBuf::from(custom)
        }
    }

    /// Writes the index off the async threads; writes are serialized.
    fn persist(self: &Arc<Self>) {
        let snapshot = {
            let inner = self.inner.lock().unwrap();
            let mut items: Vec<Entry> = inner.items.values().cloned().collect();
            items.sort_by_key(|e| std::cmp::Reverse(e.at));
            Index { folder: inner.folder.clone(), items }
        };
        let me = self.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let _g = me.save_lock.lock().unwrap();
            write_json(&me.data_dir.join(INDEX_FILE), &snapshot);
        });
    }

    /// Updates the job this task owns (a cancelled-and-restarted id gets a new
    /// cancel flag, so a stale task can't touch its successor).
    fn update_job(&self, id: &str, owner: &Arc<AtomicBool>, f: impl FnOnce(&mut JobView)) -> Option<JobView> {
        let mut inner = self.inner.lock().unwrap();
        let job = inner.jobs.iter_mut().find(|j| j.view.id == id && Arc::ptr_eq(&j.cancel, owner))?;
        f(&mut job.view);
        Some(job.view.clone())
    }

    fn drop_job(&self, id: &str, owner: &Arc<AtomicBool>) {
        self.inner.lock().unwrap().jobs.retain(|j| !(j.view.id == id && Arc::ptr_eq(&j.cancel, owner)));
    }
}

fn allow(app: &AppHandle, dir: &Path) {
    if let Err(e) = app.asset_protocol_scope().allow_directory(dir, true) {
        eprintln!("[downloads] asset scope: {e}");
    }
}

fn emit(app: &AppHandle, v: &JobView) {
    let _ = app.emit(EVENT, v);
}

pub fn setup(app: &AppHandle) {
    let d = dl(app);
    allow(app, &d.folder());
    // Files saved into earlier folders keep playing too.
    let mut dirs: Vec<PathBuf> = {
        let inner = d.inner.lock().unwrap();
        inner.items.values().filter_map(|e| Path::new(&e.path).parent().map(Path::to_path_buf)).collect()
    };
    dirs.sort();
    dirs.dedup();
    for dir in dirs {
        allow(app, &dir);
    }
}

// ------------------------------------------------------------------ commands

fn arg_str(args: &Value, key: &str) -> String {
    args[key].as_str().map(str::trim).unwrap_or("").to_string()
}

fn parse_tracks(args: &Value) -> Result<Vec<Track>, String> {
    let mut out: Vec<Track> = Vec::new();
    if args["track"].is_object() {
        out.push(serde_json::from_value(args["track"].clone()).map_err(|e| format!("bad track: {e}"))?);
    }
    if let Some(list) = args["tracks"].as_array() {
        for t in list {
            if let Ok(t) = serde_json::from_value::<Track>(t.clone()) {
                out.push(t);
            }
        }
    }
    Ok(out)
}

pub async fn handle(app: &AppHandle, cmd: &str, args: Value) -> super::Out {
    let d = dl(app);
    match cmd {
        "start" => start(app, &d, &args),
        "list" => Ok(list(&d).await),
        "get" => {
            let id = arg_str(&args, "id");
            let entry = d.inner.lock().unwrap().items.get(&id).cloned();
            match entry {
                Some(e) if Path::new(&e.path).is_file() => Ok(json!({ "path": e.path, "track": e.track })),
                Some(_) => {
                    d.inner.lock().unwrap().items.remove(&id);
                    d.persist();
                    Ok(Value::Null)
                }
                None => Ok(Value::Null),
            }
        }
        "cancel" => {
            let id = arg_str(&args, "id");
            let ids: Vec<String> = {
                let inner = d.inner.lock().unwrap();
                inner.jobs.iter().filter(|j| id.is_empty() || j.view.id == id).map(|j| j.view.id.clone()).collect()
            };
            for id in &ids {
                cancel_job(app, &d, id);
            }
            Ok(json!({ "cancelled": ids.len() }))
        }
        "remove" => {
            let id = arg_str(&args, "id");
            let keep = args["keepFile"].as_bool().unwrap_or(false);
            let entry = d.inner.lock().unwrap().items.remove(&id);
            let Some(entry) = entry else { return Ok(json!({ "removed": false })) };
            d.persist();
            if !keep {
                let path = entry.path.clone();
                let _ = tauri::async_runtime::spawn_blocking(move || std::fs::remove_file(path)).await;
            }
            Ok(json!({ "removed": true }))
        }
        "folder" => {
            if let Some(p) = args["path"].as_str() {
                let p = p.trim().to_string();
                if !p.is_empty() && !Path::new(&p).is_absolute() {
                    return Err("Pick an absolute folder.".into());
                }
                d.inner.lock().unwrap().folder = p;
                d.persist();
                let folder = d.folder();
                let _ = std::fs::create_dir_all(&folder);
                allow(app, &folder);
            }
            Ok(folder_info(&d))
        }
        "reveal" => {
            let id = arg_str(&args, "id");
            let path = if id.is_empty() {
                None
            } else {
                d.inner.lock().unwrap().items.get(&id).map(|e| PathBuf::from(&e.path))
            };
            let folder = d.folder();
            tauri::async_runtime::spawn_blocking(move || match path.filter(|p| p.is_file()) {
                Some(p) => tauri_plugin_opener::reveal_item_in_dir(p).map_err(|e| e.to_string()),
                None => {
                    std::fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
                    tauri_plugin_opener::open_path(folder, None::<&str>).map_err(|e| e.to_string())
                }
            })
            .await
            .map_err(|e| e.to_string())??;
            Ok(Value::Null)
        }
        "probe" => probe(app, &d, &arg_str(&args, "id")).await,
        _ => Err(format!("downloads: unknown command {cmd}")),
    }
}

fn folder_info(d: &Dl) -> Value {
    let custom = !d.inner.lock().unwrap().folder.trim().is_empty();
    json!({
        "folder": d.folder().to_string_lossy(),
        "default": d.default_folder.to_string_lossy(),
        "custom": custom,
    })
}

async fn list(d: &Arc<Dl>) -> Value {
    let (mut items, jobs): (Vec<Entry>, Vec<JobView>) = {
        let inner = d.inner.lock().unwrap();
        (inner.items.values().cloned().collect(), inner.jobs.iter().map(|j| j.view.clone()).collect())
    };
    items.sort_by_key(|e| std::cmp::Reverse(e.at));
    let checked = tauri::async_runtime::spawn_blocking(move || {
        items
            .into_iter()
            .map(|e| {
                let exists = Path::new(&e.path).is_file();
                json!({ "id": e.track.id, "track": e.track, "path": e.path, "size": e.size, "at": e.at, "exists": exists })
            })
            .collect::<Vec<_>>()
    })
    .await
    .unwrap_or_default();
    let mut info = folder_info(d);
    info["items"] = Value::Array(checked);
    info["jobs"] = serde_json::to_value(jobs).unwrap_or_default();
    info
}

fn start(app: &AppHandle, d: &Arc<Dl>, args: &Value) -> super::Out {
    let tracks = parse_tracks(args)?;
    let album = arg_str(args, "album");
    let mut queued = 0;
    let mut already = 0;
    let mut skipped = 0;
    for t in tracks {
        if !t.source.is_empty() || t.id.is_empty() || !t.id.bytes().all(|b| b.is_ascii_digit()) {
            skipped += 1;
            continue;
        }
        let cancel = Arc::new(AtomicBool::new(false));
        let view = {
            let mut inner = d.inner.lock().unwrap();
            if inner.items.get(&t.id).is_some_and(|e| Path::new(&e.path).is_file()) {
                already += 1;
                continue;
            }
            if let Some(j) = inner.jobs.iter().find(|j| j.view.id == t.id) {
                if !matches!(j.view.state, "error" | "cancelled") {
                    already += 1;
                    continue;
                }
            }
            inner.jobs.retain(|j| j.view.id != t.id);
            let view = JobView { id: t.id.clone(), track: t.clone(), state: "queued", done: 0, total: 0, error: String::new(), path: String::new() };
            inner.jobs.push(Job { view: view.clone(), album: album.clone(), cancel: cancel.clone() });
            view
        };
        emit(app, &view);
        queued += 1;
        let (app, d) = (app.clone(), d.clone());
        tauri::async_runtime::spawn(async move { run_job(app, d, t, cancel).await });
    }
    Ok(json!({ "queued": queued, "already": already, "skipped": skipped }))
}

/// Stops a queued / running job (at its next chunk) or dismisses a failed one.
fn cancel_job(app: &AppHandle, d: &Dl, id: &str) {
    let view = {
        let mut inner = d.inner.lock().unwrap();
        let Some(pos) = inner.jobs.iter().position(|j| j.view.id == id) else { return };
        let job = inner.jobs.remove(pos);
        job.cancel.store(true, Ordering::SeqCst);
        let mut v = job.view;
        v.state = "cancelled";
        v
    };
    emit(app, &view);
}

// ------------------------------------------------------------------ one job

async fn run_job(app: AppHandle, d: Arc<Dl>, track: Track, cancel: Arc<AtomicBool>) {
    let id = track.id.clone();
    let Ok(_permit) = d.slots.acquire().await else { return };
    if cancel.load(Ordering::SeqCst) {
        return;
    }
    if let Some(v) = d.update_job(&id, &cancel, |v| v.state = "downloading") {
        emit(&app, &v);
    }
    let last = Mutex::new(Instant::now() - EMIT_EVERY);
    let on_progress = |done: u64, total: u64| {
        let Some(v) = d.update_job(&id, &cancel, |v| {
            v.done = done;
            v.total = total;
        }) else {
            return;
        };
        let mut l = last.lock().unwrap();
        if l.elapsed() >= EMIT_EVERY || (total > 0 && done >= total) {
            *l = Instant::now();
            emit(&app, &v);
        }
    };

    let album = d.inner.lock().unwrap().jobs.iter().find(|j| j.view.id == id).map(|j| j.album.clone()).unwrap_or_default();
    let (audio, art) = tokio::join!(fetch_audio(&app, &d.http, &track, &cancel, &on_progress), fetch_art(&d.http, &track.artwork));
    let result = match audio {
        Ok(audio) if !cancel.load(Ordering::SeqCst) => {
            if let Some(v) = d.update_job(&id, &cancel, |v| v.state = "saving") {
                emit(&app, &v);
            }
            let folder = d.folder();
            let existing = d.inner.lock().unwrap().items.get(&id).map(|e| PathBuf::from(&e.path));
            let t = track.clone();
            tauri::async_runtime::spawn_blocking(move || save(&folder, &t, &album, audio, art, existing.as_deref()))
                .await
                .map_err(|e| Fail::Fatal(e.to_string()))
                .and_then(|r| r.map_err(Fail::Fatal))
        }
        Ok(_) => Err(Fail::Cancelled),
        Err(e) => Err(e),
    };
    if cancel.load(Ordering::SeqCst) {
        // Cancelled while saving: drop the file we just wrote.
        if let Ok(saved) = &result {
            let _ = std::fs::remove_file(&saved.path);
        }
        return;
    }
    match result {
        Ok(saved) => {
            let path = saved.path.to_string_lossy().to_string();
            {
                let mut inner = d.inner.lock().unwrap();
                inner.items.insert(id.clone(), Entry { track: track.clone(), path: path.clone(), size: saved.size, at: now_secs() });
                inner.jobs.retain(|j| !(j.view.id == id && Arc::ptr_eq(&j.cancel, &cancel)));
            }
            d.persist();
            let total = saved.size;
            let v = JobView { id: id.clone(), track, state: "done", done: total, total, error: String::new(), path };
            emit(&app, &v);
        }
        Err(Fail::Cancelled) => d.drop_job(&id, &cancel),
        Err(Fail::Retry(msg) | Fail::Fatal(msg)) => {
            eprintln!("[downloads] {id} \"{}\": {msg}", track.title);
            if let Some(v) = d.update_job(&id, &cancel, |v| {
                v.state = "error";
                v.error = msg;
            }) {
                emit(&app, &v);
            }
        }
    }
}

// ------------------------------------------------------------------ fetching

#[derive(Debug)]
enum Fail {
    /// The stream link was refused (expired / signed); a fresh one may work.
    Retry(String),
    Fatal(String),
    Cancelled,
}

struct Audio {
    bytes: Vec<u8>,
    ext: &'static str,
    protocol: String,
    preset: String,
}

type OnProgress<'a> = &'a (dyn Fn(u64, u64) + Sync);

/// YouTube tracks: the youtube feature saves the same audio the player uses to a temp file.
async fn fetch_youtube(app: &AppHandle, track: &Track, on: OnProgress<'_>) -> Result<Audio, Fail> {
    let vid = track.id.strip_prefix("yt:").unwrap_or(&track.id).to_string();
    let dir = app.state::<crate::AppState>().data_dir.join("dl-tmp");
    let _ = std::fs::create_dir_all(&dir);
    let tmp = dir.join(format!("{vid}.part"));
    on(0, 1);
    let info = super::youtube::Yt::global().download(&vid, &tmp).await.map_err(Fail::Fatal)?;
    let bytes = std::fs::read(&tmp).map_err(|e| Fail::Fatal(e.to_string()));
    let _ = std::fs::remove_file(&tmp);
    let bytes = bytes?;
    on(1, 1);
    let mime = info["mime"].as_str().unwrap_or("");
    let ext = if mime.contains("mp4") { "m4a" } else { "webm" };
    Ok(Audio { bytes, ext, protocol: "progressive".into(), preset: format!("itag {}", info["itag"]) })
}

async fn fetch_audio(app: &AppHandle, http: &reqwest::Client, track: &Track, cancel: &AtomicBool, on: OnProgress<'_>) -> Result<Audio, Fail> {
    if track.source == "youtube" {
        return fetch_youtube(app, track, on).await;
    }
    let sc = app.state::<crate::AppState>().sc.clone();
    let mut last = Fail::Fatal("No stream".into());
    for attempt in 0..2 {
        if attempt > 0 {
            sc.forget_stream(&track.id);
        }
        let info = sc.stream(&track.id).await.map_err(|e| Fail::Fatal(e.to_string()))?;
        let got = if info.protocol == "hls" {
            fetch_hls(http, &info.url, cancel, on).await
        } else {
            fetch_progressive(http, &info.url, cancel, on).await
        };
        match got {
            Ok((bytes, ext)) => return Ok(Audio { bytes, ext, protocol: info.protocol, preset: info.preset }),
            Err(Fail::Retry(m)) => last = Fail::Retry(m),
            Err(e) => return Err(e),
        }
    }
    Err(last)
}

fn status_fail(code: u16) -> Fail {
    let m = format!("The audio server answered {code}");
    if matches!(code, 401 | 403 | 404 | 410) {
        Fail::Retry(m)
    } else {
        Fail::Fatal(m)
    }
}

async fn fetch_progressive(http: &reqwest::Client, url: &str, cancel: &AtomicBool, on: OnProgress<'_>) -> Result<(Vec<u8>, &'static str), Fail> {
    let mut res = http.get(url).send().await.map_err(|e| Fail::Fatal(format!("Download failed: {e}")))?;
    if !res.status().is_success() {
        return Err(status_fail(res.status().as_u16()));
    }
    let total = res.content_length().unwrap_or(0);
    let mut bytes = Vec::with_capacity(total as usize);
    on(0, total);
    while let Some(chunk) = res.chunk().await.map_err(|e| Fail::Fatal(format!("Download interrupted: {e}")))? {
        if cancel.load(Ordering::SeqCst) {
            return Err(Fail::Cancelled);
        }
        bytes.extend_from_slice(&chunk);
        on(bytes.len() as u64, total.max(bytes.len() as u64));
    }
    if bytes.is_empty() {
        return Err(Fail::Fatal("The audio server sent an empty file".into()));
    }
    let ext = media::sniff(&bytes);
    Ok((bytes, ext))
}

/// GET with retries for flaky network / 5xx; refused links fail fast.
async fn get_bytes(http: &reqwest::Client, url: &str, cancel: &AtomicBool) -> Result<Vec<u8>, Fail> {
    let mut last = Fail::Fatal(String::new());
    for attempt in 0..3u64 {
        if cancel.load(Ordering::SeqCst) {
            return Err(Fail::Cancelled);
        }
        if attempt > 0 {
            tokio::time::sleep(Duration::from_millis(400 * attempt)).await;
        }
        match http.get(url).send().await {
            Ok(r) if r.status().is_success() => match r.bytes().await {
                Ok(b) => return Ok(b.to_vec()),
                Err(e) => last = Fail::Fatal(format!("Download interrupted: {e}")),
            },
            Ok(r) => {
                let f = status_fail(r.status().as_u16());
                if matches!(f, Fail::Retry(_)) {
                    return Err(f);
                }
                last = f;
            }
            Err(e) => last = Fail::Fatal(format!("Download failed: {e}")),
        }
    }
    Err(last)
}

async fn fetch_hls(http: &reqwest::Client, url: &str, cancel: &AtomicBool, on: OnProgress<'_>) -> Result<(Vec<u8>, &'static str), Fail> {
    let mut base = Url::parse(url).map_err(|e| Fail::Fatal(e.to_string()))?;
    let mut list = media::parse_playlist(&String::from_utf8_lossy(&get_bytes(http, url, cancel).await?), &base);
    if list.segments.is_empty() {
        if let Some(v) = list.variants.first().cloned() {
            base = Url::parse(&v).map_err(|e| Fail::Fatal(e.to_string()))?;
            list = media::parse_playlist(&String::from_utf8_lossy(&get_bytes(http, &v, cancel).await?), &base);
        }
    }
    if list.encrypted {
        return Err(Fail::Fatal("This stream is encrypted and can't be saved.".into()));
    }
    if list.segments.is_empty() {
        return Err(Fail::Fatal("The stream playlist is empty.".into()));
    }
    let total = list.segments.len() as u64 + list.init.is_some() as u64;
    on(0, total);
    let init = match &list.init {
        Some(u) => Some(get_bytes(http, u, cancel).await?),
        None => None,
    };
    let mut done = init.is_some() as u64;
    on(done, total);

    // `buffered` keeps several requests in flight but yields in playlist order.
    let mut segs: Vec<Vec<u8>> = Vec::with_capacity(list.segments.len());
    let mut fetches = stream::iter(list.segments.clone())
        .map(|u: String| async move { get_bytes(http, &u, cancel).await })
        .buffered(SEGMENTS_IN_FLIGHT);
    while let Some(seg) = fetches.next().await {
        segs.push(seg?);
        done += 1;
        on(done, total);
    }

    if let Some(init) = init {
        if let Some(file) = mp4::defragment(&init, &segs) {
            return Ok((file, "m4a"));
        }
        // Still playable as a fragmented MP4.
        let mut file = init;
        for s in &segs {
            file.extend_from_slice(s);
        }
        return Ok((file, "m4a"));
    }
    if media::is_ts(&segs[0]) {
        let mut demux = media::TsDemux::default();
        for s in &segs {
            demux.push(s);
        }
        let ext = demux.finish().ok_or_else(|| Fail::Fatal("Unsupported audio codec in the stream.".into()))?;
        if demux.out.is_empty() {
            return Err(Fail::Fatal("The stream had no audio.".into()));
        }
        return Ok((demux.out, ext));
    }
    let ext = media::sniff(&segs[0]);
    let mut file = Vec::with_capacity(segs.iter().map(Vec::len).sum());
    for s in &segs {
        file.extend_from_slice(media::strip_id3(s));
    }
    Ok((file, ext))
}

async fn fetch_art(http: &reqwest::Client, artwork: &str) -> Option<Vec<u8>> {
    if artwork.is_empty() {
        return None;
    }
    let res = http.get(artwork).timeout(Duration::from_secs(20)).send().await.ok()?;
    if !res.status().is_success() {
        return None;
    }
    let b = res.bytes().await.ok()?;
    (b.len() > 64).then(|| b.to_vec())
}

// ------------------------------------------------------------------ saving

struct SavedFile {
    path: PathBuf,
    size: u64,
}

/// "Artist - Title", safe on every filesystem (riff's naming).
fn file_stem(track: &Track) -> String {
    let raw = format!("{} - {}", track.artist.trim(), track.title.trim());
    let mut s: String = raw.chars().filter(|c| !matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') && !c.is_control()).collect();
    s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if s.chars().count() > 150 {
        s = s.chars().take(150).collect();
    }
    let s = s.trim_end_matches(['.', ' ']).trim().to_string();
    let upper = s.to_ascii_uppercase();
    let reserved = ["CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "LPT1", "LPT2", "LPT3"];
    if s.is_empty() {
        format!("track {}", track.id)
    } else if reserved.contains(&upper.as_str()) {
        format!("_{s}")
    } else {
        s
    }
}

fn pick_path(folder: &Path, track: &Track, ext: &str, existing: Option<&Path>) -> PathBuf {
    let stem = file_stem(track);
    let plain = folder.join(format!("{stem}.{ext}"));
    if !plain.exists() || existing == Some(plain.as_path()) {
        return plain;
    }
    folder.join(format!("{stem} [{}].{ext}", track.id))
}

fn tag_file(path: &Path, track: &Track, album: &str, art: Option<Vec<u8>>) -> Result<(), String> {
    use lofty::config::{ParseOptions, WriteOptions};
    use lofty::picture::{MimeType, Picture, PictureType};
    use lofty::prelude::*;
    use lofty::tag::Tag;

    let s = |e: lofty::error::LoftyError| e.to_string();
    let mut file = lofty::probe::Probe::open(path)
        .map_err(s)?
        .options(ParseOptions::new().read_properties(false))
        .guess_file_type()
        .map_err(|e| e.to_string())?
        .read()
        .map_err(s)?;
    if file.primary_tag_mut().is_none() {
        let tt = file.primary_tag_type();
        file.insert_tag(Tag::new(tt));
    }
    let tag = file.primary_tag_mut().ok_or("no tag")?;
    tag.set_title(track.title.clone());
    tag.set_artist(track.artist.clone());
    if !album.trim().is_empty() {
        tag.set_album(album.trim().to_string());
    }
    if !track.genre.is_empty() {
        tag.set_genre(track.genre.clone());
    }
    if !track.url.is_empty() {
        tag.set_comment(track.url.clone());
    }
    if let Some(bytes) = art {
        let mime = if bytes.starts_with(&[0x89, b'P', b'N', b'G']) { MimeType::Png } else { MimeType::Jpeg };
        tag.remove_picture_type(PictureType::CoverFront);
        tag.push_picture(Picture::new_unchecked(PictureType::CoverFront, Some(mime), None, bytes));
    }
    file.save_to_path(path, WriteOptions::default()).map_err(s)
}

fn save(folder: &Path, track: &Track, album: &str, audio: Audio, art: Option<Vec<u8>>, existing: Option<&Path>) -> Result<SavedFile, String> {
    std::fs::create_dir_all(folder).map_err(|e| format!("Can't create the download folder: {e}"))?;
    let tmp = folder.join(format!(".riff-{}.{}", track.id, audio.ext));
    std::fs::write(&tmp, &audio.bytes).map_err(|e| format!("Can't write the file: {e}"))?;
    if let Err(e) = tag_file(&tmp, track, album, art) {
        // Untagged audio is still worth keeping.
        eprintln!("[downloads] tagging {} ({}, {}): {e}", track.id, audio.protocol, audio.preset);
    }
    let path = pick_path(folder, track, audio.ext, existing);
    if path.exists() {
        let _ = std::fs::remove_file(&path);
    }
    std::fs::rename(&tmp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("Can't save the file: {e}")
    })?;
    let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(audio.bytes.len() as u64);
    Ok(SavedFile { path, size })
}

// ------------------------------------------------------------------ selftest

/// Full pipeline into a temp folder, read back with lofty, then deleted.
/// Touches neither the index nor the user's download folder.
async fn probe(app: &AppHandle, d: &Dl, id: &str) -> super::Out {
    let t0 = Instant::now();
    let sc = app.state::<crate::AppState>().sc.clone();
    let raw = sc.api(&format!("/tracks/{id}"), &[]).await.map_err(|e| e.to_string())?;
    let track = crate::soundcloud::map_track(&raw);
    let cancel = AtomicBool::new(false);
    let noop = |_: u64, _: u64| {};
    let (audio, art) = tokio::join!(fetch_audio(app, &d.http, &track, &cancel, &noop), fetch_art(&d.http, &track.artwork));
    let audio = audio.map_err(|e| format!("{e:?}"))?;
    let (ext, protocol, preset, bytes) = (audio.ext, audio.protocol.clone(), audio.preset.clone(), audio.bytes.len());
    let fetched_ms = t0.elapsed().as_millis() as u64;
    let had_art = art.is_some();
    let dir = std::env::temp_dir().join(format!("riff-rs-dl-selftest-{}", std::process::id()));
    let t = track.clone();
    let mut out = tauri::async_runtime::spawn_blocking(move || -> Result<Value, String> {
        let saved = save(&dir, &t, "riff selftest", audio, art, None)?;
        use lofty::prelude::*;
        let out = match lofty::read_from_path(&saved.path) {
            Ok(f) => {
                let tag = f.primary_tag();
                json!({
                    "title": tag.and_then(|t| t.title().map(|s| s.to_string())).unwrap_or_default(),
                    "artist": tag.and_then(|t| t.artist().map(|s| s.to_string())).unwrap_or_default(),
                    "album": tag.and_then(|t| t.album().map(|s| s.to_string())).unwrap_or_default(),
                    "cover": tag.is_some_and(|t| !t.pictures().is_empty()),
                    "durationSec": f.properties().duration().as_secs_f64(),
                    "size": saved.size,
                    "name": saved.path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
                })
            }
            Err(e) => json!({ "readError": e.to_string(), "size": saved.size }),
        };
        let _ = std::fs::remove_dir_all(&dir);
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())??;
    out["id"] = json!(track.id);
    out["expectTitle"] = json!(track.title);
    out["expectDurationSec"] = json!(track.duration);
    out["ext"] = json!(ext);
    out["protocol"] = json!(protocol);
    out["preset"] = json!(preset);
    out["bytes"] = json!(bytes);
    out["artFetched"] = json!(had_art);
    out["fetchMs"] = json!(fetched_ms);
    out["totalMs"] = json!(t0.elapsed().as_millis() as u64);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn track(id: &str, artist: &str, title: &str) -> Track {
        serde_json::from_value(json!({ "id": id, "title": title, "artist": artist, "duration": 0, "artwork": "", "url": "" })).unwrap()
    }

    #[test]
    fn file_names_are_safe() {
        assert_eq!(file_stem(&track("1", "A/B", "x: y?*")), "AB - x y");
        assert_eq!(file_stem(&track("2", "  dj  ", "song...  ")), "dj - song");
        assert_eq!(file_stem(&track("3", "", "")), "-");
        assert_eq!(file_stem(&track("5", "con", "")), "con -");
        let long = "x".repeat(400);
        assert_eq!(file_stem(&track("4", "a", &long)).chars().count(), 150);
    }

    #[test]
    fn picks_unique_paths() {
        let dir = std::env::temp_dir().join(format!("riff-rs-dl-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let t = track("42", "Artist", "Song");
        let plain = pick_path(&dir, &t, "mp3", None);
        assert_eq!(plain.file_name().unwrap(), "Artist - Song.mp3");
        std::fs::write(&plain, b"x").unwrap();
        // Re-downloading the same id reuses its own file; another track with the same name doesn't.
        assert_eq!(pick_path(&dir, &t, "mp3", Some(&plain)), plain);
        assert_eq!(pick_path(&dir, &t, "mp3", None).file_name().unwrap(), "Artist - Song [42].mp3");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn saves_a_defragmented_m4a() {
        let init = mp4::tests::init_segment();
        let file = mp4::defragment(&init, &[mp4::tests::fragment(1, &[4, 4], 1)]).unwrap();
        let dir = std::env::temp_dir().join(format!("riff-rs-dl-save-{}", std::process::id()));
        let t = track("7", "Me", "Tune");
        let audio = Audio { bytes: file, ext: "m4a", protocol: "hls".into(), preset: "aac_160k".into() };
        let saved = save(&dir, &t, "", audio, None, None).unwrap();
        assert_eq!(saved.path.file_name().unwrap(), "Me - Tune.m4a");
        assert!(saved.size > 0);
        assert!(!dir.join(".riff-7.m4a").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn tags_an_mp3() {
        // Three silent MPEG-1 Layer III frames (128 kbps, 44.1 kHz).
        let mut frame = vec![0xFF, 0xFB, 0x90, 0x00];
        frame.resize(417, 0);
        let bytes = [frame.clone(), frame.clone(), frame].concat();
        let dir = std::env::temp_dir().join(format!("riff-rs-dl-tag-{}", std::process::id()));
        let mut t = track("8", "Someone", "Thing");
        t.genre = "House".into();
        let png = [&[0x89u8, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A][..], &[0u8; 80]].concat();
        let audio = Audio { bytes, ext: "mp3", protocol: "progressive".into(), preset: "mp3_1_0".into() };
        let saved = save(&dir, &t, "My list", audio, Some(png), None).unwrap();
        use lofty::prelude::*;
        let f = lofty::read_from_path(&saved.path).unwrap();
        let tag = f.primary_tag().unwrap();
        assert_eq!(tag.title().as_deref(), Some("Thing"));
        assert_eq!(tag.artist().as_deref(), Some("Someone"));
        assert_eq!(tag.album().as_deref(), Some("My list"));
        assert_eq!(tag.genre().as_deref(), Some("House"));
        assert_eq!(tag.pictures().len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Live: every HLS transcoding a track offers (mp3 / aac / opus) turns into a file lofty can read.
    #[tokio::test]
    #[ignore]
    async fn live_every_hls_transcoding() {
        let sc = crate::soundcloud::SoundCloud::new(std::env::temp_dir().join("riff-rs-dl-live"));
        let q = std::env::var("RIFF_DL_QUERY").unwrap_or_else(|_| "lofi hip hop".into());
        let found = sc.search(&q, 0).await.unwrap();
        let t = found.into_iter().find(|t| t.duration > 0 && t.duration < 400).expect("a short track");
        let raw = sc.api(&format!("/tracks/{}", t.id), &[]).await.unwrap();
        let cid = sc.client_id(false).await.unwrap();
        let auth = raw["track_authorization"].as_str().unwrap_or("").to_string();
        let http = reqwest::Client::builder().user_agent(USER_AGENT).build().unwrap();
        let cancel = AtomicBool::new(false);
        let noop = |_: u64, _: u64| {};
        let dir = std::env::temp_dir().join("riff-rs-dl-live-all");
        for tc in raw["media"]["transcodings"].as_array().unwrap() {
            let proto = tc["format"]["protocol"].as_str().unwrap_or("");
            let preset = tc["preset"].as_str().unwrap_or("");
            if proto.contains("encrypted") || tc["snipped"].as_bool() == Some(true) {
                continue;
            }
            let u = format!("{}?client_id={cid}&track_authorization={auth}", tc["url"].as_str().unwrap());
            let Ok(res) = http.get(&u).send().await else { continue };
            let Ok(body) = res.json::<Value>().await else { eprintln!("{preset} {proto}: no url"); continue };
            let Some(link) = body["url"].as_str() else { eprintln!("{preset} {proto}: refused"); continue };
            let got = if proto == "hls" { fetch_hls(&http, link, &cancel, &noop).await } else { fetch_progressive(&http, link, &cancel, &noop).await };
            let (bytes, ext) = match got {
                Ok(v) => v,
                Err(e) => {
                    eprintln!("{preset} {proto}: {e:?}");
                    continue;
                }
            };
            let mut tt = t.clone();
            tt.id = format!("{}{}", t.id, preset.len());
            tt.title = format!("{} {preset} {proto}", t.title);
            let saved = save(&dir, &tt, "", Audio { bytes, ext, protocol: proto.into(), preset: preset.into() }, None, None).unwrap();
            use lofty::prelude::*;
            let secs = lofty::read_from_path(&saved.path).map(|f| f.properties().duration().as_secs()).unwrap_or(0);
            eprintln!("{preset} {proto}: .{ext} {} bytes, {secs}s (expected ~{}s)", saved.size, t.duration);
        }
        if std::env::var("RIFF_DL_KEEP").is_err() {
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    /// Live: downloads a real track end to end into a temp folder.
    #[tokio::test]
    #[ignore]
    async fn live_download_pipeline() {
        let sc = crate::soundcloud::SoundCloud::new(std::env::temp_dir().join("riff-rs-dl-live"));
        let found = sc.search("lofi hip hop", 0).await.unwrap();
        let t = found.into_iter().find(|t| t.duration > 0 && t.duration < 400).expect("a short track");
        let info = sc.stream(&t.id).await.unwrap();
        let http = reqwest::Client::builder().user_agent(USER_AGENT).build().unwrap();
        let cancel = AtomicBool::new(false);
        let noop = |_: u64, _: u64| {};
        let got = if info.protocol == "hls" {
            fetch_hls(&http, &info.url, &cancel, &noop).await
        } else {
            fetch_progressive(&http, &info.url, &cancel, &noop).await
        };
        let (bytes, ext) = got.unwrap();
        eprintln!("{} {} {} -> {} bytes .{}", t.title, info.protocol, info.preset, bytes.len(), ext);
        let dir = std::env::temp_dir().join("riff-rs-dl-live-out");
        let art = fetch_art(&http, &t.artwork).await;
        let saved = save(&dir, &t, "", Audio { bytes, ext, protocol: info.protocol, preset: info.preset }, art, None).unwrap();
        use lofty::prelude::*;
        let f = lofty::read_from_path(&saved.path).unwrap();
        let secs = f.properties().duration().as_secs();
        eprintln!("saved {:?}, {}s (expected ~{}s)", saved.path, secs, t.duration);
        assert!(secs + 3 >= t.duration && secs <= t.duration + 3);
        assert_eq!(f.primary_tag().and_then(|t| t.title().map(|s| s.to_string())), Some(t.title.clone()));
        // RIFF_DL_KEEP=1 keeps the file for a look with ffprobe / a player.
        if std::env::var("RIFF_DL_KEEP").is_err() {
            let _ = std::fs::remove_dir_all(&dir);
        }
    }
}
