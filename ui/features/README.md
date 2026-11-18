# Feature modules

Each feature owns its own files and nothing else:

- `ui/features/<name>.js` + `ui/features/<name>.css` (already linked from `index.html`, loaded after `app.js`)
- optionally `src-tauri/src/features/<name>.rs` (+ a `<name>/` submodule folder if needed)

Do not edit `app.js`, `style.css`, `index.html`, `lib.rs`, `features/mod.rs`, `soundcloud.rs`, `library.rs`,
`Cargo.toml`, `tauri.conf.json` or `capabilities/`. If you need a change there, say so in your report.

## JS: `window.riff`

Registration (call at load time, top level of your file):

| call | what it does |
|---|---|
| `riff.registerView(name, { render(token, arg), title, icon, nav })` | adds a view; `nav: true` adds a rail button. Open with `riff.go(name, arg)`. In `render`, append to `riff.view` (or use `riff.add(html)`); after any `await`, bail if `riff.stale(token)`. |
| `riff.addTrackMenu(fn(track, opts) -> [{label, run}])` | extra items in every track's ⋯ / right-click menu |
| `riff.addListTool({ mount(toolsEl, ctx, refresh, tracks), transform(ctx, tracks) -> tracks })` | toolbar above Likes / playlist lists (ctx.kind = 'likes' \| 'sc' \| 'local', ctx.id). `mount` adds controls to `toolsEl` and calls `refresh()` on change; `transform` filters/sorts (return a new array). |
| `riff.addSettings(fn(paneEl), cat)` | adds rows to a Settings tab. `cat`: `interface` `theme` `banners` `tracks` `integrations` `storage` `advanced` (default) `about` `custom-themes` `plugins`. `riff.add(html)` appends to that tab's pane while `fn` runs synchronously; after an `await`, append to `paneEl` yourself |
| `riff.settingsRow` | row builders with riff's look: `group(rows)` (appends), `row(name, desc, side)`, `toggle({name, desc, get, set})`, `prefToggle(key, default, name, desc, onChange)`, `slider({name, min, max, step, value, format, hints, onInput, onChange, reset})`, `select({name, options: [[v, label]], value, onChange})`, `button({name, desc, label, primary, onClick})` |
| `riff.pref(key, default)` / `riff.setPref(key, value)` | persisted UI preferences; `setPref` emits `pref` `{key, value}`. Core keys: `uiScale` `searchPos` `compactEngine` `hideEngine` `noHandCursor` `perfMode` `searchArtists` `showLocal` `albums` `homeAmbient` `myWave` `jumpBack` `reduceMotion` |
| `riff.openSettings(cat)` | opens Settings on a tab |
| `riff.addStreamResolver(async fn(track, fresh) -> {url, protocol} \| null)` | custom playback source (local files, downloaded copies). protocol `'progressive'`/`'file'` plays via `audio.src`, `'hls'` via hls.js. Return null to fall through to SoundCloud. |
| `riff.addPlaybarButton(buttonEl, 'left' \| 'right')` | adds a `pill-btn` to the player bar |
| `riff.addSelftest(async fn(log))` | runs during `RIFF_SELFTEST=1` (audio muted); `log('...')` lines go to stdout as `[ui:test]` |

Events: `riff.on(name, fn)` with `ready`, `library` (lib), `status` (SoundCloud status), `trackchange` (track), `play`, `pause`, `ended`, `seeked`, `render` ({view, arg}), `artist` (track — fired when an artist name is clicked; only once some feature listens), `theme` (emit this after changing CSS variables so canvases recolor). `riff.emit(name, detail)` fires events.

Backend: `await riff.call('module.cmd', args)` → `src-tauri/src/features/<module>.rs` `handle(app, cmd, args)`. Rust events reach JS via `riff.listen('event', e => e.payload)`.

State & player: `riff.state` (library, favIds, status, scPlaylists, view, arg…), `riff.player` (context, order, pos, userQueue, current, shuffle, repeat), `riff.audio` (the `<audio>` element), `riff.hls` (current hls.js instance or null), `riff.playList(tracks, i)`, `riff.playTrack(t)`, `riff.next()`, `riff.prev()`, `riff.togglePlay()`, `riff.addToQueue(t, next?)`, `riff.queueChanged()`, `riff.toggleFavorite(t)`, `riff.reloadLibrary()`, `riff.duration()`, `riff.upcoming(n)`.

