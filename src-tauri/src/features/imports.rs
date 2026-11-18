//! Playlist imports: Spotify, Apple Music, and SoundCloud / YouTube playlist links.
//!
//! `imports.fetch {url}` reads the remote list (title/artist/duration, or ready tracks
//! for SoundCloud/YouTube links). `imports.run {job, name, items, target?, prefer}` matches
//! each item to a playable track (preferred platform first, the other as fallback),
//! 6 at a time, in order, emits `import-progress`, and saves one local playlist.
//! Spotify account (own Client ID, PKCE): `spotify_status`, `spotify_login`, `spotify_logout`,
//! `spotify_library {likes, playlists}`.

mod apple;
mod matcher;
mod spotify;

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock, Mutex, OnceLock};
use std::time::Duration;

use futures::{stream, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use super::youtube::{Src, Yt};
use crate::soundcloud::{map_track, playable, SoundCloud, Track};

pub(crate) const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const PARALLEL: usize = 6;

pub(crate) fn http() -> &'static reqwest::Client {
    static C: OnceLock<reqwest::Client> = OnceLock::new();
    C.get_or_init(|| {
        reqwest::Client::builder()
            .gzip(true)
            .brotli(true)
            .connect_timeout(Duration::from_secs(8))
            .timeout(Duration::from_secs(20))
            .build()
            .expect("reqwest client")
    })
}

/// One entry of a remote list. `track` is set when it is already playable (SoundCloud/YouTube links).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Item {
    pub title: String,
    #[serde(default)]
    pub artist: String,
    #[serde(default)]
    pub duration: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub track: Option<Track>,
}

impl Item {
    pub fn new(title: impl Into<String>, artist: impl Into<String>, duration: u64) -> Self {
        Self { title: title.into(), artist: artist.into(), duration, track: None }
    }
    fn ready(t: Track) -> Self {
        Self { title: t.title.clone(), artist: t.artist.clone(), duration: t.duration, track: Some(t) }
    }
}

#[derive(Debug, Serialize)]
pub struct Remote {
    pub name: String,
    pub cover: String,
    pub source: &'static str,
    pub total: usize,
    /// The service exposed only part of the list.
    pub partial: bool,
    pub note: String,
    pub tracks: Vec<Item>,
}

// ------------------------------------------------------------ fetch

fn host_of(text: &str) -> String {
    url::Url::parse(text.trim()).ok().and_then(|u| u.host_str().map(|h| h.to_lowercase())).unwrap_or_default()
}

pub async fn fetch(sc: &SoundCloud, data_dir: &Path, text: &str) -> Result<Remote, String> {
    let text = text.trim();
    if let Some((kind, id)) = spotify::parse_link(text) {
        return spotify::fetch(data_dir, &kind, &id).await;
    }
    if apple::is_link(text) {
        return apple::fetch(text).await;
    }
    let host = host_of(text);
    if host == "soundcloud.com" || host.ends_with(".soundcloud.com") || host == "snd.sc" {
        return soundcloud(sc, text).await;
    }
    if host == "youtu.be" || host == "youtube.com" || host.ends_with(".youtube.com") {
        let music = host == "music.youtube.com";
        let tracks = Yt::global().link(text).await?;
        if tracks.is_empty() {
            return Err("No tracks found in this YouTube link.".into());
        }
        let name = if tracks.len() == 1 { tracks[0].title.clone() } else if music { "YouTube Music playlist".into() } else { "YouTube playlist".into() };
        let cover = tracks[0].artwork.clone();
        return Ok(Remote { name, cover, source: if music { "ytmusic" } else { "youtube" }, total: tracks.len(), partial: false, note: String::new(), tracks: tracks.into_iter().map(Item::ready).collect() });
    }
    Err("Paste a Spotify, Apple Music, SoundCloud or YouTube link.".into())
}

async fn soundcloud(sc: &SoundCloud, url: &str) -> Result<Remote, String> {
    let data = sc.api("/resolve", &[("url", url.to_string())]).await.map_err(|e| e.to_string())?;
    let (name, cover, tracks) = match data["kind"].as_str() {
        Some("track") => {
            let t = map_track(&data);
            (t.title.clone(), t.artwork.clone(), vec![t])
        }
        Some("playlist") | Some("system-playlist") => {
            let tracks: Vec<Track> = sc.hydrate(&data["tracks"]).await.iter().filter(|t| playable(t)).map(map_track).collect();
            let cover = data["artwork_url"].as_str().map(|a| crate::soundcloud::artwork(a, "t500x500")).or_else(|| tracks.first().map(|t| t.artwork.clone())).unwrap_or_default();
            (data["title"].as_str().unwrap_or("SoundCloud playlist").to_string(), cover, tracks)
        }
        other => return Err(format!("This SoundCloud link is a {}, not a playlist or track.", other.unwrap_or("page"))),
    };
    if tracks.is_empty() {
        return Err("This SoundCloud playlist has no playable tracks.".into());
    }
    Ok(Remote { name, cover, source: "soundcloud", total: tracks.len(), partial: false, note: String::new(), tracks: tracks.into_iter().map(Item::ready).collect() })
}

