/**
 * Offers on the Transfers tab: incoming ones still to answer, and offers
 * this phone sent. Files being received show as ordinary transfer rows.
 */

import { Alert, Pressable, StyleSheet, Text, View } from "react-native";

import { C } from "@/constants/colors";
import { useOffers, type OutgoingOffer } from "@/contexts/OffersContext";

function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(1)} KB`;
  return `${bytes} B`;
}

function summary(o: OutgoingOffer, served: Record<string, number>): string {
  const who = o.peer_name || "the other device";
  switch (o.state) {
    case "waiting":
      return `Waiting for ${who} to accept`;
    case "declined":
      return `${who} declined`;
    case "expired":
      return `${who} didn't answer in time`;
    case "cancelled":
      return "You cancelled this";
    case "done": {
      const r = Object.values(o.results);
      const ok = r.filter((x) => x.outcome === "completed" || x.outcome === "skipped").length;
      return ok === r.length ? `Delivered to ${who}` : `${ok} of ${r.length} delivered`;
    }
    case "accepted": {
      if (o.paused) return "Paused by you";
      const total = o.files.filter((f) => o.accepted.includes(f.id)).reduce((n, f) => n + f.size, 0);
      const sent = o.accepted.reduce((n, id) => n + (served[id] ?? o.served[id] ?? 0), 0);
      return `${who} is receiving · ${formatBytes(sent)} of ${formatBytes(total)}`;
    }
  }
}

export function OffersList() {
  const { pendingIncoming, outgoing, served, openPrompt, decline, cancelOutgoing, setOutgoingPaused } = useOffers();
  const recent = outgoing.slice(0, 20);
  if (pendingIncoming.length === 0 && recent.length === 0) return null;

  const safely = (action: () => Promise<void> | void) => async () => {
    try {
      await action();
    } catch (err) {
      Alert.alert("Couldn't do that", err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <View style={styles.wrap}>
      {pendingIncoming.length > 0 && (
        <>
          <Text style={[styles.heading, { color: C.action }]}>INCOMING · {pendingIncoming.length}</Text>
          {pendingIncoming.map((o) => (
            <View key={o.id} style={[styles.card, styles.incoming]}>
              <View style={{ flex: 1 }}>
                <Text style={styles.title} numberOfLines={1}>
                  {o.peer_name || "A paired device"} · {o.files.length} file{o.files.length === 1 ? "" : "s"}
                </Text>
                <Text style={styles.sub}>{formatBytes(o.files.reduce((n, f) => n + f.size, 0))}</Text>
              </View>
              <Pressable onPress={safely(() => decline(o.id))} style={styles.ghost} hitSlop={6}>
                <Text style={styles.ghostText}>Decline</Text>
              </Pressable>
              <Pressable onPress={() => openPrompt(o.id)} style={styles.primary} hitSlop={6}>
                <Text style={styles.primaryText}>Review</Text>
              </Pressable>
            </View>
          ))}
        </>
      )}

      {recent.length > 0 && (
        <>
          <Text style={styles.heading}>SENT</Text>
          {recent.map((o) => {
            const live = o.state === "waiting" || o.state === "accepted";
            return (
              <View key={o.id} style={styles.card}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.title} numberOfLines={1}>
                    {o.files.length === 1 ? o.files[0].name : `${o.files.length} files`}
                  </Text>
                  <Text style={styles.sub} numberOfLines={1}>
                    {summary(o, served[o.id] ?? {})}
                  </Text>
                </View>
                {o.state === "accepted" && (
                  <Pressable onPress={safely(() => setOutgoingPaused(o.id, !o.paused))} style={styles.ghost} hitSlop={6}>
                    <Text style={styles.ghostText}>{o.paused ? "Resume" : "Pause"}</Text>
                  </Pressable>
                )}
                {live && (
                  <Pressable onPress={safely(() => cancelOutgoing(o.id))} style={styles.ghost} hitSlop={6}>
                    <Text style={[styles.ghostText, { color: C.danger }]}>Cancel</Text>
                  </Pressable>
                )}
              </View>
            );
          })}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 8, marginBottom: 16 },
  heading: { fontSize: 11, fontWeight: "700", letterSpacing: 1, color: C.contentFaint, marginTop: 4 },
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: C.border,
    backgroundColor: C.surfaceRaised,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  incoming: { borderColor: C.action },
  title: { fontSize: 14, fontWeight: "600", color: C.content },
  sub: { fontSize: 12, color: C.contentFaint, marginTop: 2 },
  ghost: { paddingHorizontal: 10, paddingVertical: 6 },
  ghostText: { fontSize: 13, fontWeight: "600", color: C.contentMuted },
  primary: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8, backgroundColor: C.action },
  primaryText: { fontSize: 13, fontWeight: "700", color: C.onAction },
});
