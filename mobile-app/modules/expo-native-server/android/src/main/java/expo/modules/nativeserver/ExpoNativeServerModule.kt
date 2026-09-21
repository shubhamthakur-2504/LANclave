package expo.modules.nativeserver

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class ExpoNativeServerModule : Module() {
  private var server: NativeServer? = null

  /** Identity of the running server, so a redundant start can be detected. */
  private var currentConfig: String? = null

  override fun definition() = ModuleDefinition {
    Name("ExpoNativeServer")

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
        val next = NativeServer(context, port, deviceId, deviceName, sandboxPath, pairedDevices.toList())
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
          val uri = if (android.os.Build.VERSION.SDK_INT >= 33) {
            intent.getParcelableExtra(
              android.content.Intent.EXTRA_STREAM,
              android.net.Uri::class.java,
            )
          } else {
            @Suppress("DEPRECATION")
            intent.getParcelableExtra<android.net.Uri>(android.content.Intent.EXTRA_STREAM)
          }
          listOfNotNull(uri)
        }
        else -> {
          val list = if (android.os.Build.VERSION.SDK_INT >= 33) {
            intent.getParcelableArrayListExtra(
              android.content.Intent.EXTRA_STREAM,
              android.net.Uri::class.java,
            )
          } else {
            @Suppress("DEPRECATION")
            intent.getParcelableArrayListExtra<android.net.Uri>(
              android.content.Intent.EXTRA_STREAM,
            )
          }
          list ?: emptyList()
        }
      }

      // Consume it: a share should be handled once, not on every resume.
      intent.action = android.content.Intent.ACTION_MAIN
      intent.removeExtra(android.content.Intent.EXTRA_STREAM)

      uris.map { it.toString() }
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
