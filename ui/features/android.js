// Android: keeps playback alive in the background and drives the media notification /
// lock-screen controls. `window.noxxAndroid` only exists in the Android app (MainActivity.kt),
// so this does nothing on desktop.
(function () {
  const bridge = window.noxxAndroid;
  if (!bridge) return;
  const riff = window.riff;
  document.documentElement.classList.add('riff-android');

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
