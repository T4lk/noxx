//! App-level settings riff keeps under Advanced / Storage / Plugins:
//! close-to-tray, global media keys, single instance, cache size + clearing,
//! and the plugins folder.
//!
//! Commands (`riff.call('system.<cmd>', args)`):
//!   settings                          -> { trayOnClose, mediaKeys, multiInstance }
//!   set { key, value }                -> settings (applied live; multiInstance after restart)
//!   cache_size                        -> { audio, web } in bytes
//!   clear_cache { audio?, web? }       -> { audio, web } sizes after clearing (+ webError)
//!   memory                            -> { total, app, web, processes } private working set, bytes
//!   plugins_list                      -> [{ file, name, author, version, description, enabled, code }]
//!   plugins_set { file, on }          -> null
//!   plugins_disable_all               -> null
//!   plugins_remove { file }           -> null
//!   plugins_import { paths }          -> number added
//!   plugins_open_folder               -> null
//!   plugins_dir                       -> path
//!   thumbbar { playing }              -> null (Windows taskbar preview buttons: play or pause icon)
//!   show_main                         -> null (brings the main window back)
//!   mini { show, position }          -> { open } (floating mini player window: "top-left" | "top-center" | "top-right")
//!   keep_awake { on }                 -> null (Windows: display + system stay awake while on)
//!   global_keys { map: {action: "Ctrl+Alt+M"} } -> { failed: {action: reason} } (system-wide shortcuts)
//!
//! Events: "media-key" with "playpause" | "next" | "prev" | "stop"; "global-shortcut" with an action id.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
#[cfg(desktop)]
use tauri::menu::{Menu, MenuItem};
#[cfg(desktop)]
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
#[cfg(desktop)]
use tauri::WindowEvent;
use tauri::{AppHandle, Emitter, Manager};
#[cfg(desktop)]
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Shortcut, ShortcutState};

const SETTINGS_FILE: &str = "settings.json";
const IDENTIFIER: &str = "dev.noxx.player";
const MAX_PLUGIN_BYTES: u64 = 1024 * 1024;
const EXAMPLE_PLUGIN: &str = "/**\n * @name Hello plugin\n * @author Riff\n * @version 1.0.0\n * @description Shows a message when the track changes. Edit or delete this file.\n */\nconst off = Riff.on('trackchange', (track) => Riff.toast('Now playing: ' + track.title));\nreturn { stop() { off(); } };\n";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub tray_on_close: bool,
    pub media_keys: bool,
    pub multi_instance: bool,
    /// Performance mode: start the webview without the GPU (set from the UI, applies on next launch).
    pub no_gpu: bool,
}

