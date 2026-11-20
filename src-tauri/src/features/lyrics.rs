//! Lyrics: synced (LRC) and plain lyrics from lrclib.net, the provider riff uses.
//!
//! SoundCloud titles are messy ("Artist - Song (Official Video) [free dl] prod. X"), so the
//! title is cleaned into a few (artist, title) candidates, lrclib is queried for all of them
//! at once, and the best record is picked by name plausibility and duration.
//!
//! Results (including "not found") are cached in memory and on disk under
//! `<data_dir>/lyrics/<key>.json`; user-written lyrics live in `<data_dir>/lyrics/custom/<key>.lrc`
//! and always win. Concurrent requests for the same track (prefetch + play) share one fetch.
//!
//! Commands (`riff.call('lyrics.<cmd>', args)`):
//!   get      {title, artist, duration, online?}  -> result
//!   prefetch {title, artist, duration}           -> {queued}
//!   save     {title, artist, duration, text}     -> result  (custom lyrics; empty text removes them)
//!   parse    {text}                              -> {synced, lines, plain}
//!   clean    {title, artist}                     -> {candidates:[{artist,title}]}
//!   clear_cache                                  -> {removed}
//!   stats                                        -> {files, bytes, memory}
//!
//! A result is `{found, synced, instrumental, custom, lines:[{t, text}], plain:[text], source,
//! matched:{artist,title,duration}|null, fetched}`.

use regex::Regex;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};
use tokio::sync::OnceCell;

const API: &str = "https://lrclib.net/api";
/// "Not found" results are retried after this long.
const NEGATIVE_TTL_SECS: u64 = 3 * 24 * 3600;

type Cell = Arc<OnceCell<Value>>;

fn memory() -> &'static Mutex<HashMap<String, Cell>> {
    static M: OnceLock<Mutex<HashMap<String, Cell>>> = OnceLock::new();
    M.get_or_init(Default::default)
}

fn http() -> &'static reqwest::Client {
    static C: OnceLock<reqwest::Client> = OnceLock::new();
    C.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent(concat!("noxx/", env!("CARGO_PKG_VERSION"), " (https://github.com/T4lk/noxx)"))
            .timeout(Duration::from_secs(8))
            .connect_timeout(Duration::from_secs(5))
            .gzip(true)
            .brotli(true)
            .build()
            .expect("lyrics http client")
    })
}

// ------------------------------------------------------------ translation (riff: /api/translate)

/// One Google Translate call (riff's endpoint and client fallbacks). Returns the text split on
/// newlines, or None when every client failed.
async fn translate_once(text: &str, to: &str) -> Option<Vec<String>> {
    for client in ["dict-chrome-ex", "gtx"] {
        let req = http()
            .get("https://translate.googleapis.com/translate_a/single")
            .query(&[("client", client), ("sl", "auto"), ("tl", to), ("dt", "t"), ("q", text)])
            .header("User-Agent", "Mozilla/5.0");
        let Ok(res) = req.send().await else { continue };
        if !res.status().is_success() {
            continue;
        }
        let Ok(v) = res.json::<Value>().await else { continue };
        if let Some(parts) = v.get(0).and_then(Value::as_array) {
            let joined: String = parts.iter().filter_map(|s| s.get(0).and_then(Value::as_str)).collect();
            return Some(joined.split('\n').map(str::to_string).collect());
        }
    }
    None
}

fn tr_cache() -> &'static Mutex<HashMap<String, Vec<String>>> {
    static C: OnceLock<Mutex<HashMap<String, Vec<String>>>> = OnceLock::new();
    C.get_or_init(Default::default)
}

/// Translate lyric lines, keeping one output per input line. Lines are sent in ~1800-char
/// chunks joined by newlines; a chunk whose line count comes back different is redone line by line.
pub async fn translate_lines(lines: &[String], to: &str) -> Vec<String> {
    use futures::StreamExt;
    if lines.is_empty() {
        return Vec::new();
    }
    let key = format!("{to}\u{1}{}", lines.join("\n"));
    if let Some(v) = tr_cache().lock().ok().and_then(|c| c.get(&key).cloned()) {
        return v;
    }
    let mut chunks: Vec<&[String]> = Vec::new();
    let (mut start, mut len) = (0usize, 0usize);
    for (i, l) in lines.iter().enumerate() {
        if i > start && len + l.len() + 1 > 1800 {
            chunks.push(&lines[start..i]);
            start = i;
            len = 0;
        }
        len += l.len() + 1;
    }
    chunks.push(&lines[start..]);
    let mut out = Vec::with_capacity(lines.len());
    let mut complete = true;
    for chunk in chunks {
        match translate_once(&chunk.join("\n"), to).await {
            Some(t) if t.len() == chunk.len() => out.extend(t),
            _ => {
                let singles: Vec<(String, bool)> = futures::stream::iter(chunk.iter().cloned())
                    .map(|line| async move {
                        if line.trim().is_empty() {
                            return (String::new(), true);
                        }
                        match translate_once(&line, to).await.and_then(|v| v.into_iter().next()) {
                            Some(t) => (t, true),
                            None => (line, false),
                        }
                    })
                    .buffered(4)
                    .collect()
                    .await;
                for (t, ok) in singles {
                    complete &= ok;
                    out.push(t);
                }
            }
        }
    }
    if complete {
        if let Ok(mut c) = tr_cache().lock() {
            if c.len() > 64 {
                c.clear();
            }
            c.insert(key, out.clone());
        }
    }
    out
}

