//! Self-update for the installed Windows build and the Linux AppImage (tauri-plugin-updater).
//! Releases carry a signed `latest.json`; the update is checked against the public key in
//! tauri.conf.json, installed, and noxx restarts. The portable zip, the .deb and Android can't
//! replace themselves, so they get `{ manual: true }` and the UI offers the download instead.
//!
//! Commands (`riff.call('updater.<cmd>')`):
//!   check   -> { available, version?, current, notes?, manual }
//!   install -> downloads with "update-progress" events { done, total }, installs, restarts
//!
//! Events: "update-progress" { done, total? }.

use serde_json::{json, Value};
use tauri::AppHandle;

/// Can this copy replace itself?
pub fn self_updatable() -> bool {
    if cfg!(any(target_os = "android", target_os = "ios")) || crate::portable_dir().is_some() {
        return false;
    }
    if cfg!(target_os = "linux") {
        // Only the AppImage can; the .deb is updated by the package manager.
        return std::env::var_os("APPIMAGE").is_some();
    }
    true
}

#[cfg(desktop)]
pub async fn handle(app: &AppHandle, cmd: &str, _args: Value) -> super::Out {
    use tauri::Emitter;
    use tauri_plugin_updater::UpdaterExt;

    let current = app.package_info().version.to_string();
    if !self_updatable() {
        return match cmd {
            "check" => Ok(json!({ "available": false, "current": current, "manual": true })),
            _ => Err("This copy of noxx can't update itself; download the new version instead.".into()),
        };
    }
    let updater = app.updater().map_err(|e| e.to_string())?;
    match cmd {
        "check" => {
            let u = updater.check().await.map_err(|e| e.to_string())?;
            Ok(match u {
                Some(u) => json!({ "available": true, "version": u.version, "current": current, "notes": u.body, "manual": false }),
                None => json!({ "available": false, "current": current, "manual": false }),
            })
        }
        "install" => {
            let u = updater.check().await.map_err(|e| e.to_string())?.ok_or("Already up to date")?;
            let a = app.clone();
            let mut done: u64 = 0;
            u.download_and_install(
                move |chunk, total| {
                    done += chunk as u64;
                    let _ = a.emit("update-progress", json!({ "done": done, "total": total }));
                },
                || {},
            )
            .await
            .map_err(|e| e.to_string())?;
            super::about::line(app, "info", &format!("updated {current} -> {}, restarting", u.version));
            app.restart();
        }
        _ => Err(format!("unknown updater command {cmd}")),
    }
}

#[cfg(mobile)]
pub async fn handle(app: &AppHandle, cmd: &str, _args: Value) -> super::Out {
    match cmd {
        "check" => Ok(json!({ "available": false, "current": app.package_info().version.to_string(), "manual": true })),
        _ => Err("Updates on this device are installed from the downloaded APK.".into()),
    }
}
