//! Mixes: Spotify-style mixes made from what you like and play.
//!
//! Daily Mix 1-6 (taste clusters topped up with related tracks), genre mixes
//! ("Hardtekk Mix", "Hip Hop Mix"), era mixes ("2000s Mix"), artist mixes
//! ("<artist> Mix"), On Repeat and Repeat Rewind. The pure logic lives in
//! `mixes/engine.rs`; this file gathers the data (likes, history, SoundCloud
//! metadata, related tracks via discover's My Wave for SoundCloud seeds and YouTube
//! Music's radio for YouTube seeds) and caches the result.
//!
//! Years: SoundCloud's release_date / display_date / created_at; YouTube tracks get the
//! album year from YouTube Music, and SoundCloud tracks whose only year is the upload
//! date are looked up on YouTube Music too (the older year wins). Both are bounded per
//! build and cached forever in `youtube-years.json`.
//!
//! Commands (JS: `riff.call('mixes.<cmd>', args)`):
//! - `list` -> `{ builtAt, building, error, mixes: [summary], artists: [...] }` (cached, instant; starts a build when there is none)
//! - `get {id}` -> one mix with its tracks
//! - `refresh {wait?}` -> rebuild now (`wait: true` resolves with the new list)
//! - `sources {value?}` -> `{ value }`: where new songs come from, "both" (default) | "sc" | "yt".
//!   Setting it saves `mixes-sources.json` and rebuilds in the background. `list` reports it as `sources`.
//!
//! Sources: with "both", every plan with new songs (Daily, genre, artist) gets SoundCloud
//! and YouTube candidates, blended about half and half (at least 35% each, tilted by the
//! plan's own taste). A plan with no YouTube tracks of its own is seeded with the YouTube
//! Music twins of its best SoundCloud seeds (same title / artist, ±8 s, no edits; cached
//! by SoundCloud id in `youtube-years.json`). "sc" / "yt" take new songs from one platform only.
//!
//! Event `mixes:updated` `{ builtAt, count }` fires after each build.
//! The cache is `mixes.json` in the data folder. It is rebuilt in the background on
//! startup when older than 12 h, and when history / likes have changed a lot since.

mod engine;

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use futures::future::join_all;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::soundcloud::{artwork, collection, id_of, map_track, playable, str_of, unwrap_item, write_json, SoundCloud, Track};
use engine::{Item, Mix, Plan, Rejects, Sources, MAX_TRACKS};

const FILE: &str = "mixes.json";
const SOURCES_FILE: &str = "mixes-sources.json";
// 3: YouTube seeds top up with YouTube Music radio; YouTube Music years
// 4: new songs from SoundCloud and YouTube by default (YouTube Music twins of SoundCloud seeds)
// 5: every mix but On Repeat / Repeat Rewind fills to 50 with about half new songs; era mixes get new songs of their decade
// 6: one clear style per mix: sub-genre mixes (and Daily Mixes about one) only take new songs that
//    name the sub-genre; genre-less YouTube songs need an artist the mix knows; shorter mixes over off-genre filler
const VERSION: u32 = 6;
/// SoundCloud seeds per plan that get a YouTube Music twin (more are tried when some have none).
const TWIN_SEEDS: usize = 4;
const TWIN_TRIES: usize = 6;
/// Twin searches per build and how long they may take (found / missed twins are cached).
const TWIN_LOOKUPS: usize = 100;
/// Era top-ups: year lookups per era mix and platform, and how long each may take.
const ERA_LOOKUPS: usize = 120;
const ERA_BUDGET: Duration = Duration::from_secs(20);
/// Seeds whose related tracks / radios feed an era mix or a mix still under 50 tracks.
const MORE_SEEDS: usize = 10;
/// Artists whose other songs feed an era mix.
const ERA_ARTISTS: usize = 6;
const TWIN_BUDGET: Duration = Duration::from_secs(15);
/// Year lookups per build (highest weight first) and how long each kind may take.
const YEAR_LOOKUPS: usize = 200;
const YEAR_BUDGET: Duration = Duration::from_secs(15);
/// YouTube seeds whose radios feed one plan.
const YT_SEEDS: usize = 5;
const STALE_MS: u64 = 12 * 60 * 60 * 1000;
const CHECK_EVERY: Duration = Duration::from_secs(10 * 60);
const STARTUP_DELAY: Duration = Duration::from_secs(20);
/// "A lot" of change since the last build.
const NEW_PLAYS: usize = 30;
const LIKES_DELTA: usize = 10;

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
struct Meta {
    /// release year, 0 = unknown
    #[serde(default)]
    y: u16,
    #[serde(default = "yes")]
    ok: bool,
    /// the year is only the upload date
    #[serde(default)]
    up: bool,
}

fn yes() -> bool {
    true
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Cache {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    built_at: u64,
    #[serde(default)]
    took_ms: u64,
    #[serde(default)]
    likes_len: usize,
    #[serde(default)]
    likes_head: String,
    #[serde(default)]
    mixes: Vec<Mix>,
    #[serde(default)]
    artists: Vec<Value>,
    /// SoundCloud track id -> year / playable
    #[serde(default)]
    meta: HashMap<String, Meta>,
    /// The sources setting this build used ("both" | "sc" | "yt").
    #[serde(default)]
    sources: String,
}

static CACHE: Mutex<Option<Arc<Cache>>> = Mutex::new(None);
static BUILDING: AtomicBool = AtomicBool::new(false);
/// Set when the inputs changed during a build: the running build goes again.
static AGAIN: AtomicBool = AtomicBool::new(false);
static LAST_ERROR: Mutex<String> = Mutex::new(String::new());
static SOURCES: Mutex<Option<Sources>> = Mutex::new(None);

#[derive(Serialize, Deserialize)]
struct SourcesFile {
    value: String,
}

/// The sources setting (read from `mixes-sources.json` once; "both" when missing).
fn sources(app: &AppHandle) -> Sources {
    let mut slot = SOURCES.lock().unwrap();
    if let Some(s) = *slot {
        return s;
    }
    let path = app.state::<crate::AppState>().data_dir.join(SOURCES_FILE);
    let s = std::fs::read(path)
        .ok()
        .and_then(|b| serde_json::from_slice::<SourcesFile>(&b).ok())
        .and_then(|f| Sources::parse(&f.value))
        .unwrap_or_default();
    *slot = Some(s);
    s
}

fn set_sources(app: &AppHandle, s: Sources) -> Result<(), String> {
    let path = app.state::<crate::AppState>().data_dir.join(SOURCES_FILE);
    let bytes = serde_json::to_vec(&SourcesFile { value: s.as_str().into() }).map_err(|e| e.to_string())?;
    std::fs::write(&path, bytes).map_err(|e| format!("mixes: saving {SOURCES_FILE}: {e}"))?;
    *SOURCES.lock().unwrap() = Some(s);
    Ok(())
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn data_path(app: &AppHandle) -> std::path::PathBuf {
    app.state::<crate::AppState>().data_dir.join(FILE)
}

/// The cache in memory, reading `mixes.json` the first time.
fn cache(app: &AppHandle) -> Option<Arc<Cache>> {
    let mut slot = CACHE.lock().unwrap();
    if slot.is_none() {
        let read: Option<Cache> = std::fs::read(data_path(app)).ok().and_then(|b| serde_json::from_slice(&b).ok());
        if let Some(mut c) = read {
            if c.version != VERSION {
                // An older build: show it until the new one is ready (built_at 0 = rebuild now).
                c.version = VERSION;
                c.built_at = 0;
            }
            *slot = Some(Arc::new(c));
        }
    }
    slot.clone()
}

async fn cache_async(app: &AppHandle) -> Option<Arc<Cache>> {
    let hit = CACHE.lock().unwrap().clone();
    if hit.is_some() {
        return hit;
    }
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || cache(&app)).await.ok().flatten()
}

pub fn setup(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(STARTUP_DELAY).await;
        loop {
            if let Some(why) = needs_rebuild(&app).await {
                log(&format!("rebuilding ({why})"));
                let _ = run_build(&app).await;
            }
            tokio::time::sleep(CHECK_EVERY).await;
        }
    });
}

fn log(msg: &str) {
    eprintln!("[mixes] {msg}");
}

