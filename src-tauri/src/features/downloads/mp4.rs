//! Turns an HLS fMP4 rendition (EXT-X-MAP init segment + moof/mdat fragments)
//! into one ordinary, non-fragmented `.m4a`: a single `mdat` and a real sample
//! table in `moov`. Players then know the duration up front and seek
//! instantly, and taggers (lofty) write `ilst` without tripping over `mvex`.
//!
//! Only what SoundCloud's audio renditions use is handled: one audio track,
//! `default-base-is-moof` addressing (no explicit `base_data_offset`). Anything
//! else returns `None` and the caller keeps the plain concatenation.

fn be32(d: &[u8], at: usize) -> Option<u32> {
    d.get(at..at + 4).map(|b| u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
}
fn be64(d: &[u8], at: usize) -> Option<u64> {
    d.get(at..at + 8).map(|b| u64::from_be_bytes(b.try_into().unwrap()))
}

#[derive(Debug, Clone, Copy)]
pub(super) struct BoxRef {
    pub kind: [u8; 4],
    pub start: usize,
    pub body: usize,
    pub end: usize,
}

impl BoxRef {
    fn bytes<'a>(&self, d: &'a [u8]) -> &'a [u8] {
        &d[self.start..self.end]
    }
}

/// Boxes laid out back to back in `d[from..to]`. Stops at the first malformed one.
pub(super) fn boxes(d: &[u8], from: usize, to: usize) -> Vec<BoxRef> {
    let mut out = Vec::new();
    let mut at = from;
    let to = to.min(d.len());
    while at + 8 <= to {
        let Some(size32) = be32(d, at) else { break };
        let kind: [u8; 4] = d[at + 4..at + 8].try_into().unwrap();
        let (size, header) = match size32 {
            0 => ((to - at) as u64, 8),
            1 => match be64(d, at + 8) {
                Some(s) => (s, 16),
                None => break,
            },
            s => (s as u64, 8),
        };
        if size < header as u64 || at as u64 + size > to as u64 {
            break;
        }
        let end = at + size as usize;
        out.push(BoxRef { kind, start: at, body: at + header, end });
        at = end;
    }
    out
}

fn find<'a>(list: &'a [BoxRef], kind: &[u8; 4]) -> Option<&'a BoxRef> {
    list.iter().find(|b| &b.kind == kind)
}

fn children(d: &[u8], b: &BoxRef) -> Vec<BoxRef> {
    boxes(d, b.body, b.end)
}

fn make_box(kind: &[u8; 4], body: &[u8]) -> Vec<u8> {
    let mut v = Vec::with_capacity(body.len() + 8);
    v.extend_from_slice(&((body.len() + 8) as u32).to_be_bytes());
    v.extend_from_slice(kind);
    v.extend_from_slice(body);
    v
}

fn full_box(kind: &[u8; 4], body: &[u8]) -> Vec<u8> {
    let mut b = vec![0u8; 4]; // version 0, flags 0
    b.extend_from_slice(body);
    make_box(kind, &b)
}

/// Copy of an mvhd / mdhd / tkhd box with its duration field replaced.
fn with_duration(d: &[u8], b: &BoxRef, duration: u64) -> Option<Vec<u8>> {
    let mut out = b.bytes(d).to_vec();
    let body = b.body - b.start;
    let version = *out.get(body)?;
    // after version+flags: creation, modification (4 or 8 each), then
    // tkhd: track_id(4) reserved(4) duration ; mvhd/mdhd: timescale(4) duration
    let times = if version == 1 { 16 } else { 8 };
    let at = body + 4 + times + if &b.kind == b"tkhd" { 8 } else { 4 };
    if version == 1 {
        out.get_mut(at..at + 8)?.copy_from_slice(&duration.to_be_bytes());
    } else {
        let v = u32::try_from(duration).unwrap_or(u32::MAX);
        out.get_mut(at..at + 4)?.copy_from_slice(&v.to_be_bytes());
    }
    Some(out)
}

fn timescale(d: &[u8], b: &BoxRef) -> Option<u32> {
    let version = *d.get(b.body)?;
    be32(d, b.body + 4 + if version == 1 { 16 } else { 8 })
}

