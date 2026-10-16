/**
 * One conversation with a paired device.
 *
 * Text is shown as text, never rendered; links open in the browser. A
 * message written while the device is away waits here, and goes when it is
 * next heard from.
 */

import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import ExpoNativeServerModule, {
  type ChatMessage,
} from "../../modules/expo-native-server/src/ExpoNativeServerModule";
import { C } from "@/constants/colors";
import { deviceTag } from "@/constants/device";
import { Icon } from "@/components/Icon";

/** Matches `MAX_TEXT_BYTES` on both sides. */
const MAX_TEXT_BYTES = 64 * 1024;
const URL_PATTERN = /(https?:\/\/[^\s<>"']+)/g;

function readThread(peerId: string): ChatMessage[] {
  try {
    return ExpoNativeServerModule.getThread(peerId);
  } catch {
    return [];
  }
}

function time(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { hour: "2-digit", minute: "2-digit", day: "numeric", month: "short" });
}

function MessageText({ text, mine }: { text: string; mine: boolean }) {
  // Several lines or a code fence reads as code: keep its spacing, monospace.
  const looksLikeCode = text.includes("\n") || text.includes("```");
  const parts = text.split(URL_PATTERN);
  return (
    <Text selectable style={[styles.text, looksLikeCode && styles.code, mine && styles.textMine]}>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <Text key={i} style={styles.link} onPress={() => Linking.openURL(part).catch(() => {})}>
            {part}
          </Text>
        ) : (
          part
        ),
      )}
    </Text>
  );
}

