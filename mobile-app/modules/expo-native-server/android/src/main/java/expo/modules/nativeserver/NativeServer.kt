package expo.modules.nativeserver

import android.content.Context
import android.net.Uri
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
    private var pairedDevices: List<String>
) : NanoHTTPD(port) {
    private val isContentUri = rawSandboxPath.startsWith("content://")
    private val sandboxPath = rawSandboxPath.removePrefix("file://")

    fun updatePairedDevices(devices: List<String>) {
        pairedDevices = devices
    }

    override fun serve(session: IHTTPSession): Response {
        val uri = session.uri
        val method = session.method

        if (method != Method.GET && method != Method.PUT) {
            return newFixedLengthResponse(Response.Status.METHOD_NOT_ALLOWED, MIME_PLAINTEXT, "Method Not Allowed")
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

            try {
                val payload = "$reqDeviceId:$reqTimestamp".toByteArray(Charsets.UTF_8)
                val signatureBytes = android.util.Base64.decode(reqSignature, android.util.Base64.DEFAULT)
                val pubKeyBytes = android.util.Base64.decode(reqDeviceId, android.util.Base64.DEFAULT)

                val x509Prefix = byteArrayOf(
                    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00
                )
                val x509Bytes = x509Prefix + pubKeyBytes
                val spec = java.security.spec.X509EncodedKeySpec(x509Bytes)
                val factory = java.security.KeyFactory.getInstance("Ed25519")
                val publicKey = factory.generatePublic(spec)

                val verifier = java.security.Signature.getInstance("Ed25519")
                verifier.initVerify(publicKey)
                verifier.update(payload)
                if (!verifier.verify(signatureBytes)) {
                    return newFixedLengthResponse(Response.Status.UNAUTHORIZED, MIME_PLAINTEXT, "Invalid signature")
                }
            } catch (e: Exception) {
                return newFixedLengthResponse(Response.Status.UNAUTHORIZED, MIME_PLAINTEXT, "Invalid signature format")
            }
        }

        try {
            when {
                uri == "/health" -> {
                    val json = JSONObject()
                    json.put("status", "ok")
                    json.put("app", "lanclave")
                    json.put("device_id", deviceId)
                    json.put("device_name", deviceName)
                    return newFixedLengthResponse(Response.Status.OK, "application/json", json.toString())
                }
                uri == "/api/sandbox/files" -> {
                    val filesArray = JSONArray()

                    if (isContentUri) {
                        val treeUri = Uri.parse(rawSandboxPath)
                        val documentFile = DocumentFile.fromTreeUri(context, treeUri)
                        documentFile?.listFiles()?.forEach { file ->
                            val name = file.name
                            if (name != null && !name.startsWith(".")) {
                                val fileObj = JSONObject()
                                fileObj.put("name", name)
                                fileObj.put("size", if (file.isDirectory) 0 else file.length())
                                fileObj.put("is_directory", file.isDirectory)
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
                                filesArray.put(fileObj)
                            }
                        }
                    }

                    return newFixedLengthResponse(Response.Status.OK, "application/json", filesArray.toString())
                }
                uri.startsWith("/files/") -> {
                    val pathParam = uri.substring("/files/".length)
                    if (pathParam.contains("..") || pathParam.contains("/") || pathParam.isEmpty()) {
                        return newFixedLengthResponse(Response.Status.BAD_REQUEST, MIME_PLAINTEXT, "Bad Request")
                    }

                    if (method == Method.PUT) {
                        return handlePutFile(session, pathParam)
                    }

                    if (isContentUri) {
                        val treeUri = Uri.parse(rawSandboxPath)
                        val documentFile = DocumentFile.fromTreeUri(context, treeUri)
                        val childFile = documentFile?.findFile(pathParam)

                        if (childFile == null || !childFile.exists() || childFile.isDirectory) {
                            return newFixedLengthResponse(Response.Status.NOT_FOUND, MIME_PLAINTEXT, "Not Found")
                        }

                        val childUri = childFile.uri
                        val inputStream = context.contentResolver.openInputStream(childUri)
                            ?: return newFixedLengthResponse(Response.Status.INTERNAL_ERROR, MIME_PLAINTEXT, "Could not open stream")

                        val response = newFixedLengthResponse(Response.Status.OK, "application/octet-stream", inputStream, childFile.length())
                        return response
                    } else {
                        val file = File(sandboxPath, pathParam)
                        if (!file.exists() || file.isDirectory) {
                            return newFixedLengthResponse(Response.Status.NOT_FOUND, MIME_PLAINTEXT, "Not Found")
                        }

                        val fis = FileInputStream(file)
                        val response = newFixedLengthResponse(Response.Status.OK, "application/octet-stream", fis, file.length())
                        return response
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

    private fun handlePutFile(session: IHTTPSession, pathParam: String): Response {
        try {
            val contentLengthStr = session.headers["content-length"]
                ?: return newFixedLengthResponse(Response.Status.BAD_REQUEST, MIME_PLAINTEXT, "Missing Content-Length")
            val contentLength = contentLengthStr.toLongOrNull()
                ?: return newFixedLengthResponse(Response.Status.BAD_REQUEST, MIME_PLAINTEXT, "Invalid Content-Length")

            val outputStream: java.io.OutputStream
            val fileToDeleteOnError: File?
            val documentToDeleteOnError: DocumentFile?

            if (isContentUri) {
                val treeUri = Uri.parse(rawSandboxPath)
                val documentFile = DocumentFile.fromTreeUri(context, treeUri)
                val existingFile = documentFile?.findFile(pathParam)
                if (existingFile != null && existingFile.exists()) {
                    return newFixedLengthResponse(Response.Status.FORBIDDEN, MIME_PLAINTEXT, "File already exists")
                }
                val newFile = documentFile?.createFile("application/octet-stream", pathParam)
                    ?: return newFixedLengthResponse(Response.Status.INTERNAL_ERROR, MIME_PLAINTEXT, "Could not create file")
                
                documentToDeleteOnError = newFile
                fileToDeleteOnError = null
                outputStream = context.contentResolver.openOutputStream(newFile.uri)
                    ?: return newFixedLengthResponse(Response.Status.INTERNAL_ERROR, MIME_PLAINTEXT, "Could not open output stream")
            } else {
                val file = File(sandboxPath, pathParam)
                if (file.exists()) {
                    return newFixedLengthResponse(Response.Status.FORBIDDEN, MIME_PLAINTEXT, "File already exists")
                }
                
                documentToDeleteOnError = null
                fileToDeleteOnError = file
                outputStream = java.io.FileOutputStream(file)
            }

            try {
                val inputStream = session.inputStream
                val buffer = ByteArray(64 * 1024)
                var bytesReadTotal: Long = 0
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
                return newFixedLengthResponse(Status_201_CREATED, MIME_PLAINTEXT, "Created")
            } catch (e: Exception) {
                outputStream.close()
                fileToDeleteOnError?.delete()
                documentToDeleteOnError?.delete()
                throw e
            }
        } catch (e: Exception) {
            return newFixedLengthResponse(Response.Status.INTERNAL_ERROR, MIME_PLAINTEXT, e.message ?: "Unknown error")
        }
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
