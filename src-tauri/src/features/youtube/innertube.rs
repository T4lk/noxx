//! InnerTube (youtubei/v1) calls: YouTube + YouTube Music search, the player
//! endpoint (plain audio URLs) and playlist browse. Parsing is pure and unit-tested.

use serde_json::{json, Value};

use crate::soundcloud::Track;

pub const BROWSER_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
pub const WEB_VERSION: &str = "2.20250101.00.00";
/// riff's YouTube Music client (server.js YTM_CLIENT_VERSION / YTM_SONGS_PARAMS).
pub const YTM_VERSION: &str = "1.20250101.01.00";
pub const YTM_SONGS_PARAMS: &str = "EgWKAQIIAWoMEA4QChADEAQQCRAF";
/// "Type: Video" filter on www.youtube.com.
pub const YT_VIDEOS_PARAMS: &str = "EgIQAQ==";
/// www.youtube.com search: sort by view count (1: 3), upload date this month (2.1: 4), type video (2.2: 1).
pub const YT_TRENDING_PARAMS: &str = "CAMSBAgEEAE=";

pub const VISIONOS_UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15";
pub const ANDROID_VR_UA: &str = "com.google.android.apps.youtube.vr.oculus/1.62.27 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip";

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Src {
    Youtube,
    Music,
}

impl Src {
    pub fn parse(s: &str) -> Src {
        if s == "ytmusic" || s == "music" {
            Src::Music
        } else {
            Src::Youtube
        }
    }
    pub fn key(self) -> &'static str {
        match self {
            Src::Youtube => "youtube",
            Src::Music => "ytmusic",
        }
    }
}

pub fn web_context(visitor: &str) -> Value {
    let mut c = json!({ "clientName": "WEB", "clientVersion": WEB_VERSION, "hl": "en", "gl": "US" });
    if !visitor.is_empty() {
        c["visitorData"] = json!(visitor);
    }
    json!({ "client": c })
}

pub fn ytm_context(visitor: &str) -> Value {
    let mut c = json!({ "clientName": "WEB_REMIX", "clientVersion": YTM_VERSION, "hl": "en", "gl": "US" });
    if !visitor.is_empty() {
        c["visitorData"] = json!(visitor);
    }
    json!({ "client": c })
}

/// Player clients that hand out plain (non-ciphered) audio URLs without a JS runtime / PO token.
/// (name, header id, version, user agent, extra client fields)
pub struct PlayerClient {
    pub name: &'static str,
    pub id: &'static str,
    pub version: &'static str,
    pub ua: &'static str,
}

pub const PLAYER_CLIENTS: [PlayerClient; 2] = [
    PlayerClient { name: "VISIONOS", id: "101", version: "1.02", ua: VISIONOS_UA },
    PlayerClient { name: "ANDROID_VR", id: "28", version: "1.62.27", ua: ANDROID_VR_UA },
];

pub fn player_body(c: &PlayerClient, video_id: &str, visitor: &str) -> Value {
    let mut client = match c.name {
        "VISIONOS" => json!({
            "clientName": "VISIONOS", "clientVersion": c.version, "deviceMake": "Apple", "deviceModel": "RealityDevice17,1",
            "userAgent": c.ua, "osName": "visionOS", "osVersion": "26.5.23O471", "hl": "en", "timeZone": "UTC", "utcOffsetMinutes": 0
        }),
        _ => json!({
            "clientName": c.name, "clientVersion": c.version, "deviceMake": "Oculus", "deviceModel": "Quest 3",
            "androidSdkVersion": 32, "userAgent": c.ua, "osName": "Android", "osVersion": "12L", "hl": "en", "gl": "US"
        }),
    };
    if !visitor.is_empty() {
        client["visitorData"] = json!(visitor);
    }
    json!({
        "context": { "client": client },
        "videoId": video_id,
        "playbackContext": { "contentPlaybackContext": { "html5Preference": "HTML5_PREF_WANTS" } },
        "contentCheckOk": true,
        "racyCheckOk": true
    })
}

// ---------------------------------------------------------------- helpers

