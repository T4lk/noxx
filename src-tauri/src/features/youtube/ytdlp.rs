//! yt-dlp: finding it, running it without a console window, and the
//! "Required tools" download from the official GitHub release (checksum-verified).

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use super::sha256::Sha256;

pub const RELEASE_BASE: &str = "https://github.com/yt-dlp/yt-dlp/releases/latest/download";

pub fn exe_name() -> &'static str {
    if cfg!(windows) {
        "yt-dlp.exe"
    } else {
        "yt-dlp"
    }
}

/// Release asset for this OS / CPU (same table as riff's tools.js).
pub fn asset_name() -> &'static str {
    if cfg!(windows) {
        if cfg!(target_arch = "aarch64") {
            "yt-dlp_arm64.exe"
        } else if cfg!(target_arch = "x86") {
            "yt-dlp_x86.exe"
        } else {
            "yt-dlp.exe"
        }
    } else if cfg!(target_os = "macos") {
        "yt-dlp_macos"
    } else if cfg!(target_arch = "aarch64") {
        "yt-dlp_linux_aarch64"
    } else {
        "yt-dlp_linux"
    }
}

pub fn asset_url(asset: &str) -> String {
    format!("{RELEASE_BASE}/{asset}")
}

pub fn sums_url() -> String {
    format!("{RELEASE_BASE}/SHA2-256SUMS")
}

/// Finds `file`'s hash in a `sha256sum`-style listing.
pub fn expected_hash(sums: &str, file: &str) -> Option<String> {
    for line in sums.lines() {
        let line = line.trim();
        let mut parts = line.splitn(2, char::is_whitespace);
        let (Some(hash), Some(name)) = (parts.next(), parts.next()) else { continue };
        let name = name.trim().trim_start_matches('*').trim_start_matches("./");
        if hash.len() == 64 && hash.chars().all(|c| c.is_ascii_hexdigit()) && name == file {
            return Some(hash.to_ascii_lowercase());
        }
    }
    None
}

/// Lookup order: <app data>/bin, riff's copies (%APPDATA%\Riff\bin, %LOCALAPPDATA%\Riff\bin), then PATH.
pub fn candidates(app_bin: Option<&Path>, appdata: Option<&str>, localappdata: Option<&str>, path_var: Option<&str>) -> Vec<PathBuf> {
    let exe = exe_name();
    let mut out = Vec::new();
    if let Some(b) = app_bin {
        out.push(b.join(exe));
    }
    for base in [appdata, localappdata].into_iter().flatten() {
        if !base.is_empty() {
            out.push(Path::new(base).join("Riff").join("bin").join(exe));
        }
    }
    if let Some(p) = path_var {
        for dir in std::env::split_paths(p) {
            if !dir.as_os_str().is_empty() {
                out.push(dir.join(exe));
            }
        }
    }
    out
}

pub fn find(app_bin: Option<&Path>) -> Option<PathBuf> {
    let appdata = std::env::var("APPDATA").ok();
    let local = std::env::var("LOCALAPPDATA").ok();
    let path = std::env::var("PATH").ok();
    candidates(app_bin, appdata.as_deref(), local.as_deref(), path.as_deref())
        .into_iter()
        .find(|p| p.is_file() && std::fs::metadata(p).map(|m| m.len() > 1000).unwrap_or(false))
}

fn command(bin: &Path) -> Command {
    let mut c = Command::new(bin);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    c
}

/// Runs yt-dlp (blocking; call from spawn_blocking) and returns stdout.
pub fn run(bin: &Path, args: &[&str], timeout: Duration) -> Result<String, String> {
    let mut child = command(bin)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("could not start yt-dlp: {e}"))?;
    let mut out = child.stdout.take();
    let mut err = child.stderr.take();
    let out_t = std::thread::spawn(move || {
        let mut s = String::new();
        if let Some(o) = out.as_mut() {
            let _ = std::io::Read::read_to_string(o, &mut s);
        }
        s
    });
    let err_t = std::thread::spawn(move || {
        let mut s = String::new();
        if let Some(e) = err.as_mut() {
            let _ = std::io::Read::read_to_string(e, &mut s);
        }
        s
    });
    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) if start.elapsed() > timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("yt-dlp timed out after {}s", timeout.as_secs()));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(25)),
            Err(e) => return Err(e.to_string()),
        }
    };
    let stdout = out_t.join().unwrap_or_default();
    let stderr = err_t.join().unwrap_or_default();
    if status.success() {
        Ok(stdout)
    } else {
        let msg = stderr.lines().rfind(|l| l.contains("ERROR")).unwrap_or(stderr.trim()).to_string();
        Err(if msg.is_empty() { format!("yt-dlp exited with {status}") } else { msg.chars().take(300).collect() })
    }
}