// ------------------------------------------------------------ matching

#[derive(Clone, Copy, PartialEq, Debug)]
enum Plat {
    Sc,
    Yt(Src),
}

async fn search(sc: &SoundCloud, p: Plat, q: &str) -> Result<Vec<Track>, String> {
    match p {
        Plat::Sc => sc.search(q, 0).await.map(|mut v| {
            v.truncate(10);
            v
        }).map_err(|e| e.to_string()),
        Plat::Yt(src) => Yt::global().search(src, q, 0).await.map(|mut v| {
            v.truncate(10);
            v
        }),
    }
}

fn order(prefer: &str) -> [Plat; 2] {
    match prefer {
        "youtube" => [Plat::Yt(Src::Youtube), Plat::Sc],
        "ytmusic" => [Plat::Yt(Src::Music), Plat::Sc],
        _ => [Plat::Sc, Plat::Yt(Src::Music)],
    }
}

/// Ok(None) = searched fine but nothing close enough. Err = every search failed.
async fn match_one(sc: &SoundCloud, prefer: &str, it: &Item) -> Result<Option<Track>, String> {
    if let Some(t) = &it.track {
        return Ok(Some(t.clone()));
    }
    let [first, second] = order(prefer);
    let q1 = format!("{} {}", it.artist, it.title).trim().to_string();
    let mut tries: Vec<(Plat, String)> = vec![(first, q1.clone()), (second, q1.clone())];
    let q2 = it.title.trim().to_string();
    if !q2.is_empty() && q2 != q1 {
        tries.push((first, q2));
    }
    let full = format!("{} {}", it.artist, it.title);
    if matcher::has_cyrillic(&full) {
        let q3 = matcher::normalize(&full);
        if !q3.is_empty() && q3 != q1 {
            tries.push((first, q3));
        }
    }
    let mut ok_once = false;
    let mut last = String::new();
    // Best so far; an exact-length hit ends the search, otherwise the other platform gets a look too.
    let mut best: Option<(Track, f64)> = None;
    for (p, q) in tries {
        if q.is_empty() {
            continue;
        }
        if best.is_some() && q != q1 {
            break;
        }
        match search(sc, p, &q).await {
            Ok(list) => {
                ok_once = true;
                if let Some((t, score, exact)) = matcher::pick_scored(&it.title, &it.artist, it.duration, &list) {
                    if exact {
                        return Ok(Some(t.clone()));
                    }
                    if best.as_ref().map_or(true, |(_, s)| score > *s) {
                        best = Some((t.clone(), score));
                    }
                }
            }
            Err(e) => last = e,
        }
    }
    if let Some((t, _)) = best {
        return Ok(Some(t));
    }
    if ok_once || last.is_empty() {
        Ok(None)
    } else {
        Err(last)
    }
}

pub struct Outcome {
    pub tracks: Vec<Track>,
    pub unmatched: Vec<Item>,
    pub errors: usize,
    pub common_error: String,
    pub cancelled: bool,
}

