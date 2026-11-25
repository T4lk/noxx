//! "Sign in to Spotify" inside noxx: Spotify's own login page opens in a noxx window; once
//! you're signed in, open.spotify.com sets its `sp_dc` session cookie, which noxx reads and
//! keeps in `spotify-web.json` in the data folder. With it, `guest::liked` reads your Liked
//! Songs the way the web player does. No developer app, no export to wait for.
//!
//! The login page is a remote page: it gets no access to noxx (not in any capability).

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use super::guest;

const FILE: &str = "spotify-web.json";
const WINDOW: &str = "spotify-login";
const LOGIN_URL: &str = "https://accounts.spotify.com/login?continue=https%3A%2F%2Fopen.spotify.com%2F";
const WAIT: Duration = Duration::from_secs(600);

#[derive(Default, Serialize, Deserialize)]
struct Saved {
    sp_dc: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    avatar: String,
}

fn path(dir: &Path) -> PathBuf {
    dir.join(FILE)
}

fn load(dir: &Path) -> Option<Saved> {
    std::fs::read(path(dir)).ok().and_then(|b| serde_json::from_slice::<Saved>(&b).ok()).filter(|s| !s.sp_dc.is_empty())
}

/// What's saved, without asking Spotify: { signedIn, name, state: "signed-in" | "signed-out" }.
pub fn status(dir: &Path) -> Value {
    match load(dir) {
        Some(s) => json!({ "signedIn": true, "name": s.name, "avatar": s.avatar, "state": "signed-in" }),
        None => json!({ "signedIn": false, "name": "", "avatar": "", "state": "signed-out" }),
    }
}

/// Asks Spotify whether the saved sign-in still works. state: "signed-in" (checked, name
/// refreshed), "expired" (Spotify refused it: forgotten, sign in again), "signed-out", or
/// "unknown" (couldn't reach Spotify: still saved, `error` says why).
pub async fn check(app: &AppHandle, dir: &Path) -> Value {
    let Some(mut s) = load(dir) else { return status(dir) };
    match guest::profile(&s.sp_dc).await {
        Ok((name, avatar)) => {
            if (!name.is_empty() && name != s.name) || avatar != s.avatar {
                if !name.is_empty() {
                    s.name = name;
                }
                s.avatar = avatar;
                crate::soundcloud::write_json(&path(dir), &s);
            }
            json!({ "signedIn": true, "name": s.name, "avatar": s.avatar, "state": "signed-in", "checked": true })
        }
        Err(e) if e.contains("SIGNED_OUT") => {
            logout(app, dir);
            json!({ "signedIn": false, "name": s.name, "state": "expired" })
        }
        Err(e) => json!({ "signedIn": true, "name": s.name, "avatar": s.avatar, "state": "unknown", "error": e }),
    }
}

/// Forgets the session and removes Spotify's login cookies from noxx's browser storage, so
/// the next sign-in asks for the account again.
pub fn logout(app: &AppHandle, dir: &Path) {
    let _ = std::fs::remove_file(path(dir));
    if let Some(w) = app.get_webview_window("main") {
        for site in ["https://open.spotify.com/", "https://accounts.spotify.com/", "https://www.spotify.com/"] {
            let Ok(url) = site.parse() else { continue };
            if let Ok(cookies) = w.cookies_for_url(url) {
                for c in cookies {
                    let _ = w.delete_cookie(c);
                }
            }
        }
    }
}

fn session_cookie(w: &tauri::WebviewWindow) -> Option<String> {
    let url = "https://open.spotify.com/".parse().ok()?;
    w.cookies_for_url(url).ok()?.into_iter().find(|c| c.name() == "sp_dc" && !c.value().is_empty()).map(|c| c.value().to_string())
}

/// Opens the login window and waits (up to 10 min) for the session; closing the window cancels.
pub async fn login(app: &AppHandle, dir: &Path) -> Result<Value, String> {
    if let Some(old) = app.get_webview_window(WINDOW) {
        let _ = old.close();
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    let url = LOGIN_URL.parse().map_err(|e| format!("{e}"))?;
    let mut b = tauri::WebviewWindowBuilder::new(app, WINDOW, tauri::WebviewUrl::External(url))
        .title("Sign in to Spotify")
        .inner_size(480.0, 760.0)
        .min_inner_size(380.0, 560.0)
        .center()
        .focused(true);
    // Every webview in the process must share the main window's browser arguments.
    if let Some(args) = app.config().app.windows.first().and_then(|c| c.additional_browser_args.clone()) {
        b = b.additional_browser_args(&args);
    }
    let w = b.build().map_err(|e| format!("Couldn't open the Spotify window: {e}"))?;

    let started = std::time::Instant::now();
    let sp_dc = loop {
        tokio::time::sleep(Duration::from_millis(800)).await;
        if app.get_webview_window(WINDOW).is_none() {
            return Err("Spotify sign-in was cancelled.".into());
        }
        // Off the main thread: on Windows the cookie call deadlocks there.
        let ww = w.clone();
        let found = tauri::async_runtime::spawn_blocking(move || session_cookie(&ww)).await.ok().flatten();
        if let Some(c) = found {
            break c;
        }
        if started.elapsed() > WAIT {
            let _ = w.close();
            return Err("Spotify sign-in timed out.".into());
        }
    };
    let _ = w.close();
    // Checks the session works, and gets the name and picture to show.
    let (name, avatar) = match guest::profile(&sp_dc).await {
        Ok(p) => p,
        Err(e) if e.contains("SIGNED_OUT") => return Err("Spotify didn't accept that sign-in. Try again.".into()),
        Err(e) => {
            eprintln!("[imports] spotify profile: {e}");
            (String::new(), String::new())
        }
    };
    let saved = Saved { sp_dc, name, avatar };
    crate::soundcloud::write_json(&path(dir), &saved);
    Ok(status(dir))
}

/// Liked Songs of the signed-in account: { likes: Item[], total }.
pub async fn likes(app: &AppHandle, dir: &Path) -> Result<Value, String> {
    let s = load(dir).ok_or("Sign in to Spotify first.")?;
    match guest::liked(&s.sp_dc).await {
        Ok((likes, total)) => Ok(json!({ "likes": likes, "total": total })),
        Err(e) if e.contains("SIGNED_OUT") => {
            logout(app, dir);
            Err("Your Spotify sign-in has expired. Sign in again.".into())
        }
        Err(e) => Err(e),
    }
}
