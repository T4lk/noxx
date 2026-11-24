package dev.noxx.player

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.webkit.CookieManager
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

/**
 * SoundCloud sign-in on Android: soundcloud.com/signin in its own screen. Once the site sets
 * the `oauth_token` cookie, the token goes back to the page (window.__noxxLoginDone) and this
 * screen closes. Closing it by hand reports null.
 */
class LoginActivity : Activity() {
  private val main = Handler(Looper.getMainLooper())
  private var done = false
  private lateinit var web: WebView

  private val poll = object : Runnable {
    override fun run() {
      if (done) return
      val token = readToken()
      if (token != null) finishWith(token) else main.postDelayed(this, 1000)
    }
  }

  @SuppressLint("SetJavaScriptEnabled")
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val cookies = CookieManager.getInstance()
    cookies.setAcceptCookie(true)
    // A forced sign-in, or the same token that was handed over last time (it didn't work or
    // the user signed out): start from a clean SoundCloud login.
    val prefs = getSharedPreferences("login", Context.MODE_PRIVATE)
    val existing = readToken()
    if (intent.getBooleanExtra("force", false) || (existing != null && existing == prefs.getString("last", null))) {
      clearSoundCloudCookies()
    }

    web = WebView(this).apply {
      setBackgroundColor(Color.parseColor("#070707"))
      settings.javaScriptEnabled = true
      settings.domStorageEnabled = true
      // Desktop Chrome user agent: SoundCloud then serves the same sign-in as on the desktop
      // app (the mobile site keeps the login elsewhere), and Google doesn't refuse it as a WebView.
      val chrome = Regex("""Chrome/[\d.]+""").find(settings.userAgentString)?.value ?: "Chrome/131.0.0.0"
      settings.userAgentString = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) $chrome Safari/537.36"
      settings.useWideViewPort = true
      settings.loadWithOverviewMode = true
      settings.builtInZoomControls = true
      settings.displayZoomControls = false
      webViewClient = WebViewClient()
    }
    cookies.setAcceptThirdPartyCookies(web, true)
    ViewCompat.setOnApplyWindowInsetsListener(web) { v, insets ->
      val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime())
      v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
      insets
    }
    setContentView(web)
    if (Build.VERSION.SDK_INT >= 33) {
      onBackInvokedDispatcher.registerOnBackInvokedCallback(android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT) {
        if (web.canGoBack()) web.goBack() else finishWith(null)
      }
    }
    web.loadUrl("https://soundcloud.com/signin")
    main.postDelayed(poll, 1500)
  }

  private fun readToken(): String? {
    val cm = CookieManager.getInstance()
    for (host in HOSTS) {
      val all = cm.getCookie(host) ?: continue
      val t = all.split(';')
        .map { it.trim() }
        .firstOrNull { it.startsWith("oauth_token=") }
        ?.substringAfter('=')
        ?.trim()
        ?.takeIf { it.isNotEmpty() }
      if (t != null) return t
    }
    return null
  }

  private fun clearSoundCloudCookies() {
    val cm = CookieManager.getInstance()
    for (host in HOSTS) {
      val all = cm.getCookie(host) ?: continue
      for (c in all.split(';')) {
        val name = c.substringBefore('=').trim()
        if (name.isEmpty()) continue
        for (domain in listOf(".soundcloud.com", "soundcloud.com", host.removePrefix("https://"))) {
          cm.setCookie(host, "$name=; Max-Age=0; Path=/; Domain=$domain")
        }
        cm.setCookie(host, "$name=; Max-Age=0; Path=/")
      }
    }
    cm.flush()
  }

  private fun finishWith(token: String?) {
    if (done) return
    done = true
    if (token != null) getSharedPreferences("login", Context.MODE_PRIVATE).edit().putString("last", token).apply()
    MainActivity.instance?.loginDone(token)
    finish()
  }

  @Deprecated("Deprecated in Java")
  override fun onBackPressed() {
    if (web.canGoBack()) web.goBack() else finishWith(null)
  }

  override fun onDestroy() {
    main.removeCallbacks(poll)
    if (!done) {
      done = true
      MainActivity.instance?.loginDone(null)
    }
    web.destroy()
    super.onDestroy()
  }

  companion object {
    private val HOSTS = listOf("https://soundcloud.com", "https://m.soundcloud.com", "https://secure.soundcloud.com", "https://api.soundcloud.com")

    fun start(activity: Activity, force: Boolean) {
      activity.startActivity(Intent(activity, LoginActivity::class.java).putExtra("force", force))
    }
  }
}
