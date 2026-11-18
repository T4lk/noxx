//! "My files": local audio folders / files scanned into a library.
//!
//! * The folder + file list lives in `localfiles.json`, the scan cache (tags,
//!   duration, cover path, keyed by file path + mtime + size) in
//!   `localfiles-cache.json`, covers in `local-covers/` (named by a hash of the
//!   image bytes, so one album shares one file).
//! * Scans run on the blocking pool with a few worker threads; files that did
//!   not change since the last scan are taken from the cache untouched.
//! * Every folder / file (and the cover dir) is allowed in the asset protocol
//!   scope so the UI can play and show them with `convertFileSrc`.
//!
//! Commands (`riff.call('localfiles.<cmd>', args)`):
//!   list                         -> { folders, files, tracks, scanning }
//!   add { folders?, files? }     -> list (after scanning the new entries)
//!   remove { path }              -> list
//!   rescan                       -> list
//!   reveal { path }              -> null (shows the file in Explorer / Finder)
//!   selftest                     -> { tracks } (scans a generated WAV, nothing persisted)
//!
//! Event: `localfiles-changed` { count } after every finished scan.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

const EXTS: &[&str] = &["mp3", "m4a", "aac", "flac", "ogg", "opus", "wav"];
const ROOTS_FILE: &str = "localfiles.json";
const CACHE_FILE: &str = "localfiles-cache.json";
const COVERS_DIR: &str = "local-covers";
const SELFTEST_DIR: &str = "localfiles-selftest";

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
struct Roots {
    #[serde(default)]
    folders: Vec<String>,
    #[serde(default)]
    files: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct LocalTrack {
    id: String,
    title: String,
    artist: String,
    #[serde(default)]
    album: String,
    #[serde(default)]
    genre: String,
    /// seconds
    duration: u64,
    path: String,
    /// Extracted cover image file ("" if none).
    #[serde(default)]
    cover: String,
    /// Unix ms when the file first showed up in the library.
    #[serde(default)]
    added: u64,
}

impl LocalTrack {
    fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "title": self.title,
            "artist": self.artist,
            "album": self.album,
            "genre": self.genre,
            "duration": self.duration,
            "artwork": "",
            "url": "",
            "source": "local",
            "path": self.path,
            "cover": self.cover,
            "added": self.added,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Entry {
    mtime: u64,
    size: u64,
    track: LocalTrack,
}

#[derive(Default)]
struct Inner {
    roots: Roots,
    /// path -> cached scan result
    cache: HashMap<String, Entry>,
    /// display order (paths)
    order: Vec<String>,
    scanning: bool,
}

fn inner() -> &'static Mutex<Inner> {
    static S: OnceLock<Mutex<Inner>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(Inner::default()))
}

fn scan_lock() -> &'static tokio::sync::Mutex<()> {
    static L: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    L.get_or_init(|| tokio::sync::Mutex::new(()))
}