impl Default for Settings {
    fn default() -> Self {
        // Linux: many bars (Hyprland, Sway...) have no tray, so closing really closes.
        Settings { tray_on_close: !cfg!(target_os = "linux"), media_keys: true, multi_instance: false, no_gpu: false }
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
/// decided there). Same folder as `app_data_dir()`.
pub fn early_settings() -> Settings {
    if let Some(dir) = crate::portable_dir() {
        return read_settings(&dir);
    }
    early_data_dir().map(|d| read_settings(&d)).unwrap_or_default()
}

/// `app_data_dir()` before the app exists: %APPDATA% on Windows, $XDG_DATA_HOME
/// (or ~/.local/share) on Linux, ~/Library/Application Support on macOS.
pub fn early_data_dir() -> Option<PathBuf> {
    let base = if cfg!(windows) {
        std::env::var_os("APPDATA").map(PathBuf::from)
    } else if cfg!(target_os = "macos") {
        std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library/Application Support"))
    } else {
        std::env::var_os("XDG_DATA_HOME")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")))
    };
    base.map(|b| b.join(IDENTIFIER))
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
/// WebView2's memory target: Low while noxx is hidden (tray) or minimized, so the renderer
/// gives back caches; Normal again when it's shown. Playback keeps going either way.
#[cfg(windows)]
pub fn set_low_memory(w: &tauri::WebviewWindow, low: bool) {
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    use windows_core::Interface;
    let _ = w.with_webview(move |pw| unsafe {
        let level = if low { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW } else { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL };
        if let Ok(wv) = pw.controller().CoreWebView2().and_then(|c| c.cast::<ICoreWebView2_19>()) {
            let _ = wv.SetMemoryUsageTargetLevel(level);
        }
    });
}
#[cfg(not(windows))]
pub fn set_low_memory(_w: &tauri::WebviewWindow, _low: bool) {}

#[cfg(desktop)]
pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        set_low_memory(&w, false);
        let _ = w.show();
        let _ = w.unminimize();
        let _ = AsRef::<tauri::Webview>::as_ref(&w).show();
        let _ = w.set_focus();
    }
}

#[cfg(mobile)]
pub fn show_main(_app: &AppHandle) {}

#[cfg(desktop)]
const MEDIA_KEYS: [(Code, &str); 4] = [
    (Code::MediaPlayPause, "playpause"),
    (Code::MediaTrackNext, "next"),
    (Code::MediaTrackPrevious, "prev"),
    (Code::MediaStop, "stop"),
];

/// Global-shortcut plugin with the media-key handler (registered in lib.rs).
#[cfg(desktop)]
pub fn shortcut_plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, shortcut, event| {
            if event.state() != ShortcutState::Pressed {
                return;
            }
            let custom = CUSTOM_KEYS.lock().unwrap_or_else(|e| e.into_inner()).iter().find(|(id, _)| *id == shortcut.id()).map(|(_, a)| a.clone());
            if let Some(action) = custom {
                if action == "showWindow" {
                    show_main(app);
                }
                let _ = app.emit("global-shortcut", action);
            } else if let Some((_, name)) = MEDIA_KEYS.iter().find(|(c, _)| *c == shortcut.key) {
                let _ = app.emit("media-key", *name);
            }
        })
        .build()
}

/// System-wide shortcuts the user picked: (shortcut id, action).
#[cfg(desktop)]
static CUSTOM_KEYS: Mutex<Vec<(u32, String)>> = Mutex::new(Vec::new());

/// "Ctrl+Alt+ArrowRight" / "Ctrl+Shift+M" / "Super+1" (the UI's format) -> a Shortcut.
#[cfg(desktop)]
fn parse_combo(combo: &str) -> Result<Shortcut, String> {
    let parts: Vec<String> = combo
        .split('+')
        .map(|p| match p {
            "Ctrl" => "Control".to_string(),
            k if k.len() == 1 && k.chars().all(|c| c.is_ascii_alphabetic()) => format!("Key{k}"),
            k if k.len() == 1 && k.chars().all(|c| c.is_ascii_digit()) => format!("Digit{k}"),
            "/" => "Slash".to_string(),
            k => k.to_string(),
        })
        .collect();
    parts.join("+").parse::<Shortcut>().map_err(|e| format!("{combo}: {e}"))
}

/// Replaces the user's system-wide shortcuts. Returns the ones that couldn't be registered
/// (usually taken by another app).
#[cfg(desktop)]
fn apply_global_keys(app: &AppHandle, map: &serde_json::Map<String, Value>) -> Value {
    let gs = app.global_shortcut();
    let mut custom = CUSTOM_KEYS.lock().unwrap_or_else(|e| e.into_inner());
    let media: Vec<u32> = MEDIA_KEYS.iter().map(|(c, _)| Shortcut::new(None, *c).id()).collect();
    for (id, _) in custom.drain(..) {
        if media.contains(&id) {
            continue;
        }
        if let Some(sc) = REGISTERED.lock().unwrap_or_else(|e| e.into_inner()).remove(&id) {
            let _ = gs.unregister(sc);
        }
    }
    let mut failed = serde_json::Map::new();
    for (action, combo) in map {
        let Some(combo) = combo.as_str().filter(|c| !c.is_empty()) else { continue };
        match parse_combo(combo) {
            Ok(sc) if media.contains(&sc.id()) => failed.insert(action.clone(), json!("media keys are already handled")),
            Ok(sc) => match gs.register(sc) {
                Ok(()) => {
                    custom.push((sc.id(), action.clone()));
                    REGISTERED.lock().unwrap_or_else(|e| e.into_inner()).insert(sc.id(), sc);
                    None
                }
                Err(e) => failed.insert(action.clone(), json!(e.to_string())),
            },
            Err(e) => failed.insert(action.clone(), json!(e)),
        };
    }
    json!({ "failed": failed })
}

