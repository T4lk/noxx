//! Pure mix-building logic (no I/O, no AppHandle) so it can be unit tested.
//!
//! Flow (driven by `mixes.rs`):
//!   build_items(likes, history)      -> one Item per track the user liked or played, with play counts
//!   (caller fills families / years from discover's style logic and SoundCloud metadata)
//!   assign_families(items)           -> primary genre family + sub-genre per item
//!   plans(items, cooc)               -> what mixes to make (own tracks, seeds for related top-ups, filters)
//!   finish(plan, fresh)              -> final Mix (deduped, interleaved, covers, subtitle) or None if too small

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::soundcloud::Track;

pub const MIN_TRACKS: usize = 8;
pub const MAX_TRACKS: usize = 50;
pub const DAY_MS: u64 = 86_400_000;
pub const RECENT_MS: u64 = 30 * DAY_MS;
const MAX_DAILY: usize = 6;
const MAX_GENRE: usize = 8;
const MAX_ARTIST: usize = 6;
/// New songs per artist in one mix (an artist mix's own artist is not capped).
pub const NEW_PER_ARTIST: usize = 3;

/// discover.rs genre family keys (same order: most specific first) with display names.
pub const FAMILY_NAMES: &[(&str, &str)] = &[
    ("harddance", "Hard Dance"),
    ("techno", "Techno"),
    ("house", "House"),
    ("trance", "Trance"),
    ("dnb", "Drum & Bass"),
    ("bass", "Bass"),
    ("phonk", "Phonk"),
    ("rap", "Hip Hop"),
    ("hyperpop", "Hyperpop"),
    ("pop", "Pop"),
    ("rnb", "R&B"),
    ("rock", "Rock"),
    ("metal", "Metal"),
    ("ambient", "Chill"),
    ("latin", "Latin"),
    ("jazz", "Jazz"),
    ("folk", "Folk"),
];

/// Genre field values too broad to name a mix after.
const GENERIC: &[&str] = &[
    "electronic", "electronica", "edm", "dance", "other", "music", "remix", "remixes", "none", "beats", "instrumental", "soundcloud",
    "mix", "dj", "bootleg", "edit", "sped up", "slowed", "unknown", "genre", "free", "free download", "original",
];

pub fn family_label(f: &str) -> String {
    FAMILY_NAMES.iter().find(|(k, _)| *k == f).map(|(_, n)| n.to_string()).unwrap_or_else(|| title_case(f))
}

pub fn family_rank(f: &str) -> usize {
    FAMILY_NAMES.iter().position(|(k, _)| *k == f).unwrap_or(99)
}

pub fn title_case(s: &str) -> String {
    s.split_whitespace()
        .map(|w| {
            let mut c = w.chars();
            match c.next() {
                Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn slug(s: &str) -> String {
    let mut out = String::new();
    for ch in s.to_lowercase().chars() {
        if ch.is_alphanumeric() {
            out.push(ch);
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
    }
    out.trim_end_matches('-').to_string()
}

/// A normalised sub-genre from a SoundCloud genre field ("Hardtek" -> "hardtekk"),
/// or None when the field is empty or too broad ("Dance & EDM", "Electronic").
pub fn subgenre_of(genre: &str) -> Option<String> {
    let g = genre.trim().to_lowercase();
    let g = g.trim_matches(|c: char| !c.is_alphanumeric()).replace(['_', '-'], " ");
    let g = g.split_whitespace().collect::<Vec<_>>().join(" ");
    if g.is_empty() || g.chars().count() > 24 || g.contains('&') || g.split(' ').count() > 3 || GENERIC.contains(&g.as_str()) {
        return None;
    }
    let canon = match g.as_str() {
        "hardtek" | "hard tekk" | "hard tek" | "tekk" | "tek" | "tekkno" | "hardtekkno" | "hard tekkno" => "hardtekk",
        "euphoric frenchcore" | "french core" | "frenchcore hardcore" => "frenchcore",
        "uptempo hardcore" | "up tempo" => "uptempo",
        "hardtechno" | "hard techno" => "hard techno",
        "hip hop" | "hiphop" | "hip hop rap" => "hip hop",
        "drum and bass" | "drum n bass" | "dnb" | "d b" => "drum and bass",
        "lofi" | "lo fi" | "lo fi hip hop" | "lofi hip hop" => "lofi",
        "rnb" | "r b" => "rnb",
        "house music" => "house",
        other => other,
    };
    Some(canon.to_string())
}

/// Release year from SoundCloud track JSON: release_date, then display_date, then created_at.
pub fn year_of(raw: &Value) -> Option<u16> {
    for key in ["release_date", "display_date", "created_at"] {
        if let Some(y) = raw[key].as_str().and_then(parse_year) {
            return Some(y);
        }
    }
    None
}

/// True when SoundCloud's only year is the upload date (no release_date, and
/// display_date missing or in the upload year): such songs may be much older.
pub fn upload_year_only(raw: &Value) -> bool {
    if raw["release_date"].as_str().and_then(parse_year).is_some() {
        return false;
    }
    let created = raw["created_at"].as_str().and_then(parse_year);
    match raw["display_date"].as_str().and_then(parse_year) {
        Some(d) => Some(d) == created,
        None => created.is_some(),
    }
}

pub fn parse_year(s: &str) -> Option<u16> {
    let y: u16 = s.trim().get(..4)?.parse().ok()?;
    (1900..=2100).contains(&y).then_some(y)
}

pub fn decade_of(year: u16) -> u16 {
    year / 10 * 10
}

/// "2000s", "2010s", "90s": the decade as people say (and search) it.
pub fn decade_word(decade: u16) -> String {
    if decade >= 2000 {
        format!("{decade}s")
    } else {
        format!("{:02}s", decade % 100)
    }
}

/// "2000s Mix", "2010s Mix", "90s Mix".
pub fn era_title(decade: u16) -> String {
    format!("{} Mix", decade_word(decade))
}

/// Mixes that get new songs (and fill up to `MAX_TRACKS`): all but On Repeat / Repeat Rewind.
pub fn tops_up(kind: &str) -> bool {
    !matches!(kind, "repeat" | "rewind")
}

/// Release year of an era top-up candidate: a SoundCloud release / display date is
/// trusted; an upload-date-only year gives way to an older YouTube Music year; YouTube
/// tracks have only the YouTube Music year.
pub fn candidate_year(sc_year: Option<u16>, upload_only: bool, ytm_year: Option<u16>) -> Option<u16> {
    match (sc_year, ytm_year) {
        (Some(y), _) if !upload_only => Some(y),
        (Some(y), Some(m)) => Some(y.min(m)),
        (y, m) => y.or(m),
    }
}

/// A SoundCloud upload of someone else's song ("Artist - Song" by another uploader): its
/// upload year says nothing about the song, so era top-ups need a YouTube Music year for it.
pub fn reupload(t: &Track) -> bool {
    t.title.split_once(" - ").is_some_and(|(a, _)| name_key(a) != name_key(&t.artist))
}

pub fn in_decade(year: Option<u16>, decade: u16) -> bool {
    year.is_some_and(|y| y >= 1900 && decade_of(y) == decade)
}

/// The user's top genre families inside a decade (by weight), at most `n`.
pub fn era_families(items: &[Item], decade: u16, n: usize) -> Vec<String> {
    let mut w: HashMap<&str, f64> = HashMap::new();
    for it in items.iter().filter(|it| in_decade(it.year, decade)) {
        if let Some(f) = &it.family {
            *w.entry(f.as_str()).or_insert(0.0) += it.weight.max(0.5);
        }
    }
    let mut v: Vec<(&str, f64)> = w.into_iter().collect();
    v.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal).then(family_rank(a.0).cmp(&family_rank(b.0))));
    v.into_iter().take(n).map(|(f, _)| f.to_string()).collect()
}

/// Searches for a decade's songs in the user's genres: "90s hip hop", "2000s pop".
pub fn era_queries(decade: u16, families: &[String]) -> Vec<String> {
    families.iter().map(|f| format!("{} {}", decade_word(decade), family_label(f).to_lowercase())).collect()
}

/// Artist name for per-artist caps across platforms ("Nas - Topic" == "nas").
pub fn name_key(name: &str) -> String {
    let n = name.trim().to_lowercase();
    n.strip_suffix(" - topic").unwrap_or(&n).trim().to_string()
}

/// "a", "a and b", "a, b and c", "a, b, c and more".
pub fn credits(names: &[String]) -> String {
    match names.len() {
        0 => String::new(),
        1 => names[0].clone(),
        2 => format!("{} and {}", names[0], names[1]),
        3 => format!("{}, {} and {}", names[0], names[1], names[2]),
        _ => format!("{}, {}, {} and more", names[0], names[1], names[2]),
    }
}

pub fn artist_key(t: &Track) -> String {
    if !t.artist_id.is_empty() {
        t.artist_id.clone()
    } else {
        t.artist.trim().to_lowercase()
    }
}

/// Matching key for one song uploaded twice ("Song (Official Video)" == "Song").
pub fn song_key(t: &Track) -> String {
    let mut title = String::new();
    let mut depth = 0i32;
    for ch in t.title.to_lowercase().chars() {
        match ch {
            '(' | '[' => depth += 1,
            ')' | ']' => depth = (depth - 1).max(0),
            c if depth == 0 => title.push(if c.is_alphanumeric() { c } else { ' ' }),
            _ => {}
        }
    }
    let title = title.split(" feat ").next().unwrap_or("").split(" ft ").next().unwrap_or("").to_string();
    let artist = t.artist.to_lowercase();
    let squash = |s: &str| s.split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()).collect::<Vec<_>>().join(" ");
    format!("{}::{}", squash(&artist), squash(&title))
}

pub fn is_sc(t: &Track) -> bool {
    t.source.is_empty() && !t.id.is_empty() && t.id.bytes().all(|b| b.is_ascii_digit())
}

/// A YouTube / YouTube Music track (id `yt:<videoId>`).
pub fn is_yt(t: &Track) -> bool {
    t.id.starts_with("yt:") && t.id.len() == 14 && source_of(t) == "youtube"
}

/// "sc" | "youtube" | "local" (anything else counts as its own source name).
pub fn source_of(t: &Track) -> String {
    if t.source.is_empty() {
        "sc".into()
    } else if t.source.contains("youtube") || t.source == "ytm" || t.id.starts_with("yt:") {
        "youtube".into()
    } else if t.source == "local" || t.source == "download" || t.source == "file" {
        "local".into()
    } else {
        t.source.clone()
    }
}

// ------------------------------------------------------------------
// items
// ------------------------------------------------------------------

#[derive(Clone, Debug)]
pub struct Item {
    pub track: Track,
    /// Families detected in the whole style text (title + genre + tags), rank order.
    pub families: Vec<String>,
    /// Families detected in the genre field alone (a stronger signal).
    pub genre_families: Vec<String>,
    /// Primary family / sub-genre (set by `assign_families`).
    pub family: Option<String>,
    pub sub: Option<String>,
    pub year: Option<u16>,
    /// Position in likes (0 = newest like).
    pub liked: Option<usize>,
    pub plays: u32,
    pub recent_plays: u32,
    pub last_played: u64,
    pub weight: f64,
}

/// One Item per liked or played track. `history` is newest first: (track, played_at ms).
/// Very short clips (< 30 s, e.g. test tones) are skipped.
pub fn build_items(likes: &[Track], history: &[(Track, u64)], now: u64) -> Vec<Item> {
    let mut out: Vec<Item> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();
    let short = |t: &Track| t.duration > 0 && t.duration < 30;
    let mut push = |out: &mut Vec<Item>, t: &Track| -> usize {
        if let Some(&i) = index.get(&t.id) {
            return i;
        }
        index.insert(t.id.clone(), out.len());
        out.push(Item {
            track: t.clone(),
            families: Vec::new(),
            genre_families: Vec::new(),
            family: None,
            sub: None,
            year: None,
            liked: None,
            plays: 0,
            recent_plays: 0,
            last_played: 0,
            weight: 0.0,
        });
        out.len() - 1
    };
    for (i, t) in likes.iter().enumerate() {
        if t.id.is_empty() || short(t) {
            continue;
        }
        let at = push(&mut out, t);
        if out[at].liked.is_none() {
            out[at].liked = Some(i);
        }
    }
    for (t, played_at) in history {
        if t.id.is_empty() || short(t) {
            continue;
        }
        let at = push(&mut out, t);
        let it = &mut out[at];
        it.plays += 1;
        if now.saturating_sub(*played_at) <= RECENT_MS {
            it.recent_plays += 1;
        }
        it.last_played = it.last_played.max(*played_at);
    }
    let n = likes.len().max(1) as f64;
    for it in &mut out {
        let like = it.liked.map(|i| 2.0 + (1.0 - i as f64 / n)).unwrap_or(0.0);
        it.weight = like + it.plays as f64 + it.recent_plays as f64;
    }
    out
}

/// Songs saved in your own playlists (including Spotify / Apple Music imports) count as a
/// weaker taste signal than likes and plays: new ones join with weight 1, ones already
/// known get +0.5. Skips clips under 30 s and tracks without an id.
pub fn add_saved(items: &mut Vec<Item>, saved: &[Track]) {
    let mut index: HashMap<String, usize> = items.iter().enumerate().map(|(i, it)| (it.track.id.clone(), i)).collect();
    for t in saved {
        if t.id.is_empty() || (t.duration > 0 && t.duration < 30) {
            continue;
        }
        if let Some(&i) = index.get(&t.id) {
            items[i].weight += 0.5;
            continue;
        }
        index.insert(t.id.clone(), items.len());
        items.push(Item {
            track: t.clone(),
            families: Vec::new(),
            genre_families: Vec::new(),
            family: None,
            sub: None,
            year: None,
            liked: None,
            plays: 0,
            recent_plays: 0,
            last_played: 0,
            weight: 1.0,
        });
    }
}

/// Families from the names of the playlists a song is saved in (first name that has one).
pub fn hint_families(playlists: &[String], name_families: &HashMap<String, Vec<String>>) -> Vec<String> {
    playlists.iter().filter_map(|n| name_families.get(n)).find(|f| !f.is_empty()).cloned().unwrap_or_default()
}

/// The name an artist's tracks use most (ties: the shortest), so a YouTube channel's
/// mix is "Daft Punk Mix", not "Daft Punk & Julian Casablancas Mix".
fn artist_name(list: &[&Item]) -> String {
    let mut counts: Vec<(&str, usize)> = Vec::new();
    for it in list {
        let a = it.track.artist.trim();
        match counts.iter_mut().find(|(n, _)| n.eq_ignore_ascii_case(a)) {
            Some(c) => c.1 += 1,
            None => counts.push((a, 1)),
        }
    }
    counts.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.chars().count().cmp(&b.0.chars().count())));
    counts.first().map(|(n, _)| n.to_string()).unwrap_or_default()
}

