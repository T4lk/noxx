package dev.noxx.player

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioManager
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
        override fun onPlay() = key("play")
        override fun onPause() = key("pause")
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
      .createWifiLock(
        if (Build.VERSION.SDK_INT >= 29) WifiManager.WIFI_MODE_FULL_LOW_LATENCY else WifiManager.WIFI_MODE_FULL_HIGH_PERF,
        "noxx:playback",
      ).apply { setReferenceCounted(false) }
    // Headphones unplugged / Bluetooth gone: pause instead of blasting the speaker.
    ContextCompat.registerReceiver(this, noisy, IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY), ContextCompat.RECEIVER_NOT_EXPORTED)
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
    if (state.title.isEmpty()) { // stopped before the service got going
      shutdown()
      return START_NOT_STICKY
    }
    refresh()
    return START_NOT_STICKY
  }

  // Swiping noxx out of recents closes the page, so the music is gone too.
  override fun onTaskRemoved(rootIntent: Intent?) {
    shutdown()
    super.onTaskRemoved(rootIntent)
  }

  private val noisy = object : BroadcastReceiver() {
    override fun onReceive(c: Context?, i: Intent?) {
      if (state.playing) key("pause")
    }
  }

  override fun onDestroy() {
    try { unregisterReceiver(noisy) } catch (e: Exception) {}
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
    if (s.playing) {
      try {
        if (Build.VERSION.SDK_INT >= 29) {
          startForeground(ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
        } else {
          startForeground(ID, n)
        }
      } catch (e: Exception) {
        // Android 12+ refuses a foreground start from the background; keep the notification.
        android.util.Log.w("noxx", "startForeground: $e")
        getSystemService(NotificationManager::class.java).notify(ID, n)
      }
    } else {
      // Paused: the notification stays (swipe to dismiss) but the service may be stopped.
      ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_DETACH)
      getSystemService(NotificationManager::class.java).notify(ID, n)
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
      .setDeleteIntent(
        PendingIntent.getService(
          this, 9, Intent(this, PlaybackService::class.java).setAction(ACTION_STOP),
          PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        ),
      )
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
        // small enough for the notification / media session (binder limit ~1 MB)
        val raw = c.inputStream.use { BitmapFactory.decodeStream(it) }
        if (raw != null && (raw.width > 320 || raw.height > 320)) {
          val k = 320f / maxOf(raw.width, raw.height)
          Bitmap.createScaledBitmap(raw, (raw.width * k).toInt(), (raw.height * k).toInt(), true)
        } else {
          raw
        }
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
    private const val ACTION_KEY = "dev.noxx.player.KEY"
    private const val ACTION_STOP = "dev.noxx.player.STOP"

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
            android.util.Log.w("noxx", "playback service start: $e")
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
