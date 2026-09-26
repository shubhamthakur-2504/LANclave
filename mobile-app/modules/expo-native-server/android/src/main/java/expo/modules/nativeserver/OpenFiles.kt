package expo.modules.nativeserver

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.webkit.MimeTypeMap

/**
 * Opening and sharing sandbox files with other apps (docs/open-files-plan
 * O1): Android's "Open with" and share sheets, with read access granted to
 * the chosen app for that one file only.
 */
object OpenFiles {
    /**
     * Types that install or run code when opened. `.apk` is the one that
     * matters on Android; the rest are here so a file headed for a
     * computer is flagged too.
     */
    private val RISKY = setOf("apk", "apks", "xapk", "exe", "msi", "bat", "cmd", "ps1", "vbs", "js", "jar", "sh", "scr", "lnk")

    fun isRisky(name: String): Boolean = extensionOf(name) in RISKY

    fun extensionOf(name: String): String =
        name.substringAfterLast('.', "").takeIf { it != name }?.lowercase() ?: ""

    /** The MIME type for a file name, or null when Android does not know it. */
    fun mimeTypeOf(name: String): String? =
        extensionOf(name).takeIf { it.isNotEmpty() }?.let { MimeTypeMap.getSingleton().getMimeTypeFromExtension(it) }

    /**
     * Open [uri] in whatever app handles [name]'s type. A `content://` URI
     * only: Android refuses to hand `file://` URIs to other apps. Returns
     * false when no installed app opens this type.
     */
    fun open(context: Context, uri: String, name: String): Boolean {
        val intent = Intent(Intent.ACTION_VIEW)
            .setDataAndType(Uri.parse(uri), mimeTypeOf(name) ?: "*/*")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        return try {
            context.startActivity(intent)
            true
        } catch (_: ActivityNotFoundException) {
            false
        }
    }

    /** The share sheet for one file. */
    fun share(context: Context, uri: String, name: String) {
        val send = Intent(Intent.ACTION_SEND)
            .setType(mimeTypeOf(name) ?: "application/octet-stream")
            .putExtra(Intent.EXTRA_STREAM, Uri.parse(uri))
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        context.startActivity(
            Intent.createChooser(send, name).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION),
        )
    }
}
