package expo.modules.nativeserver

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.util.UUID
import java.util.concurrent.Executors

/**
 * The phone's downloads (P4), in native code so they keep running while JS
 * is suspended, sign every request themselves, and resume.
 *
 * Mirrors the desktop's pull (`client/pull.rs`) step for step:
 * dedupe → resumable pull into a hidden partial file → verify SHA-256
 * against the sender → rename to a free name (never overwrite).
 *
 * One scheduler for every download (P6), same rules as the desktop's
 * `transfers.rs`: at most [maxDownloads] run at once (default 2); pausing
 * frees the slot; resuming goes to the front of the queue; a download the
 * sender paused steps out and rejoins after 5 s. The foreground service
 * keeps the process alive while anything is queued or running.
 *
 * Unfinished downloads are kept in `transfers.json` (P5): after the app is
 * closed or killed, paused ones come back paused, and ones that were
 * running or waiting go back in line. Week-old ones, and their partial
 * files, are cleared away.
 */
object TransferEngine {
    enum class Status { QUEUED, IN_PROGRESS, VERIFYING, PAUSED, COMPLETED, SKIPPED, FAILED }
    enum class Stop { PAUSE, CANCEL }

    class Job(
        val id: String,
        @Volatile var peerAddr: String,
        val peerId: String,
        val peerName: String?,
        /** Name to save under (already a safe bare name). */
        val name: String,
        val size: Long?,
        /** Request path on the peer, percent-encoded. */
        val path: String,
        val fingerprintPath: String?,
        /** "me" for pulls the user started; "peer" for accepted offers. */
        val initiatedBy: String,
        val offerId: String? = null,
        val fileId: String? = null,
    ) {
        @Volatile var status = Status.QUEUED
        @Volatile var bytes = 0L
        @Volatile var total = size ?: 0L
        @Volatile var message: String? = null
        @Volatile var destName: String? = null
        @Volatile var stop: Stop? = null
        @Volatile var pausedBySender = false
        /** A sender pause holds it back until this time (ms). */
        @Volatile var notBefore = 0L
        @Volatile var startedMs = System.currentTimeMillis()
        /** Last change of any kind: what "a week untouched" counts from. */
        @Volatile var touchedMs = System.currentTimeMillis()

        fun toJson(): JSONObject = JSONObject()
            .put("id", id).put("peerAddr", peerAddr).put("peerId", peerId)
            .put("peerName", peerName ?: JSONObject.NULL).put("name", name).put("size", size ?: JSONObject.NULL)
            .put("path", path).put("fingerprintPath", fingerprintPath ?: JSONObject.NULL)
            .put("initiatedBy", initiatedBy).put("offerId", offerId ?: JSONObject.NULL).put("fileId", fileId ?: JSONObject.NULL)
            .put("status", status.name).put("bytes", bytes).put("total", total)
            .put("message", message ?: JSONObject.NULL).put("startedMs", startedMs).put("touchedMs", touchedMs)

        /** `ahead`: downloads waiting in front of this one, if it waits. */
        fun toMap(ahead: Int? = null): Map<String, Any?> = mapOf(
            "id" to id,
            "fileName" to name,
            "peerId" to peerId,
            "peerName" to peerName,
            "status" to status.name.lowercase(),
            "bytes" to bytes.toDouble(),
            "total" to total.toDouble(),
            "message" to message,
            "destName" to destName,
            "offerId" to offerId,
            "fileId" to fileId,
            "pausedBySender" to pausedBySender,
            "ahead" to ahead,
        )
    }

