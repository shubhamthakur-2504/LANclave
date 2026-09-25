package expo.modules.nativeserver

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class IdentityTest {
    /** RFC 8032, section 7.1, TEST 1: a seed, the empty message, its signature. */
    @Test
    fun signsTheRfc8032TestVector() {
        val seed = Identity.hexToBytes("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60")
        val expected = Identity.hexToBytes(
            "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b",
        )
        assertArrayEquals(expected, Identity.sign(Identity.privateKey(seed), ByteArray(0)))
    }
}

/** Must agree with `safe_file_name` in desktop-app/src-tauri/src/offers.rs. */
class OfferNamesTest {
    @Test
    fun offeredNamesAreReducedToABareName() {
        assertEquals("photo.jpg", Offers.safeFileName("photo.jpg"))
        assertEquals("passwd", Offers.safeFileName("../../etc/passwd"))
        assertEquals("x.dll", Offers.safeFileName("C:\\Windows\\x.dll"))
        for (bad in listOf("", "..", ".", ".hidden", "a\u0000b", "evil:stream", "dir/")) {
            assertNull(bad, Offers.safeFileName(bad))
        }
    }
}
