package expo.modules.nativeserver

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.os.IBinder
import android.os.PowerManager

/**
 * Keeps the process alive **only while transfers are active** (P4): while
 * downloads are queued or running, and while an offer we sent may still be
 * pulled from us. Shows the progress notification Android requires, holds
 * a Wi-Fi lock so the radio stays fast, and a partial wake lock so the CPU
 * keeps moving bytes with the screen off. Stops itself when idle -- the
 * phone never runs an always-on server in the background.
 */
class TransferService : Service() {
    private var wifiLock: WifiManager.WifiLock? = null
    private var wakeLock: PowerManager.WakeLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        running = this
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL, "Transfers", NotificationManager.IMPORTANCE_LOW).apply {
                description = "Files being sent or received"
                setShowBadge(false)
            },
        )
        @Suppress("DEPRECATION") // HIGH_PERF is still the throughput lock.
        wifiLock = (applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager)
            .createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "lanclave:transfers")
            .apply { setReferenceCounted(false); acquire() }
        wakeLock = (getSystemService(Context.POWER_SERVICE) as PowerManager)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "lanclave:transfers")
            .apply { setReferenceCounted(false); acquire(6 * 60 * 60 * 1000L) }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForeground(NOTIFICATION_ID, build(this), ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        if (!needed()) stopSelf()
        // Not sticky: after a kill, JS restarts transfers; a service revived
        // without the app would have no identity to sign with.
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        running = null
        wifiLock?.takeIf { it.isHeld }?.release()
        wakeLock?.takeIf { it.isHeld }?.release()
        super.onDestroy()
    }

    override fun onTimeout(startId: Int, fgsType: Int) {
        // Android 15's daily cap for data-sync services: stop cleanly.
        stopSelf()
    }

    companion object {
        private const val CHANNEL = "lanclave_transfers"
        private const val NOTIFICATION_ID = 8377
        @Volatile private var running: TransferService? = null
        @Volatile private var lastUpdate = 0L

        private fun needed(): Boolean =
            TransferEngine.active().isNotEmpty() || Offers.liveOutgoing().isNotEmpty()

        /** Start, update or stop to match what is going on. Cheap to call often. */
        fun refresh(context: Context?) {
            val ctx = context?.applicationContext ?: return
            val service = running
            when {
                needed() && service == null -> try {
                    ctx.startForegroundService(Intent(ctx, TransferService::class.java))
                } catch (_: Exception) {
                    // Not allowed from the background right now; the process
                    // stays up while the app is visible, and a later refresh
                    // from the foreground starts it.
                }
                !needed() && service != null -> service.stopSelf()
                service != null -> {
                    val now = System.currentTimeMillis()
                    if (now - lastUpdate < 1_000) return
                    lastUpdate = now
                    ctx.getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, build(ctx))
                }
            }
        }

        private fun build(ctx: Context): Notification {
            val receiving = TransferEngine.active()
            val sending = Offers.liveOutgoing()
            val (title, progress) = when {
                receiving.isNotEmpty() -> {
                    val total = receiving.sumOf { it.total }
                    val done = receiving.sumOf { it.bytes }
                    val pct = if (total > 0) (done * 100 / total).toInt() else 0
                    "Receiving ${receiving.size} file${if (receiving.size == 1) "" else "s"} · $pct%" to pct
                }
                sending.any { it.state == "accepted" } -> {
                    val o = sending.first { it.state == "accepted" }
                    val total = o.files.filter { it.id in o.accepted }.sumOf { it.size }
                    val done = o.accepted.sumOf { o.served[it] ?: 0L }
                    val pct = if (total > 0) (done * 100 / total).toInt() else 0
                    "Sending to ${o.peerName ?: "a paired device"} · $pct%" to pct
                }
                sending.isNotEmpty() -> "Waiting for ${sending.first().peerName ?: "the other device"} to accept" to -1
                else -> "Finishing up" to -1
            }
            val open = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName)?.let {
                PendingIntent.getActivity(ctx, 0, it, PendingIntent.FLAG_IMMUTABLE)
            }
            return Notification.Builder(ctx, CHANNEL)
                .setSmallIcon(if (receiving.isNotEmpty()) android.R.drawable.stat_sys_download else android.R.drawable.stat_sys_upload)
                .setContentTitle("LANclave")
                .setContentText(title)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setContentIntent(open)
                .apply { if (progress >= 0) setProgress(100, progress, false) else setProgress(0, 0, true) }
                .build()
        }
    }
}
