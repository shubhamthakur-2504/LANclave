/**
 * Opening and sharing sandbox files with other apps (docs/open-files-plan
 * O1). Other apps can only be given `content://` URIs: a SAF sandbox
 * already has them; the app-private sandbox goes through expo-file-system's
 * FileProvider (`File.contentUri`).
 */

import { File } from "expo-file-system";
import { Alert, Platform } from "react-native";

import ExpoNativeServerModule from "../../modules/expo-native-server/src/ExpoNativeServerModule";
import { getHistory } from "@/services/history";
import type { SandboxFileEntry } from "@/services/storage";

function shareableUri(file: SandboxFileEntry): string {
  return file.uri.startsWith("content://") ? file.uri : new File(file.uri).contentUri;
}

/** Who sent `name`, from the transfer history, if a peer did. */
async function senderOf(name: string): Promise<string | null> {
  const history = await getHistory();
  const entry = history.find((e) => e.direction === "received" && (e.dest_name ?? e.file_name) === name);
  return entry?.peer_name ?? null;
}

function confirm(title: string, message: string, okLabel: string): Promise<boolean> {
  return new Promise((resolve) =>
    Alert.alert(title, message, [
      { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
      { text: okLabel, style: "destructive", onPress: () => resolve(true) },
    ], { cancelable: true, onDismiss: () => resolve(false) }),
  );
}

/**
 * Open with whatever app handles the type ("Open with" if several do).
 * An installer or program a peer sent is not opened without asking.
 */
export async function openSandboxFile(file: SandboxFileEntry): Promise<void> {
  if (Platform.OS !== "android" || file.isDirectory) return;
  try {
    if (ExpoNativeServerModule.isRiskyFile(file.name)) {
      const sender = await senderOf(file.name);
      const who = sender ? `${sender} sent this file.` : "This file came from another device.";
      const ok = await confirm(
        `Open ${file.name}?`,
        `${who} It can install or run apps on this phone. Only open it if you trust it.`,
        "Open anyway",
      );
      if (!ok) return;
    }
    if (!ExpoNativeServerModule.openUri(shareableUri(file), file.name)) {
      const dot = file.name.lastIndexOf(".");
      const ext = dot > 0 ? file.name.slice(dot) : "files like this";
      Alert.alert("Can't open this file", `No app on this phone opens ${ext}. Try sharing it to another app.`);
    }
  } catch (err) {
    Alert.alert("Can't open this file", err instanceof Error ? err.message : String(err));
  }
}

/** Android's share sheet for one sandbox file. */
export function shareSandboxFile(file: SandboxFileEntry): void {
  if (Platform.OS !== "android" || file.isDirectory) return;
  try {
    ExpoNativeServerModule.shareUri(shareableUri(file), file.name);
  } catch (err) {
    Alert.alert("Can't share this file", err instanceof Error ? err.message : String(err));
  }
}
