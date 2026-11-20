'use strict';
// Now playing panel (right side): riff's newest panel blended with Spotify's Now Playing view.
//  - cover: "Large" (full panel width, title + artist over a soft bottom shade) or "Shaped" (a centred
//    cover morphing between the Material 3 shapes from shapes.js); title and artist marquee when long
//  - left or centre alignment, the lyrics toolbar on top, lyrics / up next below the cover
//  - cards: About the artist (image, followers, bio, Follow), Credits, Next in queue
//  - a soft glow visualizer behind the cover and lyrics, fed by riff.getAnalyser('nowplaying')
//    (the fx.js visualizer tap; no second audio graph)
//  - a cover-colour wash at the top of the main view (playlist / mix / artist header, or the playing
//    track on list pages)
(() => {
  const R = window.riff;
  if (!R) return;
  const $ = (s, root = document) => root.querySelector(s);
  const esc = R.esc;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const isSc = (t) => !!t && !t.source && /^\d+$/.test(String(t.id || ''));
  const isYt = (t) => !!t && (t.source === 'youtube' || /^yt:/.test(String(t.id || '')));
  const hasArtist = (t) => !!t && (!!t.artist_id || !!t.artist_url || (!!t.artist && !/^unknown artist$/i.test(t.artist)));
  const compact = (n) => { try { return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n || 0); } catch (e) { return String(n || 0); } };
  const openUrl = (url) => R.invoke('plugin:opener|open_url', { url }).catch(() => R.toast("Couldn't open the link", 'error'));
  const svg = (body) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
  const IC = {
    ext: svg('<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>'),
    cloud: svg('<path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/>'),
    yt: svg('<rect x="2" y="5" width="20" height="14" rx="4"/><polygon points="10 9 15 12 10 15" fill="currentColor"/>'),
    file: svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>'),
  };

  const PREF = {
    cover: ['npCover', 'large'],       // 'large' | 'shaped'
    align: ['npAlign', 'left'],        // 'left' | 'center'
    glow: ['npGlow', !/X11; Linux/.test(navigator.userAgent)], // Web Audio glow: off by default on WebKitGTK
    intensity: ['npGlowIntensity', 60],
    tint: ['npTint', true],
    next: ['npShowNext', true],        // show the "Up next" list in the panel
    panel: ['npPanel', 'full'],        // 'full' | 'cover' (just the cover, nothing under it)
    artist: ['npShowArtist', true],    // each card can be hidden on its own
    credits: ['npShowCredits', true],
    queue: ['npShowQueue', true],
  };
  const pref = (k) => R.pref(PREF[k][0], PREF[k][1]);
  const motionOff = () => document.body.classList.contains('perf') || document.body.classList.contains('reduce-motion');

  // ------------------------------------------------------------ colours (one readable colour per image, cached)

  const COLOR_KEY = 'np.colors';
  let diskColors = R.load(COLOR_KEY, {});
  if (!diskColors || typeof diskColors !== 'object' || Array.isArray(diskColors)) diskColors = {};
  const memColors = new Map();
  // SoundCloud artwork: analyse the 100x100 variant.
  const thumbOf = (url) => String(url || '').replace(/-(t\d+x\d+|large|crop|original)\.(jpg|jpeg|png|webp)/i, '-large.$2');

  function hexToRgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
    if (!d) return [0, 0, l];
    const s = d / (1 - Math.abs(2 * l - 1));
    let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
    return [h, s, l];
  }
  function analyse(data) {
    if (R.theme && R.theme.analyzePixels) {
      const res = R.theme.analyzePixels(data);
      const a = hexToRgb(res.accent), b = hexToRgb(res.accent2);
      if (a) return { a, b: b || a };
    }
    let r = 0, g = 0, bl = 0;
    const n = data.length / 4;
    for (let i = 0; i < data.length; i += 4) { r += data[i]; g += data[i + 1]; bl += data[i + 2]; }
    const avg = [r / n, g / n, bl / n].map(Math.round);
    return { a: avg, b: avg };
  }
  /** -> Promise<{ a: [h,s,l], b: [h,s,l] } | null> (raw colours; shade() makes them readable). */
  function coverColor(url) {
    if (!url) return Promise.resolve(null);
    const src = thumbOf(url);
    if (memColors.has(src)) return memColors.get(src);
    if (diskColors[src]) { const v = Promise.resolve(diskColors[src]); memColors.set(src, v); return v; }
    const job = new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.decoding = 'async';
      img.onload = () => {
        try {
          const c = document.createElement('canvas');
          c.width = c.height = 32;
          const ctx = c.getContext('2d', { willReadFrequently: true });
          ctx.drawImage(img, 0, 0, 32, 32);
          const { a, b } = analyse(ctx.getImageData(0, 0, 32, 32).data);
          const res = { a: rgbToHsl(...a), b: rgbToHsl(...b) };
          if (!src.startsWith('data:') && !src.startsWith('blob:')) {
            diskColors[src] = res;
            const keys = Object.keys(diskColors);
            if (keys.length > 250) for (const k of keys.slice(0, keys.length - 250)) delete diskColors[k];
            R.store(COLOR_KEY, diskColors);
          }
          resolve(res);
        } catch (e) { resolve(null); } // tainted canvas (no CORS) -> no tint
      };
      img.onerror = () => resolve(null);
      img.src = src;
    });
    memColors.set(src, job);
    if (memColors.size > 150) memColors.delete(memColors.keys().next().value);
    return job;
  }
  const hasCls = (c) => document.documentElement.classList.contains(c) || document.body.classList.contains(c);
  /** A readable shade of [h, s, l]: muted and fairly dark on dark themes, pale on light ones. */
  function shade(hsl, boost = 0) {
    if (!hsl) return '';
    const [h, s0] = hsl;
    let s = Math.min(0.62, s0 * (hasCls('th-glass') ? 0.6 : 0.9));
    if (s0 < 0.08) s = 0; // greyscale covers stay grey
    const l = hasCls('th-light') ? 0.76 : Math.min(0.52, 0.36 + boost);
    return `hsl(${Math.round(h)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%)`;
  }
  const urlOf = (el) => {
    const m = el && /url\(["']?([^"')]+)["']?\)/.exec(el.style.backgroundImage || '');
    return m ? m[1] : '';
  };

  // ------------------------------------------------------------ panel layout

  const panel = $('#right-panel');
  const artBox = $('.rp-art-box', panel);
  const artEl = $('#rp-art');
  const meta = $('.rp-meta', panel);
  const titleEl = $('#rp-title');
  const artistEl = $('#rp-artist');
  panel.classList.add('np-on');

  // The cover, lyrics / up next and the cards scroll together under the fixed toolbar.
  const scroller = R.el('<div class="np-scroll"></div>');
  const glowCv = R.el('<canvas class="np-glow" width="48" height="96" aria-hidden="true"></canvas>');
  artBox.before(scroller);
  for (const n of [...panel.children]) {
    if (n === scroller || n.id === 'rp-banner' || n.classList.contains('ly-bar')) continue;
    scroller.append(n);
  }
  scroller.before(glowCv);
  const shadeEl = R.el('<div class="np-cover-shade" aria-hidden="true"></div>');
  artEl.after(shadeEl);
  shadeEl.after(meta);
  // Shaped covers clip to an SVG path in objectBoundingBox units.
  const defs = R.el('<svg class="np-defs" width="0" height="0" aria-hidden="true"><clipPath id="np-shape" clipPathUnits="objectBoundingBox"><path d="M0 0H1V1H0Z"/></clipPath></svg>');
  document.body.append(defs);
  const shapePath = defs.querySelector('path');

  const cards = R.el(`<div class="np-cards">
    <section class="np-card np-artist" hidden>
      <div class="np-a-img"><span class="np-a-label">About the artist</span><button class="np-hide" type="button" data-hide="artist" title="Hide this card" aria-label="Hide this card">×</button></div>
      <div class="np-a-body">
        <div class="np-a-name" role="link" tabindex="0"></div>
        <div class="np-a-row"><div class="np-a-stats"></div><button class="np-follow" type="button" title="Follow on SoundCloud">Follow</button></div>
        <div class="np-a-bio" hidden></div>
      </div>
    </section>
    <section class="np-card np-credits" hidden>
      <div class="np-card-head"><span class="np-card-title">Credits</span><button class="np-link np-c-open" type="button">Show artist</button><button class="np-hide" type="button" data-hide="credits" title="Hide this card" aria-label="Hide this card">×</button></div>
      <div class="np-c-person"></div>
      <div class="np-c-source"></div>
    </section>
    <section class="np-card np-queue" hidden>
      <div class="np-card-head"><span class="np-card-title">Next in queue</span><button class="np-link np-q-open" type="button">Open queue</button><button class="np-hide" type="button" data-hide="queue" title="Hide this card" aria-label="Hide this card">×</button></div>
      <div class="np-q-row" role="button" tabindex="0"><div class="np-q-art"></div><div class="np-q-text"><div class="np-q-title"></div><div class="np-q-artist"></div></div></div>
    </section>
  </div>`);
  scroller.append(cards);
  const artistCard = $('.np-artist', cards), creditsCard = $('.np-credits', cards), queueCard = $('.np-queue', cards);

  function applyLayout() {
    const shaped = pref('cover') === 'shaped';
    panel.classList.toggle('np-shaped', shaped);
    panel.classList.toggle('np-large', !shaped);
    panel.classList.toggle('np-center', pref('align') === 'center');
    fitTitle();
    morph.kick();
    sizeGlow();
  }

  // ------------------------------------------------------------ title / artist marquee

  // app.js sets #rp-title / #rp-artist with textContent; wrap the text in a span the marquee can move.
  function wrap(el) {
    const f = el.firstChild;
    if (f && f.nodeType === 1 && f.classList.contains('np-inner') && el.childNodes.length === 1) return;
    const txt = el.textContent;
    const span = document.createElement('span');
    span.className = 'np-inner';
    span.textContent = txt;
    el.replaceChildren(span);
  }
  let fitRaf = 0;
  function fitTitle() {
    if (fitRaf) return;
    fitRaf = requestAnimationFrame(() => {
      fitRaf = 0;
      for (const el of [titleEl, artistEl]) {
        wrap(el);
        const inner = el.firstChild;
        el.classList.remove('np-marquee');
        const extra = inner.scrollWidth - el.clientWidth;
        if (el.clientWidth > 20 && extra > 2) {
          const dist = Math.ceil(extra + 16);
          el.style.setProperty('--np-dist', `-${dist}px`);
          el.style.setProperty('--np-dur', `${Math.max(8, Math.min(22, 6 + dist / 22)).toFixed(1)}s`);
          el.classList.add('np-marquee');
        }
      }
    });
  }
  const mo = new MutationObserver(() => fitTitle());
  mo.observe(titleEl, { childList: true, characterData: true, subtree: true });
  mo.observe(artistEl, { childList: true, characterData: true, subtree: true });
  new ResizeObserver(() => { fitTitle(); sizeGlow(); }).observe(panel);

  // ------------------------------------------------------------ shaped cover morph (shapes.js profiles)

  // Hold a shape for a few seconds, then morph to the next over ~1.2 s at <= 30 fps; only while playing,
  // the panel is visible and the window is awake. Nothing runs while holding (a plain timer).
  const morph = {
    from: 0, to: 0, start: 0, timer: 0, loop: 0, HOLD: 4200, MS: 1200, ok: false,
    draw(e) {
      const S = window.RiffShapes;
      const a = S.profile(this.from), b = S.profile(this.to), K = S.K;
      let d = '';
      for (let k = 0; k < K; k += 3) {
        const th = -Math.PI + (Math.PI * 2 * k) / K;
        const r = (a[k] + (b[k] - a[k]) * e) / 160 * 0.5;
        const x = 0.5 + Math.cos(th) * r, y = 0.5 + Math.sin(th) * r;
        d += `${k ? 'L' : 'M'}${x.toFixed(4)} ${y.toFixed(4)}`;
      }
      shapePath.setAttribute('d', d + 'Z');
    },
    wanted() { return panel.classList.contains('np-shaped') && !R.audio.paused && !R.asleep && !motionOff() && panel.offsetParent !== null; },
    tick(now) {
      this.loop = 0;
      const S = window.RiffShapes;
      const p = Math.min(1, (now - this.start) / this.MS);
      this.draw(S.ease(p));
      if (p < 1) { this.loop = R.nextFrame((t) => this.tick(t), R.FPS_PLAYING); return; }
      this.from = this.to;
      this.schedule();
    },
    schedule() {
      clearTimeout(this.timer);
      if (!this.wanted()) return;
      this.timer = setTimeout(() => {
        if (!this.wanted() || this.loop) return;
        this.to = window.RiffShapes.next(this.from);
        this.start = performance.now();
        this.loop = R.nextFrame((t) => this.tick(t), R.FPS_PLAYING);
      }, this.HOLD);
    },
    kick() {
      const S = window.RiffShapes;
      if (!panel.classList.contains('np-shaped') || !S || !S.ready() || !S.count()) return;
      if (!this.ok) { this.ok = true; this.from = this.to = Math.floor(Math.random() * S.count()); this.draw(0); }
      if (!this.loop) this.schedule();
    },
  };

  // ------------------------------------------------------------ cards

  const A = { track: null, key: '', data: null, loading: false, seq: 0, cache: new Map() };
  const artistKey = (t) => (t ? String(t.artist_id || t.artist_url || (t.artist || '').toLowerCase()) : '');
  const sourceOf = (t) => (t.source === 'local' ? ['My files', IC.file] : isYt(t) ? ['YouTube', IC.yt] : ['SoundCloud', IC.cloud]);
  function yearOf(t) {
    const y = t.year || t.release_year || String(t.release_date || t.created_at || t.display_date || '').slice(0, 4);
    return /^(19|20)\d\d$/.test(String(y)) ? String(y) : '';
  }
  const canOpenArtist = (t) => hasArtist(t) && !isYt(t) && t.source !== 'local';

  function paintCredits(t) {
    creditsCard.hidden = !t;
    if (!t) return;
    const role = isYt(t) ? 'Channel' : t.source === 'local' ? 'Artist' : 'Main artist';
    $('.np-c-person', creditsCard).innerHTML = `<div class="np-c-name${canOpenArtist(t) ? ' link' : ''}">${esc(t.artist || 'Unknown artist')}</div><div class="np-c-role">${role}</div>`;
    const [src, icon] = sourceOf(t);
    const facts = [t.genre || t.style, yearOf(t)].filter(Boolean).map(esc).join(' · ');
    $('.np-c-source', creditsCard).innerHTML = `<div class="np-c-label">Source</div><div class="np-c-badge">${icon}<span>${src}</span></div>${facts ? `<div class="np-c-facts">${facts}</div>` : ''}`;
    $('.np-c-open', creditsCard).hidden = !canOpenArtist(t);
  }

  function paintArtist() {
    const t = A.track;
    // Spotify's card needs an artist with a profile: SoundCloud only. YouTube / local tracks keep the credits card.
    const show = !!t && isSc(t) && hasArtist(t);
    artistCard.hidden = !show;
    paintCredits(t);
    if (!show) return;
    const a = A.data;
    const img = $('.np-a-img', artistCard);
    const pic = a && (a.banner || a.avatar);
    img.style.backgroundImage = pic ? `url('${pic}')` : '';
    img.classList.toggle('wide', !!(a && a.banner));
    img.classList.toggle('empty', !pic);
    $('.np-a-name', artistCard).textContent = (a && a.name) || t.artist || 'Unknown artist';
    let stats = '';
    if (a) {
      const where = [a.city, a.country].filter(Boolean).join(', ');
      stats = [`${compact(a.followers)} followers`, where].filter(Boolean).join(' · ');
    } else if (A.loading) stats = 'Loading…';
    $('.np-a-stats', artistCard).textContent = stats;
    const bio = $('.np-a-bio', artistCard);
    const text = a && a.description ? a.description.trim() : '';
    bio.hidden = !text;
    bio.textContent = text;
    bio.classList.remove('open');
    // Real follow when signed in (discover.follow); otherwise the button opens the SoundCloud page.
    const fb = $('.np-follow', artistCard);
    fb.hidden = !(a && (a.id || a.url));
    const on = !!(a && a.following === true);
    fb.textContent = on ? 'Following' : 'Follow';
    fb.classList.toggle('on', on);
    fb.title = a && a.following == null ? 'Follow on SoundCloud' : on ? 'Unfollow' : 'Follow';
    artistCard.classList.toggle('loaded', !!a);
  }

  async function loadArtist(t, force) {
    const key = artistKey(t);
    if (!t || !isSc(t) || !hasArtist(t)) { A.loading = false; paintArtist(); return null; }
    if (!force && A.cache.has(key)) { A.data = A.cache.get(key); A.key = key; paintArtist(); return A.data; }
    const seq = ++A.seq;
    A.loading = true; A.key = key; paintArtist();
    try {
      const a = await R.call('discover.artist', { id: t.artist_id || '', url: t.artist_url || '', trackId: t.id, name: t.artist || '' });
      const slim = a && { id: a.id, name: a.name, avatar: a.avatar, banner: a.banner, followers: a.followers, description: a.description, city: a.city, country: a.country, url: a.url, following: a.following };
      A.cache.set(key, slim);
      if (A.cache.size > 60) A.cache.delete(A.cache.keys().next().value);
      if (seq !== A.seq) return slim;
      A.data = slim;
    } catch (e) {
      if (seq !== A.seq) return null;
      A.data = null;
    }
    A.loading = false;
    paintArtist();
    return A.data;
  }

  // Load the artist only once its card is (nearly) on screen: discover.artist makes several API calls.
  let cardSeen = false;
  new IntersectionObserver((ents) => {
    cardSeen = ents.some((e) => e.isIntersecting);
    if (cardSeen && A.track && artistKey(A.track) !== A.key && !A.loading) loadArtist(A.track);
  }, { root: scroller, rootMargin: '0px 0px 240px 0px' }).observe(artistCard);

  cards.addEventListener('click', (e) => {
    const hide = e.target.closest('.np-hide');
    if (hide) { e.stopPropagation(); R.setPref(PREF[hide.dataset.hide][0], false); applyNext(); R.toast('Hidden. Bring it back in Settings > Interface'); return; }
    const t = A.track;
    if (e.target.closest('.np-follow')) {
      const a = A.data;
      if (!a) return;
      // following === null means logged out / unknown: fall back to the SoundCloud page.
      if (a.following == null || !a.id) { if (a.url) openUrl(a.url); return; }
      const want = !a.following;
      R.call('discover.follow', { id: a.id, on: want }).then((r) => {
        a.following = !!(r && r.following);
        paintArtist();
        R.toast(a.following ? `Following ${a.name}` : `Unfollowed ${a.name}`);
      }).catch((err) => R.toast(R.errText(err), 'error'));
      return;
    }
    if (e.target.closest('.np-a-name, .np-c-name.link, .np-c-open')) { if (t && canOpenArtist(t)) R.emit('artist', t); return; }
    const bio = e.target.closest('.np-a-bio');
    if (bio) { bio.classList.toggle('open'); return; }
    if (e.target.closest('.np-q-open')) { R.go('queue'); return; }
    if (e.target.closest('.np-q-row')) $('#rp-next-list .mini-row[data-i="0"]')?.click(); // app.js plays it
  });

  // Next in queue: mirrors the first row of app.js' up-next list (it re-renders on every queue change).
  function paintQueue() {
    const n = R.upcoming(1)[0];
    queueCard.hidden = !n;
    if (!n) return;
    $('.np-q-art', queueCard).style.backgroundImage = n.artwork ? `url('${R.art(n.artwork, 48)}')` : '';
    $('.np-q-title', queueCard).textContent = n.title || '';
    $('.np-q-artist', queueCard).textContent = n.artist || '';
  }
  const nextList = $('#rp-next-list');
  if (nextList) new MutationObserver(() => paintQueue()).observe(nextList, { childList: true });

  // ------------------------------------------------------------ track changes

  const lastTint = { fromTrack: false, seq: 0 };
  let trackTimer = 0;
  function onTrack(t) {
    // Sharper cover than app.js' 220px variant: the cover spans the panel now.
    if (t && t.artwork) artEl.style.backgroundImage = `url('${R.art(t.artwork, 340)}')`;
    panel.classList.toggle('np-empty', !t);
    fitTitle();
    const changed = artistKey(t) !== artistKey(A.track);
    A.track = t || null;
    if (changed) { A.data = null; A.key = ''; A.seq++; A.loading = false; }
    paintArtist();
    paintQueue();
    clearTimeout(trackTimer);
    if (changed && t && cardSeen) trackTimer = setTimeout(() => { if (A.track === t) loadArtist(t); }, 350);
    setGlowColor(t);
    if (lastTint.fromTrack) applyTint();
  }
  R.on('trackchange', onTrack);

  // ------------------------------------------------------------ cover-colour wash at the top of the main view

  const TRACK_PAGES = new Set(['likes', 'queue', 'history', 'downloads', 'files', 'playlists']);
  function pageCover(view) {
    const v = R.view;
    for (const sel of ['.hero .cover', '.dc-avatar', '.dc-ahero-bg', '[data-np-cover]']) {
      const el = v.querySelector(sel);
      const url = el && (el.dataset.npCover || urlOf(el));
      if (url) return { url, fromTrack: false };
    }
    if (TRACK_PAGES.has(view) && R.player.current && R.player.current.artwork) return { url: R.player.current.artwork, fromTrack: true };
    return null;
  }
  function applyTint() {
    const v = R.view;
    const view = R.state.view;
    const src = pref('tint') && view !== 'settings' ? pageCover(view) : null;
    lastTint.fromTrack = !!(src && src.fromTrack);
    const seq = ++lastTint.seq;
    let el = v.querySelector(':scope > .np-tint');
    if (!src) { if (el) el.remove(); v.classList.remove('np-tinted'); return; }
    coverColor(src.url).then((c) => {
      if (seq !== lastTint.seq) return;
      el = v.querySelector(':scope > .np-tint');
      if (!c) { if (el) el.remove(); v.classList.remove('np-tinted'); return; }
      const color = shade(c.a);
      if (!el) {
        el = R.el('<div class="np-tint" aria-hidden="true"></div>');
        el.style.setProperty('--np-tint', color);
        v.prepend(el);
        v.classList.add('np-tinted');
        requestAnimationFrame(() => el.classList.add('show'));
      } else el.style.setProperty('--np-tint', color);
      el.dataset.src = thumbOf(src.url);
    });
  }
  R.on('render', () => applyTint());
  R.on('theme', () => { applyTint(); setGlowColor(A.track); });

  // ------------------------------------------------------------ glow visualizer behind the cover and lyrics

  // A tiny canvas (48 px wide) stretched over the panel: the browser's upscaling does the blur for free.
  // Redrawn at <= 30 fps while playing; stops when paused, when the panel is hidden and while asleep.
  const gctx = glowCv.getContext('2d', { willReadFrequently: true });
  const G = { loop: 0, frames: 0, energy: 0, mid: 0, t: 0, colA: '', colB: '', freq: null, held: false, W: 48, H: 96 };
  function sizeGlow() {
    const w = panel.clientWidth, h = panel.clientHeight;
    if (!w || !h) return;
    const H = Math.max(24, Math.min(160, Math.round(48 * h / w)));
    if (glowCv.height !== H) { glowCv.height = H; }
    G.W = glowCv.width; G.H = glowCv.height;
  }
  function setGlowColor(t) {
    const url = t && t.artwork;
    if (!url) { G.colA = G.colB = ''; return; }
    coverColor(url).then((c) => {
      if (A.track !== t) return;
      G.colA = c ? shade(c.a, 0.2) : '';
      G.colB = c ? shade(c.b, 0.14) : '';
    });
  }
  function glowWanted() {
    return pref('glow') && !R.asleep && !R.audio.paused && !document.body.classList.contains('perf') && panel.offsetParent !== null;
  }
  function drawGlow(an) {
    const W = G.W, H = G.H;
    const k = Math.max(0, Math.min(100, pref('intensity'))) / 100;
    let bass = 0, mid = 0;
    if (an) {
      if (!G.freq || G.freq.length !== an.frequencyBinCount) G.freq = new Uint8Array(an.frequencyBinCount);
      an.getByteFrequencyData(G.freq);
      const f = G.freq, n = Math.min(f.length, 24);
      for (let i = 0; i < 4; i++) bass += f[i];
      for (let i = 5; i < n; i++) mid += f[i];
      bass /= 4 * 255; mid /= Math.max(1, n - 5) * 255;
    }
    G.energy += (bass - G.energy) * 0.35;
    G.mid += (mid - G.mid) * 0.25;
    G.t += 1 / 30;
    // Centre the orb on the cover (it scrolls with the panel content).
    const pr = panel.getBoundingClientRect(), ar = artEl.getBoundingClientRect();
    const sx = W / (pr.width || 1), sy = H / (pr.height || 1);
    const cx0 = (ar.left + ar.width / 2 - pr.left) * sx, cy0 = (ar.top + ar.height / 2 - pr.top) * sy;
    const base = Math.max(ar.width * sx, 8);
    gctx.clearRect(0, 0, W, H);
    const a = G.colA || 'hsl(0 0% 70%)', b = G.colB || a;
    gctx.globalCompositeOperation = 'lighter';
    const r1 = base * (0.62 + 0.3 * G.energy * (0.5 + k));
    let g = gctx.createRadialGradient(cx0, cy0, 0, cx0, cy0, r1);
    gctx.globalAlpha = Math.min(1, (0.3 + 0.7 * G.energy) * (0.3 + k * 0.85));
    g.addColorStop(0, a); g.addColorStop(1, 'rgba(0,0,0,0)');
    gctx.fillStyle = g; gctx.fillRect(0, 0, W, H);
    // A second orb in the cover's second colour drifts below the cover (over the lyrics), following the mids.
    const ang = G.t * 0.33;
    const cx = cx0 + Math.cos(ang) * base * 0.28, cy = cy0 + base * 0.55 + Math.sin(ang * 1.3) * base * 0.25;
    const r2 = base * (0.5 + 0.3 * G.mid * (0.5 + k));
    g = gctx.createRadialGradient(cx, cy, 0, cx, cy, r2);
    gctx.globalAlpha = Math.min(1, (0.2 + 0.8 * G.mid) * (0.3 + k * 0.75));
    g.addColorStop(0, b); g.addColorStop(1, 'rgba(0,0,0,0)');
    gctx.fillStyle = g; gctx.fillRect(0, 0, W, H);
    gctx.globalAlpha = 1;
    gctx.globalCompositeOperation = 'source-over';
    G.frames++;
  }
  function glowTick() {
    G.loop = 0;
    if (!glowWanted()) { stopGlow(); return; }
    G.held = true;
    drawGlow(R.getAnalyser ? R.getAnalyser('nowplaying') : null);
    glowCv.classList.add('on');
    G.loop = R.nextFrame(glowTick, R.FPS_PLAYING);
  }
  function stopGlow() {
    glowCv.classList.remove('on');
    if (G.held) { R.releaseAnalyser?.('nowplaying'); G.held = false; }
    G.energy = 0; G.mid = 0;
  }
  function kick() {
    panel.classList.toggle('np-paused', R.audio.paused);
    morph.kick();
    if (G.loop) return;
    if (glowWanted()) G.loop = R.nextFrame(glowTick, R.FPS_PLAYING);
    else stopGlow();
  }
  R.audio.addEventListener('playing', kick);
  R.audio.addEventListener('pause', kick);
  R.on('visibility', kick);
  R.on('pref', ({ key }) => {
    if (key === PREF.glow[0]) kick();
    else if (key === PREF.tint[0]) applyTint();
    else if (key === PREF.cover[0] || key === PREF.align[0]) applyLayout();
  });

  // ------------------------------------------------------------ settings

  function settings(pane) {
    const S = R.settingsRow;
    // Cover / alignment / tint: their own group; the glow sits with the other visualizer rows.
    S.group([
      S.select({ name: 'Now playing cover', desc: 'Large fills the panel with the title on the cover; Shaped morphs between expressive shapes',
        options: [['large', 'Large'], ['shaped', 'Shaped']], value: pref('cover'), onChange: (v) => R.setPref(PREF.cover[0], v) }),
      S.select({ name: 'Now playing alignment', options: [['left', 'Left'], ['center', 'Centre']], value: pref('align'), onChange: (v) => R.setPref(PREF.align[0], v) }),
      S.prefToggle(PREF.tint[0], PREF.tint[1], 'Tint pages with the cover colour', 'A soft colour wash at the top of playlists, mixes and artist pages'),
      S.select({ name: 'Now playing panel', desc: 'Cover only shows just the big cover with the title, nothing under it',
        options: [['full', 'Full'], ['cover', 'Cover only']], value: pref('panel'), onChange: (v) => R.setPref(PREF.panel[0], v) }),
      S.prefToggle(PREF.next[0], PREF.next[1], 'Show up next in the panel', 'The list of upcoming songs under the cover. Click its heading to fold it'),
      S.prefToggle(PREF.artist[0], PREF.artist[1], 'Show About the artist', 'Artist picture, followers, bio and Follow'),
      S.prefToggle(PREF.credits[0], PREF.credits[1], 'Show credits', 'Artist, source, genre and year'),
      S.prefToggle(PREF.queue[0], PREF.queue[1], 'Show next in queue', 'The next song you queued yourself'),
    ], 'np-settings');
    const rows = [
      S.prefToggle(PREF.glow[0], PREF.glow[1], 'Glow behind the now playing cover', 'A soft light behind the cover and lyrics that moves with the music'),
      S.slider({ name: 'Glow intensity', min: 0, max: 100, step: 5, value: pref('intensity'), format: (v) => `${v}%`, reset: PREF.intensity[1],
        onInput: (v) => R.setPref(PREF.intensity[0], v), onChange: (v) => R.setPref(PREF.intensity[0], v) }),
    ];
    const groups = (pane || document).querySelectorAll('[data-group="interface-visualizer"]');
    const g = groups[groups.length - 1];
    if (g) rows.forEach((r) => g.append(r)); else S.group(rows);
  }
  // ------------------------------------------------------------ up next: hide (setting) or fold (click the heading)

  function applyNext() {
    const rp = document.getElementById('right-panel');
    if (!rp) return;
    rp.classList.toggle('np-next-off', !pref('next'));
    rp.classList.toggle('np-cover-only', pref('panel') === 'cover');
    rp.classList.toggle('np-no-artist', !pref('artist'));
    rp.classList.toggle('np-no-credits', !pref('credits'));
    rp.classList.toggle('np-no-queue', !pref('queue'));
    rp.classList.toggle('np-next-folded', R.load('npNextFolded', false));
    const head = rp.querySelector('.rp-next-title');
    if (head && !head.dataset.npFold) {
      head.dataset.npFold = '1';
      head.setAttribute('role', 'button');
      head.tabIndex = 0;
      head.title = 'Fold or unfold up next';
      head.insertAdjacentHTML('beforeend', `<span class="np-fold">${svg('<polyline points="6 9 12 15 18 9"/>')}</span>`);
      const toggle = () => { R.store('npNextFolded', !R.load('npNextFolded', false)); applyNext(); };
      head.addEventListener('click', toggle);
      head.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
    }
  }
  const PANEL_KEYS = ['next', 'panel', 'artist', 'credits', 'queue'].map((k) => PREF[k][0]);
  R.on('pref', (p) => { if (p && PANEL_KEYS.includes(p.key)) applyNext(); });
  if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', applyNext); else applyNext();

  // Registered once every feature script ran, so the playbar visualizer group already exists.
  const regSettings = () => R.addSettings(settings, 'interface');
  if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', regSettings); else regSettings();

  applyLayout();
  onTrack(R.player.current);
  kick();

  // ------------------------------------------------------------ selftest (audio muted)

  R.addSelftest(async (log) => {
    const ok = (c) => (c ? 'OK' : 'FAILED');
    const until = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await wait(100); } return false; };
    const prevView = R.state.view, prevArg = R.state.arg;
    const saved = { cover: pref('cover'), align: pref('align'), glow: pref('glow') };
    try {
      R.setPref(PREF.cover[0], 'large'); R.setPref(PREF.glow[0], true);
      // 1. a SoundCloud track playing
      let t = R.player.current;
      if (!isSc(t) || !t.artwork || !hasArtist(t)) {
        await until(() => R.state.trending, 15000);
        t = (R.state.trending || []).find((x) => isSc(x) && x.artwork && hasArtist(x)) || t;
        if (t && t !== R.player.current) R.playTrack(t);
      }
      if (!t) { log('nowplaying: skipped (no track to play)'); return; }
      await until(() => R.player.current === t, 10000);
      if (R.audio.paused) R.audio.play().catch(() => {});
      const playing = await until(() => !R.audio.paused && R.audio.currentTime > 0.2, 20000);
      await wait(400);

      // 2. panel: large cover, overlaid title, toolbar, cards
      const coverOk = /url\(/.test(artEl.style.backgroundImage) && artEl.offsetWidth >= scroller.clientWidth - 24;
      const tr = titleEl.getBoundingClientRect(), ar = artEl.getBoundingClientRect();
      const inside = artBox.contains(meta) && tr.bottom <= ar.bottom + 1 && tr.top >= ar.top && tr.width > 0;
      log(`nowplaying panel cover ${ok(coverOk)}: ${artEl.offsetWidth}x${artEl.offsetHeight} in a ${panel.clientWidth}px panel`);
      log(`nowplaying panel title overlay ${ok(inside && titleEl.textContent === t.title)}: "${titleEl.textContent}" at ${Math.round(tr.top - ar.top)}px of ${Math.round(ar.height)}px, marquee ${titleEl.classList.contains('np-marquee')}`);
      log(`nowplaying toolbar ${ok(panel.querySelectorAll('.ly-bar .ly-tab').length === 2 && panel.querySelector('.ly-bar').offsetParent !== null)}`);
      const t0 = performance.now();
      const a = await loadArtist(t, true);
      const name = $('.np-a-name', artistCard).textContent;
      log(`nowplaying artist card ${ok(a && !artistCard.hidden && name === a.name && /followers/.test($('.np-a-stats', artistCard).textContent))}: "${name}" ${a ? compact(a.followers) : '?'} followers, bio ${a && a.description ? a.description.length : 0} chars, ${a && a.banner ? 'banner' : a && a.avatar ? 'avatar' : 'no image'}, follow ${!$('.np-follow', artistCard).hidden} (${Math.round(performance.now() - t0)}ms)`);
      log(`nowplaying credits ${ok(!creditsCard.hidden && $('.np-c-name', creditsCard).textContent === t.artist && /SoundCloud/.test($('.np-c-source', creditsCard).textContent))}: ${creditsCard.textContent.replace(/\s+/g, ' ').trim()}`);
      const nx = R.upcoming(1)[0];
      log(`nowplaying next in queue ${ok(nx ? !queueCard.hidden && $('.np-q-title', queueCard).textContent === nx.title : queueCard.hidden)}: ${nx ? nx.title : 'nothing queued'}`);

      // 3. tint on a playlist page
      const pl = (R.state.scPlaylists || []).find((p) => p.artwork);
      const lp = (R.state.library?.playlists || []).find((p) => p.tracks && p.tracks[0] && p.tracks[0].artwork);
      if (pl) R.go('sc', pl.id); else if (lp) R.go('local', lp.id); else R.go('likes');
      const tinted = await until(() => { const e = R.view.querySelector(':scope > .np-tint'); return e && e.style.getPropertyValue('--np-tint'); }, 8000);
      const te = R.view.querySelector(':scope > .np-tint');
      log(`nowplaying tint ${ok(tinted && te.offsetHeight >= 200)}: ${R.state.view} -> ${te ? te.style.getPropertyValue('--np-tint') : 'none'} (${te ? te.offsetHeight : 0}px)`);
      const t1 = performance.now();
      await coverColor(te ? te.dataset.src : '');
      log(`nowplaying tint cache ${ok(te && performance.now() - t1 < 20)}: ${(performance.now() - t1).toFixed(1)}ms`);
      await wait(1500); // tinted page + large panel stay up for a screenshot

      // 4. glow draws non-empty frames while playing
      if (playing) {
        if (R.audio.paused) { R.audio.play().catch(() => {}); await until(() => !R.audio.paused, 5000); }
        const f0 = G.frames;
        await wait(1500);
        const px = gctx.getImageData(0, 0, G.W, G.H).data;
        let lit = 0;
        for (let i = 3; i < px.length; i += 4) if (px[i] > 8) lit++;
        const fps = (G.frames - f0) / 1.5;
        const holders = R.analyserHolders ? R.analyserHolders() : [];
        log(`nowplaying glow ${ok(lit > 0 && G.frames > f0 && fps <= 32 && holders.includes('nowplaying'))}: ${lit}/${G.W * G.H} lit px, ${fps.toFixed(1)} fps, holders ${holders.join(',')}, routing ${R.fx ? R.fx.routing : '?'}`);

        // 5. shaped cover morphs
        R.setPref(PREF.cover[0], 'shaped');
        R.setPref(PREF.align[0], 'center');
        const d0 = shapePath.getAttribute('d');
        const morphed = await until(() => shapePath.getAttribute('d') !== d0, morph.HOLD + 3000);
        const clip = getComputedStyle(artEl).clipPath;
        log(`nowplaying shaped cover ${ok(morphed && /np-shape/.test(clip) && getComputedStyle(meta).textAlign === 'center')}: clip ${clip.slice(0, 30)}, morphed ${morphed}`);
        await wait(1500); // shaped panel screenshot
        R.audio.pause();
        await wait(400);
        log(`nowplaying stops when paused ${ok(!G.loop && !glowCv.classList.contains('on') && !morph.loop && !(R.analyserHolders ? R.analyserHolders() : []).includes('nowplaying'))}`);
        R.audio.play().catch(() => {});
      } else log('nowplaying glow: skipped (nothing playing)');
    } catch (e) {
      log('nowplaying selftest error: ' + R.errText(e));
    } finally {
      R.setPref(PREF.cover[0], saved.cover); R.setPref(PREF.align[0], saved.align); R.setPref(PREF.glow[0], saved.glow);
      R.go(prevView, prevArg);
    }
    // CPU windows for an outside sampler (selftest runs only): after the other selftests finish, 30 s each of
    // glow off / glow on / glow on + shaped cover, logged with timestamps; prefs are put back at the end.
    const stamp = (m) => log(`nowplaying cpu window ${m} at ${new Date().toISOString()}`);
    const phases = [
      [90000, () => { R.setPref(PREF.glow[0], false); R.setPref(PREF.cover[0], 'large'); stamp('glow-off'); }],
      [120000, () => { R.setPref(PREF.glow[0], true); stamp('glow-on'); }],
      [150000, () => { R.setPref(PREF.cover[0], 'shaped'); stamp('glow-on+shaped'); }],
      [180000, () => { R.setPref(PREF.cover[0], saved.cover); R.setPref(PREF.align[0], saved.align); R.setPref(PREF.glow[0], saved.glow); stamp('end'); }],
    ];
    for (const [ms, fn] of phases) setTimeout(() => { if (R.player.current && R.audio.paused) R.audio.play().catch(() => {}); fn(); }, ms);
  });
})();
