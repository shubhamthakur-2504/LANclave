import { ArrowUpRight, Inbox, Pause, Play, X } from "lucide-react";
import { useOffers } from "../../contexts/OffersContext";
import { formatBytes } from "../../lib/stats";
import type { OutgoingOffer } from "../../types";
import { useToast } from "../ui/Toast";

/** Minutes until `ms`, rounded up, for "expires in". */
function minutesUntil(ms: number): number {
  return Math.max(1, Math.ceil((ms - Date.now()) / 60_000));
}

function outgoingSummary(o: OutgoingOffer, served: Record<string, number>): string {
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
      const results = Object.values(o.results);
      const ok = results.filter((r) => r.outcome === "completed" || r.outcome === "skipped").length;
      return ok === results.length ? `Delivered to ${who}` : `${ok} of ${results.length} delivered`;
    }
    case "accepted": {
      if (o.paused) return "Paused by you";
      const total = o.files.filter((f) => o.accepted.includes(f.id)).reduce((n, f) => n + f.size, 0);
      const sent = o.accepted.reduce((n, id) => n + (served[id] ?? o.served[id] ?? 0), 0);
      return `${who} is receiving · ${formatBytes(sent)} of ${formatBytes(total)}`;
    }
  }
}

/**
 * Offers on the Activity view: incoming ones still to answer, and the
 * offers this computer sent. Rows for files being pulled live in the
 * transfer list below like any other download.
 */
export default function OffersSection() {
  const { pendingIncoming, outgoing, served, openPrompt, decline, cancelOutgoing, setOutgoingPaused } = useOffers();
  const toast = useToast();
  const recentOutgoing = outgoing.slice(0, 20);

  if (pendingIncoming.length === 0 && recentOutgoing.length === 0) return null;

  const safely = (action: () => Promise<void>) => async () => {
    try {
      await action();
    } catch (err) {
      toast.error(err);
    }
  };

  return (
    <div className="space-y-3 border-b border-border p-4">
      {pendingIncoming.length > 0 && (
        <section aria-label="Incoming offers">
          <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-action">
            Incoming · {pendingIncoming.length}
          </h3>
          <ul className="space-y-2">
            {pendingIncoming.map((o) => (
              <li key={o.id} className="flex items-center gap-3 rounded-xl border border-action/30 bg-action/5 px-4 py-3">
                <Inbox className="h-4 w-4 shrink-0 text-action" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-content">
                    {o.peer_name || "A paired device"} · {o.files.length} file{o.files.length === 1 ? "" : "s"}
                  </p>
                  <p className="text-xs text-content-faint">
                    {formatBytes(o.files.reduce((n, f) => n + f.size, 0))} · expires in {minutesUntil(o.expires_ms)} min
                  </p>
                </div>
                <button
                  onClick={safely(() => decline(o.id))}
                  className="rounded-lg border border-border-strong px-3 py-1.5 text-xs font-medium text-content hover:bg-surface-active"
                >
                  Decline
                </button>
                <button
                  onClick={() => openPrompt(o.id)}
                  className="rounded-lg bg-action px-3 py-1.5 text-xs font-medium text-on-action hover:bg-action-hover"
                >
                  Review
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {recentOutgoing.length > 0 && (
        <section aria-label="Sent offers">
          <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-content-faint">Sent</h3>
          <ul className="space-y-2">
            {recentOutgoing.map((o) => {
              const live = o.state === "waiting" || o.state === "accepted";
              return (
                <li key={o.id} className="flex items-center gap-3 rounded-xl border border-border bg-surface-raised px-4 py-3">
                  <ArrowUpRight className="h-4 w-4 shrink-0 text-action" aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-content">
                      {o.files.length === 1 ? o.files[0].name : `${o.files.length} files`}
                    </p>
                    <p className="truncate text-xs text-content-faint">{outgoingSummary(o, served[o.id] ?? {})}</p>
                  </div>
                  {o.state === "accepted" && (
                    <button
                      onClick={safely(() => setOutgoingPaused(o.id, !o.paused))}
                      aria-label={o.paused ? "Resume sending" : "Pause sending"}
                      title={o.paused ? "Resume sending" : "Pause sending"}
                      className="rounded-lg p-1.5 text-content-muted hover:bg-surface-active hover:text-content"
                    >
                      {o.paused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
                    </button>
                  )}
                  {live && (
                    <button
                      onClick={safely(() => cancelOutgoing(o.id))}
                      aria-label="Cancel sending"
                      title="Cancel: stop offering these files"
                      className="rounded-lg p-1.5 text-content-muted hover:bg-danger-bg hover:text-danger"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
