'use strict';
// Floating mini player (desktop): a small always-on-top window (ui/mini.html, opened by
// features/system.rs `mini`) with cover, title, like / prev / play / next and progress.
// This side sends it "mini-state" and runs what it asks for ("mini-cmd").
// Open it from the playbar button, a shortcut (Shortcuts → Mini player), or automatically
// while noxx is minimized (Settings → Interface → Mini player).
(() => {
  const R = window.riff;
  if (window.noxxAndroid) return;
  const { emit } = window.__TAURI__.event;
  const audio = R.audio;
  const st = { open: false, auto: false, lastSent: 0 };
  const POSITIONS = [['top-left', 'Top left'], ['top-center', 'Top center'], ['top-right', 'Top right']];

  function theme() {
    const cs = getComputedStyle(document.body);
    const v = (n) => cs.getPropertyValue(n).trim();
    return { '--bg': v('--surface') || v('--bg'), '--fg': v('--on-surface'), '--dim': v('--on-variant'), '--accent': v('--primary'), '--on-accent': v('--on-primary') };
  }
  function send() {
    if (!st.open) return;
    st.lastSent = performance.now();
    const t = R.player.current;
    emit('mini-state', {
      track: t ? { title: t.title, artist: t.artist, artwork: t.artwork ? R.mid(t.artwork) : '' } : null,
      playing: !audio.paused,
      time: audio.currentTime || 0,
      duration: R.duration() || (t && t.duration) || 0,
      liked: !!(t && R.state.favIds && R.state.favIds.has(t.id)),
      theme: theme(),
      cover: R.pref('miniCover', 'record'),
      viz: R.pref('miniViz', 'bars'),
    }).catch(() => {});
    syncLevels();
  }

  // Live spectrum for the mini player's visualizer: ~30 times a second while it's open, playing
  // and showing one. The analyser is released as soon as that stops.
  let levelsTimer = 0, freq = null;
  function syncLevels() {
    const want = st.open && !audio.paused && R.pref('miniViz', 'bars') !== 'off' && typeof R.getAnalyser === 'function';
    if (want && !levelsTimer) levelsTimer = setInterval(sendLevels, 33);
    else if (!want && levelsTimer) { clearInterval(levelsTimer); levelsTimer = 0; if (R.releaseAnalyser) R.releaseAnalyser('mini'); }
  }
  function sendLevels() {
    const an = R.getAnalyser('mini');
    if (!an) return;
    if (!freq || freq.length !== an.frequencyBinCount) freq = new Uint8Array(an.frequencyBinCount);
    an.getByteFrequencyData(freq);
    // 48 bands from the lower ~3/4 of the spectrum (the top is mostly empty for music).
    const n = 48, use = Math.floor(freq.length * 0.75), out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = freq[Math.floor((i / n) * use)];
    emit('mini-levels', out).catch(() => {});
  }

  async function setOpen(open, auto = false) {
    if (open === st.open) { if (open) send(); return; }
    try {
      const r = await R.call('system.mini', { show: open, position: R.pref('miniPos', 'top-right') });
      st.open = !!(r && r.open);
      st.auto = st.open && auto;
      paintBtn();
      syncLevels();
      if (st.open) setTimeout(send, 400);
    } catch (e) {
      R.toast(`Mini player: ${R.errText(e)}`, 'error');
    }
  }
  const toggle = () => setOpen(!st.open);

  R.listen('mini-cmd', (e) => {
    const c = e.payload || {};
    switch (c.action) {
      case 'hello': st.open = true; paintBtn(); send(); break;
      case 'playPause': R.togglePlay(); break;
      case 'next': R.next(false); break;
      case 'prev': R.prev(); break;
      case 'like': if (R.player.current) Promise.resolve(R.toggleFavorite(R.player.current)).then(() => setTimeout(send, 300)); break;
      case 'seek': if (R.duration()) audio.currentTime = Math.max(0, Math.min(1, Number(c.frac) || 0)) * R.duration(); break;
      case 'focusMain': R.call('system.show_main').catch(() => {}); setOpen(false); break;
      case 'close': setOpen(false); break;
      default: break;
    }
  });
  ['play', 'pause', 'seeked', 'durationchange'].forEach((ev) => audio.addEventListener(ev, send));
  audio.addEventListener('timeupdate', () => { if (performance.now() - st.lastSent > 1000) send(); });
  R.on('trackchange', send);
  R.on('library', send);

  // While minimized or in the tray (the page is hidden then), if that option is on.
  document.addEventListener('visibilitychange', () => {
    if (!R.pref('miniOnMinimize', false)) return;
    if (document.hidden && R.player.current && !st.open) setOpen(true, true);
    else if (!document.hidden && st.open && st.auto) setOpen(false);
  });

  // Shortcut action (in app or system-wide).
  if (R.keyActions && !R.keyActions.some((a) => a.id === 'miniPlayer')) {
    R.keyActions.push({ id: 'miniPlayer', name: 'Mini player', keys: [], run: toggle, typing: false });
  }

  // Playbar button.
  const btn = R.el(`<button class="pill-btn mini-pb" title="Mini player">${R.svg('<rect x="3" y="4" width="18" height="14" rx="2"/><rect x="12" y="11" width="7" height="5" rx="1" fill="currentColor"/>')}</button>`);
  btn.addEventListener('click', toggle);
  function paintBtn() { btn.classList.toggle('on', st.open); btn.title = st.open ? 'Close mini player' : 'Mini player'; }
  R.on('ready', () => R.addPlaybarButton(btn));

  R.addSettings(() => {
    const S = R.settingsRow;
    if (!S) return;
    R.add('<div class="section-title">Mini player</div>');
    S.group([
      S.select({ name: 'Position', desc: 'Where the mini player opens. You can drag it anywhere', options: POSITIONS, value: R.pref('miniPos', 'top-right'), onChange: (v) => { R.setPref('miniPos', v); if (st.open) { st.open = false; setOpen(true); } } }),
      S.select({ name: 'Cover', options: [['record', 'Record'], ['wavy', 'Wavy shape']], value: R.pref('miniCover', 'record'), onChange: (v) => { R.setPref('miniCover', v); send(); } }),
      S.select({ name: 'Visualizer', options: [['bars', 'Bars'], ['wave', 'Wave'], ['dots', 'Dots'], ['off', 'Off']], value: R.pref('miniViz', 'bars'), onChange: (v) => { R.setPref('miniViz', v); send(); } }),
      S.prefToggle('miniOnMinimize', false, 'Show when noxx is minimized', 'The mini player opens while the main window is minimized or in the tray, and closes when it comes back'),
      S.button && S.button({ name: 'Open the mini player', label: st.open ? 'Close' : 'Open', onClick: toggle }),
    ]);
  }, 'interface');

  R.mini = { toggle, open: (on) => setOpen(on), get isOpen() { return st.open; } };

  R.addSelftest(async (log) => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    await setOpen(true);
    let hello = false;
    const un = await R.listen('mini-cmd', (e) => { if (e.payload && e.payload.action === 'hello') hello = true; });
    for (let i = 0; i < 40 && !hello; i++) await wait(250);
    log(`mini player open ${st.open && hello ? 'OK' : 'FAILED'} (window ${st.open}, page answered ${hello})`);
    await setOpen(false);
    log(`mini player close ${!st.open ? 'OK' : 'FAILED'}`);
    if (typeof un === 'function') un();
  });
})();