#[derive(Default, Clone, Copy)]
struct Defaults {
    duration: u32,
    size: u32,
}

struct Chunk {
    start: usize,
    len: usize,
    samples: u32,
}

/// Samples gathered from every fragment, in order.
#[derive(Default)]
struct Samples {
    sizes: Vec<u32>,
    durations: Vec<u32>,
    chunks: Vec<Chunk>,
}

fn read_traf(d: &[u8], moof: &BoxRef, traf: &BoxRef, trex: Defaults, out: &mut Samples) -> Option<()> {
    let kids = children(d, traf);
    let tfhd = find(&kids, b"tfhd")?;
    let flags = be32(d, tfhd.body)? & 0x00ff_ffff;
    if flags & 0x01 != 0 {
        return None; // explicit base_data_offset: not used by SoundCloud, offsets would be segment-relative
    }
    let mut at = tfhd.body + 8;
    if flags & 0x02 != 0 {
        at += 4;
    }
    let mut def = trex;
    if flags & 0x08 != 0 {
        def.duration = be32(d, at)?;
        at += 4;
    }
    if flags & 0x10 != 0 {
        def.size = be32(d, at)?;
    }
    let base = moof.start;
    let mut next_data: Option<usize> = None;
    for trun in kids.iter().filter(|b| &b.kind == b"trun") {
        let tflags = be32(d, trun.body)? & 0x00ff_ffff;
        let count = be32(d, trun.body + 4)?;
        let mut p = trun.body + 8;
        let data_start = if tflags & 0x01 != 0 {
            let off = be32(d, p)? as i32;
            p += 4;
            (base as i64 + off as i64) as usize
        } else {
            next_data?
        };
        if tflags & 0x04 != 0 {
            p += 4;
        }
        let mut len = 0usize;
        for _ in 0..count {
            let dur = if tflags & 0x100 != 0 {
                let v = be32(d, p)?;
                p += 4;
                v
            } else {
                def.duration
            };
            let size = if tflags & 0x200 != 0 {
                let v = be32(d, p)?;
                p += 4;
                v
            } else {
                def.size
            };
            if tflags & 0x400 != 0 {
                p += 4;
            }
            if tflags & 0x800 != 0 {
                p += 4;
            }
            out.durations.push(dur);
            out.sizes.push(size);
            len += size as usize;
        }
        if data_start + len > d.len() || count == 0 {
            if count == 0 {
                continue;
            }
            return None;
        }
        out.chunks.push(Chunk { start: data_start, len, samples: count });
        next_data = Some(data_start + len);
    }
    Some(())
}

fn build_stbl(stsd: &[u8], s: &Samples, offsets: &[u32]) -> Vec<u8> {
    // stts: run-length durations
    let mut runs: Vec<(u32, u32)> = Vec::new();
    for &dur in &s.durations {
        match runs.last_mut() {
            Some((n, d)) if *d == dur => *n += 1,
            _ => runs.push((1, dur)),
        }
    }
    let mut stts = (runs.len() as u32).to_be_bytes().to_vec();
    for (n, d) in &runs {
        stts.extend_from_slice(&n.to_be_bytes());
        stts.extend_from_slice(&d.to_be_bytes());
    }
    // stsc: a new entry whenever samples-per-chunk changes
    let mut stsc_entries: Vec<(u32, u32)> = Vec::new();
    for (i, c) in s.chunks.iter().enumerate() {
        if stsc_entries.last().map(|e| e.1) != Some(c.samples) {
            stsc_entries.push((i as u32 + 1, c.samples));
        }
    }
    let mut stsc = (stsc_entries.len() as u32).to_be_bytes().to_vec();
    for (first, n) in &stsc_entries {
        stsc.extend_from_slice(&first.to_be_bytes());
        stsc.extend_from_slice(&n.to_be_bytes());
        stsc.extend_from_slice(&1u32.to_be_bytes());
    }
    // stsz
    let uniform = s.sizes.first().filter(|f| s.sizes.iter().all(|x| x == *f)).copied();
    let mut stsz = uniform.unwrap_or(0).to_be_bytes().to_vec();
    stsz.extend_from_slice(&(s.sizes.len() as u32).to_be_bytes());
    if uniform.is_none() {
        for z in &s.sizes {
            stsz.extend_from_slice(&z.to_be_bytes());
        }
    }
    // stco
    let mut stco = (offsets.len() as u32).to_be_bytes().to_vec();
    for o in offsets {
        stco.extend_from_slice(&o.to_be_bytes());
    }
    let mut body = stsd.to_vec();
    body.extend(full_box(b"stts", &stts));
    body.extend(full_box(b"stsc", &stsc));
    body.extend(full_box(b"stsz", &stsz));
    body.extend(full_box(b"stco", &stco));
    make_box(b"stbl", &body)
}