fn re(cell: &'static OnceLock<Regex>, pat: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pat).expect("lyrics regex"))
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

// ------------------------------------------------------------------ command plumbing

pub fn setup(_app: &AppHandle) {}

pub async fn handle(app: &AppHandle, cmd: &str, args: Value) -> super::Out {
    let dir = lyrics_dir(app);
    match cmd {
        "get" => {
            let q = Query::from_args(&args);
            let online = args.get("online").and_then(Value::as_bool).unwrap_or(true);
            Ok(get(&dir, &q, online).await)
        }
        "prefetch" => {
            let q = Query::from_args(&args);
            if q.title.trim().is_empty() {
                return Ok(json!({ "queued": false }));
            }
            tauri::async_runtime::spawn(async move {
                let _ = get(&dir, &q, true).await;
            });
            Ok(json!({ "queued": true }))
        }
        "save" => {
            let q = Query::from_args(&args);
            let text = args.get("text").and_then(Value::as_str).unwrap_or("");
            save_custom(&dir, &q, text)?;
            Ok(get(&dir, &q, false).await)
        }
        "translate" => {
            let to = args.get("to").and_then(Value::as_str).unwrap_or("en").to_string();
            let lines: Vec<String> = args
                .get("lines")
                .and_then(Value::as_array)
                .map(|a| a.iter().map(|v| v.as_str().unwrap_or("").to_string()).collect())
                .unwrap_or_default();
            let out = translate_lines(&lines, &to).await;
            Ok(json!({ "translations": out }))
        }
        "parse" => {
            let text = args.get("text").and_then(Value::as_str).unwrap_or("");
            let p = parse_lrc(text);
            Ok(json!({ "synced": p.synced(), "lines": lines_json(&p.lines), "plain": p.plain }))
        }
        "clean" => {
            let title = args.get("title").and_then(Value::as_str).unwrap_or("");
            let artist = args.get("artist").and_then(Value::as_str).unwrap_or("");
            let c: Vec<Value> = candidates(title, artist).into_iter().map(|c| json!({ "artist": c.artist, "title": c.title })).collect();
            Ok(json!({ "candidates": c }))
        }
        "clear_cache" => {
            memory().lock().unwrap().clear();
            let mut removed = 0;
            if let Ok(rd) = std::fs::read_dir(&dir) {
                for e in rd.flatten() {
                    let p = e.path();
                    if p.extension().is_some_and(|x| x == "json") && std::fs::remove_file(&p).is_ok() {
                        removed += 1;
                    }
                }
            }
            Ok(json!({ "removed": removed }))
        }
        "stats" => {
            let (mut files, mut bytes) = (0u64, 0u64);
            if let Ok(rd) = std::fs::read_dir(&dir) {
                for e in rd.flatten() {
                    if e.path().extension().is_some_and(|x| x == "json") {
                        files += 1;
                        bytes += e.metadata().map(|m| m.len()).unwrap_or(0);
                    }
                }
            }
            let mem = memory().lock().unwrap().values().filter(|c| c.initialized()).count();
            Ok(json!({ "files": files, "bytes": bytes, "memory": mem }))
        }
        _ => Err(format!("lyrics: unknown command {cmd}")),
    }
}

fn lyrics_dir(app: &AppHandle) -> PathBuf {
    app.state::<crate::AppState>().data_dir.join("lyrics")
}

#[derive(Clone, Debug, Default)]
struct Query {
    title: String,
    artist: String,
    duration: f64,
}

impl Query {
    fn from_args(a: &Value) -> Self {
        let s = |k: &str| a.get(k).and_then(Value::as_str).unwrap_or("").to_string();
        Self { title: s("title"), artist: s("artist"), duration: a.get("duration").and_then(Value::as_f64).unwrap_or(0.0).max(0.0) }
    }

    /// Stable cache key (FNV-1a over the normalized names + whole-second duration).
    fn key(&self) -> String {
        let src = format!("{}\u{0}{}\u{0}{}", self.artist.trim().to_lowercase(), self.title.trim().to_lowercase(), self.duration.round() as i64);
        let mut h: u64 = 0xcbf29ce484222325;
        for b in src.as_bytes() {
            h ^= *b as u64;
            h = h.wrapping_mul(0x100000001b3);
        }
        format!("{h:016x}")
    }
}

// ------------------------------------------------------------------ cache + lookup

/// Bumped when matching rules change, so cached picks from the old rules are refetched.
const MATCH_VERSION: u64 = 2;

async fn get(dir: &Path, q: &Query, online: bool) -> Value {
    let key = q.key();
    if let Some(v) = read_custom(dir, &key) {
        return v;
    }
    let cell = {
        let mut m = memory().lock().unwrap();
        m.entry(key.clone()).or_default().clone()
    };
    if let Some(v) = cell.get() {
        return v.clone();
    }
    if !online {
        return read_disk(dir, &key).unwrap_or_else(|| not_found(false));
    }
    let res = cell
        .get_or_try_init(|| async {
            if let Some(v) = read_disk(dir, &key) {
                // Results from an older matcher are refetched (it may have picked the wrong song).
                let fresh = v["mv"].as_u64() == Some(MATCH_VERSION) && v["found"].as_bool().unwrap_or(false) || now_secs().saturating_sub(v["fetched"].as_u64().unwrap_or(0)) < NEGATIVE_TTL_SECS;
                if fresh {
                    return Ok(v);
                }
            }
            let mut v = fetch(q).await?;
            v["mv"] = json!(MATCH_VERSION);
            crate::soundcloud::write_json(&dir.join(format!("{key}.json")), &v);
            Ok::<Value, String>(v)
        })
        .await;
    match res {
        Ok(v) => v.clone(),
        // Network trouble: don't cache, the next play retries.
        Err(e) => {
            let mut v = not_found(false);
            v["error"] = json!(e);
            v
        }
    }
}

fn read_disk(dir: &Path, key: &str) -> Option<Value> {
    let b = std::fs::read(dir.join(format!("{key}.json"))).ok()?;
    serde_json::from_slice::<Value>(&b).ok().filter(|v| v.get("found").is_some())
}

fn custom_path(dir: &Path, key: &str) -> PathBuf {
    dir.join("custom").join(format!("{key}.lrc"))
}

fn read_custom(dir: &Path, key: &str) -> Option<Value> {
    let text = std::fs::read_to_string(custom_path(dir, key)).ok()?;
    let p = parse_lrc(&text);
    if p.lines.is_empty() && p.plain.is_empty() {
        return None;
    }
    let mut v = result_from(&p, "custom", None);
    v["custom"] = json!(true);
    Some(v)
}

fn save_custom(dir: &Path, q: &Query, text: &str) -> Result<(), String> {
    let path = custom_path(dir, &q.key());
    if text.trim().is_empty() {
        let _ = std::fs::remove_file(&path);
        return Ok(());
    }
    std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    std::fs::write(&path, text).map_err(|e| e.to_string())
}

fn not_found(instrumental: bool) -> Value {
    json!({ "found": false, "synced": false, "instrumental": instrumental, "custom": false,
            "lines": [], "plain": [], "source": "", "matched": null, "fetched": now_secs() })
}

fn lines_json(lines: &[Line]) -> Value {
    Value::Array(lines.iter().map(|l| json!({ "t": (l.t * 1000.0).round() / 1000.0, "text": l.text })).collect())
}

fn result_from(p: &Parsed, source: &str, matched: Option<Value>) -> Value {
    json!({
        "found": !p.lines.is_empty() || !p.plain.is_empty(),
        "synced": p.synced(),
        "instrumental": false,
        "custom": false,
        "lines": lines_json(&p.lines),
        "plain": p.plain,
        "source": source,
        "matched": matched,
        "fetched": now_secs(),
    })
}

// ------------------------------------------------------------------ lrclib

#[derive(Clone, Debug, Default, PartialEq)]
struct Record {
    artist: String,
    title: String,
    duration: f64,
    synced: String,
    plain: String,
    instrumental: bool,
    /// came from the exact /api/get endpoint
    exact: bool,
}

fn record_from(v: &Value, exact: bool) -> Option<Record> {
    let s = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let r = Record {
        artist: s("artistName"),
        title: s("trackName"),
        duration: v.get("duration").and_then(Value::as_f64).unwrap_or(0.0),
        synced: s("syncedLyrics"),
        plain: s("plainLyrics"),
        instrumental: v.get("instrumental").and_then(Value::as_bool).unwrap_or(false),
        exact,
    };
    (!r.title.is_empty()).then_some(r)
}

async fn lrclib(path: &str, params: Vec<(&'static str, String)>) -> Result<Value, String> {
    let resp = http().get(format!("{API}/{path}")).query(&params).send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    if status.as_u16() == 404 {
        return Ok(Value::Null);
    }
    if !status.is_success() {
        return Err(format!("lrclib {path}: HTTP {status}"));
    }
    resp.json::<Value>().await.map_err(|e| e.to_string())
}

async fn fetch(q: &Query) -> Result<Value, String> {
    let cands = candidates(&q.title, &q.artist);
    let Some(first) = cands.first().cloned() else {
        return Ok(not_found(false));
    };
    let dur = (q.duration > 0.0).then(|| q.duration.round().to_string());

    // All lookups at once: one round trip in the common case.
    let mut jobs: Vec<futures::future::BoxFuture<'static, (bool, Result<Value, String>)>> = Vec::new();
    for c in cands.iter().filter(|c| !c.artist.is_empty()).take(3) {
        let mut p = vec![("artist_name", c.artist.clone()), ("track_name", c.title.clone())];
        if let Some(d) = &dur {
            p.push(("duration", d.clone()));
        }
        jobs.push(Box::pin(async move { (true, lrclib("get", p).await) }));
    }
    let q_all = format!("{} {}", first.artist, first.title).trim().to_string();
    jobs.push(Box::pin(async move { (false, lrclib("search", vec![("q", q_all)]).await) }));
    let t_only = first.title.clone();
    jobs.push(Box::pin(async move { (false, lrclib("search", vec![("track_name", t_only)]).await) }));

    let mut records = Vec::new();
    let mut errors = 0;
    let total = jobs.len();
    for (exact, res) in futures::future::join_all(jobs).await {
        match res {
            Ok(Value::Array(items)) => records.extend(items.iter().filter_map(|v| record_from(v, false))),
            Ok(v @ Value::Object(_)) => records.extend(record_from(&v, exact)),
            Ok(_) => {}
            Err(_) => errors += 1,
        }
    }
    if errors == total {
        return Err("lyrics provider unreachable".into());
    }

    let tags = variant_tags(&q.title);
    let picked = if tags.is_empty() {
        pick_best(&records, &cands, q.duration).cloned()
    } else {
        // A remix/edit/sped-up cut: only accept lyrics filed under the same kind of version,
        // or a record whose length matches almost exactly. The original song's lyrics are wrong here.
        let same: Vec<Record> = records
            .iter()
            .filter(|r| {
                let rt = variant_tags(&r.title);
                tags.iter().any(|t| rt.contains(t))
                    || (q.duration > 0.0 && r.duration > 0.0 && (r.duration - q.duration).abs() <= 1.5)
            })
            .cloned()
            .collect();
        pick_best(&same, &cands, q.duration).cloned()
    };
    let Some(best) = picked else {
        return Ok(not_found(false));
    };
    if best.instrumental && best.synced.is_empty() && best.plain.is_empty() {
        return Ok(not_found(true));
    }
    let dd = if q.duration > 0.0 && best.duration > 0.0 { (best.duration - q.duration).abs() } else { 0.0 };
    // Timings from a very different cut (sped up, extended…) would be wrong: show plain text.
    let mut p = if dd <= 8.0 && !best.synced.trim().is_empty() { parse_lrc(&best.synced) } else { Parsed::default() };
    if p.lines.is_empty() {
        p = parse_lrc(if best.plain.trim().is_empty() { &best.synced } else { &best.plain });
        if !p.lines.is_empty() {
            p.plain = p.lines.drain(..).map(|l| l.text).filter(|t| !t.is_empty()).collect();
        }
    }
    let matched = json!({ "artist": best.artist, "title": best.title, "duration": best.duration });
    Ok(result_from(&p, "lrclib", Some(matched)))
}

/// Best record for the candidates, or None when nothing plausibly matches.
fn pick_best<'a>(records: &'a [Record], cands: &[Candidate], duration: f64) -> Option<&'a Record> {
    let mut best: Option<(f64, &Record)> = None;
    for r in records {
        let dd = (duration > 0.0 && r.duration > 0.0).then(|| (r.duration - duration).abs());
        let full = cands.iter().any(|c| plausible(r, c));
        let title_exact = cands.iter().any(|c| norm(&c.title) == norm(&r.title));
        let ok = (r.exact && dd.is_none_or(|d| d <= 3.0))
            || (full && dd.is_none_or(|d| d <= 20.0))
            || (title_exact && dd.is_some_and(|d| d <= 2.0));
        if !ok {
            continue;
        }
        let has_synced = !r.synced.trim().is_empty();
        let has_plain = has_synced || !r.plain.trim().is_empty();
        let mut score = 0.0;
        if has_synced && dd.is_none_or(|d| d <= 3.0) {
            score += 100.0;
        } else if has_synced && dd.is_some_and(|d| d <= 8.0) {
            score += 60.0;
        } else if has_plain {
            score += 40.0;
        } else {
            score += 5.0; // instrumental / empty record
        }
        if full {
            score += 30.0;
        }
        if r.exact {
            score += 10.0;
        }
        score -= dd.unwrap_or(0.0).min(20.0) * 2.0;
        if best.is_none_or(|(s, _)| score > s) {
            best = Some((score, r));
        }
    }
    best.map(|(_, r)| r)
}