/// Primary family per item: the genre field's family if it has one, else the
/// style family the artist leans to most, else the artist's dominant family.
/// Sub-genre: the genre field (normalised) when it names a known family.
pub fn assign_families(items: &mut [Item]) {
    let mut profile: HashMap<String, HashMap<String, f64>> = HashMap::new();
    for it in items.iter() {
        let p = profile.entry(artist_key(&it.track)).or_default();
        for f in it.genre_families.iter() {
            *p.entry(f.clone()).or_insert(0.0) += 2.0 * it.weight.max(1.0);
        }
        for f in it.families.iter() {
            *p.entry(f.clone()).or_insert(0.0) += it.weight.max(1.0);
        }
    }
    let best_of = |p: &HashMap<String, f64>, among: Option<&[String]>| -> Option<String> {
        let mut v: Vec<(&String, f64)> =
            p.iter().filter(|(f, _)| among.is_none_or(|a| a.contains(f))).map(|(f, w)| (f, *w)).collect();
        v.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal).then(family_rank(a.0).cmp(&family_rank(b.0))));
        v.first().map(|(f, _)| (*f).clone())
    };
    for it in items.iter_mut() {
        let p = profile.get(&artist_key(&it.track));
        it.family = if !it.genre_families.is_empty() {
            let mut g = it.genre_families.clone();
            g.sort_by_key(|f| family_rank(f));
            if g.len() > 1 { p.and_then(|p| best_of(p, Some(&g))).or_else(|| g.first().cloned()) } else { g.first().cloned() }
        } else if !it.families.is_empty() {
            p.and_then(|p| best_of(p, Some(&it.families))).or_else(|| it.families.first().cloned())
        } else {
            p.and_then(|p| best_of(p, None))
        };
        it.sub = if it.genre_families.is_empty() { None } else { subgenre_of(&it.track.genre) };
        // "Techno" in the techno family is not a sub-genre of its own.
        if let (Some(f), Some(s)) = (&it.family, &it.sub) {
            if family_label(f).eq_ignore_ascii_case(s) || f == s {
                it.sub = None;
            }
        }
    }
}

/// Artist co-occurrence from history (newest first): consecutive plays less than
/// 20 minutes apart link their two artists.
pub fn cooccurrence(history: &[(Track, u64)]) -> HashMap<String, HashMap<String, u32>> {
    let mut m: HashMap<String, HashMap<String, u32>> = HashMap::new();
    for w in history.windows(2) {
        let (a, ta) = (&w[0].0, w[0].1);
        let (b, tb) = (&w[1].0, w[1].1);
        if ta.abs_diff(tb) > 20 * 60 * 1000 {
            continue;
        }
        let (ka, kb) = (artist_key(a), artist_key(b));
        if ka == kb || ka.is_empty() || kb.is_empty() {
            continue;
        }
        *m.entry(ka.clone()).or_default().entry(kb.clone()).or_insert(0) += 1;
        *m.entry(kb).or_default().entry(ka).or_insert(0) += 1;
    }
    m
}

// ------------------------------------------------------------------
// taste groups (Daily Mixes)
// ------------------------------------------------------------------

#[derive(Clone, Debug)]
pub struct Group {
    pub key: String,
    pub family: Option<String>,
    pub sub: Option<String>,
    pub members: Vec<usize>,
    pub weight: f64,
}

impl Group {
    pub fn label(&self) -> String {
        match (&self.sub, &self.family) {
            (Some(s), _) => title_case(s),
            (None, Some(f)) => family_label(f),
            _ => String::new(),
        }
    }
}

fn taste_key(family: &Option<String>, sub: &Option<String>) -> String {
    match (family, sub) {
        (Some(f), Some(s)) => format!("{f}/{s}"),
        (Some(f), None) => f.clone(),
        _ => "other".into(),
    }
}

