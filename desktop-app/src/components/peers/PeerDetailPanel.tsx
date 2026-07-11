import type { Peer } from "../../mockdata";
import StatusDot from "../ui/StatusDot";

interface PeerDetailPanelProps {
  peer: Peer;
  onOpenConnection: () => void;
}

function formatSize(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(1)} KB`;
  return `${bytes} B`;
}

export default function PeerDetailPanel({
  peer,
  onOpenConnection,
}: PeerDetailPanelProps) {
  return (
    <div className="flex h-full flex-col">
      {/* Profile header */}
      <div className="flex flex-col items-center border-b border-slate-800 px-6 py-8">
        <div className="mb-3 flex h-20 w-20 items-center justify-center rounded-full bg-sky-500/20 text-2xl font-bold text-sky-400">
          {peer.name[0]}
        </div>
        <h3 className="text-lg font-semibold text-slate-100">{peer.name}</h3>
        <div className="mt-1 flex items-center gap-1.5 text-sm text-slate-400">
          <StatusDot status={peer.status} />
          <span className="capitalize">{peer.status}</span>
        </div>
        <p className="mt-0.5 text-xs text-slate-500">
          {peer.deviceType} &middot; {peer.ipAddress}
        </p>
      </div>

      {/* Action buttons */}
      <div className="flex gap-3 border-b border-slate-800 px-6 py-4">
        <button className="flex-1 rounded-lg bg-sky-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-sky-400">
          Send File
        </button>
        <button className="flex-1 rounded-lg border border-slate-700 px-4 py-2 text-sm font-medium text-slate-300 transition-colors hover:bg-slate-800">
          Chat
        </button>
      </div>

      {/* Shared files */}
      <div className="flex-1 px-6 py-4">
        <h4 className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-500">
          Shared Files
        </h4>
        {peer.sharedFiles.length === 0 ? (
          <p className="text-sm text-slate-600">No shared files</p>
        ) : (
          <div className="space-y-2">
            {peer.sharedFiles.map((file) => (
              <div
                key={file.id}
                className="flex items-center gap-3 rounded-lg bg-slate-800/30 px-3 py-2"
              >
                <svg
                  className="h-5 w-5 shrink-0 text-sky-400"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={1.5}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z"
                  />
                </svg>
                <div className="flex-1 min-w-0">
                  <p className="truncate text-sm text-slate-300">{file.name}</p>
                  <p className="text-xs text-slate-500">{formatSize(file.size)}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Pair device */}
      <div className="border-t border-slate-800 px-6 py-4">
        <button
          onClick={onOpenConnection}
          className="flex w-full items-center justify-center gap-2 rounded-lg border border-sky-500/30 bg-sky-500/5 px-4 py-2.5 text-sm font-medium text-sky-400 transition-colors hover:bg-sky-500/10"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75 11.25 15 15 9.75m-3-7.036A11.959 11.959 0 0 1 3.598 6 11.99 11.99 0 0 0 3 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285Z" />
          </svg>
          Pair Device
        </button>
      </div>
    </div>
  );
}
