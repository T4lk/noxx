//! Custom themes (riff's Settings > Custom themes): `.css` files in `<app data>/themes/`,
//! listed in `themes/index.json` with the same format riff uses
//! (`{ "themes": [{ id, name, author, description, enabled }] }`), so riff's own
//! theme folder can be imported as is. Name / author / description come from the
//! file's header comment (`@name`, `@author`, `@description`).
//!
//! Commands: `list` -> [{id, name, author, description, enabled, css}],
//! `import {paths}` -> added themes, `importRiff` -> added themes (from
//! %LOCALAPPDATA%\Riff\themes), `setEnabled {id, enabled}`, `remove {id}`.
//!
//! Banner / background media (riff's "Banner media" and "Background media"):
//! `importMedia {path, kind}` copies the picked image or video to
//! `<app data>/media/<kind>.<ext>` (that folder is on the asset protocol scope)
//! and returns `{ path }`; `clearMedia {kind}` deletes it.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use super::Out;

const MAX_CSS: u64 = 2 * 1024 * 1024;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Meta {
    pub id: String,
    pub name: String,
    pub author: String,
    pub description: String,
    pub enabled: bool,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(default)]
struct Index {
    themes: Vec<Meta>,
}

pub fn setup(app: &AppHandle) {
    let dir = media_dir(app);
    let _ = std::fs::create_dir_all(&dir);
    if let Err(e) = app.asset_protocol_scope().allow_directory(&dir, false) {
        eprintln!("themes: media scope: {e}");
    }
}

const MEDIA_EXT: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "mp4", "webm"];
const MAX_MEDIA: u64 = 1024 * 1024 * 1024;

fn media_dir(app: &AppHandle) -> PathBuf {
    app.state::<crate::AppState>().data_dir.join("media")
}

fn media_kind(args: &Value) -> Result<&'static str, String> {
    match args.get("kind").and_then(Value::as_str) {
        Some("banner") => Ok("banner"),
        Some("bg") => Ok("bg"),
        _ => Err("kind must be banner or bg".into()),
    }
}

/// Removes every `<kind>.*` file in the media folder.
fn clear_media(dir: &Path, kind: &str) {
    for ext in MEDIA_EXT {
        let _ = std::fs::remove_file(dir.join(format!("{kind}.{ext}")));
    }
}

fn import_media(dir: &Path, kind: &str, src: &Path) -> Result<PathBuf, String> {
    let ext = src
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .filter(|e| MEDIA_EXT.contains(&e.as_str()))
        .ok_or("Choose an image (png, jpg, gif, webp, avif, bmp) or a video (mp4, webm)")?;
    let len = std::fs::metadata(src).map_err(|e| format!("{}: {e}", src.display()))?.len();
    if len > MAX_MEDIA {
        return Err("That file is larger than 1 GB".into());
    }
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let dest = dir.join(format!("{kind}.{ext}"));
    let tmp = dir.join(format!("{kind}.tmp"));
    std::fs::copy(src, &tmp).map_err(|e| format!("{}: {e}", src.display()))?;
    clear_media(dir, kind);
    std::fs::rename(&tmp, &dest).map_err(|e| e.to_string())?;
    Ok(dest)
}

fn dir(app: &AppHandle) -> PathBuf {
    app.state::<crate::AppState>().data_dir.join("themes")
}

