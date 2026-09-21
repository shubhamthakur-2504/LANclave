import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { C, fileIcon, mb } from "@/constants/colors";

export interface RemoteFileRowProps {
  name: string;
  size: number;
  is_directory: boolean;
  /** 0–100 while downloading; undefined when idle. */
  progress?: number;
  onDownload: (name: string) => void;
}

export function RemoteFileRow({
  name,
  size,
  is_directory,
  progress,
  onDownload,
}: RemoteFileRowProps) {
  const isDownloading = progress !== undefined;

  return (
    <View style={styles.row}>
      {/* Icon */}
      <View style={styles.iconWrap}>
        <Text style={styles.icon}>{fileIcon(name)}</Text>
      </View>

      {/* Name + size / progress bar */}
      <View style={styles.meta}>
        <Text style={styles.name} numberOfLines={1}>
          {name}
        </Text>
        {isDownloading ? (
          <View style={styles.progressTrack}>
            <View
              style={[
                styles.progressFill,
                // cast needed — RN StyleSheet doesn't accept template strings
                { width: `${progress}%` as any },
              ]}
            />
          </View>
        ) : (
          <Text style={styles.sub}>
            {is_directory ? "Folder" : mb(size)}
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
    </View>
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
  iconWrap: {
    width: 40,
    height: 40,
    borderRadius: 10,
    backgroundColor: C.borderStrong,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 12,
  },
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
