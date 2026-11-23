'use strict';

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const appWindow = window.__TAURI__.window.getCurrentWindow();
const $ = (s) => document.querySelector(s);
const ROW_H = 68; // 64px row + 4px gap, like riff's track list
const log = (level, message) => invoke('log_js', { level, message: String(message) }).catch(() => {});
window.addEventListener('error', (e) => log('error', `${e.message} @ ${e.filename}:${e.lineno}`));
window.addEventListener('unhandledrejection', (e) => log('error', errText(e.reason)));

const svg = (body, filled) => filled
  ? `<svg viewBox="0 0 24 24" fill="currentColor">${body}</svg>`
  : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const ICON = {
  heart: svg('<path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78L12 21.23l8.84-8.84a5.5 5.5 0 0 0 0-7.78z"/>'),
  heartFill: svg('<path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78L12 21.23l8.84-8.84a5.5 5.5 0 0 0 0-7.78z"/>', true),
  queue: svg('<line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="14" y2="12"/><line x1="4" y1="18" x2="11" y2="18"/><line x1="18" y1="14" x2="18" y2="22"/><line x1="14" y1="18" x2="22" y2="18"/>'),
  more: svg('<circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/>', true),
  close: svg('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>'),
  play: svg('<path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.6-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/>', true),
  pause: svg('<rect x="6" y="5" width="4" height="14" rx="1.2"/><rect x="14" y="5" width="4" height="14" rx="1.2"/>', true),
  shuffle: svg('<polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/>'),
  sync: svg('<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>'),
  cloud: svg('<path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/>'),
  music: svg('<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>'),
  plus: svg('<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>'),
  home: svg('<path d="M3 9.5 12 3l9 6.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>'),
  fire: svg('<path d="M12 2c1 4 5 5.5 5 10a5 5 0 0 1-10 0c0-2 1-3.5 2-4.5.3 2 1.5 3 2.5 3-1-3 0-6 .5-8.5z"/>'),
  user: svg('<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>'),
};

// ---------------------------------------------------------------- extension API (see ui/features/README.md)

const bus = new EventTarget();
function emit(name, detail) { bus.dispatchEvent(new CustomEvent(name, { detail })); }
const ext = {
  views: {},             // name -> { render(token, arg), title, icon, nav }
  trackMenu: [],         // fn(track, opts) -> items[]
  listTools: [],         // { mount(toolsEl, ctx, refresh), transform(ctx, tracks) -> tracks }
  settings: [],          // { fn(paneEl), cat } — see riff.addSettings
  streamResolvers: [],   // async fn(track, fresh) -> {url, protocol:'progressive'|'hls'|'file'} | null
  selftests: [],         // async fn(log)
  continuations: [],     // async fn(seeds, avoidIds) -> tracks: what to play when the queue runs out
};

// Persisted UI preferences (riff's settings toggles): riff.pref(key, default) / riff.setPref(key, value).
const prefs = (() => { try { return JSON.parse(localStorage.getItem('prefs')) || {}; } catch (e) { return {}; } })();
function pref(key, fallback) { return Object.prototype.hasOwnProperty.call(prefs, key) ? prefs[key] : fallback; }
function setPref(key, value) {
  prefs[key] = value;
  try { localStorage.setItem('prefs', JSON.stringify(prefs)); } catch (e) {}
  emit('pref', { key, value });
}

// ---------------------------------------------------------------- helpers

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmt(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
function totalTime(tracks) {
  const sec = tracks.reduce((a, t) => a + (t.duration || 0), 0);
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
}
// Smaller artwork for rows / cards (SoundCloud sizes, YouTube thumbnails, YouTube Music art).
function small(art) {
  if (!art) return '';
  return art.replace('-t500x500.', '-large.').replace(/(i\.ytimg\.com\/vi\/[^/]+\/)hq720\.jpg.*$/, '$1mqdefault.jpg').replace(/=w\d+-h\d+/, '=w120-h120');
}
function mid(art) {
  if (!art) return '';
  return art.replace('-t500x500.', '-t300x300.').replace(/(i\.ytimg\.com\/vi\/[^/]+\/)hq720\.jpg.*$/, '$1hqdefault.jpg').replace(/=w\d+-h\d+/, '=w300-h300');
}
function bg(url) { return url ? `background-image:url('${esc(url)}')` : ''; }
function store(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {} }
function load(key, fallback) { try { const v = JSON.parse(localStorage.getItem(key)); return v ?? fallback; } catch (e) { return fallback; } }
function errText(e) { return typeof e === 'string' ? e : (e && e.message) || 'Something went wrong'; }
function plural(n, word) { return `${n} ${word}${n === 1 ? '' : 's'}`; }

function toast(text, kind) {
  const box = $('#toasts');
  const ms = kind === 'error' ? 5000 : 3000;
  // The same message again while it's still showing: keep one and restart its timer instead of stacking copies.
  const same = [...box.children].find((n) => n.textContent === text && !n.dataset.leaving);
  if (same) { clearTimeout(same._t); same._t = setTimeout(() => same.remove(), ms); return; }
  const el = document.createElement('div');
  el.className = 'toast' + (kind === 'error' ? ' error' : '');
  el.textContent = text;
  box.append(el);
  el._t = setTimeout(() => el.remove(), ms);
}

/** SoundCloud artwork at the smallest size that is still sharp at `px` CSS pixels (other URLs pass through). */
function art(url, px) {
  if (!url) return '';
  const need = px * (window.devicePixelRatio || 1) * (document.body ? document.body.currentCSSZoom || 1 : 1);
  const size = need <= 100 ? 'large' : need <= 300 ? 't300x300' : 't500x500';
  return url.replace(/-(t500x500|t300x300|large)\.(jpg|jpeg|png|webp)/i, `-${size}.$2`);
}

// ---------------------------------------------------------------- switch (riff's effect-switch-btn)

const SW_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path class="sw-icon"/></svg>';
const SW_THUMB = `<span class="thumb">${SW_ICON}</span>`;
function switchHtml(on, attrs = '') {
  return `<button type="button" class="switch${on ? ' active' : ''}" role="switch" aria-checked="${!!on}" ${attrs}>${SW_THUMB}</button>`;
}
function setSwitch(btn, on) {
  btn.classList.toggle('active', !!on);
  btn.setAttribute('aria-checked', String(!!on));
}
/** A ready switch button: click flips it and calls onChange(on, btn). `btn.checked` reads/sets it. */
function makeSwitch(checked, onChange, opts = {}) {
  const b = el(switchHtml(checked, opts.label ? `aria-label="${esc(opts.label)}" title="${esc(opts.label)}"` : ''));
  b.addEventListener('click', () => {
    const on = !b.classList.contains('active');
    setSwitch(b, on);
    if (onChange) onChange(on, b);
  });
  Object.defineProperty(b, 'checked', { get: () => b.classList.contains('active'), set: (v) => setSwitch(b, v) });
  return b;
}
// Switches written as plain markup (<span class="thumb"></span>) get riff's x / check icon.
let swDecorate = 0;
new MutationObserver(() => {
  if (swDecorate) return;
  swDecorate = requestAnimationFrame(() => {
    swDecorate = 0;
    document.querySelectorAll('.switch > .thumb:empty').forEach((t) => { t.innerHTML = SW_ICON; });
  });
}).observe(document.documentElement, { childList: true, subtree: true });

// ---------------------------------------------------------------- motion: frame pacing + sleeping while hidden

// Like riff, drawing loops run on capped frame slots: 60 fps while the user drags or hovers, 30 fps for
// ambient playback animation, 15 fps when another window has focus. While the window is minimized or
// hidden nothing animates: CSS animations are paused and requestAnimationFrame callbacks are parked
// until it comes back (WebView2 keeps rendering a minimized window otherwise).
const FPS_ACTIVE = 60, FPS_PLAYING = 30, FPS_UNFOCUSED = 15;
const motion = { minimized: false, focused: document.hasFocus(), asleep: false, perf: false };
// Performance mode (riff) caps every loop at 30 fps.
const slotMs = (fps) => 1000 / Math.min(motion.perf ? 30 : fps, motion.focused ? fps : FPS_UNFOCUSED);
/**
 * Runs cb(now) once, on the first display frame of the next frame slot at `fps` (call it again from cb
 * to keep a loop going). Sleeps in a timer between slots instead of waking up on every display refresh.
 */
function nextFrame(cb, fps = FPS_PLAYING) {
  const ms = slotMs(fps);
  const slot = Math.floor(performance.now() / ms);
  const wait = (slot + 1) * ms - performance.now();
  const onFrame = (now) => {
    if (Math.floor(now / ms) <= slot) requestAnimationFrame(onFrame); // vsync landed just before the boundary
    else cb(now);
  };
  return setTimeout(() => requestAnimationFrame(onFrame), Math.max(0, wait - 4));
}

const nativeRaf = window.requestAnimationFrame.bind(window);
const nativeCancelRaf = window.cancelAnimationFrame.bind(window);
const parkedFrames = new Map();
let parkedId = 0;
window.requestAnimationFrame = (cb) => {
  if (!motion.asleep) return nativeRaf(cb);
  const id = -(++parkedId);
  parkedFrames.set(id, cb);
  return id;
};
window.cancelAnimationFrame = (id) => { if (id < 0) parkedFrames.delete(id); else nativeCancelRaf(id); };

function syncSleep() {
  const asleep = document.hidden || motion.minimized;
  if (asleep === motion.asleep) return;
  motion.asleep = asleep;
  document.documentElement.classList.toggle('riff-asleep', asleep);
  if (!asleep) {
    const cbs = [...parkedFrames.values()];
    parkedFrames.clear();
    cbs.forEach((cb) => nativeRaf(cb));
    kickAnim();
  }
  emit('visibility', { asleep });
}
document.addEventListener('visibilitychange', syncSleep);
async function syncMinimized() {
  try { motion.minimized = await appWindow.isMinimized(); } catch (e) { motion.minimized = false; }
  syncSleep();
}
appWindow.onResized(syncMinimized).catch(() => {});
appWindow.onFocusChanged((e) => { motion.focused = !!e.payload; if (motion.focused) syncMinimized(); }).catch(() => {});
window.addEventListener('focus', () => { motion.focused = true; });
window.addEventListener('blur', () => { motion.focused = false; });

// ---------------------------------------------------------------- ripples (riff's press feedback)

const RIPPLE_SEL = '.btn, .pill-btn, .ctrl-btn, .play-btn, .nav-item, .tile, .card, .track-row, .platform-btn, .win-btn, .mini-row, .menu button, .th-seg-btn, .ly-tab';
document.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  let target = e.target.closest(RIPPLE_SEL);
  if (!target || target.disabled) return;
  if (target.classList.contains('nav-item')) target = target.querySelector('.nav-ind') || target;
  let host = target.querySelector(':scope > .ripple-host');
  if (!host) {
    if (getComputedStyle(target).position === 'static') target.style.position = 'relative';
    host = document.createElement('span');
    host.className = 'ripple-host';
    target.append(host);
  }
  const r = target.getBoundingClientRect();
  const z = uiZoom();
  const size = Math.hypot(Math.max(e.clientX - r.left, r.right - e.clientX), Math.max(e.clientY - r.top, r.bottom - e.clientY)) * 2 / z;
  const d = document.createElement('span');
  d.className = 'ripple';
  d.style.cssText = `width:${size}px;height:${size}px;left:${(e.clientX - r.left) / z - size / 2}px;top:${(e.clientY - r.top) / z - size / 2}px`;
  d.addEventListener('animationend', () => d.remove());
  host.append(d);
}, true);

// ---------------------------------------------------------------- window controls

// Linux desktop (WebKitGTK; Android's WebView doesn't say "X11"). It's far slower than
// WebView2 at blur and full-window animation, so Performance mode starts on there.
const IS_WEBKITGTK = /X11; Linux/.test(navigator.userAgent);
$('#win-min').onclick = () => appWindow.minimize();
$('#win-max').onclick = () => appWindow.toggleMaximize();
$('#win-close').onclick = () => appWindow.close();
// Windows only: elsewhere Tauri's drag region already maximizes on double-click.
if (/Windows/.test(navigator.userAgent)) document.querySelectorAll('.titlebar, .top-nav').forEach((bar) => bar.addEventListener('dblclick', (e) => { if (e.target.hasAttribute('data-tauri-drag-region')) appWindow.toggleMaximize(); }));

// The UI is drawn at riff's 0.9 zoom (--app-zoom on <body>). Pointer/rect coordinates are screen
// pixels; lengths set from script are in zoomed CSS pixels, so divide by this when mixing them.
const uiZoom = () => document.body.currentCSSZoom || 1;
// Canvas backing pixels per CSS pixel (device pixels after the zoom).
const canvasScale = () => (window.devicePixelRatio || 1) * uiZoom();

// ---------------------------------------------------------------- state

const state = {
  view: 'home',
  arg: null,
  status: { loggedIn: false },
  library: { favorites: [], playlists: [] },
  favIds: new Set(),
  scPlaylists: [],
  scCache: new Map(),
  trending: null,
  search: { query: '', results: [], offset: 0, done: false, loading: false, token: 0 },
};

function setBadge(id, n) {
  const el = $(id);
  el.hidden = !n;
  el.textContent = n > 999 ? '999+' : String(n);
}

// Rail badges only flag something new: likes that arrived since you last opened Likes.
let newLikes = load('newLikes', 0);
function bumpNewLikes(n) {
  if (state.view === 'likes') n = 0; else n = newLikes + n;
  newLikes = n;
  store('newLikes', n);
  setBadge('#badge-likes', n);
}

function setLibrary(lib) {
  state.library = lib;
  state.favIds = new Set(lib.favorites.map((t) => t.id));
  setBadge('#badge-likes', newLikes);
  setBadge('#badge-playlists', 0);
  emit('library', lib);
}

// ---------------------------------------------------------------- side bar: labels, groups, distinct icons

const RAIL_GROUPS = [['home', 'discover'], ['likes', 'playlists', 'history', 'downloads', 'files'], ['queue', 'settings']];
const RAIL_ICONS = {
  home: svg('<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>'),
  discover: svg('<circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/>'),
  playlists: svg('<line x1="3" y1="6" x2="15" y2="6"/><line x1="3" y1="11" x2="15" y2="11"/><line x1="3" y1="16" x2="10" y2="16"/><path d="M19 7v9.5"/><circle cx="16.5" cy="17" r="2.5"/>'),
};
// One top panel that mirrors the player bar: logo on the left, search in the middle,
// account and window buttons on the right (the old thin title strip is folded into it).
function buildTopPanel() {
  const nav = $('.top-nav'), bar = $('.titlebar');
  if (!nav || !bar || nav.classList.contains('top-panel')) return;
  const brand = bar.querySelector('.brand'), btns = bar.querySelector('.win-btns');
  if (brand) nav.prepend(brand);
  if (btns) $('.nav-right').append(btns);
  bar.hidden = true;
  nav.classList.add('top-panel');
  buildHistoryButtons(nav);
  fitSearchBox();
}

function organizeRail() {
  const rail = $('.rail');
  const items = new Map([...rail.querySelectorAll('.nav-item')].map((b) => [b.dataset.view, b]));
  rail.querySelectorAll('.rail-divider').forEach((d) => d.remove());
  const placed = new Set();
  RAIL_GROUPS.forEach((group, gi) => {
    if (gi) rail.append(el('<div class="rail-divider"></div>'));
    for (const v of group) { const b = items.get(v); if (b) { rail.append(b); placed.add(v); } }
  });
  // Views a feature added that aren't in a group go just before Queue.
  for (const [v, b] of items) if (!placed.has(v)) items.get('queue')?.before(b);
  for (const [v, b] of items) {
    const ind = b.querySelector('.nav-ind');
    if (RAIL_ICONS[v]) { const badge = ind.querySelector('.nav-badge'); ind.innerHTML = RAIL_ICONS[v]; if (badge) ind.append(badge); }
    if (!b.querySelector('.nav-label')) b.append(el(`<span class="nav-label">${esc(b.title || v)}</span>`));
  }
  rail.classList.add('labelled');
  buildRailLibrary(rail);
  updateNavIndicator(false);
}

// ---------------------------------------------------------------- navigation history (Back / Forward)
// A real history over go(view, arg): Back / Forward buttons, mouse buttons 4 / 5, Alt+Left / Alt+Right.
// Each entry keeps the page's scroll so going back lands where you were.
const navHist = { list: [], pos: -1, moving: false };
let histScroll = 0;
function histPush(v, arg) {
  if (navHist.moving) return;
  const cur = navHist.list[navHist.pos];
  if (cur && cur.v === v && cur.arg === arg) return;
  if (cur) cur.scroll = view.scrollTop;
  navHist.list.splice(navHist.pos + 1);
  navHist.list.push({ v, arg, scroll: 0 });
  if (navHist.list.length > 100) navHist.list.shift();
  navHist.pos = navHist.list.length - 1;
  updateHistButtons();
}
/** step -1 = back, 1 = forward. Returns false when there is nowhere to go. */
function navHistory(step) {
  const target = navHist.list[navHist.pos + step];
  if (!target) return false;
  const cur = navHist.list[navHist.pos];
  if (cur) cur.scroll = view.scrollTop;
  navHist.pos += step;
  navHist.moving = true;
  histScroll = target.scroll || 0;
  try { go(target.v, target.arg); } finally { navHist.moving = false; }
  updateHistButtons();
  return true;
}
function updateHistButtons() {
  const b = $('#nav-back'), f = $('#nav-fwd');
  if (b) b.disabled = navHist.pos <= 0;
  if (f) f.disabled = navHist.pos >= navHist.list.length - 1;
}
const CHEVRON_L = svg('<polyline points="15 18 9 12 15 6"/>'), CHEVRON_R = svg('<polyline points="9 18 15 12 9 6"/>');
function buildHistoryButtons(nav) {
  if ($('.nav-history')) return;
  const box = el(`<div class="nav-history">
    <button class="hist-btn" id="nav-back" title="Back (Alt+←)" aria-label="Back" disabled>${CHEVRON_L}</button>
    <button class="hist-btn" id="nav-fwd" title="Forward (Alt+→)" aria-label="Forward" disabled>${CHEVRON_R}</button></div>`);
  const brand = nav.querySelector('.brand');
  if (brand) brand.after(box); else nav.prepend(box);
  box.querySelector('#nav-back').onclick = () => navHistory(-1);
  box.querySelector('#nav-fwd').onclick = () => navHistory(1);
  // Round Home button just left of the search field (it rides along with the search box's position).
  const home = el(`<button class="top-home" id="nav-home" title="Home" aria-label="Home">${RAIL_ICONS.home}</button>`);
  home.addEventListener('mousedown', (e) => e.preventDefault()); // don't light up the search field
  home.onclick = () => go('home');
  $('.search-box').append(home);
  updateHistButtons();
}
// Mouse buttons 4 / 5 (button 3 / 4). mousedown is cancelled too so WebView2 doesn't act on them itself.
window.addEventListener('mousedown', (e) => { if (e.button === 3 || e.button === 4) e.preventDefault(); });
window.addEventListener('mouseup', (e) => {
  if (e.button !== 3 && e.button !== 4) return;
  e.preventDefault();
  navHistory(e.button === 3 ? -1 : 1);
});

// ---------------------------------------------------------------- side bar: drag wider into "Your Library", pins
// Drag the side bar's right edge: below ~120px it folds to icons, the labelled bar (default) in the middle,
// and past ~240px it opens "Your Library" (280-380px): nav on top, every playlist / mix underneath.
// Double-click the edge to toggle. Width and pins are prefs (railWidth, railWideWidth, railPins, railSort).
const RAIL_W = { icons: 80, normal: 184, wideMin: 280, wideMax: 380 };
const LIB_SORTS = [['recent', 'Recents'], ['alpha', 'Alphabetical'], ['creator', 'Creator']];
const PIN_ICON = svg('<path d="M12 17v5"/><path d="M9 10.76V6h6v4.76a2 2 0 0 0 1.11 1.79l1.78.9A2 2 0 0 1 19 15.24V16H5v-.76a2 2 0 0 1 1.11-1.79l1.78-.9A2 2 0 0 0 9 10.76z"/><path d="M8 2h8"/>');
const railLib = { mode: 'normal', px: RAIL_W.normal, filter: '', mixes: [], mixesAt: 0, el: null, introTimer: 0 };
function railModeFor(w) { return w < 120 ? 'icons' : w < 240 ? 'normal' : 'wide'; }
function railPx(w) {
  const m = railModeFor(w);
  return m === 'icons' ? RAIL_W.icons : m === 'normal' ? RAIL_W.normal : Math.round(Math.max(RAIL_W.wideMin, Math.min(RAIL_W.wideMax, w)));
}
/** Sets the side bar width (snapped to its three modes); save stores it as the railWidth pref. */
function setRailWidth(w, save) {
  const px = railPx(Number(w) || RAIL_W.normal), mode = railModeFor(px);
  const rail = $('.rail'), layout = $('.app-layout');
  layout.classList.add('rail-sized');
  document.documentElement.style.setProperty('--rail-w', px + 'px'); // the top bar lines up with it too
  const changed = mode !== railLib.mode;
  railLib.mode = mode; railLib.px = px;
  rail.classList.toggle('rail-wide', mode === 'wide');
  rail.classList.toggle('rail-icons', mode === 'icons');
  document.body.classList.toggle('sidebar-expanded', mode === 'wide');
  document.body.classList.toggle('sidebar-icons', mode === 'icons');
  if (changed) { renderRailLib(true); if (mode === 'wide') loadRailMixes(); }
  if (save) { setPref('railWidth', px); if (mode === 'wide') setPref('railWideWidth', px); }
  requestAnimationFrame(() => updateNavIndicator(false));
  return mode;
}
function toggleRailWide() {
  return setRailWidth(railLib.mode === 'wide' ? RAIL_W.normal : pref('railWideWidth', 320), true);
}
// Docked layout (default): side bar and player bar flush on one panel colour, the page carved out
// of them with concave corners. Off = the older floating cards.
function applyShellPrefs() {
  document.body.classList.toggle('docked', !!pref('dockedShell', true));
  requestAnimationFrame(() => { updateNavIndicator(false); fitSearchBox(); redrawLists(); });
}
// Your Library filter chips (one at a time, click again to clear).
const LIB_CHIPS = [['playlists', 'Playlists', (it) => it.kind !== 'mix'], ['mine', 'By you', (it) => it.kind === 'local' || it.kind === 'likes'],
  ['sc', 'SoundCloud', (it) => it.kind === 'sc'], ['mixes', 'Mixes', (it) => it.kind === 'mix']];

