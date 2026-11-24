//! Windows taskbar thumbnail toolbar: previous / play-pause / next buttons under the
//! taskbar preview of the main window. Clicks arrive as WM_COMMAND (THBN_CLICKED) on the
//! window, so the window is subclassed; they go to the UI as "media-key" events, the same
//! path as the hardware media keys. The UI calls `system.thumbbar {playing}` to switch the
//! middle button between play and pause.

use std::sync::atomic::{AtomicBool, AtomicIsize, AtomicU32, Ordering};
use std::sync::OnceLock;

use tauri::{AppHandle, Emitter, Manager};
use windows::core::w;
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER};
use windows::Win32::UI::Shell::{
    DefSubclassProc, ITaskbarList3, SetWindowSubclass, TaskbarList, THBF_ENABLED, THBN_CLICKED, THB_FLAGS, THB_ICON, THB_TOOLTIP,
    THUMBBUTTON,
};
use windows::Win32::UI::WindowsAndMessaging::{CreateIcon, RegisterWindowMessageW, HICON, WM_COMMAND};

const SIZE: i32 = 20;
const ID_PREV: u32 = 1;
const ID_PLAY: u32 = 2;
const ID_NEXT: u32 = 3;

static APP: OnceLock<AppHandle> = OnceLock::new();
static HWND_RAW: AtomicIsize = AtomicIsize::new(0);
static TASKBAR_CREATED: AtomicU32 = AtomicU32::new(0);
static ADDED: AtomicBool = AtomicBool::new(false);
static PLAYING: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Copy)]
enum Glyph {
    Prev,
    Play,
    Pause,
    Next,
}

/// Is (x, y) inside the triangle a, b, c?
fn in_tri(x: f32, y: f32, a: (f32, f32), b: (f32, f32), c: (f32, f32)) -> bool {
    let s = |p: (f32, f32), q: (f32, f32), r: (f32, f32)| (p.0 - r.0) * (q.1 - r.1) - (q.0 - r.0) * (p.1 - r.1);
    let (d1, d2, d3) = (s((x, y), a, b), s((x, y), b, c), s((x, y), c, a));
    let neg = d1 < 0.0 || d2 < 0.0 || d3 < 0.0;
    let pos = d1 > 0.0 || d2 > 0.0 || d3 > 0.0;
    !(neg && pos)
}

/// White glyph on transparent, 4x supersampled for smooth edges. BGRA, top row first.
fn glyph_pixels(g: Glyph) -> Vec<u8> {
    let inside = |x: f32, y: f32| -> bool {
        let rect = |x0: f32, y0: f32, x1: f32, y1: f32| x >= x0 && x <= x1 && y >= y0 && y <= y1;
        match g {
            Glyph::Play => in_tri(x, y, (6.0, 4.0), (6.0, 16.0), (16.0, 10.0)),
            Glyph::Pause => rect(5.0, 4.0, 8.5, 16.0) || rect(11.5, 4.0, 15.0, 16.0),
            Glyph::Next => in_tri(x, y, (4.0, 4.0), (4.0, 16.0), (13.0, 10.0)) || rect(13.5, 4.0, 16.0, 16.0),
            Glyph::Prev => in_tri(x, y, (16.0, 4.0), (16.0, 16.0), (7.0, 10.0)) || rect(4.0, 4.0, 6.5, 16.0),
        }
    };
    let mut out = Vec::with_capacity((SIZE * SIZE * 4) as usize);
    for py in 0..SIZE {
        for px in 0..SIZE {
            let mut hits = 0;
            for sy in 0..4 {
                for sx in 0..4 {
                    if inside(px as f32 + (sx as f32 + 0.5) / 4.0, py as f32 + (sy as f32 + 0.5) / 4.0) {
                        hits += 1;
                    }
                }
            }
            let a = (hits * 255 / 16) as u8;
            // Premultiplied white.
            out.extend_from_slice(&[a, a, a, a]);
        }
    }
    out
}

fn icon(g: Glyph) -> HICON {
    static ICONS: OnceLock<[isize; 4]> = OnceLock::new();
    let icons = ICONS.get_or_init(|| {
        let make = |g: Glyph| unsafe {
            let and_mask = vec![0u8; (SIZE * SIZE / 8) as usize];
            CreateIcon(None, SIZE, SIZE, 1, 32, and_mask.as_ptr(), glyph_pixels(g).as_ptr()).map(|h| h.0 as isize).unwrap_or(0)
        };
        [make(Glyph::Prev), make(Glyph::Play), make(Glyph::Pause), make(Glyph::Next)]
    });
    HICON(icons[g as usize] as _)
}