pub fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Some(v) = std::str::from_utf8(&b[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// "4:05" / "1:02:03" -> seconds.
pub fn parse_duration(text: &str) -> u64 {
    let t = text.trim();
    if t.is_empty() || !t.split(':').all(|p| !p.is_empty() && p.len() <= 2 && p.chars().all(|c| c.is_ascii_digit())) {
        return 0;
    }
    let parts: Vec<u64> = t.split(':').filter_map(|p| p.parse().ok()).collect();
    if parts.len() < 2 || parts.len() > 3 {
        return 0;
    }
    parts.iter().fold(0, |a, n| a * 60 + n)
}

pub(super) fn text_of(v: &Value) -> String {
    if let Some(s) = v["simpleText"].as_str() {
        return s.to_string();
    }
    v["runs"].as_array().map(|r| r.iter().filter_map(|x| x["text"].as_str()).collect::<String>()).unwrap_or_default()
}

pub fn valid_id(id: &str) -> bool {
    id.len() == 11 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

pub fn clean_artist(a: &str) -> String {
    let a = a.trim();
    let a = a.strip_suffix(" - Topic").unwrap_or(a);
    a.trim().to_string()
}

/// Collects every object under `key` anywhere in `v` (depth-first, document order).
pub(super) fn collect<'a>(v: &'a Value, key: &str, out: &mut Vec<&'a Value>) {
    match v {
        Value::Object(m) => {
            for (k, x) in m {
                if k == key {
                    out.push(x);
                } else {
                    collect(x, key, out);
                }
            }
        }
        Value::Array(a) => a.iter().for_each(|x| collect(x, key, out)),
        _ => {}
    }
}

/// Next-page token: `continuationCommand.token` (www / new YTM) or `nextContinuationData.continuation` (YTM shelves).
pub fn continuation(v: &Value) -> Option<String> {
    let mut found = Vec::new();
    collect(v, "continuationItemRenderer", &mut found);
    for c in found {
        if let Some(t) = c["continuationEndpoint"]["continuationCommand"]["token"].as_str() {
            return Some(t.to_string());
        }
    }
    let mut found = Vec::new();
    collect(v, "nextContinuationData", &mut found);
    found.first().and_then(|c| c["continuation"].as_str()).map(String::from)
}

pub fn yt_thumb(id: &str) -> String {
    format!("https://i.ytimg.com/vi/{id}/hq720.jpg")
}

#[allow(clippy::too_many_arguments)]
pub(super) fn track(id: &str, title: String, artist: String, duration: u64, artwork: String, url: String, channel: &str, channel_url: String) -> Track {
    Track {
        id: format!("yt:{id}"),
        title: if title.is_empty() { "untitled".into() } else { title },
        artist: if artist.is_empty() { "unknown artist".into() } else { artist },
        duration,
        artwork,
        url,
        artist_id: channel.to_string(),
        artist_url: channel_url,
        genre: String::new(),
        style: String::new(),
        source: "youtube".into(),
        path: String::new(),
    }
}

// ---------------------------------------------------------------- www.youtube.com search

pub fn parse_yt_videos(v: &Value) -> Vec<Track> {
    let mut items = Vec::new();
    collect(v, "videoRenderer", &mut items);
    let mut out: Vec<Track> = Vec::new();
    for r in items {
        let Some(id) = r["videoId"].as_str() else { continue };
        if !valid_id(id) || out.iter().any(|t| t.id[3..] == *id) {
            continue;
        }
        let duration = parse_duration(&text_of(&r["lengthText"]));
        if duration == 0 {
            continue; // live streams / premieres
        }
        let owner = if r["ownerText"].is_object() { &r["ownerText"] } else { &r["longBylineText"] };
        let artist = clean_artist(&text_of(owner));
        let channel = owner["runs"][0]["navigationEndpoint"]["browseEndpoint"]["browseId"].as_str().unwrap_or("");
        let channel_url = if channel.is_empty() { String::new() } else { format!("https://www.youtube.com/channel/{channel}") };
        out.push(track(id, text_of(&r["title"]), artist, duration, yt_thumb(id), format!("https://www.youtube.com/watch?v={id}"), channel, channel_url));
    }
    out
}

/// YouTube Music artwork: square album art upscaled like riff (=w544-h544), else the video thumbnail.
pub(super) fn ytm_art(url: &str, id: &str) -> String {
    if url.is_empty() || url.contains("i.ytimg.com/vi/") {
        yt_thumb(id)
    } else if let Some(p) = url.find("=w") {
        format!("{}=w544-h544-l90-rj", &url[..p])
    } else {
        url.to_string()
    }
}

/// Trending picks: songs only (1 to 15 minutes), no full albums / DJ mixes / compilations.
pub fn trending_song(t: &Track) -> bool {
    if t.duration < 60 || t.duration > 15 * 60 {
        return false;
    }
    let words: Vec<String> = t.title.to_lowercase().split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()).map(String::from).collect();
    let has = |w: &str| words.iter().any(|x| x == w);
    let pair = |a: &str, b: &str| words.windows(2).any(|p| p[0] == a && p[1] == b);
    // "dj" in a trending title is almost always a regional "DJ song / DJ remix" upload, not the genre.
    !(has("mix") || has("megamix") || has("mashup") || has("medley") || has("mixtape") || has("compilation") || has("playlist") || has("nonstop") || has("dj")
        || pair("full", "album") || pair("full", "ep") || pair("dj", "set") || pair("live", "set")
        || words.windows(2).any(|p| p[0].chars().all(|c| c.is_ascii_digit()) && matches!(p[1].as_str(), "hour" | "hours" | "hr")))
}

// ---------------------------------------------------------------- music.youtube.com search (riff's parseYtmSongs)

pub fn parse_ytm_songs(v: &Value) -> Vec<Track> {
    let mut items = Vec::new();
    collect(v, "musicResponsiveListItemRenderer", &mut items);
    let mut out: Vec<Track> = Vec::new();
    for r in items {
        let cols = r["flexColumns"].as_array().cloned().unwrap_or_default();
        let runs = |i: usize| -> Vec<Value> {
            cols.get(i).and_then(|c| c["musicResponsiveListItemFlexColumnRenderer"]["text"]["runs"].as_array().cloned()).unwrap_or_default()
        };
        let col0 = runs(0);
        let id = r["playlistItemData"]["videoId"]
            .as_str()
            .or_else(|| r["overlay"]["musicItemThumbnailOverlayRenderer"]["content"]["musicPlayButtonRenderer"]["playNavigationEndpoint"]["watchEndpoint"]["videoId"].as_str())
            .or_else(|| col0.first().and_then(|x| x["navigationEndpoint"]["watchEndpoint"]["videoId"].as_str()))
            .unwrap_or("");
        if !valid_id(id) || out.iter().any(|t| t.id[3..] == *id) {
            continue;
        }
        let title: String = col0.iter().filter_map(|x| x["text"].as_str()).collect::<String>().trim().to_string();
        let col1 = runs(1);
        let mut segs: Vec<String> = Vec::new();
        let mut cur = String::new();
        let mut channel = String::new();
        for run in &col1 {
            let t = run["text"].as_str().unwrap_or("");
            if t == " • " {
                segs.push(cur.trim().to_string());
                cur.clear();
            } else {
                cur.push_str(t);
                if channel.is_empty() && segs.is_empty() {
                    if let Some(b) = run["navigationEndpoint"]["browseEndpoint"]["browseId"].as_str() {
                        if b.starts_with("UC") {
                            channel = b.to_string();
                        }
                    }
                }
            }
        }
        segs.push(cur.trim().to_string());
        let mut clean: Vec<String> = segs.into_iter().filter(|s| !s.is_empty() && !s.eq_ignore_ascii_case("song") && !s.eq_ignore_ascii_case("video")).collect();
        let mut duration = 0;
        if let Some(last) = clean.last() {
            let d = parse_duration(last);
            if d > 0 {
                duration = d;
                clean.pop();
            }
        }
        if duration == 0 {
            // playlist rows keep the length in a fixed column
            duration = r["fixedColumns"][0]["musicResponsiveListItemFixedColumnRenderer"]["text"]["runs"][0]["text"].as_str().map(parse_duration).unwrap_or(0);
        }
        if title.is_empty() || (duration > 0 && duration < 30) {
            continue;
        }
        let artist = clean_artist(clean.first().map(String::as_str).unwrap_or(""));
        let thumbs = r["thumbnail"]["musicThumbnailRenderer"]["thumbnail"]["thumbnails"].as_array();
        let art = ytm_art(thumbs.and_then(|t| t.last()).and_then(|t| t["url"].as_str()).unwrap_or(""), id);
        let channel_url = if channel.is_empty() { String::new() } else { format!("https://music.youtube.com/channel/{channel}") };
        out.push(track(id, title, artist, duration, art, format!("https://music.youtube.com/watch?v={id}"), &channel, channel_url));
    }
    out
}

// ---------------------------------------------------------------- player

#[derive(Clone, Debug, PartialEq)]
pub struct AudioFormat {
    pub url: String,
    pub itag: u32,
    pub mime: String,
    pub clen: Option<u64>,
    pub bitrate: u64,
}

/// Picks the audio format: m4a 140 first (plays everywhere), then opus 251, then the best remaining.
pub fn pick_audio(player: &Value) -> Option<AudioFormat> {
    let formats = player["streamingData"]["adaptiveFormats"].as_array()?;
    let mut audio: Vec<AudioFormat> = formats
        .iter()
        .filter(|f| f["mimeType"].as_str().unwrap_or("").starts_with("audio/") && f["url"].is_string())
        .filter(|f| f["audioTrack"].is_null() || f["audioTrack"]["audioIsDefault"].as_bool().unwrap_or(true))
        .map(|f| AudioFormat {
            url: f["url"].as_str().unwrap_or("").to_string(),
            itag: f["itag"].as_u64().unwrap_or(0) as u32,
            mime: f["mimeType"].as_str().unwrap_or("").split(';').next().unwrap_or("").to_string(),
            clen: f["contentLength"].as_str().and_then(|s| s.parse().ok()),
            bitrate: f["bitrate"].as_u64().unwrap_or(0),
        })
        .collect();
    let rank = |f: &AudioFormat| match f.itag {
        140 => 0,
        251 => 1,
        _ => 2,
    };
    audio.sort_by(|a, b| rank(a).cmp(&rank(b)).then(b.bitrate.cmp(&a.bitrate)));
    audio.into_iter().next()
}

pub fn playable(player: &Value) -> Result<(), String> {
    let s = player["playabilityStatus"]["status"].as_str().unwrap_or("");
    if s == "OK" {
        Ok(())
    } else {
        let reason = player["playabilityStatus"]["reason"].as_str().unwrap_or("unavailable");
        Err(format!("{s}: {reason}"))
    }
}

pub fn track_from_player(player: &Value, music: bool) -> Option<Track> {
    let d = &player["videoDetails"];
    let id = d["videoId"].as_str()?;
    if !valid_id(id) {
        return None;
    }
    let channel = d["channelId"].as_str().unwrap_or("");
    let host = if music { "music.youtube.com" } else { "www.youtube.com" };
    Some(track(
        id,
        d["title"].as_str().unwrap_or("").to_string(),
        clean_artist(d["author"].as_str().unwrap_or("")),
        d["lengthSeconds"].as_str().and_then(|s| s.parse().ok()).unwrap_or(0),
        yt_thumb(id),
        format!("https://{host}/watch?v={id}"),
        channel,
        if channel.is_empty() { String::new() } else { format!("https://{host}/channel/{channel}") },
    ))
}

// ---------------------------------------------------------------- links & URLs

pub fn is_link(text: &str) -> bool {
    let t = text.trim().to_ascii_lowercase();
    let t = t.strip_prefix("https://").or_else(|| t.strip_prefix("http://")).unwrap_or(&t);
    ["youtube.com/", "www.youtube.com/", "m.youtube.com/", "music.youtube.com/", "youtu.be/"].iter().any(|p| t.starts_with(p))
}

#[derive(Debug, PartialEq, Default)]
pub struct Link {
    pub video: Option<String>,
    pub list: Option<String>,
    pub music: bool,
}

pub fn parse_link(text: &str) -> Option<Link> {
    if !is_link(text) {
        return None;
    }
    let t = text.trim();
    let full = if t.contains("://") { t.to_string() } else { format!("https://{t}") };
    let u = url::Url::parse(&full).ok()?;
    let host = u.host_str().unwrap_or("").to_ascii_lowercase();
    let mut l = Link { music: host == "music.youtube.com", ..Default::default() };
    for (k, v) in u.query_pairs() {
        if k == "v" && valid_id(&v) {
            l.video = Some(v.to_string());
        } else if k == "list" && !v.is_empty() && v.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
            l.list = Some(v.to_string());
        }
    }
    let segs: Vec<&str> = u.path_segments().map(|s| s.filter(|x| !x.is_empty()).collect()).unwrap_or_default();
    if l.video.is_none() {
        let cand = if host == "youtu.be" {
            segs.first().copied()
        } else if matches!(segs.first().copied(), Some("shorts" | "embed" | "live" | "v")) {
            segs.get(1).copied()
        } else {
            None
        };
        if let Some(c) = cand.filter(|c| valid_id(c)) {
            l.video = Some(c.to_string());
        }
    }
    if l.video.is_none() && l.list.is_none() {
        return None;
    }
    Some(l)
}