/// Matches every item, PARALLEL at a time, keeping the original order.
pub async fn match_all(sc: &SoundCloud, prefer: &str, items: Vec<Item>, cancel: &AtomicBool, progress: impl Fn(usize, usize, usize)) -> Result<Outcome, String> {
    let total = items.len();
    let done = AtomicUsize::new(0);
    let found = AtomicUsize::new(0);
    let errs = AtomicUsize::new(0);
    let abort = AtomicBool::new(false);
    progress(0, total, 0);
    let results: Vec<(Item, Result<Option<Track>, String>)> = stream::iter(items)
        .map(|it| {
            let (done, found, errs, abort, progress) = (&done, &found, &errs, &abort, &progress);
            async move {
                if cancel.load(Ordering::Relaxed) || abort.load(Ordering::Relaxed) {
                    return (it, Ok(None));
                }
                let r = match_one(sc, prefer, &it).await;
                let d = done.fetch_add(1, Ordering::Relaxed) + 1;
                match &r {
                    Ok(Some(_)) => {
                        found.fetch_add(1, Ordering::Relaxed);
                    }
                    Err(_) => {
                        let e = errs.fetch_add(1, Ordering::Relaxed) + 1;
                        // The first 8 all failing means search itself is down.
                        if d == 8 && e == 8 {
                            abort.store(true, Ordering::Relaxed);
                        }
                    }
                    _ => {}
                }
                progress(d, total, found.load(Ordering::Relaxed));
                (it, r)
            }
        })
        .buffered(PARALLEL)
        .collect()
        .await;
    if abort.load(Ordering::Relaxed) {
        return Err("Search isn't responding, so nothing could be matched. Check your connection and try again.".into());
    }
    let mut out = Outcome { tracks: Vec::new(), unmatched: Vec::new(), errors: 0, common_error: String::new(), cancelled: cancel.load(Ordering::Relaxed) };
    let mut counts: HashMap<String, usize> = HashMap::new();
    let mut seen = std::collections::HashSet::new();
    for (it, r) in results {
        match r {
            Ok(Some(t)) => {
                if seen.insert(t.id.clone()) {
                    out.tracks.push(t);
                }
            }
            Ok(None) => out.unmatched.push(it),
            Err(e) => {
                out.errors += 1;
                *counts.entry(e).or_default() += 1;
                out.unmatched.push(it);
            }
        }
    }
    out.common_error = counts.into_iter().max_by_key(|(_, n)| *n).map(|(e, _)| e).unwrap_or_default();
    Ok(out)
}

// ------------------------------------------------------------ jobs

static JOBS: LazyLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = LazyLock::new(Default::default);

async fn run(app: &AppHandle, args: Value) -> super::Out {
    let job = args["job"].as_str().unwrap_or("import").to_string();
    let items: Vec<Item> = serde_json::from_value(args["items"].clone()).map_err(|e| format!("bad items: {e}"))?;
    if items.is_empty() {
        return Err("Nothing to import.".into());
    }
    let name = args["name"].as_str().map(str::trim).filter(|n| !n.is_empty()).unwrap_or("Imported playlist").to_string();
    let target = args["target"].as_str().filter(|t| !t.is_empty() && *t != "new").map(str::to_string);
    let prefer = args["prefer"].as_str().unwrap_or("soundcloud").to_string();
    let cancel = Arc::new(AtomicBool::new(false));
    JOBS.lock().unwrap().insert(job.clone(), cancel.clone());
    let state = app.state::<crate::AppState>();
    let sc = state.sc.clone();
    let emit_app = app.clone();
    let job_id = job.clone();
    let res = match_all(&sc, &prefer, items, &cancel, move |done, total, matched| {
        let _ = emit_app.emit("import-progress", json!({ "job": job_id, "done": done, "total": total, "matched": matched }));
    })
    .await;
    JOBS.lock().unwrap().remove(&job);
    let out = res?;
    if out.cancelled {
        return Ok(json!({ "cancelled": true, "matched": out.tracks.len() }));
    }
    let matched = out.tracks.len();
    let (playlist_id, playlist_name, added) = if matched == 0 {
        (String::new(), name, 0)
    } else {
        let mut lib = state.lib.lock().unwrap();
        let existing = target.as_deref().and_then(|t| lib.data.playlists.iter().find(|p| p.id == t).map(|p| (p.id.clone(), p.name.clone())));
        let (id, pname) = existing.unwrap_or_else(|| {
            let p = lib.create_playlist(&name);
            (p.id, p.name)
        });
        let added = lib.add_many(&id, out.tracks);
        (id, pname, added)
    };
    if matched > 0 {
        let _ = app.emit("library-changed", ());
    }
    Ok(json!({
        "playlistId": playlist_id,
        "name": playlist_name,
        "matched": matched,
        "added": added,
        "unmatched": out.unmatched,
        "errors": out.errors,
        "commonError": out.common_error,
    }))
}

pub fn setup(_app: &AppHandle) {}

