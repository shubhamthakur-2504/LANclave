package expo.modules.nativeserver

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The phone must show the same six digits as the desktop and the JS side,
 * or every pairing is rejected as a mismatch. Expected values come from an
 * independent SHA-256 of the bytewise-sorted keys.
 */
class PairingCodeTest {
    @Test
    fun ordersKeysAsUnsignedBytes() {
        // 0x80 is negative as a signed Kotlin Byte; a signed comparison
        // would hash the keys in the wrong order and give 548798.
        val a = ByteArray(32) { 0x80.toByte() }
        val b = ByteArray(32) { 0x01 }
        assertEquals("961434", PairingCode.compute(a, b))
    }

    @Test
    fun isSymmetric() {
        val c = ByteArray(32) { it.toByte() }
        val d = ByteArray(32) { (it + 1).toByte() }
        assertEquals("771556", PairingCode.compute(c, d))
        assertEquals("771556", PairingCode.compute(d, c))
    }
}