/// Up to six taste groups: items are grouped by (family, sub-genre); items with
/// no genre follow their artist, or the artist they are most often played next to.
/// Small groups fold into the biggest group of the same family.
pub fn taste_groups(items: &[Item], cooc: &HashMap<String, HashMap<String, u32>>) -> Vec<Group> {
    // Each artist's dominant taste (and dominant sub-genre per family).
    let mut artist_taste: HashMap<String, HashMap<String, f64>> = HashMap::new();
    let mut artist_sub: HashMap<(String, String), HashMap<String, f64>> = HashMap::new();
    for it in items {
        let Some(f) = &it.family else { continue };
        let a = artist_key(&it.track);
        *artist_taste.entry(a.clone()).or_default().entry(taste_key(&it.family, &it.sub)).or_insert(0.0) += it.weight.max(0.5);
        if let Some(s) = &it.sub {
            *artist_sub.entry((a, f.clone())).or_default().entry(s.clone()).or_insert(0.0) += it.weight.max(0.5);
        }
    }
    let argmax = |m: &HashMap<String, f64>| -> Option<String> {
        let mut v: Vec<(&String, &f64)> = m.iter().collect();
        v.sort_by(|a, b| b.1.partial_cmp(a.1).unwrap_or(std::cmp::Ordering::Equal).then(a.0.cmp(b.0)));
        v.first().map(|(k, _)| (*k).clone())
    };
    let mut artist_key_of: HashMap<String, String> = artist_taste.iter().filter_map(|(a, m)| argmax(m).map(|k| (a.clone(), k))).collect();
    // Genre-less artists borrow the taste of the artist they're played next to most.
    for _ in 0..2 {
        let mut add = Vec::new();
        for it in items {
            let a = artist_key(&it.track);
            if artist_key_of.contains_key(&a) {
                continue;
            }
            if let Some(partners) = cooc.get(&a) {
                let mut best: Option<(&String, u32)> = None;
                for (p, n) in partners {
                    if let Some(k) = artist_key_of.get(p) {
                        if best.is_none_or(|(bk, bn)| *n > bn || (*n == bn && k < bk)) {
                            best = Some((k, *n));
                        }
                    }
                }
                if let Some((k, _)) = best {
                    add.push((a, k.clone()));
                }
            }
        }
        if add.is_empty() {
            break;
        }
        artist_key_of.extend(add);
    }

    let mut groups: HashMap<String, Group> = HashMap::new();
    for (i, it) in items.iter().enumerate() {
        let a = artist_key(&it.track);
        let key = match &it.family {
            Some(f) => {
                let sub = it.sub.clone().or_else(|| artist_sub.get(&(a.clone(), f.clone())).and_then(argmax));
                taste_key(&it.family, &sub)
            }
            None => artist_key_of.get(&a).cloned().unwrap_or_else(|| "other".into()),
        };
        let g = groups.entry(key.clone()).or_insert_with(|| {
            let (family, sub) = match key.split_once('/') {
                Some((f, s)) => (Some(f.to_string()), Some(s.to_string())),
                None if key == "other" => (None, None),
                None => (Some(key.clone()), None),
            };
            Group { key: key.clone(), family, sub, members: Vec::new(), weight: 0.0 }
        });
        g.members.push(i);
        g.weight += it.weight;
    }
    let mut list: Vec<Group> = groups.into_values().collect();
    list.sort_by(|a, b| b.weight.partial_cmp(&a.weight).unwrap_or(std::cmp::Ordering::Equal).then(a.key.cmp(&b.key)));

    // Fold small groups into the biggest group of their family.
    const SMALL: usize = 6;
    let mut kept: Vec<Group> = Vec::new();
    for g in list {
        if g.members.len() >= SMALL {
            kept.push(g);
            continue;
        }
        if let Some(fam) = &g.family {
            if let Some(big) = kept.iter_mut().find(|k| k.family.as_ref() == Some(fam)) {
                big.members.extend(g.members);
                big.weight += g.weight;
                continue;
            }
        }
        kept.push(g);
    }
    // A family-level group that collected its sub-groups is still fine; drop what stays tiny.
    kept.retain(|g| g.members.len() >= SMALL || g.members.len() >= 4 && g.family.is_some());
    kept.sort_by(|a, b| b.weight.partial_cmp(&a.weight).unwrap_or(std::cmp::Ordering::Equal).then(a.key.cmp(&b.key)));
    kept.truncate(MAX_DAILY);
    kept
}

// ------------------------------------------------------------------
// plans and final mixes
// ------------------------------------------------------------------

#[derive(Clone, Debug)]
pub struct Plan {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub number: u8,
    /// small label shown on the card ("Hardtekk", "2010s")
    pub tag: String,
    /// Fixed subtitle; empty = built from the artists in the mix.
    pub subtitle: String,
    /// Own tracks, best first.
    pub own: Vec<Track>,
    /// SoundCloud seeds for related top-ups (id, weight); empty = no top-up.
    pub seeds: Vec<(String, f64)>,
    /// YouTube seeds (`yt:<videoId>`, weight) for YouTube Music radio top-ups.
    pub yt_seeds: Vec<(String, f64)>,
    /// Share of the plan's own taste (by weight) that is YouTube: how much of
    /// the new songs should come from YouTube.
    pub yt_share: f64,
    /// Fresh tracks must be in this family.
    pub family: Option<String>,
    /// Own tracks per artist (0 = no cap).
    pub own_cap: usize,
    pub max_own: usize,
    /// Pattern: how many own tracks before each run of fresh ones.
    pub own_run: usize,
    /// Pattern: how many fresh tracks after each own run (Daily Mixes lean on discovery).
    pub new_run: usize,
    /// The artist an artist mix is about (always credited first).
    pub lead: String,
    /// Era mixes: the decade (1990, 2000 ...); 0 = not an era mix.
    pub decade: u16,
}

