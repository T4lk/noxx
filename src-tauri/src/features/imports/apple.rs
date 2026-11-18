//! Apple Music: albums through the public iTunes lookup API, playlists from the
//! JSON Apple embeds in its public playlist page.

use std::collections::HashSet;
use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;

use super::{http, Item, Remote, UA};

static ALBUM: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)music\.apple\.com/(?:([a-z]{2})/)?album/(?:[^/?#]+/)?(\d+)").unwrap());
static PLAYLIST: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)music\.apple\.com/.*?(pl\.(?:u-)?[a-zA-Z0-9_-]+)").unwrap());
static SONG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)music\.apple\.com/(?:([a-z]{2})/)?song/(?:[^/?#]+/)?(\d+)").unwrap());
static SERVER_DATA: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)<script\s+type=["']application/json["']\s+id=["']serialized-server-data["'][^>]*>([\s\S]*?)</script>"#).unwrap()
});
static LD_JSON: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)<script\s+id=["']schema:music-playlist["']\s+type=["']application/ld\+json["'][^>]*>([\s\S]*?)</script>"#).unwrap()
});
static OG_TITLE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(?i)<meta\s+property=["']og:title["']\s+content=["']([^"']*)["']"#).unwrap());
static OG_IMAGE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(?i)<meta\s+property=["']og:image["']\s+content=["']([^"']*)["']"#).unwrap());
static ISO_DUR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?").unwrap());

pub fn is_link(text: &str) -> bool {
    text.to_lowercase().contains("music.apple.com/")
}

fn s(v: &Value) -> String {
    v.as_str().unwrap_or("").trim().to_string()
}

pub async fn fetch(url: &str) -> Result<Remote, String> {
    if let Some(c) = ALBUM.captures(url) {
        let cc = c.get(1).map(|m| m.as_str().to_lowercase()).unwrap_or_else(|| "us".into());
        return lookup(&c[2], &cc, url.contains("?i=").then(|| url_param(url, "i")).flatten()).await;
    }
    if let Some(c) = SONG.captures(url) {
        let cc = c.get(1).map(|m| m.as_str().to_lowercase()).unwrap_or_else(|| "us".into());
        return lookup(&c[2], &cc, None).await;
    }
    if PLAYLIST.is_match(url) {
        return playlist(url).await;
    }
    Err("That isn't an Apple Music playlist, album or song link.".into())
}

fn url_param(url: &str, key: &str) -> Option<String> {
    url::Url::parse(url).ok()?.query_pairs().find(|(k, _)| k == key).map(|(_, v)| v.to_string())
}

/// Album (or single song) via itunes.apple.com/lookup.
async fn lookup(id: &str, country: &str, only: Option<String>) -> Result<Remote, String> {
    let u = format!("https://itunes.apple.com/lookup?id={id}&entity=song&limit=300&country={country}");
    let v: Value = http().get(&u).header("User-Agent", UA).send().await.map_err(|e| e.to_string())?.json().await.map_err(|e| e.to_string())?;
    let results = v["results"].as_array().cloned().unwrap_or_default();
    let head = results.iter().find(|r| r["wrapperType"] == "collection").or_else(|| results.first());
    let Some(head) = head else { return Err("Apple Music: not found in this region.".into()) };
    let mut tracks: Vec<Item> = results
        .iter()
        .filter(|r| r["wrapperType"] == "track")
        .filter(|r| only.as_deref().map_or(true, |o| r["trackId"].to_string() == o))
        .map(|r| {
            let artist = [s(&r["artistName"]), s(&head["artistName"])].into_iter().find(|a| !a.is_empty()).unwrap_or_default();
            Item::new(s(&r["trackName"]), artist, r["trackTimeMillis"].as_f64().map(|m| (m / 1000.0).round() as u64).unwrap_or(0))
        })
        .filter(|i| !i.title.is_empty())
        .collect();
    tracks.dedup_by(|a, b| a.title == b.title && a.artist == b.artist);
    if tracks.is_empty() {
        return Err("Apple Music: this album has no tracks available.".into());
    }
    let name = [s(&head["collectionName"]), s(&head["trackName"])].into_iter().find(|n| !n.is_empty()).unwrap_or_else(|| "Album".into());
    Ok(Remote {
        name,
        cover: s(&head["artworkUrl100"]).replace("100x100", "600x600"),
        source: "apple",
        total: tracks.len(),
        partial: false,
        note: String::new(),
        tracks,
    })
}

async fn playlist(url: &str) -> Result<Remote, String> {
    let r = http()
        .get(url)
        .header("User-Agent", UA)
        .header("Accept-Language", "en-US,en;q=0.9")
        .send()
        .await
        .map_err(|e| format!("Network error connecting to Apple Music: {e}"))?;
    match r.status().as_u16() {
        200 => {}
        404 => return Err("Apple Music: playlist not found.".into()),
        429 => return Err("Apple Music is rate limiting. Try again in a minute.".into()),
        401 | 403 => return Err("This Apple Music playlist is private.".into()),
        s => return Err(format!("Apple Music returned status {s}")),
    }
    let body = r.text().await.map_err(|e| e.to_string())?;
    parse_playlist(&body)
}

#[derive(Default)]
struct Walk {
    title: String,
    cover: String,
    count: usize,
    seen: HashSet<String>,
    tracks: Vec<Item>,
}

fn duration(v: &Value) -> u64 {
    if let Some(n) = v.as_f64() {
        return if n > 1000.0 { (n / 1000.0).round() as u64 } else { n.round() as u64 };
    }
    if let Some(c) = v.as_str().and_then(|t| ISO_DUR.captures(t)) {
        let n = |i: usize| c.get(i).and_then(|m| m.as_str().parse::<u64>().ok()).unwrap_or(0);
        return n(1) * 3600 + n(2) * 60 + n(3);
    }
    0
}

impl Walk {
    fn node(&mut self, n: &Value) {
        match n {
            Value::Array(a) => a.iter().for_each(|x| self.node(x)),
            Value::Object(o) => {
                let kind = n["contentDescriptor"]["kind"].as_str().or(n["type"].as_str()).unwrap_or("");
                if self.title.is_empty() {
                    if matches!(kind, "playlist" | "playlists") {
                        self.title = [s(&n["title"]), s(&n["name"]), s(&n["attributes"]["name"])].into_iter().find(|t| !t.is_empty()).unwrap_or_default();
                        self.cover = [s(&n["artwork"]["dictionary"]["url"]), s(&n["artwork"]["url"])].into_iter().find(|t| !t.is_empty()).unwrap_or_default();
                    } else if n["@type"] == "MusicPlaylist" {
                        self.title = s(&n["name"]);
                    }
                }
                if self.count == 0 {
                    if let Some(c) = n["trackCount"].as_u64() {
                        self.count = c as usize;
                    }
                }
                let recording = n["@type"] == "MusicRecording" || kind == "songs";
                let title = n["title"].as_str().map(str::to_string).or_else(|| recording.then(|| s(&n["name"]))).unwrap_or_default().trim().to_string();
                let artist = [s(&n["artistName"]), s(&n["artist"]), s(&n["byArtist"]["name"])].into_iter().find(|a| !a.is_empty()).unwrap_or_default();
                let dur = duration(if !n["durationInMillis"].is_null() { &n["durationInMillis"] } else if !n["duration"].is_null() { &n["duration"] } else { &n["duration_ms"] });
                let songish = matches!(kind, "song" | "music-video" | "songs" | "library-songs") || recording || dur > 0 || !n["audioTraits"].is_null();
                if !title.is_empty() && !artist.is_empty() && songish {
                    if self.seen.insert(format!("{}\u{1}{}", title.to_lowercase(), artist.to_lowercase())) {
                        self.tracks.push(Item::new(title, artist, dur));
                    }
                    return;
                }
                o.values().for_each(|x| self.node(x));
            }
            _ => {}
        }
    }
}

pub fn parse_playlist(body: &str) -> Result<Remote, String> {
    let data: Option<Value> = SERVER_DATA
        .captures(body)
        .and_then(|c| serde_json::from_str(&c[1]).ok())
        .or_else(|| LD_JSON.captures(body).and_then(|c| serde_json::from_str(&c[1]).ok()));
    let Some(data) = data else {
        return Err("This Apple Music playlist is private or couldn't be read.".into());
    };
    let mut w = Walk::default();
    w.node(&data);
    if w.title.is_empty() {
        if let Some(c) = OG_TITLE.captures(body) {
            w.title = c[1].trim_end_matches(" on Apple Music").trim().to_string();
        }
    }
    if w.cover.is_empty() {
        if let Some(c) = OG_IMAGE.captures(body) {
            w.cover = c[1].to_string();
        }
    }
    w.cover = w.cover.replace("{w}x{h}bb.{f}", "600x600bb.jpg").replace("{w}x{h}", "600x600").replace("{f}", "jpg");
    if w.tracks.is_empty() {
        return Err("This Apple Music playlist is private or empty.".into());
    }
    let total = w.count.max(w.tracks.len());
    let partial = total > w.tracks.len();
    Ok(Remote {
        name: if w.title.is_empty() { "Apple Music playlist".into() } else { w.title },
        cover: w.cover,
        source: "apple",
        total,
        partial,
        note: if partial { format!("Apple's page only lists {} of {total} tracks. Use Export files to import all of them.", w.tracks.len()) } else { String::new() },
        tracks: w.tracks,
    })
}
