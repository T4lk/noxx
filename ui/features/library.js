'use strict';
// library feature: search + sort toolbar over Likes / playlists, play History view
// (backed by src-tauri/src/features/history.rs), "Jump back in" strip on Home.
(() => {
  const riff = window.riff;
  const { esc, plural, totalTime, bg, small, mid, store, load, svg } = riff;

  const CLOCK = svg('<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>');
  const SEARCH = svg('<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.5" y2="16.5"/>');
  const TRASH = svg('<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>');
  const HIST_CAP = 1000;

  // ------------------------------------------------------------ search text (like riff's search-text.js)

  /** Lower-cases, strips accents / Arabic diacritics and folds look-alike letters. */
  function normalize(value) {
    if (typeof value !== 'string' || !value) return '';
    return value
      .normalize('NFKD')
      .replace(/[̀-֑ͯ-ׇؐ-ًؚ-ٰٟۖ-ۭـ]/g, '')
      .replace(/[یى]/g, 'ي')
      .replace(/ک/g, 'ك')
      .replace(/[ةہ]/g, 'ه')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
  }
  // Normalised "title \u0001 artist" per track object, so typing over thousands of likes stays instant.
  const haystack = new WeakMap();
  function textOf(t) {
    let s = haystack.get(t);
    if (s === undefined) { s = normalize(t.title || '') + '\u0001' + normalize(t.artist || ''); haystack.set(t, s); }
    return s;
  }

  // ------------------------------------------------------------ sorting (riff's track-sort.js modes)

  const SORTS = [
    ['manual', 'Manual order'],
    ['added-desc', 'Date added (newest)'],
    ['added-asc', 'Date added (oldest)'],
    ['title-asc', 'Title (A-Z)'],
    ['artist-asc', 'Artist (A-Z)'],
    ['duration-asc', 'Duration (shortest)'],
    ['plays-desc', 'Most played'],
  ];
  const SORT_IDS = new Set(SORTS.map((s) => s[0]));
  const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

  function cmpText(key) {
    return (a, b) => {
      const av = (a[key] || '').trim(), bv = (b[key] || '').trim();
      if (!av || !bv) return av ? -1 : bv ? 1 : 0; // blanks last
      return collator.compare(av, bv);
    };
  }
  const durOf = (t) => (Number.isFinite(t.duration) && t.duration > 0 ? t.duration : Infinity);
  const cmpDur = (a, b) => { const x = durOf(a), y = durOf(b); return x === y ? 0 : x < y ? -1 : 1; };

  /**
   * Pure filter + sort. Likes are stored newest-first; playlists oldest-first
   * (tracks are appended), so "date added" is the list order or its reverse.
   */
  function filterSort(tracks, query, mode, kind, playCounts) {
    const q = normalize(query || '');
    const list = q ? tracks.filter((t) => textOf(t).includes(q)) : tracks.slice();
    const newestFirst = kind === 'likes';
    switch (mode) {
      case 'title-asc': list.sort(cmpText('title')); break;
      case 'artist-asc': list.sort(cmpText('artist')); break;
      case 'duration-asc': list.sort(cmpDur); break;
      case 'added-desc': if (!newestFirst) list.reverse(); break;
      case 'added-asc': if (newestFirst) list.reverse(); break;
      case 'plays-desc': {
        const c = playCounts || {};
        list.sort((a, b) => (c[b.id] || 0) - (c[a.id] || 0)); // stable: ties keep list order
        break;
      }
      default: break;
    }
    return list;
  }

  // ------------------------------------------------------------ list toolbar (Likes / playlists)

  const KINDS = new Set(['likes', 'sc', 'local']);
  const sortByKind = Object.assign({}, load('riff_lib_sort', {})); // kind -> mode (remembered, like riff)
  const queries = new Map();                                     // `${kind}:${id}` -> search text (this session)
  const toolEls = new WeakMap();                                 // ctx -> { count }
  const qKey = (ctx) => `${ctx.kind}:${ctx.id ?? ''}`;
  const sortOf = (kind) => (SORT_IDS.has(sortByKind[kind]) ? sortByKind[kind] : 'manual');

  riff.addListTool({
    mount(toolsEl, ctx, refresh) {
      if (!ctx || !KINDS.has(ctx.kind)) return;
      const placeholder = ctx.kind === 'likes' ? 'Search favorites...' : 'Search playlist...';
      const bar = riff.el(`<div class="lib-tools">
        <label class="lib-search">${SEARCH}<input type="text" class="lib-search-input" placeholder="${placeholder}" autocomplete="off" spellcheck="false"></label>
        <span class="lib-count"></span>
        <select class="lib-sort" title="Sort" aria-label="Sort">${SORTS.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('')}</select>
      </div>`);
      const input = bar.querySelector('input');
      const select = bar.querySelector('select');
      input.value = queries.get(qKey(ctx)) || '';
      select.value = sortOf(ctx.kind);
      toolEls.set(ctx, { count: bar.querySelector('.lib-count') });

      let timer = 0;
      input.addEventListener('input', () => {
        queries.set(qKey(ctx), input.value);
        clearTimeout(timer);
        timer = setTimeout(refresh, 90);
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && input.value) {
          e.stopPropagation();
          input.value = '';
          queries.delete(qKey(ctx));
          clearTimeout(timer);
          refresh();
        }
      });
      select.addEventListener('change', async () => {
        sortByKind[ctx.kind] = select.value;
        store('riff_lib_sort', sortByKind);
        if (select.value === 'plays-desc') await loadHistory().catch(() => {});
        refresh();
      });
      toolsEl.append(bar);
      // "Most played" needs play counts; fetch them once in the background.
      if (select.value === 'plays-desc' && !hist) loadHistory().then(refresh, () => {});
    },
    transform(ctx, tracks) {
      if (!ctx || !KINDS.has(ctx.kind)) return tracks;
      const query = queries.get(qKey(ctx)) || '';
      const mode = sortOf(ctx.kind);
      if (!query.trim() && mode === 'manual') { setCount(ctx, ''); return tracks; }
      const out = filterSort(tracks, query, mode, ctx.kind, counts);
      setCount(ctx, query.trim() ? `${out.length} of ${plural(tracks.length, 'track')}` : '');
      return out;
    },
  });
  function setCount(ctx, text) { const e = toolEls.get(ctx); if (e) e.count.textContent = text; }

  // ------------------------------------------------------------ history data (cached in memory)

  let hist = null;          // [{...track, playedAt}] newest first
  let counts = null;        // id -> plays
  let histLoading = null;

  function loadHistory(force) {
    if (hist && !force) return Promise.resolve(hist);
    if (histLoading && !force) return histLoading;
    const p = riff.call('history.list').then((list) => {
      hist = Array.isArray(list) ? list : [];
      recount();
      return hist;
    }).finally(() => { if (histLoading === p) histLoading = null; });
    histLoading = p;
    return p;
  }
  function recount() {
    counts = {};
    for (const e of hist) counts[e.id] = (counts[e.id] || 0) + 1;
  }
  /** Each track once, at its latest play (riff's history view / "Jump back in"). */
  function uniqueRecent(limit = Infinity) {
    const seen = new Set(), out = [];
    for (const e of hist || []) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      out.push(e);
      if (out.length >= limit) break;
    }
    return out;
  }
  function topPlayed(limit) {
    return uniqueRecent().map((t, i) => ({ t, i, c: counts[t.id] || 0 }))
      .sort((a, b) => b.c - a.c || a.i - b.i).slice(0, limit).map((x) => x.t);
  }

  /** Track in the shape history.rs expects (ids as strings, whole seconds). */
  function wireTrack(t) {
    return {
      id: String(t.id), title: t.title || '', artist: t.artist || '', duration: Math.max(0, Math.round(t.duration || 0)),
      artwork: t.artwork || '', url: t.url || '', artist_id: String(t.artist_id || ''), artist_url: t.artist_url || '',
      genre: t.genre || '', style: t.style || '', source: t.source || '', path: t.path || '',
    };
  }

  async function record(t) {
    try {
      const track = wireTrack(t);
      const r = await riff.call('history.add', { track });
      if (hist) {
        const entry = Object.assign({}, track, { playedAt: r.playedAt });
        if (r.added) {
          hist.unshift(entry);
          if (hist.length > HIST_CAP) hist.length = HIST_CAP;
          recount();
        } else if (hist.length) hist[0] = entry;
        else hist.push(entry);
      }
      if (riff.state.view === 'history') riff.render(true);
    } catch (e) {
      riff.log('warn', `history.add: ${riff.errText(e)}`);
    }
  }

  // Record a track once it actually starts playing (trackchange, then the first 'play').
  let pending = null;
  riff.on('trackchange', (t) => { pending = t && t.id != null ? t : null; });
  riff.on('play', (t) => {
    const cur = t || riff.player.current;
    if (pending && cur && cur.id === pending.id) { const p = pending; pending = null; record(p); }
  });

  // ------------------------------------------------------------ History view

  let histMode = 'recent';

  function ago(ms) {
    if (!ms) return '';
    const s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return plural(Math.floor(s / 3600), 'hour') + ' ago';
    const d = Math.floor(s / 86400);
    return d === 1 ? 'yesterday' : `${d} days ago`;
  }

  async function renderHistory(token) {
    if (!hist) {
      const sp = riff.spinner();
      try { await loadHistory(); } catch (e) { if (!riff.stale(token)) { sp.remove(); riff.emptyMsg(riff.errText(e)); } return; }
      if (riff.stale(token)) return;
      sp.remove();
    }
    const recent = uniqueRecent();
    const tracks = histMode === 'top' ? topPlayed(50) : recent;
    const sub = !hist.length ? 'Tracks you play show up here'
      : histMode === 'top' ? `Your ${plural(tracks.length, 'most played track')}`
      : `${plural(recent.length, 'track')} · ${plural(hist.length, 'play')} · ${totalTime(recent)} · last played ${ago(hist[0].playedAt)}`;

    const head = riff.add(`<div class="head-row"><div><div class="page-title">History</div><div class="page-sub">${esc(sub)}</div></div>
      <div class="actions">${hist.length ? riff.listActions() : ''}<button class="btn outline" data-a="clear"${hist.length ? '' : ' disabled'}>${TRASH}Clear history</button></div></div>`);
    riff.wireActions(head, tracks, {
      clear: async () => {
        if (!(await riff.confirmBox('Clear history', 'Remove every track from your listening history?', 'Clear history'))) return;
        try {
          await riff.call('history.clear');
          hist = []; counts = {};
          riff.toast('History cleared');
          if (riff.state.view === 'history') riff.render();
        } catch (e) { riff.toast(riff.errText(e), 'error'); }
      },
    });
    if (!hist.length) { riff.emptyMsg('No recently played tracks.'); return; }

    const tabs = riff.add(`<div class="lib-tabs">
      <button class="lib-chip${histMode === 'recent' ? ' on' : ''}" data-m="recent">Recently played</button>
      <button class="lib-chip${histMode === 'top' ? ' on' : ''}" data-m="top">Most played</button></div>`);
    tabs.addEventListener('click', (e) => {
      const m = e.target.closest('[data-m]')?.dataset.m;
      if (m && m !== histMode) { histMode = m; riff.render(); }
    });
    riff.trackList(riff.view, tracks, { history: true });
  }

  riff.registerView('history', { title: 'History', icon: CLOCK, nav: true, render: renderHistory });

  riff.addTrackMenu((t, opts) => {
    if (!opts || !opts.history || !t) return [];
    return [{
      label: 'Remove from history',
      run: async () => {
        const n = (counts && counts[t.id]) || 0;
        try {
          await riff.call('history.remove', { id: String(t.id) });
          if (hist) { hist = hist.filter((e) => e.id !== t.id); recount(); }
          riff.toast(n > 1 ? `Removed ${n} plays` : 'Removed from history');
          if (riff.state.view === 'history') riff.render(true);
        } catch (e) { riff.toast(riff.errText(e), 'error'); }
      },
    }];
  });

  // ------------------------------------------------------------ Home: "Jump back in" (riff's recent carousel)

  riff.on('render', async ({ view }) => {
    if (view !== 'home' || !riff.pref('jumpBack', true)) return;
    try { await loadHistory(); } catch (e) { return; }
    if (riff.state.view !== 'home') return;
    const root = riff.view;
    if (root.querySelector('.lib-jump')) return;
    const recent = uniqueRecent(12);
    if (!recent.length) return;
    const anchor = root.querySelector('.tiles') || root.firstElementChild;
    if (!anchor) return;
    const title = riff.el(`<div class="section-title lib-jump-title">${CLOCK}Jump back in<button class="lib-more" data-all>See all</button></div>`);
    const strip = riff.el(`<div class="lib-jump">${recent.map((t, i) => `<button class="card" data-i="${i}" title="${esc(t.title)} · ${esc(t.artist)}">
      <div class="c" style="${bg(mid(t.artwork) || small(t.artwork))}">${t.artwork ? '' : riff.ICON.music}</div>
      <div class="a">${esc(t.title)}</div><div class="b">${esc(t.artist)}</div></button>`).join('')}</div>`);
    title.querySelector('[data-all]').onclick = () => { histMode = 'recent'; riff.go('history'); };
    strip.addEventListener('click', (e) => {
      const b = e.target.closest('[data-i]');
      if (b) riff.playList(recent, Number(b.dataset.i));
    });
    anchor.after(title, strip);
  });

  // ------------------------------------------------------------ selftest

  riff.addSelftest(async (log) => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const okf = (c) => (c ? 'OK' : 'FAILED');

    // 1. pure filter / sort
    const mk = (id, title, artist, duration) => ({ id, title, artist, duration, artwork: '', url: '' });
    const L = [mk('1', 'Zebra', 'Beyoncé', 200), mk('2', 'apple', 'Cardi', 90), mk('3', 'Mango', 'adele', 0)];
    const ids = (a) => a.map((t) => t.id).join('');
    const checks = [
      ['title', ids(filterSort(L, '', 'title-asc', 'likes')), '231'],
      ['artist', ids(filterSort(L, '', 'artist-asc', 'likes')), '312'],
      ['duration', ids(filterSort(L, '', 'duration-asc', 'likes')), '213'],
      ['added-asc likes', ids(filterSort(L, '', 'added-asc', 'likes')), '321'],
      ['added-desc playlist', ids(filterSort(L, '', 'added-desc', 'local')), '321'],
      ['search accents', ids(filterSort(L, 'BEYONCE', 'manual', 'likes')), '1'],
      ['search + sort', ids(filterSort(L, 'a', 'title-asc', 'likes')), '231'],
      ['plays', ids(filterSort(L, '', 'plays-desc', 'likes', { 3: 5, 2: 1 })), '321'],
    ];
    const bad = checks.filter(([, got, want]) => got !== want);
    log(`library: filter/sort ${okf(!bad.length)}${bad.length ? ' ' + bad.map(([n, g, w]) => `${n}=${g} want ${w}`).join(', ') : ''}`);

    // 2. backend round-trip with a throwaway track (removed again afterwards)
    let t0 = performance.now();
    await loadHistory(true);
    log(`library: history.list ${hist.length} entries in ${Math.round(performance.now() - t0)}ms`);
    const cur = riff.player.current;
    if (cur && cur.id != null) {
      await wait(300);
      const recentList = await riff.call('history.list', { limit: 5 });
      log(`library: recorded current track ${okf(recentList.some((e) => e.id === String(cur.id)))} ("${cur.title}")`);
    }
    const fake = wireTrack(mk('riff-selftest-history', 'Selftest track', 'riff', 61));
    const a1 = await riff.call('history.add', { track: fake });
    const a2 = await riff.call('history.add', { track: fake });
    const after = await riff.call('history.list', { limit: 3 });
    const cnt = await riff.call('history.counts');
    log(`library: history.add ${okf(a1.added && !a2.added && after[0] && after[0].id === fake.id && cnt[fake.id] === 1)} (added=${a1.added}, repeat added=${a2.added})`);
    const top = await riff.call('history.top', { limit: 3 });
    log(`library: history.top ${okf(Array.isArray(top) && top.length > 0 && top.every((x) => x.track && x.count >= 1))} (${top.map((x) => `${x.track.title} x${x.count}`).join(', ')})`);
    const rm = await riff.call('history.remove', { id: fake.id });
    const left = await riff.call('history.counts');
    log(`library: history.remove ${okf(rm.removed === 1 && !left[fake.id])}`);
    await loadHistory(true);

    // 3. History view renders from the rail
    const prev = riff.state.view, prevArg = riff.state.arg;
    t0 = performance.now();
    riff.go('history');
    await wait(400);
    const title = riff.view.querySelector('.page-title');
    const rows = riff.view.querySelectorAll('.track-row').length;
    const navBtn = document.querySelector('.nav-item[data-view="history"]');
    log(`library: history view ${okf(title && title.textContent === 'History' && navBtn && (rows > 0 || !hist.length))} (${rows} rows, ${hist.length} plays, ${Math.round(performance.now() - t0)}ms)`);

    // 4. Likes toolbar is mounted
    riff.go('likes');
    await wait(300);
    const favs = riff.state.library.favorites.length;
    const bar = riff.view.querySelector('.lib-tools');
    log(`library: likes toolbar ${okf(!favs || !!bar)} (${favs} likes, placeholder "${bar ? bar.querySelector('input').placeholder : '-'}")`);
    riff.go(prev, prevArg);
  });
})();