pub async fn handle(app: &AppHandle, cmd: &str, args: Value) -> super::Out {
    match cmd {
        "list" => {
            let c = cache_async(app).await;
            if c.is_none() && !BUILDING.load(Ordering::SeqCst) {
                spawn_build(app);
            }
            Ok(list_json(c.as_deref(), sources(app)))
        }
        "sources" => {
            let Some(raw) = args["value"].as_str() else { return Ok(json!({ "value": sources(app).as_str() })) };
            let s = Sources::parse(raw).ok_or_else(|| format!("mixes: unknown sources {raw:?} (both, sc or yt)"))?;
            if s != sources(app) {
                set_sources(app, s)?;
                log(&format!("sources -> {}, rebuilding", s.as_str()));
                AGAIN.store(true, Ordering::SeqCst);
                spawn_build(app);
            }
            Ok(json!({ "value": s.as_str() }))
        }
        "get" => {
            let id = args["id"].as_str().unwrap_or_default().to_string();
            let c = cache_async(app).await.ok_or("Mixes aren't ready yet")?;
            let m = c.mixes.iter().find(|m| m.id == id).ok_or_else(|| format!("No mix called {id}"))?;
            serde_json::to_value(m).map_err(|e| e.to_string())
        }
        "refresh" => {
            if args["wait"].as_bool().unwrap_or(false) {
                run_build(app).await?;
                Ok(list_json(cache_async(app).await.as_deref(), sources(app)))
            } else {
                spawn_build(app);
                Ok(json!({ "started": true }))
            }
        }
        _ => Err(format!("mixes: unknown command {cmd}")),
    }
}

fn summary(m: &Mix) -> Value {
    let mut v = serde_json::to_value(m).unwrap_or(Value::Null);
    if let Value::Object(o) = &mut v {
        o.remove("tracks");
        o.insert("trackCount".into(), json!(m.tracks.len()));
        o.insert("duration".into(), json!(m.tracks.iter().map(|t| t.duration).sum::<u64>()));
    }
    v
}

fn list_json(c: Option<&Cache>, src: Sources) -> Value {
    let error = LAST_ERROR.lock().unwrap().clone();
    let building = BUILDING.load(Ordering::SeqCst);
    match c {
        Some(c) => json!({
            "builtAt": c.built_at,
            "tookMs": c.took_ms,
            "building": building,
            "error": error,
            "sources": src.as_str(),
            "mixes": c.mixes.iter().map(summary).collect::<Vec<_>>(),
            "artists": c.artists,
        }),
        None => json!({ "builtAt": 0, "building": building, "error": error, "sources": src.as_str(), "mixes": [], "artists": [] }),
    }
}

fn spawn_build(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = run_build(&app).await;
    });
}

