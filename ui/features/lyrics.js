'use strict';
// Lyrics (riff style): synced LRC lines with a sweep highlight and smooth auto-scroll in the
// right panel, plain-text fallback, "No lyrics found" state, RTL lines, a custom lyrics editor,
// and a fullscreen "TV karaoke" view. Data comes from src-tauri/src/features/lyrics.rs (lrclib).
(() => {
  const R = window.riff;
  const { esc, audio } = R;
  const $ = (s, root = document) => root.querySelector(s);

  // ------------------------------------------------------------ settings

  const opt = {
    tab: R.load('lyrics.tab', 'lyrics'),            // 'lyrics' | 'next'
    online: R.load('lyrics.online', true),          // Online lyrics lookup
    autoscroll: R.load('lyrics.autoscroll', true),  // Auto-scroll synced lyrics
    sweep: R.load('lyrics.sweep', true),            // header button: Word / Line mode
    karaoke: R.load('lyrics.karaoke', true),        // Advanced: Karaoke word highlighting
    tr: R.load('lyrics.tr', false),                 // Lyrics translation
    trLang: R.load('lyrics.trLang', 'en'),          // Translation language
    trAuto: R.load('lyrics.trAuto', false),         // Auto-translate
    ease: R.load('lyrics.ease', 'inout'),           // Lyrics animation
    speed: R.load('lyrics.speed', 1),               // Lyrics animation speed (0.5 - 2.5)
    wordStyle: R.load('lyrics.wordStyle', 'gradient'), // Word mode style: gradient | words
    tight: R.load('lyrics.tight', 2),               // Gradient tightness (%)
    tvkViz: R.load('lyrics.tvkViz', true),          // Visualizer in full karaoke mode
    tvkVizLyrics: R.load('lyrics.tvkVizLyrics', false), // Visualizer with lyrics
  };
  const setOpt = (k, v) => { opt[k] = v; R.store('lyrics.' + k, v); };
  const wordMode = () => opt.sweep && opt.karaoke;
  const gradientMode = () => wordMode() && opt.wordStyle !== 'words';

  // riff's LYRIC_EASINGS: CSS curve for line transitions + JS curve for the auto-scroll.
  const EASINGS = {
    inout: ['Ease in-out (Cubic)', 'cubic-bezier(0.65, 0, 0.35, 1)', (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)],
    quad: ['Smooth (Quad)', 'cubic-bezier(0.45, 0, 0.55, 1)', (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2)],
    sine: ['Gentle (Sine)', 'cubic-bezier(0.37, 0, 0.63, 1)', (t) => -(Math.cos(Math.PI * t) - 1) / 2],
    out: ['Ease out (Quart)', 'cubic-bezier(0.22, 1, 0.36, 1)', (t) => 1 - Math.pow(1 - t, 4)],
    outsine: ['Soft ease out', 'cubic-bezier(0.39, 0.575, 0.565, 1)', (t) => Math.sin((t * Math.PI) / 2)],
    expo: ['Snappy (Expo)', 'cubic-bezier(0.16, 1, 0.3, 1)', (t) => (t === 1 ? 1 : 1 - Math.pow(2, -10 * t))],
    linear: ['Linear', 'linear', (t) => t],
  };
  if (!EASINGS[opt.ease]) opt.ease = 'inout';
  if (!(opt.speed >= 0.5 && opt.speed <= 2.5)) opt.speed = 1;
  if (!(opt.tight >= 0 && opt.tight <= 40)) opt.tight = 2;
  function applyAnim() {
    const s = document.documentElement.style;
    s.setProperty('--lyric-ease', EASINGS[opt.ease][1]);
    s.setProperty('--lyric-duration', `${(0.45 / opt.speed).toFixed(2)}s`);
    s.setProperty('--lyric-fw', `${opt.tight}%`);
  }
  applyAnim();

  // riff's translation language list (code, name, flag).
  const LANGS = [
    ['af','Afrikaans','🇿🇦'],
    ['sq','Albanian','🇦🇱'],
    ['am','Amharic','🇪🇹'],
    ['ar','Arabic','🇸🇦'],
    ['hy','Armenian','🇦🇲'],
    ['as','Assamese','🇮🇳'],
    ['ay','Aymara','🇧🇴'],
    ['az','Azerbaijani','🇦🇿'],
    ['bm','Bambara','🇲🇱'],
    ['eu','Basque','🇪🇸'],
    ['be','Belarusian','🇧🇾'],
    ['bn','Bengali','🇧🇩'],
    ['bho','Bhojpuri','🇮🇳'],
    ['bs','Bosnian','🇧🇦'],
    ['bg','Bulgarian','🇧🇬'],
    ['ca','Catalan','🇪🇸'],
    ['ceb','Cebuano','🇵🇭'],
    ['ny','Chichewa','🇲🇼'],
    ['zh-CN','Chinese (Simplified)','🇨🇳'],
    ['zh-TW','Chinese (Traditional)','🇹🇼'],
    ['co','Corsican','🇫🇷'],
    ['hr','Croatian','🇭🇷'],
    ['cs','Czech','🇨🇿'],
    ['da','Danish','🇩🇰'],
    ['dv','Dhivehi','🇲🇻'],
    ['doi','Dogri','🇮🇳'],
    ['nl','Dutch','🇳🇱'],
    ['en','English','🇺🇸'],
    ['eo','Esperanto','🌐'],
    ['et','Estonian','🇪🇪'],
    ['ee','Ewe','🇬🇭'],
    ['tl','Filipino','🇵🇭'],
    ['fi','Finnish','🇫🇮'],
    ['fr','French','🇫🇷'],
    ['fy','Frisian','🇳🇱'],
    ['gl','Galician','🇪🇸'],
    ['ka','Georgian','🇬🇪'],
    ['de','German','🇩🇪'],
    ['el','Greek','🇬🇷'],
    ['gn','Guarani','🇵🇾'],
    ['gu','Gujarati','🇮🇳'],
    ['ht','Haitian Creole','🇭🇹'],
    ['ha','Hausa','🇳🇬'],
    ['haw','Hawaiian','🇺🇸'],
    ['he','Hebrew','🇮🇱'],
    ['hi','Hindi','🇮🇳'],
    ['hmn','Hmong','🇱🇦'],
    ['hu','Hungarian','🇭🇺'],
    ['is','Icelandic','🇮🇸'],
    ['ig','Igbo','🇳🇬'],
    ['ilo','Ilocano','🇵🇭'],
    ['id','Indonesian','🇮🇩'],
    ['ga','Irish','🇮🇪'],
    ['it','Italian','🇮🇹'],
    ['ja','Japanese','🇯🇵'],
    ['jw','Javanese','🇮🇩'],
    ['kn','Kannada','🇮🇳'],
    ['kk','Kazakh','🇰🇿'],
    ['km','Khmer','🇰🇭'],
    ['rw','Kinyarwanda','🇷🇼'],
    ['gom','Konkani','🇮🇳'],
    ['ko','Korean','🇰🇷'],
    ['kri','Krio','🇸🇱'],
    ['ku','Kurdish (Kurmanji)','🇹🇷'],
    ['ckb','Kurdish (Sorani)','🇮🇶'],
    ['ky','Kyrgyz','🇰🇬'],
    ['lo','Lao','🇱🇦'],
    ['la','Latin','🏛️'],
    ['lv','Latvian','🇱🇻'],
    ['ln','Lingala','🇨🇩'],
    ['lt','Lithuanian','🇱🇹'],
    ['lg','Luganda','🇺🇬'],
    ['lb','Luxembourgish','🇱🇺'],
    ['mk','Macedonian','🇲🇰'],
    ['mai','Maithili','🇮🇳'],
    ['mg','Malagasy','🇲🇬'],
    ['ms','Malay','🇲🇾'],
    ['ml','Malayalam','🇮🇳'],
    ['mt','Maltese','🇲🇹'],
    ['mi','Maori','🇳🇿'],
    ['mr','Marathi','🇮🇳'],
    ['mni-Mtei','Meiteilon (Manipuri)','🇮🇳'],
    ['lus','Mizo','🇮🇳'],
    ['mn','Mongolian','🇲🇳'],
    ['my','Myanmar (Burmese)','🇲🇲'],
    ['ne','Nepali','🇳🇵'],
    ['no','Norwegian','🇳🇴'],
    ['or','Odia (Oriya)','🇮🇳'],
    ['om','Oromo','🇪🇹'],
    ['ps','Pashto','🇦🇫'],
    ['fa','Persian','🇮🇷'],
    ['pl','Polish','🇵🇱'],
    ['pt','Portuguese','🇵🇹'],
    ['pa','Punjabi','🇮🇳'],
    ['qu','Quechua','🇵🇪'],
    ['ro','Romanian','🇷🇴'],
    ['ru','Russian','🇷🇺'],
    ['sm','Samoan','🇼🇸'],
    ['sa','Sanskrit','🇮🇳'],
    ['gd','Scots Gaelic','🏴󠁧󠁢󠁳󠁣󠁴󠁿'],
    ['sr','Serbian','🇷🇸'],
    ['st','Sesotho','🇱🇸'],
    ['sn','Shona','🇿🇼'],
    ['sd','Sindhi','🇵🇰'],
    ['si','Sinhala','🇱🇰'],
    ['sk','Slovak','🇸🇰'],
    ['sl','Slovenian','🇸🇮'],
    ['so','Somali','🇸🇴'],
    ['es','Spanish','🇪🇸'],
    ['su','Sundanese','🇮🇩'],
    ['sw','Swahili','🇰🇪'],
    ['sv','Swedish','🇸🇪'],
    ['tg','Tajik','🇹🇯'],
    ['ta','Tamil','🇮🇳'],
    ['tt','Tatar','🇷🇺'],
    ['te','Telugu','🇮🇳'],
    ['th','Thai','🇹🇭'],
    ['ti','Tigrinya','🇪🇷'],
    ['ts','Tsonga','🇿🇦'],
    ['tr','Turkish','🇹🇷'],
    ['tk','Turkmen','🇹🇲'],
    ['ak','Twi (Akan)','🇬🇭'],
    ['uk','Ukrainian','🇺🇦'],
    ['ur','Urdu','🇵🇰'],
    ['ug','Uyghur','🇨🇳'],
    ['uz','Uzbek','🇺🇿'],
    ['vi','Vietnamese','🇻🇳'],
    ['cy','Welsh','🏴󠁧󠁢󠁷󠁬󠁳󠁿'],
    ['xh','Xhosa','🇿🇦'],
    ['yi','Yiddish','🇮🇱'],
    ['yo','Yoruba','🇳🇬'],
    ['zu','Zulu','🇿🇦'],
  ];
  const langLabel = (code) => { const l = LANGS.find((x) => x[0] === code) || ['en', 'English', '🇺🇸']; return `${l[2]} ${l[1]} (${l[0]})`; };

  // ------------------------------------------------------------ helpers

  const RTL_RE = /[֐-ࣿיִ-﷿ﹰ-﻿]/;
  const LETTER_RE = /\p{L}/u;
  // Direction comes from the first letter, like riff's lyrics-rtl.js.
  function isRtl(text) {
    for (const ch of String(text || '')) { if (LETTER_RE.test(ch)) return RTL_RE.test(ch); }
    return false;
  }
  // riff's gradient pacing: vowels and CJK take longer to sing than consonants and spaces,
  // and the last 20% of a line is drawn out.
  const PUNCT_RE = /^[\s\p{P}]$/u, CJK_RE = /^[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Hangul}]$/u, MARK_RE = /^\p{M}$/u;
  const CYR_VOWELS = new Set('аеёиоуыэюяєіїўѣѵѫѧѩѭ'), LATIN_EXTRA = new Set(['æ', 'ø', 'œ', 'ı']);
  function charWeight(c) {
    if (PUNCT_RE.test(c)) return 0.4;
    if (CJK_RE.test(c) || MARK_RE.test(c)) return 3;
    const lower = c.toLowerCase();
    if (CYR_VOWELS.has(lower)) return 3;
    const base = c.normalize('NFD')[0].toLowerCase();
    return 'aeiouy'.includes(base) || LATIN_EXTRA.has(lower) ? 3 : 1;
  }
  function lineWeights(text) {
    const chars = Array.from(text), N = chars.length, cum = new Float64Array(N + 1), outro = Math.floor(N * 0.8);
    for (let i = 0; i < N; i++) cum[i + 1] = cum[i] + charWeight(chars[i]) * (i >= outro ? 1.6 : 1);
    return { N, cum, total: cum[N] };
  }
  // tau (0..1 through the line's time) -> k (0..1 through its characters)
  function sweepK(w, tau) {
    if (!w.N || !w.total || tau <= 0) return Math.max(0, Math.min(1, tau));
    if (tau >= 1) return 1;
    const tw = tau * w.total, c = w.cum;
    let lo = 0, hi = w.N - 1, i = 0;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (c[m + 1] <= tw) lo = m + 1; else if (c[m] > tw) hi = m - 1; else { i = m; break; }
    }
    const cw = c[i + 1] - c[i];
    return Math.min(1, Math.max(0, (i + (cw > 0 ? (tw - c[i]) / cw : 0)) / w.N));
  }
  const argsFor = (t) => ({ title: t.title || '', artist: t.artist || '', duration: Number(t.duration) || 0 });
  const keyFor = (t) => `${t.source || ''}:${t.id}:${t.title}`;

  // Timing offset, in seconds: positive shows each line sooner. One for all songs plus one per song.
  const offsets = { all: R.pref('lyricsOffset', 0), songs: R.load('lyricsOffsets', {}) };
  const songOffset = (t) => (t && offsets.songs[keyFor(t)]) || 0;
  const lyricsOffset = () => offsets.all + songOffset(R.player.current);
  function nudgeOffset(which, delta) {
    const round = (v) => Math.round(Math.max(-30, Math.min(30, v)) * 100) / 100;
    if (which === 'all') { offsets.all = delta == null ? 0 : round(offsets.all + delta); R.setPref('lyricsOffset', offsets.all); }
    else if (R.player.current) {
      const k = keyFor(R.player.current);
      const v = delta == null ? 0 : round(songOffset(R.player.current) + delta);
      if (v) offsets.songs[k] = v; else delete offsets.songs[k];
      const keys = Object.keys(offsets.songs);
      if (keys.length > 500) delete offsets.songs[keys[0]];
      R.store('lyricsOffsets', offsets.songs);
    }
  }

  const IC = {
    edit: R.svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>'),
    tv: R.svg('<path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/>'),
    timing: R.svg('<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2"/><path d="M9 2h6"/>'),
    mic: R.svg('<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>'),
    prev: R.svg('<path d="M6 5h2v14H6zm3.5 7L18 5v14z"/>', true),
    next: R.svg('<path d="M16 5h2v14h-2zM6 19V5l8.5 7z"/>', true),
    tr: R.svg('<path d="m5 8 6 6"/><path d="m4 14 6-6 2-3"/><path d="M2 5h12"/><path d="M7 2h1"/><path d="m22 22-5-10-5 10"/><path d="M14 18h6"/>'),
  };

  // ------------------------------------------------------------ data

  const cache = new Map(); // track key -> result (session memory; Rust also caches on disk)
  function remember(k, v) {
    cache.set(k, v);
    if (cache.size > 300) cache.delete(cache.keys().next().value);
  }
  async function fetchLyrics(t) {
    const k = keyFor(t);
    if (cache.has(k)) return cache.get(k);
    const r = await R.call('lyrics.get', { ...argsFor(t), online: opt.online });
    if (!r.error) remember(k, r); // transient failures are retried next time
    return r;
  }

  // ------------------------------------------------------------ a lyrics list (panel or TV)

  class LyricsView {
    constructor(container) {
      this.box = container;
      this.lines = [];      // [{t, text}]
      this.els = [];
      this.synced = false;
      this.active = -2;
      this.raf = 0;
      this.holdUntil = 0;   // user scrolled: pause auto-scroll for a moment
      this.tr = null;       // translations, one per line (or null)
      this.weights = null;  // char weights of the active line (gradient mode)
      ['wheel', 'touchstart', 'pointerdown'].forEach((ev) => container.addEventListener(ev, () => {
        cancelAnimationFrame(this.raf);
        this.holdUntil = performance.now() + 2500;
      }, { passive: true }));
      container.addEventListener('click', (e) => {
        const line = e.target.closest('.lyric-line[data-t]');
        if (!line || !this.synced || !R.player.current) return;
        this.holdUntil = 0;
        audio.currentTime = Math.max(0, Number(line.dataset.t) - lyricsOffset());
        if (audio.paused) audio.play().catch(() => {});
      });
      new ResizeObserver(() => { this.pad(); this.update(audio.currentTime, true, true); }).observe(container);
    }

    render(data, tr) {
      const box = this.box;
      this.synced = !!(data && data.synced && data.lines.length);
      this.lines = this.synced ? data.lines : [];
      this.tr = tr || null;
      this.active = -2;
      this.weights = null;
      const grad = this.synced && gradientMode(), words = this.synced && wordMode() && !grad;
      box.classList.toggle('synced', this.synced);
      box.classList.toggle('plain', !!data && !this.synced);
      box.classList.toggle('sweep', grad);
      box.classList.toggle('words', words);
      const trHtml = (i) => (this.tr && this.tr[i] ? `<div class="lyric-translation" dir="auto">${esc(this.tr[i])}</div>` : '');
      let html = '';
      if (this.synced) {
        html = this.lines.map((l, i) => {
          if (!l.text) return `<div class="lyric-line gap" data-i="${i}" data-t="${l.t}"><span class="lyric-fill">• • •</span></div>`;
          const rtl = isRtl(l.text);
          const body = words
            ? l.text.split(/\s+/).filter(Boolean).map((w) => `<span class="lyric-word">${esc(w)}</span>`).join(' ')
            : `<span class="lyric-fill">${esc(l.text)}</span>`;
          return `<div class="lyric-line${rtl ? ' rtl' : ''}${grad ? ' gradient-line' : ''}" dir="${rtl ? 'rtl' : 'auto'}" data-i="${i}" data-t="${l.t}">${body}${trHtml(i)}</div>`;
        }).join('');
      } else if (data) {
        // translations of plain lyrics are indexed by the plain line list (blank lines included)
        html = data.plain.map((l, i) => (l
          ? `<div class="lyric-line${isRtl(l) ? ' rtl' : ''}" dir="${isRtl(l) ? 'rtl' : 'auto'}">${esc(l)}${trHtml(i)}</div>`
          : '<div class="ly-break"></div>')).join('');
      }
      box.innerHTML = html;
      this.els = Array.from(box.children).filter((n) => n.classList.contains('lyric-line'));
      cancelAnimationFrame(this.raf);
      box.scrollTop = 0;
      this.pad();
      if (this.synced) this.update(audio.currentTime, true, true);
    }

    pad() {
      const h = this.box.clientHeight;
      const p = this.synced && h ? Math.round(h * 0.42) : 12;
      this.box.style.paddingTop = this.box.style.paddingBottom = `${p}px`;
    }

    indexAt(t) {
      let lo = 0, hi = this.lines.length - 1, ans = -1;
      while (lo <= hi) { const m = (lo + hi) >> 1; if (this.lines[m].t <= t) { ans = m; lo = m + 1; } else hi = m - 1; }
      return ans;
    }

    // force: re-apply classes and scroll even if the line didn't change; snap: jump, don't animate
    update(t, force, snap) {
      if (!this.synced || !this.box.clientHeight) return;
      t += lyricsOffset();
      const i = this.indexAt(t + 0.05);
      if (i !== this.active || force) {
        this.active = i;
        this.els.forEach((el, n) => {
          el.style.setProperty('--dist', i < 0 ? Math.min(n + 1, 6) : Math.min(Math.abs(n - i), 6));
          el.classList.toggle('active', n === i);
          el.classList.toggle('past', n < i);
          if (n === i) return;
          const f = el.firstElementChild;
          if (f && f.classList.contains('lyric-fill')) f.style.setProperty('--k', '0');
          else if (f && f.classList.contains('lyric-word')) {
            el.querySelectorAll('.lyric-word').forEach((w) => { w.className = n < i ? 'lyric-word past-word' : 'lyric-word'; });
          }
        });
        this.weights = null;
        this.scroll(snap);
      }
      const cur = this.els[i];
      if (!cur || !wordMode()) return;
      const start = this.lines[i].t;
      const end = i + 1 < this.lines.length ? this.lines[i + 1].t : start + 4;
      const tau = Math.min(1, Math.max(0, (t - start) / Math.max(0.5, end - start)));
      const f = cur.firstElementChild;
      if (!f) return;
      if (f.classList.contains('lyric-word')) {
        // riff "Words": the word at the line's time progress is lit, earlier ones are sung
        const ws = cur.querySelectorAll('.lyric-word');
        const w = Math.floor(Math.min(tau, 0.999) * ws.length);
        ws.forEach((s, n) => { const c = n < w ? 'lyric-word past-word' : n === w ? 'lyric-word active-word' : 'lyric-word'; if (s.className !== c) s.className = c; });
      } else if (f.classList.contains('lyric-fill') && cur.classList.contains('gradient-line')) {
        if (!this.weights) this.weights = lineWeights(f.textContent || '');
        f.style.setProperty('--k', sweepK(this.weights, tau).toFixed(4));
      }
    }

    scroll(snap) {
      if (!opt.autoscroll || performance.now() < this.holdUntil) return;
      const box = this.box, el = this.els[this.active];
      const target = el ? Math.max(0, el.offsetTop - box.clientHeight / 2 + el.offsetHeight / 2) : 0;
      cancelAnimationFrame(this.raf);
      const from = box.scrollTop, delta = target - from;
      if (Math.abs(delta) < 1) return;
      if (snap || Math.abs(delta) > box.clientHeight * 2) { box.scrollTop = target; return; }
      const ease = EASINGS[opt.ease][2];
      const dur = Math.max(120, Math.min(750, Math.max(420, Math.abs(delta) * 1.2)) / opt.speed), t0 = performance.now();
      const step = (now) => {
        const p = Math.min(1, (now - t0) / dur);
        box.scrollTop = from + delta * ease(p);
        if (p < 1) this.raf = requestAnimationFrame(step);
      };
      this.raf = requestAnimationFrame(step);
    }
  }

  // ------------------------------------------------------------ right panel

  const panel = $('#right-panel');
  const bar = R.el(`<div class="ly-bar">
    <div class="ly-tabs" role="tablist">
      <button class="ly-tab" data-tab="lyrics" title="Lyrics" aria-label="Lyrics">${IC.mic}</button>
      <button class="ly-tab" data-tab="next" title="Up next" aria-label="Up next">${R.ICON.queue}</button>
    </div>
    <div class="ly-actions">
      <button class="lyrics-mode-btn" data-a="mode" title="Toggle line mode"><span>Word</span></button>
      <button class="lyrics-action-btn" data-a="timing" title="Lyrics timing" aria-label="Lyrics timing" hidden>${IC.timing}</button>
      <button class="lyrics-action-btn" data-a="tr" title="Translate lyrics" aria-label="Translate lyrics" hidden>${IC.tr}</button>
      <button class="lyrics-action-btn" data-a="edit" title="Edit lyrics" aria-label="Edit lyrics">${IC.edit}</button>
      <button class="lyrics-action-btn" data-a="tv" title="Fullscreen karaoke" aria-label="Fullscreen karaoke">${IC.tv}</button>
    </div>
  </div>`);
  const section = R.el(`<div class="ly-section">
    <div class="ly-empty-msg" hidden></div>
    <div class="lyrics-container ly-list"></div>
    <div class="ly-status" hidden></div>
  </div>`);
  panel.prepend(bar);
  (panel.querySelector('.rp-meta') || bar).after(section);
  const panelView = new LyricsView($('.ly-list', section));
  const emptyMsg = $('.ly-empty-msg', section);
  const status = $('.ly-status', section);
  const playbarBtn = R.el(`<button class="pill-btn ly-pb" title="Toggle lyrics">${R.ICON.music}</button>`);

  // tr: translations for cur.data (one per line), trActive: translation shown for this track
  const cur = { track: null, data: null, loading: false, token: 0, ms: 0, tr: null, trActive: false, trBusy: false };
  const tv = { open: false, idleTimer: 0, winFs: false };

  function syncPanel() {
    const want = opt.tab === 'lyrics';
    const has = !!(cur.data && cur.data.found);
    panel.classList.toggle('ly-on', want && has);
    // No lyrics: show up next instead of an empty panel (only "loading" keeps the empty state).
    panel.classList.toggle('ly-none', want && !has && !!cur.loading);
    panel.classList.toggle('ly-fallback', want && !has && !cur.loading && !!cur.track);
    bar.querySelectorAll('.ly-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === opt.tab));
    const modeBtn = $('[data-a=mode]', bar);
    modeBtn.hidden = !(want && opt.karaoke && cur.data && cur.data.synced);
    modeBtn.firstElementChild.textContent = opt.sweep ? 'Word' : 'Line';
    const timingBtn = $('[data-a=timing]', bar);
    timingBtn.hidden = !(want && cur.data && cur.data.synced);
    timingBtn.classList.toggle('active', !!lyricsOffset());
    const trBtn = $('[data-a=tr]', bar);
    trBtn.hidden = !(opt.tr && want && cur.data && cur.data.found);
    trBtn.classList.toggle('active', cur.trActive);
    trBtn.classList.toggle('busy', cur.trBusy);
    // The pen is unclear on its own; editing lives in the now-playing ⋯ menu instead.
    $('[data-a=edit]', bar).hidden = true;
    let msg = '';
    if (want && !has && cur.track) {
      if (cur.loading) msg = 'Loading lyrics…';
      else if (cur.data && cur.data.instrumental) msg = 'Instrumental';
      else msg = 'No lyrics for this song';
    }
    emptyMsg.hidden = !msg;
    emptyMsg.classList.toggle('loading', !!cur.loading);
    emptyMsg.innerHTML = msg ? `${IC.mic}<span>${esc(msg)}</span>` : '';
    const d = cur.data;
    const label = d && d.found ? (d.custom ? (d.synced ? 'Custom synced' : 'Custom') : (d.synced ? 'Synced' : 'Plain')) : '';
    status.hidden = !(want && label);
    status.textContent = label ? `${label}${d.source === 'lrclib' ? ' · LRCLIB' : ''}` : '';
    playbarBtn.classList.toggle('on', want);
    loop();
  }

  bar.addEventListener('click', (e) => {
    const tab = e.target.closest('.ly-tab')?.dataset.tab;
    if (tab) { setTab(tab); return; }
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a === 'mode') { setOpt('sweep', !opt.sweep); rerender(); }
    else if (a === 'tr') setTranslation(!cur.trActive);
    else if (a === 'timing') timingPopover(e.target.closest('[data-a]'));
    else if (a === 'edit') openEditor();
    else if (a === 'tv') openTv();
  });

  // Lyrics early or late: nudge this song (saved per song) or every song, in 0.25 s steps.
  let timingEl = null;
  function timingPopover(btn) {
    if (timingEl) { timingEl.remove(); timingEl = null; return; }
    const fmtOff = (v) => (v ? `${v > 0 ? '+' : '−'}${Math.abs(v).toFixed(2)} s` : '0 s');
    const row = (k, name) => `<div class="ly-timing-row"><span>${name}</span><button type="button" data-n="${k}" data-d="-0.25" title="Later">−</button><b data-v="${k}"></b><button type="button" data-n="${k}" data-d="0.25" title="Earlier">+</button><button type="button" class="ly-timing-reset" data-n="${k}" data-d="reset" title="Reset">${R.ICON.close || '×'}</button></div>`;
    timingEl = R.el(`<div class="ly-timing" role="dialog" aria-label="Lyrics timing">
      <div class="ly-timing-head">Lyrics timing</div>${row('song', 'This song')}${row('all', 'All songs')}
      <div class="ly-timing-hint">+ shows lines sooner, − later</div></div>`);
    const paint = () => {
      $('[data-v=song]', timingEl).textContent = fmtOff(songOffset(R.player.current));
      $('[data-v=all]', timingEl).textContent = fmtOff(offsets.all);
    };
    timingEl.addEventListener('click', (e) => {
      const b = e.target.closest('[data-n]');
      if (!b) return;
      nudgeOffset(b.dataset.n === 'all' ? 'all' : 'song', b.dataset.d === 'reset' ? null : Number(b.dataset.d));
      paint();
      syncPanel();
      panelView.update(audio.currentTime, true);
      if (tv.open) tvView.update(audio.currentTime, true);
    });
    document.body.append(timingEl);
    const r = btn.getBoundingClientRect();
    timingEl.style.top = `${r.bottom + 8}px`;
    timingEl.style.left = `${Math.max(8, Math.min(window.innerWidth - timingEl.offsetWidth - 8, r.right - timingEl.offsetWidth))}px`;
    paint();
    const away = (e) => { if (timingEl && !timingEl.contains(e.target) && !btn.contains(e.target)) { timingEl.remove(); timingEl = null; document.removeEventListener('pointerdown', away, true); } };
    document.addEventListener('pointerdown', away, true);
  }
  R.on('trackchange', () => { if (timingEl) { timingEl.remove(); timingEl = null; } });

  function setTab(tab) {
    setOpt('tab', tab);
    syncPanel();
    if (tab === 'lyrics') requestAnimationFrame(() => { panelView.pad(); panelView.update(audio.currentTime, true, true); });
  }

  function rerender() {
    const d = cur.data && cur.data.found ? cur.data : null;
    const tr = cur.trActive ? cur.tr : null;
    syncPanel(); // layout first, so the list has its final height
    panelView.render(d, tr);
    if (tv.open) tvView.render(d, tr);
    updateTv();
  }

  // ------------------------------------------------------------ translation (riff: Lyrics translation)

  const trCache = new Map(); // "track|lang" -> translations
  const linesOf = (d) => (d.synced ? d.lines.map((l) => l.text) : d.plain);
  async function translate() {
    const d = cur.data, t = cur.track;
    if (!d || !d.found || !t) return;
    const lang = opt.trLang, key = `${keyFor(t)}|${lang}`;
    if (trCache.has(key)) { cur.tr = trCache.get(key); rerender(); return; }
    const token = cur.token;
    cur.trBusy = true; syncPanel();
    try {
      const r = await R.call('lyrics.translate', { lines: linesOf(d), to: lang });
      if (Array.isArray(r.translations) && r.translations.length) {
        trCache.set(key, r.translations);
        if (trCache.size > 50) trCache.delete(trCache.keys().next().value);
      }
      if (token === cur.token && lang === opt.trLang && cur.trActive) { cur.tr = r.translations; }
    } catch (e) {
      R.toast(`Translation failed: ${R.errText(e)}`, 'error');
    }
    cur.trBusy = false;
    rerender();
  }
  function setTranslation(on) {
    cur.trActive = !!on && opt.tr;
    if (!cur.trActive) { cur.tr = null; rerender(); return; }
    syncPanel();
    translate();
  }

  async function loadFor(t) {
    const token = ++cur.token;
    cur.track = t;
    cur.data = null;
    cur.tr = null;
    cur.trActive = opt.tr && opt.trAuto;
    cur.loading = !!t;
    rerender();
    if (!t) return;
    const t0 = performance.now();
    let data;
    try { data = await fetchLyrics(t); } catch (e) { data = { found: false, error: R.errText(e) }; }
    if (token !== cur.token) return;
    cur.loading = false;
    cur.data = data;
    cur.ms = Math.round(performance.now() - t0);
    rerender();
    if (cur.trActive && data && data.found) translate();
  }

  // ------------------------------------------------------------ playback loop

  let rafId = 0, lastFrame = 0;
  const panelShowing = () => panel.classList.contains('ly-on') && panel.offsetParent !== null;
  function frame(now) {
    rafId = 0;
    if (document.hidden || !cur.data || !cur.data.synced || !(tv.open || panelShowing())) return;
    if (now - lastFrame > 30) { // ~30 fps is plenty for the sweep
      lastFrame = now;
      const t = audio.currentTime;
      if (panelShowing()) panelView.update(t);
      if (tv.open) tvView.update(t);
    }
    if (!audio.paused) rafId = requestAnimationFrame(frame);
  }
  function loop() { if (!rafId) rafId = requestAnimationFrame(frame); }
  audio.addEventListener('timeupdate', loop);
  R.on('play', loop);
  R.on('seeked', () => {
    if (!cur.data || !cur.data.synced) return;
    panelView.holdUntil = tvView.holdUntil = 0;
    panelView.update(audio.currentTime, true);
    if (tv.open) tvView.update(audio.currentTime, true);
  });
  document.addEventListener('visibilitychange', loop);

  // ------------------------------------------------------------ track changes + prefetch

  let prefetchTimer = 0;
  function prefetchNext() {
    clearTimeout(prefetchTimer);
    if (!opt.online) return;
    prefetchTimer = setTimeout(() => {
      for (const t of R.upcoming(2)) {
        if (t && !cache.has(keyFor(t))) R.call('lyrics.prefetch', argsFor(t)).catch(() => {});
      }
    }, 2500); // after the current track's own lookup and stream start
  }
  R.on('trackchange', (t) => {
    if (!t || !cur.track || keyFor(t) !== keyFor(cur.track)) loadFor(t || null);
    if (t) prefetchNext();
  });

  // ------------------------------------------------------------ playbar toggle (riff: "Toggle lyrics", key L)

  playbarBtn.addEventListener('click', toggleLyrics);
  R.addPlaybarButton(playbarBtn, 'right');
  // "Edit lyrics" for the song that's playing (replaces the pen in the panel).
  R.addTrackMenu((t) => (R.player.current && t && t.id === R.player.current.id ? [{ label: 'Edit lyrics', run: () => openEditor() }] : []));

  function toggleLyrics() {
    // Narrow windows hide the right panel; fall back to the fullscreen view.
    if (getComputedStyle(panel).display === 'none') { if (tv.open) closeTv(); else openTv(); return; }
    setTab(opt.tab === 'lyrics' ? 'next' : 'lyrics');
  }

  document.addEventListener('keydown', (e) => {
    if (e.target.closest && e.target.closest('input, textarea, [contenteditable]')) return;
    if (e.key === 'Escape' && tv.open) { closeTv(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey || !$('#modal').hidden) return;
    const k = e.key.toLowerCase();
    if (k === 'l') { e.preventDefault(); toggleLyrics(); }
    else if (k === 'f') { e.preventDefault(); if (tv.open) closeTv(); else openTv(); }
  });

  // ------------------------------------------------------------ custom lyrics editor

  function openEditor() {
    const t = cur.track;
    if (!t) return;
    const d = cur.data;
    const stamp = (s) => { const m = Math.floor(s / 60); return `[${String(m).padStart(2, '0')}:${(s - m * 60).toFixed(2).padStart(5, '0')}]`; };
    const text = d && d.found ? (d.synced ? d.lines.map((l) => stamp(l.t) + l.text).join('\n') : d.plain.join('\n')) : '';
    const m = R.openModal(`<div class="ly-editor"><h3>Custom lyrics editor</h3>
      <p>Paste or type lyrics for the current track. One line per row. Lines starting with [mm:ss.xx] are synced.</p>
      <div class="ly-ed-track"><b>${esc(t.title)}</b><span>${esc(t.artist)}</span></div>
      <textarea spellcheck="false" placeholder="First line of the lyrics...&#10;Second line of the lyrics...&#10;&#10;Chorus starts here..."></textarea>
      <div class="row-btns">${d && d.custom ? '<button class="btn outline" data-k="reset">Remove custom</button>' : ''}<button class="btn outline" data-k="cancel">Cancel</button><button class="btn primary" data-k="save">Save lyrics</button></div></div>`);
    m.classList.add('ly-modal');
    const ta = $('textarea', m);
    ta.value = text;
    const save = async (value) => {
      try {
        const r = await R.call('lyrics.save', { ...argsFor(t), text: value });
        R.closeModal();
        cache.delete(keyFor(t));
        if (value.trim()) remember(keyFor(t), r);
        if (cur.track && keyFor(cur.track) === keyFor(t)) {
          trCache.clear();
          if (value.trim()) { cur.data = r; cur.tr = null; cur.loading = false; rerender(); if (cur.trActive) translate(); } else loadFor(t);
        }
        R.toast(value.trim() ? 'Lyrics saved' : 'Custom lyrics removed');
      } catch (e) { R.toast(R.errText(e), 'error'); }
    };
    $('[data-k=cancel]', m).onclick = () => R.closeModal();
    $('[data-k=save]', m).onclick = () => save(ta.value);
    const reset = $('[data-k=reset]', m);
    if (reset) reset.onclick = () => save('');
    setTimeout(() => ta.focus(), 0);
  }

  // ------------------------------------------------------------ TV karaoke

  const tvEl = R.el(`<div class="tvk" hidden>
    <div class="tvk-bg"></div>
    <button class="tvk-close" title="Close (Esc)" aria-label="Close">${R.ICON.close}</button>
    <div class="tvk-layout">
      <div class="tvk-side">
        <div class="tvk-cover"></div>
        <div class="tvk-meta"><div class="tvk-title"></div><div class="tvk-artist"></div></div>
        <div class="tvk-msg" hidden></div>
        <div class="tvk-controls">
          <button class="tvk-ctrl" data-c="prev" title="Previous">${IC.prev}</button>
          <button class="tvk-play" data-c="play" title="Play or pause"></button>
          <button class="tvk-ctrl" data-c="next" title="Next">${IC.next}</button>
        </div>
      </div>
      <div class="tvk-content"><div class="lyrics-container tvk-list"></div></div>
    </div>
    <div class="tvk-visualizer"><canvas></canvas></div>
  </div>`);
  document.body.append(tvEl);
  const tvView = new LyricsView($('.tvk-list', tvEl));

  // ------------------------------------------------------------ TV karaoke visualizer (riff: 28 white bars)
  // Shown with no lyrics ("Visualizer in full karaoke mode") or under them ("Visualizer with lyrics").
  // Smoothness / sensitivity / opacity follow the Interface visualizer settings when they exist.

  const viz = { canvas: $('.tvk-visualizer canvas', tvEl), raf: 0, w: 0, h: 0, prev: null, heights: null, data: null, an: null };
  const vizPref = (k, d) => { const v = Number(R.load(k, d)); return Number.isFinite(v) ? v : d; };
  function vizWanted() {
    if (!tv.open) return false;
    const has = !!(cur.data && cur.data.found);
    return has ? opt.tvkVizLyrics : opt.tvkViz;
  }
  function vizResize() {
    const dpr = window.devicePixelRatio || 1;
    viz.w = Math.min(760, Math.max(360, Math.round(window.innerWidth * 0.64)));
    viz.h = Math.min(84, Math.max(52, Math.round(window.innerHeight * 0.085)));
    viz.canvas.width = Math.round(viz.w * dpr);
    viz.canvas.height = Math.round(viz.h * dpr);
    viz.canvas.style.width = `${viz.w}px`;
    viz.canvas.style.height = `${viz.h}px`;
    viz.canvas.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  function vizDraw() {
    const ctx = viz.canvas.getContext('2d'), w = viz.w, h = viz.h;
    ctx.clearRect(0, 0, w, h);
    const bars = 28, gap = Math.max(3, Math.min(6, Math.round(w / 115)));
    const bw = Math.max(4, Math.floor((w - gap * (bars - 1)) / bars));
    const x0 = Math.max(0, (w - (bars * bw + gap * (bars - 1))) / 2), minH = 4, usable = Math.max(10, h - minH - 2);
    if (!viz.heights) viz.heights = new Float32Array(bars).fill(minH);
    const an = R.getAnalyser ? R.getAnalyser('lyrics') : null;
    let moving = false;
    if (an && !audio.paused) {
      if (!viz.data || viz.data.length !== an.frequencyBinCount) { viz.data = new Uint8Array(an.frequencyBinCount); viz.prev = new Float32Array(an.frequencyBinCount); }
      an.getByteFrequencyData(viz.data);
      const vs = window.riff.vizSettings ? window.riff.vizSettings() : null;
      const smooth = vs ? vs.smooth : Math.min(0.95, Math.max(0, vizPref('viz.smooth', 70) / 100));
      const sens = vs ? vs.sens : Math.min(3, Math.max(0.3, vizPref('viz.sens', 100) / 100));
      for (let i = 0; i < viz.data.length; i++) viz.prev[i] = viz.prev[i] * smooth + Math.min(255, viz.data[i] * sens) * (1 - smooth);
      // riff reads bins 0..55 of a 64-bin analyser; scale that span to whatever size this one has
      const step = Math.max(1, Math.floor(viz.data.length / 64));
      for (let i = 0; i < bars; i++) {
        const b0 = i * 2 * step, b1 = Math.min(viz.data.length - 1, b0 + step);
        const norm = ((viz.prev[b0] || 0) + (viz.prev[b1] || 0)) * 0.5 / 255;
        viz.heights[i] = minH + Math.pow(norm, 1.3) * 0.78 * usable;
      }
      moving = true;
    } else {
      for (let i = 0; i < bars; i++) {
        viz.heights[i] += (minH - viz.heights[i]) * 0.15;
        if (viz.heights[i] > minH + 0.5) moving = true;
      }
    }
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    for (let i = 0; i < bars; i++) ctx.roundRect(x0 + i * (bw + gap), h - viz.heights[i], bw, viz.heights[i], Math.min(bw / 2, 3));
    ctx.fill();
    return moving;
  }
  function vizTick() {
    viz.raf = 0;
    if (!vizWanted() || document.hidden) { R.releaseAnalyser?.('lyrics'); return; }
    const moving = vizDraw();
    if (moving || !audio.paused) viz.raf = R.nextFrame ? R.nextFrame(vizTick, 30) : requestAnimationFrame(vizTick);
  }
  function updateViz() {
    const on = vizWanted();
    tvEl.classList.toggle('tvk-viz', on);
    if (!on) R.releaseAnalyser?.('lyrics');
    tvEl.style.setProperty('--tvk-vis-opacity', String(window.riff.vizSettings ? window.riff.vizSettings().opacity : Math.min(100, Math.max(0, vizPref('viz.opacity', 85))) / 100));
    if (!on) return;
    if (!viz.w) vizResize();
    if (!viz.raf) vizTick();
  }
  window.addEventListener('resize', () => { if (tv.open) { vizResize(); updateViz(); } });
  R.on('play', updateViz);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) updateViz(); });

  function updateTv() {
    if (!tv.open) return;
    const t = cur.track;
    const art = t && t.artwork ? t.artwork : '';
    const cover = $('.tvk-cover', tvEl);
    cover.style.backgroundImage = art ? `url('${art}')` : '';
    cover.innerHTML = art ? '' : R.ICON.music;
    $('.tvk-bg', tvEl).style.backgroundImage = art ? `url('${art}')` : '';
    $('.tvk-title', tvEl).textContent = t ? t.title : 'No track playing';
    $('.tvk-artist', tvEl).textContent = t ? t.artist : '';
    const has = !!(cur.data && cur.data.found);
    tvEl.classList.toggle('tvk-nolyrics', !has);
    const msg = !t ? '' : cur.loading ? 'Loading lyrics…' : has ? '' : cur.data && cur.data.instrumental ? 'Instrumental' : 'No lyrics found';
    const m = $('.tvk-msg', tvEl);
    m.hidden = !msg;
    m.textContent = msg;
    setTvPlay();
    updateViz();
  }
  function setTvPlay() {
    const b = $('.tvk-play', tvEl);
    const playing = !audio.paused;
    b.innerHTML = playing ? R.ICON.pause : R.ICON.play;
    b.title = playing ? 'Pause' : 'Play';
  }
  R.on('play', setTvPlay);
  R.on('pause', setTvPlay);

  function wake() {
    tvEl.classList.remove('tvk-idle');
    clearTimeout(tv.idleTimer);
    tv.idleTimer = setTimeout(() => tvEl.classList.add('tvk-idle'), 3000);
  }
  tvEl.addEventListener('mousemove', wake);
  tvEl.addEventListener('click', (e) => {
    wake();
    if (e.target.closest('.tvk-close')) { closeTv(); return; }
    const c = e.target.closest('[data-c]')?.dataset.c;
    if (c === 'prev') R.prev();
    else if (c === 'next') R.next();
    else if (c === 'play') R.togglePlay();
  });

  // Window fullscreen needs core:window:allow-set-fullscreen; the DOM Fullscreen API is the fallback.
  async function setFullscreen(on) {
    const win = window.__TAURI__?.window?.getCurrentWindow?.();
    if (on) {
      try { await win.setFullscreen(true); tv.winFs = true; return; } catch (e) { tv.winFs = false; }
      try { await document.documentElement.requestFullscreen(); } catch (e) {}
    } else if (tv.winFs) {
      tv.winFs = false;
      try { await win.setFullscreen(false); } catch (e) {}
    } else if (document.fullscreenElement) {
      try { await document.exitFullscreen(); } catch (e) {}
    }
  }
  document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && tv.open && !tv.winFs) closeTv(true); });

  function openTv(noFullscreen) {
    if (tv.open) return;
    tv.open = true;
    tvEl.hidden = false;
    requestAnimationFrame(() => tvEl.classList.add('show'));
    updateTv();
    tvView.render(cur.data && cur.data.found ? cur.data : null, cur.trActive ? cur.tr : null);
    vizResize();
    updateTv();
    wake();
    if (noFullscreen !== true) setFullscreen(true);
    loop();
  }
  // Phones use this view as the full-screen "now playing" (features/android.js).
  R.openNowPlaying = () => openTv(true);
  R.closeNowPlaying = () => closeTv(true);
  R.nowPlayingOpen = () => tv.open;
  function closeTv(skipFullscreen) {
    if (!tv.open) return;
    tv.open = false;
    tvEl.classList.remove('show', 'tvk-idle');
    tvEl.hidden = true;
    clearTimeout(tv.idleTimer);
    tvEl.classList.remove('tvk-viz');
    if (skipFullscreen !== true) setFullscreen(false);
  }

  // ------------------------------------------------------------ settings

  // Rows use the themes.js look (th-group / th-item / th-sl / th-dd) with their own wiring.
  const CHEV = '<svg class="th-dd-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>';
  const nameCol = (name, desc) => (desc
    ? `<div class="th-col"><span class="th-name">${esc(name)}</span><span class="th-desc">${esc(desc)}</span></div>`
    : `<span class="th-name">${esc(name)}</span>`);
  const S = {
    toggle: (k, name, desc, needs) => `<div class="th-item setting-item"${needs ? ` data-ly-needs="${needs}"` : ''}><div class="th-top">${nameCol(name, desc)}${R.switchHtml(opt[k], `data-ly-sw="${k}" aria-label="${esc(name)}"`)}</div></div>`,
    dd: (k, name, desc, opts, { needs, search } = {}) => `<div class="th-item setting-item"${needs ? ` data-ly-needs="${needs}"` : ''}><div class="th-top">${nameCol(name, desc)}</div>
      <div class="th-dd ly-dd" data-ly-dd="${k}"><button type="button" class="th-dd-trigger"><span data-ly-dd-label></span>${CHEV}</button>
        <div class="th-dd-menu">${search ? '<div class="ly-dd-search"><input type="text" placeholder="Search language..." autocomplete="off" spellcheck="false"></div>' : ''}
          <div class="ly-dd-list">${opts.map(([v, l]) => `<button type="button" class="th-dd-opt" data-v="${esc(v)}">${esc(l)}</button>`).join('')}</div></div></div></div>`,
    slider: (k, name, min, max, step, h, needs) => `<div class="th-item setting-item"${needs ? ` data-ly-needs="${needs}"` : ''}><div class="th-top"><span class="th-name">${esc(name)}</span><span class="th-side"><span class="th-val" data-ly-val="${k}"></span></span></div>
      <div class="th-sl"><div class="th-sl-on"></div><div class="th-sl-off"></div><input type="range" data-ly-k="${k}" min="${min}" max="${max}" step="${step}"></div>
      <div class="th-hints"><span>${h[0]}</span><span>${h[1]}</span><span>${h[2]}</span></div></div>`,
  };
  // sliders store a different unit than they show (speed is 0.5-2.5, the slider 5-25)
  const SL = {
    speed: { get: () => Math.round(opt.speed * 10), set: (v) => v / 10, fmt: (v) => `${(v / 10).toFixed(1)}x` },
    tight: { get: () => opt.tight, set: (v) => v, fmt: (v) => `${v}%` },
  };
  const DD_LABEL = {
    trLang: (v) => langLabel(v),
    ease: (v) => EASINGS[v][0],
    wordStyle: (v) => (v === 'words' ? 'Words' : 'Gradient'),
  };

  let setHosts = [];
  function syncSettings() {
    setHosts = setHosts.filter((h) => h.isConnected);
    for (const host of setHosts) {
      host.querySelectorAll('[data-ly-sw]').forEach((b) => R.setSwitch(b, !!opt[b.dataset.lySw]));
      host.querySelectorAll('input[data-ly-k]').forEach((inp) => {
        const sl = SL[inp.dataset.lyK];
        if (inp.dataset.dragging !== '1') inp.value = sl.get();
        const min = +inp.min, max = +inp.max;
        inp.parentElement.style.setProperty('--v', (+inp.value - min) / (max - min));
        const lab = host.querySelector(`[data-ly-val="${inp.dataset.lyK}"]`);
        if (lab) lab.textContent = sl.fmt(+inp.value);
      });
      host.querySelectorAll('[data-ly-dd]').forEach((dd) => {
        const k = dd.dataset.lyDd;
        dd.querySelector('[data-ly-dd-label]').textContent = DD_LABEL[k](opt[k]);
        dd.querySelectorAll('.th-dd-opt').forEach((o) => o.classList.toggle('selected', o.dataset.v === opt[k]));
      });
      host.querySelectorAll('[data-ly-needs]').forEach((n) => n.classList.toggle('is-disabled', !opt[n.dataset.lyNeeds]));
    }
  }

  // One place that reacts to a setting change (settings UI and selftest both go through it).
  function applySetting(k, v) {
    setOpt(k, v);
    switch (k) {
      case 'online':
        if (opt.online && cur.track && !(cur.data && cur.data.found)) { cache.delete(keyFor(cur.track)); loadFor(cur.track); }
        break;
      case 'karaoke': case 'wordStyle': rerender(); break;
      case 'ease': case 'speed': case 'tight': applyAnim(); break;
      case 'tr': setTranslation(opt.tr && (opt.trAuto || cur.trActive)); break;
      case 'trAuto': if (opt.tr && opt.trAuto && !cur.trActive) setTranslation(true); else syncPanel(); break;
      case 'trLang': if (cur.trActive) { cur.tr = null; translate(); } break;
      case 'tvkViz': case 'tvkVizLyrics': updateViz(); break;
      default: break;
    }
    syncSettings();
  }

  function wireSettings(host) {
    setHosts.push(host);
    host.addEventListener('input', (e) => {
      const t = e.target;
      if (t.matches('input[data-ly-k]')) {
        t.dataset.dragging = '1';
        const k = t.dataset.lyK;
        opt[k] = SL[k].set(+t.value);
        applyAnim();
        syncSettings();
      } else if (t.closest('.ly-dd-search')) {
        const q = t.value.toLowerCase().trim();
        t.closest('.th-dd').querySelectorAll('.th-dd-opt').forEach((o) => {
          o.hidden = !!q && !o.textContent.toLowerCase().includes(q) && !o.dataset.v.toLowerCase().includes(q);
        });
      }
    });
    host.addEventListener('change', (e) => {
      const t = e.target;
      if (t.matches('input[data-ly-k]')) { t.dataset.dragging = ''; applySetting(t.dataset.lyK, SL[t.dataset.lyK].set(+t.value)); }
    });
    host.addEventListener('keydown', (e) => {
      const t = e.target;
      if (!t.closest('.ly-dd-search')) return;
      if (e.key === 'Escape') { e.stopPropagation(); t.closest('.th-dd').classList.remove('open'); }
      else if (e.key === 'Enter') { e.preventDefault(); t.closest('.th-dd').querySelector('.th-dd-opt:not([hidden])')?.click(); }
    });
    host.addEventListener('click', (e) => {
      const t = e.target;
      const sw = t.closest('[data-ly-sw]');
      if (sw) { applySetting(sw.dataset.lySw, !opt[sw.dataset.lySw]); return; }
      if (t.closest('.ly-dd-search')) { e.stopPropagation(); return; }
      const trig = t.closest('.th-dd-trigger');
      if (trig) {
        e.stopPropagation();
        const dd = trig.parentElement;
        document.querySelectorAll('.ly-dd.open').forEach((o) => { if (o !== dd) o.classList.remove('open'); });
        const open = dd.classList.toggle('open');
        const inp = dd.querySelector('.ly-dd-search input');
        if (open && inp) {
          inp.value = '';
          dd.querySelectorAll('.th-dd-opt').forEach((o) => { o.hidden = false; });
          dd.querySelector('.th-dd-opt.selected')?.scrollIntoView({ block: 'nearest' });
          setTimeout(() => inp.focus(), 50);
        }
        return;
      }
      const o = t.closest('.th-dd-opt');
      if (o && o.closest('[data-ly-dd]')) {
        e.stopPropagation();
        const dd = o.closest('[data-ly-dd]');
        dd.classList.remove('open');
        applySetting(dd.dataset.lyDd, o.dataset.v);
      }
    });
    syncSettings();
    return host;
  }
  document.addEventListener('click', () => document.querySelectorAll('.ly-dd.open').forEach((d) => d.classList.remove('open')));

  // Settings land in the pane B1's tab system hands over; R.add (main view) when there is none.
  const paneAdd = (pane) => (html) => { if (!pane || !pane.append) return R.add(html); const n = R.el(html); pane.append(n); return n; };

  // Tracks tab
  R.addSettings((pane) => {
    const add = paneAdd(pane);
    add('<div class="section-title">Lyrics</div>');
    wireSettings(add(`<div class="th-group">
      ${S.toggle('tr', 'Lyrics translation', '')}
      ${S.dd('trLang', 'Translation language', '', LANGS.map((l) => [l[0], `${l[2]} ${l[1]} (${l[0]})`]), { needs: 'tr', search: true })}
      ${S.toggle('trAuto', 'Auto-translate', '', 'tr')}
      ${S.dd('ease', 'Lyrics animation', 'How the active line moves', Object.entries(EASINGS).map(([k, e]) => [k, e[0]]))}
      ${S.slider('speed', 'Lyrics animation speed', 5, 25, 1, ['0.5x (Slow)', '1.0x (Normal)', '2.5x (Fast)'])}
      ${S.dd('wordStyle', 'Word mode style', 'How the active line is highlighted in Word mode', [['gradient', 'Gradient'], ['words', 'Words']], { needs: 'karaoke' })}
      ${S.slider('tight', 'Gradient tightness', 2, 24, 2, ['2% (Sharp)', 'Default', '24% (Soft)'], 'karaoke')}
    </div>`));
  }, 'tracks');

  // Interface tab
  R.addSettings((pane) => {
    const add = paneAdd(pane);
    add('<div class="section-title">Karaoke</div>');
    wireSettings(add(`<div class="th-group">
      ${S.toggle('tvkViz', 'Visualizer in full karaoke mode', 'Show wave visualizer when track has no lyrics')}
      ${S.toggle('tvkVizLyrics', 'Visualizer with lyrics', 'Show wave visualizer at the bottom even when track has lyrics')}
    </div>`));
  }, 'interface');

  // Advanced tab
  R.addSettings((pane) => {
    const add = paneAdd(pane);
    add('<div class="section-title">Lyrics</div>');
    wireSettings(add(`<div class="th-group">
      ${S.toggle('online', 'Online lyrics lookup', 'Fetch synced and plain lyrics from LRCLIB')}
      ${S.toggle('karaoke', 'Karaoke word highlighting', 'Sweep across the active line as it is sung')}
      ${S.toggle('autoscroll', 'Auto-scroll synced lyrics', 'Smoothly follow the active lyric line during playback')}
    </div>`));
    const c = add(`<div class="set-card ly-set"><div class="i"><div class="a">Lyrics cache</div><div class="b ly-cache-info">Counting…</div></div>
      <div class="actions"><button class="btn outline" data-k="clear">Clear cache</button></div></div>`);
    const info = $('.ly-cache-info', c);
    const refresh = () => R.call('lyrics.stats')
      .then((st) => { info.textContent = `${R.plural(st.files, 'track')} cached · ${(st.bytes / 1024).toFixed(0)} KB · L toggles lyrics, F opens fullscreen karaoke`; })
      .catch(() => { info.textContent = ''; });
    refresh();
    $('[data-k=clear]', c).onclick = async () => {
      try {
        const r = await R.call('lyrics.clear_cache');
        cache.clear();
        trCache.clear();
        R.toast(`Cleared ${R.plural(r.removed, 'cached lyric')}`);
        refresh();
      } catch (e) { R.toast(R.errText(e), 'error'); }
    };
  }, 'advanced');

  // ------------------------------------------------------------ init

  syncPanel();
  R.on('ready', () => { if (R.player.current) loadFor(R.player.current); });

  // ------------------------------------------------------------ selftest

  R.addSelftest(async (log) => {
    const ok = (cond, msg) => log(`lyrics: ${cond ? 'OK' : 'FAILED'} ${msg}`);
    const until = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 100)); } return false; };
    try {
      const c1 = (await R.call('lyrics.clean', { title: 'Daft Punk - Get Lucky (Official Video) [free dl] prod. X', artist: 'Some Channel' })).candidates;
      ok(c1[0] && c1[0].artist === 'Daft Punk' && c1[0].title === 'Get Lucky', `clean "Artist - Title (Official Video) [free dl] prod.": ${JSON.stringify(c1[0])}`);

      const p = await R.call('lyrics.parse', { text: '[ar:x]\n[00:01.00]One\n[00:03.50]Two <00:04.00>words\n[00:06.00]שלום עולם' });
      ok(p.synced && p.lines.length === 3 && p.lines[1].text === 'Two words', `parse LRC: ${p.lines.length} lines`);
      ok(isRtl(p.lines[2].text) && !isRtl('Hello'), 'RTL detection');

      // Render + highlight in an off-screen view.
      const host = document.createElement('div');
      host.className = 'lyrics-container';
      host.style.cssText = 'position:fixed;left:-9999px;top:0;width:300px;height:300px;overflow:auto';
      document.body.append(host);
      const v = new LyricsView(host);
      v.render({ found: true, synced: true, lines: p.lines, plain: [] });
      v.update(3.6, true, true);
      ok(v.active === 1 && host.querySelector('.lyric-line.active')?.dataset.i === '1', `synced highlight at 3.6s -> line ${v.active}`);
      ok(host.querySelector('.lyric-line.rtl') !== null, 'RTL line rendered');
      v.render({ found: true, synced: false, lines: [], plain: ['a', '', 'b'] });
      ok(host.querySelectorAll('.lyric-line').length === 2 && host.querySelectorAll('.ly-break').length === 1, 'plain fallback render');
      host.remove();

      // Live lookup, then the cached path.
      const probe = { title: 'Rick Astley - Never Gonna Give You Up (Official Video)', artist: 'RickAstleyVEVO', duration: 213 };
      let t0 = performance.now();
      const r1 = await R.call('lyrics.get', probe);
      const ms1 = Math.round(performance.now() - t0);
      ok(r1.found && r1.synced, `lrclib lookup: found=${r1.found} synced=${r1.synced} lines=${r1.lines.length} match=${r1.matched ? `${r1.matched.artist} / ${r1.matched.title}` : '-'} (${ms1}ms)${r1.error ? ' error=' + r1.error : ''}`);
      t0 = performance.now();
      const r2 = await R.call('lyrics.get', probe);
      const ms2 = Math.round(performance.now() - t0);
      ok(r2.found === r1.found && ms2 < 150, `cached lookup ${ms2}ms`);
      const miss = await R.call('lyrics.get', { title: 'zzqx nonexistent track 93847', artist: 'nobody qqq', duration: 61 });
      ok(!miss.found, `unknown track -> not found${miss.error ? ' (error ' + miss.error + ')' : ''}`);

      if (R.player.current) {
        await until(() => !cur.loading, 10000);
        const d = cur.data;
        log(`lyrics: current "${R.player.current.title}" -> ${d ? (d.found ? (d.synced ? `synced ${d.lines.length} lines` : `plain ${d.plain.length} lines`) : 'No lyrics found') : 'none'} in ${cur.ms}ms; panel: ${panel.classList.contains('ly-on') ? 'lyrics' : panel.classList.contains('ly-none') ? 'empty state' : 'up next'}`);
      }
      openTv(true);
      ok(!tvEl.hidden && tv.open, 'TV karaoke opens');
      const vizExpect = cur.data && cur.data.found ? opt.tvkVizLyrics : opt.tvkViz;
      ok(tvEl.classList.contains('tvk-viz') === vizExpect, `TV visualizer ${vizExpect ? 'shown' : 'hidden'} (lyrics=${!!(cur.data && cur.data.found)}, analyser=${R.getAnalyser ? (R.getAnalyser('lyrics') ? 'yes' : 'null') : 'n/a'})`);
      if (!vizExpect) R.releaseAnalyser?.('lyrics');
      closeTv(true);
      ok(tvEl.hidden && !tv.open, 'TV karaoke closes');

      // Translation round trip (Google Translate via Rust), blank lines kept in place.
      t0 = performance.now();
      const tr = await R.call('lyrics.translate', { lines: ['Hello my friend', '', 'Good morning'], to: 'es' });
      const tl = tr.translations || [];
      ok(tl.length === 3 && tl[1] === '' && tl[0] && tl[0] !== 'Hello my friend' && /amigo/i.test(tl[0]), `translate en->es: ${JSON.stringify(tl)} (${Math.round(performance.now() - t0)}ms)`);
      t0 = performance.now();
      await R.call('lyrics.translate', { lines: ['Hello my friend', '', 'Good morning'], to: 'es' });
      ok(performance.now() - t0 < 100, `translate cached ${Math.round(performance.now() - t0)}ms`);
      ok(LANGS.length >= 130 && langLabel('ja').includes('Japanese'), `${LANGS.length} translation languages`);

      // Animation prefs: CSS vars + stored values, then Words style rendering; restore after.
      const saved = { ease: opt.ease, speed: opt.speed, tight: opt.tight, wordStyle: opt.wordStyle, sweep: opt.sweep, karaoke: opt.karaoke };
      const root = document.documentElement.style;
      applySetting('ease', 'expo');
      applySetting('speed', 2);
      applySetting('tight', 10);
      ok(root.getPropertyValue('--lyric-ease') === EASINGS.expo[1] && root.getPropertyValue('--lyric-duration') === '0.23s' && root.getPropertyValue('--lyric-fw') === '10%',
        `animation vars: ease=${root.getPropertyValue('--lyric-ease')} dur=${root.getPropertyValue('--lyric-duration')} fw=${root.getPropertyValue('--lyric-fw')}`);
      ok(R.load('lyrics.ease') === 'expo' && R.load('lyrics.speed') === 2 && R.load('lyrics.tight') === 10, 'animation prefs stored');
      setOpt('sweep', true); setOpt('karaoke', true); setOpt('wordStyle', 'words');
      const host2 = document.createElement('div');
      host2.className = 'lyrics-container';
      host2.style.cssText = 'position:fixed;left:-9999px;top:0;width:300px;height:300px;overflow:auto';
      document.body.append(host2);
      const v2 = new LyricsView(host2);
      v2.render({ found: true, synced: true, lines: [{ t: 1, text: 'One two' }, { t: 3, text: 'three four five six' }, { t: 7, text: 'end' }], plain: [] }, ['Uno dos', 'tres', '']);
      v2.update(5.1, true, true); // halfway through line 1 -> third word
      const act = host2.querySelector('.lyric-line.active .active-word');
      ok(host2.classList.contains('words') && act && act.textContent === 'five' && host2.querySelectorAll('.lyric-line.active .past-word').length === 2, `Words style: active word "${act ? act.textContent : '-'}"`);
      ok(host2.querySelectorAll('.lyric-translation').length === 2, 'translation lines rendered');
      setOpt('wordStyle', 'gradient');
      v2.render({ found: true, synced: true, lines: [{ t: 1, text: 'One two' }, { t: 3, text: 'three four five six' }, { t: 7, text: 'end' }], plain: [] });
      v2.update(5, true, true);
      const k = parseFloat(host2.querySelector('.lyric-line.active .lyric-fill')?.style.getPropertyValue('--k'));
      ok(host2.classList.contains('sweep') && k > 0.3 && k < 0.7, `Gradient style: k=${k} at mid-line`);
      setOpt('karaoke', false);
      v2.render({ found: true, synced: true, lines: [{ t: 1, text: 'One two' }], plain: [] });
      ok(!host2.classList.contains('sweep') && !host2.classList.contains('words'), 'karaoke highlighting off -> plain lines');
      host2.remove();
      for (const [key, v] of Object.entries(saved)) setOpt(key, v);
      applyAnim();
      rerender();

      const st = await R.call('lyrics.stats');
      log(`lyrics: cache ${st.files} files on disk, ${st.memory} in memory`);
    } catch (e) {
      log(`lyrics: FAILED selftest error ${R.errText(e)}`);
    }
  });
})();
