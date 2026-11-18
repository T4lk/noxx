//! "Sign in with your browser": SoundCloud has no public OAuth app registration, and noxx
//! can't read the browser's cookies, so a small loopback page bridges the two.
//!
//! 1. noxx listens on 127.0.0.1:47231 and opens `http://127.0.0.1:47231/` in the default browser.
//! 2. That page links to soundcloud.com and offers a bookmark button ("Send login to noxx").
//! 3. Clicked on soundcloud.com, the bookmark reads the `oauth_token` cookie and navigates to
//!    `/cb#<token>`. The fragment never reaches any server; the /cb page POSTs it to `/token`.
//! 4. noxx checks the token with /me, saves the session, and the listener stops.
//!
//! The token only ever travels between the browser and this PC. The listener runs for at most
//! 10 minutes and only while a sign-in is in progress.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

pub const PORT: u16 = 47231;
const LIFETIME: Duration = Duration::from_secs(600);

fn bookmarklet() -> String {
    format!(
        "javascript:(()=>{{if(!/(^|\\.)soundcloud\\.com$/.test(location.hostname)){{alert('Open soundcloud.com first, then click this bookmark there.');return}}const m=document.cookie.match(/(?:^|; )oauth_token=([^;]+)/);if(!m){{alert('Sign in to SoundCloud first, then click this bookmark again.');return}}location.href='http://127.0.0.1:{PORT}/cb#'+m[1]}})()"
    )
}

fn page(body: &str) -> String {
    format!(
        "<!doctype html><html><head><meta charset=utf-8><meta name=viewport content=\"width=device-width,initial-scale=1\"><title>noxx · SoundCloud sign in</title>\
<style>body{{margin:0;min-height:100vh;display:grid;place-items:center;background:#070707;color:#ebebee;font:16px/1.6 system-ui,'Segoe UI',sans-serif}}\
main{{max-width:560px;padding:32px 20px}}h1{{font-size:24px;margin:0 0 18px}}ol{{padding-left:22px}}li{{margin:0 0 16px}}\
a{{color:#ebebee}}.btn{{display:inline-block;padding:10px 18px;border-radius:999px;background:#ebebee;color:#0b0b0b;font-weight:600;text-decoration:none;cursor:grab}}\
.ghost{{background:transparent;color:#ebebee;border:1px solid #333}}.muted{{color:#8d8d94;font-size:14px}}</style></head><body><main>{body}</main></body></html>"
    )
}

fn index_html() -> String {
    page(&format!(
        "<h1>Sign in to noxx with your browser</h1><ol>\
<li><b>Drag this button to your bookmarks bar</b> (Ctrl+Shift+B shows the bar):<br><br><a class=btn href=\"{}\" onclick=\"alert('Drag me to your bookmarks bar first, then click the bookmark on soundcloud.com.');return false\">Send login to noxx</a></li>\
<li><a class=\"btn ghost\" href=\"https://soundcloud.com/signin\" target=_blank rel=noopener>Open soundcloud.com</a> and sign in there as usual.</li>\
<li>On soundcloud.com, click the <b>Send login to noxx</b> bookmark. noxx is signed in after that.</li></ol>\
<p class=muted>Your login only goes to noxx on this PC (127.0.0.1). This page stops working after 10 minutes or once you're signed in. You only need to drag the bookmark once.</p>",
        bookmarklet().replace('&', "&amp;").replace('"', "&quot;")
    ))
}

fn callback_html() -> String {
    page(
        "<h1 id=t>Signing in…</h1><p id=m class=muted></p><script>\
const tok=decodeURIComponent(location.hash.slice(1));history.replaceState(null,'',location.pathname);\
const t=document.getElementById('t'),m=document.getElementById('m');\
if(!tok){t.textContent='No login found';m.textContent='Click the bookmark while you are on soundcloud.com and signed in.';}\
else fetch('/token',{method:'POST',headers:{'Content-Type':'text/plain'},body:tok}).then(r=>r.text().then(x=>[r.ok,x])).then(([ok,x])=>{\
t.textContent=ok?'You are signed in':'That did not work';m.textContent=ok?('Signed in as '+x+'. You can close this tab and go back to noxx.'):x;})\
.catch(()=>{t.textContent='noxx is not listening';m.textContent='Start the sign-in from noxx again.';});</script>",
    )
}

