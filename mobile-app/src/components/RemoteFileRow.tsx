import { useEffect } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { C, mb } from "@/constants/colors";
import { fileKind } from "@/constants/file-kind";
import { FileIcon } from "@/components/FileIcon";

export interface RemoteFileRowProps {
  name: string;
  size: number;
  is_directory: boolean;
  /** 0–100 while downloading; undefined when idle. */
  progress?: number;
  onDownload: (name: string) => void;
  /** Go into this folder. Without it, folders are inert. */
  onOpenFolder?: (name: string) => void;
}

export function RemoteFileRow({
  name,
  size,
  is_directory,
  progress,
  onDownload,
  onOpenFolder,
}: RemoteFileRowProps) {
  const isDownloading = progress !== undefined;
  const kind = fileKind(name, is_directory);

  // Progress arrives in ~100ms steps; easing between them reads as motion
  // rather than a bar that snaps (U3.3).
  const width = useSharedValue(0);
  useEffect(() => {
    width.value = withTiming(progress ?? 0, { duration: 220 });
  }, [progress, width]);
  const progressStyle = useAnimatedStyle(() => ({
    width: `${width.value}%`,
  }));

  const opensFolder = is_directory && !!onOpenFolder;
  return (
    <Pressable
      style={({ pressed }) => [styles.row, opensFolder && pressed && styles.rowPressed]}
      onPress={opensFolder ? () => onOpenFolder(name) : undefined}
      disabled={!opensFolder}
      accessibilityRole={opensFolder ? "button" : undefined}
      accessibilityLabel={opensFolder ? `Open folder ${name}` : undefined}
    >
      <View style={styles.iconWrap}>
        <FileIcon name={name} isDirectory={is_directory} />
      </View>

      {/* Name + size / progress bar */}
      <View style={styles.meta}>
        <Text style={styles.name} numberOfLines={1}>
          {name}
        </Text>
        {isDownloading ? (
          <View style={styles.progressTrack}>
            <Animated.View style={[styles.progressFill, progressStyle]} />
          </View>
        ) : (
          <Text style={styles.sub}>
            {is_directory ? kind.label : `${kind.label} · ${mb(size)}`}
          </Text>
        )}
      </View>

      {/* Download button (files only) */}
      {!is_directory && (
        <Pressable
          style={({ pressed }) => [
            styles.dlBtn,
            pressed && styles.dlBtnPressed,
            isDownloading && styles.dlBtnBusy,
          ]}
          onPress={() => !isDownloading && onDownload(name)}
          disabled={isDownloading}
          accessibilityLabel={`Download ${name}`}
        >
          {isDownloading ? (
            <ActivityIndicator size="small" color={C.action} />
          ) : (
            <Text style={styles.dlBtnText}>↓</Text>
          )}
        </Pressable>
      )}
      {opensFolder && <Text style={styles.chevron}>›</Text>}
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
  rowPressed: { opacity: 0.75 },
  chevron: { fontSize: 22, color: C.contentFaint, marginLeft: 8 },
  // The tile draws its own tinted background.
  iconWrap: { marginRight: 12 },
  icon: { fontSize: 18 },
  meta: { flex: 1 },
  name: { fontSize: 14, fontWeight: "600", color: C.content },
  sub: { marginTop: 2, fontSize: 11, color: C.contentMuted },

  // Progress bar
  progressTrack: {
    marginTop: 6,
    height: 4,
    borderRadius: 2,
    backgroundColor: C.surfaceInset,
    overflow: "hidden",
  },
  progressFill: {
    height: 4,
    borderRadius: 2,
    backgroundColor: C.action,
  },

  // Download button
  dlBtn: {
    marginLeft: 8,
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "#0C2040",
    borderWidth: 1,
    borderColor: C.borderStrong,
    alignItems: "center",
    justifyContent: "center",
  },
  dlBtnPressed: { backgroundColor: "#0EA5E920" },
  dlBtnBusy: { borderColor: C.action },
  dlBtnText: { fontSize: 16, color: C.action, fontWeight: "600" },
});
