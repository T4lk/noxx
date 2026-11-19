package dev.riffrs.player

import android.content.Context
import android.webkit.JavascriptInterface

/** `window.noxxAndroid` in the page (ui/features/android.js). */
class NoxxBridge(private val ctx: Context) {
  @JavascriptInterface
  fun update(title: String, artist: String, artwork: String, playing: Boolean, durationMs: Long, positionMs: Long) {
    PlaybackService.update(
      ctx,
      PlaybackService.State(title, artist, artwork, playing, durationMs, positionMs, System.currentTimeMillis()),
    )
  }

  /** "top,bottom" system bar heights in CSS px. */
  @JavascriptInterface
  fun insets(): String = "${MainActivity.insetTop},${MainActivity.insetBottom}"

  /** Opens the SoundCloud sign-in screen; the token comes back through window.__noxxLoginDone. */
  @JavascriptInterface
  fun login(force: Boolean) {
    val a = MainActivity.instance ?: return
    a.runOnUiThread { LoginActivity.start(a, force) }
  }

  /** Downloads a release APK and opens the system installer (ApkUpdater). */
  @JavascriptInterface
  fun installUpdate(url: String) {
    ApkUpdater.start(ctx, url)
  }

  @JavascriptInterface
  fun stop() {
    PlaybackService.stop(ctx)
  }
}
