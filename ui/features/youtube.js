'use strict';
// YouTube + YouTube Music: search providers for riff's platform switch, playback, links.
// Backend: src-tauri/src/features/youtube.rs (youtube.*). Uses window.riff (see README.md).
(() => {
  const R = window.riff;
  const { errText } = R;

  // riff's platform-switch icons (index.html #platform-yt / #platform-ytm)
  const IC = {
    yt: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M21.58 7.19c-.23-.86-.91-1.54-1.77-1.77C18.25 5 12 5 12 5s-6.25 0-7.81.42c-.86.23-1.54.91-1.77 1.77C2 8.75 2 12 2 12s0 3.25.42 4.81c.23.86.91 1.54 1.77 1.77C5.75 19 12 19 12 19s6.25 0 7.81-.42c.86-.23 1.54-.91 1.77-1.77C22 15.25 22 12 22 12s0-3.25-.42-4.81zM10 15V9l5.2 3L10 15z"/></svg>',
    ytm: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm-2-12.5v9l6-4.5-6-4.5z"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
    err: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
  };

  const PAGE = 20;
  const LINK = /^(https?:\/\/)?((www|m|music)\.)?(youtube\.com|youtu\.be)\//i;
  const isYt = (t) => !!t && (t.source === 'youtube' || /^yt:/.test(String(t.id || '')));
  const vid = (t) => String(t.id || '').replace(/^yt:/, '');
  const prefetched = new Set();

  function prefetch(t) {
    if (!isYt(t) || prefetched.has(t.id)) return;
    prefetched.add(t.id);
    if (prefetched.size > 400) prefetched.clear();
    R.call('youtube.prefetch', { id: t.id }).catch(() => {});
  }

  // ---------------------------------------------------------------- search providers

  function provider(id, label, icon, withLinks) {
    return {
      id, label, icon, pageSize: PAGE,
      matchesLink: withLinks ? (text) => LINK.test(String(text || '').trim()) : undefined,
      async search(query, offset) {
        const tracks = await R.call('youtube.search', { source: id, query, offset: offset || 0 });
        if (!offset && tracks.length) prefetch(tracks[0]); // the likely first click plays instantly
        return tracks;
      },
    };
  }
  // addSearchProvider puts each new one first: register in reverse for "YouTube | YouTube Music | SoundCloud".
  R.addSearchProvider(provider('ytmusic', 'YouTube Music', IC.ytm, false));
  R.addSearchProvider(provider('youtube', 'YouTube', IC.yt, true));

  // ---------------------------------------------------------------- playback

  async function resolveYt(t, fresh) {
    if (!isYt(t)) return null;
    try {
      const r = await R.call('youtube.resolve', { id: t.id, fresh: !!fresh });
      R.log('info', `youtube ${vid(t)} via ${r.method} itag ${r.itag} in ${r.ms}ms`);
      return { url: r.url, protocol: 'progressive', preset: `youtube/${r.method}` };
    } catch (e) {
      const msg = errText(e);
      if (/YTDLP_MISSING/.test(msg)) {
        toolsModal(t);
        throw new Error('YouTube needs yt-dlp for this track');
      }
      throw e;
    }
  }
  R.addStreamResolver(resolveYt);

  // Warm the next YouTube link: shortly after a track starts, and again near the end (links expire).
  let nearEnd = '';
  R.on('trackchange', () => {
    nearEnd = '';
    setTimeout(() => { const n = R.upcoming(1)[0]; if (n) prefetch(n); }, 2500);
  });
  R.audio.addEventListener('timeupdate', () => {
    const cur = R.player.current;
    const d = R.duration();
    if (!cur || !d || d - R.audio.currentTime > 30 || nearEnd === cur.id) return;
    nearEnd = cur.id;
    const n = R.upcoming(1)[0];
    if (isYt(n)) R.call('youtube.prefetch', { id: n.id }).catch(() => {});
  });

  // ---------------------------------------------------------------- artist / menu

  function searchYoutube(text) {
    const sw = document.querySelector('#platform-switch [data-p="youtube"]');
    if (sw && !sw.classList.contains('active')) sw.click();
    const input = document.querySelector('#search-input');
    if (!input) return;
    input.value = text;
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
  }
  const open = (url) => R.call('youtube.open', { url }).catch((e) => R.toast(errText(e), 'error'));

  // Artist click on a YouTube track: search YouTube for the channel / artist name.
  // (Deferred so it runs after other 'artist' listeners and wins the view.)
  R.on('artist', (t) => {
    if (!isYt(t) || !t.artist) return;
    setTimeout(() => searchYoutube(t.artist), 0);
  });

  R.addTrackMenu((t) => {
    if (!isYt(t)) return [];
    const items = [];
    if (t.artist && !/^unknown artist$/i.test(t.artist)) items.push({ label: `Search “${t.artist}” on YouTube`, run: () => searchYoutube(t.artist) });
    if (t.artist_url) items.push({ label: 'Open channel in browser', run: () => open(t.artist_url) });
    items.push({ label: /music\.youtube/.test(t.url) ? 'Open on YouTube Music' : 'Open on YouTube', run: () => open(t.url || `https://www.youtube.com/watch?v=${vid(t)}`) });
    return items;
  });

  // ---------------------------------------------------------------- Required tools (riff's yt-dlp prompt)

  let tools = { status: 'idle', percent: 0, error: '', ytdlp: null };
  let modalEl = null;
  let retryTrack = null;

  function paintModal() {
    if (!modalEl || !modalEl.isConnected) { modalEl = null; return; }
    const s = tools;
    const busy = s.status === 'downloading';
    modalEl.querySelector('.yt-pct').textContent = busy ? `${s.percent || 0}%` : s.ytdlp ? 'Installed' : '';
    const icon = modalEl.querySelector('.yt-tool-icon');
    icon.innerHTML = s.ytdlp && !busy ? IC.check : s.status === 'error' ? IC.err : '';
    icon.className = `yt-tool-icon${busy ? ' busy' : ''}${s.ytdlp && !busy ? ' ok' : ''}${s.status === 'error' ? ' bad' : ''}`;
    modalEl.querySelector('.yt-bar').hidden = !busy;
    modalEl.querySelector('.yt-bar i').style.width = `${s.percent || 0}%`;
    const err = modalEl.querySelector('.yt-err');
    err.hidden = s.status !== 'error';
    err.textContent = s.error || '';
    modalEl.querySelector('[data-k=go]').hidden = busy || s.status === 'error' || !!s.ytdlp;
    modalEl.querySelector('[data-k=retry]').hidden = s.status !== 'error';
    modalEl.querySelector('[data-k=no]').textContent = s.ytdlp ? 'Close' : 'Not now';
  }

  async function toolsModal(t) {
    retryTrack = t || null;
    modalEl = R.openModal(`<div class="yt-tools">
      <h3>Required tools</h3>
      <p>${t ? 'YouTube blocked the direct stream for this track. ' : ''}The app can play it through yt-dlp (~18 MB, from the official yt-dlp GitHub release).</p>
      <div class="yt-tool-row">
        <div class="yt-tool-head"><span class="yt-tool-name">yt-dlp</span><span class="yt-pct"></span><span class="yt-tool-icon"></span></div>
        <div class="yt-bar" hidden><i></i></div>
      </div>
      <div class="yt-err" hidden></div>
      <div class="row-btns">
        <button class="btn outline" data-k="no">Not now</button>
        <button class="btn primary" data-k="go">Download</button>
        <button class="btn outline" data-k="retry" hidden>Retry</button>
      </div></div>`);
    modalEl.querySelector('[data-k=no]').onclick = () => { R.closeModal(); modalEl = null; };
    const start = async () => {
      try { tools = await R.call('youtube.install'); } catch (e) { tools = { ...tools, status: 'error', error: errText(e) }; }
      paintModal();
    };
    modalEl.querySelector('[data-k=go]').onclick = start;
    modalEl.querySelector('[data-k=retry]').onclick = start;
    try { tools = await R.call('youtube.tools'); } catch (e) {}
    paintModal();
  }

  R.listen('youtube-tools', (e) => {
    tools = e.payload || tools;
    paintModal();
    paintSettings();
    if (tools.status === 'done') {
      R.toast('yt-dlp installed');
      if (modalEl) { R.closeModal(); modalEl = null; }
      const t = retryTrack;
      retryTrack = null;
      if (t && R.player.current && R.player.current.id === t.id) R.playTrack(t, 0, true);
    } else if (tools.status === 'error' && !modalEl) {
      R.toast(`yt-dlp download failed: ${tools.error}`, 'error');
    }
  });

  // ---------------------------------------------------------------- settings

  let setCard = null;
  function paintSettings() {
    if (!setCard || !setCard.isConnected) { setCard = null; return; }
    const s = tools;
    const busy = s.status === 'downloading';
    setCard.querySelector('.b').textContent = busy ? `Downloading yt-dlp… ${s.percent || 0}%`
      : s.ytdlp ? `Direct streams, yt-dlp as fallback: ${s.ytdlp}`
      : 'Direct streams. yt-dlp is not installed (only needed when YouTube blocks a direct stream).';
    setCard.querySelector('[data-a=dl]').hidden = !!s.ytdlp || busy;
  }
  R.addSettings(() => {
    R.add('<div class="section-title">YouTube</div>');
    setCard = R.add(`<div class="set-card yt-set">${IC.yt}<div class="i"><div class="a">YouTube &amp; YouTube Music</div>
      <div class="b">Checking yt-dlp…</div></div>
      <button class="btn outline" data-a="dl" hidden>Download yt-dlp</button></div>`);
    setCard.querySelector('[data-a=dl]').onclick = () => toolsModal(null);
    R.call('youtube.tools').then((s) => { tools = s; paintSettings(); }).catch(() => {});
  }, 'integrations');

  // ---------------------------------------------------------------- selftest

  R.addSelftest(async (log) => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const until = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await wait(100); } return false; };
    const ok = (b) => (b ? 'OK' : 'FAILED');
    const now = () => performance.now();
    R.audio.muted = true;

    // The source picker is a chip in the search box; its menu order is kept in data-order.
    const pills = document.querySelector('#platform-switch')?.dataset.order || '';
    log(`youtube platform switch ${ok(pills.startsWith('youtube,ytmusic'))}: ${pills}`);

    let t0 = now();
    const yt = await R.call('youtube.search', { source: 'youtube', query: 'daft punk', offset: 0 });
    const ytOk = yt.length >= 10 && yt.every((t) => /^yt:[\w-]{11}$/.test(t.id) && t.source === 'youtube' && t.duration > 0);
    log(`youtube search ${ok(ytOk)}: ${yt.length} tracks in ${Math.round(now() - t0)}ms; first: ${yt[0] ? `${yt[0].title} / ${yt[0].artist} / ${R.fmt(yt[0].duration)}` : '-'}`);

    t0 = now();
    const ytm = await R.call('youtube.search', { source: 'ytmusic', query: 'daft punk', offset: 0 });
    log(`ytmusic search ${ok(ytm.length >= 10 && ytm.every((t) => isYt(t) && t.duration > 0))}: ${ytm.length} tracks in ${Math.round(now() - t0)}ms; first: ${ytm[0] ? `${ytm[0].title} / ${ytm[0].artist} / ${R.fmt(ytm[0].duration)}` : '-'}`);

    t0 = now();
    const more = await R.call('youtube.search', { source: 'ytmusic', query: 'daft punk', offset: PAGE });
    log(`ytmusic page 2 ${ok(more.length > 0)}: ${more.length} tracks in ${Math.round(now() - t0)}ms`);

    t0 = now();
    const link = await R.call('youtube.search', { source: 'youtube', query: 'https://youtu.be/dQw4w9WgXcQ', offset: 0 });
    log(`youtube link ${ok(link.length === 1 && link[0].id === 'yt:dQw4w9WgXcQ')}: ${link[0] ? link[0].title : '-'} in ${Math.round(now() - t0)}ms`);

    const t = ytm[1] || yt[1];
    if (!t) return;
    t0 = now();
    const s = await resolveYt(t, false);
    log(`youtube resolve ${ok(!!s && /^http:\/\/127\.0\.0\.1:\d+\/yt\//.test(s.url))}: ${s && s.preset} in ${Math.round(now() - t0)}ms`);

    t0 = now();
    R.playList([t], 0);
    const playing = await until(() => R.player.current === t && !R.audio.paused && R.audio.currentTime > 0.3, 20000);
    log(`youtube playback ${ok(playing)}: "${t.title}" t=${R.audio.currentTime.toFixed(1)}s, started in ${Math.round(now() - t0)}ms, crossOrigin=${R.audio.crossOrigin || 'none'}`);
    if (playing) {
      const target = Math.min(90, Math.max(5, (R.duration() || 120) / 2));
      t0 = now();
      R.audio.currentTime = target;
      const seeked = await until(() => !R.audio.paused && R.audio.currentTime > target + 0.3, 15000);
      log(`youtube seek ${ok(seeked)}: to ${target.toFixed(0)}s -> t=${R.audio.currentTime.toFixed(1)}s in ${Math.round(now() - t0)}ms`);
    }
    R.audio.pause();
  });
})();
