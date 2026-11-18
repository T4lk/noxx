//! Picks the playable track that best matches an imported title/artist.
//! Token overlap on normalized text, plus a bonus when durations agree.

use std::collections::HashSet;
use std::sync::LazyLock;

use regex::Regex;

use crate::soundcloud::Track;

static BRACKETS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\(.*?\)|\[.*?\]").unwrap());
static TAIL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\b(feat|ft|remaster(ed)?|remix|version|official|audio|video|lyrics?)\b.*$").unwrap());

fn translit(c: char) -> Option<&'static str> {
    Some(match c {
        'а' => "a", 'б' => "b", 'в' => "v", 'г' => "g", 'д' => "d", 'е' | 'ё' | 'э' => "e", 'ж' => "zh",
        'з' => "z", 'и' | 'і' => "i", 'й' | 'ы' => "y", 'к' => "k", 'л' => "l", 'м' => "m", 'н' => "n",
        'о' => "o", 'п' => "p", 'р' => "r", 'с' => "s", 'т' => "t", 'у' => "u", 'ф' => "f", 'х' => "h",
        'ц' => "ts", 'ч' => "ch", 'ш' => "sh", 'щ' => "sch", 'ъ' | 'ь' => "", 'ю' => "yu", 'я' => "ya",
        'ї' => "yi", 'є' => "ye", 'ґ' => "g",
        'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' | 'ā' | 'ă' | 'ą' => "a",
        'ç' | 'ć' | 'č' => "c", 'ď' | 'đ' => "d",
        'è' | 'é' | 'ê' | 'ë' | 'ē' | 'ę' | 'ě' => "e",
        'ì' | 'í' | 'î' | 'ï' | 'ī' | 'ı' => "i", 'ł' => "l", 'ñ' | 'ń' | 'ň' => "n",
        'ò' | 'ó' | 'ô' | 'õ' | 'ö' | 'ø' | 'ō' | 'ő' => "o", 'ř' => "r", 'ś' | 'š' | 'ş' => "s", 'ß' => "ss",
        'ť' | 'ţ' => "t", 'ù' | 'ú' | 'û' | 'ü' | 'ū' | 'ů' | 'ű' => "u", 'ý' | 'ÿ' => "y", 'ź' | 'ż' | 'ž' => "z",
        'æ' => "ae", 'œ' => "oe", '$' => "s", '&' => " and ",
        _ => return None,
    })
}

pub fn normalize(s: &str) -> String {
    let lower = s.to_lowercase();
    let no_br = BRACKETS.replace_all(&lower, " ");
    let cut = TAIL.replace(&no_br, " ");
    let mut out = String::with_capacity(cut.len());
    for c in cut.chars() {
        if let Some(t) = translit(c) {
            out.push_str(t);
        } else if c.is_ascii_alphanumeric() {
            out.push(c);
        } else {
            out.push(' ');
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub fn has_cyrillic(s: &str) -> bool {
    s.chars().any(|c| ('\u{0400}'..='\u{04FF}').contains(&c))
}

fn tokens(s: &str) -> HashSet<String> {
    normalize(s).split(' ').filter(|t| !t.is_empty()).map(str::to_string).collect()
}

pub fn similarity(a: &str, b: &str) -> f64 {
    let (a, b) = (tokens(a), tokens(b));
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    let hit = a.iter().filter(|t| b.contains(*t)).count();
    hit as f64 / a.len().max(b.len()) as f64
}

/// Re-uploads that are a different version of the song.
static VARIANT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\b(slowed|reverb|sped[ -]?up|speed[ -]?up|nightcore|8d|cover|karaoke|instrumental|remix|rmx|edit|vip|live|bootleg|flip|mashup|acoustic|1 hour|10 hours|extended|loop|reverse|bass ?boosted|daycore)\b").unwrap()
});

fn variants(s: &str) -> HashSet<String> {
    VARIANT.find_iter(&s.to_lowercase()).map(|m| m.as_str().replace([' ', '-'], "")).collect()
}

/// Best candidate, or None when nothing is close enough.
#[cfg(test)]
pub fn pick<'a>(title: &str, artist: &str, duration: u64, results: &'a [Track]) -> Option<&'a Track> {
    pick_scored(title, artist, duration, results).map(|(t, _, _)| t)
}

/// Best candidate with its score and whether the length matched to the second.
pub fn pick_scored<'a>(title: &str, artist: &str, duration: u64, results: &'a [Track]) -> Option<(&'a Track, f64, bool)> {
    let want = format!("{title} {artist}");
    let want_v = variants(&want);
    // The main artist, e.g. "KAROL G" from "KAROL G, Judeline".
    let lead = artist.split([',', '&']).next().unwrap_or("").trim();
    let mut best: Option<(&Track, f64, bool)> = None;
    for r in results {
        if variants(&format!("{} {}", r.title, r.artist)).iter().any(|v| !want_v.contains(v)) {
            continue;
        }
        let text = similarity(&want, &format!("{} {}", r.title, r.artist));
        let title_sim = similarity(title, &r.title);
        let artist_sim = if lead.is_empty() { 1.0 } else { similarity(lead, &r.artist).max(similarity(lead, &r.title) * 0.9) };
        let dur_ok = duration > 0 && r.duration > 0 && duration.abs_diff(r.duration) <= 3;
        let score = text + if dur_ok { 0.6 } else { 0.0 } + title_sim * 0.3 + artist_sim * 0.4;
        // The artist has to show up somewhere unless the length matches to the second.
        let accept = ((dur_ok && text >= 0.2) || title_sim >= 0.6 || text >= 0.55) && (artist_sim > 0.0 || dur_ok);
        // Way off in length (a 1h mix for a 3 min song) is a different upload.
        let far = duration > 0 && r.duration > 0 && (r.duration > duration * 2 + 60 || r.duration + 45 < duration / 2);
        if accept && !far && best.map_or(true, |(_, s, _)| score > s) {
            best = Some((r, score, dur_ok));
        }
    }
    best
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(title: &str, artist: &str, duration: u64) -> Track {
        Track {
            id: title.into(),
            title: title.into(),
            artist: artist.into(),
            duration,
            artwork: String::new(),
            url: String::new(),
            artist_id: String::new(),
            artist_url: String::new(),
            genre: String::new(),
            style: String::new(),
            source: String::new(),
            path: String::new(),
        }
    }

    #[test]
    fn normalizes() {
        assert_eq!(normalize("Café del Mar (Remastered 2010) [Live]"), "cafe del mar");
        assert_eq!(normalize("Song feat. Someone"), "song");
        assert_eq!(normalize("Кино - Группа крови"), "kino gruppa krovi");
    }

    #[test]
    fn picks_by_duration_and_text() {
        let list = vec![t("Get Lucky (Radio Edit)", "Daft Punk", 248), t("Get Lucky", "Daft Punk", 369), t("Lucky", "Britney", 206)];
        assert_eq!(pick("Get Lucky", "Daft Punk, Pharrell Williams", 369, &list).unwrap().duration, 369);
        assert!(pick("Totally Different", "Nobody", 100, &list).is_none());
        let rem = vec![t("BbY WOW (slowed and reverb)", "clouclou", 260), t("BbY WOW", "KAROL G", 226)];
        assert_eq!(pick("BbY WOW", "KAROL G, Judeline", 226, &rem).unwrap().artist, "KAROL G");
        assert!(pick("BbY WOW", "KAROL G", 226, &rem[..1]).is_none());
    }
}
