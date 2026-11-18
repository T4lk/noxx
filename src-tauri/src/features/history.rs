//! Play history: every track that actually starts playing, newest first.
//!
//! Kept in memory after the first use and saved as `history.json` in the app
//! data folder (written off the async worker with `spawn_blocking`).
//! Commands (JS: `riff.call('history.<cmd>', args)`):
//!   list   { limit? }        -> [entry]            entry = track fields + playedAt (ms)
//!   add    { track }         -> { added, count, playedAt }  a repeat of the newest entry only refreshes it
//!   remove { id, playedAt? } -> { removed }        one play, or every play of `id` without playedAt
//!   clear                    -> { cleared }
//!   top    { limit? }        -> [{ track, count, lastPlayed }]  most played first
//!   counts                   -> { id: count }

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::soundcloud::{write_json, Track};

pub const MAX_ENTRIES: usize = 1000;
const FILE: &str = "history.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Entry {
    #[serde(flatten)]
    pub track: Track,
    #[serde(rename = "playedAt", default)]
    pub played_at: u64,
}

#[derive(Debug, Default)]
pub struct History {
    pub entries: Vec<Entry>,
}

impl History {
    /// Records a play. A repeat of the newest entry only refreshes its time
    /// (and metadata). Returns true when a new entry was added.
    pub fn add(&mut self, track: Track, now: u64) -> bool {
        if let Some(top) = self.entries.first_mut() {
            if top.track.id == track.id {
                top.track = track;
                top.played_at = now;
                return false;
            }
        }
        self.entries.insert(0, Entry { track, played_at: now });
        self.entries.truncate(MAX_ENTRIES);
        true
    }

    /// Removes one play (matching `played_at`) or, without it, every play of `id`.
    pub fn remove(&mut self, id: &str, played_at: Option<u64>) -> usize {
        let before = self.entries.len();
        match played_at {
            Some(at) => {
                if let Some(pos) = self.entries.iter().position(|e| e.track.id == id && e.played_at == at) {
                    self.entries.remove(pos);
                }
            }
            None => self.entries.retain(|e| e.track.id != id),
        }
        before - self.entries.len()
    }

    pub fn counts(&self) -> HashMap<String, usize> {
        let mut m = HashMap::new();
        for e in &self.entries {
            *m.entry(e.track.id.clone()).or_insert(0) += 1;
        }
        m
    }

    /// Most played tracks with (count, last played); ties keep recency order.
    pub fn top(&self, limit: usize) -> Vec<(Track, usize, u64)> {
        let mut out: Vec<(Track, usize, u64)> = Vec::new();
        let mut index: HashMap<&str, usize> = HashMap::new();
        for e in &self.entries {
            match index.get(e.track.id.as_str()) {
                Some(&i) => out[i].1 += 1,
                None => {
                    index.insert(e.track.id.as_str(), out.len());
                    out.push((e.track.clone(), 1, e.played_at));
                }
            }
        }
        out.sort_by(|a, b| b.1.cmp(&a.1)); // stable
        out.truncate(limit);
        out
    }
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

struct Store {
    path: PathBuf,
    hist: Mutex<History>,
}

static STORE: OnceLock<Store> = OnceLock::new();

fn store(app: &AppHandle) -> &'static Store {
    STORE.get_or_init(|| {
        let path = app.state::<crate::AppState>().data_dir.join(FILE);
        let mut entries: Vec<Entry> = std::fs::read(&path)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        entries.truncate(MAX_ENTRIES);
        Store { path, hist: Mutex::new(History { entries }) }
    })
}

/// Serialises a snapshot and writes it on a blocking thread. Writes are
/// serialised by a lock so an older snapshot can never land after a newer one.
fn save(s: &'static Store) {
    static WRITE: Mutex<u64> = Mutex::new(0);
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let snapshot = s.hist.lock().map(|h| h.entries.clone()).unwrap_or_default();
    let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
    let path = s.path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let Ok(mut last) = WRITE.lock() else { return };
        if seq > *last {
            write_json(&path, &snapshot);
            *last = seq;
        }
    });
}

fn limit_arg(args: &Value, default: usize) -> usize {
    args.get("limit").and_then(Value::as_u64).map(|n| n as usize).unwrap_or(default).max(1)
}

pub fn setup(app: &AppHandle) {
    // Load the file in the background so the first `history.list` is instant.
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        store(&app);
    });
}

