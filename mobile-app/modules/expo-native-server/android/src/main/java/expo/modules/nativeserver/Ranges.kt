package expo.modules.nativeserver

/**
 * Resumable downloads: `Range` / `If-Range` resolution, identical to
 * `desktop-app/src-tauri/src/range.rs` (same tag format, same rules), so a
 * partial download resumes the same way from either kind of peer.
 *
 * Only `bytes=N-` is supported -- all a resuming client sends. Anything else
 * gets the whole file, which RFC 9110 allows.
 */
object Ranges {
    sealed class Requested {
        /** Send the whole file with 200. */
        object Full : Requested()
        /** Send from [start] to the end with 206. */
        data class From(val start: Long) : Requested()
        /** The start is at or past the end: 416. */
        object Unsatisfiable : Requested()
    }

    /** Version tag: size and modified time, hex, quoted. Same as the desktop's. */
    fun etag(size: Long, modifiedMs: Long): String =
        "\"${size.toString(16)}-${maxOf(modifiedMs, 0L).toString(16)}\""

    fun requested(range: String?, ifRange: String?, currentEtag: String, size: Long): Requested {
        if (range == null) return Requested.Full
        // A range conditional on an older version of the file is void.
        if (ifRange != null && ifRange.trim() != currentEtag) return Requested.Full
        val start = parseOpenRange(range) ?: return Requested.Full
        return when {
            start >= size -> Requested.Unsatisfiable
            start == 0L -> Requested.Full
            else -> Requested.From(start)
        }
    }

    private fun parseOpenRange(value: String): Long? {
        val spec = value.trim().removePrefix("bytes=").takeIf { it != value.trim() } ?: return null
        if (spec.contains(',')) return null
        val dash = spec.indexOf('-')
        if (dash < 0 || spec.substring(dash + 1).isNotBlank()) return null
        return spec.substring(0, dash).trim().toLongOrNull()?.takeIf { it >= 0 }
    }
}
