//! Localhost audio proxy for googlevideo streams.
//!
//! googlevideo only sends `Access-Control-Allow-Origin` for youtube.com origins, and the
//! core plays through Web Audio with `audio.crossOrigin = 'anonymous'`, so a direct
//! `audio.src = googlevideo URL` fails CORS. This tiny HTTP/1.1 server on 127.0.0.1
//! answers with `Access-Control-Allow-Origin: *`, supports Range (seeking), fetches the
//! upstream in ranged chunks (a single unranged request is throttled to ~2x realtime) and
//! swaps in a fresh link (yt-dlp, same itag) if the current one dies mid-stream.

use std::io::{self, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::time::Duration;

use super::{Stream, Yt};

const FIRST_CHUNK: u64 = 1 << 20; // fast start
const CHUNK: u64 = 4 << 20;

pub fn random_token() -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    let mut out = String::new();
    for i in 0..2u64 {
        let mut h = RandomState::new().build_hasher();
        h.write_u64(i);
        h.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
        h.write_u32(std::process::id());
        out.push_str(&format!("{:016x}", h.finish()));
    }
    out
}

pub fn start() -> io::Result<(u16, String)> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();
    let token = random_token();
    let tok = token.clone();
    std::thread::Builder::new().name("yt-proxy".into()).spawn(move || {
        for conn in listener.incoming() {
            let Ok(s) = conn else { continue };
            let tok = tok.clone();
            let _ = std::thread::Builder::new().name("yt-proxy-conn".into()).spawn(move || {
                if let Err(e) = serve(s, &tok) {
                    if !matches!(e.kind(), io::ErrorKind::BrokenPipe | io::ErrorKind::ConnectionReset | io::ErrorKind::ConnectionAborted) {
                        eprintln!("[youtube] proxy: {e}");
                    }
                }
            });
        }
    })?;
    Ok((port, token))
}

struct Head {
    method: String,
    path: String,
    range: Option<String>,
}

fn read_head(s: &mut TcpStream) -> io::Result<Head> {
    let mut buf = Vec::with_capacity(2048);
    let mut b = [0u8; 2048];
    loop {
        let n = s.read(&mut b)?;
        if n == 0 {
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "closed"));
        }
        buf.extend_from_slice(&b[..n]);
        if buf.windows(4).any(|w| w == b"\r\n\r\n") {
            break;
        }
        if buf.len() > 16384 {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "header too large"));
        }
    }
    let text = String::from_utf8_lossy(&buf);
    let mut lines = text.split("\r\n");
    let first = lines.next().unwrap_or("");
    let mut parts = first.split(' ');
    let method = parts.next().unwrap_or("").to_string();
    let path = parts.next().unwrap_or("").to_string();
    let mut range = None;
    for l in lines {
        if let Some((k, v)) = l.split_once(':') {
            if k.trim().eq_ignore_ascii_case("range") {
                range = Some(v.trim().to_string());
            }
        }
    }
    Ok(Head { method, path, range })
}

/// `bytes=a-b` / `bytes=a-` / `bytes=-n` -> inclusive (start, end) within `total`.
pub fn parse_range(h: &str, total: u64) -> Option<(u64, u64)> {
    let spec = h.trim().strip_prefix("bytes=")?.split(',').next()?.trim();
    let (a, b) = spec.split_once('-')?;
    if total == 0 {
        return None;
    }
    let (start, end) = if a.is_empty() {
        let n: u64 = b.parse().ok()?;
        (total.saturating_sub(n), total - 1)
    } else {
        let s: u64 = a.parse().ok()?;
        let e: u64 = if b.is_empty() { total - 1 } else { b.parse::<u64>().ok()?.min(total - 1) };
        (s, e)
    };
    (start <= end && start < total).then_some((start, end))
}

/// `/yt/<token>/<videoId>?anything` -> videoId
pub fn video_of<'a>(path: &'a str, token: &str) -> Option<&'a str> {
    let p = path.split('?').next()?;
    let rest = p.strip_prefix("/yt/")?;
    let (t, id) = rest.split_once('/')?;
    (t == token && super::innertube::valid_id(id)).then_some(id)
}

const CORS: &str = "Access-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: *\r\nAccess-Control-Allow-Private-Network: true\r\nAccess-Control-Expose-Headers: Content-Length, Content-Range, Accept-Ranges\r\n";

