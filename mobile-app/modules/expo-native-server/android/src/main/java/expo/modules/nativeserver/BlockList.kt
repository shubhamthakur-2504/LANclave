package expo.modules.nativeserver

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * Devices the user blocked from asking to pair. The same rule as
 * `pairing/blocklist.rs` on the desktop.
 *
 * A blocked device's pairing requests are refused before anything reaches
 * the screen. Pairing requests are signed, so a block names the device that
 * really asked; a fresh identity is what the pairing guard's address
 * cooldown is for.
 */
class BlockList(private val file: File?) {
    data class Blocked(val deviceId: String, val deviceName: String?, val blockedAtMs: Long)

    private val devices = mutableListOf<Blocked>()

    init {
        try {
            val array = JSONArray(file?.takeIf { it.exists() }?.readText() ?: "[]")
            for (i in 0 until array.length()) {
                val o = array.getJSONObject(i)
                devices += Blocked(
                    o.getString("device_id"),
                    o.optString("device_name").takeIf { it.isNotEmpty() },
                    o.optLong("blocked_at"),
                )
            }
        } catch (_: Exception) {
            // unreadable: start empty rather than refuse to run
        }
    }

    @Synchronized fun contains(deviceId: String): Boolean = devices.any { it.deviceId == deviceId }

    @Synchronized fun list(): List<Blocked> = devices.toList()

    @Synchronized fun block(deviceId: String, deviceName: String?) {
        if (contains(deviceId)) return
        devices += Blocked(deviceId, deviceName?.takeIf { it.isNotBlank() }, System.currentTimeMillis())
        save()
    }

    /** `true` when it was blocked. */
    @Synchronized fun unblock(deviceId: String): Boolean {
        val removed = devices.removeAll { it.deviceId == deviceId }
        if (removed) save()
        return removed
    }

    private fun save() {
        val target = file ?: return
        val array = JSONArray()
        for (d in devices) {
            array.put(
                JSONObject()
                    .put("device_id", d.deviceId)
                    .put("device_name", d.deviceName ?: "")
                    .put("blocked_at", d.blockedAtMs),
            )
        }
        try {
            target.writeText(array.toString())
        } catch (_: Exception) {
            // kept in memory for this run
        }
    }

    companion object {
        @Volatile private var instance: BlockList? = null

        /** The saved list, loaded on first use. */
        fun shared(context: Context): BlockList =
            instance ?: synchronized(this) {
                instance ?: BlockList(File(context.filesDir, "blocked_devices.json")).also { instance = it }
            }

        /** The list if loaded; nothing is blocked before the app has started. */
        fun sharedOrNull(): BlockList? = instance
    }
}
