//! YouTube Music watch-next (the song radio behind "Start mix") and release years.
//! Pure parsing + matching, unit-tested; the calls live in `youtube.rs`.
//!
//! - watch-next: `next` on music.youtube.com (WEB_REMIX) with `playlistId: RDAMVM<videoId>`
//!   returns ~50 `playlistPanelVideoRenderer` rows. The first is the seed itself. Album
//!   tracks ("ATV") carry "Artist • Album • 2007" in `longBylineText`, so one call gives
//!   both the related songs and the seed's release year.
//! - album `browse` (MPREb_…): the header subtitle is "Album • 2007".
//! - songs search rows name the album (MPREb_ browse id) in their second column.

use std::collections::HashMap;

use serde_json::{json, Value};

use super::innertube::{self, collect, parse_duration, text_of, valid_id, ytm_art};
use crate::soundcloud::Track;

/// One watch-next row: a mapped Track plus what YouTube Music knows about its release.
/// (`album` / `kind` are kept for callers that want them; the mixes use `year`.)
#[allow(dead_code)]
#[derive(Clone, Debug)]
pub struct Row {
    pub track: Track,
    /// Album / single release year (album tracks only).
    pub year: Option<u16>,
    /// Album browse id (MPREb_…).
    pub album: Option<String>,
    /// "ATV" (album track), "OMV" (official video), "UGC" (upload)…
    pub kind: String,
}

pub fn watch_body(video_id: &str, visitor: &str) -> Value {
    json!({
        "context": innertube::ytm_context(visitor),
        "videoId": video_id,
        "playlistId": format!("RDAMVM{video_id}"),
        "isAudioOnly": true,
    })
}

/// "2007" -> 2007 (exactly four digits, 1900..=2100).
pub fn year_text(s: &str) -> Option<u16> {
    let s = s.trim();
    if s.len() != 4 || !s.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let y: u16 = s.parse().ok()?;
    (1900..=2100).contains(&y).then_some(y)
}

fn is_album_id(id: &str) -> bool {
    id.starts_with("MPREb")
}

/// Rows of a watch-next response, in radio order, deduped by video id.
pub fn parse_watch(v: &Value) -> Vec<Row> {
    let mut found = Vec::new();
    collect(v, "playlistPanelVideoRenderer", &mut found);
    let mut out: Vec<Row> = Vec::new();
    for r in found {
        let Some(id) = r["videoId"].as_str().or_else(|| r["navigationEndpoint"]["watchEndpoint"]["videoId"].as_str()) else { continue };
        if !valid_id(id) || out.iter().any(|o| o.track.id[3..] == *id) {
            continue;
        }
        let duration = parse_duration(&text_of(&r["lengthText"]));
        if duration < 30 {
            continue; // live streams, clips
        }
        // "Artist[, Artist] • Album • 2007" (ATV) or "Channel • 34M views • 388K likes" (videos)
        let runs = r["longBylineText"]["runs"].as_array().cloned().unwrap_or_default();
        let mut segs: Vec<String> = vec![String::new()];
        let mut channel = String::new();
        let mut album = None;
        for run in &runs {
            let t = run["text"].as_str().unwrap_or("");
            if t == " • " {
                segs.push(String::new());
                continue;
            }
            segs.last_mut().unwrap().push_str(t);
            if let Some(b) = run["navigationEndpoint"]["browseEndpoint"]["browseId"].as_str() {
                if segs.len() == 1 && channel.is_empty() && b.starts_with("UC") {
                    channel = b.to_string();
                } else if album.is_none() && is_album_id(b) {
                    album = Some(b.to_string());
                }
            }
        }
        let kind = r["navigationEndpoint"]["watchEndpoint"]["watchEndpointMusicSupportedConfigs"]["watchEndpointMusicConfig"]["musicVideoType"]
            .as_str()
            .unwrap_or("")
            .trim_start_matches("MUSIC_VIDEO_TYPE_")
            .to_string();
        let year = if album.is_some() || kind == "ATV" { segs.iter().skip(1).rev().find_map(|s| year_text(s)) } else { None };
        let mut artist = innertube::clean_artist(&segs[0]);
        if artist.is_empty() {
            artist = innertube::clean_artist(&text_of(&r["shortBylineText"]));
        }
        let art = ytm_art(r["thumbnail"]["thumbnails"].as_array().and_then(|t| t.last()).and_then(|t| t["url"].as_str()).unwrap_or(""), id);
        let channel_url = if channel.is_empty() { String::new() } else { format!("https://music.youtube.com/channel/{channel}") };
        let track = innertube::track(id, text_of(&r["title"]).trim().to_string(), artist, duration, art, format!("https://music.youtube.com/watch?v={id}"), &channel, channel_url);
        out.push(Row { track, year, album, kind });
    }
    out
}