fn data_dir(app: &AppHandle) -> PathBuf {
    app.state::<crate::AppState>().data_dir.clone()
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

// ------------------------------------------------------------------
// pure helpers (unit tested)
// ------------------------------------------------------------------

/// FNV-1a 64: stable across runs and platforms (unlike std's hasher).
fn fnv1a(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in bytes {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

/// Windows paths are case-insensitive and may use either slash.
fn path_key(path: &str) -> String {
    if cfg!(windows) {
        path.replace('/', "\\").to_lowercase()
    } else {
        path.to_string()
    }
}

fn track_id(path: &str) -> String {
    format!("local:{:016x}", fnv1a(path_key(path).as_bytes()))
}

fn is_audio(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| EXTS.iter().any(|x| x.eq_ignore_ascii_case(e)))
}

/// Strips a leading track number like "01 - ", "3. ", "07_" or "01 ".
fn strip_track_no(name: &str) -> &str {
    let digits = name.bytes().take_while(|b| b.is_ascii_digit()).count();
    if digits == 0 || digits > 3 {
        return name;
    }
    let rest = &name[digits..];
    let trimmed = rest.trim_start();
    let after = if let Some(r) = trimmed.strip_prefix(['.', '-', '_', ')']) {
        r.trim_start()
    } else if digits == 2 && name.starts_with('0') && rest.starts_with(' ') {
        // "01 Title" – only for zero-padded numbers so "50 Cent - X" stays intact
        trimmed
    } else {
        return name;
    };
    if after.is_empty() {
        name
    } else {
        after
    }
}

/// Splits "Artist - Title" (also with en / em dashes). None when there is no separator.
fn split_artist_title(s: &str) -> Option<(String, String)> {
    for sep in [" - ", " – ", " — "] {
        if let Some((a, t)) = s.split_once(sep) {
            let (a, t) = (a.trim(), t.trim());
            if !a.is_empty() && !t.is_empty() {
                return Some((a.to_string(), t.to_string()));
            }
        }
    }
    None
}

/// (title, artist) from a file name when the tags have nothing.
fn parse_file_name(path: &Path) -> (String, String) {
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("").replace('_', " ");
    let stem = stem.trim();
    let clean = strip_track_no(stem);
    match split_artist_title(clean) {
        Some((a, t)) => (t, a),
        None => (if clean.is_empty() { "Untitled".to_string() } else { clean.to_string() }, String::new()),
    }
}

/// Merges tag values with the file-name fallback the way riff does it -> (title, artist).
fn resolve_names(path: &Path, tag_title: &str, tag_artist: &str) -> (String, String) {
    let (mut title, mut artist) = (tag_title.trim().to_string(), tag_artist.trim().to_string());
    if title.is_empty() {
        let (t, a) = parse_file_name(path);
        title = t;
        if artist.is_empty() {
            artist = a;
        }
    } else if artist.is_empty() {
        if let Some((a, t)) = split_artist_title(&title) {
            artist = a;
            title = t;
        }
    }
    if artist.is_empty() {
        artist = "Unknown artist".to_string();
    }
    (title, artist)
}

/// All audio files under the roots (recursive for folders), de-duplicated, in walk order.
fn collect_files(roots: &Roots) -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    let mut push = |p: PathBuf, out: &mut Vec<PathBuf>| {
        if seen.insert(path_key(&p.to_string_lossy())) {
            out.push(p);
        }
    };
    for folder in &roots.folders {
        let mut stack = vec![PathBuf::from(folder)];
        while let Some(dir) = stack.pop() {
            let Ok(rd) = std::fs::read_dir(&dir) else { continue };
            let mut entries: Vec<_> = rd.flatten().collect();
            entries.sort_by_key(|e| e.file_name());
            let mut subdirs = Vec::new();
            for e in entries {
                if e.file_name().to_string_lossy().starts_with('.') {
                    continue;
                }
                // file_type() does not follow symlinks, so link loops can't trap us.
                let Ok(ft) = e.file_type() else { continue };
                let p = e.path();
                if ft.is_dir() {
                    subdirs.push(p);
                } else if ft.is_file() && is_audio(&p) {
                    push(p, &mut out);
                }
            }
            // reversed so the stack pops them in name order
            stack.extend(subdirs.into_iter().rev());
        }
    }
    for f in &roots.files {
        let p = PathBuf::from(f);
        if p.is_file() && is_audio(&p) {
            push(p, &mut out);
        }
    }
    out
}

fn file_stamp(path: &Path) -> Option<(u64, u64)> {
    let md = std::fs::metadata(path).ok()?;
    let mtime = md.modified().ok()?.duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    Some((mtime, md.len()))
}

/// Reads tags, duration and the cover (written to `covers`) of one file.
fn read_track(path: &Path, covers: &Path) -> LocalTrack {
    use lofty::picture::{MimeType, PictureType};
    use lofty::prelude::*;

    let path_str = path.to_string_lossy().to_string();
    let (mut tag_title, mut tag_artist, mut album, mut genre) = (String::new(), String::new(), String::new(), String::new());
    let mut duration = 0;
    let mut cover = String::new();

    if let Ok(file) = lofty::read_from_path(path) {
        duration = file.properties().duration().as_secs_f64().round() as u64;
        let tags: Vec<&lofty::tag::Tag> = file.primary_tag().into_iter().chain(file.tags().iter()).collect();
        let pick = |f: &dyn Fn(&lofty::tag::Tag) -> Option<String>| {
            tags.iter().find_map(|t| f(t).map(|s| s.trim().to_string()).filter(|s| !s.is_empty())).unwrap_or_default()
        };
        tag_title = pick(&|t| t.title().map(|s| s.into_owned()));
        tag_artist = pick(&|t| t.artist().map(|s| s.into_owned()));
        album = pick(&|t| t.album().map(|s| s.into_owned()));
        genre = pick(&|t| t.genre().map(|s| s.into_owned()));

        let pics: Vec<&lofty::picture::Picture> = tags.iter().flat_map(|t| t.pictures().iter()).collect();
        let pic = pics.iter().find(|p| p.pic_type() == PictureType::CoverFront).or_else(|| pics.first());
        if let Some(pic) = pic {
            let data = pic.data();
            if !data.is_empty() {
                let ext = match pic.mime_type() {
                    Some(MimeType::Png) => "png",
                    Some(MimeType::Gif) => "gif",
                    Some(MimeType::Bmp) => "bmp",
                    _ => "jpg",
                };
                let out = covers.join(format!("{:016x}.{ext}", fnv1a(data)));
                if out.exists() || (std::fs::create_dir_all(covers).is_ok() && std::fs::write(&out, data).is_ok()) {
                    cover = out.to_string_lossy().to_string();
                }
            }
        }
    }

    let (title, artist) = resolve_names(path, &tag_title, &tag_artist);
    LocalTrack { id: track_id(&path_str), title, artist, album, genre, duration, path: path_str, cover, added: 0 }
}

/// Full scan: reuses unchanged cache entries, reads the rest in parallel.
/// Returns the new cache and the display order (newest first, then walk order).
fn scan(roots: &Roots, old: &HashMap<String, Entry>, covers: &Path) -> (HashMap<String, Entry>, Vec<String>) {
    let files = collect_files(roots);
    let now = now_ms();
    let mut cache = HashMap::with_capacity(files.len());
    let mut todo = Vec::new();
    for p in &files {
        let key = p.to_string_lossy().to_string();
        let Some((mtime, size)) = file_stamp(p) else { continue };
        match old.get(&key) {
            Some(e) if e.mtime == mtime && e.size == size && (e.track.cover.is_empty() || Path::new(&e.track.cover).exists()) => {
                cache.insert(key, e.clone());
            }
            _ => todo.push((p.clone(), mtime, size, old.get(&key).map(|e| e.track.added))),
        }
    }

    if !todo.is_empty() {
        let next = AtomicUsize::new(0);
        let results = Mutex::new(Vec::with_capacity(todo.len()));
        let workers = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).clamp(1, 6).min(todo.len());
        std::thread::scope(|s| {
            for _ in 0..workers {
                s.spawn(|| loop {
                    let k = next.fetch_add(1, Ordering::Relaxed);
                    let Some((p, mtime, size, added)) = todo.get(k) else { break };
                    let mut track = read_track(p, covers);
                    track.added = added.unwrap_or(now);
                    let entry = Entry { mtime: *mtime, size: *size, track };
                    results.lock().unwrap().push((p.to_string_lossy().to_string(), entry));
                });
            }
        });
        cache.extend(results.into_inner().unwrap());
    }

    let pos: HashMap<String, usize> = files.iter().enumerate().map(|(i, p)| (p.to_string_lossy().to_string(), i)).collect();
    let mut order: Vec<String> = cache.keys().cloned().collect();
    order.sort_by(|a, b| {
        let (ea, eb) = (&cache[a], &cache[b]);
        eb.track.added.cmp(&ea.track.added).then(pos.get(a).cmp(&pos.get(b)))
    });
    (cache, order)
}