fn tip(text: &str) -> [u16; 260] {
    let mut t = [0u16; 260];
    for (i, c) in text.encode_utf16().take(259).enumerate() {
        t[i] = c;
    }
    t
}

fn button(id: u32, g: Glyph, text: &str) -> THUMBBUTTON {
    THUMBBUTTON { dwMask: THB_ICON | THB_TOOLTIP | THB_FLAGS, iId: id, iBitmap: 0, hIcon: icon(g), szTip: tip(text), dwFlags: THBF_ENABLED }
}

fn play_button() -> THUMBBUTTON {
    if PLAYING.load(Ordering::SeqCst) {
        button(ID_PLAY, Glyph::Pause, "Pause")
    } else {
        button(ID_PLAY, Glyph::Play, "Play")
    }
}

fn taskbar() -> Option<ITaskbarList3> {
    unsafe {
        let tb: ITaskbarList3 = CoCreateInstance(&TaskbarList, None, CLSCTX_INPROC_SERVER).ok()?;
        tb.HrInit().ok()?;
        Some(tb)
    }
}

/// Main thread only. ThumbBarAddButtons works once per taskbar button; after that, update.
fn add_buttons(hwnd: HWND) {
    let Some(tb) = taskbar() else { return };
    let buttons = [button(ID_PREV, Glyph::Prev, "Previous"), play_button(), button(ID_NEXT, Glyph::Next, "Next")];
    match unsafe { tb.ThumbBarAddButtons(hwnd, &buttons) } {
        Ok(()) => ADDED.store(true, Ordering::SeqCst),
        Err(e) => eprintln!("[thumbbar] add: {e}"),
    }
}

fn update_play(hwnd: HWND) {
    if !ADDED.load(Ordering::SeqCst) {
        return add_buttons(hwnd);
    }
    if let Some(tb) = taskbar() {
        let _ = unsafe { tb.ThumbBarUpdateButtons(hwnd, &[play_button()]) };
    }
}

unsafe extern "system" fn subclass(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM, _id: usize, _data: usize) -> LRESULT {
    let created = TASKBAR_CREATED.load(Ordering::SeqCst);
    if created != 0 && msg == created {
        // The taskbar button (re)appeared (first show, Explorer restart): add the buttons again.
        ADDED.store(false, Ordering::SeqCst);
        add_buttons(hwnd);
    } else if msg == WM_COMMAND && ((wparam.0 >> 16) & 0xffff) as u32 == THBN_CLICKED {
        let key = match (wparam.0 & 0xffff) as u32 {
            ID_PREV => Some("prev"),
            ID_PLAY => Some("playpause"),
            ID_NEXT => Some("next"),
            _ => None,
        };
        if let (Some(key), Some(app)) = (key, APP.get()) {
            let _ = app.emit("media-key", key);
            return LRESULT(0);
        }
    }
    DefSubclassProc(hwnd, msg, wparam, lparam)
}

pub fn setup(app: &AppHandle) {
    let Some(w) = app.get_webview_window("main") else { return };
    let Ok(h) = w.hwnd() else { return };
    let raw = h.0 as isize;
    let _ = APP.set(app.clone());
    HWND_RAW.store(raw, Ordering::SeqCst);
    let _ = app.run_on_main_thread(move || unsafe {
        TASKBAR_CREATED.store(RegisterWindowMessageW(w!("TaskbarButtonCreated")), Ordering::SeqCst);
        let hwnd = HWND(raw as _);
        let _ = SetWindowSubclass(hwnd, Some(subclass), 0x6e6f7878, 0);
    });
    // The window may already have its taskbar button (no TaskbarButtonCreated then).
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
        let _ = app2.run_on_main_thread(move || {
            if !ADDED.load(Ordering::SeqCst) {
                add_buttons(HWND(raw as _));
            }
        });
    });
}

/// Play / pause icon on the middle button.
pub fn set_playing(app: &AppHandle, playing: bool) {
    if PLAYING.swap(playing, Ordering::SeqCst) == playing && ADDED.load(Ordering::SeqCst) {
        return;
    }
    let raw = HWND_RAW.load(Ordering::SeqCst);
    if raw == 0 {
        return;
    }
    let _ = app.run_on_main_thread(move || update_play(HWND(raw as _)));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn glyphs_have_ink() {
        for g in [Glyph::Prev, Glyph::Play, Glyph::Pause, Glyph::Next] {
            let px = glyph_pixels(g);
            assert_eq!(px.len(), (SIZE * SIZE * 4) as usize);
            let ink = px.chunks(4).filter(|p| p[3] > 128).count();
            assert!(ink > 40 && ink < 300, "{ink}");
        }
    }
}