/// Release year in an album page header ("Album • 2007", "Single • 2005").
pub fn parse_album_year(v: &Value) -> Option<u16> {
    for key in ["musicResponsiveHeaderRenderer", "musicDetailHeaderRenderer", "musicImmersiveHeaderRenderer"] {
        let mut found = Vec::new();
        collect(v, key, &mut found);
        for h in found {
            if let Some(runs) = h["subtitle"]["runs"].as_array() {
                if let Some(y) = runs.iter().filter_map(|r| r["text"].as_str()).find_map(year_text) {
                    return Some(y);
                }
            }
        }
    }
    None
}

/// videoId -> album browse id, from a YouTube Music songs search.
pub fn song_albums(v: &Value) -> HashMap<String, String> {
    let mut found = Vec::new();
    collect(v, "musicResponsiveListItemRenderer", &mut found);
    let mut out = HashMap::new();
    for r in found {
        let cols = r["flexColumns"].as_array().cloned().unwrap_or_default();
        let col = |i: usize| cols.get(i).and_then(|c| c["musicResponsiveListItemFlexColumnRenderer"]["text"]["runs"].as_array().cloned()).unwrap_or_default();
        let id = r["playlistItemData"]["videoId"]
            .as_str()
            .or_else(|| r["overlay"]["musicItemThumbnailOverlayRenderer"]["content"]["musicPlayButtonRenderer"]["playNavigationEndpoint"]["watchEndpoint"]["videoId"].as_str())
            .map(String::from)
            .or_else(|| col(0).first().and_then(|x| x["navigationEndpoint"]["watchEndpoint"]["videoId"].as_str()).map(String::from));
        let Some(id) = id.filter(|i| valid_id(i)) else { continue };
        if let Some(a) = col(1).iter().filter_map(|x| x["navigationEndpoint"]["browseEndpoint"]["browseId"].as_str()).find(|b| is_album_id(b)) {
            out.entry(id).or_insert_with(|| a.to_string());
        }
    }
    out
}

// ---------------------------------------------------------------- matching a song by title / artist / length

/// Lowercase words without bracketed parts, "feat." credits and punctuation.
pub fn norm(s: &str) -> String {
    let mut t = String::new();
    let mut depth = 0i32;
    for ch in s.to_lowercase().chars() {
        match ch {
            '(' | '[' | '{' => depth += 1,
            ')' | ']' | '}' => depth = (depth - 1).max(0),
            c if depth == 0 => t.push(if c.is_alphanumeric() { c } else { ' ' }),
            _ => {}
        }
    }
    let words: Vec<&str> = t.split_whitespace().collect();
    let cut = words.iter().position(|w| matches!(*w, "feat" | "ft" | "featuring" | "prod")).unwrap_or(words.len());
    words[..cut].join(" ")
}

fn has_words(hay: &str, needle: &str) -> bool {
    !needle.is_empty() && format!(" {hay} ").contains(&format!(" {needle} "))
}

/// Search text for a song: SoundCloud "Artist - Title" uploads already name the artist.
pub fn song_query(title: &str, artist: &str) -> String {
    let t = norm(title);
    let a = norm(artist);
    if title.contains(" - ") || a.is_empty() || has_words(&t, &a) {
        t
    } else {
        format!("{a} {t}")
    }
}

