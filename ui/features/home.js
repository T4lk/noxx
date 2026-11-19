'use strict';
// Home feed: quick tiles, Daily Mixes, genre / era / artist mixes, On Repeat,
// SoundCloud's own mixes, your artists and trending. Replaces the core home page.
// Backend: src-tauri/src/features/mixes.rs (mixes.*), discover.rs (discover.for_you / system_playlist).
(() => {
  const R = window.riff;
  const { esc, bg, mid, small, plural, totalTime, errText, ICON, svg } = R;

  const IC = {
    bars: svg('<path d="M4 10a1 1 0 0 1 1 1v2a1 1 0 0 1-2 0v-2a1 1 0 0 1 1-1zm4-4a1 1 0 0 1 1 1v10a1 1 0 1 1-2 0V7a1 1 0 0 1 1-1zm4-4a1 1 0 0 1 1 1v18a1 1 0 1 1-2 0V3a1 1 0 0 1 1-1zm4 4a1 1 0 0 1 1 1v10a1 1 0 1 1-2 0V7a1 1 0 0 1 1-1zm4 4a1 1 0 0 1 1 1v2a1 1 0 1 1-2 0v-2a1 1 0 0 1 1-1z"/>', true),
    repeat: svg('<polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>'),
    tag: svg('<path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/>'),
    clock: svg('<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>'),
    mic: svg('<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/>'),
    chevron: svg('<polyline points="9 18 15 12 9 6"/>'),
    left: svg('<polyline points="15 18 9 12 15 6"/>'),
    back: svg('<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>'),
    edit: svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/>'),
    up: svg('<polyline points="18 15 12 9 6 15"/>'),
    down: svg('<polyline points="6 9 12 15 18 9"/>'),
    files: svg('<path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/>'),
    person: svg('<path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/>', true),
    sparkle: svg('<path d="M12 3l1.9 5.6L19.5 10l-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.4z"/>'),
  };

  // Sections in their default order. `kinds` = mix kinds shown in the section.
  const SECTIONS = [
    { id: 'quick', name: 'Quick picks', icon: ICON.home },
    { id: 'made', name: 'Made for you', icon: IC.bars, kinds: ['daily'] },
    { id: 'repeat', name: 'On Repeat', icon: IC.repeat, kinds: ['repeat', 'rewind'] },
    { id: 'genre', name: 'Your genre mixes', icon: IC.tag, kinds: ['genre'] },
    { id: 'era', name: 'Your era mixes', icon: IC.clock, kinds: ['era'] },
    { id: 'artistmix', name: 'Artist mixes', icon: IC.mic, kinds: ['artist'] },
    { id: 'soundcloud', name: 'From SoundCloud', icon: ICON.cloud },
    { id: 'artists', name: 'Your artists', icon: ICON.user },
    { id: 'trending', name: 'Trending now', icon: ICON.fire },
  ];
  const SECTION = Object.fromEntries(SECTIONS.map((s) => [s.id, s]));
  const FILTERS = [['all', 'All'], ['sc', 'SoundCloud'], ['youtube', 'YouTube'], ['local', 'My files']];
  const ROW_MAX = 12;
  const FOR_YOU_TTL = 10 * 60 * 1000;
  const KICKER = { daily: 'Made for you', genre: 'Genre mix', era: 'Era mix', artist: 'Artist mix', repeat: 'On Repeat', rewind: 'Repeat Rewind' };

  const H = {
    list: null, loading: null, err: '',
    full: new Map(),          // id -> full mix (with tracks)
    forYou: null, forYouAt: 0, forYouErr: '',
    lastHomeRender: 0,
  };

  const isSc = (t) => !!t && !t.source && /^\d+$/.test(String(t.id || ''));
  const sourceOf = (t) => (!t || !t.source ? 'sc' : /youtube|ytm/.test(t.source) || String(t.id || '').startsWith('yt:') ? 'youtube' : t.source === 'local' || t.source === 'download' ? 'local' : t.source);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const mixesWord = (n) => `${n} ${n === 1 ? 'mix' : 'mixes'}`;
  const filter = () => R.pref('home.filter', 'all');
  const order = () => {
    const saved = R.pref('home.order', []);
    const ids = (Array.isArray(saved) ? saved : []).filter((id, i, a) => SECTION[id] && a.indexOf(id) === i);
    SECTIONS.forEach((s, i) => { if (!ids.includes(s.id)) ids.splice(Math.min(i, ids.length), 0, s.id); });
    return ids;
  };
  const hidden = () => new Set(R.pref('home.hidden', []));
  const loggedIn = () => { const s = R.state.status || {}; return !!s.loggedIn && !s.expired; };
  const arrows = () => `<span class="hm-head-right"><button class="hm-arrow" data-scroll="-1" aria-label="Scroll left">${IC.left}</button><button class="hm-arrow" data-scroll="1" aria-label="Scroll right">${IC.chevron}</button></span>`;

  // ---------------------------------------------------------------- data

  function loadList(force) {
    if (H.loading) return H.loading;
    if (H.list && !force) return Promise.resolve(H.list);
    H.loading = R.call('mixes.list')
      .then((l) => { H.list = l; H.err = l.error || ''; return l; })
      .catch((e) => { H.err = errText(e); H.list = H.list || { mixes: [], artists: [], builtAt: 0 }; return H.list; })
      .finally(() => { H.loading = null; });
    return H.loading;
  }

  async function getMix(id) {
    const hit = H.full.get(id);
    const sum = (H.list?.mixes || []).find((m) => m.id === id);
    if (hit && (!sum || hit.updatedAt === sum.updatedAt)) return hit;
    const m = await R.call('mixes.get', { id });
    H.full.set(id, m);
    return m;
  }

  function loadForYou() {
    if (!loggedIn()) return Promise.resolve([]);
    if (H.forYou && Date.now() - H.forYouAt < FOR_YOU_TTL) return Promise.resolve(H.forYou);
    return R.call('discover.for_you', {})
      .then((l) => { H.forYou = l || []; H.forYouErr = ''; H.forYouAt = Date.now(); return H.forYou; })
      .catch((e) => { H.forYouErr = errText(e); H.forYou = H.forYou || []; H.forYouAt = Date.now(); return H.forYou; });
  }

  // "Trending in your genres": new uploads (last month) ranked by plays, on SoundCloud and
  // YouTube, for the user's top genre mixes. Falls back to the global chart with no genres yet.
  async function loadTrendingFor() {
    const genres = (H.list?.mixes || []).filter((m) => m.kind === 'genre').map((m) => String(m.title || '').replace(/\s*Mix$/i, '').trim()).filter(Boolean).slice(0, 3);
    const key = genres.join('|') + '|' + R.pref('musicSources', 'both');
    if (!genres.length) { H.trendRows = null; return; }
    if (H.trendKey === key && H.trendRows && Date.now() - (H.trendAt || 0) < 30 * 60 * 1000) return;
    const [sc, yt] = await Promise.all([
      // Follows Settings > Music sources (SoundCloud + YouTube by default).
      R.pref('musicSources', 'both') !== 'yt' ? R.call('discover.trending_for', { genres, limit: 18 }).catch(() => []) : [],
      R.pref('musicSources', 'both') !== 'sc' ? R.call('youtube.trending_for', { genres, limit: 12 }).catch(() => []) : [],
    ]);
    const liked = R.state.favIds || new Set();
    H.trendRows = genres.map((g) => {
      const a = ((sc || []).find((r) => r.genre === g) || {}).tracks || [];
      const b = ((yt || []).find((r) => r.genre === g) || {}).tracks || [];
      const out = [], seen = new Set();
      for (let i = 0; out.length < 24 && (i < a.length || i < b.length); i++) {
        for (const t of [a[i], b[i]]) {
          if (!t || liked.has(t.id)) continue;
          const k = `${(t.artist || '').toLowerCase()}|${(t.title || '').toLowerCase()}`;
          if (seen.has(k)) continue;
          seen.add(k);
          out.push(t);
        }
      }
      return { genre: g, tracks: out };
    }).filter((r) => r.tracks.length);
    H.trendKey = key;
    H.trendAt = Date.now();
  }

  async function loadTrending() {
    if (!R.state.trending) {
      try { R.state.trending = await R.invoke('trending'); } catch (e) { return []; }
    }
    return R.state.trending || [];
  }

  async function loadRecent() {
    try { return await R.call('history.list', { limit: 60 }); } catch (e) { return []; }
  }

  // Rust tells us when a build finished: refresh the list and redraw.
  R.listen('mixes:updated', async () => {
    await loadList(true);
    H.full.clear();
    if ((R.state.view === 'home' && Date.now() - H.lastHomeRender > 400) || R.state.view === 'home-all') R.render(true);
  });

  // ---------------------------------------------------------------- markup

  function hue(text) { let h = 0; for (const c of String(text)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }

  function coverHtml(m, px = 180) {
    const covers = (m.covers || []).filter(Boolean);
    const inner = covers.length >= 4
      ? `<div class="hm-collage">${covers.slice(0, 4).map((c) => `<span style="${bg(R.art(c, px / 2))}"></span>`).join('')}</div>`
      : m.cover ? `<div class="hm-single" style="${bg(R.art(m.cover, px))}"></div>` : `<div class="hm-empty">${ICON.music}</div>`;
    let deco = '';
    if (m.kind === 'daily') {
      deco = `<span class="hm-daily"><span>Daily Mix</span><b>${String(m.number || 1).padStart(2, '0')}</b></span>`;
    } else if (m.kind === 'genre' || m.kind === 'era' || m.kind === 'artist') {
      deco = `<span class="hm-band" style="--band-h:${hue(m.tag || m.title)}">${esc(m.tag || m.title)}</span>`;
    } else if (m.kind === 'repeat' || m.kind === 'rewind') {
      deco = `<span class="hm-band hm-band-big" style="--band-h:${m.kind === 'repeat' ? 330 : 200}">${esc(m.title)}</span>`;
    }
    return inner + deco;
  }

  function mixCard(m, i) {
    return `<div class="hm-card" data-mix="${esc(m.id)}" style="--i:${i}" title="${esc(m.title)}">
      <div class="hm-cover">${coverHtml(m)}<button class="hm-play" data-a="play" title="Play" aria-label="Play ${esc(m.title)}">${ICON.play}</button></div>
      <div class="hm-title hm-fade">${esc(m.title)}</div><div class="hm-sub">${esc(m.subtitle || plural(m.trackCount || 0, 'track'))}</div></div>`;
  }

  function scMixCard(p, i) {
    return `<div class="hm-card" data-urn="${esc(p.urn)}" style="--i:${i}" title="${esc(p.title)}">
      <div class="hm-cover">${p.artwork ? `<div class="hm-single" style="${bg(R.art(p.artwork, 180))}"></div>` : `<div class="hm-empty">${ICON.cloud}</div>`}
      <button class="hm-play" data-a="play" title="Play" aria-label="Play ${esc(p.title)}">${ICON.play}</button></div>
      <div class="hm-title hm-fade">${esc(p.title)}</div><div class="hm-sub">${esc(p.description || plural(p.trackCount || 0, 'track'))}</div></div>`;
  }

  function trackCard(t, i) {
    return `<div class="hm-card" data-ti="${i}" style="--i:${i}" title="${esc(t.title)} · ${esc(t.artist)}">
      <div class="hm-cover">${t.artwork ? `<div class="hm-single" style="${bg(mid(t.artwork))}"></div>` : `<div class="hm-empty">${ICON.music}</div>`}
      <button class="hm-play" data-a="play" title="Play" aria-label="Play ${esc(t.title)}">${ICON.play}</button></div>
      <div class="hm-title hm-fade">${esc(t.title)}</div><div class="hm-sub hm-fade">${esc(t.artist)}</div></div>`;
  }

  function artistCard(a, i) {
    const pic = a.avatar || mid(a.artwork);
    return `<button class="hm-artist" data-ai="${i}" style="--i:${i}" title="${esc(a.name)}">
      <span class="hm-artist-pic" style="${bg(pic)}">${pic ? '' : IC.person}</span>
      <span class="hm-artist-name hm-fade">${esc(a.name)}</span><span class="hm-artist-sub">Artist</span></button>`;
  }

  function sectionHtml(id, inner, { showAll = true } = {}) {
    const s = SECTION[id];
    return `<section class="hm-section" data-sec="${id}">
      <div class="hm-head${showAll ? ' hm-clickable' : ''}"><h2>${s.icon}<span>${esc(s.name)}</span></h2>
        ${showAll ? `<span class="hm-head-right"><button class="hm-showall" data-a="all">Show all</button><button class="hm-arrow" data-scroll="-1" aria-label="Scroll left">${IC.left}</button><button class="hm-arrow" data-scroll="1" aria-label="Scroll right">${IC.chevron}</button></span>` : arrows()}</div>
      ${inner}</section>`;
  }

  // ---------------------------------------------------------------- filtering

  function mixesFor(kinds, f = filter()) {
    const all = (H.list?.mixes || []).filter((m) => kinds.includes(m.kind));
    if (f === 'all') return all;
    return all.filter((m) => (m.sources || []).includes(f));
  }

  function quickTiles(recent, f) {
    const tiles = [];
    const favs = R.state.library.favorites || [];
    const mixes = H.list?.mixes || [];
    const push = (t) => { if (tiles.length < 8 && !tiles.some((x) => x.key === t.key)) tiles.push(t); };
    const mixTile = (m) => m && push({ key: `mix:${m.id}`, title: m.title, sub: m.subtitle, cover: m.cover, covers: m.covers, mix: m.id });
    const okMix = (m) => f === 'all' || (m.sources || []).includes(f);
    if (f === 'all' || f === 'sc') push({ key: 'likes', title: 'Liked Songs', sub: plural(favs.length, 'song'), heart: true, go: 'likes' });
    if (f === 'local') push({ key: 'files', title: 'My files', sub: 'Music on this computer', icon: IC.files, go: 'files' });
    mixTile(mixes.find((m) => m.kind === 'repeat' && okMix(m)));
    mixTile(mixes.find((m) => m.kind === 'daily' && okMix(m)));
    if (f === 'all' || f === 'sc') for (const p of (R.state.scPlaylists || []).slice(0, 3)) push({ key: `sc:${p.id}`, title: p.title, sub: plural(p.trackCount, 'track'), cover: p.artwork, icon: ICON.cloud, go: 'sc', id: p.id });
    if (f === 'all' || f === 'local') {
      for (const p of (R.state.library.playlists || []).filter((p) => p.tracks.length).slice(0, 2)) push({ key: `local:${p.id}`, title: p.name, sub: plural(p.tracks.length, 'track'), cover: p.tracks[0]?.artwork, icon: ICON.music, go: 'local', id: p.id });
    }
    const last = recent.find((e) => f === 'all' || sourceOf(e) === f);
    if (last) push({ key: 'recent', title: 'Recently played', sub: `${last.title} · ${last.artist}`, cover: last.artwork, icon: IC.clock, go: 'history' });
    for (const m of mixes.filter((m) => okMix(m) && m.kind !== 'era')) mixTile(m);
    return tiles;
  }

  function tileHtml(t, i) {
    const covers = (t.covers || []).filter(Boolean);
    const art = t.heart ? `<span class="hm-tile-art hm-heart">${ICON.heartFill}</span>`
      : covers.length >= 4 ? `<span class="hm-tile-art hm-collage">${covers.slice(0, 4).map((c) => `<span style="${bg(R.art(c, 32))}"></span>`).join('')}</span>`
      : `<span class="hm-tile-art" style="${bg(t.cover ? small(t.cover) : '')}">${t.cover ? '' : t.icon || ICON.music}</span>`;
    return `<div class="hm-tile" data-qi="${i}" style="--i:${i}" title="${esc(t.title)}">${art}
      <span class="hm-tile-text"><span class="hm-tile-title hm-fade">${esc(t.title)}</span><span class="hm-tile-sub hm-fade">${esc(t.sub || '')}</span></span>
      <button class="hm-play hm-play-sm" data-a="play" title="Play" aria-label="Play ${esc(t.title)}">${ICON.play}</button></div>`;
  }

  // ---------------------------------------------------------------- playing

  async function withLoading(el, fn) {
    if (el?.classList.contains('loading')) return;
    el?.classList.add('loading');
    try { await fn(); } catch (e) { R.toast(errText(e), 'error'); } finally { el?.classList.remove('loading'); }
  }

  function playMixId(id, el) {
    return withLoading(el, async () => {
      const m = await getMix(id);
      if (!m.tracks?.length) { R.toast(`${m.title} is empty`, 'error'); return; }
      R.playList(m.tracks, 0);
      R.toast(`Playing ${m.title}`);
    });
  }

  function playScMix(p, el) {
    return withLoading(el, async () => {
      const data = await R.call('discover.system_playlist', { urn: p.urn });
      if (!data.tracks?.length) { R.toast(`Couldn't load ${p.title}`, 'error'); return; }
      R.playList(data.tracks, 0);
      R.toast(`Playing ${p.title}`);
    });
  }

  function playTile(t, el) {
    if (t.mix) return playMixId(t.mix, el);
    return withLoading(el, async () => {
      let tracks = [];
      if (t.go === 'likes') tracks = R.state.library.favorites || [];
      else if (t.go === 'local') tracks = (R.state.library.playlists.find((p) => p.id === t.id) || {}).tracks || [];
      else if (t.go === 'sc') tracks = await R.invoke('sc_playlist_tracks', { id: t.id });
      else if (t.go === 'history') tracks = await loadRecent();
      if (tracks.length) R.playList(tracks, 0); else R.go(t.go, t.id || null);
    });
  }

  function openArtist(a) {
    const t = a.track || { artist: a.name, artist_id: a.artistId, artist_url: a.artistUrl };
    if (isSc(t) || /^\d+$/.test(String(t.artist_id || ''))) {
      R.go('artist', { id: t.artist_id || '', url: t.artist_url || '', trackId: isSc(t) ? t.id : '', name: t.artist || a.name });
    } else {
      R.emit('artist', t);
    }
  }

  // ---------------------------------------------------------------- rows

  function wireRow(row) {
    row.addEventListener('wheel', (e) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX) || row.scrollWidth <= row.clientWidth) return;
      const max = row.scrollWidth - row.clientWidth;
      // At either end the wheel scrolls the page again.
      if ((e.deltaY < 0 && row.scrollLeft <= 0) || (e.deltaY > 0 && row.scrollLeft >= max - 1)) return;
      row.scrollBy({ left: e.deltaY * 1.6, behavior: 'smooth' });
      e.preventDefault();
    }, { passive: false });
    const edge = () => {
      const max = row.scrollWidth - row.clientWidth;
      const sec = row.closest('.hm-section');
      if (!sec) return;
      sec.querySelector('[data-scroll="-1"]')?.toggleAttribute('disabled', row.scrollLeft <= 2);
      sec.querySelector('[data-scroll="1"]')?.toggleAttribute('disabled', row.scrollLeft >= max - 2);
    };
    row.addEventListener('scroll', edge, { passive: true });
    requestAnimationFrame(edge);
  }

  /** Wires clicks for a container of mix / SoundCloud / track / artist cards and tiles. getCtx() -> { tiles, tracks, artists } */
  function wireCards(box, getCtx) {
    box.addEventListener('click', (e) => {
      const ctx = getCtx();
      const play = e.target.closest('[data-a=play]');
      const mixEl = e.target.closest('[data-mix]');
      if (mixEl) { if (play) playMixId(mixEl.dataset.mix, mixEl); else R.go('mix', mixEl.dataset.mix); return; }
      const urnEl = e.target.closest('[data-urn]');
      if (urnEl) {
        const p = (H.forYou || []).find((x) => x.urn === urnEl.dataset.urn);
        if (p) { if (play) playScMix(p, urnEl); else R.go('dc-mix', p.urn); }
        return;
      }
      const tEl = e.target.closest('[data-ti]');
      if (tEl && ctx.tracks) { R.playList(ctx.tracks, Number(tEl.dataset.ti)); return; }
      const aEl = e.target.closest('[data-ai]');
      if (aEl && ctx.artists) { openArtist(ctx.artists[Number(aEl.dataset.ai)]); return; }
      const qEl = e.target.closest('[data-qi]');
      if (qEl && ctx.tiles) {
        const t = ctx.tiles[Number(qEl.dataset.qi)];
        if (!t) return;
        if (play) playTile(t, qEl);
        else if (t.mix) R.go('mix', t.mix);
        else R.go(t.go, t.id || null);
      }
    });
    box.addEventListener('contextmenu', (e) => {
      const ctx = getCtx();
      const tEl = e.target.closest('[data-ti]');
      const mixEl = e.target.closest('[data-mix]');
      if (tEl && ctx.tracks) {
        e.preventDefault();
        const i = Number(tEl.dataset.ti);
        const t = ctx.tracks[i];
        R.showMenu([
          { label: 'Play', run: () => R.playList(ctx.tracks, i) },
          { label: 'Play next', run: () => R.addToQueue(t, true) },
          { label: 'Add to queue', run: () => R.addToQueue(t) },
        ], e.clientX, e.clientY);
      } else if (mixEl) {
        e.preventDefault();
        const id = mixEl.dataset.mix;
        R.showMenu([
          { label: 'Play', run: () => playMixId(id, mixEl) },
          { label: 'Shuffle', run: async () => { const m = await getMix(id); if (m.tracks.length) R.playList(m.tracks, Math.floor(Math.random() * m.tracks.length), true); } },
          { label: 'Add to queue', run: async () => { const m = await getMix(id); m.tracks.forEach((t) => R.addToQueue(t)); R.toast(`Added ${plural(m.tracks.length, 'track')} to the queue`); } },
          { label: 'Open', run: () => R.go('mix', id) },
        ], e.clientX, e.clientY);
      }
    });
  }

  // ---------------------------------------------------------------- home

  function chipsHtml() {
    const f = filter();
    return `<div class="hm-top"><div class="hm-chips" role="tablist">${FILTERS.map(([v, l]) => `<button class="hm-chip${v === f ? ' active' : ''}" data-f="${v}" role="tab" aria-selected="${v === f}">${l}</button>`).join('')}</div>
      <div class="hm-tools"><button class="pill-btn" data-a="refresh" title="Remake mixes">${ICON.sync}</button><button class="pill-btn" data-a="edit" title="Edit home">${IC.edit}</button></div></div>`;
  }

  function emptyCard(building) {
    return `<section class="hm-section hm-firstrun" data-sec="firstrun"><div class="hm-firstrun-card">
      <span class="hm-firstrun-ico">${IC.sparkle}</span>
      <div class="hm-firstrun-text"><div class="hm-firstrun-title">${building ? 'Making your mixes…' : 'Your mixes show up after a few plays'}</div>
      <div class="hm-firstrun-sub">Like and play a few songs. noxx turns what you listen to into Daily Mixes, genre and era mixes, artist mixes and On Repeat.</div></div>
      ${building ? '<div class="spinner hm-spin"></div>' : `<button class="btn primary" data-a="make">${ICON.sync}Make mixes now</button>`}</div></section>`;
  }

  async function renderHome(token) {
    H.lastHomeRender = Date.now();
    const page = R.add('<div class="hm-home"></div>');
    page.innerHTML = chipsHtml();
    const body = R.el('<div class="hm-body"></div>');
    page.append(body);
    let ctx = { tiles: [], tracks: null, artists: null };
    wireCards(body, () => ctx);
    body.addEventListener('click', (e) => {
      const sc = e.target.closest('[data-scroll]');
      if (sc) { const row = sc.closest('.hm-section').querySelector('.hm-row'); row.scrollBy({ left: Number(sc.dataset.scroll) * row.clientWidth * 0.8, behavior: 'smooth' }); return; }
      const head = e.target.closest('.hm-clickable');
      if (head && (e.target.closest('[data-a=all]') || e.target.closest('h2'))) { R.go('home-all', head.closest('.hm-section').dataset.sec); return; }
      if (e.target.closest('[data-a=make]')) remake();
    });

    page.querySelector('.hm-chips').addEventListener('click', async (e) => {
      const b = e.target.closest('[data-f]');
      if (!b || b.dataset.f === filter()) return;
      R.setPref('home.filter', b.dataset.f);
      page.querySelectorAll('.hm-chip').forEach((c) => { const on = c === b; c.classList.toggle('active', on); c.setAttribute('aria-selected', String(on)); });
      ctx = await drawBody(token, body) || ctx;
    });
    page.querySelector('.hm-tools').addEventListener('click', (e) => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (a === 'refresh') remake();
      if (a === 'edit') editHome();
    });

    if (!H.list) body.innerHTML = '<div class="hm-skel-tiles">' + '<div class="hm-skel"></div>'.repeat(8) + '</div><div class="hm-skel-row">' + '<div class="hm-skel hm-skel-card"></div>'.repeat(6) + '</div>';
    await Promise.all([loadList(), loadForYou(), loadTrending()]);
    await loadTrendingFor(); // needs the genre mixes from loadList()
    if (R.stale(token)) return;
    ctx = await drawBody(token, body) || ctx;
  }

  /** Fills the feed for the current filter; returns the click context. */
  async function drawBody(token, body) {
    const f = filter();
    const recent = await loadRecent();
    if (R.stale(token)) return null;
    const hide = hidden();
    const list = H.list || { mixes: [], artists: [] };
    const html = [];
    const ctx = { tiles: [], tracks: null, artists: null };
    const haveMixes = (list.mixes || []).length > 0;
    const building = !!list.building || !list.builtAt;

    for (const id of order()) {
      if (hide.has(id)) continue;
      const s = SECTION[id];
      if (id === 'quick') {
        ctx.tiles = quickTiles(recent, f);
        if (ctx.tiles.length) html.push(`<section class="hm-section" data-sec="quick"><div class="hm-quick">${ctx.tiles.map(tileHtml).join('')}</div></section>`);
        if (!haveMixes) html.push(emptyCard(building));
      } else if (s.kinds) {
        const mixes = mixesFor(s.kinds, f);
        if (mixes.length) html.push(sectionHtml(id, `<div class="hm-row">${mixes.slice(0, ROW_MAX).map(mixCard).join('')}</div>`));
      } else if (id === 'soundcloud') {
        if (f !== 'all' && f !== 'sc') continue;
        const fy = H.forYou || [];
        if (fy.length) html.push(sectionHtml(id, `<div class="hm-row">${fy.slice(0, ROW_MAX).map(scMixCard).join('')}</div>`));
      } else if (id === 'artists') {
        const artists = (list.artists || []).filter((a) => f === 'all' || a.source === f);
        ctx.artists = artists;
        if (artists.length) html.push(sectionHtml(id, `<div class="hm-row hm-artists">${artists.map(artistCard).join('')}</div>`, { showAll: false }));
      } else if (id === 'trending') {
        if (f === 'local') continue;
        const bySource = (t) => f === 'all' || (f === 'youtube' ? t.source === 'youtube' : !t.source);
        const rows = (H.trendRows || []).map((r) => ({ genre: r.genre, tracks: r.tracks.filter(bySource) })).filter((r) => r.tracks.length);
        if (rows.length) {
          // One section, a labelled row per genre; card indices run across all rows.
          const all = [];
          const inner = rows.map((r) => {
            const cards = r.tracks.map((t) => { all.push(t); return trackCard(t, all.length - 1); }).join('');
            return `<div class="hm-subhead">Trending in ${esc(r.genre)}</div><div class="hm-row">${cards}</div>`;
          }).join('');
          ctx.tracks = all;
          html.push(sectionHtml(id, inner, { showAll: false }).replace(`<span>${esc(SECTION.trending.name)}</span>`, '<span>Trending in your genres</span>'));
        } else if (f === 'all' || f === 'sc') {
          const tr = (R.state.trending || []).slice(0, 24);
          ctx.tracks = tr;
          if (tr.length) html.push(sectionHtml(id, `<div class="hm-row">${tr.map(trackCard).join('')}</div>`, { showAll: false }));
        }
      }
    }
    if (!haveMixes && hide.has('quick')) html.unshift(emptyCard(building));
    if (!html.length) html.push(`<div class="empty"><div>Nothing from ${esc((FILTERS.find(([v]) => v === f) || [])[1] || 'here')} yet.</div></div>`);
    html.forEach((h, i) => { html[i] = h.replace('<section class="hm-section', `<section style="--s:${i}" class="hm-section`); });
    body.innerHTML = html.join('');
    body.querySelectorAll('.hm-row').forEach(wireRow);
    return ctx;
  }

  async function remake() {
    if (H.list?.building) { R.toast('Already making your mixes'); return; }
    R.toast('Making fresh mixes…');
    try {
      await R.call('mixes.refresh', { wait: false });
      if (H.list) H.list.building = true;
    } catch (e) { R.toast(errText(e), 'error'); }
  }

  function editHome() {
    const ids = order();
    const hide = hidden();
    const m = R.openModal(`<h3>Edit home</h3><div class="page-sub">Reorder or hide sections.</div><div class="hm-edit-list"></div>
      <div class="row-btns"><button class="btn outline" data-k="reset">Reset</button><button class="btn primary" data-k="done">Done</button></div>`);
    const box = m.querySelector('.hm-edit-list');
    const draw = () => {
      box.innerHTML = ids.map((id, i) => `<div class="hm-edit-row" data-id="${id}"><span class="hm-edit-ico">${SECTION[id].icon}</span><span class="hm-edit-name">${esc(SECTION[id].name)}</span>
        <button class="pill-btn" data-k="up" ${i === 0 ? 'disabled' : ''} aria-label="Move up">${IC.up}</button><button class="pill-btn" data-k="down" ${i === ids.length - 1 ? 'disabled' : ''} aria-label="Move down">${IC.down}</button>
        ${R.switchHtml(!hide.has(id), 'data-k="show" aria-label="Show section"')}</div>`).join('');
    };
    draw();
    box.addEventListener('click', (e) => {
      const b = e.target.closest('[data-k]');
      if (!b) return;
      const id = b.closest('.hm-edit-row').dataset.id;
      const i = ids.indexOf(id);
      if (b.dataset.k === 'show') { if (hide.has(id)) hide.delete(id); else hide.add(id); R.setSwitch(b, !hide.has(id)); return; }
      if (b.dataset.k === 'up' && i > 0) [ids[i - 1], ids[i]] = [ids[i], ids[i - 1]];
      else if (b.dataset.k === 'down' && i < ids.length - 1) [ids[i + 1], ids[i]] = [ids[i], ids[i + 1]];
      draw();
    });
    m.querySelector('[data-k=reset]').onclick = () => { ids.splice(0, ids.length, ...SECTIONS.map((s) => s.id)); hide.clear(); draw(); };
    m.querySelector('[data-k=done]').onclick = () => {
      R.setPref('home.order', ids.slice());
      R.setPref('home.hidden', [...hide]);
      R.closeModal();
      if (R.state.view === 'home') R.render(true);
    };
  }

  // ---------------------------------------------------------------- Show all

  function backRow() {
    R.add(`<div class="hm-backrow"><button class="pill-btn" title="Back to Home" aria-label="Back to Home">${IC.back}</button></div>`).querySelector('button').onclick = () => R.go('home');
  }

  async function renderAll(token, secId) {
    const s = SECTION[secId] || SECTION.made;
    backRow();
    R.add(`<div class="page-title">${esc(s.name)}</div>`);
    const sub = R.add('<div class="page-sub hm-all-sub"></div>');
    await Promise.all([loadList(), secId === 'soundcloud' ? loadForYou() : null]);
    if (R.stale(token)) return;
    const grid = R.add('<div class="hm-grid"></div>');
    if (s.kinds) {
      const mixes = mixesFor(s.kinds, 'all');
      sub.textContent = mixesWord(mixes.length);
      grid.innerHTML = mixes.map(mixCard).join('');
      if (!mixes.length) grid.replaceWith(R.el('<div class="empty"><div>No mixes here yet. Keep listening.</div></div>'));
    } else if (secId === 'soundcloud') {
      const fy = H.forYou || [];
      sub.textContent = fy.length ? mixesWord(fy.length) : H.forYouErr;
      grid.innerHTML = fy.map(scMixCard).join('');
    }
    wireCards(grid, () => ({}));
  }

  // ---------------------------------------------------------------- mix page

  async function renderMixPage(token, id) {
    backRow();
    await loadList();
    if (R.stale(token)) return;
    const sum = (H.list?.mixes || []).find((m) => m.id === id);
    const head = R.hero({ kicker: KICKER[sum?.kind] || 'Mix', title: sum?.title || 'Mix', sub: sum?.subtitle || '', cover: sum?.cover || '', icon: ICON.music,
      actions: R.listActions(`<button class="pill-btn" data-a="queue" title="Add to queue" aria-label="Add to queue">${ICON.queue}</button>`) });
    const cov = head.querySelector('.cover');
    if (sum && cov) { cov.classList.add('hm-hero-cover'); cov.style.backgroundImage = 'none'; cov.innerHTML = coverHtml(sum, 160); }
    const sp = R.spinner();
    let m;
    try { m = await getMix(id); } catch (e) { if (!R.stale(token)) { sp.remove(); R.emptyMsg(errText(e), 'Back to Home', () => R.go('home')); } return; }
    if (R.stale(token)) return;
    sp.remove();
    const tracks = m.tracks || [];
    const when = m.updatedAt ? new Date(m.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '';
    head.querySelector('.page-sub').textContent = [m.subtitle, `${plural(tracks.length, 'track')} · ${totalTime(tracks)}`, when && `updated ${when}`].filter(Boolean).join(' · ');
    R.wireActions(head, tracks, { queue: () => { tracks.forEach((t) => R.addToQueue(t)); R.toast(`Added ${plural(tracks.length, 'track')} to the queue`); } });
    if (!tracks.length) { R.emptyMsg('This mix is empty right now.'); return; }
    R.toolList({ kind: 'mix', id }, tracks);
  }

  R.registerView('home', { override: true, title: 'Home', render: renderHome });
  R.registerView('home-all', { title: 'Show all', render: renderAll });
  R.registerView('mix', { title: 'Mix', render: renderMixPage });

  // ---------------------------------------------------------------- selftest

  R.addSelftest(async (log) => {
    const ok = (b) => (b ? 'OK' : 'FAILED');
    try {
      let t0 = performance.now();
      let list = await R.call('mixes.list');
      const listMs = Math.round(performance.now() - t0);
      log(`home: mixes.list ${ok(listMs < 500 && Array.isArray(list.mixes))} (${list.mixes.length} mixes, built ${list.builtAt ? Math.round((Date.now() - list.builtAt) / 60000) + ' min ago' : 'never'}, ${listMs} ms)`);
      const favs = (R.state.library.favorites || []).length;
      let hist = [];
      try { hist = await R.call('history.list', { limit: 1000 }); } catch (e) {}
      if (!list.mixes.length || Date.now() - list.builtAt > 12 * 3600 * 1000) {
        t0 = performance.now();
        list = await R.call('mixes.refresh', { wait: true });
        log(`home: mixes.refresh ${ok(Array.isArray(list.mixes) && list.mixes.length > 0)} (${list.mixes.length} mixes in ${Math.round(performance.now() - t0)} ms${list.error ? ', error ' + list.error : ''})`);
      }
      H.list = list; H.full.clear();
      const by = {};
      for (const m of list.mixes) (by[m.kind] = by[m.kind] || []).push(m.title);
      log(`home: mixes ${Object.entries(by).map(([k, v]) => `${k} ${v.length}`).join(', ') || 'none'} (${favs} likes, ${hist.length} plays, built in ${list.tookMs || '?'} ms)`);
      log(`home: titles ${list.mixes.map((m) => `${m.title} [${m.trackCount}]`).join(' | ')}`);
      const enough = favs >= 30 || hist.length >= 50;
      log(`home: genre mixes ${ok(!enough || (by.genre || []).length > 0)} (${(by.genre || []).join(', ') || 'none'})`);
      log(`home: daily mixes ${ok(!enough || (by.daily || []).length > 0)} (${(by.daily || []).length}), on repeat ${(by.repeat || []).length ? 'made' : 'not enough repeat plays yet'}, era ${(by.era || []).join(', ') || 'none'}`);
      log(`home: sizes ${ok(list.mixes.every((m) => m.trackCount >= 8 && m.trackCount <= 50))} (${list.mixes.map((m) => m.trackCount).join(',')}), artists row ${(list.artists || []).length}`);
      { const src = (await R.call('mixes.sources')).value; const dm = list.mixes.filter((m) => ['daily', 'genre', 'artist'].includes(m.kind)); const both = dm.filter((m) => (m.sources || []).includes('sc') && (m.sources || []).includes('youtube')).length; log(`home: mix sources ${ok(src === list.sources && (src !== 'both' || both > 0))} (${src}; ${both}/${dm.length} daily/genre/artist mixes mix SoundCloud and YouTube)`); }
      const first = list.mixes[0];
      if (first) {
        t0 = performance.now();
        const m = await R.call('mixes.get', { id: first.id });
        const ids = new Set(m.tracks.map((t) => t.id));
        log(`home: mixes.get ${ok(m.tracks.length === first.trackCount && ids.size === m.tracks.length)} (${first.title}: ${m.tracks.length} tracks, ${Math.round(performance.now() - t0)} ms)`);
        t0 = performance.now();
        R.go('mix', first.id);
        let h1 = null;
        for (let i = 0; i < 40 && !(h1 && R.view.querySelector('.tracks')); i++) { await wait(100); h1 = R.view.querySelector('.hero h1'); }
        log(`home: mix view ${ok(!!h1 && h1.textContent === first.title && !!R.view.querySelector('.tracks') && !!R.view.querySelector('.hm-hero-cover'))} (${Math.round(performance.now() - t0)} ms)`);
      }
      t0 = performance.now();
      const before = R.pref('home.filter', 'all');
      R.setPref('home.filter', 'all');
      R.go('home');
      let secs = [];
      for (let i = 0; i < 60; i++) { await wait(100); secs = [...R.view.querySelectorAll('.hm-section')].map((s) => s.dataset.sec); if (secs.length >= 3 || secs.includes('firstrun')) break; }
      const wantSome = list.mixes.length ? secs.some((s) => ['made', 'genre', 'repeat', 'era', 'artistmix'].includes(s)) : secs.includes('firstrun');
      log(`home: feed ${ok(!!R.view.querySelector('.hm-chips') && wantSome)} (sections ${secs.join(', ')}; ${R.view.querySelectorAll('.hm-tile').length} tiles, ${R.view.querySelectorAll('.hm-card').length} cards, ${R.view.querySelectorAll('.hm-artist').length} artists, ${Math.round(performance.now() - t0)} ms)`);
      const chip = R.view.querySelector('.hm-chip[data-f=youtube]');
      if (chip) {
        chip.click();
        await wait(400);
        const ys = [...R.view.querySelectorAll('.hm-section')].map((s) => s.dataset.sec);
        // Trending may stay under YouTube (YouTube trending in your genres); every card there must be a YouTube track.
        const ytTrendOk = !ys.includes('trending') || (H.trendRows || []).some((r) => r.tracks.some((t) => t.source === 'youtube'));
        log(`home: filter ${ok(ytTrendOk && !ys.includes('soundcloud'))} (YouTube shows ${ys.join(', ') || 'nothing'})`);
      }
      const rows = H.trendRows || [];
      log(`home: trending in your genres ${ok(!H.list?.mixes?.some((m) => m.kind === 'genre') || rows.length > 0)}: ${rows.map((r) => `${r.genre} ${r.tracks.length} (${r.tracks.filter((t) => t.source === 'youtube').length} YouTube)`).join(' | ') || 'none'}; first: ${rows[0]?.tracks.slice(0, 3).map((t) => t.title).join(' | ') || '-'}`);
      R.setPref('home.filter', before);
      R.go('home');
    } catch (e) {
      log(`home: selftest FAILED (${errText(e)})`);
    }
  });
})();
