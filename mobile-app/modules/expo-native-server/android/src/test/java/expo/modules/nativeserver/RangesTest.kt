package expo.modules.nativeserver

import org.junit.Assert.assertEquals
import org.junit.Test

/** Must agree with desktop-app/src-tauri/src/range.rs, case for case. */
class RangesTest {
    private val tag = "\"t\""

    @Test
    fun openRangeResolves() {
        assertEquals(Ranges.Requested.From(10), Ranges.requested("bytes=10-", null, tag, 100))
        assertEquals(Ranges.Requested.Full, Ranges.requested("bytes=0-", null, tag, 100))
        assertEquals(Ranges.Requested.Full, Ranges.requested(null, null, tag, 100))
    }

    @Test
    fun pastTheEndIsUnsatisfiable() {
        assertEquals(Ranges.Requested.Unsatisfiable, Ranges.requested("bytes=100-", null, tag, 100))
        assertEquals(Ranges.Requested.Unsatisfiable, Ranges.requested("bytes=5-", null, tag, 0))
    }

    @Test
    fun staleIfRangeGetsTheWholeFile() {
        assertEquals(Ranges.Requested.Full, Ranges.requested("bytes=10-", "\"old\"", "\"new\"", 100))
        assertEquals(Ranges.Requested.From(10), Ranges.requested("bytes=10-", "\"new\"", "\"new\"", 100))
    }

    @Test
    fun unsupportedFormsFallBackToFull() {
        for (r in listOf("bytes=-10", "bytes=0-9", "bytes=1-,5-", "items=1-", "bytes=x-")) {
            assertEquals(r, Ranges.Requested.Full, Ranges.requested(r, null, tag, 100))
        }
    }

    @Test
    fun etagMatchesTheDesktopFormat() {
        // range.rs: format!("\"{:x}-{:x}\"", len, modified_ms)
        assertEquals("\"c8-18f4df73f10\"", Ranges.etag(200, 1715000000272))
    }
}
