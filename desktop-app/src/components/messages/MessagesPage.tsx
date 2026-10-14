import { useCallback, useEffect, useRef, useState } from "react";
import { Copy, MessageSquare, Trash2 } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import * as api from "../../api";
import type { PeerInfo } from "../../types";
import { colorForDevice, deviceTag } from "../../lib/identity";
import { useToast } from "../ui/Toast";
import EmptyState from "../ui/EmptyState";

/** Matches `MAX_TEXT_BYTES` in messages.rs. */
const MAX_TEXT_BYTES = 64 * 1024;

const URL_PATTERN = /(https?:\/\/[^\s<>"']+)/g;

/**
 * Message text, always as text: never HTML, since this window can call
 * LANclave's commands. Links open in the default browser, not in here.
 */
function MessageText({ text }: { text: string }) {
  // Several lines or a code fence reads as code: keep its spacing, monospace.
  const looksLikeCode = text.includes("\n") || text.includes("```");
  const parts = text.split(URL_PATTERN);
  return (
    <p className={`whitespace-pre-wrap break-words text-sm ${looksLikeCode ? "font-mono text-[13px]" : ""}`}>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <button
            key={i}
            onClick={() => openUrl(part).catch(() => {})}
            className="break-all text-left text-action underline underline-offset-2 hover:opacity-80"
            title="Open in your browser"
          >
            {part}
          </button>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </p>
  );
}

function time(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { hour: "2-digit", minute: "2-digit", day: "numeric", month: "short" });
}

function Thread({ peer }: { peer: PeerInfo }) {
  const toast = useToast();
  const [messages, setMessages] = useState<api.ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const name = peer.device_name || "this device";

  const load = useCallback(async () => {
    try {
      setMessages(await api.getThread(peer.device_id));
      // Open on screen means read.
      await api.markThreadRead(peer.device_id);
    } catch {
      // keep what is shown
    }
  }, [peer.device_id]);

  useEffect(() => {
    load();
    let unlisten: (() => void) | undefined;
    import("@tauri-apps/api/event")
      .then(({ listen }) => listen("messages-changed", () => load()))
      .then((u) => {
        unlisten = u;
      });
    return () => unlisten?.();
  }, [load]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length]);

  const tooLong = new TextEncoder().encode(draft).length > MAX_TEXT_BYTES;

  const send = async () => {
    if (!draft.trim() || tooLong || sending) return;
    setSending(true);
    try {
      await api.sendMessage(peer.device_id, draft);
      setDraft("");
      await load();
    } catch (e) {
      toast.error(e, name);
    } finally {
      setSending(false);
    }
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Copied");
    } catch {
      toast.info("Couldn't copy", "Select the text and copy it instead.");
    }
  };

  const clear = async () => {
    const ok = await api.confirmAction(
      `Every message with ${name} is deleted from this computer, including any still waiting to be sent. ${name} keeps its own copy.`,
      { title: "Clear this conversation?", okLabel: "Clear" },
    );
    if (!ok) return;
    await api.clearThread(peer.device_id);
    await load();
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b border-border bg-surface-raised px-6 py-3">
        <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: colorForDevice(peer.device_id) }} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-content">
            {name} <span className="font-mono text-xs font-normal text-content-muted">{deviceTag(peer.device_id)}</span>
          </p>
          <p className="text-xs text-content-faint">
            {peer.addr ? "Online — messages arrive now" : "Offline — messages wait until it is back"}
          </p>
        </div>
        {messages.length > 0 && (
          <button
            onClick={clear}
            className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs text-content-faint transition-colors hover:text-danger"
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
            Clear
          </button>
        )}
      </div>

      <div className="flex-1 space-y-2 overflow-y-auto px-6 py-4">
        {messages.length === 0 && (
          <p className="pt-8 text-center text-sm text-content-faint">
            Send a link, a code or a note. Only {name} can read it.
          </p>
        )}
        {messages.map((m) => {
          const mine = m.state !== "received";
          return (
            <div key={m.id} className={`group flex ${mine ? "justify-end" : "justify-start"}`}>
              <div
                className={`relative max-w-[75%] rounded-2xl px-3.5 py-2 ${
                  mine ? "bg-action/15 text-content" : "border border-border bg-surface-raised text-content"
                }`}
              >
                <MessageText text={m.text} />
                <div className="mt-1 flex items-center justify-end gap-2 text-[10px] text-content-faint">
                  <span>{time(m.sent_at)}</span>
                  {m.state === "waiting" && <span className="text-warn">Waiting for device</span>}
                  {m.state === "delivered" && <span>Delivered</span>}
                </div>
                <button
                  onClick={() => copy(m.text)}
                  title="Copy"
                  aria-label="Copy message"
                  className={`absolute top-1 rounded-md border border-border bg-surface p-1 text-content-muted opacity-0 transition-opacity hover:text-content focus:opacity-100 group-hover:opacity-100 ${
                    mine ? "-left-8" : "-right-8"
                  }`}
                >
                  <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      <div className="border-t border-border bg-surface-raised px-6 py-3">
        <div className="flex items-end gap-3">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            rows={2}
            placeholder={`Message ${name}`}
            className="flex-1 resize-none rounded-xl border border-border bg-surface-inset px-3 py-2 text-sm text-content focus:border-action focus:outline-none"
          />
          <button
            onClick={send}
            disabled={!draft.trim() || tooLong || sending}
            className="rounded-xl bg-action px-4 py-2 text-sm font-medium text-on-action transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            Send
          </button>
        </div>
        <p className="mt-1.5 text-[11px] text-content-faint">
          {tooLong
            ? "Too long for a message — send it as a file instead."
            : "Enter sends · Shift+Enter for a new line"}
        </p>
      </div>
    </div>
  );
}

/**
 * One conversation per paired device.
 *
 * The list shows who and how many, never what: the screen may be shared,
 * and a code or a link should only appear when its thread is opened.
 */
export default function MessagesPage({
  peers,
  selectedId,
  onSelect,
}: {
  peers: PeerInfo[];
  selectedId: string | null;
  onSelect: (deviceId: string) => void;
}) {
  const [threads, setThreads] = useState<api.ThreadSummary[]>([]);

  useEffect(() => {
    const load = () => api.listThreads().then(setThreads).catch(() => {});
    load();
    let unlisten: (() => void) | undefined;
    import("@tauri-apps/api/event")
      .then(({ listen }) => listen("messages-changed", load))
      .then((u) => {
        unlisten = u;
      });
    return () => unlisten?.();
  }, []);

  const paired = peers.filter((p) => p.paired && !p.untrusted);
  const summary = (id: string) => threads.find((t) => t.peer_id === id);
  const ordered = [...paired].sort((a, b) => (summary(b.device_id)?.last_at ?? 0) - (summary(a.device_id)?.last_at ?? 0));
  const selected = paired.find((p) => p.device_id === selectedId) ?? null;

  if (paired.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <EmptyState message="No paired devices" hint="Pair with a device on the Peers page to message it." />
      </div>
    );
  }

  return (
    <div className="flex h-full">
      <ul className="w-64 shrink-0 overflow-y-auto border-r border-border bg-surface-raised">
        {ordered.map((peer) => {
          const s = summary(peer.device_id);
          const active = peer.device_id === selectedId;
          return (
            <li key={peer.device_id}>
              <button
                onClick={() => onSelect(peer.device_id)}
                className={`flex w-full items-center gap-3 px-4 py-3 text-left transition-colors ${
                  active ? "bg-action/10" : "hover:bg-surface-active"
                }`}
              >
                <span
                  className={`h-2 w-2 shrink-0 rounded-full ${peer.addr ? "" : "bg-content-faint"}`}
                  style={peer.addr ? { backgroundColor: colorForDevice(peer.device_id) } : undefined}
                  title={peer.addr ? "Online" : "Offline"}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-content">
                    {peer.device_name || deviceTag(peer.device_id)}
                  </span>
                  <span className="block text-xs text-content-faint">
                    {s ? `${s.count} message${s.count === 1 ? "" : "s"}${s.waiting ? ` · ${s.waiting} waiting` : ""}` : "No messages"}
                  </span>
                </span>
                {!!s?.unread && (
                  <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-action px-1.5 text-[10px] font-bold text-on-action">
                    {s.unread > 9 ? "9+" : s.unread}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
      <div className="min-w-0 flex-1">
        {selected ? (
          <Thread key={selected.device_id} peer={selected} />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-content-faint">
            <MessageSquare className="h-8 w-8" aria-hidden="true" />
            <p className="text-sm">Pick a device to message.</p>
          </div>
        )}
      </div>
    </div>
  );
}