function railPins() { const p = pref('railPins', []); return Array.isArray(p) ? p : []; }
function isPinned(key) { return railPins().includes(key); }
function togglePin(key, on = !isPinned(key)) {
  const pins = railPins().filter((k) => k !== key);
  if (on) pins.push(key);
  setPref('railPins', pins);
  renderRailLib();
  return on;
}
function pinMenuItem(key) { return { label: isPinned(key) ? 'Unpin from side bar' : 'Pin to side bar', run: () => togglePin(key) }; }

// Last time each list was opened, for the "Recents" sort.
const libRecents = load('railRecents', {});
function libKeyFor(v, arg) {
  if (v === 'likes') return 'likes';
  if ((v === 'sc' || v === 'local') && arg != null) return `${v}:${arg}`;
  if ((v === 'mix' || v === 'mixes') && arg != null && typeof arg !== 'object') return `mix:${arg}`;
  return '';
}
function shellAfterGo(v, arg) {
  const key = libKeyFor(v, arg);
  if (key) { libRecents[key] = Date.now(); store('railRecents', libRecents); }
  const home = $('#nav-home');
  if (home) home.classList.toggle('active', v === 'home');
  if (railLib.el) railLib.el.querySelectorAll('[data-key]').forEach((r) => r.classList.toggle('active', r.dataset.key === key));
}

function mixList(res) {
  const list = Array.isArray(res) ? res : (res && (res.mixes || res.items || res.list)) || [];
  return list.filter(Boolean).map((m) => {
    const id = m.id ?? m.urn ?? m.key;
    const n = m.trackCount ?? m.track_count ?? (Array.isArray(m.tracks) ? m.tracks.length : null);
    return { key: `mix:${id}`, kind: 'mix', id, raw: m, title: String(m.title || m.name || 'Mix'), cover: m.artwork || m.cover || (Array.isArray(m.tracks) && m.tracks[0]?.artwork) || '',
      sub: m.subtitle || m.description || (n != null ? `Mix · ${plural(n, 'track')}` : 'Mix'), creator: String(m.creator || m.by || 'noxx') };
  }).filter((m) => m.id != null);
}
// mixes.list is another feature's work in progress; any error just means no mixes yet.
async function loadRailMixes() {
  if (Date.now() - railLib.mixesAt < 60000) return;
  railLib.mixesAt = Date.now();
  try { railLib.mixes = mixList(await window.riff.call('mixes.list')); } catch (e) { railLib.mixes = []; }
  renderRailLib();
}
function openMix(m) {
  if (ext.views.mix) go('mix', m.id);
  else if (ext.views.mixes) go('mixes', m.id);
  else toast('Mixes are not available yet');
}

function libItems() {
  const favs = state.library.favorites || [];
  const out = [{ key: 'likes', kind: 'likes', title: 'Liked Songs', sub: `Playlist · ${plural(favs.length, 'song')}`, cover: '', icon: ICON.heartFill, creator: 'You', order: 0 }];
  (state.scPlaylists || []).forEach((p, i) => out.push({ key: `sc:${p.id}`, kind: 'sc', id: p.id, title: p.title, sub: `SoundCloud · ${plural(p.trackCount, 'track')}`, cover: p.artwork, icon: ICON.cloud, creator: 'SoundCloud', order: 100 + i }));
  (state.library.playlists || []).forEach((p, i) => out.push({ key: `local:${p.id}`, kind: 'local', id: p.id, title: p.name, sub: `Playlist · ${plural(p.tracks.length, 'track')}`, cover: p.tracks[0]?.artwork, icon: ICON.music, creator: 'You', order: 10 + i }));
  railLib.mixes.forEach((m, i) => out.push({ ...m, icon: ICON.fire, order: 1000 + i }));
  return out;
}
function sortLib(items) {
  const s = pref('railSort', 'recent');
  const byTitle = (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });
  const by = s === 'alpha' ? byTitle
    : s === 'creator' ? (a, b) => a.creator.localeCompare(b.creator) || byTitle(a, b)
    : (a, b) => (libRecents[b.key] || 0) - (libRecents[a.key] || 0) || a.order - b.order;
  // Liked Songs stays first.
  return items.slice().sort((a, b) => (a.key === 'likes' ? -1 : b.key === 'likes' ? 1 : by(a, b)));
}
function openLibItem(it) {
  if (it.kind === 'likes') go('likes');
  else if (it.kind === 'mix') openMix(it);
  else go(it.kind, it.id);
}
function libCoverHtml(it, px) {
  const url = it.kind === 'local' ? small(it.cover) : art(it.cover, px);
  return `<span class="rl-cover${it.kind === 'likes' ? ' likes' : ''}" style="${bg(url)}">${url ? '' : it.icon}</span>`;
}

function buildRailLibrary(rail) {
  if (railLib.el) return;
  // A <section>, not a <div>: the CSS that drops Queue / Settings to the bottom uses .rail-divider:last-of-type.
  const sec = document.createElement('section');
  sec.className = 'rail-lib';
  sec.innerHTML = `<div class="rl-pins-head">Pinned</div>
    <div class="rl-wide-head">
      <div class="rl-head"><span class="rl-title">Your Library</span><button class="rl-create" title="Create playlist">${ICON.plus}<span>Create</span></button></div>
      <div class="rl-chips"></div>
      <div class="rl-tools"><label class="rl-filter">${svg('<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>')}<input type="text" placeholder="Search in Your Library" spellcheck="false" autocomplete="off"></label>
        <button class="rl-sort" title="Sort"><span></span>${svg('<polyline points="6 9 12 15 18 9"/>')}</button></div>
    </div>
    <div class="rl-list"></div>`;
  const dividers = rail.querySelectorAll('.rail-divider');
  const last = dividers[dividers.length - 1];
  if (last) last.before(sec); else rail.append(sec);
  railLib.el = sec;

  const edge = document.createElement('div');
  edge.className = 'rail-resize-edge';
  edge.id = 'sidebar-resize-edge';
  edge.title = 'Drag to resize · double-click for Your Library';
  rail.append(edge);
  wireRailEdge(edge);

  sec.querySelector('.rl-create').onclick = () => newPlaylist();
  sec.querySelector('.rl-chips').addEventListener('click', (e) => {
    const c = e.target.closest('[data-chip]');
    if (!c) return;
    railLib.chip = railLib.chip === c.dataset.chip ? '' : c.dataset.chip;
    renderRailLib(true);
  });
  const input = sec.querySelector('.rl-filter input');
  input.addEventListener('input', () => { railLib.filter = input.value.trim().toLowerCase(); renderRailLib(); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Escape') { input.value = ''; railLib.filter = ''; renderRailLib(); input.blur(); } });
  const sortBtn = sec.querySelector('.rl-sort');
  sortBtn.onclick = (e) => {
    e.stopPropagation();
    const r = sortBtn.getBoundingClientRect();
    showMenu(LIB_SORTS.map(([v, label]) => ({ label, checked: pref('railSort', 'recent') === v, run: () => { setPref('railSort', v); renderRailLib(true); } })), r.left, r.bottom + 6);
  };
  const list = sec.querySelector('.rl-list');
  const itemOf = (row) => libItems().find((it) => it.key === row.dataset.key);
  list.addEventListener('click', (e) => {
    const row = e.target.closest('[data-key]');
    const it = row && itemOf(row);
    if (!it) return;
    if (e.target.closest('[data-pin]')) { togglePin(it.key); return; }
    openLibItem(it);
  });
  list.addEventListener('keydown', (e) => {
    const row = e.target.closest('[data-key]');
    const it = row && (e.key === 'Enter' || e.key === ' ') && itemOf(row);
    if (it) { e.preventDefault(); openLibItem(it); }
  });
  list.addEventListener('contextmenu', (e) => {
    const row = e.target.closest('[data-key]');
    if (!row) return;
    e.preventDefault();
    const it = itemOf(row);
    if (it) showMenu([{ label: 'Open', run: () => openLibItem(it) }, pinMenuItem(it.key)], e.clientX, e.clientY);
  });

  bus.addEventListener('library', () => renderRailLib());
  bus.addEventListener('ready', () => setTimeout(loadRailMixes, 1500));
  wireCardPinMenu();
  applyShellPrefs();
  setRailWidth(pref('railWidth', RAIL_W.normal), false);
  renderRailLib(true);
}

/** Draws the pinned list (icons / labelled side bar) or the whole library (wide); cascade = rows slide in. */
function renderRailLib(cascade) {
  const sec = railLib.el;
  if (!sec || !state.library) return;
  const wide = railLib.mode === 'wide';
  const all = libItems();
  let items;
  if (wide) {
    const chips = LIB_CHIPS.filter(([id]) => id !== 'mixes' || railLib.mixes.length);
    if (railLib.chip && !chips.some(([id]) => id === railLib.chip)) railLib.chip = '';
    sec.querySelector('.rl-chips').innerHTML = (railLib.chip ? `<button class="rl-chip clear" data-chip="${railLib.chip}" title="Clear filter">${ICON.close}</button>` : '')
      + chips.map(([id, label]) => `<button class="rl-chip${railLib.chip === id ? ' on' : ''}" data-chip="${id}">${label}</button>`).join('');
    items = sortLib(all);
    const chip = chips.find(([id]) => id === railLib.chip);
    if (chip) items = items.filter(chip[2]);
    if (railLib.filter) items = items.filter((it) => `${it.title} ${it.sub} ${it.creator}`.toLowerCase().includes(railLib.filter));
  } else {
    const byKey = new Map(all.map((it) => [it.key, it]));
    items = railPins().map((k) => byKey.get(k)).filter(Boolean);
  }
  sec.querySelector('.rl-sort > span').textContent = (LIB_SORTS.find(([v]) => v === pref('railSort', 'recent')) || LIB_SORTS[0])[1];
  sec.classList.toggle('empty', !wide && !items.length);
  const activeKey = libKeyFor(state.view, state.arg);
  const list = sec.querySelector('.rl-list');
  list.innerHTML = items.map((it) => {
    const pinned = isPinned(it.key);
    return wide
      ? `<div class="sb-lib-row${it.key === activeKey ? ' active' : ''}" data-key="${esc(it.key)}" role="button" tabindex="0" title="${esc(it.title)}">
          ${libCoverHtml(it, 40)}<span class="rl-text"><span class="rl-name">${esc(it.title)}</span><span class="rl-sub">${pinned ? `<i class="rl-pinned">${PIN_ICON}</i>` : ''}${esc(it.sub)}</span></span>
          <button class="rl-pin${pinned ? ' on' : ''}" data-pin title="${pinned ? 'Unpin' : 'Pin to side bar'}">${PIN_ICON}</button></div>`
      : `<div class="sb-pin-row${it.key === activeKey ? ' active' : ''}" data-key="${esc(it.key)}" role="button" tabindex="0" title="${esc(it.title)}">
          ${libCoverHtml(it, 28)}<span class="rl-name">${esc(it.title)}</span></div>`;
  }).join('') || (wide ? `<div class="rl-empty">${railLib.filter ? 'Nothing matches.' : 'No playlists yet.'}</div>` : '');
  if (cascade) {
    [...list.children].forEach((r, i) => { r.style.animationDelay = `${Math.min(i, 4) * 20}ms`; }); // 80ms + 120ms ≤ 200ms
    list.classList.remove('rl-intro');
    void list.offsetWidth;
    list.classList.add('rl-intro');
    clearTimeout(railLib.introTimer);
    railLib.introTimer = setTimeout(() => list.classList.remove('rl-intro'), 260);
  }
}

function wireRailEdge(edge) {
  let drag = null;
  edge.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    drag = { x: e.clientX, w: railLib.px, moved: false };
    try { edge.setPointerCapture(e.pointerId); } catch (err) {}
    $('.app-layout').classList.add('rail-dragging');
    document.body.classList.add('rail-resizing');
  });
  edge.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = (e.clientX - drag.x) / uiZoom();
    if (Math.abs(dx) > 2) drag.moved = true;
    if (drag.moved) setRailWidth(drag.w + dx, false);
  });
  const end = () => {
    if (!drag) return;
    const moved = drag.moved;
    drag = null;
    $('.app-layout').classList.remove('rail-dragging');
    document.body.classList.remove('rail-resizing');
    if (moved) { setRailWidth(railLib.px, true); redrawLists(); }
  };
  edge.addEventListener('pointerup', end);
  edge.addEventListener('pointercancel', end);
  edge.addEventListener('dblclick', (e) => { e.preventDefault(); toggleRailWide(); });
}

// A playlist's ⋯ menu (in its header) and right-click on playlist cards / tiles: pin or unpin it.
bus.addEventListener('render', (e) => {
  const { view: v, arg } = e.detail || {};
  if ((v !== 'sc' && v !== 'local') || arg == null) return;
  const actions = view.querySelector('.hero .actions');
  if (!actions || actions.querySelector('[data-pl-more]')) return;
  const key = `${v}:${arg}`;
  const more = el(`<button class="pill-btn pl-more" data-pl-more title="More" aria-label="More">${ICON.more}</button>`);
  more.addEventListener('click', (ev) => {
    ev.stopPropagation();
    const r = more.getBoundingClientRect();
    const btn = (a) => actions.querySelector(`[data-a="${a}"]`);
    const items = [pinMenuItem(key)];
    if (btn('rename')) items.push({ label: 'Rename…', run: () => btn('rename').click() });
    if (btn('delete')) items.push({ label: 'Delete…', run: () => btn('delete').click() });
    if (btn('save')) items.push({ label: 'Save a copy', run: () => btn('save').click() });
    showMenu(items, r.left, r.bottom + 4);
  });
  actions.append(more);
});
// (wired from buildRailLibrary: `view` is declared further down this file)
function wireCardPinMenu() {
  view.addEventListener('contextmenu', (e) => {
    const card = e.target.closest('[data-go="sc"][data-id], [data-go="local"][data-id]');
    if (!card || e.defaultPrevented) return;
    e.preventDefault();
    const key = `${card.dataset.go}:${card.dataset.id}`;
    showMenu([{ label: 'Open', run: () => go(card.dataset.go, card.dataset.id) }, pinMenuItem(key)], e.clientX, e.clientY);
  });
}

async function reloadLibrary() {
  setLibrary(await invoke('get_library'));
}

// ---------------------------------------------------------------- virtual track list

const view = $('#view');
let activeLists = [];

function rowHtml(t, i, opts) {
  const playing = player.current && player.current.id === t.id ? ' playing' : '';
  const fav = state.favIds.has(t.id);
  return `<div class="track-row${playing}" data-i="${i}" style="top:${i * ROW_H}px">
    <span class="tr-index track-row-index">${i + 1}</span>
    <div class="tr-thumb track-row-thumb" style="${bg(small(t.artwork))}"></div>
    <div class="tr-info"><span class="tr-title track-row-title">${esc(t.title)}</span><span class="tr-artist track-row-artist" data-act="artist">${esc(t.artist)}</span></div>
    <div class="tr-actions">
      <button class="pill-btn heart${fav ? ' on' : ''}" data-act="fav" title="${fav ? 'Unlike' : 'Like'}">${ICON.heart}</button>
      ${opts.removable
        ? `<button class="pill-btn" data-act="remove" title="Remove">${ICON.close}</button>`
        : `<button class="pill-btn" data-act="queue" title="Add to queue">${ICON.queue}</button>`}
      <button class="pill-btn" data-act="more" title="More">${ICON.more}</button>
    </div>
    <span class="tr-fav">${fav && !opts.hideFav ? ICON.heartFill : ''}</span>
    <span class="tr-dur track-row-duration">${fmt(t.duration)}</span>
  </div>`;
}

/**
 * Draws only the rows in view, so thousands of likes stay instant.
 * opts: { onPlay(i), removable, onRemove(i) }
 */
function trackList(container, tracks, opts = {}) {
  const el = document.createElement('div');
  el.className = 'tracks';
  el.style.height = Math.max(0, tracks.length * ROW_H - 4) + 'px';
  container.append(el);

  let lastStart = -1, lastEnd = -1;
  // Rows cascade in (20ms apart, all done within 200ms) only on the first draw after a view change:
  // never on scroll or filter, and a scroll during the cascade drops it for the new rows.
  let intro = performance.now() - lastGoAt < 600, drawn = 0;
  function draw(force) {
    if (!el.isConnected) return;
    const top = view.scrollTop - el.offsetTop;
    const start = Math.max(0, Math.floor(top / ROW_H) - 6);
    const end = Math.min(tracks.length, Math.ceil((top + view.clientHeight) / ROW_H) + 6);
    if (start === lastStart && end === lastEnd) {
      if (force) patchRows();
      return;
    }
    lastStart = start; lastEnd = end;
    let html = '';
    for (let i = start; i < end; i++) html += rowHtml(tracks[i], i, opts);
    el.innerHTML = html;
    if (intro && !drawn++) {
      // Delay by position on screen (rows above the fold don't count); the cap keeps the whole cascade under 200ms.
      const first = Math.max(0, Math.floor(top / ROW_H));
      for (const row of el.children) row.style.animationDelay = `${Math.min(4, Math.max(0, Number(row.dataset.i) - first)) * 20}ms`;
      el.classList.add('intro');
      setTimeout(() => el.classList.remove('intro'), 260);
    } else el.classList.remove('intro');
  }
  // Same rows, new state (now playing / liked): update them in place so hover, ripples and focus survive.
  function patchRows() {
    for (const row of el.children) {
      const t = tracks[Number(row.dataset.i)];
      if (!t) continue;
      row.classList.toggle('playing', !!player.current && player.current.id === t.id);
      const fav = state.favIds.has(t.id);
      const heart = row.querySelector('[data-act=fav]');
      if (heart && heart.classList.contains('on') !== fav) {
        heart.classList.toggle('on', fav);
        heart.title = fav ? 'Unlike' : 'Like';
        row.querySelector('.tr-fav').innerHTML = fav && !opts.hideFav ? ICON.heartFill : '';
      }
    }
  }

  el.addEventListener('click', (e) => {
    const row = e.target.closest('.track-row');
    if (!row) return;
    const i = Number(row.dataset.i);
    const t = tracks[i];
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'fav') toggleFavorite(t);
    else if (act === 'artist' && bus.hasArtist) emit('artist', t);
    else if (act === 'queue') addToQueue(t);
    else if (act === 'remove') opts.onRemove && opts.onRemove(i);
    else if (act === 'more') { const r = e.target.closest('[data-act]').getBoundingClientRect(); trackMenu(t, r.left, r.bottom + 4, opts, i); }
    else (opts.onPlay ? opts.onPlay(i) : playList(tracks, i));
  });
  el.addEventListener('contextmenu', (e) => {
    const row = e.target.closest('.track-row');
    if (!row) return;
    e.preventDefault();
    const i = Number(row.dataset.i);
    trackMenu(tracks[i], e.clientX, e.clientY, opts, i);
  });

  activeLists.push(draw);
  requestAnimationFrame(() => draw(true));
}

let scrollQueued = false;
view.addEventListener('scroll', () => {
  if (scrollQueued) return;
  scrollQueued = true;
  requestAnimationFrame(() => {
    scrollQueued = false;
    activeLists.forEach((d) => d(false));
    maybeLoadMoreSearch();
  });
});
window.addEventListener('resize', () => { activeLists.forEach((d) => d(true)); sizeWave(); fitMarquee(); updateNavIndicator(false); });
function redrawLists() { activeLists.forEach((d) => d(true)); }

// ---------------------------------------------------------------- menus & modals

