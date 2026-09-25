package expo.modules.nativeserver

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import fi.iki.elonen.NanoHTTPD
import fi.iki.elonen.NanoHTTPD.Response
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/**
 * Sending as "offer, consent, receiver pulls" -- the phone's side of
 * `desktop-app/src-tauri/src/offers.rs`, with the same routes and rules:
 * offers only from paired devices; an offered file served only to the
 * device it was offered to, only after it accepted, only until the offer
 * expires, only by random id; offered names reduced to a bare file name.
 *
 * Kept in `offers.json` (P5), so open offers survive the app being closed
 * or killed: an accepted offer stays pullable and resumable on both sides.
 */
object Offers {
    const val PENDING_TTL_MS = 10 * 60 * 1000L
    const val ACCEPTED_TTL_MS = 24 * 60 * 60 * 1000L

    class OfferFile(val id: String, val name: String, val size: Long, val modified: Long?) {
        fun toJson(): JSONObject = JSONObject().put("id", id).put("name", name).put("size", size)
            .put("modified", modified ?: JSONObject.NULL)
    }

    class Outgoing(
        val id: String,
        val peerId: String,
        val peerName: String?,
        @Volatile var peerAddr: String,
        val files: List<OfferFile>,
        /** Where each file lives here, by file id. Never sent anywhere. */
        val uris: Map<String, Uri>,
        val createdMs: Long,
    ) {
        @Volatile var state = "waiting"
        @Volatile var paused = false
        @Volatile var accepted: List<String> = emptyList()
        @Volatile var expiresMs = createdMs + PENDING_TTL_MS
        val served = ConcurrentHashMap<String, Long>()
        val results = ConcurrentHashMap<String, JSONObject>()

        fun toJson(): JSONObject = JSONObject()
            .put("id", id).put("peer_id", peerId).put("peer_name", peerName ?: JSONObject.NULL)
            .put("files", JSONArray(files.map { it.toJson() }))
            .put("state", state).put("paused", paused).put("accepted", JSONArray(accepted))
            .put("served", JSONObject(served.mapValues { it.value }))
            .put("results", JSONObject(results as Map<*, *>))
            .put("created_ms", createdMs).put("expires_ms", expiresMs)
    }

    class Incoming(
        val id: String,
        val peerId: String,
        val peerName: String?,
        @Volatile var peerAddr: String,
        val files: List<OfferFile>,
        val receivedMs: Long,
    ) {
        @Volatile var state = "waiting"
        @Volatile var accepted: List<String> = emptyList()
        @Volatile var expiresMs = receivedMs + PENDING_TTL_MS
        val results = ConcurrentHashMap<String, JSONObject>()

        fun toJson(): JSONObject = JSONObject()
            .put("id", id).put("peer_id", peerId).put("peer_name", peerName ?: JSONObject.NULL)
            .put("files", JSONArray(files.map { it.toJson() }))
            .put("state", state).put("accepted", JSONArray(accepted))
            .put("results", JSONObject(results as Map<*, *>))
            .put("receiving", TransferEngine.active().any { it.offerId == id })
            .put("received_ms", receivedMs).put("expires_ms", expiresMs)
    }

    private val outgoing = ConcurrentHashMap<String, Outgoing>()
    private val incoming = ConcurrentHashMap<String, Incoming>()
    @Volatile private var app: Context? = null
    @Volatile private var sandboxPath: String? = null
    @Volatile private var deviceName: String = "Phone"
    @Volatile private var loaded = false
    private val saveLock = Any()

    fun configure(context: Context, sandbox: String, name: String) {
        app = context.applicationContext
        sandboxPath = sandbox
        deviceName = name
        TransferEngine.onJobEnded = ::onJobEnded
        if (!loaded) {
            loaded = true
            load(context.applicationContext)
        }
    }

    // ------------------------------------------------------------------
    // Kept on disk
    // ------------------------------------------------------------------