/// Shortcuts we registered, by id (to unregister them later).
#[cfg(desktop)]
static REGISTERED: std::sync::LazyLock<Mutex<std::collections::HashMap<u32, Shortcut>>> = std::sync::LazyLock::new(Default::default);

#[cfg(mobile)]
fn apply_media_keys(_app: &AppHandle, _on: bool) -> Result<(), String> {
    Ok(())
}

#[cfg(desktop)]
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

#[cfg(desktop)]
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
    #[cfg(desktop)]
    desktop_setup(app);
}

#[cfg(desktop)]
fn desktop_setup(app: &AppHandle) {
    if let Err(e) = build_tray(app) {
        eprintln!("[system] tray: {e}");
    }
    // Global shortcuts are X11-only on Linux; Wayland compositors don't allow grabbing keys.
    let wayland = cfg!(target_os = "linux") && std::env::var_os("WAYLAND_DISPLAY").is_some();
    if settings().media_keys && !wayland && std::env::var_os("RIFF_SELFTEST").is_none() {
        if let Err(e) = apply_media_keys(app, true) {
            eprintln!("[system] media keys: {e}");
        }
    }
    if let Some(w) = app.get_webview_window("main") {
        let win = w.clone();
        let hidden = AtomicBool::new(false);
        w.on_window_event(move |e| match e {
            WindowEvent::CloseRequested { api, .. } => {
                save_window_state(win.app_handle());
                if settings().tray_on_close && !QUITTING.load(Ordering::SeqCst) {
                    api.prevent_close();
                    let _ = win.hide();
                    set_low_memory(&win, true);
                }
            }
            WindowEvent::Moved(_) => save_window_state_soon(win.app_handle()),
            // Minimized: tell WebView2 it isn't visible so it stops painting.
            // Audio keeps playing; it comes back on restore.
            WindowEvent::Resized(_) | WindowEvent::Focused(_) => {
                if matches!(e, WindowEvent::Resized(_)) {
                    save_window_state_soon(win.app_handle());
                }
                let min = win.is_minimized().unwrap_or(false);
                if hidden.swap(min, Ordering::SeqCst) != min {
                    let wv: &tauri::Webview = win.as_ref();
                    let _ = if min { wv.hide() } else { wv.show() };
                    set_low_memory(&win, min);
                }
            }
            _ => {}
        });
    }
}

/// Window size / position / maximized (tauri-plugin-window-state). The plugin saves on a clean
/// exit only; noxx usually goes to the tray instead and may be ended by a shutdown, so the
/// state is also saved a second after the last move or resize.
#[cfg(desktop)]
fn save_window_state(app: &AppHandle) {
    use tauri_plugin_window_state::{AppHandleExt, StateFlags};
    if let Err(e) = app.save_window_state(StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED) {
        eprintln!("[system] window state: {e}");
    }
}

#[cfg(desktop)]
fn save_window_state_soon(app: &AppHandle) {
    use std::sync::atomic::AtomicU64;
    static GEN: AtomicU64 = AtomicU64::new(0);
    let gen = GEN.fetch_add(1, Ordering::SeqCst) + 1;
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
        if GEN.load(Ordering::SeqCst) == gen && !app.get_webview_window("main").is_some_and(|w| w.is_minimized().unwrap_or(false)) {
            save_window_state(&app);
        }
    });
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
    let local = match crate::portable_dir() {
        Some(d) => d.join("webview"),
        None => match app.path().app_local_data_dir() {
            Ok(d) => d,
            Err(_) => return vec![],
        },
    };
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

// ------------------------------------------------------------------ memory

/// Private working set (what Task Manager's Memory column shows) of noxx and
/// every process under it. Task Manager files the WebView2 processes in their
/// own "WebView2 Manager" group (WebView2Feedback#5628, tauri#15567), so this
/// is the only place the whole number shows up.
#[cfg(windows)]
mod mem {
    use std::collections::HashMap;
    use std::ffi::c_void;

