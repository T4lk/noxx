// Update check: on start (once a day at most) and from Settings > About, asks GitHub for the
// newest noxx release. If it's newer than this build, a dialog offers the download for this
// platform (Windows installer, Linux AppImage, Android APK); the browser does the download.
(() => {
  const R = window.riff;
  if (!R) return;
  const API = 'https://api.github.com/repos/T4lk/noxx/releases/latest';
  const PAGE = 'https://github.com/T4lk/noxx/releases/latest';
  const DAY = 24 * 60 * 60 * 1000;
  let info = null; // { version, os }

  const parse = (v) => String(v || '').replace(/^v/i, '').split(/[.+-]/).slice(0, 3).map((n) => parseInt(n, 10) || 0);
  const newer = (a, b) => { const x = parse(a), y = parse(b); for (let i = 0; i < 3; i++) { if (x[i] !== y[i]) return x[i] > y[i]; } return false; };
  const openUrl = (url) => R.invoke('plugin:opener|open_url', { url }).catch(() => R.toast("Couldn't open the link", 'error'));

  async function appInfo() {
    if (!info) info = await R.call('about.info');
    return info;
  }

  function assetFor(rel, os) {
    const assets = rel.assets || [];
    const want = os === 'android' ? /\.apk$/i : os === 'linux' ? /\.AppImage$/i : os === 'windows' ? /setup\.exe$/i : null;
    return want ? assets.find((a) => want.test(a.name)) : null;
  }

  /** Returns { latest, current, url } when a newer release exists, null when up to date. */
  async function check() {
    const me = await appInfo();
    const r = await fetch(API, { headers: { Accept: 'application/vnd.github+json' } });
    if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
    const rel = await r.json();
    R.store('updates.lastCheck', Date.now());
    if (!newer(rel.tag_name, me.version)) return null;
    const a = assetFor(rel, me.os);
    return { latest: String(rel.tag_name).replace(/^v/i, ''), current: me.version, url: a ? a.browser_download_url : rel.html_url || PAGE, direct: !!a };
  }

  function offer(u) {
    const m = R.openModal(`<h3>noxx ${R.esc(u.latest)} is out</h3>
      <p>You have ${R.esc(u.current)}. ${u.direct ? 'Download the update, then open it to install.' : 'Open the release page to get it.'}</p>
      <div class="row-btns">
        <button class="btn outline" data-k="notes">What's new</button>
        <button class="btn outline" data-k="later">Later</button>
        <button class="btn primary" data-k="get">${u.direct ? 'Download' : 'Open page'}</button>
      </div>`);
    m.querySelector('[data-k=later]').onclick = () => { R.store('updates.skip', u.latest); R.closeModal(); };
    m.querySelector('[data-k=notes]').onclick = () => openUrl(`https://github.com/T4lk/noxx/releases/tag/v${u.latest}`);
    m.querySelector('[data-k=get]').onclick = () => { openUrl(u.url); R.closeModal(); };
  }

  async function autoCheck() {
    if (R.load('updates.auto', true) === false) return;
    if (Date.now() - Number(R.load('updates.lastCheck', 0)) < DAY) return;
    try {
      const u = await check();
      if (u && R.load('updates.skip', '') !== u.latest) offer(u);
    } catch (e) { /* offline or rate-limited: try again next start */ }
  }

  R.on('ready', () => setTimeout(autoCheck, 8000));

  R.addSettings(() => {
    const g = R.add(`<div class="th-group">
      <div class="th-item setting-item"><div class="th-top">
        <div class="th-col"><span class="th-name">Updates</span><span class="th-desc" data-upd-msg>Checks GitHub for a newer noxx once a day</span></div>
        <div class="th-side"><button class="btn outline set-btn" data-upd-check style="white-space:nowrap">Check now</button><span data-upd-sw></span></div>
      </div></div></div>`);
    const msg = g.querySelector('[data-upd-msg]');
    g.querySelector('[data-upd-sw]').replaceWith(R.switch(R.load('updates.auto', true) !== false, (on) => R.store('updates.auto', on), { label: 'Check for updates on start' }));
    g.querySelector('[data-upd-check]').onclick = async (e) => {
      const b = e.currentTarget;
      b.disabled = true;
      msg.textContent = 'Checking…';
      try {
        const u = await check();
        if (u) { msg.textContent = `noxx ${u.latest} is available`; offer(u); }
        else msg.textContent = `You're up to date (${(await appInfo()).version})`;
      } catch (err) {
        msg.textContent = `Couldn't check: ${R.errText(err)}`;
      }
      b.disabled = false;
    };
  }, 'about');
})();
