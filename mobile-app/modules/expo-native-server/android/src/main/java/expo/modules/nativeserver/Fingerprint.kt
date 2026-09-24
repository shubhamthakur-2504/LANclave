package expo.modules.nativeserver

import android.content.Context
import android.net.Uri
import androidx.documentfile.provider.DocumentFile
import java.io.File
import java.io.InputStream
import java.security.MessageDigest

/**
 * On-demand file fingerprints for transfer dedupe, mirroring
 * `desktop-app/src-tauri/src/dedupe.rs`, plus the collision-naming scheme
 * both apps share (`name (1).ext`).
 *
 * Hashing is never part of the listing: on a SAF sandbox every file open is
 * a DocumentsProvider round trip, so it is paid only for the few files a peer
 * cannot tell apart by name and size. When the caller's expected size differs
 * from ours, we answer without opening the file at all.
 */
object Fingerprint {
    /** How many numbered copies (`name (1)` ... `name (N)`) are considered. */
    private const val MAX_SIBLINGS = 50

    data class Sibling(val name: String, val sha256: String)

    /**
     * `size`/`sha256` describe the exact name; `siblings` are numbered copies
     * whose size matched the caller's expected size.
     */
    data class Result(val size: Long, val sha256: String?, val siblings: List<Sibling> = emptyList())

    /** `"notes.txt"`, 2 -> `"notes (2).txt"`; 0 is the name itself. */
    fun numberedName(name: String, n: Int): String {
        if (n == 0) return name
        val dot = name.lastIndexOf('.')
        return if (dot > 0) "${name.substring(0, dot)} ($n)${name.substring(dot)}" else "$name ($n)"
    }

    /** First of `name`, `name (1)`, ... for which `isTaken` is false. */
    fun firstFreeName(name: String, isTaken: (String) -> Boolean): String {
        for (n in 0 until 10_000) {
            val candidate = numberedName(name, n)
            if (!isTaken(candidate)) return candidate
        }
        throw IllegalStateException("No free name for $name")
    }

    /** One sandbox entry, however the sandbox is stored. */
    private class Entry(val size: Long, val open: () -> InputStream?)

    /**
     * Size and (when sizes agree) SHA-256 of `name` in the sandbox, plus
     * same-size numbered copies with an expected size. Null when there is no
     * such regular file.
     */
    fun ofSandboxFile(
        context: Context,
        rawSandboxPath: String,
        name: String,
        expectedSize: Long?,
        withSiblings: Boolean = true,
    ): Result? {
        val lookup: (String) -> Entry? = if (rawSandboxPath.startsWith("content://")) {
            val tree = DocumentFile.fromTreeUri(context, Uri.parse(rawSandboxPath)) ?: return null
            // One listing, then lookups by name: findFile() would re-list per call.
            val children = tree.listFiles().filter { it.isFile }.associateBy { it.name }
            val resolve: (String) -> Entry? = { n ->
                children[n]?.let { doc -> Entry(doc.length()) { context.contentResolver.openInputStream(doc.uri) } }
            }
            resolve
        } else {
            val dir = File(rawSandboxPath.removePrefix("file://"))
            val resolve: (String) -> Entry? = { n ->
                File(dir, n).takeIf { it.isFile }?.let { f -> Entry(f.length()) { f.inputStream() } }
            }
            resolve
        }

        val base = lookup(name) ?: return null
        if (expectedSize == null) {
            return Result(base.size, base.open()?.let(::sha256))
        }

        val baseSha = if (base.size == expectedSize) base.open()?.let(::sha256) else null
        val siblings = mutableListOf<Sibling>()
        for (n in 1..(if (withSiblings) MAX_SIBLINGS else 0)) {
            val siblingName = numberedName(name, n)
            val sibling = lookup(siblingName) ?: break
            if (sibling.size != expectedSize) continue
            sibling.open()?.let { siblings.add(Sibling(siblingName, sha256(it))) }
        }
        return Result(base.size, baseSha, siblings)
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
