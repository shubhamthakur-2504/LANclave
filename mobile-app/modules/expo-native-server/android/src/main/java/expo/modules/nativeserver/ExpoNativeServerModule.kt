package expo.modules.nativeserver

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class ExpoNativeServerModule : Module() {
  private var server: NativeServer? = null

  override fun definition() = ModuleDefinition {
    Name("ExpoNativeServer")

    Function("startServer") { port: Int, deviceId: String, deviceName: String, sandboxPath: String, pairedDevices: Array<String> ->
      try {
        if (server != null) {
          server?.stop()
        }
        val context = appContext.reactContext ?: throw Exception("React context is null")
        server = NativeServer(context, port, deviceId, deviceName, sandboxPath, pairedDevices.toList())
        server?.start(5000, false)
        true
      } catch (e: Exception) {
        throw Exception("Failed to start server: ${e.message}")
      }
    }

    Function("stopServer") {
      server?.stop()
      server = null
    }

    Function("updatePairedDevices") { devices: Array<String> ->
      server?.updatePairedDevices(devices.toList())
    }
  }
}
