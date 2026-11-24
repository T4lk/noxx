//! Song cache: songs you play are kept on disk, so playing them again starts instantly and
//! works offline. The least recently played go first once the cache is over its size limit
//! (default 3 GB). Files are plain audio from the downloads pipeline (no tags), named by id,
//! in `<data>/audio-cache`, indexed in `audio-cache.json`.
//!
//! Commands (`riff.call('audiocache.<cmd>', args)`):
//!   get   { id }            -> { path } | null   (marks it as just played)
//!   add   { track }         -> { queued }        (fetched in the background, one at a time)
//!   list                    -> { tracks, bytes, limit, count }
//!   set_limit { bytes }     -> list
//!   remove { id }           -> list
//!   clear                   -> list
//!
//! Event: `audiocache-changed` { count, bytes } after a song is added or the cache shrinks.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::soundcloud::{write_json, Track};

const DIR: &str = "audio-cache";
const INDEX: &str = "audio-cache.json";
const DEFAULT_LIMIT: u64 = 3 * 1024 * 1024 * 1024;
const MIN_LIMIT: u64 = 250 * 1024 * 1024;

#[derive(Clone, Serialize, Deserialize)]
struct Entry {
    track: Track,
    file: String,
    size: u64,
    /// Last played, unix seconds.
    last: u64,
}

#[derive(Default, Serialize, Deserialize)]
struct Index {
    #[serde(default)]
    limit: u64,
    #[serde(default)]
    items: Vec<Entry>,
}

struct Cache {
    dir: PathBuf,
    index_path: PathBuf,
    limit: u64,
    items: HashMap<String, Entry>,
    busy: HashSet<String>,
    queue: Vec<Track>,
    running: bool,
}

