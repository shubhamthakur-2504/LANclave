package expo.modules.nativeserver

import java.io.ByteArrayInputStream
import java.net.Socket
import java.security.KeyFactory
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.SecureRandom
import java.security.Signature
import java.security.cert.CertificateException
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.security.spec.ECGenParameterSpec
import java.security.spec.X509EncodedKeySpec
import java.util.Base64
import javax.net.ssl.KeyManagerFactory
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLEngine
import javax.net.ssl.SSLServerSocketFactory
import javax.net.ssl.SSLSocketFactory
import javax.net.ssl.X509ExtendedTrustManager

/**
 * Encrypted connections between devices. The same scheme as `tls.rs` on the
 * desktop, and the two must stay in step.
 *
 * A device's identity is an Ed25519 key, which signs but cannot encrypt, so
 * each device makes a separate TLS key and has its identity vouch for it:
 * the certificate carries an extension holding the device's public key and
 * its signature over the certificate's own public key. Whoever sees that
 * certificate knows, from the handshake alone, which device it is talking
 * to. No certificate authority, and nothing to store: the TLS key is made
 * fresh each time the identity is set.
 *
 * The server still identifies the *client* by its signed headers, as
 * before. TLS adds confidentiality and proves the server.
 */
object Tls {
    /** The extension carrying the claim: 32 bytes of key, then 64 of signature. */
    const val ATTESTATION_OID = "2.25.8377001"

    /** What the identity key signs: this, then the SubjectPublicKeyInfo. */
    private val CONTEXT = "lanclave-tls-v1:".toByteArray(Charsets.US_ASCII)

    private const val KEY_LEN = 32
    private const val SIG_LEN = 64

    /** SubjectPublicKeyInfo header for a raw Ed25519 public key (RFC 8410). */
    private val ED25519_SPKI_PREFIX = byteArrayOf(
        0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
    )

    /** ecdsa-with-SHA256, as an AlgorithmIdentifier. */
    private val ECDSA_SHA256 = der(0x30, der(0x06, oid("1.2.840.10045.4.3.2")))

    class Credentials(val key: java.security.PrivateKey, val certificate: X509Certificate)

    // ---- This device's certificate -------------------------------------

    @Volatile private var credentials: Credentials? = null

    /** Public keys of the paired devices, as hex: who [Trust.PAIRED] accepts. */
    @Volatile private var pairedKeys: Set<String> = emptySet()

    /** Replace the paired list, given as device ids (base64 public keys). */
    fun setPairedDevices(deviceIds: Collection<String>) {
        pairedKeys = deviceIds.mapNotNull { id ->
            try {
                Base64.getMimeDecoder().decode(id).takeIf { it.size == KEY_LEN }?.let(::hex)
            } catch (_: IllegalArgumentException) {
                null
            }
        }.toSet()
    }