    private fun file(ctx: Context) = File(ctx.filesDir, "offers.json")

    private fun save() {
        val ctx = app ?: return
        val json = JSONObject()
            .put("outgoing", JSONArray(outgoing.values.map { o ->
                // What the UI never sees: where the files are, and the peer.
                o.toJson().put("peer_addr", o.peerAddr).put("uris", JSONObject(o.uris.mapValues { it.value.toString() }))
            }))
            .put("incoming", JSONArray(incoming.values.map { it.toJson().put("peer_addr", it.peerAddr) }))
        synchronized(saveLock) {
            runCatching {
                val tmp = File(ctx.filesDir, "offers.json.tmp")
                tmp.writeText(json.toString())
                tmp.renameTo(file(ctx))
            }
        }
    }

    private fun load(ctx: Context) {
        val json = runCatching { JSONObject(file(ctx).readText()) }.getOrNull() ?: return
        json.optJSONArray("outgoing")?.let { arr ->
            for (i in 0 until arr.length()) runCatching { outgoingFrom(arr.getJSONObject(i)) }.getOrNull()?.let { outgoing[it.id] = it }
        }
        json.optJSONArray("incoming")?.let { arr ->
            for (i in 0 until arr.length()) runCatching { incomingFrom(arr.getJSONObject(i)) }.getOrNull()?.let { incoming[it.id] = it }
        }
        sweep()
    }

    private fun nameOrNull(j: JSONObject, key: String): String? =
        j.optString(key).takeIf { it.isNotEmpty() && it != "null" }

    private fun strings(arr: JSONArray?): List<String> = arr?.let { a -> (0 until a.length()).map { a.getString(it) } } ?: emptyList()

    private fun filesFrom(arr: JSONArray): List<OfferFile> = (0 until arr.length()).map { i ->
        val f = arr.getJSONObject(i)
        OfferFile(f.getString("id"), f.getString("name"), f.getLong("size"), f.optLong("modified").takeIf { it > 0 })
    }

    private fun outgoingFrom(j: JSONObject): Outgoing {
        val u = j.getJSONObject("uris")
        val uris = u.keys().asSequence().associateWith { Uri.parse(u.getString(it)) }
        return Outgoing(j.getString("id"), j.getString("peer_id"), nameOrNull(j, "peer_name"), j.getString("peer_addr"),
            filesFrom(j.getJSONArray("files")), uris, j.getLong("created_ms")).apply {
            state = j.getString("state")
            paused = j.optBoolean("paused")
            accepted = strings(j.optJSONArray("accepted"))
            expiresMs = j.getLong("expires_ms")
            j.optJSONObject("served")?.let { s -> s.keys().forEach { served[it] = s.getLong(it) } }
            j.optJSONObject("results")?.let { r -> r.keys().forEach { results[it] = r.getJSONObject(it) } }
        }
    }

    private fun incomingFrom(j: JSONObject): Incoming =
        Incoming(j.getString("id"), j.getString("peer_id"), nameOrNull(j, "peer_name"), j.getString("peer_addr"),
            filesFrom(j.getJSONArray("files")), j.getLong("received_ms")).apply {
            state = j.getString("state")
            accepted = strings(j.optJSONArray("accepted"))
            expiresMs = j.getLong("expires_ms")
            j.optJSONObject("results")?.let { r -> r.keys().forEach { results[it] = r.getJSONObject(it) } }
        }

    // ------------------------------------------------------------------
    // "Always accept from this device"
    // ------------------------------------------------------------------

    private fun prefs(ctx: Context) = ctx.applicationContext.getSharedPreferences("lanclave_offers", Context.MODE_PRIVATE)

    /** Devices whose offers are taken without asking. */
    fun autoAccept(ctx: Context): Set<String> = prefs(ctx).getStringSet("auto_accept", emptySet())?.toSet() ?: emptySet()