const menu = $('#menu');
// items: '-' or { label, run, checked? } — when any item has `checked`, a check column lines them up.
function showMenu(items, x, y) {
  menu.innerHTML = '';
  // No separator at the start or end, and never two in a row.
  items = items.filter(Boolean).filter((it, i, a) => it !== '-' || (i > 0 && i < a.length - 1 && a[i - 1] !== '-'));
  const checks = items.some((it) => it && it !== '-' && 'checked' in it);
  menu.classList.toggle('has-checks', checks);
  for (const it of items) {
    if (it === '-') { const s = document.createElement('div'); s.className = 'sep'; menu.append(s); continue; }
    const b = document.createElement('button');
    if (checks) b.innerHTML = `<span class="menu-check">${it.checked ? svg('<polyline points="20 6 9 17 4 12"/>') : ''}</span>`;
    b.append(document.createTextNode(it.label));
    b.onclick = () => { hideMenu(); it.run(); };
    menu.append(b);
  }
  menu.hidden = false;
  // Replay the open animation as one piece (the whole menu fades/scales, not its rows).
  menu.classList.remove('menu-open');
  void menu.offsetWidth;
  menu.classList.add('menu-open');
  const r = menu.getBoundingClientRect();
  const z = uiZoom();
  menu.style.left = Math.max(8, Math.min(x, innerWidth - r.width - 8)) / z + 'px';
  menu.style.top = Math.max(8, Math.min(y, innerHeight - r.height - 8)) / z + 'px';
}
function hideMenu() { menu.hidden = true; }
document.addEventListener('mousedown', (e) => { if (!menu.hidden && !menu.contains(e.target)) hideMenu(); });

function addToQueue(t, next) {
  if (next) player.userQueue.unshift(t); else player.userQueue.push(t);
  toast(next ? 'Playing next' : 'Added to queue');
  queueChanged();
}

// ---------------------------------------------------------------- never play: songs / artists the user blocked
// Matched by id and by artist + title (so the same song on the other platform or a reupload is
// caught too). Radio, My Wave, mixes and autoplay leave them out; the queue skips past them.
const nameKey = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
function songKey(t) {
  let a = t.artist || '', ti = String(t.title || '');
  const dash = ti.match(/^(.+?)\s+[-–]\s+(.+)$/);
  if (dash) { a = dash[1]; ti = dash[2]; }
  return `${nameKey(a)}|${nameKey(ti.replace(/\s*[[(].*$/, ''))}`;
}
const artistKey = (t) => nameKey(String(t.title || '').match(/^(.+?)\s+[-–]\s+/)?.[1] || t.artist);
const blockedList = () => { const v = pref('blocked', []); return Array.isArray(v) ? v : []; };
let blockIndex = null;
function blockSets() {
  if (!blockIndex) {
    blockIndex = { ids: new Set(), songs: new Set(), artists: new Set() };
    for (const b of blockedList()) {
      if (b.kind === 'artist') blockIndex.artists.add(b.key);
      else { if (b.id) blockIndex.ids.add(b.id); if (b.key) blockIndex.songs.add(b.key); }
    }
  }
  return blockIndex;
}
function isBlocked(t) {
  if (!t) return false;
  const s = blockSets();
  if (!s.ids.size && !s.songs.size && !s.artists.size) return false;
  return s.ids.has(t.id) || s.songs.has(songKey(t)) || s.artists.has(nameKey(t.artist)) || s.artists.has(artistKey(t));
}
function saveBlocked(list) { setPref('blocked', list); blockIndex = null; emit('blocked', list); }
function block(t, kind) {
  const list = blockedList();
  if (kind === 'artist') {
    const key = artistKey(t);
    if (!key || list.some((b) => b.kind === 'artist' && b.key === key)) return;
    const name = String(t.title || '').match(/^(.+?)\s+[-–]\s+/)?.[1] || t.artist;
    list.unshift({ kind: 'artist', key, name, at: Date.now() });
    toast(`You won't hear ${name} again`);
  } else {
    if (isBlocked(t)) return;
    list.unshift({ kind: 'song', id: t.id, key: songKey(t), title: t.title, artist: t.artist, at: Date.now() });
    toast(`You won't hear ${t.title} again`);
  }
  saveBlocked(list.slice(0, 2000));
  // Drop it from what's lined up, and move on if it's playing now.
  player.userQueue = player.userQueue.filter((x) => !isBlocked(x));
  queueChanged();
  if (player.current && isBlocked(player.current)) next(false);
}
function unblock(entry) {
  saveBlocked(blockedList().filter((b) => !(b.kind === entry.kind && b.key === entry.key && b.id === entry.id)));
}

function trackMenu(t, x, y, opts = {}, i = -1) {
  const items = [
    { label: 'Play next', run: () => addToQueue(t, true) },
    { label: 'Add to queue', run: () => addToQueue(t) },
    { label: state.favIds.has(t.id) ? 'Remove from likes' : 'Add to likes', run: () => toggleFavorite(t) },
    { label: 'Add to playlist…', run: () => playlistPicker(t, x, y) },
  ];
  if (opts.removable && opts.onRemove && i >= 0) items.push({ label: 'Remove from this list', run: () => opts.onRemove(i) });
  for (const fn of ext.trackMenu) { try { const more = fn(t, opts) || []; if (more.length) items.push('-', ...more); } catch (e) { log('error', errText(e)); } }
  const who = String(t.title || '').match(/^(.+?)\s+[-–]\s+/)?.[1] || t.artist;
  items.push('-', { label: 'Don\'t play this song', run: () => block(t, 'song') });
  if (who && !/^unknown/i.test(who)) items.push({ label: `Don't play ${who}`, run: () => block(t, 'artist') });
  if (t.url) items.push('-', { label: 'Copy link', run: () => navigator.clipboard.writeText(t.url).then(() => toast('Link copied')).catch(() => {}) });
  showMenu(items, x, y);
}

function playlistPicker(t, x, y) {
  const items = state.library.playlists.map((p) => ({
    label: p.name,
    run: async () => {
      const added = await invoke('playlist_add', { id: p.id, track: t });
      toast(added ? `Added to ${p.name}` : `Already in ${p.name}`);
      await reloadLibrary();
      if (state.view === 'local' && state.arg === p.id) render(true);
    },
  }));
  if (items.length) items.push('-');
  items.push({
    label: 'New playlist…',
    run: async () => {
      const name = await askText('New playlist', 'Name', '');
      if (name == null) return;
      const p = await invoke('playlist_create', { name });
      await invoke('playlist_add', { id: p.id, track: t });
      await reloadLibrary();
      toast(`Added to ${p.name}`);
    },
  });
  showMenu(items, x, y);
}

const modal = $('#modal');
function openModal(html) {
  modal.innerHTML = `<div class="modal modal-card">${html}</div>`;
  modal.hidden = false;
  return modal.firstElementChild;
}
function closeModal() { modal.hidden = true; modal.innerHTML = ''; }
modal.addEventListener('mousedown', (e) => { if (e.target === modal) closeModal(); });

function askText(title, placeholder, value) {
  return new Promise((resolve) => {
    const m = openModal(`<h3>${esc(title)}</h3><input placeholder="${esc(placeholder)}" value="${esc(value)}">
      <div class="row-btns"><button class="btn outline" data-k="cancel">Cancel</button><button class="btn primary" data-k="ok">OK</button></div>`);
    const input = m.querySelector('input');
    const done = (v) => { closeModal(); resolve(v); };
    m.querySelector('[data-k=cancel]').onclick = () => done(null);
    m.querySelector('[data-k=ok]').onclick = () => done(input.value);
    input.onkeydown = (e) => { if (e.key === 'Enter') done(input.value); if (e.key === 'Escape') done(null); };
    setTimeout(() => { input.focus(); input.select(); }, 0);
  });
}

function confirmBox(title, text, okLabel) {
  return new Promise((resolve) => {
    const m = openModal(`<h3>${esc(title)}</h3><p>${esc(text)}</p>
      <div class="row-btns"><button class="btn outline" data-k="cancel">Cancel</button><button class="btn primary" data-k="ok">${esc(okLabel)}</button></div>`);
    m.querySelector('[data-k=cancel]').onclick = () => { closeModal(); resolve(false); };
    m.querySelector('[data-k=ok]').onclick = () => { closeModal(); resolve(true); };
  });
}

// ---------------------------------------------------------------- account

// Some SoundCloud names are only invisible characters (e.g. Unicode tag chars).
function displayName(name) {
  const visible = String(name || '').replace(/[\u{E0000}-\u{E007F}​-‏⁠-⁤﻿\s]/gu, '');
  return visible ? name : 'SoundCloud';
}

function renderAccount() {
  const s = state.status;
  const pill = $('#account-pill');
  pill.classList.toggle('warn', !!s.expired);
  if (!s.loggedIn) {
    pill.innerHTML = `<span class="av">${ICON.cloud}</span><span class="ap-name">Connect</span>`;
    pill.title = 'Connect SoundCloud';
  } else {
    pill.innerHTML = `<span class="av" style="${bg(s.avatar)}"></span>${s.expired ? '<span class="ap-name">Reconnect</span>' : ''}`;
    pill.title = s.expired ? 'SoundCloud session expired' : `SoundCloud: ${displayName(s.username)}`;
  }
  if (state.view === 'settings') render(true);
}
$('#account-pill').onclick = () => {
  const s = state.status;
  if (!s.loggedIn) connectDialog(false);
  else if (s.expired) connectDialog(true);
  else go('settings', 'integrations');
};

function connectDialog(force) {
  const m = openModal(`<h3>${force ? 'Reconnect' : 'Connect'} SoundCloud</h3>
    <p>A SoundCloud window opens. Sign in there and it closes by itself. Your likes and playlists show up right after.</p>
    <p class="muted">Or use your own browser: a page opens with one bookmark button that hands your SoundCloud login to noxx.</p>
    <div class="row-btns">
      <button class="btn outline" data-k="token">Paste token</button>
      <button class="btn outline" data-k="browser">Use my browser</button>
      <button class="btn outline" data-k="cancel">Cancel</button>
      <button class="btn primary" data-k="open">Open sign-in</button>
    </div>`);
  m.querySelector('[data-k=cancel]').onclick = closeModal;
  // Android: the sign-in page opens as its own screen (LoginActivity.kt) and hands the token back.
  if (window.noxxAndroid) {
    m.querySelector('[data-k=browser]').remove();
    m.querySelectorAll('p').forEach((p, i) => (i ? p.remove() : (p.textContent = "SoundCloud's sign-in page opens. Sign in there and you come straight back here, connected.")));
  }
  m.querySelector('[data-k=open]').onclick = async () => {
    closeModal();
    toast('Waiting for SoundCloud sign-in…');
    try {
      const status = window.noxxAndroid
        ? await invoke('sc_use_token', { token: await window.noxxLogin(force) })
        : await invoke('sc_login', { force });
      onStatus(status);
      toast(`Connected as ${displayName(status.username)}`);
    } catch (e) {
      toast(errText(e), 'error');
    }
  };
  m.querySelector('[data-k=browser]').onclick = async () => {
    closeModal();
    toast('Finish signing in in your browser…');
    try {
      const status = await invoke('sc_login_browser');
      onStatus(status);
      toast(`Connected as ${displayName(status.username)}`);
    } catch (e) {
      toast(errText(e), 'error');
    }
  };
  m.querySelector('[data-k=token]').onclick = async () => {
    closeModal();
    const token = await askText('Paste your SoundCloud oauth_token', 'oauth_token cookie value', '');
    if (!token) return;
    try {
      const status = await invoke('sc_use_token', { token });
      onStatus(status);
      toast(`Connected as ${displayName(status.username)}`);
    } catch (e) {
      toast(errText(e), 'error');
    }
  };
}

async function logout() {
  if (!(await confirmBox('Disconnect SoundCloud?', 'Your likes stay in the app. SoundCloud playlists are hidden until you connect again.', 'Disconnect'))) return;
  await invoke('sc_logout');
  onStatus(await invoke('sc_status'));
}

let expiredToastShown = false;
function onStatus(s) {
  const wasLive = state.status.loggedIn && !state.status.expired;
  state.status = s;
  renderAccount();
  emit('status', s);
  if (s.loggedIn && s.expired && !expiredToastShown) {
    expiredToastShown = true;
    toast('SoundCloud session expired. Reconnect to see your private stuff.', 'error');
  }
  if (s.loggedIn && !s.expired) expiredToastShown = false;
  if (s.loggedIn && !s.expired && !wasLive) loadScPlaylists();
  if (!s.loggedIn) { state.scPlaylists = []; setLibrary(state.library); }
  if (state.view === 'home' || state.view === 'playlists') render(true);
}

async function syncLikes(loud) {
  try {
    // Changes arrive through the library-changed event (which toasts).
    const r = await invoke('sync_likes');
    if (loud && !r.changed) toast('Likes are up to date');
  } catch (e) {
    if (loud) toast(errText(e), 'error');
  }
}

async function loadScPlaylists() {
  try { state.scPlaylists = await invoke('sc_playlists'); } catch (e) { state.scPlaylists = []; }
  setLibrary(state.library);
  if (state.view === 'home' || state.view === 'playlists') render(true);
}

// ---------------------------------------------------------------- navigation

document.querySelectorAll('.nav-item').forEach((b) => b.addEventListener('click', () => go(b.dataset.view)));
$('#pb-queue').onclick = () => go('queue');

let lastGoAt = 0, enterTimer = 0;
function go(v, arg = null) {
  histPush(v, arg); // Back / Forward (before render clears the old page, so its scroll is kept)
  state.view = v;
  state.arg = arg;
  if (v === 'likes' && newLikes) bumpNewLikes(0);
  const navView = { sc: 'playlists', local: 'playlists', search: '' }[v] ?? v;
  document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === navView));
  updateNavIndicator(true);
  lastGoAt = performance.now();
  render();
  shellAfterGo(v, arg);
  // The new page fades in with a small rise (110ms); its cards and rows cascade after it.
  view.classList.remove('enter');
  void view.offsetWidth;
  view.classList.add('enter');
  clearTimeout(enterTimer);
  enterTimer = setTimeout(() => view.classList.remove('enter'), 320);
}

// ---------------------------------------------------------------- nav indicator (riff's sliding pill)

const navInd = $('#nav-active-ind');
let navIndTimer = 0, navIndReady = false;
// riff's stacked radii: items between dividers read as one group (big outer corners, small inner ones).
function navItemRadius(item) {
  const group = [];
  let n = item;
  while (n.previousElementSibling && n.previousElementSibling.classList.contains('nav-item')) n = n.previousElementSibling;
  for (; n && n.classList.contains('nav-item'); n = n.nextElementSibling) if (n.offsetParent) group.push(n);
  const i = group.indexOf(item);
  if (group.length < 2) return '24px';
  if (i === 0) return '24px 24px 10px 10px';
  if (i === group.length - 1) return '10px 10px 24px 24px';
  return '14px';
}
function updateNavIndicator(animate) {
  if (!navInd) return;
  const active = document.querySelector('.rail .nav-item.active');
  if (!active || !active.offsetParent) { navInd.classList.add('is-hidden'); return; }
  const top = active.offsetTop + (active.offsetHeight - 48) / 2;
  const radius = navItemRadius(active);
  navInd.classList.remove('is-hidden');
  clearTimeout(navIndTimer);
  if (!animate || !navIndReady) {
    navInd.style.transition = 'opacity .2s ease';
    navInd.style.height = '48px';
    navInd.style.transform = `translateY(${top}px)`;
    navInd.style.borderRadius = radius;
    navIndReady = true;
    return;
  }
  // Stretch to cover both the old and the new item, then shrink onto the new one.
  const curTop = new DOMMatrix(getComputedStyle(navInd).transform).m42;
  const curBottom = curTop + (navInd.offsetHeight || 48);
  const from = Math.min(curTop, top), to = Math.max(curBottom, top + 48);
  // Whole stretch-and-settle stays within 200ms.
  navInd.style.transition = 'transform 90ms cubic-bezier(.3, 0, .8, .15), height 90ms cubic-bezier(.3, 0, .8, .15), opacity 150ms ease';
  navInd.style.transform = `translateY(${from}px)`;
  navInd.style.height = `${to - from}px`;
  navInd.style.borderRadius = '24px';
  navIndTimer = setTimeout(() => {
    navInd.style.transition = 'transform 110ms var(--ease), height 110ms var(--ease), border-radius 110ms var(--ease), opacity 150ms ease';
    navInd.style.transform = `translateY(${top}px)`;
    navInd.style.height = '48px';
    navInd.style.borderRadius = radius;
  }, 90);
}

let renderToken = 0;
function render(keepScroll) {
  // Back / Forward put the page back where it was scrolled to (navHistory sets histScroll).
  const scroll = keepScroll ? view.scrollTop : (histScroll || 0);
  histScroll = 0;
  const token = ++renderToken;
  activeLists = [];
  view.innerHTML = '';
  const views = { home: renderHome, search: renderSearch, likes: renderLikes, playlists: renderPlaylists, queue: renderQueue, sc: renderScPlaylist, local: renderLocalPlaylist, settings: renderSettings };
  // A feature can replace a core page by registering it with { override: true } (e.g. the home feed).
  const xv = ext.views[state.view];
  const fn = (xv && xv.override && xv.render) || views[state.view] || (xv && xv.render) || renderHome;
  Promise.resolve().then(() => fn(token, state.arg)).catch((e) => { log('error', `view ${state.view}: ${errText(e)}`); }).then(() => {
    if (token !== renderToken) return;
    view.scrollTop = scroll;
    emit('render', { view: state.view, arg: state.arg });
  });
}
const stale = (token) => token !== renderToken;

function el(html) { const d = document.createElement('div'); d.innerHTML = html.trim(); return d.firstElementChild; }
// Settings tabs point add() at their pane while they render (see renderSettingsPane).
let addTarget = null;
function add(html) { const e = el(html); (addTarget || view).append(e); return e; }
function spinner() { return add('<div class="spinner"></div>'); }
function emptyMsg(text, btnLabel, onClick) {
  const e = add(`<div class="empty"><div>${esc(text)}</div>${btnLabel ? `<button class="btn primary">${esc(btnLabel)}</button>` : ''}</div>`);
  if (btnLabel) e.querySelector('button').onclick = onClick;
  return e;
}

function hero({ kicker, title, sub, cover, icon, actions = '' }) {
  const node = add(`<div class="hero${cover ? ' has-banner' : ''}">${cover ? '<div class="art-banner"><canvas width="1" height="1"></canvas></div>' : ''}
    <div class="cover" style="${bg(art(cover, 160))}">${cover ? '' : icon || ''}</div>
    <div class="meta"><div class="kicker">${esc(kicker)}</div><h1>${esc(title)}</h1><div class="page-sub">${esc(sub || '')}</div><div class="actions">${actions}</div></div></div>`);
  if (cover) heroBanner(node.querySelector('.art-banner'), art(cover, 500));
  return node;
}

function listActions(extra = '') {
  return `<button class="btn primary" data-a="play">${ICON.play}Play</button><button class="btn" data-a="shuffle">${ICON.shuffle}Shuffle</button>${extra}`;
}
function wireActions(node, tracks, handlers = {}) {
  node.addEventListener('click', (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (!a) return;
    if (a === 'play' && tracks.length) { setShuffle(false); playList(tracks, 0); }
    else if (a === 'shuffle' && tracks.length) playList(tracks, Math.floor(Math.random() * tracks.length), true);
    else if (handlers[a]) handlers[a]();
  });
}

// ---------------------------------------------------------------- views

async function renderHome(token) {
  add(`<div class="section-title">${ICON.home}Home</div>`);
  const tiles = add('<div class="tiles"></div>');
  const favs = state.library.favorites;
  const tileHtml = (cls, style, inner, a, b, data) => `<button class="tile" ${data}><span class="t ${cls}" style="${style}">${inner}</span><span class="i"><div class="a">${esc(a)}</div><div class="b">${esc(b)}</div></span></button>`;
  let html = tileHtml('heart', '', ICON.heartFill, 'Liked songs', plural(favs.length, 'song'), 'data-go="likes"');
  for (const p of state.scPlaylists.slice(0, 7)) html += tileHtml('', bg(art(p.artwork, 64)), p.artwork ? '' : ICON.cloud, p.title, plural(p.trackCount, 'track'), `data-go="sc" data-id="${esc(p.id)}"`);
  for (const p of state.library.playlists.slice(0, 4)) html += tileHtml('', bg(small(p.tracks[0]?.artwork)), p.tracks.length ? '' : ICON.music, p.name, plural(p.tracks.length, 'track'), `data-go="local" data-id="${esc(p.id)}"`);
  tiles.innerHTML = html;
  tiles.addEventListener('click', (e) => { const b = e.target.closest('[data-go]'); if (b) go(b.dataset.go, b.dataset.id || null); });
  if (!state.status.loggedIn) emptyMsg('Connect SoundCloud to bring in your likes and playlists.', 'Connect SoundCloud', () => connectDialog(false));

  add(`<div class="section-title">${ICON.fire}Trending now</div>`);
  if (!state.trending) {
    const sp = spinner();
    try { state.trending = await invoke('trending'); } catch (e) { if (!stale(token)) { sp.remove(); emptyMsg(errText(e)); } return; }
    if (stale(token)) return;
    sp.remove();
  }
  trackList(view, state.trending);
}

