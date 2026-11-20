'use strict';
// Discord Rich Presence: mirrors the current track to Discord ("Listening to riff").
// Backend: src-tauri/src/features/discord.rs (discord.status / setEnabled / update / clear / preview).
(() => {
  const riff = window.riff;
  const { esc } = riff;

  const LOGO = '<svg class="dc-logo" viewBox="0 0 127.14 96.36" fill="currentColor" aria-hidden="true"><path d="M107.7,8.07A105.15,105.15,0,0,0,81.47,0a72.06,72.06,0,0,0-3.36,6.83A97.68,97.68,0,0,0,49,6.83,72.37,72.37,0,0,0,45.64,0,105.89,105.89,0,0,0,19.39,8.09C2.79,32.65-1.71,56.6.54,80.21h0A105.73,105.73,0,0,0,32.71,96.36,77.7,77.7,0,0,0,39.6,85.25a68.42,68.42,0,0,1-10.85-5.18c.91-.66,1.8-1.34,2.66-2a75.57,75.57,0,0,0,64.32,0c.87.71,1.76,1.39,2.66,2a68.68,68.68,0,0,1-10.87,5.19,77,77,0,0,0,6.89,11.1A105.25,105.25,0,0,0,126.6,80.22h0C129.24,52.84,122.09,29.11,107.7,8.07ZM42.45,65.69C36.18,65.69,31,60,31,53s5-12.74,11.43-12.74S54,46,53.89,53,48.84,65.69,42.45,65.69Zm42.24,0C78.41,65.69,73.31,60,73.31,53s5-12.74,11.43-12.74S96.1,46,96,53,91.08,65.69,84.69,65.69Z"/></svg>';

  // The Rust side owns the persisted setting; this cached copy only paints the toggle instantly.
  let status = { enabled: riff.load('discord_rpc', true), connected: false, user: null, error: null, showing: null };
  let timer = 0;
  // Selftest plays tracks muted; keep them off the user's real Discord profile.
  let quiet = false;
  riff.invoke('selftest_mode').then((on) => { quiet = !!on; }).catch(() => {});

  function payload(t) {
    return {
      title: t.title || '',
      artist: t.artist || '',
      artwork: t.artwork || '',
      url: t.url || '',
      source: t.source || '',
      duration: Number(t.duration) || riff.duration() || 0,
      position: riff.audio.currentTime || 0,
      paused: !!riff.audio.paused,
    };
  }

  // Debounced so seeking and quick skips don't flood Discord. Paused tracks are sent too; the
  // Rust side clears or shows them depending on "Show while paused".
  function sync(delay = 250) {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!status.enabled || quiet) return;
      const t = riff.player.current;
      if (t) riff.call('discord.update', { track: payload(t) }).catch(() => {});
      else riff.call('discord.clear').catch(() => {});
    }, delay);
  }

  riff.on('trackchange', () => sync(400));
  riff.on('play', () => sync());
  riff.on('pause', () => sync());
  riff.on('seeked', () => sync(500));
  riff.on('ready', async () => {
    try { setStatus(await riff.call('discord.status')); } catch (e) {}
  });

  riff.listen('discord-status', (e) => setStatus(e.payload));

  function setStatus(s) {
    if (!s) return;
    status = s;
    riff.store('discord_rpc', !!s.enabled);
    for (const card of document.querySelectorAll('.dc-card')) paint(card);
  }

  function statusText(s) {
    if (!s.enabled) return 'Off';
    if (s.connected) {
      const who = s.user ? `Connected as ${esc(s.user)}` : 'Connected';
      return s.showing ? `${who} · showing ${esc(s.showing)}` : who;
    }
    return s.error ? `${esc(s.error)} · retrying every 30s` : 'Connecting…';
  }

  function paint(card) {
    const on = !!status.enabled;
    riff.setSwitch(card.querySelector('.switch'), on);
    card.classList.toggle('enabled', on);
    card.querySelector('.dc-dot').classList.toggle('on', on && status.connected);
    card.querySelector('.dc-status-text').innerHTML = statusText(status);
  }

  riff.addSettings(() => {
    riff.add('<div class="section-title">Discord</div>');
    const card = riff.add(`<div class="set-card dc-card">
      ${LOGO}
      <div class="i">
        <div class="a">Discord Rich Presence</div>
        <div class="b dc-status"><span class="dc-dot"></span><span class="dc-status-text"></span></div>
      </div>
      ${riff.switchHtml(!!status.enabled, 'aria-label="Discord Rich Presence"')}
    </div>`);
    paint(card);
    card.querySelector('.switch').addEventListener('click', async () => {
      const enabled = !status.enabled;
      setStatus({ ...status, enabled });
      try {
        setStatus(await riff.call('discord.setEnabled', { enabled }));
        if (enabled) sync(0);
      } catch (e) { riff.toast(riff.errText(e), 'error'); }
    });
    riff.call('discord.status').then(setStatus).catch(() => {});
  }, 'integrations');


  // ------------------------------------------------------------ customize (Settings > Integrations)

  const DEFAULTS = { statusShows: 'song', line1: '{title}', line2: '{artist}', largeImage: 'cover', largeText: '{title}', smallLogo: true, time: 'progress', listenButton: true, customLabel: '', customUrl: '', showPaused: false };
  let cfg = { ...DEFAULTS };
  riff.call('discord.config').then((c) => { cfg = { ...DEFAULTS, ...c }; }).catch(() => {});

  const SAMPLE = { title: 'Midnight City', artist: 'M83', artwork: '', url: 'https://soundcloud.com/m83/midnight-city', source: '', duration: 243, position: 74, paused: false };
  const fmtT = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  const LOGO_IMG = '<img src="assets/noxx-mark.svg" alt="">';

  /** A Discord-style card drawn from the activity JSON the Rust side would send. */
  async function paintPreview(box) {
    const t = riff.player.current ? payload(riff.player.current) : { ...SAMPLE };
    let a = null;
    try { a = await riff.call('discord.preview', { track: t, config: cfg }); } catch (e) { box.textContent = riff.errText(e); return; }
    if (!a) { box.innerHTML = '<div class="dcp-empty">Paused: nothing shows on Discord</div>'; return; }
    const sdt = a.status_display_type;
    const listening = sdt === 1 ? a.state : sdt === 2 ? a.details : 'noxx';
    const assets = a.assets || {};
    const big = assets.large_image;
    const cover = big && big !== 'noxx' ? `background-image:url('${esc(big)}')` : '';
    const ts = a.timestamps;
    const now = Date.now();
    let time = '';
    if (ts && ts.end) {
      const done = (now - ts.start) / 1000, total = (ts.end - ts.start) / 1000;
      time = `<div class="dcp-bar"><span>${fmtT(done)}</span><i><b style="width:${Math.min(100, (done / total) * 100)}%"></b></i><span>${fmtT(total)}</span></div>`;
    } else if (ts) {
      time = `<div class="dcp-line dcp-dim">${fmtT((now - ts.start) / 1000)} elapsed</div>`;
    }
    const art = big
      ? `<div class="dcp-art" style="${cover}" title="${esc(assets.large_text || '')}">${cover ? '' : LOGO_IMG}${assets.small_image ? `<span class="dcp-small" title="${esc(assets.small_text || '')}">${LOGO_IMG}</span>` : ''}</div>`
      : '';
    const btns = (a.buttons || []).map((b) => `<span class="dcp-btn">${esc(b.label)}</span>`).join('');
    box.innerHTML = `<div class="dcp-member"><span class="dcp-avatar"></span><div><b>You</b><div class="dcp-dim">Listening to <b>${esc(listening || 'noxx')}</b></div></div></div>
      <div class="dcp-card"><div class="dcp-head">Listening to noxx</div>
        <div class="dcp-body">${art}
          <div class="dcp-text">${a.details ? `<div class="dcp-line"><b>${esc(a.details)}</b></div>` : ''}${a.state ? `<div class="dcp-line">${esc(a.state)}</div>` : ''}${time}</div></div>
        ${btns ? `<div class="dcp-btns">${btns}</div>` : ''}</div>`;
  }

  riff.addSettings(() => {
    const S = riff.settingsRow;
    let saveTimer = 0;
    const previewRow = riff.el('<div class="th-item setting-item dc-preview-row"><div class="th-top"><div class="th-col"><span class="th-name">Preview</span><span class="th-desc">Your profile with the playing song (or a sample)</span></div></div><div class="dc-preview"></div></div>');
    const preview = previewRow.querySelector('.dc-preview');
    const save = () => {
      paintPreview(preview);
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        riff.call('discord.setConfig', { config: cfg }).then((c) => { cfg = { ...DEFAULTS, ...c }; }).catch((e) => riff.toast(riff.errText(e), 'error'));
      }, 300);
    };
    const set = (k) => (v) => { cfg[k] = v; save(); };
    const text = (key, name, desc, placeholder) => {
      const inp = riff.el(`<input class="dc-input" type="text" spellcheck="false" autocomplete="off" placeholder="${esc(placeholder)}">`);
      inp.value = cfg[key] || '';
      inp.addEventListener('input', () => { cfg[key] = inp.value; save(); });
      const r = S.row(name, desc);
      r.classList.add('dc-text-row');
      r.append(inp);
      return r;
    };
    riff.add('<div class="section-title dc-sub">Customize Discord status</div>');
    S.group([
      previewRow,
      S.select({ name: 'Listening to…', desc: 'What follows your name in the member list and DMs', options: [['song', 'Song name'], ['artist', 'Artist name'], ['app', 'noxx']], value: cfg.statusShows, onChange: set('statusShows') }),
      text('line1', 'Top line', 'Use {title}, {artist} and {source}. Leave empty to hide it.', '{title}'),
      text('line2', 'Second line', 'Use {title}, {artist} and {source}', '{artist}'),
      S.select({ name: 'Big image', options: [['cover', 'Song cover'], ['logo', 'noxx logo'], ['none', 'None']], value: cfg.largeImage, onChange: set('largeImage') }),
      text('largeText', 'Image hover text', 'Shown when someone hovers the big image', '{title}'),
      S.toggle({ name: 'noxx logo on the cover', desc: 'Small badge in the corner of the cover', get: () => cfg.smallLogo, set: set('smallLogo') }),
      S.select({ name: 'Time', options: [['progress', 'Progress bar'], ['elapsed', 'Time elapsed'], ['none', 'Hidden']], value: cfg.time, onChange: set('time') }),
      S.toggle({ name: 'Listen button', desc: '"Listen on SoundCloud / YouTube" opens the song', get: () => cfg.listenButton, set: set('listenButton') }),
      text('customLabel', 'Extra button text', 'Optional second button, e.g. "Get noxx"', 'Button text'),
      text('customUrl', 'Extra button link', 'Must start with https://', 'https://'),
      S.toggle({ name: 'Show while paused', desc: 'Keep the song on your profile when paused, with a Paused badge', get: () => cfg.showPaused, set: set('showPaused') }),
      S.button({ name: 'Reset', desc: 'Song name, artist, cover and progress bar', label: 'Reset', onClick: () => { cfg = { ...DEFAULTS }; save(); setTimeout(() => riff.render(true), 50); } }),
    ], 'dc-custom');
    paintPreview(preview);
  }, 'integrations');

  // Keep an open preview in step with the song.
  riff.on('trackchange', () => { const box = document.querySelector('.dc-preview'); if (box) setTimeout(() => paintPreview(box), 300); });

  riff.addSelftest(async (log) => {
    const ok = (name, cond, extra = '') => log(`discord ${name}: ${cond ? 'OK' : 'FAILED'}${extra ? ' ' + extra : ''}`);
    try {
      const s = await riff.call('discord.status');
      ok('status', s && typeof s.enabled === 'boolean', `(enabled=${s.enabled} connected=${s.connected}${s.error ? ' note=' + s.error : ''})`);
      const a = await riff.call('discord.preview', {
        track: { title: 'Selftest Song', artist: 'riff', artwork: 'https://i1.sndcdn.com/artworks-test-t500x500.jpg', url: 'https://soundcloud.com/riff/selftest', duration: 180, position: 30 },
      });
      const span = a.timestamps ? a.timestamps.end - a.timestamps.start : 0;
      ok('activity', a.type === 2 && a.details === 'Selftest Song' && span === 180000 && !!(a.assets && a.assets.large_image));
      const art = await riff.call('discord.preview', { track: { title: 'Song', artist: 'Artist', duration: 100 }, config: { ...DEFAULTS, statusShows: 'artist' } });
      ok('artist status', art.status_display_type === 1 && art.state === 'Artist');
      ok('button', !!a.buttons && a.buttons[0].label === 'Listen on SoundCloud' && a.buttons[0].url === 'https://soundcloud.com/riff/selftest');
      const local = await riff.call('discord.preview', { track: { title: 'x', artwork: 'http://asset.localhost/C%3A/a.jpg', source: 'local' } });
      // Local files: never a file-path cover (Discord can't load those; the noxx logo stands in) and no button.
      const big = (local.assets && local.assets.large_image) || '';
      ok('local track', !/asset\.localhost|^file:|^[a-z]:[\\/]/i.test(big) && !local.buttons);
      const again = await riff.call('discord.setEnabled', { enabled: s.enabled }); // round-trip, same value
      ok('setEnabled', again.enabled === s.enabled);
      const t0 = performance.now();
      await riff.call('discord.clear');
      ok('clear (non-blocking)', performance.now() - t0 < 200, `${Math.round(performance.now() - t0)}ms`);
    } catch (e) {
      log('discord: FAILED ' + riff.errText(e));
    }
  });
})();
