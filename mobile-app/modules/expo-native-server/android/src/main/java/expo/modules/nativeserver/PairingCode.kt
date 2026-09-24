package expo.modules.nativeserver

import java.security.MessageDigest

/**
 * The 6-digit pairing code, identical to `compute_pairing_fingerprint` in
 * `desktop-app/src-tauri/src/pairing/handshake.rs` and `computeFingerprint`
 * in `mobile-app/src/services/pairing.ts`: the two 32-byte public keys,
 * ordered bytewise, hashed with SHA-256; the first three bytes mod 10^6.
 *
 * The humans comparing both screens are the security boundary; this only
 * has to give both devices the same number for the same pair of keys.
 */
object PairingCode {
    /** Decode a base64 device id to its 32-byte public key, or null. */
    fun publicKey(deviceId: String): ByteArray? = try {
        android.util.Base64.decode(deviceId, android.util.Base64.DEFAULT).takeIf { it.size == 32 }
    } catch (_: IllegalArgumentException) {
        null
    }

    fun compute(a: ByteArray, b: ByteArray): String {
        val (first, second) = if (compareUnsigned(a, b) < 0) a to b else b to a
        val hash = MessageDigest.getInstance("SHA-256").digest(first + second)
        val value = ((hash[0].toInt() and 0xff) shl 16) or
            ((hash[1].toInt() and 0xff) shl 8) or
            (hash[2].toInt() and 0xff)
        return (value % 1_000_000).toString().padStart(6, '0')
    }

    private fun compareUnsigned(a: ByteArray, b: ByteArray): Int {
        for (i in 0 until minOf(a.size, b.size)) {
            val x = a[i].toInt() and 0xff
            val y = b[i].toInt() and 0xff
            if (x != y) return x - y
        }
        return a.size - b.size
    }
}
