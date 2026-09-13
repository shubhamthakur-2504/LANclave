import ExpoModulesCore

public class ExpoNativeServerModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ExpoNativeServer")

    Function("startServer") { (port: Int, deviceId: String, deviceName: String, sandboxPath: String) in
      print("Warning: NativeServer is not implemented for iOS. This is a dummy module.")
      return false
    }

    Function("stopServer") {
      // Do nothing
    }
  }
}
