// Playlist imports, like riff: Spotify (link, export files, account), Apple Music (link,
// export files) and SoundCloud / YouTube / YouTube Music playlist links. Rust reads the
// remote list (imports.fetch) and matches it to playable tracks (imports.run), 6 at a time,
// in order, and saves one local playlist. Entry points: Playlists view "Import" and
// Settings > Integrations.
(() => {
  const R = window.riff;
  const { esc } = R;

  const IC = {
    spotify: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm4.6 14.4a.62.62 0 0 1-.86.2c-2.35-1.43-5.3-1.76-8.79-.96a.62.62 0 1 1-.28-1.21c3.81-.87 7.08-.5 9.72 1.11.3.18.39.57.2.86Zm1.22-2.72a.78.78 0 0 1-1.07.26c-2.69-1.65-6.79-2.13-9.97-1.17a.78.78 0 1 1-.45-1.49c3.63-1.1 8.15-.57 11.23 1.33.37.22.48.7.26 1.07Zm.1-2.84C14.7 8.93 9.38 8.75 6.3 9.68a.94.94 0 1 1-.54-1.79c3.53-1.07 9.4-.86 13.1 1.34a.94.94 0 0 1-.95 1.61Z"/></svg>',
    apple: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M16.37 12.6c-.02-2.2 1.8-3.26 1.88-3.31-1.03-1.5-2.62-1.7-3.18-1.73-1.35-.14-2.64.8-3.33.8-.69 0-1.74-.78-2.87-.76a4.24 4.24 0 0 0-3.58 2.18c-1.53 2.65-.39 6.57 1.1 8.72.73 1.05 1.6 2.23 2.73 2.19 1.1-.05 1.51-.71 2.84-.71 1.32 0 1.7.71 2.86.69 1.18-.02 1.93-1.07 2.65-2.13a9.4 9.4 0 0 0 1.2-2.47 3.83 3.83 0 0 1-2.3-3.47ZM14.2 6.13a3.5 3.5 0 0 0 .8-2.53 3.57 3.57 0 0 0-2.31 1.2 3.34 3.34 0 0 0-.83 2.43c.88.07 1.79-.45 2.34-1.1Z"/></svg>',
    link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',
    yt: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M23 12s0-3.6-.46-5.33a2.78 2.78 0 0 0-1.96-1.96C18.88 4.25 12 4.25 12 4.25s-6.88 0-8.58.46A2.78 2.78 0 0 0 1.46 6.67C1 8.4 1 12 1 12s0 3.6.46 5.33a2.78 2.78 0 0 0 1.96 1.96c1.7.46 8.58.46 8.58.46s6.88 0 8.58-.46a2.78 2.78 0 0 0 1.96-1.96C23 15.6 23 12 23 12ZM9.75 15.27V8.73L15.5 12l-5.75 3.27Z"/></svg>',
    ytm: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 15.5a5.5 5.5 0 1 1 0-11 5.5 5.5 0 0 1 0 11Zm0-10a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9Zm-1.5 6.75v-4.5L14.25 12l-3.75 2.25Z"/></svg>',
    sc: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M1.2 14.3c0 .7.5 1.2 1 1.2s1-.5 1-1.2l.2-2-.2-2c0-.5-.4-.9-1-.9-.5 0-1 .4-1 .9l-.2 2 .2 2Zm3.1 1.2c.5 0 .9-.4 1-.9l.2-3.3-.2-3.6c0-.5-.5-.9-1-.9s-.9.4-.9.9l-.2 3.6.2 3.3c0 .5.4.9.9.9Zm3.2.1c.5 0 .9-.4.9-.9l.2-3.4-.2-5.1c0-.5-.4-.9-.9-.9s-.9.4-.9.9l-.2 5.1.2 3.4c0 .5.4.9.9.9Zm3.2 0c.5 0 .9-.4.9-.9l.2-3.4-.2-6.4c0-.5-.4-.9-.9-.9s-.9.4-.9.9l-.1 6.4.1 3.4c0 .5.4.9.9.9Zm9.1-6.8c-.4 0-.8.1-1.1.2a4.7 4.7 0 0 0-4.7-4.3c-.6 0-1.2.1-1.7.3-.2.1-.3.2-.3.4v9.3c0 .2.2.4.4.4h7.4a3.2 3.2 0 0 0 0-6.3Z"/></svg>',
    warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    chev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  };
  const WARN_TEXT = "We don't steal anything, and nothing leaves your computer except the searches. Want zero risk? Import a single playlist by link instead.";

  let busy = null; // { job, label } while an import runs (survives closing the modal)
  let progressFn = null;
  R.listen('import-progress', (e) => { if (progressFn) progressFn(e.payload); });

  // ------------------------------------------------------------ export-file parsers (riff's formats)

  const dur = (v) => {
    if (typeof v === 'number') return v > 1000 ? Math.round(v / 1000) : Math.round(v);
    const s = String(v || '').trim();
    if (!s) return 0;
    if (/^\d+$/.test(s)) { const n = +s; return n > 1000 ? Math.round(n / 1000) : n; }
    const m = s.match(/^(?:(\d+):)?(\d+):(\d{2})$/);
    if (m) return (+(m[1] || 0)) * 3600 + (+m[2]) * 60 + (+m[3]);
    const iso = s.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
    return iso ? (+(iso[1] || 0)) * 3600 + (+(iso[2] || 0)) * 60 + (+(iso[3] || 0)) : 0;
  };
  const item = (title, artist, duration) => ({ title: String(title).trim(), artist: String(artist || '').trim(), duration: dur(duration) });

  /** Spotify "Download your data": YourLibrary.json (tracks) and Playlist1.json (playlists). */
  function parseSpotifyExport(json, out) {
    const tracks = Array.isArray(json?.tracks) ? json.tracks : (Array.isArray(json) && !json[0]?.items ? json : null);
    for (const t of tracks || []) {
      const title = t.track || t.trackName; const artist = t.artist || t.artistName;
      if (title && artist) out.likes.push(item(title, artist, t.durationMs || t.duration_ms));
    }
    const pls = Array.isArray(json?.playlists) ? json.playlists : (Array.isArray(json) && json[0]?.items ? json : null);
    for (const p of pls || []) {
      const list = (p.items || []).map((it) => it?.track).filter(Boolean)
        .map((t) => item(t.trackName || t.track || '', t.artistName || t.artist, t.durationMs || t.duration_ms)).filter((t) => t.title && t.artist);
      if (list.length) out.playlists.push({ name: p.name || 'Imported playlist', tracks: list });
    }
  }

  function parseCsv(text) {
    const rows = []; let row = []; let cell = ''; let q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; continue; }
      if (c === '"') q = true;
      else if (c === ',' ) { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
      else cell += c;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    const head = (rows.shift() || []).map((h) => h.replace(/^﻿/, '').trim());
    return rows.filter((r) => r.some((c) => c.trim())).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] || ''])));
  }

  /** Apple privacy export: CSV with title/artist(/playlist) columns, or JSON. */
  function parseAppleCsv(text, out) {
    const rows = parseCsv(text);
    if (!rows.length) return;
    const hs = Object.keys(rows[0]);
    const col = (re, loose) => hs.find((h) => re.test(h)) || (loose ? hs.find((h) => loose.test(h)) : undefined);
    const tc = col(/^(title|name|track\s*name|song(\s*name)?|track\s*description)$/i, /(title|song|track)/i);
    const ac = col(/^(artist(\s*name)?|artist\(s\)|creator|uploader)$/i, /artist/i);
    const dc = col(/(duration|time|length)/i);
    const pc = col(/(playlist(\s*name)?|container(\s*description|\s*name)?)/i);
    const map = new Map();
    for (const r of rows) {
      const t = tc && r[tc]; const a = ac && r[ac];
      if (!t || !a) continue;
      const tr = item(t, a, dc ? r[dc] : 0);
      const pl = pc ? r[pc].trim() : '';
      if (pl) { if (!map.has(pl)) map.set(pl, []); map.get(pl).push(tr); } else out.likes.push(tr);
    }
    for (const [name, tracks] of map) out.playlists.push({ name, tracks });
  }
  function parseAppleJson(json, out) {
    const map = new Map();
    const walk = (n, pl) => {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) { n.forEach((x) => walk(x, pl)); return; }
      pl = n.playlistName || n.playlist || n['playlist name'] || pl;
      const list = Array.isArray(n.tracks) ? n.tracks : Array.isArray(n.items) ? n.items : null;
      if (list && (n.name || n.title)) { list.forEach((x) => walk(x, n.name || n.title)); return; }
      const title = String(n.title || n.name || n.trackName || n.song || n['track name'] || n['song name'] || '').trim();
      const artist = String(n.artistName || n.artist || n.artist_name || n['artist name'] || '').trim();
      const d = dur(n.durationInMillis || n.duration || n.duration_ms || n.time || n.trackDuration);
      if (title && artist && (n.type === 'song' || n.type === 'songs' || d || pl || n.contentDescriptor)) {
        const tr = { title, artist, duration: d };
        if (pl) { if (!map.has(pl)) map.set(pl, []); map.get(pl).push(tr); } else out.likes.push(tr);
        return;
      }
      Object.values(n).forEach((x) => walk(x, pl));
    };
    walk(json, '');
    for (const [name, tracks] of map) out.playlists.push({ name, tracks });
  }

  async function readFiles(files, kind) {
    const out = { likes: [], playlists: [] };
    for (const f of files) {
      try {
        const text = await f.text();
        if (kind === 'spotify') parseSpotifyExport(JSON.parse(text), out);
        else if (/\.csv$/i.test(f.name) || !/^\s*[[{]/.test(text)) parseAppleCsv(text, out);
        else parseAppleJson(JSON.parse(text), out);
      } catch (e) { R.log('warn', `import: could not read ${f.name}: ${R.errText(e)}`); }
    }
    return out;
  }

  // ------------------------------------------------------------ wavy progress (riff's import bar)

  function wave(canvas) {
    let frac = 0; let shown = 0; let phase = 0; let alive = true; let last = performance.now();
    const color = () => getComputedStyle(document.documentElement).getPropertyValue('--primary').trim() || '#fff';
    const track = () => getComputedStyle(document.documentElement).getPropertyValue('--container-highest').trim() || '#333';
    const draw = (now) => {
      if (!alive || !canvas.isConnected) return;
      const dt = Math.min(0.05, (now - last) / 1000); last = now;
      phase += dt * 3.5; shown += (frac - shown) * Math.min(1, dt * 8);
      const dpr = devicePixelRatio || 1; const w = canvas.clientWidth; const h = canvas.clientHeight;
      if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
      const g = canvas.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
      const mid = h / 2; const x = Math.max(0, Math.min(w, shown * w)); const gap = 6;
      g.lineCap = 'round'; g.lineWidth = 4;
      if (x + gap < w - 2) { g.strokeStyle = track(); g.beginPath(); g.moveTo(x + gap, mid); g.lineTo(w - 2, mid); g.stroke(); }
      if (x > 2) {
        g.strokeStyle = color(); g.beginPath();
        for (let px = 2; px <= x; px += 1) { const y = mid + Math.sin(px / 24 * Math.PI * 2 - phase) * 3.5; if (px === 2) g.moveTo(px, y); else g.lineTo(px, y); }
        g.stroke();
      }
      R.nextFrame(draw, 30);
    };
    R.nextFrame(draw, 30);
    return { set: (f) => { frac = Math.max(0, Math.min(1, f)); }, stop: () => { alive = false; } };
  }

  // ------------------------------------------------------------ the modal

  const MODES = {
    spotify: { title: 'Import from Spotify', icon: IC.spotify, tabs: [['link', 'Playlist link'], ['web', 'Liked songs'], ['file', 'Export files'], ['login', 'Developer app']], placeholder: 'Spotify playlist, album or track link', newLabel: 'New playlist (Spotify name)' },
    apple: { title: 'Import from Apple Music', icon: IC.apple, tabs: [['link', 'Playlist link'], ['file', 'Export files']], placeholder: 'Paste an Apple Music playlist or album link', newLabel: 'New playlist (Apple Music name)' },
    link: { title: 'Import from link', icon: IC.link, tabs: [['link', 'Link']], placeholder: 'Paste a YouTube, YouTube Music or SoundCloud link', newLabel: 'New playlist (same name)' },
  };
  const PLACEHOLDER = { youtube: 'Paste a YouTube playlist link', ytmusic: 'Paste a YouTube Music playlist link', soundcloud: 'Paste a SoundCloud playlist (set) link' };

  function preferred() {
    const p = R.state.platform;
    return p === 'youtube' || p === 'ytmusic' ? p : 'soundcloud';
  }

  function dropdown(root, options, value, onPick) {
    const label = root.querySelector('[data-dd-label]');
    const menu = root.querySelector('.imp-dd-menu');
    const set = (v) => { value = v; const o = options.find((x) => x[0] === v) || options[0]; label.textContent = o[1]; menu.querySelectorAll('button').forEach((b) => b.classList.toggle('selected', b.dataset.v === v)); onPick(v); };
    menu.innerHTML = options.map(([v, l]) => `<button type="button" data-v="${esc(v)}">${esc(l)}</button>`).join('');
    root.querySelector('.imp-dd-trigger').onclick = (e) => { e.stopPropagation(); root.classList.toggle('open'); };
    menu.onclick = (e) => { const b = e.target.closest('[data-v]'); if (!b) return; root.classList.remove('open'); set(b.dataset.v); };
    root.ownerDocument.addEventListener('mousedown', (e) => { if (!root.contains(e.target)) root.classList.remove('open'); });
    set(value);
  }

  function open(kind = 'spotify', opts = {}) {
    if (busy) { R.toast(`Still importing ${busy.label}…`); }
    const M = MODES[kind] || MODES.link;
    const m = R.openModal(`<div class="imp">
      <div class="imp-head"><span class="imp-logo imp-${kind}">${opts.platform === 'youtube' ? IC.yt : opts.platform === 'ytmusic' ? IC.ytm : opts.platform === 'soundcloud' ? IC.sc : M.icon}</span><h3>${M.title}</h3></div>
      ${M.tabs.length > 1 ? `<div class="imp-modes">${M.tabs.map(([k, l]) => `<button type="button" data-mode="${k}">${l}</button>`).join('')}</div>` : ''}
      <div class="imp-pane" data-mode="link">
        <label class="imp-field"><span class="imp-field-ic">${IC.link}</span><input type="text" data-k="url" placeholder="${esc(PLACEHOLDER[opts.platform] || M.placeholder)}" spellcheck="false"></label>
        <div class="imp-label">Import into</div>
        <div class="imp-dd" data-k="target"><button type="button" class="imp-dd-trigger"><span data-dd-label></span>${IC.chev}</button><div class="imp-dd-menu"></div></div>
      </div>
      <div class="imp-pane" data-mode="file" hidden>
        <p class="imp-help">${kind === 'spotify'
          ? 'Spotify → Account → Privacy → Download your data. When the archive arrives, pick Playlist1.json and YourLibrary.json.'
          : 'privacy.apple.com → Request a copy of your data → Apple Media Services. Unzip it, then pick the playlist / library CSV or JSON files.'}</p>
        <div class="imp-row"><button type="button" class="btn outline" data-k="pick">Choose files</button><input type="file" data-k="files" accept=".json,.csv,application/json,text/csv" multiple hidden><span class="imp-dim" data-k="file-info">No files selected</span></div>
        <div class="imp-checks">${check('likes', 'Liked songs')}${check('pls', 'Playlists')}</div>
        <div class="imp-dim" data-k="file-sum"></div>
        <div class="imp-warn">${IC.warn}<span>${WARN_TEXT}</span></div>
      </div>
      <div class="imp-pane" data-mode="web" hidden>
        <p class="imp-help">Sign in to Spotify in a noxx window to import your Liked songs. No developer app or data export needed.</p>
        <div class="imp-row"><button type="button" class="btn outline" data-k="web-login">Sign in to Spotify</button><button type="button" class="btn outline" data-k="web-logout" hidden>Sign out</button><span class="imp-dim" data-k="web-status">Not signed in</span></div>
        <div class="imp-warn">${IC.warn}<span>You sign in on Spotify's own page. noxx keeps the sign-in in the app data folder to read your Liked songs, and reads them the way the Spotify web player does, so a Spotify update can break this until noxx catches up. For playlists, use Playlist link.</span></div>
      </div>
      <div class="imp-pane" data-mode="login" hidden>
        <p class="imp-help">Public playlists: use Playlist link. Liked songs: use the Liked songs tab. This option is for private playlists, through your own Spotify developer app.</p>
        <p class="imp-help">1) Open <a href="#" data-k="dash">developer.spotify.com/dashboard</a> and create an app (Web API). 2) Add this exact Redirect URI: <code data-k="redir">http://127.0.0.1:43827/callback</code><button type="button" class="imp-copy" data-k="copy" title="Copy">${IC.copy}</button> 3) Paste the app's Client ID here and log in.</p>
        <label class="imp-field"><input type="text" data-k="client" placeholder="Client ID" spellcheck="false"></label>
        <div class="imp-row"><button type="button" class="btn outline" data-k="login">Log in with Spotify</button><button type="button" class="btn outline" data-k="logout" hidden>Disconnect</button><span class="imp-dim" data-k="login-status">Not connected</span></div>
        <div class="imp-checks">${check('likes2', 'Liked songs')}${check('pls2', 'Playlists')}</div>
        <div class="imp-warn">${IC.warn}<span>Uses your own Spotify app, so the app only sees what you allow. The login is stored in the app data folder.</span></div>
      </div>
      <div class="imp-error" data-k="err" hidden></div>
      <div class="imp-progress" data-k="prog" hidden><canvas></canvas><span data-k="prog-label">0 / 0</span></div>
      <div class="imp-status" data-k="status" hidden></div>
      <div class="imp-missing" data-k="missing" hidden></div>
      <div class="row-btns"><button class="btn outline" data-k="cancel">Cancel</button><button class="btn primary" data-k="go">${M.icon}<span data-k="go-text">${kind === 'link' ? 'Import' : M.title}</span></button></div>
    </div>`);
    m.classList.add('imp-modal');
    const $ = (k) => m.querySelector(`[data-k="${k}"]`);
    let mode = 'link'; let target = 'new'; let files = null; let done = null; let auth = null;
    const err = (t) => { $('err').hidden = !t; $('err').textContent = t || ''; };

    const setMode = (k) => {
      mode = k;
      m.querySelectorAll('.imp-modes button').forEach((b) => b.classList.toggle('active', b.dataset.mode === k));
      m.querySelectorAll('.imp-pane').forEach((p) => { p.hidden = p.dataset.mode !== k; });
      err('');
      if (!done) $('go').disabled = false;
      if (k === 'login') refreshAuth();
      if (k === 'web') refreshWeb();
    };
    m.querySelectorAll('.imp-modes button').forEach((b) => { b.onclick = () => !busyHere && setMode(b.dataset.mode); });

    const pls = (R.state.library.playlists || []).map((p) => [p.id, p.name]);
    dropdown($('target'), [['new', M.newLabel], ...pls], 'new', (v) => { target = v; });

    // export files
    if ($('pick')) {
      $('pick').onclick = () => $('files').click();
      $('files').onchange = async () => {
        const fl = [...$('files').files];
        $('file-info').textContent = fl.length ? fl.map((f) => f.name).join(', ') : 'No files selected';
        files = fl.length ? await readFiles(fl, kind) : null;
        $('file-sum').textContent = files ? `${R.plural(files.likes.length, 'liked song')} · ${R.plural(files.playlists.length, 'playlist')} (${files.playlists.reduce((n, p) => n + p.tracks.length, 0)} tracks)` : '';
      };
    }

    // spotify account
    const paintAuth = () => {
      if (!auth || !$('login-status')) return;
      $('login-status').textContent = auth.connected ? 'Connected' : 'Not connected';
      $('logout').hidden = !auth.connected;
      $('login').hidden = !!auth.connected;
      if (auth.clientId && !$('client').value) $('client').value = auth.clientId;
      $('login').disabled = !/^[a-f0-9]{32}$/i.test($('client').value.trim());
      if (auth.redirectUri) $('redir').textContent = auth.redirectUri;
    };
    async function refreshAuth() { try { auth = await R.call('imports.spotify_status'); paintAuth(); } catch (_) {} }
    if ($('client')) {
      $('client').oninput = paintAuth;
      $('dash').onclick = (e) => { e.preventDefault(); R.invoke('plugin:opener|open_url', { url: 'https://developer.spotify.com/dashboard' }).catch(() => {}); };
      $('copy').onclick = () => { navigator.clipboard.writeText($('redir').textContent).then(() => R.toast('Copied')).catch(() => {}); };
      $('login').onclick = async () => {
        err(''); $('login').disabled = true; $('login-status').textContent = 'Waiting for the browser…';
        try { auth = await R.call('imports.spotify_login', { clientId: $('client').value.trim() }); paintAuth(); R.toast('Spotify connected'); paintSettings(); } catch (e) { err(R.errText(e)); refreshAuth(); }
      };
      $('logout').onclick = async () => { auth = await R.call('imports.spotify_logout'); paintAuth(); paintSettings(); };
    }

    // spotify sign-in in noxx (Liked songs)
    let web = null;
    const paintWeb = () => {
      if (!web || !$('web-status')) return;
      $('web-status').textContent = webText(web);
      $('web-status').dataset.state = web.state || '';
      $('web-login').hidden = !!web.signedIn;
      $('web-login').textContent = web.state === 'expired' ? 'Sign in again' : 'Sign in to Spotify';
      $('web-logout').hidden = !web.signedIn;
    };
    // Shows what's saved at once, then asks Spotify whether it still works.
    async function refreshWeb() {
      try {
        web = await R.call('imports.spotify_web_status'); paintWeb();
        if (web.signedIn) { $('web-status').textContent = 'Checking your Spotify sign-in…'; web = await R.call('imports.spotify_web_status', { check: true }); paintWeb(); setWebState(web); }
      } catch (_) {}
    }
    if ($('web-login')) {
      $('web-login').onclick = async () => {
        err(''); $('web-login').disabled = true; $('web-status').textContent = 'Sign in in the Spotify window…';
        try { web = await R.call('imports.spotify_web_login'); paintWeb(); setWebState(web); R.toast(web.name ? `Signed in to Spotify as ${web.name}` : 'Signed in to Spotify'); } catch (e) { err(R.errText(e)); refreshWeb(); }
        $('web-login').disabled = false;
      };
      $('web-logout').onclick = async () => { web = await R.call('imports.spotify_web_logout'); paintWeb(); setWebState(web); };
    }

    // progress
    let bar = null; let base = 0; let grand = 0;
    const showProgress = (on) => {
      $('prog').hidden = !on;
      if (on && !bar) bar = wave($('prog').querySelector('canvas'));
      if (!on && bar) { bar.stop(); bar = null; }
    };
    const setProgress = (d, t, matched) => {
      const all = grand || t;
      if (bar) bar.set(all ? (base + d) / all : 0);
      $('prog-label').textContent = `${base + d} / ${all}${matched != null ? ` · ${matched} found` : ''}`;
    };

    let busyHere = false;
    const lock = (on) => {
      busyHere = on;
      m.querySelectorAll('input, .imp-modes button, .imp-dd-trigger, [data-k=pick], [data-k=login], [data-k=web-login], [data-k=web-logout]').forEach((x) => { x.disabled = on; });
      $('go').disabled = on;
      $('go-text').textContent = on ? 'Importing…' : (kind === 'link' ? 'Import' : M.title);
      $('cancel').textContent = on ? 'Stop' : 'Cancel';
    };

    const job = `imp-${Date.now()}`;
    async function runList(name, items, into) {
      progressFn = (p) => { if (p.job === job) setProgress(p.done, p.total, p.matched); };
      const r = await R.call('imports.run', { job, name, items, target: into, prefer: preferred() });
      base += items.length;
      return r;
    }

    async function go() {
      if (done) { finish(); return; }
      err('');
      $('status').hidden = true; $('missing').hidden = true;
      // Collect the lists to import: [{ name, items, into }]
      let lists = []; let label = '';
      lock(true);
      try {
        if (mode === 'link') {
          const url = $('url').value.trim();
          if (!url) throw new Error('Paste a link first.');
          $('status').hidden = false; $('status').textContent = 'Reading the playlist…';
          const r = await R.call('imports.fetch', { url });
          label = r.name;
          lists = [{ name: r.name, items: r.tracks, into: target }];
          $('status').textContent = `${r.name}: ${R.plural(r.tracks.length, 'track')}${r.partial ? ` (of ${r.total})` : ''}`;
          if (r.note) err(r.note);
        } else if (mode === 'file') {
          if (!files) throw new Error('Choose your export files first.');
          const wantL = $('likes').checked; const wantP = $('pls').checked;
          const src = kind === 'spotify' ? 'Spotify' : 'Apple Music';
          if (wantL && files.likes.length) lists.push({ name: `Liked songs (${src})`, items: files.likes, into: 'new' });
          if (wantP) lists.push(...files.playlists.map((p) => ({ name: p.name, items: p.tracks, into: 'new' })));
          if (!lists.length) throw new Error('Nothing to import from those files.');
          label = `${src} export`;
        } else if (mode === 'web') {
          if (!web || !web.signedIn) throw new Error('Sign in to Spotify first.');
          $('status').hidden = false; $('status').textContent = 'Reading your Liked songs…';
          let r;
          try { r = await R.call('imports.spotify_web_likes'); } catch (e) { refreshWeb(); throw e; }
          if (!r.likes.length) throw new Error('Your Liked songs on Spotify look empty.');
          $('status').textContent = `Liked songs: ${R.plural(r.likes.length, 'track')}${r.total > r.likes.length ? ` (of ${r.total})` : ''}`;
          lists.push({ name: 'Liked songs (Spotify)', items: r.likes, into: 'new' });
          label = 'your Spotify Liked songs';
        } else if (mode === 'login') {
          if (!auth || !auth.connected) throw new Error('Log in with Spotify first.');
          $('status').hidden = false; $('status').textContent = 'Reading your Spotify library…';
          const lib = await R.call('imports.spotify_library', { likes: $('likes2').checked, playlists: $('pls2').checked });
          if (lib.likes.length) lists.push({ name: 'Liked songs (Spotify)', items: lib.likes, into: 'new' });
          lists.push(...lib.playlists.filter((p) => p.tracks.length).map((p) => ({ name: p.name, items: p.tracks, into: 'new' })));
          if (lib.skipped.length) err(`Skipped ${R.plural(lib.skipped.length, 'playlist')} Spotify wouldn't share: ${lib.skipped.map((s) => s.name).join(', ')}`);
          if (!lists.length) throw new Error('Your Spotify library looks empty.');
          label = 'your Spotify library';
        }
        busy = { job, label };
        grand = lists.reduce((n, l) => n + l.items.length, 0); base = 0;
        showProgress(true); setProgress(0, grand, 0);
        const results = [];
        for (const l of lists) {
          if (stopped) break;
          if (lists.length > 1) { $('status').hidden = false; $('status').textContent = `Importing “${l.name}” (${results.length + 1} of ${lists.length})`; }
          const r = await runList(l.name, l.items, l.into);
          if (r.cancelled) break;
          results.push({ ...r, total: l.items.length });
        }
        done = results;
        report(results, lists.length);
      } catch (e) {
        err(R.errText(e));
        $('status').hidden = true;
      } finally {
        busy = null; progressFn = null; lock(false);
        if (stopped && !done) { showProgress(false); $('status').hidden = false; $('status').textContent = 'Stopped.'; }
        stopped = false;
      }
    }

    function report(results, nLists) {
      if (bar) bar.set(1);
      const matched = results.reduce((n, r) => n + r.matched, 0);
      const total = results.reduce((n, r) => n + r.total, 0);
      const missing = results.flatMap((r) => r.unmatched || []);
      const fails = results.reduce((n, r) => n + (r.errors || 0), 0);
      let msg = missing.length ? `Imported ${matched} tracks. ${missing.length} not found.` : `Imported all ${matched} tracks.`;
      if (nLists > 1) msg += ` ${R.plural(results.filter((r) => r.matched).length, 'playlist')} created.`;
      if (fails > missing.length / 2 && results.find((r) => r.commonError)) msg += ` Search error: ${results.find((r) => r.commonError).commonError}`;
      $('status').hidden = false; $('status').textContent = msg;
      $('status').classList.toggle('ok', matched > 0);
      if (missing.length) {
        $('missing').hidden = false;
        $('missing').innerHTML = `<button type="button" class="imp-missing-head">${IC.chev}<span>Not found (${missing.length})</span></button>
          <div class="imp-missing-list">${missing.slice(0, 300).map((t, i) => `<div class="imp-miss"><div class="imp-miss-t"><b>${esc(t.title)}</b><span>${esc(t.artist)}</span></div><button type="button" class="imp-copy" data-i="${i}" title="Search for it">${IC.search}</button></div>`).join('')}</div>`;
        $('missing').querySelector('.imp-missing-head').onclick = () => $('missing').classList.toggle('open');
        $('missing').querySelector('.imp-missing-list').onclick = (e) => {
          const b = e.target.closest('[data-i]'); if (!b) return;
          const t = missing[+b.dataset.i]; R.closeModal(); searchFor(`${t.artist} ${t.title}`);
        };
      }
      R.reloadLibrary();
      const first = results.find((r) => r.playlistId);
      $('go-text').textContent = first ? 'Open playlist' : 'Done';
      $('cancel').textContent = 'Close';
      if (!m.isConnected) R.toast(msg);
    }

    function finish() {
      const first = (done || []).find((r) => r.playlistId);
      R.closeModal();
      if (first) R.reloadLibrary().then(() => R.go('local', first.playlistId));
    }

    let stopped = false;
    $('cancel').onclick = () => {
      if (busyHere) { stopped = true; R.call('imports.cancel', { job }).catch(() => {}); $('cancel').disabled = true; setTimeout(() => { if ($('cancel')) $('cancel').disabled = false; }, 800); return; }
      R.closeModal();
    };
    $('go').onclick = go;
    if ($('url')) {
      $('url').onkeydown = (e) => { if (e.key === 'Enter') go(); };
      if (opts.url) $('url').value = opts.url;
      setTimeout(() => $('url').focus(), 50);
    }
    setMode(opts.mode || 'link');
    return m;
  }
  function check(k, label) {
    return `<label class="imp-check"><input type="checkbox" data-k="${k}" checked><span class="imp-box"></span>${label}</label>`;
  }

  function searchFor(q) {
    const input = document.querySelector('#search-input');
    if (!input) return;
    input.value = q;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  }

  // ------------------------------------------------------------ entry points

  R.on('render', ({ view }) => {
    if (view !== 'playlists') return;
    const actions = R.view.querySelector('.head-row .actions');
    if (!actions || actions.querySelector('.imp-open')) return;
    const b = document.createElement('button');
    b.className = 'btn outline imp-open';
    b.innerHTML = `${IC.link}Import`;
    b.onclick = (e) => {
      const r = b.getBoundingClientRect();
      R.showMenu([
        { label: 'From Spotify', run: () => open('spotify') },
        { label: 'From Apple Music', run: () => open('apple') },
        { label: 'From YouTube / YouTube Music', run: () => open('link', { platform: 'youtube' }) },
        { label: 'From SoundCloud', run: () => open('link', { platform: 'soundcloud' }) },
      ], r.left, r.bottom + 6);
      e.stopPropagation();
    };
    actions.prepend(b);
  });

  let settingsGroup = null;
  // ---------------------------------------------------------------- Spotify sign-in status
  // One place for "is Spotify signed in": the Integrations row, the import row and the dialog.
  // state: signed-in | signed-out | expired (Spotify refused it) | unknown (couldn't check).
  let webState = null;
  function webText(w) {
    if (!w) return 'Not signed in';
    if (w.state === 'expired') return 'Sign-in expired. Sign in again';
    if (!w.signedIn) return 'Not signed in';
    const who = w.name ? `Signed in as ${w.name}` : 'Signed in';
    return w.state === 'unknown' ? `${who} (couldn't reach Spotify to check)` : who;
  }
  function setWebState(w) { if (w) { webState = w; paintSettings(); } }
  async function checkWeb() {
    try { setWebState(await R.call('imports.spotify_web_status', { check: true })); } catch (_) {}
    return webState;
  }
  // A while after start: tell once if the saved sign-in stopped working.
  R.on('ready', () => { R.call('imports.spotify_web_status').then(setWebState).catch(() => {}); });
  R.on('ready', () => setTimeout(async () => {
    let w = null;
    try { w = await R.call('imports.spotify_web_status'); } catch (_) { return; }
    setWebState(w);
    if (!w.signedIn) return;
    w = await checkWeb();
    if (w && w.state === 'expired') R.toast('Your Spotify sign-in has expired. Sign in again in Settings → Integrations', 'error');
  }, 20000));

  // Top bar: a Spotify button next to SoundCloud's (same look), shown once you've signed in to
  // Spotify in noxx (or while that sign-in has expired). Click: Settings → Integrations.
  let spPill = null;
  function paintPill() {
    const w = webState;
    const show = !!w && (w.signedIn || w.state === 'expired');
    if (!spPill) {
      const sc = document.getElementById('account-pill');
      if (!sc || !show) return;
      spPill = R.el('<button type="button" class="account-pill sp-pill"></button>');
      spPill.addEventListener('click', () => R.openSettings('integrations'));
      sc.before(spPill);
    }
    spPill.hidden = !show;
    if (!show) return;
    const expired = w.state === 'expired';
    spPill.classList.toggle('warn', expired);
    spPill.innerHTML = `<span class="av sp-av" style="${!expired && w.avatar ? R.bg(w.avatar) : ''}">${!expired && w.avatar ? '' : IC.spotify}</span>${expired ? '<span class="ap-name">Reconnect</span>' : ''}`;
    spPill.title = expired ? 'Spotify sign-in expired. Click to sign in again'
      : w.state === 'unknown' ? `Spotify: ${w.name || 'signed in'} (couldn't reach Spotify to check)`
      : `Spotify: ${w.name || 'signed in'}`;
  }

  let accountRow = null;
  function paintSettings() {
    paintPill();
    if (accountRow && accountRow.isConnected) {
      const w = webState;
      accountRow.querySelector('[data-sp-acc-desc]').textContent = webText(w) + (w && w.signedIn ? ' · Liked songs can be imported' : '');
      accountRow.querySelector('[data-sp-acc-desc]').dataset.state = (w && w.state) || '';
      accountRow.querySelector('[data-sp-acc=in]').hidden = !!(w && w.signedIn);
      accountRow.querySelector('[data-sp-acc=in]').textContent = w && w.state === 'expired' ? 'Sign in again' : 'Sign in';
      accountRow.querySelector('[data-sp-acc=out]').hidden = !(w && w.signedIn);
    }
    if (!settingsGroup || !settingsGroup.isConnected) return;
    R.call('imports.spotify_status').then((s) => {
      const d = settingsGroup.querySelector('[data-imp-sp-desc]');
      if (!d) return;
      const w = webState;
      d.textContent = w && w.signedIn ? `${webText(w)}: playlists by link, plus your Liked songs`
        : s.connected ? 'Developer app connected: playlists import in full, plus your liked songs'
        : 'Playlists, albums and tracks by link, export files, or sign in for your Liked songs';
    }).catch(() => {});
  }
  R.addSettings(() => {
    const row = (k, icon, name, desc, extra = '') => `<div class="th-item setting-item imp-set"><div class="th-top"><div class="imp-set-l"><span class="imp-set-ic imp-${k}">${icon}</span><div class="th-col"><span class="th-name">${name}</span><span class="th-desc"${extra}>${desc}</span></div></div><button type="button" class="btn primary" data-imp="${k}">Import</button></div></div>`;
    R.add('<div class="section-title">Spotify account</div>');
    accountRow = R.add(`<div class="th-group"><div class="th-item setting-item imp-set"><div class="th-top"><div class="imp-set-l"><span class="imp-set-ic imp-spotify">${IC.spotify}</span><div class="th-col"><span class="th-name">Spotify</span><span class="th-desc imp-acc-desc" data-sp-acc-desc>Checking…</span></div></div>
      <div class="th-side"><button type="button" class="btn outline" data-sp-acc="out" hidden>Sign out</button><button type="button" class="btn primary" data-sp-acc="in" hidden>Sign in</button></div></div></div></div>`);
    accountRow.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-sp-acc]');
      if (!b) return;
      b.disabled = true;
      try {
        if (b.dataset.spAcc === 'in') {
          accountRow.querySelector('[data-sp-acc-desc]').textContent = 'Sign in in the Spotify window…';
          const w = await R.call('imports.spotify_web_login');
          setWebState(w);
          R.toast(w.name ? `Signed in to Spotify as ${w.name}` : 'Signed in to Spotify');
        } else if (await R.confirmBox('Sign out of Spotify', 'noxx forgets your Spotify sign-in. Playlists you already imported stay.', 'Sign out')) {
          setWebState(await R.call('imports.spotify_web_logout'));
        }
      } catch (err) { R.toast(R.errText(err), 'error'); checkWeb(); }
      b.disabled = false;
    });
    // Saved state at once, then the real check.
    R.call('imports.spotify_web_status').then((w) => { setWebState(w); if (w.signedIn) checkWeb(); }).catch(() => {});
    R.add('<div class="section-title">Import playlists</div>');
    settingsGroup = R.add(`<div class="th-group imp-group">
      ${row('spotify', IC.spotify, 'Spotify', 'Playlists, albums and tracks by link, export files or your account', ' data-imp-sp-desc')}
      ${row('youtube', IC.yt, 'YouTube', 'Import playlists from YouTube')}
      ${row('ytmusic', IC.ytm, 'YouTube Music', 'Import playlists from YouTube Music')}
      ${row('soundcloud', IC.sc, 'SoundCloud', 'Import any public SoundCloud playlist by link')}
      ${row('apple', IC.apple, 'Apple Music', 'Playlists and albums by link, or your privacy export files')}
    </div>`);
    settingsGroup.addEventListener('click', (e) => {
      const k = e.target.closest('[data-imp]')?.dataset.imp;
      if (k === 'spotify' || k === 'apple') open(k);
      else if (k) open('link', { platform: k });
    });
    paintSettings();
  }, 'integrations');

  R.imports = { open };

  // ------------------------------------------------------------ selftest

  R.addSelftest(async (log) => {
    const ok = (b) => (b ? 'OK' : 'FAILED');
    const now = () => performance.now();
    let t0 = now();
    let r;
    try { r = await R.call('imports.fetch', { url: 'https://open.spotify.com/album/4m2880jivSbbyEGAKfITCa' }); } catch (e) { log(`imports spotify fetch FAILED: ${R.errText(e)}`); return; }
    log(`imports spotify fetch ${ok(r.tracks.length >= 10 && r.tracks.every((t) => t.title && t.artist && t.duration > 0))}: "${r.name}" ${r.tracks.length} tracks in ${Math.round(now() - t0)}ms`);
    const items = r.tracks.slice(0, 5);
    let ticks = 0;
    const job = 'imp-selftest';
    progressFn = (p) => { if (p.job === job) ticks++; };
    t0 = now();
    const res = await R.call('imports.run', { job, name: 'noxx selftest import', items, prefer: 'soundcloud' });
    progressFn = null;
    log(`imports spotify match ${ok(res.matched >= 3 && res.playlistId && ticks >= items.length)}: ${res.matched}/${items.length} matched, ${ticks} progress events in ${Math.round(now() - t0)}ms; missing: ${res.unmatched.map((u) => u.title).join(', ') || '-'}`);
    const lib = await R.invoke('get_library');
    const pl = lib.playlists.find((p) => p.id === res.playlistId);
    log(`imports playlist saved ${ok(pl && pl.tracks.length === res.matched)}: ${pl ? pl.tracks.length : 0} tracks`);
    if (res.playlistId) { await R.invoke('playlist_delete', { id: res.playlistId }); await R.reloadLibrary(); }

    t0 = now();
    try {
      const a = await R.call('imports.fetch', { url: 'https://music.apple.com/us/album/random-access-memories/617154241' });
      log(`imports apple fetch ${ok(a.tracks.length >= 10)}: "${a.name}" ${a.tracks.length} tracks in ${Math.round(now() - t0)}ms`);
    } catch (e) { log(`imports apple fetch FAILED: ${R.errText(e)}`); }

    const parsed = { likes: [], playlists: [] };
    parseSpotifyExport({ playlists: [{ name: 'P', items: [{ track: { trackName: 'One More Time', artistName: 'Daft Punk' } }] }] }, parsed);
    parseSpotifyExport({ tracks: [{ track: 'Around the World', artist: 'Daft Punk' }] }, parsed);
    parseAppleCsv('Title,Artist,Playlist Name\n"Get Lucky","Daft Punk","Mix"\nOne,"U2",\n', parsed);
    log(`imports export parsers ${ok(parsed.playlists.length === 2 && parsed.likes.length === 2 && parsed.playlists[1].tracks[0].title === 'Get Lucky')}: ${parsed.likes.length} likes, ${parsed.playlists.length} playlists`);

    const m = open('spotify');
    const tabs = m.querySelectorAll('.imp-modes button').length;
    log(`imports modal ${ok(tabs === 3 && m.querySelector('[data-k=url]') && m.querySelector('.imp-dd'))}: ${tabs} tabs`);
    R.closeModal();
  });
})();
