package expo.modules.nativeserver

import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import javax.net.ssl.HttpsURLConnection

/** Signed HTTP to paired peers, from native code. Blocking: call off the main thread. */
object PeerHttp {
    private const val CONNECT_TIMEOUT_MS = 5_000
    /** Idle timeout, not a total one: large files take as long as they take. */
    private const val READ_TIMEOUT_MS = 30_000

    /**
     * A request over TLS, not yet sent. The caller reads and disconnects.
     *
     * [trust] says whose certificate is accepted: paired devices by default,
     * anyone only for discovery and pairing. [signed] adds the auth headers
     * that tell the peer who is asking.
     */
    fun open(
        addr: String,
        path: String,
        method: String = "GET",
        extraHeaders: Map<String, String> = emptyMap(),
        trust: Tls.Trust = Tls.Trust.PAIRED,
        signed: Boolean = true,
        timeoutMs: Int? = null,
    ): HttpURLConnection {
        val conn = URL("https://$addr$path").openConnection() as HttpsURLConnection
        conn.sslSocketFactory = Tls.clientSocketFactory(trust)
        // Devices are reached by address; the certificate's claim, checked
        // by the socket factory, is what identifies them.
        conn.setHostnameVerifier { _, _ -> true }
        conn.requestMethod = method
        conn.connectTimeout = timeoutMs ?: CONNECT_TIMEOUT_MS
        conn.readTimeout = timeoutMs ?: READ_TIMEOUT_MS
        conn.instanceFollowRedirects = false
        if (signed) Identity.authHeaders().forEach { (k, v) -> conn.setRequestProperty(k, v) }
        extraHeaders.forEach { (k, v) -> conn.setRequestProperty(k, v) }
        return conn
    }

    /** What a request came back with; a negative `status` when nothing did. */
    class Reply(val status: Int, val body: String)

    /** Nothing answered at that address. */
    const val UNREACHABLE = -1
    /** It did not answer in time. */
    const val TIMED_OUT = -2
    /** Something answered, but not a device we accept: not LANclave 2, or not paired. */
    const val REFUSED_CERTIFICATE = -3

    /**
     * One whole request, for the calls JS used to make with `fetch`, which
     * cannot check a certificate like ours. Never throws. [onOpen] gets the
     * connection before anything is sent, for a caller that may need to cut
     * it off from another thread (`disconnect()`).
     */
    fun request(
        addr: String,
        method: String,
        path: String,
        body: String?,
        trust: Tls.Trust,
        signed: Boolean,
        timeoutMs: Int,
        onOpen: ((HttpURLConnection) -> Unit)? = null,
    ): Reply = try {
        val headers = if (body != null) mapOf("Content-Type" to "application/json") else emptyMap()
        val conn = open(addr, path, method, headers, trust, signed, timeoutMs)
        onOpen?.invoke(conn)
        try {
            if (body != null) {
                val bytes = body.toByteArray(Charsets.UTF_8)
                conn.doOutput = true
                conn.setFixedLengthStreamingMode(bytes.size)
                conn.outputStream.use { it.write(bytes) }
            }
            val status = conn.responseCode
            val stream = if (status in 200..399) conn.inputStream else conn.errorStream
            Reply(status, stream?.bufferedReader()?.use { it.readText() } ?: "")
        } finally {
            conn.disconnect()
        }
    } catch (_: java.net.SocketTimeoutException) {
        Reply(TIMED_OUT, "")
    } catch (_: javax.net.ssl.SSLException) {
        Reply(REFUSED_CERTIFICATE, "")
    } catch (_: Exception) {
        Reply(UNREACHABLE, "")
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
