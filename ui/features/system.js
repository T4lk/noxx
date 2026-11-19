'use strict';
// Settings → Advanced (tray, media keys, multiple instances), Storage (cache,
// required tools, offline library, music folder, download folder) and Plugins.
// Rust side: src-tauri/src/features/system.rs. Uses window.riff (see README.md).
(() => {
  const R = window.riff;
  const { esc, plural } = R;

  let sys = { trayOnClose: true, mediaKeys: true, multiInstance: false };
  const sysReady = R.call('system.settings').then((s) => { sys = s; }).catch((e) => R.log('error', `system settings: ${R.errText(e)}`));

  function fmtBytes(b) {
    if (!b) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB'];
    const i = Math.min(u.length - 1, Math.floor(Math.log(b) / Math.log(1024)));
    return `${(b / Math.pow(1024, i)).toFixed(i ? 1 : 0)} ${u[i]}`;
  }

  // riff's setting row: name + small description on the left, control on the right.
  const row = (name, desc, side = '', attrs = '') => `<div class="th-item setting-item sys-row"${attrs}><div class="th-top">
    <div class="th-col"><span class="th-name">${name}</span>${desc}</div><div class="th-side">${side}</div></div></div>`;
  const desc = (text, attrs = '') => `<span class="th-desc"${attrs}>${text}</span>`;
  const btn = (a, label, primary) => `<button type="button" class="btn ${primary ? 'primary' : 'outline'} sys-btn" data-a="${a}">${label}</button>`;
  const swRow = (k, name, text) => row(name, desc(text), R.switchHtml(sys[k], `data-sys-sw="${k}" aria-label="${esc(name)}"`));

  // ------------------------------------------------------------ media keys

  // Global media keys from Rust. If WebView2's own media-session handling also
  // fires for the same press, the second one is dropped.
  let lastPlayState = 0;
  let lastTrackChange = 0;
  R.audio.addEventListener('play', () => { lastPlayState = performance.now(); });
  R.audio.addEventListener('pause', () => { lastPlayState = performance.now(); });
  R.on('trackchange', () => { lastTrackChange = performance.now(); });
  // ------------------------------------------------------------ SoundCloud → YouTube fallback

  // A SoundCloud track with no playable stream (Go+ only, preview-only, encrypted, blocked)
  // plays the same song from YouTube Music, then YouTube, matched by title, artist and length.
  // Runs after the downloads / local files resolvers, so offline copies still win.
  const invoke = window.__TAURI__.core.invoke;
  const NO_STREAM = /no playable stream|go\+|subscription|preview|snippet|not available|geo|blocked|403|404/i;
  const alts = new Map(); // SoundCloud id -> YouTube track | null (no match)
  const isSc = (t) => !t.source || t.source === 'soundcloud';
  async function resolveAlt(t, fresh) {
    if (!t || !isSc(t) || !/^\d+$/.test(String(t.id))) return null;
    let alt = alts.get(t.id);
    if (alt === undefined) {
      try { return await invoke('stream_url', { id: t.id, fresh }); } catch (e) {
        const why = R.errText(e);
        if (!NO_STREAM.test(why)) throw e;
        try {
          alt = await R.call('imports.alt', { title: t.title, artist: t.artist, duration: Math.round(t.duration || 0) });
        } catch (e2) {
          R.log('warn', `fallback search for ${t.id}: ${R.errText(e2)}`);
          throw e;
        }
        alts.set(t.id, alt || null);
        if (!alt) throw new Error(`${why} Not found on YouTube Music or YouTube either.`);
        R.log('info', `fallback ${t.id} "${t.title}" -> ${alt.source} ${alt.id} "${alt.title}" / ${alt.artist}`);
        R.toast('Not playable on SoundCloud, playing it from YouTube instead');
      }
    }
    if (!alt) return null; // known miss: let the normal path show SoundCloud's error
    const r = await R.call('youtube.resolve', { id: alt.id, fresh: !!fresh });
    return { url: r.url, protocol: 'progressive', preset: `fallback/${alt.source}/${r.method}` };
  }
  R.addStreamResolver(resolveAlt);

  // Hearts are mirrored to SoundCloud likes in the background; say so when that fails.
  R.listen('sc-like-error', (e) => R.toast(String(e.payload || "Couldn't update the like on SoundCloud")));
  R.listen('media-key', (e) => {
    const k = e.payload;
    const now = performance.now();
    if (k === 'playpause') { if (now - lastPlayState > 350) R.togglePlay(); }
    else if (k === 'next') { if (now - lastTrackChange > 350) R.next(false); }
    else if (k === 'prev') { if (now - lastTrackChange > 350) R.prev(); }
    else if (k === 'stop') R.audio.pause();
  });

  // ------------------------------------------------------------ Advanced

  R.addSettings(() => {
    R.add('<div class="section-title">Advanced</div>');
    const g = R.add(`<div class="th-group">
      ${swRow('trayOnClose', 'Minimize to tray on close', 'Keep running in background when window is closed')}
      ${swRow('mediaKeys', 'Capture media keys (Windows)', 'Turn off if another app should receive your media keys')}
      ${swRow('multiInstance', 'Allow multiple instances', 'For testing: lets you start a second window. Applies after restart.')}
    </div>`);
    g.querySelectorAll('[data-sys-sw]').forEach((b) => {
      b.addEventListener('click', async () => {
        const key = b.dataset.sysSw;
        const on = !b.classList.contains('active');
        R.setSwitch(b, on);
        try {
          sys = await R.call('system.set', { key, value: on });
          if (key === 'multiInstance') R.toast('Applies after restart');
        } catch (e) {
          R.setSwitch(b, !on);
          R.toast(R.errText(e), 'error');
        }
      });
    });
  }, 'advanced');

  // ------------------------------------------------------------ Storage

  function clearCacheModal() {
    const m = R.openModal(`<div class="sys-cache">
      <h3>Clear Cache</h3>
      <p>Clear cache and free up your storage, don't do it too often because the app will get laggy.</p>
      <label class="sys-cache-row"><input type="checkbox" data-k="audio" checked><span>Audio &amp; Art</span><span class="sys-cache-size" data-s="audio">...</span></label>
      <label class="sys-cache-row"><input type="checkbox" data-k="web" checked><span>Web &amp; App Data</span><span class="sys-cache-size" data-s="web">...</span></label>
      <div class="row-btns"><button class="btn outline" data-k="cancel">Cancel</button><button class="btn primary" data-k="ok">Clear Selected</button></div>
    </div>`);
    R.call('system.cache_size').then((s) => {
      m.querySelector('[data-s=audio]').textContent = fmtBytes(s.audio);
      m.querySelector('[data-s=web]').textContent = fmtBytes(s.web);
    }).catch(() => {});
    m.querySelector('[data-k=cancel]').onclick = () => R.closeModal();
    m.querySelector('[data-k=ok]').onclick = async () => {
      const ok = m.querySelector('[data-k=ok]');
      ok.disabled = true;
      ok.textContent = 'Clearing...';
      try {
        const before = await R.call('system.cache_size');
        const pick = (k) => m.querySelector(`[data-k=${k}]`).checked;
        if (!pick('audio') && !pick('web')) { R.closeModal(); return; }
        const after = await R.call('system.clear_cache', { audio: pick('audio'), web: pick('web') });
        const freed = Math.max(0, before.audio + before.web - after.audio - after.web);
        R.toast(after.webError ? `Cache partly cleared (${after.webError})` : `Cache cleared, ${fmtBytes(freed)} freed`, after.webError ? 'error' : undefined);
      } catch (e) {
        R.toast(R.errText(e), 'error');
      }
      R.closeModal();
      if (R.state.view === 'settings') R.render(true);
    };
  }

  // yt-dlp status (riff also lists ffmpeg; riff-rs muxes in Rust and doesn't need it).
  let tools = null;
  const toolsText = () => {
    if (!tools) return 'Checking...';
    if (tools.status === 'downloading') return `Downloading yt-dlp... ${tools.percent || 0}%`;
    if (tools.status === 'error') return `Download failed: ${esc(tools.error || 'unknown error')}`;
    return tools.ytdlp ? `yt-dlp ready · ${esc(tools.ytdlp)}` : 'yt-dlp missing';
  };
  function paintTools() {
    document.querySelectorAll('[data-sys-tools]').forEach((n) => { n.innerHTML = toolsText(); });
    document.querySelectorAll('[data-a=tools]').forEach((b) => {
      b.textContent = tools && tools.ytdlp ? 'Update' : 'Download';
      b.disabled = !!tools && tools.status === 'downloading';
    });
  }
  const loadTools = () => R.call('youtube.tools').then((t) => { tools = t; paintTools(); return t; }).catch((e) => { tools = { status: 'error', error: R.errText(e) }; paintTools(); return tools; });
  R.listen('youtube-tools', (e) => { tools = e.payload; paintTools(); });

  R.addSettings(() => {
    R.add('<div class="section-title">Storage</div>');
    const dl = R.downloads;
    const lf = R.localfiles;
    const dlFolder = dl ? dl.folder : { folder: '' };
    const offline = () => dl ? `${plural(dl.count(), 'track')} (${dl.fmtSize(dl.totalSize())})` : 'Unavailable';
    const music = () => {
      if (!lf) return 'Unavailable';
      const f = lf.lib.folders;
      if (!f.length) return 'No folders yet';
      return esc(f[0]) + (f.length > 1 ? ` + ${f.length - 1} more` : '');
    };
    const g = R.add(`<div class="th-group">
      ${row('Clear cache', desc('Temporary web and partial data'), btn('cache', 'Clear'), ' data-a="cache"')}
      ${row('Required tools', desc('yt-dlp') + desc(toolsText(), ' data-sys-tools'), btn('tools', 'Download', true))}
      ${row('Offline library', desc(offline(), ' data-sys-offline'), btn('offline', 'Clear'))}
      ${row('Music folder', desc(music(), ' data-sys-music'), btn('music-manage', 'Manage') + btn('music-add', 'Add'))}
      ${row('Download folder', desc(esc(dlFolder.folder || 'Calculating...'), ' data-sys-dl'),
        (dlFolder.custom ? btn('dl-reset', 'Reset') : '') + btn('dl-open', 'Open') + btn('dl-change', 'Change'))}
    </div>`);
    g.querySelector('[data-a=cache]').classList.add('sys-click');
    paintTools();
    loadTools();
    if (dl && dl.ready) dl.ready.then(() => {
      const o = g.querySelector('[data-sys-offline]'); if (o) o.textContent = offline();
      const d = g.querySelector('[data-sys-dl]'); if (d) d.textContent = dl.folder.folder;
    });
    g.addEventListener('click', async (e) => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (a === 'cache') clearCacheModal();
      else if (a === 'tools') {
        try { tools = await R.call('youtube.install'); paintTools(); } catch (err) { R.toast(R.errText(err), 'error'); }
      } else if (a === 'offline') {
        if (!dl || !dl.count()) { R.toast('The offline library is empty'); return; }
        if (!(await R.confirmBox('Clear offline library', 'Delete all downloaded tracks from offline storage? They will need to be downloaded again.', 'Delete all'))) return;
        const n = await dl.clearAll();
        R.toast(`Offline library cleared (${plural(n, 'track')})`);
        const o = g.querySelector('[data-sys-offline]'); if (o) o.textContent = offline();
      } else if (a === 'music-manage') lf && lf.foldersModal();
      else if (a === 'music-add') lf && lf.pick('folder');
      else if (a === 'dl-change') dl && dl.pickFolder();
      else if (a === 'dl-reset') dl && dl.setFolder('');
      else if (a === 'dl-open') dl && dl.reveal('');
    });
  }, 'storage');

  // ------------------------------------------------------------ About: memory

  // Task Manager shows the WebView2 processes in their own "WebView2 Manager" group,
  // so the noxx entry there looks tiny. This line adds noxx and all its processes up.
  R.addSettings(() => {
    const mb = (b) => `${Math.round(b / 1048576)} MB`;
    const g = R.add(`<div class="th-group">${row('Memory', desc('Measuring…', ' data-sys-mem') + desc('', ' data-sys-mem-parts'))}</div>`);
    const total = g.querySelector('[data-sys-mem]'), parts = g.querySelector('[data-sys-mem-parts]');
    const tick = () => {
      if (!g.isConnected) return;
      R.call('system.memory').then((m) => {
        total.textContent = mb(m.total);
        parts.textContent = `App ${mb(m.app)} · WebView2 ${mb(m.web)} · ${m.processes} ${m.processes === 1 ? 'process' : 'processes'}`;
      }).catch(() => { total.textContent = 'Unavailable'; });
      setTimeout(tick, 2000);
    };
    tick();
  }, 'about');

  // ------------------------------------------------------------ Plugins

  // A plugin is a JS file run as `function (Riff, plugin) { ... }`; it may
  // return { stop() } so it can be turned off without a restart.
  const EVENTS = ['trackchange', 'play', 'pause', 'ended', 'seeked', 'ready', 'library', 'status', 'theme', 'render', 'platform'];
  const listeners = [];
  EVENTS.forEach((ev) => R.on(ev, (data) => {
    listeners.filter((l) => l.event === ev).forEach((l) => { try { l.cb(data); } catch (e) { pluginError(l.file, e); } });
  }));
  const loaded = new Map(); // file -> { stop }
  let plugins = [];
  let pluginsLoaded = false;
  let listEl = null;

  function pluginError(file, e) {
    R.log('error', `[plugin ${file}] ${R.errText(e)}`);
    R.toast(`Plugin ${file} failed: ${e && e.message ? e.message : e}`, 'error');
  }

  function pluginApi(p) {
    const prefix = `riff_plugin_${p.file}_`;
    return {
      plugin: { file: p.file, name: p.name, author: p.author, version: p.version },
      on(event, cb) {
        const l = { event, cb, file: p.file };
        listeners.push(l);
        return () => { const i = listeners.indexOf(l); if (i >= 0) listeners.splice(i, 1); };
      },
      toast: (message, type) => R.toast(String(message), type === 'error' ? 'error' : undefined),
      addStyle(css) {
        const s = document.createElement('style');
        s.dataset.riffCustom = 'plugin';
        s.dataset.plugin = p.file;
        s.textContent = css;
        document.head.appendChild(s);
        return () => s.remove();
      },
      storage: {
        get: (k, d) => { try { const v = localStorage.getItem(prefix + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
        set: (k, v) => { try { localStorage.setItem(prefix + k, JSON.stringify(v)); } catch (e) {} },
      },
      getTrack: () => R.player.current,
      isPlaying: () => !R.audio.paused,
      audio: () => R.audio,
      query: (sel) => document.querySelector(sel),
      riff: R, // the full extension API (features/README.md)
    };
  }

  function runPlugin(p) {
    if (loaded.has(p.file)) return;
    try {
      const api = pluginApi(p);
      const fn = new Function('Riff', 'plugin', `${p.code}\n//# sourceURL=riff-plugin-${p.file}`);
      const result = fn(api, api.plugin);
      loaded.set(p.file, { stop: result && typeof result.stop === 'function' ? result.stop : null });
    } catch (e) { pluginError(p.file, e); }
  }

  function stopPlugin(p, silent) {
    const entry = loaded.get(p.file);
    try { if (entry && entry.stop) entry.stop(); } catch (e) { pluginError(p.file, e); }
    for (let i = listeners.length - 1; i >= 0; i--) if (listeners[i].file === p.file) listeners.splice(i, 1);
    document.querySelectorAll(`style[data-plugin="${CSS.escape(p.file)}"]`).forEach((n) => n.remove());
    loaded.delete(p.file);
    if (!silent && !(entry && entry.stop)) R.toast(`Restart the app to fully unload "${p.name}"`);
  }

  async function fetchPlugins() {
    plugins = await R.call('system.plugins_list');
    pluginsLoaded = true;
    return plugins;
  }

  function renderPlugins() {
    if (!listEl || !listEl.isConnected) return;
    if (!pluginsLoaded) { listEl.innerHTML = '<div class="th-item setting-item"><span class="th-desc">Loading...</span></div>'; return; }
    if (!plugins.length) { listEl.innerHTML = '<div class="th-item setting-item"><span class="th-desc">No plugins. Put .js files into the plugins folder or click Add.</span></div>'; return; }
    listEl.innerHTML = plugins.map((p, i) => row(
      esc(`${p.name}${p.version ? ' v' + p.version : ''}`),
      desc(esc([p.author && `by ${p.author}`, p.description, p.file].filter(Boolean).join(' · '))),
      `<button type="button" class="btn outline sys-btn" data-p-del="${i}" title="Delete file">Delete</button>${R.switchHtml(p.enabled, `data-p-sw="${i}" aria-label="${esc(p.name)}"`)}`,
    )).join('');
  }

  async function reloadPlugins() {
    try {
      await fetchPlugins();
      const present = new Set(plugins.map((x) => x.file));
      [...loaded.keys()].filter((f) => !present.has(f)).forEach((f) => stopPlugin({ file: f, name: f }, true));
    } catch (e) { R.toast(R.errText(e), 'error'); }
    renderPlugins();
  }

  async function addPlugins() {
    const dialog = window.__TAURI__ && window.__TAURI__.dialog;
    if (!dialog) { R.toast('The file picker is not available', 'error'); return; }
    try {
      const res = await dialog.open({ title: 'Add plugin', multiple: true, filters: [{ name: 'JavaScript plugin', extensions: ['js'] }] });
      if (!res) return;
      const paths = (Array.isArray(res) ? res : [res]).map((p) => (typeof p === 'string' ? p : p && p.path)).filter(Boolean);
      const added = await R.call('system.plugins_import', { paths });
      if (!added) { R.toast('No plugin added (only .js files up to 1 MB)', 'error'); return; }
      await fetchPlugins();
      renderPlugins();
      R.toast(`Added ${added} plugin${added > 1 ? 's' : ''}. Turn one on to run it`);
    } catch (e) { R.toast(R.errText(e), 'error'); }
  }

  R.addSettings(() => {
    const head = R.add(`<div class="sys-plugins-head">
      <div><div class="section-title">Plugins</div>
      <div class="th-desc"><span class="sys-warn">Plugins are JavaScript files with full access to the app.</span> Only add plugins you trust. They live in the plugins folder: delete a file and the plugin is gone. Ctrl+Shift+R turns every plugin off.</div></div>
      <div class="sys-actions">${btn('folder', 'Open folder')}${btn('reload', 'Reload list')}${btn('add', 'Add', true)}</div></div>`);
    head.addEventListener('click', (e) => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (a === 'folder') R.call('system.plugins_open_folder').catch((err) => R.toast(R.errText(err), 'error'));
      else if (a === 'reload') reloadPlugins();
      else if (a === 'add') addPlugins();
    });
    listEl = R.add('<div class="th-group sys-plugins"></div>');
    listEl.addEventListener('click', (e) => {
      const sw = e.target.closest('[data-p-sw]');
      const del = e.target.closest('[data-p-del]');
      if (sw) {
        const p = plugins[+sw.dataset.pSw];
        if (!p) return;
        p.enabled = !p.enabled;
        R.setSwitch(sw, p.enabled);
        R.call('system.plugins_set', { file: p.file, on: p.enabled }).catch((err) => R.toast(R.errText(err), 'error'));
        if (p.enabled) runPlugin(p); else stopPlugin(p, false);
      } else if (del) {
        const p = plugins[+del.dataset.pDel];
        if (!p) return;
        stopPlugin(p, true);
        R.call('system.plugins_remove', { file: p.file }).then(() => {
          plugins = plugins.filter((x) => x.file !== p.file);
          renderPlugins();
          R.toast('Plugin file deleted');
        }).catch((err) => R.toast(R.errText(err), 'error'));
      }
    });
    renderPlugins();
    if (!pluginsLoaded) fetchPlugins().then(renderPlugins).catch(() => {});
  }, 'plugins');

  // Ctrl+Shift+R: every plugin off (themes.js handles custom themes on the same key).
  window.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey && e.shiftKey && !e.altKey && e.code === 'KeyR')) return;
    e.preventDefault();
    const on = plugins.filter((p) => p.enabled);
    R.call('system.plugins_disable_all').catch(() => {});
    plugins.forEach((p) => { p.enabled = false; stopPlugin(p, true); });
    renderPlugins();
    if (on.length) R.toast(`${plural(on.length, 'plugin')} turned off (Ctrl+Shift+R)`);
  }, true);

  // Enabled plugins start once the core is up.
  R.on('ready', () => {
    fetchPlugins().then((list) => list.filter((p) => p.enabled).forEach(runPlugin)).catch((e) => R.log('error', `plugins: ${R.errText(e)}`));
  });

  // ------------------------------------------------------------ selftest (RIFF_SELFTEST=1)

  R.addSelftest(async (log) => {
    await sysReady;
    log(`system settings: ${typeof sys.trayOnClose === 'boolean' && typeof sys.mediaKeys === 'boolean' ? 'OK' : 'FAILED'} tray ${sys.trayOnClose}, media keys ${sys.mediaKeys}, multi ${sys.multiInstance}`);
    try {
      const s = await R.call('system.cache_size');
      log(`system cache size: ${Number.isFinite(s.web) && Number.isFinite(s.audio) ? 'OK' : 'FAILED'} web ${fmtBytes(s.web)}, audio & art ${fmtBytes(s.audio)}`);
    } catch (e) { log(`system cache size: FAILED ${R.errText(e)}`); }
    const t = await loadTools();
    log(`system tools: ${t && t.status !== 'error' ? 'OK' : 'FAILED'} yt-dlp ${t && t.ytdlp ? t.ytdlp : 'missing'} (${t && t.status})`);
    try {
      const list = await R.call('system.plugins_list');
      const ex = list.find((p) => p.file === 'example-hello.js');
      log(`system plugins list: ${Array.isArray(list) ? 'OK' : 'FAILED'} ${list.length} plugin(s)${ex ? `, example "${ex.name}" ${ex.enabled ? 'on' : 'off'}` : ''}, ${loaded.size} running`);
      // Run the example in a sandboxed copy and make sure the API shape works.
      if (ex) {
        let toasted = '';
        const api = pluginApi({ ...ex, file: '__selftest.js' });
        api.toast = (m) => { toasted = m; };
        const res = new Function('Riff', 'plugin', ex.code)(api, api.plugin);
        listeners.filter((l) => l.file === '__selftest.js' && l.event === 'trackchange').forEach((l) => l.cb({ title: 'Selftest' }));
        if (res && res.stop) res.stop();
        const left = listeners.filter((l) => l.file === '__selftest.js').length;
        log(`system plugin run: ${toasted === 'Now playing: Selftest' && !left ? 'OK' : 'FAILED'} toast "${toasted}", ${left} listener(s) left`);
      }
    } catch (e) { log(`system plugins: FAILED ${R.errText(e)}`); }
    const ui = !!document.querySelector('[data-sys-sw]') || R.state.view !== 'settings';
    log(`system ui: ${ui ? 'OK' : 'FAILED'}`);
  });
})();
