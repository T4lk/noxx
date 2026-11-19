package dev.riffrs.player

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

/**
 * Android update: downloads the release APK into the app's cache and opens the system
 * installer. Android always shows its own "Install" screen; that part can't be skipped.
 * Progress / result go to the page: window.__noxxApkProgress(done, total), window.__noxxApkDone(error|null).
 */
object ApkUpdater {
  @Volatile
  private var busy = false

  fun start(ctx: Context, url: String) {
    if (busy) return
    if (!url.startsWith("https://github.com/T4lk/noxx/releases/")) {
      report("Not a GitHub download")
      return
    }
    // Android 8+: noxx needs "Install unknown apps" once; send the user to that switch.
    if (Build.VERSION.SDK_INT >= 26 && !ctx.packageManager.canRequestPackageInstalls()) {
      val i = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${ctx.packageName}"))
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      try { ctx.startActivity(i) } catch (e: Exception) {}
      report("Allow noxx to install apps, then tap Update again")
      return
    }
    busy = true
    thread(isDaemon = true) {
      try {
        val dir = File(ctx.cacheDir, "updates").apply { mkdirs() }
        dir.listFiles()?.forEach { it.delete() }
        val out = File(dir, "noxx-update.apk")
        val conn = URL(url).openConnection() as HttpURLConnection
        conn.instanceFollowRedirects = true
        conn.connectTimeout = 15000
        conn.readTimeout = 30000
        val total = conn.contentLengthLong
        var done = 0L
        var last = 0L
        conn.inputStream.use { input ->
          out.outputStream().use { o ->
            val buf = ByteArray(64 * 1024)
            while (true) {
              val n = input.read(buf)
              if (n < 0) break
              o.write(buf, 0, n)
              done += n
              val now = System.currentTimeMillis()
              if (now - last > 200) {
                last = now
                js("window.__noxxApkProgress && window.__noxxApkProgress($done, $total)")
              }
            }
          }
        }
        js("window.__noxxApkProgress && window.__noxxApkProgress($done, $done)")
        val uri = FileProvider.getUriForFile(ctx, "${ctx.packageName}.fileprovider", out)
        val install = Intent(Intent.ACTION_VIEW)
          .setDataAndType(uri, "application/vnd.android.package-archive")
          .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        ctx.startActivity(install)
        report(null)
      } catch (e: Exception) {
        report("Download failed: ${e.message ?: e.javaClass.simpleName}")
      } finally {
        busy = false
      }
    }
  }

  private fun report(err: String?) {
    val arg = if (err == null) "null" else org.json.JSONObject.quote(err)
    js("window.__noxxApkDone && window.__noxxApkDone($arg)")
  }

  private fun js(code: String) {
    MainActivity.instance?.runJs(code)
  }
}