// ------------------------------------------------------------------
// persistence / scope
// ------------------------------------------------------------------

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Option<T> {
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

fn allow_roots(app: &AppHandle, roots: &Roots) {
    let scope = app.asset_protocol_scope();
    let _ = scope.allow_directory(data_dir(app).join(COVERS_DIR), false);
    for f in &roots.folders {
        let _ = scope.allow_directory(f, true);
    }
    for f in &roots.files {
        let _ = scope.allow_file(f);
    }
}

/// Loads roots + cache once (off the main thread); every command waits for it.
async fn ensure_loaded(app: &AppHandle) {
    static LOADED: tokio::sync::OnceCell<()> = tokio::sync::OnceCell::const_new();
    LOADED
        .get_or_init(|| async {
            let dir = data_dir(app);
            let (roots, list) = tauri::async_runtime::spawn_blocking(move || {
                let roots: Roots = read_json(&dir.join(ROOTS_FILE)).unwrap_or_default();
                let list: Vec<Entry> = read_json(&dir.join(CACHE_FILE)).unwrap_or_default();
                (roots, list)
            })
            .await
            .unwrap_or_default();
            allow_roots(app, &roots);
            // The cache file is written in display order already.
            let order: Vec<String> = list.iter().map(|e| e.track.path.clone()).collect();
            let mut st = inner().lock().unwrap();
            st.roots = roots;
            st.order = order;
            st.cache = list.into_iter().map(|e| (e.track.path.clone(), e)).collect();
        })
        .await;
}

fn save_roots(app: &AppHandle, roots: &Roots) {
    crate::soundcloud::write_json(&data_dir(app).join(ROOTS_FILE), roots);
}

fn snapshot() -> Value {
    let st = inner().lock().unwrap();
    let tracks: Vec<Value> = st.order.iter().filter_map(|p| st.cache.get(p)).map(|e| e.track.to_json()).collect();
    json!({ "folders": st.roots.folders, "files": st.roots.files, "tracks": tracks, "scanning": st.scanning })
}

async fn run_scan(app: &AppHandle) {
    ensure_loaded(app).await;
    let _guard = scan_lock().lock().await;
    let (roots, old) = {
        let mut st = inner().lock().unwrap();
        st.scanning = true;
        (st.roots.clone(), st.cache.clone())
    };
    let dir = data_dir(app);
    let res = tauri::async_runtime::spawn_blocking(move || {
        let (cache, order) = scan(&roots, &old, &dir.join(COVERS_DIR));
        let list: Vec<&Entry> = order.iter().filter_map(|p| cache.get(p)).collect();
        crate::soundcloud::write_json(&dir.join(CACHE_FILE), &list);
        (cache, order)
    })
    .await;
    let count = {
        let mut st = inner().lock().unwrap();
        st.scanning = false;
        if let Ok((cache, order)) = res {
            st.cache = cache;
            st.order = order;
        }
        st.order.len()
    };
    let _ = app.emit("localfiles-changed", json!({ "count": count }));
}

fn str_list(args: &Value, key: &str) -> Vec<String> {
    args.get(key)
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str()).map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect())
        .unwrap_or_default()
}

