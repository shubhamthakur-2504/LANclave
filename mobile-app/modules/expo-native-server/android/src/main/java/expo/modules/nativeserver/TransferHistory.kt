package expo.modules.nativeserver

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FilterInputStream
import java.io.InputStream
import java.util.UUID

/**
 * Transfer history, kept for 30 days -- the phone's side of
 * `desktop-app/src-tauri/src/history.rs`, with the same JSON fields.
 *
 * The server logs what peers do to us (`initiated_by: "peer"`); the JS app
 * logs what it starts itself (`"me"`) through the module. Stored as JSON
 * lines in app-private storage, never in the user-visible sandbox.
 */
object TransferHistory {
    const val RETENTION_MS = 30L * 24 * 60 * 60 * 1000
    private const val FILE_NAME = "transfer_history.jsonl"
    private val lock = Any()

    private fun file(context: Context) = File(context.filesDir, FILE_NAME)

    fun entry(
        direction: String,
        initiatedBy: String,
        peerId: String,
        peerName: String?,
        fileName: String,
    ): JSONObject = JSONObject()
        .put("id", UUID.randomUUID().toString())
        .put("at_ms", System.currentTimeMillis())
        .put("direction", direction)
        .put("initiated_by", initiatedBy)
        .put("peer_id", peerId)
        .put("peer_name", peerName ?: JSONObject.NULL)
        .put("file_name", fileName)
        .put("dest_name", JSONObject.NULL)
        .put("bytes", 0)
        .put("outcome", "completed")
        .put("error", JSONObject.NULL)

    fun record(context: Context, entry: JSONObject) {
        synchronized(lock) {
            file(context).appendText(entry.toString() + "\n")
            prune(context)
        }
    }

    /** Entries from the last 30 days, newest first, as a JSON array string. */
    fun list(context: Context): String {
        synchronized(lock) {
            val entries = prune(context).sortedByDescending { it.optLong("at_ms") }
            return JSONArray(entries).toString()
        }
    }

    fun clear(context: Context) {
        synchronized(lock) { file(context).delete() }
    }

    /**
     * Read the log, dropping entries past retention and unreadable lines;
     * the file is rewritten only when something was dropped.
     */
    private fun prune(context: Context): List<JSONObject> {
        val f = file(context)
        if (!f.exists()) return emptyList()
        val cutoff = System.currentTimeMillis() - RETENTION_MS
        val lines = f.readLines().filter { it.isNotBlank() }
        val kept = lines.mapNotNull { line ->
            runCatching { JSONObject(line) }.getOrNull()?.takeIf { it.optLong("at_ms") >= cutoff }
        }
        if (kept.size != lines.size) {
            val tmp = File(f.parentFile, "$FILE_NAME.tmp")
            tmp.writeText(kept.joinToString("") { it.toString() + "\n" })
            tmp.renameTo(f)
        }
        return kept
    }

    /**
     * Wraps a file being served to a peer and logs the pull when NanoHTTPD
     * closes it: completed if every byte went out, failed if the peer hung
     * up first.
     */
    class LoggingInputStream(
        input: InputStream,
        private val context: Context,
        private val entry: JSONObject,
        private val expected: Long,
    ) : FilterInputStream(input) {
        private var sent = 0L
        private var logged = false

        override fun read(): Int = super.read().also { if (it >= 0) sent++ }

        override fun read(b: ByteArray, off: Int, len: Int): Int =
            super.read(b, off, len).also { if (it > 0) sent += it }

        override fun close() {
            try {
                super.close()
            } finally {
                if (!logged) {
                    logged = true
                    entry.put("bytes", sent).put("at_ms", System.currentTimeMillis())
                    if (sent < expected) {
                        entry.put("outcome", "failed").put("error", "stopped after $sent of $expected bytes")
                    }
                    runCatching { record(context, entry) }
                }
            }
        }
    }
}
