import { Pressable, StyleSheet, Text, View } from "react-native";
import { SandboxFileEntry } from "@/services/storage";
import { C, mb } from "@/constants/colors";
import { fileKind } from "@/constants/file-kind";
import { FileIcon } from "@/components/FileIcon";

export interface LocalFileRowProps {
  file: SandboxFileEntry;
  /** Tap: open in another app. */
  onPress?: () => void;
  /** Long-press: more actions (share, send to a device). */
  onLongPress?: () => void;
}

export function LocalFileRow({ file, onPress, onLongPress }: LocalFileRowProps) {
  const kind = fileKind(file.name, file.isDirectory);

  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
      onPress={onPress}
      onLongPress={onLongPress}
      disabled={!onPress && !onLongPress}
      accessibilityRole="button"
      accessibilityLabel={`${file.name}. Tap to open, long-press for more.`}
    >
      <View style={styles.iconWrap}>
        <FileIcon name={file.name} isDirectory={file.isDirectory} />
      </View>
      <View style={styles.meta}>
        <Text style={styles.name} numberOfLines={1}>
          {file.name}
        </Text>
        <Text style={styles.sub}>
          {file.isDirectory ? kind.label : `${kind.label} · ${mb(file.size)}`}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: C.border,
    backgroundColor: C.surfaceRaised,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  // The tile draws its own tinted background.
  iconWrap: { marginRight: 12 },
  pressed: { backgroundColor: C.surfaceActive },
  icon: { fontSize: 18 },
  meta: { flex: 1 },
  name: { fontSize: 14, fontWeight: "600", color: C.content },
  sub: { marginTop: 2, fontSize: 11, color: C.contentMuted },
});
