import { useTransfers } from "@/contexts/TransferContext";
import { C } from "@/constants/colors";
import {
  FlatList,
  StatusBar,
  StyleSheet,
  Text,
  View,
  Pressable,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { Transfer } from "@/contexts/TransferContext";
import { Icon } from "@/components/Icon";
import { HistoryView } from "@/components/HistoryView";
import { OffersList } from "@/components/OffersList";
import { useState } from "react";

function formatSize(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(1)} KB`;
  return `${bytes} B`;
}

function formatSpeed(bytesPerSec: number): string {
  if (bytesPerSec === 0) return "—";
  if (bytesPerSec >= 1_000_000) return `${(bytesPerSec / 1_000_000).toFixed(1)} MB/s`;
  if (bytesPerSec >= 1_000) return `${(bytesPerSec / 1_000).toFixed(1)} KB/s`;
  return `${bytesPerSec} B/s`;
}

function calcEta(transfer: Transfer): string {
  if (transfer.status !== "in_progress" || transfer.speed === 0) return "—";
  const remaining = transfer.fileSize - transfer.progress;
  if (remaining <= 0) return "Almost done";
  const seconds = remaining / transfer.speed;
  if (seconds < 60) return `~${Math.round(seconds)}s left`;
  return `~${Math.round(seconds / 60)}m left`;
}

export default function TransfersScreen() {
  const { transfers, cancelTransfer, pauseTransfer, resumeTransfer } = useTransfers();
  // "Activity": this session's live transfers. "History": the 30-day log.
  const [view, setView] = useState<"activity" | "history">("activity");

  return (
    <View style={styles.root}>
      <StatusBar barStyle="light-content" backgroundColor={C.surface} />
      <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.title}>Transfers</Text>
          <Text style={styles.subtitle}>Live transfers and 30 days of history</Text>
        </View>

        <View style={styles.tabs}>
          {(["activity", "history"] as const).map((key) => (
            <Pressable
              key={key}
              onPress={() => setView(key)}
              style={[styles.tab, view === key && styles.tabActive]}
            >
              <Text style={[styles.tabText, view === key && styles.tabTextActive]}>
                {key === "activity" ? "Activity" : "History"}
              </Text>
            </Pressable>
          ))}
        </View>

        {view === "history" ? <HistoryView /> : (
        <FlatList
          data={transfers}
          keyExtractor={(t) => t.id}
          contentContainerStyle={styles.content}
          ListHeaderComponent={<OffersList />}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Icon name="transfers" size={40} color={C.contentFaint} />
              <Text style={styles.emptyTitle}>No active transfers</Text>
              <Text style={styles.emptyHint}>
                Start a download from a peer&apos;s sandbox to see it here.
              </Text>
            </View>
          }
          ItemSeparatorComponent={() => <View style={styles.sep} />}
          renderItem={({ item }) => {
            const pct = item.fileSize > 0 ? Math.round((item.progress / item.fileSize) * 100) : 0;
            const inProgress = item.status === 'in_progress' || item.status === 'verifying';

            return (
              <View style={styles.card}>
                <View style={styles.cardHeader}>
                  <Text style={styles.fileName} numberOfLines={1}>{item.fileName}</Text>
                  <Text style={[
                    styles.statusBadge,
                    item.status === 'completed' && styles.statusCompleted,
                    item.status === 'failed' && styles.statusFailed,
                  ]}>
                    {item.skipped
                      ? 'ALREADY THERE'
                      : item.status === 'verifying'
                        ? 'CHECKING'
                        : item.status === 'pending' && item.native
                          ? 'WAITING'
                          : item.status.replace('_', ' ').toUpperCase()}
                  </Text>
                </View>

                <Text style={styles.peerInfo}>
                  {item.direction === 'download' ? 'Receiving from ' : 'Sending to '}{item.peerName}
                </Text>
                {item.message && item.status !== 'completed' && (
                  <Text style={styles.peerInfo}>{item.message}</Text>
                )}

                {inProgress && (
                  <View style={styles.progressSection}>
                    <View style={styles.progressRow}>
                      <Text style={styles.progressText}>
                        {formatSize(item.progress)} / {formatSize(item.fileSize)} ({pct}%)
                      </Text>
                      <Text style={styles.speedText}>{calcEta(item)}</Text>
                    </View>
                    <View style={styles.progressBarBg}>
                      <View style={[styles.progressBarFill, { width: `${pct}%` }]} />
                    </View>
                    <View style={styles.progressRow}>
                      <Text style={styles.speedText}>{formatSpeed(item.speed)}</Text>
                    </View>
                  </View>
                )}

                {(item.status === 'failed' || item.status === 'paused') && (
                  <View style={styles.progressSection}>
                    <Text style={styles.progressText}>
                      Stopped at {formatSize(item.progress)} / {formatSize(item.fileSize)}
                    </Text>
                  </View>
                )}

                {(inProgress || item.status === 'pending') && (
                  <View style={[styles.actions, styles.actionRow]}>
                    {item.native && (item.status === 'in_progress' || item.status === 'pending') && (
                      <Pressable style={styles.pauseBtn} onPress={() => pauseTransfer(item.id)}>
                        <Text style={styles.pauseText}>Pause</Text>
                      </Pressable>
                    )}
                    <Pressable
                      style={styles.cancelBtn}
                      onPress={() => cancelTransfer(item.id)}
                    >
                      <Text style={styles.cancelText}>Cancel</Text>
                    </Pressable>
                  </View>
                )}

                {item.native && (item.status === 'paused' || item.status === 'failed') && (
                  <View style={[styles.actions, styles.actionRow]}>
                    <Pressable style={styles.pauseBtn} onPress={() => resumeTransfer(item.id)}>
                      <Text style={styles.pauseText}>{item.status === 'paused' ? 'Resume' : 'Retry'}</Text>
                    </Pressable>
                    {item.status === 'paused' && (
                      <Pressable style={styles.cancelBtn} onPress={() => cancelTransfer(item.id)}>
                        <Text style={styles.cancelText}>Discard</Text>
                      </Pressable>
                    )}
                  </View>
                )}
              </View>
            );
          }}
        />
        )}
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.surface },
  safe: { flex: 1 },

  // Header
  header: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 14 },
  title: {
    fontSize: 26,
    fontWeight: "700",
    color: C.action,
    letterSpacing: -0.5,
  },
  subtitle: { marginTop: 4, fontSize: 13, color: C.contentMuted },

  tabs: {
    flexDirection: "row",
    marginHorizontal: 20,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  tab: {
    paddingHorizontal: 12,
    paddingBottom: 10,
    marginBottom: -1,
    borderBottomWidth: 2,
    borderBottomColor: "transparent",
  },
  tabActive: { borderBottomColor: C.action },
  tabText: { fontSize: 14, fontWeight: "600", color: C.contentMuted },
  tabTextActive: { color: C.action },

  divider: {
    height: 1,
    backgroundColor: C.border,
    marginHorizontal: 20,
    marginBottom: 4,
  },

  content: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 40 },

  card: {
    backgroundColor: C.surfaceRaised,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 16,
    padding: 16,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
  },
  fileName: {
    flex: 1,
    fontSize: 15,
    fontWeight: '600',
    color: C.content,
  },
  statusBadge: {
    fontSize: 10,
    fontWeight: '700',
    color: C.action,
    backgroundColor: C.borderStrong,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
  },
  statusCompleted: {
    color: C.ok,
    backgroundColor: C.okBg,
  },
  statusFailed: {
    color: C.danger,
    backgroundColor: C.dangerBg,
  },
  peerInfo: {
    fontSize: 12,
    color: C.contentMuted,
    marginTop: 4,
  },

  progressSection: {
    marginTop: 12,
  },
  progressRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 6,
    marginTop: 4,
  },
  progressText: {
    fontSize: 12,
    color: C.content,
  },
  speedText: {
    fontSize: 12,
    color: C.contentFaint,
  },
  progressBarBg: {
    height: 6,
    backgroundColor: C.borderStrong,
    borderRadius: 3,
    overflow: 'hidden',
  },
  progressBarFill: {
    height: '100%',
    backgroundColor: C.action,
    borderRadius: 3,
  },

  actions: {
    marginTop: 16,
    borderTopWidth: 1,
    borderTopColor: C.border,
    paddingTop: 12,
    alignItems: 'flex-end',
  },
  actionRow: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10 },
  pauseBtn: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: C.borderStrong,
  },
  pauseText: { fontSize: 13, fontWeight: '600', color: C.content },
  cancelBtn: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: C.dangerBg,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: C.dangerBorder,
  },
  cancelText: {
    fontSize: 13,
    fontWeight: '600',
    color: C.danger,
  },

  sep: { height: 12 },

  empty: {
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: C.border,
    backgroundColor: C.surfaceRaised,
    paddingVertical: 36,
    paddingHorizontal: 20,
    marginTop: 20,
  },
  emptyIcon: { fontSize: 32, marginBottom: 12 },
  emptyTitle: {
    fontSize: 15,
    fontWeight: "600",
    color: C.content,
    marginBottom: 6,
  },
  emptyHint: {
    fontSize: 12,
    color: C.contentMuted,
    textAlign: "center",
    lineHeight: 18,
  },
});
