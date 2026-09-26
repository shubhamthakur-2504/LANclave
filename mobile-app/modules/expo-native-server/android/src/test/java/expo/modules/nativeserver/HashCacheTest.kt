package expo.modules.nativeserver

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test

/** Same rules as desktop-app/src-tauri/src/hash_cache.rs. */
class HashCacheTest {
    private val now = 10_000_000L
    private val settled = now - 60_000

    @Before
    fun reset() = HashCache.clearForTest()

    @Test
    fun aCachedDigestHoldsUntilTheFileChanges() {
        HashCache.put("a", 3, settled, "digest", now)
        assertEquals("digest", HashCache.get("a", 3, settled))
        assertNull("size changed", HashCache.get("a", 4, settled))
        assertNull("gone after a miss", HashCache.get("a", 3, settled))
    }

    @Test
    fun recentOrUnknownModifiedTimesAreNotCached() {
        HashCache.put("fresh", 3, now - 500, "digest", now)
        HashCache.put("unknown", 3, 0, "digest", now)
        assertNull(HashCache.get("fresh", 3, now - 500))
        assertNull(HashCache.get("unknown", 3, 0))
    }

    @Test
    fun theLeastRecentlyUsedEntryGoesFirst() {
        for (i in 0 until 256) HashCache.put("f$i", 1, settled, "d", now)
        HashCache.get("f0", 1, settled) // recently used: survives
        HashCache.put("new", 1, settled, "d", now)
        assertNotNull(HashCache.get("f0", 1, settled))
        assertNull("the oldest unused entry was evicted", HashCache.get("f1", 1, settled))
    }
}
