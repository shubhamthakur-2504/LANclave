package expo.modules.nativeserver

import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/** Signed HTTP to paired peers, from native code. Blocking: call off the main thread. */
object PeerHttp {
    private const val CONNECT_TIMEOUT_MS = 5_000
    /** Idle timeout, not a total one: large files take as long as they take. */
    private const val READ_TIMEOUT_MS = 30_000

    /** A signed request, not yet sent. The caller reads and disconnects. */
    fun open(
        addr: String,
        path: String,
        method: String = "GET",
        extraHeaders: Map<String, String> = emptyMap(),
    ): HttpURLConnection {
        val conn = URL("http://$addr$path").openConnection() as HttpURLConnection
        conn.requestMethod = method
        conn.connectTimeout = CONNECT_TIMEOUT_MS
        conn.readTimeout = READ_TIMEOUT_MS
        conn.instanceFollowRedirects = false
        Identity.authHeaders().forEach { (k, v) -> conn.setRequestProperty(k, v) }
        extraHeaders.forEach { (k, v) -> conn.setRequestProperty(k, v) }
        return conn
    }

    /** GET a JSON object; null on any non-2xx or error. */
    fun getJson(addr: String, path: String): JSONObject? = try {
        val conn = open(addr, path)
        try {
            if (conn.responseCode !in 200..299) null
            else JSONObject(conn.inputStream.bufferedReader().use { it.readText() })
        } finally {
            conn.disconnect()
        }
    } catch (_: Exception) {
        null
    }

    /** POST a JSON body; returns the status, or -1 if unreachable. */
    fun postJson(addr: String, path: String, body: JSONObject): Int = try {
        val conn = open(addr, path, "POST", mapOf("Content-Type" to "application/json"))
        conn.doOutput = true
        val bytes = body.toString().toByteArray(Charsets.UTF_8)
        conn.setFixedLengthStreamingMode(bytes.size)
        try {
            conn.outputStream.use { it.write(bytes) }
            conn.responseCode
        } finally {
            conn.disconnect()
        }
    } catch (_: Exception) {
        -1
    }

    /** Whether the peer's server speaks offers (from its pairing status). */
    fun supportsOffers(addr: String): Boolean {
        val features = getJson(addr, "/api/pairing/status")?.optJSONArray("features") ?: return false
        return (0 until features.length()).any { features.optString(it) == "offers" }
    }
}

/** Events to JS. The module installs the sink; without one they are dropped. */
object Events {
    @Volatile var sink: ((String, Map<String, Any?>) -> Unit)? = null

    fun emit(name: String, body: Map<String, Any?>) {
        try {
            sink?.invoke(name, body)
        } catch (_: Exception) {
            // JS not ready; state is re-read on demand anyway.
        }
    }
}
