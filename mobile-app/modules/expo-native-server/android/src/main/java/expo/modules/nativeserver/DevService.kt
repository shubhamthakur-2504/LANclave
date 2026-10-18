package expo.modules.nativeserver

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder

/**
 * Dev builds only: keeps LANclave running while developer tools are on, so
 * a laptop can read logs and install builds with the app in the background
 * or the screen off. Without it Android freezes a backgrounded app and its
 * server stops answering.
 */
class DevService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            DevTools.setEnabled(this, false)
            DevLogs.stop()
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL, "Developer tools", NotificationManager.IMPORTANCE_LOW).apply {
                description = "While a laptop can read this phone's logs and install apps"
                setShowBadge(false)
            },
        )
        try {
            if (Build.VERSION.SDK_INT >= 34) {
                startForeground(NOTIFICATION_ID, build(this), ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
            } else {
                startForeground(NOTIFICATION_ID, build(this))
            }
        } catch (_: Exception) {
            stopSelf()
            return START_NOT_STICKY
        }
        return START_NOT_STICKY
    }

    companion object {
        private const val CHANNEL = "lanclave-dev"
        private const val NOTIFICATION_ID = 8379
        private const val ACTION_STOP = "expo.modules.nativeserver.DEV_STOP"

        fun start(context: Context) {
            context.startForegroundService(Intent(context, DevService::class.java))
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, DevService::class.java))
        }

        private fun build(ctx: Context): Notification {
            val stop = PendingIntent.getService(
                ctx, 2, Intent(ctx, DevService::class.java).setAction(ACTION_STOP),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
            val open = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName)?.let {
                PendingIntent.getActivity(ctx, 0, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
            }
            return Notification.Builder(ctx, CHANNEL)
                .setSmallIcon(ctx.applicationInfo.icon)
                .setContentTitle("Developer tools on")
                .setContentText("Your laptop can read logs and install apps")
                .setOngoing(true)
                .addAction(Notification.Action.Builder(null, "Turn off", stop).build())
                .apply { if (open != null) setContentIntent(open) }
                .build()
        }
    }
}
