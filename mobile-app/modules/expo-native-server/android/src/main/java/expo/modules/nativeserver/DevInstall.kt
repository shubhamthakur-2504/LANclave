package expo.modules.nativeserver

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import org.json.JSONObject
import java.io.InputStream
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Dev builds only: install an APK a paired laptop sends (`PUT /api/dev/install`).
 *
 * The APK streams straight into a PackageInstaller session; nothing is
 * stored first. Android asks the user to confirm the first install of an
 * app. Updates to an app LANclave installed itself may go through without
 * asking (Android 12+), which is what makes a rebuild-and-install loop fast.
 */
object DevInstall {
    private const val ACTION = "expo.modules.nativeserver.DEV_INSTALL_RESULT"
    private const val CHANNEL = "lanclave-dev-install"
    private const val NOTIFICATION_ID = 8380

    /** How long the laptop waits for the user to answer Android's prompt. */
    private const val WAIT_MINUTES = 5L

    private class Waiter {
        val done = CountDownLatch(1)
        @Volatile var result: JSONObject? = null
    }

    private val waiting = ConcurrentHashMap<Int, Waiter>()

    /** Install `length` bytes of APK from `input`. Blocks until Android answers. */
    fun install(context: Context, input: InputStream, length: Long, name: String?): JSONObject {
        val installer = context.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
            setSize(length)
            // Honoured for apps whose installer of record is LANclave.
            setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
        }
        val sessionId = installer.createSession(params)
        val waiter = Waiter()
        waiting[sessionId] = waiter
        try {
            installer.openSession(sessionId).use { session ->
                session.openWrite(name ?: "app.apk", 0, length).use { out ->
                    val buffer = ByteArray(64 * 1024)
                    var total = 0L
                    while (total < length) {
                        val read = input.read(buffer, 0, minOf(buffer.size.toLong(), length - total).toInt())
                        if (read == -1) break
                        out.write(buffer, 0, read)
                        total += read
                    }
                    if (total < length) throw Exception("APK cut short: got $total of $length bytes")
                    session.fsync(out)
                }
                val intent = Intent(ACTION).setClass(context, DevInstallReceiver::class.java)
                val pending = PendingIntent.getBroadcast(
                    context, sessionId, intent,
                    // Mutable: Android fills in the outcome.
                    PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
                )
                session.commit(pending.intentSender)
            }
        } catch (e: Exception) {
            waiting.remove(sessionId)
            runCatching { installer.abandonSession(sessionId) }
            return JSONObject().put("status", "failed").put("message", e.message ?: "could not write the APK")
        }

        val answered = waiter.done.await(WAIT_MINUTES, TimeUnit.MINUTES)
        waiting.remove(sessionId)
        cancelPrompt(context)
        return if (answered) waiter.result!! else JSONObject()
            .put("status", "waiting")
            .put("message", "Nobody answered the install prompt on the phone within $WAIT_MINUTES minutes")
    }

    /** Android's answer for a session (called by [DevInstallReceiver]). */
    internal fun onResult(context: Context, intent: Intent) {
        val sessionId = intent.getIntExtra(PackageInstaller.EXTRA_SESSION_ID, -1)
        val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
        val pkg = intent.getStringExtra(PackageInstaller.EXTRA_PACKAGE_NAME)
        val message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)

        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            val confirm = intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java) ?: return
            confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            // Straight to the prompt when Android allows it (LANclave on
            // screen); a notification to tap otherwise.
            runCatching { context.startActivity(confirm) }
            showPrompt(context, confirm, sessionId)
            return
        }

        val waiter = waiting[sessionId] ?: return
        val result = JSONObject().put("package", pkg ?: JSONObject.NULL)
        when (status) {
            PackageInstaller.STATUS_SUCCESS -> result.put("status", "installed")
            PackageInstaller.STATUS_FAILURE_ABORTED -> result.put("status", "cancelled")
                .put("message", "Install was cancelled on the phone")
            else -> result.put("status", "failed").put("message", explain(status, message))
        }
        waiter.result = result
        waiter.done.countDown()
    }

    private fun explain(status: Int, message: String?): String {
        val base = when (status) {
            PackageInstaller.STATUS_FAILURE_CONFLICT ->
                "Conflicts with the installed app. Usually a different signing key (debug vs release): uninstall it first"
            PackageInstaller.STATUS_FAILURE_INCOMPATIBLE -> "Not compatible with this phone (CPU type or Android version)"
            PackageInstaller.STATUS_FAILURE_INVALID -> "Not a valid APK"
            PackageInstaller.STATUS_FAILURE_STORAGE -> "Not enough storage on the phone"
            PackageInstaller.STATUS_FAILURE_BLOCKED -> "Blocked by the phone"
            else -> "Install failed"
        }
        return if (message.isNullOrBlank()) base else "$base ($message)"
    }

    private fun showPrompt(context: Context, confirm: Intent, sessionId: Int) {
        runCatching {
            val nm = context.getSystemService(NotificationManager::class.java)
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL, "Installs from your laptop", NotificationManager.IMPORTANCE_HIGH),
            )
            val tap = PendingIntent.getActivity(
                context, sessionId, confirm,
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
            nm.notify(
                NOTIFICATION_ID,
                Notification.Builder(context, CHANNEL)
                    .setSmallIcon(context.applicationInfo.icon)
                    .setContentTitle("Install from your laptop")
                    .setContentText("Tap to review and install")
                    .setContentIntent(tap)
                    .setAutoCancel(true)
                    .build(),
            )
        }
    }

    private fun cancelPrompt(context: Context) {
        runCatching { context.getSystemService(NotificationManager::class.java).cancel(NOTIFICATION_ID) }
    }
}

/** Receives PackageInstaller's outcome for [DevInstall]. Not exported. */
class DevInstallReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        DevInstall.onResult(context.applicationContext, intent)
    }
}