    /** Every job; also the lock for [queue]. */
    private val jobs = LinkedHashMap<String, Job>()
    /** Queued and running downloads, by the rules above. */
    private val queue = Scheduler<String>()
    private val workers = Executors.newCachedThreadPool { r -> Thread(r, "lanclave-transfers").apply { isDaemon = true } }
    /** Wakes the queue when a download the sender paused may ask again. */
    private val later = Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "lanclave-retry").apply { isDaemon = true } }
    @Volatile private var app: Context? = null
    @Volatile private var sandboxPath: String? = null

    private const val PREFS = "lanclave_transfers"
    private const val SENDER_PAUSE_MS = 5_000L
    private const val JOBS_FILE = "transfers.json"
    /** Unfinished downloads and partial files are given up after a week. */
    const val STALE_AFTER_MS = 7L * 24 * 60 * 60 * 1000
    @Volatile private var loaded = false
    private val saveLock = Any()

    /** Downloads that run at once; the rest wait their turn. */
    var maxDownloads: Int
        get() = synchronized(jobs) { queue.max }
        set(value) {
            synchronized(jobs) { queue.max = value.coerceIn(1, 8) }
            app?.getSharedPreferences(PREFS, Context.MODE_PRIVATE)?.edit()?.putInt("max_downloads", value)?.apply()
            pump()
        }

    /** Called whenever a job ends: offers report results from here. */
    @Volatile var onJobEnded: ((Job) -> Unit)? = null

    fun configure(context: Context, sandbox: String) {
        app = context.applicationContext
        sandboxPath = sandbox
        val saved = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getInt("max_downloads", 2)
        synchronized(jobs) { queue.max = saved.coerceIn(1, 8) }
        if (!loaded) {
            loaded = true
            restore(context.applicationContext)
            Thread({ sweepStale(context.applicationContext, sandbox) }, "lanclave-cleanup").apply { isDaemon = true }.start()
        }
    }

    // ------------------------------------------------------------------
    // Kept on disk
    // ------------------------------------------------------------------

    /** Keep the unfinished downloads; finished ones are in the history. */
    private fun save() {
        val ctx = app ?: return
        val keep = synchronized(jobs) {
            jobs.values.filter { it.status != Status.COMPLETED && it.status != Status.SKIPPED }.map { it.toJson() }
        }
        synchronized(saveLock) {
            runCatching {
                val tmp = File(ctx.filesDir, "$JOBS_FILE.tmp")
                tmp.writeText(JSONArray(keep).toString())
                tmp.renameTo(File(ctx.filesDir, JOBS_FILE))
            }
        }
    }

    private fun jobFrom(j: JSONObject): Job {
        fun opt(key: String) = j.optString(key).takeIf { it.isNotEmpty() && it != "null" }
        return Job(
            id = j.getString("id"),
            peerAddr = j.getString("peerAddr"),
            peerId = j.getString("peerId"),
            peerName = opt("peerName"),
            name = j.getString("name"),
            size = if (j.isNull("size")) null else j.optLong("size"),
            path = j.getString("path"),
            fingerprintPath = opt("fingerprintPath"),
            initiatedBy = j.getString("initiatedBy"),
            offerId = opt("offerId"),
            fileId = opt("fileId"),
        ).apply {
            status = Status.valueOf(j.getString("status"))
            bytes = j.optLong("bytes")
            total = j.optLong("total")
            message = opt("message")
            startedMs = j.optLong("startedMs", System.currentTimeMillis())
            touchedMs = j.optLong("touchedMs", startedMs)
        }
    }

    /** What was running or waiting waits again, oldest first; paused stays paused. */
    private fun restore(ctx: Context) {
        val arr = runCatching { JSONArray(File(ctx.filesDir, JOBS_FILE).readText()) }.getOrNull() ?: return
        val now = System.currentTimeMillis()
        val restored = (0 until arr.length())
            .mapNotNull { runCatching { jobFrom(arr.getJSONObject(it)) }.getOrNull() }
            .filterNot { (it.status == Status.PAUSED || it.status == Status.FAILED) && now - maxOf(it.startedMs, it.touchedMs) > STALE_AFTER_MS }
        synchronized(jobs) { restored.forEach { jobs[it.id] = it } }
        for (job in restored) {
            if (job.status in listOf(Status.QUEUED, Status.IN_PROGRESS, Status.VERIFYING)) {
                job.message = null
                enqueue(job)
            } else {
                emit(job)
            }
        }
        save()
    }

    /** Partial files nothing has written to in a week, and their notes. */
    private fun sweepStale(ctx: Context, sandbox: String) {
        runCatching { Sandbox(ctx, sandbox).sweepStalePartials(STALE_AFTER_MS) }
        val cutoff = System.currentTimeMillis() - STALE_AFTER_MS
        File(ctx.filesDir, "partials").listFiles()?.filter { it.lastModified() < cutoff }?.forEach { it.delete() }
    }

    fun snapshot(): List<Map<String, Any?>> = synchronized(jobs) { jobs.values.map { it.toMap(queue.ahead(it.id)) } }

    /** Queued or running, i.e. reasons to keep the service up. */
    fun active(): List<Job> = synchronized(jobs) {
        jobs.values.filter { it.status == Status.QUEUED || it.status == Status.IN_PROGRESS || it.status == Status.VERIFYING }
    }

    fun get(id: String): Job? = synchronized(jobs) { jobs[id] }

    /** A download from a peer's sandbox, started by the user here. */
    fun pullFromSandbox(peerAddr: String, peerId: String, peerName: String?, remoteName: String, size: Long?): String {
        val safe = Offers.safeFileName(remoteName) ?: throw IllegalArgumentException("Unsafe file name")
        val encoded = java.net.URLEncoder.encode(remoteName, "UTF-8").replace("+", "%20")
        val path = "/files/$encoded"
        // Asked again for a file already on its way (a double tap): continue
        // that download rather than start a twin.
        val open = synchronized(jobs) {
            jobs.values.firstOrNull {
                it.offerId == null && it.peerId == peerId && it.path == path &&
                    it.status != Status.COMPLETED && it.status != Status.SKIPPED
            }
        }
        if (open != null) {
            resume(open.id)
            return open.id
        }
        val job = Job(
            id = UUID.randomUUID().toString(),
            peerAddr = peerAddr,
            peerId = peerId,
            peerName = peerName,
            name = safe,
            size = size,
            path = path,
            fingerprintPath = "/api/sandbox/fingerprint/$encoded",
            initiatedBy = "me",
        )
        enqueue(job)
        return job.id
    }

    /** Put a download in line; it starts when a slot is free. */
    fun enqueue(job: Job, front: Boolean = false) = enqueueAll(listOf(job), front)

    /** Several at once (an accepted offer): one save and one pump. */
    fun enqueueAll(batch: List<Job>, front: Boolean = false) {
        synchronized(jobs) {
            for (job in batch) {
                jobs[job.id] = job
                job.touchedMs = System.currentTimeMillis()
                job.status = Status.QUEUED
                job.stop = null
                job.notBefore = 0L
                queue.add(job.id, front)
            }
        }
        if (batch.size == 1) emit(batch[0]) // pump() tells the rest of the line
        save()
        pump()
    }

    /** Forget a failed or paused download and what arrived of it. */
    fun remove(id: String) {
        val job = get(id) ?: return
        val idle = synchronized(jobs) {
            (job.status == Status.FAILED || job.status == Status.PAUSED) && !queue.isRunning(id)
        }
        if (!idle) return
        synchronized(jobs) {
            queue.remove(id)
            jobs.remove(id)
        }
        discardPartial(job)
        save()
    }

    /** Start what the free slots allow; tell waiting rows their place. */
    private fun pump() {
        val now = System.currentTimeMillis()
        val start = synchronized(jobs) { queue.take(now).mapNotNull { jobs[it] } }
        for (job in start) {
            workers.execute {
                try {
                    run(job)
                } finally {
                    synchronized(jobs) { queue.finished(job.id) }
                    pump()
                }
            }
        }
        val waiting = synchronized(jobs) { jobs.values.filter { it.status == Status.QUEUED }.map { it.toMap(queue.ahead(it.id)) } }
        waiting.forEach { Events.emit("onTransferProgress", it) }
    }

    /** Stop a download, keeping what arrived; a waiting one leaves the line. */
    fun pause(id: String) {
        val job = get(id) ?: return
        val waiting = synchronized(jobs) {
            (job.status == Status.QUEUED && !queue.isRunning(id)).also { if (it) queue.remove(id) }
        }
        if (waiting) {
            job.touchedMs = System.currentTimeMillis()
            job.status = Status.PAUSED
            job.message = null
            job.pausedBySender = false
            emit(job)
            save()
            pump() // the rest move up
        } else {
            job.stop = Stop.PAUSE
        }
    }

    fun cancel(id: String) {
        val job = get(id) ?: return
        val idle = synchronized(jobs) {
            (job.status in listOf(Status.QUEUED, Status.PAUSED, Status.FAILED) && !queue.isRunning(id))
                .also { if (it) queue.remove(id) }
        }
        if (idle) {
            job.stop = Stop.CANCEL
            discardPartial(job)
            finish(job, Status.FAILED, "Transfer cancelled")
            pump()
        } else {
            job.stop = Stop.CANCEL
        }
    }

    /** Continue a paused or failed download: to the front of the line. */
    fun resume(id: String) {
        val job = get(id) ?: return
        if (job.status == Status.PAUSED || job.status == Status.FAILED) enqueue(job, front = true)
    }

    /** Stop the offer's downloads (the sender withdrew it). */
    fun cancelOffer(offerId: String) {
        synchronized(jobs) { jobs.values.filter { it.offerId == offerId } }.forEach { cancel(it.id) }
    }

    // ------------------------------------------------------------------
    // One download
    // ------------------------------------------------------------------

    /**
     * Tagged by source, so two downloads that will land under one name
     * (two offered `IMG_1.jpg`, running side by side) never share one.
     */
    private fun partialName(job: Job): String {
        val digest = java.security.MessageDigest.getInstance("SHA-256").digest(job.path.toByteArray())
        val tag = digest.take(4).joinToString("") { "%02x".format(it) }
        return ".${job.name}.$tag.lanclave-part"
    }

    /** The note lives in app-private storage, not beside the file in SAF. */
    private fun noteFile(job: Job): File {
        val ctx = app!!
        val key = Integer.toHexString("${sandboxPath}|${partialName(job)}".hashCode())
        return File(File(ctx.filesDir, "partials").apply { mkdirs() }, "$key.json")
    }

    private fun discardPartial(job: Job) {
        val ctx = app ?: return
        val sandbox = Sandbox(ctx, sandboxPath ?: return)
        try { sandbox.delete(partialName(job)) } catch (_: Exception) {}
        noteFile(job).delete()
    }

    private fun run(job: Job) {
        if (job.status != Status.QUEUED) return
        if (job.stop != null) return stopped(job) // paused or cancelled as it took its slot
        val ctx = app ?: return finish(job, Status.FAILED, "Not ready")
        val sandbox = Sandbox(ctx, sandboxPath ?: return finish(job, Status.FAILED, "No sandbox"))
        if (!Identity.isSet) return finish(job, Status.FAILED, "Identity not ready")

        job.status = Status.IN_PROGRESS
        job.message = null
        job.pausedBySender = false
        emit(job)

        var networkRetries = 0
        while (true) {
            // Follow the peer if its address changed (hotspot DHCP).
            PresenceRegistry.addrOf(job.peerId)?.let { job.peerAddr = it }
            try {
                return pullOnce(ctx, sandbox, job)
            } catch (e: SenderPaused) {
                // Step out of the slot: other downloads run meanwhile; this
                // one waits at the back of the line for 5 s (pause and
                // cancel still apply).
                job.pausedBySender = true
                job.message = "Paused by sender"
                job.status = Status.QUEUED
                synchronized(jobs) { queue.later(job.id, System.currentTimeMillis() + SENDER_PAUSE_MS) }
                emit(job)
                save()
                later.schedule({ pump() }, SENDER_PAUSE_MS, java.util.concurrent.TimeUnit.MILLISECONDS)
                return
            } catch (e: IOException) {
                if (job.stop != null) return stopped(job)
                if (networkRetries >= 5) return finish(job, Status.FAILED, e.message ?: "Network error")
                networkRetries++
                job.message = "Waiting for network"
                emit(job)
                if (sleepUnlessStopped(job, minOf(30_000L, 1_000L shl networkRetries))) return stopped(job)
            } catch (e: Exception) {
                return finish(job, Status.FAILED, e.message ?: "Transfer failed")
            }
        }
    }

    private class SenderPaused : Exception()
    private class Rejected(val code: Int) : Exception("The device refused the download (HTTP $code)")

    private fun pullOnce(ctx: Context, sandbox: Sandbox, job: Job) {
        // ---- 0. Skip if we already hold an identical copy --------------
        job.fingerprintPath?.let { fp ->
            val size = job.size ?: return@let
            val local = Fingerprint.ofSandboxFile(ctx, sandboxPath!!, job.name, size) ?: return@let
            if (local.sha256 == null && local.siblings.isEmpty()) return@let
            val remote = PeerHttp.getJson(job.peerAddr, "$fp?size=$size") ?: return@let
            val remoteSha = remote.optString("sha256").takeIf { it.isNotEmpty() && it != "null" } ?: return@let
            val holder = when {
                local.sha256.equals(remoteSha, ignoreCase = true) -> job.name
                else -> local.siblings.firstOrNull { it.sha256.equals(remoteSha, ignoreCase = true) }?.name
            } ?: return@let
            job.destName = holder
            job.bytes = size
            job.total = size
            return finish(job, Status.SKIPPED, null)
        }

        val partial = partialName(job)
        for (attempt in 0..1) {
            // ---- 1. Request from where the partial stops ---------------
            val note = noteFile(job).takeIf { it.exists() }?.let { runCatching { JSONObject(it.readText()) }.getOrNull() }
            val have = sandbox.length(partial) ?: 0L
            val resumable = attempt == 0 && note != null && note.optString("source") == job.path &&
                have > 0 && have <= note.optLong("size", -1)
            if (!resumable) {
                sandbox.delete(partial)
                noteFile(job).delete()
            }

            val headers = if (resumable) mapOf("Range" to "bytes=$have-", "If-Range" to note!!.getString("etag")) else emptyMap()
            val conn = PeerHttp.open(job.peerAddr, job.path, extraHeaders = headers)
            try {
                val code = conn.responseCode
                if (code == 503) throw SenderPaused()
                if (code == 416) {
                    if (resumable && have == note!!.optLong("size")) {
                        return complete(ctx, sandbox, job, have)
                    }
                    continue // stale partial: start over
                }
                if (code !in 200..299) throw Rejected(code)

                val offset = when {
                    code == 206 && resumable && contentRangeStart(conn) == have -> have
                    code == 206 -> { sandbox.delete(partial); continue } // a range we did not ask for
                    else -> 0L
                }
                val length = conn.getHeaderField("Content-Length")?.toLongOrNull() ?: -1L
                val total = if (length >= 0) offset + length else (job.size ?: 0L)
                job.total = total
                conn.getHeaderField("ETag")?.let { etag ->
                    noteFile(job).writeText(JSONObject().put("source", job.path).put("etag", etag).put("size", total).toString())
                }

                // ---- 2. Stream into the partial file -------------------
                job.bytes = offset
                job.pausedBySender = false
                job.message = null
                emit(job)
                var lastEmit = 0L
                sandbox.openForWrite(partial, append = offset > 0).use { out ->
                    conn.inputStream.use { input ->
                        val buf = ByteArray(64 * 1024)
                        while (true) {
                            if (job.stop != null) return stopped(job)
                            val n = input.read(buf)
                            if (n < 0) break
                            out.write(buf, 0, n)
                            job.bytes += n
                            val now = System.currentTimeMillis()
                            if (now - lastEmit > 250) {
                                emit(job)
                                lastEmit = now
                            }
                        }
                    }
                }
                if (length >= 0 && job.bytes != total) {
                    throw IOException("Peer sent ${job.bytes} of $total bytes") // partial kept: resumes
                }

                // ---- 3. Verify against the sender's copy ----------------
                job.status = Status.VERIFYING
                emit(job)
                when (verify(sandbox, partial, job, total)) {
                    false -> {
                        if (attempt == 0) {
                            // Damaged transfer or resume: once more from scratch.
                            sandbox.delete(partial)
                            noteFile(job).delete()
                            job.status = Status.IN_PROGRESS
                            continue
                        }
                        sandbox.delete(partial)
                        noteFile(job).delete()
                        return finish(job, Status.FAILED, "The file arrived damaged twice; it does not match the sender's copy")
                    }
                    else -> return complete(ctx, sandbox, job, total)
                }
            } finally {
                conn.disconnect()
            }
        }
        finish(job, Status.FAILED, "The device kept refusing to resume the download")
    }

    /** `true` match, `false` mismatch, `null` the sender cannot say. */
    private fun verify(sandbox: Sandbox, partial: String, job: Job, size: Long): Boolean? {
        val fp = job.fingerprintPath ?: return null
        val remote = PeerHttp.getJson(job.peerAddr, "$fp?exact=1&size=$size") ?: return null
        val remoteSha = remote.optString("sha256").takeIf { it.isNotEmpty() && it != "null" } ?: return false
        if (remote.optLong("size") != size) return false
        val local = sandbox.openForRead(partial)?.let { Fingerprint.sha256(it) } ?: return null
        return local.equals(remoteSha, ignoreCase = true)
    }

    /** Give the finished partial a free name (never over an existing file). */
    private val naming = Any()

    private fun complete(ctx: Context, sandbox: Sandbox, job: Job, size: Long) {
        // Choosing a free name and taking it is one step: downloads now
        // finish side by side.
        job.destName = synchronized(naming) {
            val taken = sandbox.names()
            val free = Fingerprint.firstFreeName(job.name) { it in taken }
            sandbox.rename(partialName(job), free)
        }
        noteFile(job).delete()
        job.bytes = size
        job.total = size
        finish(job, Status.COMPLETED, null)
    }

    private fun contentRangeStart(conn: java.net.HttpURLConnection): Long? =
        conn.getHeaderField("Content-Range")?.removePrefix("bytes ")?.substringBefore('-')?.trim()?.toLongOrNull()

    private fun sleepUnlessStopped(job: Job, ms: Long): Boolean {
        val until = System.currentTimeMillis() + ms
        while (System.currentTimeMillis() < until) {
            if (job.stop != null) return true
            Thread.sleep(200)
        }
        return false
    }

    private fun stopped(job: Job) {
        when (job.stop) {
            Stop.PAUSE -> {
                job.stop = null
                job.touchedMs = System.currentTimeMillis()
                job.status = Status.PAUSED
                job.message = null
                emit(job)
                save()
                TransferService.refresh(app)
            }
            else -> {
                discardPartial(job)
                finish(job, Status.FAILED, "Transfer cancelled")
            }
        }
    }

    private fun finish(job: Job, status: Status, message: String?) {
        job.touchedMs = System.currentTimeMillis()
        job.status = status
        job.message = message
        emit(job)
        save()
        record(job)
        onJobEnded?.invoke(job)
        TransferService.refresh(app)
    }

    private fun record(job: Job) {
        val ctx = app ?: return
        val entry = TransferHistory.entry("received", job.initiatedBy, job.peerId, job.peerName, job.name)
        entry.put("bytes", if (job.status == Status.FAILED) 0 else job.bytes)
        entry.put(
            "outcome",
            when (job.status) {
                Status.COMPLETED -> "completed"
                Status.SKIPPED -> "skipped"
                else -> if (job.message == "Transfer cancelled") "cancelled" else "failed"
            },
        )
        job.destName?.takeIf { it != job.name }?.let { entry.put("dest_name", it) }
        if (job.status == Status.FAILED && job.message != "Transfer cancelled") entry.put("error", job.message)
        runCatching { TransferHistory.record(ctx, entry) }
    }

    private fun emit(job: Job) {
        Events.emit("onTransferProgress", job.toMap(synchronized(jobs) { queue.ahead(job.id) }))
        TransferService.refresh(app)
    }
}