fn respond(sock: &mut TcpStream, status: &str, ctype: &str, body: &str) {
    let _ = sock.write_all(
        format!(
            "HTTP/1.1 {status}\r\nContent-Type: {ctype}; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
        .as_bytes(),
    );
}

/// Reads one HTTP request: (method, path, body).
fn read_request(sock: &mut TcpStream) -> Option<(String, String, String)> {
    let _ = sock.set_read_timeout(Some(Duration::from_secs(5)));
    let mut buf = Vec::with_capacity(8192);
    let mut chunk = [0u8; 4096];
    loop {
        let n = sock.read(&mut chunk).ok()?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(end) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            let head = String::from_utf8_lossy(&buf[..end]).to_string();
            let len = head
                .lines()
                .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap_or(0)))
                .unwrap_or(0)
                .min(16 * 1024);
            while buf.len() < end + 4 + len {
                let n = sock.read(&mut chunk).ok()?;
                if n == 0 {
                    break;
                }
                buf.extend_from_slice(&chunk[..n]);
            }
            let mut first = head.lines().next()?.split_whitespace();
            let method = first.next()?.to_string();
            let path = first.next()?.to_string();
            let body = String::from_utf8_lossy(&buf[end + 4..(end + 4 + len).min(buf.len())]).to_string();
            return Some((method, path, body));
        }
        if buf.len() > 64 * 1024 {
            return None;
        }
    }
    None
}

/// Opens the browser page and serves it until a valid login arrives (or 10 minutes pass).
/// Returns the signed-in username.
pub fn run(app: AppHandle) -> Result<String, String> {
    let listener = TcpListener::bind(("127.0.0.1", PORT))
        .map_err(|_| format!("Port {PORT} is busy. A browser sign-in may already be open; finish or close it first."))?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    tauri_plugin_opener::open_url(format!("http://127.0.0.1:{PORT}/"), None::<&str>).map_err(|e| e.to_string())?;
    let end = Instant::now() + LIFETIME;
    while Instant::now() < end {
        let mut sock = match listener.accept() {
            Ok((s, _)) => s,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(120));
                continue;
            }
            Err(e) => return Err(e.to_string()),
        };
        let _ = sock.set_nonblocking(false);
        let Some((method, path, body)) = read_request(&mut sock) else { continue };
        let path = path.split('?').next().unwrap_or("").to_string();
        match (method.as_str(), path.as_str()) {
            ("GET", "/") => respond(&mut sock, "200 OK", "text/html", &index_html()),
            ("GET", "/cb") => respond(&mut sock, "200 OK", "text/html", &callback_html()),
            ("POST", "/token") => {
                let token = body.trim().to_string();
                let valid = !token.is_empty() && token.len() < 200 && token.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.');
                if !valid {
                    respond(&mut sock, "400 Bad Request", "text/plain", "That doesn't look like a SoundCloud login.");
                    continue;
                }
                let sc = app.state::<crate::AppState>().sc.clone();
                match tauri::async_runtime::block_on(sc.login_with_token(&token)) {
                    Ok(status) => {
                        let name = status.username.clone();
                        respond(&mut sock, "200 OK", "text/plain", if name.trim().is_empty() { "your account" } else { &name });
                        return Ok(name);
                    }
                    Err(e) => respond(&mut sock, "401 Unauthorized", "text/plain", &format!("SoundCloud didn't accept that login: {e}")),
                }
            }
            _ => respond(&mut sock, "404 Not Found", "text/plain", "Not found"),
        }
    }
    Err("Browser sign-in timed out. Start it again from noxx.".into())
}

#[cfg(test)]
mod tests {
    #[test]
    fn bookmarklet_targets_loopback_only() {
        let b = super::bookmarklet();
        assert!(b.starts_with("javascript:"));
        assert!(b.contains("http://127.0.0.1:47231/cb#"));
        assert!(b.contains("oauth_token"));
    }
}
