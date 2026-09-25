package expo.modules.nativeserver

import android.content.Context
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
 * One download at a time; the foreground service keeps the process alive
 * while anything is queued or running.
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

        fun toMap(): Map<String, Any?> = mapOf(
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
        )
    }

    private val jobs = LinkedHashMap<String, Job>()
    private val runner = Executors.newSingleThreadExecutor { r -> Thread(r, "lanclave-transfers").apply { isDaemon = true } }
    /** Re-queues jobs a sender paused, without holding up the rest. */
    private val later = Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "lanclave-retry").apply { isDaemon = true } }
    @Volatile private var app: Context? = null
    @Volatile private var sandboxPath: String? = null

    /** Called whenever a job ends: offers report results from here. */
    @Volatile var onJobEnded: ((Job) -> Unit)? = null

    fun configure(context: Context, sandbox: String) {
        app = context.applicationContext
        sandboxPath = sandbox
    }

    fun snapshot(): List<Map<String, Any?>> = synchronized(jobs) { jobs.values.map { it.toMap() } }

    /** Queued or running, i.e. reasons to keep the service up. */
    fun active(): List<Job> = synchronized(jobs) {
        jobs.values.filter { it.status == Status.QUEUED || it.status == Status.IN_PROGRESS || it.status == Status.VERIFYING }
    }

    fun get(id: String): Job? = synchronized(jobs) { jobs[id] }

    /** A download from a peer's sandbox, started by the user here. */
    fun pullFromSandbox(peerAddr: String, peerId: String, peerName: String?, remoteName: String, size: Long?): String {
        val safe = Offers.safeFileName(remoteName) ?: throw IllegalArgumentException("Unsafe file name")
        val encoded = java.net.URLEncoder.encode(remoteName, "UTF-8").replace("+", "%20")
        val job = Job(
            id = UUID.randomUUID().toString(),
            peerAddr = peerAddr,
            peerId = peerId,
            peerName = peerName,
            name = safe,
            size = size,
            path = "/files/$encoded",
            fingerprintPath = "/api/sandbox/fingerprint/$encoded",
            initiatedBy = "me",
        )
        enqueue(job)
        return job.id
    }

    fun enqueue(job: Job) {
        synchronized(jobs) { jobs[job.id] = job }
        job.status = Status.QUEUED
        job.stop = null
        emit(job)
        runner.execute { run(job) }
    }

    fun pause(id: String) {
        val job = get(id) ?: return
        if (job.status == Status.QUEUED) {
            job.status = Status.PAUSED
            emit(job)
        } else {
            job.stop = Stop.PAUSE
        }
    }

    fun cancel(id: String) {
        val job = get(id) ?: return
        when (job.status) {
            Status.QUEUED, Status.PAUSED, Status.FAILED -> {
                job.stop = Stop.CANCEL
                discardPartial(job)
                finish(job, Status.FAILED, "Transfer cancelled")
            }
            else -> job.stop = Stop.CANCEL
        }
    }

    /** Continue a paused or failed download from its partial file. */
    fun resume(id: String) {
        val job = get(id) ?: return
        if (job.status == Status.PAUSED || job.status == Status.FAILED) enqueue(job)
    }

    /** Stop the offer's downloads (the sender withdrew it). */
    fun cancelOffer(offerId: String) {
        synchronized(jobs) { jobs.values.filter { it.offerId == offerId } }.forEach { cancel(it.id) }
    }

    // ------------------------------------------------------------------
    // One download
    // ------------------------------------------------------------------

    private fun partialName(job: Job) = ".${job.name}.lanclave-part"

    /** The note lives in app-private storage, not beside the file in SAF. */
    private fun noteFile(job: Job): File {
        val ctx = app!!
        val key = Integer.toHexString("${sandboxPath}|${job.name}".hashCode())
        return File(File(ctx.filesDir, "partials").apply { mkdirs() }, "$key.json")
    }

    private fun discardPartial(job: Job) {
        val ctx = app ?: return
        val sandbox = Sandbox(ctx, sandboxPath ?: return)
        try { sandbox.delete(partialName(job)) } catch (_: Exception) {}
        noteFile(job).delete()
    }

    private fun run(job: Job) {
        if (job.status != Status.QUEUED || job.stop != null) return // paused or cancelled while queued
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
                // Step aside: other downloads run meanwhile; this one is
                // queued again in 5 s (pause / cancel still apply).
                job.pausedBySender = true
                job.message = "Paused by sender"
                job.status = Status.QUEUED
                emit(job)
                later.schedule({
                    if (job.status == Status.QUEUED && job.stop == null) runner.execute { run(job) }
                }, 5, java.util.concurrent.TimeUnit.SECONDS)
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
    private fun complete(ctx: Context, sandbox: Sandbox, job: Job, size: Long) {
        val taken = sandbox.names()
        val free = Fingerprint.firstFreeName(job.name) { it in taken }
        job.destName = sandbox.rename(partialName(job), free)
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
                job.status = Status.PAUSED
                job.message = null
                emit(job)
                TransferService.refresh(app)
            }
            else -> {
                discardPartial(job)
                finish(job, Status.FAILED, "Transfer cancelled")
            }
        }
    }

    private fun finish(job: Job, status: Status, message: String?) {
        job.status = status
        job.message = message
        emit(job)
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
        Events.emit("onTransferProgress", job.toMap())
        TransferService.refresh(app)
    }
}
