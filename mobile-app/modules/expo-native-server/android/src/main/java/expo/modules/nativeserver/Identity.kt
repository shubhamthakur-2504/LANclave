package expo.modules.nativeserver

import java.security.KeyFactory
import java.security.PrivateKey
import java.security.Signature
import java.security.spec.PKCS8EncodedKeySpec
import java.util.Base64

/**
 * This phone's identity for requests native code sends itself (P4): the
 * same Ed25519 key JS signs with, handed over at start and kept in memory
 * only. Signing here means every request -- including each resume, however
 * late -- carries a fresh signature, instead of headers JS signed once.
 *
 * Same scheme as `identity.ts` and the desktop: sign "deviceId:timestamp".
 */
object Identity {
    /** PKCS#8 wrapping of a raw 32-byte Ed25519 seed (RFC 8410). */
    private val PKCS8_PREFIX = byteArrayOf(
        0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
    )

    @Volatile var deviceId: String? = null
        private set
    @Volatile private var key: PrivateKey? = null

    fun set(deviceId: String, seedHex: String) {
        val key = privateKey(hexToBytes(seedHex))
        // Same identity as before: keep the certificate peers already saw.
        val unchanged = this.deviceId == deviceId && Tls.isReady
        this.key = key
        this.deviceId = deviceId
        if (!unchanged) {
            Tls.setIdentity(Base64.getMimeDecoder().decode(deviceId)) { message -> sign(key, message) }
        }
    }

    val isSet: Boolean get() = key != null && deviceId != null

    fun privateKey(seed: ByteArray): PrivateKey {
        require(seed.size == 32) { "Ed25519 seed must be 32 bytes" }
        return KeyFactory.getInstance("Ed25519").generatePrivate(PKCS8EncodedKeySpec(PKCS8_PREFIX + seed))
    }

    fun sign(key: PrivateKey, message: ByteArray): ByteArray =
        Signature.getInstance("Ed25519").run {
            initSign(key)
            update(message)
            sign()
        }

    /** The three auth headers for one request, signed now. */
    fun authHeaders(): Map<String, String> {
        val id = deviceId ?: throw IllegalStateException("identity not set")
        val k = key ?: throw IllegalStateException("identity not set")
        val ts = (System.currentTimeMillis() / 1000).toString()
        val sig = Base64.getEncoder().encodeToString(sign(k, "$id:$ts".toByteArray(Charsets.UTF_8)))
        return mapOf(
            "X-LANclave-Device-Id" to id,
            "X-LANclave-Timestamp" to ts,
            "X-LANclave-Signature" to sig,
        )
    }

    fun hexToBytes(hex: String): ByteArray {
        require(hex.length % 2 == 0) { "odd hex length" }
        return ByteArray(hex.length / 2) { i -> hex.substring(i * 2, i * 2 + 2).toInt(16).toByte() }
    }
}