pub async fn handle(app: &AppHandle, cmd: &str, args: Value) -> super::Out {
    let s = store(app);
    match cmd {
        "list" => {
            let limit = limit_arg(&args, MAX_ENTRIES);
            let h = s.hist.lock().map_err(|e| e.to_string())?;
            let list: Vec<&Entry> = h.entries.iter().take(limit).collect();
            serde_json::to_value(list).map_err(|e| e.to_string())
        }
        "add" => {
            let track: Track = serde_json::from_value(args.get("track").cloned().unwrap_or(Value::Null))
                .map_err(|e| format!("history.add: bad track: {e}"))?;
            if track.id.is_empty() {
                return Err("history.add: track has no id".into());
            }
            let (added, count, played_at) = {
                let mut h = s.hist.lock().map_err(|e| e.to_string())?;
                let added = h.add(track, now_ms());
                (added, h.entries.len(), h.entries[0].played_at)
            };
            save(s);
            Ok(json!({ "added": added, "count": count, "playedAt": played_at }))
        }
        "remove" => {
            let id = args.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
            let at = args.get("playedAt").and_then(Value::as_u64);
            let removed = s.hist.lock().map_err(|e| e.to_string())?.remove(&id, at);
            if removed > 0 {
                save(s);
            }
            Ok(json!({ "removed": removed }))
        }
        "clear" => {
            s.hist.lock().map_err(|e| e.to_string())?.entries.clear();
            save(s);
            Ok(json!({ "cleared": true }))
        }
        "top" => {
            let limit = limit_arg(&args, 50);
            let h = s.hist.lock().map_err(|e| e.to_string())?;
            let out: Vec<Value> = h
                .top(limit)
                .into_iter()
                .map(|(t, c, at)| json!({ "track": t, "count": c, "lastPlayed": at }))
                .collect();
            Ok(Value::Array(out))
        }
        "counts" => {
            let h = s.hist.lock().map_err(|e| e.to_string())?;
            serde_json::to_value(h.counts()).map_err(|e| e.to_string())
        }
        _ => Err(format!("history: unknown command {cmd}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(id: &str) -> Track {
        serde_json::from_value(json!({ "id": id, "title": format!("T{id}"), "artist": "A", "duration": 100, "artwork": "", "url": "" })).unwrap()
    }

    #[test]
    fn newest_first_and_consecutive_dedupe() {
        let mut h = History::default();
        assert!(h.add(t("1"), 10));
        assert!(h.add(t("2"), 20));
        assert!(!h.add(t("2"), 30));
        assert!(h.add(t("1"), 40));
        let ids: Vec<&str> = h.entries.iter().map(|e| e.track.id.as_str()).collect();
        assert_eq!(ids, ["1", "2", "1"]);
        assert_eq!(h.entries[1].played_at, 30);
    }

    #[test]
    fn capped() {
        let mut h = History::default();
        for i in 0..(MAX_ENTRIES + 25) {
            h.add(t(&i.to_string()), i as u64);
        }
        assert_eq!(h.entries.len(), MAX_ENTRIES);
        assert_eq!(h.entries[0].track.id, (MAX_ENTRIES + 24).to_string());
    }

    #[test]
    fn top_and_counts() {
        let mut h = History::default();
        for (i, id) in ["a", "b", "a", "c", "a", "b"].iter().enumerate() {
            h.add(t(id), i as u64);
        }
        let top = h.top(10);
        let got: Vec<(&str, usize)> = top.iter().map(|(t, c, _)| (t.id.as_str(), *c)).collect();
        assert_eq!(got, [("a", 3), ("b", 2), ("c", 1)]);
        assert_eq!(top[1].2, 5); // b last played at 5
        assert_eq!(h.counts()["a"], 3);
        assert_eq!(h.top(1).len(), 1);
    }

    #[test]
    fn remove_one_or_all() {
        let mut h = History::default();
        h.add(t("a"), 1);
        h.add(t("b"), 2);
        h.add(t("a"), 3);
        assert_eq!(h.remove("a", Some(1)), 1);
        assert_eq!(h.entries.len(), 2);
        assert_eq!(h.remove("a", None), 1);
        assert_eq!(h.entries.len(), 1);
        assert_eq!(h.remove("zzz", None), 0);
    }

    #[test]
    fn entry_json_shape() {
        let e = Entry { track: t("9"), played_at: 7 };
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v["id"], "9");
        assert_eq!(v["playedAt"], 7);
        let back: Entry = serde_json::from_value(v).unwrap();
        assert_eq!(back.track.title, "T9");
    }
}