/// googlevideo `expire=` (unix seconds) from a stream URL.
pub fn url_param(url: &str, key: &str) -> Option<String> {
    let q = url.split_once('?')?.1;
    q.split('&').find_map(|kv| {
        let (k, v) = kv.split_once('=')?;
        (k == key).then(|| percent_decode(v))
    })
}

pub fn expire_of(url: &str) -> Option<u64> {
    url_param(url, "expire").and_then(|s| s.parse().ok()).or_else(|| {
        // HLS-style path params: /expire/1795034429/
        let i = url.find("/expire/")?;
        url[i + 8..].split('/').next()?.parse().ok()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn youtube_durations_and_ids() {
        assert_eq!(parse_duration("4:05"), 245);
        assert_eq!(parse_duration("1:02:03"), 3723);
        assert_eq!(parse_duration("Song"), 0);
        assert_eq!(parse_duration("12"), 0);
        assert!(valid_id("dQw4w9WgXcQ"));
        assert!(!valid_id("dQw4w9WgXc"));
        assert_eq!(clean_artist("Daft Punk - Topic"), "Daft Punk");
        assert_eq!(percent_decode("Cgt3dn%3D%3D"), "Cgt3dn==");
    }

    #[test]
    fn youtube_links() {
        assert!(is_link("https://www.youtube.com/watch?v=dQw4w9WgXcQ"));
        assert!(is_link("youtu.be/dQw4w9WgXcQ"));
        assert!(!is_link("daft punk youtube.com"));
        assert!(!is_link("https://soundcloud.com/x/y"));
        let l = parse_link("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123&t=4").unwrap();
        assert_eq!(l.video.as_deref(), Some("dQw4w9WgXcQ"));
        assert_eq!(l.list.as_deref(), Some("PL123"));
        assert!(!l.music);
        let l = parse_link("https://youtu.be/dQw4w9WgXcQ?si=abc").unwrap();
        assert_eq!(l.video.as_deref(), Some("dQw4w9WgXcQ"));
        let l = parse_link("music.youtube.com/watch?v=mqgEYRtWMJU&feature=share").unwrap();
        assert!(l.music);
        assert_eq!(l.video.as_deref(), Some("mqgEYRtWMJU"));
        let l = parse_link("https://www.youtube.com/shorts/dQw4w9WgXcQ").unwrap();
        assert_eq!(l.video.as_deref(), Some("dQw4w9WgXcQ"));
        let l = parse_link("https://www.youtube.com/playlist?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG").unwrap();
        assert!(l.video.is_none());
        assert!(l.list.is_some());
        assert!(parse_link("https://www.youtube.com/@channel").is_none());
    }

    #[test]
    fn youtube_stream_url_params() {
        let u = "https://rr6---sn-x.googlevideo.com/videoplayback?expire=1795034142&ei=x&itag=140&mime=audio%2Fmp4&clen=3449447&dur=213.1";
        assert_eq!(expire_of(u), Some(1795034142));
        assert_eq!(url_param(u, "mime").as_deref(), Some("audio/mp4"));
        assert_eq!(url_param(u, "clen").as_deref(), Some("3449447"));
        assert_eq!(expire_of("https://manifest.googlevideo.com/api/manifest/hls_variant/expire/1795034429/ei/3b"), Some(1795034429));
        assert_eq!(expire_of("https://x/y"), None);
    }

    #[test]
    fn youtube_parse_search() {
        let yt = json!({ "contents": { "twoColumnSearchResultsRenderer": { "primaryContents": { "sectionListRenderer": { "contents": [
            { "itemSectionRenderer": { "contents": [
                { "videoRenderer": { "videoId": "a5uQMwRMHcs", "title": { "runs": [{ "text": "Instant Crush" }] },
                  "ownerText": { "runs": [{ "text": "Daft Punk", "navigationEndpoint": { "browseEndpoint": { "browseId": "UC_kRDKYrUlrbtrSiyu5Tflg" } } }] },
                  "lengthText": { "simpleText": "5:40" } } },
                { "videoRenderer": { "videoId": "liveliveliv", "title": { "runs": [{ "text": "Live" }] } } }
            ] } },
            { "continuationItemRenderer": { "continuationEndpoint": { "continuationCommand": { "token": "TOKEN1" } } } }
        ] } } } } });
        let t = parse_yt_videos(&yt);
        assert_eq!(t.len(), 1);
        assert_eq!(t[0].id, "yt:a5uQMwRMHcs");
        assert_eq!(t[0].source, "youtube");
        assert_eq!(t[0].artist, "Daft Punk");
        assert_eq!(t[0].duration, 340);
        assert_eq!(t[0].artwork, "https://i.ytimg.com/vi/a5uQMwRMHcs/hq720.jpg");
        assert_eq!(t[0].url, "https://www.youtube.com/watch?v=a5uQMwRMHcs");
        assert_eq!(t[0].artist_url, "https://www.youtube.com/channel/UC_kRDKYrUlrbtrSiyu5Tflg");
        assert_eq!(continuation(&yt).as_deref(), Some("TOKEN1"));

        let ytm = json!({ "contents": { "tabbedSearchResultsRenderer": { "tabs": [{ "tabRenderer": { "content": { "sectionListRenderer": { "contents": [
            { "musicShelfRenderer": { "contents": [
                { "musicResponsiveListItemRenderer": {
                    "playlistItemData": { "videoId": "mqgEYRtWMJU" },
                    "thumbnail": { "musicThumbnailRenderer": { "thumbnail": { "thumbnails": [{ "url": "https://lh3.googleusercontent.com/abc=w60-h60-l90-rj" }, { "url": "https://lh3.googleusercontent.com/abc=w120-h120-l90-rj" }] } } },
                    "flexColumns": [
                        { "musicResponsiveListItemFlexColumnRenderer": { "text": { "runs": [{ "text": "The Son of Flynn" }] } } },
                        { "musicResponsiveListItemFlexColumnRenderer": { "text": { "runs": [
                            { "text": "Daft Punk", "navigationEndpoint": { "browseEndpoint": { "browseId": "UCRr1xG_2WIDs18a6cIiCxeA" } } },
                            { "text": " • " }, { "text": "TRON: Legacy" }, { "text": " • " }, { "text": "1:36" } ] } } }
                    ] } }
            ], "continuations": [{ "nextContinuationData": { "continuation": "CTOK" } }] } }
        ] } } } }] } } });
        let t = parse_ytm_songs(&ytm);
        assert_eq!(t.len(), 1);
        assert_eq!(t[0].id, "yt:mqgEYRtWMJU");
        assert_eq!(t[0].title, "The Son of Flynn");
        assert_eq!(t[0].artist, "Daft Punk");
        assert_eq!(t[0].duration, 96);
        assert_eq!(t[0].artwork, "https://lh3.googleusercontent.com/abc=w544-h544-l90-rj");
        assert_eq!(t[0].url, "https://music.youtube.com/watch?v=mqgEYRtWMJU");
        assert_eq!(t[0].artist_id, "UCRr1xG_2WIDs18a6cIiCxeA");
        assert_eq!(continuation(&ytm).as_deref(), Some("CTOK"));
    }

    #[test]
    fn youtube_parse_trending() {
        let v = |id: &str, title: &str, len: &str| json!({ "videoRenderer": { "videoId": id, "title": { "runs": [{ "text": title }] },
            "ownerText": { "runs": [{ "text": "Some Channel", "navigationEndpoint": { "browseEndpoint": { "browseId": "UCabc" } } }] },
            "lengthText": { "simpleText": len }, "viewCountText": { "simpleText": "2,345,227 views" } } });
        let page = json!({ "contents": { "twoColumnSearchResultsRenderer": { "primaryContents": { "sectionListRenderer": { "contents": [
            { "itemSectionRenderer": { "contents": [
                v("rkg946FdrWA", "1 Nacht auf einer Hardtekk-Party", "36:27"),
                v("l3J6cYVBleM", "Riogeovn - AINSI BAS LA VIDA HARDTEKK", "2:05"),
                v("c1l2d-Oc4xs", "INSTINCT.404 (Hardtekk)", "0:58"),
                v("aaaaaaaaaaa", "Hardtekk Mix 2025 | Best Of", "9:00"),
                v("bbbbbbbbbbb", "Song (Hardtekk Remix)", "3:10"),
                v("ccccccccccc", "Artist - Full Album", "12:00"),
                v("ddddddddddd", "1 Hour Hardtekk", "14:00"),
                v("eeeeeeeeeee", "New Tiktok Mashup 2026 Party Music", "8:00")
            ] } }
        ] } } } } });
        let t: Vec<Track> = parse_yt_videos(&page).into_iter().filter(trending_song).collect();
        let ids: Vec<&str> = t.iter().map(|x| x.id.as_str()).collect();
        assert_eq!(ids, vec!["yt:l3J6cYVBleM", "yt:bbbbbbbbbbb"]);
        assert_eq!((t[0].artist.as_str(), t[0].duration, t[0].source.as_str()), ("Some Channel", 125, "youtube"));
        assert_eq!(t[0].url, "https://www.youtube.com/watch?v=l3J6cYVBleM");
    }

    #[test]
    fn youtube_pick_audio() {
        let p = json!({ "playabilityStatus": { "status": "OK" }, "streamingData": { "adaptiveFormats": [
            { "itag": 137, "mimeType": "video/mp4; codecs=\"avc1\"", "url": "v", "bitrate": 4000000 },
            { "itag": 251, "mimeType": "audio/webm; codecs=\"opus\"", "url": "o", "bitrate": 136000, "contentLength": "3500000" },
            { "itag": 140, "mimeType": "audio/mp4; codecs=\"mp4a.40.2\"", "url": "m", "bitrate": 130000, "contentLength": "3449447" },
            { "itag": 139, "mimeType": "audio/mp4; codecs=\"mp4a.40.5\"", "signatureCipher": "s=1", "bitrate": 50000 }
        ] } });
        assert!(playable(&p).is_ok());
        let f = pick_audio(&p).unwrap();
        assert_eq!((f.itag, f.mime.as_str(), f.clen, f.url.as_str()), (140, "audio/mp4", Some(3449447), "m"));
        assert!(playable(&json!({ "playabilityStatus": { "status": "LOGIN_REQUIRED", "reason": "bot" } })).is_err());
        assert!(pick_audio(&json!({})).is_none());
    }
}