    fun setAutoAccept(ctx: Context, deviceId: String, enabled: Boolean) {
        val next = autoAccept(ctx).let { if (enabled) it + deviceId else it - deviceId }
        prefs(ctx).edit().putStringSet("auto_accept", next).apply()
    }

    /** Forget the setting for devices no longer paired: pairing again starts from asking. */
    fun keepAutoAcceptFor(ctx: Context, paired: Collection<String>) {
        val current = autoAccept(ctx)
        val next = current.intersect(paired.toSet())
        if (next != current) prefs(ctx).edit().putStringSet("auto_accept", next).apply()
    }

    fun snapshotJson(): String {
        sweep()
        return JSONObject()
            .put("outgoing", JSONArray(outgoing.values.sortedByDescending { it.createdMs }.map { it.toJson() }))
            .put("incoming", JSONArray(incoming.values.sortedByDescending { it.receivedMs }.map { it.toJson() }))
            .toString()
    }

    /** Outgoing offers the receiver may still pull: keep the service up for them. */
    fun liveOutgoing(): List<Outgoing> {
        sweep()
        return outgoing.values.filter { it.state == "waiting" || it.state == "accepted" }
    }

    fun changed() {
        save()
        Events.emit("onOffersChanged", mapOf("json" to snapshotJson()))
        TransferService.refresh(app)
    }

    private fun sweep() {
        val now = System.currentTimeMillis()
        for (o in outgoing.values) if ((o.state == "waiting" || o.state == "accepted") && now >= o.expiresMs) {
            if (o.state == "waiting") o.files.forEach { logSent(o, it, "cancelled", null, "not answered in time") }
            o.state = "expired"
        }
        for (o in incoming.values) if (o.state == "waiting" && now >= o.expiresMs) o.state = "expired"
        val cutoff = now - ACCEPTED_TTL_MS
        outgoing.values.removeAll { it.state !in listOf("waiting", "accepted") && it.expiresMs < cutoff }
        incoming.values.removeAll { it.state !in listOf("waiting", "accepted") && it.expiresMs < cutoff }
    }

    /** Every accepted file has a result, and none failed. */
    private fun allSettled(accepted: List<String>, results: Map<String, JSONObject>): Boolean =
        accepted.all { results[it]?.optString("outcome")?.let { o -> o != "failed" } == true }

    /** A bare, visible file name from an offered one, or null to refuse it. */
    fun safeFileName(name: String): String? {
        val base = name.split('/', '\\').last().trim()
        val ok = base.isNotEmpty() && base != "." && base != ".." && !base.startsWith(".") &&
            !base.contains('\u0000') && !base.contains(':')
        return base.takeIf { ok }
    }

    // ------------------------------------------------------------------
    // Routes (already authenticated: `caller` is a verified paired device)
    // ------------------------------------------------------------------

    fun handle(session: NanoHTTPD.IHTTPSession, caller: String): Response {
        val parts = session.uri.removePrefix("/api/offers").trim('/').split('/').filter { it.isNotEmpty() }
        val post = session.method == NanoHTTPD.Method.POST
        return when {
            parts.isEmpty() && post -> receive(session, caller)
            parts.size == 2 && post && parts[1] == "cancel" -> withdrawn(parts[0], caller)
            parts.size == 2 && post && parts[1] == "accept" -> accepted(session, parts[0], caller)
            parts.size == 2 && post && parts[1] == "decline" -> declined(parts[0], caller)
            parts.size == 2 && post && parts[1] == "report" -> reported(session, parts[0], caller)
            parts.size == 3 && parts[1] == "files" -> serve(session, parts[0], parts[2], caller)
            parts.size == 4 && parts[1] == "files" && parts[3] == "fingerprint" -> fingerprint(session, parts[0], parts[2], caller)
            else -> status(Response.Status.NOT_FOUND)
        }
    }

    private fun status(s: Response.IStatus, text: String = "") =
        NanoHTTPD.newFixedLengthResponse(s, NanoHTTPD.MIME_PLAINTEXT, text)