// ------------------------------------------------------------------ title cleaning

/// Version markers in a title ("(Hardtekk)", "- Sped Up", "[VIP Edit]"…), lowercased and folded
/// so "sped up" / "speed up" and "hardtek" / "hardtekk" compare equal. Empty for the original cut.
fn variant_tags(title: &str) -> Vec<&'static str> {
    static TAG: OnceLock<Regex> = OnceLock::new();
    let t = fold_styled(title).to_lowercase();
    let mut out = Vec::new();
    for m in re(
        &TAG,
        r"\b(remix|rmx|edit|bootleg|flip|vip|mashup|mash-up|rework|refix|re-?mix|sped\s*up|speed\s*up|spedup|slowed|nightcore|hard\s*te(?:k|kk|ck)|tekk|hardstyle|hardcore|techno|phonk|jersey|drill|cover|bass\s*boost(?:ed)?|8d|reverb|daycore|extended|amapiano|house\s*mix|dnb|drum\s*(?:&|and|n)\s*bass)\b",
    )
    .find_iter(&t)
    {
        let w = m.as_str();
        let tag = match w {
            _ if w.starts_with("sped") || w.starts_with("speed") || w == "nightcore" => "speed",
            _ if w.starts_with("hard") && w.contains('t') && !w.contains("style") || w == "tekk" => "tekk",
            _ if w.contains("mix") || w == "rmx" || w == "rework" || w == "refix" || w == "flip" || w == "bootleg" || w == "vip" || w == "edit" => "remix",
            _ if w.starts_with("slowed") || w == "reverb" || w == "daycore" => "slowed",
            _ if w.starts_with("bass") => "bass",
            _ if w.starts_with("drum") || w == "dnb" => "dnb",
            "hardstyle" => "hardstyle",
            "hardcore" => "hardcore",
            "techno" => "techno",
            "phonk" => "phonk",
            "jersey" => "jersey",
            "drill" => "drill",
            "cover" => "cover",
            "8d" => "8d",
            "extended" => "extended",
            "amapiano" => "amapiano",
            _ => "remix",
        };
        if !out.contains(&tag) {
            out.push(tag);
        }
    }
    // "Original Mix" / "Radio Edit" are the song itself.
    if t.contains("original mix") || t.contains("radio edit") {
        out.retain(|x| *x != "remix");
    }
    out
}

