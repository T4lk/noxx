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

  @JavascriptInterface
  fun stop() {
    PlaybackService.stop(ctx)
  }
}
