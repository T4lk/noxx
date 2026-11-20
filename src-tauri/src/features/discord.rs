//! Discord Rich Presence ("Listening to noxx"), customizable in Settings > Integrations.
//!
//! All Discord IPC is blocking (named pipe / unix socket), so it lives on one
//! dedicated `std::thread`. Commands from the UI only push a message into a
//! channel and return immediately; the worker connects, retries every
//! `RETRY_EVERY` while Discord isn't running, and re-applies the last
//! presence after (re)connecting. Nothing here can block the async runtime or
//! fail when Discord is absent.

use std::path::PathBuf;
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use discord_rich_presence::activity::{Activity, ActivityType, Assets, Button, StatusDisplayType, Timestamps};
use discord_rich_presence::{DiscordIpc, DiscordIpcClient};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

const CLIENT_ID: &str = "1573013030122426418";
/// Art asset key uploaded to the Discord application (Rich Presence > Art Assets).
const LOGO_ASSET: &str = "noxx";
const RETRY_EVERY: Duration = Duration::from_secs(30);
const STATUS_EVENT: &str = "discord-status";

/// What the UI sends for the current track.
#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
#[serde(default)]
pub struct Presence {
    pub title: String,
    pub artist: String,
    pub artwork: String,
    pub url: String,
    pub source: String,
    /// seconds
    pub duration: f64,
    /// seconds into the track
    pub position: f64,
    pub paused: bool,
}

/// What the presence looks like (Settings > Integrations > Discord). Templates take
/// {title}, {artist} and {source}.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Config {
    /// What follows "Listening to" in the member list: "song" (line 1), "artist" (line 2) or "app" (noxx).
    pub status_shows: String,
    pub line1: String,
    pub line2: String,
    /// "cover" | "logo" | "none"
    pub large_image: String,
    pub large_text: String,
    /// noxx logo in the corner of the cover
    pub small_logo: bool,
    /// "progress" (bar with both times) | "elapsed" | "none"
    pub time: String,
    /// "Listen on SoundCloud / YouTube" button
    pub listen_button: bool,
    pub custom_label: String,
    pub custom_url: String,
    /// Keep the presence while paused (otherwise it's cleared).
    pub show_paused: bool,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            status_shows: "song".into(),
            line1: "{title}".into(),
            line2: "{artist}".into(),
            large_image: "cover".into(),
            large_text: "{title}".into(),
            small_logo: true,
            time: "progress".into(),
            listen_button: true,
            custom_label: String::new(),
            custom_url: String::new(),
            show_paused: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Status {
    pub enabled: bool,
    pub connected: bool,
    pub user: Option<String>,
    pub error: Option<String>,
    /// Title currently shown on the profile, if any.
    pub showing: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct Saved {
    enabled: bool,
    #[serde(default)]
    config: Config,
}

enum Msg {
    Update(Presence),
    Clear,
    Enabled(bool),
    Refresh,
}

struct Shared {
    tx: Mutex<Sender<Msg>>,
    status: Mutex<Status>,
    config: Mutex<Config>,
    file: PathBuf,
    app: AppHandle,
}

static SHARED: OnceLock<Shared> = OnceLock::new();

fn shared() -> Result<&'static Shared, String> {
    SHARED.get().ok_or_else(|| "discord: not started".to_string())
}

fn status_now() -> Status {
    SHARED.get().map(|s| s.status.lock().unwrap().clone()).unwrap_or(Status {
        enabled: false,
        connected: false,
        user: None,
        error: Some("not started".into()),
        showing: None,
    })
}

/// Mutates the shared status and tells the UI when something changed.
fn set_status(f: impl FnOnce(&mut Status)) {
    let Some(s) = SHARED.get() else { return };
    let snapshot = {
        let mut st = s.status.lock().unwrap();
        let before = st.clone();
        f(&mut st);
        if *st == before {
            return;
        }
        st.clone()
    };
    let _ = s.app.emit(STATUS_EVENT, snapshot);
}

pub fn setup(app: &AppHandle) {
    let file = app.state::<crate::AppState>().data_dir.join("discord.json");
    let saved = std::fs::read(&file).ok().and_then(|b| serde_json::from_slice::<Saved>(&b).ok());
    let enabled = saved.as_ref().map(|s| s.enabled).unwrap_or(true); // on by default, like riff
    let config = saved.map(|s| s.config).unwrap_or_default();
    let (tx, rx) = mpsc::channel::<Msg>();
    let shared = Shared {
        tx: Mutex::new(tx),
        status: Mutex::new(Status { enabled, connected: false, user: None, error: None, showing: None }),
        config: Mutex::new(config),
        file,
        app: app.clone(),
    };
    if SHARED.set(shared).is_err() {
        return;
    }
    let spawned = std::thread::Builder::new().name("discord-rpc".into()).spawn(move || worker(rx, enabled));
    if let Err(e) = spawned {
        eprintln!("[discord] could not start worker: {e}");
    }
}

