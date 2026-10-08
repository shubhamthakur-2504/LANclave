import ExpoNativeServerModule from "../../modules/expo-native-server/src/ExpoNativeServerModule";
import { getOrCreateDeviceIdentity } from "./identity";
import { getSettings } from "./settings";
import { getPairedPeers } from "./pairing";
import { PermissionsAndroid, Platform } from "react-native";
import Zeroconf from "react-native-zeroconf";
import { startPresence, stopPresence } from "./presence";

let serverDesiredOn = false; // tracks user intent: should the server be running?
let watchdogTimer: ReturnType<typeof setInterval> | null = null;
const PORT = 8377;

// ─── mDNS advertisement ──────────────────────────────────────────────────────
//
// Same service, TXT fields and naming as the desktop (discovery.rs), so
// desktops and other phones find this phone on their own instead of only
// after a manual subnet sweep.

let publisher: Zeroconf | null = null;
let publishedName: string | null = null;
/** The display name in the published record, to notice a rename. */
let publishedDeviceName: string | null = null;

/** DNS-label-safe tag from the device id; matches the desktop's `mdns_tag`. */
function mdnsTag(deviceId: string): string {
  return deviceId.replace(/[^A-Za-z0-9]/g, "").slice(0, 12).toLowerCase();
}

/** How long Android is given to withdraw a record before it is published again. */
const REPUBLISH_DELAY_MS = 1000;
let republishTimer: ReturnType<typeof setTimeout> | null = null;

function advertise(deviceId: string, deviceName: string): void {
  if (publishedName && publishedDeviceName === deviceName) return;
  if (publishedName) {
    // Renamed. The record carries the name, so it has to be published
    // afresh, and under the same service name: wait for the old one to go,
    // or Android registers the new one as "LANclave-… (2)".
    stopAdvertising();
    republishTimer = setTimeout(() => {
      republishTimer = null;
      if (serverDesiredOn) publish(deviceId, deviceName);
    }, REPUBLISH_DELAY_MS);
    return;
  }
  publish(deviceId, deviceName);
}

function publish(deviceId: string, deviceName: string): void {
  try {
    publisher = publisher ?? new Zeroconf();
    const name = `LANclave-${mdnsTag(deviceId)}`;
    publisher.publishService("lanclave-portal", "tcp", "local.", name, PORT, {
      version: "1.0.0",
      node_type: "mobile",
      device_type: "phone",
      device_id: deviceId,
      device_name: deviceName,
    });
    publishedName = name;
    publishedDeviceName = deviceName;
  } catch (err) {
    // Discovery falls back to the manual sweep; nothing else depends on this.
    console.warn("[server] mDNS advertise failed:", err);
  }
}

function stopAdvertising(): void {
  if (republishTimer) {
    clearTimeout(republishTimer);
    republishTimer = null;
  }
  if (!publisher || !publishedName) return;
  try {
    publisher.unpublishService(publishedName);
  } catch {
    // best effort
  }
  publishedName = null;
  publishedDeviceName = null;
}

function startWatchdog(): void {
  stopWatchdog();
  watchdogTimer = setInterval(async () => {
    if (!serverDesiredOn) return;
    if (Platform.OS !== 'android') return;

    try {
      // Only act when the server has actually died. Previously this called
      // startServer() unconditionally every 10s, and startServer rebuilt the
      // server every time, so the listening socket was rebound every 10
      // seconds for the lifetime of the app.
      if (ExpoNativeServerModule.isRunning()) return;

      console.warn("[watchdog] Server not running - restarting");

      const identity = await getOrCreateDeviceIdentity();
      const settings = await getSettings();
      const peers = await getPairedPeers();
      const pairedDevices = peers.map(p => p.id);

      ExpoNativeServerModule.setIdentity(identity.deviceId, identity.privateKey);
      ExpoNativeServerModule.startServer(PORT, identity.deviceId, settings.displayName, settings.sandboxPath, pairedDevices);
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
    // Native transfers sign their own requests (so a late resume is never
    // refused for a stale signature); the key stays in memory there.
    ExpoNativeServerModule.setIdentity(identity.deviceId, identity.privateKey);
    ExpoNativeServerModule.startServer(PORT, identity.deviceId, settings.displayName, settings.sandboxPath, pairedDevices);
    console.log(`[server] Native Server started on port ${PORT}`);
  } catch (err: unknown) {
    console.error("[server] Failed to start native server:", err);
  }

  startWatchdog();
  // The transfer notification needs this on Android 13+. Asked once; a
  // refusal only hides the notification, transfers still run.
  PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS).catch(() => {});
  // Announce to paired peers and start the per-peer heartbeat.
  startPresence();
  advertise(identity.deviceId, settings.displayName);
}

export function stopServer(): void {
  serverDesiredOn = false;
  stopWatchdog();
  // Best-effort bye so peers show us offline immediately.
  stopPresence().catch(() => {});
  stopAdvertising();
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