// ---------------------------------------------------------------- search sources (riff's platform switch)

const searchProviders = [
  { id: 'soundcloud', label: 'SoundCloud', icon: ICON.cloud, search: (query, offset) => invoke('search', { query, offset }), pageSize: 50 },
];
state.platform = load('platform', 'soundcloud');
function provider() { return searchProviders.find((p) => p.id === state.platform) || searchProviders[0]; }

// riff keeps the centred search clear of the right-hand group (--engine-w).
// The left group (logo, Back / Forward) plus the Home button beside the search counts too.
function fitSearchBox() {
  const hist = $('.nav-history');
  const histEnd = hist ? hist.offsetLeft + hist.offsetWidth : 0;
  const nav = $('.top-nav'), right = $('.nav-right').offsetWidth;
  nav.style.setProperty('--engine-w', `${Math.max(right, histEnd + 24)}px`);
  // "Search bar: left" starts right after Back / Forward (+ the Home button); see style.css app shell.
  nav.style.setProperty('--top-left-w', `${histEnd}px`);
  nav.style.setProperty('--nav-right-w', `${right}px`);
}

function renderPlatformSwitch() {
  let box = $('#platform-switch');
  if (searchProviders.length < 2) { if (box) box.remove(); fitSearchBox(); return; }
  // The source picker lives inside the search box: one chip that opens a small menu.
  if (!box) {
    box = el('<button class="src-chip" id="platform-switch" title="Search source"></button>');
    $('.search-box').prepend(box);
    box.addEventListener('click', (e) => {
      e.stopPropagation();
      const r = box.getBoundingClientRect();
      showMenu(searchProviders.map((p) => ({ label: p.label, checked: p.id === state.platform, run: () => setPlatform(p.id) })), r.left, r.bottom + 6);
    });
  }
  const cur = provider();
  box.innerHTML = `${cur.icon || ''}<span>${esc(cur.label)}</span>${svg('<polyline points="6 9 12 15 18 9"/>')}`;
  box.dataset.p = cur.id;
  box.dataset.order = searchProviders.map((p) => p.id).join(',');
  searchInput.placeholder = window.noxxAndroid ? 'Search' : 'What do you want to play?';
  fitSearchBox();
}

function renderSearch() {
  const s = state.search;
  if (!s.query) { emptyMsg(`Search ${provider().label}, or paste a track or playlist link.`); return; }
  add(`<div class="page-title">Results for “${esc(s.query)}”</div>`);
  add(`<div class="page-sub">${s.results.length ? plural(s.results.length, 'track') : ''}</div>`);
  if (s.loading && !s.results.length) { spinner(); return; }
  if (!s.results.length) { emptyMsg('Nothing found.'); return; }
  trackList(view, s.results);
  if (s.loading) spinner();
}

async function runSearch(query) {
  const s = state.search;
  const token = ++s.token;
  Object.assign(s, { query, results: [], offset: 0, done: false, loading: true });
  if (state.view !== 'search') go('search'); else render();
  try {
    // A pasted link picks its own source (provider.matchesLink), otherwise the selected one.
    const p = searchProviders.find((x) => x.matchesLink && x.matchesLink(query)) || provider();
    s.provider = p;
    const res = await p.search(query, 0);
    if (token !== s.token) return;
    s.results = res;
    s.offset = p.pageSize || 50;
    s.done = !p.pageSize || res.length < (p.pageSize * 0.6) || /^https?:/.test(query);
  } catch (e) {
    if (token !== s.token) return;
    toast(errText(e), 'error');
    s.done = true;
  }
  s.loading = false;
  if (state.view === 'search') render();
}

async function maybeLoadMoreSearch() {
  const s = state.search;
  if (state.view !== 'search' || s.loading || s.done || !s.results.length) return;
  if (view.scrollTop + view.clientHeight < view.scrollHeight - 600) return;
  const token = s.token;
  s.loading = true;
  try {
    const p = s.provider || provider();
    const more = await p.search(s.query, s.offset);
    if (token !== s.token) return;
    const seen = new Set(s.results.map((t) => t.id));
    const fresh = more.filter((t) => !seen.has(t.id));
    s.results = s.results.concat(fresh);
    s.offset += p.pageSize || 50;
    if (!fresh.length) s.done = true;
  } catch (e) { s.done = true; }
  s.loading = false;
  if (state.view === 'search') render(true);
}

let searchTimer = 0;
const searchInput = $('#search-input');
searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  const q = searchInput.value.trim();
  $('#search-clear').hidden = !searchInput.value;
  if (q.length < 2) return;
  searchTimer = setTimeout(() => { if (q !== state.search.query) runSearch(q); }, 380);
});
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { clearTimeout(searchTimer); const q = searchInput.value.trim(); if (q) runSearch(q); }
});
$('#search-clear').onclick = () => { searchInput.value = ''; $('#search-clear').hidden = true; searchInput.focus(); };

/** Track list with extension tools (filter / sort) above it. ctx: { kind: 'likes'|'sc'|'local'|'search'|..., id } */
function toolList(ctx, tracks, opts = {}, container = view) {
  const tools = el('<div class="list-tools"></div>');
  const holder = el('<div class="list-holder"></div>');
  container.append(tools, holder);
  let myDraw = null;
  const refresh = () => {
    let shown = tracks;
    for (const t of ext.listTools) { try { if (t.transform) shown = t.transform(ctx, shown) || shown; } catch (e) { log('error', errText(e)); } }
    activeLists = activeLists.filter((d) => d !== myDraw);
    holder.innerHTML = '';
    myDraw = null;
    if (!shown.length && tracks.length) { holder.append(el('<div class="empty">No matches.</div>')); return; }
    const before = activeLists.length;
    const o = Object.assign({}, opts);
    if (opts.onRemove) o.onRemove = (i) => opts.onRemove(tracks.indexOf(shown[i]));
    trackList(holder, shown, o);
    myDraw = activeLists[before];
  };
  for (const t of ext.listTools) { try { if (t.mount) t.mount(tools, ctx, refresh, tracks); } catch (e) { log('error', errText(e)); } }
  if (!tools.children.length) tools.remove();
  refresh();
  return { refresh };
}

function renderLikes() {
  // Two kinds of likes: SoundCloud likes (synced with the signed-in account; hearting a
  // SoundCloud track while signed in likes it there too) and noxx likes (kept only in noxx:
  // YouTube tracks, or anything hearted while signed out). Signing in is optional.
  const all = state.library.favorites;
  const scIds = new Set(state.library.syncedLikeIds || []);
  const scCount = all.filter((t) => scIds.has(t.id)).length;
  const showTabs = state.status.loggedIn || scCount > 0;
  const src = showTabs ? (load('likes.src', 'all') || 'all') : 'all';
  const favs = src === 'sc' ? all.filter((t) => scIds.has(t.id)) : src === 'local' ? all.filter((t) => !scIds.has(t.id)) : all;
  const tabs = showTabs
    ? `<div class="likes-src" role="tablist">${[['all', 'All', all.length], ['sc', 'SoundCloud', scCount], ['local', 'noxx', all.length - scCount]]
      .map(([k, label, n]) => `<button role="tab" class="likes-src-btn${src === k ? ' on' : ''}" data-src="${k}" aria-selected="${src === k}">${label}<span>${n}</span></button>`).join('')}</div>`
    : '';
  const note = state.status.loggedIn
    ? ` · synced with SoundCloud <button class="sync-mini" data-a="sync" title="Sync likes now" aria-label="Sync likes now">${ICON.sync}</button>`
    : ' · saved in noxx';
  const head = add(`<div class="head-row"><div><div class="page-title">Likes</div>
    <div class="page-sub">${plural(favs.length, 'track')} · ${totalTime(favs)}${note}</div>${tabs}</div>
    <div class="actions">${listActions()}</div></div>`);
  head.querySelectorAll('[data-src]').forEach((b) => { b.onclick = () => { store('likes.src', b.dataset.src); render(true); }; });
  wireActions(head, favs, { sync: () => syncLikes(true) });
  if (!favs.length && all.length) {
    emptyMsg(src === 'sc' ? 'No SoundCloud likes yet. Heart a SoundCloud track while signed in.' : 'No noxx-only likes. Hearts on YouTube tracks, or on anything while signed out, land here.');
    return;
  }
  if (!favs.length) {
    if (state.status.loggedIn) emptyMsg('No likes yet. Syncing with SoundCloud…');
    else emptyMsg('No liked tracks yet. Click the heart on any song, or connect SoundCloud.', 'Connect SoundCloud', () => connectDialog(false));
    return;
  }
  toolList({ kind: 'likes' }, favs, { hideFav: true }); // every row here is liked; no heart badge needed
}

function renderPlaylists() {
  const head = add(`<div class="head-row"><div><div class="page-title">Playlists</div>
    <div class="page-sub">${plural(state.library.playlists.length + state.scPlaylists.length, 'playlist')}</div></div>
    <div class="actions"><button class="btn primary" data-a="new">${ICON.plus}New playlist</button></div></div>`);
  head.querySelector('[data-a=new]').onclick = newPlaylist;
  const card = (cover, icon, a, b, data) => `<button class="card" ${data}><div class="c" style="${bg(cover)}">${cover ? '' : icon}</div><div class="a">${esc(a)}</div><div class="b">${esc(b)}</div></button>`;

  add(`<div class="section-title">${ICON.music}Your playlists</div>`);
  if (state.library.playlists.length) {
    const grid = add('<div class="cards"></div>');
    grid.innerHTML = state.library.playlists.map((p) => card(mid(p.tracks[0]?.artwork), ICON.music, p.name, plural(p.tracks.length, 'track'), `data-go="local" data-id="${esc(p.id)}"`)).join('');
    grid.addEventListener('click', (e) => { const b = e.target.closest('[data-go]'); if (b) go(b.dataset.go, b.dataset.id); });
  } else {
    add('<div class="page-sub">None yet. Make one with “New playlist” or the ⋯ menu on any track.</div>');
  }

  add(`<div class="section-title">${ICON.cloud}From SoundCloud</div>`);
  if (!state.status.loggedIn) { emptyMsg('Connect SoundCloud to see your playlists.', 'Connect SoundCloud', () => connectDialog(false)); return; }
  if (!state.scPlaylists.length) { add('<div class="page-sub">No SoundCloud playlists.</div>'); return; }
  const grid = add('<div class="cards"></div>');
  grid.innerHTML = state.scPlaylists.map((p) => card(art(p.artwork, 180), ICON.cloud, p.title, plural(p.trackCount, 'track'), `data-go="sc" data-id="${esc(p.id)}"`)).join('');
  grid.addEventListener('click', (e) => { const b = e.target.closest('[data-go]'); if (b) go(b.dataset.go, b.dataset.id); });
}

async function newPlaylist() {
  const name = await askText('New playlist', 'Name', '');
  if (name == null) return;
  const p = await invoke('playlist_create', { name });
  await reloadLibrary();
  go('local', p.id);
}

async function renderScPlaylist(token) {
  const id = state.arg;
  const meta = state.scPlaylists.find((p) => p.id === id) || { title: 'Playlist', trackCount: 0, artwork: '' };
  let tracks = state.scCache.get(id);
  const head = hero({ kicker: 'SoundCloud playlist', title: meta.title, cover: meta.artwork, icon: ICON.cloud, sub: plural(meta.trackCount, 'track'), actions: listActions(`<button class="btn outline" data-a="save">Save a copy</button>`) });
  if (!tracks) {
    const sp = spinner();
    try { tracks = await invoke('sc_playlist_tracks', { id }); } catch (e) { if (!stale(token)) { sp.remove(); emptyMsg(errText(e)); } return; }
    state.scCache.set(id, tracks);
    if (stale(token)) return;
    sp.remove();
  }
  head.querySelector('.page-sub').textContent = `${plural(tracks.length, 'track')} · ${totalTime(tracks)}`;
  wireActions(head, tracks, {
    save: async () => {
      const p = await invoke('playlist_create', { name: meta.title });
      for (const t of tracks) await invoke('playlist_add', { id: p.id, track: t });
      await reloadLibrary();
      toast(`Saved “${meta.title}” to your playlists`);
    },
  });
  if (!tracks.length) { emptyMsg('This playlist is empty.'); return; }
  toolList({ kind: 'sc', id }, tracks);
}

function renderLocalPlaylist() {
  const p = state.library.playlists.find((x) => x.id === state.arg);
  if (!p) { emptyMsg('Playlist not found.'); return; }
  const tracks = p.tracks;
  const head = hero({
    kicker: 'Playlist', title: p.name, cover: mid(tracks[0]?.artwork), icon: ICON.music,
    sub: `${plural(tracks.length, 'track')} · ${totalTime(tracks)}`,
    actions: listActions(`<button class="btn outline" data-a="rename">Rename</button><button class="btn outline" data-a="delete">Delete</button>`),
  });
  wireActions(head, tracks, {
    rename: async () => {
      const name = await askText('Rename playlist', 'Name', p.name);
      if (!name) return;
      await invoke('playlist_rename', { id: p.id, name });
      await reloadLibrary();
      render(true);
    },
    delete: async () => {
      if (!(await confirmBox('Delete playlist?', `“${p.name}” will be removed.`, 'Delete'))) return;
      await invoke('playlist_delete', { id: p.id });
      await reloadLibrary();
      go('playlists');
    },
  });
  if (!tracks.length) { emptyMsg('Add tracks with the ⋯ menu on any song.'); return; }
  const onRemove = async (i) => {
    await invoke('playlist_remove', { id: p.id, trackId: tracks[i].id });
    await reloadLibrary();
    render(true);
  };
  toolList({ kind: 'local', id: p.id }, tracks, { removable: true, onRemove });
}

function upcoming(limit) {
  const out = player.userQueue.slice(0, limit);
  for (let p = player.pos + 1; p < player.order.length && out.length < limit; p++) out.push(player.context[player.order[p]]);
  return out;
}

function renderQueue() {
  add(`<div class="page-title">Queue</div><div class="page-sub">${player.current ? '' : 'Nothing playing'}</div>`);
  if (!player.current && !player.userQueue.length) { emptyMsg('Play something and it shows up here.'); return; }
  if (player.current) {
    add('<div class="section-title">Now playing</div>');
    trackList(view, [player.current], { onPlay: () => togglePlay() });
  }
  if (player.userQueue.length) {
    const q = player.userQueue;
    const h = add(`<div class="section-title" style="justify-content:space-between">Next in queue <button class="btn outline" data-a="clear">Clear</button></div>`);
    h.querySelector('[data-a=clear]').onclick = () => { q.length = 0; queueChanged(); };
    trackList(view, q, {
      removable: true,
      onRemove: (i) => { q.splice(i, 1); queueChanged(); },
      onPlay: (i) => { const [t] = q.splice(i, 1); playTrack(t); },
    });
  }
  const rest = [];
  for (let p = player.pos + 1; p < player.order.length && rest.length < 300; p++) rest.push(player.context[player.order[p]]);
  if (rest.length) {
    add('<div class="section-title">Next up</div>');
    trackList(view, rest, { onPlay: (i) => { player.pos += i + 1; playTrack(player.context[player.order[player.pos]]); } });
  }
}

// ---------------------------------------------------------------- settings (riff's tabbed layout)

// riff.settingsRow: building blocks with riff's m3-group / setting-item look (th-* styles in features/themes.css).
// Rows are created detached; group(rows) appends them to the open settings tab.
const SET_CHEVRON = '<svg class="th-dd-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>';
const SET = {
  group(rows, cls = '') {
    const g = el(`<div class="th-group set-group${cls ? ' ' + cls : ''}"></div>`);
    [].concat(rows).flat().filter(Boolean).forEach((r) => g.append(r));
    (addTarget || view).append(g);
    return g;
  },
  /** A row: name (+ optional desc) on the left, `side` (node or html) on the right. */
  row(name, desc = '', side = null) {
    const r = el(`<div class="th-item setting-item"><div class="th-top"><div class="th-col"><span class="th-name">${esc(name)}</span>${desc ? `<span class="th-desc">${esc(desc)}</span>` : ''}</div></div></div>`);
    if (side) r.firstElementChild.append(typeof side === 'string' ? el(side) : side);
    return r;
  },
  toggle({ name, desc = '', get, set }) {
    const sw = makeSwitch(!!get(), (on) => set(on), { label: name });
    return SET.row(name, desc, sw);
  },
  /** Switch stored in riff.pref(key); onChange(on) runs after saving. */
  prefToggle(key, fallback, name, desc = '', onChange) {
    return SET.toggle({ name, desc, get: () => pref(key, fallback), set: (on) => { setPref(key, on); if (onChange) onChange(on); } });
  },
  /** riff's pill slider. onInput(v) while dragging, onChange(v) on release. reset: value for a Reset button. */
  slider({ name, desc = '', min, max, step = 1, value, format = (v) => String(v), hints, onInput, onChange, reset }) {
    const r = el(`<div class="th-item setting-item"><div class="th-top"><div class="th-col"><span class="th-name">${esc(name)}</span>${desc ? `<span class="th-desc">${esc(desc)}</span>` : ''}</div>
      <span class="th-side">${reset != null ? '<button type="button" class="th-mini" data-reset>Reset</button>' : ''}<span class="th-val"></span></span></div>
      <div class="th-sl"><div class="th-sl-on"></div><div class="th-sl-off"></div><input type="range" min="${min}" max="${max}" step="${step}" aria-label="${esc(name)}"></div>
      ${hints ? `<div class="th-hints">${hints.map((h) => `<span>${esc(h)}</span>`).join('')}</div>` : ''}</div>`);
    const input = r.querySelector('input'), label = r.querySelector('.th-val');
    const sync = () => {
      input.parentElement.style.setProperty('--v', max > min ? (+input.value - min) / (max - min) : 0);
      label.textContent = format(+input.value);
    };
    input.value = value;
    sync();
    input.addEventListener('input', () => { sync(); if (onInput) onInput(+input.value); });
    input.addEventListener('change', () => { if (onChange) onChange(+input.value); });
    r.querySelector('[data-reset]')?.addEventListener('click', () => {
      input.value = reset; sync();
      if (onInput) onInput(+input.value);
      if (onChange) onChange(+input.value);
    });
    r.setValue = (v) => { input.value = v; sync(); };
    return r;
  },
  /** riff's m3 dropdown. options: [[value, label], ...] */
  select({ name, desc = '', options, value, onChange }) {
    const r = el(`<div class="th-item setting-item"><div class="th-top"><div class="th-col"><span class="th-name">${esc(name)}</span>${desc ? `<span class="th-desc">${esc(desc)}</span>` : ''}</div></div>
      <div class="th-dd"><button type="button" class="th-dd-trigger"><span data-label></span>${SET_CHEVRON}</button>
      <div class="th-dd-menu">${options.map(([v, l]) => `<button type="button" class="th-dd-opt" data-v="${esc(v)}">${esc(l)}</button>`).join('')}</div></div></div>`);
    const dd = r.querySelector('.th-dd');
    const show = (v) => {
      const o = options.find(([x]) => String(x) === String(v)) || options[0];
      r.querySelector('[data-label]').textContent = o ? o[1] : '';
      dd.querySelectorAll('.th-dd-opt').forEach((b) => b.classList.toggle('selected', o && b.dataset.v === String(o[0])));
    };
    show(value);
    dd.querySelector('.th-dd-trigger').addEventListener('click', (e) => {
      e.stopPropagation();
      document.querySelectorAll('.th-dd.open').forEach((d) => { if (d !== dd) d.classList.remove('open'); });
      dd.classList.toggle('open');
    });
    dd.querySelector('.th-dd-menu').addEventListener('click', (e) => {
      const b = e.target.closest('.th-dd-opt');
      if (!b) return;
      e.stopPropagation();
      dd.classList.remove('open');
      show(b.dataset.v);
      onChange(b.dataset.v);
    });
    r.setValue = show;
    return r;
  },
  /** Row with a pill button on the right. */
  button({ name, desc = '', label, primary = false, onClick }) {
    const b = el(`<button type="button" class="btn ${primary ? 'primary' : 'outline'} set-btn">${esc(label)}</button>`);
    b.addEventListener('click', onClick);
    return SET.row(name, desc, b);
  },
};
document.addEventListener('click', (e) => {
  if (!e.target.closest || !e.target.closest('.th-dd')) document.querySelectorAll('.th-dd.open').forEach((d) => d.classList.remove('open'));
});

// ---- preferences that change the core look (riff's Interface / Tracks / Advanced toggles)

