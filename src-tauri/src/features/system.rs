//! App-level settings riff keeps under Advanced / Storage / Plugins:
//! close-to-tray, global media keys, single instance, cache size + clearing,
//! and the plugins folder.
//!
//! Commands (`riff.call('system.<cmd>', args)`):
//!   settings                          -> { trayOnClose, mediaKeys, multiInstance }
//!   set { key, value }                -> settings (applied live; multiInstance after restart)
//!   cache_size                        -> { audio, web } in bytes
//!   clear_cache { audio?, web? }       -> { audio, web } sizes after clearing (+ webError)
//!   plugins_list                      -> [{ file, name, author, version, description, enabled, code }]
//!   plugins_set { file, on }          -> null
//!   plugins_disable_all               -> null
//!   plugins_remove { file }           -> null
//!   plugins_import { paths }          -> number added
//!   plugins_open_folder               -> null
//!   plugins_dir                       -> path
//!
//! Events: "media-key" with "playpause" | "next" | "prev" | "stop".

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WindowEvent};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Shortcut, ShortcutState};

const SETTINGS_FILE: &str = "settings.json";
const IDENTIFIER: &str = "dev.riffrs.player";
const MAX_PLUGIN_BYTES: u64 = 1024 * 1024;
const EXAMPLE_PLUGIN: &str = "/**\n * @name Hello plugin\n * @author Riff\n * @version 1.0.0\n * @description Shows a message when the track changes. Edit or delete this file.\n */\nconst off = Riff.on('trackchange', (track) => Riff.toast('Now playing: ' + track.title));\nreturn { stop() { off(); } };\n";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub tray_on_close: bool,
    pub media_keys: bool,
    pub multi_instance: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings { tray_on_close: true, media_keys: true, multi_instance: false }
    }
}

static SETTINGS: OnceLock<Mutex<Settings>> = OnceLock::new();
static QUITTING: AtomicBool = AtomicBool::new(false);

fn settings() -> std::sync::MutexGuard<'static, Settings> {
    SETTINGS.get_or_init(|| Mutex::new(Settings::default())).lock().unwrap_or_else(|e| e.into_inner())
}

fn read_settings(dir: &Path) -> Settings {
    std::fs::read(dir.join(SETTINGS_FILE)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

/// Settings read before the Tauri builder exists (single-instance has to be
/// decided there). Same folder as `app_data_dir()` on Windows.
pub fn early_settings() -> Settings {
    std::env::var_os("APPDATA")
        .map(|d| read_settings(&PathBuf::from(d).join(IDENTIFIER)))
        .unwrap_or_default()
}

fn data_dir(app: &AppHandle) -> PathBuf {
    app.state::<crate::AppState>().data_dir.clone()
}

fn save(app: &AppHandle) {
    let s = settings().clone();
    if let Ok(b) = serde_json::to_vec_pretty(&s) {
        let _ = std::fs::write(data_dir(app).join(SETTINGS_FILE), b);
    }
}

// ------------------------------------------------------------------ window / tray

/// Brings the main window back from the tray / taskbar.
pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = AsRef::<tauri::Webview>::as_ref(&w).show();
        let _ = w.set_focus();
    }
}

const MEDIA_KEYS: [(Code, &str); 4] = [
    (Code::MediaPlayPause, "playpause"),
    (Code::MediaTrackNext, "next"),
    (Code::MediaTrackPrevious, "prev"),
    (Code::MediaStop, "stop"),
];

/// Global-shortcut plugin with the media-key handler (registered in lib.rs).
pub fn shortcut_plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, shortcut, event| {
            if event.state() != ShortcutState::Pressed {
                return;
            }
            if let Some((_, name)) = MEDIA_KEYS.iter().find(|(c, _)| *c == shortcut.key) {
                let _ = app.emit("media-key", *name);
            }
        })
        .build()
}