impl Plan {
    pub fn new(id: String, kind: &str, title: String) -> Self {
        Plan {
            id,
            kind: kind.into(),
            title,
            number: 0,
            tag: String::new(),
            subtitle: String::new(),
            own: Vec::new(),
            seeds: Vec::new(),
            yt_seeds: Vec::new(),
            yt_share: 0.0,
            family: None,
            own_cap: 4,
            max_own: 30,
            own_run: 2,
            new_run: 1,
            lead: String::new(),
            decade: 0,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Mix {
    pub id: String,
    /// daily | genre | era | artist | repeat | rewind
    pub kind: String,
    pub title: String,
    pub subtitle: String,
    /// 4 covers for a 2x2 collage, or empty (then `cover` alone).
    pub covers: Vec<String>,
    pub cover: String,
    #[serde(default)]
    pub number: u8,
    #[serde(default)]
    pub tag: String,
    /// Sources present: "sc", "youtube", "local".
    #[serde(default)]
    pub sources: Vec<String>,
    pub tracks: Vec<Track>,
    pub updated_at: u64,
}

fn sorted_by_weight<'a>(items: &'a [Item], members: impl Iterator<Item = usize>) -> Vec<&'a Item> {
    let mut v: Vec<&Item> = members.map(|i| &items[i]).collect();
    v.sort_by(|a, b| b.weight.partial_cmp(&a.weight).unwrap_or(std::cmp::Ordering::Equal).then(b.last_played.cmp(&a.last_played)));
    v
}

fn seeds_of(list: &[&Item], n: usize) -> Vec<(String, f64)> {
    list.iter().filter(|it| is_sc(&it.track)).take(n).map(|it| (it.track.id.clone(), it.weight.max(0.5))).collect()
}

/// SoundCloud + YouTube seeds (best first) and the YouTube share of the list's weight.
fn set_seeds(p: &mut Plan, list: &[&Item], n: usize) {
    p.seeds = seeds_of(list, n);
    p.yt_seeds = list.iter().filter(|it| is_yt(&it.track)).take(n).map(|it| (it.track.id.clone(), it.weight.max(0.5))).collect();
    let w = |f: fn(&Track) -> bool| list.iter().filter(|it| f(&it.track)).map(|it| it.weight.max(0.5)).sum::<f64>();
    let (sc, yt) = (w(is_sc), w(is_yt));
    p.yt_share = if sc + yt > 0.0 { yt / (sc + yt) } else { 0.0 };
}

/// About half new songs: one own track, one new one, own tracks up to half the mix
/// (more own tracks fill in when there aren't enough new songs, see `finish`).
fn half_new(p: &mut Plan) {
    p.max_own = MAX_TRACKS / 2;
    p.own_run = 1;
    p.new_run = 1;
}

pub fn plans(items: &[Item], cooc: &HashMap<String, HashMap<String, u32>>, now: u64) -> Vec<Plan> {
    let mut out = Vec::new();

    // Daily Mix 1-6
    for (n, g) in taste_groups(items, cooc).iter().enumerate() {
        let list = sorted_by_weight(items, g.members.iter().copied());
        let mut p = Plan::new(format!("daily-{}", n + 1), "daily", format!("Daily Mix {}", n + 1));
        p.number = (n + 1) as u8;
        p.tag = g.label();
        set_seeds(&mut p, &list, 10);
        p.own = list.iter().map(|it| it.track.clone()).collect();
        p.family = g.family.clone();
        // Mostly discovery, like Spotify's: one of your songs, then two new ones.
        p.max_own = 17;
        p.own_run = 1;
        p.new_run = 2;
        out.push(p);
    }

    // Genre mixes: families, plus sub-genres that stand on their own.
    let mut fam_members: HashMap<String, Vec<usize>> = HashMap::new();
    let mut sub_members: HashMap<(String, String), Vec<usize>> = HashMap::new();
    for (i, it) in items.iter().enumerate() {
        if let Some(f) = &it.family {
            fam_members.entry(f.clone()).or_default().push(i);
            if let Some(s) = &it.sub {
                sub_members.entry((f.clone(), s.clone())).or_default().push(i);
            }
        }
    }
    let mut genre: Vec<(f64, Plan)> = Vec::new();
    let mut titles: HashSet<String> = HashSet::new();
    let mut fam_list: Vec<(&String, &Vec<usize>)> = fam_members.iter().collect();
    fam_list.sort_by_key(|(f, _)| family_rank(f));
    for (f, members) in fam_list {
        let subs: Vec<(&String, &Vec<usize>)> =
            sub_members.iter().filter(|((sf, _), m)| sf == f && m.len() >= MIN_TRACKS).map(|((_, s), m)| (s, m)).collect();
        // One sub-genre is nearly the whole family: name the mix after it instead.
        let dominant = subs.iter().any(|(_, m)| m.len() * 100 >= members.len() * 85);
        if members.len() >= 5 && !dominant {
            let list = sorted_by_weight(items, members.iter().copied());
            let title = format!("{} Mix", family_label(f));
            if titles.insert(title.to_lowercase()) {
                let mut p = Plan::new(format!("genre-{f}"), "genre", title);
                p.tag = family_label(f);
                set_seeds(&mut p, &list, 10);
                p.own = list.iter().map(|it| it.track.clone()).collect();
                p.family = Some(f.clone());
                half_new(&mut p);
                genre.push((list.iter().map(|it| it.weight).sum(), p));
            }
        }
        for (s, m) in subs {
            let list = sorted_by_weight(items, m.iter().copied());
            let title = format!("{} Mix", title_case(s));
            if !titles.insert(title.to_lowercase()) {
                continue;
            }
            let mut p = Plan::new(format!("genre-{f}-{}", slug(s)), "genre", title);
            p.tag = title_case(s);
            set_seeds(&mut p, &list, 10);
            p.own = list.iter().map(|it| it.track.clone()).collect();
            p.family = Some(f.clone());
            half_new(&mut p);
            genre.push((list.iter().map(|it| it.weight).sum(), p));
        }
    }
    genre.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal).then(a.1.id.cmp(&b.1.id)));
    out.extend(genre.into_iter().take(MAX_GENRE).map(|(_, p)| p));

    // Era mixes: own tracks of the decade, topped up with new songs of the same decade
    // (mixes.rs checks each new song's year).
    let mut decades: HashMap<u16, Vec<usize>> = HashMap::new();
    for (i, it) in items.iter().enumerate() {
        if let Some(y) = it.year {
            decades.entry(decade_of(y)).or_default().push(i);
        }
    }
    let mut dl: Vec<(u16, Vec<usize>)> = decades.into_iter().filter(|(_, m)| m.len() >= MIN_TRACKS).collect();
    dl.sort_by_key(|(d, _)| std::cmp::Reverse(*d));
    for (d, m) in dl {
        let list = sorted_by_weight(items, m.into_iter());
        let mut p = Plan::new(format!("era-{d}s"), "era", era_title(d));
        p.tag = format!("{d}s");
        set_seeds(&mut p, &list, 10);
        p.own = list.iter().map(|it| it.track.clone()).collect();
        p.own_cap = 5;
        p.decade = d;
        half_new(&mut p);
        out.push(p);
    }

    // Artist mixes for the top artists.
    let mut by_artist: HashMap<String, Vec<usize>> = HashMap::new();
    for (i, it) in items.iter().enumerate() {
        if !it.track.artist.is_empty() && !it.track.artist.eq_ignore_ascii_case("unknown artist") {
            by_artist.entry(artist_key(&it.track)).or_default().push(i);
        }
    }
    let mut al: Vec<(f64, String, Vec<usize>)> =
        by_artist.into_iter().map(|(a, m)| (m.iter().map(|&i| items[i].weight).sum::<f64>(), a, m)).collect();
    al.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal).then(a.1.cmp(&b.1)));
    for (_, a, m) in al.into_iter() {
        if out.iter().filter(|p| p.kind == "artist").count() >= MAX_ARTIST {
            break;
        }
        let list = sorted_by_weight(items, m.into_iter());
        let has_seed = list.iter().any(|it| is_sc(&it.track) || is_yt(&it.track));
        if list.len() < 3 || (!has_seed && list.len() < MIN_TRACKS) {
            continue;
        }
        let name = artist_name(&list);
        let mut p = Plan::new(format!("artist-{}", slug(&a)), "artist", format!("{name} Mix"));
        p.tag = name.clone();
        set_seeds(&mut p, &list, 8);
        p.own = list.iter().map(|it| it.track.clone()).collect();
        // Fresh tracks must fit the artist's own family (if they have one).
        let mut fams: HashMap<&str, f64> = HashMap::new();
        for it in &list {
            if let Some(f) = &it.family {
                *fams.entry(f.as_str()).or_insert(0.0) += it.weight;
            }
        }
        p.family = fams.into_iter().max_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal)).map(|(f, _)| f.to_string());
        p.own_cap = 0;
        half_new(&mut p);
        p.lead = name;
        out.push(p);
    }

    // On Repeat: most played in the last 30 days.
    let mut rep: Vec<&Item> = items.iter().filter(|it| it.recent_plays >= 2).collect();
    rep.sort_by(|a, b| b.recent_plays.cmp(&a.recent_plays).then(b.last_played.cmp(&a.last_played)));
    if rep.len() >= MIN_TRACKS {
        let mut p = Plan::new("on-repeat".into(), "repeat", "On Repeat".into());
        p.subtitle = "Songs you can't stop playing".into();
        p.own = rep.iter().map(|it| it.track.clone()).collect();
        p.max_own = 30;
        p.own_cap = 0;
        out.push(p);
    }

    // Repeat Rewind: played a lot before, not in the last 30 days.
    let mut rew: Vec<&Item> =
        items.iter().filter(|it| it.plays >= 3 && it.recent_plays == 0 && now.saturating_sub(it.last_played) > RECENT_MS).collect();
    rew.sort_by(|a, b| b.plays.cmp(&a.plays).then(b.last_played.cmp(&a.last_played)));
    if rew.len() >= MIN_TRACKS {
        let mut p = Plan::new("repeat-rewind".into(), "rewind", "Repeat Rewind".into());
        p.subtitle = "Past favourites you haven't played lately".into();
        p.own = rew.iter().map(|it| it.track.clone()).collect();
        p.max_own = 30;
        p.own_cap = 0;
        out.push(p);
    }
    out
}

/// Distinct-artist covers for a 2x2 collage (4), or none when there aren't four.
pub fn collage(tracks: &[Track]) -> (Vec<String>, String) {
    let mut seen_art = HashSet::new();
    let mut seen_artist = HashSet::new();
    let mut covers = Vec::new();
    for t in tracks {
        if t.artwork.is_empty() || !seen_art.insert(t.artwork.clone()) || !seen_artist.insert(artist_key(t)) {
            continue;
        }
        covers.push(t.artwork.clone());
        if covers.len() == 4 {
            break;
        }
    }
    let cover = covers.first().cloned().or_else(|| tracks.iter().find(|t| !t.artwork.is_empty()).map(|t| t.artwork.clone())).unwrap_or_default();
    if covers.len() < 4 {
        covers.clear();
    }
    (covers, cover)
}

/// Artist names by how much they appear, most first (the lead first if given).
fn credit_names(tracks: &[Track], lead: &str) -> Vec<String> {
    let mut counts: Vec<(String, usize, usize)> = Vec::new();
    for (i, t) in tracks.iter().enumerate() {
        let name = t.artist.trim();
        if name.is_empty() || name.eq_ignore_ascii_case("unknown artist") {
            continue;
        }
        match counts.iter_mut().find(|(n, _, _)| n.eq_ignore_ascii_case(name)) {
            Some(c) => c.1 += 1,
            None => counts.push((name.to_string(), 1, i)),
        }
    }
    counts.sort_by(|a, b| b.1.cmp(&a.1).then(a.2.cmp(&b.2)));
    let mut names: Vec<String> = counts.into_iter().map(|(n, _, _)| n).collect();
    if !lead.is_empty() {
        names.retain(|n| !n.eq_ignore_ascii_case(lead));
        names.insert(0, lead.to_string());
    }
    names
}