    #[repr(C)]
    struct ProcessEntry32W {
        size: u32,
        usage: u32,
        pid: u32,
        heap_id: usize,
        module_id: u32,
        threads: u32,
        parent: u32,
        pri_base: i32,
        flags: u32,
        exe: [u16; 260],
    }

    /// PROCESS_MEMORY_COUNTERS_EX2.
    #[repr(C)]
    #[derive(Default)]
    struct Counters {
        cb: u32,
        page_faults: u32,
        peak_working_set: usize,
        working_set: usize,
        quota_peak_paged: usize,
        quota_paged: usize,
        quota_peak_nonpaged: usize,
        quota_nonpaged: usize,
        pagefile: usize,
        peak_pagefile: usize,
        private_usage: usize,
        private_working_set: usize,
        shared_commit: u64,
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateToolhelp32Snapshot(flags: u32, pid: u32) -> *mut c_void;
        fn Process32FirstW(snap: *mut c_void, e: *mut ProcessEntry32W) -> i32;
        fn Process32NextW(snap: *mut c_void, e: *mut ProcessEntry32W) -> i32;
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut c_void;
        fn CloseHandle(h: *mut c_void) -> i32;
        fn K32GetProcessMemoryInfo(h: *mut c_void, c: *mut Counters, cb: u32) -> i32;
    }

    const TH32CS_SNAPPROCESS: u32 = 2;
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    const INVALID: *mut c_void = -1isize as *mut c_void;

    /// (pid, exe) of this process and all its descendants.
    fn tree() -> Vec<(u32, String)> {
        let me = std::process::id();
        let mut kids: HashMap<u32, Vec<(u32, String)>> = HashMap::new();
        unsafe {
            let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if !snap.is_null() && snap != INVALID {
                let mut e: ProcessEntry32W = std::mem::zeroed();
                e.size = std::mem::size_of::<ProcessEntry32W>() as u32;
                let mut ok = Process32FirstW(snap, &mut e);
                while ok != 0 {
                    let n = e.exe.iter().position(|&c| c == 0).unwrap_or(e.exe.len());
                    // Idle/System list themselves as parents; skip those loops.
                    if e.pid != e.parent && e.pid > 4 {
                        kids.entry(e.parent).or_default().push((e.pid, String::from_utf16_lossy(&e.exe[..n])));
                    }
                    ok = Process32NextW(snap, &mut e);
                }
                CloseHandle(snap);
            }
        }
        let mut out = vec![(me, "noxx.exe".to_string())];
        let mut i = 0;
        while i < out.len() && out.len() < 256 {
            if let Some(k) = kids.remove(&out[i].0) {
                out.extend(k);
            }
            i += 1;
        }
        out
    }

    fn private_ws(pid: u32) -> u64 {
        unsafe {
            let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if h.is_null() {
                return 0;
            }
            let mut c = Counters::default();
            let full = std::mem::size_of::<Counters>() as u32;
            c.cb = full;
            let v = if K32GetProcessMemoryInfo(h, &mut c, full) != 0 {
                c.private_working_set as u64
            } else {
                // Before Windows 10 1809 there's no private working set; use the plain one.
                let base = (8 + 8 * std::mem::size_of::<usize>()) as u32; // PROCESS_MEMORY_COUNTERS
                c = Counters { cb: base, ..Default::default() };
                if K32GetProcessMemoryInfo(h, &mut c, base) != 0 { c.working_set as u64 } else { 0 }
            };
            CloseHandle(h);
            v
        }
    }

    pub fn usage() -> serde_json::Value {
        let (mut app, mut web, mut n) = (0u64, 0u64, 0u32);
        for (pid, exe) in tree() {
            let b = private_ws(pid);
            if exe.eq_ignore_ascii_case("msedgewebview2.exe") { web += b } else { app += b }
            n += 1;
        }
        serde_json::json!({ "total": app + web, "app": app, "web": web, "processes": n })
    }
}