function applyUiScale(v = pref('uiScale', 100)) {
  // 100% is riff's own 0.9 base zoom (1.0 on phones, where the layout is already compact).
  const base = window.noxxAndroid ? 1 : 0.9;
  document.documentElement.style.setProperty('--app-zoom', String(+(base * v / 100).toFixed(4)));
  requestAnimationFrame(() => {
    window.dispatchEvent(new Event('resize'));
    sizeWave(); redrawLists(); fitMarquee(); updateNavIndicator(false); fitSearchBox();
  });
}
function applySearchPos() {
  const tn = $('.top-nav');
  tn.classList.remove('search-pos-left', 'search-pos-middle', 'search-pos-right');
  tn.classList.add(`search-pos-${pref('searchPos', 'middle')}`);
}
function applyBodyPrefs() {
  const b = document.body.classList;
  b.toggle('compact-engine-btns', !!pref('compactEngine', false));
  b.toggle('hide-engine-btns', !!pref('hideEngine', false));
  b.toggle('no-hand-cursor', !!pref('noHandCursor', true));
  motion.perf = !!pref('perfMode', IS_WEBKITGTK);
  b.toggle('perf', motion.perf);
  b.toggle('reduce-motion', !!pref('reduceMotion', false));
  b.toggle('hide-local-tab', !pref('showLocal', true));
  b.toggle('no-home-ambient', !pref('homeAmbient', true));
  if (!pref('showLocal', true) && state.view === 'files') go('home');
  requestAnimationFrame(() => { fitSearchBox(); updateNavIndicator(false); });
}
function applyPrefs() {
  applyUiScale();
  applySearchPos();
  applyBodyPrefs();
}

function setPlatform(id) {
  if (!searchProviders.some((p) => p.id === id) || id === state.platform) return;
  state.platform = id;
  store('platform', id);
  renderPlatformSwitch();
  emit('platform', id);
  if (state.search.query) runSearch(state.search.query);
}

// ---- shortcuts, diagnostics

const SHORTCUTS = [
  ['Play / Pause', ['Space']],
  ['Back / Forward', ['Alt', '←', '/', '→']],
  ['Next / Previous', ['Ctrl', '→', '/', '←']],
  ['Seek ±5s', ['→', '/', '←']],
  ['Volume ±5%', ['Ctrl', '↑', '/', '↓']],
  ['Mute / Unmute', ['M']],
  ['Shuffle', ['H']],
  ['Repeat', ['R']],
  ['Search', ['/', 'or', 'Ctrl', 'F']],
  ['Close / Blur', ['Esc']],
];
function openShortcuts() {
  const keys = (list) => list.map((k, i) => (k === '/' && i > 0 && i < list.length - 1) || k === 'or'
    ? `<span class="kc-sep">${k === 'or' ? 'or' : '/'}</span>`
    : `${i > 0 && list[i - 1] !== '/' && list[i - 1] !== 'or' ? '<span class="kc-sep">+</span>' : ''}<span class="keycap${k.length > 1 ? ' wide' : ''}">${esc(k)}</span>`).join('');
  const m = openModal(`<div class="sc-head"><h3>Keyboard shortcuts</h3><button class="pill-btn" data-close title="Close">${ICON.close}</button></div>
    <div class="sc-list">${SHORTCUTS.map(([n, k]) => `<div class="sc-row"><span>${esc(n)}</span><div class="sc-keys">${keys(k)}</div></div>`).join('')}</div>`);
  m.classList.add('shortcuts-modal');
  m.querySelector('[data-close]').onclick = closeModal;
}

async function diagnosticsText() {
  let info = {};
  try { info = await window.riff.call('about.info'); } catch (e) {}
  let tail = '';
  try { tail = await window.riff.call('about.log_tail', { lines: 40 }); } catch (e) {}
  const ua = navigator.userAgent;
  const edge = (ua.match(/Edg\/([\d.]+)/) || [])[1] || '?';
  const s = state.status;
  const lines = [
    `${info.name || 'noxx'} ${info.version || '?'} (${info.os || '?'} ${info.arch || ''})`,
    `WebView2 ${edge} · screen ${screen.width}x${screen.height} @${window.devicePixelRatio} · zoom ${uiZoom().toFixed(3)}`,
    `SoundCloud: ${s.loggedIn ? (s.expired ? 'session expired' : 'connected') : 'not connected'}`,
    `Library: ${state.library.favorites.length} liked, ${state.library.playlists.length} playlists, ${state.scPlaylists.length} SoundCloud playlists`,
    `View: ${state.view} · search engine: ${state.platform} · playing: ${player.current ? `${player.current.source || 'soundcloud'} ${audio.paused ? '(paused)' : ''}` : 'nothing'}`,
    `Features: ${Object.keys(ext.views).join(', ')}`,
    `Prefs: ${JSON.stringify(prefs)}`,
    '',
    '--- recent log ---',
    tail || '(empty)',
  ];
  return lines.join('\n');
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch (e) {}
  const ta = el('<textarea style="position:fixed;opacity:0"></textarea>');
  ta.value = text;
  document.body.append(ta);
  ta.select();
  const ok = document.execCommand('copy');
  ta.remove();
  return ok;
}

// ---- tabs

const SETTINGS_CATS = [
  ['interface', 'Interface', svg('<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><line x1="3" x2="21" y1="9" y2="9"/><line x1="9" x2="9" y1="21" y2="9"/>')],
  ['theme', 'Theme', svg('<circle cx="13.5" cy="6.5" r=".5"/><circle cx="17.5" cy="10.5" r=".5"/><circle cx="8.5" cy="7.5" r=".5"/><circle cx="6.5" cy="12.5" r=".5"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.9 0 1.7-.8 1.7-1.7 0-.4-.2-.8-.4-1.1-.3-.3-.4-.7-.4-1.1 0-.9.8-1.7 1.7-1.7H16c3.3 0 6-2.7 6-6 0-4.9-4.5-8.4-10-8.4z"/>')],
  ['banners', 'Banners', svg('<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>')],
  ['tracks', 'Tracks', svg('<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>')],
  ['integrations', 'Integrations', svg('<path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/>')],
  ['storage', 'Storage', svg('<line x1="22" x2="2" y1="12" y2="12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/><line x1="6" x2="6.01" y1="16" y2="16"/><line x1="10" x2="10.01" y1="16" y2="16"/>')],
  ['advanced', 'Advanced', svg('<line x1="21" x2="14" y1="4" y2="4"/><line x1="10" x2="3" y1="4" y2="4"/><line x1="21" x2="12" y1="12" y2="12"/><line x1="8" x2="3" y1="12" y2="12"/><line x1="21" x2="16" y1="20" y2="20"/><line x1="12" x2="3" y1="20" y2="20"/><line x1="14" x2="14" y1="2" y2="6"/><line x1="8" x2="8" y1="10" y2="14"/><line x1="16" x2="16" y1="18" y2="22"/>')],
  ['about', 'About', svg('<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>')],
  ['custom-themes', 'Custom themes', svg('<circle cx="13.5" cy="6.5" r=".5"/><circle cx="17.5" cy="10.5" r=".5"/><circle cx="8.5" cy="7.5" r=".5"/><circle cx="6.5" cy="12.5" r=".5"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.9 0 1.7-.8 1.7-1.7 0-.4-.2-.8-.4-1.1-.3-.3-.4-.7-.4-1.1 0-.9.8-1.7 1.7-1.7H16c3.3 0 6-2.7 6-6 0-4.9-4.5-8.4-10-8.4z"/>')],
  ['plugins', 'Plugins', svg('<path d="M20.5 11H19V7c0-1.1-.9-2-2-2h-4V3.5C13 2.12 11.88 1 10.5 1S8 2.12 8 3.5V5H4c-1.1 0-1.99.9-1.99 2v3.8H3.5c1.49 0 2.7 1.21 2.7 2.7s-1.21 2.7-2.7 2.7H2V20c0 1.1.9 2 2 2h3.8v-1.5c0-1.49 1.21-2.7 2.7-2.7 1.49 0 2.7 1.21 2.7 2.7V22H17c1.1 0 2-.9 2-2v-4h1.5c1.38 0 2.5-1.12 2.5-2.5S21.88 11 20.5 11z"/>', true)],
];
const SETTINGS_CAT_IDS = new Set(SETTINGS_CATS.map(([c]) => c));
let settingsCat = load('settingsCat', 'interface');

// Core rows per tab: `before` runs ahead of the feature rows, `after` behind them.
const coreSettings = {
  interface: {
    before() {
      SET.group([
        SET.slider({ name: 'UI scale', min: 80, max: 130, step: 5, value: pref('uiScale', 100), format: (v) => `${v}%`, hints: ['Compact', 'Default', 'Large'],
          onChange: (v) => { setPref('uiScale', v); applyUiScale(v); } }),
        SET.select({ name: 'Position of searchbar', options: [['left', 'Left'], ['middle', 'Middle'], ['right', 'Right']], value: pref('searchPos', 'middle'),
          onChange: (v) => { setPref('searchPos', v); applySearchPos(); } }),
        searchProviders.length > 1 && SET.select({ name: 'Search engine', options: searchProviders.map((p) => [p.id, p.label]), value: state.platform, onChange: setPlatform }),
        searchProviders.length > 1 && SET.prefToggle('compactEngine', false, 'Compact engine buttons', 'Show only icons for YouTube, YouTube Music, and SoundCloud in the top bar', applyBodyPrefs),
        searchProviders.length > 1 && SET.prefToggle('hideEngine', false, 'Hide engine buttons', 'Hide search engine buttons from the top bar', applyBodyPrefs),
        SET.prefToggle('noHandCursor', true, 'No-Hand cursor', 'Replaces the hand and grab cursors with the normal arrow', applyBodyPrefs),
        SET.prefToggle('autoplay', true, 'Autoplay', 'When your queue ends, keep playing similar songs instead of stopping'),
        SET.prefToggle('dockedShell', true, 'Docked layout', 'Side bar and player bar sit flush against the window edges', applyShellPrefs),
        SET.select({ name: 'Side bar', options: [['icons', 'Icons only'], ['normal', 'Icons and labels'], ['wide', 'Your Library']], value: railLib.mode,
          onChange: (v) => setRailWidth(v === 'icons' ? RAIL_W.icons : v === 'normal' ? RAIL_W.normal : pref('railWideWidth', 320), true) }),
        SET.toggle({ name: 'Shaped cover in the bottom bar', desc: 'Morphing Material 3 shape with a wavy progress ring around the cover', get: () => cover.on, set: (on) => setM3Cover(on) }),
      ]);
    },
    after() {
      SET.group([
        SET.prefToggle('perfMode', IS_WEBKITGTK, 'Performance mode', 'Disables visualizers, animated gradient and blur effects, limits animations to 30 FPS', applyBodyPrefs),
      ]);
    },
  },
  tracks: {
    before() {
      SET.group([
        SET.prefToggle('searchArtists', true, 'Show artists in search'),
        SET.prefToggle('showLocal', true, 'Show My files tab', '', applyBodyPrefs),
      ]);
    },
  },
  integrations: {
    before() {
      const s = state.status;
      add('<div class="section-title">SoundCloud</div>');
      const card = add(`<div class="set-card"><div class="av" style="${bg(s.avatar)}"></div><div class="i">
        <div class="a">${esc(s.loggedIn ? displayName(s.username) : 'Not connected')}</div>
        <div class="b${s.expired ? ' warn' : ''}">${s.loggedIn ? (s.expired ? 'Session expired. Reconnect to load private playlists and likes.' : 'Connected. Likes sync on launch and every 30 minutes.') : 'Connect to bring in your likes and playlists.'}</div></div>
        <div class="actions">${s.loggedIn
          ? `<button class="btn outline" data-a="sync">${ICON.sync}Sync likes</button><button class="btn ${s.expired ? 'primary' : 'outline'}" data-a="reconnect">Reconnect</button><button class="btn outline" data-a="logout">Disconnect</button>`
          : '<button class="btn primary" data-a="connect">Connect</button>'}</div></div>`);
      card.addEventListener('click', (e) => {
        const a = e.target.closest('[data-a]')?.dataset.a;
        if (a === 'sync') syncLikes(true);
        else if (a === 'reconnect') connectDialog(true);
        else if (a === 'logout') logout();
        else if (a === 'connect') connectDialog(false);
      });
    },
  },
  storage: {
    before() {
      add('<div class="section-title">Library</div>');
      add(`<div class="set-card"><div class="i"><div class="a">${plural(state.library.favorites.length, 'liked track')} · ${plural(state.library.playlists.length, 'playlist')}</div>
        <div class="b">Tracks you heart here stay, even if they aren't liked on SoundCloud.</div></div></div>`);
    },
  },
  advanced: {
    after() {
      const homeRender = () => { if (['home', 'discover', 'search'].includes(state.view)) render(true); };
      SET.group([
        SET.prefToggle('albums', true, 'Albums', 'Shows albums in search results'),
        SET.prefToggle('homeAmbient', true, 'Ambient light on home page', 'Display colored glow behind the recommendation card', applyBodyPrefs),
        SET.prefToggle('myWave', true, 'My Wave recommendations', 'Show personal recommendations on the Discover page', homeRender),
        SET.prefToggle('jumpBack', true, 'Jump back in', 'Recently played tracks on the home page', homeRender),
        SET.prefToggle('reduceMotion', false, 'Reduce motion', 'Replace spring animations with simple fades', applyBodyPrefs),
      ]);
    },
  },
  about: {
    before() {
      const appRow = el(`<div class="th-item setting-item"><div class="th-top"><div class="about-app"><span class="about-logo"><img src="assets/noxx-mark.svg" alt="" class="noxx-logo-img"></span>
        <div class="th-col"><span class="th-name">Music player</span><span class="th-desc" data-ver>Version …</span></div></div></div></div>`);
      SET.group([
        appRow,
        SET.button({ name: 'Keyboard shortcuts', label: 'Keyboard shortcuts', onClick: openShortcuts }),
        SET.button({ name: 'Diagnostics', label: 'Copy diagnostics', onClick: async () => { toast((await copyText(await diagnosticsText())) ? 'Diagnostics copied' : 'Couldn\'t copy', 'info'); } }),
        SET.button({ name: 'Logs', label: 'Open logs folder', onClick: () => window.riff.call('about.open_logs').catch((e) => toast(errText(e), 'error')) }),
      ]);
      const credits = add('<div class="settings-credits"><span class="settings-credits-text">Built in Rust.</span><span class="settings-version-tag" data-ver-tag></span></div>');
      window.riff.call('about.info').then((i) => {
        appRow.querySelector('[data-ver]').textContent = `Version ${i.version}`;
        credits.querySelector('[data-ver-tag]').textContent = `v${i.version}`;
      }).catch(() => {});
    },
  },
};

function renderSettings(token, arg) {
  if (arg && SETTINGS_CAT_IDS.has(arg)) settingsCat = arg;
  if (!SETTINGS_CAT_IDS.has(settingsCat)) settingsCat = 'interface';
  add('<div class="page-title settings-title">Settings</div>');
  const layout = add(`<div class="settings-layout"><nav class="settings-nav">${SETTINGS_CATS.map(([c, l, i]) => `<button type="button" class="settings-nav-btn" data-cat="${c}">${i}<span>${l}</span></button>`).join('')}</nav>
    <div class="settings-pane"></div></div>`);
  const nav = layout.querySelector('.settings-nav'), pane = layout.querySelector('.settings-pane');
  nav.addEventListener('click', (e) => {
    const b = e.target.closest('[data-cat]');
    if (!b || b.dataset.cat === settingsCat) return;
    settingsCat = b.dataset.cat;
    store('settingsCat', settingsCat);
    renderSettingsPane(nav, pane, true);
  });
  renderSettingsPane(nav, pane, false);
}

function renderSettingsPane(nav, pane, animate) {
  const cat = settingsCat;
  nav.querySelectorAll('[data-cat]').forEach((b) => b.classList.toggle('active', b.dataset.cat === cat));
  pane.innerHTML = '';
  pane.dataset.cat = cat;
  const core = coreSettings[cat] || {};
  const run = (fn) => { try { fn(pane); } catch (e) { log('error', `settings ${cat}: ${errText(e)}`); } };
  const prev = addTarget;
  addTarget = pane;
  try {
    if (core.before) run(core.before);
    for (const s of ext.settings) if (s.cat === cat) run(s.fn);
    if (core.after) run(core.after);
  } finally { addTarget = prev; }
  if (!pane.childElementCount) pane.append(el('<div class="empty"><div>Nothing here yet.</div></div>'));
  if (animate) {
    view.scrollTop = 0;
    pane.classList.remove('settings-in');
    void pane.offsetWidth;
    pane.classList.add('settings-in');
  }
  emit('settings-tab', cat);
}

// ---------------------------------------------------------------- favorites

async function toggleFavorite(t) {
  if (!t) return;
  const on = await invoke('toggle_favorite', { track: t });
  const favs = state.library.favorites;
  if (on) favs.unshift(t); else { const i = favs.findIndex((x) => x.id === t.id); if (i >= 0) favs.splice(i, 1); }
  setLibrary(state.library);
  updateHeart();
  if (state.view === 'likes') render(true); else redrawLists();
}

// ---------------------------------------------------------------- player

const audio = new Audio();
audio.preload = 'auto';
let hls = null;

const player = {
  context: [],
  order: [],
  pos: -1,
  userQueue: [],
  current: null,
  shuffle: load('shuffle', false),
  repeat: load('repeat', 'off'),
  loadToken: 0,
  retries: 0,
  errorStreak: 0,
  prefetched: '',
};

function queueChanged() {
  setBadge('#badge-queue', player.userQueue.length);
  renderUpNext();
  if (state.view === 'queue') render(true);
}

function buildOrder(startIdx) {
  const n = player.context.length;
  const order = [...Array(n).keys()];
  if (player.shuffle) {
    for (let i = n - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    const at = order.indexOf(startIdx);
    if (at > 0) { order.splice(at, 1); order.unshift(startIdx); }
    player.order = order;
    player.pos = 0;
  } else {
    player.order = order;
    player.pos = startIdx;
  }
}

function playList(tracks, i, shuffle) {
  if (shuffle !== undefined) setShuffle(!!shuffle, true);
  player.context = tracks.slice();
  buildOrder(i);
  playTrack(player.context[i]);
}

function destroyHls() {
  if (hls) { try { hls.destroy(); } catch (e) {} hls = null; }
}

function setLoading(on) { $('#btn-play').classList.toggle('loading', on); }

async function playTrack(t, startAt = 0, fresh = false) {
  if (!t) return;
  const token = ++player.loadToken;
  if (!fresh) player.retries = 0;
  player.current = t;
  player.prefetched = '';
  xfadeReset();
  updateNowPlaying();
  setLoading(true);
  destroyHls();
  audio.pause();
  let s = null;
  // A source that never answers must not leave the player stuck: give up after 15 s and move on.
  const started = performance.now();
  let stage = 'resolver';
  const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error(`no stream after 15 s (${stage})`)), 15000));
  try {
    s = await Promise.race([(async () => {
      for (const r of ext.streamResolvers) { stage = r.label || 'resolver'; const x = await r(t, fresh); if (x) return x; }
      stage = 'stream_url';
      return invoke('stream_url', { id: t.id, fresh });
    })(), timeout]);
    const took = performance.now() - started;
    if (took > 4000) log('warn', `slow stream for ${t.id} "${t.title}": ${Math.round(took)} ms (${stage})`);
  } catch (e) {
    if (token === player.loadToken) log('error', `stream failed for ${t.id} "${t.title}": ${errText(e)}`);
    if (token !== player.loadToken) return;
    setLoading(false);
    toast(`${t.title}: ${errText(e)}`, 'error');
    if (++player.errorStreak < 4) setTimeout(() => { if (token === player.loadToken) next(false); }, 900);
    return;
  }
  if (token !== player.loadToken) return;
  log('info', `play ${t.id} "${t.title}" via ${s.protocol} ${s.preset}`);
  attach(s, startAt);
}

function attach(s, startAt) {
  player.stream = s;
  if (s.protocol === 'hls') {
    if (!window.Hls || !Hls.isSupported()) { toast('HLS playback is not supported here', 'error'); setLoading(false); return; }
    // Small buffers: 30 s ahead, 10 s behind, at most 12 MB (audio only, so that's plenty).
    hls = new Hls({ enableWorker: true, startPosition: startAt > 0 ? startAt : -1, maxBufferLength: 30, maxMaxBufferLength: 60, maxBufferSize: 12 * 1000 * 1000, backBufferLength: 10 });
    hls.on(Hls.Events.ERROR, (_, d) => { if (d.fatal) recover(); });
    hls.loadSource(s.url);
    hls.attachMedia(audio);
  } else {
    audio.src = s.url;
    if (startAt > 0) audio.addEventListener('loadedmetadata', () => { audio.currentTime = startAt; }, { once: true });
  }
  audio.play().catch(() => {});
}

// Stream links expire; on a fatal error grab a fresh one and resume where we were.
function recover() {
  const t = player.current;
  if (!t) return;
  if (player.retries >= 2) { toast(`Couldn't keep playing ${t.title}`, 'error'); setLoading(false); return; }
  player.retries++;
  playTrack(t, audio.currentTime || 0, true);
}
audio.addEventListener('error', () => { if (!hls && audio.src) recover(); });

function peekNext() {
  if (player.userQueue.length) return player.userQueue[0];
  if (player.pos + 1 < player.order.length) return player.context[player.order[player.pos + 1]];
  if (player.repeat === 'all' && player.order.length) return player.context[player.order[0]];
  return null;
}

