//! Format plumbing for downloads: HLS playlist parsing, MPEG-TS demuxing to
//! a raw ADTS / MP3 stream, container sniffing and ID3 stripping.

use url::Url;

// ------------------------------------------------------------------ HLS

#[derive(Debug, Default, PartialEq)]
pub(super) struct Playlist {
    /// Variant playlists (master playlist), best bandwidth first.
    pub variants: Vec<String>,
    /// EXT-X-MAP init segment (fMP4).
    pub init: Option<String>,
    pub segments: Vec<String>,
    /// METHOD other than NONE: we can't decrypt.
    pub encrypted: bool,
}

fn attr(line: &str, key: &str) -> Option<String> {
    let at = line.find(&format!("{key}="))? + key.len() + 1;
    let rest = &line[at..];
    Some(if let Some(r) = rest.strip_prefix('"') {
        r.split('"').next().unwrap_or("").to_string()
    } else {
        rest.split(',').next().unwrap_or("").trim().to_string()
    })
}

fn join(base: &Url, rel: &str) -> Option<String> {
    base.join(rel.trim()).ok().map(|u| u.to_string())
}

pub(super) fn parse_playlist(text: &str, base: &Url) -> Playlist {
    let mut p = Playlist::default();
    let mut variants: Vec<(u64, String)> = Vec::new();
    let mut pending_bw: Option<u64> = None;
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        if let Some(rest) = line.strip_prefix("#EXT-X-STREAM-INF:") {
            pending_bw = Some(attr(rest, "BANDWIDTH").and_then(|b| b.parse().ok()).unwrap_or(0));
        } else if let Some(rest) = line.strip_prefix("#EXT-X-MAP:") {
            p.init = attr(rest, "URI").and_then(|u| join(base, &u));
        } else if let Some(rest) = line.strip_prefix("#EXT-X-KEY:") {
            if attr(rest, "METHOD").is_some_and(|m| !m.eq_ignore_ascii_case("NONE")) {
                p.encrypted = true;
            }
        } else if line.starts_with('#') {
            continue;
        } else if let Some(bw) = pending_bw.take() {
            if let Some(u) = join(base, line) {
                variants.push((bw, u));
            }
        } else if let Some(u) = join(base, line) {
            p.segments.push(u);
        }
    }
    variants.sort_by_key(|v| std::cmp::Reverse(v.0));
    p.variants = variants.into_iter().map(|v| v.1).collect();
    p
}

// ------------------------------------------------------------------ sniffing

/// Skips any ID3v2 tags at the front (HLS packed audio carries a timestamp tag per segment).
pub(super) fn strip_id3(mut d: &[u8]) -> &[u8] {
    while d.len() >= 10 && &d[..3] == b"ID3" {
        let size = d[6..10].iter().fold(0usize, |a, &b| (a << 7) | (b & 0x7f) as usize);
        let footer = if d[5] & 0x10 != 0 { 10 } else { 0 };
        let total = 10 + size + footer;
        if total > d.len() {
            return &d[d.len()..];
        }
        d = &d[total..];
    }
    d
}

pub(super) fn is_ts(d: &[u8]) -> bool {
    d.len() >= 188 && d[0] == 0x47 && (d.len() < 376 || d[188] == 0x47)
}

/// File extension for a raw (non-TS) audio payload.
pub(super) fn sniff(d: &[u8]) -> &'static str {
    let d = strip_id3(d);
    if d.len() >= 8 && &d[4..8] == b"ftyp" {
        "m4a"
    } else if d.starts_with(b"OggS") {
        if d.windows(8).take(200).any(|w| w == b"OpusHead") {
            "opus"
        } else {
            "ogg"
        }
    } else if d.starts_with(b"fLaC") {
        "flac"
    } else if d.len() >= 2 && d[0] == 0xFF && d[1] & 0xF6 == 0xF0 {
        "aac" // ADTS: sync + layer 00
    } else {
        "mp3"
    }
}

// ------------------------------------------------------------------ MPEG-TS

