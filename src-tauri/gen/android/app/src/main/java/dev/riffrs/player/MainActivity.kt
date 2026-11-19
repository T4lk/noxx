package dev.riffrs.player

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat

class MainActivity : TauriActivity() {
  private var webView: WebView? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    instance = this
    // The media notification needs this on Android 13+.
    if (Build.VERSION.SDK_INT >= 33 &&
      ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
    ) {
      ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
    }
  }

  override fun onWebViewCreate(webView: WebView) {
    this.webView = webView
    webView.settings.mediaPlaybackRequiresUserGesture = false
    webView.addJavascriptInterface(NoxxBridge(applicationContext), "noxxAndroid")
  }

  // WryActivity pauses the WebView when the app leaves the screen, which would stop the
  // music. While something is playing, keep it running; the foreground service keeps the
  // process alive.
  override fun onPause() {
    super.onPause()
    if (PlaybackService.state.playing) webView?.onResume()
  }

  override fun onDestroy() {
    if (instance === this) instance = null
    super.onDestroy()
  }

  /** Notification / headset button -> the page's media-key handler. */
  fun mediaKey(key: String) {
    if (key !in setOf("playpause", "next", "prev", "stop")) return
    runOnUiThread {
      webView?.evaluateJavascript("window.__noxxMediaKey && window.__noxxMediaKey('$key')", null)
    }
  }

  companion object {
    @Volatile
    var instance: MainActivity? = null
  }
}
