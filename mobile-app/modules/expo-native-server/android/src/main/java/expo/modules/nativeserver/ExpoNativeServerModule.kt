package expo.modules.nativeserver

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class ExpoNativeServerModule : Module() {
  private var server: NativeServer? = null

  /** The newest pairing request, until JS shows it. */
  @Volatile private var pendingRequest: Map<String, Any?>? = null

  /** Pairing cancels not yet applied to the JS-side paired list. */
  private val pendingCancels = mutableSetOf<String>()

  /** Identity of the running server, so a redundant start can be detected. */
  private var currentConfig: String? = null

  override fun definition() = ModuleDefinition {
    Name("ExpoNativeServer")

    Events("onPairingCancelled", "onPairingRequest")

    Function("startServer") { port: Int, deviceId: String, deviceName: String, sandboxPath: String, pairedDevices: Array<String> ->
      try {
        val config = "$port|$deviceId|$deviceName|$sandboxPath"
        val existing = server

        // Idempotent. This used to stop() and rebuild unconditionally, and the
        // JS watchdog calls it every 10s, so the listening socket was torn down
        // and rebound every 10 seconds -- resetting every peer's TCP connection
        // and killing any transfer in flight. A start for a server that is
        // already listening with the same config is now just a paired-device
        // refresh.
        if (existing != null && existing.isAlive && currentConfig == config) {
          existing.updatePairedDevices(pairedDevices.toList())
          return@Function true
        }

        existing?.stop()
        val context = appContext.reactContext ?: throw Exception("React context is null")
        val next = NativeServer(context, port, deviceId, deviceName, sandboxPath, pairedDevices.toList()) { cancelledId ->
          // Queued as well as announced: the stored paired list lives in JS,
          // and a cancel must not be lost if nothing is listening right now.
          synchronized(pendingCancels) { pendingCancels.add(cancelledId) }
          sendEvent("onPairingCancelled", mapOf("deviceId" to cancelledId))
        }.also { srv ->
          srv.setPairingRequestHandler { id, name, ip, code ->
            val request = mapOf(
              "deviceId" to id,
              "name" to name,
              "ip" to ip,
              "fingerprint" to code,
              "receivedAtMs" to System.currentTimeMillis().toDouble(),
            )
            // Kept too, so a dialog is not lost while nothing is listening.
            pendingRequest = request
            sendEvent("onPairingRequest", request)
          }
        }
        next.start(5000, false)
        server = next
        currentConfig = config
        true
      } catch (e: Exception) {
        server = null
        currentConfig = null
        throw Exception("Failed to start server: ${e.message}")
      }
    }

    Function("isRunning") {
      server?.isAlive == true
    }

    /**
     * URIs handed to us by Android's share sheet (U3.2).
     *
     * Returns the EXTRA_STREAM of an ACTION_SEND / ACTION_SEND_MULTIPLE
     * intent, then clears the intent so the same share is not replayed every
     * time the app is foregrounded. Content URIs are returned as-is: the
     * uploader reads content:// directly, so nothing needs copying first.
     */
    Function("consumeSharedUris") {
      val activity = appContext.currentActivity
      val intent = activity?.intent
      val action = intent?.action

      if (intent == null ||
        (action != android.content.Intent.ACTION_SEND &&
          action != android.content.Intent.ACTION_SEND_MULTIPLE)
      ) {
        return@Function emptyList<String>()
      }

      val uris = when (action) {
        android.content.Intent.ACTION_SEND -> {
          // minSdk is 33, so the typed getter always exists.
          val uri = intent.getParcelableExtra(
            android.content.Intent.EXTRA_STREAM,
            android.net.Uri::class.java,
          )
          listOfNotNull(uri)
        }
        else -> {
          val list = intent.getParcelableArrayListExtra(
            android.content.Intent.EXTRA_STREAM,
            android.net.Uri::class.java,
          )
          list ?: emptyList()
        }
      }

      // Consume it: a share should be handled once, not on every resume.
      intent.action = android.content.Intent.ACTION_MAIN
      intent.removeExtra(android.content.Intent.EXTRA_STREAM)

      uris.map { it.toString() }
    }

    /**
     * Dedupe, client side: size and (when it matches `expectedSize`) SHA-256
     * of a file in our own sandbox, plus same-size numbered copies. Null when
     * the file is absent.
     */
    AsyncFunction("sandboxFileFingerprint") { sandboxPath: String, name: String, expectedSize: Double? ->
      if (name.contains("..") || name.contains("/") || name.isEmpty()) return@AsyncFunction null
      val context = appContext.reactContext ?: throw Exception("React context is null")
      val result = Fingerprint.ofSandboxFile(context, sandboxPath, name, expectedSize?.toLong())
        ?: return@AsyncFunction null
      mapOf(
        "size" to result.size.toDouble(),
        "sha256" to result.sha256,
        "siblings" to result.siblings.map { mapOf("name" to it.name, "sha256" to it.sha256) },
      )
    }

    /** SHA-256 of a local file about to be pushed, e.g. a picked content:// URI. */
    AsyncFunction("uriSha256") { uri: String ->
      val context = appContext.reactContext ?: throw Exception("React context is null")
      Fingerprint.ofUri(context, uri)
    }

    /**
     * Transfer history (30 days). The server logs what peers do; JS logs the
     * transfers it starts with `recordTransfer` (a JSON entry, same fields as
     * the desktop's `HistoryEntry`).
     */
    AsyncFunction("recordTransfer") { json: String ->
      val context = appContext.reactContext ?: throw Exception("React context is null")
      TransferHistory.record(context, org.json.JSONObject(json))
    }

    /** JSON array string, newest first. */
    AsyncFunction("getTransferHistory") {
      val context = appContext.reactContext ?: throw Exception("React context is null")
      TransferHistory.list(context)
    }

    AsyncFunction("clearTransferHistory") {
      val context = appContext.reactContext ?: throw Exception("React context is null")
      TransferHistory.clear(context)
    }

    /** The last pairing request not yet shown, if under a minute old; consumed on read. */
    Function("consumePairingRequest") {
      val request = pendingRequest
      pendingRequest = null
      val at = (request?.get("receivedAtMs") as? Double) ?: 0.0
      request?.takeIf { System.currentTimeMillis() - at < 60_000 }
    }

    /** Devices that withdrew their pairing since the last call; consumed on read. */
    Function("consumePairingCancels") {
      synchronized(pendingCancels) {
        val out = pendingCancels.toList()
        pendingCancels.clear()
        out
      }
    }

    /** Inbound presence recorded by the server. Local read, no network. */
    Function("getPresence") {
      PresenceRegistry.snapshot()
    }

    Function("stopServer") {
      server?.stop()
      server = null
      currentConfig = null
    }

    Function("updatePairedDevices") { devices: Array<String> ->
      server?.updatePairedDevices(devices.toList())
    }
  }
}
