//! About / diagnostics: app info, a log file and opening the logs folder.
//!
//! Commands (JS: `riff.call('about.<cmd>', args)`):
//! - `info` → { name, version, os, arch, dataDir, logFile }
//! - `open_logs` → opens the logs folder in the file manager
//! - `log_tail {lines?}` → last lines of the log file (for "Copy diagnostics")
//!
//! `log_js` (lib.rs) and `line()` append to `<app data>/logs/noxx.log`; the file is
//! started fresh when it grows past 2 MB (the previous one is kept as noxx.old.log).

use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

const MAX_LOG: u64 = 2 * 1024 * 1024;
static LOCK: Mutex<()> = Mutex::new(());

fn log_dir(app: &AppHandle) -> PathBuf {
    app.state::<crate::AppState>().data_dir.join("logs")
}
fn log_file(app: &AppHandle) -> PathBuf {
    log_dir(app).join("noxx.log")
}

pub fn setup(app: &AppHandle) {
    line(app, "info", &format!("noxx {} started", app.package_info().version));
}

/// Append one line to the log file (also echoed to stderr).
pub fn line(app: &AppHandle, level: &str, message: &str) {
    eprintln!("[{level}] {message}");
    let _g = LOCK.lock();
    let path = log_file(app);
    let _ = std::fs::create_dir_all(log_dir(app));
    if std::fs::metadata(&path).map(|m| m.len() > MAX_LOG).unwrap_or(false) {
        let _ = std::fs::rename(&path, log_dir(app).join("noxx.old.log"));
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        let _ = writeln!(f, "{ts} [{level}] {message}");
    }
}

pub async fn handle(app: &AppHandle, cmd: &str, args: Value) -> super::Out {
    match cmd {
        "info" => {
            let p = app.package_info();
            Ok(json!({
                "name": p.name,
                "version": p.version.to_string(),
                "os": std::env::consts::OS,
                "arch": std::env::consts::ARCH,
                "dataDir": app.state::<crate::AppState>().data_dir.to_string_lossy(),
                "logFile": log_file(app).to_string_lossy(),
            }))
        }
        "open_logs" => {
            let dir = log_dir(app);
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            use tauri_plugin_opener::OpenerExt;
            app.opener().open_path(dir.to_string_lossy(), None::<&str>).map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "log_tail" => {
            let n = args["lines"].as_u64().unwrap_or(60) as usize;
            let text = std::fs::read_to_string(log_file(app)).unwrap_or_default();
            let lines: Vec<&str> = text.lines().collect();
            Ok(json!(lines[lines.len().saturating_sub(n)..].join("\n")))
        }
        _ => Err(format!("about: unknown command {cmd}")),
    }
}