/// Format selector: the same itag again (when replacing a dead direct link mid-stream), else m4a, else best audio.
pub fn format_for(itag: Option<u32>) -> String {
    match itag {
        Some(i) => format!("{i}/bestaudio[ext=m4a]/bestaudio"),
        None => "bestaudio[ext=m4a]/bestaudio".into(),
    }
}

pub fn stream_url(bin: &Path, video_id: &str, itag: Option<u32>) -> Result<String, String> {
    let url = format!("https://www.youtube.com/watch?v={video_id}");
    let f = format_for(itag);
    let out = run(bin, &["--no-config", "--no-warnings", "--no-playlist", "-f", &f, "-g", "--", &url], Duration::from_secs(25))?;
    out.lines().map(str::trim).find(|l| l.starts_with("http")).map(String::from).ok_or_else(|| "yt-dlp returned no stream URL".into())
}

/// Downloads the release asset into `bin_dir`, verifying SHA2-256SUMS. `progress(percent)`.
pub async fn install(http: &reqwest::Client, bin_dir: &Path, progress: impl Fn(u32)) -> Result<PathBuf, String> {
    use std::io::Write;
    let asset = asset_name();
    let sums = http
        .get(sums_url())
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("checksums: {e}"))?
        .text()
        .await
        .map_err(|e| e.to_string())?;
    let want = expected_hash(&sums, asset).ok_or_else(|| format!("No checksum published for {asset}"))?;
    std::fs::create_dir_all(bin_dir).map_err(|e| e.to_string())?;
    let target = bin_dir.join(exe_name());
    let tmp = bin_dir.join(format!("{}.download", exe_name()));
    let mut res = http
        .get(asset_url(asset))
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("download: {e}"))?;
    let total = res.content_length().unwrap_or(0);
    let mut file = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
    let mut hash = Sha256::new();
    let mut done: u64 = 0;
    let mut last = u32::MAX;
    loop {
        match res.chunk().await {
            Ok(Some(c)) => {
                hash.update(&c);
                file.write_all(&c).map_err(|e| e.to_string())?;
                done += c.len() as u64;
                if total > 0 {
                    let p = (done * 100).checked_div(total).unwrap_or(0) as u32;
                    if p != last {
                        last = p;
                        progress(p);
                    }
                }
            }
            Ok(None) => break,
            Err(e) => {
                drop(file);
                let _ = std::fs::remove_file(&tmp);
                return Err(format!("download: {e}"));
            }
        }
    }
    drop(file);
    if hash.hex() != want {
        let _ = std::fs::remove_file(&tmp);
        return Err("yt-dlp checksum mismatch".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755));
    }
    let _ = std::fs::remove_file(&target);
    std::fs::rename(&tmp, &target).map_err(|e| e.to_string())?;
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn youtube_ytdlp_candidates_order() {
        let sep = if cfg!(windows) { ";" } else { ":" };
        let path = format!("C:/tools{sep}{sep}D:/bin");
        let c = candidates(Some(Path::new("A:/data/bin")), Some("R:/roam"), Some("L:/local"), Some(&path));
        let exe = exe_name();
        assert_eq!(c[0], Path::new("A:/data/bin").join(exe));
        assert_eq!(c[1], Path::new("R:/roam").join("Riff").join("bin").join(exe));
        assert_eq!(c[2], Path::new("L:/local").join("Riff").join("bin").join(exe));
        assert_eq!(c[3], Path::new("C:/tools").join(exe));
        assert_eq!(c[4], Path::new("D:/bin").join(exe));
        assert_eq!(c.len(), 5);
        assert_eq!(candidates(None, None, None, None).len(), 0);
    }

    #[test]
    fn youtube_ytdlp_release_urls() {
        if cfg!(all(windows, target_arch = "x86_64")) {
            assert_eq!(asset_name(), "yt-dlp.exe");
        }
        assert_eq!(asset_url("yt-dlp.exe"), "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe");
        assert_eq!(sums_url(), "https://github.com/yt-dlp/yt-dlp/releases/latest/download/SHA2-256SUMS");
        let sums = "aaaa  other\n0123456789abcdef0123456789abcdef0123456789abcdef0123456789ABCDEF  yt-dlp.exe\nffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff *yt-dlp_x86.exe\n";
        assert_eq!(expected_hash(sums, "yt-dlp.exe").unwrap(), "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
        assert!(expected_hash(sums, "yt-dlp_x86.exe").is_some());
        assert!(expected_hash(sums, "yt-dlp_macos").is_none());
        assert_eq!(format_for(Some(140)), "140/bestaudio[ext=m4a]/bestaudio");
        assert_eq!(format_for(None), "bestaudio[ext=m4a]/bestaudio");
    }
}