#[derive(Clone, Debug, PartialEq)]
struct Candidate {
    artist: String,
    title: String,
}

/// Maps "styled" Unicode letters (𝐛𝐨𝐥𝐝, 𝘪𝘵𝘢𝘭𝘪𝘤, ｆｕｌｌｗｉｄｔｈ…) to plain ASCII, the part of NFKC that
/// matters for track titles.
fn fold_styled(s: &str) -> String {
    s.chars()
        .map(|c| {
            let u = c as u32;
            match u {
                0x1D400..=0x1D6A3 => {
                    let i = (u - 0x1D400) % 52;
                    char::from(if i < 26 { b'A' + i as u8 } else { b'a' + (i - 26) as u8 })
                }
                0x1D7CE..=0x1D7FF => char::from(b'0' + ((u - 0x1D7CE) % 10) as u8),
                0xFF01..=0xFF5E => char::from_u32(u - 0xFF01 + 0x21).unwrap_or(c),
                0x3000 => ' ',
                0x2018 | 0x2019 | 0x02BC => '\'',
                0x201C | 0x201D => '"',
                _ => c,
            }
        })
        .collect()
}

fn clean_title(s: &str) -> String {
    static BRACKETS: OnceLock<Regex> = OnceLock::new();
    static PROD: OnceLock<Regex> = OnceLock::new();
    static FEAT: OnceLock<Regex> = OnceLock::new();
    static JUNK: OnceLock<Regex> = OnceLock::new();
    static PIPE: OnceLock<Regex> = OnceLock::new();
    let mut s = fold_styled(s);
    s = re(&PIPE, r"\s*[|｜/]{1,2}\s.*$").replace(&s, "").into_owned();
    s = re(&BRACKETS, r"\[[^\]]*\]|\([^)]*\)|\{[^}]*\}|【[^】]*】|「[^」]*」|<[^>]*>").replace_all(&s, " ").into_owned();
    s = re(&PROD, r"(?i)(^|\s)[-~*]*\s*(prod\.|produced\b|prod\b)\s*(by\b|@)?.*$").replace(&s, "").into_owned();
    s = re(&FEAT, r"(?i)(^|\s)(feat|ft|featuring)\b\.?.*$").replace(&s, "").into_owned();
    s = re(
        &JUNK,
        r"(?i)\b(official\s*(music\s*)?(video|audio|visuali[sz]er|lyric\s*video)|music\s*video|lyric(s)?\s*video|lyrics?|visuali[sz]er|video\s*clip|clip\s*officiel|free\s*(dl|download)|out\s*now|hq|hd|4k|remaster(ed)?|explicit)\b|#\S+",
    )
    .replace_all(&s, " ")
    .into_owned();
    tidy(&s)
}

