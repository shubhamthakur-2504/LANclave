package expo.modules.nativeserver

import android.content.Context
import android.net.Uri
import androidx.documentfile.provider.DocumentFile
import java.io.File
import java.io.InputStream
import java.security.MessageDigest

/**
 * On-demand file fingerprints for transfer dedupe, mirroring
 * `desktop-app/src-tauri/src/dedupe.rs`.
 *
 * Hashing is never part of the listing: on a SAF sandbox every file open is
 * a DocumentsProvider round trip, so it is paid only for the few files a peer
 * cannot tell apart by name and size. When the caller's expected size differs
 * from ours, we answer without opening the file at all.
 */
object Fingerprint {
    data class Result(val size: Long, val sha256: String?)

    /**
     * Size and (when sizes agree) SHA-256 of `name` in the sandbox, or null
     * when there is no such regular file.
     */
    fun ofSandboxFile(context: Context, rawSandboxPath: String, name: String, expectedSize: Long?): Result? {
        if (rawSandboxPath.startsWith("content://")) {
            val tree = DocumentFile.fromTreeUri(context, Uri.parse(rawSandboxPath)) ?: return null
            val doc = tree.findFile(name) ?: return null
            if (!doc.exists() || doc.isDirectory) return null
            val size = doc.length()
            if (expectedSize != null && expectedSize != size) return Result(size, null)
            val stream = context.contentResolver.openInputStream(doc.uri) ?: return null
            return Result(size, sha256(stream))
        }

        val file = File(rawSandboxPath.removePrefix("file://"), name)
        if (!file.isFile) return null
        val size = file.length()
        if (expectedSize != null && expectedSize != size) return Result(size, null)
        return Result(size, sha256(file.inputStream()))
    }

    /** SHA-256 of any `content://` or `file://` URI, e.g. a picked or shared file. */
    fun ofUri(context: Context, uri: String): String {
        val stream = context.contentResolver.openInputStream(Uri.parse(uri))
            ?: throw IllegalStateException("Could not open $uri")
        return sha256(stream)
    }

    /** Hex SHA-256 of the whole stream. Closes it. */
    fun sha256(input: InputStream): String {
        val digest = MessageDigest.getInstance("SHA-256")
        input.use { stream ->
            val buffer = ByteArray(1024 * 1024)
            while (true) {
                val n = stream.read(buffer)
                if (n == -1) break
                digest.update(buffer, 0, n)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }
}