Building blocks: `riff.trackList(container, tracks, opts)`, `riff.toolList(ctx, tracks, opts, container?)`, `riff.add(html)`, `riff.el(html)`, `riff.spinner()`, `riff.emptyMsg(text, btnLabel?, onClick?)`, `riff.hero({kicker, title, sub, cover, icon, actions})`, `riff.listActions(extraHtml)` + `riff.wireActions(node, tracks, handlers)`, `riff.showMenu(items, x, y)`, `riff.openModal(html)`/`closeModal()`, `riff.askText()`, `riff.confirmBox()`, `riff.toast(text, 'error'?)`.

Helpers: `esc, fmt, bg, small, mid, plural, totalTime, errText, store, load, ICON, svg`, `art(url, cssPx)` (SoundCloud artwork at the smallest sharp size; use it for thumbnails instead of the t500x500 `artwork`).

Switches (riff's toggle): `riff.switch(on, (on, btn) => …, { label })` returns a ready `<button>` (`btn.checked` reads/sets it); in HTML templates use `riff.switchHtml(on, attrs)` and `riff.setSwitch(btn, on)`; plain `<button class="switch"><span class="thumb"></span></button>` with an `active` class also works. Don't style your own switch.

Animation: draw loops should use `riff.nextFrame(cb, fps)` (a requestAnimationFrame capped to `riff.FPS_PLAYING` = 30 or `riff.FPS_ACTIVE` = 60, 15 when the window is unfocused) and stop when idle. While the window is minimized or hidden (`riff.asleep`, event `visibility` {asleep}) CSS animations are paused and requestAnimationFrame callbacks wait until it is back. Avoid CSS `filter: blur()` / `backdrop-filter` on large or animated layers and `will-change`; they cost GPU memory for as long as they are on screen.

Track objects: `{ id, title, artist, duration (s), artwork (t500x500 url), url, artist_id, artist_url, genre, style, source ('' = SoundCloud, 'local' …), path }`.

## Look

Match riff (E:\riff, read `styles.css` / `index.html` / `app.js` for the original): grey theme, CSS vars in `ui/style.css` `:root` (`--surface`, `--container`, `--container-high`, `--container-highest`, `--on-surface`, `--on-variant`, `--outline`, `--primary`, `--on-primary`, `--r-m/l/xl`, `--fs`). Reuse classes `.btn`, `.btn.primary`, `.btn.outline`, `.pill-btn`, `.page-title`, `.page-sub`, `.section-title`, `.head-row`, `.actions`, `.set-card`, `.cards`/`.card`, `.tiles`/`.tile`, `.hero`.

## Rust: `features/<name>.rs`

```rust
pub fn setup(app: &AppHandle)                                   // startup; spawn with tauri::async_runtime::spawn
pub async fn handle(app: &AppHandle, cmd: &str, args: Value) -> super::Out   // Result<Value, String>
```

`app.state::<crate::AppState>()` → `sc: Arc<SoundCloud>` (use `sc.api(endpoint, &[(k, v)])`, `sc.hydrate(&tracks_value)`, `sc.http` (reqwest client), `sc.token()`, `sc.user_id()`, `sc.status()`), `lib: Mutex<Library>`, `data_dir`. Mapping helpers in `crate::soundcloud`: `map_track`, `listable`, `playable`, `collection`, `id_of`, `str_of`, `unwrap_item`. The future returned by `handle` must be `Send` (don't hold a std `MutexGuard` across `.await`). Store your data as JSON in `data_dir` (`crate::soundcloud::write_json`). Plugins available: `tauri-plugin-dialog`, `tauri-plugin-opener`; crate `discord-rich-presence` 1.x; asset protocol is enabled with an empty scope (add folders at runtime with `app.asset_protocol_scope().allow_directory(path, true)`; play with `convertFileSrc` = `window.__TAURI__.core.convertFileSrc(path)`).

Check your work with `cargo check` from `src-tauri` (other agents build at the same time — if an error is in someone else's file, ignore it and re-run later), `cargo test <your_module>`, and `node --check ui/features/<name>.js`. Don't launch the GUI; the integrator does that.