    private val GONE = object : Response.IStatus {
        override fun getDescription() = "410 Gone"
        override fun getRequestStatus() = 410
    }
    private val ACCEPTED_202 = object : Response.IStatus {
        override fun getDescription() = "202 Accepted"
        override fun getRequestStatus() = 202
    }
    private val UNAVAILABLE_503 = object : Response.IStatus {
        override fun getDescription() = "503 Service Unavailable"
        override fun getRequestStatus() = 503
    }

    private fun body(session: NanoHTTPD.IHTTPSession): JSONObject? = try {
        val files = HashMap<String, String>()
        session.parseBody(files)
        JSONObject(files["postData"] ?: "{}")
    } catch (_: Exception) {
        null
    }

    /** `POST /api/offers` -- a paired device offers us files. */
    private fun receive(session: NanoHTTPD.IHTTPSession, caller: String): Response {
        val json = body(session) ?: return status(Response.Status.BAD_REQUEST)
        val id = json.optString("offer_id").takeIf { it.isNotEmpty() } ?: return status(Response.Status.BAD_REQUEST)
        val arr = json.optJSONArray("files") ?: return status(Response.Status.BAD_REQUEST)
        if (arr.length() == 0 || arr.length() > 10_000) return status(Response.Status.BAD_REQUEST)
        val files = ArrayList<OfferFile>()
        for (i in 0 until arr.length()) {
            val f = arr.getJSONObject(i)
            // Refuse the whole offer rather than half-accept it later.
            val name = safeFileName(f.optString("name")) ?: return status(Response.Status.BAD_REQUEST)
            files.add(OfferFile(f.getString("id"), name, f.getLong("size"), f.optLong("modified").takeIf { it > 0 }))
        }
        if (incoming.containsKey(id)) return status(ACCEPTED_202)

        val name = PresenceRegistry.nameOf(caller) ?: json.optString("sender_name").takeIf { it.isNotEmpty() }
        val offer = Incoming(id, caller, name, "${session.remoteIpAddress}:8377", files, System.currentTimeMillis())
        incoming[id] = offer
        changed()
        val ask = { Events.emit("onOfferReceived", mapOf("json" to offer.toJson().toString())) }
        val ctx = app
        if (ctx != null && caller in autoAccept(ctx)) {
            // Answered after this reply: the sender registered the offer
            // before posting it. No room, or the sender gone: ask instead.
            Thread { runCatching { accept(id, files.map { it.id }) }.onFailure { ask() } }.start()
        } else {
            ask()
        }
        return status(ACCEPTED_202)
    }

    private fun withdrawn(id: String, caller: String): Response {
        val offer = incoming[id]?.takeIf { it.peerId == caller } ?: return status(Response.Status.NOT_FOUND)
        if (offer.state == "waiting" || offer.state == "accepted") offer.state = "cancelled"
        TransferEngine.cancelOffer(id)
        changed()
        return status(Response.Status.OK)
    }

    /** Someone else's offer does not exist, as far as this caller knows. */
    private fun outgoingFor(id: String, caller: String): Outgoing? = outgoing[id]?.takeIf { it.peerId == caller }

    private fun accepted(session: NanoHTTPD.IHTTPSession, id: String, caller: String): Response {
        val offer = outgoingFor(id, caller) ?: return status(Response.Status.NOT_FOUND)
        if (offer.state != "waiting" && offer.state != "accepted") return status(GONE)
        val ids = body(session)?.optJSONArray("file_ids") ?: return status(Response.Status.BAD_REQUEST)
        val chosen = (0 until ids.length()).map { ids.getString(it) }.filter { fid -> offer.files.any { it.id == fid } }
        offer.accepted = chosen
        offer.state = "accepted"
        offer.expiresMs = System.currentTimeMillis() + ACCEPTED_TTL_MS
        offer.files.filter { it.id !in chosen }.forEach { logSent(offer, it, "declined", null, null) }
        changed()
        return status(Response.Status.OK)
    }