/// Linux: proportional set size (Pss, shared pages split fairly) of noxx and its WebKit
/// child processes, from /proc.
#[cfg(target_os = "linux")]
mod mem {
    fn pss(pid: u32) -> u64 {
        std::fs::read_to_string(format!("/proc/{pid}/smaps_rollup"))
            .ok()
            .and_then(|s| s.lines().find(|l| l.starts_with("Pss:")).and_then(|l| l.split_whitespace().nth(1)?.parse::<u64>().ok()))
            .map(|kb| kb * 1024)
            .unwrap_or(0)
    }
    fn parent(pid: u32) -> Option<u32> {
        let s = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        s.rsplit_once(')')?.1.split_whitespace().nth(1)?.parse().ok()
    }
    pub fn usage() -> serde_json::Value {
        let me = std::process::id();
        let mut tree = vec![me];
        let pids: Vec<u32> = std::fs::read_dir("/proc")
            .map(|rd| rd.flatten().filter_map(|e| e.file_name().to_str()?.parse().ok()).collect())
            .unwrap_or_default();
        // children, grandchildren... (WebKitWebProcess / WebKitNetworkProcess)
        let mut grew = true;
        while grew {
            grew = false;
            for &p in &pids {
                if !tree.contains(&p) && parent(p).is_some_and(|pp| tree.contains(&pp)) {
                    tree.push(p);
                    grew = true;
                }
            }
        }
        let app = pss(me);
        let web: u64 = tree.iter().skip(1).map(|&p| pss(p)).sum();
        serde_json::json!({ "total": app + web, "app": app, "web": web, "processes": tree.len(), "engine": "WebKit" })
    }
}

#[cfg(not(any(windows, target_os = "linux")))]
mod mem {
    pub fn usage() -> serde_json::Value {
        serde_json::json!({ "total": 0, "app": 0, "web": 0, "processes": 0 })
    }
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

// ------------------------------------------------------------------ mini player window

/// The floating mini player (ui/mini.html): small, always on top, no taskbar entry. It talks
/// to the main window through events ("mini-state" from main, "mini-cmd" back).
#[cfg(desktop)]
fn mini_window(app: &AppHandle, show: bool, position: &str) -> Result<bool, String> {
    const W: f64 = 360.0;
    const H: f64 = 84.0;
    const MARGIN: f64 = 16.0;
    if !show {
        if let Some(w) = app.get_webview_window("mini") {
            let _ = w.close();
        }
        return Ok(false);
    }
    let w = match app.get_webview_window("mini") {
        Some(w) => w,
        None => {
            let mut b = tauri::WebviewWindowBuilder::new(app, "mini", tauri::WebviewUrl::App("mini.html".into()))
                .title("noxx mini player")
                .inner_size(W, H)
                .resizable(false)
                .maximizable(false)
                .minimizable(false)
                .decorations(false)
                .always_on_top(true)
                .skip_taskbar(true)
                .focused(false)
                .shadow(true)
                .visible(false);
            // Every webview in the process must share the main window's browser arguments.
            if let Some(args) = app.config().app.windows.first().and_then(|c| c.additional_browser_args.clone()) {
                b = b.additional_browser_args(&args);
            }
            b.build().map_err(|e| e.to_string())?
        }
    };
    // Place it on the monitor the main window is on (or the primary one).
    let mon = app
        .get_webview_window("main")
        .and_then(|m| m.current_monitor().ok().flatten())
        .or_else(|| w.primary_monitor().ok().flatten());
    if let Some(m) = mon {
        let scale = m.scale_factor();
        let (mx, my) = (m.position().x as f64 / scale, m.position().y as f64 / scale);
        let mw = m.size().width as f64 / scale;
        let x = match position {
            "top-left" => mx + MARGIN,
            "top-center" => mx + (mw - W) / 2.0,
            _ => mx + mw - W - MARGIN,
        };
        let _ = w.set_position(tauri::LogicalPosition::new(x, my + MARGIN));
    }
    let _ = w.show();
    Ok(true)
}

// ------------------------------------------------------------------ keep awake

/// Windows: `SetThreadExecutionState(ES_CONTINUOUS | ...)` holds only while the calling thread
/// lives, so one parked thread owns the request; dropping the sender ends it.
#[cfg(windows)]
fn keep_awake(on: bool) {
    use std::sync::mpsc;
    static HOLDER: Mutex<Option<mpsc::Sender<()>>> = Mutex::new(None);
    #[link(name = "kernel32")]
    extern "system" {
        fn SetThreadExecutionState(flags: u32) -> u32;
    }
    const ES_CONTINUOUS: u32 = 0x8000_0000;
    const ES_SYSTEM_REQUIRED: u32 = 0x0000_0001;
    const ES_DISPLAY_REQUIRED: u32 = 0x0000_0002;
    let mut holder = HOLDER.lock().unwrap_or_else(|e| e.into_inner());
    if on == holder.is_some() {
        return;
    }
    if !on {
        holder.take(); // the thread wakes, clears the request and exits
        return;
    }
    let (tx, rx) = mpsc::channel::<()>();
    std::thread::spawn(move || {
        unsafe { SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED) };
        let _ = rx.recv();
        unsafe { SetThreadExecutionState(ES_CONTINUOUS) };
    });
    *holder = Some(tx);
}