/// Pulls the first audio elementary stream out of a transport stream.
#[derive(Default)]
pub(super) struct TsDemux {
    pmt_pid: Option<u16>,
    audio_pid: Option<u16>,
    stream_type: u8,
    pes: Vec<u8>,
    pub out: Vec<u8>,
}

fn section(payload: &[u8], pusi: bool) -> &[u8] {
    if !pusi || payload.is_empty() {
        return payload;
    }
    let skip = 1 + payload[0] as usize;
    payload.get(skip..).unwrap_or(&[])
}

impl TsDemux {
    pub fn push(&mut self, data: &[u8]) {
        for p in data.chunks_exact(188) {
            if p[0] == 0x47 {
                self.packet(p);
            }
        }
    }

    fn packet(&mut self, p: &[u8]) {
        let pusi = p[1] & 0x40 != 0;
        let pid = (((p[1] & 0x1f) as u16) << 8) | p[2] as u16;
        let afc = (p[3] >> 4) & 3;
        if afc & 1 == 0 {
            return; // no payload
        }
        let start = if afc & 2 != 0 { 5 + p[4] as usize } else { 4 };
        let Some(payload) = p.get(start..) else { return };
        if pid == 0 {
            let s = section(payload, pusi);
            if s.len() >= 12 {
                let len = ((((s[1] & 0x0f) as usize) << 8) | s[2] as usize).min(s.len() - 3);
                let mut at = 8;
                while at + 4 <= 3 + len.saturating_sub(4) {
                    let program = ((s[at] as u16) << 8) | s[at + 1] as u16;
                    let ppid = (((s[at + 2] & 0x1f) as u16) << 8) | s[at + 3] as u16;
                    if program != 0 {
                        self.pmt_pid = Some(ppid);
                        break;
                    }
                    at += 4;
                }
            }
        } else if Some(pid) == self.pmt_pid {
            if self.audio_pid.is_some() {
                return;
            }
            let s = section(payload, pusi);
            if s.len() < 12 {
                return;
            }
            let len = ((((s[1] & 0x0f) as usize) << 8) | s[2] as usize).min(s.len() - 3);
            let end = 3 + len.saturating_sub(4);
            let info = (((s[10] & 0x0f) as usize) << 8) | s[11] as usize;
            let mut at = 12 + info;
            while at + 5 <= end {
                let st = s[at];
                let epid = (((s[at + 1] & 0x1f) as u16) << 8) | s[at + 2] as u16;
                let es_len = (((s[at + 3] & 0x0f) as usize) << 8) | s[at + 4] as usize;
                if matches!(st, 0x0f | 0x03 | 0x04) {
                    self.audio_pid = Some(epid);
                    self.stream_type = st;
                    break;
                }
                at += 5 + es_len;
            }
        } else if Some(pid) == self.audio_pid {
            if pusi {
                self.flush();
            }
            self.pes.extend_from_slice(payload);
        }
    }

    fn flush(&mut self) {
        let pes = std::mem::take(&mut self.pes);
        if pes.len() >= 9 && pes[..3] == [0, 0, 1] {
            let body = 9 + pes[8] as usize;
            if let Some(es) = pes.get(body..) {
                self.out.extend_from_slice(es);
            }
        }
    }

