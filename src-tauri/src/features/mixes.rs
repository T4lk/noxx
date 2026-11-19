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

use crate::soundcloud::{artwork, id_of, map_track, playable, str_of, write_json, SoundCloud, Track};
use engine::{Item, Mix, Plan};

const FILE: &str = "mixes.json";
const VERSION: u32 = 3; // 3: YouTube seeds top up with YouTube Music radio; YouTube Music years
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
}

static CACHE: Mutex<Option<Arc<Cache>>> = Mutex::new(None);
static BUILDING: AtomicBool = AtomicBool::new(false);
static LAST_ERROR: Mutex<String> = Mutex::new(String::new());

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
            Ok(list_json(c.as_deref()))
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
                Ok(list_json(cache_async(app).await.as_deref()))
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

fn list_json(c: Option<&Cache>) -> Value {
    let error = LAST_ERROR.lock().unwrap().clone();
    let building = BUILDING.load(Ordering::SeqCst);
    match c {
        Some(c) => json!({
            "builtAt": c.built_at,
            "tookMs": c.took_ms,
            "building": building,
            "error": error,
            "mixes": c.mixes.iter().map(summary).collect::<Vec<_>>(),
            "artists": c.artists,
        }),
        None => json!({ "builtAt": 0, "building": building, "error": error, "mixes": [], "artists": [] }),
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
    let res = build(app).await;
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
        Known { set: ids.iter().cloned().collect(), songs: items.iter().map(|it| engine::song_key(&it.track)).collect(), ids }
    }
}

/// YouTube Music radios of a plan's best YouTube seeds, merged: (track, seeds it is related to).
async fn yt_related(plan: &Plan, known: &Known, limit: usize) -> Vec<(Track, usize)> {
    if plan.yt_seeds.is_empty() || limit == 0 {
        return Vec::new();
    }
    let yt = super::youtube::Yt::global();
    let lists: Vec<(f64, Vec<Track>)> = join_all(plan.yt_seeds.iter().take(YT_SEEDS).map(|(id, w)| async move {
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
/// seeds and YouTube Music radio for its YouTube seeds, each filtered to the plan's genre
/// family, then blended so the YouTube share matches the plan's own taste.
async fn top_up(app: &AppHandle, plan: &Plan, known: &Known) -> Vec<(Track, Vec<String>)> {
    let (has_sc, has_yt) = (!plan.seeds.is_empty(), !plan.yt_seeds.is_empty());
    let share = match (has_sc, has_yt) {
        (false, false) => return Vec::new(),
        (true, false) => 0.0,
        (false, true) => 1.0,
        _ => plan.yt_share,
    };
    // Daily Mixes are mostly new songs, so they need a bigger pool (some get dropped by the genre filter).
    let limit = if plan.kind == "daily" { 70 } else { 40 };
    let fits = |fams: &[String]| plan.family.as_ref().is_none_or(|f| fams.contains(f));

    let sc = async {
        if !has_sc || share > 0.9 {
            return Vec::new();
        }
        let seeds: Vec<Value> = plan.seeds.iter().map(|(id, w)| json!({ "id": id, "weight": w })).collect();
        let v = super::discover::handle(app, "wave", json!({ "seeds": seeds, "heard": known.ids, "limit": limit })).await;
        let list: Vec<Track> = v.ok().and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default();
        let mut out = Vec::with_capacity(list.len());
        for t in list {
            let f = families(app, &style_text(&t)).await;
            if fits(&f) {
                out.push((t, f));
            }
        }
        out
    };
    let yt = async {
        if !has_yt || share < 0.1 {
            return Vec::new();
        }
        let artists: HashSet<String> = plan.own.iter().map(engine::artist_key).collect();
        let mut out = Vec::new();
        for (t, hits) in yt_related(plan, known, limit).await {
            let (f, junk) = style_of(app, &style_text(&t)).await;
            if junk {
                continue;
            }
            if let Some(f) = engine::admit_related(plan, f, hits, artists.contains(&engine::artist_key(&t))) {
                out.push((t, f));
            }
        }
        out
    };
    let (sc, yt) = futures::join!(sc, yt);
    engine::blend(sc, yt, share)
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
        return Ok(Cache { version: VERSION, built_at: now, ..Default::default() });
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

    // Related top-ups never repeat what the user already knows.
    let known = Known::of(&items);
    let known = &known;
    let mut built: Vec<Mix> = Vec::new();
    for group in plans.chunks(3) {
        let done = join_all(group.iter().map(|p| async move {
            let fresh = top_up(app, p, known).await;
            engine::finish(p, &fresh, now)
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
    })
}

// ------------------------------------------------------------------
// live test (reads the real data folder, read-only)
// ------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Rough family guess for the live test (the app uses discover's detector).
    fn guess(text: &str) -> Vec<String> {
        let t = text.to_lowercase();
        let mut v = Vec::new();
        for (f, words) in [
            ("harddance", &["tekk", "tek", "frenchcore", "hardstyle", "uptempo", "hardcore", "rawstyle", "speedcore", "gabber"][..]),
            ("techno", &["techno"][..]),
            ("house", &["house", "disco"][..]),
            ("rap", &["hip hop", "hip-hop", "rap", "trap", "drill", "plugg"][..]),
            ("phonk", &["phonk"][..]),
            ("bass", &["dubstep", "riddim"][..]),
        ] {
            if words.iter().any(|w| t.contains(w)) {
                v.push(f.to_string());
            }
        }
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

        // YouTube top-ups only (SoundCloud's wave needs the app); families via the rough guess.
        let known = Known::of(&items);
        let t1 = Instant::now();
        for p in &plans {
            let t2 = Instant::now();
            let artists: HashSet<String> = p.own.iter().map(engine::artist_key).collect();
            let fresh: Vec<(Track, Vec<String>)> = if p.yt_share >= 0.1 {
                yt_related(p, &known, if p.kind == "daily" { 70 } else { 40 })
                    .await
                    .into_iter()
                    .filter_map(|(t, hits)| {
                        let known = artists.contains(&engine::artist_key(&t));
                        engine::admit_related(p, guess(&style_text(&t)), hits, known).map(|f| (t, f))
                    })
                    .collect()
            } else {
                Vec::new()
            };
            let Some(m) = engine::finish(p, &fresh, now) else {
                println!("  (too small) {} - {} own, {} YouTube seeds", p.title, p.own.len(), p.yt_seeds.len());
                continue;
            };
            let own: HashSet<&str> = p.own.iter().map(|t| t.id.as_str()).collect();
            let yt = m.tracks.iter().filter(|t| engine::is_yt(t)).count();
            let new = m.tracks.iter().filter(|t| !own.contains(t.id.as_str())).count();
            println!(
                "  [{}] {} ({}) {} tracks, {}% YouTube, {}% new; YouTube share {:.0}%, {} YouTube seeds, {} ms; sources {:?}",
                m.kind, m.title, m.tag, m.tracks.len(), yt * 100 / m.tracks.len(), new * 100 / m.tracks.len(),
                (p.yt_share * 100.0).abs(), p.yt_seeds.len(), t2.elapsed().as_millis(), m.sources
            );
            for t in m.tracks.iter().filter(|t| engine::is_yt(t) && !own.contains(t.id.as_str())).take(4) {
                println!("      e.g. new: {} - {} ({}s) {}", t.artist, t.title, t.duration, t.url);
            }
        }
        println!("YouTube top-ups for all plans in {} ms", t1.elapsed().as_millis());
        assert!(!plans.is_empty());
    }
}