    private fun declined(id: String, caller: String): Response {
        val offer = outgoingFor(id, caller) ?: return status(Response.Status.NOT_FOUND)
        if (offer.state != "waiting") return status(GONE)
        offer.state = "declined"
        offer.files.forEach { logSent(offer, it, "declined", null, null) }
        changed()
        return status(Response.Status.OK)
    }

    private fun reported(session: NanoHTTPD.IHTTPSession, id: String, caller: String): Response {
        val offer = outgoingFor(id, caller) ?: return status(Response.Status.NOT_FOUND)
        val results = body(session)?.optJSONObject("results") ?: return status(Response.Status.BAD_REQUEST)
        for (fid in results.keys()) {
            // A file that failed may be retried and reported again.
            val open = offer.results[fid]?.optString("outcome")?.let { it == "failed" } ?: true
            if (fid !in offer.accepted || !open) continue
            val r = results.getJSONObject(fid)
            offer.results[fid] = r
            val file = offer.files.firstOrNull { it.id == fid } ?: continue
            logSent(offer, file, r.optString("outcome"), r.optString("dest_name").takeIf { it.isNotEmpty() && it != "null" },
                r.optString("error").takeIf { it.isNotEmpty() && it != "null" })
        }
        if (allSettled(offer.accepted, offer.results)) offer.state = "done"
        changed()
        return status(Response.Status.OK)
    }

    /** The offer and file `caller` may pull right now, or the refusal. */
    private fun servable(id: String, fid: String, caller: String): Pair<Pair<Outgoing, OfferFile>?, Response?> {
        val offer = outgoingFor(id, caller) ?: return null to status(Response.Status.NOT_FOUND)
        if (offer.state != "accepted" || System.currentTimeMillis() >= offer.expiresMs) return null to status(GONE)
        if (fid !in offer.accepted) return null to status(Response.Status.NOT_FOUND)
        if (offer.paused) {
            return null to status(UNAVAILABLE_503).apply { addHeader("Retry-After", "5") }
        }
        val file = offer.files.firstOrNull { it.id == fid } ?: return null to status(Response.Status.NOT_FOUND)
        return (offer to file) to null
    }

    private fun serve(session: NanoHTTPD.IHTTPSession, id: String, fid: String, caller: String): Response {
        val (ok, refusal) = servable(id, fid, caller)
        val (offer, file) = ok ?: return refusal!!
        val uri = offer.uris[fid] ?: return status(Response.Status.NOT_FOUND)
        val ctx = app ?: return status(Response.Status.INTERNAL_ERROR)
        val served = ServedFile.of(ctx, uri, file.name, file.size, file.modified ?: 0L)
        return serveFile(session, served) { input, start, _ ->
            // Track how far the receiver has got, for the sender's view.
            object : java.io.FilterInputStream(input) {
                var pos = start
                var last = 0L
                override fun read(b: ByteArray, off: Int, len: Int): Int =
                    super.read(b, off, len).also { n ->
                        if (n > 0) {
                            pos += n
                            offer.served[fid] = maxOf(offer.served[fid] ?: 0L, pos)
                            val now = System.currentTimeMillis()
                            if (now - last > 500) {
                                last = now
                                Events.emit("onOfferProgress", mapOf("offerId" to id, "fileId" to fid, "bytes" to pos.toDouble()))
                                TransferService.refresh(app)
                            }
                        }
                    }
            }
        }
    }

    private fun fingerprint(session: NanoHTTPD.IHTTPSession, id: String, fid: String, caller: String): Response {
        val (ok, refusal) = servable(id, fid, caller)
        val (offer, file) = ok ?: return refusal!!
        val uri = offer.uris[fid] ?: return status(Response.Status.NOT_FOUND)
        val ctx = app ?: return status(Response.Status.INTERNAL_ERROR)
        val expected = session.parameters["size"]?.firstOrNull()?.toLongOrNull()
        val sha = if (expected == null || expected == file.size) Fingerprint.ofUri(ctx, uri.toString()) else null
        val json = JSONObject().put("size", file.size).put("sha256", sha ?: JSONObject.NULL)
        return NanoHTTPD.newFixedLengthResponse(Response.Status.OK, "application/json", json.toString())
    }