fn clean_artist(s: &str) -> String {
    static JUNK: OnceLock<Regex> = OnceLock::new();
    static BRACKETS: OnceLock<Regex> = OnceLock::new();
    let s = fold_styled(s);
    let s = re(&BRACKETS, r"\[[^\]]*\]|\([^)]*\)|【[^】]*】").replace_all(&s, " ");
    let s = re(&JUNK, r"(?i)\s*-\s*topic\b|\b(vevo|records|official)\b").replace_all(&s, " ");
    tidy(&s)
}

/// Drops emoji and symbol noise, keeps letters/digits and the punctuation lrclib names use.
fn tidy(s: &str) -> String {
    static NOISE: OnceLock<Regex> = OnceLock::new();
    static SPACE: OnceLock<Regex> = OnceLock::new();
    static EDGE: OnceLock<Regex> = OnceLock::new();
    let s = re(&NOISE, r"[^\p{L}\p{N}\p{M}\s'&.,!?$+-]").replace_all(s, " ");
    let s = re(&SPACE, r"\s+").replace_all(&s, " ");
    re(&EDGE, r"^[\s.,&+!?-]+|[\s,&+-]+$").replace_all(&s, "").trim().to_string()
}

fn bad_name(s: &str) -> bool {
    let l = s.to_lowercase();
    l.is_empty() || l == "untitled" || l == "unknown artist" || l == "unknown"
}