pub async fn handle(_app: &AppHandle, cmd: &str, args: Value) -> super::Out {
    match cmd {
        "status" => Ok(json!(status_now())),
        "setEnabled" => {
            let enabled = args.get("enabled").and_then(Value::as_bool).ok_or("discord.setEnabled: missing `enabled`")?;
            let s = shared()?;
            crate::soundcloud::write_json(&s.file, &Saved { enabled, config: config_now() });
            set_status(|st| st.enabled = enabled);
            send(Msg::Enabled(enabled))?;
            Ok(json!(status_now()))
        }
        "update" => {
            send(Msg::Update(parse(args)?))?;
            Ok(Value::Null)
        }
        "clear" => {
            send(Msg::Clear)?;
            Ok(Value::Null)
        }
        "config" => Ok(json!(config_now())),
        "setConfig" => {
            let c: Config = serde_json::from_value(args.get("config").cloned().unwrap_or(args))
                .map_err(|e| format!("discord: bad config: {e}"))?;
            let s = shared()?;
            *s.config.lock().unwrap() = c.clone();
            crate::soundcloud::write_json(&s.file, &Saved { enabled: status_now().enabled, config: c });
            send(Msg::Refresh)?;
            Ok(json!(config_now()))
        }
        // Pure: the activity JSON `update` would send (no IPC; used by the settings preview and
        // the selftest). Optional `config` previews unsaved settings. null = presence cleared.
        "preview" => {
            let p = parse(args.clone())?;
            let cfg = match args.get("config") {
                Some(c) => serde_json::from_value(c.clone()).map_err(|e| format!("discord: bad config: {e}"))?,
                None => config_now(),
            };
            serde_json::to_value(build_activity(&p, now_ms(), &cfg)).map_err(|e| e.to_string())
        }
        _ => Err(format!("discord: unknown command {cmd}")),
    }
}

fn parse(args: Value) -> Result<Presence, String> {
    let v = args.get("track").cloned().unwrap_or(args);
    serde_json::from_value(v).map_err(|e| format!("discord: bad track: {e}"))
}

fn config_now() -> Config {
    SHARED.get().map(|s| s.config.lock().unwrap().clone()).unwrap_or_default()
}

fn send(m: Msg) -> Result<(), String> {
    shared()?.tx.lock().unwrap().send(m).map_err(|_| "discord: worker stopped".to_string())
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

// ------------------------------------------------------------------ activity

/// Discord wants 2..=max chars for text fields (counted in chars, not bytes).
fn clip(s: &str, max: usize) -> String {
    let s = s.trim();
    let mut out = if s.chars().count() > max {
        s.chars().take(max - 1).collect::<String>() + "…"
    } else {
        s.to_string()
    };
    while out.chars().count() < 2 {
        out.push('\u{2800}');
    }
    out
}

/// Only public web URLs mean anything to Discord (not asset:// or the
/// `http://asset.localhost` form Tauri uses for local files on Windows).
fn is_web(url: &str) -> bool {
    let Ok(u) = url::Url::parse(url) else { return false };
    let host = u.host_str().unwrap_or("");
    matches!(u.scheme(), "http" | "https")
        && !host.is_empty()
        && host != "localhost"
        && !host.ends_with(".localhost")
        && host != "127.0.0.1"
        && host != "[::1]"
}

fn button_label(p: &Presence, url: &str) -> &'static str {
    if url.contains("youtube.com") || url.contains("youtu.be") {
        "Listen on YouTube"
    } else if p.source.is_empty() || url.contains("soundcloud.com") {
        "Listen on SoundCloud"
    } else {
        "Open track"
    }
}

fn source_name(p: &Presence) -> &'static str {
    let u = p.url.as_str();
    if p.source == "local" || p.source == "file" {
        "Local file"
    } else if u.contains("music.youtube.com") || p.source == "ytmusic" {
        "YouTube Music"
    } else if p.source == "youtube" || u.contains("youtube.com") || u.contains("youtu.be") {
        "YouTube"
    } else {
        "SoundCloud"
    }
}

