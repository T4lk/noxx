package dev.riffrs.player

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  private var webView: WebView? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    instance = this
    // Back: the page closes what's open (now playing, dialogs) or goes back a page; at the
    // start it sends noxx to the background instead of closing it, so music keeps playing.
    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        val wv = webView
        if (wv == null) { moveTaskToBack(true); return }
        wv.evaluateJavascript("(window.__noxxBack && window.__noxxBack()) || false") { r ->
          if (r != "true") moveTaskToBack(true)
        }
      }
    })
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
    // Edge-to-edge: hand the status / navigation bar heights to the page (ui/features/mobile.css).
    ViewCompat.setOnApplyWindowInsetsListener(webView) { v, insets ->
      val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
      val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
      val d = resources.displayMetrics.density
      insetTop = Math.round(bars.top / d)
      insetBottom = Math.round(bars.bottom / d)
      // keyboard height above the navigation bar, so dialogs can move up
      val kb = Math.round(maxOf(0, ime.bottom - bars.bottom) / d)
      (v as WebView).evaluateJavascript("window.__noxxInsets && window.__noxxInsets($insetTop, $insetBottom, $kb)", null)
      insets
    }
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
    if (key !in setOf("playpause", "play", "pause", "next", "prev", "stop")) return
    runOnUiThread {
      // A paused WebView (noxx in the background while paused) wouldn't start playing again.
      if (key != "pause" && key != "stop") webView?.onResume()
      webView?.evaluateJavascript("window.__noxxMediaKey && window.__noxxMediaKey('$key')", null)
    }
  }

  fun runJs(code: String) {
    runOnUiThread { webView?.evaluateJavascript(code, null) }
  }

  /** Sign-in result (null = closed) -> the page. The token is never logged. */
  fun loginDone(token: String?) {
    val arg = if (token == null) "null" else org.json.JSONObject.quote(token)
    runOnUiThread {
      webView?.evaluateJavascript("window.__noxxLoginDone && window.__noxxLoginDone($arg)", null)
    }
  }

  companion object {
    @Volatile
    var instance: MainActivity? = null

    @Volatile
    var insetTop = 0

    @Volatile
    var insetBottom = 0
  }
}