fn simple(s: &mut TcpStream, status: &str, body: &str) -> io::Result<()> {
    write!(s, "HTTP/1.1 {status}\r\n{CORS}Content-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len())?;
    s.flush()
}

fn block_on<F: std::future::Future>(f: F) -> F::Output {
    tauri::async_runtime::block_on(f)
}

fn serve(mut s: TcpStream, token: &str) -> io::Result<()> {
    s.set_read_timeout(Some(Duration::from_secs(15)))?;
    s.set_write_timeout(Some(Duration::from_secs(60)))?;
    let _ = s.set_nodelay(true);
    let head = read_head(&mut s)?;
    if head.method == "OPTIONS" {
        write!(s, "HTTP/1.1 204 No Content\r\n{CORS}Access-Control-Allow-Methods: GET, HEAD, OPTIONS\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")?;
        return s.flush();
    }
    if head.method != "GET" && head.method != "HEAD" {
        return simple(&mut s, "405 Method Not Allowed", "");
    }
    let Some(vid) = video_of(&head.path, token).map(String::from) else {
        return simple(&mut s, "404 Not Found", "not found");
    };
    let yt = Yt::global();
    let mut stream: Stream = match block_on(yt.stream(&vid, false)) {
        Ok(st) => st,
        Err(e) => return simple(&mut s, "502 Bad Gateway", &e),
    };
    let total = match stream.clen {
        Some(n) => n,
        None => match block_on(yt.probe_len(&stream.url)) {
            Some(n) => n,
            None => {
                // URL already dead: try one replacement before giving up
                match block_on(yt.replace_dead(&vid, &stream)) {
                    Ok(st) => {
                        let n = st.clen.or_else(|| block_on(yt.probe_len(&st.url)));
                        stream = st;
                        match n {
                            Some(n) => n,
                            None => return simple(&mut s, "502 Bad Gateway", "stream unavailable"),
                        }
                    }
                    Err(e) => return simple(&mut s, "502 Bad Gateway", &e),
                }
            }
        },
    };
    let (start, end, partial) = match &head.range {
        Some(r) => match parse_range(r, total) {
            Some((a, b)) => (a, b, true),
            None => {
                write!(s, "HTTP/1.1 416 Range Not Satisfiable\r\n{CORS}Content-Range: bytes */{total}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")?;
                return s.flush();
            }
        },
        None => (0, total.saturating_sub(1), false),
    };
    let len = end - start + 1;
    let mime = if stream.mime.is_empty() { "audio/mp4".to_string() } else { stream.mime.clone() };
    if partial {
        write!(s, "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {start}-{end}/{total}\r\n")?;
    } else {
        write!(s, "HTTP/1.1 200 OK\r\n")?;
    }
    write!(s, "{CORS}Content-Type: {mime}\r\nContent-Length: {len}\r\nAccept-Ranges: bytes\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n")?;
    if head.method == "HEAD" {
        return s.flush();
    }

    let mut pos = start;
    let mut first = true;
    let mut dead = 0;
    let mut hiccups = 0;
    while pos <= end {
        let size = if first { FIRST_CHUNK } else { CHUNK };
        let chunk_end = end.min(pos + size - 1);
        let res = block_on(yt.fetch_range(&stream.url, pos, chunk_end));
        match res {
            Ok(mut r) if r.status().as_u16() == 206 || (r.status().as_u16() == 200 && pos == 0) => {
                first = false;
                loop {
                    match block_on(r.chunk()) {
                        Ok(Some(b)) => {
                            let room = (end + 1 - pos) as usize;
                            let b = if b.len() > room { &b[..room] } else { &b[..] };
                            s.write_all(b)?;
                            pos += b.len() as u64;
                            if pos > end {
                                break;
                            }
                        }
                        Ok(None) => {
                            hiccups = 0;
                            break;
                        }
                        Err(_) => {
                            hiccups += 1;
                            break;
                        }
                    }
                }
                if hiccups > 4 {
                    return Ok(());
                }
            }
            Ok(r) if r.status().is_client_error() => {
                // 403 / 410: link died (PO token, expiry). Swap in a fresh one with the same itag.
                dead += 1;
                if dead > 2 {
                    eprintln!("[youtube] proxy: {vid} upstream {} - giving up", r.status());
                    return Ok(());
                }
                eprintln!("[youtube] proxy: {vid} upstream {} at {pos}, replacing link", r.status());
                match block_on(yt.replace_dead(&vid, &stream)) {
                    Ok(st) => {
                        if st.clen.is_some() && st.clen != Some(total) {
                            return Ok(()); // different file; the player re-resolves on error
                        }
                        stream = st;
                    }
                    Err(e) => {
                        eprintln!("[youtube] proxy: replacement failed: {e}");
                        return Ok(());
                    }
                }
            }
            _ => {
                hiccups += 1;
                if hiccups > 4 {
                    return Ok(());
                }
                std::thread::sleep(Duration::from_millis(300));
            }
        }
    }
    s.flush()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn youtube_proxy_ranges() {
        assert_eq!(parse_range("bytes=0-", 100), Some((0, 99)));
        assert_eq!(parse_range("bytes=10-19", 100), Some((10, 19)));
        assert_eq!(parse_range("bytes=90-200", 100), Some((90, 99)));
        assert_eq!(parse_range("bytes=-10", 100), Some((90, 99)));
        assert_eq!(parse_range("bytes=100-", 100), None);
        assert_eq!(parse_range("bytes=5-2", 100), None);
        assert_eq!(parse_range("items=0-1", 100), None);
        assert_eq!(video_of("/yt/abc/dQw4w9WgXcQ?n=2", "abc"), Some("dQw4w9WgXcQ"));
        assert_eq!(video_of("/yt/bad/dQw4w9WgXcQ", "abc"), None);
        assert_eq!(video_of("/yt/abc/../../etc", "abc"), None);
        assert_eq!(random_token().len(), 32);
        assert_ne!(random_token(), random_token());
    }
}
