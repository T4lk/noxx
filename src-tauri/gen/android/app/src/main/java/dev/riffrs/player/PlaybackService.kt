package dev.riffrs.player

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.support.v4.media.MediaMetadataCompat
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

/**
 * Keeps noxx alive while music plays with the screen off or another app open, and shows the
 * media notification / lock-screen controls. The audio itself still plays in the WebView.
 */
class PlaybackService : Service() {
  data class State(
    val title: String = "",
    val artist: String = "",
    val artwork: String = "",
    val playing: Boolean = false,
    val durationMs: Long = 0,
    val positionMs: Long = 0,
    val at: Long = 0,
  )

  private lateinit var session: MediaSessionCompat
  private var wake: PowerManager.WakeLock? = null
  private var wifi: WifiManager.WifiLock? = null
  private var art: Bitmap? = null
  private var artUrl = ""

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    val nm = getSystemService(NotificationManager::class.java)
    if (Build.VERSION.SDK_INT >= 26) {
      nm.createNotificationChannel(
        NotificationChannel(CHANNEL, "Playback", NotificationManager.IMPORTANCE_LOW).apply {
          setShowBadge(false)
        },
      )
    }
    session = MediaSessionCompat(this, "noxx").apply {
      setCallback(object : MediaSessionCompat.Callback() {
        override fun onPlay() = key("playpause")
        override fun onPause() = key("playpause")
        override fun onSkipToNext() = key("next")
        override fun onSkipToPrevious() = key("prev")
        override fun onStop() = key("stop")
      })
      isActive = true
    }
    wake = (getSystemService(POWER_SERVICE) as PowerManager)
      .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "noxx:playback").apply { setReferenceCounted(false) }
    @Suppress("DEPRECATION")
    wifi = (applicationContext.getSystemService(WIFI_SERVICE) as WifiManager)
      .createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "noxx:playback").apply { setReferenceCounted(false) }
    running = this
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_KEY -> intent.getStringExtra("key")?.let { key(it) }
      ACTION_STOP -> {
        shutdown()
        return START_NOT_STICKY
      }
    }
    refresh()
    return START_NOT_STICKY
  }

  // Swiping noxx out of recents closes the page, so the music is gone too.
  override fun onTaskRemoved(rootIntent: Intent?) {
    shutdown()
    super.onTaskRemoved(rootIntent)
  }

  override fun onDestroy() {
    running = null
    session.release()
    wake?.release()
    wifi?.release()
    super.onDestroy()
  }

  private fun key(k: String) {
    MainActivity.instance?.mediaKey(k)
  }

  private fun shutdown() {
    ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
    stopSelf()
  }

  fun refresh() {
    val s = state
    val actions = PlaybackStateCompat.ACTION_PLAY or PlaybackStateCompat.ACTION_PAUSE or
      PlaybackStateCompat.ACTION_PLAY_PAUSE or PlaybackStateCompat.ACTION_SKIP_TO_NEXT or
      PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS or PlaybackStateCompat.ACTION_STOP
    session.setPlaybackState(
      PlaybackStateCompat.Builder()
        .setActions(actions)
        .setState(
          if (s.playing) PlaybackStateCompat.STATE_PLAYING else PlaybackStateCompat.STATE_PAUSED,
          s.positionMs,
          if (s.playing) 1f else 0f,
          android.os.SystemClock.elapsedRealtime() - (System.currentTimeMillis() - s.at),
        )
        .build(),
    )
    val meta = MediaMetadataCompat.Builder()
      .putString(MediaMetadataCompat.METADATA_KEY_TITLE, s.title)
      .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, s.artist)
      .putLong(MediaMetadataCompat.METADATA_KEY_DURATION, s.durationMs)
    if (s.artwork == artUrl) art?.let { meta.putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, it) }
    session.setMetadata(meta.build())

    val n = notification(s)
    if (Build.VERSION.SDK_INT >= 29) {
      startForeground(ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
    } else {
      startForeground(ID, n)
    }

    if (s.playing) {
      wake?.acquire(6 * 60 * 60 * 1000L)
      wifi?.acquire()
    } else {
      wake?.release()
      wifi?.release()
    }
    if (s.artwork.isNotEmpty() && s.artwork != artUrl) loadArt(s.artwork)
  }

  private fun notification(s: State): Notification {
    val open = PendingIntent.getActivity(
      this, 0,
      Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
    fun btn(icon: Int, label: String, k: String, req: Int) = NotificationCompat.Action(
      icon, label,
      PendingIntent.getService(
        this, req,
        Intent(this, PlaybackService::class.java).setAction(ACTION_KEY).putExtra("key", k),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
      ),
    )
    return NotificationCompat.Builder(this, CHANNEL)
      .setSmallIcon(R.drawable.ic_stat_noxx)
      .setContentTitle(s.title.ifEmpty { "noxx" })
      .setContentText(s.artist)
      .setLargeIcon(if (s.artwork == artUrl) art else null)
      .setContentIntent(open)
      .setOngoing(s.playing)
      .setSilent(true)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .addAction(btn(android.R.drawable.ic_media_previous, "Previous", "prev", 1))
      .addAction(
        if (s.playing) btn(android.R.drawable.ic_media_pause, "Pause", "playpause", 2)
        else btn(android.R.drawable.ic_media_play, "Play", "playpause", 2),
      )
      .addAction(btn(android.R.drawable.ic_media_next, "Next", "next", 3))
      .setStyle(
        androidx.media.app.NotificationCompat.MediaStyle()
          .setMediaSession(session.sessionToken)
          .setShowActionsInCompactView(0, 1, 2),
      )
      .build()
  }

  private fun loadArt(url: String) {
    artUrl = url
    art = null
    thread(isDaemon = true) {
      val bmp = try {
        val c = URL(url).openConnection() as HttpURLConnection
        c.connectTimeout = 8000
        c.readTimeout = 8000
        c.inputStream.use { BitmapFactory.decodeStream(it) }
      } catch (e: Exception) {
        null
      }
      Handler(Looper.getMainLooper()).post {
        if (artUrl == url && bmp != null) {
          art = bmp
          if (running === this) refresh()
        }
      }
    }
  }

  companion object {
    private const val CHANNEL = "playback"
    private const val ID = 1
    private const val ACTION_KEY = "dev.riffrs.player.KEY"
    private const val ACTION_STOP = "dev.riffrs.player.STOP"

    @Volatile
    var state = State()

    @Volatile
    private var running: PlaybackService? = null

    private val main = Handler(Looper.getMainLooper())

    fun update(ctx: Context, s: State) {
      state = s
      main.post {
        val svc = running
        if (svc != null) {
          svc.refresh()
        } else if (s.playing) {
          // Started only while the page is playing (the app is in front then).
          try {
            ContextCompat.startForegroundService(ctx, Intent(ctx, PlaybackService::class.java))
          } catch (e: Exception) {
          }
        }
      }
    }

    fun stop(ctx: Context) {
      state = State()
      main.post { running?.shutdown() }
    }
  }
}
