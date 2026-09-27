package expo.modules.nativeserver

/**
 * Who may put a pairing sheet on this screen, and when.
 *
 * Anyone on the network can ask to pair, anywhere, at any time -- that is
 * deliberate. What this stops is the asking becoming a nuisance:
 *
 * - One ceremony at a time. While a code is on screen (asked of us, or
 *   started here), other devices are told we are busy instead of replacing
 *   it. Two overlapping requests made the codes look like they did not match.
 * - Escalating cooldown. Each rejection mutes that device for longer:
 *   1 min, 5 min, 30 min, 2 h, then 24 h. Keyed by device id *and* address,
 *   since a new device id costs nothing to make; the address cooldown is
 *   capped lower because networks hand old addresses to new devices.
 *
 * In memory only. Must agree with desktop-app/src-tauri/src/pairing/guard.rs,
 * rule for rule.
 */
class PairingGuard {
    sealed class Admit {
        object Ok : Admit()
        /** Another device's code is on screen. */
        object Busy : Admit()
        /** Declined recently; ask again after this long. */
        data class CoolingDown(val leftMs: Long) : Admit()
    }

    /** `ip` is where an incoming request came from; null when we started it. */
    private class Active(val deviceId: String, val ip: String?, val untilMs: Long)

    private class Strikes(val count: Int, val mutedUntilMs: Long)

    private var active: Active? = null
    private val strikes = HashMap<String, Strikes>()

    private fun activeAt(nowMs: Long): Active? {
        if (active?.let { it.untilMs <= nowMs } == true) active = null
        return active
    }

    private fun mutedFor(key: String, nowMs: Long): Long? {
        val s = strikes[key] ?: return null
        if (nowMs >= s.mutedUntilMs + FORGIVE_AFTER_MS) {
            strikes.remove(key)
            return null
        }
        return (s.mutedUntilMs - nowMs).takeIf { it > 0 }
    }

    private fun strike(key: String, capMs: Long?, nowMs: Long) {
        val prev = strikes[key]
        val count = if (prev != null && nowMs < prev.mutedUntilMs + FORGIVE_AFTER_MS) prev.count + 1 else 1
        var cooldown = COOLDOWNS_MS[minOf(count - 1, COOLDOWNS_MS.size - 1)]
        if (capMs != null) cooldown = minOf(cooldown, capMs)
        strikes[key] = Strikes(count, nowMs + cooldown)
    }

    /** May [deviceId], asking from [ip], open a pairing sheet here? On Ok its ceremony holds the screen. */
    @Synchronized
    fun admit(deviceId: String, ip: String, nowMs: Long = System.currentTimeMillis()): Admit {
        val muted = listOfNotNull(mutedFor(idKey(deviceId), nowMs), mutedFor(ipKey(ip), nowMs)).maxOrNull()
        if (muted != null) return Admit.CoolingDown(muted)
        if (activeAt(nowMs)?.let { it.deviceId != deviceId } == true) return Admit.Busy
        active = Active(deviceId, ip, nowMs + ACTIVE_FOR_MS)
        return Admit.Ok
    }

    /** The user here started pairing with [deviceId]: hold the screen for it. */
    @Synchronized
    fun beginOutgoing(deviceId: String, nowMs: Long = System.currentTimeMillis()) {
        active = Active(deviceId, null, nowMs + ACTIVE_FOR_MS)
    }

    /** The user here rejected the codes. A device that asked us earns a strike; one we asked did nothing wrong. */
    @Synchronized
    fun decline(deviceId: String, nowMs: Long = System.currentTimeMillis()) {
        val a = active?.takeIf { it.deviceId == deviceId } ?: return
        active = null
        val ip = a.ip ?: return
        strike(idKey(deviceId), null, nowMs)
        strike(ipKey(ip), ADDR_COOLDOWN_CAP_MS, nowMs)
    }

    /** Paired: forgive the device and free the screen. */
    @Synchronized
    fun paired(deviceId: String) {
        active?.takeIf { it.deviceId == deviceId }?.let {
            active = null
            it.ip?.let { ip -> strikes.remove(ipKey(ip)) }
        }
        strikes.remove(idKey(deviceId))
    }

    /** The other device withdrew: free the screen, no strike. */
    @Synchronized
    fun withdrawn(deviceId: String) {
        if (active?.deviceId == deviceId) active = null
    }

    companion object {
        private const val MINUTE_MS = 60_000L

        /** A ceremony left open this long no longer holds the screen. */
        const val ACTIVE_FOR_MS = 2 * MINUTE_MS

        /** Cooldown after the 1st, 2nd, ... rejection; the last repeats. */
        val COOLDOWNS_MS = longArrayOf(MINUTE_MS, 5 * MINUTE_MS, 30 * MINUTE_MS, 120 * MINUTE_MS, 1440 * MINUTE_MS)

        /** Addresses get reassigned, so an address is never muted longer than this. */
        const val ADDR_COOLDOWN_CAP_MS = 30 * MINUTE_MS

        /** Strikes are forgotten this long after the cooldown they earned ends. */
        const val FORGIVE_AFTER_MS = 1440 * MINUTE_MS

        /** The one the server admits requests through and JS settles them with. */
        val shared = PairingGuard()

        private fun idKey(id: String) = "id:$id"
        private fun ipKey(ip: String) = "ip:$ip"
    }
}
