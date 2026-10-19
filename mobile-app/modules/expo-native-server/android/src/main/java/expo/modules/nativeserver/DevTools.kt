package expo.modules.nativeserver

import android.content.Context
import fi.iki.elonen.NanoHTTPD
import fi.iki.elonen.NanoHTTPD.IHTTPSession
import fi.iki.elonen.NanoHTTPD.Response
import org.json.JSONObject

/**
 * Dev builds only: the `/api/dev/` routes, reached through the same signed,
 * paired-only server as everything else.
 *
 *   GET /api/dev/status    what the tools can do right now
 *   GET /api/dev/logs      live logcat (see [DevLogs.stream])
 *   PUT /api/dev/install   an APK to install (see [DevInstall])
 */
object DevTools {
    private const val PREFS = "lanclave-dev"
    private const val KEY_ENABLED = "enabled"

    fun isEnabled(context: Context): Boolean =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(KEY_ENABLED, false)

    fun setEnabled(context: Context, enabled: Boolean) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(KEY_ENABLED, enabled).apply()
    }

    /** Turn the tools on and start capturing. Call while LANclave is on screen. */
    fun enable(context: Context) {
        setEnabled(context, true)
        DevService.start(context)
        DevLogs.start(context)
    }

    fun disable(context: Context) {
        setEnabled(context, false)
        DevLogs.stop()
        DevService.stop(context)
    }

    fun status(context: Context): Map<String, Any?> = mapOf(
        "enabled" to isEnabled(context),
        "capturing" to DevLogs.isCapturing,
        "readLogsGranted" to DevLogs.hasReadLogs(context),
        "seesOtherApps" to DevLogs.seesOtherApps,
        "lines" to DevLogs.lineCount(),
        "canInstall" to context.packageManager.canRequestPackageInstalls(),
        // "Display over other apps": what lets LANclave open an app from the background.
        "canOpenApps" to android.provider.Settings.canDrawOverlays(context),
        "packageName" to context.packageName,
    )

    fun handle(context: Context, session: IHTTPSession): Response {
        val uri = session.uri
        return when {
            uri == "/api/dev/status" && session.method == NanoHTTPD.Method.GET ->
                json(Response.Status.OK, JSONObject(status(context)))
            uri == "/api/dev/logs" && session.method == NanoHTTPD.Method.GET -> logs(context, session)
            uri == "/api/dev/install" && session.method == NanoHTTPD.Method.PUT -> install(context, session)
            uri == "/api/dev/launch" && session.method == NanoHTTPD.Method.POST -> launch(context, session)
            else -> NanoHTTPD.newFixedLengthResponse(Response.Status.NOT_FOUND, NanoHTTPD.MIME_PLAINTEXT, "Not Found")
        }
    }

    private fun logs(context: Context, session: IHTTPSession): Response {
        if (!DevLogs.isCapturing) {
            return json(
                Response.Status.CONFLICT,
                JSONObject().put("error", "Log capture is off. On the phone: LANclave > Settings > Developer tools > Start"),
            )
        }
        val p = session.parameters
        fun param(name: String) = p[name]?.firstOrNull()?.takeIf { it.isNotBlank() }

        val level = param("level")?.uppercase()?.firstOrNull() ?: 'V'
        val tags = param("tag")?.split(',')?.map { it.trim() }?.filter { it.isNotEmpty() }?.toSet() ?: emptySet()
        val filter = DevLogs.Filter(param("pkg"), level, tags, context)
        // `after` resumes a dropped stream, but only within the same capture.
        val after = param("after")?.toLongOrNull()?.takeIf { param("capture") == DevLogs.captureId }
        val tail = param("tail")?.toIntOrNull() ?: 200

        val response = NanoHTTPD.newChunkedResponse(
            Response.Status.OK, "text/plain; charset=utf-8", DevLogs.stream(filter, after, tail),
        )
        response.addHeader("X-Lanclave-Capture", DevLogs.captureId)
        response.addHeader("X-Lanclave-Sees-All", DevLogs.seesOtherApps.toString())
        return response
    }

    private fun install(context: Context, session: IHTTPSession): Response {
        val length = session.headers["content-length"]?.toLongOrNull()
            ?: return json(Response.Status.BAD_REQUEST, JSONObject().put("status", "failed").put("message", "Missing Content-Length"))
        val name = session.parameters["name"]?.firstOrNull()
        val result = DevInstall.install(context, session.inputStream, length, name)
        return json(Response.Status.OK, result)
    }

    /**
     * Open an app. With `scheme` (an Expo dev client's `exp+<slug>`) and
     * `port`, it opens connected to the Metro server on the laptop that
     * asked: the address is the one this request came from, so it is right
     * on Wi-Fi and on this phone's own hotspot alike.
     *
     * Android lets a background app open another only with "Display over
     * other apps"; without it a notification to tap stands in.
     */
    private fun launch(context: Context, session: IHTTPSession): Response {
        fun param(name: String) = session.parameters[name]?.firstOrNull()?.takeIf { it.isNotBlank() }
        val pkg = param("pkg")
            ?: return json(Response.Status.BAD_REQUEST, JSONObject().put("status", "failed").put("message", "Missing pkg"))
        // Lines from here on are this launch's.
        val seq = DevLogs.lastSeq()

        val scheme = param("scheme")
        val port = param("port")?.toIntOrNull()
        val laptop = session.remoteIpAddress?.let { if (it.contains(':')) "[$it]" else it }
        val intent = if (scheme != null && port != null && laptop != null) {
            val metro = android.net.Uri.encode("http://$laptop:$port")
            android.content.Intent(
                android.content.Intent.ACTION_VIEW,
                android.net.Uri.parse("$scheme://expo-development-client/?url=$metro"),
            ).setPackage(pkg)
        } else {
            context.packageManager.getLaunchIntentForPackage(pkg)
        } ?: return json(
            Response.Status.NOT_FOUND,
            JSONObject().put("status", "failed").put("message", "$pkg is not installed, or has no screen to open"),
        )
        intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK or android.content.Intent.FLAG_ACTIVITY_CLEAR_TOP)

        val direct = android.provider.Settings.canDrawOverlays(context)
        try {
            context.startActivity(intent)
        } catch (e: Exception) {
            return json(
                Response.Status.OK,
                JSONObject().put("status", "failed").put("message", e.message ?: "could not open $pkg"),
            )
        }
        if (!direct) DevInstall.showOpenPrompt(context, intent, pkg)
        return json(
            Response.Status.OK,
            JSONObject()
                .put("status", if (direct) "opened" else "notified")
                .put("capture", DevLogs.captureId)
                .put("seq", seq),
        )
    }

    private fun json(status: Response.Status, body: JSONObject): Response =
        NanoHTTPD.newFixedLengthResponse(status, "application/json", body.toString())
}
