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