/// Splits "Artist - Title" uploads; returns (left, right).
fn split_dash(title: &str) -> Option<(String, String)> {
    static DASH: OnceLock<Regex> = OnceLock::new();
    let t = fold_styled(title);
    let m = re(&DASH, r"\s+[-–—~]+\s+").find(&t)?;
    let (l, r) = (t[..m.start()].trim(), t[m.end()..].trim());
    (!l.is_empty() && !r.is_empty()).then(|| (l.to_string(), r.to_string()))
}

/// First credited name of "A, B & C" / "A x B" / "A feat. B".
fn first_artist(s: &str) -> String {
    static SPLIT: OnceLock<Regex> = OnceLock::new();
    re(&SPLIT, r"(?i)\s*(,|&|\bx\b|\band\b|\bfeat\b\.?|\bft\b\.?|\bvs\b\.?)\s*").split(s).next().unwrap_or("").trim().to_string()
}

fn candidates(title: &str, uploader: &str) -> Vec<Candidate> {
    let mut out: Vec<Candidate> = Vec::new();
    let mut push = |artist: String, title: String| {
        if bad_name(&title) {
            return;
        }
        let artist = if bad_name(&artist) { String::new() } else { artist };
        let c = Candidate { artist, title };
        if !out.contains(&c) {
            out.push(c);
        }
    };
    let up = clean_artist(uploader);
    if let Some((l, r)) = split_dash(title) {
        let (a, t) = (clean_artist(&l), clean_title(&r));
        push(a.clone(), t.clone());
        let fa = first_artist(&a);
        if fa != a {
            push(fa, t.clone());
        }
        push(up.clone(), t);
        push(up, clean_title(title));
    } else {
        let t = clean_title(title);
        push(up.clone(), t.clone());
        let fa = first_artist(&up);
        if fa != up {
            push(fa, t);
        }
    }
    // Candidates without an artist go last (only the title-only search can use them).
    out.sort_by_key(|c| c.artist.is_empty());
    out
}

fn norm(s: &str) -> String {
    static BR: OnceLock<Regex> = OnceLock::new();
    static NA: OnceLock<Regex> = OnceLock::new();
    let s = fold_styled(s).to_lowercase().replace('&', " and ");
    let s = re(&BR, r"\[[^\]]*\]|\([^)]*\)|【[^】]*】").replace_all(&s, " ");
    re(&NA, r"[^\p{L}\p{N}]+").replace_all(&s, " ").trim().to_string()
}

fn contains_words(hay: &str, needle: &str) -> bool {
    format!(" {hay} ").contains(&format!(" {needle} "))
}

/// lrclib search is fuzzy; only accept records whose artist and title line up (riff's rule).
fn plausible(r: &Record, c: &Candidate) -> bool {
    let (wt, wa, gt, ga) = (norm(&c.title), norm(&c.artist), norm(&r.title), norm(&r.artist));
    if wt.is_empty() || wa.is_empty() || gt.is_empty() || ga.is_empty() {
        return false;
    }
    let artist_ok = ga == wa || contains_words(&ga, &wa) || contains_words(&wa, &ga);
    let title_ok = gt == wt || gt.starts_with(&format!("{wt} ")) || wt.starts_with(&format!("{gt} "));
    artist_ok && title_ok
}

// ------------------------------------------------------------------ LRC parsing

#[derive(Clone, Debug, PartialEq)]
struct Line {
    t: f64,
    text: String,
}

#[derive(Clone, Debug, Default)]
struct Parsed {
    lines: Vec<Line>,
    plain: Vec<String>,
}

impl Parsed {
    fn synced(&self) -> bool {
        !self.lines.is_empty()
    }
}

