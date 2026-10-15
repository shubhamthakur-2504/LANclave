package expo.modules.nativeserver

import java.io.File

/**
 * Paths inside the sandbox, as peers send them: `photos/2026/a.jpg`. The
 * same rules as `validate_sandboxed_path` on the desktop.
 */
object SandboxPath {
    /**
     * The segments of `raw`, or null when it could step outside the sandbox
     * or name something it should not: empty, absolute, `.` or `..`
     * anywhere, backslashes, drive letters, or NUL.
     */
    fun segments(raw: String): List<String>? {
        if (raw.isEmpty() || raw.startsWith("/") || raw.contains('\\') || raw.contains('\u0000')) return null
        val parts = raw.split('/')
        if (parts.any { it.isEmpty() || it == "." || it == ".." || it.contains(':') }) return null
        return parts
    }

    /**
     * `segments` under `root` on a real filesystem, or null if it resolves
     * outside it (a symlink pointing out, for instance).
     */
    fun resolve(root: File, segments: List<String>): File? {
        val target = File(root, segments.joinToString(File.separator))
        val base = root.canonicalFile
        val resolved = target.canonicalFile
        return resolved.takeIf { it == base || it.path.startsWith(base.path + File.separator) }
    }
}
