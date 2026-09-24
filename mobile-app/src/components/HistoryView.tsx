import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import { useFocusEffect } from "expo-router";

import { C } from "@/constants/colors";
import {
  clearHistory,
  computeStats,
  getHistory,
  subscribeHistory,
  type HistoryEntry,
} from "@/services/history";

type Range = 7 | 30;
const DAY_MS = 24 * 60 * 60 * 1000;

function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(1)} KB`;
  return `${bytes} B`;
}

function formatWhen(ms: number): string {
  const d = new Date(ms);
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString()
    ? time
    : `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${time}`;
}

/** Who started it matters as much as which way it went. */
function describe(e: HistoryEntry): string {
  const peer = e.peer_name ?? "Unknown device";
  if (e.initiated_by === "me") {
    return e.direction === "sent" ? `You sent to ${peer}` : `You pulled from ${peer}`;
  }
  return e.direction === "sent" ? `${peer} pulled from you` : `${peer} sent to you`;
}

const OUTCOME_LABEL: Record<HistoryEntry["outcome"], string> = {
  completed: "DONE",
  skipped: "ALREADY THERE",
  failed: "FAILED",
  cancelled: "CANCELLED",
};

function StatTile({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <View style={styles.tile}>
      <Text style={styles.tileLabel}>{label}</Text>
      <Text style={styles.tileValue}>{value}</Text>
      <Text style={styles.tileDetail}>{detail}</Text>
    </View>
  );
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * 30-day transfer history and analytics: what this phone sent and pulled,
 * and what peers sent to or pulled from it.
 */
export function HistoryView() {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [range, setRange] = useState<Range>(30);
  // "Now" as of the last load; reading the clock during render is impure.
  const [loadedAt, setLoadedAt] = useState(0);

  const load = useCallback(async () => {
    setEntries(await getHistory());
    setLoadedAt(Date.now());
  }, []);

  // Peer-started transfers are logged natively with no event, so re-read
  // whenever the screen comes into view.
  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );
  useEffect(() => subscribeHistory(load), [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const since = loadedAt - range * DAY_MS;
  const visible = useMemo(() => entries.filter((e) => e.at_ms >= since), [entries, since]);
  const stats = useMemo(() => computeStats(visible), [visible]);
  const maxPeerBytes = stats.byPeer[0]?.bytes ?? 0;

  const confirmClear = () =>
    Alert.alert("Clear history?", "This removes the transfer log on this phone.", [
      { text: "Cancel", style: "cancel" },
      { text: "Clear", style: "destructive", onPress: () => clearHistory() },
    ]);

  const header = (
    <View>
      <View style={styles.rangeRow}>
        {([7, 30] as Range[]).map((r) => (
          <Pressable key={r} onPress={() => setRange(r)} hitSlop={8}>
            <Text style={[styles.rangeText, range === r && styles.rangeActive]}>Last {r} days</Text>
          </Pressable>
        ))}
        <View style={{ flex: 1 }} />
        {entries.length > 0 && (
          <Pressable onPress={confirmClear} hitSlop={8}>
            <Text style={styles.clearText}>Clear</Text>
          </Pressable>
        )}
      </View>

      {visible.length > 0 && (
        <>
          <View style={styles.tiles}>
            <StatTile label="Sent" value={formatBytes(stats.sentBytes)} detail={plural(stats.sentFiles, "file")} />
            <StatTile
              label="Received"
              value={formatBytes(stats.receivedBytes)}
              detail={plural(stats.receivedFiles, "file")}
            />
            <StatTile
              label="Already there"
              value={formatBytes(stats.skippedBytes)}
              detail={`${plural(stats.skippedFiles, "file")} not re-sent`}
            />
            <StatTile label="Failed" value={String(stats.failed)} detail={plural(stats.failed, "transfer")} />
          </View>

          {stats.byPeer.length > 0 && (
            <View style={styles.card}>
              <Text style={styles.sectionTitle}>Data moved by device</Text>
              {stats.byPeer.map((p) => (
                <View key={p.peerId} style={styles.peerRow}>
                  <Text style={styles.peerName} numberOfLines={1}>
                    {p.peerName}
                  </Text>
                  <View style={styles.barTrack}>
                    <View
                      style={[
                        styles.barFill,
                        { width: `${maxPeerBytes > 0 ? Math.max(2, (p.bytes / maxPeerBytes) * 100) : 0}%` },
                      ]}
                    />
                  </View>
                  <Text style={styles.peerValue}>
                    {formatBytes(p.bytes)} · {p.files}
                  </Text>
                </View>
              ))}
            </View>
          )}

          <Text style={styles.sectionTitle}>Activity log</Text>
        </>
      )}
    </View>
  );

  return (
    <FlatList
      data={visible}
      keyExtractor={(e) => e.id}
      contentContainerStyle={styles.content}
      ListHeaderComponent={header}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={C.contentMuted} />}
      ListEmptyComponent={
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>No transfers in the last {range} days</Text>
          <Text style={styles.emptyHint}>
            Files you send or pull, and files peers send or pull from you, show up here.
          </Text>
        </View>
      }
      ItemSeparatorComponent={() => <View style={styles.sep} />}
      renderItem={({ item }) => (
        <View style={styles.row}>
          <Text style={[styles.arrow, item.direction === "sent" ? styles.arrowSent : styles.arrowReceived]}>
            {item.direction === "sent" ? "↑" : "↓"}
          </Text>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={styles.fileName} numberOfLines={1}>
              {item.file_name}
              {item.dest_name ? <Text style={styles.faint}> → {item.dest_name}</Text> : null}
            </Text>
            <Text style={styles.faint} numberOfLines={1}>
              {describe(item)} · {formatWhen(item.at_ms)}
            </Text>
          </View>
          <View style={{ alignItems: "flex-end" }}>
            <Text style={styles.bytes}>{formatBytes(item.bytes)}</Text>
            <Text
              style={[
                styles.outcome,
                item.outcome === "completed" && { color: C.ok },
                item.outcome === "failed" && { color: C.danger },
              ]}
            >
              {OUTCOME_LABEL[item.outcome]}
            </Text>
          </View>
        </View>
      )}
    />
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 40 },

  rangeRow: { flexDirection: "row", alignItems: "center", gap: 16, marginBottom: 14 },
  rangeText: { fontSize: 13, fontWeight: "600", color: C.contentFaint },
  rangeActive: { color: C.action },
  clearText: { fontSize: 13, fontWeight: "600", color: C.danger },

  tiles: { flexDirection: "row", flexWrap: "wrap", gap: 10, marginBottom: 14 },
  tile: {
    flexBasis: "47%",
    flexGrow: 1,
    backgroundColor: C.surfaceRaised,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 14,
    padding: 12,
  },
  tileLabel: { fontSize: 12, color: C.contentMuted },
  tileValue: { fontSize: 20, fontWeight: "700", color: C.content, marginTop: 4 },
  tileDetail: { fontSize: 12, color: C.contentFaint },

  card: {
    backgroundColor: C.surfaceRaised,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 14,
    padding: 14,
    marginBottom: 16,
    gap: 10,
  },
  sectionTitle: { fontSize: 12, fontWeight: "700", color: C.contentMuted, marginBottom: 8 },
  peerRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  peerName: { width: 90, fontSize: 12, color: C.content },
  barTrack: { flex: 1, height: 8, borderRadius: 4, backgroundColor: C.surfaceInset },
  barFill: { height: 8, borderRadius: 4, backgroundColor: C.contentMuted },
  peerValue: { fontSize: 12, color: C.contentMuted, fontVariant: ["tabular-nums"] },

  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: C.surfaceRaised,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  arrow: { fontSize: 16, fontWeight: "700", width: 16, textAlign: "center" },
  arrowSent: { color: C.action },
  arrowReceived: { color: C.ok },
  fileName: { fontSize: 14, fontWeight: "600", color: C.content },
  faint: { fontSize: 12, color: C.contentFaint, fontWeight: "400" },
  bytes: { fontSize: 12, color: C.contentMuted, fontVariant: ["tabular-nums"] },
  outcome: { fontSize: 10, fontWeight: "700", color: C.contentMuted, marginTop: 2 },
  sep: { height: 8 },

  empty: {
    alignItems: "center",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: C.border,
    backgroundColor: C.surfaceRaised,
    paddingVertical: 32,
    paddingHorizontal: 20,
  },
  emptyTitle: { fontSize: 15, fontWeight: "600", color: C.content },
  emptyHint: { fontSize: 13, color: C.contentMuted, textAlign: "center", marginTop: 6 },
});
