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

  @JavascriptInterface
  fun stop() {
    PlaybackService.stop(ctx)
  }
}
