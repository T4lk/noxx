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
  const SUB_VIEWS = new Set(['artist', 'dc-artist-cat', 'dc-release', 'dc-mix']);

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

  // ---------------------------------------------------------------- artist page
  // Full-bleed banner (carousel when the profile has several), huge name with a
  // cookie-shaped verified badge, Play / Follow row, then Popular, Discography
  // (chips), Playlists, All tracks, Fans also like and About. Every section
  // header opens its full category page (dc-artist-cat).

  Object.assign(IC, {
    chev: svg('<polyline points="9 18 15 12 9 6"/>'),
    chevL: svg('<polyline points="15 18 9 12 15 6"/>'),
    info: svg('<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>'),
    follow: svg('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/>'),
    following: svg('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><polyline points="16 11 18 13 22 9"/>'),
  });

  // An 8-lobed "cookie" outline for the verified badge, drawn once.
  const COOKIE = (() => {
    const pts = [];
    for (let i = 0; i < 96; i++) {
      const t = (i / 96) * Math.PI * 2, r = 10.6 + 1.25 * Math.cos(8 * t);
      pts.push(`${(12 + r * Math.cos(t)).toFixed(2)} ${(12 + r * Math.sin(t)).toFixed(2)}`);
    }
    return `M${pts.join('L')}Z`;
  })();
  const verifiedBadge = () => `<span class="dc-badge" title="Verified artist" aria-label="Verified artist"><svg viewBox="0 0 24 24">
    <path class="s" d="${COOKIE}"/><polyline class="k" points="7.6 12.4 10.6 15.3 16.5 9.2"/></svg></span>`;

  const AP_CATS = {
    popular: 'Popular', discography: 'Discography', playlists: 'Playlists', tracks: 'All tracks', related: 'Fans also like',
  };
  const isSingle = (r) => /^(single|ep)$/i.test(r.kind || '');
  const isAlbum = (r) => !isSingle(r);
  const DISCO_CHIPS = [
    ['popular', 'Popular releases', (l) => l.slice().sort((x, y) => (y.likes || 0) - (x.likes || 0))],
    ['albums', 'Albums', (l) => l.filter(isAlbum)],
    ['singles', 'Singles and EPs', (l) => l.filter(isSingle)],
  ];
  const kindLabel = (r) => ({ album: 'Album', ep: 'EP', single: 'Single', compilation: 'Compilation' })[(r.kind || '').toLowerCase()] || 'Playlist';

  function shelfCards(list) {
    return list.map((r, i) => `<button class="card dc-rcard" data-i="${i}"><div class="c" style="${bg(r.artwork)}">${r.artwork ? '' : IC.disc}</div>
      <div class="a" title="${esc(r.title)}">${esc(r.title)}</div><div class="b">${esc([r.year, r.kind === 'playlist' || !r.kind ? plural(r.trackCount, 'track') : kindLabel(r)].filter(Boolean).join(' · '))}</div></button>`).join('');
  }
  function wireReleases(host, getList) {
    host.addEventListener('click', (e) => {
      const c = e.target.closest('.dc-rcard[data-i]');
      if (c) R.go('dc-release', getList()[Number(c.dataset.i)]);
    });
  }
  function artistCards(list) {
    return list.map((p, i) => `<button class="dc-fan" data-i="${i}" title="${esc(p.name)}">
      <div class="dc-fan-av" style="${bg(p.avatar)}">${p.avatar ? '' : IC.person}</div>
      <div class="a">${esc(p.name)}${p.verified ? verifiedBadge() : ''}</div><div class="b">${p.followers ? `${compact(p.followers)} followers` : 'Artist'}</div></button>`).join('');
  }
  function wireArtists(host, list) {
    host.addEventListener('click', (e) => {
      const b = e.target.closest('.dc-fan[data-i]');
      if (!b) return;
      const p = list[Number(b.dataset.i)];
      R.go('artist', { id: p.id, url: p.url, trackId: '', name: p.name });
    });
  }

  // R.trackList plus a plays column (rows are virtual, so stamp each row as it is drawn).
  function playsList(container, tracks, plays, opts) {
    R.trackList(container, tracks, opts);
    const el = container.lastElementChild;
    el.classList.add('dc-plist');
    const stamp = () => {
      for (const row of el.children) {
        if (row.querySelector('.dc-plays')) continue;
        const t = tracks[Number(row.dataset.i)];
        const n = t && plays && plays[t.id];
        const s = document.createElement('span');
        s.className = 'dc-plays';
        s.textContent = n ? Number(n).toLocaleString('en') : '';
        if (n) s.title = `${Number(n).toLocaleString('en')} plays`;
        const fav = row.querySelector('.tr-fav');
        if (fav) fav.before(s); else row.append(s);
      }
    };
    stamp();
    new MutationObserver(stamp).observe(el, { childList: true });
    return el;
  }

  function secHead(cat, title, count) {
    return `<button class="dc-sec-head" data-cat="${cat}" title="Show all">
      <h2>${esc(title)}</h2>${count ? `<span class="dc-count">${esc(count)}</span>` : ''}<span class="dc-sec-arrow">${IC.chev}</span></button>`;
  }

  function aboutHtml(a) {
    const pic = a.banners && a.banners[1] || a.avatar || a.banner;
    const where = [a.city, a.country].filter(Boolean).join(', ');
    return `<button class="dc-about" data-a="bio">
      <div class="dc-about-pic" style="${bg(pic)}"></div>
      <div class="dc-about-body">
        <div class="dc-about-top">${a.avatar ? `<span class="dc-about-av" style="${bg(a.avatar)}"></span>` : ''}
          <div><div class="dc-about-num">${compact(a.followers)} followers</div>
          <div class="dc-about-sub">${esc([plural(a.trackCount, 'track'), where].filter(Boolean).join(' · '))}</div></div></div>
        ${a.description ? `<p class="dc-about-bio">${esc(a.description)}</p>` : '<p class="dc-about-bio dim">No bio yet.</p>'}
      </div></button>`;
  }

  function showBio(a) {
    const where = [a.city, a.country].filter(Boolean).join(', ');
    const m = R.openModal(`<div class="dc-bio-modal">
      ${a.avatar || a.banner ? `<div class="dc-bio-pic" style="${bg(a.banner || a.avatar)}"></div>` : ''}
      <h3>${esc(a.name)}${a.verified ? verifiedBadge() : ''}</h3>
      <div class="dc-bio-stats">${esc([`${compact(a.followers)} followers`, a.followings ? `${compact(a.followings)} following` : '', plural(a.trackCount, 'track'), where].filter(Boolean).join(' · '))}</div>
      <p class="dc-bio-text">${esc(a.description || 'No bio yet.')}</p>
      <div class="row-btns">${a.url ? '<button class="btn outline" data-k="link">Copy link</button>' : ''}<button class="btn primary" data-k="close">Close</button></div></div>`);
    m.querySelector('[data-k=close]').onclick = () => R.closeModal();
    const l = m.querySelector('[data-k=link]');
    if (l) l.onclick = () => navigator.clipboard.writeText(a.url).then(() => R.toast('Link copied')).catch(() => {});
  }

  // Banner carousel: slides move by transform (200 ms), auto-advance while shown.
  function mountBanner(hero, a) {
    const slides = (a.banners && a.banners.length ? a.banners : [a.banner || a.avatar]).filter(Boolean).slice(0, 6);
    const track = hero.querySelector('.dc-ah-track');
    hero.classList.toggle('no-banner', !a.banner);
    if (!slides.length) return;
    track.innerHTML = slides.map((u) => `<div class="dc-ah-slide" style="background-image:url('${esc(u)}')"></div>`).join('');
    const img = new Image();
    img.onload = () => hero.classList.add('ready');
    img.onerror = () => hero.classList.add('ready');
    img.src = slides[0];
    if (slides.length < 2) return;
    const ctrl = hero.querySelector('.dc-ah-ctrl');
    const dots = ctrl.querySelector('.dc-ah-dots');
    dots.innerHTML = slides.map((_, i) => `<button class="dc-ah-dot" data-s="${i}" aria-label="Banner ${i + 1}"></button>`).join('');
    ctrl.hidden = false;
    let at = 0, timer = 0;
    const show = (i) => {
      at = (i + slides.length) % slides.length;
      track.style.transform = `translateX(${-at * 100}%)`;
      dots.querySelectorAll('.dc-ah-dot').forEach((d, j) => d.classList.toggle('active', j === at));
    };
    const arm = () => {
      clearInterval(timer);
      timer = setInterval(() => {
        if (!hero.isConnected) { clearInterval(timer); return; }
        if (!R.asleep && !hero.matches(':hover')) show(at + 1);
      }, 7000);
    };
    ctrl.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      e.stopPropagation();
      if (b.dataset.s) show(Number(b.dataset.s));
      else show(at + (b.dataset.a === 'prev' ? -1 : 1));
      arm();
    });
    show(0);
    arm();
  }

  async function mountFollow(btn, a, fansEl) {
    if (!loggedIn() || !a.id) return;
    let st;
    if (typeof a.following === 'boolean') st = { loggedIn: true, following: a.following };
    else try { st = await R.call('discover.follow_state', { id: a.id }); } catch (e) { return; }
    if (!btn.isConnected || st.self || !st.loggedIn) return;
    let on = st.following === true;
    const paint = () => {
      btn.classList.toggle('on', on);
      btn.innerHTML = `${on ? IC.following : IC.follow}<span>${on ? 'Following' : 'Follow'}</span>`;
      btn.title = on ? 'Unfollow on SoundCloud' : 'Follow on SoundCloud';
    };
    paint();
    btn.hidden = false;
    btn.dataset.state = st.following === null ? 'unknown' : on ? 'following' : 'not-following';
    btn.onclick = async (e) => {
      e.stopPropagation();
      if (btn.disabled) return;
      btn.disabled = true;
      try {
        const r = await R.call('discover.follow', { id: a.id, on: !on });
        a.followers = Math.max(0, (a.followers || 0) + (r.following === on ? 0 : r.following ? 1 : -1));
        on = !!r.following;
        btn.dataset.state = on ? 'following' : 'not-following';
        paint();
        if (fansEl) fansEl.textContent = fansLine(a);
        R.toast(on ? `Following ${a.name}` : `Unfollowed ${a.name}`);
      } catch (err) {
        R.toast(errText(err), 'error');
      } finally {
        btn.disabled = false;
      }
    };
  }

  function fansLine(a) {
    return [`${(a.followers || 0).toLocaleString('en')} followers`, a.trackCount ? plural(a.trackCount, 'track') : '', [a.city, a.country].filter(Boolean).join(', ')].filter(Boolean).join(' · ');
  }

  async function renderArtist(token, arg) {
    arg = arg || {};
    const page = R.add(`<div class="dc-ap">
      <div class="dc-ah">
        <div class="dc-ah-track"></div>
        <button class="dc-ah-back" data-a="back" title="Back">${IC.back}</button>
        <div class="dc-ah-ctrl" hidden><button class="dc-ah-nav" data-a="prev" title="Previous banner">${IC.chevL}</button><div class="dc-ah-dots"></div><button class="dc-ah-nav" data-a="next" title="Next banner">${IC.chev}</button></div>
        <div class="dc-ah-info">
          <div class="dc-ah-av" hidden></div>
          <div class="dc-ah-text">
            <div class="dc-ah-name"><h1 class="dc-aname">${esc(arg.name || 'Artist')}</h1><span class="dc-ah-badge"></span></div>
            <div class="dc-ah-fans">Loading artist…</div>
          </div>
        </div>
      </div>
      <div class="dc-abar" hidden>
        <button class="dc-bigplay" data-a="play" title="Play">${ICON.play}</button>
        <button class="dc-ibtn" data-a="shuffle" title="Shuffle">${ICON.shuffle}</button>
        <button class="dc-follow" data-a="follow" hidden></button>
        <button class="dc-ibtn" data-a="radio" title="Artist radio">${IC.radio}</button>
        <button class="dc-ibtn" data-a="bio" title="About">${IC.info}</button>
        <button class="dc-ibtn" data-a="more" title="More">${ICON.more}</button>
      </div>
    </div>`);
    const hero = page.querySelector('.dc-ah');
    let a = null;
    page.addEventListener('click', (e) => {
      const act = e.target.closest('[data-a]')?.dataset.a;
      if (act === 'back') return goBack();
      if (!a) return;
      const list = a.top.length ? a.top : a.tracks;
      if (act === 'play' && list.length) R.playList(list, 0, false);
      else if (act === 'shuffle' && list.length) R.playList(list, Math.floor(Math.random() * list.length), true);
      else if (act === 'radio' && list.length) startRadio(list[0]);
      else if (act === 'bio') showBio(a);
      else if (act === 'more') {
        const r = e.target.closest('[data-a]').getBoundingClientRect();
        R.showMenu([
          { label: 'Artist radio', run: () => list.length && startRadio(list[0]) },
          { label: 'About', run: () => showBio(a) },
          ...(a.url ? [{ label: 'Copy link', run: () => navigator.clipboard.writeText(a.url).then(() => R.toast('Link copied')).catch(() => {}) }] : []),
          { label: 'Refresh', run: () => R.call('discover.artist', { id: a.id, refresh: true }).then(() => R.render(true)).catch((err) => R.toast(errText(err), 'error')) },
        ], r.left, r.bottom + 4);
      }
    });

    const sp = R.spinner();
    try {
      a = await R.call('discover.artist', arg);
    } catch (e) {
      if (R.stale(token)) return;
      sp.remove();
      hero.classList.add('ready', 'no-banner');
      page.querySelector('.dc-ah-fans').textContent = '';
      R.emptyMsg(errText(e) === 'Artist not found' ? 'No tracks found for this artist.' : errText(e));
      return;
    }
    if (R.stale(token)) return;
    sp.remove();
    a.banners = a.banners || [];
    a.plays = a.plays || {};
    a.related = a.related || [];

    mountBanner(hero, a);
    page.querySelector('.dc-aname').textContent = a.name;
    if (a.verified) page.querySelector('.dc-ah-badge').innerHTML = verifiedBadge();
    const fans = page.querySelector('.dc-ah-fans');
    fans.textContent = fansLine(a);
    if (!a.banner && a.avatar) {
      const av = page.querySelector('.dc-ah-av');
      av.style.backgroundImage = `url('${a.avatar}')`;
      av.hidden = false;
    }
    const bar = page.querySelector('.dc-abar');
    const playable = a.top.length || a.tracks.length;
    bar.hidden = false;
    for (const k of ['play', 'shuffle', 'radio']) bar.querySelector(`[data-a=${k}]`).hidden = !playable;
    mountFollow(bar.querySelector('.dc-follow'), a, fans);

    const body = R.add('<div class="dc-abody"></div>');
    body.addEventListener('click', (e) => {
      const head = e.target.closest('.dc-sec-head[data-cat]');
      if (head) R.go('dc-artist-cat', { id: a.id, name: a.name, cat: head.dataset.cat });
    });

    // Popular: 5 rows, "See more" shows 10.
    if (a.top.length) {
      body.insertAdjacentHTML('beforeend', `<section class="dc-sec dc-sec-popular">${secHead('popular', 'Popular')}<div class="dc-pop"></div>
        ${a.top.length > 5 ? '<button class="dc-more" data-more="1">See more</button>' : ''}</section>`);
      const sec = body.lastElementChild, box = sec.querySelector('.dc-pop');
      let open = false;
      const draw = () => { box.innerHTML = ''; playsList(box, a.top.slice(0, open ? 10 : 5), a.plays, { onPlay: (i) => R.playList(a.top, i) }); };
      draw();
      const more = sec.querySelector('[data-more]');
      if (more) more.onclick = () => { open = !open; more.textContent = open ? 'Show less' : 'See more'; draw(); };
    }

    // Discography with chips.
    if (a.albums.length) {
      const chips = DISCO_CHIPS.filter(([, , f]) => f(a.albums).length);
      body.insertAdjacentHTML('beforeend', `<section class="dc-sec">${secHead('discography', 'Discography', plural(a.albums.length, 'release'))}
        <div class="dc-chips">${chips.map(([k, label], i) => `<button class="dc-chip${i ? '' : ' on'}" data-chip="${k}">${esc(label)}</button>`).join('')}</div>
        <div class="dc-shelf"></div></section>`);
      const sec = body.lastElementChild, shelf = sec.querySelector('.dc-shelf');
      let shown = [];
      const pick = (k) => {
        shown = DISCO_CHIPS.find((c) => c[0] === k)[2](a.albums).slice(0, 12);
        shelf.innerHTML = shelfCards(shown);
        sec.querySelectorAll('.dc-chip').forEach((c) => c.classList.toggle('on', c.dataset.chip === k));
      };
      sec.querySelector('.dc-chips').addEventListener('click', (e) => { const c = e.target.closest('[data-chip]'); if (c) pick(c.dataset.chip); });
      wireReleases(shelf, () => shown);
      wireRow(shelf);
      pick(chips[0] ? chips[0][0] : 'popular');
    }

    if (a.playlists.length) {
      body.insertAdjacentHTML('beforeend', `<section class="dc-sec">${secHead('playlists', 'Playlists', String(a.playlists.length))}
        <div class="dc-shelf">${shelfCards(a.playlists.slice(0, 12))}</div></section>`);
      const shelf = body.lastElementChild.querySelector('.dc-shelf');
      wireReleases(shelf, () => a.playlists);
      wireRow(shelf);
    }

    if (a.tracks.length) {
      body.insertAdjacentHTML('beforeend', `<section class="dc-sec">${secHead('tracks', 'All tracks', plural(Math.max(a.trackCount || 0, a.tracks.length), 'track'))}<div class="dc-all"></div></section>`);
      const latest = a.tracks.slice(0, 10);
      playsList(body.lastElementChild.querySelector('.dc-all'), latest, a.plays, { onPlay: (i) => R.playList(a.tracks, i) });
    }

    if (a.related.length) {
      body.insertAdjacentHTML('beforeend', `<section class="dc-sec dc-sec-fans">${secHead('related', 'Fans also like')}<div class="dc-row dc-fans">${artistCards(a.related.slice(0, 12))}</div></section>`);
      const row = body.lastElementChild.querySelector('.dc-fans');
      wireArtists(row, a.related);
      wireRow(row);
    }

    body.insertAdjacentHTML('beforeend', `<section class="dc-sec dc-sec-about"><div class="dc-sec-title">About</div>${aboutHtml(a)}</section>`);
    body.querySelector('.dc-about').onclick = () => showBio(a);

    if (!a.top.length && !a.tracks.length && !a.albums.length && !a.playlists.length) R.emptyMsg('No tracks found for this artist.');
  }

  // Category sub-page: every popular song, the whole discography, playlists, all uploads (paged) or related artists.
  async function renderArtistCat(token, arg) {
    arg = arg || {};
    const cat = AP_CATS[arg.cat] ? arg.cat : 'popular';
    const head = R.add(`<div class="dc-cat-head">
      <button class="pill-btn dc-back" data-a="back" title="Back to artist">${IC.back}</button>
      <div class="dc-cat-info"><h1 class="dc-cat-title">${esc(AP_CATS[cat])}</h1><div class="dc-cat-sub">${esc(arg.name || '')}</div></div>
      <div class="dc-cat-actions"></div></div>`);
    head.querySelector('[data-a=back]').onclick = goBack;
    const sub = head.querySelector('.dc-cat-sub');
    const sp = R.spinner();
    let a;
    try { a = await R.call('discover.artist', { id: arg.id, name: arg.name }); } catch (e) { if (!R.stale(token)) { sp.remove(); R.emptyMsg(errText(e)); } return; }
    if (R.stale(token)) return;
    sp.remove();
    const plays = a.plays || {};
    const body = R.add('<div class="dc-cat-body"></div>');
    const actions = (tracks) => {
      const box = head.querySelector('.dc-cat-actions');
      box.innerHTML = R.listActions();
      R.wireActions(box, tracks);
    };

    if (cat === 'popular') {
      sub.textContent = `${a.name} · ${plural(a.top.length, 'song')}`;
      actions(a.top);
      if (!a.top.length) return R.emptyMsg('No popular songs yet.');
      playsList(R.view, a.top, plays);
    } else if (cat === 'discography' || cat === 'playlists') {
      const all = cat === 'playlists' ? a.playlists : a.albums;
      sub.textContent = `${a.name} · ${plural(all.length, cat === 'playlists' ? 'playlist' : 'release')}`;
      if (!all.length) return R.emptyMsg('Nothing here yet.');
      let shown = all;
      if (cat === 'discography') {
        const chips = [['all', 'All', (l) => l], ...DISCO_CHIPS].filter(([, , f]) => f(all).length);
        body.insertAdjacentHTML('beforeend', `<div class="dc-chips">${chips.map(([k, l], i) => `<button class="dc-chip${i ? '' : ' on'}" data-chip="${k}">${esc(l)}</button>`).join('')}</div>`);
        body.lastElementChild.addEventListener('click', (e) => {
          const c = e.target.closest('[data-chip]');
          if (!c) return;
          shown = chips.find((x) => x[0] === c.dataset.chip)[2](all);
          grid.innerHTML = shelfCards(shown);
          body.querySelectorAll('.dc-chip').forEach((x) => x.classList.toggle('on', x === c));
        });
      }
      body.insertAdjacentHTML('beforeend', `<div class="cards dc-grid">${shelfCards(shown)}</div>`);
      const grid = body.lastElementChild;
      wireReleases(grid, () => shown);
    } else if (cat === 'related') {
      const list = a.related || [];
      sub.textContent = `Artists ${a.name}'s fans listen to`;
      if (!list.length) return R.emptyMsg('No related artists found.');
      body.insertAdjacentHTML('beforeend', `<div class="dc-fan-grid">${artistCards(list)}</div>`);
      wireArtists(body.lastElementChild, list);
    } else {
      // All tracks, 50 per page, more load as the end comes into view.
      const tracks = a.tracks.slice();
      const allPlays = Object.assign({}, plays);
      let next = a.tracksNext || '', loading = false, list = null;
      const total = () => Math.max(a.trackCount || 0, tracks.length);
      const draw = () => {
        sub.textContent = `${a.name} · ${plural(total(), 'track')}${next ? ` · ${tracks.length} loaded` : ''}`;
        if (list) list.remove();
        list = playsList(body, tracks, allPlays);
        body.append(foot);
        foot.hidden = !next;
      };
      const foot = R.el('<div class="dc-cat-foot"><button class="btn outline" data-a="more">Load more</button></div>');
      const loadMore = async () => {
        if (loading || !next) return;
        loading = true;
        foot.firstElementChild.textContent = 'Loading…';
        try {
          const p = await R.call('discover.artist_tracks', { id: a.id, next });
          if (R.stale(token)) return;
          const have = new Set(tracks.map((t) => t.id));
          for (const t of p.tracks || []) if (!have.has(t.id)) { have.add(t.id); tracks.push(t); }
          Object.assign(allPlays, p.plays || {});
          next = p.next || '';
          const top = R.view.scrollTop;
          draw();
          R.view.scrollTop = top;
        } catch (e) {
          R.toast(errText(e), 'error');
        } finally {
          loading = false;
          foot.firstElementChild.textContent = 'Load more';
        }
      };
      foot.firstElementChild.onclick = loadMore;
      actions(tracks);
      if (!tracks.length) return R.emptyMsg('No tracks yet.');
      draw();
      const io = new IntersectionObserver((es) => { if (!foot.isConnected) { io.disconnect(); return; } if (es.some((x) => x.isIntersecting)) loadMore(); }, { root: R.view, rootMargin: '400px' });
      io.observe(foot);
    }
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
  R.registerView('dc-artist-cat', { title: 'Artist', render: renderArtistCat });
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
      // Pick the richest artist among a few trending ones, so banner / albums / related all get exercised.
      const score = (x) => (x.banners.length ? 1 : 0) + (x.albums.length ? 1 : 0) + (x.related.length ? 1 : 0) + (x.top.length ? 1 : 0);
      let rich = a, richArg = artistArg(seed);
      const seenArtists = new Set([a.id]);
      for (const t of pool.slice(1, 12)) {
        if (score(rich) >= 4) break;
        if (!t.artist_id || seenArtists.has(t.artist_id)) continue;
        seenArtists.add(t.artist_id);
        try { const b = await R.call('discover.artist', artistArg(t)); if (score(b) > score(rich)) { rich = b; richArg = artistArg(t); } } catch (e) { /* next */ }
      }
      D.testArtist = richArg;
      a = rich;
      const withPlays = a.top.filter((t) => a.plays[t.id]).length;
      const singles = a.albums.filter(isSingle).length;
      log(`discover artist banner ${ok(a.banners.length > 0 || !!a.avatar)}: "${a.name}" ${a.banners.length} banners, avatar ${!!a.avatar}, verified ${a.verified}`);
      log(`discover artist popular ${ok(a.top.length > 0 && withPlays > 0)}: ${a.top.length} songs, ${withPlays} with play counts, stubs ${a.top.filter(stub).length}`);
      log(`discover artist albums ${ok(Array.isArray(a.albums) && a.albums.every((r) => r.id && r.title))}: ${a.albums.length} releases (${singles} singles/EPs), ${a.playlists.length} playlists`);
      log(`discover artist related ${ok(Array.isArray(a.related) && a.related.every((p) => p.id && p.name && p.id !== a.id))}: ${a.related.length} artists${a.related.length ? `: ${a.related.slice(0, 4).map((p) => p.name).join(' | ')}` : ' (section hidden)'}`);
      if (a.tracksNext) {
        t0 = performance.now();
        try {
          const p = await R.call('discover.artist_tracks', { id: a.id, next: a.tracksNext });
          log(`discover artist tracks page ${ok(p.tracks.length > 0)}: +${p.tracks.length} after ${a.tracks.length}, stubs ${p.tracks.filter(stub).length}, more ${!!p.next} (${ms(t0)})`);
        } catch (e) { log(`discover artist tracks page FAILED: ${errText(e)}`); }
      } else log(`discover artist tracks page: skipped (all ${a.tracks.length} uploads fit one page)`);
      let fstate = null;
      if (loggedIn()) {
        try {
          fstate = await R.call('discover.follow_state', { id: a.id });
          log(`discover artist follow state ${ok(fstate.loggedIn && (fstate.following !== null || fstate.self))}: following=${fstate.following} via ${fstate.via || 'self'}, artist.following=${a.following} ${ok(a.following === fstate.following)}`);
        } catch (e) { log(`discover artist follow state FAILED: ${errText(e)}`); }
      } else log('discover artist follow state: skipped (not signed in)');

      R.go('artist', richArg);
      const q = (s) => document.querySelectorAll(`#view ${s}`).length;
      const drawn = await until(() => document.querySelector('#view .dc-aname')?.textContent === a.name && q('.dc-ah.ready') && (q('.track-row') || !a.top.length), 8000);
      if (fstate && !fstate.self) await until(() => document.querySelector('#view .dc-follow:not([hidden])'), 5000);
      const fans = q('.dc-fan'), wantFans = Math.min(12, a.related.length);
      const follow = document.querySelector('#view .dc-follow');
      log(`discover artist view ${ok(drawn)}: banner ${ok(q('.dc-ah-slide') > 0)} ${q('.dc-ah-slide')} slides, popular ${ok(q('.dc-sec-popular .track-row') === Math.min(5, a.top.length) && (!a.top.length || q('.dc-sec-popular .dc-plays') > 0))} ${q('.dc-sec-popular .track-row')} rows, discography ${ok(!a.albums.length || q('.dc-chip') > 0)} ${q('.dc-shelf .dc-rcard')} cards ${q('.dc-chip')} chips, fans ${ok(fans === wantFans)} ${fans}, about ${ok(q('.dc-about') === 1)}, follow ${loggedIn() ? ok(!follow.hidden || (fstate && fstate.self)) : 'n/a'} ${follow && !follow.hidden ? follow.dataset.state : 'hidden'}`);

      for (const cat of ['popular', 'discography', 'tracks', 'related']) {
        if ((cat === 'discography' && !a.albums.length) || (cat === 'related' && !a.related.length)) continue;
        R.go('dc-artist-cat', { id: a.id, name: a.name, cat });
        const sel = cat === 'discography' ? '.dc-grid .card' : cat === 'related' ? '.dc-fan-grid .dc-fan' : '.track-row';
        const shown = await until(() => document.querySelector('#view .dc-cat-title') && q(sel) > 0, 8000);
        log(`discover artist category ${cat} ${ok(shown)}: "${document.querySelector('#view .dc-cat-title')?.textContent}" ${q(sel)} items, sub "${document.querySelector('#view .dc-cat-sub')?.textContent}"`);
      }
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

    // Leave the artist page open (for screenshots of the finished run).
    if (D.testArtist) {
      R.go('artist', D.testArtist);
      const back = await until(() => document.querySelector('#view .dc-ah.ready') && document.querySelector('#view .dc-abody'), 8000);
      log(`discover artist page left open ${ok(back)}`);
      await wait(5000); // a short hold so the page can be captured before other selftests move on
    }
  });
})();
