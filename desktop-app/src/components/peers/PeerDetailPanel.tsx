import type { PeerInfo } from "../../types";

interface PeerDetailPanelProps {
  peer: PeerInfo;
  onOpenConnection: (peer: PeerInfo) => void;
  onBrowseFiles?: () => void;
}

function shortId(full: string): string {
  if (full.length <= 12) return full;
  return `${full.slice(0, 10)}…`;
}

export default function PeerDetailPanel({
  peer,
  onOpenConnection,
  onBrowseFiles,
}: PeerDetailPanelProps) {
  return (
    <div className="flex h-full flex-col">
      {/* Profile header */}
      <div className="flex flex-col items-center border-b border-slate-800 px-6 py-8">
        <div className="mb-3 flex h-20 w-20 items-center justify-center rounded-full bg-sky-500/20 text-2xl font-bold text-sky-400">
          {(peer.device_name?.[0] ?? peer.addr[0] ?? peer.device_id[0] ?? "?").toUpperCase()}
        </div>
        <h3 className="text-lg font-semibold text-slate-100">
          {peer.device_name || shortId(peer.device_id)}
        </h3>
        <p className="mt-0.5 text-xs text-slate-500">
          {peer.addr || <span className="text-slate-600 italic">Offline / unreachable</span>}
        </p>
        <div className="mt-2">
          {peer.paired ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-400/10 px-3 py-1 text-xs font-medium text-emerald-400">
              <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
              </svg>
              Paired
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-400/10 px-3 py-1 text-xs font-medium text-amber-400">
              Not paired
            </span>
          )}
        </div>
      </div>

      {/* Action buttons */}
      <div className="flex gap-3 border-b border-slate-800 px-6 py-4">
        <button
          onClick={onBrowseFiles}
          disabled={!peer.paired}
          className="flex-1 rounded-lg bg-sky-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-sky-400 disabled:opacity-40"
        >
          Browse Files
        </button>
        <button
          disabled={!peer.paired}
          className="flex-1 rounded-lg border border-slate-700 px-4 py-2 text-sm font-medium text-slate-300 transition-colors hover:bg-slate-800 disabled:opacity-40"
        >
          Send File
        </button>
      </div>

      {/* Info area */}
      <div className="flex-1 px-6 py-4">
        <h4 className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-500">
          Device Info
        </h4>
        <dl className="space-y-2">
          <div className="flex justify-between">
            <dt className="text-xs text-slate-500">Device ID</dt>
            <dd className="max-w-[180px] truncate text-xs text-slate-300 font-mono">
              {peer.device_id}
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-xs text-slate-500">Address</dt>
            <dd className="text-xs text-slate-300">{peer.addr}</dd>
          </div>
        </dl>
      </div>

      {/* Pair device */}
      <div className="border-t border-slate-800 px-6 py-4">
        <button
          onClick={() => onOpenConnection(peer)}
          disabled={peer.paired}
          className="flex w-full items-center justify-center gap-2 rounded-lg border border-sky-500/30 bg-sky-500/5 px-4 py-2.5 text-sm font-medium text-sky-400 transition-colors hover:bg-sky-500/10 disabled:opacity-40"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75 11.25 15 15 9.75m-3-7.036A11.959 11.959 0 0 1 3.598 6 11.99 11.99 0 0 0 3 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285Z" />
          </svg>
          {peer.paired ? "Already Paired" : "Pair Device"}
        </button>
      </div>
    </div>
  );
}
