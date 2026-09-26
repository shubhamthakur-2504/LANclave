package expo.modules.nativeserver

/**
 * Recently computed SHA-256 digests, so a file is read once per transfer,
 * not twice -- the phone's side of `desktop-app/src-tauri/src/hash_cache.rs`.
 *
 * Every transfer is verified: the receiver asks the sender for the file's
 * hash. The sender hashes the file as it serves it whole and keeps the
 * result here, so that request is answered without a second read.
 *
 * In memory only, capped, least recently used evicted. An entry holds only
 * while the file's size and modified time are unchanged; a file changed in
 * the last 2 s, or whose modified time is unknown (0), is never cached.
 */
object HashCache {
    private const val CAPACITY = 256
    private const val SETTLE_MS = 2_000L

    private class Entry(val size: Long, val modified: Long, val sha256: String, var used: Long)

    private val map = HashMap<String, Entry>()
    private var clock = 0L

    @Synchronized
    fun get(key: String, size: Long, modified: Long): String? {
        val e = map[key] ?: return null
        if (e.size != size || e.modified != modified) {
            map.remove(key)
            return null
        }
        e.used = ++clock
        return e.sha256
    }

    @Synchronized
    fun put(key: String, size: Long, modified: Long, sha256: String, now: Long = System.currentTimeMillis()) {
        if (modified <= 0 || now - modified < SETTLE_MS) return // unknown, or may still be changing
        if (map.size >= CAPACITY && key !in map) {
            map.minByOrNull { it.value.used }?.key?.let { map.remove(it) }
        }
        map[key] = Entry(size, modified, sha256, ++clock)
    }

    /** The cached digest, or `compute()`'s, which is then cached. */
    fun cached(key: String, size: Long, modified: Long, compute: () -> String?): String? {
        get(key, size, modified)?.let { return it }
        val sha = compute() ?: return null
        put(key, size, modified, sha)
        return sha
    }

    @Synchronized
    internal fun clearForTest() {
        map.clear()
    }
}
