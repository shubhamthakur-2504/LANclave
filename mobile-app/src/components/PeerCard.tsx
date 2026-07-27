import { Pressable, StyleSheet, Text, View } from "react-native";
import { DiscoveredPeer } from "@/hooks/use-peer-discovery";
import { C, short } from "@/constants/colors";

export interface PeerCardProps {
  peer: DiscoveredPeer;
  isSelected: boolean;
  onConnect: (peer: DiscoveredPeer) => void;
}

export function PeerCard({ peer, isSelected, onConnect }: PeerCardProps) {
  return (
    <View style={[styles.card, isSelected && styles.cardSelected]}>
      {/* Avatar */}
      <View style={styles.avatar}>
        <Text style={styles.avatarLetter}>
          {peer.name[0]?.toUpperCase() ?? "?"}
        </Text>
      </View>

      {/* Identity */}
      <Text style={styles.name}>{short(peer.name)}</Text>
      <Text style={styles.ip}>
        {peer.ip}:{peer.port}
      </Text>

      {/* Action */}
      <Pressable
        style={({ pressed }) => [
          styles.btn,
          isSelected && styles.btnActive,
          pressed && styles.btnPressed,
        ]}
        onPress={() => onConnect(peer)}
      >
        <Text style={styles.btnText}>
          {isSelected ? "Connected ✓" : "Pair & Connect"}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    width: 172,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: C.border,
    backgroundColor: C.surface,
    padding: 16,
  },
  cardSelected: {
    borderColor: C.accent,
    backgroundColor: C.surfaceRaised,
  },
  avatar: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: "#0C2344",
    borderWidth: 1,
    borderColor: C.borderStrong,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 12,
  },
  avatarLetter: { fontSize: 16, fontWeight: "700", color: C.accent },
  name: { fontSize: 14, fontWeight: "600", color: C.textPrimary },
  ip: { marginTop: 2, fontSize: 11, color: C.textSecond },
  btn: {
    marginTop: 14,
    borderRadius: 10,
    backgroundColor: C.accentBtn,
    paddingVertical: 9,
    alignItems: "center",
  },
  btnActive: { backgroundColor: C.accentBtnDim },
  btnPressed: { opacity: 0.75 },
  btnText: { fontSize: 12, fontWeight: "700", color: "#FFFFFF" },
});