pub async fn handle(app: &AppHandle, cmd: &str, args: Value) -> super::Out {
    let state = app.state::<crate::AppState>();
    let dir = state.data_dir.clone();
    match cmd {
        "fetch" => {
            let url = args["url"].as_str().unwrap_or("");
            let sc = state.sc.clone();
            Ok(json!(fetch(&sc, &dir, url).await?))
        }
        "run" => run(app, args).await,
        "cancel" => {
            if let Some(c) = JOBS.lock().unwrap().get(args["job"].as_str().unwrap_or("")) {
                c.store(true, Ordering::Relaxed);
            }
            Ok(Value::Null)
        }
        "spotify_status" => Ok(spotify::Auth::status(&dir)),
        "spotify_login" => spotify::login(&dir, args["clientId"].as_str().unwrap_or("")).await,
        "spotify_logout" => {
            spotify::Auth::logout(&dir);
            Ok(spotify::Auth::status(&dir))
        }
        "spotify_library" => spotify::library(&dir, args["likes"].as_bool().unwrap_or(true), args["playlists"].as_bool().unwrap_or(true)).await,
        _ => Err(format!("unknown imports command: {cmd}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    fn dirs() -> (SoundCloud, std::path::PathBuf) {
        let d = std::env::temp_dir().join("riff-rs-import-test");
        let _ = std::fs::create_dir_all(&d);
        (SoundCloud::new(d.clone()), d)
    }

    /// cargo test imports -- --ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn live_spotify_playlist_and_album() {
        let (sc, d) = dirs();
        let t0 = Instant::now();
        let r = fetch(&sc, &d, "https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M").await.expect("spotify playlist");
        println!("spotify playlist '{}': {} tracks (partial={}) in {:?}; first: {} / {} / {}s", r.name, r.tracks.len(), r.partial, t0.elapsed(), r.tracks[0].title, r.tracks[0].artist, r.tracks[0].duration);
        assert!(r.tracks.len() >= 20 && r.tracks.iter().all(|t| !t.title.is_empty() && !t.artist.is_empty()));
        let a = fetch(&sc, &d, "https://open.spotify.com/album/4m2880jivSbbyEGAKfITCa").await.expect("spotify album");
        println!("spotify album '{}': {} tracks; cover={}", a.name, a.tracks.len(), !a.cover.is_empty());
        assert!(a.tracks.len() >= 10);

        let t0 = Instant::now();
        let none = AtomicBool::new(false);
        let items: Vec<Item> = r.tracks.into_iter().take(20).collect();
        let n = items.len();
        for it in &items {
            let m = match_one(&sc, "soundcloud", it).await;
            println!("  {} - {} ({}s)
      -> {}", it.artist, it.title, it.duration, match m {
                Ok(Some(t)) => format!("{} / {} ({}s) [{}]", t.title, t.artist, t.duration, if t.source.is_empty() { "sc" } else { &t.source }),
                Ok(None) => "no match".into(),
                Err(e) => format!("error {e}"),
            });
        }
        let out = match_all(&sc, "soundcloud", items, &none, |_, _, _| {}).await.expect("match");
        println!("match_all: {}/{n} in {:?}", out.tracks.len(), t0.elapsed());
        assert!(out.tracks.len() * 2 >= n, "at least half should match");
    }

    #[tokio::test]
    #[ignore]
    async fn live_apple_playlist_and_album() {
        let (sc, d) = dirs();
        let t0 = Instant::now();
        let r = fetch(&sc, &d, "https://music.apple.com/us/playlist/todays-hits/pl.f4d106fed2bd41149aaacabb233eb5eb").await.expect("apple playlist");
        println!("apple playlist '{}': {}/{} tracks in {:?}; first: {} / {} / {}s; cover={}", r.name, r.tracks.len(), r.total, t0.elapsed(), r.tracks[0].title, r.tracks[0].artist, r.tracks[0].duration, r.cover);
        assert!(r.tracks.len() >= 20);
        let a = fetch(&sc, &d, "https://music.apple.com/us/album/random-access-memories/617154241").await.expect("apple album");
        println!("apple album '{}': {} tracks; first {} / {}", a.name, a.tracks.len(), a.tracks[0].title, a.tracks[0].artist);
        assert!(a.tracks.len() >= 10);
    }

    #[tokio::test]
    #[ignore]
    async fn live_soundcloud_and_youtube_links() {
        let (sc, d) = dirs();
        let r = fetch(&sc, &d, "https://soundcloud.com/lofi_girl/sets/lofi-hip-hop-radio-beats-to-relax-study-to").await;
        match &r {
            Ok(r) => println!("soundcloud set '{}': {} tracks", r.name, r.tracks.len()),
            Err(e) => println!("soundcloud set: {e}"),
        }
        let y = fetch(&sc, &d, "https://www.youtube.com/playlist?list=PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI").await.expect("youtube playlist");
        println!("youtube playlist '{}': {} tracks; first {}", y.name, y.tracks.len(), y.tracks[0].title);
        assert!(y.tracks.iter().all(|t| t.track.is_some()));
    }
}