/// Is `cand` (a YouTube Music song) the same recording as title / artist / duration?
/// Needs the length within 3 s, the title inside the other title, and the artist named.
pub fn same_song(title: &str, artist: &str, duration: u64, cand: &Track) -> bool {
    if duration == 0 || cand.duration == 0 || duration.abs_diff(cand.duration) > 3 {
        return false;
    }
    let want = norm(title);
    let got = norm(&cand.title);
    if got.is_empty() || want.is_empty() || !(has_words(&want, &got) || has_words(&got, &want)) {
        return false;
    }
    let hay = norm(&format!("{artist} {title}"));
    let first = cand.artist.split([',', '&']).next().unwrap_or("");
    let ca = norm(first);
    let wa = norm(artist);
    has_words(&hay, &ca) || has_words(&norm(&cand.artist), &wa)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(id: &str, title: &str, byline: Value, len: &str, kind: &str) -> Value {
        json!({ "playlistPanelVideoRenderer": {
            "videoId": id,
            "title": { "runs": [{ "text": title }] },
            "longBylineText": { "runs": byline },
            "lengthText": { "runs": [{ "text": len }] },
            "thumbnail": { "thumbnails": [{ "url": "https://lh3.googleusercontent.com/x=w60-h60-l90-rj" }, { "url": "https://lh3.googleusercontent.com/x=w120-h120-l90-rj" }] },
            "navigationEndpoint": { "watchEndpoint": { "videoId": id, "watchEndpointMusicSupportedConfigs": { "watchEndpointMusicConfig": { "musicVideoType": kind } } } }
        } })
    }

    fn sample_watch() -> Value {
        let atv = |artist: &str, ch: &str, album: &str, alb: &str, year: &str| {
            json!([
                { "text": artist, "navigationEndpoint": { "browseEndpoint": { "browseId": ch } } },
                { "text": " • " },
                { "text": album, "navigationEndpoint": { "browseEndpoint": { "browseId": alb } } },
                { "text": " • " },
                { "text": year }
            ])
        };
        json!({ "contents": { "singleColumnMusicWatchNextResultsRenderer": { "tabbedRenderer": { "watchNextTabbedResultsRenderer": { "tabs": [
            { "tabRenderer": { "content": { "musicQueueRenderer": { "content": { "playlistPanelRenderer": { "contents": [
                row("hqvcww4ydh8", "Can't Tell Me Nothing", atv("Kanye West", "UCRY5dYsbIN5TylSbd7gVnZg", "Graduation", "MPREb_KCNeTnK02S7", "2007"), "4:32", "MUSIC_VIDEO_TYPE_ATV"),
                row("K_8yRH2KPVo", "Superman (feat. Dina Rae)", atv("Eminem", "UCedvOgsKFzcK3hA5taf3KoQ", "The Eminem Show", "MPREb_6hyn9PhqicQ", "2002"), "5:51", "MUSIC_VIDEO_TYPE_ATV"),
                row("xMfIAFJpRYc", "I know what you want (Remix)", json!([{ "text": "DoctorWoofle" }, { "text": " • " }, { "text": "34M views" }, { "text": " • " }, { "text": "388K likes" }]), "4:02", "MUSIC_VIDEO_TYPE_UGC"),
                row("K_8yRH2KPVo", "dupe", json!([]), "5:51", "MUSIC_VIDEO_TYPE_ATV"),
                row("shortclip00", "Intro", json!([{ "text": "X" }]), "0:12", "MUSIC_VIDEO_TYPE_ATV"),
                { "playlistPanelVideoWrapperRenderer": { "primaryRenderer":
                    row("CSD2J8yaMmM", "Ms. Jackson", atv("Outkast", "UCx", "Stankonia", "MPREb_x", "2000"), "4:31", "MUSIC_VIDEO_TYPE_ATV") } }
            ] } } } } } }
        ] } } } } })
    }

    #[test]
    fn youtube_parse_watch_next() {
        let rows = parse_watch(&sample_watch());
        let ids: Vec<&str> = rows.iter().map(|r| r.track.id.as_str()).collect();
        assert_eq!(ids, vec!["yt:hqvcww4ydh8", "yt:K_8yRH2KPVo", "yt:xMfIAFJpRYc", "yt:CSD2J8yaMmM"]);
        let a = &rows[0];
        assert_eq!((a.track.title.as_str(), a.track.artist.as_str(), a.track.duration), ("Can't Tell Me Nothing", "Kanye West", 272));
        assert_eq!(a.track.source, "youtube");
        assert_eq!(a.track.url, "https://music.youtube.com/watch?v=hqvcww4ydh8");
        assert_eq!(a.track.artwork, "https://lh3.googleusercontent.com/x=w544-h544-l90-rj");
        assert_eq!(a.track.artist_id, "UCRY5dYsbIN5TylSbd7gVnZg");
        assert_eq!(a.track.artist_url, "https://music.youtube.com/channel/UCRY5dYsbIN5TylSbd7gVnZg");
        assert_eq!((a.year, a.album.as_deref(), a.kind.as_str()), (Some(2007), Some("MPREb_KCNeTnK02S7"), "ATV"));
        assert_eq!(rows[1].year, Some(2002));
        // uploads have view counts, not years
        assert_eq!((rows[2].year, rows[2].kind.as_str(), rows[2].track.artist.as_str()), (None, "UGC", "DoctorWoofle"));
        assert_eq!(rows[3].year, Some(2000));
        let b = watch_body("hqvcww4ydh8", "");
        assert_eq!(b["playlistId"], "RDAMVMhqvcww4ydh8");
        assert_eq!(b["context"]["client"]["clientName"], "WEB_REMIX");
    }

    #[test]
    fn youtube_album_year_and_song_albums() {
        let album = json!({ "contents": { "twoColumnBrowseResultsRenderer": { "tabs": [{ "tabRenderer": { "content": { "sectionListRenderer": { "contents": [
            { "musicResponsiveHeaderRenderer": { "title": { "runs": [{ "text": "Graduation" }] }, "subtitle": { "runs": [{ "text": "Album" }, { "text": " • " }, { "text": "2007" }] } } }
        ] } } } }] } } });
        assert_eq!(parse_album_year(&album), Some(2007));
        assert_eq!(parse_album_year(&json!({})), None);
        let search = json!({ "contents": [{ "musicResponsiveListItemRenderer": {
            "playlistItemData": { "videoId": "PsO6ZnUZI0g" },
            "flexColumns": [
                { "musicResponsiveListItemFlexColumnRenderer": { "text": { "runs": [{ "text": "Stronger" }] } } },
                { "musicResponsiveListItemFlexColumnRenderer": { "text": { "runs": [
                    { "text": "Kanye West", "navigationEndpoint": { "browseEndpoint": { "browseId": "UCRY5dYsbIN5TylSbd7gVnZg" } } },
                    { "text": " • " }, { "text": "Graduation", "navigationEndpoint": { "browseEndpoint": { "browseId": "MPREb_KCNeTnK02S7" } } },
                    { "text": " • " }, { "text": "5:12" } ] } } }
            ] } }] });
        assert_eq!(song_albums(&search).get("PsO6ZnUZI0g").map(String::as_str), Some("MPREb_KCNeTnK02S7"));
        assert_eq!(year_text("2007"), Some(2007));
        assert_eq!(year_text("34M views"), None);
        assert_eq!(year_text("1850"), None);
    }

    #[test]
    fn youtube_song_matching() {
        let cand = |title: &str, artist: &str, d: u64| {
            let mut t = innertube::track("PsO6ZnUZI0g", title.into(), artist.into(), d, String::new(), String::new(), "", String::new());
            t.duration = d;
            t
        };
        assert_eq!(norm("Stronger (Official Video) [HQ] feat. Daft Punk"), "stronger");
        assert_eq!(song_query("Kanye West - Stronger (Official Video)", "someuploader"), "kanye west stronger");
        assert_eq!(song_query("Stronger", "Kanye West"), "kanye west stronger");
        let c = cand("Stronger", "Kanye West", 312);
        assert!(same_song("Kanye West - Stronger", "someuploader", 314, &c));
        assert!(same_song("Stronger", "Kanye West", 310, &c));
        assert!(!same_song("Stronger", "Kanye West", 330, &c), "length differs");
        assert!(!same_song("Stronger", "Kelly Clarkson", 312, &c), "other artist");
        assert!(!same_song("Heartless", "Kanye West", 312, &c), "other song");
        assert!(same_song("Dilemma", "Nelly", 289, &cand("Dilemma (feat. Kelly Rowland)", "Nelly & Kelly Rowland", 290)));
    }
}
