'use strict';
// Song cache (Rust: features/audiocache.rs): songs you play are kept on disk, so they start
// instantly next time and play offline. Least recently played go first past the size limit.
// A song is cached once it has played 30 s (or half of a short one). Settings → Storage.
(() => {
  const R = window.riff;
  const { convertFileSrc } = window.__TAURI__.core;
  const LIMITS = [[0.5, '500 MB'], [1, '1 GB'], [3, '3 GB'], [5, '5 GB'], [10, '10 GB'], [20, '20 GB']];
  const GB = 1024 * 1024 * 1024;
  const st = { ids: new Set(), count: 0, bytes: 0, limit: 3 * GB, tracks: [], asked: '' };
  const on = () => R.pref('songCache', true);
  const cacheable = (t) => !!t && !!t.id && t.source !== 'local' && !(R.downloads && R.downloads.has(t.id));

  const fmtSize = (b) => (b >= GB ? (b / GB).toFixed(1) + ' GB' : Math.round(b / 1024 / 1024) + ' MB');
  function apply(r) {
    if (!r) return;
    st.tracks = r.tracks || [];
    st.ids = new Set(st.tracks.map((t) => t.id));
    Object.assign(st, { count: r.count || 0, bytes: r.bytes || 0, limit: r.limit || st.limit });
    paintSettings();
  }
  const refresh = () => R.call('audiocache.list').then(apply).catch((e) => R.log('warn', `audiocache: ${R.errText(e)}`));
  R.listen('audiocache-changed', async () => { await refresh(); if (R.state.view === 'cached') R.render(true); });
  R.on('ready', refresh);

  // Before the network resolvers (this file loads right after downloads.js).
  async function resolveCached(t) {
    if (!on() || !t || !st.ids.has(t.id)) return null;
    try {
      const r = await R.call('audiocache.get', { id: t.id });
      if (!r || !r.path) { st.ids.delete(t.id); return null; }
      return { url: convertFileSrc(r.path), protocol: 'file', preset: 'cached' };
    } catch (e) { return null; }
  }
  R.addStreamResolver(resolveCached);

  R.audio.addEventListener('timeupdate', () => {
    const t = R.player.current;
    if (!on() || !cacheable(t) || st.ids.has(t.id) || st.asked === t.id || !navigator.onLine) return;
    const d = R.duration() || t.duration || 0;
    if (R.audio.currentTime < Math.min(30, d ? d / 2 : 30)) return;
    st.asked = t.id;
    R.call('audiocache.add', { track: t }).catch((e) => R.log('warn', `audiocache add: ${R.errText(e)}`));
  });

  // ---------------------------------------------------------------- "Cached songs" page
  R.registerView('cached', {
    title: 'Cached songs',
    async render(token) {
      await refresh();
      if (R.stale(token)) return;
      const head = R.add(`<div class="head-row"><div><div class="page-title">Cached songs</div><div class="page-sub">${R.plural(st.count, 'song')} · ${fmtSize(st.bytes)} of ${fmtSize(st.limit)}</div></div>
        <div class="actions">${st.tracks.length ? R.listActions() : ''}</div></div>`);
      head.addEventListener('click', (e) => {
        const a = e.target.closest('[data-a]')?.dataset.a;
        if (a === 'play') R.playList(st.tracks, 0, false);
        else if (a === 'shuffle') R.playList(st.tracks, Math.floor(Math.random() * st.tracks.length), true);
      });
      if (!st.tracks.length) {
        R.add(`<div class="page-sub">${on() ? 'Songs you play show up here once they have played for 30 seconds.' : 'The song cache is off (Settings → Storage).'}</div>`);
        return;
      }
      R.trackList(R.add('<div class="cache-list"></div>'), st.tracks);
    },
  });
  R.addTrackMenu((t) => (t && st.ids.has(t.id) ? [{ label: 'Remove from cache', run: () => R.call('audiocache.remove', { id: t.id }).then(apply) }] : []));

  // ---------------------------------------------------------------- settings
  let setBox = null;
  function paintSettings() {
    if (!setBox || !setBox.isConnected) return;
    setBox.querySelector('[data-cache-sum]').textContent = `${R.plural(st.count, 'song')} · ${fmtSize(st.bytes)} of ${fmtSize(st.limit)}`;
  }
  R.addSettings(() => {
    const S = R.settingsRow;
    if (!S) return;
    R.add('<div class="section-title">Song cache</div>');
    const nearest = () => String(LIMITS.reduce((b, [g]) => (Math.abs(g * GB - st.limit) < Math.abs(b * GB - st.limit) ? g : b), 3));
    const g = S.group([
      S.prefToggle('songCache', true, 'Keep songs you play', 'Songs you have played start instantly next time and play offline. The least recently played are removed when the cache is full'),
      S.select({ name: 'Cache size', options: LIMITS.map(([v, l]) => [String(v), l]), value: nearest(), onChange: (v) => R.call('audiocache.set_limit', { bytes: Math.round(Number(v) * GB) }).then(apply) }),
    ]);
    setBox = R.el(`<div class="th-item setting-item"><div class="th-top"><div class="th-col"><span class="th-name">Cached songs</span><span class="th-desc" data-cache-sum></span></div>
      <div class="th-side"><button type="button" class="btn outline sys-btn" data-a="show">Show</button><button type="button" class="btn outline sys-btn" data-a="clear">Clear</button></div></div></div>`);
    g.append(setBox);
    setBox.addEventListener('click', async (e) => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (a === 'show') R.go('cached');
      else if (a === 'clear' && (await R.confirmBox('Clear song cache', `Delete ${R.plural(st.count, 'cached song')} (${fmtSize(st.bytes)})? Downloads are not touched.`, 'Clear'))) apply(await R.call('audiocache.clear'));
    });
    paintSettings();
    refresh();
  }, 'storage');

  R.cache = { has: (id) => st.ids.has(id), refresh };

  R.addSelftest(async (log) => {
    const r = await R.call('audiocache.list');
    log(`audiocache list ${r && Array.isArray(r.tracks) && r.limit >= 250 * 1024 * 1024 ? 'OK' : 'FAILED'}: ${r?.count} songs, ${fmtSize(r?.bytes || 0)} of ${fmtSize(r?.limit || 0)}`);
    const t = R.player.current;
    if (!t || !cacheable(t)) { log('audiocache add skipped: nothing streamable playing'); return; }
    await R.call('audiocache.add', { track: t });
    const end = Date.now() + 90000;
    while (Date.now() < end && !st.ids.has(t.id)) { await new Promise((res) => setTimeout(res, 1000)); await refresh(); }
    const cached = st.ids.has(t.id);
    const s = cached ? await resolveCached(t) : null;
    log(`audiocache add + resolve ${cached && s && s.protocol === 'file' ? 'OK' : 'FAILED'}: "${t.title}" ${s ? s.url.slice(0, 60) : ''}`);
  });
})();
