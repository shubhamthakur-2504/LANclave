/**
 * Message threads as lists show them: counts per device, never text.
 */

import { useEffect, useState } from "react";
import { Platform } from "react-native";

import ExpoNativeServerModule, {
  type ThreadSummary,
} from "../../modules/expo-native-server/src/ExpoNativeServerModule";

function read(): ThreadSummary[] {
  if (Platform.OS !== "android") return [];
  try {
    return ExpoNativeServerModule.listThreads();
  } catch {
    return []; // older native build
  }
}

/** Every thread's counts, kept current. */
export function useThreadSummaries(): ThreadSummary[] {
  const [threads, setThreads] = useState<ThreadSummary[]>(read);

  useEffect(() => {
    if (Platform.OS !== "android") return;
    let sub: { remove: () => void } | null = null;
    try {
      sub = ExpoNativeServerModule.addListener("onMessagesChanged", () => setThreads(read()));
    } catch {
      // older native build
    }
    return () => sub?.remove();
  }, []);

  return threads;
}

/** Messages not yet read, across every thread. */
export function useUnreadCount(): number {
  return useThreadSummaries().reduce((n, t) => n + t.unread, 0);
}