/// `init` = EXT-X-MAP bytes, `frags` = media segments in playlist order.
pub(super) fn defragment(init: &[u8], frags: &[Vec<u8>]) -> Option<Vec<u8>> {
    let top = boxes(init, 0, init.len());
    let moov = find(&top, b"moov")?;
    let moov_kids = children(init, moov);
    let mvhd = find(&moov_kids, b"mvhd")?;
    let traks: Vec<&BoxRef> = moov_kids.iter().filter(|b| &b.kind == b"trak").collect();
    if traks.len() != 1 {
        return None;
    }
    let trak = traks[0];
    let trak_kids = children(init, trak);
    let tkhd = find(&trak_kids, b"tkhd")?;
    let mdia = find(&trak_kids, b"mdia")?;
    let mdia_kids = children(init, mdia);
    let mdhd = find(&mdia_kids, b"mdhd")?;
    let minf = find(&mdia_kids, b"minf")?;
    let minf_kids = children(init, minf);
    let stbl = find(&minf_kids, b"stbl")?;
    let stsd = find(&children(init, stbl), b"stsd")?.bytes(init).to_vec();

    let mut trex = Defaults::default();
    if let Some(mvex) = find(&moov_kids, b"mvex") {
        if let Some(t) = find(&children(init, mvex), b"trex") {
            trex.duration = be32(init, t.body + 12)?;
            trex.size = be32(init, t.body + 16)?;
        }
    }

    let data: Vec<u8> = frags.concat();
    let mut samples = Samples::default();
    for b in boxes(&data, 0, data.len()) {
        if &b.kind != b"moof" {
            continue;
        }
        for traf in children(&data, &b).iter().filter(|t| &t.kind == b"traf") {
            read_traf(&data, &b, traf, trex, &mut samples)?;
        }
    }
    if samples.sizes.is_empty() {
        return None;
    }

    let media_ts = timescale(init, mdhd)? as u64;
    let movie_ts = timescale(init, mvhd)? as u64;
    if media_ts == 0 {
        return None;
    }
    let media_dur: u64 = samples.durations.iter().map(|&d| d as u64).sum();
    let movie_dur = media_dur * movie_ts / media_ts;
    let mvhd_new = with_duration(init, mvhd, movie_dur)?;
    let tkhd_new = with_duration(init, tkhd, movie_dur)?;
    let mdhd_new = with_duration(init, mdhd, media_dur)?;
    let hdlr = find(&mdia_kids, b"hdlr").map(|b| b.bytes(init).to_vec()).unwrap_or_default();
    let minf_rest: Vec<u8> = minf_kids.iter().filter(|b| &b.kind != b"stbl").flat_map(|b| b.bytes(init).to_vec()).collect();
    let udta = find(&moov_kids, b"udta").map(|b| b.bytes(init).to_vec()).unwrap_or_default();

    let build_moov = |offsets: &[u32]| -> Vec<u8> {
        let mut minf_body = minf_rest.clone();
        minf_body.extend(build_stbl(&stsd, &samples, offsets));
        let mut mdia_body = mdhd_new.clone();
        mdia_body.extend_from_slice(&hdlr);
        mdia_body.extend(make_box(b"minf", &minf_body));
        let mut trak_body = tkhd_new.clone();
        trak_body.extend(make_box(b"mdia", &mdia_body));
        let mut moov_body = mvhd_new.clone();
        moov_body.extend(make_box(b"trak", &trak_body));
        moov_body.extend_from_slice(&udta);
        make_box(b"moov", &moov_body)
    };

    let mut ftyp_body = b"M4A ".to_vec();
    ftyp_body.extend_from_slice(&0u32.to_be_bytes());
    ftyp_body.extend_from_slice(b"M4A isomiso2mp41");
    let ftyp = make_box(b"ftyp", &ftyp_body);

    let payload: usize = samples.chunks.iter().map(|c| c.len).sum();
    let zeros = vec![0u32; samples.chunks.len()];
    let moov_len = build_moov(&zeros).len();
    let mdat_body_at = ftyp.len() + moov_len + 8;
    if (mdat_body_at + payload) as u64 > u32::MAX as u64 {
        return None;
    }
    let mut offsets = Vec::with_capacity(samples.chunks.len());
    let mut at = mdat_body_at;
    for c in &samples.chunks {
        offsets.push(at as u32);
        at += c.len;
    }
    let moov_bytes = build_moov(&offsets);
    debug_assert_eq!(moov_bytes.len(), moov_len);

    let mut out = Vec::with_capacity(mdat_body_at + payload);
    out.extend(ftyp);
    out.extend(moov_bytes);
    out.extend_from_slice(&((payload + 8) as u32).to_be_bytes());
    out.extend_from_slice(b"mdat");
    for c in &samples.chunks {
        out.extend_from_slice(&data[c.start..c.start + c.len]);
    }
    Some(out)
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;

    fn full(kind: &[u8; 4], version: u8, flags: u32, body: &[u8]) -> Vec<u8> {
        let mut b = ((version as u32) << 24 | flags).to_be_bytes().to_vec();
        b.extend_from_slice(body);
        make_box(kind, &b)
    }

    /// Minimal init segment: 1 audio trak, media timescale 44100, movie 1000.
    pub fn init_segment() -> Vec<u8> {
        let mut mvhd = vec![0u8; 8];
        mvhd.extend_from_slice(&1000u32.to_be_bytes());
        mvhd.extend_from_slice(&0u32.to_be_bytes());
        mvhd.extend(vec![0u8; 80]);
        let mut tkhd = vec![0u8; 8];
        tkhd.extend_from_slice(&1u32.to_be_bytes());
        tkhd.extend_from_slice(&[0u8; 4]);
        tkhd.extend_from_slice(&0u32.to_be_bytes());
        tkhd.extend(vec![0u8; 60]);
        let mut mdhd = vec![0u8; 8];
        mdhd.extend_from_slice(&44100u32.to_be_bytes());
        mdhd.extend_from_slice(&0u32.to_be_bytes());
        mdhd.extend_from_slice(&[0u8; 4]);
        let stsd = full(b"stsd", 0, 0, &0u32.to_be_bytes());
        let empty = |k: &[u8; 4]| full(k, 0, 0, &[0u8; 4]);
        let mut stbl = stsd.clone();
        stbl.extend(empty(b"stts"));
        stbl.extend(empty(b"stsc"));
        stbl.extend(full(b"stsz", 0, 0, &[0u8; 8]));
        stbl.extend(empty(b"stco"));
        let mut minf = full(b"smhd", 0, 0, &[0u8; 4]);
        minf.extend(make_box(b"stbl", &stbl));
        let mut mdia = full(b"mdhd", 0, 0, &mdhd);
        mdia.extend(full(b"hdlr", 0, 0, b"\0\0\0\0soun\0\0\0\0\0\0\0\0\0\0\0\0\0"));
        mdia.extend(make_box(b"minf", &minf));
        let mut trak = full(b"tkhd", 0, 3, &tkhd);
        trak.extend(make_box(b"mdia", &mdia));
        let mut trex = 1u32.to_be_bytes().to_vec();
        trex.extend_from_slice(&1u32.to_be_bytes());
        trex.extend_from_slice(&1024u32.to_be_bytes()); // default duration
        trex.extend_from_slice(&0u32.to_be_bytes());
        trex.extend_from_slice(&0u32.to_be_bytes());
        let mut moov = full(b"mvhd", 0, 0, &mvhd);
        moov.extend(make_box(b"trak", &trak));
        moov.extend(make_box(b"mvex", &full(b"trex", 0, 0, &trex)));
        let mut out = make_box(b"ftyp", b"iso6\0\0\0\0iso6cmfc");
        out.extend(make_box(b"moov", &moov));
        out
    }

    /// One fragment with `sizes.len()` samples filled with `fill`.
    pub fn fragment(seq: u32, sizes: &[u32], fill: u8) -> Vec<u8> {
        let mfhd = full(b"mfhd", 0, 0, &seq.to_be_bytes());
        let tfhd = full(b"tfhd", 0, 0x020000, &1u32.to_be_bytes());
        let tfdt = full(b"tfdt", 0, 0, &0u32.to_be_bytes());
        let trun_len = 8 + 4 + 4 + 4 + sizes.len() * 4;
        let traf_len = 8 + tfhd.len() + tfdt.len() + trun_len;
        let moof_len = 8 + mfhd.len() + traf_len;
        let mut trun = (sizes.len() as u32).to_be_bytes().to_vec();
        trun.extend_from_slice(&((moof_len + 8) as i32).to_be_bytes());
        for s in sizes {
            trun.extend_from_slice(&s.to_be_bytes());
        }
        let trun = full(b"trun", 0, 0x000201, &trun);
        let mut traf = tfhd;
        traf.extend(tfdt);
        traf.extend(trun);
        let mut moof = mfhd;
        moof.extend(make_box(b"traf", &traf));
        let mut out = make_box(b"moof", &moof);
        assert_eq!(out.len(), moof_len);
        let payload: Vec<u8> = vec![fill; sizes.iter().sum::<u32>() as usize];
        out.extend(make_box(b"mdat", &payload));
        out
    }

    #[test]
    fn defragments_into_single_mdat_with_sample_table() {
        let init = init_segment();
        let frags = vec![fragment(1, &[10, 12, 10], 0xAA), fragment(2, &[7, 7], 0xBB)];
        let out = defragment(&init, &frags).expect("defragment");
        let top = boxes(&out, 0, out.len());
        let kinds: Vec<&[u8]> = top.iter().map(|b| &b.kind[..]).collect();
        assert_eq!(kinds, vec![&b"ftyp"[..], b"moov", b"mdat"]);
        let mdat = top[2];
        assert_eq!(mdat.end - mdat.body, 46);
        assert!(out[mdat.body..mdat.body + 32].iter().all(|&b| b == 0xAA));
        assert!(out[mdat.body + 32..mdat.end].iter().all(|&b| b == 0xBB));

        let moov = top[1];
        let mk = children(&out, &moov);
        assert!(find(&mk, b"mvex").is_none());
        let mvhd = find(&mk, b"mvhd").unwrap();
        // 5 samples * 1024 at 44100 -> 116 ms at timescale 1000
        assert_eq!(be32(&out, mvhd.body + 16).unwrap(), 5 * 1024 * 1000 / 44100);
        let trak = find(&mk, b"trak").unwrap();
        let mdia = find(&children(&out, trak), b"mdia").unwrap().to_owned();
        let mdia_k = children(&out, &mdia);
        let mdhd = find(&mdia_k, b"mdhd").unwrap();
        assert_eq!(be32(&out, mdhd.body + 16).unwrap(), 5 * 1024);
        let minf = find(&mdia_k, b"minf").unwrap();
        let stbl = find(&children(&out, minf), b"stbl").unwrap().to_owned();
        let sk = children(&out, &stbl);
        let stco = find(&sk, b"stco").unwrap();
        assert_eq!(be32(&out, stco.body + 4).unwrap(), 2);
        assert_eq!(be32(&out, stco.body + 8).unwrap() as usize, mdat.body);
        assert_eq!(be32(&out, stco.body + 12).unwrap() as usize, mdat.body + 32);
        let stsz = find(&sk, b"stsz").unwrap();
        assert_eq!(be32(&out, stsz.body + 4).unwrap(), 0);
        assert_eq!(be32(&out, stsz.body + 8).unwrap(), 5);
        assert_eq!(be32(&out, stsz.body + 16).unwrap(), 12);
        let stsc = find(&sk, b"stsc").unwrap();
        assert_eq!(be32(&out, stsc.body + 4).unwrap(), 2);
    }

    #[test]
    fn rejects_garbage() {
        assert!(defragment(b"nope", &[vec![1, 2, 3]]).is_none());
        assert!(defragment(&init_segment(), &[b"not a fragment".to_vec()]).is_none());
    }
}
