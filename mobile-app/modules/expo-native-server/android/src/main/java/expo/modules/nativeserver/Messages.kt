package expo.modules.nativeserver

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID
import java.util.concurrent.Executors

/**
 * Text messages between paired devices: one thread per device. The same
 * rules as `messages.rs` on the desktop, and the two must stay in step.
 *
 * There is no server in between, so the sender keeps a message until the
 * other device can take it: pushed at once when it can be reached, and again
 * on the next contact. When this phone cannot be reached (its server is off
 * while the app is closed), the other side holds messages for it, says how
 * many in its heartbeat reply, and this side fetches and acknowledges them.
 *
 * Notifications never carry the text: the screen may be shared.
 */
object Messages {
    /** Longer than this goes as a file. Matches `MAX_TEXT_BYTES` on the desktop. */
    const val MAX_TEXT_BYTES = 64 * 1024

    private const val MAX_PER_THREAD = 2000
    private const val CHANNEL = "lanclave-messages"

    const val WAITING = "waiting"
    const val DELIVERED = "delivered"
    const val RECEIVED = "received"

    data class Message(
        val id: String,
        val text: String,
        val sentAt: Long,
        var state: String,
        var read: Boolean,
    )

    private val threads = HashMap<String, MutableList<Message>>()
    private var file: File? = null
    private var context: Context? = null
    private val busy = HashSet<String>()
    private val worker = Executors.newCachedThreadPool()

    /** Load saved threads once; later calls only refresh the context. */
    @Synchronized fun configure(context: Context) {
        this.context = context.applicationContext
        if (file != null) return
        file = File(context.filesDir, "messages.json")
        load()
    }

    /** For tests: keep threads in `target`, or in memory with `null`. */
    @Synchronized fun useFile(target: File?) {
        context = null
        file = target
        threads.clear()
        load()
    }

    private fun load() {
        try {
            val root = JSONObject(file?.takeIf { it.exists() }?.readText() ?: "{}")
            for (peerId in root.keys()) {
                val array = root.getJSONArray(peerId)
                threads[peerId] = MutableList(array.length()) { i ->
                    val o = array.getJSONObject(i)
                    Message(o.getString("id"), o.getString("text"), o.getLong("sent_at"), o.getString("state"), o.optBoolean("read"))
                }
            }
        } catch (_: Exception) {
            // unreadable: start empty rather than refuse to run
        }
    }

    /** Save, trim and tell JS. Call with the lock held. */
    private fun changed() {
        for (thread in threads.values) {
            while (thread.size > MAX_PER_THREAD) thread.removeAt(0)
        }
        file?.let { target ->
            val root = JSONObject()
            for ((peerId, thread) in threads) {
                root.put(peerId, JSONArray().apply {
                    thread.forEach {
                        put(JSONObject().put("id", it.id).put("text", it.text).put("sent_at", it.sentAt)
                            .put("state", it.state).put("read", it.read))
                    }
                })
            }
            try {
                val tmp = File(target.path + ".tmp")
                tmp.writeText(root.toString())
                java.nio.file.Files.move(
                    tmp.toPath(), target.toPath(),
                    java.nio.file.StandardCopyOption.REPLACE_EXISTING,
                    java.nio.file.StandardCopyOption.ATOMIC_MOVE,
                )
            } catch (_: Exception) {
                // kept in memory for this run
            }
        }
        Events.emit("onMessagesChanged", emptyMap())
    }

    /** A message written here, to send. Throws on blank or oversized text. */
    @Synchronized fun queueOutgoing(peerId: String, text: String): Message {
        require(text.isNotBlank()) { "Nothing to send." }
        require(text.toByteArray(Charsets.UTF_8).size <= MAX_TEXT_BYTES) {
            "That is too long for a message. Send it as a file instead."
        }
        val message = Message(UUID.randomUUID().toString(), text, System.currentTimeMillis(), WAITING, true)
        threads.getOrPut(peerId) { mutableListOf() }.add(message)
        changed()
        return message
    }

    /** A message from `peerId`. `true` when it is new, not a retry. */
    @Synchronized fun receive(peerId: String, id: String, text: String, sentAt: Long): Boolean {
        val thread = threads.getOrPut(peerId) { mutableListOf() }
        if (thread.any { it.id == id }) return false
        thread.add(Message(id, text, sentAt, RECEIVED, false))
        // By the sender's clock: keep the order they were written in.
        thread.sortBy { it.sentAt }
        changed()
        return true
    }

    @Synchronized fun markDelivered(peerId: String, ids: Collection<String>) {
        var any = false
        threads[peerId]?.forEach {
            if (it.state == WAITING && it.id in ids) {
                it.state = DELIVERED
                any = true
            }
        }
        if (any) changed()
    }

    @Synchronized fun waitingFor(peerId: String): List<Message> =
        threads[peerId].orEmpty().filter { it.state == WAITING }

    @Synchronized fun thread(peerId: String): List<Message> = threads[peerId].orEmpty().map { it.copy() }

    /** Each thread as a list shows it: counts, never text. */
    @Synchronized fun summaries(): List<Map<String, Any?>> =
        threads.filterValues { it.isNotEmpty() }.map { (peerId, thread) ->
            mapOf(
                "peerId" to peerId,
                "count" to thread.size,
                "unread" to thread.count { it.state == RECEIVED && !it.read },
                "waiting" to thread.count { it.state == WAITING },
                "lastAtMs" to thread.last().sentAt.toDouble(),
            )
        }

