'use strict';
// "My files": local folders / files scanned in Rust (features/localfiles.rs),
// shown riff-style and played straight from disk through the asset protocol.
(() => {
  const R = window.riff;
  const { convertFileSrc } = window.__TAURI__.core;
  const dialog = window.__TAURI__.dialog;
  const EXTS = ['mp3', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'wav'];

  // riff's "My files" folder, with a note inside so it reads apart from Playlists.
  const ICON_FILES = R.svg('<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><path d="M11 17v-5l4-1v5"/><circle cx="9.6" cy="17" r="1.4"/><circle cx="13.6" cy="16" r="1.4"/>');
  const ICON_SEARCH = R.svg('<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.5" y2="16.5"/>');
  const ICON_FOLDER = R.svg('<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>');
  const ICON_FILE = R.svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>');

  const lib = { tracks: [], folders: [], files: [], scanning: false, loaded: false };
  let loading = null;   // in-flight list() promise
  let query = '';
  let ui = null;        // live refs of the open view: { sub, holder, input }

  const prep = (t) => Object.assign(t, { source: 'local', artwork: t.cover ? convertFileSrc(t.cover) : '' });

  function apply(r) {
    if (!r) return;
    lib.tracks = (r.tracks || []).map(prep);
    lib.folders = r.folders || [];
    lib.files = r.files || [];
    lib.scanning = !!r.scanning;
    lib.loaded = true;
    updateBadge();
  }

  function refreshLib() {
    if (!loading) loading = R.call('localfiles.list').then(apply).catch((e) => R.log('error', `localfiles: ${R.errText(e)}`)).finally(() => { loading = null; });
    return loading;
  }

  // ---------------------------------------------------------------- search

  const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const baseName = (p) => String(p || '').split(/[\\/]/).pop();
  function filtered() {
    const words = norm(query).split(/\s+/).filter(Boolean);
    if (!words.length) return lib.tracks;
    return lib.tracks.filter((t) => {
      const hay = t._hay || (t._hay = norm(`${t.title} ${t.artist} ${t.album || ''} ${baseName(t.path)}`));
      return words.every((w) => hay.includes(w));
    });
  }

  // ---------------------------------------------------------------- nav badge

  let badge = null;
  function updateBadge() {
    if (!badge) {
      const ind = document.querySelector('.nav-item[data-view="files"] .nav-ind');
      if (!ind) return;
      badge = document.createElement('span');
      badge.className = 'nav-badge';
      ind.append(badge);
    }
    const n = lib.tracks.length;
    badge.hidden = !n;
    badge.textContent = n > 999 ? '999+' : String(n);
  }

  // ---------------------------------------------------------------- adding / removing

  async function pick(kind) {
    try {
      const res = kind === 'folder'
        ? await dialog.open({ directory: true, multiple: true, title: 'Add folders to My files' })
        : await dialog.open({ multiple: true, title: 'Add files to My files', filters: [{ name: 'Audio', extensions: EXTS }] });
      if (!res) return;
      const paths = (Array.isArray(res) ? res : [res]).map((p) => (typeof p === 'string' ? p : p && p.path)).filter(Boolean);
      if (!paths.length) return;
      await addPaths(kind === 'folder' ? { folders: paths } : { files: paths });
    } catch (e) {
      R.toast(R.errText(e), 'error');
    }
  }

  async function addPaths(args) {
    const before = lib.tracks.length;
    lib.scanning = true;
    updateView();
    R.toast('Scanning…');
    try {
      apply(await R.call('localfiles.add', args));
      const added = lib.tracks.length - before;
      R.toast(added > 0 ? `Added ${R.plural(added, 'track')}` : 'No new tracks found');
    } catch (e) {
      lib.scanning = false;
      R.toast(R.errText(e), 'error');
    }
    rerender();
  }

  function addMenu(btn) {
    const r = btn.getBoundingClientRect();
    R.showMenu([
      { label: 'Add folder…', run: () => pick('folder') },
      { label: 'Add files…', run: () => pick('files') },
    ], r.left, r.bottom + 6);
  }

  async function rescan() {
    lib.scanning = true;
    updateView();
    try { apply(await R.call('localfiles.rescan')); R.toast(`${R.plural(lib.tracks.length, 'track')} in library`); }
    catch (e) { lib.scanning = false; R.toast(R.errText(e), 'error'); }
    rerender();
  }

  function foldersModal() {
    const row = (p, icon) => `<div class="lf-root" title="${R.esc(p)}">${icon}<span class="lf-root-path">${R.esc(p)}</span>
      <button class="pill-btn" data-rm="${R.esc(p)}" title="Remove">${R.ICON.close}</button></div>`;
    const rows = lib.folders.map((p) => row(p, ICON_FOLDER)).join('') + lib.files.map((p) => row(p, ICON_FILE)).join('');
    const m = R.openModal(`<h3>Folders and files</h3>
      <p>The app scans these folders (and their subfolders) for ${EXTS.join(', ')} files. Removing one only takes it out of My files, nothing is deleted.</p>
      <div class="lf-roots">${rows || '<div class="lf-roots-empty">Nothing added yet.</div>'}</div>
      <div class="row-btns"><button class="btn outline" data-k="folder">${R.ICON.plus}Add folder</button><button class="btn outline" data-k="files">${R.ICON.plus}Add files</button><button class="btn primary" data-k="close">Done</button></div>`);
    m.querySelector('[data-k=close]').onclick = R.closeModal;
    m.querySelector('[data-k=folder]').onclick = () => { R.closeModal(); pick('folder'); };
    m.querySelector('[data-k=files]').onclick = () => { R.closeModal(); pick('files'); };
    m.querySelector('.lf-roots').addEventListener('click', async (e) => {
      const b = e.target.closest('[data-rm]');
      if (!b) return;
      b.disabled = true;
      try { apply(await R.call('localfiles.remove', { path: b.dataset.rm })); } catch (err) { R.toast(R.errText(err), 'error'); }
      b.closest('.lf-root').remove();
      rerender();
    });
  }

  // ---------------------------------------------------------------- view

  function subText(shown) {
    const n = lib.tracks.length;
    let s = query.trim() ? `${shown.length} of ${R.plural(n, 'track')}` : `${R.plural(n, 'track')} in library`;
    if (n && !query.trim()) s += ` · ${R.totalTime(lib.tracks)}`;
    if (lib.scanning) s += ' · scanning…';
    return s;
  }

  // Redraws only the list + subtitle, so the search box keeps focus while typing.
  function updateView() {
    if (!ui || !ui.holder.isConnected) return;
    const shown = filtered();
    ui.sub.textContent = subText(shown);
    ui.shown = shown;
    ui.holder.innerHTML = '';
    if (!lib.tracks.length) {
      ui.holder.append(R.el(`<div class="empty lf-empty"><div>No local tracks in library yet.</div><button class="btn primary">${R.ICON.plus}Add files</button></div>`));
      ui.holder.querySelector('button').onclick = (e) => addMenu(e.currentTarget);
      return;
    }
    if (!shown.length) { ui.holder.append(R.el('<div class="empty">No matches.</div>')); return; }
    R.toolList({ kind: 'files' }, shown, {}, ui.holder);
  }

  function rerender() {
    if (R.state.view === 'files' && ui && ui.holder.isConnected) updateView();
  }

  async function renderView(token) {
    const head = R.add(`<div class="head-row lf-head"><div><div class="page-title">My files</div><div class="page-sub lf-sub"></div></div>
      <div class="actions">${R.listActions()}<button class="btn outline" data-a="folders">${ICON_FOLDER}Folders</button>
      <button class="btn outline" data-a="rescan">${R.ICON.sync}Rescan</button>
      <button class="btn primary" data-a="add">${R.ICON.plus}Add files</button></div></div>`);
    const box = R.add(`<div class="view-search-box lf-search">${ICON_SEARCH}<input type="text" class="view-search-input" placeholder="Search my files..." autocomplete="off" spellcheck="false"></div>`);
    const holder = R.add('<div class="lf-list"></div>');
    const input = box.querySelector('input');
    ui = { sub: head.querySelector('.lf-sub'), holder, input, shown: [] };
    input.value = query;

    head.addEventListener('click', (e) => {
      const b = e.target.closest('[data-a]');
      if (!b) return;
      const a = b.dataset.a, list = ui.shown;
      if (a === 'play' && list.length) R.playList(list, 0, false);
      else if (a === 'shuffle' && list.length) R.playList(list, Math.floor(Math.random() * list.length), true);
      else if (a === 'add') addMenu(b);
      else if (a === 'rescan') rescan();
      else if (a === 'folders') foldersModal();
    });
    let timer = 0;
    input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { query = input.value; updateView(); }, 90); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Escape' && input.value) { input.value = ''; query = ''; updateView(); } });

    if (!lib.loaded) {
      ui.sub.textContent = 'Loading…';
      const sp = R.el('<div class="spinner"></div>');
      holder.append(sp);
      await refreshLib();
      if (R.stale(token)) return;
      sp.remove();
    }
    updateView();
  }

  R.registerView('files', { title: 'My files', icon: ICON_FILES, nav: true, render: renderView });

  // ---------------------------------------------------------------- playback & menus

  async function resolveLocal(t) {
    if (!t || t.source !== 'local' || !t.path) return null;
    return { url: convertFileSrc(t.path), protocol: 'file', preset: 'local file' };
  }
  R.addStreamResolver(resolveLocal);

  R.addTrackMenu((t) => (t && t.source === 'local' && t.path)
    ? [{ label: 'Show in folder', run: () => R.call('localfiles.reveal', { path: t.path }).catch((e) => R.toast(R.errText(e), 'error')) }]
    : []);

  // Background scans (startup, other windows) land here.
  R.listen('localfiles-changed', async () => {
    await refreshLib();
    rerender();
  });
  R.on('ready', () => { updateBadge(); refreshLib(); });

  // Settings → Storage → Music folder (drawn by features/system.js).
  R.localfiles = { get lib() { return lib; }, pick, foldersModal };

  // ---------------------------------------------------------------- selftest

  R.addSelftest(async (log) => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const until = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await wait(100); } return false; };

    let t0 = performance.now();
    const r = await R.call('localfiles.list');
    const listOk = r && Array.isArray(r.tracks) && Array.isArray(r.folders) && Array.isArray(r.files);
    log(`localfiles list ${listOk ? 'OK' : 'FAILED'}: ${r?.tracks?.length} tracks, ${r?.folders?.length} folders, ${r?.files?.length} files (${Math.round(performance.now() - t0)}ms)`);

    t0 = performance.now();
    const st = await R.call('localfiles.selftest');
    const t = (st.tracks || []).map(prep).find((x) => x.title === 'Selftest Tone');
    const scanOk = !!t && t.artist === 'Selftest Artist' && t.duration === 3 && /^local:[0-9a-f]{16}$/.test(t.id);
    log(`localfiles scan ${scanOk ? 'OK' : 'FAILED'}: ${t ? `"${t.title}" / ${t.artist} / ${R.fmt(t.duration)} / ${t.id}` : 'no track'} (${Math.round(performance.now() - t0)}ms)`);
    if (!t) return;

    const s = await resolveLocal(t);
    const resOk = !!s && s.protocol === 'file' && /^(https?|asset):/.test(s.url) && (await resolveLocal({ id: '1', source: '' })) === null;
    log(`localfiles resolver ${resOk ? 'OK' : 'FAILED'}: ${s && s.url}`);

    t0 = performance.now();
    R.playTrack(t);
    const playOk = await until(() => R.player.current === t && R.audio.currentTime > 0.3, 8000);
    let why = '';
    if (!playOk) {
      const me = R.audio.error;
      let fetchInfo = '';
      try { const r = await fetch(s.url, { method: 'GET' }); fetchInfo = `fetch ${r.status} ${r.headers.get('content-type') || ''} acao=${r.headers.get('access-control-allow-origin') || '-'}`; } catch (e) { fetchInfo = `fetch error ${R.errText(e)}`; }
      why = `; media error ${me ? me.code : '-'} ${me && me.message ? me.message : ''}; src=${(R.audio.currentSrc || '').slice(0, 60)}; crossOrigin=${R.audio.crossOrigin}; ${fetchInfo}`;
    }
    log(`localfiles playback ${playOk ? 'OK' : 'FAILED'}: t=${R.audio.currentTime.toFixed(1)}s in ${Math.round(performance.now() - t0)}ms${why}`);
    R.audio.pause();

    R.go('files');
    const viewOk = await until(() => ui && ui.holder.isConnected && lib.loaded, 5000);
    const title = R.view.querySelector('.page-title')?.textContent;
    const hasSearch = !!R.view.querySelector('.lf-search input');
    const rows = R.view.querySelectorAll('.lf-list .track-row').length;
    log(`localfiles view ${viewOk && title === 'My files' && hasSearch ? 'OK' : 'FAILED'}: "${title}", "${ui?.sub.textContent}", ${rows} rows drawn`);

    const saved = query;
    query = 'zzzz-no-such-track-zzzz';
    updateView();
    const noneOk = filtered().length === 0;
    query = saved;
    updateView();
    log(`localfiles search filter ${noneOk ? 'OK' : 'FAILED'}`);
  });
})();