fn apply_media_keys(app: &AppHandle, on: bool) -> Result<(), String> {
    let gs = app.global_shortcut();
    let mut errs = Vec::new();
    for (code, _) in MEDIA_KEYS {
        let sc = Shortcut::new(None, code);
        let registered = gs.is_registered(sc);
        let res = match (on, registered) {
            (true, false) => gs.register(sc),
            (false, true) => gs.unregister(sc),
            _ => Ok(()),
        };
        if let Err(e) = res {
            errs.push(format!("{code:?}: {e}"));
        }
    }
    if errs.is_empty() { Ok(()) } else { Err(errs.join(", ")) }
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show noxx", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;
    let mut b = TrayIconBuilder::with_id("main")
        .tooltip("noxx")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, e| match e.id.as_ref() {
            "show" => show_main(app),
            "quit" => {
                QUITTING.store(true, Ordering::SeqCst);
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, e| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        b = b.icon(icon.clone());
    }
    b.build(app)?;
    Ok(())
}

pub fn setup(app: &AppHandle) {
    *settings() = read_settings(&data_dir(app));
    if let Err(e) = build_tray(app) {
        eprintln!("[system] tray: {e}");
    }
    if settings().media_keys && std::env::var_os("RIFF_SELFTEST").is_none() {
        if let Err(e) = apply_media_keys(app, true) {
            eprintln!("[system] media keys: {e}");
        }
    }
    if let Some(w) = app.get_webview_window("main") {
        let win = w.clone();
        let hidden = AtomicBool::new(false);
        w.on_window_event(move |e| match e {
            WindowEvent::CloseRequested { api, .. } => {
                if settings().tray_on_close && !QUITTING.load(Ordering::SeqCst) {
                    api.prevent_close();
                    let _ = win.hide();
                }
            }
            // Minimized: tell WebView2 it isn't visible so it stops painting.
            // Audio keeps playing; it comes back on restore.
            WindowEvent::Resized(_) | WindowEvent::Focused(_) => {
                let min = win.is_minimized().unwrap_or(false);
                if hidden.swap(min, Ordering::SeqCst) != min {
                    let wv: &tauri::Webview = win.as_ref();
                    let _ = if min { wv.hide() } else { wv.show() };
                }
            }
            _ => {}
        });
    }
}

// ------------------------------------------------------------------ cache

fn dir_size(p: &Path) -> u64 {
    let Ok(rd) = std::fs::read_dir(p) else { return 0 };
    rd.flatten()
        .map(|e| match e.file_type() {
            Ok(t) if t.is_dir() => dir_size(&e.path()),
            Ok(_) => e.metadata().map(|m| m.len()).unwrap_or(0),
            Err(_) => 0,
        })
        .sum()
}

fn web_cache_dirs(app: &AppHandle) -> Vec<PathBuf> {
    let Ok(local) = app.path().app_local_data_dir() else { return vec![] };
    let d = local.join("EBWebView").join("Default");
    ["Cache", "Code Cache", "GPUCache", "Service Worker/CacheStorage", "Service Worker/ScriptCache"]
        .iter()
        .map(|s| d.join(s))
        .collect()
}

fn audio_cache_dirs(app: &AppHandle) -> Vec<PathBuf> {
    let d = data_dir(app);
    vec![d.join("dl-tmp"), d.join("lyrics")]
}

async fn cache_size(app: &AppHandle) -> Value {
    let web = web_cache_dirs(app);
    let audio = audio_cache_dirs(app);
    tauri::async_runtime::spawn_blocking(move || {
        json!({
            "web": web.iter().map(|p| dir_size(p)).sum::<u64>(),
            "audio": audio.iter().map(|p| dir_size(p)).sum::<u64>(),
        })
    })
    .await
    .unwrap_or_else(|_| json!({ "web": 0, "audio": 0 }))
}

#[cfg(windows)]
async fn clear_web_cache(app: &AppHandle) -> Result<(), String> {
    use webview2_com::ClearBrowsingDataCompletedHandler;
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    use windows_core::Interface;

    let w = app.get_webview_window("main").ok_or("no main window")?;
    let (tx, rx) = tokio::sync::oneshot::channel::<Result<(), String>>();
    let tx = Mutex::new(Some(tx));
    w.with_webview(move |pw| {
        let send = move |r: Result<(), String>| {
            if let Some(tx) = tx.lock().unwrap().take() {
                let _ = tx.send(r);
            }
        };
        let send = std::sync::Arc::new(send);
        let s2 = send.clone();
        let res = unsafe {
            (|| -> windows_core::Result<()> {
                let profile = pw.controller().CoreWebView2()?.cast::<ICoreWebView2_13>()?.Profile()?.cast::<ICoreWebView2Profile2>()?;
                let kinds = COREWEBVIEW2_BROWSING_DATA_KINDS(
                    COREWEBVIEW2_BROWSING_DATA_KINDS_DISK_CACHE.0
                        | COREWEBVIEW2_BROWSING_DATA_KINDS_CACHE_STORAGE.0
                        | COREWEBVIEW2_BROWSING_DATA_KINDS_SERVICE_WORKERS.0,
                );
                let handler = ClearBrowsingDataCompletedHandler::create(Box::new(move |r| {
                    s2(r.map_err(|e| e.to_string()));
                    Ok(())
                }));
                profile.ClearBrowsingData(kinds, &handler)
            })()
        };
        if let Err(e) = res {
            send(Err(e.to_string()));
        }
    })
    .map_err(|e| e.to_string())?;
    match tokio::time::timeout(std::time::Duration::from_secs(20), rx).await {
        Ok(Ok(r)) => r,
        _ => Err("WebView2 didn't answer".into()),
    }
}

#[cfg(not(windows))]
async fn clear_web_cache(_app: &AppHandle) -> Result<(), String> {
    Ok(())
}

async fn clear_cache(app: &AppHandle, args: &Value) -> super::Out {
    let web = if args["web"].as_bool().unwrap_or(true) { clear_web_cache(app).await } else { Ok(()) };
    if !args["audio"].as_bool().unwrap_or(true) {
        let mut v = cache_size(app).await;
        if let Err(e) = web { v["webError"] = json!(e); }
        return Ok(v);
    }
    // Lyrics cache (memory + disk), stream links, client_id, leftover partial downloads.
    let _ = super::lyrics::handle(app, "clear_cache", Value::Null).await;
    app.state::<crate::AppState>().sc.clear_caches().await;
    let tmp = data_dir(app).join("dl-tmp");
    let _ = tauri::async_runtime::spawn_blocking(move || {
        if let Ok(rd) = std::fs::read_dir(&tmp) {
            for e in rd.flatten() {
                let _ = std::fs::remove_file(e.path()); // in-use .part files just stay
            }
        }
    })
    .await;
    let mut v = cache_size(app).await;
    if let Err(e) = web {
        v["webError"] = json!(e);
    }
    Ok(v)
}

// ------------------------------------------------------------------ plugins

fn safe_name(n: &str) -> bool {
    !n.contains("..")
        && n.len() > 3
        && n.to_ascii_lowercase().ends_with(".js")
        && n.chars().all(|c| c.is_alphanumeric() || matches!(c, '_' | '.' | '-' | ' '))
}

fn plugins_dir(app: &AppHandle) -> PathBuf {
    let d = data_dir(app).join("plugins");
    if !d.exists() {
        let _ = std::fs::create_dir_all(&d);
        let _ = std::fs::write(d.join("example-hello.js"), EXAMPLE_PLUGIN);
    }
    d
}

fn plugin_state(dir: &Path) -> BTreeMap<String, bool> {
    std::fs::read(dir.join("plugins.json"))
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .and_then(|v| serde_json::from_value(v["enabled"].clone()).ok())
        .unwrap_or_default()
}

fn write_plugin_state(dir: &Path, enabled: &BTreeMap<String, bool>) -> Result<(), String> {
    std::fs::write(dir.join("plugins.json"), json!({ "enabled": enabled }).to_string()).map_err(|e| e.to_string())
}

/// `@key value` from the first /* */ block (riff's plugin header).
fn parse_meta(code: &str, key: &str) -> String {
    let Some(start) = code.find("/*") else { return String::new() };
    let Some(end) = code[start..].find("*/") else { return String::new() };
    let block = &code[start..start + end];
    let tag = format!("@{key}");
    block
        .lines()
        .find_map(|l| {
            let i = l.find(&tag)?;
            let rest = &l[i + tag.len()..];
            rest.starts_with([' ', '\t']).then(|| rest.trim().trim_end_matches('*').trim().to_string())
        })
        .unwrap_or_default()
}

fn list_plugins(dir: &Path) -> Vec<Value> {
    let enabled = plugin_state(dir);
    let Ok(rd) = std::fs::read_dir(dir) else { return vec![] };
    let mut out: Vec<Value> = rd
        .flatten()
        .filter_map(|e| {
            let file = e.file_name().to_string_lossy().into_owned();
            if !safe_name(&file) || e.metadata().ok()?.len() > MAX_PLUGIN_BYTES {
                return None;
            }
            let code = std::fs::read_to_string(e.path()).ok()?;
            let name = Some(parse_meta(&code, "name")).filter(|s| !s.is_empty()).unwrap_or_else(|| file[..file.len() - 3].to_string());
            Some(json!({
                "file": file,
                "name": name,
                "author": parse_meta(&code, "author"),
                "version": parse_meta(&code, "version"),
                "description": parse_meta(&code, "description"),
                "enabled": enabled.get(&file).copied().unwrap_or(false),
                "code": code,
            }))
        })
        .collect();
    out.sort_by(|a, b| a["file"].as_str().cmp(&b["file"].as_str()));
    out
}

fn file_arg(args: &Value) -> Result<String, String> {
    let f = args["file"].as_str().unwrap_or("").to_string();
    if safe_name(&f) { Ok(f) } else { Err("bad plugin file name".into()) }
}

// ------------------------------------------------------------------ dispatch

pub async fn handle(app: &AppHandle, cmd: &str, args: Value) -> super::Out {
    match cmd {
        "settings" => Ok(json!(settings().clone())),
        "set" => {
            let on = args["value"].as_bool().ok_or("value must be true/false")?;
            match args["key"].as_str().unwrap_or("") {
                "trayOnClose" => settings().tray_on_close = on,
                "multiInstance" => settings().multi_instance = on,
                "mediaKeys" => {
                    settings().media_keys = on;
                    let r = apply_media_keys(app, on);
                    save(app);
                    r?;
                }
                k => return Err(format!("unknown setting {k}")),
            }
            save(app);
            Ok(json!(settings().clone()))
        }
        "cache_size" => Ok(cache_size(app).await),
        "clear_cache" => clear_cache(app, &args).await,
        "plugins_dir" => Ok(json!(plugins_dir(app).to_string_lossy())),
        "plugins_list" => {
            let d = plugins_dir(app);
            Ok(json!(tauri::async_runtime::spawn_blocking(move || list_plugins(&d)).await.unwrap_or_default()))
        }
        "plugins_set" => {
            let d = plugins_dir(app);
            let file = file_arg(&args)?;
            let mut s = plugin_state(&d);
            if args["on"].as_bool().unwrap_or(false) { s.insert(file, true); } else { s.remove(&file); }
            write_plugin_state(&d, &s)?;
            Ok(Value::Null)
        }
        "plugins_disable_all" => {
            write_plugin_state(&plugins_dir(app), &BTreeMap::new())?;
            Ok(Value::Null)
        }
        "plugins_remove" => {
            let d = plugins_dir(app);
            let file = file_arg(&args)?;
            let _ = std::fs::remove_file(d.join(&file));
            let mut s = plugin_state(&d);
            s.remove(&file);
            write_plugin_state(&d, &s)?;
            Ok(Value::Null)
        }
        "plugins_import" => {
            let d = plugins_dir(app);
            let mut added = 0;
            for p in args["paths"].as_array().into_iter().flatten().filter_map(Value::as_str) {
                let src = Path::new(p);
                let Some(name) = src.file_name().map(|n| n.to_string_lossy().into_owned()) else { continue };
                if !safe_name(&name) || std::fs::metadata(src).map(|m| m.len() > MAX_PLUGIN_BYTES).unwrap_or(true) {
                    continue;
                }
                if std::fs::copy(src, d.join(&name)).is_ok() {
                    added += 1;
                }
            }
            Ok(json!(added))
        }
        "plugins_open_folder" => {
            let d = plugins_dir(app);
            tauri_plugin_opener::open_path(d, None::<&str>).map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        _ => Err(format!("system: unknown command {cmd}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_plugin_meta_and_names() {
        assert_eq!(parse_meta(EXAMPLE_PLUGIN, "name"), "Hello plugin");
        assert_eq!(parse_meta(EXAMPLE_PLUGIN, "version"), "1.0.0");
        assert_eq!(parse_meta(EXAMPLE_PLUGIN, "missing"), "");
        assert!(safe_name("example-hello.js"));
        assert!(safe_name("My Plugin.JS"));
        assert!(!safe_name("../evil.js"));
        assert!(!safe_name("a/b.js"));
        assert!(!safe_name("x.css"));
        let s: Settings = serde_json::from_str("{\"mediaKeys\":false}").unwrap();
        assert!(s.tray_on_close && !s.media_keys && !s.multi_instance);
    }

    #[test]
    fn system_plugin_listing() {
        let dir = std::env::temp_dir().join(format!("riff-rs-plugins-test-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        std::fs::write(dir.join("a.js"), EXAMPLE_PLUGIN).unwrap();
        std::fs::write(dir.join("b.txt"), "x").unwrap();
        let mut st = BTreeMap::new();
        st.insert("a.js".to_string(), true);
        write_plugin_state(&dir, &st).unwrap();
        let l = list_plugins(&dir);
        assert_eq!(l.len(), 1);
        assert_eq!(l[0]["name"], "Hello plugin");
        assert_eq!(l[0]["enabled"], true);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
