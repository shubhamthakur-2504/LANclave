import type { Transfer } from "../../mockdata";

interface TransferDetailPanelProps {
  transfer: Transfer;
}

function formatSize(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(1)} KB`;
  return `${bytes} B`;
}

function formatSpeed(bytesPerSec: number): string {
  if (bytesPerSec === 0) return "—";
  if (bytesPerSec >= 1_000_000) return `${(bytesPerSec / 1_000_000).toFixed(1)} MB/s`;
  if (bytesPerSec >= 1_000) return `${(bytesPerSec / 1_000).toFixed(1)} KB/s`;
  return `${bytesPerSec} B/s`;
}

function formatTime(iso: string): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function calcEta(transfer: Transfer): string {
  if (transfer.status !== "in_progress" || transfer.speed === 0) return "—";
  const remaining = transfer.fileSize * ((100 - transfer.progress) / 100);
  const seconds = remaining / transfer.speed;
  if (seconds < 60) return `~${Math.round(seconds)}s remaining`;
  return `~${Math.round(seconds / 60)}m remaining`;
}

export default function TransferDetailPanel({
  transfer,
}: TransferDetailPanelProps) {
  return (
    <div className="flex h-full flex-col">
      {/* Preview */}
      <div className="flex items-center justify-center border-b border-slate-800 px-6 py-12">
        <div className="flex h-24 w-24 items-center justify-center rounded-2xl bg-sky-500/10">
          <svg className="h-12 w-12 text-sky-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
          </svg>
        </div>
      </div>

      {/* Transfer info */}
      <div className="px-6 py-4">
        <h3 className="text-lg font-semibold text-slate-100">
          {transfer.fileName}
        </h3>

        {/* Progress bar */}
        {(transfer.status === "in_progress" || transfer.status === "pending") && (
          <div className="mt-4">
            <div className="mb-1 flex justify-between text-xs text-slate-400">
              <span>{transfer.progress}%</span>
              <span>{calcEta(transfer)}</span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-slate-700">
              <div
                className="h-full rounded-full bg-sky-400 transition-all duration-300"
                style={{ width: `${transfer.progress}%` }}
              />
            </div>
          </div>
        )}

        <dl className="mt-5 space-y-3">
          <div className="flex justify-between">
            <dt className="text-xs text-slate-500">Size</dt>
            <dd className="text-xs text-slate-300">
              {formatSize(transfer.fileSize)}
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-xs text-slate-500">Direction</dt>
            <dd className="text-xs text-slate-300">
              {transfer.direction === "upload"
                ? `Sending to ${transfer.peerName}`
                : `Receiving from ${transfer.peerName}`}
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-xs text-slate-500">Started</dt>
            <dd className="text-xs text-slate-300">
              {formatTime(transfer.startedAt)}
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-xs text-slate-500">Speed</dt>
            <dd className="text-xs text-slate-300">
              {formatSpeed(transfer.speed)}
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-xs text-slate-500">Status</dt>
            <dd className="text-xs text-slate-300 capitalize">
              {transfer.status.replace("_", " ")}
            </dd>
          </div>
        </dl>
      </div>

      {/* Actions */}
      {transfer.status === "in_progress" && (
        <div className="mt-auto border-t border-slate-800 px-6 py-4">
          <div className="flex gap-2">
            <button className="flex-1 rounded-lg border border-slate-700 px-4 py-2 text-sm font-medium text-slate-300 transition-colors hover:bg-slate-800">
              Pause
            </button>
            <button className="flex-1 rounded-lg border border-red-800/50 px-4 py-2 text-sm font-medium text-red-400 transition-colors hover:bg-red-950/30">
              Cancel
            </button>
          </div>
        </div>
      )}
      {transfer.status === "completed" && (
        <div className="mt-auto border-t border-slate-800 px-6 py-4">
          <button className="flex w-full items-center justify-center gap-2 rounded-lg bg-sky-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-sky-400">
            Open File
          </button>
        </div>
      )}
      {transfer.status === "failed" && (
        <div className="mt-auto border-t border-slate-800 px-6 py-4">
          <button className="flex w-full items-center justify-center gap-2 rounded-lg border border-slate-700 px-4 py-2 text-sm font-medium text-slate-300 transition-colors hover:bg-slate-800">
            Retry
          </button>
        </div>
      )}
    </div>
  );
}
