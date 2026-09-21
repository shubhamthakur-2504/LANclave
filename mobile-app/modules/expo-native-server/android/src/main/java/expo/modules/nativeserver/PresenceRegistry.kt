package expo.modules.nativeserver

import java.util.concurrent.ConcurrentHashMap

/**
 * Inbound presence: which paired peers have talked to this server, and when.
 *
 * Any authenticated request is a liveness signal, so the server records one
 * here on every request -- free, with no extra traffic. Explicit hello/bye
 * announcements update the same table. JS reads it locally through the
 * module (no network) and merges it with its own outbound heartbeat.
 *
 * A process-wide object rather than a server field, so the table survives the
 * server being restarted and the module can read it without a server handle.
 */
object PresenceRegistry {
    data class Entry(
        val deviceId: String,
        val lastSeenMs: Long,
        val ip: String?,
        val port: Int?,
        val deviceName: String?,
        /** Set by an explicit bye; cleared by any later contact. */
        val offline: Boolean,
    )

    private val entries = ConcurrentHashMap<String, Entry>()

    fun markSeen(deviceId: String, ip: String?, port: Int? = null, deviceName: String? = null) {
        entries.compute(deviceId) { _, prev ->
            Entry(
                deviceId = deviceId,
                lastSeenMs = System.currentTimeMillis(),
                ip = ip ?: prev?.ip,
                port = port ?: prev?.port,
                deviceName = deviceName ?: prev?.deviceName,
                offline = false,
            )
        }
    }

    fun markOffline(deviceId: String) {
        entries.computeIfPresent(deviceId) { _, prev -> prev.copy(offline = true) }
    }

    fun snapshot(): List<Map<String, Any?>> = entries.values.map {
        mapOf(
            "deviceId" to it.deviceId,
            "lastSeenMs" to it.lastSeenMs.toDouble(),
            "ip" to it.ip,
            "port" to it.port,
            "deviceName" to it.deviceName,
            "offline" to it.offline,
        )
    }
}
