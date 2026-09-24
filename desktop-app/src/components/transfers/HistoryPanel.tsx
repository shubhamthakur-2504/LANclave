import { ArrowDownLeft, ArrowUpRight, Check, CopyCheck, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import * as api from "../../api";
import type { HistoryEntry } from "../../types";
import { computeStats, formatBytes } from "../../lib/stats";
import EmptyState from "../ui/EmptyState";

type Range = 7 | 30;
const DAY_MS = 24 * 60 * 60 * 1000;

function formatWhen(ms: number): string {
  const d = new Date(ms);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
        " " +
        d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/** "You sent", "Phone pulled", ... -- who started it matters as much as which way it went. */
function describe(e: HistoryEntry): string {
  const peer = e.peer_name ?? "Unknown device";
  if (e.initiated_by === "me") {
    return e.direction === "sent" ? `You sent to ${peer}` : `You pulled from ${peer}`;
  }
  return e.direction === "sent" ? `${peer} pulled from you` : `${peer} sent to you`;
}

function OutcomeBadge({ entry }: { entry: HistoryEntry }) {
  switch (entry.outcome) {
    case "completed":
      return (
        <span className="inline-flex items-center gap-1 text-[11px] font-medium text-ok">
          <Check className="h-3 w-3" strokeWidth={2.5} aria-hidden="true" />
          Done
        </span>
      );
    case "skipped":
      return (
        <span
          className="inline-flex items-center gap-1 text-[11px] font-medium text-content-muted"
          title="The destination already had an identical copy, so nothing was sent."
        >
          <CopyCheck className="h-3 w-3" strokeWidth={2.5} aria-hidden="true" />
          Already there
        </span>
      );
    case "cancelled":
      return (
        <span className="inline-flex items-center gap-1 text-[11px] font-medium text-content-muted">
          <X className="h-3 w-3" strokeWidth={2.5} aria-hidden="true" />
          Cancelled
        </span>
      );
    default:
      return (
        <span
          className="inline-flex items-center gap-1 text-[11px] font-medium text-danger"
          title={entry.error ?? undefined}
        >
          <X className="h-3 w-3" strokeWidth={2.5} aria-hidden="true" />
          Failed
        </span>
      );
  }
}

function StatTile({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="rounded-xl border border-border bg-surface-raised px-4 py-3">
      <p className="text-xs text-content-muted">{label}</p>
      <p className="mt-1 text-xl font-semibold text-content">{value}</p>
      <p className="text-xs text-content-faint">{detail}</p>
    </div>
  );
}

/**
 * Transfer history and analytics (30 days), both directions and both
 * initiators: what this device sent and pulled, and what peers sent to or
 * pulled from it.
 */
export default function HistoryPanel() {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [range, setRange] = useState<Range>(30);
  // "Now" as of the last load, so the window is stable between renders.
  const [loadedAt, setLoadedAt] = useState(0);

  const refresh = useCallback(async () => {
    try {
      setEntries(await api.getTransferHistory());
      setLoadedAt(Date.now());
    } catch (err) {
      console.error("Failed to load history:", err);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    refresh();
    // The backend announces every new entry, including ones a peer caused.
    const unlisten = listen("history-changed", () => refresh());
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [refresh]);

  const since = loadedAt - range * DAY_MS;
  const visible = useMemo(() => entries.filter((e) => e.at_ms >= since), [entries, since]);
  const stats = useMemo(() => computeStats(visible), [visible]);
  const maxPeerBytes = stats.byPeer[0]?.bytes ?? 0;

  const handleClear = async () => {
    if (!window.confirm("Clear the transfer history on this device? This can't be undone.")) return;
    await api.clearTransferHistory();
    refresh();
  };

  return (
    <div className="flex h-full flex-col">
      {/* Controls: one row above everything they filter */}
      <div className="flex items-center gap-4 border-b border-border px-5 py-2">
        {([7, 30] as Range[]).map((r) => (
          <button
            key={r}
            onClick={() => setRange(r)}
            className={`text-xs font-medium transition-colors ${
              range === r ? "text-action" : "text-content-faint hover:text-content"
            }`}
          >
            Last {r} days
          </button>
        ))}
        <div className="flex-1" />
        {entries.length > 0 && (
          <button
            onClick={handleClear}
            className="inline-flex items-center gap-1 text-xs font-medium text-content-faint transition-colors hover:text-danger"
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
            Clear history
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {loaded && visible.length === 0 ? (
          <EmptyState
            kind="transfers"
            message={`No transfers in the last ${range} days`}
            hint="Files you send or pull, and files peers send or pull from you, show up here."
          />
        ) : (
          <>
            {/* KPI row */}
            <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
              <StatTile
                label="Sent"
                value={formatBytes(stats.sentBytes)}
                detail={`${stats.sentFiles} ${stats.sentFiles === 1 ? "file" : "files"}`}
              />
              <StatTile
                label="Received"
                value={formatBytes(stats.receivedBytes)}
                detail={`${stats.receivedFiles} ${stats.receivedFiles === 1 ? "file" : "files"}`}
              />
              <StatTile
                label="Skipped, already there"
                value={formatBytes(stats.skippedBytes)}
                detail={`${stats.skippedFiles} ${stats.skippedFiles === 1 ? "file" : "files"} not re-sent`}
              />
              <StatTile
                label="Failed or cancelled"
                value={String(stats.failed)}
                detail={stats.failed === 1 ? "transfer" : "transfers"}
              />
            </div>

            {/* Volume by peer: one hue, value in text beside every bar */}
            {stats.byPeer.length > 0 && (
              <section className="rounded-xl border border-border bg-surface-raised p-4">
                <h3 className="mb-3 text-xs font-semibold text-content-muted">Data moved by device</h3>
                <ul className="space-y-2.5">
                  {stats.byPeer.map((p) => {
                    const pct = maxPeerBytes > 0 ? Math.max(2, (p.bytes / maxPeerBytes) * 100) : 0;
                    return (
                      <li
                        key={p.peerId}
                        className="grid grid-cols-[minmax(0,9rem)_1fr_auto] items-center gap-3"
                        title={`${p.peerName}: ${formatBytes(p.bytes)} in ${p.files} ${p.files === 1 ? "file" : "files"}`}
                      >
                        <span className="truncate text-xs text-content">{p.peerName}</span>
                        <span className="h-2 rounded-full bg-surface-inset">
                          <span
                            className="block h-2 rounded-full bg-content-muted"
                            style={{ width: `${pct}%` }}
                          />
                        </span>
                        <span className="text-xs tabular-nums text-content-muted">
                          {formatBytes(p.bytes)} · {p.files}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}

            {/* The log */}
            <section className="rounded-xl border border-border bg-surface-raised">
              <h3 className="border-b border-border px-4 py-2.5 text-xs font-semibold text-content-muted">
                Activity log
              </h3>
              <ul>
                {visible.map((e) => (
                  <li
                    key={e.id}
                    className="flex items-center gap-3 border-b border-border px-4 py-2.5 last:border-b-0"
                  >
                    {e.direction === "sent" ? (
                      <ArrowUpRight className="h-4 w-4 shrink-0 text-action" aria-label="Sent" />
                    ) : (
                      <ArrowDownLeft className="h-4 w-4 shrink-0 text-ok" aria-label="Received" />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-content">
                        {e.file_name}
                        {e.dest_name && (
                          <span className="text-content-faint"> → {e.dest_name}</span>
                        )}
                      </p>
                      <p className="truncate text-xs text-content-faint">{describe(e)}</p>
                    </div>
                    <span className="shrink-0 text-xs tabular-nums text-content-muted">
                      {formatBytes(e.bytes)}
                    </span>
                    <span className="w-24 shrink-0 text-right">
                      <OutcomeBadge entry={e} />
                    </span>
                    <span className="w-28 shrink-0 text-right text-xs text-content-faint">
                      {formatWhen(e.at_ms)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
