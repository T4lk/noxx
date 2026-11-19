pub(crate) mod library;
pub(crate) mod soundcloud;
mod browser_login;
mod features;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Emitter, Manager, State, Url, WebviewUrl, WebviewWindowBuilder};

use library::{Library, LibraryData, LocalPlaylist, SyncResult};
use soundcloud::{PlaylistSummary, ScError, SoundCloud, Status, StreamInfo, Track};

const LIKES_SYNC_EVERY: Duration = Duration::from_secs(30 * 60);
const MAX_LIKES: usize = 5000;
const LOGIN_LABEL: &str = "sc-login";

pub(crate) struct AppState {
    pub(crate) sc: Arc<SoundCloud>,
    pub(crate) lib: Mutex<Library>,
    pub(crate) sync_lock: tokio::sync::Mutex<()>,
    pub(crate) data_dir: PathBuf,
}

type Res<T> = Result<T, ScError>;

fn err(e: impl std::fmt::Display) -> ScError {
    ScError::Msg(e.to_string())
}

// ------------------------------------------------------------------
// SoundCloud account
// ------------------------------------------------------------------

#[tauri::command]
fn sc_status(state: State<'_, AppState>) -> Status {
    state.sc.status()
}

#[tauri::command]
async fn sc_use_token(app: AppHandle, state: State<'_, AppState>, token: String) -> Res<Status> {
    let status = state.sc.login_with_token(&token).await?;
    after_login(&app);
    Ok(status)
}

/// Sign in through the default browser (see browser_login.rs). Resolves once the
/// browser hands the login over, or errors after 10 minutes.
#[tauri::command]
async fn sc_login_browser(app: AppHandle) -> Result<Status, String> {
    let a = app.clone();
    tauri::async_runtime::spawn_blocking(move || browser_login::run(a)).await.map_err(|e| e.to_string())??;
    after_login(&app);
    Ok(app.state::<AppState>().sc.status())
}

#[tauri::command]
fn sc_logout(state: State<'_, AppState>) {
    state.sc.logout();
    // Next sign-in starts from a clean cookie jar instead of reusing this login.
    let _ = std::fs::write(state.data_dir.join("sc-login-reset"), b"1");
}

fn reset_marker(state: &AppState) -> PathBuf {
    state.data_dir.join("sc-login-reset")
}

fn is_login_host(url: &Url) -> bool {
    let host = url.host_str().unwrap_or("").to_ascii_lowercase();
    ["soundcloud.com", "sndcdn.com", "accounts.google.com", "appleid.apple.com", "facebook.com", "google.com", "gstatic.com"]
        .iter()
        .any(|d| host == *d || host.ends_with(&format!(".{d}")))
}

fn read_oauth_cookie(win: &tauri::WebviewWindow) -> Option<String> {
    let url = Url::parse("https://soundcloud.com/").ok()?;
    win.cookies_for_url(url)
        .ok()?
        .into_iter()
        .find(|c| c.name().eq_ignore_ascii_case("oauth_token") && !c.value().trim().is_empty())
        .map(|c| c.value().trim().to_string())
}

/// Opens soundcloud.com in its own window (separate cookie jar) and waits for
/// the `oauth_token` cookie the site sets after a successful sign-in.
#[tauri::command]
async fn sc_login(app: AppHandle, state: State<'_, AppState>, force: bool) -> Res<Status> {
    if let Some(w) = app.get_webview_window(LOGIN_LABEL) {
        let _ = w.set_focus();
        return Err(err("The sign-in window is already open."));
    }
    let force = force || reset_marker(&state).exists();
    let profile = state.data_dir.join("sc-login-webview");
    let blank = Url::parse("about:blank").unwrap();
    let win = WebviewWindowBuilder::new(&app, LOGIN_LABEL, WebviewUrl::External(blank))
        .title("SoundCloud sign in")
        .inner_size(960.0, 780.0)
        .min_inner_size(700.0, 560.0)
        .data_directory(profile)
        .visible(false)
        .on_new_window(|url, _| {
            // Google / Apple / Facebook sign-in popups stay in this cookie jar.
            if is_login_host(&url) {
                NewWindowResponse::Allow
            } else {
                NewWindowResponse::Deny
            }
        })
        .build()
        .map_err(err)?;

    if force {
        let _ = win.clear_all_browsing_data();
        let _ = std::fs::remove_file(reset_marker(&state));
    }

    // Reuse a still-valid login from this window's cookie jar.
    let mut tried = String::new();
    if !force {
        if let Some(token) = read_oauth_cookie(&win) {
            tried = token.clone();
            if let Ok(status) = state.sc.login_with_token(&token).await {
                let _ = win.close();
                after_login(&app);
                return Ok(status);
            }
        }
    }

    win.navigate(Url::parse("https://soundcloud.com/signin").unwrap()).map_err(err)?;
    let _ = win.show();
    let _ = win.set_focus();

    for _ in 0..(20 * 60) {
        tokio::time::sleep(Duration::from_secs(1)).await;
        let Some(win) = app.get_webview_window(LOGIN_LABEL) else {
            return Err(err("The sign-in window was closed."));
        };
        let Some(token) = read_oauth_cookie(&win) else { continue };
        if token == tried {
            continue;
        }
        tried = token.clone();
        if let Ok(status) = state.sc.login_with_token(&token).await {
            let _ = win.close();
            after_login(&app);
            return Ok(status);
        }
    }
    if let Some(w) = app.get_webview_window(LOGIN_LABEL) {
        let _ = w.close();
    }
    Err(err("Sign-in timed out."))
}

