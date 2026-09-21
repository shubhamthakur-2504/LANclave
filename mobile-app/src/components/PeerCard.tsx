import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import Animated, {
  FadeIn,
  FadeOut,
  LinearTransition,
} from "react-native-reanimated";
import { DiscoveredPeer } from "@/hooks/use-peer-discovery";
import { C, idColor, short } from "@/constants/colors";
import { Icon } from "@/components/Icon";
import { deviceKind, initialForDevice, KIND_ICON } from "@/constants/device";

export interface PeerCardProps {
  peer: DiscoveredPeer;
  isSelected: boolean;
  isFetching?: boolean;
  hasError?: boolean;
  onConnect: (peer: DiscoveredPeer) => void;
}

export function PeerCard({
  peer,
  isSelected,
  isFetching,
  hasError,
  onConnect,
}: PeerCardProps) {
  const tint = idColor(peer.id);
  const initial = initialForDevice(peer.name);
  const kind = deviceKind(undefined, peer.name);

  return (
    /*
     * A peer appearing is a state change worth noticing — it is what makes
     * discovery feel like discovery rather than a refresh loop. Motion is
     * kept to arrival, departure and reflow; nothing decorative.
     */
    <Animated.View
      entering={FadeIn.duration(220)}
      exiting={FadeOut.duration(160)}
      layout={LinearTransition.duration(200)}
      style={[styles.card, isSelected && styles.cardSelected]}
    >
      {/* Avatar: name initial where there is one, device glyph otherwise, on a
          colour derived from the device id so a peer looks the same every time. */}
      <View style={[styles.avatar, { backgroundColor: `${tint}22` }]}>
        {initial ? (
          <Text style={[styles.avatarLetter, { color: tint }]}>{initial}</Text>
        ) : (
          <Icon name={KIND_ICON[kind]} size={22} color={tint} />
        )}
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
          isSelected && !hasError && styles.btnActive,
          hasError && styles.btnError,
          pressed && styles.btnPressed,
        ]}
        onPress={() => onConnect(peer)}
        accessibilityRole="button"
        accessibilityLabel={`Pair with ${peer.name}`}
        disabled={isFetching}
      >
        {isSelected && isFetching ? (
          <ActivityIndicator size="small" color={C.onAction} />
        ) : (
          <Text style={styles.btnText}>
            {isSelected
              ? hasError
                ? "Retry Pair"
                : "Connected"
              : "Pair & Connect"}
          </Text>
        )}
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  card: {
    width: 172,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: C.border,
    backgroundColor: C.surfaceRaised,
    padding: 16,
  },
  cardSelected: {
    borderColor: C.action,
    backgroundColor: C.surfaceActive,
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
  avatarLetter: { fontSize: 16, fontWeight: "700", color: C.action },
  name: { fontSize: 14, fontWeight: "600", color: C.content },
  ip: { marginTop: 2, fontSize: 11, color: C.contentMuted },
  btn: {
    marginTop: 14,
    borderRadius: 10,
    backgroundColor: C.action,
    paddingVertical: 9,
    alignItems: "center",
  },
  btnActive: { backgroundColor: C.actionPressed },
  btnError: { backgroundColor: C.dangerBorder },
  btnPressed: { opacity: 0.75 },
  btnText: { fontSize: 12, fontWeight: "700", color: C.onAction },
});