fn parse_lrc(text: &str) -> Parsed {
    static STAMPS: OnceLock<Regex> = OnceLock::new();
    static STAMP: OnceLock<Regex> = OnceLock::new();
    static META: OnceLock<Regex> = OnceLock::new();
    static WORD: OnceLock<Regex> = OnceLock::new();
    let stamps = re(&STAMPS, r"^\s*((?:\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]\s*)+)(.*)$");
    let stamp = re(&STAMP, r"\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]");
    let meta = re(&META, r"^\s*\[([a-zA-Z#]+):(.*)\]\s*$");
    let word = re(&WORD, r"<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>");

    let mut offset = 0.0;
    let mut timed: Vec<Line> = Vec::new();
    let mut plain: Vec<String> = Vec::new();
    for raw in text.lines() {
        let raw = raw.trim_end_matches('\r');
        if let Some(m) = stamps.captures(raw) {
            let body = word.replace_all(&m[2], "").split_whitespace().collect::<Vec<_>>().join(" ");
            for s in stamp.captures_iter(&m[1]) {
                let min: f64 = s[1].parse().unwrap_or(0.0);
                let sec: f64 = s[2].parse().unwrap_or(0.0);
                let frac = s.get(3).map(|f| format!("0.{}", f.as_str()).parse::<f64>().unwrap_or(0.0)).unwrap_or(0.0);
                timed.push(Line { t: min * 60.0 + sec + frac, text: body.clone() });
            }
        } else if let Some(m) = meta.captures(raw) {
            if m[1].eq_ignore_ascii_case("offset") {
                offset = m[2].trim().parse::<f64>().unwrap_or(0.0) / 1000.0;
            }
        } else {
            let line = word.replace_all(raw, "").trim().to_string();
            if line.is_empty() && plain.last().is_none_or(|l: &String| l.is_empty()) {
                continue; // collapse blank runs, no leading blanks
            }
            plain.push(line);
        }
    }
    while plain.last().is_some_and(|l| l.is_empty()) {
        plain.pop();
    }
    if timed.iter().any(|l| !l.text.is_empty()) {
        for l in &mut timed {
            l.t = (l.t - offset).max(0.0);
        }
        timed.sort_by(|a, b| a.t.total_cmp(&b.t));
        // Drop leading and repeated empty (instrumental) markers.
        let mut lines: Vec<Line> = Vec::with_capacity(timed.len());
        for l in timed {
            if l.text.is_empty() && lines.last().is_none_or(|p: &Line| p.text.is_empty()) {
                continue;
            }
            lines.push(l);
        }
        while lines.last().is_some_and(|l| l.text.is_empty()) {
            lines.pop();
        }
        // Untimed text in a synced file is noise (credits etc.).
        return Parsed { lines, plain: Vec::new() };
    }
    Parsed { lines: Vec::new(), plain }
}

// ------------------------------------------------------------------ tests

#[cfg(test)]
mod tests {
    use super::*;

    fn cand(a: &str, t: &str) -> Candidate {
        Candidate { artist: a.into(), title: t.into() }
    }

    #[test]
    fn cleans_soundcloud_titles() {
        assert_eq!(clean_title("Never Gonna Give You Up (Official Video) [HD]"), "Never Gonna Give You Up");
        assert_eq!(clean_title("Midnight Run [free dl]"), "Midnight Run");
        assert_eq!(clean_title("Midnight Run FREE DOWNLOAD"), "Midnight Run");
        assert_eq!(clean_title("Sunset prod. by someone"), "Sunset");
        assert_eq!(clean_title("Sunset (prod. Kenny)"), "Sunset");
        assert_eq!(clean_title("Sunset feat. Bob & Alice"), "Sunset");
        assert_eq!(clean_title("Lose Yourself | Official Music Video"), "Lose Yourself");
        assert_eq!(clean_title("Don’t Stop Me Now 🔥🔥 #rock"), "Don't Stop Me Now");
        assert_eq!(clean_title("Product Placement"), "Product Placement");
        assert_eq!(clean_title("Mr. Brightside"), "Mr. Brightside");
        assert_eq!(clean_title("𝐛𝐞𝐚𝐮𝐭𝐢𝐟𝐮𝐥 𝐭𝐡𝐢𝐧𝐠𝐬"), "beautiful things");
        assert_eq!(clean_title("ｈｅｌｌｏ"), "hello");
        assert_eq!(clean_artist("Rick Astley - Topic"), "Rick Astley");
        assert_eq!(clean_artist("RickAstleyVEVO"), "RickAstleyVEVO"); // word boundary keeps joined names
        assert_eq!(clean_artist("Queen Official"), "Queen");
    }

    #[test]
    fn builds_candidates() {
        let c = candidates("Daft Punk - Get Lucky (Official Audio) ft. Pharrell", "Some Repost Channel");
        assert_eq!(c[0], cand("Daft Punk", "Get Lucky"));
        assert!(c.contains(&cand("Some Repost Channel", "Get Lucky")));

        let c = candidates("Calvin Harris & Dua Lipa - One Kiss", "x");
        assert_eq!(c[0], cand("Calvin Harris & Dua Lipa", "One Kiss"));
        assert!(c.contains(&cand("Calvin Harris", "One Kiss")));

        let c = candidates("Blinding Lights", "The Weeknd");
        assert_eq!(c, vec![cand("The Weeknd", "Blinding Lights")]);

        // A hyphenated name is not an "Artist - Title" split.
        let c = candidates("Jay-Z Story", "Uploader");
        assert_eq!(c[0], cand("Uploader", "Jay-Z Story"));

        assert!(candidates("untitled", "unknown artist").is_empty());
        let c = candidates("Song", "unknown artist");
        assert_eq!(c, vec![cand("", "Song")]);
    }

