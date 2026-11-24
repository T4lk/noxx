'use strict';
// Playback and the device around it (desktop):
// - pause when an audio output goes away (headphones unplugged, Bluetooth dropped)
// - keep the screen and PC awake while music plays (features/system.rs keep_awake)
(() => {
  const R = window.riff;
  const audio = R.audio;
  if (window.noxxAndroid) return; // Android pauses on unplug in PlaybackService

  // ---------------------------------------------------------------- pause on unplug
  // Only an output disappearing pauses: plugging something in never does. Without device ids
  // (no media permission) every change looks the same, so any change counts, as in riff.
  const md = navigator.mediaDevices;
  let outputs = null; // Set of audiooutput ids, or null before the first read
  const readOutputs = async () => {
    try { return (await md.enumerateDevices()).filter((d) => d.kind === 'audiooutput').map((d) => d.deviceId || ''); } catch (e) { return null; }
  };
  if (md && md.addEventListener) {
    readOutputs().then((l) => { outputs = l; });
    md.addEventListener('devicechange', async () => {
      const now = await readOutputs();
      const before = outputs;
      outputs = now;
      if (!now || !before || !R.pref('pauseOnUnplug', true) || audio.paused) return;
      const known = before.every((id) => id) && now.every((id) => id);
      const lost = known ? before.some((id) => !now.includes(id)) : true;
      if (!lost) return;
      audio.pause();
      R.log('info', `audio output changed (${before.length} -> ${now.length}), paused`);
      R.toast('Audio output changed, paused');
    });
  }

  // ---------------------------------------------------------------- keep awake while playing
  let awake = false;
  function syncAwake() {
    const want = R.pref('keepAwake', false) && !audio.paused && !!R.player.current;
    if (want === awake) return;
    awake = want;
    R.call('system.keep_awake', { on: want }).catch((e) => R.log('warn', `keep awake: ${R.errText(e)}`));
  }
  audio.addEventListener('play', syncAwake);
  audio.addEventListener('pause', syncAwake);
  audio.addEventListener('ended', syncAwake);
  R.on('pref', (p) => { if (p.key === 'keepAwake') syncAwake(); });

  // ---------------------------------------------------------------- taskbar preview buttons (Windows)
  // Prev / play-pause / next under the taskbar thumbnail (Rust: features/thumbbar.rs); clicks come
  // back as media keys. Here: keep the middle button's icon in step with playback.
  if (/Windows/.test(navigator.userAgent)) {
    const thumb = () => R.call('system.thumbbar', { playing: !audio.paused }).catch(() => {});
    audio.addEventListener('play', thumb);
    audio.addEventListener('pause', thumb);
  }

  // ---------------------------------------------------------------- settings
  R.addSettings(() => {
    const S = R.settingsRow;
    if (!S) return;
    R.add('<div class="section-title">Devices</div>');
    S.group([
      md && S.prefToggle('pauseOnUnplug', true, 'Pause when headphones disconnect', 'Pauses when an audio output goes away, like unplugged headphones or a dropped Bluetooth connection'),
      /Windows/.test(navigator.userAgent) && S.prefToggle('keepAwake', false, 'Keep the screen awake while playing', 'Stops the screen and PC from going to sleep while music plays (also keeps HDMI and some USB audio from cutting out)'),
    ]);
  }, 'tracks');

  // ---------------------------------------------------------------- selftest (QoL features from riff's list)
  R.addSelftest(async (log) => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const until = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await wait(100); } return false; };
    const ok = (b) => (b ? 'OK' : 'FAILED');

    // keep awake: the command answers and turns off again
    try { await R.call('system.keep_awake', { on: true }); await R.call('system.keep_awake', { on: false }); log('keep awake OK'); } catch (e) { log(`keep awake FAILED: ${R.errText(e)}`); }

    // resume session: the queue and position are saved while something is loaded
    const sess = R.load('session', null), at = R.load('sessionAt', null);
    log(`session saved ${ok(!R.player.current || (sess && sess.current && sess.current.id === R.player.current.id && Array.isArray(sess.tracks)))}: "${sess?.current?.title}", ${sess?.tracks?.length} tracks, pos ${sess?.pos}, at ${at?.at}s`);

    // recent searches: Enter remembers, the empty box lists it, clicking searches again
    const input = document.querySelector('#search-input');
    input.focus();
    input.value = 'noxx selftest query';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await wait(300);
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.blur(); input.focus();
    await wait(100);
    const items = [...document.querySelectorAll('.search-history .sh-item span')].map((x) => x.textContent);
    log(`search history ${ok(items[0] === 'noxx selftest query')}: [${items.slice(0, 3).join(' | ')}]`);
    const del = document.querySelector('.search-history [data-del="0"]');
    if (del) del.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await wait(100);
    log(`search history remove ${ok(!R.load('searchHistory', []).includes('noxx selftest query'))}`);
    input.blur();

    // album version of a music video ("Official Audio" upload == the radio edit song)
    try {
      const hit = await R.call('youtube.album_version', { id: 'yt:h5EofwRzit0', title: 'Daft Punk - Get Lucky (Official Audio) ft. Pharrell Williams, Nile Rodgers', artist: 'Daft Punk', duration: 249 });
      log(`album version ${ok(hit && hit.id && hit.id !== 'yt:h5EofwRzit0' && Math.abs(hit.duration - 249) <= 2)}: ${hit ? `${hit.id} "${hit.title}" ${hit.duration}s` : 'none'}`);
    } catch (e) { log(`album version FAILED: ${R.errText(e)}`); }

    // drop a file onto the window: a generated WAV lands in My files
    try {
      const st = await R.call('localfiles.selftest');
      const path = st.tracks && st.tracks[0] && st.tracks[0].path;
      if (!path) throw new Error('no generated file');
      await window.__TAURI__.event.emit('tauri://drag-drop', { paths: [path], position: { x: 10, y: 10 } });
      const added = await until(() => (R.localfiles.lib.files || []).some((f) => String(f).toLowerCase() === String(path).toLowerCase()), 8000);
      log(`drop to add ${ok(added && R.state.view === 'files')}: ${path}`);
      await R.call('localfiles.remove', { path });
    } catch (e) { log(`drop to add FAILED: ${R.errText(e)}`); }

    // rebindable shortcuts: a custom key runs its action, the old default stops
    const keys0 = R.pref('keys', {});
    const press = (init) => document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }));
    const shuf0 = R.player.shuffle;
    R.setPref('keys', { ...keys0, shuffle: ['Ctrl+Alt+9'] });
    document.activeElement && document.activeElement.blur && document.activeElement.blur();
    press({ key: '9', code: 'Digit9', ctrlKey: true, altKey: true });
    const custom = R.player.shuffle !== shuf0;
    press({ key: 'h', code: 'KeyH' });
    const oldDead = R.player.shuffle !== shuf0; // still toggled once = H did nothing
    R.setPref('keys', keys0);
    if (R.player.shuffle !== shuf0) press({ key: 'h', code: 'KeyH' });
    log(`shortcuts rebind ${custom && oldDead ? 'OK' : 'FAILED'} (custom ${custom}, old key ignored ${oldDead})`);
    try { const r = await R.call('system.global_keys', { map: { like: 'Ctrl+Alt+Shift+F11' } }); await R.call('system.global_keys', { map: {} }); log(`global key register ${r && r.failed && !r.failed.like ? 'OK' : 'FAILED'}: ${JSON.stringify(r)}`); } catch (e) { log(`global key register FAILED: ${R.errText(e)}`); }

    // lyrics timing: the button shows for synced lyrics; nudging "this song" is saved per song
    const btn = document.querySelector('.lyrics-action-btn[data-a="timing"]');
    if (btn && !btn.hidden) {
      btn.click();
      await wait(100);
      document.querySelector('.ly-timing [data-n="song"][data-d="0.25"]')?.click();
      const v = document.querySelector('.ly-timing [data-v="song"]')?.textContent;
      log(`lyrics timing ${ok(v === '+0.25 s' && Object.keys(R.load('lyricsOffsets', {})).length > 0)}: ${v}`);
      document.querySelector('.ly-timing [data-n="song"][data-d="reset"]')?.click();
      btn.click();
    } else {
      log('lyrics timing skipped: no synced lyrics showing');
    }
  });
})();