    private fun logSent(offer: Outgoing, file: OfferFile, outcome: String, destName: String?, error: String?) {
        val ctx = app ?: return
        val entry = TransferHistory.entry("sent", "me", offer.peerId, offer.peerName, file.name)
        entry.put("outcome", if (outcome in listOf("completed", "skipped", "failed", "cancelled", "declined")) outcome else "failed")
        entry.put("bytes", if (outcome == "completed" || outcome == "skipped") file.size else 0)
        destName?.takeIf { it != file.name }?.let { entry.put("dest_name", it) }
        error?.let { entry.put("error", it) }
        runCatching { TransferHistory.record(ctx, entry) }
    }

    // ------------------------------------------------------------------
    // Actions from JS (blocking: call on a background thread)
    // ------------------------------------------------------------------

    /** Offer files to a peer. Returns the offer id, or null when the peer predates offers. */
    fun send(peerAddr: String, peerId: String, peerName: String?, files: JSONArray): String? {
        val ctx = app ?: throw IllegalStateException("Server not started")
        if (!PeerHttp.supportsOffers(peerAddr)) return null

        val offerFiles = ArrayList<OfferFile>()
        val uris = HashMap<String, Uri>()
        for (i in 0 until files.length()) {
            val f = files.getJSONObject(i)
            val uri = Uri.parse(f.getString("uri"))
            // Keep read access past the screen that picked or received it;
            // allowed for picker URIs, refused (harmlessly) for some shares.
            runCatching { ctx.contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION) }
            val id = UUID.randomUUID().toString().replace("-", "")
            val name = safeFileName(f.getString("name")) ?: throw IllegalArgumentException("Unsafe name: ${f.getString("name")}")
            // Pickers and shares do not always say how big a file is.
            val size = f.optLong("size").takeIf { it > 0 } ?: sizeOf(ctx, uri)
                ?: throw IllegalArgumentException("Cannot read the size of $name")
            offerFiles.add(OfferFile(id, name, size, modifiedOf(ctx, uri)))
            uris[id] = uri
        }

