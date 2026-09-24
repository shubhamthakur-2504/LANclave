package expo.modules.nativeserver

import android.content.Context
import android.net.Uri
import android.os.ParcelFileDescriptor
import fi.iki.elonen.NanoHTTPD
import java.io.File
import java.io.FileInputStream
import java.io.InputStream

/**
 * Serving one file with resume support, whatever it is stored in: a plain
 * file, a SAF document in the sandbox, or (for offers) any content URI.
 */
class ServedFile(
    val name: String,
    val size: Long,
    val modifiedMs: Long,
    /** Open positioned at [offset]. */
    private val openAt: (offset: Long) -> InputStream?,
) {
    fun open(offset: Long): InputStream? = openAt(offset)

    companion object {
        fun of(file: File): ServedFile? = file.takeIf { it.isFile }?.let {
            ServedFile(it.name, it.length(), it.lastModified()) { offset ->
                FileInputStream(it).also { s -> s.channel.position(offset) }
            }
        }

        /**
         * A content URI. Seeks through its file descriptor, which local
         * providers (SAF storage, MediaStore) offer; a provider that only
         * streams is skipped forward instead -- slower, still correct.
         */
        fun of(context: Context, uri: Uri, name: String, size: Long, modifiedMs: Long): ServedFile =
            ServedFile(name, size, modifiedMs) { offset ->
                val pfd = try {
                    context.contentResolver.openFileDescriptor(uri, "r")
                } catch (_: Exception) {
                    null
                }
                if (pfd != null) {
                    ParcelFileDescriptor.AutoCloseInputStream(pfd).also { it.channel.position(offset) }
                } else {
                    context.contentResolver.openInputStream(uri)?.also { skipFully(it, offset) }
                }
            }

        private fun skipFully(input: InputStream, count: Long) {
            var left = count
            while (left > 0) {
                val skipped = input.skip(left)
                if (skipped <= 0) {
                    if (input.read() == -1) return
                    left -= 1
                } else {
                    left -= skipped
                }
            }
        }
    }
}

private val STATUS_206 = object : NanoHTTPD.Response.IStatus {
    override fun getDescription() = "206 Partial Content"
    override fun getRequestStatus() = 206
}

private val STATUS_416 = object : NanoHTTPD.Response.IStatus {
    override fun getDescription() = "416 Range Not Satisfiable"
    override fun getRequestStatus() = 416
}

/**
 * Answer a GET for [file], honouring `Range` / `If-Range`. [wrap] sees the
 * stream about to be sent with the first byte and length, so a caller can
 * log or track it.
 */
fun serveFile(
    session: NanoHTTPD.IHTTPSession,
    file: ServedFile,
    wrap: (input: InputStream, start: Long, length: Long) -> InputStream = { s, _, _ -> s },
): NanoHTTPD.Response {
    val tag = Ranges.etag(file.size, file.modifiedMs)
    val requested = Ranges.requested(session.headers["range"], session.headers["if-range"], tag, file.size)

    if (requested is Ranges.Requested.Unsatisfiable) {
        return NanoHTTPD.newFixedLengthResponse(STATUS_416, NanoHTTPD.MIME_PLAINTEXT, "").apply {
            addHeader("Content-Range", "bytes */${file.size}")
            addHeader("ETag", tag)
        }
    }

    val start = (requested as? Ranges.Requested.From)?.start ?: 0L
    val length = file.size - start
    val input = file.open(start)
        ?: return NanoHTTPD.newFixedLengthResponse(
            NanoHTTPD.Response.Status.INTERNAL_ERROR, NanoHTTPD.MIME_PLAINTEXT, "Could not open file",
        )

    val status = if (start > 0) STATUS_206 else NanoHTTPD.Response.Status.OK
    return NanoHTTPD.newFixedLengthResponse(status, "application/octet-stream", wrap(input, start, length), length)
        .apply {
            addHeader("Accept-Ranges", "bytes")
            addHeader("ETag", tag)
            if (start > 0) addHeader("Content-Range", "bytes $start-${file.size - 1}/${file.size}")
        }
}