/// One build at a time; a second caller waits for the running one.
async fn run_build(app: &AppHandle) -> Result<(), String> {
    if BUILDING.swap(true, Ordering::SeqCst) {
        let start = Instant::now();
        while BUILDING.load(Ordering::SeqCst) && start.elapsed() < Duration::from_secs(180) {
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        return Ok(());
    }
    let t0 = Instant::now();
    let res = loop {
        AGAIN.store(false, Ordering::SeqCst);
        let r = build(app).await;
        if !AGAIN.load(Ordering::SeqCst) {
            break r;
        }
        log("settings changed during the build, building again");
    };
    match res {
        Ok(mut c) => {
            c.took_ms = t0.elapsed().as_millis() as u64;
            let count = c.mixes.len();
            let built_at = c.built_at;
            log(&format!("built {count} mixes in {} ms", c.took_ms));
            let path = data_path(app);
            let c = Arc::new(c);
            *CACHE.lock().unwrap() = Some(c.clone());
            LAST_ERROR.lock().unwrap().clear();
            let _ = tauri::async_runtime::spawn_blocking(move || write_json(&path, &*c)).await;
            BUILDING.store(false, Ordering::SeqCst);
            let _ = app.emit("mixes:updated", json!({ "builtAt": built_at, "count": count }));
            Ok(())
        }
        Err(e) => {
            log(&format!("build failed: {e}"));
            *LAST_ERROR.lock().unwrap() = e.clone();
            BUILDING.store(false, Ordering::SeqCst);
            let _ = app.emit("mixes:updated", json!({ "error": e }));
            Err(e)
        }
    }
}

// ------------------------------------------------------------------
// inputs
// ------------------------------------------------------------------

fn likes(app: &AppHandle) -> Vec<Track> {
    app.state::<crate::AppState>().lib.lock().map(|l| l.data.favorites.clone()).unwrap_or_default()
}

/// The user's own playlists (imports from Spotify / Apple Music included): (name, tracks).
fn playlists(app: &AppHandle) -> Vec<(String, Vec<Track>)> {
    app.state::<crate::AppState>()
        .lib
        .lock()
        .map(|l| l.data.playlists.iter().map(|p| (p.name.clone(), p.tracks.clone())).collect())
        .unwrap_or_default()
}

/// Track id -> playlist names it is saved in.
fn playlist_names(lists: &[(String, Vec<Track>)]) -> HashMap<String, Vec<String>> {
    let mut m: HashMap<String, Vec<String>> = HashMap::new();
    for (name, tracks) in lists {
        for t in tracks {
            let v = m.entry(t.id.clone()).or_default();
            if !v.contains(name) {
                v.push(name.clone());
            }
        }
    }
    m
}

/// Play history, newest first: (track, played_at).
async fn history(app: &AppHandle) -> Vec<(Track, u64)> {
    let list = super::history::handle(app, "list", json!({ "limit": super::history::MAX_ENTRIES })).await.unwrap_or(Value::Null);
    serde_json::from_value::<Vec<super::history::Entry>>(list)
        .map(|v| v.into_iter().map(|e| (e.track, e.played_at)).collect())
        .unwrap_or_default()
}

/// Why the cache needs a rebuild, or None.
async fn needs_rebuild(app: &AppHandle) -> Option<String> {
    let Some(c) = cache_async(app).await else { return Some("no mixes yet".into()) };
    let now = now_ms();
    if now.saturating_sub(c.built_at) > STALE_MS {
        return Some("older than 12 h".into());
    }
    if c.sources != sources(app).as_str() {
        return Some("sources changed".into());
    }
    let plays = history(app).await.iter().filter(|(_, at)| *at > c.built_at).count();
    if plays >= NEW_PLAYS {
        return Some(format!("{plays} new plays"));
    }
    let l = likes(app);
    let delta = l.len().abs_diff(c.likes_len);
    if delta >= LIKES_DELTA || likes_moved(&l, &c.likes_head) >= LIKES_DELTA {
        return Some("likes changed".into());
    }
    None
}

/// How many likes were added in front of the old newest like.
fn likes_moved(likes: &[Track], old_head: &str) -> usize {
    if old_head.is_empty() {
        return likes.len();
    }
    likes.iter().position(|t| t.id == old_head).unwrap_or(likes.len())
}

/// Genre families of a piece of text, via discover's style logic.
async fn families(app: &AppHandle, text: &str) -> Vec<String> {
    if text.trim().is_empty() {
        return Vec::new();
    }
    let v = super::discover::handle(app, "style", json!({ "text": text })).await.unwrap_or(Value::Null);
    let mut f: Vec<String> = v["families"].as_object().map(|o| o.keys().cloned().collect()).unwrap_or_default();
    f.sort_by_key(|x| engine::family_rank(x));
    f
}

fn style_text(t: &Track) -> String {
    if t.style.trim().is_empty() {
        format!("{} {}", t.title, t.genre)
    } else {
        t.style.clone()
    }
}

/// Fresh SoundCloud data for the user's tracks (50 ids per request): year and
/// playability, plus a re-mapped Track. Ids missing from an answered batch are
/// deleted / private. `answered` holds every id whose batch came back.
async fn fetch_meta(sc: &SoundCloud, ids: &[String]) -> (HashMap<String, (Meta, Track)>, HashSet<String>) {
    let batches: Vec<Vec<String>> = ids.chunks(50).map(|c| c.to_vec()).collect();
    let mut results: Vec<(Vec<String>, Option<Value>)> = Vec::new();
    for group in batches.chunks(4) {
        let answers = join_all(group.iter().map(|b| async move { sc.api("/tracks", &[("ids", b.join(","))]).await.ok() })).await;
        results.extend(group.iter().cloned().zip(answers));
    }
    let mut out = HashMap::new();
    let mut answered = HashSet::new();
    for (b, r) in results {
        let Some(Value::Array(list)) = r else { continue };
        answered.extend(b);
        for raw in list {
            let Some(id) = id_of(&raw) else { continue };
            let meta = Meta { y: engine::year_of(&raw).unwrap_or(0), ok: playable(&raw), up: engine::upload_year_only(&raw) };
            out.insert(id, (meta, map_track(&raw)));
        }
    }
    (out, answered)
}

/// Genre families of a track's text plus whether it is an edit / not a song (discover's style).
async fn style_of(app: &AppHandle, text: &str) -> (Vec<String>, bool) {
    if text.trim().is_empty() {
        return (Vec::new(), false);
    }
    let v = super::discover::handle(app, "style", json!({ "text": text })).await.unwrap_or(Value::Null);
    let mut f: Vec<String> = v["families"].as_object().map(|o| o.keys().cloned().collect()).unwrap_or_default();
    f.sort_by_key(|x| engine::family_rank(x));
    (f, v["edit"].as_bool().unwrap_or(false) || v["notASong"].as_bool().unwrap_or(false))
}

/// What top-ups must not repeat: the user's own track ids and songs.
struct Known {
    ids: Vec<String>,
    set: HashSet<String>,
    songs: HashSet<String>,
}

impl Known {
    fn of(items: &[Item]) -> Known {
        let ids: Vec<String> = items.iter().map(|it| it.track.id.clone()).collect();
        Known { set: ids.iter().cloned().collect(), songs: items.iter().flat_map(|it| engine::song_keys(&it.track)).collect(), ids }
    }
}

/// Twin lookup items (SoundCloud id, title, artist, length) for the plans that would get
/// twin seeds: the best non-edit SoundCloud seeds of plans with no YouTube seeds, in plan order.
async fn twin_requests(app: &AppHandle, items: &[Item], plans: &[Plan], src: Sources) -> Vec<(String, String, String, u64)> {
    if src == Sources::Sc {
        return Vec::new();
    }
    let by_id: HashMap<&str, &Track> = items.iter().map(|it| (it.track.id.as_str(), &it.track)).collect();
    let mut out: Vec<(String, String, String, u64)> = Vec::new();
    let mut edit: HashMap<String, bool> = HashMap::new();
    for p in plans.iter().filter(|p| p.yt_seeds.len() < TWIN_SEEDS) {
        let mut n = 0;
        for (id, _) in &p.seeds {
            if n >= TWIN_TRIES {
                break;
            }
            let Some(t) = by_id.get(id.as_str()) else { continue };
            let junk = match edit.get(id) {
                Some(&j) => j,
                None => {
                    let j = style_of(app, &t.title).await.1;
                    edit.insert(id.clone(), j);
                    j
                }
            };
            if junk {
                continue;
            }
            n += 1;
            if !out.iter().any(|(k, ..)| k == id) {
                out.push((id.clone(), t.title.clone(), t.artist.clone(), t.duration));
            }
        }
    }
    out
}

/// Twin seeds per style (`engine::style_key`: "harddance", "harddance/hardtekk"), from every
/// plan's SoundCloud seeds (heaviest first): a plan whose own seeds have no twin borrows
/// those of its style, so it still gets YouTube songs of its genre. A sub-genre plan only
/// borrows from plans about the same sub-genre; a family plan from any plan of the family.
fn family_twins(plans: &[Plan], twins: &HashMap<String, String>) -> HashMap<String, Vec<(String, f64)>> {
    let mut m: HashMap<String, Vec<(String, f64)>> = HashMap::new();
    for p in plans {
        let Some(f) = &p.family else { continue };
        let mut keys = vec![f.clone()];
        if let Some(s) = &p.sub {
            keys.push(engine::style_key(Some(f), Some(s)));
        }
        for key in keys {
            let list = m.entry(key).or_default();
            for (id, w) in &p.seeds {
                if let Some(v) = twins.get(id) {
                    let v = format!("yt:{v}");
                    if !list.iter().any(|(s, _)| *s == v) {
                        list.push((v, *w));
                    }
                }
            }
        }
    }
    for list in m.values_mut() {
        list.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    }
    m
}

/// The plan as topped up: with "both" / "yt", a plan with fewer than `TWIN_SEEDS` YouTube
/// seeds of its own gets the YouTube Music twins of its best SoundCloud seeds added; one
/// left with none borrows its genre family's twins (`family_twins`).
fn with_twins(p: &Plan, twins: &HashMap<String, String>, fam: &HashMap<String, Vec<(String, f64)>>, src: Sources) -> Plan {
    let mut p = p.clone();
    if src != Sources::Sc && p.yt_seeds.len() < TWIN_SEEDS && !p.seeds.is_empty() {
        let want = TWIN_SEEDS - p.yt_seeds.len();
        let add: Vec<(String, f64)> = p
            .seeds
            .iter()
            .filter_map(|(id, w)| twins.get(id).map(|v| (format!("yt:{v}"), *w)))
            .filter(|(v, _)| !p.yt_seeds.iter().any(|(s, _)| s == v))
            .take(want)
            .collect();
        p.yt_seeds.extend(add);
        if p.yt_seeds.is_empty() {
            if let Some(list) = p.family.as_ref().and_then(|f| fam.get(&engine::style_key(Some(f), p.sub.as_deref()))) {
                p.yt_seeds = list.iter().take(TWIN_SEEDS).cloned().collect();
            }
        }
    }
    p
}

/// YouTube Music radios of a plan's best YouTube seeds, merged: (track, seeds it is related to).
async fn yt_related(plan: &Plan, known: &Known, limit: usize) -> Vec<(Track, usize)> {
    yt_radios(plan, known, limit, YT_SEEDS).await
}

/// `yt_related` over the best `seeds` YouTube seeds.
async fn yt_radios(plan: &Plan, known: &Known, limit: usize, seeds: usize) -> Vec<(Track, usize)> {
    if plan.yt_seeds.is_empty() || limit == 0 {
        return Vec::new();
    }
    let yt = super::youtube::Yt::global();
    let lists: Vec<(f64, Vec<Track>)> = join_all(plan.yt_seeds.iter().take(seeds).map(|(id, w)| async move {
        match yt.related(id, 50).await {
            Ok(list) => (*w, list),
            Err(e) => {
                log(&format!("youtube radio {id}: {e}"));
                (*w, Vec::new())
            }
        }
    }))
    .await;
    engine::rank_related(&lists, &known.set, &known.songs, limit)
}

/// New songs for a plan: SoundCloud related tracks (discover's My Wave) for its SoundCloud
/// seeds and YouTube Music radio for its YouTube seeds (twins included, see `with_twins`),
/// each checked by `engine::admit` (family, sub-genre, known artist), then blended by
/// `engine::new_share`: about half and half with "both", one platform only with "sc" / "yt".
/// Also returns how many candidates the genre check dropped.
async fn top_up(app: &AppHandle, plan: &Plan, known: &Known, src: Sources) -> (Vec<(Track, Vec<String>)>, Rejects) {
    let has_sc = !plan.seeds.is_empty() && src != Sources::Yt;
    let has_yt = !plan.yt_seeds.is_empty() && src != Sources::Sc;
    let share = match (has_sc, has_yt) {
        (false, false) => return (Vec::new(), Rejects::default()),
        (true, false) => 0.0,
        (false, true) => 1.0,
        _ => engine::new_share(src, plan.yt_share),
    };
    // Daily Mixes are mostly new songs, so they need a bigger pool (some get dropped by the genre filter).
    let limit = if plan.kind == "daily" { 70 } else { 60 };

    let sc = async {
        let mut r = Rejects::default();
        if !has_sc || share > 0.9 {
            return (Vec::new(), r);
        }
        let seeds: Vec<Value> = plan.seeds.iter().map(|(id, w)| json!({ "id": id, "weight": w })).collect();
        let v = super::discover::handle(app, "wave", json!({ "seeds": seeds, "heard": known.ids, "limit": limit })).await;
        let list: Vec<Track> = v.ok().and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default();
        let mut out = Vec::with_capacity(list.len());
        for t in list {
            let f = families(app, &style_text(&t)).await;
            if let Some(f) = engine::admit_counted(plan, &t, f, &mut r) {
                out.push((t, f));
            }
        }
        (out, r)
    };
    let yt = async {
        let mut r = Rejects::default();
        if !has_yt || share < 0.1 {
            return (Vec::new(), r);
        }
        let mut out = Vec::new();
        // YouTube Music has no genres, so more candidates fall to the genre check: rank twice as many
        // (the radios are fetched anyway).
        for (t, _) in yt_related(plan, known, limit * 2).await {
            let (f, junk) = style_of(app, &style_text(&t)).await;
            if junk {
                continue;
            }
            if let Some(f) = engine::admit_counted(plan, &t, f, &mut r) {
                out.push((t, f));
            }
        }
        (out, r)
    };
    let ((sc, mut r), (yt, ry)) = futures::join!(sc, yt);
    r.add(ry);
    (engine::blend(sc, yt, share), r)
}

/// The YouTube share of a plan's new songs when one side may have nothing.
fn side_share(plan: &Plan, src: Sources, has_sc: bool, has_yt: bool) -> f64 {
    match (has_sc, has_yt) {
        (true, false) => 0.0,
        (false, true) => 1.0,
        _ => engine::new_share(src, plan.yt_share),
    }
}

/// More new songs for a mix still under 50 tracks: SoundCloud related tracks of up to
/// `MORE_SEEDS` SoundCloud seeds and YouTube Music radios of as many YouTube seeds, with the
/// same genre checks as `top_up` (`style` = discover's style: families, is an edit).
async fn more_related<S, F>(sc: &SoundCloud, plan: &Plan, known: &Known, src: Sources, limit: usize, style: S) -> (Vec<(Track, Vec<String>)>, Rejects)
where
    S: Fn(String) -> F,
    F: std::future::Future<Output = (Vec<String>, bool)>,
{
    let has_sc = !plan.seeds.is_empty() && src != Sources::Yt;
    let has_yt = !plan.yt_seeds.is_empty() && src != Sources::Sc;
    if !has_sc && !has_yt {
        return (Vec::new(), Rejects::default());
    }
    let sc_side = async {
        let mut r = Rejects::default();
        if !has_sc {
            return (Vec::new(), r);
        }
        let lists: Vec<(f64, Vec<Track>)> = join_all(plan.seeds.iter().take(MORE_SEEDS).map(|(id, w)| async move {
            let v = sc.api(&format!("/tracks/{id}/related"), &[("limit", "50".to_string())]).await.unwrap_or(Value::Null);
            (*w, sc_rows(&v).into_iter().map(|(t, ..)| t).collect::<Vec<Track>>())
        }))
        .await;
        let mut out = Vec::new();
        for (t, _) in engine::rank_related(&lists, &known.set, &known.songs, limit * 2) {
            let (f, junk) = style(style_text(&t)).await;
            if junk {
                continue;
            }
            if let Some(f) = engine::admit_counted(plan, &t, f, &mut r) {
                out.push((t, f));
            }
        }
        (out, r)
    };
    let yt_side = async {
        let mut r = Rejects::default();
        if !has_yt {
            return (Vec::new(), r);
        }
        let mut out = Vec::new();
        for (t, _) in yt_radios(plan, known, limit * 2, MORE_SEEDS).await {
            let (f, junk) = style(style_text(&t)).await;
            if junk {
                continue;
            }
            if let Some(f) = engine::admit_counted(plan, &t, f, &mut r) {
                out.push((t, f));
            }
        }
        (out, r)
    };
    let ((a, mut r), (b, rb)) = futures::join!(sc_side, yt_side);
    r.add(rb);
    let share = side_share(plan, src, !a.is_empty(), !b.is_empty());
    (engine::blend(a, b, share), r)
}

/// Playable SoundCloud tracks of an API answer: (track, year, year is only the upload date).
fn sc_rows(v: &Value) -> Vec<(Track, Option<u16>, bool)> {
    collection(v)
        .iter()
        .map(|r| unwrap_item(r, "track"))
        .filter(|r| playable(r))
        .map(|r| (map_track(r), engine::year_of(r), engine::upload_year_only(r)))
        .collect()
}

/// Lists taken in turns (first item of each, then the second ...).
fn round_robin<T>(lists: Vec<Vec<T>>) -> Vec<T> {
    let mut its: Vec<_> = lists.into_iter().map(|l| l.into_iter()).collect();
    let mut out = Vec::new();
    loop {
        let before = out.len();
        for it in its.iter_mut() {
            out.extend(it.next());
        }
        if out.len() == before {
            return out;
        }
    }
}

/// An era top-up candidate: (track, SoundCloud year, upload-date-only, families).
type EraCand = (Track, Option<u16>, bool, Vec<String>);

/// New songs for an era mix, all from its decade, one platform at a time: (a) related tracks /
/// YouTube Music radio of its own tracks, (b) other songs by its artists, (c) "<decade> <genre>"
/// searches in the user's top genres of that decade (`fams`). Every candidate's year is checked:
/// SoundCloud dates, YouTube Music album years for YouTube songs and for SoundCloud songs dated
/// only by their upload (cached, at most `ERA_LOOKUPS` new lookups / `ERA_BUDGET` per platform).
/// Candidates with a genre must be in one of the decade's families (`engine::admit`).
#[allow(clippy::too_many_arguments)]
async fn era_top_up<S, F>(sc: &SoundCloud, dir: &std::path::Path, plan: &Plan, fams: &[String], known: &Known, src: Sources, style: S) -> (Vec<(Track, Vec<String>)>, Rejects)
where
    S: Fn(String) -> F,
    F: std::future::Future<Output = (Vec<String>, bool)>,
{
    let decade = plan.decade;
    let queries = engine::era_queries(decade, fams);
    let need = MAX_TRACKS.saturating_sub(plan.own.len().min(plan.max_own));
    // Plenty of spares: some fall to dedupe / per-artist caps in `finish`.
    let want = need + 10;
    let mut uids: Vec<String> = Vec::new();
    let mut names: Vec<String> = Vec::new();
    for t in &plan.own {
        if engine::is_sc(t) && !t.artist_id.is_empty() && !uids.contains(&t.artist_id) && uids.len() < ERA_ARTISTS {
            uids.push(t.artist_id.clone());
        }
        let n = engine::name_key(&t.artist);
        if !n.is_empty() && n != "unknown artist" && !names.contains(&n) && names.len() < ERA_ARTISTS {
            names.push(n);
        }
    }
    let rank = |lists: Vec<(f64, Vec<Track>)>| -> Vec<Track> {
        engine::rank_related(&lists, &known.set, &known.songs, 300).into_iter().map(|(t, _)| t).collect()
    };

    let sc_side = async {
        if src == Sources::Yt {
            return Vec::new();
        }
        let get = |path: String, params: Vec<(&'static str, String)>, w: f64| async move {
            let v = sc.api(&path, &params).await.unwrap_or(Value::Null);
            (w, sc_rows(&v))
        };
        let lim = || ("limit", "50".to_string());
        let (rel, by, found) = futures::join!(
            join_all(plan.seeds.iter().take(MORE_SEEDS).map(|(id, w)| get(format!("/tracks/{id}/related"), vec![lim()], *w))),
            join_all(uids.iter().map(|u| get(format!("/users/{u}/tracks"), vec![lim()], 1.0))),
            join_all(queries.iter().map(|q| get("/search/tracks".into(), vec![("q", q.clone()), lim()], 1.0))),
        );
        let mut info: HashMap<String, (Option<u16>, bool)> = HashMap::new();
        let mut strip = |groups: Vec<(f64, Vec<(Track, Option<u16>, bool)>)>| -> Vec<(f64, Vec<Track>)> {
            groups
                .into_iter()
                .map(|(w, rows)| {
                    (w, rows.into_iter().map(|(t, y, up)| {
                        info.insert(t.id.clone(), (y, up));
                        t
                    }).collect())
                })
                .collect()
        };
        let lists = vec![rank(strip(rel)), rank(strip(by)), rank(strip(found))];
        let mut out: Vec<EraCand> = Vec::new();
        for t in round_robin(lists) {
            let (y, up) = info.get(&t.id).copied().unwrap_or((None, false));
            out.push((t, y, up, Vec::new()));
        }
        out
    };
    let yt_side = async {
        if src == Sources::Sc {
            return Vec::new();
        }
        let yt = super::youtube::Yt::global();
        let search = |q: String, artist: Option<String>| async move {
            let list = yt.search(super::youtube::Src::Music, &q, 0).await.unwrap_or_else(|e| {
                log(&format!("youtube music search {q:?}: {e}"));
                Vec::new()
            });
            // An artist's search also finds other artists' songs that name them: keep theirs.
            let list = list.into_iter().filter(|t| artist.as_ref().is_none_or(|a| engine::name_key(&t.artist) == *a)).collect::<Vec<_>>();
            (1.0, list)
        };
        let radios = async {
            let lists: Vec<(f64, Vec<Track>)> = join_all(plan.yt_seeds.iter().take(MORE_SEEDS).map(|(id, w)| async move {
                (*w, yt.related(id, 50).await.unwrap_or_default())
            }))
            .await;
            lists
        };
        let (rel, by, found) = futures::join!(
            radios,
            join_all(names.iter().map(|n| search(n.clone(), Some(n.clone())))),
            join_all(queries.iter().map(|q| search(q.clone(), None))),
        );
        round_robin(vec![rank(rel), rank(by), rank(found)]).into_iter().map(|t| (t, None, false, Vec::new())).collect::<Vec<EraCand>>()
    };
    let (sc_c, yt_c) = futures::join!(sc_side, yt_side);

    // Songs only (no edits, DJ sets or clips), each song once across both platforms.
    let mut songs: HashSet<String> = HashSet::new();
    let mut clean = |list: Vec<EraCand>| {
        let mut keep = Vec::new();
        for c in list {
            let d = c.0.duration;
            let keys = engine::song_keys(&c.0);
            if (d > 0 && !(60..=900).contains(&d)) || keys.iter().any(|k| songs.contains(k)) {
                continue;
            }
            songs.extend(keys);
            keep.push(c);
        }
        keep
    };
    let (sc_c, yt_c) = (clean(sc_c), clean(yt_c));
    let n_cands = (sc_c.len(), yt_c.len());
    let ((a, mut r), (b, rb)) =
        futures::join!(era_dated(dir, plan, sc_c, want, false, &style), era_dated(dir, plan, yt_c, want, true, &style));
    r.add(rb);
    log(&format!(
        "{}: {} + {} SoundCloud / YouTube candidates -> {} + {} of the {} (want {need}; {} off-genre, families {:?})",
        plan.title, n_cands.0, n_cands.1, a.len(), b.len(), engine::decade_word(decade), r.total(), plan.families
    ));
    let share = side_share(plan, src, !a.is_empty(), !b.is_empty());
    (engine::blend(a, b, share), r)
}

/// The candidates of one platform that are songs of the plan's decade and pass its genre
/// check, in order, until `want` are found. Years come in chunks (cache hits are free; new
/// lookups are bounded).
async fn era_dated<S, F>(dir: &std::path::Path, plan: &Plan, cands: Vec<EraCand>, want: usize, youtube: bool, style: &S) -> (Vec<(Track, Vec<String>)>, Rejects)
where
    S: Fn(String) -> F,
    F: std::future::Future<Output = (Vec<String>, bool)>,
{
    let decade = plan.decade;
    let mut r = Rejects::default();
    let yt = super::youtube::Yt::global();
    let deadline = Instant::now() + ERA_BUDGET;
    let mut lookups = ERA_LOOKUPS;
    let mut out = Vec::new();
    for chunk in cands.chunks(20) {
        if out.len() >= want {
            break;
        }
        // Edits / non-songs out before spending lookups on them.
        let mut keep: Vec<&EraCand> = Vec::new();
        let mut fams: Vec<Vec<String>> = Vec::new();
        for c in chunk {
            let (f, junk) = style(style_text(&c.0)).await;
            if junk {
                continue;
            }
            if let Some(f) = engine::admit_counted(plan, &c.0, f, &mut r) {
                keep.push(c);
                fams.push(f);
            }
        }
        let left = deadline.saturating_duration_since(Instant::now());
        let years = if youtube {
            let reqs: Vec<(String, String, String, u64)> =
                keep.iter().map(|c| (c.0.id.trim_start_matches("yt:").to_string(), c.0.title.clone(), c.0.artist.clone(), c.0.duration)).collect();
            let (y, n) = yt.video_years(dir, &reqs, lookups, left).await;
            lookups = lookups.saturating_sub(n);
            y
        } else {
            let reqs: Vec<(String, String, String, u64)> = keep
                .iter()
                .filter(|c| c.2 && c.1.is_some_and(|y| engine::decade_of(y) >= decade))
                .map(|c| (c.0.id.clone(), c.0.title.clone(), c.0.artist.clone(), c.0.duration))
                .collect();
            let (y, n) = if reqs.is_empty() { (HashMap::new(), 0) } else { yt.song_years(dir, &reqs, lookups, left).await };
            lookups = lookups.saturating_sub(n);
            y
        };
        for (c, f) in keep.into_iter().zip(fams) {
            let key = if youtube { c.0.id.trim_start_matches("yt:") } else { c.0.id.as_str() };
            let ytm = years.get(key).copied();
            if !youtube && c.2 && ytm.is_none() && engine::reupload(&c.0) {
                continue;
            }
            let y = engine::candidate_year(c.1, c.2, ytm);
            if engine::in_decade(y, decade) && out.len() < want {
                out.push((c.0.clone(), f));
            }
        }
    }
    (out, r)
}

/// Release years from YouTube Music (cached forever, bounded per build, highest weight
/// first): album years for YouTube tracks, and an older year for SoundCloud tracks whose
/// only date is the upload. Returns (YouTube tracks with a year, SoundCloud years improved).
async fn youtube_years(dir: &std::path::Path, items: &mut [Item], meta: &HashMap<String, Meta>) -> (usize, usize) {
    let yt = super::youtube::Yt::global();
    let mut order: Vec<usize> = (0..items.len()).collect();
    order.sort_by(|&a, &b| items[b].weight.partial_cmp(&items[a].weight).unwrap_or(std::cmp::Ordering::Equal));
    let req = |t: &Track, key: String| (key, t.title.clone(), t.artist.clone(), t.duration);

    let t0 = Instant::now();
    let vids: Vec<(String, String, String, u64)> =
        order.iter().filter(|&&i| engine::is_yt(&items[i].track)).map(|&i| req(&items[i].track, items[i].track.id[3..].to_string())).collect();
    let (years, looked) = yt.video_years(dir, &vids, YEAR_LOOKUPS, YEAR_BUDGET).await;
    let mut dated = 0;
    for it in items.iter_mut().filter(|it| engine::is_yt(&it.track)) {
        if let Some(&y) = years.get(&it.track.id[3..]) {
            it.year = Some(y);
            dated += 1;
        }
    }
    log(&format!("YouTube years: {dated}/{} tracks ({looked} lookups, {} ms)", vids.len(), t0.elapsed().as_millis()));

    let t0 = Instant::now();
    let songs: Vec<(String, String, String, u64)> = order
        .iter()
        .filter(|&&i| engine::is_sc(&items[i].track) && items[i].year.is_some() && meta.get(&items[i].track.id).is_some_and(|m| m.up))
        .map(|&i| req(&items[i].track, items[i].track.id.clone()))
        .collect();
    let (older, looked) = yt.song_years(dir, &songs, YEAR_LOOKUPS, YEAR_BUDGET).await;
    let mut better = 0;
    for it in items.iter_mut() {
        if let (Some(&y), Some(cur)) = (older.get(&it.track.id), it.year) {
            if y < cur {
                it.year = Some(y);
                better += 1;
            }
        }
    }
    log(&format!("older years from YouTube Music: {better} of {} upload-dated SoundCloud tracks ({looked} lookups, {} ms)", songs.len(), t0.elapsed().as_millis()));
    (dated, better)
}

/// Avatars for the "Your artists" row.
async fn artist_cards(sc: &SoundCloud, items: &[Item]) -> Vec<Value> {
    let top = engine::top_artists(items, 16);
    join_all(top.into_iter().map(|(t, w)| async move {
            let mut avatar = String::new();
            if engine::is_sc(&t) && !t.artist_id.is_empty() {
                if let Ok(u) = sc.api(&format!("/users/{}", t.artist_id), &[]).await {
                    let a = artwork(&str_of(&u, "avatar_url").unwrap_or_default(), "t300x300");
                    if !a.contains("default_avatar") {
                        avatar = a;
                    }
                }
            }
            json!({
                "name": t.artist,
                "artistId": t.artist_id,
                "artistUrl": t.artist_url,
                "avatar": avatar,
                "artwork": t.artwork,
                "source": engine::source_of(&t),
                "weight": (w * 10.0).round() / 10.0,
                "track": t,
            })
    }))
    .await
}

// ------------------------------------------------------------------
// build
// ------------------------------------------------------------------

async fn build(app: &AppHandle) -> Result<Cache, String> {
    let sc: Arc<SoundCloud> = app.state::<crate::AppState>().sc.clone();
    let likes = likes(app);
    let hist = history(app).await;
    let now = now_ms();
    let old = cache_async(app).await;
    let mut items = engine::build_items(&likes, &hist, now);
    let lists = playlists(app);
    let saved: Vec<Track> = lists.iter().flat_map(|(_, t)| t.iter().cloned()).collect();
    engine::add_saved(&mut items, &saved);
    if items.is_empty() {
        return Ok(Cache { version: VERSION, built_at: now, sources: sources(app).as_str().into(), ..Default::default() });
    }

    // Years + playability for SoundCloud tracks (falls back to the last build's data offline).
    let sc_ids: Vec<String> = items.iter().filter(|it| engine::is_sc(&it.track)).map(|it| it.track.id.clone()).collect();
    let (fresh, answered) = fetch_meta(&sc, &sc_ids).await;
    let mut meta: HashMap<String, Meta> = HashMap::new();
    items.retain_mut(|it| {
        let t = &it.track;
        if engine::is_sc(t) {
            if let Some((m, mapped)) = fresh.get(&t.id) {
                meta.insert(t.id.clone(), *m);
                if !m.ok {
                    return false;
                }
                // Fresh artwork / genre / tags from SoundCloud.
                it.track = mapped.clone();
                it.year = (m.y > 0).then_some(m.y);
                return true;
            }
            if answered.contains(&t.id) {
                return false; // deleted or private
            }
            if let Some(m) = old.as_ref().and_then(|c| c.meta.get(&t.id)) {
                meta.insert(t.id.clone(), *m);
                it.year = (m.y > 0).then_some(m.y);
                return m.ok;
            }
            return true;
        }
        if t.source == "local" && !t.path.is_empty() {
            return std::path::Path::new(&t.path).exists();
        }
        true
    });

    let dir = app.state::<crate::AppState>().data_dir.clone();
    youtube_years(&dir, &mut items, &meta).await;

    // Songs with no genre words (YouTube Music has no genres) take one from the name
    // of a playlist they are saved in ("Hip Hop Mix").
    let names = playlist_names(&lists);
    let mut name_fams: HashMap<String, Vec<String>> = HashMap::new();
    for (name, _) in &lists {
        if !name_fams.contains_key(name) {
            let f = families(app, name).await;
            name_fams.insert(name.clone(), f);
        }
    }
    for it in items.iter_mut() {
        it.families = families(app, &style_text(&it.track)).await;
        it.genre_families = families(app, &it.track.genre).await;
        if it.families.is_empty() && it.genre_families.is_empty() {
            it.families = engine::hint_families(names.get(&it.track.id).map(Vec::as_slice).unwrap_or(&[]), &name_fams);
        }
    }
    engine::assign_families(&mut items);
    let cooc = engine::cooccurrence(&hist);
    let plans = engine::plans(&items, &cooc, now);

    // YouTube Music twins of SoundCloud seeds, for plans with no YouTube seeds of their own.
    let src = sources(app);
    let t0 = Instant::now();
    let reqs = twin_requests(app, &items, &plans, src).await;
    let (twins, looked) = if reqs.is_empty() {
        (HashMap::new(), 0)
    } else {
        super::youtube::Yt::global().song_twins(&dir, &reqs, TWIN_LOOKUPS, TWIN_BUDGET).await
    };
    if !reqs.is_empty() {
        log(&format!("YouTube Music twins: {}/{} SoundCloud seeds ({looked} searches, {} ms)", twins.len(), reqs.len(), t0.elapsed().as_millis()));
    }

    // Related top-ups never repeat what the user already knows (twins are the user's songs too).
    let mut known = Known::of(&items);
    known.set.extend(twins.values().map(|v| format!("yt:{v}")));
    let known = &known;
    let fam = &family_twins(&plans, &twins);
    let twins = &twins;
    let (scr, dir): (&SoundCloud, &std::path::Path) = (&*sc, dir.as_path());
    let style = |text: String| async move { style_of(app, &text).await };
    let style = &style;
    let mut built: Vec<Mix> = Vec::new();
    for group in plans.chunks(3) {
        let done = join_all(group.iter().map(|p| async move {
            let tp = with_twins(p, twins, fam, src);
            // Era mixes search the user's top genres of their decade (`Plan::families`).
            let (mix, rejected) = if p.decade > 0 {
                let (fresh, r) = era_top_up(scr, dir, &tp, &p.families, known, src, style).await;
                (engine::finish(p, &fresh, now), r)
            } else {
                let (mut fresh, mut r) = top_up(app, &tp, known, src).await;
                let mut mix = engine::finish(p, &fresh, now);
                // Still under 50: more related tracks from more seeds (same genre checks).
                if engine::tops_up(&p.kind) && mix.as_ref().map_or(0, |m| m.tracks.len()) < MAX_TRACKS {
                    let (more, rm) = more_related(scr, &tp, known, src, 60, style).await;
                    fresh.extend(more);
                    r.add(rm);
                    mix = engine::finish(p, &fresh, now);
                }
                (mix, r)
            };
            let n = mix.as_ref().map_or(0, |m| m.tracks.len());
            let style_name = engine::style_key(p.family.as_deref(), p.sub.as_deref());
            if engine::tops_up(&p.kind) && n < MAX_TRACKS {
                // Shorter beats off-genre filler: own tracks of the style and matching new songs only.
                log(&format!(
                    "{} [{style_name}]: {n} tracks, not enough new songs of its style ({} off-genre, {} genre-less from unknown artists dropped)",
                    p.title, rejected.off, rejected.unsure
                ));
            } else if rejected.total() > 0 {
                log(&format!("{} [{style_name}]: {} off-genre / {} unsure new songs dropped", p.title, rejected.off, rejected.unsure));
            }
            mix
        }))
        .await;
        built.extend(done.into_iter().flatten());
    }
    // Renumber Daily Mixes in case one was too small.
    let mut n = 0u8;
    let mixes: Vec<Mix> = built
        .into_iter()
        .map(|mut m| {
            if m.kind == "daily" {
                n += 1;
                m.number = n;
                m.id = format!("daily-{n}");
                m.title = format!("Daily Mix {n}");
            }
            m
        })
        .collect();
    let artists = artist_cards(&sc, &items).await;
    Ok(Cache {
        version: VERSION,
        built_at: now,
        took_ms: 0,
        likes_len: likes.len(),
        likes_head: likes.first().map(|t| t.id.clone()).unwrap_or_default(),
        mixes,
        artists,
        meta,
        sources: src.as_str().into(),
    })
}

// ------------------------------------------------------------------
// live test (reads the real data folder, read-only)
// ------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Genre families of a text with discover's detector (what the app's `style` command uses).
    fn guess(text: &str) -> Vec<String> {
        let mut v: Vec<String> = super::super::discover::detect_families(text).into_keys().collect();
        v.sort_by_key(|f| engine::family_rank(f));
        v
    }

    #[test]
    fn likes_moved_counts_new_front_likes() {
        let t = |id: &str| -> Track { serde_json::from_value(json!({ "id": id, "title": "x", "artist": "a", "duration": 100, "artwork": "", "url": "" })).unwrap() };
        let l = vec![t("3"), t("2"), t("1")];
        assert_eq!(likes_moved(&l, "1"), 2);
        assert_eq!(likes_moved(&l, "3"), 0);
        assert_eq!(likes_moved(&l, "gone"), 3);
    }

    #[test]
    fn twins_seed_plans_without_youtube() {
        let plan = |id: &str, seeds: &[&str], yt: &[&str], fam: &str| {
            let mut p = Plan::new(id.into(), "daily", id.into());
            p.seeds = seeds.iter().enumerate().map(|(i, s)| (s.to_string(), 10.0 - i as f64)).collect();
            p.yt_seeds = yt.iter().map(|s| (s.to_string(), 1.0)).collect();
            p.family = Some(fam.into());
            p
        };
        let twins: HashMap<String, String> =
            [("1", "aaaaaaaaaa1"), ("2", "aaaaaaaaaa2"), ("3", "aaaaaaaaaa3"), ("4", "aaaaaaaaaa4"), ("5", "aaaaaaaaaa5"), ("9", "aaaaaaaaaa9")]
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect();
        let plans = vec![
            plan("all-sc", &["1", "x", "2", "3", "4", "5"], &[], "harddance"),
            plan("some-yt", &["9"], &["yt:own00000001"], "rap"),
            plan("no-twins", &["x", "y"], &[], "harddance"),
            plan("no-twins-other", &["x"], &[], "techno"),
        ];
        let fam = family_twins(&plans, &twins);
        let t = |p: &Plan, s| with_twins(p, &twins, &fam, s).yt_seeds.into_iter().map(|(v, _)| v).collect::<Vec<_>>();
        assert_eq!(t(&plans[0], Sources::Both), ["yt:aaaaaaaaaa1", "yt:aaaaaaaaaa2", "yt:aaaaaaaaaa3", "yt:aaaaaaaaaa4"], "best 4 twins");
        assert_eq!(t(&plans[0], Sources::Yt).len(), 4);
        assert!(t(&plans[0], Sources::Sc).is_empty(), "SoundCloud only: no twins");
        assert_eq!(t(&plans[1], Sources::Both), ["yt:own00000001", "yt:aaaaaaaaaa9"], "own YouTube seeds first");
        assert_eq!(t(&plans[2], Sources::Both).len(), 4, "borrows its family's twins");
        assert!(t(&plans[3], Sources::Both).is_empty(), "no twins in its family");
    }

    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn live_mixes_from_real_data() {
        let dir = std::env::var("NOXX_DATA")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|_| std::path::PathBuf::from(std::env::var("APPDATA").unwrap_or_default()).join("dev.riffrs.player"));
        let lib: crate::library::LibraryData =
            serde_json::from_slice(&std::fs::read(dir.join("library.json")).expect("library.json")).expect("library");
        let hist: Vec<super::super::history::Entry> =
            serde_json::from_slice(&std::fs::read(dir.join("history.json")).unwrap_or_else(|_| b"[]".to_vec())).unwrap_or_default();
        let hist: Vec<(Track, u64)> = hist.into_iter().map(|e| (e.track, e.played_at)).collect();
        let now = now_ms();
        let t0 = Instant::now();
        let mut items = engine::build_items(&lib.favorites, &hist, now);
        let saved: Vec<Track> = lib.playlists.iter().flat_map(|p| p.tracks.iter().cloned()).collect();
        engine::add_saved(&mut items, &saved);
        let n_yt = items.iter().filter(|it| engine::is_yt(&it.track)).count();
        println!("{} likes, {} plays, {} saved -> {} items ({n_yt} YouTube)", lib.favorites.len(), hist.len(), saved.len(), items.len());

        let tmp = std::env::temp_dir().join("noxx-mixes-test");
        let _ = std::fs::create_dir_all(&tmp);
        let sc = SoundCloud::new(tmp.clone());
        let ids: Vec<String> = items.iter().filter(|it| engine::is_sc(&it.track)).map(|it| it.track.id.clone()).collect();
        let t1 = Instant::now();
        let (fresh, answered) = fetch_meta(&sc, &ids).await;
        println!("metadata for {}/{} SoundCloud tracks in {} ms", fresh.len(), ids.len(), t1.elapsed().as_millis());
        let mut meta: HashMap<String, Meta> = HashMap::new();
        items.retain_mut(|it| match fresh.get(&it.track.id) {
            Some((m, _)) => {
                meta.insert(it.track.id.clone(), *m);
                it.year = (m.y > 0).then_some(m.y);
                m.ok
            }
            None => !answered.contains(&it.track.id),
        });
        let decades = |items: &[Item]| {
            let mut d: Vec<(u16, usize)> = Vec::new();
            for it in items {
                if let Some(y) = it.year {
                    match d.iter_mut().find(|(k, _)| *k == engine::decade_of(y)) {
                        Some(e) => e.1 += 1,
                        None => d.push((engine::decade_of(y), 1)),
                    }
                }
            }
            d.sort();
            d
        };
        let before = decades(&items);
        let by_decade = |items: &[Item], dec: u16| -> HashSet<String> {
            items.iter().filter(|it| it.year.map(engine::decade_of) == Some(dec)).map(|it| it.track.id.clone()).collect()
        };
        let (b2000, b2010) = (by_decade(&items, 2000), by_decade(&items, 2010));
        println!("playable items {}, decades from SoundCloud: {before:?}", items.len());

        // YouTube Music years (cache in a temp folder; the real data folder stays read-only)
        let ycache = tmp.join("years");
        let _ = std::fs::create_dir_all(&ycache);
        let t1 = Instant::now();
        let (dated, better) = youtube_years(&ycache, &mut items, &meta).await;
        println!("YouTube Music years in {} ms: {dated}/{n_yt} YouTube tracks dated, {better} SoundCloud tracks older", t1.elapsed().as_millis());
        let t1 = Instant::now();
        let again = youtube_years(&ycache, &mut items, &meta).await;
        println!("  again (cached) in {} ms: {again:?}", t1.elapsed().as_millis());
        let (a2000, a2010) = (by_decade(&items, 2000), by_decade(&items, 2010));
        println!("decades now: {:?}", decades(&items));
        println!(
            "2000s: {} -> {} (+{} -{}), 2010s: {} -> {} (+{} -{})",
            b2000.len(), a2000.len(), a2000.difference(&b2000).count(), b2000.difference(&a2000).count(),
            b2010.len(), a2010.len(), a2010.difference(&b2010).count(), b2010.difference(&a2010).count()
        );
        for it in items.iter().filter(|it| engine::is_sc(&it.track) && a2000.contains(&it.track.id) && !b2000.contains(&it.track.id)).take(5) {
            println!("  moved to the 2000s: {} - {} ({:?})", it.track.artist, it.track.title, it.year);
        }

        let lists: Vec<(String, Vec<Track>)> = lib.playlists.iter().map(|p| (p.name.clone(), p.tracks.clone())).collect();
        let names = playlist_names(&lists);
        let name_fams: HashMap<String, Vec<String>> = lists.iter().map(|(n, _)| (n.clone(), guess(n))).collect();
        let mut hinted = 0;
        for it in items.iter_mut() {
            it.families = guess(&style_text(&it.track));
            it.genre_families = guess(&it.track.genre);
            if it.families.is_empty() && it.genre_families.is_empty() {
                it.families = engine::hint_families(names.get(&it.track.id).map(Vec::as_slice).unwrap_or(&[]), &name_fams);
                hinted += usize::from(!it.families.is_empty());
            }
        }
        println!("{hinted} genre-less tracks took a family from their playlist's name");
        engine::assign_families(&mut items);
        let cooc = engine::cooccurrence(&hist);
        let plans = engine::plans(&items, &cooc, now);
        let mixes: Vec<Mix> = plans.iter().filter_map(|p| engine::finish(p, &[], now)).collect();
        println!("{} plans, {} mixes from own tracks alone in {} ms", plans.len(), mixes.len(), t0.elapsed().as_millis());

        // YouTube Music twins of SoundCloud seeds (cache in the temp folder). Edits are
        // skipped with a rough word check here (the app asks discover's style).
        fn is_edit(s: &str) -> bool {
            let s = s.to_lowercase();
            ["sped up", "speed up", "slowed", "nightcore", "reverb", "bass boost", "daycore", "tiktok"].iter().any(|w| s.contains(w))
        }
        let by_id: HashMap<&str, &Track> = items.iter().map(|it| (it.track.id.as_str(), &it.track)).collect();
        let mut reqs: Vec<(String, String, String, u64)> = Vec::new();
        for p in plans.iter().filter(|p| p.yt_seeds.len() < TWIN_SEEDS) {
            for (id, _) in p.seeds.iter().filter(|(id, _)| by_id.get(id.as_str()).is_some_and(|t| !is_edit(&t.title))).take(TWIN_TRIES) {
                if !reqs.iter().any(|(k, ..)| k == id) {
                    let t = by_id[id.as_str()];
                    reqs.push((id.clone(), t.title.clone(), t.artist.clone(), t.duration));
                }
            }
        }
        let yt = super::super::youtube::Yt::global();
        let t1 = Instant::now();
        let (twins, looked) = yt.song_twins(&ycache, &reqs, TWIN_LOOKUPS, TWIN_BUDGET).await;
        println!("YouTube Music twins: {}/{} SoundCloud seeds ({looked} searches) in {} ms", twins.len(), reqs.len(), t1.elapsed().as_millis());
        let t1 = Instant::now();
        let (again, looked) = yt.song_twins(&ycache, &reqs, TWIN_LOOKUPS, TWIN_BUDGET).await;
        println!("  again (cached): {} twins ({looked} searches) in {} us", again.len(), t1.elapsed().as_micros());
        for (k, title, artist, _) in reqs.iter().filter(|(k, ..)| twins.contains_key(k)).take(5) {
            println!("  twin: {artist} - {title} -> https://music.youtube.com/watch?v={}", twins[k]);
        }

        // SoundCloud side: related tracks of the best seeds (stand-in for discover's wave).
        // Unfiltered: the genre rules run below, so old and new rules see the same candidates.
        async fn sc_pool(sc: &SoundCloud, p: &Plan, known: &Known, limit: usize, guess: fn(&str) -> Vec<String>) -> Vec<(Track, Vec<String>)> {
            let lists: Vec<(f64, Vec<Track>)> = join_all(p.seeds.iter().take(5).map(|(id, w)| async move {
                let v = sc.api(&format!("/tracks/{id}/related"), &[("limit", "30".to_string())]).await.unwrap_or(Value::Null);
                let list = v["collection"].as_array().cloned().unwrap_or_default();
                (*w, list.iter().filter(|t| playable(t)).map(map_track).collect::<Vec<Track>>())
            }))
            .await;
            // discover's wave drops edits too
            engine::rank_related(&lists, &known.set, &known.songs, limit)
                .into_iter()
                .filter(|(t, _)| !is_edit(&style_text(t)))
                .map(|(t, _)| {
                    let f = guess(&style_text(&t));
                    (t, f)
                })
                .collect()
        }
        async fn yt_pool(p: &Plan, known: &Known, limit: usize, guess: fn(&str) -> Vec<String>) -> Vec<(Track, Vec<String>)> {
            yt_related(p, known, limit * 2).await.into_iter().filter(|(t, _)| !is_edit(&t.title)).map(|(t, _)| { let f = guess(&style_text(&t)); (t, f) }).collect()
        }
        /// The old rule (family only; genre-less YouTube songs by any artist of the mix).
        fn old_fit(p: &Plan, t: &Track, f: &[String]) -> bool {
            match &p.family {
                None => true,
                Some(x) => f.contains(x) || (f.is_empty() && engine::is_yt(t) && p.own.iter().any(|o| engine::artist_key(o) == engine::artist_key(t))),
            }
        }

        let mut known = Known::of(&items);
        known.set.extend(twins.values().map(|v| format!("yt:{v}")));
        let fam = family_twins(&plans, &twins);
        let t1 = Instant::now();
        let test_style = |text: String| async move { (guess(&text), is_edit(&text)) };
        let style_of_plan = |p: &Plan| engine::style_key(p.family.as_deref(), p.sub.as_deref());
        // (title, style, tracks before -> after, % new before -> after, off / unsure dropped) per mix.
        struct Row {
            title: String,
            style: String,
            before: usize,
            after: usize,
            new_before: usize,
            new_after: usize,
            r: Rejects,
        }
        let mut table: Vec<Row> = Vec::new();
        let pct = |n: usize, of: usize| n * 100 / of.max(1);
        for p in plans.iter().filter(|p| !engine::tops_up(&p.kind)) {
            let n = engine::finish(p, &[], now).map_or(0, |m| m.tracks.len());
            table.push(Row { title: p.title.clone(), style: String::new(), before: n, after: n, new_before: 0, new_after: 0, r: Rejects::default() });
        }
        let new_of = |p: &Plan, m: &Option<Mix>| -> Vec<Track> {
            let own: HashSet<&str> = p.own.iter().map(|t| t.id.as_str()).collect();
            m.as_ref().map(|m| m.tracks.iter().filter(|t| !own.contains(t.id.as_str())).cloned().collect()).unwrap_or_default()
        };
        for p in plans.iter().filter(|p| p.decade > 0) {
            let t2 = Instant::now();
            let tp = with_twins(p, &twins, &fam, Sources::Both);
            let mut open = tp.clone();
            open.families.clear();
            let (all, _) = era_top_up(&sc, &ycache, &open, &p.families, &known, Sources::Both, &test_style).await;
            let before = engine::finish(p, &all, now);
            let mut r = Rejects::default();
            let fresh: Vec<(Track, Vec<String>)> =
                all.iter().filter_map(|(t, f)| engine::admit_counted(&tp, t, f.clone(), &mut r).map(|f| (t.clone(), f))).collect();
            let after = engine::finish(p, &fresh, now);
            let (nb, na) = (new_of(p, &before), new_of(p, &after));
            let (b, a) = (before.as_ref().map_or(0, |m| m.tracks.len()), after.as_ref().map_or(0, |m| m.tracks.len()));
            println!("  [era] {}: families {:?}; {b} -> {a} tracks, {} -> {} new, {} off-genre dropped, {} ms", p.title, p.families, nb.len(), na.len(), r.off, t2.elapsed().as_millis());
            for t in nb.iter().filter(|t| !na.iter().any(|x| x.id == t.id)).take(8) {
                println!("      dropped: {} - {} [{}] genre {:?}", t.artist, t.title, if engine::is_yt(t) { "YT" } else { "SC" }, t.genre);
            }
            table.push(Row { title: p.title.clone(), style: format!("{:?}", p.families), before: b, after: a, new_before: nb.len(), new_after: na.len(), r });
        }
        for p in plans.iter().filter(|p| p.decade == 0 && engine::tops_up(&p.kind) && (!p.seeds.is_empty() || !p.yt_seeds.is_empty())) {
            let t2 = Instant::now();
            let limit = if p.kind == "daily" { 70 } else { 60 };
            let tp = with_twins(p, &twins, &fam, Sources::Both);
            // Every candidate, genre-checked below: first round, then the second-round pool.
            let mut open = tp.clone();
            open.family = None;
            open.sub = None;
            let share = match (!tp.seeds.is_empty(), !tp.yt_seeds.is_empty()) {
                (true, false) => 0.0,
                (false, true) => 1.0,
                _ => engine::new_share(Sources::Both, tp.yt_share),
            };
            let yt_list = if tp.yt_seeds.is_empty() { Vec::new() } else { yt_pool(&tp, &known, limit, guess).await };
            let mut pool = engine::blend(sc_pool(&sc, &tp, &known, limit, guess).await, yt_list, share);
            pool.extend(more_related(&sc, &open, &known, Sources::Both, 60, &test_style).await.0);
            let old: Vec<(Track, Vec<String>)> = pool.iter().filter(|(t, f)| old_fit(p, t, f)).cloned().collect();
            let mut r = Rejects::default();
            let fresh: Vec<(Track, Vec<String>)> =
                pool.iter().filter_map(|(t, f)| engine::admit_counted(&tp, t, f.clone(), &mut r).map(|f| (t.clone(), f))).collect();
            let (before, after) = (engine::finish(p, &old, now), engine::finish(p, &fresh, now));
            let (nb, na) = (new_of(p, &before), new_of(p, &after));
            let (b, a) = (before.as_ref().map_or(0, |m| m.tracks.len()), after.as_ref().map_or(0, |m| m.tracks.len()));
            // New picks the old rule let in that the new check calls off-genre / unsure.
            let bad_before = nb.iter().filter(|t| !matches!(engine::admit(&tp, t, guess(&style_text(t))), engine::Fit::Yes(_))).count();
            println!(
                "  [{}] {} ({}) style {}: {b} -> {a} tracks, {} -> {} new ({bad_before} of the old new picks fail the new check); pool {}, dropped {} off-genre + {} genre-less/unknown artist; own {}, known artists {}, YT seeds {} -> {}, {} ms",
                p.kind, p.title, p.tag, style_of_plan(p), nb.len(), na.len(), pool.len(), r.off, r.unsure, p.own.len(), p.artists.len(),
                p.yt_seeds.len(), tp.yt_seeds.len(), t2.elapsed().as_millis()
            );
            if p.kind == "daily" && p.family.is_none() {
                let own: Vec<String> = p.own.iter().take(8).map(|t| format!("{} - {} ({:?})", t.artist, t.title, t.genre)).collect();
                println!("      own (no family): {own:?}");
            }
            let show = p.sub.as_deref() == Some("hardtekk") && p.kind == "genre" || p.kind == "daily";
            if show {
                for t in na.iter().take(if p.kind == "daily" { 16 } else { 30 }) {
                    println!("      new: {} - {} [{}] genre {:?}", t.artist, t.title, if engine::is_yt(t) { "YT" } else { "SC" }, t.genre);
                }
                for t in nb.iter().filter(|t| !na.iter().any(|x| x.id == t.id)).take(10) {
                    println!("      no longer in: {} - {} [{}] genre {:?}", t.artist, t.title, if engine::is_yt(t) { "YT" } else { "SC" }, t.genre);
                }
            }
            table.push(Row { title: p.title.clone(), style: style_of_plan(p), before: b, after: a, new_before: nb.len(), new_after: na.len(), r });
        }
        println!("top-ups for all plans in {} ms", t1.elapsed().as_millis());
        println!("mix | style | tracks before -> after | % new before -> after | off-genre / unsure dropped");
        for x in &table {
            println!(
                "{} | {} | {} -> {} | {}% -> {}% | {} / {}",
                x.title, x.style, x.before, x.after, pct(x.new_before, x.before), pct(x.new_after, x.after), x.r.off, x.r.unsure
            );
        }
        assert!(!plans.is_empty());
    }
}