    @Synchronized fun markRead(peerId: String) {
        val thread = threads[peerId] ?: return
        if (thread.none { !it.read }) return
        thread.forEach { it.read = true }
        changed()
    }

    /** Delete a thread, including what still waits to go: "Clear", and unpairing. */
    @Synchronized fun forget(peerId: String) {
        if (threads.remove(peerId) != null) changed()
    }

    fun toMap(m: Message): Map<String, Any?> =
        mapOf("id" to m.id, "text" to m.text, "sentAtMs" to m.sentAt.toDouble(), "state" to m.state, "read" to m.read)

    // ---- Moving messages ------------------------------------------------

    /**
     * We just heard from `peerId` at `addr`: send what waits for it, and
     * fetch what it says waits for us. In the background; nothing to do, or
     * a run for this peer already going, means no run.
     */
    fun onContact(peerId: String, addr: String, waitingThere: Int) {
        synchronized(this) {
            if (waitingThere <= 0 && waitingFor(peerId).isEmpty()) return
            if (!busy.add(peerId)) return
        }
        worker.execute {
            try {
                if (waitingThere > 0) fetchWaiting(peerId, addr)
                deliver(peerId, addr)
            } finally {
                synchronized(this) { busy.remove(peerId) }
            }
        }
    }

    private fun deliver(peerId: String, addr: String) {
        for (message in waitingFor(peerId)) {
            val body = JSONObject().put("id", message.id).put("text", message.text).put("sent_at", message.sentAt)
            when (PeerHttp.postJson(addr, "/api/messages", body)) {
                in 200..299 -> markDelivered(peerId, listOf(message.id))
                // Refused for what it is, not for where we are: the rest
                // must not wait behind it.
                400, 413 -> continue
                else -> break
            }
        }
    }

    private fun fetchWaiting(peerId: String, addr: String) {
        val reply = PeerHttp.request(addr, "GET", "/api/messages/pending", null, Tls.Trust.PAIRED, true, 10_000)
        if (reply.status !in 200..299) return
        val array = try { JSONArray(reply.body) } catch (_: Exception) { return }
        val ids = mutableListOf<String>()
        var new = 0
        for (i in 0 until array.length()) {
            val o = array.optJSONObject(i) ?: continue
            val id = o.optString("id")
            val text = o.optString("text")
            ids += id
            if (id.isNotEmpty() && text.isNotBlank() && text.toByteArray().size <= MAX_TEXT_BYTES &&
                receive(peerId, id, text, o.optLong("sent_at"))
            ) new++
        }
        if (ids.isNotEmpty()) PeerHttp.postJson(addr, "/api/messages/ack", JSONObject().put("ids", JSONArray(ids)))
        if (new > 0) announce(peerId)
    }

    // ---- Routes ---------------------------------------------------------

    /** `POST /api/messages`: a paired device sends us a message. */
    fun handleReceive(peerId: String, body: String): Pair<Int, String> {
        // Escaping can make a valid message's body up to six times its text
        // (a control character is sent as six); the text itself is measured below.
        if (body.length > MAX_TEXT_BYTES * 6 + 4096) return 413 to "too large"
        val o = try { JSONObject(body) } catch (_: Exception) { return 400 to "bad body" }
        val id = o.optString("id")
        val text = o.optString("text")
        if (text.toByteArray(Charsets.UTF_8).size > MAX_TEXT_BYTES) return 413 to "too large"
        if (id.isEmpty() || text.isBlank()) return 400 to "empty"
        if (receive(peerId, id, text, o.optLong("sent_at"))) announce(peerId)
        return 200 to "{\"status\":\"ok\"}"
    }

    /** `GET /api/messages/pending`: what we hold for the caller. */
    fun pendingJson(peerId: String): String = JSONArray().apply {
        waitingFor(peerId).forEach { put(JSONObject().put("id", it.id).put("text", it.text).put("sent_at", it.sentAt)) }
    }.toString()

    /** `POST /api/messages/ack`: the caller has these now. */
    fun handleAck(peerId: String, body: String) {
        val ids = try { JSONObject(body).optJSONArray("ids") } catch (_: Exception) { null } ?: return
        markDelivered(peerId, (0 until ids.length()).map { ids.optString(it) })
    }

    // ---- Notification ---------------------------------------------------

    /** "New message from …". Never the text. */
    private fun announce(peerId: String) {
        val ctx = context ?: return
        val who = PresenceRegistry.nameOf(peerId) ?: "a paired device"
        try {
            val nm = ctx.getSystemService(NotificationManager::class.java)
            nm.createNotificationChannel(NotificationChannel(CHANNEL, "Messages", NotificationManager.IMPORTANCE_DEFAULT))
            val open = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName)?.let {
                PendingIntent.getActivity(ctx, 0, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
            }
            val notification = Notification.Builder(ctx, CHANNEL)
                .setSmallIcon(ctx.applicationInfo.icon)
                .setContentTitle("New message from $who")
                .setContentText("Open LANclave to read it.")
                .setAutoCancel(true)
                .apply { if (open != null) setContentIntent(open) }
                .build()
            nm.notify(peerId.hashCode(), notification)
        } catch (_: Exception) {
            // no permission to notify: the badge in the app still shows it
        }
    }
}
