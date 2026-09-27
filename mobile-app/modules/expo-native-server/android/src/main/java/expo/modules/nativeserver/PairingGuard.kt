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
 * - Asking then withdrawing is a rejection too, after a few free ones.
 *   Otherwise ask-and-withdraw, over and over, flashed a sheet here each
 *   time and never earned a strike. The free ones cover a genuine retry
 *   whose code never showed for some technical reason.
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

    private class Withdrawals(val count: Int, val lastMs: Long)

    private var active: Active? = null
    private val strikes = HashMap<String, Strikes>()
    private val withdrawals = HashMap<String, Withdrawals>()

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

    /** A strike, unless [key] still has free withdrawals left. */
    private fun withdrawal(key: String, capMs: Long?, nowMs: Long) {
        val prev = withdrawals[key]
        val count = if (prev != null && nowMs < prev.lastMs + FORGIVE_AFTER_MS) prev.count + 1 else 1
        withdrawals[key] = Withdrawals(count, nowMs)
        if (count > FREE_WITHDRAWALS) strike(key, capMs, nowMs)
    }

    private fun forgive(key: String) {
        strikes.remove(key)
        withdrawals.remove(key)
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
            it.ip?.let { ip -> forgive(ipKey(ip)) }
        }
        forgive(idKey(deviceId))
    }

    /**
     * The other device withdrew. If it had asked us, that is a rejection once
     * its free withdrawals are used up; one we asked, or an unpair with
     * nothing on screen, costs nothing.
     */
    @Synchronized
    fun withdrawn(deviceId: String, nowMs: Long = System.currentTimeMillis()) {
        val a = active?.takeIf { it.deviceId == deviceId } ?: return
        active = null
        val ip = a.ip ?: return
        withdrawal(idKey(deviceId), null, nowMs)
        withdrawal(ipKey(ip), ADDR_COOLDOWN_CAP_MS, nowMs)
    }

    companion object {
        private const val MINUTE_MS = 60_000L

        /** A ceremony left open this long no longer holds the screen. */
        const val ACTIVE_FOR_MS = 2 * MINUTE_MS

        /** Cooldown after the 1st, 2nd, ... rejection; the last repeats. */
        val COOLDOWNS_MS = longArrayOf(MINUTE_MS, 5 * MINUTE_MS, 30 * MINUTE_MS, 120 * MINUTE_MS, 1440 * MINUTE_MS)

        /** Addresses get reassigned, so an address is never muted longer than this. */
        const val ADDR_COOLDOWN_CAP_MS = 30 * MINUTE_MS

        /** Withdrawals of a request to us that cost nothing; the next ones strike. */
        const val FREE_WITHDRAWALS = 3

        /**
         * Strikes are forgotten this long after the cooldown they earned ends,
         * and free withdrawals come back this long after the last one.
         */
        const val FORGIVE_AFTER_MS = 1440 * MINUTE_MS

        /** The one the server admits requests through and JS settles them with. */
        val shared = PairingGuard()

        private fun idKey(id: String) = "id:$id"
        private fun ipKey(ip: String) = "ip:$ip"
    }
}
