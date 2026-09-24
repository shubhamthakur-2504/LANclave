import { Pressable, StyleSheet, Text, View } from "react-native";

import { C } from "@/constants/colors";
import { nextSort, type SortKey, type SortState } from "@/utils/sort-files";

const KEYS: { key: SortKey; label: string }[] = [
  { key: "name", label: "Name" },
  { key: "modified", label: "Date" },
  { key: "size", label: "Size" },
  { key: "type", label: "Type" },
];

/** Sort chips for a file list. Tapping the active chip reverses it. */
export function SortBar({ sort, onChange }: { sort: SortState; onChange: (s: SortState) => void }) {
  return (
    <View style={styles.row} accessibilityRole="toolbar" accessibilityLabel="Sort files by">
      {KEYS.map(({ key, label }) => {
        const active = sort.key === key;
        return (
          <Pressable
            key={key}
            onPress={() => onChange(nextSort(sort, key))}
            style={[styles.chip, active && styles.chipActive]}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            accessibilityLabel={
              active ? `${label}, ${sort.dir === "asc" ? "ascending" : "descending"}` : `Sort by ${label}`
            }
            hitSlop={4}
          >
            <Text style={[styles.text, active && styles.textActive]}>
              {label}
              {active ? (sort.dir === "asc" ? " ↑" : " ↓") : ""}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", gap: 8, paddingHorizontal: 20, paddingVertical: 10 },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: C.border,
    backgroundColor: C.surfaceRaised,
  },
  chipActive: { borderColor: C.action },
  text: { fontSize: 12, fontWeight: "600", color: C.contentMuted },
  textActive: { color: C.action },
});
