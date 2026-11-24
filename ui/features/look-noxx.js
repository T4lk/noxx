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
  if (root.classList.contains('riff-android')) return; // the phone layout has its own shell (features/mobile.css)

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

  // Right panel: the artist cards join the Up next list, so the cover stays put and only that list scrolls.
  function nestCards() {
    const panel = document.getElementById('right-panel');
    const next = panel && panel.querySelector('.rp-next');
    const cards = panel && panel.querySelector('.np-cards');
    if (next && cards && cards.parentElement !== next) next.append(cards);
  }

  function sync() {
    const v = R.state.view;
    nestCards();
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
  { const rp = document.getElementById('right-panel'); if (rp) new MutationObserver(later).observe(rp, { childList: true, subtree: true }); }
  new MutationObserver(later).observe(root, { attributes: true, attributeFilter: ['class'] });
  sync();

  // Glass: how strong the blur behind the cards is and how see-through they are.
  const GLASS = { noxxBlur: { def: 24, min: 0, max: 40, unit: 'px', css: '--nx-blur', fmt: (v) => `${v}px` },
                  noxxGlass: { def: 84, min: 40, max: 100, unit: '%', css: '--nx-glass', fmt: (v) => `${v}%` },
                  noxxGlow: { def: 60, min: 0, max: 100, unit: '%', css: '--nx-glow', fmt: (v) => String(v / 100) },
                  noxxDim: { def: 0, min: 0, max: 90, unit: '%', css: '--nx-dim', fmt: (v) => String(v / 100) } };
  // A dark layer over the background (album glow, mesh, your image or video), under the cards.
  const dim = document.createElement('div');
  dim.className = 'nx-dim';
  document.body.append(dim);
  const glassVal = (k) => { const g = GLASS[k], v = Number(R.pref(k, g.def)); return Number.isFinite(v) ? Math.min(g.max, Math.max(g.min, Math.round(v))) : g.def; };
  // At 0 no blur layers exist at all (html.nx-noblur).
  const applyGlass = () => {
    for (const k in GLASS) root.style.setProperty(GLASS[k].css, GLASS[k].fmt(glassVal(k)));
    root.classList.toggle('nx-noblur', glassVal('noxxBlur') === 0);
  };
  applyGlass();

  R.addSettings(() => {
    const row = (k, name, desc, lo, hi) => {
      const g = GLASS[k], v = glassVal(k);
      return `<div class="th-item setting-item"><div class="th-top"><span class="th-name">${name}</span><span class="th-val" data-nx-val="${k}">${v}${g.unit}</span></div>
        <div class="th-sl" style="--v:${(v - g.min) / (g.max - g.min)}"><div class="th-sl-on"></div><div class="th-sl-off"></div>
        <input type="range" data-nx-glass="${k}" min="${g.min}" max="${g.max}" step="1" value="${v}" aria-label="${name}"></div>
        <div class="th-hints"><span>${lo}</span><span>${hi}</span></div><div class="th-desc">${desc}</div></div>`;
    };
    R.add('<div class="section-title">Background and glass</div>');
    const g = R.add(`<div class="th-group">${row('noxxBlur', 'Blur', 'Blurs what is behind the cards and the player. Turn it down if the app feels slow on your PC.', 'Off', 'Strong')}${row('noxxGlass', 'Card opacity', 'Lower lets more of the background show through the cards.', 'See-through', 'Solid')}${row('noxxGlow', 'Album glow', 'How bright the colour from the playing cover is behind the app. Turn the glow itself on or off in Banners > Cover background.', 'Off', 'Full')}${row('noxxDim', 'Darken background', 'Dims the glow, mesh or your own image or video so text stays easy to read. Pick an image or video in Banners > Background media.', 'None', 'Dark')}</div>`);
    g.addEventListener('input', (e) => {
      const i = e.target.closest('[data-nx-glass]');
      if (!i) return;
      const k = i.dataset.nxGlass, c = GLASS[k];
      R.setPref(k, Number(i.value));
      applyGlass();
      i.closest('.th-sl').style.setProperty('--v', String((glassVal(k) - c.min) / (c.max - c.min)));
      g.querySelector(`[data-nx-val="${k}"]`).textContent = `${glassVal(k)}${c.unit}`;
    });
  }, 'theme');

  // Performance mode also runs noxx without the GPU. That is decided when the app starts, so the
  // choice is saved for the next launch.
  const perfOn = () => !!R.pref('perfMode', false);
  let gpuSaved = null;
  const syncGpu = (say) => {
    const on = perfOn();
    if (on === gpuSaved) return;
    gpuSaved = on;
    R.call('system.set', { key: 'noGpu', value: on })
      .then(() => { if (say) R.toast(on ? 'Performance mode: the GPU is off after you restart noxx' : 'The GPU is back on after you restart noxx'); })
      .catch((e) => R.log('warn', `gpu setting: ${R.errText(e)}`));
  };
  R.call('system.settings').then((st) => { gpuSaved = !!st.noGpu; syncGpu(false); }).catch(() => {});
  R.on('pref', (p) => { if (p && p.key === 'perfMode') syncGpu(true); });

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