// ------------------------------------------------------------------
// selftest helper: a short silent WAV with an "Artist - Title" name
// ------------------------------------------------------------------

fn write_test_wav(path: &Path, seconds: u32) -> std::io::Result<()> {
    let rate: u32 = 8000;
    let data_len = rate * seconds * 2; // mono 16-bit
    let mut b = Vec::with_capacity(44 + data_len as usize);
    b.extend_from_slice(b"RIFF");
    b.extend_from_slice(&(36 + data_len).to_le_bytes());
    b.extend_from_slice(b"WAVEfmt ");
    b.extend_from_slice(&16u32.to_le_bytes());
    b.extend_from_slice(&1u16.to_le_bytes()); // PCM
    b.extend_from_slice(&1u16.to_le_bytes()); // mono
    b.extend_from_slice(&rate.to_le_bytes());
    b.extend_from_slice(&(rate * 2).to_le_bytes());
    b.extend_from_slice(&2u16.to_le_bytes());
    b.extend_from_slice(&16u16.to_le_bytes());
    b.extend_from_slice(b"data");
    b.extend_from_slice(&data_len.to_le_bytes());
    b.resize(44 + data_len as usize, 0);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, b)
}

// ------------------------------------------------------------------
// entry points
// ------------------------------------------------------------------