// ---------------------------------------------------------------- keep playing when the queue runs out
// Features register providers (riff.addContinuation): async (seeds, avoidIds) -> tracks. They run in
// order until one returns songs; trending is the last resort. On by default (Settings: "Autoplay").
const continuing = { busy: null, failedFor: '' };
async function continueQueue(play) {
  if (!pref('autoplay', true) || !player.current) return false;
  if (continuing.busy) return continuing.busy;
  continuing.busy = (async () => {
    const recent = [];
    for (let p = player.pos; p >= 0 && recent.length < 6; p--) { const t = player.context[player.order[p]]; if (t) recent.push(t); }
    if (!recent.length) recent.push(player.current);
    const have = new Set(player.context.map((t) => t.id));
    const fresh = (list) => (list || []).filter((t) => t && t.id && !have.has(t.id) && !isBlocked(t) && (have.add(t.id), true));
    let found = [];
    for (const fn of ext.continuations) {
      try { found = fresh(await fn(recent, [...have])); } catch (e) { log('warn', `autoplay: ${fn.label || 'provider'} failed: ${errText(e)}`); found = []; }
      if (found.length) break;
      log('warn', `autoplay: ${fn.label || 'provider'} found nothing for "${player.current?.title}"`);
    }
    if (!found.length) {
      try { if (!state.trending) state.trending = await invoke('trending'); } catch (e) { log('warn', `autoplay: trending failed: ${errText(e)}`); }
      found = fresh(state.trending || []).slice(0, 20);
      if (found.length) log('warn', 'autoplay: fell back to trending');
    }
    if (!found.length) { log('error', 'autoplay: nothing to continue with'); return false; }
    for (const t of found) { player.order.push(player.context.length); player.context.push(t); }
    queueChanged();
    if (play && player.pos + 1 < player.order.length) { player.pos++; playTrack(player.context[player.order[player.pos]]); }
    return true;
  })();
  try { return await continuing.busy; } finally { continuing.busy = null; }
}
// Line the continuation up early (when the last song of the queue starts), so the end is seamless.
bus.addEventListener('trackchange', () => { if (!peekNext() && player.repeat === 'off') continueQueue(false); });

function next(auto) {
  if (auto && player.repeat === 'one' && player.current) { audio.currentTime = 0; audio.play().catch(() => {}); return; }
  while (player.userQueue.length && isBlocked(player.userQueue[0])) player.userQueue.shift();
  if (player.userQueue.length) { playTrack(player.userQueue.shift()); queueChanged(); return; }
  // Songs you said never to play are skipped (a whole blocked list just runs on to autoplay).
  let skip = 1;
  while (player.pos + skip < player.order.length && isBlocked(player.context[player.order[player.pos + skip]])) skip++;
  if (player.pos + skip < player.order.length) { player.pos += skip; playTrack(player.context[player.order[player.pos]]); return; }
  if (skip > 1) player.pos += skip - 1;
  if (player.repeat === 'all' && player.order.length) {
    if (player.shuffle) buildOrder(player.order[0]);
    player.pos = 0;
    playTrack(player.context[player.order[0]]);
    return;
  }
  // End of the queue: keep going with similar songs instead of stopping (⏭ works here too).
  continueQueue(true).then((ok) => {
    if (ok) return;
    audio.pause();
    if (!auto) toast('Nothing more to play right now');
  });
}

function prev() {
  if (audio.currentTime > 3 || player.pos <= 0) { audio.currentTime = 0; return; }
  player.pos--;
  playTrack(player.context[player.order[player.pos]]);
}

function togglePlay() {
  if (!player.current) {
    const list = state.view === 'likes' ? state.library.favorites : state.trending || [];
    if (list.length) playList(list, 0);
    return;
  }
  if (audio.paused) audio.play().catch(() => {}); else audio.pause();
}

function setShuffle(on, quiet) {
  if (player.shuffle === on) return;
  player.shuffle = on;
  store('shuffle', on);
  $('#btn-shuffle').classList.toggle('on', on);
  if (!quiet && player.context.length && player.current) {
    const cur = player.context.indexOf(player.current);
    buildOrder(cur >= 0 ? cur : 0);
    renderUpNext();
  }
}

function setRepeat(mode) {
  player.repeat = mode;
  store('repeat', mode);
  const b = $('#btn-repeat');
  b.classList.toggle('on', mode !== 'off');
  b.classList.toggle('one', mode === 'one');
}

function updateHeart() {
  const on = !!player.current && state.favIds.has(player.current.id);
  const b = $('#pb-heart');
  b.classList.toggle('on', on);
  b.innerHTML = on ? ICON.heartFill : ICON.heart;
}

function renderUpNext() {
  const list = upcoming(12);
  const box = $('#rp-next-list');
  box.innerHTML = list.length
    ? list.map((t, i) => `<div class="mini-row" data-i="${i}"><div class="t" style="${bg(small(t.artwork))}"></div><div class="i"><div class="a">${esc(t.title)}</div><div class="b">${esc(t.artist)}</div></div></div>`).join('')
    : '<div class="mini-row" style="cursor:default"><div class="i"><div class="b">Nothing queued</div></div></div>';
}
$('#rp-next-list').addEventListener('click', (e) => {
  const r = e.target.closest('.mini-row[data-i]');
  if (!r) return;
  let i = Number(r.dataset.i);
  if (i < player.userQueue.length) { const [t] = player.userQueue.splice(i, 1); playTrack(t); queueChanged(); return; }
  i -= player.userQueue.length;
  player.pos += i + 1;
  playTrack(player.context[player.order[player.pos]]);
});

function updateNowPlaying() {
  const t = player.current;
  $('#pb-title').firstElementChild.textContent = t ? t.title : 'No track playing';
  $('#pb-artist').firstElementChild.textContent = t ? t.artist : 'Select a track to listen';
  const pbArt = $('#pb-art');
  pbArt.style.backgroundImage = t && t.artwork ? `url('${art(t.artwork, 72)}')` : '';
  pbArt.innerHTML = t && t.artwork ? '' : ICON.music;
  $('#rp-title').textContent = t ? t.title : 'No track playing';
  $('#rp-artist').textContent = t ? t.artist : 'Select a track to listen';
  // Small info line under the artist (genre · source), useful when there are no lyrics.
  let rpInfo = $('#rp-info');
  if (!rpInfo) { rpInfo = el('<div class="rp-info" id="rp-info"></div>'); $('#rp-artist').after(rpInfo); }
  const src = t ? ({ youtube: 'YouTube', local: 'My files' }[t.source] || 'SoundCloud') : '';
  rpInfo.textContent = t ? [t.genre, src].filter(Boolean).join(' · ') : '';
  const rpArt = $('#rp-art');
  rpArt.style.backgroundImage = t && t.artwork ? `url('${art(t.artwork, 220)}')` : '';
  rpArt.classList.toggle('empty', !(t && t.artwork));
  rpArt.innerHTML = t && t.artwork ? '' : ICON.music;
  setCoverArt(t && t.artwork);
  setTrackBackdrops(t && t.artwork);
  fitMarquee();
  $('#t-dur').textContent = fmt(t ? t.duration : 0);
  document.title = t ? `${t.title} · ${t.artist}` : 'Music';
  updateHeart();
  renderUpNext();
  redrawLists();
  emit('trackchange', t);
  if ('mediaSession' in navigator && t) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.title, artist: t.artist,
      artwork: t.artwork ? [{ src: t.artwork, sizes: '500x500', type: 'image/jpeg' }] : [],
    });
  }
}

function setPlayIcon(playing) {
  const b = $('#btn-play');
  b.innerHTML = playing ? ICON.pause : ICON.play;
  b.classList.toggle('is-playing', playing);
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
  kickAnim();
}

// Long titles: fade at the right edge, scroll while the player bar text is hovered (riff's marquee).
function fitMarquee() {
  requestAnimationFrame(() => {
    for (const box of [$('#pb-title'), $('#pb-artist')]) {
      const span = box.firstElementChild;
      const extra = span.scrollWidth - box.clientWidth;
      box.classList.toggle('overflow', extra > 1);
      if (extra > 1) {
        box.style.setProperty('--marquee-dx', `${-(extra + 12)}px`);
        box.style.setProperty('--marquee-t', `${(4 + extra / 25).toFixed(1)}s`);
      }
    }
  });
}

function duration() { return isFinite(audio.duration) && audio.duration > 0 ? audio.duration : (player.current?.duration || 0); }

// ---------------------------------------------------------------- wavy progress bar (riff style)

const wave = $('#wave');
const canvas = $('#wave-canvas');
const ctx = canvas.getContext('2d');
let waveW = 0, waveH = 0, phase = 0, seekFrac = null;

function sizeWave() {
  const k = canvasScale();
  waveW = wave.clientWidth; waveH = wave.clientHeight;   // CSS px, so riff's geometry keeps its size
  canvas.width = Math.round(waveW * k);
  canvas.height = Math.round(waveH * k);
  ctx.setTransform(k, 0, 0, k, 0, 0);
  drawWave();
}

// Same geometry as riff's scrubber: 42px wavelength, 5px amplitude, 9.5px stroke,
// phase advancing 3.5 rad/s while playing (and following the knob while dragging).
const WAVE_K = (2 * Math.PI) / 42;
let wavePrimary = '#ffffff';
function refreshWaveColor() { wavePrimary = getComputedStyle(document.documentElement).getPropertyValue('--primary').trim() || '#ffffff'; drawWave(); drawCover(0); }
bus.addEventListener('theme', () => refreshWaveColor());
const PAD = 5.5;
let shownFrac = 0, knobAnim = 0, lastKnobX = null;

function drawWave(dt = 0) {
  if (!waveW) return;
  const d = duration();
  const target = seekFrac ?? (d ? Math.max(0, Math.min(1, audio.currentTime / d)) : 0);
  const dragging = seekFrac != null;
  shownFrac += (target - shownFrac) * (dt ? Math.min(1, dt * (dragging ? 32 : 45)) : 1);
  // The knob grows while you hover or drag the bar.
  knobAnim += ((dragging || waveHover ? 1 : 0) - knobAnim) * (dt ? Math.min(1, dt * 20) : 1);

  // Straight bar, same language as the cover ring: dotted track for what's left,
  // a solid line with a soft glow for what's played, and a round knob.
  const trackW = waveW - PAD * 2;
  const x = PAD + shownFrac * trackW;
  const mid = waveH / 2;
  const cls = document.body.classList;
  const noKnob = cls.contains('no-knob');
  ctx.clearRect(0, 0, waveW, waveH);
  ctx.lineCap = 'round';

  if (!cls.contains('no-progress-bg') && waveW - PAD > x + 8) {
    ctx.save();
    ctx.globalAlpha = 0.4;
    ctx.strokeStyle = wavePrimary;
    ctx.lineWidth = 3;
    ctx.setLineDash([0.1, 6]);
    ctx.beginPath();
    ctx.moveTo(x + 8, mid);
    ctx.lineTo(waveW - PAD, mid);
    ctx.stroke();
    ctx.restore();
  }
  if (x > PAD + 1) {
    ctx.save();
    ctx.strokeStyle = wavePrimary;
    ctx.lineWidth = 4 + knobAnim;
    ctx.shadowColor = wavePrimary;
    ctx.shadowBlur = 6;
    ctx.globalAlpha = 0.95;
    ctx.beginPath();
    ctx.moveTo(PAD, mid);
    ctx.lineTo(x, mid);
    ctx.stroke();
    ctx.restore();
  }
  if (noKnob) return;
  ctx.fillStyle = wavePrimary;
  ctx.beginPath();
  ctx.arc(x, mid, 5.5 + 2.5 * knobAnim, 0, Math.PI * 2);
  ctx.fill();
}
let waveHover = false;

// ---------------------------------------------------------------- shaped cover (riff's m3 cover)

// The player-bar cover is clipped to one of riff's Material 3 shapes, which slowly turns and morphs
// into the next shape every couple of seconds; a dotted ring around it fills with a wavy line as the
// track plays. Drawn on a 120px canvas (CSS px) only while playing or hovered, at 30 / 60 fps.
const COVER_PX = 70, COVER_CANVAS = 120, RING_GAP = 5, RING_W = 2.4;
const cover = {
  on: load('m3Cover', true),
  canvas: $('#pb-cover-canvas'),
  ctx: null,
  img: null, url: '',
  from: 0, to: 0, start: 0, clock: 0, rot: 0, phase: 0,
  hover: 0, hovered: false,
  fill: '#2b2b2b',
};

function sizeCover() {
  const k = canvasScale();
  cover.canvas.width = Math.round(COVER_CANVAS * k);
  cover.canvas.height = Math.round(COVER_CANVAS * k);
  cover.ctx = cover.canvas.getContext('2d');
  cover.ctx.setTransform(k, 0, 0, k, 0, 0);
  cover.ctx.imageSmoothingQuality = 'high';
}

function setM3Cover(on) {
  cover.on = !!on;
  store('m3Cover', cover.on);
  document.body.classList.toggle('m3-cover-on', cover.on);
  if (cover.on) { sizeCover(); drawCover(0); kickAnim(); }
  else if (cover.ctx) { cover.canvas.width = cover.canvas.height = 1; cover.ctx = null; }
}

function setCoverArt(url) {
  const src = url ? art(url, COVER_PX * 1.25) : '';
  if (src === cover.url) return;
  cover.url = src;
  if (!src) { cover.img = null; drawCover(0); return; }
  loadImage(src).then((img) => {
    if (cover.url !== src) return;
    cover.img = img;
    drawCover(0);
  });
}

function drawCover(dt) {
  const S = window.RiffShapes;
  const c = cover.ctx;
  if (!cover.on || !c || !S || !S.ready()) return;
  // Shape timeline: hold HOLD_MS, then morph MORPH_MS into a new shape. Time only runs while playing.
  if (!audio.paused) { cover.clock += dt * 1000; cover.rot += dt * (Math.PI * 2 / 36); cover.phase += dt * 7.5; }
  if (cover.clock - cover.start >= S.HOLD_MS) { cover.from = cover.to; cover.to = S.next(cover.from); cover.start = cover.clock; }
  const e = S.ease(Math.min(1, (cover.clock - cover.start) / S.MORPH_MS));
  const a = S.profile(cover.from), b = S.profile(cover.to), K = S.K;
  const size = COVER_PX * (1 + cover.hover * 0.16);
  const scale = (size / 2) / 160 * 1.02;
  const cx = COVER_CANVAS / 2, cy = COVER_CANVAS / 2 - cover.hover * 4;
  const rot = cover.rot;
  const radiusAt = (angle) => {
    const f = ((angle + Math.PI) / (Math.PI * 2)) * K;
    const i0 = ((Math.floor(f) % K) + K) % K, i1 = (i0 + 1) % K, w = f - Math.floor(f);
    const r0 = a[i0] + (b[i0] - a[i0]) * e, r1 = a[i1] + (b[i1] - a[i1]) * e;
    return (r0 + (r1 - r0) * w) * scale;
  };

  c.clearRect(0, 0, COVER_CANVAS, COVER_CANVAS);
  c.beginPath();
  for (let k = 0; k <= K; k++) {
    const th = -Math.PI + (Math.PI * 2 * (k % K)) / K;
    const r = radiusAt(th);
    const x = cx + Math.cos(th + rot) * r, y = cy + Math.sin(th + rot) * r;
    if (k === 0) c.moveTo(x, y); else c.lineTo(x, y);
  }
  c.closePath();
  // Soft drop shadow under the shape (riff puts a CSS drop-shadow on the wrapper).
  c.save();
  c.shadowColor = '#00000048';
  c.shadowBlur = 10 + cover.hover * 8;
  c.shadowOffsetY = 4 + cover.hover * 4;
  c.fillStyle = cover.fill;
  c.fill();
  c.restore();
  if (cover.img) {
    c.save();
    c.clip();
    const iw = cover.img.naturalWidth, ih = cover.img.naturalHeight, side = Math.min(iw, ih);
    const d = Math.ceil(size * 1.06);
    c.drawImage(cover.img, (iw - side) / 2, (ih - side) / 2, side, side, cx - d / 2, cy - d / 2, d, d);
    c.restore();
  }

  // Ring: dotted where still to play, a wavy solid line where played.
  const dur = duration();
  const p = seekFrac ?? (dur ? Math.min(1, Math.max(0, audio.currentTime / dur)) : 0);
  const STEPS = 240, startPhi = -Math.PI / 2;
  const ringPoint = (phi, wv) => {
    const r = radiusAt(phi - rot) + RING_GAP + RING_W / 2 + wv;
    return [cx + Math.cos(phi) * r, cy + Math.sin(phi) * r];
  };
  c.lineCap = 'round';
  c.lineJoin = 'round';
  c.lineWidth = RING_W;
  c.strokeStyle = wavePrimary;
  c.setLineDash([0.1, 5.5]);
  c.globalAlpha = 0.4;
  c.beginPath();
  const restFrom = Math.round(p * STEPS);
  for (let s = restFrom; s <= STEPS; s++) {
    const [x, y] = ringPoint(startPhi + (Math.PI * 2 * s) / STEPS, 0);
    if (s === restFrom) c.moveTo(x, y); else c.lineTo(x, y);
  }
  c.stroke();
  c.setLineDash([]);
  c.globalAlpha = 1;
  if (p > 0) {
    c.beginPath();
    const played = Math.max(2, Math.round(p * STEPS));
    for (let s = 0; s <= played; s++) {
      const phi = startPhi + (Math.PI * 2 * s) / STEPS;
      const [x, y] = ringPoint(phi, 0); // smooth played arc (no wave)
      if (s === 0) c.moveTo(x, y); else c.lineTo(x, y);
    }
    c.stroke();
  }
}

const coverBox = $('#pb-cover');
coverBox.addEventListener('mouseenter', () => { cover.hovered = true; kickAnim(); });
coverBox.addEventListener('mouseleave', () => { cover.hovered = false; kickAnim(); });

// ---------------------------------------------------------------- one paced loop for wave + cover

let animPending = 0, lastAnimT = 0;
const coverHoverMoving = () => Math.abs((cover.hovered ? 1 : 0) - cover.hover) > 0.002;
function waveSettling() {
  const d = duration();
  return knobAnim > 0.01 || Math.abs(shownFrac - (d ? audio.currentTime / d : 0)) > 0.001;
}
function animTick(now) {
  animPending = 0;
  if (motion.asleep) { lastAnimT = 0; return; }
  const dt = lastAnimT ? Math.max(0, Math.min(0.1, (now - lastAnimT) / 1000)) : 1 / FPS_PLAYING;
  lastAnimT = now;
  const target = cover.hovered ? 1 : 0;
  cover.hover = coverHoverMoving() ? cover.hover + (target - cover.hover) * Math.min(1, dt * 12) : target;
  drawWave(dt);
  drawCover(dt);
  const active = seekFrac != null || (cover.on && (cover.hovered || coverHoverMoving()));
  if (audio.paused && !active && !waveSettling()) { lastAnimT = 0; return; }
  animPending = nextFrame(animTick, active ? FPS_ACTIVE : FPS_PLAYING);
}
function kickAnim() {
  if (animPending || motion.asleep) return;
  animPending = requestAnimationFrame(animTick);
}

// ---------------------------------------------------------------- artwork backdrops (riff's banners + cover background)

// riff blurs full-size covers with CSS filters. Here each backdrop is painted once into a small canvas
// with the blur, opacity and fade baked in, so the GPU only ever shows a static, downscaled bitmap.
const imageCache = new Map();
function loadImage(url) {
  if (!url) return Promise.resolve(null);
  if (imageCache.has(url)) { const v = imageCache.get(url); imageCache.delete(url); imageCache.set(url, v); return v; }
  const img = new Image();
  img.decoding = 'async';
  img.src = url;
  const job = img.decode().then(() => img, () => null);
  imageCache.set(url, job);
  if (imageCache.size > 16) imageCache.delete(imageCache.keys().next().value);
  return job;
}

/** Paints img "object-fit: cover" into canvas (w x h device px) with blur / CSS filter / alpha / vertical fade. */
function paintArt(canvas, img, { w, h, blur = 0, filter = '', alpha = 1, zoom = 1, fade = null }) {
  w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  const c = canvas.getContext('2d');
  c.clearRect(0, 0, w, h);
  if (!img) return;
  const pad = blur * 2; // blurred edges go transparent; draw past them
  const s = Math.max((w + pad * 2) / img.naturalWidth, (h + pad * 2) / img.naturalHeight) * zoom;
  const dw = img.naturalWidth * s, dh = img.naturalHeight * s;
  c.filter = `${blur > 0 ? `blur(${blur}px) ` : ''}${filter}`.trim() || 'none';
  c.globalAlpha = alpha;
  c.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
  c.filter = 'none';
  c.globalAlpha = 1;
  if (fade) {
    const g = c.createLinearGradient(0, 0, 0, h);
    for (const [at, a] of fade) g.addColorStop(Math.max(0, Math.min(1, at)), `rgba(0,0,0,${a})`);
    c.globalCompositeOperation = 'destination-in';
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);
    c.globalCompositeOperation = 'source-over';
  }
}
function freeCanvas(canvas) { if (canvas && canvas.width > 1) { canvas.width = 1; canvas.height = 1; } }

