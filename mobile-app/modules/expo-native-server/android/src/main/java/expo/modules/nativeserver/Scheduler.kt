package expo.modules.nativeserver

/**
 * The download queue's rules (P6), free of Android so they can be tested.
 * Same rules as the desktop's `transfers.rs`:
 * - at most [max] downloads run at once; the rest wait in line;
 * - a resume goes to the front of the line, a new download to the back;
 * - a download the sender paused waits at the back until its delay is over.
 *
 * Not thread-safe: the engine holds its lock around every call.
 */
class Scheduler<K> {
    var max = 2
    private val waiting = ArrayDeque<K>()
    private val running = LinkedHashSet<K>()
    private val notBefore = HashMap<K, Long>()

    /** Put `key` in line: at the front for a resume, else at the back. */
    fun add(key: K, front: Boolean = false) {
        waiting.remove(key)
        notBefore.remove(key)
        if (front) waiting.addFirst(key) else waiting.addLast(key)
    }

    /** Back of the line, not to start before `at` (a sender pause). */
    fun later(key: K, at: Long) {
        add(key)
        notBefore[key] = at
    }

    /** Leave the line (paused or cancelled while waiting). */
    fun remove(key: K) {
        waiting.remove(key)
        notBefore.remove(key)
    }

    /** A running download ended one way or another: its slot is free. */
    fun finished(key: K) {
        running.remove(key)
    }

    /** The downloads to start now, as many as there are free slots. */
    fun take(now: Long): List<K> {
        val started = ArrayList<K>()
        val it = waiting.iterator()
        while (running.size < max && it.hasNext()) {
            val key = it.next()
            // Still winding down from its last run, or cooling off.
            if (key in running || (notBefore[key] ?: 0L) > now) continue
            it.remove()
            notBefore.remove(key)
            running.add(key)
            started.add(key)
        }
        return started
    }

    /** How many wait in front of `key`, or null if it is not waiting. */
    fun ahead(key: K): Int? = waiting.indexOf(key).takeIf { it >= 0 }

    fun isRunning(key: K): Boolean = key in running
}
