import { Inbox, X } from "lucide-react";
import { useEffect, useState } from "react";
import * as api from "../../api";
import { useOffers } from "../../contexts/OffersContext";
import { formatBytes } from "../../lib/stats";
import { useToast } from "../ui/Toast";

/**
 * "Phone wants to send 3 files" -- one prompt for the whole selection, with
 * each file tickable. Closing it without answering leaves the offer in the
 * Incoming list on the Transfers page; it is never lost.
 */
export default function IncomingOfferModal() {
  const { promptOffer: offer, closePrompt, accept, decline } = useOffers();
  const toast = useToast();
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [always, setAlways] = useState(false);

  // Everything ticked by default, afresh for each offer.
  useEffect(() => {
    setChosen(new Set(offer?.files.map((f) => f.id) ?? []));
    setAlways(false);
  }, [offer?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!offer) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closePrompt();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [offer, closePrompt]);

  if (!offer) return null;

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
      toast.error(err, who);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4 backdrop-blur-sm">
      <div className="flex max-h-[85vh] w-full max-w-md flex-col rounded-2xl border border-border-strong bg-surface-raised shadow-2xl">
        <div className="flex items-start gap-3 px-6 pt-6">
          <Inbox className="mt-0.5 h-5 w-5 shrink-0 text-content-muted" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold text-content">
              {who} wants to send {offer.files.length} file{offer.files.length === 1 ? "" : "s"}
            </h2>
            <p className="mt-0.5 text-xs text-content-muted">
              {formatBytes(offer.files.reduce((n, f) => n + f.size, 0))} in total. Untick anything you don't want.
            </p>
          </div>
          <button
            onClick={closePrompt}
            aria-label="Decide later"
            title="Decide later: it stays under Incoming on the Transfers page"
            className="flex h-6 w-6 items-center justify-center rounded-full text-content-faint hover:bg-surface-active hover:text-content"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <ul className="mx-6 mt-4 flex-1 overflow-y-auto rounded-lg border border-border">
          {offer.files.map((f) => (
            <li key={f.id} className="border-b border-border last:border-b-0">
              <label className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-surface-active">
                <input
                  type="checkbox"
                  checked={chosen.has(f.id)}
                  onChange={() => toggle(f.id)}
                  className="h-4 w-4 accent-[var(--color-action)]"
                />
                <span className="min-w-0 flex-1 truncate text-sm text-content">{f.name}</span>
                <span className="shrink-0 text-xs tabular-nums text-content-faint">{formatBytes(f.size)}</span>
              </label>
            </li>
          ))}
        </ul>

        <label className="mx-6 mt-3 flex cursor-pointer items-center gap-2 text-xs text-content-muted">
          <input
            type="checkbox"
            checked={always}
            onChange={(e) => setAlways(e.target.checked)}
            className="h-3.5 w-3.5 accent-[var(--color-action)]"
          />
          Always accept from {who}
        </label>

        {/* Equal weight, like the pairing dialog: no reflex-click target. */}
        <div className="flex gap-3 px-6 py-5">
          <button
            onClick={() => run(() => decline(offer.id))}
            disabled={busy}
            className="flex-1 rounded-lg border border-danger-border bg-danger-bg/40 px-4 py-2.5 text-sm font-semibold text-danger transition-colors hover:bg-danger-bg disabled:opacity-40"
          >
            Decline
          </button>
          <button
            onClick={() =>
              run(async () => {
                await accept(offer.id, selected.map((f) => f.id));
                if (always) await api.setAutoAccept(offer.peer_id, true);
              })
            }
            disabled={busy || selected.length === 0}
            className="flex-1 rounded-lg border border-ok-border bg-ok/10 px-4 py-2.5 text-sm font-semibold text-ok transition-colors hover:bg-ok/20 disabled:opacity-40"
          >
            {selected.length === offer.files.length
              ? "Accept"
              : `Accept ${selected.length} · ${formatBytes(selectedBytes)}`}
          </button>
        </div>
      </div>
    </div>
  );
}
