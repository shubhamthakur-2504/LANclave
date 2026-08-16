import { useTransfers } from "@/contexts/TransferContext";
import { C } from "@/constants/colors";
import {
  FlatList,
  SafeAreaView,
  StatusBar,
  StyleSheet,
  Text,
  View,
  Pressable,
} from "react-native";
import type { Transfer } from "@/contexts/TransferContext";

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
  const { transfers, cancelTransfer } = useTransfers();

  return (
    <View style={styles.root}>
      <StatusBar barStyle="light-content" backgroundColor={C.bg} />
      <SafeAreaView style={styles.safe}>
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.title}>Transfers</Text>
          <Text style={styles.subtitle}>Track active downloads from paired peers</Text>
        </View>

        <View style={styles.divider} />

        <FlatList
          data={transfers}
          keyExtractor={(t) => t.id}
          contentContainerStyle={styles.content}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.emptyIcon}>🔄</Text>
              <Text style={styles.emptyTitle}>No active transfers</Text>
              <Text style={styles.emptyHint}>
                Start a download from a peer's sandbox to see it here.
              </Text>
            </View>
          }
          ItemSeparatorComponent={() => <View style={styles.sep} />}
          renderItem={({ item }) => {
            const pct = item.fileSize > 0 ? Math.round((item.progress / item.fileSize) * 100) : 0;
            const inProgress = item.status === 'in_progress';
            
            return (
              <View style={styles.card}>
                <View style={styles.cardHeader}>
                  <Text style={styles.fileName} numberOfLines={1}>{item.fileName}</Text>
                  <Text style={[
                    styles.statusBadge, 
                    item.status === 'completed' && styles.statusCompleted,
                    item.status === 'failed' && styles.statusFailed,
                  ]}>
                    {item.status.replace('_', ' ').toUpperCase()}
                  </Text>
                </View>

                <Text style={styles.peerInfo}>
                  {item.direction === 'download' ? 'Receiving from ' : 'Sending to '}{item.peerName}
                </Text>

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

                {item.status === 'failed' && (
                  <View style={styles.progressSection}>
                    <Text style={styles.progressText}>
                      Stopped at {formatSize(item.progress)} / {formatSize(item.fileSize)}
                    </Text>
                  </View>
                )}

                {inProgress && (
                  <View style={styles.actions}>
                    <Pressable 
                      style={styles.cancelBtn} 
                      onPress={() => cancelTransfer(item.id)}
                    >
                      <Text style={styles.cancelText}>Cancel</Text>
                    </Pressable>
                  </View>
                )}
              </View>
            );
          }}
        />
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  safe: { flex: 1 },

  // Header
  header: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 14 },
  title: {
    fontSize: 26,
    fontWeight: "700",
    color: C.accent,
    letterSpacing: -0.5,
  },
  subtitle: { marginTop: 4, fontSize: 13, color: C.textSecond },

  divider: {
    height: 1,
    backgroundColor: C.border,
    marginHorizontal: 20,
    marginBottom: 4,
  },

  content: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 40 },

  card: {
    backgroundColor: C.surface,
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
    color: C.textPrimary,
  },
  statusBadge: {
    fontSize: 10,
    fontWeight: '700',
    color: C.accent,
    backgroundColor: C.borderStrong,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
  },
  statusCompleted: {
    color: C.online,
    backgroundColor: C.onlineBg,
  },
  statusFailed: {
    color: C.errorText,
    backgroundColor: C.errorBg,
  },
  peerInfo: {
    fontSize: 12,
    color: C.textSecond,
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
    color: C.textPrimary,
  },
  speedText: {
    fontSize: 12,
    color: C.textMuted,
  },
  progressBarBg: {
    height: 6,
    backgroundColor: C.borderStrong,
    borderRadius: 3,
    overflow: 'hidden',
  },
  progressBarFill: {
    height: '100%',
    backgroundColor: C.accent,
    borderRadius: 3,
  },
  
  actions: {
    marginTop: 16,
    borderTopWidth: 1,
    borderTopColor: C.border,
    paddingTop: 12,
    alignItems: 'flex-end',
  },
  cancelBtn: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: C.errorBg,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: C.errorBorder,
  },
  cancelText: {
    fontSize: 13,
    fontWeight: '600',
    color: C.errorText,
  },

  sep: { height: 12 },

  empty: {
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: C.border,
    backgroundColor: C.surface,
    paddingVertical: 36,
    paddingHorizontal: 20,
    marginTop: 20,
  },
  emptyIcon: { fontSize: 32, marginBottom: 12 },
  emptyTitle: {
    fontSize: 15,
    fontWeight: "600",
    color: C.textPrimary,
    marginBottom: 6,
  },
  emptyHint: {
    fontSize: 12,
    color: C.textSecond,
    textAlign: "center",
    lineHeight: 18,
  },
});
