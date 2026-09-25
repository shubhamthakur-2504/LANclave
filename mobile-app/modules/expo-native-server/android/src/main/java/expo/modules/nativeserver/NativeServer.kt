package expo.modules.nativeserver

import android.content.Context
import android.net.Uri
import android.provider.DocumentsContract
import androidx.documentfile.provider.DocumentFile
import fi.iki.elonen.NanoHTTPD
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.io.FileNotFoundException

class NativeServer(
    private val context: Context,
    port: Int,
    private val deviceId: String,
    private val deviceName: String,
    private val rawSandboxPath: String,
    private var pairedDevices: List<String>,
    /** A device withdrew its own pairing (rejected the codes, or unpaired). */
    private val onPairingCancelled: (String) -> Unit = {},
) : NanoHTTPD(port) {
    /** A device wants to pair: (deviceId, name, ip, code). */
    private var onPairingRequest: (String, String, String?, String) -> Unit = { _, _, _, _ -> }

    fun setPairingRequestHandler(handler: (String, String, String?, String) -> Unit) {
        onPairingRequest = handler
    }

    private val isContentUri = rawSandboxPath.startsWith("content://")
    private val sandboxPath = rawSandboxPath.removePrefix("file://")

    fun updatePairedDevices(devices: List<String>) {
        pairedDevices = devices
    }

    override fun serve(session: IHTTPSession): Response {
        val uri = session.uri
        val method = session.method

        if (method != Method.GET && method != Method.PUT && method != Method.POST) {
            return newFixedLengthResponse(Response.Status.METHOD_NOT_ALLOWED, MIME_PLAINTEXT, "Method Not Allowed")
        }

        // A device revoking its own pairing is, by definition, possibly not
        // paired with us any more -- it is checked against its own key below.
        if (uri == "/api/pairing/cancel" && method == Method.POST) {
            return handlePairingCancel(session)
        }
        // Asking to pair is, by definition, from a device we have not paired.
        if (uri == "/api/pairing/request" && method == Method.POST) {
            return handlePairingRequest(session)
        }

        if (uri != "/health") {
            val reqDeviceId = session.headers["x-lanclave-device-id"]
            val reqTimestamp = session.headers["x-lanclave-timestamp"]
            val reqSignature = session.headers["x-lanclave-signature"]

            if (reqDeviceId == null || reqTimestamp == null || reqSignature == null) {
                return newFixedLengthResponse(Response.Status.UNAUTHORIZED, MIME_PLAINTEXT, "Missing authentication headers")
            }

            if (!pairedDevices.contains(reqDeviceId)) {
                return newFixedLengthResponse(Response.Status.UNAUTHORIZED, MIME_PLAINTEXT, "Device not paired")
            }

            val timestampSecs = reqTimestamp.toLongOrNull()
            if (timestampSecs == null) {
                return newFixedLengthResponse(Response.Status.UNAUTHORIZED, MIME_PLAINTEXT, "Invalid timestamp format")
            }

            val currentSecs = System.currentTimeMillis() / 1000
            if (kotlin.math.abs(currentSecs - timestampSecs) > 30) {
                return newFixedLengthResponse(Response.Status.UNAUTHORIZED, MIME_PLAINTEXT, "Timestamp expired")
            }

            val valid = try {
                verifyEd25519(reqDeviceId, reqTimestamp, reqSignature)
            } catch (e: Exception) {
                return newFixedLengthResponse(Response.Status.UNAUTHORIZED, MIME_PLAINTEXT, "Invalid signature format")
            }
            if (!valid) {
                return newFixedLengthResponse(Response.Status.UNAUTHORIZED, MIME_PLAINTEXT, "Invalid signature")
            }

            // Verified request from a paired peer: that is a liveness signal.
            PresenceRegistry.markSeen(reqDeviceId, session.remoteIpAddress)
        } else {
            // /health stays open for discovery, but a paired peer's heartbeat
            // arrives signed. Record it as contact when the signature checks
            // out -- that is how this side learns a peer's new address after
            // a DHCP lease change. Never rejects: bad or missing headers just
            // mean an ordinary anonymous probe.
            recordSignedHealthProbe(session)
        }

        try {
            when {
                uri == "/health" -> {
                    val json = JSONObject()
                    json.put("status", "ok")
                    json.put("app", "lanclave")
                    json.put("device_id", deviceId)
                    json.put("device_name", deviceName)
                    // Lets peers show a phone glyph rather than a generic dot.
                    json.put("device_type", "phone")
                    return newFixedLengthResponse(Response.Status.OK, "application/json", json.toString())
                }
                uri == "/api/pairing/status" && method == Method.GET -> {
                    // Reaching here means the caller passed the paired-device
                    // check above: the pairing holds on this side. Unlike the
                    // open /health, a one-sided pairing gets 401 instead.
                    val json = JSONObject()
                    json.put("paired", true)
                    json.put("app", "lanclave")
                    json.put("device_id", deviceId)
                    json.put("device_name", deviceName)
                    json.put("device_type", "phone")
                    // What this server speaks: peers choose offers over the
                    // legacy push, and know downloads resume.
                    json.put("features", JSONArray(listOf("range", "fingerprint", "offers")))
                    return newFixedLengthResponse(Response.Status.OK, "application/json", json.toString())
                }
                uri == "/api/offers" || uri.startsWith("/api/offers/") -> {
                    // Authenticated above: the header is a verified paired device.
                    return Offers.handle(session, session.headers["x-lanclave-device-id"]!!)
                }
                uri == "/api/presence/hello" && method == Method.POST -> {
                    return handlePresenceHello(session)
                }
                uri == "/api/presence/bye" && method == Method.POST -> {
                    val peerId = session.headers["x-lanclave-device-id"]
                    if (peerId != null) PresenceRegistry.markOffline(peerId)
                    return newFixedLengthResponse(Response.Status.OK, "application/json", "{\"status\":\"ok\"}")
                }
                uri == "/api/sandbox/files" -> {
                    val filesArray = JSONArray()

                    if (isContentUri) {
                        // One query for every child's name, size, type and
                        // mtime. DocumentFile.listFiles() + length()/isDirectory
                        // cost a DocumentsProvider round trip per call, per file.
                        querySafChildren { name, size, isDir, modified ->
                            if (!name.startsWith(".")) {
                                val fileObj = JSONObject()
                                fileObj.put("name", name)
                                fileObj.put("size", if (isDir) 0 else size)
                                fileObj.put("is_directory", isDir)
                                if (modified != null) fileObj.put("modified", modified)
                                filesArray.put(fileObj)
                            }
                        }
                    } else {
                        val dir = File(sandboxPath)
                        dir.listFiles()?.forEach { file ->
                            if (!file.name.startsWith(".")) {
                                val fileObj = JSONObject()
                                fileObj.put("name", file.name)
                                fileObj.put("size", if (file.isDirectory) 0 else file.length())
                                fileObj.put("is_directory", file.isDirectory)
                                file.lastModified().takeIf { it > 0 }?.let { fileObj.put("modified", it) }
                                filesArray.put(fileObj)
                            }
                        }
                    }

                    return newFixedLengthResponse(Response.Status.OK, "application/json", filesArray.toString())
                }
                uri.startsWith("/api/sandbox/fingerprint/") && method == Method.GET -> {
                    return handleFingerprint(session, uri.substring("/api/sandbox/fingerprint/".length))
                }
                uri.startsWith("/files/") -> {
                    val pathParam = uri.substring("/files/".length)
                    if (pathParam.contains("..") || pathParam.contains("/") || pathParam.isEmpty()) {
                        return newFixedLengthResponse(Response.Status.BAD_REQUEST, MIME_PLAINTEXT, "Bad Request")
                    }

                    if (method == Method.PUT) {
                        return handlePutFile(session, pathParam)
                    }

                    val served = if (isContentUri) {
                        val tree = DocumentFile.fromTreeUri(context, Uri.parse(rawSandboxPath))
                        tree?.findFile(pathParam)
                            ?.takeIf { it.exists() && it.isFile }
                            ?.let { ServedFile.of(context, it.uri, pathParam, it.length(), it.lastModified()) }
                    } else {
                        ServedFile.of(File(sandboxPath, pathParam))
                    } ?: return newFixedLengthResponse(Response.Status.NOT_FOUND, MIME_PLAINTEXT, "Not Found")

                    // Honours Range / If-Range, so an interrupted pull resumes.
                    return serveFile(session, served) { input, _, length ->
                        servedToPeer(session, pathParam, input, length)
                    }
                }
                else -> {
                    return newFixedLengthResponse(Response.Status.NOT_FOUND, MIME_PLAINTEXT, "Not Found")
                }
            }
        } catch (e: Exception) {
            return newFixedLengthResponse(Response.Status.INTERNAL_ERROR, MIME_PLAINTEXT, e.message ?: "Unknown error")
        }
    }

    /**
     * `POST /api/pairing/request` -- a device (the desktop, when pairing is
     * started there) asking us to open our side of the code comparison.
     * Mirrors the desktop's handler: same body, same reply.
     *
     * Grants nothing. It only shows a dialog; trust is stored when the user
     * here confirms the code, exactly as when pairing starts on this phone.
     */
    private fun handlePairingRequest(session: IHTTPSession): Response {
        val body = try {
            val files = HashMap<String, String>()
            session.parseBody(files)
            JSONObject(files["postData"] ?: "")
        } catch (_: Exception) {
            return newFixedLengthResponse(Response.Status.BAD_REQUEST, MIME_PLAINTEXT, "Invalid body")
        }

        val peerId = body.optString("device_id")
        val peerKey = PairingCode.publicKey(peerId)
        val ownKey = PairingCode.publicKey(deviceId)
        if (peerKey == null || ownKey == null || peerId == deviceId) {
            return newFixedLengthResponse(Response.Status.BAD_REQUEST, MIME_PLAINTEXT, "Invalid device id")
        }

        val code = PairingCode.compute(ownKey, peerKey)
        val name = body.optString("name").takeIf { it.isNotBlank() } ?: "Unknown device"
        // The address the request came from, not one the body claims.
        onPairingRequest(peerId, name, session.remoteIpAddress, code)

        val reply = JSONObject()
        reply.put("status", "ok")
        reply.put("fingerprint", code)
        reply.put("device_id", deviceId)
        return newFixedLengthResponse(Response.Status.OK, "application/json", reply.toString())
    }

    /**
     * `POST /api/pairing/cancel` -- a device withdrawing its own pairing.
     *
     * Verified against the key its device id names, with no pairing needed:
     * a device can only ever revoke trust in itself. Stops accepting it at
     * once; JS removes it from the stored list via [onPairingCancelled].
     */
    private fun handlePairingCancel(session: IHTTPSession): Response {
        val id = session.headers["x-lanclave-device-id"]
        val ts = session.headers["x-lanclave-timestamp"]
        val sig = session.headers["x-lanclave-signature"]
        if (id == null || ts == null || sig == null) {
            return newFixedLengthResponse(Response.Status.UNAUTHORIZED, MIME_PLAINTEXT, "Missing authentication headers")
        }
        val tsSecs = ts.toLongOrNull()
        if (tsSecs == null || kotlin.math.abs(System.currentTimeMillis() / 1000 - tsSecs) > 30) {
            return newFixedLengthResponse(Response.Status.UNAUTHORIZED, MIME_PLAINTEXT, "Timestamp expired")
        }
        val valid = try { verifyEd25519(id, ts, sig) } catch (_: Exception) { false }
        if (!valid) {
            return newFixedLengthResponse(Response.Status.UNAUTHORIZED, MIME_PLAINTEXT, "Invalid signature")
        }

        pairedDevices = pairedDevices.filter { it != id }
        PresenceRegistry.forget(id)
        onPairingCancelled(id)
        return newFixedLengthResponse(Response.Status.OK, "application/json", "{\"status\":\"ok\"}")
    }

    /** Ed25519 check of "deviceId:timestamp". Throws on malformed input. */
    private fun verifyEd25519(deviceId: String, timestamp: String, signature: String): Boolean {
        val payload = "$deviceId:$timestamp".toByteArray(Charsets.UTF_8)
        val signatureBytes = android.util.Base64.decode(signature, android.util.Base64.DEFAULT)
        val pubKeyBytes = android.util.Base64.decode(deviceId, android.util.Base64.DEFAULT)

        val x509Prefix = byteArrayOf(
            0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00
        )
        val spec = java.security.spec.X509EncodedKeySpec(x509Prefix + pubKeyBytes)
        val publicKey = java.security.KeyFactory.getInstance("Ed25519").generatePublic(spec)

        val verifier = java.security.Signature.getInstance("Ed25519")
        verifier.initVerify(publicKey)
        verifier.update(payload)
        return verifier.verify(signatureBytes)
    }

    private fun recordSignedHealthProbe(session: IHTTPSession) {
        val id = session.headers["x-lanclave-device-id"] ?: return
        val ts = session.headers["x-lanclave-timestamp"] ?: return
        val sig = session.headers["x-lanclave-signature"] ?: return
        if (!pairedDevices.contains(id)) return

        val tsSecs = ts.toLongOrNull() ?: return
        if (kotlin.math.abs(System.currentTimeMillis() / 1000 - tsSecs) > 30) return

        val ok = try { verifyEd25519(id, ts, sig) } catch (_: Exception) { false }
        if (ok) PresenceRegistry.markSeen(id, session.remoteIpAddress)
    }

    /**
     * A peer announcing it is online. Identity comes from the verified auth
     * headers and the address from the TCP connection; the body only supplies
     * a display name and port. The reply carries our own details so a single
     * round trip informs both sides.
     */
    private fun handlePresenceHello(session: IHTTPSession): Response {
        val peerId = session.headers["x-lanclave-device-id"]
            ?: return newFixedLengthResponse(Response.Status.UNAUTHORIZED, MIME_PLAINTEXT, "Missing device id")

        var peerName: String? = null
        var peerPort: Int? = null
        try {
            val files = HashMap<String, String>()
            session.parseBody(files)
            val raw = files["postData"]
            if (!raw.isNullOrBlank()) {
                val body = JSONObject(raw)
                peerName = body.optString("device_name").takeIf { it.isNotBlank() }
                peerPort = body.optInt("port", 0).takeIf { it > 0 }
            }
        } catch (_: Exception) {
            // A malformed body still counts as contact; only the name/port are lost.
        }

        PresenceRegistry.markSeen(peerId, session.remoteIpAddress, peerPort, peerName)

        val ack = JSONObject()
        ack.put("status", "ok")
        ack.put("device_id", deviceId)
        ack.put("device_name", deviceName)
        return newFixedLengthResponse(Response.Status.OK, "application/json", ack.toString())
    }

    /**
     * `GET /api/sandbox/fingerprint/{name}?size=N` -- size and SHA-256 of one
     * file, for dedupe. With `size`, a mismatch is answered without hashing,
     * and same-size numbered copies (`name (1).ext`...) are listed with their
     * digests. Same wire format as the desktop's handler.
     */
    private fun handleFingerprint(session: IHTTPSession, name: String): Response {
        if (name.contains("..") || name.contains("/") || name.isEmpty()) {
            return newFixedLengthResponse(Response.Status.NOT_FOUND, MIME_PLAINTEXT, "Not Found")
        }
        val expectedSize = session.parameters["size"]?.firstOrNull()?.toLongOrNull()

        // exact=1: this file only, not its numbered copies (download checks).
        val exact = session.parameters["exact"]?.firstOrNull() == "1"
        val result = Fingerprint.ofSandboxFile(context, rawSandboxPath, name, expectedSize, withSiblings = !exact)
            ?: return newFixedLengthResponse(Response.Status.NOT_FOUND, MIME_PLAINTEXT, "Not Found")

        val json = JSONObject()
        json.put("size", result.size)
        json.put("sha256", result.sha256 ?: JSONObject.NULL)
        if (result.siblings.isNotEmpty()) {
            val siblings = JSONArray()
            result.siblings.forEach { s ->
                siblings.put(JSONObject().put("name", s.name).put("sha256", s.sha256))
            }
            json.put("siblings", siblings)
        }
        return newFixedLengthResponse(Response.Status.OK, "application/json", json.toString())
    }

    private fun handlePutFile(session: IHTTPSession, pathParam: String): Response {
        try {
            val contentLengthStr = session.headers["content-length"]
                ?: return newFixedLengthResponse(Response.Status.BAD_REQUEST, MIME_PLAINTEXT, "Missing Content-Length")
            val contentLength = contentLengthStr.toLongOrNull()
                ?: return newFixedLengthResponse(Response.Status.BAD_REQUEST, MIME_PLAINTEXT, "Invalid Content-Length")

            val outputStream: java.io.OutputStream
            val fileToDeleteOnError: File?
            val documentToDeleteOnError: DocumentFile?

            // Never overwrite: a taken name is saved as "name (1).ext", and the
            // reply says which name was used. Choosing and creating happen
            // under one lock -- NanoHTTPD serves each connection on its own
            // thread, and two pushes of the same name used to both pass an
            // exists() check and write into one file.
            val savedName: String
            if (isContentUri) {
                val treeUri = Uri.parse(rawSandboxPath)
                val documentFile = DocumentFile.fromTreeUri(context, treeUri)
                    ?: return newFixedLengthResponse(Response.Status.INTERNAL_ERROR, MIME_PLAINTEXT, "Sandbox unavailable")
                val newFile = synchronized(createLock) {
                    val taken = documentFile.listFiles().mapNotNull { it.name }.toHashSet()
                    val name = Fingerprint.firstFreeName(pathParam) { it in taken }
                    documentFile.createFile("application/octet-stream", name)
                } ?: return newFixedLengthResponse(Response.Status.INTERNAL_ERROR, MIME_PLAINTEXT, "Could not create file")

                savedName = newFile.name ?: pathParam
                documentToDeleteOnError = newFile
                fileToDeleteOnError = null
                outputStream = context.contentResolver.openOutputStream(newFile.uri)
                    ?: return newFixedLengthResponse(Response.Status.INTERNAL_ERROR, MIME_PLAINTEXT, "Could not open output stream")
            } else {
                // createNewFile() is atomic, so the lock only saves wasted retries.
                val file = synchronized(createLock) {
                    var created: File? = null
                    Fingerprint.firstFreeName(pathParam) { candidate ->
                        val f = File(sandboxPath, candidate)
                        if (f.createNewFile()) { created = f; false } else true
                    }
                    created
                } ?: return newFixedLengthResponse(Response.Status.INTERNAL_ERROR, MIME_PLAINTEXT, "Could not create file")

                savedName = file.name
                documentToDeleteOnError = null
                fileToDeleteOnError = file
                outputStream = java.io.FileOutputStream(file)
            }

            // Logged as "received" whichever way this ends.
            val peerId = session.headers["x-lanclave-device-id"] ?: ""
            val logEntry = TransferHistory.entry("received", "peer", peerId, PresenceRegistry.nameOf(peerId), pathParam)
            if (savedName != pathParam) logEntry.put("dest_name", savedName)
            var bytesReadTotal: Long = 0

            try {
                val inputStream = session.inputStream
                val buffer = ByteArray(64 * 1024)
                while (bytesReadTotal < contentLength) {
                    val bytesToRead = minOf(buffer.size.toLong(), contentLength - bytesReadTotal).toInt()
                    val read = inputStream.read(buffer, 0, bytesToRead)
                    if (read == -1) break
                    outputStream.write(buffer, 0, read)
                    bytesReadTotal += read
                }
                outputStream.flush()
                outputStream.close()

                if (bytesReadTotal < contentLength) {
                    throw Exception("Short read: expected $contentLength, got $bytesReadTotal")
                }
                // Use custom CREATED status instead of casting to existing Response.Status since NanoHTTPD doesn't have 201 CREATED
                logEntry.put("bytes", bytesReadTotal)
                runCatching { TransferHistory.record(context, logEntry) }

                val saved = JSONObject()
                saved.put("name", savedName)
                return newFixedLengthResponse(Status_201_CREATED, "application/json", saved.toString())
            } catch (e: Exception) {
                outputStream.close()
                fileToDeleteOnError?.delete()
                documentToDeleteOnError?.delete()
                logEntry.put("bytes", bytesReadTotal).put("outcome", "failed").put("error", e.message ?: "upload failed")
                runCatching { TransferHistory.record(context, logEntry) }
                throw e
            }
        } catch (e: Exception) {
            return newFixedLengthResponse(Response.Status.INTERNAL_ERROR, MIME_PLAINTEXT, e.message ?: "Unknown error")
        }
    }
    
    /** Every child of the SAF sandbox, from a single ContentResolver query. */
    private fun querySafChildren(visit: (name: String, size: Long, isDir: Boolean, modified: Long?) -> Unit) {
        val tree = Uri.parse(rawSandboxPath)
        val parentId = if (DocumentsContract.isDocumentUri(context, tree)) {
            DocumentsContract.getDocumentId(tree)
        } else {
            DocumentsContract.getTreeDocumentId(tree)
        }
        val children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, parentId)
        val columns = arrayOf(
            DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_SIZE,
            DocumentsContract.Document.COLUMN_MIME_TYPE,
            DocumentsContract.Document.COLUMN_LAST_MODIFIED,
        )
        context.contentResolver.query(children, columns, null, null, null)?.use { c ->
            while (c.moveToNext()) {
                val name = c.getString(0) ?: continue
                val size = if (c.isNull(1)) 0L else c.getLong(1)
                val isDir = c.getString(2) == DocumentsContract.Document.MIME_TYPE_DIR
                val modified = if (c.isNull(3)) null else c.getLong(3).takeIf { it > 0 }
                visit(name, size, isDir, modified)
            }
        }
    }

    /** Wrap a file a peer is pulling so the pull is logged when it ends. */
    private fun servedToPeer(session: IHTTPSession, name: String, input: java.io.InputStream, length: Long): java.io.InputStream {
        val peerId = session.headers["x-lanclave-device-id"] ?: ""
        val entry = TransferHistory.entry("sent", "peer", peerId, PresenceRegistry.nameOf(peerId), name)
        return TransferHistory.LoggingInputStream(input, context, entry, length)
    }

    companion object {
        /** Serialises "pick a free name + create it" across request threads. */
        private val createLock = Any()
    }

    private val Status_201_CREATED = object : Response.IStatus {
        override fun getDescription(): String = "201 Created"
        override fun getRequestStatus(): Int = 201
    }

    private fun hexStringToByteArray(s: String): ByteArray {
        val len = s.length
        val data = ByteArray(len / 2)
        var i = 0
        while (i < len) {
            data[i / 2] = ((Character.digit(s[i], 16) shl 4) + Character.digit(s[i + 1], 16)).toByte()
            i += 2
        }
        return data
    }
}