    #[test]
    fn plausibility_matches_riff() {
        let r = Record { artist: "Daft Punk feat. Pharrell Williams".into(), title: "Get Lucky (Radio Edit)".into(), ..Default::default() };
        assert!(plausible(&r, &cand("Daft Punk", "Get Lucky")));
        assert!(!plausible(&r, &cand("Daft Punk", "Lose Yourself to Dance")));
        assert!(!plausible(&r, &cand("Daft", "Lucky Get")));
        assert!(!plausible(&r, &cand("Justice", "Get Lucky")));
        let r = Record { artist: "Simon & Garfunkel".into(), title: "The Boxer".into(), ..Default::default() };
        assert!(plausible(&r, &cand("Simon and Garfunkel", "The Boxer")));
    }

    #[test]
    fn picks_by_duration_and_sync() {
        let c = vec![cand("Artist", "Song")];
        let mk = |d: f64, synced: &str, plain: &str| Record {
            artist: "Artist".into(),
            title: "Song".into(),
            duration: d,
            synced: synced.into(),
            plain: plain.into(),
            ..Default::default()
        };
        let recs = vec![mk(200.0, "", "plain"), mk(181.0, "[00:01.00]x", ""), mk(240.0, "[00:01.00]y", "")];
        assert_eq!(pick_best(&recs, &c, 180.0).unwrap().duration, 181.0);
        assert_eq!(variant_tags("is that love (Hardtekk)"), vec!["tekk"]);
        assert_eq!(variant_tags("Song (Sped Up)"), variant_tags("song - speed up"));
        assert!(variant_tags("Song (Original Mix)").is_empty());
        assert!(variant_tags("Is That Love").is_empty());
        // Wrong names: rejected.
        let other = vec![Record { artist: "Else".into(), title: "Other".into(), duration: 180.0, plain: "x".into(), ..Default::default() }];
        assert!(pick_best(&other, &c, 180.0).is_none());
        // Same title, different uploader, duration within 2s: accepted; far off: rejected.
        let repost = vec![Record { artist: "Real Artist".into(), title: "Song".into(), duration: 181.0, plain: "x".into(), ..Default::default() }];
        assert!(pick_best(&repost, &[cand("Channel", "Song")], 180.0).is_some());
        assert!(pick_best(&repost, &[cand("Channel", "Song")], 200.0).is_none());
    }

    #[test]
    fn parses_lrc() {
        let p = parse_lrc("[ar:Someone]\n[offset:+500]\n[00:12.50]Hello <00:13.00>world\n[00:10.00][01:00.0]Chorus\n[00:20.00]\n[00:21.00]\n[00:25]Last\n");
        assert!(p.synced());
        let ts: Vec<f64> = p.lines.iter().map(|l| (l.t * 100.0).round() / 100.0).collect();
        assert_eq!(ts, vec![9.5, 12.0, 19.5, 24.5, 59.5]);
        assert_eq!(p.lines[1].text, "Hello world");
        assert_eq!(p.lines[2].text, ""); // one instrumental gap kept, the repeat dropped
        assert_eq!(p.lines[4].text, "Chorus");

        let p = parse_lrc("\n\nLine one\nLine two\n\n\n\nVerse two\n\n");
        assert!(!p.synced());
        assert_eq!(p.plain, vec!["Line one", "Line two", "", "Verse two"]);

        let p = parse_lrc("[00:01.123]Millis");
        assert!((p.lines[0].t - 1.123).abs() < 1e-9);
        assert!(parse_lrc("").lines.is_empty());
    }

    #[test]
    fn key_is_stable() {
        let q = Query { title: "Song".into(), artist: "Artist".into(), duration: 180.4 };
        let q2 = Query { title: " song ".into(), artist: "ARTIST".into(), duration: 179.6 };
        assert_eq!(q.key(), q2.key());
        assert_eq!(q.key().len(), 16);
    }

    #[test]
    #[ignore = "live network"]
    fn live_lrclib_lookup() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let q = Query { title: "Rick Astley - Never Gonna Give You Up (Official Video)".into(), artist: "RickAstleyVEVO".into(), duration: 213.0 };
        let v = rt.block_on(fetch(&q)).unwrap();
        assert!(v["found"].as_bool().unwrap(), "{v}");
        assert!(v["synced"].as_bool().unwrap(), "{v}");
    }

    #[test]
    #[ignore = "live network"]
    fn live_translate_keeps_line_count() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let lines: Vec<String> = ["Hello my friend", "", "Good morning"].iter().map(|s| s.to_string()).collect();
        let out = rt.block_on(translate_lines(&lines, "es"));
        assert_eq!(out.len(), 3, "{out:?}");
        assert_eq!(out[1], "", "{out:?}");
        assert!(out[0].to_lowercase().contains("amigo"), "{out:?}");
    }
}