/// Builds the final mix from a plan and the related tracks fetched for it
/// (`fresh` = (track, families)). None when it would have fewer than 8 tracks.
pub fn finish(plan: &Plan, fresh: &[(Track, Vec<String>)], now: u64) -> Option<Mix> {
    let mut seen_id = HashSet::new();
    let mut seen_key = HashSet::new();
    let mut per_artist: HashMap<String, usize> = HashMap::new();
    let mut own = Vec::new();
    // Own tracks past `max_own` fill in when there aren't enough new songs
    // (On Repeat / Repeat Rewind stop at `max_own`).
    let mut spare = Vec::new();
    for t in &plan.own {
        if own.len() >= plan.max_own && (!tops_up(&plan.kind) || own.len() + spare.len() >= MAX_TRACKS) {
            break;
        }
        if !seen_id.insert(t.id.clone()) || !seen_key.insert(song_key(t)) {
            continue;
        }
        let n = per_artist.entry(artist_key(t)).or_insert(0);
        if plan.own_cap > 0 && *n >= plan.own_cap {
            continue;
        }
        *n += 1;
        seen_key.extend(song_keys(t));
        if own.len() < plan.max_own {
            own.push(t.clone());
        } else {
            spare.push(t.clone());
        }
    }
    let mut new = Vec::new();
    let mut per_new: HashMap<String, usize> = HashMap::new();
    let lead = name_key(&plan.lead);
    for (t, fams) in fresh {
        if let Some(f) = &plan.family {
            if !fams.contains(f) {
                continue;
            }
        }
        let keys = song_keys(t);
        if keys.iter().any(|k| seen_key.contains(k)) || seen_id.contains(&t.id) {
            continue;
        }
        // No artist fills a mix (an artist mix's own artist excepted).
        let a = name_key(&t.artist);
        let n = per_new.entry(a.clone()).or_insert(0);
        if *n >= NEW_PER_ARTIST && (lead.is_empty() || a != lead) {
            continue;
        }
        *n += 1;
        seen_id.insert(t.id.clone());
        seen_key.extend(keys);
        new.push(t.clone());
    }
    let room = MAX_TRACKS.saturating_sub(own.len() + new.len());
    own.extend(spare.into_iter().take(room));
    // Interleave: `own_run` own tracks, then `new_run` fresh ones, until MAX_TRACKS.
    let mut tracks = Vec::new();
    let (mut oi, mut ni) = (0, 0);
    let run = plan.own_run.max(1);
    let fresh_run = plan.new_run.max(1);
    while tracks.len() < MAX_TRACKS && (oi < own.len() || ni < new.len()) {
        for _ in 0..run {
            if oi < own.len() && tracks.len() < MAX_TRACKS {
                tracks.push(own[oi].clone());
                oi += 1;
            }
        }
        for _ in 0..fresh_run {
            if ni < new.len() && tracks.len() < MAX_TRACKS {
                tracks.push(new[ni].clone());
                ni += 1;
            }
        }
    }
    if tracks.len() < MIN_TRACKS {
        return None;
    }
    let subtitle = if !plan.subtitle.is_empty() {
        plan.subtitle.clone()
    } else if !plan.lead.is_empty() {
        // "<artist>, X and Y": the lead plus the two artists that show up most besides them.
        let names = credit_names(&tracks, &plan.lead);
        match names.len() {
            0 => String::new(),
            1 => names[0].clone(),
            2 => format!("{} and {}", names[0], names[1]),
            _ => format!("{}, {} and {}", names[0], names[1], names[2]),
        }
    } else {
        credits(&credit_names(&own, ""))
    };
    // Lead / own covers first so the collage looks like the user's taste.
    let (covers, cover) = collage(&tracks);
    let mut sources: Vec<String> = Vec::new();
    for t in &tracks {
        let s = source_of(t);
        if !sources.contains(&s) {
            sources.push(s);
        }
    }
    Some(Mix {
        id: plan.id.clone(),
        kind: plan.kind.clone(),
        title: plan.title.clone(),
        subtitle,
        covers,
        cover,
        number: plan.number,
        tag: plan.tag.clone(),
        sources,
        tracks,
        updated_at: now,
    })
}

/// Merges YouTube Music radios (seed weight, rows in radio order) into one ranked list
/// of (track, how many seeds it is related to): tracks related to more seeds first,
/// then by weighted rank. Skips known ids / songs, and keeps two tracks per artist.
pub fn rank_related(lists: &[(f64, Vec<Track>)], skip: &HashSet<String>, skip_songs: &HashSet<String>, limit: usize) -> Vec<(Track, usize)> {
    let mut by_id: HashMap<String, (Track, usize, f64, usize)> = HashMap::new();
    let mut order = 0usize;
    for (w, list) in lists {
        let n = list.len().max(1) as f64;
        let mut seen_here = HashSet::new();
        for (pos, t) in list.iter().enumerate() {
            if skip.contains(&t.id) || song_keys(t).iter().any(|k| skip_songs.contains(k)) || !seen_here.insert(t.id.clone()) {
                continue;
            }
            let score = w * (1.0 - 0.5 * pos as f64 / n);
            let e = by_id.entry(t.id.clone()).or_insert_with(|| {
                order += 1;
                (t.clone(), 0, 0.0, order)
            });
            e.1 += 1;
            e.2 += score;
        }
    }
    let mut v: Vec<(Track, usize, f64, usize)> = by_id.into_values().collect();
    v.sort_by(|a, b| b.1.cmp(&a.1).then(b.2.partial_cmp(&a.2).unwrap_or(std::cmp::Ordering::Equal)).then(a.3.cmp(&b.3)));
    let mut per_artist: HashMap<String, usize> = HashMap::new();
    let mut songs = HashSet::new();
    let mut out = Vec::new();
    for (t, hits, _, _) in v {
        if out.len() >= limit {
            break;
        }
        let n = per_artist.entry(artist_key(&t)).or_insert(0);
        if *n >= 2 || !songs.insert(song_key(&t)) {
            continue;
        }
        *n += 1;
        out.push((t, hits));
    }
    out
}

/// Genre check for a YouTube related track. YouTube Music has no genres, so a track
/// whose title shows no family still fits a plan's family when it is related to two
/// or more seeds, or is by an artist already in the plan. Returns the families to
/// hand to `finish`, or None to drop the track.
pub fn admit_related(plan: &Plan, families: Vec<String>, hits: usize, artist_known: bool) -> Option<Vec<String>> {
    let Some(f) = &plan.family else { return Some(families) };
    if families.contains(f) {
        return Some(families);
    }
    if families.is_empty() && (hits >= 2 || artist_known) {
        return Some(vec![f.clone()]);
    }
    None
}

/// Where new songs in mixes come from (the user's own tracks are always kept).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum Sources {
    #[default]
    Both,
    Sc,
    Yt,
}

impl Sources {
    /// "both" | "sc" | "yt" (also "soundcloud" / "youtube"), any case.
    pub fn parse(s: &str) -> Option<Sources> {
        match s.trim().to_ascii_lowercase().as_str() {
            "both" | "all" | "mixed" => Some(Sources::Both),
            "sc" | "soundcloud" => Some(Sources::Sc),
            "yt" | "youtube" | "ytm" => Some(Sources::Yt),
            _ => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Sources::Both => "both",
            Sources::Sc => "sc",
            Sources::Yt => "yt",
        }
    }
}

/// Least share of new songs each platform gets when sources are "both".
pub const MIN_SIDE: f64 = 0.35;

/// YouTube share of a plan's new songs: about half and half ("both"), tilted towards the
/// plan's own taste but never under `MIN_SIDE` for either platform; all one platform otherwise.
pub fn new_share(sources: Sources, own_yt_share: f64) -> f64 {
    match sources {
        Sources::Sc => 0.0,
        Sources::Yt => 1.0,
        Sources::Both => (0.5 + (own_yt_share.clamp(0.0, 1.0) - 0.5) * (1.0 - 2.0 * MIN_SIDE)).clamp(MIN_SIDE, 1.0 - MIN_SIDE),
    }
}

/// Song keys of a track: `song_key`, plus "Artist - Title" read from the title
/// (SoundCloud uploads), so the same song on another platform is recognised.
pub fn song_keys(t: &Track) -> Vec<String> {
    let mut v = vec![song_key(t)];
    if let Some((a, title)) = t.title.split_once(" - ") {
        let mut alt = t.clone();
        alt.artist = a.trim().to_string();
        alt.title = title.trim().to_string();
        let k = song_key(&alt);
        if !v.contains(&k) {
            v.push(k);
        }
    }
    v
}

/// Interleaves SoundCloud and YouTube new songs so about `yt_share` of the start is YouTube;
/// whatever is left of the longer list follows.
pub fn blend<T>(sc: Vec<T>, yt: Vec<T>, yt_share: f64) -> Vec<T> {
    let share = yt_share.clamp(0.0, 1.0);
    let (mut a, mut b) = (sc.into_iter().peekable(), yt.into_iter().peekable());
    let mut out = Vec::new();
    let mut n_yt = 0usize;
    loop {
        let want_yt = (n_yt as f64) < share * (out.len() + 1) as f64;
        let pick_yt = match (a.peek().is_some(), b.peek().is_some()) {
            (false, false) => break,
            (true, false) => false,
            (false, true) => true,
            _ => want_yt,
        };
        if pick_yt {
            n_yt += 1;
            out.push(b.next().unwrap());
        } else {
            out.push(a.next().unwrap());
        }
    }
    out
}

/// Top artists for the "Your artists" row: (sample track, weight), heaviest first.
pub fn top_artists(items: &[Item], limit: usize) -> Vec<(Track, f64)> {
    let mut m: HashMap<String, (Track, f64)> = HashMap::new();
    for it in items {
        let t = &it.track;
        if t.artist.trim().is_empty() || t.artist.eq_ignore_ascii_case("unknown artist") {
            continue;
        }
        let e = m.entry(artist_key(t)).or_insert_with(|| (t.clone(), 0.0));
        e.1 += it.weight;
        if e.0.artwork.is_empty() && !t.artwork.is_empty() {
            e.0 = t.clone();
        }
    }
    let mut v: Vec<(Track, f64)> = m.into_values().filter(|(_, w)| *w >= 3.0).collect();
    v.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal).then(a.0.artist.cmp(&b.0.artist)));
    v.truncate(limit);
    v
}