pub fn setup(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        ensure_loaded(&app).await;
        // The cached list is usable right away; refresh it in the background.
        let (count, has_roots) = {
            let st = inner().lock().unwrap();
            (st.order.len(), !st.roots.folders.is_empty() || !st.roots.files.is_empty())
        };
        let _ = app.emit("localfiles-changed", json!({ "count": count }));
        if has_roots {
            run_scan(&app).await;
        }
    });
}

pub async fn handle(app: &AppHandle, cmd: &str, args: Value) -> super::Out {
    ensure_loaded(app).await;
    match cmd {
        "list" => Ok(snapshot()),
        "add" => {
            let folders = str_list(&args, "folders");
            let files: Vec<String> = str_list(&args, "files").into_iter().filter(|f| is_audio(Path::new(f))).collect();
            let roots = {
                let mut st = inner().lock().unwrap();
                let mut have: HashSet<String> = st.roots.folders.iter().chain(st.roots.files.iter()).map(|p| path_key(p)).collect();
                for f in folders {
                    if Path::new(&f).is_dir() && have.insert(path_key(&f)) {
                        st.roots.folders.push(f);
                    }
                }
                for f in files {
                    if Path::new(&f).is_file() && have.insert(path_key(&f)) {
                        st.roots.files.push(f);
                    }
                }
                st.roots.clone()
            };
            save_roots(app, &roots);
            allow_roots(app, &roots);
            run_scan(app).await;
            Ok(snapshot())
        }
        "remove" => {
            let key = path_key(args.get("path").and_then(|v| v.as_str()).unwrap_or(""));
            let roots = {
                let mut st = inner().lock().unwrap();
                st.roots.folders.retain(|p| path_key(p) != key);
                st.roots.files.retain(|p| path_key(p) != key);
                st.roots.clone()
            };
            save_roots(app, &roots);
            run_scan(app).await;
            Ok(snapshot())
        }
        "rescan" => {
            run_scan(app).await;
            Ok(snapshot())
        }
        "reveal" => {
            let path = args.get("path").and_then(|v| v.as_str()).unwrap_or("");
            if path.is_empty() {
                return Err("no path".into());
            }
            tauri_plugin_opener::reveal_item_in_dir(path).map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "selftest" => {
            let dir = data_dir(app).join(SELFTEST_DIR);
            let covers = data_dir(app).join(COVERS_DIR);
            let scope_dir = dir.clone();
            let tracks = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<Value>, String> {
                let file = dir.join("Selftest Artist - Selftest Tone.wav");
                if !file.exists() {
                    write_test_wav(&file, 3).map_err(|e| e.to_string())?;
                }
                let roots = Roots { folders: vec![dir.to_string_lossy().to_string()], files: vec![] };
                let (cache, order) = scan(&roots, &HashMap::new(), &covers);
                Ok(order.iter().filter_map(|p| cache.get(p)).map(|e| e.track.to_json()).collect())
            })
            .await
            .map_err(|e| e.to_string())??;
            let _ = app.asset_protocol_scope().allow_directory(&scope_dir, true);
            Ok(json!({ "tracks": tracks }))
        }
        _ => Err(format!("localfiles: unknown command {cmd}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_stable_and_prefixed() {
        let a = track_id("C:\\Music\\a.mp3");
        assert!(a.starts_with("local:"));
        assert_eq!(a.len(), "local:".len() + 16);
        assert_eq!(a, track_id("C:\\Music\\a.mp3"));
        assert_ne!(a, track_id("C:\\Music\\b.mp3"));
        assert_eq!(fnv1a(b""), 0xcbf29ce484222325);
    }

    #[test]
    fn file_name_parsing() {
        let p = |s: &str| parse_file_name(Path::new(s));
        let pair = |t: &str, a: &str| (t.to_string(), a.to_string());
        assert_eq!(p("Daft Punk - One More Time.mp3"), pair("One More Time", "Daft Punk"));
        assert_eq!(p("01 - Daft Punk - One More Time.flac"), pair("One More Time", "Daft Punk"));
        assert_eq!(p("03. Intro.mp3"), pair("Intro", ""));
        assert_eq!(p("07 Song Name.ogg"), pair("Song Name", ""));
        assert_eq!(p("50 Cent - In Da Club.mp3"), pair("In Da Club", "50 Cent"));
        assert_eq!(p("2Pac - Changes.mp3"), pair("Changes", "2Pac"));
        assert_eq!(p("Artist – Title.m4a"), pair("Title", "Artist"));
        assert_eq!(p("just_a_title.wav"), pair("just a title", ""));
        assert_eq!(p("1999.mp3"), pair("1999", ""));
    }

    #[test]
    fn names_merge_with_tags() {
        let path = Path::new("X - Y.mp3");
        let pair = |t: &str, a: &str| (t.to_string(), a.to_string());
        assert_eq!(resolve_names(path, "Tag Title", "Tag Artist"), pair("Tag Title", "Tag Artist"));
        assert_eq!(resolve_names(path, "", ""), pair("Y", "X"));
        assert_eq!(resolve_names(path, "A - B", ""), pair("B", "A"));
        assert_eq!(resolve_names(Path::new("Plain.mp3"), "", ""), pair("Plain", "Unknown artist"));
        assert_eq!(resolve_names(path, "", "Tagged"), pair("Y", "Tagged"));
    }

    #[test]
    fn audio_extensions() {
        for e in ["a.mp3", "a.M4A", "a.aac", "a.flac", "a.ogg", "a.opus", "a.wav"] {
            assert!(is_audio(Path::new(e)), "{e}");
        }
        for e in ["a.txt", "a.jpg", "a", "a.mp3.part"] {
            assert!(!is_audio(Path::new(e)), "{e}");
        }
    }

    #[test]
    fn scan_reads_wav_and_uses_cache() {
        let root = std::env::temp_dir().join(format!("riff-localfiles-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let sub = root.join("Album");
        write_test_wav(&sub.join("Some Artist - Some Song.wav"), 2).unwrap();
        write_test_wav(&root.join("02 - Lone.wav"), 1).unwrap();
        std::fs::write(root.join("notes.txt"), b"x").unwrap();
        write_test_wav(&root.join(".hidden").join("skip.wav"), 1).unwrap();

        let roots = Roots { folders: vec![root.to_string_lossy().to_string()], files: vec![] };
        let covers = root.join("covers");
        let (cache, order) = scan(&roots, &HashMap::new(), &covers);
        assert_eq!(order.len(), 2, "{order:?}");
        let song = cache.values().find(|e| e.track.title == "Some Song").expect("song");
        assert_eq!(song.track.artist, "Some Artist");
        assert_eq!(song.track.duration, 2);
        assert!(song.track.id.starts_with("local:"));
        let lone = cache.values().find(|e| e.track.title == "Lone").expect("lone");
        assert_eq!(lone.track.artist, "Unknown artist");

        // A second scan reuses the entries (same `added` stamp, same ids).
        let (cache2, order2) = scan(&roots, &cache, &covers);
        assert_eq!(order2, order);
        for (k, e) in &cache {
            assert_eq!(cache2[k].track, e.track);
        }

        // Individual file roots work, duplicates are dropped.
        let single = sub.join("Some Artist - Some Song.wav").to_string_lossy().to_string();
        let both = Roots { folders: roots.folders.clone(), files: vec![single.clone()] };
        assert_eq!(collect_files(&both).len(), 2);
        let only = Roots { folders: vec![], files: vec![single] };
        assert_eq!(collect_files(&only).len(), 1);

        let _ = std::fs::remove_dir_all(&root);
    }
}
