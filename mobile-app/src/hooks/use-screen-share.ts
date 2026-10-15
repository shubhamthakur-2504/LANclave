/**
 * Showing this phone's screen on a paired laptop: the current state, and
 * an alert when it ends badly. The work itself is native (`Mirror.kt`).
 */

import { useEffect, useState } from "react";
import { Alert, Platform } from "react-native";

import ExpoNativeServerModule from "../../modules/expo-native-server/src/ExpoNativeServerModule";

export interface ScreenShare {
  /** idle, asking, connecting, sharing. */
  state: string;
  /** Who it is being shown to, while not idle. */
  peerId: string | null;
  peerName: string | null;
}

function current(): ScreenShare {
  if (Platform.OS !== "android") return { state: "idle", peerId: null, peerName: null };
  try {
    return { state: ExpoNativeServerModule.screenShareState(), peerId: null, peerName: null };
  } catch {
    return { state: "idle", peerId: null, peerName: null };
  }
}

export function useScreenShare(): ScreenShare {
  const [share, setShare] = useState<ScreenShare>(current);

  useEffect(() => {
    if (Platform.OS !== "android") return;
    let sub: { remove: () => void } | null = null;
    try {
      sub = ExpoNativeServerModule.addListener("onMirrorState", (event) => {
        const done = ["declined", "failed", "ended"].includes(event.state);
        setShare({
          state: done ? "idle" : event.state,
          peerId: done ? null : event.peerId,
          peerName: done ? null : event.peerName,
        });
        if (event.state === "declined" || event.state === "failed") {
          Alert.alert(event.state === "declined" ? "Not shown" : "Couldn't share the screen", event.message ?? "");
        }
      });
    } catch {
      // older native build
    }
    return () => sub?.remove();
  }, []);

  return share;
}

/** Ask Android, then the laptop. Nothing happens if the user says no to Android. */
export async function shareScreenWith(peer: { id: string; name: string; ip: string; port: number }): Promise<void> {
  try {
    await ExpoNativeServerModule.shareScreen(peer.id, `${peer.ip}:${peer.port}`, peer.name);
  } catch (err) {
    Alert.alert("Couldn't share the screen", err instanceof Error ? err.message : String(err));
  }
}

export function stopScreenShare(): void {
  try {
    ExpoNativeServerModule.stopScreenShare();
  } catch {
    // older native build
  }
}
