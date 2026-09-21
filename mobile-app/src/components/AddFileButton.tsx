/**
 * AddFileButton — Floating Action Button that opens the system document picker
 * and copies the selected file into the app's sandboxed document directory via
 * `saveToSandbox()`.
 *
 * Props:
 *  - onFileAdded?: () => void   — called after a file is successfully saved,
 *                                  so the parent can trigger a list refresh.
 *  - style?: ViewStyle           — optional override for FAB positioning.
 */

import { useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import * as DocumentPicker from "expo-document-picker";

import { saveToSandbox } from "@/services/storage";
import { C } from "@/constants/colors";

// ─── Local token overrides (error colours not in shared palette) ──────────────
const ERR = {
  bg:     C.dangerBg,
  border: C.dangerBorder,
  text:   C.danger,
} as const;

// ─── Props ────────────────────────────────────────────────────────────────────

export interface AddFileButtonProps {
  /** Called once a file has been successfully copied into the sandbox. */
  onFileAdded?: () => void;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function AddFileButton({ onFileAdded }: AddFileButtonProps) {
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handlePress() {
    if (isBusy) return;

    setError(null);
    setIsBusy(true);

    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: "*/*",               // allow any file type
        copyToCacheDirectory: true, // required so expo-file-system can read it
        multiple: false,
      });

      // User cancelled — do nothing, no error.
      if (result.canceled) return;

      const asset = result.assets[0];
      if (!asset) return;

      const { uri, name } = asset;

      await saveToSandbox(uri, name);
      onFileAdded?.();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "An unexpected error occurred.";
      setError(message);
      console.warn("[AddFileButton] Failed to add file:", err);
    } finally {
      setIsBusy(false);
    }
  }

  return (
    <View style={styles.wrapper} pointerEvents="box-none">
      {/* Inline error toast above the FAB */}
      {error !== null && (
        <View style={styles.errorBubble}>
          <Text style={styles.errorText} numberOfLines={2}>
            {error}
          </Text>
        </View>
      )}

      <Pressable
        style={({ pressed }) => [
          styles.fab,
          pressed && styles.fabPressed,
          isBusy && styles.fabBusy,
        ]}
        onPress={handlePress}
        disabled={isBusy}
        accessibilityLabel="Add file from device"
        accessibilityRole="button"
      >
        {isBusy ? (
          <ActivityIndicator color={C.onAction} size="small" />
        ) : (
          <Text style={styles.fabIcon}>+</Text>
        )}
      </Pressable>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  wrapper: {
    position: "absolute",
    bottom: 28,
    right: 22,
    alignItems: "flex-end",
    gap: 10,
  },

  // Error bubble
  errorBubble: {
    maxWidth: 220,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: ERR.border,
    backgroundColor: ERR.bg,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  errorText: {
    fontSize: 12,
    color: ERR.text,
    lineHeight: 17,
  },

  // FAB
  fab: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: C.action,
    alignItems: "center",
    justifyContent: "center",
    elevation: 8,
  },
  fabPressed: {
    backgroundColor: C.actionPressed,
    transform: [{ scale: 0.95 }],
  },
  fabBusy: {
    opacity: 0.7,
  },
  fabIcon: {
    fontSize: 28,
    color: C.onAction,
    fontWeight: "300",
    lineHeight: 30,
  },
});