    /// Finishes the stream; returns the extension for what came out.
    pub fn finish(&mut self) -> Option<&'static str> {
        self.flush();
        match self.stream_type {
            0x0f => Some("aac"),
            0x03 | 0x04 => Some("mp3"),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_media_and_master_playlists() {
        let base = Url::parse("https://cf-hls-media.sndcdn.com/playlist/abc/aac_160k/x/playlist.m3u8?a=1").unwrap();
        let media = "#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-MAP:URI=\"init.mp4?x=1\"\n#EXTINF:9.9,\nseg0.m4s\n#EXTINF:9.9,\nhttps://other.example/seg1.m4s\n#EXT-X-ENDLIST\n";
        let p = parse_playlist(media, &base);
        assert_eq!(p.init.as_deref(), Some("https://cf-hls-media.sndcdn.com/playlist/abc/aac_160k/x/init.mp4?x=1"));
        assert_eq!(p.segments.len(), 2);
        assert_eq!(p.segments[1], "https://other.example/seg1.m4s");
        assert!(!p.encrypted && p.variants.is_empty());

        let master = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=64000,CODECS=\"mp4a\"\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=160000\nhigh.m3u8\n";
        let m = parse_playlist(master, &base);
        assert!(m.segments.is_empty());
        assert!(m.variants[0].ends_with("/high.m3u8"));

        let enc = "#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI=\"k\"\na.ts\n";
        assert!(parse_playlist(enc, &base).encrypted);
        let none = "#EXTM3U\n#EXT-X-KEY:METHOD=NONE\na.ts\n";
        assert!(!parse_playlist(none, &base).encrypted);
    }

    #[test]
    fn strips_id3_and_sniffs() {
        let mut d = b"ID3\x04\x00\x00\x00\x00\x00\x02xx".to_vec();
        d.extend_from_slice(&[0xFF, 0xFB, 0x90, 0x00]);
        assert_eq!(strip_id3(&d), &[0xFF, 0xFB, 0x90, 0x00]);
        assert_eq!(sniff(&d), "mp3");
        assert_eq!(sniff(&[0xFF, 0xF1, 0x50, 0x80]), "aac");
        assert_eq!(sniff(b"\0\0\0\x18ftypM4A "), "m4a");
        assert_eq!(sniff(b"OggS\0\x02........OpusHead"), "opus");
        assert_eq!(strip_id3(b"ID3\x04\x00\x00\x00\x00\x7f\x7f"), b"");
    }

    fn ts_packet(pid: u16, pusi: bool, payload: &[u8]) -> Vec<u8> {
        let mut p = vec![0x47, ((pusi as u8) << 6) | ((pid >> 8) as u8 & 0x1f), pid as u8];
        let room = 184;
        if payload.len() < room {
            // adaptation field stuffing
            let af = room - payload.len() - 1;
            p.push(0x30);
            p.push(af as u8);
            if af > 0 {
                p.push(0);
                p.extend(std::iter::repeat_n(0xFF, af - 1));
            }
        } else {
            p.push(0x10);
        }
        p.extend_from_slice(payload);
        assert_eq!(p.len(), 188);
        p
    }

    #[test]
    fn demuxes_adts_from_transport_stream() {
        // PAT -> program 1 on PID 0x1000
        let pat = [0u8, 0x00, 0xB0, 0x0D, 0x00, 0x01, 0xC1, 0x00, 0x00, 0x00, 0x01, 0xF0, 0x00, 0, 0, 0, 0];
        // PMT: ADTS audio (0x0F) on PID 0x0101
        let pmt = [0u8, 0x02, 0xB0, 0x12, 0x00, 0x01, 0xC1, 0x00, 0x00, 0xE1, 0x01, 0xF0, 0x00, 0x0F, 0xE1, 0x01, 0xF0, 0x00, 0, 0, 0, 0];
        let frame_a = [0xFFu8, 0xF1, 0x50, 0x80, 1, 2, 3];
        let frame_b = [0xFFu8, 0xF1, 0x50, 0x80, 4, 5, 6];
        let pes = |es: &[u8]| {
            let mut v = vec![0, 0, 1, 0xC0, 0, 0, 0x80, 0x80, 5, 0x21, 0, 1, 0, 1];
            v.extend_from_slice(es);
            v
        };
        let mut ts = ts_packet(0, true, &pat);
        ts.extend(ts_packet(0x1000, true, &pmt));
        ts.extend(ts_packet(0x0101, true, &pes(&frame_a)));
        ts.extend(ts_packet(0x0101, true, &pes(&frame_b)));
        assert!(is_ts(&ts));
        let mut d = TsDemux::default();
        d.push(&ts[..376]);
        d.push(&ts[376..]);
        assert_eq!(d.finish(), Some("aac"));
        assert_eq!(d.out, [frame_a, frame_b].concat());
    }
}