const rootCl = document.documentElement.classList;
function bannerSettings() {
  const cs = getComputedStyle(document.documentElement);
  const num = (n, d) => { const v = parseFloat(cs.getPropertyValue(n)); return Number.isFinite(v) ? v : d; };
  return {
    blur: num('--banner-blur', 3),
    opacity: num('--banner-opacity', 1),
    fade: num('--banner-fade-base', 38) / 100,
    banners: !rootCl.contains('th-banners-off'),
    track: !rootCl.contains('th-track-banners-off'),
    coverBg: !rootCl.contains('th-cover-bg-off'),
    // A theme can tint the track backdrops (Glasshouse: grayscale, dim); baked into the canvases.
    artFilter: cs.getPropertyValue('--art-filter').trim().replace(/^none$/, ''),
  };
}
let banner = bannerSettings();

// Paints a banner canvas to fill its host. Blurry banners use half resolution: nobody can tell.
function paintBanner(host, img, fadeStops, filter = '') {
  const canvas = host.querySelector('canvas');
  const w = host.clientWidth, h = host.clientHeight;
  if (!img || !w || !h) { freeCanvas(canvas); return; }
  const r = canvasScale() * (banner.blur >= 2 ? 0.5 : 1);
  paintArt(canvas, img, { w: w * r, h: h * r, blur: banner.blur * r, filter, alpha: banner.opacity, zoom: 1.06, fade: fadeStops });
}

// Right panel: the playing track's cover over the top of the panel, fading out at --banner-fade-base.
const rpBanner = $('#rp-banner');
let rpBannerUrl = null, rpBannerImg = null, rpFadeTimer = 0;
const rpFade = () => [[0, 1], [banner.fade * 0.55, 1], [banner.fade, 0], [1, 0]];
function drawRpBanner() {
  if (!banner.banners || !banner.track) { freeCanvas(rpBanner.firstElementChild); return; }
  paintBanner(rpBanner, rpBannerImg, rpFade(), banner.artFilter);
}

// Window background: riff's #cover-bg (blur 90px, saturate 1.3) as a ~64px pre-blurred canvas.
const coverBgLayers = [...document.querySelectorAll('#cover-bg canvas')];
let coverBgFront = 0, coverBgImg = null;
function paintCoverBg(layer, img) {
  const W = innerWidth || 1, H = innerHeight || 1;
  paintArt(layer, img, { w: 64, h: Math.max(8, Math.round(64 * H / W)), blur: 3.5, filter: banner.artFilter || 'saturate(1.2) brightness(.8)' });
}
function showCoverBg(img) {
  coverBgImg = img;
  const on = banner.coverBg && !!img;
  rootCl.toggle('cover-bg-on', on);
  if (!on) { coverBgLayers.forEach((l) => { l.classList.remove('on'); freeCanvas(l); }); return; }
  const next = coverBgLayers[1 - coverBgFront], prev = coverBgLayers[coverBgFront];
  paintCoverBg(next, img);
  next.classList.add('on');
  prev.classList.remove('on');
  coverBgFront = 1 - coverBgFront;
  setTimeout(() => { if (!prev.classList.contains('on')) freeCanvas(prev); }, 800);
}

let backdropSeq = 0;
function setTrackBackdrops(url) {
  const big = url ? art(url, 500) : '';
  if (big === rpBannerUrl) return;
  rpBannerUrl = big;
  const seq = ++backdropSeq;
  Promise.all([loadImage(big), loadImage(url ? art(url, 100) : '')]).then(([bigImg, smallImg]) => {
    if (seq !== backdropSeq) return;
    showCoverBg(smallImg);
    // riff's banner swap: fade out, repaint, fade back in.
    rpBanner.classList.add('fading');
    clearTimeout(rpFadeTimer);
    rpFadeTimer = setTimeout(() => {
      rpBannerImg = bigImg;
      drawRpBanner();
      rpBanner.classList.toggle('fading', !bigImg);
    }, 150);
  });
}

// Playlist heroes: the playlist cover fading out from the top (riff's playlist-header-banner).
const heroFade = [[0, 1], [0.55, 0.45], [1, 0]];
let heroBanners = [];
function heroBanner(host, url) {
  host.classList.add('fading');
  loadImage(url).then((img) => {
    if (!host.isConnected) return;
    host.heroImg = img;
    heroBanners = heroBanners.filter((h) => h.isConnected).concat(host);
    if (banner.banners) paintBanner(host, img, heroFade);
    host.classList.toggle('fading', !img);
  });
}

function repaintBanners() {
  drawRpBanner();
  heroBanners = heroBanners.filter((h) => h.isConnected);
  for (const h of heroBanners) { if (banner.banners) paintBanner(h, h.heroImg, heroFade); else freeCanvas(h.firstElementChild); }
}

// Settings > Background changes arrive as a 'theme' event (themes.js sets the variables / classes).
bus.addEventListener('theme', () => {
  const was = JSON.stringify(banner);
  banner = bannerSettings();
  refreshCoverFill();
  if (JSON.stringify(banner) === was) return;
  repaintBanners();
  showCoverBg(coverBgImg);
});

let bannerResize = 0;
new ResizeObserver(() => {
  clearTimeout(bannerResize);
  bannerResize = setTimeout(() => {
    drawRpBanner();
    if (coverBgImg && banner.coverBg) paintCoverBg(coverBgLayers[coverBgFront], coverBgImg);
  }, 120);
}).observe($('#right-panel'));

// Theme colours as canvas-ready rgb() strings (theme tokens may be color-mix() expressions).
const colorProbe = document.createElement('i');
colorProbe.style.display = 'none';
document.body.append(colorProbe);
function resolveColor(cssVar, fallback) {
  colorProbe.style.color = fallback;
  colorProbe.style.color = `var(${cssVar})`;
  return getComputedStyle(colorProbe).color || fallback;
}
function refreshCoverFill() {
  cover.fill = resolveColor('--container-high', '#2b2b2b');
  drawCover(0);
}

function fracAt(e) { const r = wave.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); }
wave.addEventListener('pointerdown', (e) => {
  if (!duration()) return;
  wave.setPointerCapture(e.pointerId);
  seekFrac = fracAt(e);
  $('#t-cur').textContent = fmt(seekFrac * duration());
  kickAnim();
});
// Hover the progress bar to see the time you'd jump to.
const waveTip = el('<span class="wave-tip" hidden></span>');
wave.append(waveTip);
wave.addEventListener('pointerleave', () => { waveTip.hidden = true; waveHover = false; kickAnim(); });
wave.addEventListener('pointerenter', () => { waveHover = true; kickAnim(); });
wave.addEventListener('pointermove', (e) => {
  const d = duration();
  if (d) {
    const f = fracAt(e);
    waveTip.hidden = false;
    waveTip.textContent = fmt(f * d);
    waveTip.style.left = `${f * 100}%`;
  }
  if (seekFrac == null) return;
  seekFrac = fracAt(e);
  $('#t-cur').textContent = fmt(seekFrac * duration());
});
wave.addEventListener('pointerup', (e) => {
  if (seekFrac == null) return;
  audio.currentTime = fracAt(e) * duration();
  seekFrac = null;
  kickAnim();
});

audio.addEventListener('timeupdate', () => {
  const d = duration();
  if (seekFrac == null) $('#t-cur').textContent = fmt(audio.currentTime);
  if (audio.paused) { drawWave(); drawCover(0); }
  xfadeCheck();
  // Warm the next track's stream link shortly before this one ends.
  if (d && d - audio.currentTime < 25 && player.current && player.prefetched !== player.current.id) {
    player.prefetched = player.current.id;
    const n = peekNext();
    if (n && !n.source) invoke('stream_url', { id: n.id }).catch(() => {}); // other sources prefetch themselves
  }
});
audio.addEventListener('durationchange', () => { const d = duration(); if (d) $('#t-dur').textContent = fmt(d); });
audio.addEventListener('playing', () => {
  if (xfade.fadeInPending) { xfade.fadeInPending = false; const X = xfade.fadeInSecs || crossfadeSecs() / 2; xfade.fadeInSecs = 0; if (X) rampVolume(1, X); else { xfade.gain = 1; applyVolume(); } }
});
audio.addEventListener('playing', () => { setLoading(false); player.errorStreak = 0; log('info', `audio playing at ${audio.currentTime.toFixed(1)}s`); });
audio.addEventListener('waiting', () => setLoading(true));
audio.addEventListener('play', () => { setPlayIcon(true); emit('play', player.current); });
audio.addEventListener('pause', () => { setPlayIcon(false); emit('pause', player.current); });
audio.addEventListener('ended', () => { if (xfade.handoff) { xfade.handoff(); return; } if (xfade.nextTimer) { xfadeAdvance(); return; } emit('ended', player.current); next(true); });
audio.addEventListener('seeked', () => emit('seeked', audio.currentTime));

// ---------------------------------------------------------------- volume & buttons

const vol = $('#volume');
function setVolume(v) {
  vol.value = v;
  vol.style.setProperty('--p', v + '%');
  vol.title = `Volume ${Math.round(v)}%`;
  volBase = Math.pow(v / 100, 3); // riff's curve (position cubed)
  applyVolume();
  store('volume', Number(v));
}
let volBase = Math.pow(0.8, 3);
function applyVolume() { audio.volume = Math.max(0, Math.min(1, volBase * xfade.gain)); }

// ---------------------------------------------------------------- crossfade (riff's Tracks > Crossfade, 0-12 s)

// riff, X seconds from the end of a track: fade out over X/2, move to the next track, fade it in over X/2.
// riff has one <audio> element and fades a gain node; here the element volume is faded the same way and the
// next track starts once the fade-out has finished (riff switches right away and lets the load time cover it).
const xfade = { gain: 1, triggered: false, fadeInPending: false, nextTimer: 0, ramp: 0 };
const crossfadeSecs = () => Math.max(0, Math.min(12, Number(load('crossfade', 4)) || 0));
// A plain 30 ms timer, not a frame loop: the fade has to keep going while the window is minimized.
function rampVolume(to, secs) {
  clearInterval(xfade.ramp);
  const from = xfade.gain, t0 = performance.now(), ms = Math.max(1, secs * 1000);
  xfade.ramp = setInterval(() => {
    const k = Math.min(1, (performance.now() - t0) / ms);
    xfade.gain = from + (to - from) * k;
    applyVolume();
    if (k >= 1) { clearInterval(xfade.ramp); xfade.ramp = 0; }
  }, 30);
}
function xfadeReset() {
  clearTimeout(xfade.nextTimer); xfade.nextTimer = 0;
  clearInterval(xfade.ramp); xfade.ramp = 0;
  xfade.triggered = false;
  if (!xfade.fadeInPending) { xfade.gain = 1; applyVolume(); }
}
// Pausing or seeking back during the fade-out calls the crossfade off for this track.
function xfadeCancel() {
  if (!xfade.nextTimer) return;
  clearTimeout(xfade.nextTimer); xfade.nextTimer = 0;
  clearInterval(xfade.ramp); xfade.ramp = 0;
  xfade.fadeInPending = false;
  xfade.gain = 1; applyVolume();
}
audio.addEventListener('pause', () => { if (!audio.ended) xfadeCancel(); });
audio.addEventListener('seeking', () => { if (xfade.nextTimer && audio.currentTime < duration() - crossfadeSecs()) { xfadeCancel(); xfade.triggered = false; } });
// Real overlap: the last X seconds of this song keep playing on a second, plain <audio> (the
// "tail") while the next song starts on the main one. The tail fades out, the next song fades in.
/** A second, paused <audio> buffering this song from `at`; started by the crossfade handoff. */
function startTail(s, at) {
  const el = new Audio();
  el.preload = 'auto';
  let h = null;
  if (s.protocol === 'hls') {
    if (!window.Hls || !Hls.isSupported()) return null;
    h = new Hls({ enableWorker: true, startPosition: at, maxBufferLength: 15, backBufferLength: 0 });
    h.loadSource(s.url);
    h.attachMedia(el);
  } else {
    el.src = s.url;
    el.addEventListener('loadedmetadata', () => { el.currentTime = at; }, { once: true });
  }
  el.volume = audio.volume;
  return { el, stop() { try { el.pause(); } catch (e) {} if (h) { try { h.destroy(); } catch (e) {} } el.removeAttribute('src'); try { el.load(); } catch (e) {} } };
}
function fadeTail(tail, secs) {
  const v0 = tail.el.volume, t0 = performance.now(), ms = Math.max(1, secs * 1000);
  const iv = setInterval(() => {
    const k = Math.min(1, (performance.now() - t0) / ms);
    tail.el.volume = Math.max(0, v0 * (1 - k) * (1 - k));
    if (k >= 1 || tail.el.ended) { clearInterval(iv); tail.stop(); }
  }, 50);
}
// Real overlap, without a seek or a gap: XFADE_LEAD seconds before the crossfade point, a second
// <audio> (the "tail") starts buffering this song, paused, at that point. When the main player
// reaches it the tail starts playing and carries the old song out (fading) while the next song
// starts on the main player and fades in.
const XFADE_LEAD = 3;
function xfadeCheck() {
  const X = crossfadeSecs(), d = duration(), cur = audio.currentTime;
  if (!X || xfade.triggered || audio.paused || player.repeat === 'one' || !player.current || !(d > X + 1) || cur < d - X - XFADE_LEAD) return;
  if (!peekNext()) return;
  xfade.triggered = true;
  const s = player.stream, from = player.current;
  const at = Math.max(cur + 0.5, d - X);
  const tail = s && !s.local ? startTail(s, at) : null;
  if (!tail) { // no second stream possible: the old fade-out, then the next song
    xfade.fadeInPending = true;
    rampVolume(0, X / 2);
    xfade.nextTimer = setTimeout(xfadeAdvance, (X / 2) * 1000);
    return;
  }
  let iv = 0;
  const handoff = () => {
    clearInterval(iv); xfade.handoff = null;
    // Buffered at the right spot: it plays on from exactly where the main player is.
    const ready = tail.el.readyState >= 3 && Math.abs(tail.el.currentTime - audio.currentTime) < 0.5;
    if (ready) {
      tail.el.volume = audio.volume;
      tail.el.play().catch(() => {});
      fadeTail(tail, Math.max(0.5, duration() - audio.currentTime));
    } else {
      tail.stop();
      log('warn', `crossfade: tail not ready (state ${tail.el.readyState}, at ${tail.el.currentTime.toFixed(1)} vs ${audio.currentTime.toFixed(1)})`);
    }
    xfade.fadeInPending = true;
    xfade.fadeInSecs = ready ? X : Math.min(1, X);
    xfade.gain = 0; applyVolume();
    emit('ended', player.current);
    next(true);
  };
  xfade.handoff = handoff;
  iv = setInterval(() => {
    if (player.current !== from || audio.paused) { clearInterval(iv); xfade.handoff = null; tail.stop(); return; }
    if (audio.currentTime >= at - 0.02 || audio.currentTime >= duration() - 0.12) handoff();
  }, 15);
}
function xfadeAdvance() {
  if (!xfade.nextTimer) return;
  clearTimeout(xfade.nextTimer); xfade.nextTimer = 0;
  emit('ended', player.current);
  next(true);
}
let lastVol = 80;
vol.addEventListener('input', () => setVolume(vol.value));
vol.addEventListener('wheel', (e) => { e.preventDefault(); setVolume(Math.max(0, Math.min(100, Number(vol.value) - Math.sign(e.deltaY) * 5))); }, { passive: false });
$('#btn-mute').onclick = () => { if (Number(vol.value) > 0) { lastVol = Number(vol.value); setVolume(0); } else setVolume(lastVol || 80); };

$('#btn-play').onclick = togglePlay;
$('#btn-next').onclick = () => next(false);
$('#btn-prev').onclick = prev;
$('#btn-shuffle').onclick = () => setShuffle(!player.shuffle);
$('#btn-repeat').onclick = () => setRepeat(player.repeat === 'off' ? 'all' : player.repeat === 'all' ? 'one' : 'off');
$('#pb-heart').onclick = () => toggleFavorite(player.current);
$('#pb-more').onclick = (e) => { if (!player.current) return; const r = e.currentTarget.getBoundingClientRect(); trackMenu(player.current, r.left, r.top - 230); };

if ('mediaSession' in navigator) {
  const ms = navigator.mediaSession;
  ms.setActionHandler('play', () => audio.play().catch(() => {}));
  ms.setActionHandler('pause', () => audio.pause());
  ms.setActionHandler('nexttrack', () => next(false));
  ms.setActionHandler('previoustrack', prev);
  try { ms.setActionHandler('seekto', (d) => { audio.currentTime = d.seekTime; }); } catch (e) {}
}

document.addEventListener('keydown', (e) => {
  // The target can be the document or a text node (synthetic events, focus on nothing).
  const typing = (e.target instanceof Element ? e.target : e.target?.parentElement)?.closest('input, textarea');
  if (e.key === 'Escape') { hideMenu(); if (!modal.hidden) closeModal(); return; }
  if (e.altKey && !e.ctrlKey && !e.shiftKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) { e.preventDefault(); navHistory(e.key === 'ArrowLeft' ? -1 : 1); return; }
  if (typing) return;
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  else if (e.key === '/' || (e.ctrlKey && e.key.toLowerCase() === 'f')) { e.preventDefault(); searchInput.focus(); searchInput.select(); }
  else if (e.ctrlKey && e.key === 'ArrowRight') next(false);
  else if (e.ctrlKey && e.key === 'ArrowLeft') prev();
  else if (e.key === 'ArrowRight' && duration()) audio.currentTime = Math.min(duration(), audio.currentTime + 5);
  else if (e.key === 'ArrowLeft') audio.currentTime = Math.max(0, audio.currentTime - 5);
  else if (e.ctrlKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); setVolume(Math.max(0, Math.min(100, Number(vol.value) + (e.key === 'ArrowUp' ? 5 : -5)))); }
  else if (e.ctrlKey || e.altKey || e.metaKey) return;
  else if (e.key.toLowerCase() === 'm') $('#btn-mute').click();
  else if (e.key.toLowerCase() === 'h') setShuffle(!player.shuffle);
  else if (e.key.toLowerCase() === 'r') $('#btn-repeat').click();
});

// ---------------------------------------------------------------- start

async function init() {
  applyPrefs();
  setVolume(load('volume', 80));
  lastVol = Number(vol.value) || 80;
  $('#btn-shuffle').classList.toggle('on', player.shuffle);
  setRepeat(player.repeat);
  setM3Cover(cover.on);
  refreshCoverFill();
  setPlayIcon(false);
  updateNowPlaying();
  sizeWave();
  document.fonts?.ready.then(() => { sizeWave(); redrawLists(); fitMarquee(); updateNavIndicator(false); fitSearchBox(); });
  new ResizeObserver(fitSearchBox).observe($('.nav-right'));
  new ResizeObserver(() => requestAnimationFrame(() => updateNavIndicator(false))).observe($('.rail'));
  syncMinimized();

  listen('sc-status', (e) => onStatus(e.payload));
  listen('library-changed', async (e) => {
    await reloadLibrary();
    const r = e.payload || {};
    if (r.added || r.removed) toast(`Likes synced · ${r.added} new, ${r.removed} removed`);
    if (r.added) bumpNewLikes(r.added);
    if (state.view === 'likes' || state.view === 'home') render(true);
  });

  renderPlatformSwitch();
  organizeRail();
  buildTopPanel();
  emit('ready');
  await reloadLibrary();
  state.status = await invoke('sc_status');
  renderAccount();
  emit('status', state.status);
  if (state.status.loggedIn) loadScPlaylists();
  go(state.status.loggedIn && state.library.favorites.length ? 'likes' : 'home');
  if (await invoke('selftest_mode')) selftest();
}
// Runs after ui/features/*.js have loaded and registered themselves.
window.addEventListener('DOMContentLoaded', init);

