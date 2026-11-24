// Noxx look: the markup its layouts need beyond CSS (features/look-noxx.css).
// Two layouts, picked in Settings > Theme > Layout:
//   minimal  four-item side bar (Home, Discover, Library, Downloads + Settings), Likes / Playlists /
//            History / My files become tabs of one Library page, slim top bar and player
//   full     every page in the side bar, back / forward, source chips on Home
// Everything here is inert in the other looks: the CSS only shows it under html.th-noxx.
(() => {
  const R = window.riff;
  const root = document.documentElement;
  const rail = document.querySelector('.rail');
  const view = document.getElementById('view');
  if (!R || !rail || !view) return;

  const layout = () => (R.pref('noxxLayout', 'minimal') === 'full' ? 'full' : 'minimal');
  const applyLayout = () => root.classList.toggle('nx-min', layout() === 'minimal');
  applyLayout();
  const minimal = () => root.classList.contains('th-noxx') && root.classList.contains('nx-min');

  const TABS = [['likes', 'Songs'], ['playlists', 'Playlists'], ['history', 'History'], ['files', 'My files']];
  const NAV_OF = { sc: 'playlists', local: 'playlists' }; // an opened playlist sits under Playlists
  const tabOf = (v) => NAV_OF[v] || v;
  const inLibrary = (v) => TABS.some(([t]) => t === tabOf(v));
  let lastTab = 'likes';

  const lib = document.createElement('button');
  lib.className = 'nav-item nx-lib';
  lib.title = 'Library';
  lib.innerHTML = '<span class="nav-ind nav-indicator"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4v16M10 4v16M15 4l4 16"/></svg></span><span class="nav-label">Library</span>';
  lib.addEventListener('click', () => R.go(lastTab));

  function placeLib() {
    const after = rail.querySelector('.nav-item[data-view="discover"]') || rail.querySelector('.nav-item[data-view="home"]');
    if (after && after.nextElementSibling !== lib) after.after(lib);
  }

  function greeting() {
    const h = new Date().getHours();
    return h < 5 ? 'Good night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  }

  function sync() {
    const v = R.state.view;
    placeLib();
    lib.classList.toggle('active', inLibrary(v));
    if (inLibrary(v)) lastTab = tabOf(v);
    const tabs = view.querySelector(':scope > .nx-tabs');
    const wantTabs = minimal() && TABS.some(([t]) => t === v);
    if (tabs && !wantTabs) tabs.remove();
    if (wantTabs && !tabs) {
      const bar = document.createElement('div');
      bar.className = 'nx-tabs';
      bar.setAttribute('role', 'tablist');
      bar.innerHTML = TABS.map(([t, label]) =>
        `<button type="button" role="tab" class="nx-tab${t === v ? ' active' : ''}" aria-selected="${t === v}" data-nx-tab="${t}">${label}</button>`).join('');
      bar.addEventListener('click', (e) => { const b = e.target.closest('[data-nx-tab]'); if (b && b.dataset.nxTab !== R.state.view) R.go(b.dataset.nxTab); });
      view.prepend(bar);
    }
    if (v === 'home') {
      const top = view.querySelector('.hm-top');
      if (top && !top.querySelector('.nx-greet')) {
        const h = document.createElement('h1');
        h.className = 'nx-greet';
        h.textContent = greeting();
        top.prepend(h);
      }
    }
  }

  let queued = false;
  const later = () => { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; sync(); }); };
  new MutationObserver(later).observe(view, { childList: true, subtree: true });
  new MutationObserver(later).observe(rail, { childList: true });
  new MutationObserver(later).observe(root, { attributes: true, attributeFilter: ['class'] });
  sync();

  // Settings > Theme > Layout
  R.addSettings(() => {
    const cur = layout();
    const opt = (v, label) => `<button type="button" class="th-seg-btn${cur === v ? ' active' : ''}" data-nx-layout="${v}">${label}</button>`;
    const g = R.add(`<div class="th-group"><div class="th-item setting-item"><div class="th-top"><span class="th-name">Layout</span></div>
      <div class="th-seg">${opt('minimal', 'Minimal')}${opt('full', 'Full')}</div>
      <div class="th-desc">Minimal: a short side bar with one Library page. Full: every page in the side bar.</div></div></div>`);
    g.addEventListener('click', (e) => {
      const b = e.target.closest('[data-nx-layout]');
      if (!b) return;
      R.setPref('noxxLayout', b.dataset.nxLayout);
      applyLayout();
      g.querySelectorAll('[data-nx-layout]').forEach((x) => x.classList.toggle('active', x === b));
      later();
    });
  }, 'theme');
})();
