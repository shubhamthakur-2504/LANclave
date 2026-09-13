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
    private val rawSandboxPath: String
) : NanoHTTPD(port) {
    private val isContentUri = rawSandboxPath.startsWith("content://")
    private val sandboxPath = rawSandboxPath.removePrefix("file://")

    override fun serve(session: IHTTPSession): Response {
        val uri = session.uri
        val method = session.method

        if (method != Method.GET) {
            return newFixedLengthResponse(Response.Status.METHOD_NOT_ALLOWED, MIME_PLAINTEXT, "Method Not Allowed")
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
}