fn read_index(dir: &Path) -> Index {
    std::fs::read_to_string(dir.join("index.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_index(dir: &Path, index: &Index) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let text = serde_json::to_string_pretty(index).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("index.json"), text).map_err(|e| e.to_string())
}

/// Ids become file names, so only [a-z0-9_-] survive.
fn safe_id(id: &str) -> Option<String> {
    let ok = !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    ok.then(|| id.to_string())
}

fn new_id() -> String {
    let n = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    format!("t{n:x}")
}

/// `@name` / `@author` / `@description` from the first comment block.
pub fn parse_header(css: &str) -> (Option<String>, Option<String>, Option<String>) {
    let head = css.find("/*").and_then(|a| css[a..].find("*/").map(|b| &css[a..a + b])).unwrap_or("");
    let tag = |t: &str| {
        head.lines().find_map(|line| {
            let line = line.trim_start_matches(|c: char| c == '*' || c == '/' || c.is_whitespace());
            line.strip_prefix(t).map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
        })
    };
    (tag("@name"), tag("@author"), tag("@description"))
}

fn read_css(path: &Path) -> Result<String, String> {
    let len = std::fs::metadata(path).map_err(|e| format!("{}: {e}", path.display()))?.len();
    if len > MAX_CSS {
        return Err(format!("{} is larger than 2 MB", path.display()));
    }
    std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))
}

fn with_css(dir: &Path, m: &Meta) -> Value {
    let css = std::fs::read_to_string(dir.join(format!("{}.css", m.id))).unwrap_or_default();
    json!({ "id": m.id, "name": m.name, "author": m.author, "description": m.description, "enabled": m.enabled, "css": css })
}

/// Adds one css text as a new theme (disabled unless `enabled`). Returns its metadata.
fn add(dir: &Path, index: &mut Index, css: &str, fallback_name: &str, meta: Option<&Meta>) -> Result<Meta, String> {
    let (name, author, description) = parse_header(css);
    let m = Meta {
        id: new_id(),
        name: name.or_else(|| meta.map(|m| m.name.clone()).filter(|s| !s.is_empty())).unwrap_or_else(|| fallback_name.to_string()),
        author: author.or_else(|| meta.map(|m| m.author.clone())).unwrap_or_default(),
        description: description.or_else(|| meta.map(|m| m.description.clone())).unwrap_or_default(),
        enabled: false,
    };
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(format!("{}.css", m.id)), css).map_err(|e| e.to_string())?;
    index.themes.push(m.clone());
    // ids come from the clock; two in the same nanosecond would collide, so wait it out
    std::thread::sleep(std::time::Duration::from_micros(2));
    Ok(m)
}

fn riff_dir() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(|p| PathBuf::from(p).join("Riff").join("themes"))
}

