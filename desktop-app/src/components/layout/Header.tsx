import { useTransfers } from "../../contexts/TransferContext";

interface HeaderProps {
  /** Real server state — see the note on honesty below. */
  serverRunning: boolean;
  /** True while a start/stop is in flight. */
  serverBusy: boolean;
}

/**
 * The status pill used to be a hardcoded green dot reading "System Active",
 * which claimed everything was fine even with the server stopped. It is now
 * bound to real state with three honest outcomes.
 */
function status(serverRunning: boolean, serverBusy: boolean) {
  if (serverBusy) {
    return { label: "Starting…", dot: "bg-warn", text: "text-warn" };
  }
  if (serverRunning) {
    return { label: "Server running", dot: "bg-ok", text: "text-ok" };
  }
  return { label: "Server stopped", dot: "bg-content-faint", text: "text-content-muted" };
}

export default function Header({ serverRunning, serverBusy }: HeaderProps) {
  const { transfers } = useTransfers();
  const state = status(serverRunning, serverBusy);

  // A global transfer indicator, visible from every page (U2.2). Nobody
  // should have to open a tab to find out whether their file is moving.
  const active = transfers.filter((t) => t.status === "in_progress");
  const totalBytes = active.reduce((sum, t) => sum + t.fileSize, 0);
  const movedBytes = active.reduce((sum, t) => sum + t.progress, 0);
  const pct = totalBytes > 0 ? Math.min(100, (movedBytes / totalBytes) * 100) : 0;

  return (
    <header className="relative border-b border-border">
      <div className="flex items-center justify-between px-6 py-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-content">
            LANclave
          </h1>
          <p className="text-[11px] text-content-faint">
            Local network vault — no internet, ever
          </p>
        </div>

        <div className="flex items-center gap-3">
          {active.length > 0 && (
            <span className="text-[11px] text-content-muted" aria-live="polite">
              {active.length} transfer{active.length > 1 ? "s" : ""} ·{" "}
              {Math.round(pct)}%
            </span>
          )}
          <div
            className={`flex items-center gap-2 rounded-full border border-border-strong bg-surface-raised px-4 py-1.5 text-xs ${state.text}`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${state.dot}`} />
            {state.label}
          </div>
        </div>
      </div>

      {/* Slim global progress bar along the header's bottom edge. */}
      {active.length > 0 && (
        <div
          className="absolute inset-x-0 bottom-0 h-0.5 bg-surface-inset"
          role="progressbar"
          aria-valuenow={Math.round(pct)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Overall transfer progress"
        >
          <div
            className="h-full bg-action transition-[width] duration-300 ease-out"
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
    </header>
  );
}
