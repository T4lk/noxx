'use strict';
// Offline mode: when the connection drops, songs that aren't on this PC (downloads, My files)
// are passed over instead of failing one by one, a chip in the top bar says so, and it all
// switches back when the connection returns. Detection: the OS online flag plus a tiny probe,
// since a network that's "up" can still have no internet.
(() => {
  const R = window.riff;
  const PROBE = 'https://www.gstatic.com/generate_204';
  const st = { offline: !navigator.onLine, timer: 0, chip: null };

  const onDevice = (t) => !!t && (t.source === 'local' || (R.downloads && R.downloads.has(t.id)) || (R.cache && R.cache.has(t.id) && R.pref('songCache', true)));
  R.addSkip((t) => (st.offline && !onDevice(t) ? "you're offline and this song isn't downloaded" : ''));

  async function probe() {
    if (!navigator.onLine) return false;
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 5000);
    try { await fetch(PROBE, { mode: 'no-cors', cache: 'no-store', signal: ctl.signal }); return true; } catch (e) { return false; } finally { clearTimeout(t); }
  }

  function set(offline) {
    clearTimeout(st.timer);
    // While offline, look again every 20 s (the OS flag alone misses captive / dead Wi-Fi).
    if (offline) st.timer = setTimeout(check, 20000);
    if (offline === st.offline) return paint();
    st.offline = offline;
    R.log('info', `offline mode ${offline ? 'on' : 'off'}`);
    R.toast(offline ? "You're offline. Playing downloaded songs and your files only" : 'Back online');
    document.body.classList.toggle('is-offline', offline);
    paint();
    R.emit('offline', offline);
    // The song that was playing can't continue from the network: move on to one on this PC.
    const cur = R.player.current;
    if (offline && cur && !onDevice(cur) && !R.audio.paused) setTimeout(() => { if (st.offline && R.audio.paused) R.next(false); }, 1500);
  }
  async function check() { set(!(await probe())); }

  function paint() {
    if (!st.chip) {
      st.chip = R.el(`<button type="button" class="offline-chip" hidden title="No internet connection. Click to check again">${R.svg('<path d="M1 1l22 22"/><path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55"/><path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39"/><path d="M10.71 5.05A16 16 0 0 1 22.58 9"/><path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/>')}<span>Offline</span></button>`);
      st.chip.addEventListener('click', () => { st.chip.classList.add('busy'); check().finally(() => st.chip && st.chip.classList.remove('busy')); });
      document.querySelector('.nav-right')?.prepend(st.chip);
    }
    st.chip.hidden = !st.offline;
  }

  window.addEventListener('offline', () => set(true));
  window.addEventListener('online', () => setTimeout(check, 1000));
  // A stream that fails while the OS still says "online" may be the first sign: check then.
  R.audio.addEventListener('error', () => { if (!st.offline) check(); });
  R.on('ready', () => { paint(); if (st.offline) set(true); else check(); });

  R.offline = { get on() { return st.offline; }, check, onDevice };

  R.addSelftest(async (log) => {
    const remote = { id: 'yt:selftest00000', title: 'Selftest remote', artist: 'x', source: 'youtube' };
    const local = { id: 'local:selftest', title: 'Selftest local', artist: 'x', source: 'local', path: 'C:/x.mp3' };
    const was = st.offline;
    st.offline = true;
    const skipRemote = R.skipReason(remote), skipLocal = R.skipReason(local);
    st.offline = was;
    log(`offline skip ${skipRemote && !skipLocal ? 'OK' : 'FAILED'}: remote "${skipRemote}", local "${skipLocal}"`);
    log(`offline probe: ${(await probe()) ? 'online' : 'offline'}, chip ${st.chip && st.chip.isConnected ? 'mounted' : 'missing'}`);
  });
})();
