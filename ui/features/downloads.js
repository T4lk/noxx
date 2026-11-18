'use strict';
// Downloads: save SoundCloud tracks as tagged audio files (Rust: features/downloads.rs),
// play them back from disk, and keep an eye on the queue. Uses window.riff (see README.md).
(() => {
  const R = window.riff;
  const { esc, svg, ICON, plural } = R;

  const IC = {
    download: svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>'),
    saved: svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="8 9 11 12 16 6"/>'),
    folder: svg('<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>'),
    retry: ICON.sync,
    close: ICON.close,
  };

  const items = new Map(); // track id -> { id, track, path, size, at }
  const jobs = new Map();  // track id -> { id, track, state, done, total, error }
  let folder = { folder: '', default: '', custom: false };
  let ready = null;        // promise of the latest list
  const batch = { count: 0, done: 0, failed: 0, single: null };

  const ACTIVE = new Set(['queued', 'downloading', 'saving']);
  const isActive = (j) => !!j && ACTIVE.has(j.state);
  const downloadable = (t) => !!t && ((!t.source && /^\d+$/.test(String(t.id || ''))) || (t.source === 'youtube' && /^yt:/.test(String(t.id || ''))));
  const activeCount = () => { let n = 0; for (const j of jobs.values()) if (isActive(j)) n++; return n; };
  const pct = (j) => (j.total > 0 ? Math.min(100, Math.round((j.done / j.total) * 100)) : 0);

  function fmtSize(b) {
    if (!b) return '0 MB';
    if (b >= 1e9) return (b / 1e9).toFixed(1) + ' GB';
    return Math.max(0.1, b / 1e6).toFixed(b >= 1e8 ? 0 : 1) + ' MB';
  }
  const totalSize = () => { let s = 0; for (const e of items.values()) s += e.size || 0; return s; };

  // ------------------------------------------------------------ state from Rust

  function refresh() {
    ready = R.call('downloads.list').then((r) => {
      folder = { folder: r.folder, default: r.default, custom: r.custom };
      items.clear();
      for (const e of r.items) if (e.exists) items.set(e.id, e);
      jobs.clear();
      for (const j of r.jobs) jobs.set(j.id, j);
      changed();
    }).catch((e) => R.log('error', 'downloads.list: ' + R.errText(e)));
    return ready;
  }

  R.listen('download-progress', (e) => {
    const j = e.payload;
    if (!j || !j.id) return;
    if (j.state === 'done') {
      jobs.delete(j.id);
      items.set(j.id, { id: j.id, track: j.track, path: j.path, size: j.total, at: Date.now() / 1000 });
      batch.done++;
    } else if (j.state === 'cancelled') {
      jobs.delete(j.id);
      if (batch.count) batch.count--;
    } else {
      if (j.state === 'error' && jobs.get(j.id)?.state !== 'error') {
        batch.failed++;
        if (batch.count <= 1) R.toast(`${j.track.title}: ${j.error || 'download failed'}`, 'error');
      }
      jobs.set(j.id, j);
    }
    if (!activeCount() && batch.count) summarize();
    changed(j);
  });

  // One toast when the queue drains, not one per track (riff's wording).
  function summarize() {
    const { count, done, failed, single } = batch;
    if (count > 1) {
      R.toast(failed ? `Downloaded ${done}/${count} (${failed} failed)` : `Downloaded ${plural(count, 'track')} to ${folder.folder}`, failed ? 'error' : undefined);
    } else if (count === 1 && done === 1) {
      R.toast(`Downloaded "${single || 'track'}"`);
    }
    Object.assign(batch, { count: 0, done: 0, failed: 0, single: null });
  }

  async function start(tracks, album) {
    const list = tracks.filter(downloadable);
    if (!list.length) { R.toast('Only SoundCloud tracks can be downloaded', 'error'); return; }
    try {
      const r = await R.call('downloads.start', { tracks: list, album: album || '' });
      if (r.queued) {
        if (!batch.count) batch.single = list[0].title;
        batch.count += r.queued;
        R.toast(r.queued === 1 && list.length === 1 ? `Downloading "${list[0].title}"` : `Downloading ${plural(r.queued, 'track')}`);
      } else if (r.already) {
        R.toast(r.already === 1 ? 'Already downloaded' : 'Already downloaded or in progress');
      }
    } catch (e) {
      R.toast(R.errText(e), 'error');
    }
  }

  const cancel = (id) => R.call('downloads.cancel', { id: id || '' }).catch((e) => R.toast(R.errText(e), 'error'));
  const reveal = (id) => R.call('downloads.reveal', { id: id || '' }).catch((e) => R.toast(R.errText(e), 'error'));

  async function removeDownload(t) {
    if (!(await R.confirmBox('Remove download', `Delete the downloaded file of "${t.title}"? It can still be streamed.`, 'Remove'))) return;
    try {
      await R.call('downloads.remove', { id: t.id });
      items.delete(t.id);
      changed();
      R.toast('Download removed');
    } catch (e) {
      R.toast(R.errText(e), 'error');
    }
  }

  // ------------------------------------------------------------ redraws (batched per frame)

  let redrawQueued = false;
  let viewDirty = false;
  function changed(j) {
    // Progress ticks update rows in place; anything else re-renders the view.
    if (!j || !isActive(j) || !document.querySelector(`.dl-job[data-id="${CSS.escape(j.id)}"]`)) viewDirty = true;
    if (redrawQueued) return;
    redrawQueued = true;
    requestAnimationFrame(() => {
      redrawQueued = false;
      updatePill();
      updateBadge();
      updateListButtons();
      if (R.state.view === 'downloads') {
        if (viewDirty) R.render(true); else updateJobRows();
      }
      viewDirty = false;
    });
  }

  // ------------------------------------------------------------ track menu

  function menuFor(t) {
    if (!downloadable(t)) return [];
    const j = jobs.get(t.id);
    if (items.has(t.id)) {
      return [
        { label: 'Show in folder', run: () => reveal(t.id) },
        { label: 'Remove download', run: () => removeDownload(t) },
      ];
    }
    if (isActive(j)) return [{ label: 'Cancel download', run: () => cancel(t.id) }];
    return [{ label: j?.state === 'error' ? 'Retry download' : 'Download', run: () => start([t]) }];
  }
  R.addTrackMenu(menuFor);

  // ------------------------------------------------------------ player bar pill

  const pill = R.el(`<button class="pill-btn dl-pill" id="pb-download" title="Download track">${IC.download}</button>`);
  pill.addEventListener('click', () => {
    const t = R.player.current;
    if (!t) { R.toast('No track currently playing'); return; }
    if (!downloadable(t)) { R.toast('Only SoundCloud tracks can be downloaded', 'error'); return; }
    if (items.has(t.id)) reveal(t.id);
    else if (isActive(jobs.get(t.id))) R.go('downloads');
    else start([t]);
  });
  R.addPlaybarButton(pill, 'left');

  let pillShows = '';
  function updatePill() {
    const t = R.player.current;
    const j = t && jobs.get(t.id);
    const saved = !!t && items.has(t.id);
    const busy = isActive(j);
    pill.classList.toggle('on', saved);
    pill.classList.toggle('busy', busy);
    pill.style.setProperty('--p', busy ? pct(j) + '%' : '0%');
    const icon = saved ? 'saved' : 'download';
    if (pillShows !== icon) { pill.innerHTML = IC[icon]; pillShows = icon; }
    pill.title = !t ? 'Download track'
      : saved ? 'Downloaded · show in folder'
      : busy ? (j.state === 'queued' ? 'Waiting to download' : `Downloading… ${pct(j)}%`)
      : downloadable(t) ? 'Download track' : 'Only SoundCloud tracks can be downloaded';
  }
  R.on('trackchange', updatePill);

  // ------------------------------------------------------------ "Download all" on Likes / playlists

  const listButtons = new Set(); // { btn, tracks }
  function listName(ctx) {
    if (ctx.kind === 'sc') return R.state.scPlaylists.find((p) => String(p.id) === String(ctx.id))?.title || '';
    if (ctx.kind === 'local') return R.state.library.playlists.find((p) => String(p.id) === String(ctx.id))?.name || '';
    return '';
  }
  function updateListButtons() {
    for (const entry of listButtons) {
      if (!entry.btn.isConnected) { listButtons.delete(entry); continue; }
      const remote = entry.tracks.filter(downloadable);
      const have = remote.filter((t) => items.has(t.id)).length;
      const busy = remote.some((t) => isActive(jobs.get(t.id)));
      const all = remote.length > 0 && have === remote.length;
      const label = busy ? `Downloading ${have}/${remote.length}` : all ? 'Downloaded' : 'Download all';
      if (entry.label !== label) {
        entry.label = label;
        entry.btn.innerHTML = `${all ? IC.saved : IC.download}<span>${esc(label)}</span>`;
      }
      entry.btn.classList.toggle('done', all);
    }
  }
  R.addListTool({
    mount(toolsEl, ctx, _refresh, tracks) {
      if (!['likes', 'sc', 'local'].includes(ctx.kind) || !tracks) return;
      const btn = R.el(`<button class="btn outline dl-all" title="Download all songs" aria-label="Download all songs">${IC.download}<span>Download all</span></button>`);
      btn.addEventListener('click', async () => {
        await ready;
        const todo = tracks.filter((t) => downloadable(t) && !items.has(t.id) && !isActive(jobs.get(t.id)));
        if (!todo.length) {
          R.toast(tracks.some(downloadable) ? 'Everything here is already downloaded' : 'No remote tracks to download in this playlist');
          return;
        }
        const ok = todo.length === 1 || await R.confirmBox('Download all', `Download ${plural(todo.length, 'track')} to ${folder.folder}?`, `Download ${plural(todo.length, 'track')}`);
        if (ok) start(todo, listName(ctx));
      });
      toolsEl.append(btn);
      listButtons.add({ btn, tracks, label: 'Download all' });
      updateListButtons();
    },
  });

  // ------------------------------------------------------------ Downloads view

  function jobStatus(j) {
    if (j.state === 'queued') return 'Waiting';
    if (j.state === 'saving') return 'Saving…';
    if (j.state === 'error') return j.error || 'Failed';
    return j.total > 0 ? `${pct(j)}%` : 'Downloading…';
  }
  const barWidth = (j) => (j.state === 'saving' ? 100 : pct(j)) + '%';
  function jobRow(j) {
    const t = j.track || {};
    return `<div class="dl-job ${esc(j.state)}" data-id="${esc(j.id)}">
      <div class="dl-art" style="${R.bg(R.small(t.artwork))}"></div>
      <div class="dl-i"><div class="a">${esc(t.title)}</div>
        <div class="b"><span class="dl-artist">${esc(t.artist)}</span><span class="dl-status">${esc(jobStatus(j))}</span></div>
        <div class="dl-bar"><i style="width:${barWidth(j)}"></i></div></div>
      ${j.state === 'error' ? `<button class="pill-btn" data-act="retry" title="Retry">${IC.retry}</button>` : ''}
      <button class="pill-btn" data-act="cancel" title="${j.state === 'error' ? 'Dismiss' : 'Cancel'}">${IC.close}</button>
    </div>`;
  }
  function updateJobRows() {
    for (const row of document.querySelectorAll('#view .dl-job')) {
      const j = jobs.get(row.dataset.id);
      if (!j) continue;
      row.querySelector('.dl-status').textContent = jobStatus(j);
      row.querySelector('.dl-bar i').style.width = barWidth(j);
      row.className = `dl-job ${j.state}`;
    }
    const n = document.querySelector('#view .dl-jobs-count');
    if (n) n.textContent = activeCount() ? `${activeCount()} in progress` : '';
  }

  async function renderDownloads(token) {
    if (!ready) refresh();
    if (!items.size && !jobs.size) R.spinner();
    await ready;
    if (R.stale(token)) return;
    R.view.innerHTML = '';
    const entries = [...items.values()].sort((a, b) => (b.at || 0) - (a.at || 0));
    const tracks = entries.map((e) => e.track);
    const head = R.add(`<div class="head-row"><div><div class="page-title">Downloads</div>
      <div class="page-sub">${plural(tracks.length, 'track')} · ${fmtSize(totalSize())} · <span class="dl-folder">${esc(folder.folder)}</span></div></div>
      <div class="actions">${tracks.length ? R.listActions() : ''}<button class="btn outline" data-a="folder">${IC.folder}Open folder</button></div></div>`);
    R.wireActions(head, tracks, { folder: () => reveal('') });

    const list = [...jobs.values()];
    if (list.length) {
      const failed = list.filter((j) => j.state === 'error');
      const sec = R.add(`<div class="section-title dl-sec">Downloading <span class="dl-jobs-count">${activeCount() ? `${activeCount()} in progress` : ''}</span>
        <span class="dl-sec-actions">${failed.length ? '<button class="btn outline" data-a="retry-all">Retry failed</button>' : ''}<button class="btn outline" data-a="cancel-all">${activeCount() ? 'Cancel all' : 'Clear'}</button></span></div>`);
      sec.addEventListener('click', (e) => {
        const a = e.target.closest('[data-a]')?.dataset.a;
        if (a === 'cancel-all') cancel('');
        else if (a === 'retry-all') start(failed.map((j) => j.track));
      });
      const box = R.add(`<div class="dl-jobs">${list.map(jobRow).join('')}</div>`);
      box.addEventListener('click', (e) => {
        const b = e.target.closest('[data-act]');
        const row = e.target.closest('.dl-job');
        if (!b || !row) return;
        const j = jobs.get(row.dataset.id);
        if (b.dataset.act === 'cancel') cancel(row.dataset.id);
        else if (b.dataset.act === 'retry' && j) start([j.track]);
      });
    }

    R.add('<div class="section-title">Downloaded</div>');
    if (!tracks.length) {
      R.emptyMsg('Nothing downloaded yet. Use Download in a track\'s ⋯ menu, the player bar, or "Download all" on Likes and playlists.');
      return;
    }
    R.trackList(R.view, tracks, { removable: true, onRemove: (i) => removeDownload(tracks[i]) });
  }

  R.registerView('downloads', { title: 'Downloads', icon: IC.download, nav: true, render: renderDownloads });

  // Rail badge with the number of running downloads.
  const navInd = document.querySelector('.nav-item[data-view="downloads"] .nav-ind');
  const badge = navInd ? R.el('<span class="nav-badge" hidden></span>') : null;
  if (badge) navInd.append(badge);
  function updateBadge() {
    if (!badge) return;
    const n = activeCount();
    badge.hidden = !n;
    badge.textContent = n > 999 ? '999+' : String(n);
  }

  // ------------------------------------------------------------ settings

  async function pickFolder() {
    const dialog = window.__TAURI__ && window.__TAURI__.dialog;
    if (!dialog) { R.toast('The folder picker is not available', 'error'); return; }
    try {
      const dir = await dialog.open({ directory: true, multiple: false, title: 'Choose download folder', defaultPath: folder.folder || undefined });
      if (!dir || Array.isArray(dir)) return;
      await setFolder(dir);
    } catch (e) {
      R.toast(R.errText(e), 'error');
    }
  }
  async function setFolder(path) {
    try {
      const r = await R.call('downloads.folder', { path });
      folder = { folder: r.folder, default: r.default, custom: r.custom };
      R.toast(`Downloads go to ${folder.folder}`);
      if (R.state.view === 'settings' || R.state.view === 'downloads') R.render(true);
    } catch (e) {
      R.toast(R.errText(e), 'error');
    }
  }

  // Settings → Storage rows (Offline library, Download folder) are drawn by
  // features/system.js through this handle.
  R.downloads = {
    get folder() { return folder; },
    get ready() { return ready; },
    count: () => items.size,
    totalSize,
    fmtSize,
    pickFolder,
    setFolder,
    reveal,
    async clearAll() {
      let n = 0;
      for (const id of [...items.keys()]) {
        try { await R.call('downloads.remove', { id }); items.delete(id); n++; } catch (e) { R.log('warn', `downloads clear ${id}: ${R.errText(e)}`); }
      }
      changed();
      return n;
    },
  };

  // ------------------------------------------------------------ playback from disk

  async function resolveDownloaded(t) {
    if (!downloadable(t)) return null;
    if (ready) await ready;
    if (!items.has(t.id)) return null;
    try {
      const r = await R.call('downloads.get', { id: t.id });
      if (!r || !r.path) { items.delete(t.id); changed(); return null; }
      return { url: window.__TAURI__.core.convertFileSrc(r.path), protocol: 'file', preset: 'downloaded' };
    } catch (e) {
      return null;
    }
  }
  R.addStreamResolver(resolveDownloaded);

  // ------------------------------------------------------------ selftest (RIFF_SELFTEST=1)

  R.addSelftest(async (log) => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    await ready;
    try {
      const r = await R.call('downloads.list');
      log(`downloads list: OK ${r.items.length} saved, ${r.jobs.length} jobs, folder ${r.folder}`);
    } catch (e) {
      log(`downloads list: FAILED ${R.errText(e)}`);
    }
    const nav = !!document.querySelector('.nav-item[data-view="downloads"]');
    log(`downloads ui: ${nav && pill.isConnected ? 'OK' : 'FAILED'} (nav ${nav}, player-bar pill ${pill.isConnected})`);

    const none = await resolveDownloaded({ id: '1', source: '' });
    const local = await resolveDownloaded({ id: 'x', source: 'local', path: 'C:/x.mp3' });
    log(`downloads resolver passthrough: ${none === null && local === null ? 'OK' : 'FAILED'}`);

    const pool = [...(R.state.search?.results || []), ...(R.state.trending || [])];
    const cand = pool.find((t) => downloadable(t) && t.duration > 20 && t.duration < 420) || pool.find(downloadable);
    if (!cand) { log('downloads probe: FAILED (no SoundCloud track to test with)'); return; }
    const labels = menuFor(cand).map((i) => i.label);
    log(`downloads track menu: ${labels.length ? 'OK' : 'FAILED'} [${labels.join(', ')}]`);

    // Whole pipeline (stream -> file -> tags -> re-read) into a temp folder; the index is untouched.
    try {
      const p = await R.call('downloads.probe', { id: cand.id });
      const durOk = !p.expectDurationSec || Math.abs((p.durationSec || 0) - p.expectDurationSec) <= 3;
      const ok = !p.readError && p.title === p.expectTitle && durOk && p.size > 10000;
      log(`downloads probe: ${ok ? 'OK' : 'FAILED'} "${p.title || p.expectTitle}" -> ${p.name || '.' + p.ext} via ${p.protocol} ${p.preset}, ${fmtSize(p.size)}, ${(p.durationSec || 0).toFixed(1)}s of ${p.expectDurationSec}s, cover ${p.cover}, fetched ${p.fetchMs}ms, saved+tagged ${p.totalMs - p.fetchMs}ms${p.readError ? ', ' + p.readError : ''}`);
    } catch (e) {
      log(`downloads probe: FAILED ${R.errText(e)}`);
    }

    // An existing download must load through the asset protocol (separate muted element).
    const first = items.values().next().value;
    if (first) {
      const s = await resolveDownloaded(first.track);
      if (!s) {
        log('downloads play-from-disk: FAILED (resolver returned nothing)');
      } else {
        const a = new Audio();
        a.muted = true;
        a.preload = 'metadata';
        const loaded = await new Promise((res) => {
          const timer = setTimeout(() => res(false), 8000);
          a.onloadedmetadata = () => { clearTimeout(timer); res(true); };
          a.onerror = () => { clearTimeout(timer); res(false); };
          a.src = s.url;
        });
        log(`downloads play-from-disk: ${loaded ? 'OK' : 'FAILED'} "${first.track.title}"${loaded ? ' ' + a.duration.toFixed(1) + 's' : ' ' + s.url}`);
        a.removeAttribute('src');
        a.load();
      }
    } else {
      log('downloads play-from-disk: skipped (nothing downloaded yet)');
    }

    const prev = R.state.view, prevArg = R.state.arg;
    R.go('downloads');
    await wait(400);
    const title = document.querySelector('#view .page-title')?.textContent;
    log(`downloads view: ${title === 'Downloads' ? 'OK' : 'FAILED'} (${document.querySelectorAll('#view .track-row').length} rows, ${document.querySelectorAll('#view .dl-job').length} jobs)`);
    R.go(prev, prevArg);
  });

  refresh();
})();
