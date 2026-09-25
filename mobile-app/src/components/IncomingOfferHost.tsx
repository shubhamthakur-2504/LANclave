/**
 * "MacBook wants to send 3 files" -- one prompt for the whole offer, on
 * whatever screen the user is on, with each file tickable. Closing it
 * defers the choice: the offer waits under Incoming on the Transfers tab.
 */

import { useState } from "react";
import { Alert, FlatList, Modal, Pressable, StyleSheet, Text, View } from "react-native";

import { C } from "@/constants/colors";
import { useOffers, type IncomingOffer } from "@/contexts/OffersContext";

function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(1)} KB`;
  return `${bytes} B`;
}

export function IncomingOfferHost() {
  const { promptOffer } = useOffers();
  // Keyed by offer, so each one starts with fresh choices.
  return promptOffer ? <OfferPrompt key={promptOffer.id} offer={promptOffer} /> : null;
}

function OfferPrompt({ offer }: { offer: IncomingOffer }) {
  const { closePrompt, accept, decline } = useOffers();
  // Everything ticked to start with.
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(offer.files.map((f) => f.id)));
  const [busy, setBusy] = useState(false);

  const who = offer.peer_name || "A paired device";
  const selected = offer.files.filter((f) => chosen.has(f.id));
  const selectedBytes = selected.reduce((n, f) => n + f.size, 0);

  const toggle = (id: string) =>
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } catch (err) {
      Alert.alert("Couldn't do that", err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal visible transparent animationType="fade" onRequestClose={closePrompt}>
      <View style={styles.overlay}>
        <View style={styles.card}>
          <Text style={styles.title}>
            {who} wants to send {offer.files.length} file{offer.files.length === 1 ? "" : "s"}
          </Text>
          <Text style={styles.sub}>
            {formatBytes(offer.files.reduce((n, f) => n + f.size, 0))} in total. Untick anything you don&apos;t want.
          </Text>

          <FlatList
            style={styles.list}
            data={offer.files}
            keyExtractor={(f) => f.id}
            renderItem={({ item }) => {
              const on = chosen.has(item.id);
              return (
                <Pressable
                  onPress={() => toggle(item.id)}
                  style={styles.row}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: on }}
                >
                  <View style={[styles.box, on && styles.boxOn]}>
                    {on && <Text style={styles.tick}>✓</Text>}
                  </View>
                  <Text style={styles.fileName} numberOfLines={1}>
                    {item.name}
                  </Text>
                  <Text style={styles.size}>{formatBytes(item.size)}</Text>
                </Pressable>
              );
            }}
          />

          {/* Equal weight, like the pairing sheet: no reflex-tap target. */}
          <View style={styles.buttons}>
            <Pressable
              style={[styles.decline, busy && styles.dim]}
              disabled={busy}
              onPress={() => run(() => decline(offer.id))}
            >
              <Text style={styles.declineText}>Decline</Text>
            </Pressable>
            <Pressable
              style={[styles.accept, (busy || selected.length === 0) && styles.dim]}
              disabled={busy || selected.length === 0}
              onPress={() => run(() => accept(offer.id, selected.map((f) => f.id)))}
            >
              <Text style={styles.acceptText}>
                {selected.length === offer.files.length ? "Accept" : `Accept ${selected.length} · ${formatBytes(selectedBytes)}`}
              </Text>
            </Pressable>
          </View>
          <Pressable onPress={closePrompt} hitSlop={8} style={styles.later}>
            <Text style={styles.laterText}>Decide later</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.78)",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 20,
  },
  card: {
    width: "100%",
    maxWidth: 400,
    maxHeight: "85%",
    borderRadius: 20,
    backgroundColor: C.surfaceRaised,
    borderWidth: 1,
    borderColor: C.borderStrong,
    padding: 20,
  },
  title: { fontSize: 18, fontWeight: "700", color: C.content },
  sub: { fontSize: 13, color: C.contentMuted, marginTop: 4 },
  list: { marginTop: 14, borderRadius: 12, borderWidth: 1, borderColor: C.border, flexGrow: 0 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  box: {
    width: 20,
    height: 20,
    borderRadius: 5,
    borderWidth: 1.5,
    borderColor: C.borderStrong,
    alignItems: "center",
    justifyContent: "center",
  },
  boxOn: { backgroundColor: C.action, borderColor: C.action },
  tick: { color: C.onAction, fontSize: 13, fontWeight: "800" },
  fileName: { flex: 1, fontSize: 14, color: C.content },
  size: { fontSize: 12, color: C.contentFaint },
  buttons: { flexDirection: "row", gap: 12, marginTop: 16 },
  decline: {
    flex: 1,
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: "center",
    backgroundColor: C.dangerBg,
    borderWidth: 1,
    borderColor: C.dangerBorder,
  },
  declineText: { color: C.danger, fontWeight: "700", fontSize: 15 },
  accept: {
    flex: 1,
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: "center",
    backgroundColor: C.okBg,
    borderWidth: 1,
    borderColor: C.okBorder,
  },
  acceptText: { color: C.ok, fontWeight: "700", fontSize: 15 },
  dim: { opacity: 0.45 },
  later: { alignSelf: "center", marginTop: 12 },
  laterText: { color: C.contentMuted, fontSize: 13 },
});
