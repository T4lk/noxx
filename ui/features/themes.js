'use strict';
// Themes: riff's Appearance + Theme settings (mode, palette style, accent, hue,
// intensity, brightness, mesh gradient, highlight buttons, font scale/family,
// corner radius, interface/text opacity). Everything resolves to CSS variables
// on <html>. The palette is applied synchronously as soon as this file runs and
// does not need window.riff for that, so the file can also be loaded from <head>.
(() => {
  const KEY = 'riff_theme';
  const AUTO_KEY = 'riff_theme_auto';      // last cover analysis, so "Auto (album)" paints right on launch
  const COVER_KEY = 'riff_theme_covers';   // small persistent cover-analysis cache
  const BASE_FS = 1.1875;                  // core --fs at 100% (riff: 0.95 * 1.25)
  const FALLBACK_ACCENT = '#6750A4';

  const DEFAULTS = {
    look: 'glasshouse',        // 'glasshouse' (riff's Glasshouse theme) | 'riff' (riff's generated colours)
    mode: 'dark',              // 'light' | 'dark' | 'auto'
    style: 'classic',
    accent: FALLBACK_ACCENT,
    intensity: 0,              // 0 = riff's grey theme
    brightness: 50,
    mesh: false,
    meshBrightness: 100,
    meshFollow: true,
    meshCover: false,
    meshCfg: { p1: { x: 20, y: 0 }, p2: { x: 85, y: 5 }, speed: 0, blur: 0 },
    highlight: true,
    fontScale: 100,
    font: 'google',
    radius: 16,
    uiAlpha: 100,
    textAlpha: 100,
    // riff's banner + cover background settings
    banners: true,
    trackBanners: true,
    bannerBlur: 3,
    bannerOpacity: 100,
    bannerFade: 38,
    coverBg: true,
    grain: false,              // Glasshouse film grain (off by default)
    coverBgBrightness: 30,   // riff: 45%; dimmer here so colourful covers stay a subtle tint
    bannerFit: 'zoom',         // riff: 'fit' | 'zoom' | 'stretch'
    bannerMedia: '',           // asset URL of a picked image / video ('' = track art)
    bgMedia: '',               // riff's "Background media"
    bgOpacity: 100,
    bgBlur: 0,
    uiAlphaAuto: true,         // riff's "Lower interface opacity for backgrounds"
    uiAlphaPrev: null,         // what Interface opacity was before a background lowered it
    uiAlphaSet: null,          // the value it was lowered to
    clipFx: true,              // riff's "Clip effects to panels"
  };
  const FITS = { fit: 'Fit', zoom: 'Zoom', stretch: 'Stretch' };
  const MEDIA_RE = /^(https?:\/\/asset\.localhost\/|asset:\/\/localhost\/|data:(image|video)\/)/i;
  const mediaUrl = (v) => (typeof v === 'string' && v.length < 4_000_000 && MEDIA_RE.test(v) ? v : '');
  const isVideo = (u) => /\.(mp4|webm)($|\?)|^data:video\//i.test(u || '');

  const SWATCHES = [
    ['#B69DF8', 'Purple'], ['#7AA7FF', 'Blue'], ['#56C5C5', 'Teal'], ['#6DD58C', 'Green'],
    ['#F5B83D', 'Amber'], ['#F28B82', 'Red'], ['#F48FB1', 'Pink'],
  ];

  const STYLES = {
    classic: { label: 'Classic', sec: 0, tert: 0, pri: 1.0, surf: 1.0, cont: 1.0 },
    'tonal-spot': { label: 'Tonal spot', sec: 0, tert: 60, pri: 1.0, surf: 0.8, cont: 0.9 },
    expressive: { label: 'Expressive', sec: 60, tert: 120, pri: 1.25, surf: 1.5, cont: 1.3 },
    vibrant: { label: 'Vibrant', sec: 0, tert: 60, pri: 1.4, surf: 1.2, cont: 1.4 },
    neutral: { label: 'Neutral', sec: 0, tert: 0, pri: 0.35, surf: 0.2, cont: 0.25 },
  };

  const FONTS = {
    google: { label: 'Google Sans', stack: '"Google Sans", "Google Sans Text", "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif' },
    sf: { label: 'SF Pro', stack: '-apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Helvetica Neue", sans-serif' },
    system: { label: 'System', stack: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif' },
  };

  // ------------------------------------------------------------ storage

  const lsGet = (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
  const clamp = (v, lo, hi, d) => { const n = Number(v); return v !== null && v !== '' && Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
  const isHex = (s) => typeof s === 'string' && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(s);
  const bool = (v, d) => (typeof v === 'boolean' ? v : d);
  const optPct = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Math.round(clamp(v, 20, 100, 100)));

  function sanitize(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const D = DEFAULTS;
    const mc = r.meshCfg && typeof r.meshCfg === 'object' ? r.meshCfg : {};
    const pt = (p, d) => ({ x: clamp(p && p.x, 0, 100, d.x), y: clamp(p && p.y, 0, 100, d.y) });
    return {
      look: ['glasshouse', 'riff'].includes(r.look) ? r.look : D.look,
      mode: ['light', 'dark', 'auto'].includes(r.mode) ? r.mode : D.mode,
      style: Object.prototype.hasOwnProperty.call(STYLES, r.style) ? r.style : D.style,
      accent: isHex(r.accent) ? r.accent : D.accent,
      intensity: Math.round(clamp(r.intensity, 0, 100, D.intensity)),
      brightness: Math.round(clamp(r.brightness, 0, 100, D.brightness)),
      mesh: bool(r.mesh, D.mesh),
      meshBrightness: Math.round(clamp(r.meshBrightness, 0, 100, D.meshBrightness)),
      meshFollow: bool(r.meshFollow, D.meshFollow),
      meshCover: bool(r.meshCover, D.meshCover),
      meshCfg: {
        p1: pt(mc.p1, D.meshCfg.p1), p2: pt(mc.p2, D.meshCfg.p2),
        speed: clamp(mc.speed, 0, 100, 0), blur: clamp(mc.blur, 0, 60, 0),
      },
      highlight: bool(r.highlight, D.highlight),
      fontScale: clamp(r.fontScale, 80, 130, D.fontScale),
      font: Object.prototype.hasOwnProperty.call(FONTS, r.font) ? r.font : D.font,
      radius: clamp(r.radius, 0, 32, D.radius),
      uiAlpha: Math.round(clamp(r.uiAlpha, 20, 100, D.uiAlpha)),
      textAlpha: Math.round(clamp(r.textAlpha, 1, 100, D.textAlpha)),
      banners: bool(r.banners, D.banners),
      trackBanners: bool(r.trackBanners, D.trackBanners),
      bannerBlur: Math.round(clamp(r.bannerBlur, 0, 12, D.bannerBlur)),
      bannerOpacity: Math.round(clamp(r.bannerOpacity, 20, 100, D.bannerOpacity)),
      bannerFade: Math.round(clamp(r.bannerFade, 20, 100, D.bannerFade)),
      coverBg: bool(r.coverBg, D.coverBg),
      grain: bool(r.grain, D.grain),
      coverBgBrightness: Math.round(clamp(r.coverBgBrightness, 5, 100, D.coverBgBrightness)),
      bannerFit: Object.prototype.hasOwnProperty.call(FITS, r.bannerFit) ? r.bannerFit : D.bannerFit,
      bannerMedia: mediaUrl(r.bannerMedia),
      bgMedia: mediaUrl(r.bgMedia),
      bgOpacity: Math.round(clamp(r.bgOpacity, 5, 100, D.bgOpacity)),
      bgBlur: Math.round(clamp(r.bgBlur, 0, 40, D.bgBlur)),
      uiAlphaAuto: bool(r.uiAlphaAuto, D.uiAlphaAuto),
      uiAlphaPrev: optPct(r.uiAlphaPrev),
      uiAlphaSet: optPct(r.uiAlphaSet),
      clipFx: bool(r.clipFx, D.clipFx),
    };
  }

  let cfg = sanitize(lsGet(KEY));
  let autoInfo = lsGet(AUTO_KEY);   // { accent, accent2, luminance, saturation } | null
  let lastEffectiveMode = 'dark';
  let saveTimer = 0;
  function save() { clearTimeout(saveTimer); saveTimer = setTimeout(() => lsSet(KEY, cfg), 150); }

  // Glasshouse: riff's custom theme by Talk. Fixed black / white tokens, no accent.
  const GLASS = {
    mono: true, mode: 'dark',
    bg: '#070707', surface: '#0B0B0B', container: '#151515', containerHigh: '#1C1C1C', containerHighest: '#242424',
    surfaceBright: '#2E2E2E', primary: '#FFFFFF', onPrimary: '#0A0A0A', primaryContainer: '#2A2A2A', onPrimaryContainer: '#FFFFFF',
    secondary: '#D4D4D4', secondaryContainer: '#262626', onSecondaryContainer: '#EDEDED', tertiary: '#BDBDBD',
    onSurface: '#F2F2F2', onVariant: '#A8A8A8', outline: '#6E6E6E', outlineVariant: '#2B2B2B', error: '#FFB4AB',
    btn: { bg: '#FFFFFF', fg: '#0A0A0A', hover: '#E6E6E6' },
  };
  const GLASS_FONT = '"Space Grotesk", "Google Sans", system-ui, sans-serif';
  const GLASS_ART = 'grayscale(1) brightness(.45) contrast(1.1)';

  // ------------------------------------------------------------ colour math

  function hexToRgb(hex) {
    let h = String(hex || '').replace('#', '');
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    const n = parseInt(h, 16) || 0;
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  const toHex = (r, g, b) => '#' + [r, g, b].map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0')).join('');
  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0;
    const l = (max + min) / 2;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
      else if (max === g) h = ((b - r) / d + 2) / 6;
      else h = ((r - g) / d + 4) / 6;
    }
    return { h: Math.round(h * 360) % 360, s: Math.round(s * 100), l: Math.round(l * 100) };
  }
  function hslToHex(h, s, l) {
    s /= 100; l /= 100;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => { const k = (n + h / 30) % 12; return l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1); };
    return toHex(f(0) * 255, f(8) * 255, f(4) * 255);
  }
  const hexToHsl = (hex) => { const c = hexToRgb(hex); return rgbToHsl(c.r, c.g, c.b); };
  const normHex = (hex) => { const c = hexToRgb(hex); return toHex(c.r, c.g, c.b); };
  function mixHex(a, b, t) {
    const x = hexToRgb(a), y = hexToRgb(b);
    return toHex(x.r + (y.r - x.r) * t, x.g + (y.g - x.g) * t, x.b + (y.b - x.b) * t);
  }
  function relLum(hex) {
    const c = hexToRgb(hex);
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  }
  const contrast = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

  // ------------------------------------------------------------ palette (pure)

  // Same recipe as riff's generateM3Palette, mapped onto the core's tokens:
  // bg = background, surface = container-low, container, container-high,
  // container-highest. The grey dark defaults reproduce the core's stock look.
  function palette(accent, mode, intensity, brightness, styleKey) {
    const st = Object.prototype.hasOwnProperty.call(STYLES, styleKey) ? STYLES[styleKey] : STYLES.classic;
    const { h } = hexToHsl(isHex(accent) ? accent : FALLBACK_ACCENT);
    const hSec = (h + st.sec) % 360, hTert = (h + st.tert) % 360;
    const k = clamp(intensity, 0, 100, 0) / 100;
    const br = clamp(brightness, 0, 100, 50) / 100;
    const mono = k < 0.08;
    const sat = (base, scale) => Math.min(100, Math.round(base * k * scale));
    const sf = k * st.surf;
    const p = { mono, mode };

    if (mode === 'light') {
      const L = (v) => Math.max(0, Math.min(100, Math.round(v + (br - 0.5) * 24)));
      const surf = (s, l) => hslToHex(mono ? 0 : h, mono ? 0 : Math.round(s * sf), L(l));
      Object.assign(p, {
        bg: surf(5, 99), surface: surf(5, 96), container: surf(6, 94),
        containerHigh: surf(5, 92), containerHighest: surf(5, 88), surfaceBright: surf(5, 99),
      });
      if (mono) {
        Object.assign(p, {
          primary: '#111111', onPrimary: '#FFFFFF', primaryContainer: hslToHex(0, 0, L(90)), onPrimaryContainer: '#111111',
          secondary: '#444444', secondaryContainer: hslToHex(0, 0, L(86)), onSecondaryContainer: '#111111', tertiary: '#444444',
          onSurface: '#111111', onVariant: '#444444', outline: '#777777', outlineVariant: '#CFCFCF',
        });
      } else {
        Object.assign(p, {
          primary: hslToHex(h, sat(48, st.pri), 40), onPrimary: '#FEFBFF',
          primaryContainer: hslToHex(h, sat(80, st.cont), L(90)), onPrimaryContainer: hslToHex(h, sat(55, st.pri), 18),
          secondary: hslToHex(hSec, sat(30, st.cont), 45), secondaryContainer: hslToHex(hSec, sat(30, st.cont), L(86)),
          onSecondaryContainer: hslToHex(hSec, sat(20, st.cont), 15), tertiary: hslToHex(hTert, sat(30, st.cont), 45),
          onSurface: '#1C1B1F', onVariant: '#49454F', outline: '#79747E', outlineVariant: '#CAC4D0',
        });
      }
      p.error = '#B3261E';
    } else {
      const B = (v) => Math.max(0, Math.min(100, Math.round(v * br * 2)));
      const surf = (s, l) => hslToHex(mono ? 0 : h, mono ? 0 : Math.round(s * sf), B(l));
      Object.assign(p, {
        bg: surf(5, 7), surface: surf(5, 10), container: surf(6, 13),
        containerHigh: surf(5, 17), containerHighest: surf(5, 24), surfaceBright: surf(5, 22),
      });
      if (mono) {
        Object.assign(p, {
          primary: '#FFFFFF', onPrimary: '#121212', primaryContainer: hslToHex(0, 0, B(24)), onPrimaryContainer: '#FFFFFF',
          secondary: '#D0D0D0', secondaryContainer: hslToHex(0, 0, B(24)), onSecondaryContainer: '#FFFFFF', tertiary: '#D0D0D0',
          onSurface: '#FFFFFF', onVariant: '#CFCFCF', outline: '#8F8F8F', outlineVariant: '#3A3A3A',
        });
      } else {
        const pri = hslToHex(h, sat(60, st.pri), 75);
        Object.assign(p, {
          primary: pri, onPrimary: hslToHex(h, sat(50, st.pri), 20),
          primaryContainer: hslToHex(h, sat(60, st.cont), B(24)), onPrimaryContainer: pri,
          secondary: hslToHex(hSec, sat(30, st.cont), 75), secondaryContainer: hslToHex(hSec, sat(15, st.cont), 22),
          onSecondaryContainer: hslToHex(hSec, sat(30, st.cont), 85), tertiary: hslToHex(hTert, sat(30, st.cont), 75),
          onSurface: '#E2E2E9', onVariant: '#C4C6D0', outline: '#8E9099', outlineVariant: '#282A33',
        });
      }
      p.error = '#F2B8B5';
    }
    p.btn = buttonColors(p.primary, mode, mono);
    return p;
  }

  // riff's computeButtonColors: an accent fill with a readable label.
  function buttonColors(primary, mode, mono) {
    if (mono) return mode === 'light' ? { bg: '#111111', fg: '#FFFFFF', hover: '#333333' } : { bg: '#FFFFFF', fg: '#121212', hover: '#E6E6E6' };
    const hsl = hexToHsl(primary);
    const dark = mode !== 'light';
    let l = dark ? Math.min(74, Math.max(52, hsl.l)) : Math.min(46, Math.max(32, hsl.l));
    const lumAt = (L) => relLum(hslToHex(hsl.h, hsl.s, L));
    while (lumAt(l) > 0.42 && l > 26) l -= 1;
    const mid = lumAt(l);
    if (mid > 0.18 && mid < 0.23) while (lumAt(l) > 0.18 && l > 22) l -= 1;
    const bg = hslToHex(hsl.h, hsl.s, l);
    const bl = relLum(bg);
    const darkText = '#1B1B1F';
    const fg = contrast(bl, 1) >= contrast(bl, relLum(darkText)) ? '#FFFFFF' : darkText;
    return { bg, fg, hover: hslToHex(hsl.h, hsl.s, Math.max(0, Math.min(100, l + (dark ? 5 : -5)))) };
  }

  // What "Auto (album)" derives from a cover analysis (riff's updateThemeFromState).
  function deriveAuto(a) {
    const mode = a.luminance > 0.58 ? 'light' : 'dark';
    const intensity = Math.min(85, Math.max(20, Math.round(a.saturation * 100 * 0.9)));
    const brightness = mode === 'dark'
      ? Math.min(60, Math.max(40, Math.round(40 + (Math.min(0.58, a.luminance) / 0.58) * 20)))
      : Math.min(75, Math.max(55, Math.round(55 + Math.max(0, Math.min(1, (a.luminance - 0.58) / 0.42)) * 20)));
    return { mode, intensity, brightness };
  }

  function effective() {
    if (cfg.mode === 'auto') {
      if (autoInfo && isHex(autoInfo.accent) && Number.isFinite(autoInfo.luminance)) {
        return { accent: autoInfo.accent, accent2: isHex(autoInfo.accent2) ? autoInfo.accent2 : null, ...deriveAuto(autoInfo), auto: true };
      }
      return { accent: cfg.accent, accent2: null, mode: 'dark', intensity: cfg.intensity, brightness: cfg.brightness, auto: true };
    }
    return { accent: cfg.accent, accent2: null, mode: cfg.mode, intensity: cfg.intensity, brightness: cfg.brightness, auto: false };
  }

  // ------------------------------------------------------------ cover analysis

  const coverMem = new Map();
  let coverDisk = lsGet(COVER_KEY);
  if (!coverDisk || typeof coverDisk !== 'object' || Array.isArray(coverDisk)) coverDisk = {};

  // SoundCloud artwork: analyse the 100x100 "large" variant instead of t500x500.
  const thumbOf = (url) => String(url || '').replace(/-t\d+x\d+(\.\w+)(\?.*)?$/, '-large$1');

  // Pure pixel analysis (riff's analyzeCover): saturation-weighted 24-bin hue
  // histogram -> accent, a second accent >= 60deg away, mean luminance/saturation.
  function analyzePixels(data) {
    const bins = Array.from({ length: 24 }, (_, i) => ({ i, hue: (i + 0.5) * 15, w: 0, r: 0, g: 0, b: 0, n: 0 }));
    let fr = 0, fg = 0, fb = 0, lumSum = 0, satSum = 0, satN = 0;
    const total = data.length / 4;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      fr += r; fg += g; fb += b;
      const rn = r / 255, gn = g / 255, bn = b / 255;
      lumSum += 0.2126 * rn + 0.7152 * gn + 0.0722 * bn;
      const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn), d = max - min, l = (max + min) / 2;
      const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
      if (s < 0.15) continue;
      satSum += s; satN++;
      if (l < 0.1 || l > 0.9) continue;
      let hd;
      if (max === rn) hd = ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60;
      else if (max === gn) hd = ((bn - rn) / d + 2) * 60;
      else hd = ((rn - gn) / d + 4) * 60;
      const bin = bins[Math.min(23, Math.max(0, Math.floor(hd / 15)))];
      bin.w += s; bin.r += r; bin.g += g; bin.b += b; bin.n++;
    }
    let best = null;
    for (const b of bins) if (b.n && (!best || b.w > best.w)) best = b;
    const avg = (b) => toHex(b.r / b.n, b.g / b.n, b.b / b.n);
    const accent = best ? avg(best) : toHex(fr / total, fg / total, fb / total);
    let second = null;
    if (best) {
      for (const b of bins) {
        if (!b.n || b.i === best.i) continue;
        const diff = Math.abs(b.hue - best.hue);
        if (Math.min(diff, 360 - diff) >= 60 && (!second || b.w > second.w)) second = b;
      }
    }
    let accent2;
    if (second) accent2 = avg(second);
    else { const a = hexToHsl(accent); accent2 = hslToHex((a.h + 40) % 360, a.s, a.l); }
    return { accent, accent2, luminance: total ? lumSum / total : 0.2, saturation: satN ? satSum / satN : 0 };
  }

  function analyzeCover(url) {
    if (!url) return Promise.resolve(null);
    const src = thumbOf(url);
    if (coverMem.has(src)) return coverMem.get(src);
    const disk = coverDisk[src];
    if (disk && isHex(disk.accent)) { const v = Promise.resolve(disk); coverMem.set(src, v); return v; }
    const job = new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.decoding = 'async';
      img.onload = () => {
        try {
          const c = document.createElement('canvas');
          c.width = c.height = 48;
          const ctx = c.getContext('2d', { willReadFrequently: true });
          ctx.drawImage(img, 0, 0, 48, 48);
          const res = analyzePixels(ctx.getImageData(0, 0, 48, 48).data);
          if (!src.startsWith('data:')) {
            coverDisk[src] = res;
            const keys = Object.keys(coverDisk);
            if (keys.length > 300) for (const k of keys.slice(0, keys.length - 300)) delete coverDisk[k];
            lsSet(COVER_KEY, coverDisk);
          }
          resolve(res);
        } catch (e) { resolve(null); }   // tainted canvas / decode failure -> keep the accent
      };
      img.onerror = () => resolve(null);
      img.src = src;
    });
    coverMem.set(src, job);
    if (coverMem.size > 120) coverMem.delete(coverMem.keys().next().value);
    return job;
  }

  let meshCoverColors = null;
  let coverSeq = 0;
  const currentTrack = () => (window.riff && window.riff.player ? window.riff.player.current : null);
  async function onTrack(t) {
    if (cfg.mode !== 'auto' && !(cfg.mesh && cfg.meshCover)) { meshCoverColors = null; return; }
    const seq = ++coverSeq;
    const a = t && t.artwork ? await analyzeCover(t.artwork) : null;
    if (seq !== coverSeq) return;
    meshCoverColors = a ? [a.accent, a.accent2] : null;
    if (cfg.mode === 'auto' && a) { autoInfo = a; lsSet(AUTO_KEY, a); }
    schedule();
  }

  // ------------------------------------------------------------ apply

  const root = document.documentElement;
  const applied = new Map();
  function setVar(name, v) {
    if (applied.get(name) === v) return;
    applied.set(name, v);
    root.style.setProperty(name, v);
  }
  const alphaMix = (hex, a) => (a >= 100 ? hex : `color-mix(in srgb, ${hex} ${a}%, transparent)`);

  let current = null;   // last { eff, pal }
  function apply() {
    const glass = cfg.look === 'glasshouse';
    const eff = glass ? { ...effective(), mode: 'dark', auto: false } : effective();
    const pal = glass ? GLASS : palette(eff.accent, eff.mode, eff.intensity, eff.brightness, cfg.style);
    current = { eff, pal };
    lastEffectiveMode = eff.mode;
    const ui = cfg.uiAlpha, tx = cfg.textAlpha;

    setVar('--bg', pal.bg);
    setVar('--surface', alphaMix(pal.surface, ui));
    setVar('--container', alphaMix(pal.container, ui));
    setVar('--container-high', alphaMix(pal.containerHigh, ui));
    setVar('--container-highest', alphaMix(pal.containerHighest, ui));
    setVar('--on-surface', alphaMix(pal.onSurface, tx));
    setVar('--on-variant', alphaMix(pal.onVariant, tx));
    setVar('--outline', pal.outline);
    setVar('--primary', pal.primary);
    setVar('--on-primary', pal.onPrimary);
    setVar('--error', pal.error);
    // solid copies + extra tokens (menus/modals stay opaque; other features may use them)
    setVar('--th-surface-solid', pal.surface);
    setVar('--th-container-solid', pal.container);
    setVar('--th-container-high-solid', pal.containerHigh);
    setVar('--th-container-highest-solid', pal.containerHighest);
    setVar('--th-primary-container', pal.primaryContainer);
    setVar('--th-on-primary-container', pal.onPrimaryContainer);
    setVar('--th-secondary', pal.secondary);
    setVar('--th-secondary-container', pal.secondaryContainer);
    setVar('--th-on-secondary-container', pal.onSecondaryContainer);
    setVar('--th-tertiary', pal.tertiary);
    setVar('--th-outline-variant', pal.outlineVariant);
    // core tokens used by the switch and the nav pill (riff: surface-bright, outline-variant, primary-container)
    setVar('--surface-bright', pal.surfaceBright);
    setVar('--outline-variant', pal.outlineVariant);
    setVar('--nav-active', pal.primaryContainer);
    setVar('--on-nav-active', pal.onPrimaryContainer);
    setVar('--banner-blur', `${cfg.bannerBlur}px`);
    setVar('--banner-opacity', String(cfg.bannerOpacity / 100));
    setVar('--banner-fade-base', `${cfg.bannerFade}%`);
    setVar('--cover-bg-brightness', String(cfg.coverBgBrightness / 100));
    // riff's applyBannerFit
    setVar('--banner-fit', cfg.bannerFit === 'fit' ? 'contain' : cfg.bannerFit === 'stretch' ? '100% 100%' : 'cover');
    setVar('--banner-object-fit', cfg.bannerFit === 'fit' ? 'contain' : cfg.bannerFit === 'stretch' ? 'fill' : 'cover');
    setVar('--banner-scale', cfg.bannerFit === 'zoom' ? 'scale(1.06)' : 'none');
    setVar('--th-bm-filter', cfg.bannerBlur > 0 ? `blur(${cfg.bannerBlur}px)` : 'none');
    setVar('--th-bm-filter-track', `${cfg.bannerBlur > 0 ? `blur(${cfg.bannerBlur}px) ` : ''}${glass ? GLASS_ART : ''}`.trim() || 'none');
    setVar('--th-btn-bg', pal.btn.bg);
    setVar('--th-btn-fg', pal.btn.fg);
    setVar('--th-btn-hover', pal.btn.hover);
    setVar('--th-glow', pal.mono ? (eff.mode === 'light' ? '#00000008' : '#ffffff0b') : `color-mix(in srgb, ${pal.primary} 9%, transparent)`);

    // The same values under riff's token names, so riff custom themes (and their compat layer) see them.
    const md = (k, v) => setVar(`--md-sys-color-${k}`, v);
    md('background', pal.bg); md('surface', alphaMix(pal.bg, ui)); md('surface-container-low', alphaMix(pal.surface, ui));
    md('surface-container', alphaMix(pal.container, ui)); md('surface-container-high', alphaMix(pal.containerHigh, ui));
    md('surface-container-highest', alphaMix(pal.containerHighest, ui)); md('surface-bright', pal.surfaceBright);
    md('on-surface', alphaMix(pal.onSurface, tx)); md('on-surface-variant', alphaMix(pal.onVariant, tx));
    md('outline', pal.outline); md('outline-variant', pal.outlineVariant); md('primary', pal.primary); md('on-primary', pal.onPrimary);
    md('primary-container', pal.primaryContainer); md('on-primary-container', pal.onPrimaryContainer);
    md('secondary', pal.secondary); md('secondary-container', pal.secondaryContainer); md('on-secondary-container', pal.onSecondaryContainer);
    md('tertiary', pal.tertiary); md('error', pal.error);
    setVar('--btn-primary-bg', pal.btn.bg); setVar('--btn-primary-fg', pal.btn.fg); setVar('--btn-primary-hover', pal.btn.hover);
    setVar('--art-filter', glass ? GLASS_ART : 'none');

    setVar('--fs', String(+(cfg.fontScale / 100 * BASE_FS).toFixed(4)));
    setVar('--th-font', glass ? GLASS_FONT : FONTS[cfg.font].stack);
    setVar('--font-family', glass ? GLASS_FONT : FONTS[cfg.font].stack);
    setVar('--r-l', `${cfg.radius}px`);
    setVar('--r-m', `${Math.max(0, cfg.radius - 4)}px`);
    setVar('--r-xl', `${cfg.radius + 12}px`);
    setVar('color-scheme', eff.mode === 'light' ? 'light' : 'dark');

    const mc = cfg.meshCfg;
    setVar('--mesh-p1x', `${mc.p1.x}%`); setVar('--mesh-p1y', `${mc.p1.y}%`);
    setVar('--mesh-p2x', `${mc.p2.x}%`); setVar('--mesh-p2y', `${mc.p2.y}%`);
    setVar('--mesh-speed', mc.speed > 0 ? `${(120 / (mc.speed * 0.2 + 1)).toFixed(1)}s` : '0s');
    setVar('--mesh-blur', `${mc.blur}px`);

    const cl = root.classList;
    cl.toggle('th-light', eff.mode === 'light');
    cl.toggle('th-dark', eff.mode !== 'light');
    cl.toggle('th-mono', pal.mono);
    cl.toggle('th-highlight', cfg.highlight);
    cl.toggle('th-banners-off', !cfg.banners);
    cl.toggle('th-track-banners-off', !cfg.trackBanners);
    cl.toggle('th-cover-bg-off', !cfg.coverBg);
    cl.toggle('th-glass', glass);
    cl.toggle('th-no-clip-fx', !cfg.clipFx);
    cl.toggle('th-custom-bg-on', !!cfg.bgMedia);
    if (glass) ensureGlassFonts();
    else if (cfg.font === 'sf') ensureSf();
    updateGlassLayers(glass, glass && cfg.grain);

    updateMesh();
    updateCustomBg();
    syncBannerMedia();
    syncUI();
    if (window.riff && typeof window.riff.emit === 'function') window.riff.emit('theme', { mode: eff.mode, primary: pal.primary });
  }

  let raf = 0;
  function schedule() {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; apply(); });
  }

  function ensureGlassFonts() {
    if (document.getElementById('th-font-glass')) return;
    const link = document.createElement('link');
    link.id = 'th-font-glass';
    link.rel = 'stylesheet';
    link.href = 'https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap';
    (document.head || root).appendChild(link);
  }

  // Glasshouse's aurora and film grain. The grain is a 160px noise tile made once on a canvas.
  let aurora = null, grain = null;
  function updateGlassLayers(on, withGrain) {
    if (!document.body) return;
    if (!on) { if (aurora) { aurora.remove(); aurora = null; } }
    else if (!aurora) {
      aurora = document.createElement('div');
      aurora.className = 'th-aurora';
      const anchor = document.getElementById('cover-bg') || document.querySelector('.organic-bg');
      if (anchor) anchor.after(aurora); else document.body.prepend(aurora);
    }
    if (!withGrain) { if (grain) { grain.remove(); grain = null; } return; }
    if (grain) return;
    grain = document.createElement('div');
    grain.className = 'th-grain';
    if (!root.style.getPropertyValue('--th-grain-img')) {
      const c = document.createElement('canvas');
      c.width = c.height = 160;
      const g = c.getContext('2d');
      const img = g.createImageData(160, 160);
      for (let i = 0; i < img.data.length; i += 4) {
        const v = Math.random() < 0.5 ? 0 : 255;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
        img.data[i + 3] = Math.round(Math.random() * 255);
      }
      g.putImageData(img, 0, 0);
      root.style.setProperty('--th-grain-img', `url(${c.toDataURL('image/png')})`);
    }
    document.body.append(grain);
  }

  function ensureSf() {
    if (document.getElementById('th-font-sf')) return;
    const link = document.createElement('link');
    link.id = 'th-font-sf';
    link.rel = 'stylesheet';
    link.href = 'https://fonts.cdnfonts.com/css/sf-pro-display';
    (document.head || root).appendChild(link);
  }

  // ------------------------------------------------------------ mesh gradient

  let meshLayers = null, meshFront = 0, meshKey = '';
  function meshGradient(c1, c2, mode, scale) {
    const a = hexToRgb(c1), b = hexToRgb(c2);
    const a1 = ((mode === 'light' ? 0.22 : 0.55) * scale).toFixed(3), a2 = ((mode === 'light' ? 0.18 : 0.45) * scale).toFixed(3);
    return `linear-gradient(to bottom, transparent 35%, var(--bg) 85%), `
      + `radial-gradient(ellipse at var(--mesh-p1x, 20%) var(--mesh-p1y, 0%), rgba(${a.r}, ${a.g}, ${a.b}, ${a1}) 0%, transparent 70%), `
      + `radial-gradient(ellipse at var(--mesh-p2x, 85%) var(--mesh-p2y, 5%), rgba(${b.r}, ${b.g}, ${b.b}, ${a2}) 0%, transparent 65%), var(--bg)`;
  }
  function meshColors() {
    if (!current) return ['#9E9E9E', '#757575', 'dark'];
    const { eff, pal } = current;
    let c1, c2;
    if (cfg.meshCover && meshCoverColors) [c1, c2] = meshCoverColors;
    else if (pal.mono) { c1 = '#9E9E9E'; c2 = '#757575'; }
    else {
      c1 = eff.accent;
      if (eff.accent2) c2 = eff.accent2;
      else { const h = hexToHsl(eff.accent); c2 = hslToHex((h.h + 40) % 360, h.s, h.l); }
    }
    if (cfg.meshFollow) {
      const k = clamp(eff.intensity, 0, 100, 100) / 100;
      c1 = mixHex(c1, '#9E9E9E', 1 - k); c2 = mixHex(c2, '#9E9E9E', 1 - k);
    }
    return [c1, c2, eff.mode];
  }
  function updateMesh() {
    if (!document.body) return;
    const on = cfg.mesh && cfg.meshBrightness > 0;
    root.classList.toggle('th-mesh-on', on);
    const pv = document.querySelector('.th-mesh-preview-bg');
    if (pv) { const [c1, c2, mode] = meshColors(); pv.style.background = meshGradient(c1, c2, mode, Math.max(0.35, cfg.meshBrightness / 100)); }
    if (!meshLayers) {
      if (!on) return;
      meshLayers = [0, 1].map(() => { const d = document.createElement('div'); d.className = 'th-mesh'; return d; });
      const anchor = document.querySelector('.organic-bg');
      if (anchor) anchor.after(...meshLayers); else document.body.prepend(...meshLayers);
    }
    if (!on) { meshLayers.forEach((l) => { l.style.opacity = '0'; }); meshKey = ''; return; }
    const [c1, c2, mode] = meshColors();
    const key = `${c1}|${c2}|${mode}|${cfg.meshBrightness}`;
    if (key === meshKey) return;
    meshKey = key;
    const next = meshLayers[1 - meshFront], prev = meshLayers[meshFront];
    next.style.background = meshGradient(c1, c2, mode, cfg.meshBrightness / 100);
    next.style.opacity = '1';
    prev.style.opacity = '0';
    meshFront = 1 - meshFront;
  }

  // ------------------------------------------------------------ banner media / fit (riff's Banner media + Banner fit)

  // The core paints track-art banners into canvases that always "cover". When a custom banner
  // file is picked, or the fit is not riff's default Zoom, a plain <img>/<video> layer with
  // object-fit takes the canvas's place in every .art-banner host (right panel + playlist heroes).
  function bannerSource(host) {
    if (cfg.bannerMedia) return cfg.bannerMedia;
    if (host.id === 'rp-banner') {
      const t = currentTrack();
      const a = t && t.artwork;
      return a ? (window.riff && window.riff.art ? window.riff.art(a, 500) : a) : '';
    }
    return (host.heroImg && host.heroImg.src) || '';
  }
  function mediaEl(url) {
    const v = isVideo(url);
    const m = document.createElement(v ? 'video' : 'img');
    if (v) {
      Object.assign(m, { muted: true, loop: true, autoplay: true, playsInline: true, preload: 'auto', disablePictureInPicture: true });
      m.setAttribute('disableRemotePlayback', '');
    } else { m.decoding = 'async'; m.alt = ''; }
    m.src = url;
    m.dataset.src = url;
    return m;
  }
  function syncBannerMedia() {
    if (!document.body) return;
    const want = cfg.banners && (!!cfg.bannerMedia || cfg.bannerFit !== 'zoom');
    document.querySelectorAll('.art-banner').forEach((host) => {
      let layer = host.querySelector(':scope > .th-bm');
      const url = want ? bannerSource(host) : '';
      if (!url) {
        if (layer) layer.remove();
        host.classList.remove('th-has-bm');
        return;
      }
      if (!layer || layer.dataset.src !== url) {
        const next = mediaEl(url);
        next.classList.add('th-bm');
        if (layer) layer.replaceWith(next); else host.append(next);
        layer = next;
      }
      layer.classList.toggle('th-bm-track', !cfg.bannerMedia);
      layer.classList.toggle('th-bm-hero', host.id !== 'rp-banner');
      host.classList.add('th-has-bm');
    });
    syncVideos();
  }

  // ------------------------------------------------------------ background media (riff's #custom-bg)

  let customBg = null;
  function updateCustomBg() {
    if (!document.body) return;
    const url = cfg.bgMedia;
    if (!url) {
      if (customBg) { customBg.remove(); customBg = null; }
      return;
    }
    if (!customBg) {
      customBg = document.createElement('div');
      customBg.id = 'custom-bg';
      customBg.className = 'th-custom-bg';
      const anchor = document.getElementById('cover-bg');
      if (anchor) anchor.after(customBg); else document.body.prepend(customBg);
    }
    customBg.style.opacity = String(cfg.bgOpacity / 100);
    let media = customBg.firstElementChild;
    if (!media || media.dataset.src !== url) {
      customBg.textContent = '';
      media = mediaEl(url);
      if (media.tagName === 'VIDEO') {
        media.addEventListener('loadedmetadata', () => {
          if (media.videoWidth * media.videoHeight > 1920 * 1080 * 1.2 && window.riff) window.riff.toast('This background video is larger than 1080p and may stutter. A 1080p file plays smoother.');
        }, { once: true });
      }
      customBg.append(media);
    }
    // riff: blur a quarter-size copy and scale it up (16x fewer pixels to blur)
    const q = cfg.bgBlur > 0 ? 4 : 1;
    media.style.width = `${100 / q}%`;
    media.style.height = `${100 / q}%`;
    media.style.transform = q > 1 ? `scale(${q * 1.06}) translate(-3%, -3%)` : 'none';
    media.style.filter = cfg.bgBlur > 0 ? `blur(${cfg.bgBlur / q}px)` : 'none';
    syncVideos();
  }

  // Background / banner videos pause while the window is hidden or minimised.
  function syncVideos() {
    const asleep = document.hidden || !!(window.riff && window.riff.asleep);
    document.querySelectorAll('video.th-bm, .th-custom-bg video').forEach((v) => {
      if (asleep) v.pause(); else if (v.paused) v.play().catch(() => {});
    });
  }
  document.addEventListener('visibilitychange', syncVideos);

  // riff's onBackgroundChanged: adding a background drops Interface opacity to 50% (once),
  // removing the last one puts it back if it was not changed in the meantime.
  function onBackgroundChanged(enabled) {
    if (!cfg.uiAlphaAuto) return;
    if (enabled) {
      if (cfg.uiAlpha > 50) { cfg.uiAlphaPrev = cfg.uiAlpha; cfg.uiAlpha = 50; cfg.uiAlphaSet = 50; }
    } else if (!cfg.bgMedia && !cfg.coverBg) {
      if (cfg.uiAlphaSet != null && cfg.uiAlphaPrev != null && cfg.uiAlpha === cfg.uiAlphaSet) cfg.uiAlpha = cfg.uiAlphaPrev;
      cfg.uiAlphaSet = null; cfg.uiAlphaPrev = null;
    }
  }

  async function pickMedia(kind) {
    const riff = window.riff;
    const T = window.__TAURI__;
    if (!T || !T.dialog) { riff.toast('The file picker is not available', 'error'); return; }
    const path = await T.dialog.open({
      multiple: false, title: kind === 'banner' ? 'Choose banner media' : 'Choose background media',
      filters: [{ name: 'Images and videos', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'mp4', 'webm'] }],
    });
    if (!path) return;
    try {
      const r = await riff.call('themes.importMedia', { path: Array.isArray(path) ? path[0] : path, kind });
      setMedia(kind, `${T.core.convertFileSrc(r.path)}?v=${Date.now()}`);
    } catch (e) { riff.toast(riff.errText(e), 'error'); }
  }
  function setMedia(kind, url) {
    if (kind === 'banner') cfg.bannerMedia = url;
    else {
      cfg.bgMedia = url;
      onBackgroundChanged(!!url);
    }
    save(); apply();
  }
  function clearMedia(kind) {
    setMedia(kind, '');
    if (window.riff) window.riff.call('themes.clearMedia', { kind }).catch(() => {});
  }

  // ------------------------------------------------------------ CSS editor (riff's Advanced > CSS editor)

  const CSS_KEY = 'riff_custom_css', CSS_BACKUP = 'riff_custom_css_backup';
  const CSS_PLACEHOLDER = '/* Your CSS goes here. Example:\n.btn.primary { border-radius: 8px; }\n*/\n';
  const lsStr = (k) => { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } };
  const lsPut = (k, v) => { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch (e) {} };
  const userCss = () => lsStr(CSS_KEY);
  function applyUserCss() {
    let st = document.querySelector('style[data-riff-custom="user"]');
    const css = userCss();
    if (!css.trim()) { if (st) st.remove(); }
    else {
      if (!st) { st = document.createElement('style'); st.dataset.riffCustom = 'user'; }
      if (st.textContent !== css) st.textContent = css;
      document.head.appendChild(st);   // after the custom themes, like riff
    }
    root.classList.toggle('th-custom', customThemes.some((t) => t.enabled) || !!css.trim());
  }
  function setUserCss(css) { lsPut(CSS_KEY, css); applyUserCss(); schedule(); }
  function backupUserCss() { const cur = userCss(); if (cur.trim()) lsPut(CSS_BACKUP, cur); }

  let cssEditor = null;
  function openCssEditor() {
    if (cssEditor) { cssEditor.classList.remove('hidden'); cssEditor.querySelector('textarea').value = userCss() || CSS_PLACEHOLDER; cssEditor.querySelector('textarea').focus(); return; }
    cssEditor = document.createElement('div');
    cssEditor.className = 'th-css-editor';
    cssEditor.innerHTML = `<div class="th-css-bar">
        <span class="th-css-title">CSS editor</span>
        <span class="th-css-hint">Changes apply live. Ctrl+Shift+R resets all custom CSS.</span>
        <div class="th-css-actions">
          <button class="btn outline" data-a="restore">Restore last</button>
          <button class="btn outline" data-a="clear">Clear</button>
          <button class="btn primary" data-a="close">Done</button>
        </div></div>
      <textarea class="th-css-text" spellcheck="false" autocomplete="off" autocapitalize="off" aria-label="Custom CSS"></textarea>`;
    const ta = cssEditor.querySelector('textarea');
    ta.value = userCss() || CSS_PLACEHOLDER;
    let timer = 0;
    const commit = () => { clearTimeout(timer); timer = setTimeout(() => setUserCss(ta.value === CSS_PLACEHOLDER ? '' : ta.value), 350); };
    ta.addEventListener('input', commit);
    ta.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.shiftKey && e.code === 'KeyR') return;   // let the reset shortcut through
      e.stopPropagation();   // keep player shortcuts (space, arrows) out of the editor
      if (e.key === 'Tab' && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        ta.setRangeText('  ', ta.selectionStart, ta.selectionEnd, 'end');
        commit();
      } else if (e.key === 'Escape') cssEditor.classList.add('hidden');
    });
    cssEditor.addEventListener('click', (e) => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (a === 'close') cssEditor.classList.add('hidden');
      else if (a === 'clear') { backupUserCss(); ta.value = ''; setUserCss(''); }
      else if (a === 'restore') {
        const b = lsStr(CSS_BACKUP);
        if (!b) { window.riff.toast('Nothing to restore'); return; }
        ta.value = b; setUserCss(b);
      }
    });
    document.body.append(cssEditor);
    ta.focus();
  }

  // ------------------------------------------------------------ settings UI

  const CHEVRON = '<svg class="th-dd-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>';
  const PLUS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';

  const item = (inner, attrs = '') => `<div class="th-item setting-item"${attrs}>${inner}</div>`;
  const top = (name, value = '', side = '') => `<div class="th-top"><span class="th-name">${name}</span><span class="th-side">${side}${value}</span></div>`;
  const val = (k) => `<span class="th-val" data-th-val="${k}"></span>`;
  const hints = (a, b, c) => `<div class="th-hints"><span>${a}</span><span>${b}</span><span>${c}</span></div>`;
  const slider = (k, min, max, step) => `<div class="th-sl"><div class="th-sl-on"></div><div class="th-sl-off"></div><input type="range" data-th-k="${k}" min="${min}" max="${max}" step="${step}"></div>`;
  const seg = (k, opts) => `<div class="th-seg" data-th-seg="${k}">${opts.map(([v, l]) => `<button type="button" class="th-seg-btn" data-v="${v}">${l}</button>`).join('')}</div>`;
  const toggleRow = (k, name, desc, attrs = '') => item(`<div class="th-top"><div class="th-col"><span class="th-name">${name}</span><span class="th-desc">${desc}</span></div>${window.riff.switchHtml(cfg[k], `data-th-sw="${k}" aria-label="${name}"`)}</div>`, attrs);
  const resetBtn = (k) => `<button type="button" class="th-mini" data-th-reset="${k}">Reset</button>`;

  const FMT = {
    fontScale: (v) => `${v}%`,
    radius: (v) => (v === 16 ? 'Default' : `${v}px`),
    uiAlpha: (v) => `${v}%`,
    textAlpha: (v) => `${v}%`,
    hue: (v) => `${v}°`,
    intensity: (v) => `${v}%`,
    brightness: (v) => `${v}%`,
    meshBrightness: (v) => `${v}%`,
    speed: (v) => (v ? String(v) : '0 (static)'),
    blur: (v) => `${v}px`,
    bannerBlur: (v) => `${v}px`,
    bannerOpacity: (v) => `${v}%`,
    bannerFade: (v) => `${v}%`,
    coverBgBrightness: (v) => `${v}%`,
    bgOpacity: (v) => `${v}%`,
    bgBlur: (v) => `${v}px`,
  };
  // th-dd dropdowns: data-th-dd="<cfg key>"
  const DD = { style: Object.fromEntries(Object.entries(STYLES).map(([k, s]) => [k, s.label])), bannerFit: FITS };
  const dropdown = (k) => `<div class="th-dd" data-th-dd="${k}"><button type="button" class="th-dd-trigger"><span data-th-dd-label></span>${CHEVRON}</button>
        <div class="th-dd-menu">${Object.entries(DD[k]).map(([v, l]) => `<button type="button" class="th-dd-opt" data-v="${v}">${l}</button>`).join('')}</div></div>`;
  const descRow = (name, desc, side) => item(`<div class="th-top"><div class="th-col"><span class="th-name">${name}</span>${desc ? `<span class="th-desc">${desc}</span>` : ''}</div><span class="th-side th-btns">${side}</span></div>`);
  const RESET = { fontScale: 100, radius: 16, uiAlpha: 100, textAlpha: 100 };

  let hosts = [];  // live settings groups + mesh modal (pruned when detached)

  function sliderValue(k) {
    const e = current.eff;
    switch (k) {
      case 'hue': return hexToHsl(e.accent).h;
      case 'intensity': return e.intensity;
      case 'brightness': return e.brightness;
      case 'speed': return cfg.meshCfg.speed;
      case 'blur': return cfg.meshCfg.blur;
      default: return cfg[k];
    }
  }
  function syncSlider(input) {
    const min = +input.min, max = +input.max;
    input.parentElement.style.setProperty('--v', max > min ? (+input.value - min) / (max - min) : 0);
  }

  function syncUI() {
    hosts = hosts.filter((h) => h.isConnected);
    if (!hosts.length || !current) return;
    const { eff, pal } = current;
    const accent = cfg.accent.toLowerCase();
    for (const host of hosts) {
      host.querySelectorAll('input[type=range][data-th-k]').forEach((inp) => {
        if (inp.dataset.dragging !== '1') inp.value = sliderValue(inp.dataset.thK);
        syncSlider(inp);
        const label = host.querySelector(`[data-th-val="${inp.dataset.thK}"]`);
        if (label) label.textContent = FMT[inp.dataset.thK](+inp.value);
      });
      host.querySelectorAll('[data-th-seg]').forEach((g) => {
        const v = cfg[g.dataset.thSeg];
        g.querySelectorAll('.th-seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.v === v));
      });
      host.querySelectorAll('[data-th-sw]').forEach((b) => { const on = !!cfg[b.dataset.thSw]; b.classList.toggle('active', on); b.setAttribute('aria-checked', String(on)); });
      host.querySelectorAll('[data-th-needs]').forEach((n) => n.classList.toggle('is-disabled', !cfg[n.dataset.thNeeds]));
      host.querySelectorAll('[data-th-needs-glass]').forEach((n) => n.classList.toggle('is-disabled', cfg.look !== 'glasshouse'));
      let named = null;
      host.querySelectorAll('.th-swatch').forEach((b) => {
        const on = !eff.auto && b.dataset.color.toLowerCase() === accent;
        if (on) named = b.title;
        b.classList.toggle('active', on);
      });
      const lbl = host.querySelector('[data-th-accent]');
      if (lbl) lbl.textContent = eff.auto ? 'Album' : (named || 'Custom');
      const ci = host.querySelector('input[type=color]');
      if (ci && document.activeElement !== ci) ci.value = normHex(eff.accent);
      host.querySelectorAll('.th-dd[data-th-dd]').forEach((dd) => {
        const k = dd.dataset.thDd;
        const lab = dd.querySelector('[data-th-dd-label]');
        if (lab) lab.textContent = DD[k][cfg[k]];
        dd.querySelectorAll('.th-dd-opt').forEach((o) => o.classList.toggle('selected', o.dataset.v === cfg[k]));
      });
      host.querySelectorAll('[data-th-media-reset]').forEach((b) => { b.disabled = !cfg[b.dataset.thMediaReset === 'banner' ? 'bannerMedia' : 'bgMedia']; });
      const glassOn = cfg.look === 'glasshouse';
      host.querySelectorAll('[data-th-auto-lock], [data-th-glass-lock]').forEach((n) => n.classList.toggle('is-disabled', (n.hasAttribute('data-th-auto-lock') && eff.auto) || (n.hasAttribute('data-th-glass-lock') && glassOn)));
      const dots = host.querySelector('.th-dots');
      if (dots) {
        const html = [[pal.primary, 'Primary'], [pal.primaryContainer, 'Primary container'], [pal.secondary, 'Secondary'], [pal.tertiary, 'Tertiary'], [pal.surface, 'Surface']]
          .map(([c, t]) => `<span class="th-dot" title="${t}" style="background:${c}"></span>`).join('');
        if (dots.innerHTML !== html) dots.innerHTML = html;
      }
      host.querySelectorAll('.th-mesh-dot').forEach((d) => {
        const p = cfg.meshCfg[d.dataset.p];
        d.style.left = `${p.x}%`; d.style.top = `${p.y}%`;
      });
    }
  }

  // Picking a colour while in "Auto (album)" switches to the mode auto last showed (as riff does).
  function leaveAuto() { if (cfg.mode === 'auto') cfg.mode = lastEffectiveMode === 'light' ? 'light' : 'dark'; }

  function setSlider(k, v, commit) {
    switch (k) {
      case 'hue': leaveAuto(); cfg.accent = hslToHex(v, 55, 50); break;
      case 'intensity': case 'brightness': if (cfg.mode === 'auto') return; cfg[k] = v; break;
      case 'speed': case 'blur': cfg.meshCfg = { ...cfg.meshCfg, [k]: v }; break;
      default: cfg[k] = v;
    }
    schedule();
    if (commit) save();
  }

  function wire(host) {
    hosts.push(host);
    host.addEventListener('input', (e) => {
      const t = e.target;
      if (t.matches('input[type=range][data-th-k]')) {
        t.dataset.dragging = '1';
        syncSlider(t);
        const label = host.querySelector(`[data-th-val="${t.dataset.thK}"]`);
        if (label) label.textContent = FMT[t.dataset.thK](+t.value);
        setSlider(t.dataset.thK, +t.value, false);
      } else if (t.matches('input[type=color]')) {
        leaveAuto(); cfg.accent = t.value; schedule(); save();
      }
    });
    host.addEventListener('change', (e) => {
      const t = e.target;
      if (t.matches('input[type=range][data-th-k]')) { t.dataset.dragging = ''; setSlider(t.dataset.thK, +t.value, true); }
    });
    host.addEventListener('click', (e) => {
      const t = e.target;
      const segBtn = t.closest('.th-seg-btn');
      if (segBtn) {
        const k = segBtn.parentElement.dataset.thSeg;
        cfg[k] = segBtn.dataset.v;
        if (k === 'mode' && cfg.mode === 'auto') onTrack(currentTrack());
        schedule(); save(); return;
      }
      const swatch = t.closest('.th-swatch');
      if (swatch) { leaveAuto(); cfg.accent = swatch.dataset.color; schedule(); save(); return; }
      const swb = t.closest('[data-th-sw]');
      if (swb) {
        const k = swb.dataset.thSw;
        cfg[k] = !cfg[k];
        if (k === 'coverBg') onBackgroundChanged(cfg.coverBg);   // riff: the cover background counts as a background
        if (cfg.mesh && cfg.meshCover) onTrack(currentTrack());
        schedule(); save(); return;
      }
      const rb = t.closest('[data-th-reset]');
      if (rb) {
        const k = rb.dataset.thReset;
        if (k === 'mesh') cfg.meshCfg = JSON.parse(JSON.stringify(DEFAULTS.meshCfg));
        else cfg[k] = RESET[k];
        schedule(); save(); return;
      }
      const ddT = t.closest('.th-dd-trigger');
      if (ddT) { ddT.parentElement.classList.toggle('open'); e.stopPropagation(); return; }
      const opt = t.closest('.th-dd-opt');
      if (opt) {
        const dd = opt.closest('.th-dd');
        cfg[dd.dataset.thDd || 'style'] = opt.dataset.v;
        dd.classList.remove('open'); schedule(); save(); return;
      }
      const pick = t.closest('[data-th-media]');
      if (pick) { pickMedia(pick.dataset.thMedia); return; }
      const mr = t.closest('[data-th-media-reset]');
      if (mr) { clearMedia(mr.dataset.thMediaReset); return; }
      if (t.closest('[data-th-css]')) { openCssEditor(); return; }
      if (t.closest('[data-th-mesh]')) openMeshModal();
    });
  }

  // riff's settings tabs. Tab titles come from the settings page; without tabs (an older core
  // whose addSettings takes no category) each block gets its own section title.
  const tabbed = () => !!(window.riff.settingsRow || window.riff.openSettings);
  const title = (t) => { if (!tabbed()) window.riff.add(`<div class="section-title">${t}</div>`); };

  // Interface tab: riff's order (UI scale and the search bar options belong to the core).
  function buildInterface() {
    const riff = window.riff;
    title('Appearance');
    wire(riff.add(`<div class="th-group">
      ${item(top('Font scale', val('fontScale')) + slider('fontScale', 80, 130, 5) + hints('Small', 'Default', 'Large'))}
      ${item(top('Interface font') + seg('font', Object.entries(FONTS).map(([k, f]) => [k, f.label])) + '<div class="th-desc">SF Pro is loaded from fonts.cdnfonts.com when selected</div>')}
      ${item(top('Corner radius', val('radius')) + slider('radius', 0, 32, 4) + hints('Sharp', '16px', 'Round'))}
      ${item(top('Interface opacity', val('uiAlpha'), resetBtn('uiAlpha')) + slider('uiAlpha', 20, 100, 1) + hints('20%', 'Default', '100%'))}
      ${item(top('Text opacity', val('textAlpha'), resetBtn('textAlpha')) + slider('textAlpha', 1, 100, 1) + hints('1%', 'Default', '100%'))}
    </div>`));
    syncUI();
  }

  function buildTheme() {
    const riff = window.riff;
    title('Theme');
    wire(riff.add(`<div class="th-group">
      ${item(top('Look') + seg('look', [['glasshouse', 'Glasshouse'], ['riff', 'Colour']]) + '<div class="th-desc">Glasshouse: black frosted glass, white type, no colour. Colour: uses the accent and palette below.</div>')}
      ${item(top('Theme mode') + seg('mode', [['light', 'Light'], ['dark', 'Dark'], ['auto', 'Auto (album)']]), ' data-th-glass-lock')}
      ${item(top('Palette style') + dropdown('style') + '<div class="th-dots"></div>', ' data-th-glass-lock')}
      ${item(top('Accent color', '<span class="th-val" data-th-accent></span>') + `<div class="th-swatches">
        ${SWATCHES.map(([c, n]) => `<button type="button" class="th-swatch" data-color="${c}" title="${n}" style="background:${c}"></button>`).join('')}
        <label class="th-pick" title="Choose custom color"><input type="color">${PLUS}</label></div>`, ' data-th-glass-lock')}
      ${item(top('Hue', val('hue')) + `<div class="th-sl th-hue"><div class="th-hue-track">${Array.from({ length: 12 }, (_, i) => `<i style="background:linear-gradient(90deg,hsl(${i * 30} 75% 55%),hsl(${(i + 1) * 30} 75% 55%))"></i>`).join('')}</div><input type="range" data-th-k="hue" min="0" max="360" step="1"></div>`, ' data-th-glass-lock')}
      ${item(top('Intensity', val('intensity')) + slider('intensity', 0, 100, 1) + hints('Gray', 'Soft', 'Vivid'), ' data-th-auto-lock data-th-glass-lock')}
      ${item(top('Brightness', val('brightness')) + slider('brightness', 0, 100, 1) + hints('Dark', 'Default', 'Bright'), ' data-th-auto-lock data-th-glass-lock')}
      ${item(top('Mesh gradient brightness', val('meshBrightness'), '<button type="button" class="th-mini" data-th-mesh>Configure</button>') + slider('meshBrightness', 0, 100, 5) + hints('Off', 'Subtle', 'Full'))}
      ${toggleRow('highlight', 'Highlight buttons', 'Fill the main button of each screen with the accent color')}
    </div>`));
    syncUI();
  }

  // Banners tab: riff's single group, in riff's order.
  function buildBanners() {
    const riff = window.riff;
    title('Banners');
    wire(riff.add(`<div class="th-group">
      ${toggleRow('banners', 'Enable banners', 'Show artwork backdrop banners in Now playing and playlists')}
      ${toggleRow('trackBanners', 'Track banners', 'Show artwork backdrop banner for currently playing track', ' data-th-needs="banners"')}
      ${item(top('Banner media', '', '<span class="th-btns"><button type="button" class="btn primary" data-th-media="banner">Choose file</button><button type="button" class="btn outline" data-th-media-reset="banner">Reset to track art</button></span>'), ' data-th-needs="banners"')}
      ${item(top('Banner fit') + dropdown('bannerFit'), ' data-th-needs="banners"')}
      ${item(top('Banner blur', val('bannerBlur')) + slider('bannerBlur', 0, 12, 1) + hints('0px', '3px', '12px'), ' data-th-needs="banners"')}
      ${item(top('Banner opacity', val('bannerOpacity')) + slider('bannerOpacity', 20, 100, 5) + hints('20%', '60%', '100%'), ' data-th-needs="banners"')}
      ${item(top('Banner fade', val('bannerFade')) + slider('bannerFade', 20, 100, 2) + hints('Top', 'Default', 'Deep'), ' data-th-needs="banners"')}
      ${item(top('Background media', '', '<span class="th-btns"><button type="button" class="btn primary" data-th-media="bg">Choose file</button><button type="button" class="btn outline" data-th-media-reset="bg">Remove</button></span>'))}
      ${item(top('Opacity', val('bgOpacity')) + slider('bgOpacity', 5, 100, 5) + hints('5%', '50%', '100%'), ' data-th-needs="bgMedia"')}
      ${item(top('Blur', val('bgBlur')) + slider('bgBlur', 0, 40, 1) + hints('0px', '20px', '40px'), ' data-th-needs="bgMedia"')}
      ${toggleRow('coverBg', 'Cover background', 'Uses a blurred version of the current cover as the background')}
      ${item(top('Cover background brightness', val('coverBgBrightness')) + slider('coverBgBrightness', 5, 100, 5) + hints('5%', '50%', '100%'), ' data-th-needs="coverBg"')}
      ${toggleRow('grain', 'Film grain', 'Faint noise texture over the Glasshouse look', ' data-th-needs-glass')}
    </div>`));
    syncUI();
  }

  // Advanced tab: the theme-owned rows of riff's Advanced group (others add theirs to the same tab).
  function buildAdvanced() {
    const riff = window.riff;
    title('Effects');
    wire(riff.add(`<div class="th-group">
      ${toggleRow('mesh', 'Background mesh gradient', 'Show dynamic ambient color gradients behind interface panels')}
      ${toggleRow('meshFollow', 'Mesh follows theme intensity', 'Low intensity makes the gradient colors grayer')}
      ${toggleRow('meshCover', 'Mesh color from current cover', 'Off: uses the accent color of the theme')}
      ${toggleRow('uiAlphaAuto', 'Lower interface opacity for backgrounds', 'Sets interface opacity to 50% when you add a background. You can change it afterwards.')}
      ${toggleRow('clipFx', 'Clip effects to panels', 'Off: blur and gradients can spread outside their panel')}
      ${descRow('CSS editor', 'Write your own CSS. Ctrl+Shift+R resets it if something breaks.', '<button type="button" class="btn primary" data-th-css>Open editor</button>')}
    </div>`));
    syncUI();
  }

  function openMeshModal() {
    const riff = window.riff;
    const m = riff.openModal(`<div class="th-modal">
      <h3>Mesh gradient</h3>
      <div class="th-mesh-preview"><div class="th-mesh-preview-bg"></div>
        <div class="th-mesh-dot" data-p="p1" title="Point 1">1</div><div class="th-mesh-dot" data-p="p2" title="Point 2">2</div></div>
      <div class="th-group">
        ${item(top('Speed', val('speed')) + slider('speed', 0, 100, 1) + hints('0 (Static)', '50', '100'))}
        ${item(top('Blur', val('blur')) + slider('blur', 0, 60, 2) + hints('0px', '30px', '60px'))}
      </div>
      <div class="row-btns"><button class="btn outline" data-th-reset="mesh">Reset</button><button class="btn primary" data-th-close>Done</button></div>
    </div>`);
    wire(m);
    m.querySelector('[data-th-close]').onclick = () => riff.closeModal();
    const box = m.querySelector('.th-mesh-preview');
    box.querySelectorAll('.th-mesh-dot').forEach((dot) => {
      dot.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        dot.setPointerCapture(e.pointerId);
        const r = box.getBoundingClientRect();
        const move = (ev) => {
          const x = Math.round(Math.max(0, Math.min(100, ((ev.clientX - r.left) / r.width) * 100)));
          const y = Math.round(Math.max(0, Math.min(100, ((ev.clientY - r.top) / r.height) * 100)));
          cfg.meshCfg = { ...cfg.meshCfg, [dot.dataset.p]: { x, y } };
          schedule();
        };
        const up = () => { dot.removeEventListener('pointermove', move); save(); };
        dot.addEventListener('pointermove', move);
        dot.addEventListener('pointerup', up, { once: true });
        dot.addEventListener('pointercancel', up, { once: true });
      });
    });
    updateMesh();
    syncUI();
  }

  document.addEventListener('click', (e) => {
    if (!e.target.closest || !e.target.closest('.th-dd')) document.querySelectorAll('.th-dd.open').forEach((d) => d.classList.remove('open'));
  });

  // ------------------------------------------------------------ custom themes (riff's Settings > Custom themes)

  // Theme files live in <app data>/themes (features/themes.rs); enabled ones are injected as <style>.
  // riff themes use riff's token and class names; see the compat layer at the end of themes.css.
  let customThemes = [];
  let ctList = null;
  const TRASH = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>';

  function applyCustom() {
    document.querySelectorAll('style[data-riff-custom]').forEach((n) => n.remove());
    const on = customThemes.filter((t) => t.enabled);
    for (const t of on) {
      const st = document.createElement('style');
      st.dataset.riffCustom = t.id;
      st.textContent = t.css;
      document.head.appendChild(st);
    }
    applyUserCss();   // re-adds the CSS editor's style after the themes and sets th-custom
    schedule();
  }

  async function loadCustom() {
    try { customThemes = await window.riff.call('themes.list'); } catch (e) { customThemes = []; }
    applyCustom();
    renderCustom();
  }

  function renderCustom() {
    if (!ctList || !ctList.isConnected) return;
    const riff = window.riff;
    ctList.innerHTML = '';
    if (!customThemes.length) {
      ctList.innerHTML = item('<div class="th-ct-empty">No themes yet. Click Add and choose a .css file.</div>');
      return;
    }
    for (const t of customThemes) {
      const card = riff.el(item(`<div class="th-col"><span class="th-name"></span><span class="th-desc"></span></div>
        <button class="pill-btn" data-a="remove" title="Remove">${TRASH}</button>`, ' data-ct'));
      card.classList.add('th-ct-card');
      card.querySelector('.th-name').textContent = t.name;
      card.querySelector('.th-desc').textContent = [t.author && `by ${t.author}`, t.description].filter(Boolean).join(' · ');
      card.append(riff.switch(!!t.enabled, async (on) => {
        t.enabled = on;
        applyCustom();
        try { await riff.call('themes.setEnabled', { id: t.id, enabled: on }); } catch (e) { riff.toast(riff.errText(e), 'error'); }
      }, { label: t.name }));
      card.querySelector('[data-a=remove]').onclick = async () => {
        if (!(await riff.confirmBox('Remove theme?', `"${t.name}" will be deleted.`, 'Remove'))) return;
        await riff.call('themes.remove', { id: t.id }).catch(() => {});
        customThemes = customThemes.filter((x) => x !== t);
        applyCustom();
        renderCustom();
        riff.toast('Theme removed');
      };
      ctList.append(card);
    }
  }

  async function addThemes() {
    const riff = window.riff;
    const dialog = window.__TAURI__ && window.__TAURI__.dialog;
    if (!dialog) { riff.toast('The file picker is not available', 'error'); return; }
    let paths = await dialog.open({ multiple: true, title: 'Add a theme', filters: [{ name: 'CSS theme', extensions: ['css'] }] });
    if (!paths) return;
    if (!Array.isArray(paths)) paths = [paths];
    try {
      const added = await riff.call('themes.import', { paths });
      customThemes.push(...added);
      renderCustom();
      riff.toast(`Added ${added.length} theme${added.length === 1 ? '' : 's'}. Turn one on to try it`);
    } catch (e) { riff.toast(riff.errText(e), 'error'); }
  }

  async function importFromRiff() {
    const riff = window.riff;
    try {
      const r = await riff.call('themes.importRiff');
      customThemes.push(...r.added);
      renderCustom();
      riff.toast(r.added.length ? `Imported ${r.added.length} theme${r.added.length === 1 ? '' : 's'}. Turn one on to try it` : 'Those themes are already here');
    } catch (e) { riff.toast(riff.errText(e), 'error'); }
  }

  function buildCustomSettings() {
    const riff = window.riff;
    const head = riff.add(`<div class="th-ct-head"><div><div class="section-title">Custom themes</div>
      <div class="th-desc">Add a .css file to restyle the app. Themes that use Material colour variables (--md-sys-color-*) work too.<br>Ctrl+Shift+R turns every custom theme off if something breaks.</div></div>
      <div class="actions"><button class="btn outline" data-a="riff" hidden>Import existing themes</button><button class="btn primary" data-a="add">Add</button></div></div>`);
    head.querySelector('[data-a=add]').onclick = addThemes;
    const fromRiff = head.querySelector('[data-a=riff]');
    fromRiff.onclick = importFromRiff;
    riff.call('themes.riffAvailable').then((n) => { fromRiff.hidden = !n; fromRiff.title = `${n} theme${n === 1 ? '' : 's'} found on this PC`; }).catch(() => {});
    ctList = riff.add('<div class="th-group th-ct-list"></div>');
    renderCustom();
  }

  window.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey && e.shiftKey && !e.altKey && e.code === 'KeyR')) return;
    e.preventDefault();
    const on = customThemes.filter((t) => t.enabled);
    on.forEach((t) => { t.enabled = false; window.riff.call('themes.setEnabled', { id: t.id, enabled: false }).catch(() => {}); });
    // riff's resetCustomStyling also clears the CSS editor (kept as "Restore last")
    const hadCss = !!userCss().trim();
    backupUserCss();
    lsPut(CSS_KEY, '');
    if (cssEditor) cssEditor.querySelector('textarea').value = '';
    applyCustom();
    renderCustom();
    if (window.riff) window.riff.toast(on.length || hadCss ? 'Custom themes and CSS turned off (Ctrl+Shift+R)' : 'No custom theme is on');
  }, true);

  // ------------------------------------------------------------ selftest

  async function selftest(log) {
    const saved = JSON.parse(JSON.stringify(cfg));
    const savedCss = userCss();
    const savedAuto = autoInfo;
    const css = (n) => getComputedStyle(root).getPropertyValue(n).trim().toLowerCase();
    let fails = 0;
    const check = (name, ok, detail = '') => { if (!ok) fails++; log(`themes: ${name} ${ok ? 'OK' : 'FAILED'}${detail ? ` (${detail})` : ''}`); };
    const set = (patch) => { cfg = sanitize({ ...cfg, ...patch }); apply(); };
    const t0 = performance.now();
    let events = 0;
    window.riff.on('theme', () => { events++; });
    try {
      const rt = hexToHsl(hslToHex(210, 60, 50));
      check('hsl round trip', Math.abs(rt.h - 210) <= 1 && Math.abs(rt.s - 60) <= 1 && Math.abs(rt.l - 50) <= 1, JSON.stringify(rt));

      const g = palette(FALLBACK_ACCENT, 'dark', 0, 50, 'classic');
      check('grey dark palette = stock core look', g.bg === '#121212' && g.surface === '#1a1a1a' && g.container === '#212121' && g.containerHighest === '#3d3d3d' && g.primary === '#FFFFFF', `${g.bg} ${g.surface} ${g.container} ${g.containerHighest}`);

      check('sanitize rejects junk', (() => { const s = sanitize({ mode: 'x', accent: 'red', fontScale: 999, style: '__proto__', font: 'constructor' }); return s.mode === 'dark' && s.accent === FALLBACK_ACCENT && s.fontScale === 130 && s.style === 'classic' && s.font === 'google'; })());

      set({ look: 'glasshouse' });
      check('glasshouse look', css('--bg') === '#070707' && css('--primary') === '#ffffff' && root.classList.contains('th-glass') && !!document.querySelector('.th-aurora') && css('--art-filter').includes('grayscale'), `--bg ${css('--bg')}`);
      set({ look: 'riff', mode: 'light', accent: '#7AA7FF', intensity: 70, brightness: 50, style: 'vibrant' });
      check('glass layers removed', !document.querySelector('.th-aurora') && !document.querySelector('.th-grain') && !root.classList.contains('th-glass'));
      set({ look: 'glasshouse', grain: true });
      check('film grain option', !!document.querySelector('.th-grain'));
      set({ look: 'riff', grain: false });
      const bgc = css('--bg'), pr = css('--primary'), ph = hexToHsl(pr).h;
      check('light mode + blue accent', relLum(bgc) > 0.8 && ph >= 200 && ph <= 235 && root.classList.contains('th-light') && css('color-scheme') === 'light', `--bg ${bgc}, --primary ${pr}`);
      check('light text contrast', contrast(relLum(css('--on-surface')), relLum(bgc)) > 7);
      check('theme event emitted', events > 0, `${events} events`);

      set({ mode: 'dark', accent: '#F5B83D', intensity: 80 });
      const btn = current.pal.btn;
      check('dark accent + button contrast', relLum(css('--bg')) < 0.05 && contrast(relLum(btn.bg), relLum(btn.fg)) >= 4.5, `${css('--primary')} btn ${btn.bg}/${btn.fg}`);

      set({ fontScale: 120, radius: 24, uiAlpha: 60, textAlpha: 90 });
      const fs = parseFloat(css('--fs'));
      check('font scale', Math.abs(fs - 1.425) < 0.001, `--fs ${fs}`);
      check('corner radius', css('--r-l') === '24px' && css('--r-m') === '20px' && css('--r-xl') === '36px');
      set({ bannerBlur: 6, bannerFade: 50, coverBg: false, banners: false });
      check('banner settings', css('--banner-blur') === '6px' && css('--banner-fade-base') === '50%' && root.classList.contains('th-cover-bg-off') && root.classList.contains('th-banners-off'));
      set({ bannerBlur: 3, bannerFade: 38, coverBg: true, banners: true });
      check('interface/text opacity', css('--surface').includes('color-mix') && css('--on-surface').includes('color-mix') && css('--th-surface-solid').startsWith('#'));

      // banner fit + banner / background media (riff's Banners tab)
      set({ bannerFit: 'fit' });
      check('banner fit: fit', css('--banner-object-fit') === 'contain' && css('--banner-fit') === 'contain' && css('--banner-scale') === 'none');
      set({ bannerFit: 'stretch' });
      check('banner fit: stretch', css('--banner-object-fit') === 'fill' && css('--banner-fit') === '100% 100%');
      check('banner fit rejects junk', sanitize({ bannerFit: 'tile', bannerMedia: 'https://evil.example/x.png', bgMedia: 'javascript:alert(1)' }).bannerFit === 'zoom' && sanitize({ bannerMedia: 'https://evil.example/x.png' }).bannerMedia === '' && sanitize({ bgMedia: 'javascript:1' }).bgMedia === '');
      check('asset urls accepted', sanitize({ bannerMedia: 'http://asset.localhost/E%3A%5Cmedia%5Cbanner.mp4?v=1' }).bannerMedia.endsWith('banner.mp4?v=1') && isVideo('http://asset.localhost/x/banner.mp4?v=1') && !isVideo('http://asset.localhost/x/banner.png'));
      const pc4 = document.createElement('canvas');
      pc4.width = pc4.height = 4;
      const px = pc4.getContext('2d'); px.fillStyle = '#20c060'; px.fillRect(0, 0, 4, 4);
      const dataUrl = pc4.toDataURL('image/png');
      set({ bannerFit: 'zoom', banners: true, bannerMedia: dataUrl });
      const rpb = document.getElementById('rp-banner');
      const layer = rpb && rpb.querySelector(':scope > img.th-bm');
      check('banner media layer', !!layer && layer.src === dataUrl && rpb.classList.contains('th-has-bm') && !layer.classList.contains('th-bm-track'));
      set({ bannerMedia: '' });
      check('banner media reset to track art', !!rpb && !rpb.querySelector('.th-bm') && !rpb.classList.contains('th-has-bm'));
      set({ bgMedia: dataUrl, bgOpacity: 40, bgBlur: 8 });
      const cbg = document.getElementById('custom-bg');
      const cimg = cbg && cbg.querySelector('img');
      check('background media', !!cimg && cbg.style.opacity === '0.4' && cimg.style.filter === 'blur(2px)' && cimg.style.width === '25%' && root.classList.contains('th-custom-bg-on'), cimg ? cimg.style.filter : 'no layer');
      set({ bgMedia: '' });
      check('background media removed', !document.getElementById('custom-bg') && !root.classList.contains('th-custom-bg-on'));
      set({ uiAlpha: 100, coverBg: false, uiAlphaAuto: true, uiAlphaPrev: null, uiAlphaSet: null });
      setMedia('bg', dataUrl);
      const lowered = cfg.uiAlpha;
      setMedia('bg', '');
      check('lower interface opacity for backgrounds', lowered === 50 && cfg.uiAlpha === 100, `${lowered} -> ${cfg.uiAlpha}`);
      set({ uiAlphaAuto: false });
      setMedia('bg', dataUrl);
      check('lower opacity switch off', cfg.uiAlpha === 100);
      setMedia('bg', '');
      set({ clipFx: false });
      check('clip effects to panels', root.classList.contains('th-no-clip-fx'));
      set({ clipFx: true, coverBg: true, uiAlphaAuto: true });
      check('clip effects back on', !root.classList.contains('th-no-clip-fx'));

      // CSS editor: live apply through the textarea, then put the user's CSS back
      const cprobe = document.createElement('div');
      cprobe.className = 'th-selftest-css-probe';
      document.body.appendChild(cprobe);
      openCssEditor();
      const ta = cssEditor.querySelector('textarea');
      ta.value = '.th-selftest-css-probe { color: rgb(1, 2, 3); }';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 500));
      const cssOk = getComputedStyle(cprobe).color === 'rgb(1, 2, 3)' && !!document.querySelector('style[data-riff-custom="user"]') && userCss().includes('th-selftest');
      cssEditor.querySelector('[data-a=close]').click();
      check('CSS editor applies live', cssOk && cssEditor.classList.contains('hidden'), getComputedStyle(cprobe).color);
      lsPut(CSS_KEY, savedCss);
      applyUserCss();
      ta.value = savedCss || CSS_PLACEHOLDER;
      check('CSS editor restored', userCss() === savedCss && getComputedStyle(cprobe).color !== 'rgb(1, 2, 3)');
      cprobe.remove();

      // synthetic red/blue cover, no network
      const cv = document.createElement('canvas');
      cv.width = cv.height = 48;
      const cx = cv.getContext('2d');
      cx.fillStyle = '#d02020'; cx.fillRect(0, 0, 48, 36);
      cx.fillStyle = '#2040d0'; cx.fillRect(0, 36, 48, 12);
      const an = await analyzeCover(cv.toDataURL('image/png'));
      const ah = an ? hexToHsl(an.accent).h : -1, a2 = an ? hexToHsl(an.accent2).h : -1;
      check('cover analysis', !!an && (ah <= 10 || ah >= 350) && a2 > 200 && a2 < 250, an ? `${an.accent} ${an.accent2} lum ${an.luminance.toFixed(2)}` : 'null');

      if (an) {
        autoInfo = an;
        set({ mode: 'auto' });
        const ah2 = hexToHsl(css('--primary')).h;
        check('auto (album) mode follows cover', current.eff.auto && (ah2 <= 15 || ah2 >= 345), `--primary ${css('--primary')}`);
      }

      set({ mesh: true, meshBrightness: 80 });
      const layers = [...document.querySelectorAll('.th-mesh')];
      check('mesh gradient layers', layers.length === 2 && layers.some((l) => l.style.opacity === '1' && l.style.background.includes('radial-gradient')));

      let bad = 0;
      for (const st of Object.keys(STYLES)) for (const md of ['light', 'dark']) for (const k of [0, 50, 100]) for (const b of [0, 50, 100]) {
        const p = palette('#56C5C5', md, k, b, st);
        for (const key of ['bg', 'surface', 'container', 'containerHigh', 'containerHighest', 'primary', 'onPrimary', 'onSurface', 'onVariant', 'outline']) if (!isHex(p[key])) bad++;
      }
      check('all styles/modes give valid tokens', bad === 0, `${bad} bad`);

      const tp = performance.now();
      for (let i = 0; i < 200; i++) palette(hslToHex(i, 60, 50), i % 2 ? 'dark' : 'light', 60, 50, 'expressive');
      const per = (performance.now() - tp) / 200;
      check('palette speed', per < 1, `${per.toFixed(3)}ms per palette`);

      // riff theme compatibility: a riff-style override of --md-sys-color-primary reaches --primary.
      const st = document.createElement('style');
      st.dataset.riffCustom = 'selftest';
      st.textContent = ':root { --md-sys-color-primary: #ff4081 !important; --md-sys-color-surface-container: #102030 !important; }';
      document.head.appendChild(st);
      root.classList.add('th-custom');
      const probe = document.createElement('div');
      probe.style.cssText = 'color: var(--primary); background-color: var(--container)';
      document.body.appendChild(probe);
      const pc = getComputedStyle(probe);
      check('riff theme compat', pc.color === 'rgb(255, 64, 129)' && pc.backgroundColor === 'rgb(16, 32, 48)', `${pc.color} ${pc.backgroundColor}`);
      probe.remove(); st.remove();
      root.classList.toggle('th-custom', customThemes.some((t) => t.enabled));
      try {
        const list = await window.riff.call('themes.list');
        const n = await window.riff.call('themes.riffAvailable');
        check('custom themes store', Array.isArray(list), `${list.length} installed, ${n} in riff's folder`);
      } catch (e) { check('custom themes store', false, window.riff.errText(e)); }
    } catch (e) {
      check('selftest run', false, e && e.message ? e.message : String(e));
    } finally {
      autoInfo = savedAuto;
      if (userCss() !== savedCss) { lsPut(CSS_KEY, savedCss); applyUserCss(); }
      cfg = sanitize(saved);
      lsSet(KEY, cfg);
      apply();
    }
    log(`themes: selftest ${fails ? `FAILED (${fails} checks)` : 'OK'} in ${Math.round(performance.now() - t0)}ms`);
  }

  // ------------------------------------------------------------ boot

  // Paint as early as possible: this runs before the first frame.
  applyUserCss();
  apply();

  function register() {
    const riff = window.riff;
    if (!riff || register.done) return;
    register.done = true;
    riff.theme = {
      get: () => JSON.parse(JSON.stringify(cfg)),
      set: (patch) => { cfg = sanitize({ ...cfg, ...(patch || {}) }); save(); apply(); return riff.theme.get(); },
      palette, analyzePixels, current: () => current,
    };
    riff.addSettings(buildInterface, 'interface');
    riff.addSettings(buildTheme, 'theme');
    riff.addSettings(buildBanners, 'banners');
    riff.addSettings(buildAdvanced, 'advanced');
    riff.addSettings(buildCustomSettings, 'custom-themes');
    loadCustom();
    riff.addSelftest(selftest);
    riff.on('trackchange', onTrack);
    // banner media layers follow the track (right panel) and newly rendered playlist heroes
    let bmTimers = [];
    const bannerSoon = () => { bmTimers.forEach(clearTimeout); bmTimers = [0, 400, 1500].map((ms) => setTimeout(syncBannerMedia, ms)); };
    riff.on('trackchange', bannerSoon);
    riff.on('render', bannerSoon);
    riff.on('visibility', syncVideos);
    riff.on('ready', () => { apply(); onTrack(currentTrack()); });
    apply();   // re-emit 'theme' now that the bus exists
  }

  if (document.body) updateMesh();
  if (window.riff) register();
  else document.addEventListener('DOMContentLoaded', () => { updateMesh(); register(); }, { once: true });
})();
