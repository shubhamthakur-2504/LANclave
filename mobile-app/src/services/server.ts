import ExpoNativeServerModule from "../../modules/expo-native-server/src/ExpoNativeServerModule";
import { getOrCreateDeviceIdentity } from "./identity";
import { getSettings } from "./settings";
import { getPairedPeers } from "./pairing";
import { Platform } from "react-native";

let serverDesiredOn = false; // tracks user intent: should the server be running?
let watchdogTimer: ReturnType<typeof setInterval> | null = null;
const PORT = 8377;

function startWatchdog(): void {
  stopWatchdog();
  watchdogTimer = setInterval(async () => {
    if (!serverDesiredOn) return; 

    try {
      const identity = await getOrCreateDeviceIdentity();
      const settings = await getSettings();
      const peers = await getPairedPeers();
      const pairedDevices = peers.map(p => p.id);
      
      if (Platform.OS === 'android') {
        ExpoNativeServerModule.startServer(PORT, identity.deviceId, settings.displayName, settings.sandboxPath, pairedDevices);
      }
    } catch (err: unknown) {
      console.warn("[watchdog] Restart failed:", err);
    }
  }, 10_000);
}

function stopWatchdog(): void {
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
}

export async function startServer(): Promise<void> {
  serverDesiredOn = true;
  
  if (Platform.OS !== 'android') {
    console.warn("NativeServer is only implemented for Android. Server will not start.");
    return;
  }

  const identity = await getOrCreateDeviceIdentity();
  const settings = await getSettings();
  const peers = await getPairedPeers();
  const pairedDevices = peers.map(p => p.id);

  try {
    ExpoNativeServerModule.startServer(PORT, identity.deviceId, settings.displayName, settings.sandboxPath, pairedDevices);
    console.log(`[server] Native Server started on port ${PORT}`);
  } catch (err: unknown) {
    console.error("[server] Failed to start native server:", err);
  }

  startWatchdog();
}

export function stopServer(): void {
  serverDesiredOn = false;
  stopWatchdog();
  if (Platform.OS === 'android') {
    ExpoNativeServerModule.stopServer();
  }
}

export function isServerRunning(): boolean {
  return serverDesiredOn;
}

export async function updateNativeServerPairedDevices(): Promise<void> {
  if (Platform.OS === 'android' && serverDesiredOn) {
    const peers = await getPairedPeers();
    const pairedDevices = peers.map(p => p.id);
    ExpoNativeServerModule.updatePairedDevices(pairedDevices);
  }
}