fn after_login(app: &AppHandle) {
    let status = app.state::<AppState>().sc.status();
    let _ = app.emit("sc-status", status);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = sync_likes_inner(&app).await;
    });
}

// ------------------------------------------------------------------
// browsing / playback
// ------------------------------------------------------------------

#[tauri::command]
async fn search(state: State<'_, AppState>, query: String, offset: Option<u32>) -> Res<Vec<Track>> {
    state.sc.search(&query, offset.unwrap_or(0)).await
}

#[tauri::command]
async fn trending(state: State<'_, AppState>) -> Res<Vec<Track>> {
    state.sc.trending().await
}

#[tauri::command]
async fn sc_playlists(state: State<'_, AppState>) -> Res<Vec<PlaylistSummary>> {
    state.sc.my_playlists().await
}

#[tauri::command]
async fn sc_playlist_tracks(state: State<'_, AppState>, id: String) -> Res<Vec<Track>> {
    state.sc.playlist_tracks(&id).await
}

#[tauri::command]
async fn stream_url(state: State<'_, AppState>, id: String, fresh: Option<bool>) -> Res<StreamInfo> {
    if fresh == Some(true) {
        state.sc.forget_stream(&id);
    }
    state.sc.stream(&id).await
}

// ------------------------------------------------------------------
// likes sync
// ------------------------------------------------------------------

async fn sync_likes_inner(app: &AppHandle) -> Res<SyncResult> {
    let state = app.state::<AppState>();
    if !state.sc.is_logged_in() {
        return Err(ScError::NotLoggedIn);
    }
    let _guard = state.sync_lock.lock().await;
    let liked = state.sc.liked_tracks(MAX_LIKES).await?;
    if liked.is_empty() {
        // Never wipe synced likes on an empty answer.
        return Ok(SyncResult { added: 0, removed: 0, changed: false });
    }
    let result = state.lib.lock().unwrap().apply_likes(liked);
    if result.changed {
        let _ = app.emit("library-changed", result);
    }
    Ok(result)
}

#[tauri::command]
async fn sync_likes(app: AppHandle) -> Res<SyncResult> {
    sync_likes_inner(&app).await
}

// ------------------------------------------------------------------
// local library
// ------------------------------------------------------------------

#[tauri::command]
fn get_library(state: State<'_, AppState>) -> LibraryData {
    state.lib.lock().unwrap().data.clone()
}

#[tauri::command]
async fn toggle_favorite(app: AppHandle, state: State<'_, AppState>, track: Track) -> Res<bool> {
    let id = track.id.clone();
    let from_sc = track.source.is_empty() || track.source == "soundcloud";
    let on = state.lib.lock().unwrap().toggle_favorite(track);
    // Hearts on SoundCloud tracks are mirrored to the account (like / unlike) when signed in.
    if from_sc && state.sc.is_logged_in() && id.bytes().all(|b| b.is_ascii_digit()) {
        let sc = state.sc.clone();
        tauri::async_runtime::spawn(async move {
            let res = sc.set_like(&id, on).await;
            let st = app.state::<AppState>();
            match res {
                Ok(()) => {
                    st.lib.lock().unwrap().mark_synced_like(&id, on);
                    let _ = app.emit("library-changed", ());
                }
                Err(e) => {
                    let what = if on { "like" } else { "unlike" };
                    let _ = app.emit("sc-like-error", format!("Couldn't {what} it on SoundCloud: {e}"));
                }
            }
        });
    }
    Ok(on)
}

#[tauri::command]
fn is_favorite(state: State<'_, AppState>, id: String) -> bool {
    state.lib.lock().unwrap().is_favorite(&id)
}

#[tauri::command]
fn playlist_create(state: State<'_, AppState>, name: String) -> LocalPlaylist {
    state.lib.lock().unwrap().create_playlist(&name)
}

#[tauri::command]
fn playlist_delete(state: State<'_, AppState>, id: String) {
    state.lib.lock().unwrap().delete_playlist(&id)
}

#[tauri::command]
fn playlist_rename(state: State<'_, AppState>, id: String, name: String) {
    state.lib.lock().unwrap().rename_playlist(&id, &name)
}