/// Fills {title} / {artist} / {source}.
fn render(tpl: &str, p: &Presence) -> String {
    let title = if p.title.trim().is_empty() { "Unknown Track" } else { p.title.trim() };
    let artist = if p.artist.trim().is_empty() { "Unknown Artist" } else { p.artist.trim() };
    tpl.replace("{title}", title).replace("{artist}", artist).replace("{source}", source_name(p)).trim().to_string()
}

/// The SET_ACTIVITY payload for `p` under `cfg`; None = show nothing (paused with "show paused" off).
pub fn build_activity(p: &Presence, now: i64, cfg: &Config) -> Option<Activity<'static>> {
    if p.paused && !cfg.show_paused {
        return None;
    }
    let line1 = render(&cfg.line1, p);
    let line2 = render(&cfg.line2, p);
    let shows = match cfg.status_shows.as_str() {
        "artist" if !line2.is_empty() => StatusDisplayType::State,
        "app" => StatusDisplayType::Name,
        _ if !line1.is_empty() => StatusDisplayType::Details,
        _ => StatusDisplayType::Name,
    };
    let mut a = Activity::new().activity_type(ActivityType::Listening).status_display_type(shows);
    if !line1.is_empty() {
        a = a.details(clip(&line1, 128));
    }
    if !line2.is_empty() {
        a = a.state(clip(&line2, 128));
    }
    // Paused: no clock (Discord would keep counting).
    if !p.paused && cfg.time != "none" {
        let start = now - (p.position.max(0.0) * 1000.0) as i64;
        let mut ts = Timestamps::new().start(start);
        if cfg.time == "progress" && p.duration > 0.0 {
            ts = ts.end(start + (p.duration * 1000.0) as i64);
        }
        a = a.timestamps(ts);
    }

    let hover = render(&cfg.large_text, p);
    let cover = is_web(&p.artwork) && p.artwork.len() <= 256;
    let large = match cfg.large_image.as_str() {
        "none" => None,
        "logo" => Some(LOGO_ASSET.to_string()),
        _ if cover => Some(p.artwork.clone()),
        _ => Some(LOGO_ASSET.to_string()), // local files: no web cover
    };
    let mut assets = Assets::new();
    let mut any = false;
    let big_is_logo = large.as_deref() == Some(LOGO_ASSET);
    if let Some(img) = large.clone() {
        assets = assets.large_image(img);
        if !hover.is_empty() {
            assets = assets.large_text(clip(&hover, 128));
        }
        any = true;
    }
    // The small logo only makes sense next to a cover, or to say "Paused".
    if large.is_some() && (p.paused || (cfg.small_logo && !big_is_logo)) {
        let text = if p.paused { "Paused" } else { "noxx" };
        assets = assets.small_image(LOGO_ASSET.to_string()).small_text(text.to_string());
        any = true;
    }
    if any {
        a = a.assets(assets);
    }

    let mut buttons = Vec::new();
    if cfg.listen_button && is_web(&p.url) && p.url.len() <= 512 {
        buttons.push(Button::new(button_label(p, &p.url), p.url.clone()));
    }
    let label = render(&cfg.custom_label, p);
    let url = cfg.custom_url.trim();
    if !label.is_empty() && is_web(url) && url.len() <= 512 {
        buttons.push(Button::new(clip(&label, 32), url.to_string()));
    }
    if !buttons.is_empty() {
        a = a.buttons(buttons);
    }
    Some(a)
}

// ------------------------------------------------------------------ worker

fn connect() -> Result<(DiscordIpcClient, Option<String>), String> {
    let mut client = DiscordIpcClient::new(CLIENT_ID);
    client.connect_ipc().map_err(|_| "Discord isn't running".to_string())?;
    client.send(json!({ "v": 1, "client_id": CLIENT_ID }), 0).map_err(|e| e.to_string())?;
    let (op, reply) = client.recv().map_err(|e| e.to_string())?;
    if op != 1 || reply.get("evt").and_then(Value::as_str) != Some("READY") {
        let msg = reply.get("message").and_then(Value::as_str).unwrap_or("handshake rejected");
        return Err(msg.to_string());
    }
    let user = reply
        .pointer("/data/user/global_name")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .or_else(|| reply.pointer("/data/user/username").and_then(Value::as_str))
        .map(str::to_string);
    Ok((client, user))
}