export default function PeerChatScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ id: string; name?: string; ip?: string; port?: string }>();
  const peerId = params.id ?? "";
  const name = params.name || "this device";
  const addr = params.ip ? `${params.ip}:${params.port ?? 8377}` : null;

  const [messages, setMessages] = useState<ChatMessage[]>(() => readThread(peerId));
  const [draft, setDraft] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const listRef = useRef<FlatList<ChatMessage>>(null);

  const refresh = useCallback(() => {
    setMessages(readThread(peerId));
    // On screen means read.
    try {
      ExpoNativeServerModule.markThreadRead(peerId);
    } catch {
      // older native build
    }
  }, [peerId]);

  useFocusEffect(refresh);

  useEffect(() => {
    let sub: { remove: () => void } | null = null;
    try {
      sub = ExpoNativeServerModule.addListener("onMessagesChanged", refresh);
    } catch {
      // older native build
    }
    return () => sub?.remove();
  }, [refresh]);

  const tooLong = new TextEncoder().encode(draft).length > MAX_TEXT_BYTES;

  const send = () => {
    if (!draft.trim() || tooLong) return;
    try {
      ExpoNativeServerModule.sendMessage(peerId, addr, draft);
      setDraft("");
      refresh();
    } catch (err) {
      Alert.alert("Couldn't send", err instanceof Error ? err.message : String(err));
    }
  };

  const copy = (message: ChatMessage) => {
    try {
      ExpoNativeServerModule.copyText(message.text);
      setCopied(message.id);
      setTimeout(() => setCopied((id) => (id === message.id ? null : id)), 1500);
    } catch {
      Alert.alert("Couldn't copy", "Press and hold the text to select it instead.");
    }
  };

  const clear = () => {
    Alert.alert(
      "Clear this conversation?",
      `Every message with ${name} is deleted from this phone, including any still waiting to be sent. ${name} keeps its own copy.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Clear",
          style: "destructive",
          onPress: () => {
            ExpoNativeServerModule.clearThread(peerId);
            refresh();
          },
        },
      ],
    );
  };

  return (
    <SafeAreaView style={styles.root} edges={["top", "bottom"]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={10} accessibilityRole="button" accessibilityLabel="Back">
          <Icon name="chevronLeft" size={24} color={C.content} />
        </Pressable>
        <View style={styles.headerText}>
          <Text style={styles.title} numberOfLines={1}>
            {name}
          </Text>
          <Text style={styles.subtitle}>{deviceTag(peerId)}</Text>
        </View>
        {messages.length > 0 && (
          <Pressable onPress={clear} hitSlop={10} accessibilityRole="button" accessibilityLabel="Clear conversation">
            <Icon name="trash" size={20} color={C.contentMuted} />
          </Pressable>
        )}
      </View>

      {/* Padding on Android too: the app draws edge to edge, so Android no
          longer shrinks the window for the keyboard and the composer would
          sit behind it. */}
      <KeyboardAvoidingView style={styles.flex} behavior="padding">
        <FlatList
          ref={listRef}
          data={messages}
          keyExtractor={(m) => m.id}
          contentContainerStyle={styles.list}
          // Copy and links work with the keyboard up, without closing it.
          keyboardShouldPersistTaps="handled"
          onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
          // The keyboard shrinks the list: keep the latest message in view.
          onLayout={() => listRef.current?.scrollToEnd({ animated: false })}
          ListEmptyComponent={
            <Text style={styles.empty}>Send a link, a code or a note. Only {name} can read it.</Text>
          }
          renderItem={({ item }) => {
            const mine = item.state !== "received";
            return (
              <View style={[styles.row, mine && styles.rowMine]}>
                <Pressable
                  onLongPress={() => copy(item)}
                  style={[styles.bubble, mine ? styles.bubbleMine : styles.bubbleTheirs]}
                  accessibilityHint="Long-press to copy"
                >
                  <MessageText text={item.text} mine={mine} />
                  <View style={styles.meta}>
                    <Text style={styles.metaText}>{time(item.sentAtMs)}</Text>
                    {item.state === "waiting" && <Text style={styles.waiting}>Waiting for device</Text>}
                    {item.state === "delivered" && <Text style={styles.metaText}>Delivered</Text>}
                    <Pressable onPress={() => copy(item)} hitSlop={8} accessibilityRole="button" accessibilityLabel="Copy message">
                      <Text style={styles.copy}>{copied === item.id ? "Copied" : "Copy"}</Text>
                    </Pressable>
                  </View>
                </Pressable>
              </View>
            );
          }}
        />

        <View style={styles.composer}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder={`Message ${name}`}
            placeholderTextColor={C.contentFaint}
            multiline
            style={styles.input}
          />
          <Pressable
            onPress={send}
            disabled={!draft.trim() || tooLong}
            style={({ pressed }) => [styles.sendBtn, (!draft.trim() || tooLong) && styles.sendDisabled, pressed && styles.pressed]}
            accessibilityRole="button"
            accessibilityLabel="Send message"
          >
            <Icon name="send" size={20} color={C.onAction} />
          </Pressable>
        </View>
        {tooLong && <Text style={styles.tooLong}>Too long for a message — send it as a file instead.</Text>}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.surface },
  flex: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  headerText: { flex: 1 },
  title: { fontSize: 17, fontWeight: "700", color: C.content },
  subtitle: { fontSize: 12, color: C.contentMuted, marginTop: 2 },
  list: { padding: 16, gap: 8, flexGrow: 1 },
  empty: { textAlign: "center", color: C.contentFaint, marginTop: 40, fontSize: 13 },
  row: { flexDirection: "row", justifyContent: "flex-start" },
  rowMine: { justifyContent: "flex-end" },
  bubble: { maxWidth: "82%", borderRadius: 16, paddingHorizontal: 12, paddingVertical: 8 },
  bubbleMine: { backgroundColor: C.action },
  bubbleTheirs: { backgroundColor: C.surfaceRaised, borderWidth: 1, borderColor: C.border },
  text: { fontSize: 15, color: C.content },
  textMine: { color: C.onAction },
  code: { fontFamily: Platform.OS === "android" ? "monospace" : "Menlo", fontSize: 13 },
  link: { textDecorationLine: "underline" },
  meta: { flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 8, marginTop: 4 },
  metaText: { fontSize: 10, color: C.contentFaint },
  waiting: { fontSize: 10, color: C.warn },
  copy: { fontSize: 10, fontWeight: "700", color: C.contentMuted },
  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: C.border,
  },
  input: {
    flex: 1,
    maxHeight: 140,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: C.border,
    backgroundColor: C.surfaceInset,
    paddingHorizontal: 14,
    paddingVertical: 8,
    fontSize: 15,
    color: C.content,
  },
  sendBtn: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: C.action,
    alignItems: "center",
    justifyContent: "center",
  },
  sendDisabled: { opacity: 0.4 },
  pressed: { opacity: 0.75 },
  tooLong: { fontSize: 11, color: C.warn, paddingHorizontal: 16, paddingBottom: 8 },
});
