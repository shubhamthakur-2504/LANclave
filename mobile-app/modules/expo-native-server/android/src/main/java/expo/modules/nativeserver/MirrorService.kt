package expo.modules.nativeserver

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder

/**
 * The foreground service Android requires while the screen is captured
 * (type `mediaProjection`). Started the moment the user allows capture,
 * while LANclave is still in front (Android 12+ refuses a later start from
 * the background), and runs until sharing ends: shows who is being asked,
 * then "Sharing your screen with …", with a Stop button. Tells [Mirror]
 * once it is in the foreground, which is when capture may begin.
 */
class MirrorService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            Mirror.stop()
            return START_NOT_STICKY
        }
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL, "Screen sharing", NotificationManager.IMPORTANCE_LOW).apply {
                description = "While this phone's screen is shown on a laptop"
                setShowBadge(false)
            },
        )
        try {
            startForeground(NOTIFICATION_ID, build(this), ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
        } catch (e: Exception) {
            stopSelf()
            Mirror.serviceFailed()
            return START_NOT_STICKY
        }
        running = this
        Mirror.serviceStarted()
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        running = null
        super.onDestroy()
    }

    companion object {
        private const val CHANNEL = "lanclave-mirror"
        private const val NOTIFICATION_ID = 8378
        private const val ACTION_STOP = "expo.modules.nativeserver.MIRROR_STOP"

        @Volatile private var running: MirrorService? = null

        fun start(context: Context) {
            context.startForegroundService(Intent(context, MirrorService::class.java))
        }

        fun stop() {
            running?.let {
                it.stopForeground(STOP_FOREGROUND_REMOVE)
                it.stopSelf()
            }
        }

        /** Sharing moved on: update the notification to say so. */
        fun refresh() {
            val service = running ?: return
            try {
                service.getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, build(service))
            } catch (_: Exception) {
                // the notification is a courtesy; sharing goes on without it
            }
        }

        private fun build(ctx: Context): Notification {
            val stop = PendingIntent.getService(
                ctx, 1, Intent(ctx, MirrorService::class.java).setAction(ACTION_STOP),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
            val open = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName)?.let {
                PendingIntent.getActivity(ctx, 0, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
            }
            return Notification.Builder(ctx, CHANNEL)
                .setSmallIcon(ctx.applicationInfo.icon)
                .apply {
                    val laptop = Mirror.peerNameForNotification()
                    if (Mirror.state == "asking") {
                        setContentTitle("Asking to share your screen")
                        setContentText("Waiting for $laptop to accept")
                    } else {
                        setContentTitle("Sharing your screen")
                        setContentText("with $laptop")
                    }
                }
                .setOngoing(true)
                .addAction(Notification.Action.Builder(null, "Stop", stop).build())
                .apply { if (open != null) setContentIntent(open) }
                .build()
        }
    }
}