// ------------------------------------------------------------------
// tests
// ------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    pub fn tr(id: &str, artist: &str, title: &str, genre: &str) -> Track {
        Track {
            id: id.into(),
            title: title.into(),
            artist: artist.into(),
            duration: 180,
            artwork: format!("https://i1.sndcdn.com/artworks-{id}-t500x500.jpg"),
            url: String::new(),
            artist_id: format!("u-{}", artist.to_lowercase()),
            artist_url: String::new(),
            genre: genre.into(),
            style: format!("{title} {genre}"),
            source: String::new(),
            path: String::new(),
        }
    }

    /// Tiny stand-in for discover's detect_families (enough for these tests).
    fn fams(text: &str) -> Vec<String> {
        let t = text.to_lowercase();
        let mut v = Vec::new();
        if ["tekk", "frenchcore", "hardstyle", "uptempo"].iter().any(|s| t.contains(s)) {
            v.push("harddance".to_string());
        }
        if t.contains("techno") {
            v.push("techno".to_string());
        }
        if t.contains("hip hop") || t.contains("rap") {
            v.push("rap".to_string());
        }
        if t.contains("house") {
            v.push("house".to_string());
        }
        v
    }

    fn items_from(likes: &[Track], hist: &[(Track, u64)], now: u64) -> Vec<Item> {
        let mut items = build_items(likes, hist, now);
        for it in &mut items {
            it.families = fams(&it.track.style);
            it.genre_families = fams(&it.track.genre);
        }
        assign_families(&mut items);
        items
    }

    #[test]
    fn subgenre_names_normalise() {
        assert_eq!(subgenre_of("Hardtek").as_deref(), Some("hardtekk"));
        assert_eq!(subgenre_of("hardtekk").as_deref(), Some("hardtekk"));
        assert_eq!(subgenre_of("Euphoric Frenchcore").as_deref(), Some("frenchcore"));
        assert_eq!(subgenre_of("Hip-Hop").as_deref(), Some("hip hop"));
        assert_eq!(subgenre_of("Dance & EDM"), None);
        assert_eq!(subgenre_of("Electronic"), None);
        assert_eq!(subgenre_of(""), None);
        assert_eq!(subgenre_of(":)?"), None);
        assert_eq!(title_case("hard techno"), "Hard Techno");
        assert_eq!(family_label("rap"), "Hip Hop");
        assert_eq!(family_label("dnb"), "Drum & Bass");
        assert_eq!(slug("DEADLIGHT / x"), "deadlight-x");
    }

    #[test]
    fn years_and_era_titles() {
        assert_eq!(year_of(&json!({ "release_date": "2004-05-01T00:00:00Z", "created_at": "2019-01-01T00:00:00Z" })), Some(2004));
        assert_eq!(year_of(&json!({ "release_date": null, "display_date": "2012-02-02T00:00:00Z", "created_at": "2019-01-01" })), Some(2012));
        assert_eq!(year_of(&json!({ "release_date": "", "created_at": "2023/05/01 12:00:00 +0000" })), Some(2023));
        assert_eq!(year_of(&json!({ "release_date": "0000-01-01" })), None);
        assert_eq!(year_of(&json!({})), None);
        assert_eq!(decade_of(2009), 2000);
        assert_eq!(decade_of(2010), 2010);
        assert_eq!(era_title(2000), "2000s Mix");
        assert_eq!(era_title(2020), "2020s Mix");
        assert_eq!(era_title(1990), "90s Mix");
    }

    #[test]
    fn credits_read_naturally() {
        let n = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(credits(&n(&[])), "");
        assert_eq!(credits(&n(&["celadon"])), "celadon");
        assert_eq!(credits(&n(&["celadon", "shk"])), "celadon and shk");
        assert_eq!(credits(&n(&["celadon", "shk", "expe"])), "celadon, shk and expe");
        assert_eq!(credits(&n(&["celadon", "shk", "expe", "x"])), "celadon, shk, expe and more");
    }

    #[test]
    fn song_keys_match_reuploads() {
        assert_eq!(song_key(&tr("1", "A", "Song (Official Video)", "")), song_key(&tr("2", "A", "Song", "")));
        assert_eq!(song_key(&tr("1", "A", "Song [HQ] feat B", "")), song_key(&tr("2", "a", "song", "")));
        assert_ne!(song_key(&tr("1", "A", "Song", "")), song_key(&tr("2", "B", "Song", "")));
    }

    #[test]
    fn items_count_plays_and_skip_clips() {
        let now = 100 * DAY_MS;
        let a = tr("1", "A", "One", "hardtekk");
        let mut clip = tr("9", "Z", "Tone", "");
        clip.duration = 3;
        let hist = vec![(a.clone(), now - 1000), (clip.clone(), now - 2000), (a.clone(), now - 40 * DAY_MS)];
        let items = build_items(&[a.clone()], &hist, now);
        assert_eq!(items.len(), 1, "short clips are skipped");
        assert_eq!(items[0].plays, 2);
        assert_eq!(items[0].recent_plays, 1);
        assert_eq!(items[0].liked, Some(0));
        assert!(items[0].weight > 5.0);
    }

    #[test]
    fn families_follow_genre_then_artist() {
        let likes = vec![
            tr("1", "A", "One", "Frenchcore"),
            tr("2", "A", "Two", "Dance & EDM"), // no genre family: follows A
            tr("3", "B", "Hardcore techno banger", "Techno"),
        ];
        let items = items_from(&likes, &[], 0);
        assert_eq!(items[0].family.as_deref(), Some("harddance"));
        assert_eq!(items[0].sub.as_deref(), Some("frenchcore"));
        assert_eq!(items[1].family.as_deref(), Some("harddance"));
        assert_eq!(items[1].sub, None);
        assert_eq!(items[2].family.as_deref(), Some("techno"));
        assert_eq!(items[2].sub, None, "'Techno' isn't a sub-genre of techno");
    }

    /// A user who likes hardtekk, frenchcore and hip hop plus genre-less tracks
    /// that are always played next to the hip hop artist.
    fn sample() -> (Vec<Track>, Vec<(Track, u64)>) {
        let mut likes = Vec::new();
        for i in 0..12 {
            likes.push(tr(&format!("10{i}"), &format!("Tekk{}", i % 4), &format!("tekk song {i}"), "hardtekk"));
            likes.push(tr(&format!("20{i}"), &format!("French{}", i % 3), &format!("fc song {i}"), "Frenchcore"));
        }
        for i in 0..8 {
            likes.push(tr(&format!("30{i}"), &format!("Rapper{}", i % 2), &format!("rap song {i}"), "Hip-hop"));
        }
        let mut hist = Vec::new();
        let now = 1000 * DAY_MS;
        let mut at = now;
        for i in 0..8 {
            hist.push((tr(&format!("30{i}"), &format!("Rapper{}", i % 2), &format!("rap song {i}"), "Hip-hop"), at));
            at -= 60_000;
            hist.push((tr(&format!("40{i}"), "Mystery", &format!("untagged {i}"), ""), at));
            at -= 60_000;
        }
        (likes, hist)
    }

    #[test]
    fn taste_groups_cluster_by_genre_and_cooccurrence() {
        let (likes, hist) = sample();
        let now = 1000 * DAY_MS;
        let items = items_from(&likes, &hist, now);
        let cooc = cooccurrence(&hist);
        assert!(cooc["u-mystery"]["u-rapper0"] > 0);
        let groups = taste_groups(&items, &cooc);
        let keys: Vec<&str> = groups.iter().map(|g| g.key.as_str()).collect();
        assert!(keys.contains(&"harddance/hardtekk"), "{keys:?}");
        assert!(keys.contains(&"harddance/frenchcore"), "{keys:?}");
        let rap = groups.iter().find(|g| g.family.as_deref() == Some("rap")).expect("rap group");
        // The untagged "Mystery" tracks ride along with the rapper they're played next to.
        assert!(rap.members.iter().any(|&i| items[i].track.artist == "Mystery"));
        assert!(groups.iter().all(|g| g.key != "other"));
        assert!(groups.len() <= MAX_DAILY);
        assert_eq!(groups.iter().find(|g| g.key == "harddance/hardtekk").unwrap().label(), "Hardtekk");
    }

    #[test]
    fn small_groups_fold_into_their_family() {
        let mut likes = Vec::new();
        for i in 0..10 {
            likes.push(tr(&format!("1{i}"), &format!("T{}", i % 3), &format!("tekk {i}"), "hardtekk"));
        }
        likes.push(tr("90", "U", "up 1", "Uptempo"));
        likes.push(tr("91", "U", "up 2", "Uptempo"));
        let items = items_from(&likes, &[], 0);
        let groups = taste_groups(&items, &HashMap::new());
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].members.len(), 12);
    }

    #[test]
    fn plans_name_mixes() {
        let (likes, hist) = sample();
        let now = 1000 * DAY_MS;
        let mut items = items_from(&likes, &hist, now);
        for (i, it) in items.iter_mut().enumerate() {
            it.year = Some(if i % 2 == 0 { 2008 } else { 2021 });
        }
        let plans = plans(&items, &cooccurrence(&hist), now);
        let titles: Vec<&str> = plans.iter().map(|p| p.title.as_str()).collect();
        for want in ["Daily Mix 1", "Daily Mix 2", "Daily Mix 3", "Hardtekk Mix", "Frenchcore Mix", "Hip Hop Mix", "2000s Mix", "2020s Mix"] {
            assert!(titles.contains(&want), "missing {want} in {titles:?}");
        }
        assert!(titles.contains(&"Hard Dance Mix"), "family mix when no sub-genre dominates: {titles:?}");
        // Liked + played artists rank first; six artist mixes at most.
        assert!(titles.contains(&"Rapper0 Mix"), "artist mixes: {titles:?}");
        assert_eq!(plans.iter().filter(|p| p.kind == "artist").count(), MAX_ARTIST);
        assert_eq!(titles.iter().filter(|t| **t == "Hip Hop Mix").count(), 1, "no duplicate titles");
        // ids are unique
        let ids: HashSet<&str> = plans.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(ids.len(), plans.len());
        // only 8 repeated? history has single plays, so no On Repeat
        assert!(!titles.contains(&"On Repeat"));
    }

    #[test]
    fn on_repeat_and_rewind() {
        let now = 1000 * DAY_MS;
        let mut hist = Vec::new();
        for i in 0..9 {
            let t = tr(&format!("{i}"), &format!("A{i}"), &format!("s{i}"), "");
            hist.push((t.clone(), now - 1000 - i as u64));
            hist.push((t.clone(), now - 5000 - i as u64));
            let old = tr(&format!("old{i}"), &format!("B{i}"), &format!("o{i}"), "");
            for k in 0..3 {
                hist.push((old.clone(), now - 60 * DAY_MS - k));
            }
        }
        hist.sort_by_key(|(_, at)| std::cmp::Reverse(*at));
        let items = items_from(&[], &hist, now);
        let plans = plans(&items, &HashMap::new(), now);
        let rep = plans.iter().find(|p| p.id == "on-repeat").expect("on repeat");
        assert_eq!(rep.own.len(), 9);
        assert!(rep.own.iter().all(|t| !t.id.starts_with("old")));
        let rew = plans.iter().find(|p| p.id == "repeat-rewind").expect("rewind");
        assert!(rew.own.iter().all(|t| t.id.starts_with("old")));
    }

    #[test]
    fn finish_dedupes_filters_and_skips_small() {
        let mut p = Plan::new("daily-1".into(), "daily", "Daily Mix 1".into());
        p.family = Some("harddance".into());
        p.own_run = 1;
        p.own = (0..6).map(|i| tr(&format!("{i}"), &format!("A{i}"), &format!("own {i}"), "hardtekk")).collect();
        p.own.push(tr("dup", "A0", "own 0 (Official Video)", "hardtekk")); // same song as "0"
        let fresh: Vec<(Track, Vec<String>)> = vec![
            (tr("f1", "F1", "new 1", "hardtekk"), vec!["harddance".into()]),
            (tr("f2", "F2", "new 2", "house"), vec!["house".into()]), // wrong family
            (tr("0", "A0", "own 0", "hardtekk"), vec!["harddance".into()]), // already own
            (tr("f3", "F3", "new 3", "hardtekk"), vec!["harddance".into()]),
        ];
        let m = finish(&p, &fresh, 5).expect("mix");
        let ids: Vec<&str> = m.tracks.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(ids, vec!["0", "f1", "1", "f3", "2", "3", "4", "5"]);
        assert_eq!(m.covers.len(), 4);
        assert_eq!(m.subtitle, "A0, A1, A2 and more");
        assert_eq!(m.sources, vec!["sc"]);
        assert_eq!(m.updated_at, 5);
        // Too few tracks: skipped.
        p.own.truncate(3);
        assert!(finish(&p, &fresh[..1], 5).is_none());
    }

    #[test]
    fn artist_mix_credits_lead_first() {
        let mut p = Plan::new("artist-x".into(), "artist", "celadon Mix".into());
        p.lead = "celadon".into();
        p.own_cap = 0;
        p.own = (0..4).map(|i| tr(&format!("{i}"), "celadon", &format!("c {i}"), "")).collect();
        let fresh: Vec<(Track, Vec<String>)> = (0..6)
            .map(|i| (tr(&format!("f{i}"), if i < 4 { "shk" } else { "expe" }, &format!("f {i}"), ""), vec![]))
            .collect();
        let m = finish(&p, &fresh, 0).unwrap();
        assert_eq!(m.subtitle, "celadon, shk and expe");
        assert_eq!(m.tracks.len(), 9, "at most NEW_PER_ARTIST new songs by shk");
    }

    #[test]
    fn collage_needs_four_artists() {
        let ts: Vec<Track> = (0..3).map(|i| tr(&format!("{i}"), "Same", "x", "")).collect();
        let (covers, cover) = collage(&ts);
        assert!(covers.is_empty());
        assert!(cover.contains("artworks-0"));
        let ts: Vec<Track> = (0..5).map(|i| tr(&format!("{i}"), &format!("A{i}"), "x", "")).collect();
        assert_eq!(collage(&ts).0.len(), 4);
    }

    fn yt(vid: &str, artist: &str, title: &str) -> Track {
        let mut t = tr(&format!("yt:{vid}"), artist, title, "");
        t.source = "youtube".into();
        t.style = String::new();
        t
    }

    #[test]
    fn upload_only_years() {
        assert!(upload_year_only(&json!({ "created_at": "2019-01-01T00:00:00Z", "display_date": "2019-01-01T00:00:00Z" })));
        assert!(upload_year_only(&json!({ "created_at": "2019-01-01T00:00:00Z" })));
        assert!(!upload_year_only(&json!({ "release_date": "2004-05-01", "created_at": "2019-01-01" })));
        assert!(!upload_year_only(&json!({ "display_date": "2004-05-01", "created_at": "2019-01-01" })), "display date set by the uploader");
        assert!(!upload_year_only(&json!({})));
        assert!(is_yt(&yt("hqvcww4ydh8", "Kanye West", "x")));
        assert!(!is_yt(&tr("123", "A", "x", "")));
    }

    #[test]
    fn youtube_seeds_and_share() {
        let mut likes: Vec<Track> = (0..6).map(|i| yt(&format!("vid0000000{i}"), &format!("Y{i}"), &format!("y {i}"))).collect();
        likes.extend((0..2).map(|i| tr(&format!("50{i}"), &format!("S{i}"), &format!("s {i}"), "")));
        let items = items_from(&likes, &[], 0);
        let list: Vec<&Item> = items.iter().collect();
        let mut p = Plan::new("x".into(), "daily", "x".into());
        set_seeds(&mut p, &list, 10);
        assert_eq!(p.yt_seeds.len(), 6);
        assert_eq!(p.seeds.len(), 2);
        assert!(p.yt_share > 0.6 && p.yt_share < 0.85, "{}", p.yt_share);
    }

    #[test]
    fn related_ranking_prefers_shared_tracks() {
        let a = yt("aaaaaaaaaaa", "A", "a");
        let b = yt("bbbbbbbbbbb", "B", "b");
        let c = yt("ccccccccccc", "C", "c");
        let own = yt("ownownownow", "O", "mine");
        let reup = yt("reupreupreu", "O", "Mine (Official Video)");
        let b2 = yt("bbbbbbbbbb2", "B", "b two");
        let b3 = yt("bbbbbbbbbb3", "B", "b three");
        let lists = vec![
            (2.0, vec![a.clone(), own.clone(), b.clone(), b2.clone(), b3.clone()]),
            (1.0, vec![c.clone(), b.clone(), reup.clone()]),
        ];
        let skip: HashSet<String> = [own.id.clone()].into();
        let songs: HashSet<String> = [song_key(&own)].into();
        let r = rank_related(&lists, &skip, &songs, 10);
        let ids: Vec<(&str, usize)> = r.iter().map(|(t, h)| (t.id.as_str(), *h)).collect();
        // b is in both radios; own + its re-upload are skipped; B keeps two tracks
        assert_eq!(ids, vec![("yt:bbbbbbbbbbb", 2), ("yt:aaaaaaaaaaa", 1), ("yt:bbbbbbbbbb2", 1), ("yt:ccccccccccc", 1)]);
        assert_eq!(rank_related(&lists, &skip, &songs, 2).len(), 2);
    }

    #[test]
    fn related_admission_without_genres() {
        let mut p = Plan::new("x".into(), "daily", "x".into());
        p.family = Some("rap".into());
        assert_eq!(admit_related(&p, vec!["rap".into()], 1, false), Some(vec!["rap".to_string()]));
        assert_eq!(admit_related(&p, vec!["house".into()], 3, true), None, "a different genre stays out");
        assert_eq!(admit_related(&p, vec![], 1, false), None, "no genre, one seed: unsure");
        assert_eq!(admit_related(&p, vec![], 2, false), Some(vec!["rap".to_string()]));
        assert_eq!(admit_related(&p, vec![], 1, true), Some(vec!["rap".to_string()]));
        p.family = None;
        assert_eq!(admit_related(&p, vec![], 1, false), Some(vec![]));
    }

    #[test]
    fn blend_follows_share() {
        let sc: Vec<u32> = (0..10).collect();
        let yt: Vec<u32> = (100..110).collect();
        let b = blend(sc.clone(), yt.clone(), 0.75);
        assert_eq!(b.len(), 20);
        assert_eq!(b[..8].iter().filter(|x| **x >= 100).count(), 6);
        assert_eq!(blend(sc.clone(), yt.clone(), 0.0)[..10], sc[..]);
        assert_eq!(blend(sc.clone(), yt.clone(), 1.0)[..10], yt[..]);
        assert_eq!(blend(sc[..2].to_vec(), yt.clone(), 0.0).len(), 12, "leftovers follow");
    }

    #[test]
    fn sources_parse() {
        assert_eq!(Sources::parse("both"), Some(Sources::Both));
        assert_eq!(Sources::parse(" SC "), Some(Sources::Sc));
        assert_eq!(Sources::parse("soundcloud"), Some(Sources::Sc));
        assert_eq!(Sources::parse("yt"), Some(Sources::Yt));
        assert_eq!(Sources::parse("YouTube"), Some(Sources::Yt));
        assert_eq!(Sources::parse("spotify"), None);
        assert_eq!(Sources::parse(""), None);
        assert_eq!(Sources::default(), Sources::Both);
        for s in [Sources::Both, Sources::Sc, Sources::Yt] {
            assert_eq!(Sources::parse(s.as_str()), Some(s));
        }
    }

    #[test]
    fn both_sources_keep_a_minimum_per_side() {
        assert_eq!(new_share(Sources::Both, 0.5), 0.5);
        assert_eq!(new_share(Sources::Both, 0.0), MIN_SIDE, "all-SoundCloud taste still gets YouTube");
        assert_eq!(new_share(Sources::Both, 1.0), 1.0 - MIN_SIDE, "all-YouTube taste still gets SoundCloud");
        let tilt = new_share(Sources::Both, 0.6);
        assert!(tilt > 0.5 && tilt < 1.0 - MIN_SIDE, "{tilt}");
        assert_eq!(new_share(Sources::Sc, 0.9), 0.0);
        assert_eq!(new_share(Sources::Yt, 0.1), 1.0);
        // Blended at the minimum, both sides fill at least 35% of the first 20 new songs.
        let sc: Vec<u32> = (0..40).collect();
        let yt: Vec<u32> = (100..140).collect();
        for own in [0.0, 0.2, 0.5, 0.8, 1.0] {
            let b = blend(sc.clone(), yt.clone(), new_share(Sources::Both, own));
            let n_yt = b[..20].iter().filter(|x| **x >= 100).count();
            assert!((7..=13).contains(&n_yt), "own {own}: {n_yt}/20 YouTube");
        }
    }

    #[test]
    fn song_keys_read_artist_from_soundcloud_titles() {
        let sc = tr("1", "someuploader", "Kanye West - Stronger (Official Audio)", "");
        let y = yt("dp000000009", "Kanye West", "Stronger");
        let keys = song_keys(&sc);
        assert_eq!(keys.len(), 2);
        assert!(keys.contains(&song_key(&y)));
        assert_eq!(song_keys(&y), vec![song_key(&y)]);
        // A YouTube top-up of a song the user has on SoundCloud is skipped.
        let skip: HashSet<String> = keys.into_iter().collect();
        let r = rank_related(&[(1.0, vec![y.clone(), yt("dp000000010", "Kanye West", "Heartless")])], &HashSet::new(), &skip, 10);
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].0.title, "Heartless");
    }

    #[test]
    fn playlist_names_hint_genres_and_artist_names() {
        let names: HashMap<String, Vec<String>> = [("songs".to_string(), vec![]), ("Hip Hop Mix".to_string(), vec!["rap".to_string()])].into();
        assert_eq!(hint_families(&["songs".into(), "Hip Hop Mix".into()], &names), vec!["rap"]);
        assert!(hint_families(&["songs".into()], &names).is_empty());
        let mut likes = vec![yt("dp000000001", "Daft Punk & Julian Casablancas", "Instant Crush")];
        likes.extend((2..5).map(|i| yt(&format!("dp00000000{i}"), "Daft Punk", &format!("song {i}"))));
        for t in likes.iter_mut() {
            t.artist_id = "UCdaftpunk".into();
        }
        let items = items_from(&likes, &[], 0);
        assert_eq!(artist_name(&items.iter().collect::<Vec<_>>()), "Daft Punk");
    }

    #[test]
    fn decade_filter_for_era_top_ups() {
        // SoundCloud release dates are trusted; upload-only years give way to older YouTube Music years.
        assert_eq!(candidate_year(Some(1996), false, Some(2012)), Some(1996));
        assert_eq!(candidate_year(Some(2014), true, Some(1995)), Some(1995));
        assert_eq!(candidate_year(Some(2014), true, Some(2019)), Some(2014));
        assert_eq!(candidate_year(Some(2014), true, None), Some(2014));
        assert_eq!(candidate_year(None, false, Some(1999)), Some(1999));
        assert_eq!(candidate_year(None, false, None), None);
        assert!(in_decade(Some(1990), 1990) && in_decade(Some(1999), 1990));
        assert!(!in_decade(Some(2000), 1990) && !in_decade(Some(1989), 1990) && !in_decade(None, 1990));
        assert!(in_decade(candidate_year(Some(2016), true, Some(1994)), 1990), "a 90s song re-uploaded in 2016");
        assert!(!in_decade(candidate_year(Some(2016), true, None), 1990), "no older year: stays out");
        assert!(reupload(&tr("1", "Matt", "Initial D - Movin' Up", "")));
        assert!(!reupload(&tr("1", "DEADLIGHT", "Deadlight - UROBOROS", "")), "the artist's own upload");
        assert!(!reupload(&tr("1", "cold", "TASTE MY BLOOD", "")));
        assert_eq!(decade_word(1990), "90s");
        assert_eq!(decade_word(2000), "2000s");
        assert_eq!(era_queries(1990, &["rap".into(), "rnb".into()]), vec!["90s hip hop", "90s r&b"]);
        // Top families inside the decade only.
        let mut likes: Vec<Track> = (0..5).map(|i| tr(&format!("1{i}"), &format!("R{i}"), &format!("r {i}"), "Hip hop")).collect();
        likes.extend((0..3).map(|i| tr(&format!("2{i}"), &format!("H{i}"), &format!("h {i}"), "House")));
        likes.extend((0..9).map(|i| tr(&format!("3{i}"), &format!("T{i}"), &format!("t {i}"), "Techno")));
        let mut items = items_from(&likes, &[], 0);
        for it in items.iter_mut() {
            it.year = Some(if it.track.id.starts_with('3') { 2015 } else { 1997 });
        }
        assert_eq!(era_families(&items, 1990, 3), vec!["rap", "house"]);
        assert_eq!(era_families(&items, 2010, 1), vec!["techno"]);
    }

    #[test]
    fn mixes_fill_to_fifty_with_new_songs() {
        let own: Vec<Track> = (0..12).map(|i| tr(&format!("{i}"), &format!("A{i}"), &format!("own {i}"), "")).collect();
        let fresh: Vec<(Track, Vec<String>)> =
            (0..60).map(|i| (tr(&format!("n{i}"), &format!("N{}", i / 4), &format!("new {i}"), ""), vec![])).collect();
        let mut p = Plan::new("era-1990s".into(), "era", era_title(1990));
        p.own = own.clone();
        p.own_cap = 5;
        half_new(&mut p);
        let m = finish(&p, &fresh, 0).unwrap();
        assert_eq!(m.tracks.len(), MAX_TRACKS, "12 own tracks still make 50");
        assert_eq!(m.tracks[0].id, "0", "own first");
        assert_eq!(m.tracks.iter().filter(|t| !t.id.starts_with('n')).count(), 12);
        // At most NEW_PER_ARTIST new songs per artist (N0..N14 have four each).
        let mut per: HashMap<String, usize> = HashMap::new();
        for t in m.tracks.iter().filter(|t| t.id.starts_with('n')) {
            *per.entry(t.artist.clone()).or_default() += 1;
        }
        assert!(per.values().all(|n| *n <= NEW_PER_ARTIST), "{per:?}");

        // Many own tracks: about half new.
        p.own = (0..80).map(|i| tr(&format!("{i}"), &format!("A{i}"), &format!("own {i}"), "")).collect();
        let m = finish(&p, &fresh, 0).unwrap();
        let new = m.tracks.iter().filter(|t| t.id.starts_with('n')).count();
        assert_eq!((m.tracks.len(), new), (50, 25));
        // Few new songs: more own tracks fill the mix up to 50.
        let m = finish(&p, &fresh[..8], 0).unwrap();
        assert_eq!(m.tracks.len(), 50);
        assert_eq!(m.tracks.iter().filter(|t| t.id.starts_with('n')).count(), 6, "N0 x3 + N1 x3");

        // On Repeat stays own-only and stops at max_own.
        let mut r = Plan::new("on-repeat".into(), "repeat", "On Repeat".into());
        r.own = p.own.clone();
        r.max_own = 30;
        r.own_cap = 0;
        let m = finish(&r, &[], 0).unwrap();
        assert_eq!(m.tracks.len(), 30);
    }

    #[test]
    fn era_plans_get_seeds_and_half_new() {
        let (likes, hist) = sample();
        let now = 1000 * DAY_MS;
        let mut items = items_from(&likes, &hist, now);
        for it in items.iter_mut() {
            it.year = Some(1996);
        }
        let plans = plans(&items, &cooccurrence(&hist), now);
        let era = plans.iter().find(|p| p.kind == "era").expect("era plan");
        assert_eq!((era.title.as_str(), era.decade), ("90s Mix", 1990));
        assert!(!era.seeds.is_empty() && era.family.is_none());
        assert_eq!((era.max_own, era.own_run, era.new_run), (25, 1, 1));
        let g = plans.iter().find(|p| p.kind == "genre").unwrap();
        assert_eq!((g.max_own, g.new_run), (25, 1));
        assert!(plans.iter().filter(|p| !tops_up(&p.kind)).all(|p| p.seeds.is_empty()));
    }

    #[test]
    fn mix_json_shape() {
        let m = Mix {
            id: "daily-1".into(),
            kind: "daily".into(),
            title: "Daily Mix 1".into(),
            subtitle: "a".into(),
            covers: vec![],
            cover: "c".into(),
            number: 1,
            tag: "Hardtekk".into(),
            sources: vec!["sc".into()],
            tracks: vec![tr("1", "A", "x", "")],
            updated_at: 9,
        };
        let v = serde_json::to_value(&m).unwrap();
        assert_eq!(v["updatedAt"], 9);
        assert_eq!(v["tracks"][0]["id"], "1");
        let back: Mix = serde_json::from_value(v).unwrap();
        assert_eq!(back.number, 1);
    }
}