    private fun hex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it) }

    /** Make this device's certificate, signed for by its identity key. */
    fun setIdentity(publicKey: ByteArray, sign: (ByteArray) -> ByteArray) {
        credentials = generate(publicKey, sign)
    }

    val isReady: Boolean get() = credentials != null

    /** A fresh TLS key and a certificate for it, vouched for by the identity. */
    fun generate(identityPublicKey: ByteArray, sign: (ByteArray) -> ByteArray): Credentials {
        require(identityPublicKey.size == KEY_LEN) { "Ed25519 public key must be 32 bytes" }
        val pair: KeyPair = KeyPairGenerator.getInstance("EC").run {
            initialize(ECGenParameterSpec("secp256r1"))
            generateKeyPair()
        }
        // An EC public key's own encoding is its SubjectPublicKeyInfo.
        val spki = pair.public.encoded
        val signature = sign(CONTEXT + spki)
        require(signature.size == SIG_LEN) { "Ed25519 signature must be 64 bytes" }

        val name = der(0x30, der(0x31, der(0x30, der(0x06, oid("2.5.4.3")), der(0x0c, "LANclave".toByteArray()))))
        // Positive, and with no leading zero byte: DER wants the shortest form.
        val serial = ByteArray(16).also {
            SecureRandom().nextBytes(it)
            it[0] = ((it[0].toInt() and 0x7f) or 0x40).toByte()
        }
        val extensions = der(0x30, der(0x30, der(0x06, oid(ATTESTATION_OID)), der(0x04, identityPublicKey + signature)))
        val tbs = der(
            0x30,
            der(0xa0, der(0x02, byteArrayOf(2))), // version 3
            der(0x02, serial),
            ECDSA_SHA256,
            name, // issuer
            // The certificate lives as long as the process; peers ignore the
            // dates, since a phone's clock may be wrong.
            der(0x30, der(0x17, "200101000000Z".toByteArray()), der(0x17, "491231235959Z".toByteArray())),
            name, // subject
            spki,
            der(0xa3, extensions),
        )
        val tbsSignature = Signature.getInstance("SHA256withECDSA").run {
            initSign(pair.private)
            update(tbs)
            sign()
        }
        val encoded = der(0x30, tbs, ECDSA_SHA256, der(0x03, byteArrayOf(0) + tbsSignature))
        val certificate = CertificateFactory.getInstance("X.509")
            .generateCertificate(ByteArrayInputStream(encoded)) as X509Certificate
        return Credentials(pair.private, certificate)
    }

    /**
     * The device a certificate belongs to: the identity key in its claim,
     * once that key's signature over the certificate's own key has checked
     * out. Throws [CertificateException] otherwise.
     */
    fun attestedDevice(certificate: X509Certificate): ByteArray {
        val wrapped = certificate.getExtensionValue(ATTESTATION_OID)
            ?: throw CertificateException("the certificate does not say which LANclave device it belongs to")
        // getExtensionValue returns the claim inside an OCTET STRING.
        val claim = octetString(wrapped)
        if (claim.size != KEY_LEN + SIG_LEN) throw CertificateException("the certificate could not be read")
        val key = claim.copyOfRange(0, KEY_LEN)
        val signature = claim.copyOfRange(KEY_LEN, claim.size)

        val valid = try {
            Signature.getInstance("Ed25519").run {
                initVerify(KeyFactory.getInstance("Ed25519").generatePublic(X509EncodedKeySpec(ED25519_SPKI_PREFIX + key)))
                update(CONTEXT + certificate.publicKey.encoded)
                verify(signature)
            }
        } catch (_: Exception) {
            false
        }
        if (!valid) throw CertificateException("the certificate is not signed by the device it claims to be")
        return key
    }

    // ---- Whose certificate a client accepts ----------------------------

    enum class Trust {
        /** Devices in the paired list: everything that carries files or names. */
        PAIRED,

        /**
         * Any device that proves the identity it claims: discovery and
         * pairing, where no trust exists yet. Never send it anything private.
         */
        ANYONE,
    }

    private class PeerTrustManager(private val allows: (ByteArray) -> Boolean) : X509ExtendedTrustManager() {
        private fun check(chain: Array<out X509Certificate>?) {
            val leaf = chain?.firstOrNull() ?: throw CertificateException("no certificate")
            // Devices are reached by address, and an address proves nothing;
            // the claim inside the certificate is the identity.
            if (!allows(attestedDevice(leaf))) {
                throw CertificateException("that device is not paired with this one")
            }
        }

        override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) = check(chain)
        override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?, socket: Socket?) = check(chain)
        override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?, engine: SSLEngine?) = check(chain)

        // This side never asks clients for certificates.
        private fun noClients(): Nothing = throw CertificateException("client certificates are not used")
        override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) = noClients()
        override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?, socket: Socket?) = noClients()
        override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?, engine: SSLEngine?) = noClients()

        override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
    }

    /** Sockets for requests to other devices, accepting those [allows] does. */
    fun clientSocketFactory(allows: (ByteArray) -> Boolean): SSLSocketFactory =
        SSLContext.getInstance("TLS").apply { init(null, arrayOf(PeerTrustManager(allows)), null) }.socketFactory

    private val pairedFactory: SSLSocketFactory by lazy {
        clientSocketFactory { key -> hex(key) in pairedKeys }
    }
    private val openFactory: SSLSocketFactory by lazy { clientSocketFactory { true } }

    fun clientSocketFactory(trust: Trust): SSLSocketFactory = when (trust) {
        Trust.PAIRED -> pairedFactory
        Trust.ANYONE -> openFactory
    }

    /** Server sockets presenting this device's certificate. */
    fun serverSocketFactory(): SSLServerSocketFactory =
        serverSocketFactory(credentials ?: throw IllegalStateException("identity not set"))

    fun serverSocketFactory(credentials: Credentials): SSLServerSocketFactory {
        val password = CharArray(0)
        val store = KeyStore.getInstance(KeyStore.getDefaultType()).apply {
            load(null, null)
            setKeyEntry("lanclave", credentials.key, password, arrayOf(credentials.certificate))
        }
        val keys = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm()).apply { init(store, password) }
        return SSLContext.getInstance("TLS").apply { init(keys.keyManagers, null, null) }.serverSocketFactory
    }

    // ---- DER, just enough to write one certificate ---------------------

    private fun der(tag: Int, vararg parts: ByteArray): ByteArray {
        val body = parts.fold(ByteArray(0)) { all, part -> all + part }
        return byteArrayOf(tag.toByte()) + derLength(body.size) + body
    }

    private fun derLength(n: Int): ByteArray = when {
        n < 0x80 -> byteArrayOf(n.toByte())
        n < 0x100 -> byteArrayOf(0x81.toByte(), n.toByte())
        else -> byteArrayOf(0x82.toByte(), (n shr 8).toByte(), n.toByte())
    }

    /** DER contents of a dotted object identifier (without tag and length). */
    private fun oid(dotted: String): ByteArray {
        val arcs = dotted.split('.').map { it.toLong() }
        var out = byteArrayOf((arcs[0] * 40 + arcs[1]).toByte())
        for (arc in arcs.drop(2)) {
            var groups = byteArrayOf((arc and 0x7f).toByte())
            var rest = arc shr 7
            while (rest > 0) {
                groups = byteArrayOf(((rest and 0x7f) or 0x80).toByte()) + groups
                rest = rest shr 7
            }
            out += groups
        }
        return out
    }

    /** The contents of a DER OCTET STRING. */
    private fun octetString(encoded: ByteArray): ByteArray {
        if (encoded.size < 2 || encoded[0].toInt() != 0x04) throw CertificateException("the certificate could not be read")
        val first = encoded[1].toInt() and 0xff
        val (length, start) = when {
            first < 0x80 -> first to 2
            first == 0x81 && encoded.size >= 3 -> (encoded[2].toInt() and 0xff) to 3
            else -> throw CertificateException("the certificate could not be read")
        }
        if (start + length != encoded.size) throw CertificateException("the certificate could not be read")
        return encoded.copyOfRange(start, start + length)
    }
}