static CACHE: OnceLock<Arc<Mutex<Cache>>> = OnceLock::new();

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn cache(app: &AppHandle) -> Arc<Mutex<Cache>> {
    CACHE
        .get_or_init(|| {
            let data = app.state::<crate::AppState>().data_dir.clone();
            let index_path = data.join(INDEX);
            let saved: Index = std::fs::read(&index_path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
            let items = saved.items.into_iter().map(|e| (e.track.id.clone(), e)).collect();
            let limit = if saved.limit == 0 { DEFAULT_LIMIT } else { saved.limit.max(MIN_LIMIT) };
            Arc::new(Mutex::new(Cache { dir: data.join(DIR), index_path, limit, items, busy: HashSet::new(), queue: Vec::new(), running: false }))
        })
        .clone()
}

impl Cache {
    fn bytes(&self) -> u64 {
        self.items.values().map(|e| e.size).sum()
    }
    fn path(&self, e: &Entry) -> PathBuf {
        self.dir.join(&e.file)
    }
    fn save(&self) {
        let mut items: Vec<Entry> = self.items.values().cloned().collect();
        items.sort_by_key(|e| std::cmp::Reverse(e.last));
        write_json(&self.index_path, &Index { limit: self.limit, items });
    }
    /// Drops the least recently played songs until the cache fits its limit.
    fn evict(&mut self) -> usize {
        let mut by_age: Vec<(u64, String)> = self.items.values().map(|e| (e.last, e.track.id.clone())).collect();
        by_age.sort();
        let mut total = self.bytes();
        let mut n = 0;
        for (_, id) in by_age {
            if total <= self.limit {
                break;
            }
            if let Some(e) = self.items.remove(&id) {
                let _ = std::fs::remove_file(self.path(&e));
                total = total.saturating_sub(e.size);
                n += 1;
            }
        }
        n
    }
    fn summary(&self) -> Value {
        let mut list: Vec<&Entry> = self.items.values().collect();
        list.sort_by_key(|e| std::cmp::Reverse(e.last));
        json!({
            "tracks": list.iter().map(|e| &e.track).collect::<Vec<_>>(),
            "count": self.items.len(),
            "bytes": self.bytes(),
            "limit": self.limit,
        })
    }
}

fn changed(app: &AppHandle, c: &Cache) {
    let _ = app.emit("audiocache-changed", json!({ "count": c.items.len(), "bytes": c.bytes() }));
}

fn safe_name(id: &str) -> String {
    id.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect()
}

pub fn setup(app: &AppHandle) {
    let c = cache(app);
    let dir = c.lock().unwrap().dir.clone();
    let _ = std::fs::create_dir_all(&dir);
    if let Err(e) = app.asset_protocol_scope().allow_directory(&dir, true) {
        eprintln!("[audiocache] asset scope: {e}");
    }
}

/// Fetches queued songs one after another (playback has priority on the network).
fn pump(app: AppHandle) {
    let c = cache(&app);
    {
        let mut g = c.lock().unwrap();
        if g.running {
            return;
        }
        g.running = true;
    }
    tauri::async_runtime::spawn(async move {
        loop {
            let next = {
                let mut g = c.lock().unwrap();
                if g.queue.is_empty() {
                    g.running = false;
                    break;
                }
                g.queue.remove(0)
            };
            let id = next.id.clone();
            let result = super::downloads::fetch_plain(&app, &next).await;
            let mut g = c.lock().unwrap();
            g.busy.remove(&id);
            match result {
                Ok((bytes, ext)) => {
                    let file = format!("{}.{ext}", safe_name(&id));
                    let path = g.dir.join(&file);
                    let _ = std::fs::create_dir_all(&g.dir);
                    if let Err(e) = std::fs::write(&path, &bytes) {
                        eprintln!("[audiocache] write {id}: {e}");
                        continue;
                    }
                    g.items.insert(id.clone(), Entry { track: next, file, size: bytes.len() as u64, last: now() });
                    g.evict();
                    g.save();
                    changed(&app, &g);
                }
                Err(e) => eprintln!("[audiocache] {id}: {e}"),
            }
        }
    });
}

fn arg_id(args: &Value) -> String {
    args["id"].as_str().unwrap_or("").trim().to_string()
}

pub async fn handle(app: &AppHandle, cmd: &str, args: Value) -> super::Out {
    let c = cache(app);
    match cmd {
        "get" => {
            let id = arg_id(&args);
            let mut g = c.lock().unwrap();
            let Some(e) = g.items.get(&id).cloned() else { return Ok(Value::Null) };
            let path = g.path(&e);
            if !path.is_file() {
                g.items.remove(&id);
                g.save();
                return Ok(Value::Null);
            }
            if let Some(x) = g.items.get_mut(&id) {
                x.last = now();
            }
            g.save();
            Ok(json!({ "path": path.to_string_lossy(), "track": e.track }))
        }
        "add" => {
            let track: Track = serde_json::from_value(args["track"].clone()).map_err(|e| format!("bad track: {e}"))?;
            if track.id.is_empty() || track.source == "local" {
                return Ok(json!({ "queued": false }));
            }
            let queued = {
                let mut g = c.lock().unwrap();
                if g.items.contains_key(&track.id) || !g.busy.insert(track.id.clone()) {
                    false
                } else {
                    g.queue.push(track);
                    true
                }
            };
            if queued {
                pump(app.clone());
            }
            Ok(json!({ "queued": queued }))
        }
        "list" => Ok(c.lock().unwrap().summary()),
        "set_limit" => {
            let bytes = args["bytes"].as_u64().ok_or("bytes must be a number")?.max(MIN_LIMIT);
            let mut g = c.lock().unwrap();
            g.limit = bytes;
            if g.evict() > 0 {
                changed(app, &g);
            }
            g.save();
            Ok(g.summary())
        }
        "remove" => {
            let id = arg_id(&args);
            let mut g = c.lock().unwrap();
            if let Some(e) = g.items.remove(&id) {
                let _ = std::fs::remove_file(g.path(&e));
                g.save();
                changed(app, &g);
            }
            Ok(g.summary())
        }
        "clear" => {
            let mut g = c.lock().unwrap();
            let files: Vec<PathBuf> = g.items.values().map(|e| g.path(e)).collect();
            for f in files {
                let _ = std::fs::remove_file(f);
            }
            g.items.clear();
            g.queue.clear();
            g.save();
            changed(app, &g);
            Ok(g.summary())
        }
        _ => Err(format!("unknown audiocache command: {cmd}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: &str, size: u64, last: u64) -> Entry {
        let track: Track = serde_json::from_value(json!({ "id": id, "title": id, "artist": "", "duration": 1, "artwork": "", "url": "" })).unwrap();
        Entry { track, file: format!("{id}.m4a"), size, last }
    }

    #[test]
    fn evicts_least_recently_played() {
        let dir = std::env::temp_dir().join("noxx-audiocache-test");
        let mut c = Cache { dir: dir.clone(), index_path: dir.join(INDEX), limit: 250, items: HashMap::new(), busy: HashSet::new(), queue: Vec::new(), running: false };
        for (id, size, last) in [("a", 100, 10), ("b", 100, 30), ("c", 100, 20)] {
            c.items.insert(id.into(), entry(id, size, last));
        }
        assert_eq!(c.evict(), 1);
        assert!(!c.items.contains_key("a"), "oldest goes first");
        assert!(c.items.contains_key("b") && c.items.contains_key("c"));
        c.limit = 100;
        assert_eq!(c.evict(), 1);
        assert!(c.items.contains_key("b"), "most recently played stays");
        assert_eq!(safe_name("yt:abc-_?x"), "yt_abc-__x");
    }
}
