import { StyleSheet, Text, View } from "react-native";
import { SandboxFileEntry } from "@/services/storage";
import { C, mb } from "@/constants/colors";
import { fileKind } from "@/constants/file-kind";
import { Icon } from "@/components/Icon";

export interface LocalFileRowProps {
  file: SandboxFileEntry;
}

export function LocalFileRow({ file }: LocalFileRowProps) {
  const kind = fileKind(file.name, file.isDirectory);

  return (
    <View style={styles.row}>
      <View style={styles.iconWrap}>
        <Icon name={kind.icon} size={20} color={C[kind.tone]} />
      </View>
      <View style={styles.meta}>
        <Text style={styles.name} numberOfLines={1}>
          {file.name}
        </Text>
        <Text style={styles.sub}>
          {file.isDirectory ? kind.label : `${kind.label} · ${mb(file.size)}`}
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
});
