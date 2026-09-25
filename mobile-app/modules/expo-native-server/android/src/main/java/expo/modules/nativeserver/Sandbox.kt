package expo.modules.nativeserver

import android.content.Context
import android.net.Uri
import android.provider.DocumentsContract
import androidx.documentfile.provider.DocumentFile
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.InputStream
import java.io.OutputStream

/**
 * File operations on the sandbox, whether it is a plain directory or a SAF
 * tree the user picked. Enough for downloads: partial files, appending,
 * renaming into place, and the names already taken.
 */
class Sandbox(private val context: Context, private val rawPath: String) {
    private val isSaf = rawPath.startsWith("content://")
    private val dir = File(rawPath.removePrefix("file://"))

    private fun tree(): DocumentFile? =
        if (isSaf) DocumentFile.fromTreeUri(context, Uri.parse(rawPath)) else null

    private fun doc(name: String): DocumentFile? = tree()?.findFile(name)?.takeIf { it.isFile }

    /** Every name in the sandbox, for picking a free one. */
    fun names(): Set<String> =
        if (isSaf) tree()?.listFiles()?.mapNotNull { it.name }?.toHashSet() ?: emptySet()
        else dir.list()?.toHashSet() ?: emptySet()

    fun length(name: String): Long? =
        if (isSaf) doc(name)?.length() else File(dir, name).takeIf { it.isFile }?.length()

    fun exists(name: String): Boolean = length(name) != null

    /** Open `name` for writing: appending, or from empty. Creates it if missing. */
    fun openForWrite(name: String, append: Boolean): OutputStream {
        if (!isSaf) return FileOutputStream(File(dir, name), append)
        val existing = doc(name)
        val target = existing
            ?: tree()?.createFile("application/octet-stream", name)
            ?: throw IllegalStateException("Could not create $name")
        return context.contentResolver.openOutputStream(target.uri, if (append && existing != null) "wa" else "wt")
            ?: throw IllegalStateException("Could not open $name")
    }

    fun openForRead(name: String): InputStream? =
        if (isSaf) doc(name)?.let { context.contentResolver.openInputStream(it.uri) }
        else File(dir, name).takeIf { it.isFile }?.let { FileInputStream(it) }

    fun delete(name: String) {
        if (isSaf) doc(name)?.delete() else File(dir, name).delete()
    }

    /** Rename `from` to `to`. SAF providers may adjust the name; the one used is returned. */
    fun rename(from: String, to: String): String {
        if (!isSaf) {
            val target = File(dir, to)
            if (!File(dir, from).renameTo(target)) throw IllegalStateException("Could not rename to $to")
            return to
        }
        val source = doc(from) ?: throw IllegalStateException("$from is gone")
        val renamed = DocumentsContract.renameDocument(context.contentResolver, source.uri, to)
            ?: throw IllegalStateException("Could not rename to $to")
        return DocumentFile.fromSingleUri(context, renamed)?.name ?: to
    }

    /** Delete partial downloads nothing has written to for `maxAgeMs`. */
    fun sweepStalePartials(maxAgeMs: Long): Int {
        val cutoff = System.currentTimeMillis() - maxAgeMs
        fun partial(name: String?) = name != null && name.startsWith(".") && name.endsWith(".lanclave-part")
        return if (isSaf) {
            // A provider that cannot say when a file changed reports 0: keep it.
            tree()?.listFiles()?.filter { it.isFile && partial(it.name) && it.lastModified() in 1 until cutoff }
                ?.count { it.delete() } ?: 0
        } else {
            dir.listFiles()?.filter { it.isFile && partial(it.name) && it.lastModified() < cutoff }
                ?.count { it.delete() } ?: 0
        }
    }

    /** Where to write a free space check; SAF trees live on shared storage. */
    fun freeBytes(): Long = try {
        val path = if (isSaf) android.os.Environment.getExternalStorageDirectory().path else dir.path
        android.os.StatFs(path).availableBytes
    } catch (_: Exception) {
        Long.MAX_VALUE
    }
}
