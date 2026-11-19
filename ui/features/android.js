// Android: keeps playback alive in the background and drives the media notification /
// lock-screen controls. `window.noxxAndroid` only exists in the Android app (MainActivity.kt),
// so this does nothing on desktop.
(function () {
  const bridge = window.noxxAndroid;
  if (!bridge) return;
  const riff = window.riff;
  const root = document.documentElement;
  root.classList.add('riff-android');

  // Status / navigation bar heights (CSS px) for the edge-to-edge layout; MainActivity calls
  // this again whenever they change.
  window.__noxxInsets = (top, bottom) => {
    root.style.setProperty('--sat', `${Number(top) || 0}px`);
    root.style.setProperty('--sab', `${Number(bottom) || 0}px`);
  };
  try { const [t, b] = String(bridge.insets()).split(','); window.__noxxInsets(t, b); } catch (e) {}

  // SoundCloud sign-in screen (LoginActivity.kt): resolves with the oauth token, rejects when closed.
  let pendingLogin = null;
  window.noxxLogin = (force) => new Promise((resolve, reject) => {
    pendingLogin = { resolve, reject };
    try { bridge.login(!!force); } catch (e) { pendingLogin = null; reject(e); }
  });
  window.__noxxLoginDone = (token) => {
    const p = pendingLogin; pendingLogin = null;
    if (!p) return;
    if (token) p.resolve(token); else p.reject('Sign-in was closed.');
  };

  // Notification / headset buttons arrive here and go through the same handler as desktop media keys.
  window.__noxxMediaKey = (k) => {
    try { window.__TAURI__.event.emit('media-key', k); } catch (e) {}
  };

  let timer = null;
  function sync() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const t = riff.player.current;
      try {
        if (!t) { bridge.stop(); return; }
        bridge.update(
          String(t.title || ''),
          String(t.artist || ''),
          String(t.artwork || ''),
          !riff.audio.paused,
          Math.round((Number(t.duration) || riff.duration() || 0) * 1000),
          Math.round((riff.audio.currentTime || 0) * 1000),
        );
      } catch (e) {}
    }, 150);
  }

  riff.on('trackchange', sync);
  riff.on('play', sync);
  riff.on('pause', sync);
  riff.on('seeked', sync);
})();
