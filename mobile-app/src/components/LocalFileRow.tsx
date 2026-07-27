import { StyleSheet, Text, View } from "react-native";
import { SandboxFileEntry } from "@/services/storage";
import { C, fileIcon, mb } from "@/constants/colors";

export interface LocalFileRowProps {
  file: SandboxFileEntry;
}

export function LocalFileRow({ file }: LocalFileRowProps) {
  return (
    <View style={styles.row}>
      <View style={styles.iconWrap}>
        <Text style={styles.icon}>{fileIcon(file.name)}</Text>
      </View>
      <View style={styles.meta}>
        <Text style={styles.name} numberOfLines={1}>
          {file.name}
        </Text>
        <Text style={styles.sub}>
          {file.isDirectory ? "Folder" : mb(file.size)}
        </Text>
      </View>
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
    backgroundColor: C.surface,
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
  name: { fontSize: 14, fontWeight: "600", color: C.textPrimary },
  sub: { marginTop: 2, fontSize: 11, color: C.textSecond },
});
