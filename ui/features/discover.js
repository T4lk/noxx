'use strict';
// Discover: artist pages, "For you" SoundCloud mixes, My Wave and song radio.
// Backend: src-tauri/src/features/discover.rs (discover.*). Uses window.riff (see README.md).
(() => {
  const R = window.riff;
  const { esc, bg, mid, small, plural, totalTime, errText, ICON, svg, store, load } = R;

  const IC = {
    radio: svg('<circle cx="12" cy="12" r="2"/><path d="M16.24 7.76a6 6 0 0 1 0 8.49"/><path d="M7.76 16.24a6 6 0 0 1 0-8.49"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M4.93 19.07a10 10 0 0 1 0-14.14"/>'),
    back: svg('<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>'),
    person: svg('<path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/>', true),
    verified: svg('<path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>', true),
    disc: svg('<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/>'),
  };

  const BUFFER = 10;              // songs kept lined up ahead while radio / My Wave runs
  const FOR_YOU_TTL = 10 * 60 * 1000;
  const SUB_VIEWS = new Set(['artist', 'dc-release', 'dc-mix']);

  const D = {
    forYou: null, forYouAt: 0, forYouErr: '', forYouLoading: null,
    wave: null, waveErr: '', waveLoading: null, waveFocus: 0, waveBasis: '',
    recent: load('discover.recent', []),   // recently played SoundCloud tracks (My Wave seeds)
    skipped: new Set(),                     // songs skipped early never steer radio
    auto: null,                             // { mode: 'radio'|'wave', seed, ctx, extending }
    starting: false,
    history: [],
  };

  const isSc = (t) => !!t && !t.source && /^\d+$/.test(String(t.id || ''));
  const hasArtist = (t) => !!t && (!!t.artist_id || !!t.artist_url || (!!t.artist && !/^unknown artist$/i.test(t.artist)));
  const compact = (n) => { try { return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n || 0); } catch (e) { return String(n || 0); } };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------------------------------------------------------------- artist pages

  function artistArg(t) {
    return {
      id: t.artist_id || '',
      url: t.artist_url || '',
      trackId: isSc(t) ? t.id : '',
      name: t.artist || '',
    };
  }
  function openArtist(t) { if (hasArtist(t)) R.go('artist', artistArg(t)); }

  function goBack() {
    D.history.pop(); // this page
    const prev = D.history.pop();
    if (prev) R.go(prev.view, prev.arg); else R.go('discover');
  }

  R.on('render', ({ view, arg }) => {
    const top = D.history[D.history.length - 1];
    if (!top || top.view !== view || top.arg !== arg) D.history.push({ view, arg });
    if (D.history.length > 30) D.history.shift();
    if (view === 'queue') queueNote();
    if (view === 'search') searchExtras();
  });

  // ---------------------------------------------------------------- search: artists + albums rows (riff's "Show artists in search" / "Albums")

  const SX = { q: '', data: null, loading: null };
  function searchExtras() {
    const s = R.state.search;
    const q = (s.query || '').trim();
    const wantArtists = R.pref('searchArtists', true), wantAlbums = R.pref('albums', true);
    const sc = (s.provider ? s.provider.id : R.state.platform) === 'soundcloud';
    if (!q || /^https?:/i.test(q) || !sc || (!wantArtists && !wantAlbums) || !s.results.length) return;
    const root = R.view;
    if (root.querySelector('.dc-sx')) return;
    const fill = (data) => {
      if (R.state.view !== 'search' || R.state.search.query !== s.query || root.querySelector('.dc-sx')) return;
      const artists = wantArtists ? data.artists || [] : [];
      const albums = wantAlbums ? data.albums || [] : [];
      if (!artists.length && !albums.length) return;
      const box = R.el('<div class="dc-sx"></div>');
      if (artists.length) {
        box.append(R.el(`<div class="section-title">${ICON.user}Artists</div>`));
        const row = R.el(`<div class="dc-row dc-artists">${artists.map((a, i) => `<button class="dc-artist" data-i="${i}" title="${esc(a.name)}">
          <div class="dc-artist-av" style="${bg(a.avatar)}">${a.avatar ? '' : IC.person}</div><span>${esc(a.name)}</span></button>`).join('')}</div>`);
        wireRow(row);
        row.addEventListener('click', (e) => {
          const b = e.target.closest('[data-i]');
          if (!b) return;
          const a = artists[Number(b.dataset.i)];
          R.go('artist', { id: a.id, url: a.url, trackId: '', name: a.name });
        });
        box.append(row);
      }
      if (albums.length) {
        box.append(R.el(`<div class="section-title">${IC.disc}Albums</div>`));
        const grid = R.el(`<div class="dc-row dc-sx-albums">${albums.map((r, i) => `<button class="card" data-i="${i}"><div class="c" style="${bg(r.artwork)}">${r.artwork ? '' : IC.disc}</div>
          <div class="a">${esc(r.title)}</div><div class="b">${esc([r.artist, r.year].filter(Boolean).join(' · '))}</div></button>`).join('')}</div>`);
        wireRow(grid);
        grid.addEventListener('click', (e) => { const c = e.target.closest('[data-i]'); if (c) R.go('dc-release', albums[Number(c.dataset.i)]); });
        box.append(grid);
      }
      box.append(R.el('<div class="section-title">Tracks</div>'));
      const anchor = root.querySelector('.page-sub');
      if (anchor) anchor.after(box); else root.prepend(box);
      R.redrawLists();
    };
    const key = `${q}|${wantArtists}|${wantAlbums}`;
    if (SX.q === key && SX.data) { fill(SX.data); return; }
    if (SX.q === key && SX.loading) return;
    SX.q = key; SX.data = null;
    SX.loading = R.call('discover.search_extras', { q, artists: wantArtists, albums: wantAlbums })
      .then((d) => { if (SX.q !== key) return; SX.data = d || {}; fill(SX.data); })
      .catch((e) => R.log('warn', `search extras: ${errText(e)}`))
      .finally(() => { if (SX.q === key) SX.loading = null; });
  }
  R.on('pref', ({ key }) => {
    if ((key === 'searchArtists' || key === 'albums') && R.state.view === 'search') R.render(true);
    if (key === 'myWave' && R.state.view === 'discover') R.render(true);
  });

  R.on('artist', (t) => { if (t && t.source === 'youtube') return; openArtist(t); });

  const backBtn = () => `<button class="pill-btn dc-back" data-a="back" title="Back">${IC.back}</button>`;

  function releaseCards(list) {
    return list.map((r, i) => `<button class="card" data-i="${i}"><div class="c" style="${bg(r.artwork)}">${r.artwork ? '' : IC.disc}</div>
      <div class="a">${esc(r.title)}</div><div class="b">${esc([r.year, plural(r.trackCount, 'track')].filter(Boolean).join(' · '))}</div></button>`).join('');
  }

  function addReleases(title, list) {
    if (!list || !list.length) return;
    R.add(`<div class="section-title">${esc(title)}<span class="dc-count">${list.length}</span></div>`);
    const grid = R.add(`<div class="cards dc-releases">${releaseCards(list)}</div>`);
    grid.addEventListener('click', (e) => {
      const c = e.target.closest('[data-i]');
      if (c) R.go('dc-release', list[Number(c.dataset.i)]);
    });
  }

  async function renderArtist(token, arg) {
    arg = arg || {};
    const card = R.add(`<div class="dc-ahero">
      <div class="dc-ahero-bg"></div>
      ${backBtn()}
      <div class="dc-ahero-body">
        <div class="dc-avatar loading">${IC.person}</div>
        <div class="dc-ameta">
          <div class="dc-verified" hidden>${IC.verified}<span>Verified artist</span></div>
          <h1 class="dc-aname">${esc(arg.name || 'Artist')}</h1>
          <div class="dc-astats">Loading artist…</div>
          <p class="dc-abio" hidden></p>
          <div class="dc-aactions" hidden>
            <button class="dc-bigplay" data-a="play" title="Play popular tracks">${ICON.play}</button>
            <button class="btn" data-a="shuffle">${ICON.shuffle}Shuffle</button>
            <button class="btn outline" data-a="radio">${IC.radio}Artist radio</button>
            <button class="btn outline" data-a="link">Copy link</button>
          </div>
        </div>
      </div>
    </div>`);
    let a = null;
    card.addEventListener('click', (e) => {
      const act = e.target.closest('[data-a]')?.dataset.a;
      if (act === 'back') return goBack();
      if (!a) return;
      const list = a.top.length ? a.top : a.tracks;
      if (act === 'play' && list.length) R.playList(list, 0, false);
      else if (act === 'shuffle' && list.length) R.playList(list, Math.floor(Math.random() * list.length), true);
      else if (act === 'radio' && list.length) startRadio(list[0]);
      else if (act === 'link' && a.url) navigator.clipboard.writeText(a.url).then(() => R.toast('Link copied')).catch(() => {});
    });

    const sp = R.spinner();
    try {
      a = await R.call('discover.artist', arg);
    } catch (e) {
      if (R.stale(token)) return;
      sp.remove();
      card.querySelector('.dc-astats').textContent = '';
      card.querySelector('.dc-avatar').classList.remove('loading');
      R.emptyMsg(errText(e) === 'Artist not found' ? 'No tracks found for this artist.' : errText(e));
      return;
    }
    if (R.stale(token)) return;
    sp.remove();

    const av = card.querySelector('.dc-avatar');
    if (a.avatar) {
      const img = new Image();
      img.onload = () => { av.style.backgroundImage = `url('${a.avatar}')`; av.innerHTML = ''; av.classList.remove('loading'); };
      img.onerror = () => av.classList.remove('loading');
      img.src = a.avatar;
    } else av.classList.remove('loading');
    const back = a.banner || a.avatar;
    if (back) card.querySelector('.dc-ahero-bg').style.backgroundImage = `url('${back}')`;
    card.classList.toggle('has-banner', !!a.banner);
    card.querySelector('.dc-verified').hidden = !a.verified;
    card.querySelector('.dc-aname').textContent = a.name;
    const where = [a.city, a.country].filter(Boolean).join(', ');
    card.querySelector('.dc-astats').textContent = [`${compact(a.followers)} followers`, plural(a.trackCount, 'track'), where].filter(Boolean).join(' · ');
    if (a.description) { const bio = card.querySelector('.dc-abio'); bio.textContent = a.description; bio.hidden = false; }
    card.querySelector('.dc-aactions').hidden = !(a.top.length || a.tracks.length);
    card.querySelector('[data-a=link]').hidden = !a.url;

    if (a.top.length) {
      R.add(`<div class="section-title">Popular tracks<span class="dc-count">${plural(a.top.length, 'track')}</span></div>`);
      R.trackList(R.view, a.top);
    }
    addReleases('Albums', a.albums);
    addReleases('Playlists', a.playlists);
    const topIds = new Set(a.top.map((t) => t.id));
    const latest = a.tracks.filter((t) => !topIds.has(t.id));
    if (latest.length) {
      R.add(`<div class="section-title">Latest uploads<span class="dc-count">${plural(latest.length, 'track')}</span></div>`);
      R.trackList(R.view, latest);
    }
    if (!a.top.length && !a.tracks.length && !a.albums.length && !a.playlists.length) R.emptyMsg('No tracks found for this artist.');
  }

  async function renderRelease(token, r) {
    r = r || {};
    const kind = r.kind ? r.kind[0].toUpperCase() + r.kind.slice(1) : 'Playlist';
    R.add(`<div class="dc-backrow">${backBtn()}</div>`).querySelector('button').onclick = goBack;
    const head = R.hero({
      kicker: [kind, r.year].filter(Boolean).join(' · '), title: r.title || 'Playlist', cover: r.artwork, icon: IC.disc,
      sub: [r.artist, plural(r.trackCount || 0, 'track')].filter(Boolean).join(' · '),
      actions: R.listActions(`<button class="btn outline" data-a="radio">${IC.radio}Start radio</button><button class="btn outline" data-a="artist">Go to artist</button>`),
    });
    const sp = R.spinner();
    let data;
    try { data = await R.call('discover.set', { id: r.id }); } catch (e) { if (!R.stale(token)) { sp.remove(); R.emptyMsg(errText(e)); } return; }
    if (R.stale(token)) return;
    sp.remove();
    const tracks = data.tracks || [];
    head.querySelector('.page-sub').textContent = [data.artist || r.artist, `${plural(tracks.length, 'track')} · ${totalTime(tracks)}`].filter(Boolean).join(' · ');
    R.wireActions(head, tracks, {
      radio: () => tracks.length && startRadio(tracks[0]),
      artist: () => R.go('artist', { id: data.artistId || '', name: data.artist || r.artist || '' }),
    });
    if (!tracks.length) { R.emptyMsg('This playlist is empty.'); return; }
    R.toolList({ kind: 'discover', id: r.id }, tracks);
  }

  async function renderMix(token, urn) {
    const meta = (D.forYou || []).find((p) => p.urn === urn) || { title: 'SoundCloud mix', description: '', artwork: '' };
    R.add(`<div class="dc-backrow">${backBtn()}</div>`).querySelector('button').onclick = goBack;
    const head = R.hero({ kicker: 'Made for you', title: meta.title, cover: meta.artwork, icon: ICON.cloud, sub: meta.description, actions: R.listActions() });
    const sp = R.spinner();
    let data;
    try { data = await R.call('discover.system_playlist', { urn }); } catch (e) { if (!R.stale(token)) { sp.remove(); R.emptyMsg(errText(e)); } return; }
    if (R.stale(token)) return;
    sp.remove();
    const tracks = data.tracks || [];
    head.querySelector('.page-sub').textContent = [data.description || meta.description, `${plural(tracks.length, 'track')} · ${totalTime(tracks)}`].filter(Boolean).join(' · ');
    R.wireActions(head, tracks);
    if (!tracks.length) { R.emptyMsg('This mix is empty right now.'); return; }
    R.toolList({ kind: 'discover', id: urn }, tracks);
  }

  // ---------------------------------------------------------------- For you (SoundCloud system playlists)

  function loggedIn() { const s = R.state.status || {}; return !!s.loggedIn && !s.expired; }

  function loadForYou(refresh) {
    if (!loggedIn()) return Promise.resolve([]);
    if (D.forYouLoading) return D.forYouLoading;
    if (!refresh && D.forYou && Date.now() - D.forYouAt < FOR_YOU_TTL) return Promise.resolve(D.forYou);
    D.forYouLoading = R.call('discover.for_you', { refresh: !!refresh })
      .then((list) => { D.forYou = list || []; D.forYouErr = ''; return D.forYou; })
      .catch((e) => { D.forYouErr = errText(e); D.forYou = D.forYou || []; return D.forYou; })
      .finally(() => { D.forYouAt = Date.now(); D.forYouLoading = null; });
    return D.forYouLoading;
  }

  async function playMix(pl, el) {
    if (!pl || (el && el.classList.contains('loading'))) return;
    if (el) el.classList.add('loading');
    try {
      const data = await R.call('discover.system_playlist', { urn: pl.urn });
      const tracks = data.tracks || [];
      if (!tracks.length) { R.toast(`Couldn't load ${pl.title}`, 'error'); return; }
      R.playList(tracks, 0);
      R.toast(`Playing ${pl.title}`);
    } catch (e) {
      R.toast(`Couldn't load ${pl.title}`, 'error');
    } finally {
      if (el) el.classList.remove('loading');
    }
  }

  function mixRow(list) {
    return `<div class="dc-row">${list.map((p) => `<div class="dc-mix" data-urn="${esc(p.urn)}" title="${esc(p.title)}">
      <div class="dc-mix-art" style="${bg(p.artwork)}">${p.artwork ? '' : ICON.cloud}<button class="dc-play" data-a="play" title="Play">${ICON.play}</button></div>
      <div class="a">${esc(p.title)}</div><div class="b">${esc(p.description || plural(p.trackCount, 'track'))}</div></div>`).join('')}</div>`;
  }

  function wireRow(row) {
    row.addEventListener('wheel', (e) => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && row.scrollWidth > row.clientWidth) { row.scrollLeft += e.deltaY; e.preventDefault(); }
    }, { passive: false });
  }

  async function renderForYou(token, box) {
    if (!loggedIn()) {
      box.innerHTML = `<div class="set-card dc-connect"><div class="i"><div class="a">Made for you</div>
        <div class="b">Connect SoundCloud to get Daily Drops, Weekly Wave, your mixes and artist stations.</div></div>
        <div class="actions"><button class="btn primary" data-a="connect">Connect SoundCloud</button></div></div>`;
      box.querySelector('[data-a=connect]').onclick = () => document.querySelector('#account-pill')?.click();
      return;
    }
    if (!D.forYou) box.innerHTML = '<div class="dc-skel-row">' + '<div class="dc-skel dc-skel-tile"></div>'.repeat(4) + '</div>';
    const list = await loadForYou();
    if (R.stale(token)) return;
    if (!list.length) {
      box.innerHTML = `<div class="page-sub">${esc(D.forYouErr || 'No mixes from SoundCloud yet. Like a few tracks and check back.')}</div>`;
      return;
    }
    const featured = list.filter((p) => p.featured);
    const mixes = list.filter((p) => p.group === 'mix' && !p.featured);
    const stations = list.filter((p) => p.group === 'station');
    let html = '';
    if (featured.length) {
      html += `<div class="tiles dc-featured">${featured.map((p) => `<button class="tile" data-urn="${esc(p.urn)}"><span class="t" style="${bg(p.artwork)}">${p.artwork ? '' : ICON.cloud}</span>
        <span class="i"><div class="a">${esc(p.title)}</div><div class="b">${esc(p.description || plural(p.trackCount, 'track'))}</div></span></button>`).join('')}</div>`;
    }
    if (mixes.length) html += `<div class="dc-label">Your mixes</div>${mixRow(mixes)}`;
    if (stations.length) html += `<div class="dc-label">Stations</div>${mixRow(stations)}`;
    box.innerHTML = html;
    box.querySelectorAll('.dc-row').forEach(wireRow);
    box.addEventListener('click', (e) => {
      const el = e.target.closest('[data-urn]');
      if (!el) return;
      const pl = list.find((p) => p.urn === el.dataset.urn);
      // Featured tiles play right away (like riff); mix cards open, their play button plays.
      if (el.classList.contains('tile') || e.target.closest('[data-a=play]')) playMix(pl, el);
      else R.go('dc-mix', pl.urn);
    });
  }

  // ---------------------------------------------------------------- My Wave

  function noteRecent(t) {
    if (!isSc(t)) return;
    const slim = { id: t.id, title: t.title, artist: t.artist, artist_id: t.artist_id || '', artwork: t.artwork || '' };
    D.recent = [slim, ...D.recent.filter((x) => x.id !== t.id)].slice(0, 60);
    clearTimeout(noteRecent.timer);
    noteRecent.timer = setTimeout(() => store('discover.recent', D.recent), 1500);
  }

  // Likes count most (newest first), recent plays add what you're into right now.
  function waveSeeds() {
    const seeds = new Map();
    const favs = (R.state.library.favorites || []).filter(isSc);
    favs.slice(0, 40).forEach((t, i) => seeds.set(t.id, { id: t.id, weight: i < 10 ? 3 : 2 }));
    D.recent.slice(0, 20).forEach((t, i) => {
      const w = Math.max(0.6, 2 * Math.pow(0.9, i));
      const s = seeds.get(t.id);
      if (s) s.weight += 1; else if (!D.skipped.has(t.id)) seeds.set(t.id, { id: t.id, weight: w });
    });
    if (seeds.size < 5) (R.state.trending || []).filter(isSc).slice(0, 12).forEach((t) => { if (!seeds.has(t.id)) seeds.set(t.id, { id: t.id, weight: 0.5 }); });
    return [...seeds.values()];
  }
  function waveBasis() {
    const n = (R.state.library.favorites || []).filter(isSc).length + D.recent.length;
    return n >= 5 ? 'Songs picked from your likes and what you play' : 'Picked from what\'s trending. Like a few songs to make it yours';
  }
  function heardIds() {
    return (R.state.library.favorites || []).slice(0, 400).map((t) => t.id).concat(D.recent.map((t) => t.id));
  }

  function loadWave(refresh) {
    if (D.waveLoading) return D.waveLoading;
    if (D.wave && !refresh) return Promise.resolve(D.wave);
    const seeds = waveSeeds();
    if (!seeds.length) { D.waveErr = 'Save at least 5 tracks to tune My Wave'; return Promise.resolve(D.wave || []); }
    D.waveLoading = R.call('discover.wave', { seeds, heard: heardIds(), refresh: !!refresh, limit: 30 })
      .then((list) => { D.wave = list || []; D.waveErr = ''; D.waveFocus = 0; D.waveBasis = waveBasis(); return D.wave; })
      .catch((e) => { D.waveErr = errText(e); return D.wave || []; })
      .finally(() => { D.waveLoading = null; });
    return D.waveLoading;
  }

  function playWave(i = 0) {
    const list = D.wave || [];
    if (!list.length) { R.toast(D.waveErr || 'Save at least 5 tracks to tune My Wave'); return; }
    startAuto('wave', list, Math.max(0, Math.min(i, list.length - 1)), null);
    R.toast('Playing My Wave');
  }

  function renderWave(token, pane) {
    const row = pane.querySelector('.dc-wave-row');
    const meta = pane.querySelector('.dc-wave-meta');
    const amb = pane.querySelector('.dc-wave-ambient');
    const list = D.wave || [];
    if (!list.length) {
      row.innerHTML = `<div class="dc-wave-msg">${esc(D.waveErr || 'Nothing here yet.')}<button class="btn outline" data-a="retry">${ICON.sync}Try again</button></div>`;
      row.querySelector('[data-a=retry]').onclick = () => refreshWave(token, pane);
      meta.innerHTML = '';
      amb.style.backgroundImage = '';
      return;
    }
    pane.querySelector('.dc-wave-sub').textContent = D.waveBasis || waveBasis();
    row.innerHTML = list.map((t, i) => `<div class="dc-wave-card" data-i="${i}"><div class="dc-wave-cover" style="${bg(t.artwork)}">${t.artwork ? '' : ICON.music}</div>
      <div class="dc-play">${ICON.play}</div></div>`).join('');
    const cards = [...row.children];
    let focus = -1;
    const setFocus = (i) => {
      if (i === focus) return;
      focus = i;
      D.waveFocus = i;
      cards.forEach((c, j) => { const d = Math.abs(j - i); c.classList.toggle('focus', d === 0); c.classList.toggle('near', d > 0 && d <= 2); c.classList.toggle('far', d > 2); });
      const t = list[i];
      meta.innerHTML = `<div class="dc-wave-title">${esc(t.title)}</div><div class="dc-wave-artist">${esc(t.artist)}</div>`;
      amb.style.backgroundImage = t.artwork ? `url('${mid(t.artwork)}')` : '';
    };
    const centerOf = (c) => c.offsetLeft + c.offsetWidth / 2;
    const scrollTo = (i, smooth) => row.scrollTo({ left: centerOf(cards[i]) - row.clientWidth / 2, behavior: smooth ? 'smooth' : 'auto' });
    let queued = false;
    row.addEventListener('scroll', () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        const center = row.scrollLeft + row.clientWidth / 2;
        let best = 0, bestD = Infinity;
        cards.forEach((c, j) => { const d = Math.abs(centerOf(c) - center); if (d < bestD) { bestD = d; best = j; } });
        setFocus(best);
      });
    });
    let wheelAt = 0;
    row.addEventListener('wheel', (e) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      e.preventDefault();
      if (Date.now() - wheelAt < 160) return;
      wheelAt = Date.now();
      const i = Math.max(0, Math.min(cards.length - 1, focus + Math.sign(e.deltaY)));
      setFocus(i);
      scrollTo(i, true);
    }, { passive: false });
    row.addEventListener('click', (e) => {
      const c = e.target.closest('.dc-wave-card');
      if (!c) return;
      const i = Number(c.dataset.i);
      if (i === focus) playWave(i); else { setFocus(i); scrollTo(i, true); }
    });
    row.addEventListener('contextmenu', (e) => {
      const c = e.target.closest('.dc-wave-card');
      if (!c) return;
      e.preventDefault();
      const t = list[Number(c.dataset.i)];
      R.showMenu([
        { label: 'Play My Wave from here', run: () => playWave(Number(c.dataset.i)) },
        { label: 'Play next', run: () => R.addToQueue(t, true) },
        { label: 'Add to queue', run: () => R.addToQueue(t) },
        { label: 'Start radio', run: () => startRadio(t) },
        { label: 'Go to artist', run: () => openArtist(t) },
      ], e.clientX, e.clientY);
    });
    const start = Math.min(D.waveFocus || 0, cards.length - 1);
    setFocus(start);
    requestAnimationFrame(() => scrollTo(start, false));
  }

  async function refreshWave(token, pane) {
    pane.classList.add('loading');
    await loadWave(true);
    if (R.stale(token)) return;
    pane.classList.remove('loading');
    renderWave(token, pane);
  }

  // ---------------------------------------------------------------- Discover view

  function topArtists() {
    const counts = new Map();
    const add = (t, w) => {
      if (!hasArtist(t) || !t.artist) return;
      const k = t.artist_id || t.artist.toLowerCase();
      const e = counts.get(k) || { n: 0, t };
      e.n += w;
      if (!e.t.artwork && t.artwork) e.t = t;
      counts.set(k, e);
    };
    (R.state.library.favorites || []).slice(0, 500).forEach((t) => add(t, 1));
    D.recent.forEach((t) => add(t, 2));
    return [...counts.values()].filter((e) => e.n >= 2).sort((a, b) => b.n - a.n).slice(0, 14).map((e) => e.t);
  }

  async function renderDiscover(token) {
    R.add('<div class="page-title">Discover</div><div class="page-sub">Your wave, mixes made for you and artists you like</div>');

    const waveOn = R.pref('myWave', true);
    const pane = R.add(`<div class="dc-wave"${waveOn ? '' : ' hidden'}>
      <div class="dc-wave-ambient"></div>
      <div class="dc-wave-head">
        <div><div class="dc-wave-label">My Wave</div><div class="dc-wave-sub">${esc(D.waveBasis || waveBasis())}</div></div>
        <div class="actions">
          <button class="pill-btn" data-a="refresh" title="Refresh wave">${ICON.sync}</button>
          <button class="btn primary" data-a="play">${ICON.play}Play wave</button>
        </div>
      </div>
      <div class="dc-wave-row"></div>
      <div class="dc-wave-meta"></div>
    </div>`);
    pane.querySelector('[data-a=refresh]').onclick = () => refreshWave(token, pane);
    pane.querySelector('[data-a=play]').onclick = async () => {
      if (!D.wave || !D.wave.length) { await loadWave(); if (R.stale(token)) return; renderWave(token, pane); }
      playWave(D.waveFocus || 0);
    };

    R.add(`<div class="section-title">${ICON.cloud}For you</div>`);
    const fy = R.add('<div class="dc-foryou"></div>');

    const artists = topArtists();
    if (artists.length) {
      R.add(`<div class="section-title">${ICON.user}Your artists</div>`);
      const row = R.add(`<div class="dc-row dc-artists">${artists.map((t, i) => `<button class="dc-artist" data-i="${i}" title="${esc(t.artist)}">
        <div class="dc-artist-av" style="${bg(mid(t.artwork))}">${t.artwork ? '' : IC.person}</div><span>${esc(t.artist)}</span></button>`).join('')}</div>`);
      wireRow(row);
      row.addEventListener('click', (e) => { const b = e.target.closest('[data-i]'); if (b) openArtist(artists[Number(b.dataset.i)]); });
    }

    R.add(`<div class="section-title">${IC.radio}Song radio</div>`);
    R.add(`<div class="set-card"><div class="i"><div class="a">Endless songs like the one you love</div>
      <div class="b">Pick “Start radio” in any song's ⋯ menu, or press the radio button in the player bar. Radio stays in the song's genre and keeps the queue topped up as you listen.</div></div>
      <div class="actions"><button class="btn outline" data-a="radio" ${R.player.current ? '' : 'disabled'}>${IC.radio}Radio from current song</button></div></div>`)
      .querySelector('[data-a=radio]').onclick = () => R.player.current && startRadio(R.player.current);

    // Both sections load in parallel; each fills in when ready.
    const wavePromise = (async () => {
      if (!waveOn) return;
      if (!D.wave) {
        pane.querySelector('.dc-wave-row').innerHTML = '<div class="dc-wave-card dc-skel near"></div><div class="dc-wave-card dc-skel focus"></div><div class="dc-wave-card dc-skel near"></div>';
        await loadWave();
        if (R.stale(token)) return;
      }
      renderWave(token, pane);
    })();
    await Promise.all([wavePromise, renderForYou(token, fy)]);
  }

  R.registerView('discover', { title: 'Discover', icon: IC.radio, nav: true, render: renderDiscover });
  R.registerView('artist', { title: 'Artist', render: renderArtist });
  R.registerView('dc-release', { title: 'Album', render: renderRelease });
  R.registerView('dc-mix', { title: 'Mix', render: renderMix });

  // ---------------------------------------------------------------- song radio / endless wave

  const pill = R.el(`<button class="pill-btn dc-radio-pill" title="Start radio: endless songs like this one" aria-pressed="false">${IC.radio}</button>`);
  R.addPlaybarButton(pill, 'left');
  pill.onclick = () => {
    if (D.auto) { const mode = D.auto.mode; stopAuto(); R.toast(mode === 'wave' ? 'My Wave off' : 'Radio off'); return; }
    if (!R.player.current) { R.toast('Play a song first, then start radio from it'); return; }
    startRadio(R.player.current);
  };

  function updatePill() {
    const a = D.auto;
    pill.classList.toggle('on', !!a);
    pill.classList.toggle('loading', D.starting);
    pill.setAttribute('aria-pressed', a ? 'true' : 'false');
    pill.title = a
      ? (a.mode === 'radio' ? `Radio on: songs like ${a.seed.title || 'this one'}. Click to turn off` : 'My Wave is on. Click to turn off')
      : 'Start radio: endless songs like this one';
  }

  function queueNote() {
    const a = D.auto;
    if (!a) return;
    R.add(`<div class="dc-queue-note">${esc(a.mode === 'radio'
      ? `Radio is on: more songs like ${a.seed.title || 'this one'} are added as you listen`
      : 'My Wave is on: more songs are added as you listen')}</div>`);
  }

  function stopAuto() {
    if (!D.auto) return;
    D.auto = null;
    updatePill();
    if (R.state.view === 'queue') R.render(true);
  }

  // Lines the list up as the play context in its own order (radio order matters more than shuffle).
  function startAuto(mode, list, start, seed) {
    const p = R.player;
    const keepPlaying = p.current && list[start] && p.current.id === list[start].id;
    p.context = list.slice();
    p.order = p.context.map((_, i) => i);
    p.pos = start;
    D.auto = { mode, seed, ctx: p.context, extending: false };
    if (!keepPlaying) R.playTrack(p.context[start]);
    updatePill();
    R.queueChanged();
    topUp();
  }

  async function startRadio(track) {
    if (!track || D.starting) return;
    if (!isSc(track)) { R.toast('Song radio works with SoundCloud tracks'); return; }
    D.starting = true;
    updatePill();
    R.toast(`Starting radio from ${track.title || 'this song'}…`);
    try {
      const recs = (await R.call('discover.radio', { seed: track, avoid: [track.id], limit: 12 })) || [];
      const seen = new Set([track.id]);
      const list = [track, ...recs.filter((t) => !seen.has(t.id) && seen.add(t.id))];
      if (list.length < 2) { R.toast(`Couldn't find songs like ${track.title || 'this one'}`, 'error'); return; }
      startAuto('radio', list, 0, track);
      R.toast(`Radio on: songs like ${track.title || 'this one'}`);
    } catch (e) {
      R.toast('Couldn\'t start radio', 'error');
    } finally {
      D.starting = false;
      updatePill();
    }
  }

  // Keeps BUFFER songs lined up ahead, so the queue never looks like it ends.
  async function topUp(attempt = 0) {
    const a = D.auto;
    const p = R.player;
    if (!a || a.extending || attempt > 3 || p.context !== a.ctx) return 0;
    if (p.order.length - 1 - p.pos >= BUFFER) return 0;
    a.extending = true;
    let added = 0;
    try {
      const avoid = p.context.map((t) => t.id).slice(-300);
      let more;
      if (a.mode === 'radio') {
        // The last couple of radio songs (not skipped) add variety without drifting far.
        const played = [];
        for (let i = 1; i <= p.pos && i < p.order.length; i++) {
          const t = p.context[p.order[i]];
          if (t && t.id !== a.seed.id && !D.skipped.has(t.id)) played.push(t.id);
        }
        more = await R.call('discover.radio', { seed: a.seed, played: played.slice(-2), avoid, limit: 10 });
      } else {
        more = await R.call('discover.wave', { seeds: waveSeeds(), heard: heardIds(), avoid, refresh: true, limit: 15 });
      }
      if (D.auto !== a || p.context !== a.ctx) return 0;
      const have = new Set(p.context.map((t) => t.id));
      for (const t of more || []) {
        if (have.has(t.id)) continue;
        have.add(t.id);
        p.order.push(p.context.length);
        p.context.push(t);
        added++;
      }
      if (added) R.queueChanged();
    } catch (e) {
      R.log('warn', `discover top-up: ${errText(e)}`);
    } finally {
      a.extending = false;
    }
    if (added) return added + await topUp(attempt + 1);
    return 0;
  }

  let lastTrack = null, endedNaturally = false;
  R.on('ended', () => { endedNaturally = true; });
  R.on('trackchange', (t) => {
    // Skipped within 20 s: a miss, so it never steers radio or the wave.
    if (lastTrack && lastTrack !== t && !endedNaturally && R.audio.currentTime > 0 && R.audio.currentTime < 20) D.skipped.add(lastTrack.id);
    endedNaturally = false;
    lastTrack = t;
    noteRecent(t);
    if (D.auto && R.player.context !== D.auto.ctx) stopAuto(); // something else started playing
    else if (D.auto) topUp();
  });

  // ---------------------------------------------------------------- menus & player bar

  R.addTrackMenu((t) => {
    const items = [];
    if (isSc(t)) items.push({ label: 'Start radio', run: () => startRadio(t) });
    if (hasArtist(t)) items.push({ label: 'Go to artist', run: () => openArtist(t) });
    return items;
  });

  // Artist names in the player bar and right panel open the artist page (like riff).
  for (const sel of ['#pb-artist', '#rp-artist']) {
    const el = document.querySelector(sel);
    if (!el) continue;
    el.classList.add('dc-artist-link');
    el.addEventListener('click', (e) => { e.stopPropagation(); if (R.player.current) openArtist(R.player.current); });
  }

  // Warm My Wave and For you shortly after start, so Discover opens instantly.
  let warmed = false;
  R.on('status', (s) => {
    if (warmed) { if (s && s.loggedIn && !s.expired && !D.forYou) setTimeout(() => loadForYou(), 1200); return; }
    warmed = true;
    setTimeout(() => { loadWave().catch(() => {}); loadForYou().catch(() => {}); }, 2500);
  });

  // ---------------------------------------------------------------- selftest (no user input, audio muted)

  R.addSelftest(async (log) => {
    const ms = (t0) => `${Math.round(performance.now() - t0)}ms`;
    const until = async (fn, limit) => { const end = Date.now() + limit; while (Date.now() < end) { if (fn()) return true; await wait(100); } return false; };
    const ok = (b) => (b ? 'OK' : 'FAILED');
    const stub = (t) => t.title === 'untitled' || t.artist === 'unknown artist' || !t.duration;
    await until(() => R.state.trending, 15000);
    const pool = (R.state.trending || []).filter(isSc);
    const seed = pool[0];
    if (!seed) { log('discover: FAILED no trending tracks to test with'); return; }

    const st = await R.call('discover.style', { text: 'HUMPSTEKK Hard Techno (Sped Up)' });
    log(`discover style ${ok(st.families.harddance && st.families.techno && st.edit)}: ${Object.keys(st.families).join(',')} edit=${st.edit}`);

    let t0 = performance.now();
    let a = null;
    try { a = await R.call('discover.artist', artistArg(seed)); } catch (e) { log(`discover artist FAILED: ${errText(e)}`); }
    if (a) {
      log(`discover artist ${ok(a.name && (a.top.length || a.tracks.length))}: "${a.name}" ${a.followers} followers, ${a.top.length} popular, ${a.tracks.length} latest, ${a.albums.length} albums, ${a.playlists.length} playlists, stubs ${a.top.concat(a.tracks).filter(stub).length} (${ms(t0)})`);
      t0 = performance.now();
      await R.call('discover.artist', artistArg(seed));
      log(`discover artist cached: ${ms(t0)}`);
      try {
        const byName = await R.call('discover.artist', { name: seed.artist });
        log(`discover artist by name ${ok(!!byName.id)}: "${seed.artist}" -> ${byName.name} (${byName.id}), same user: ${byName.id === a.id}`);
      } catch (e) { log(`discover artist by name FAILED: ${errText(e)}`); }
      const rel = a.albums[0] || a.playlists[0];
      if (rel) {
        t0 = performance.now();
        try {
          const s = await R.call('discover.set', { id: rel.id });
          log(`discover release ${ok(s.tracks.length > 0 || !rel.trackCount)}: "${s.title}" ${s.tracks.length}/${rel.trackCount} tracks, stubs ${s.tracks.filter(stub).length} (${ms(t0)})`);
        } catch (e) { log(`discover release FAILED: ${errText(e)}`); }
      }
      R.go('artist', artistArg(seed));
      const drawn = await until(() => document.querySelector('#view .dc-aname')?.textContent === a.name && document.querySelector('#view .track-row'), 8000);
      log(`discover artist view ${ok(drawn)}: rows ${document.querySelectorAll('#view .track-row').length}, releases ${document.querySelectorAll('#view .dc-releases .card').length}`);
    }

    t0 = performance.now();
    try {
      const r = await R.call('discover.radio', { seed, avoid: [seed.id], limit: 10 });
      log(`discover radio ${ok(r.length > 0)}: ${r.length} songs like "${seed.title}" [${seed.genre}] (${ms(t0)}); first: ${r.slice(0, 3).map((t) => `${t.title} / ${t.genre}`).join(' | ')}`);
    } catch (e) { log(`discover radio FAILED: ${errText(e)}`); }

    t0 = performance.now();
    const w = await loadWave(true);
    log(`discover wave ${ok(w.length > 0)}: ${w.length} tracks from ${waveSeeds().length} seeds (${ms(t0)})${D.waveErr ? ' error: ' + D.waveErr : ''}`);

    if (loggedIn()) {
      t0 = performance.now();
      const fy = await loadForYou(true);
      log(`discover for you ${ok(fy.length > 0)}: ${fy.length} mixes (${ms(t0)}): ${fy.slice(0, 4).map((p) => p.title).join(' | ')}${D.forYouErr ? ' error: ' + D.forYouErr : ''}`);
      if (fy[0]) {
        t0 = performance.now();
        try {
          const m = await R.call('discover.system_playlist', { urn: fy[0].urn });
          log(`discover mix ${ok(m.tracks.length > 0)}: "${m.title}" ${m.tracks.length} tracks, stubs ${m.tracks.filter(stub).length} (${ms(t0)})`);
        } catch (e) { log(`discover mix FAILED: ${errText(e)}`); }
      }
    } else log('discover for you: skipped (not signed in)');

    R.go('discover');
    const shown = await until(() => document.querySelectorAll('#view .dc-wave-card:not(.dc-skel)').length > 0, 10000);
    log(`discover view ${ok(shown)}: ${document.querySelectorAll('#view .dc-wave-card').length} wave cards, ${document.querySelectorAll('#view .dc-foryou [data-urn]').length} mixes, nav ${ok(document.querySelector('.nav-item[data-view=discover]'))}`);

    // Radio queue flow: start, then check it keeps topping up.
    R.audio.muted = true;
    t0 = performance.now();
    await startRadio(seed);
    const started = !!D.auto && R.player.context.length > 1;
    const first = R.player.context.length;
    log(`discover radio queue ${ok(started)}: ${first} queued (${ms(t0)}), pill on=${pill.classList.contains('on')}, now "${R.player.current?.title}"`);
    if (started) {
      // Pretend the radio has nearly run out and check it tops itself up.
      await until(() => !D.auto || !D.auto.extending, 10000);
      const before = R.player.context.length;
      R.player.pos = Math.max(0, R.player.order.length - 2);
      t0 = performance.now();
      const added = await topUp();
      log(`discover radio top-up ${ok(added > 0 && R.player.context.length > before)}: +${added} (${before} -> ${R.player.context.length}) in ${ms(t0)}`);
    }
    stopAuto();
    log(`discover radio off ${ok(!D.auto && !pill.classList.contains('on'))}`);
    R.audio.pause();
  });
})();