/// Sends SET_ACTIVITY (or a clear) and reads Discord's reply, which keeps the
/// pipe drained. `Err` = connection lost; `Ok(Some(msg))` = payload rejected.
fn exchange(client: &mut DiscordIpcClient, activity: Option<Activity<'static>>) -> Result<Option<String>, String> {
    let sent = match activity {
        Some(a) => client.set_activity(a),
        None => client.clear_activity(),
    };
    sent.map_err(|e| e.to_string())?;
    let (op, reply) = client.recv().map_err(|e| e.to_string())?;
    if op == 2 {
        return Err("Discord closed the connection".into());
    }
    if reply.get("evt").and_then(Value::as_str) == Some("ERROR") {
        let msg = reply.pointer("/data/message").and_then(Value::as_str).unwrap_or("rejected");
        return Ok(Some(msg.to_string()));
    }
    Ok(None)
}

fn disconnected(error: Option<String>) {
    set_status(|s| {
        s.connected = false;
        s.user = None;
        s.showing = None;
        s.error = error;
    });
}

fn worker(rx: mpsc::Receiver<Msg>, mut enabled: bool) {
    let mut conn: Option<DiscordIpcClient> = None;
    let mut current: Option<Presence> = None;
    // When `current` was received, so a later (re)connect shows the right progress.
    let mut current_at = Instant::now();
    let mut next_try = Instant::now();
    // Discord hasn't been told about `current` yet (set or clear).
    let mut dirty = false;

    loop {
        if enabled && conn.is_none() && Instant::now() >= next_try {
            match connect() {
                Ok((c, user)) => {
                    conn = Some(c);
                    dirty = current.is_some();
                    set_status(|s| {
                        s.connected = true;
                        s.user = user;
                        s.error = None;
                    });
                }
                Err(e) => {
                    next_try = Instant::now() + RETRY_EVERY;
                    disconnected(Some(e));
                }
            }
        }

        if dirty {
            if let Some(c) = conn.as_mut() {
                let cfg = config_now();
                let act = current.as_ref().and_then(|p| {
                    let mut p = p.clone();
                    if !p.paused {
                        p.position += current_at.elapsed().as_secs_f64();
                    }
                    build_activity(&p, now_ms(), &cfg)
                });
                let showing = if act.is_some() { current.as_ref().map(|p| p.title.clone()) } else { None };
                match exchange(c, act) {
                    Ok(rejected) => {
                        dirty = false;
                        set_status(|s| {
                            s.showing = if rejected.is_none() { showing } else { None };
                            s.error = rejected;
                        });
                    }
                    Err(e) => {
                        conn = None;
                        // Discord may have just restarted: try again right away, then every RETRY_EVERY.
                        next_try = Instant::now();
                        disconnected(Some(e));
                        continue;
                    }
                }
            }
        }

        let wait = if enabled && conn.is_none() {
            next_try.saturating_duration_since(Instant::now()).max(Duration::from_millis(50))
        } else {
            Duration::from_secs(3600)
        };
        match rx.recv_timeout(wait) {
            Ok(Msg::Update(p)) => {
                current = Some(p);
                current_at = Instant::now();
                dirty = true;
            }
            Ok(Msg::Refresh) => {
                dirty = conn.is_some();
            }
            Ok(Msg::Clear) => {
                current = None;
                dirty = conn.is_some();
            }
            Ok(Msg::Enabled(on)) => {
                enabled = on;
                if on {
                    next_try = Instant::now();
                    dirty = current.is_some();
                } else {
                    if let Some(mut c) = conn.take() {
                        let _ = exchange(&mut c, None);
                        let _ = c.close();
                    }
                    disconnected(None);
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }
    if let Some(mut c) = conn {
        let _ = exchange(&mut c, None);
        let _ = c.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn track() -> Presence {
        Presence {
            title: "Song".into(),
            artist: "Artist".into(),
            artwork: "https://i1.sndcdn.com/artworks-x-t500x500.jpg".into(),
            url: "https://soundcloud.com/a/song".into(),
            source: String::new(),
            duration: 200.0,
            position: 50.0,
            paused: false,
        }
    }

    fn act(p: &Presence, now: i64, c: &Config) -> Value {
        serde_json::to_value(build_activity(p, now, c).expect("shown")).unwrap()
    }

    #[test]
    fn activity_fields() {
        let v = act(&track(), 1_000_000, &Config::default());
        assert_eq!(v["type"], 2);
        assert_eq!(v["status_display_type"], 2);
        assert_eq!(v["details"], "Song");
        assert_eq!(v["state"], "Artist");
        assert_eq!(v["timestamps"]["start"], 1_000_000 - 50_000);
        assert_eq!(v["timestamps"]["end"], 1_000_000 - 50_000 + 200_000);
        assert_eq!(v["assets"]["large_image"], "https://i1.sndcdn.com/artworks-x-t500x500.jpg");
        assert_eq!(v["buttons"][0]["label"], "Listen on SoundCloud");
        assert_eq!(v["buttons"][0]["url"], "https://soundcloud.com/a/song");
    }

    #[test]
    fn local_tracks_skip_image_and_button() {
        let p = Presence {
            artwork: "asset://localhost/C%3A/x.jpg".into(),
            url: String::new(),
            source: "local".into(),
            duration: 0.0,
            ..track()
        };
        let v = act(&p, 5_000, &Config::default());
        assert_eq!(v["assets"]["large_image"], "noxx");
        assert!(v.get("buttons").is_none());
        assert!(v["timestamps"].get("end").is_none());
        assert!(!is_web("http://asset.localhost/C%3A/x.jpg"));
        assert!(!is_web("file:///C:/x.jpg"));
        assert!(is_web("https://i1.sndcdn.com/a.jpg"));
    }

    #[test]
    fn text_limits() {
        assert_eq!(clip("a", 128).chars().count(), 2);
        let c = clip(&"x".repeat(300), 128);
        assert_eq!(c.chars().count(), 128);
        assert!(c.ends_with('…'));
        assert_eq!(clip("  hello  ", 128), "hello");
        let blank = act(&Presence::default(), 0, &Config::default());
        assert_eq!(blank["details"], "Unknown Track");
        assert_eq!(blank["state"], "Unknown Artist");
    }

    #[test]
    fn config_artist_status_and_templates() {
        let c = Config { status_shows: "artist".into(), line1: "{artist} - {title}".into(), line2: "on {source}".into(), ..Config::default() };
        let v = act(&track(), 0, &c);
        assert_eq!(v["status_display_type"], 1); // State
        assert_eq!(v["details"], "Artist - Song");
        assert_eq!(v["state"], "on SoundCloud");
        let app = act(&track(), 0, &Config { status_shows: "app".into(), ..Config::default() });
        assert_eq!(app["status_display_type"], 0); // Name: "Listening to noxx"
    }

    #[test]
    fn config_images_time_buttons() {
        let c = Config {
            large_image: "logo".into(),
            time: "elapsed".into(),
            listen_button: false,
            custom_label: "Get noxx".into(),
            custom_url: "https://github.com/T4lk/noxx".into(),
            ..Config::default()
        };
        let v = act(&track(), 1_000, &c);
        assert_eq!(v["assets"]["large_image"], "noxx");
        assert!(v["assets"].get("small_image").is_none());
        assert!(v["timestamps"].get("end").is_none());
        assert_eq!(v["buttons"].as_array().unwrap().len(), 1);
        assert_eq!(v["buttons"][0]["label"], "Get noxx");
        let none = act(&track(), 0, &Config { large_image: "none".into(), time: "none".into(), ..Config::default() });
        assert!(none.get("assets").is_none());
        assert!(none.get("timestamps").is_none());
        let bad = act(&track(), 0, &Config { listen_button: false, custom_label: "x".into(), custom_url: "javascript:alert(1)".into(), ..Config::default() });
        assert!(bad.get("buttons").is_none());
    }

    #[test]
    fn config_paused() {
        let p = Presence { paused: true, ..track() };
        assert!(build_activity(&p, 0, &Config::default()).is_none());
        let v = act(&p, 0, &Config { show_paused: true, ..Config::default() });
        assert!(v.get("timestamps").is_none());
        assert_eq!(v["assets"]["small_text"], "Paused");
    }

    #[test]
    fn config_old_file_still_loads() {
        let s: Saved = serde_json::from_str(r#"{"enabled":false}"#).unwrap();
        assert!(!s.enabled);
        assert_eq!(s.config, Config::default());
    }

    #[test]
    fn parse_accepts_wrapped_or_flat() {
        let a = parse(json!({ "track": { "title": "T", "duration": 3 } })).unwrap();
        let b = parse(json!({ "title": "T", "duration": 3 })).unwrap();
        assert_eq!(a, b);
        assert_eq!(a.duration, 3.0);
    }

    /// Talks to a real Discord client if one is running.
    #[test]
    #[ignore]
    fn live_connect() {
        let (mut c, user) = connect().expect("discord running");
        println!("connected as {user:?}");
        assert_eq!(exchange(&mut c, build_activity(&track(), now_ms(), &Config::default())).unwrap(), None);
        assert_eq!(exchange(&mut c, None).unwrap(), None);
    }
}
