package expo.modules.nativeserver

import expo.modules.nativeserver.PairingGuard.Admit
import org.junit.Assert.assertEquals
import org.junit.Test

/** Same cases as the tests in desktop-app/src-tauri/src/pairing/guard.rs. */
class PairingGuardTest {
    private val min = 60_000L
    private val t = 1_000_000_000L

    @Test
    fun secondDeviceIsBusyUntilTheFirstIsSettled() {
        val g = PairingGuard()
        assertEquals(Admit.Ok, g.admit("a", "10.0.0.2", t))
        assertEquals(Admit.Busy, g.admit("b", "10.0.0.3", t))
        // The same device asking again is a retry, not a second ceremony.
        assertEquals(Admit.Ok, g.admit("a", "10.0.0.2", t))
        g.paired("a")
        assertEquals(Admit.Ok, g.admit("b", "10.0.0.3", t))
    }

    @Test
    fun anAbandonedCeremonyFreesTheScreen() {
        val g = PairingGuard()
        g.admit("a", "10.0.0.2", t)
        assertEquals(Admit.Ok, g.admit("b", "10.0.0.3", t + PairingGuard.ACTIVE_FOR_MS))
    }

    @Test
    fun ourOwnPairingMakesOthersWait() {
        val g = PairingGuard()
        g.beginOutgoing("a", t)
        assertEquals(Admit.Busy, g.admit("b", "10.0.0.3", t))
        // Rejecting a device we asked is no strike against it.
        g.decline("a", t)
        assertEquals(Admit.Ok, g.admit("a", "10.0.0.2", t))
    }

    @Test
    fun eachRejectionMutesForLonger() {
        val g = PairingGuard()
        var now = t
        for (want in listOf(1L, 5, 30, 120, 1440, 1440)) {
            assertEquals(Admit.Ok, g.admit("a", "10.0.0.2", now))
            g.decline("a", now)
            assertEquals(Admit.CoolingDown(want * min), g.admit("a", "10.0.0.9", now))
            now += want * min
        }
    }

    @Test
    fun aNewDeviceIdFromTheSameAddressIsMutedToo() {
        val g = PairingGuard()
        g.admit("a", "10.0.0.2", t)
        g.decline("a", t)
        assertEquals(Admit.CoolingDown(min), g.admit("fresh", "10.0.0.2", t))
        assertEquals(Admit.Ok, g.admit("fresh", "10.0.0.3", t))
    }

    @Test
    fun anAddressIsNeverMutedPastTheCap() {
        val g = PairingGuard()
        var now = t
        repeat(5) {
            g.admit("a", "10.0.0.2", now)
            g.decline("a", now)
            now += PairingGuard.COOLDOWNS_MS[4]
        }
        g.admit("a", "10.0.0.2", now)
        g.decline("a", now)
        assertEquals(Admit.CoolingDown(PairingGuard.ADDR_COOLDOWN_CAP_MS), g.admit("other", "10.0.0.2", now))
    }

    @Test
    fun pairingOrAQuietDayForgives() {
        val g = PairingGuard()
        g.admit("a", "10.0.0.2", t)
        g.decline("a", t)
        g.admit("a", "10.0.0.2", t + min)
        g.paired("a")
        g.admit("a", "10.0.0.2", t + min)
        g.decline("a", t + min)
        // Back to the first step, not the second.
        assertEquals(Admit.CoolingDown(min), g.admit("a", "10.0.0.2", t + min))

        val later = t + 2 * min + PairingGuard.FORGIVE_AFTER_MS
        assertEquals(Admit.Ok, g.admit("a", "10.0.0.2", later))
        g.decline("a", later)
        assertEquals(Admit.CoolingDown(min), g.admit("a", "10.0.0.2", later))
    }

    @Test
    fun askingThenWithdrawingIsFreeAFewTimesThenARejection() {
        val g = PairingGuard()
        repeat(PairingGuard.FREE_WITHDRAWALS) {
            assertEquals(Admit.Ok, g.admit("a", "10.0.0.2", t))
            g.withdrawn("a", t)
        }
        assertEquals("screen is free", Admit.Ok, g.admit("b", "10.0.0.3", t))
        g.withdrawn("b", t)
        assertEquals(Admit.Ok, g.admit("a", "10.0.0.2", t))
        g.withdrawn("a", t)
        assertEquals(Admit.CoolingDown(min), g.admit("a", "10.0.0.2", t))
        // A new id from the same address has used the address's free ones.
        g.admit("fresh", "10.0.0.2", t + min)
        g.withdrawn("fresh", t + min)
        assertEquals(Admit.CoolingDown(5 * min), g.admit("fresh", "10.0.0.2", t + min))
    }

    @Test
    fun pairingOrAQuietDayRestoresFreeWithdrawals() {
        var g = PairingGuard()
        repeat(PairingGuard.FREE_WITHDRAWALS) {
            g.admit("a", "10.0.0.2", t)
            g.withdrawn("a", t)
        }
        g.admit("a", "10.0.0.2", t)
        g.paired("a")
        g.admit("a", "10.0.0.2", t)
        g.withdrawn("a", t)
        assertEquals("free again after pairing", Admit.Ok, g.admit("a", "10.0.0.2", t))

        g = PairingGuard()
        repeat(PairingGuard.FREE_WITHDRAWALS) {
            g.admit("a", "10.0.0.2", t)
            g.withdrawn("a", t)
        }
        val later = t + PairingGuard.FORGIVE_AFTER_MS
        g.admit("a", "10.0.0.2", later)
        g.withdrawn("a", later)
        assertEquals("free again after a quiet day", Admit.Ok, g.admit("a", "10.0.0.2", later))
    }

    @Test
    fun withdrawingAPairingWeStartedOrAnUnpairIsNoStrike() {
        val g = PairingGuard()
        g.beginOutgoing("a", t)
        g.withdrawn("a", t)
        // An unpair from a device with nothing on screen.
        g.withdrawn("b", t)
        assertEquals(Admit.Ok, g.admit("a", "10.0.0.2", t))
        g.paired("a")
        assertEquals(Admit.Ok, g.admit("b", "10.0.0.3", t))
    }
}