// Dev aid (RIFF_SELFTEST=1): muted search → play → library check, results in the log.
async function selftest() {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await wait(100); } return false; };
  audio.muted = true;
  try {
    let t0 = performance.now();
    if (!state.trending) { try { state.trending = await invoke('trending'); } catch (e) { log('test', 'trending error: ' + errText(e)); } }
    log('test', `trending: ${state.trending ? state.trending.length : 'FAILED'} tracks (${Math.round(performance.now() - t0)}ms)`);
    t0 = performance.now();
    await runSearch('lofi hip hop');
    const r = state.search.results;
    log('test', `search: ${r.length} results in ${Math.round(performance.now() - t0)}ms; first: ${r.slice(0, 3).map((t) => `${t.title} / ${t.artist} / ${fmt(t.duration)}`).join(' | ')}`);
    await wait(600);
    log('test', `rows drawn: ${document.querySelectorAll('#view .track-row').length}`);
    t0 = performance.now();
    playList(r, 0);
    const ok = await until(() => !audio.paused && audio.currentTime > 0.5, 20000);
    log('test', `playback ${ok ? 'OK' : 'FAILED'}: "${player.current?.title}" t=${audio.currentTime.toFixed(1)}s, started in ${Math.round(performance.now() - t0)}ms`);
    audio.currentTime = 60;
    await wait(2500);
    log('test', `after seek to 60s: t=${audio.currentTime.toFixed(1)}s paused=${audio.paused}`);
    t0 = performance.now();
    next(false);
    const ok2 = await until(() => !audio.paused && audio.currentTime > 0.3 && player.current === r[1], 20000);
    log('test', `next track ${ok2 ? 'OK' : 'FAILED'}: "${player.current?.title}" in ${Math.round(performance.now() - t0)}ms`);
    await wait(3000);
    audio.pause();
    const favs = state.library.favorites;
    log('test', `likes: ${favs.length}, stubs: ${favs.filter((t) => t.title === 'untitled' || t.artist === 'unknown artist' || !t.duration).length}, logged in: ${state.status.loggedIn}, expired: ${!!state.status.expired}`);
    for (const p of state.scPlaylists.slice(0, 3)) {
      t0 = performance.now();
      const tracks = await invoke('sc_playlist_tracks', { id: p.id });
      log('test', `sc playlist "${p.title}": ${tracks.length}/${p.trackCount} tracks, stubs ${tracks.filter((t) => t.title === 'untitled' || !t.duration).length}, ${Math.round(performance.now() - t0)}ms`);
    }
    go('search');
  } catch (e) {
    log('test', 'selftest error: ' + errText(e));
  }
  await lookSelftest(wait);
  await settingsSelftest(wait);
  await shellSelftest(wait);
  for (const [i, t] of ext.selftests.entries()) {
    const name = t.label || `#${i}`;
    log('test', `-- feature selftest ${name}`);
    const timeout = new Promise((r) => setTimeout(() => r('timeout'), 120000));
    try {
      const res = await Promise.race([t((m) => log('test', m)), timeout]);
      if (res === 'timeout') log('test', `feature selftest ${name} TIMED OUT`);
    } catch (e) { log('test', `feature selftest ${name} error: ${errText(e)}`); }
  }
  log('test', 'selftest done');
  // Keep playing (still muted) so CPU/GPU use while playing can be measured afterwards.
  if (player.current && audio.paused) audio.play().catch(() => {});
}

// Settings: every tab renders, a few prefs apply (and are put back), About / diagnostics, search artist rows.
async function settingsSelftest(wait) {
  const check = (name, ok, detail = '') => log('test', `settings ${name}: ${ok ? 'OK' : 'FAILED'}${detail ? ` (${detail})` : ''}`);
  const until = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await wait(100); } return false; };
  const keys = ['compactEngine', 'searchPos', 'uiScale', 'showLocal', 'perfMode'];
  const saved = Object.fromEntries(keys.filter((k) => k in prefs).map((k) => [k, prefs[k]]));
  try {
    go('settings', 'interface');
    await wait(300);
    const btns = view.querySelectorAll('.settings-nav-btn');
    check('nav', btns.length === SETTINGS_CATS.length && SETTINGS_CATS.every(([c]) => view.querySelector(`.settings-nav-btn[data-cat="${c}"]`)), `${btns.length} tabs`);
    const empty = [], broken = [];
    for (const [c] of SETTINGS_CATS) {
      view.querySelector(`.settings-nav-btn[data-cat="${c}"]`).click();
      await wait(80);
      const pane = view.querySelector('.settings-pane');
      if (pane.dataset.cat !== c || !view.querySelector(`.settings-nav-btn.active[data-cat="${c}"]`)) broken.push(c);
      else if (pane.querySelector(':scope > .empty')) empty.push(c);
    }
    check('tabs render', !broken.length, `broken: ${broken.join(', ') || 'none'}; still empty: ${empty.join(', ') || 'none'}`);
    check('tab remembered', load('settingsCat', '') === SETTINGS_CATS[SETTINGS_CATS.length - 1][0]);

    setPref('compactEngine', true); applyBodyPrefs();
    check('compact engine buttons', document.body.classList.contains('compact-engine-btns') && (!$('#platform-switch') || [...$('#platform-switch').querySelectorAll('.platform-btn > span')].every((x) => !x.offsetWidth)));
    setPref('searchPos', 'left'); applySearchPos();
    await wait(900);
    // Left = just after the logo and Back / Forward, leaving room for the Home button (not the window edge any more).
    const r = $('.search-box').getBoundingClientRect(), hb = $('#nav-fwd')?.getBoundingClientRect(), hr = $('#nav-home')?.getBoundingClientRect();
    const leftOk = hb ? r.left > hb.right && r.left - hb.right < 90 * uiZoom() && (!hr || hr.left >= hb.right) : r.left < 120;
    check('searchbar left', leftOk, `left ${Math.round(r.left)}px, after forward at ${hb ? Math.round(hb.right) : '-'}px`);
    setPref('uiScale', 110); applyUiScale(110);
    await wait(150);
    check('ui scale', Math.abs(uiZoom() - 0.99) < 0.005, `zoom ${uiZoom()}`);
    setPref('showLocal', false); applyBodyPrefs();
    const files = $('.rail .nav-item[data-view="files"]');
    check('hide My files tab', !!files && !files.offsetParent);
    setPref('perfMode', true); applyBodyPrefs();
    check('performance mode', motion.perf && slotMs(60) >= 33 && document.body.classList.contains('perf'), `${slotMs(60).toFixed(1)}ms slots`);
  } catch (e) { check('prefs', false, errText(e)); }
  for (const k of keys) { if (k in saved) prefs[k] = saved[k]; else delete prefs[k]; }
  try { localStorage.setItem('prefs', JSON.stringify(prefs)); } catch (e) {}
  applyPrefs();
  try {
    go('settings', 'about');
    const ok = await until(() => /Version \d/.test(view.querySelector('[data-ver]')?.textContent || ''), 3000);
    check('about version', ok, view.querySelector('[data-ver]')?.textContent);
    const d = await diagnosticsText();
    check('diagnostics', d.includes('WebView2') && d.includes('--- recent log ---') && /\d+ \[/.test(d), `${d.length} chars, ${d.split('\n').length} lines`);
    openShortcuts();
    check('shortcuts dialog', !modal.hidden && modal.querySelectorAll('.sc-row').length === SHORTCUTS.length);
    closeModal();
    const pl = state.platform;
    state.platform = 'soundcloud';
    await runSearch('daft punk');
    const rows = await until(() => view.querySelector('.dc-sx .dc-artist'), 15000);
    check('artists in search', rows, `${view.querySelectorAll('.dc-sx .dc-artist').length} artists, ${view.querySelectorAll('.dc-sx-albums .card').length} albums`);
    state.platform = pl;
  } catch (e) { check('about', false, errText(e)); }
}

// App shell: Back / Forward, side bar drag (wide <-> labelled <-> icons), pins, motion timings.
// Prefs it touches are put back. It holds wide and labelled mode a few seconds each for screenshots.
async function shellSelftest(wait) {
  const check = (name, ok, detail = '') => log('test', `shell ${name}: ${ok ? 'OK' : 'FAILED'}${detail ? ` (${detail})` : ''}`);
  const keys = ['railWidth', 'railWideWidth', 'railPins', 'railSort', 'dockedShell'];
  const saved = Object.fromEntries(keys.filter((k) => k in prefs).map((k) => [k, prefs[k]]));
  const rail = $('.rail');
  try {
    // history
    go('likes'); go('playlists'); go('queue');
    const at = () => `${state.view}`;
    navHistory(-1); const b1 = at();
    navHistory(-1); const b2 = at();
    navHistory(1); const f1 = at();
    check('back / forward', b1 === 'playlists' && b2 === 'likes' && f1 === 'playlists' && !$('#nav-back').disabled && !$('#nav-fwd').disabled, `${b1} ${b2} ${f1}`);
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', altKey: true, bubbles: true }));
    const k1 = at();
    window.dispatchEvent(new MouseEvent('mouseup', { button: 4, bubbles: true }));
    const m1 = at();
    check('alt+left / mouse 5', k1 === 'likes' && m1 === 'playlists', `${k1} ${m1}`);
    go('settings', 'interface');
    check('new page drops forward', $('#nav-fwd').disabled && navHist.list[navHist.pos].v === 'settings');
    $('#nav-home').click();
    check('home button', state.view === 'home' && $('#nav-home').classList.contains('active') && $('#nav-home').offsetParent !== null);
    const sr = $('.search-box').getBoundingClientRect(), hr = $('#nav-home').getBoundingClientRect(), hb = $('#nav-back').getBoundingClientRect();
    check('top bar layout', hr.right <= sr.left && hb.right <= hr.left && hb.width > 0, `back ${Math.round(hb.left)}-${Math.round(hb.right)}, home ${Math.round(hr.left)}-${Math.round(hr.right)}, search ${Math.round(sr.left)}`);

    // side bar: drag the edge wider, then double-click back
    setPref('dockedShell', true); applyShellPrefs();
    setRailWidth(RAIL_W.normal, true);
    await wait(250);
    const edge = $('#sidebar-resize-edge'), z = uiZoom();
    const er = edge.getBoundingClientRect(), x0 = er.left + er.width / 2, y0 = er.top + 200;
    const pe = (type, x) => edge.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y0, button: 0, buttons: 1, pointerId: 1, bubbles: true }));
    pe('pointerdown', x0); pe('pointermove', x0 + 40 * z); pe('pointermove', x0 + 150 * z); pe('pointerup', x0 + 150 * z);
    await wait(300);
    const wideRows = rail.querySelectorAll('.sb-lib-row').length;
    check('drag to Your Library', railLib.mode === 'wide' && Math.abs(rail.offsetWidth - 334) <= 2 && pref('railWidth') === 334 && wideRows >= 1 && document.body.classList.contains('sidebar-expanded'),
      `${railLib.mode}, ${rail.offsetWidth}px, ${wideRows} rows, chips ${rail.querySelectorAll('.rl-chip').length}`);
    const navTop = rail.querySelector('.nav-item').getBoundingClientRect().top, libTop = railLib.el.getBoundingClientRect().top;
    check('nav stays on top', navTop < libTop && rail.querySelector('.rl-filter input').offsetParent !== null);
    railLib.el.querySelector('.rl-chip[data-chip="mine"]')?.click();
    const mine = [...rail.querySelectorAll('.sb-lib-row')].every((r) => r.dataset.key === 'likes' || r.dataset.key.startsWith('local:'));
    railLib.chip = ''; renderRailLib();
    check('filter chip', mine);
    log('test', 'shell: holding Your Library for a screenshot');
    await wait(6000);
    edge.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await wait(250);
    check('double-click toggles', railLib.mode === 'normal' && Math.abs(rail.offsetWidth - RAIL_W.normal) <= 2, `${railLib.mode} ${rail.offsetWidth}px`);
    setRailWidth(60, false);
    await wait(250);
    check('icons below 120px', railLib.mode === 'icons' && rail.offsetWidth === RAIL_W.icons && !rail.querySelector('.nav-label').offsetWidth, `${rail.offsetWidth}px`);
    setRailWidth(RAIL_W.normal, false);

    // pins
    setPref('railPins', []);
    togglePin('likes', true);
    const lp = state.library.playlists[0], sp = state.scPlaylists[0];
    if (sp) togglePin(`sc:${sp.id}`, true); else if (lp) togglePin(`local:${lp.id}`, true);
    await wait(100);
    const pinRows = rail.querySelectorAll('.sb-pin-row');
    check('pins', pinRows.length === (sp || lp ? 2 : 1) && pinRows[0].dataset.key === 'likes' && !railLib.el.classList.contains('empty'), `${pinRows.length} pinned`);
    if (sp || lp) {
      go(sp ? 'sc' : 'local', sp ? sp.id : lp.id);
      const more = await (async () => { for (let i = 0; i < 50; i++) { const m = view.querySelector('[data-pl-more]'); if (m) return m; await wait(100); } return null; })();
      check('playlist ⋯ menu', !!more);
      if (more) {
        more.click();
        const item = [...menu.querySelectorAll('button')].find((b) => /Unpin from side bar/.test(b.textContent));
        if (item) item.click(); else hideMenu();
        check('unpin from ⋯ menu', !!item && rail.querySelectorAll('.sb-pin-row').length === 1);
      }
    }
    go('likes');
    log('test', 'shell: holding the labelled side bar for a screenshot');
    await wait(6000);

    // motion
    go('playlists');
    await wait(30);
    const va = getComputedStyle(view);
    const viewMs = parseFloat(va.animationDuration) * (va.animationDuration.endsWith('ms') ? 1 : 1000);
    go('likes');
    await wait(60);
    const rows = [...view.querySelectorAll('.tracks.intro .track-row')];
    const worst = rows.reduce((m, r) => { const s = getComputedStyle(r); const ms = (v) => parseFloat(v) * (v.endsWith('ms') ? 1 : 1000); return Math.max(m, ms(s.animationDelay) + ms(s.animationDuration)); }, 0);
    check('motion ≤ 200ms', viewMs <= 200 && (motion.perf || !state.library.favorites.length || (rows.length > 0 && worst <= 200)), `view ${viewMs}ms, ${rows.length} rows, cascade ends ${worst}ms`);
  } catch (e) { check('selftest', false, errText(e)); }
  for (const k of keys) { if (k in saved) prefs[k] = saved[k]; else delete prefs[k]; }
  try { localStorage.setItem('prefs', JSON.stringify(prefs)); } catch (e) {}
  applyShellPrefs();
  setRailWidth(pref('railWidth', RAIL_W.normal), false);
  renderRailLib();
}

// Core look: switch, shaped cover, backdrops, nav pill, frame pacing.
async function lookSelftest(wait) {
  const check = (name, ok, detail = '') => log('test', `look ${name}: ${ok ? 'OK' : 'FAILED'}${detail ? ` (${detail})` : ''}`);
  try {
    const sw = makeSwitch(false, null, { label: 'test' });
    document.body.append(sw);
    sw.click();
    const thumb = sw.querySelector('.thumb');
    await wait(450);
    const tx = new DOMMatrix(getComputedStyle(thumb).transform).m41;
    check('switch', sw.checked && sw.getAttribute('aria-checked') === 'true' && Math.round(tx) === 20 && !!sw.querySelector('.sw-icon'), `thumb x ${tx}`);
    const plain = el('<button class="switch"><span class="thumb"></span></button>');
    document.body.append(plain);
    await wait(100);
    check('switch markup decorated', !!plain.querySelector('.sw-icon'));
    sw.remove(); plain.remove();

    check('m3 shapes', !!window.RiffShapes && window.RiffShapes.ready() && window.RiffShapes.count() >= 20, `${window.RiffShapes ? window.RiffShapes.count() : 0} shapes`);
    if (player.current) { if (audio.paused) audio.play().catch(() => {}); await wait(1500); }
    check('shaped cover', cover.on && document.body.classList.contains('m3-cover-on') && !!cover.ctx && cover.canvas.width >= 100 && (!player.current?.artwork || !!cover.img),
      `${cover.canvas.width}px canvas, art ${cover.img ? cover.img.naturalWidth + 'px' : 'none'} from ${cover.url.split('/').pop()}`);
    // Frame pacing: count cover frames over 2 s of playback (expect ~30/s focused, ~15/s unfocused).
    let frames = 0;
    const orig = drawCover;
    drawCover = (dt) => { frames++; orig(dt); };
    await wait(2000);
    drawCover = orig;
    const fps = frames / 2;
    check('frame pacing', audio.paused || (fps >= 8 && fps <= 40), `${fps.toFixed(1)} fps, focused ${motion.focused}, playing ${!audio.paused}`);

    const bgOn = rootCl.contains('cover-bg-on');
    const front = coverBgLayers[coverBgFront];
    check('cover background', !player.current?.artwork || !banner.coverBg || (bgOn && front.width === 64 && front.classList.contains('on')), `${front.width}x${front.height}`);
    const rc = rpBanner.firstElementChild;
    check('right panel banner', !player.current?.artwork || !banner.banners || !banner.track || !$('#right-panel').offsetParent || rc.width > 1, `${rc.width}x${rc.height}`);
    go('likes');
    await wait(500);
    const navOk = !navInd.classList.contains('is-hidden') && Math.abs(new DOMMatrix(getComputedStyle(navInd).transform).m42 - ($('.rail .nav-item.active')?.offsetTop ?? -99)) < 2;
    check('nav indicator', navOk, navInd.style.transform);
    const parkedBefore = parkedFrames.size;
    motion.asleep = true;
    let ran = false;
    requestAnimationFrame(() => { ran = true; });
    await wait(80);
    const parked = !ran && parkedFrames.size > parkedBefore;
    motion.asleep = false;
    parkedFrames.forEach((cb) => nativeRaf(cb)); parkedFrames.clear();
    await wait(80);
    check('sleep parks frames', parked && ran);
    go('search');
  } catch (e) {
    check('selftest', false, errText(e));
  }
}

// ---------------------------------------------------------------- public API for ui/features/*.js

window.riff = {
  invoke,
  listen,
  call: (name, args) => invoke('feature', { name, args: args ?? null }),
  log,
  on: (name, fn) => { if (name === 'artist') bus.hasArtist = true; bus.addEventListener(name, (e) => fn(e.detail)); },
  emit,
  state, player, audio,
  get hls() { return hls; },
  view,
  registerView(name, def) {
    ext.views[name] = def;
    if (def.nav) {
      const b = document.createElement('button');
      b.className = 'nav-item';
      b.dataset.view = name;
      b.title = def.title || name;
      b.innerHTML = `<span class="nav-ind nav-indicator">${def.icon || ICON.music}</span>`;
      b.addEventListener('click', () => go(name));
      $('.rail').insertBefore(b, $('.rail-divider'));
      updateNavIndicator(false);
    }
  },
  addTrackMenu(fn) { ext.trackMenu.push(fn); },
  /** Songs / artists the user chose never to hear: isBlocked(track), block(track, 'song'|'artist'). */
  isBlocked, block, unblock, blockedList,
  addListTool(tool) { ext.listTools.push(tool); },
  /** fn(paneEl) renders rows into a settings tab: cat = interface|theme|banners|tracks|integrations|storage|advanced|about|custom-themes|plugins (default advanced). */
  addSettings(fn, cat = 'advanced') { ext.settings.push({ fn, cat: SETTINGS_CAT_IDS.has(cat) ? cat : 'advanced' }); if (state.view === 'settings' && settingsCat === cat) render(true); },
  /** Settings row builders (riff's look): group(rows), row, toggle, prefToggle, slider, select, button. */
  settingsRow: SET,
  /** Persisted preferences: pref(key, fallback), setPref(key, value) emits 'pref' {key, value}. */
  pref, setPref,
  /** Open Settings on a tab. */
  openSettings: (cat) => go('settings', cat || null),
  addStreamResolver(fn) { if (!fn.label) fn.label = fn.name || (document.currentScript && document.currentScript.src.split('/').pop()) || 'resolver'; ext.streamResolvers.push(fn); },
  /** { id, label, icon?, search(query, offset) -> Promise<tracks>, pageSize?, matchesLink?(text) } — riff's platform switch */
  addSearchProvider(p) { const i = searchProviders.findIndex((x) => x.id === p.id); if (i >= 0) searchProviders[i] = p; else searchProviders.unshift(p); if (document.readyState !== 'loading') renderPlatformSwitch(); },
  /** Keep-playing provider: async (recentTracks newest first, avoidIds) -> tracks. Tried in order. */
  addContinuation(fn, label = '') { fn.label = label; ext.continuations.push(fn); },
  continueQueue,
  addSelftest(fn) { fn.label = (document.currentScript && document.currentScript.src.split('/').pop()) || ''; ext.selftests.push(fn); },
  addPlaybarButton(btn, where = 'right') {
    if (where === 'left') $('#pb-more').before(btn); else $('#pb-queue').before(btn);
  },
  go, render, stale: (token) => token !== renderToken, redrawLists,
  trackList, toolList, add, el, spinner, emptyMsg, hero, listActions, wireActions,
  showMenu, hideMenu, openModal, closeModal, askText, confirmBox, toast,
  playList, playTrack, next, prev, togglePlay, addToQueue, queueChanged, toggleFavorite, reloadLibrary, duration, upcoming,
  esc, fmt, bg, small, mid, plural, totalTime, errText, store, load, ICON, svg, art,
  /** riff's switch: riff.switch(on, (on, btn) => {...}, { label }) -> <button>; btn.checked reads/sets it */
  switch: makeSwitch, switchHtml, setSwitch,
  /** Frame pacing for feature animation loops: nextFrame(cb, fps) is a capped requestAnimationFrame. */
  nextFrame, FPS_ACTIVE, FPS_PLAYING,
  /** Redraws the playbar progress bar (after toggling body.no-wavy / no-knob / no-progress-bg). */
  redrawWave: () => drawWave(),
  /** Crossfade state, for the selftest: { gain, triggered, fadeInPending }. */
  get crossfade() { return { gain: xfade.gain, triggered: xfade.triggered, fadeInPending: xfade.fadeInPending, secs: crossfadeSecs() }; },
  get asleep() { return motion.asleep; },
  get focused() { return motion.focused; },
};