#[tauri::command]
fn playlist_add(state: State<'_, AppState>, id: String, track: Track) -> bool {
    state.lib.lock().unwrap().add_to_playlist(&id, track)
}

#[tauri::command]
fn playlist_remove(state: State<'_, AppState>, id: String, track_id: String) {
    state.lib.lock().unwrap().remove_from_playlist(&id, &track_id)
}

/// Frontend errors and notes end up in the terminal that launched the app.
#[tauri::command]
fn log_js(app: AppHandle, level: String, message: String) {
    features::about::line(&app, &format!("ui:{level}"), &message);
}

/// RIFF_SELFTEST=1 runs a muted search → play → library check on start (dev aid).
#[tauri::command]
fn selftest_mode() -> bool {
    std::env::var("RIFF_SELFTEST").is_ok_and(|v| v == "1")
}

/// Generic entry for feature modules (see features/mod.rs): name = "module.cmd".
#[tauri::command]
async fn feature(app: AppHandle, name: String, args: Option<serde_json::Value>) -> Result<serde_json::Value, String> {
    features::dispatch(&app, &name, args.unwrap_or(serde_json::Value::Null)).await
}

// ------------------------------------------------------------------

/// Portable mode: a file named `portable` next to the exe keeps every bit of app data
/// (library, login, settings, WebView profile) in a `data` folder beside it.
pub(crate) fn portable_dir() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    dir.join("portable").is_file().then(|| dir.join("data"))
}

/// Startup trace in `<data>/logs/startup.log`, written straight to disk (the normal log needs
/// AppState, which doesn't exist yet). If a launch ever stalls, the last line shows where.
fn boot_log(step: &str) {
    use std::io::Write;
    let dir = portable_dir().or_else(|| std::env::var_os("APPDATA").map(|d| PathBuf::from(d).join("dev.riffrs.player")));
    let Some(dir) = dir.map(|d| d.join("logs")) else { return };
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("startup.log");
    if std::fs::metadata(&path).map(|m| m.len() > 256 * 1024).unwrap_or(false) {
        let _ = std::fs::remove_file(&path);
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
        let _ = writeln!(f, "{t} pid {} {step}", std::process::id());
    }
}

pub fn run() {
    boot_log(&format!("start {}", std::env::current_exe().map(|p| p.display().to_string()).unwrap_or_default()));
    if let Some(dir) = portable_dir() {
        let web = dir.join("webview");
        let _ = std::fs::create_dir_all(&web);
        // WebView2 reads this before Tauri's own data folder.
        std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", &web);
    }
    let mut builder = tauri::Builder::default();
    // Settings → Advanced → Allow multiple instances (off: a second launch focuses this window).
    // RIFF_SELFTEST runs alongside a normal copy, so it skips the check.
    if !features::system::early_settings().multi_instance && std::env::var_os("RIFF_SELFTEST").is_none() {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| features::system::show_main(app)));
    }
    boot_log("plugins: single-instance checked");
    builder
        .plugin(features::system::shortcut_plugin())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            boot_log("setup: begin");
            let data_dir = match portable_dir() {
                Some(d) => d,
                None => app.path().app_data_dir()?,
            };
            std::fs::create_dir_all(&data_dir)?;
            {
                let f = |n: &str| match std::fs::read(data_dir.join(n)) {
                    Ok(b) => format!("{n} {} bytes", b.len()),
                    Err(e) => format!("{n} unreadable ({e})"),
                };
                boot_log(&format!("setup: data dir {} | {} | {}", data_dir.display(), f("soundcloud-session.json"), f("library.json")));
            }
            let sc = Arc::new(SoundCloud::new(data_dir.clone()));
            let handle = app.handle().clone();
            sc.set_on_expired(move || {
                let status = handle.state::<AppState>().sc.status();
                let _ = handle.emit("sc-status", status);
            });
            app.manage(AppState {
                sc,
                lib: Mutex::new(Library::load(&data_dir)),
                sync_lock: tokio::sync::Mutex::new(()),
                data_dir,
            });
            boot_log(&format!("setup: state ready (signed in: {})", app.state::<AppState>().sc.is_logged_in()));

            // Likes sync on launch, then every 30 minutes.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    let _ = sync_likes_inner(&handle).await;
                    tokio::time::sleep(LIKES_SYNC_EVERY).await;
                }
            });
            features::setup(app.handle());
            boot_log("setup: features ready");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            sc_status,
            sc_login,
            sc_use_token,
            sc_login_browser,
            sc_logout,
            search,
            trending,
            sc_playlists,
            sc_playlist_tracks,
            stream_url,
            sync_likes,
            get_library,
            toggle_favorite,
            is_favorite,
            playlist_create,
            playlist_delete,
            playlist_rename,
            playlist_add,
            playlist_remove,
            log_js,
            selftest_mode,
            feature,
        ])
        .run(tauri::generate_context!())
        .expect("error while running riff-rs");
}