pub async fn handle(app: &AppHandle, cmd: &str, args: Value) -> Out {
    let dir = dir(app);
    match cmd {
        "list" => {
            let index = read_index(&dir);
            Ok(Value::Array(index.themes.iter().map(|m| with_css(&dir, m)).collect()))
        }
        "import" => {
            let paths: Vec<String> = args.get("paths").and_then(|v| serde_json::from_value(v.clone()).ok()).unwrap_or_default();
            let mut index = read_index(&dir);
            let mut added = Vec::new();
            for p in paths {
                let path = PathBuf::from(&p);
                if path.extension().and_then(|e| e.to_str()).map(|e| e.eq_ignore_ascii_case("css")) != Some(true) {
                    return Err(format!("{p} is not a .css file"));
                }
                let css = read_css(&path)?;
                let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("Theme").to_string();
                added.push(add(&dir, &mut index, &css, &stem, None)?);
            }
            write_index(&dir, &index)?;
            Ok(Value::Array(added.iter().map(|m| with_css(&dir, m)).collect()))
        }
        "importRiff" => {
            let src = riff_dir().ok_or("LOCALAPPDATA is not set")?;
            let theirs = read_index(&src);
            if theirs.themes.is_empty() {
                return Err(format!("No riff themes found in {}", src.display()));
            }
            let mut index = read_index(&dir);
            let mut added = Vec::new();
            for t in &theirs.themes {
                let Some(id) = safe_id(&t.id) else { continue };
                let Ok(css) = read_css(&src.join(format!("{id}.css"))) else { continue };
                // Skip themes already imported (same name and same css).
                let dup = index.themes.iter().any(|m| m.name == t.name && std::fs::read_to_string(dir.join(format!("{}.css", m.id))).ok().as_deref() == Some(css.as_str()));
                if dup {
                    continue;
                }
                added.push(add(&dir, &mut index, &css, &t.name, Some(t))?);
            }
            write_index(&dir, &index)?;
            Ok(json!({ "added": added.iter().map(|m| with_css(&dir, m)).collect::<Vec<_>>(), "found": theirs.themes.len() }))
        }
        "setEnabled" => {
            let id = args.get("id").and_then(Value::as_str).and_then(safe_id).ok_or("bad id")?;
            let enabled = args.get("enabled").and_then(Value::as_bool).unwrap_or(false);
            let mut index = read_index(&dir);
            let m = index.themes.iter_mut().find(|m| m.id == id).ok_or("unknown theme")?;
            m.enabled = enabled;
            write_index(&dir, &index)?;
            Ok(json!(true))
        }
        "remove" => {
            let id = args.get("id").and_then(Value::as_str).and_then(safe_id).ok_or("bad id")?;
            let mut index = read_index(&dir);
            index.themes.retain(|m| m.id != id);
            write_index(&dir, &index)?;
            let _ = std::fs::remove_file(dir.join(format!("{id}.css")));
            Ok(json!(true))
        }
        "importMedia" => {
            let kind = media_kind(&args)?;
            let src = args.get("path").and_then(Value::as_str).ok_or("missing path")?;
            let dir = media_dir(app);
            let src = PathBuf::from(src);
            let dest = tauri::async_runtime::spawn_blocking(move || import_media(&dir, kind, &src)).await.map_err(|e| e.to_string())??;
            Ok(json!({ "path": dest.to_string_lossy() }))
        }
        "clearMedia" => {
            let kind = media_kind(&args)?;
            clear_media(&media_dir(app), kind);
            Ok(json!(true))
        }
        "riffAvailable" => {
            let n = riff_dir().map(|d| read_index(&d).themes.len()).unwrap_or(0);
            Ok(json!(n))
        }
        _ => Err(format!("themes: unknown command {cmd}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn header() {
        let css = "@import url('x');\n/*\n * @name Glasshouse\n * @author Talk\n * @description Black frosted glass.\n */\n:root{}";
        let (n, a, d) = parse_header(css);
        assert_eq!(n.as_deref(), Some("Glasshouse"));
        assert_eq!(a.as_deref(), Some("Talk"));
        assert_eq!(d.as_deref(), Some("Black frosted glass."));
        assert_eq!(parse_header(":root{}"), (None, None, None));
    }

    #[test]
    fn media_copy_and_clear() {
        let dir = std::env::temp_dir().join(format!("riff-media-test-{}", new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("pick.PNG");
        std::fs::write(&src, b"png").unwrap();
        let out = import_media(&dir.join("media"), "banner", &src).unwrap();
        assert_eq!(out.file_name().unwrap(), "banner.png");
        let src2 = dir.join("clip.webm");
        std::fs::write(&src2, b"webm").unwrap();
        let out2 = import_media(&dir.join("media"), "banner", &src2).unwrap();
        assert!(out2.exists() && !out.exists(), "old banner replaced");
        assert!(import_media(&dir.join("media"), "bg", &dir.join("x.exe")).is_err());
        clear_media(&dir.join("media"), "banner");
        assert!(!out2.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ids() {
        assert!(safe_id("tmvt6719o8jl2").is_some());
        assert!(safe_id("../x").is_none());
        assert!(safe_id("").is_none());
    }

    #[test]
    fn add_list_remove() {
        let dir = std::env::temp_dir().join(format!("riff-themes-test-{}", new_id()));
        let mut index = Index::default();
        let m = add(&dir, &mut index, "/* @name A */ body{}", "fallback", None).unwrap();
        write_index(&dir, &index).unwrap();
        let back = read_index(&dir);
        assert_eq!(back.themes.len(), 1);
        assert_eq!(back.themes[0].name, "A");
        assert_eq!(with_css(&dir, &m)["css"], "/* @name A */ body{}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