#[cfg(not(windows))]
fn keep_awake(_on: bool) {}

pub async fn handle(app: &AppHandle, cmd: &str, args: Value) -> super::Out {
    match cmd {
        "global_keys" => {
            #[cfg(desktop)]
            {
                let empty = serde_json::Map::new();
                let map = args["map"].as_object().unwrap_or(&empty);
                Ok(apply_global_keys(app, map))
            }
            #[cfg(mobile)]
            {
                let _ = args;
                Ok(json!({ "failed": {} }))
            }
        }
        "show_main" => {
            show_main(app);
            Ok(Value::Null)
        }
        "mini" => {
            #[cfg(desktop)]
            {
                let open = mini_window(app, args["show"].as_bool().unwrap_or(true), args["position"].as_str().unwrap_or("top-right"))?;
                Ok(json!({ "open": open }))
            }
            #[cfg(mobile)]
            {
                let _ = args;
                Ok(json!({ "open": false }))
            }
        }
        "thumbbar" => {
            #[cfg(windows)]
            super::thumbbar::set_playing(app, args["playing"].as_bool().unwrap_or(false));
            Ok(Value::Null)
        }
        "keep_awake" => {
            keep_awake(args["on"].as_bool().unwrap_or(false));
            Ok(Value::Null)
        }
        "settings" => Ok(json!(settings().clone())),
        "set" => {
            let on = args["value"].as_bool().ok_or("value must be true/false")?;
            match args["key"].as_str().unwrap_or("") {
                "trayOnClose" => settings().tray_on_close = on,
                "multiInstance" => settings().multi_instance = on,
                "noGpu" => settings().no_gpu = on,
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
        "memory" => Ok(tauri::async_runtime::spawn_blocking(mem::usage).await.unwrap_or_default()),
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
    fn system_memory_counts_self() {
        let m = mem::usage();
        assert!(m["processes"].as_u64().unwrap() >= 1);
        if cfg!(windows) {
            assert!(m["total"].as_u64().unwrap() > 0);
            // A child process is counted too.
            let mut c = std::process::Command::new("cmd").args(["/c", "ping -n 5 127.0.0.1 >nul"]).spawn().unwrap();
            std::thread::sleep(std::time::Duration::from_millis(300));
            let m2 = mem::usage();
            let _ = c.kill();
            assert!(m2["processes"].as_u64().unwrap() > m["processes"].as_u64().unwrap(), "{m2}");
        }
    }

    #[test]
    fn system_plugin_listing() {
        let dir = std::env::temp_dir().join(format!("noxx-plugins-test-{}", std::process::id()));
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

#[cfg(all(test, desktop))]
mod key_tests {
    use super::*;

    #[test]
    fn combos_parse() {
        for c in ["Ctrl+Alt+M", "Ctrl+Shift+ArrowRight", "Super+1", "Alt+Space", "F9", "Ctrl+/", "Ctrl+Alt+MediaPlayPause"] {
            assert!(parse_combo(c).is_ok(), "{c}: {:?}", parse_combo(c).err());
        }
        assert_eq!(parse_combo("Ctrl+Alt+M").unwrap(), "Control+Alt+KeyM".parse::<Shortcut>().unwrap());
        assert!(parse_combo("Ctrl+Nope").is_err());
    }
}
