package expo.modules.nativeserver

import android.content.Context
import java.io.InputStream
import java.util.UUID

/**
 * Dev builds only: one long-running `logcat`, kept in a ring buffer that
 * paired laptops read through `GET /api/dev/logs`.
 *
 * One process, started once, on purpose. Since Android 13 every new logcat
 * session asks the user for access, and only while the app is on screen;
 * a session started in the background silently sees just this app's own
 * lines. So capture starts from the Developer tools screen and stays up
 * (in [DevService]) while laptops connect and disconnect as they like.
 */
object DevLogs {
    /** Lines kept for late joiners and for resuming after a dropped link. */
    private const val CAPACITY = 20_000

    /** Sent when nothing matched for this long, so a dead reader is noticed. */
    private const val KEEPALIVE_MS = 10_000L

    class Entry(
        val seq: Long,
        val text: String,
        /** -1: a system user shown by name (root, shell); -2: not a log line. */
        val uid: Int,
        val level: Char,
        val tag: String,
        val pid: Int,
    )

    private val lock = Object()
    private val ring = ArrayDeque<Entry>()
    private var nextSeq = 1L
    private var process: Process? = null

    /** New for every capture; a reader resuming across a restart starts over. */
    @Volatile var captureId: String = ""
        private set

    /** A line from another app arrived: Android granted full access. */
    @Volatile var seesOtherApps = false
        private set

    private var ownUid = -1

    val isCapturing: Boolean get() = process?.isAlive == true

    fun lineCount(): Int = synchronized(lock) { ring.size }

    fun hasReadLogs(context: Context): Boolean =
        context.checkSelfPermission(android.Manifest.permission.READ_LOGS) ==
            android.content.pm.PackageManager.PERMISSION_GRANTED

    /** Start capturing; a no-op while already running. Call while on screen. */
    fun start(context: Context) {
        synchronized(lock) {
            if (isCapturing) return
            ownUid = context.applicationInfo.uid
            seesOtherApps = false
            ring.clear()
            nextSeq = 1L
            captureId = UUID.randomUUID().toString()
            // `uid` puts the app's uid on every line, which is how a reader
            // follows one package across restarts (its pid changes, uid not).
            val p = ProcessBuilder(
                "logcat", "-v", "threadtime", "-v", "uid",
                "-b", "main", "-b", "system", "-b", "crash",
            ).redirectErrorStream(true).start()
            process = p
            Thread({ pump(p) }, "lanclave-logcat").apply { isDaemon = true }.start()
        }
    }

    fun stop() {
        synchronized(lock) {
            process?.destroy()
            process = null
            lock.notifyAll()
        }
    }

    private fun pump(p: Process) {
        try {
            p.inputStream.bufferedReader().useLines { lines ->
                for (line in lines) add(line)
            }
        } catch (_: Exception) {
            // stopped, or logcat died; readers see the capture end
        } finally {
            synchronized(lock) {
                if (process === p) process = null
                lock.notifyAll()
            }
        }
    }

    private fun add(line: String) {
        val entry = parse(line)
        synchronized(lock) {
            val e = Entry(nextSeq++, line, entry.uid, entry.level, entry.tag, entry.pid)
            ring.addLast(e)
            if (ring.size > CAPACITY) ring.removeFirst()
            if (e.uid >= 10_000 && e.uid != ownUid) seesOtherApps = true
            lock.notifyAll()
        }
    }

    private class Parsed(val uid: Int, val level: Char, val tag: String, val pid: Int)

    /**
     * `threadtime` + `uid` lines look like
     * `10-19 14:03:12.345 10250: 4567  4580 I MyTag   : hello`
     * (system users by name when it fits: ` root:  123 ...`).
     */
    private fun parse(line: String): Parsed {
        val none = Parsed(-2, 'I', "", -1)
        if (line.length < 20 || line[2] != '-' || line[5] != ' ') return none
        var rest = line.substring(18).trimStart()
        val colon = rest.indexOf(':')
        if (colon <= 0) return none
        val uidText = rest.substring(0, colon).trim()
        val uid = uidText.toIntOrNull() ?: -1
        rest = rest.substring(colon + 1).trimStart()
        val parts = rest.split(Regex("\\s+"), limit = 4)
        if (parts.size < 4) return none
        val pid = parts[0].toIntOrNull() ?: return none
        val level = parts[2].singleOrNull() ?: return none
        val tagAndMsg = parts[3]
        val sep = tagAndMsg.indexOf(": ")
        val tag = (if (sep >= 0) tagAndMsg.substring(0, sep) else tagAndMsg).trim()
        return Parsed(uid, level, tag, pid)
    }