        val offer = Outgoing(UUID.randomUUID().toString().replace("-", ""), peerId, peerName, peerAddr, offerFiles, uris, System.currentTimeMillis())
        // Registered before posting: the receiver may accept faster than we return.
        outgoing[offer.id] = offer
        val body = JSONObject().put("offer_id", offer.id).put("sender_name", deviceName)
            .put("files", JSONArray(offerFiles.map { it.toJson() }))
        val code = PeerHttp.postJson(peerAddr, "/api/offers", body)
        if (code !in 200..299) {
            outgoing.remove(offer.id)
            throw IllegalStateException(if (code < 0) "Could not reach the device" else "The device refused the files (HTTP $code)")
        }
        changed()
        return offer.id
    }

    private fun sizeOf(ctx: Context, uri: Uri): Long? = runCatching {
        ctx.contentResolver.query(uri, arrayOf(android.provider.OpenableColumns.SIZE), null, null, null)?.use { c ->
            if (c.moveToFirst() && !c.isNull(0)) c.getLong(0).takeIf { it > 0 } else null
        }
    }.getOrNull()

    private fun modifiedOf(ctx: Context, uri: Uri): Long? = runCatching {
        ctx.contentResolver.query(uri, arrayOf(DocumentsContract.Document.COLUMN_LAST_MODIFIED), null, null, null)?.use { c ->
            if (c.moveToFirst() && !c.isNull(0)) c.getLong(0).takeIf { it > 0 } else null
        }
    }.getOrNull()

    fun cancelOutgoing(id: String) {
        val offer = outgoing[id] ?: return
        if (offer.state == "waiting" || offer.state == "accepted") offer.state = "cancelled"
        changed()
        PeerHttp.postJson(offer.peerAddr, "/api/offers/$id/cancel", JSONObject())
    }

    fun pauseOutgoing(id: String, paused: Boolean) {
        outgoing[id]?.paused = paused
        changed()
    }

    /** Take some or all files of an incoming offer and queue their downloads. */
    fun accept(id: String, fileIds: List<String>) {
        val offer = incoming[id] ?: throw IllegalStateException("This offer is gone")
        if (offer.state != "waiting" || System.currentTimeMillis() >= offer.expiresMs) {
            throw IllegalStateException("This offer is no longer open")
        }
        val chosen = offer.files.filter { it.id in fileIds }
        if (chosen.isEmpty()) throw IllegalArgumentException("Choose at least one file")

        val ctx = app ?: throw IllegalStateException("Server not started")
        val needed = chosen.sumOf { it.size }
        val free = Sandbox(ctx, sandboxPath!!).freeBytes()
        // Leave a little room: a full disk breaks more than this download.
        if (needed + 64L * 1024 * 1024 > free) {
            throw IllegalStateException("Not enough space: needs ${needed / 1_000_000} MB, ${free / 1_000_000} MB free")
        }

        PresenceRegistry.addrOf(offer.peerId)?.let { offer.peerAddr = it }
        val code = PeerHttp.postJson(offer.peerAddr, "/api/offers/$id/accept",
            JSONObject().put("file_ids", JSONArray(chosen.map { it.id })))
        if (code !in 200..299) throw IllegalStateException("The sender no longer offers these files")

        offer.accepted = chosen.map { it.id }
        offer.state = "accepted"
        offer.expiresMs = System.currentTimeMillis() + ACCEPTED_TTL_MS
        for (f in chosen) {
            TransferEngine.enqueue(
                TransferEngine.Job(
                    id = "offer:$id:${f.id}",
                    peerAddr = offer.peerAddr,
                    peerId = offer.peerId,
                    peerName = offer.peerName,
                    name = f.name,
                    size = f.size,
                    path = "/api/offers/$id/files/${f.id}",
                    fingerprintPath = "/api/offers/$id/files/${f.id}/fingerprint",
                    initiatedBy = "peer",
                    offerId = id,
                    fileId = f.id,
                ),
            )
        }
        changed()
    }

    fun decline(id: String) {
        val offer = incoming[id] ?: return
        offer.state = "declined"
        changed()
        PeerHttp.postJson(offer.peerAddr, "/api/offers/$id/decline", JSONObject())
    }

    /** A download of an offer ended: record it, and report once all have. */
    private fun onJobEnded(job: TransferEngine.Job) {
        val id = job.offerId ?: return
        val fid = job.fileId ?: return
        val offer = incoming[id] ?: return
        val outcome = when (job.status) {
            TransferEngine.Status.COMPLETED -> "completed"
            TransferEngine.Status.SKIPPED -> "skipped"
            else -> if (job.message == "Transfer cancelled") "cancelled" else "failed"
        }
        offer.results[fid] = JSONObject().put("outcome", outcome)
            .put("dest_name", job.destName ?: JSONObject.NULL)
            .put("error", if (outcome == "failed") job.message else JSONObject.NULL)
        // Report once every file has ended -- again after a retry. Failures
        // keep the offer open so Retry can pull them again.
        if (offer.state == "accepted" && offer.accepted.all { offer.results.containsKey(it) }) {
            if (allSettled(offer.accepted, offer.results)) offer.state = "done"
            val body = JSONObject().put("results", JSONObject(offer.results as Map<*, *>))
            Thread { PeerHttp.postJson(offer.peerAddr, "/api/offers/$id/report", body) }.start()
        }
        changed()
    }
}
