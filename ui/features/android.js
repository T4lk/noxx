// Android: keeps playback alive in the background and drives the media notification /
// lock-screen controls. `window.noxxAndroid` only exists in the Android app (MainActivity.kt),
// so this does nothing on desktop.
(function () {
  const bridge = window.noxxAndroid;
  if (!bridge) return;
  const riff = window.riff;
  const root = document.documentElement;
  root.classList.add('riff-android');

  // Status / navigation bar heights (CSS px) for the edge-to-edge layout; MainActivity calls
  // this again whenever they change.
  window.__noxxInsets = (top, bottom) => {
    root.style.setProperty('--sat', `${Number(top) || 0}px`);
    root.style.setProperty('--sab', `${Number(bottom) || 0}px`);
  };
  try { const [t, b] = String(bridge.insets()).split(','); window.__noxxInsets(t, b); } catch (e) {}

  // SoundCloud sign-in screen (LoginActivity.kt): resolves with the oauth token, rejects when closed.
  let pendingLogin = null;
  window.noxxLogin = (force) => new Promise((resolve, reject) => {
    pendingLogin = { resolve, reject };
    try { bridge.login(!!force); } catch (e) { pendingLogin = null; reject(e); }
  });
  window.__noxxLoginDone = (token) => {
    const p = pendingLogin; pendingLogin = null;
    if (!p) return;
    if (token) p.resolve(token); else p.reject('Sign-in was closed.');
  };

  // Notification / headset buttons arrive here and go through the same handler as desktop media keys.
  window.__noxxMediaKey = (k) => {
    try { window.__TAURI__.event.emit('media-key', k); } catch (e) {}
  };

  let timer = null;
  function sync() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const t = riff.player.current;
      try {
        if (!t) { bridge.stop(); return; }
        bridge.update(
          String(t.title || ''),
          String(t.artist || ''),
          String(t.artwork || ''),
          !riff.audio.paused,
          Math.round((Number(t.duration) || riff.duration() || 0) * 1000),
          Math.round((riff.audio.currentTime || 0) * 1000),
        );
      } catch (e) {}
    }, 150);
  }

  // ------------------------------------------------------------ now playing (full screen)
  // Tapping the mini player opens the karaoke view (lyrics.js) as a phone "now playing" screen,
  // with a seek bar and shuffle / repeat / like added; the extra buttons drive the playbar's own.
  const $ = (s, r = document) => r.querySelector(s);
  function npExtras() {
    const tv = $('.tvk');
    if (!tv || tv.querySelector('.np-seek')) return tv;
    const side = $('.tvk-side', tv), ctr = $('.tvk-controls', tv);
    const proxy = (id, cls) => {
      const src = document.getElementById(id);
      const b = document.createElement('button');
      b.className = `tvk-ctrl ${cls}`;
      b.title = src ? src.title : '';
      b.innerHTML = src ? src.innerHTML : '';
      b.addEventListener('click', (e) => { e.stopPropagation(); if (src) src.click(); setTimeout(mirror, 50); });
      return b;
    };
    ctr.prepend(proxy('btn-shuffle', 'np-shuffle'));
    ctr.append(proxy('btn-repeat', 'np-repeat'));
    const meta = $('.tvk-meta', tv);
    const row = document.createElement('div');
    row.className = 'np-metarow';
    meta.replaceWith(row);
    row.append(meta, proxy('pb-heart', 'np-heart'));
    const seek = document.createElement('div');
    seek.className = 'np-seek';
    seek.innerHTML = '<input type="range" min="0" max="1000" value="0" aria-label="Seek"><div class="np-times"><span class="np-cur">0:00</span><span class="np-dur">0:00</span></div>';
    ctr.before(seek);
    // Audio effects panel and the queue (the desktop's player-bar buttons).
    const extra = document.createElement('div');
    extra.className = 'np-extra';
    const fx = document.querySelector('.fx-pill');
    const mk = (label, html, run) => { const b = document.createElement('button'); b.className = 'np-chip'; b.innerHTML = `${html}<span>${label}</span>`; b.addEventListener('click', (e) => { e.stopPropagation(); riff.closeNowPlaying(); setTimeout(run, 60); }); return b; };
    if (fx) extra.append(mk('Audio', fx.innerHTML, () => fx.click()));
    const q = document.getElementById('pb-queue');
    extra.append(mk('Queue', q ? q.innerHTML : '', () => riff.go('queue')));
    ctr.after(extra);
    const range = $('input', seek);
    let dragging = false;
    range.addEventListener('input', () => { dragging = true; $('.np-cur', seek).textContent = riff.fmt(range.value / 1000 * (riff.duration() || 0)); });
    range.addEventListener('change', () => {
      const d = riff.duration() || 0;
      if (d) riff.audio.currentTime = range.value / 1000 * d;
      dragging = false;
    });
    riff.audio.addEventListener('timeupdate', () => {
      if (dragging || !riff.nowPlayingOpen || !riff.nowPlayingOpen()) return;
      const d = riff.duration() || 0, t = riff.audio.currentTime || 0;
      range.value = d ? Math.round(t / d * 1000) : 0;
      $('.np-cur', seek).textContent = riff.fmt(t);
      $('.np-dur', seek).textContent = riff.fmt(d);
    });
    return tv;
  }
  function mirror() {
    const tv = $('.tvk');
    if (!tv) return;
    for (const [id, cls] of [['btn-shuffle', 'np-shuffle'], ['btn-repeat', 'np-repeat'], ['pb-heart', 'np-heart']]) {
      const src = document.getElementById(id), b = tv.querySelector(`.${cls}`);
      if (src && b) { b.className = `tvk-ctrl ${cls} ${src.className.replace(/(pill-btn|ctrl-btn|heart)/g, '')}`; b.innerHTML = src.innerHTML; }
    }
  }
  function openNowPlaying() {
    if (!riff.player.current || !riff.openNowPlaying) return;
    npExtras();
    mirror();
    riff.openNowPlaying();
    riff.audio.dispatchEvent(new Event('timeupdate'));
  }
  const pbLeft = $('.pb-left');
  if (pbLeft) {
    pbLeft.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      e.preventDefault(); e.stopPropagation();
      openNowPlaying();
    }, true);
  }
  riff.on('trackchange', () => setTimeout(mirror, 50));

  // ------------------------------------------------------------ back button
  // MainActivity asks this first; false sends noxx to the background (music keeps playing).
  window.__noxxBack = () => {
    if (riff.nowPlayingOpen && riff.nowPlayingOpen()) { riff.closeNowPlaying(); return true; }
    const modal = document.getElementById('modal');
    if (modal && !modal.hidden) { riff.closeModal(); return true; }
    const menu = document.getElementById('menu');
    if (menu && !menu.hidden) { riff.hideMenu(); return true; }
    const back = document.getElementById('nav-back');
    if (back && !back.disabled) { back.click(); return true; }
    if (riff.state && riff.state.view && riff.state.view !== 'home') { const h = document.querySelector('.rail .nav-item[data-view="home"]'); if (h) { h.click(); return true; } }
    return false;
  };

  // ------------------------------------------------------------ settings
  // Rows for things a phone doesn't have (window layout, folders, yt-dlp, keyboard, logs folder).
  const PHONE_HIDDEN = new Set([
    'Position of searchbar', 'No-Hand cursor', 'Docked layout', 'Side bar', 'Shaped cover in the bottom bar',
    'Show wave visualizer in bottom bar', 'Now playing cover', 'Now playing alignment', 'Now playing panel',
    'Show up next in the panel', 'Show About the artist', 'Show Credits', 'Show Next in queue',
    'Show My files tab', 'Required tools', 'Music folder', 'Download folder',
    'Keyboard shortcuts', 'Logs', 'Memory', 'Minimize to tray on close', 'Capture media keys (Windows)',
    'Allow multiple instances',
  ]);
  function pruneSettings() {
    for (const n of document.querySelectorAll('.view .th-item .th-name')) {
      if (PHONE_HIDDEN.has(n.textContent.trim())) n.closest('.th-item').style.display = 'none';
    }
  }
  const pruneSoon = () => { pruneSettings(); setTimeout(pruneSettings, 120); setTimeout(pruneSettings, 600); };
  riff.on('settings-tab', pruneSoon);
  riff.on('render', (r) => { if (r && r.view === 'settings') pruneSoon(); });

  riff.on('trackchange', sync);
  riff.on('play', sync);
  riff.on('pause', sync);
  riff.on('seeked', sync);
})();