    /** What a reader asked for. */
    class Filter(
        /** Follow this package's lines; null for everything. */
        val pkg: String?,
        val minLevel: Char,
        /** Only these tags; empty for all. */
        val tags: Set<String>,
        private val context: Context,
    ) {
        private var uid: Int? = null
        private var resolvedAt = 0L

        /** Native crash backtrace of our package in progress: crash_dump's pid. */
        private var tombstonePid = -1
        private var tombstoneSeenAt = 0L

        private fun uidOf(pkg: String): Int? {
            val now = System.currentTimeMillis()
            // Re-resolved now and then: a package installed or reinstalled
            // after the reader connected gets a (new) uid.
            if (now - resolvedAt > 3_000) {
                resolvedAt = now
                uid = try {
                    context.packageManager.getApplicationInfo(pkg, 0).uid
                } catch (_: Exception) {
                    null
                }
            }
            return uid
        }

        fun matches(e: Entry): Boolean {
            if (pkg != null && !matchesPackage(pkg, e)) return false
            if (e.uid != -2 && levelRank(e.level) < levelRank(minLevel)) return false
            if (tags.isNotEmpty() && e.tag !in tags) return false
            return true
        }

        private fun matchesPackage(pkg: String, e: Entry): Boolean {
            if (e.uid == -2) return false
            val appUid = uidOf(pkg)
            if (appUid != null && e.uid == appUid) return true
            // A native crash is written by crash_dump, not the app: follow
            // the backtrace that names our package for a few seconds.
            if (e.tag == "DEBUG") {
                if (e.text.contains(">>> $pkg <<<")) {
                    tombstonePid = e.pid
                    tombstoneSeenAt = System.currentTimeMillis()
                    return true
                }
                if (e.pid == tombstonePid && System.currentTimeMillis() - tombstoneSeenAt < 5_000) {
                    tombstoneSeenAt = System.currentTimeMillis()
                    return true
                }
            }
            // The system talking about it: process start, death, ANR.
            return (e.uid in 0 until 10_000 || e.uid == -1) && e.text.contains(pkg)
        }
    }

    private fun levelRank(c: Char): Int = when (c) {
        'V' -> 0; 'D' -> 1; 'I' -> 2; 'W' -> 3; 'E' -> 4; 'F', 'A' -> 5
        else -> 2
    }

    /**
     * A reader's view as a byte stream for the HTTP response: lines after
     * `after` (or the last `tail` matching lines), each sent as
     * `<seq>\t<line>\n`, then new ones as they come. An empty line now and
     * then keeps the connection honest. Ends when the capture stops.
     */
    fun stream(filter: Filter, after: Long?, tail: Int): InputStream = object : InputStream() {
        private var cursor: Long = synchronized(lock) {
            when {
                after != null -> after
                tail <= 0 -> nextSeq - 1
                else -> {
                    // Start `tail` matching lines back from the end.
                    var count = 0
                    var start = nextSeq - 1
                    var i = ring.size - 1
                    while (i >= 0 && count < tail) {
                        val e = ring[i]
                        if (filter.matches(e)) {
                            count++
                            start = e.seq - 1
                        }
                        i--
                    }
                    start
                }
            }
        }
        /** A restarted capture numbers from 1 again: this reader is over. */
        private val capture = captureId
        private var pending = ByteArray(0)
        private var pos = 0
        @Volatile private var closed = false

        override fun read(): Int {
            val one = ByteArray(1)
            return if (read(one, 0, 1) <= 0) -1 else one[0].toInt() and 0xff
        }

        override fun read(b: ByteArray, off: Int, len: Int): Int {
            if (pos >= pending.size) {
                if (!fill()) return -1
            }
            val n = minOf(len, pending.size - pos)
            System.arraycopy(pending, pos, b, off, n)
            pos += n
            return n
        }

        /** Next batch of matching lines, or a keepalive; false when over. */
        private fun fill(): Boolean {
            val out = StringBuilder()
            synchronized(lock) {
                val deadline = System.currentTimeMillis() + KEEPALIVE_MS
                while (!closed) {
                    if (captureId != capture) return false
                    // Seqs in the ring run without gaps, so the cursor maps
                    // to an index. Lines that fell off the front are skipped.
                    if (ring.isNotEmpty()) {
                        var i = maxOf(0L, cursor + 1 - ring.first().seq).toInt()
                        while (i < ring.size && out.length < 32 * 1024) {
                            val e = ring[i++]
                            cursor = e.seq
                            if (filter.matches(e)) out.append(e.seq).append('\t').append(e.text).append('\n')
                        }
                    }
                    if (out.isNotEmpty()) break
                    if (!isCapturing) return false
                    val wait = deadline - System.currentTimeMillis()
                    if (wait <= 0) {
                        out.append('\n')
                        break
                    }
                    lock.wait(wait)
                }
            }
            if (closed) return false
            pending = out.toString().toByteArray(Charsets.UTF_8)
            pos = 0
            return true
        }

        override fun close() {
            closed = true
            synchronized(lock) { lock.notifyAll() }
        }
    }
}
