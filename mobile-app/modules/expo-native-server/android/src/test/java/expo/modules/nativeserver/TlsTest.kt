package expo.modules.nativeserver

import fi.iki.elonen.NanoHTTPD
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.URL
import java.security.cert.CertificateException
import javax.net.ssl.HttpsURLConnection

class TlsTest {
    /** RFC 8032, section 7.1, TEST 1 and TEST 2: seeds and their public keys. */
    private val seed = Identity.hexToBytes("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60")
    private val publicKey = Identity.hexToBytes("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a")
    private val otherSeed = Identity.hexToBytes("4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb")

    private fun credentials(signingSeed: ByteArray = seed): Tls.Credentials {
        val key = Identity.privateKey(signingSeed)
        return Tls.generate(publicKey) { message -> Identity.sign(key, message) }
    }

    @Test
    fun aCertificateNamesTheDeviceThatMadeIt() {
        assertArrayEquals(publicKey, Tls.attestedDevice(credentials().certificate))
    }

    @Test
    fun aClaimSignedByADifferentKeyThanItNamesIsRefused() {
        // Names one device, signed by another: what an impostor can make.
        val forged = credentials(signingSeed = otherSeed).certificate
        assertThrows(CertificateException::class.java) { Tls.attestedDevice(forged) }
    }

    /** A TLS server presenting `credentials`, answering every request "ok". */
    private fun serve(credentials: Tls.Credentials): NanoHTTPD {
        val server = object : NanoHTTPD("127.0.0.1", 0) {
            override fun serve(session: IHTTPSession): Response = newFixedLengthResponse("ok")
        }
        server.makeSecure(Tls.serverSocketFactory(credentials), arrayOf("TLSv1.3"))
        server.start(NanoHTTPD.SOCKET_READ_TIMEOUT, true)
        return server
    }

    private fun get(server: NanoHTTPD, allows: (ByteArray) -> Boolean): String {
        val conn = URL("https://127.0.0.1:${server.listeningPort}/").openConnection() as HttpsURLConnection
        conn.sslSocketFactory = Tls.clientSocketFactory(allows)
        conn.setHostnameVerifier { _, _ -> true }
        return try {
            conn.inputStream.bufferedReader().use { it.readText() }
        } finally {
            conn.disconnect()
        }
    }

    @Test
    fun aPairedDeviceIsReachedAndAStrangerIsNot() {
        val server = serve(credentials())
        try {
            assertEquals("ok", get(server) { key -> key.contentEquals(publicKey) })
            assertThrows(javax.net.ssl.SSLException::class.java) { get(server) { false } }
        } finally {
            server.stop()
        }
    }

    @Test
    fun nothingIsServedInTheClear() {
        val server = serve(credentials())
        try {
            val plain = URL("http://127.0.0.1:${server.listeningPort}/").openConnection() as java.net.HttpURLConnection
            plain.connectTimeout = 2000
            plain.readTimeout = 2000
            val answered = try {
                plain.responseCode == 200
            } catch (_: Exception) {
                false
            }
            assertTrue("the server answered a plain HTTP request", !answered)
        } finally {
            server.stop()
        }
    }

    /** A certificate made by the desktop (`tls.rs`), and the device it names. */
    @Test
    fun aDesktopCertificateIsUnderstood() {
        val certificate = java.security.cert.CertificateFactory.getInstance("X.509")
            .generateCertificate(Identity.hexToBytes(DESKTOP_CERTIFICATE).inputStream()) as java.security.cert.X509Certificate
        assertArrayEquals(Identity.hexToBytes(DESKTOP_DEVICE), Tls.attestedDevice(certificate))
    }

    /** Prints a certificate for the desktop's own cross-check; not an assertion. */
    @Test
    fun printACertificateForTheDesktopTests() {
        val encoded = credentials().certificate.encoded.joinToString("") { "%02x".format(it) }
        println("PHONE_CERTIFICATE=$encoded")
    }

    private companion object {
        const val DESKTOP_DEVICE = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a"
        const val DESKTOP_CERTIFICATE =
            "308201963082013da003020102021467c0244069248cfca7e56d35869e39dcac6918bc300a06082a8648ce3d04030230133111300f06035504030c084c414e636c6176653020170d3735303130313030303030305a180f34303936303130313030303030305a30133111300f06035504030c084c414e636c6176653059301306072a8648ce3d020106082a8648ce3d03010703420004d0acc549b6ee2da03f4932e5f6051a1bd598102d83f2c3a4c15ffb45c77d024271228057e96c1a01eefbd38ca4162e87b738a6d39fa589a1f0a543347f410530a36d306b306906056983ffa5290460d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a29199988b797634ca7aea3085ee856fc763b93625fc0dab7e46e17f42b25e99d7011fc222e8730ccd13a68a3bd157a98904f7941a955ef446eafb7eb5b96f50b300a06082a8648ce3d040302034700304402206b239205aa3b11e22c924f4fff68b84f5988d2dce00589b6f609916ffd957848022023211f4e6fc158e87e3c36a464db527ed72617c38c9a649bbd55a334e8221a1d"
    }
}
