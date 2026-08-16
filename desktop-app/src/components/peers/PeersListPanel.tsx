import type { PeerInfo } from "../../types";

interface PeersListPanelProps {
  peers: PeerInfo[];
  onConnect: (peer: PeerInfo) => void;
  onBrowseFiles?: (peer: PeerInfo) => void;
}

function shortId(full: string): string {
  if (full.length <= 12) return full;
  return `${full.slice(0, 8)}…`;
}

function PeerRow({
  peer,
  onConnect,
  onBrowseFiles,
}: {
  peer: PeerInfo;
  onConnect: () => void;
  onBrowseFiles: (() => void) | undefined;
}) {
  const isOnline = peer.addr !== "";
  return (
    <div className="flex w-full items-center gap-3 border-b border-slate-800/50 px-5 py-3 text-left transition-colors hover:bg-slate-800/10">
      <div className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-sky-500/20 text-sm font-semibold text-sky-400">
        {shortId(peer.device_id)[0].toUpperCase()}
        {/* Online dot */}
        <span
          className={`absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full border-2 border-slate-900 ${
            isOnline ? "bg-emerald-400" : "bg-slate-600"
          }`}
        />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-slate-200">
            {peer.device_name || `${peer.device_id.substring(0, 8)}...`}
          </span>
          {peer.paired && (
            <span className="inline-flex shrink-0 items-center rounded-full bg-emerald-400/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-400">
              Paired
            </span>
          )}
        </div>
        <p className="truncate text-xs text-slate-500">
          {peer.addr || "Offline / unreachable"}
        </p>
      </div>
      
      {/* Actions */}
      <div className="shrink-0 flex gap-2">
        {peer.paired ? (
          <button
            onClick={onBrowseFiles}
            disabled={!isOnline}
            className="rounded-lg bg-sky-500 px-4 py-1.5 text-xs font-medium text-white transition-colors hover:bg-sky-400 disabled:opacity-50"
          >
            Browse Files
          </button>
        ) : (
          <button
            onClick={onConnect}
            disabled={!isOnline}
            className="rounded-lg border border-slate-700 bg-slate-800 px-4 py-1.5 text-xs font-medium text-slate-300 transition-colors hover:bg-slate-700 disabled:opacity-50"
          >
            Connect
          </button>
        )}
      </div>
    </div>
  );
}

export default function PeersListPanel({
  peers,
  onConnect,
  onBrowseFiles,
}: PeersListPanelProps) {
  const paired = peers.filter((p) => p.paired);
  const nearby = peers.filter((p) => !p.paired);

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto">
        {/* ── Paired Devices ── */}
        {paired.length > 0 && (
          <>
            <div className="px-5 pt-3 pb-1 border-b border-slate-800">
              <span className="text-[10px] font-semibold uppercase tracking-widest text-emerald-500">
                Paired Devices
              </span>
            </div>
            {paired.map((peer) => (
              <PeerRow
                key={peer.device_id}
                peer={peer}
                onConnect={() => onConnect(peer)}
                onBrowseFiles={() => onBrowseFiles?.(peer)}
              />
            ))}
          </>
        )}

        {/* ── Nearby (unpaired) ── */}
        {nearby.length > 0 && (
          <>
            <div className="px-5 pt-4 pb-1 border-b border-slate-800 mt-2">
              <span className="text-[10px] font-semibold uppercase tracking-widest text-sky-500">
                Nearby (unpaired)
              </span>
            </div>
            {nearby.map((peer) => (
              <PeerRow
                key={peer.device_id}
                peer={peer}
                onConnect={() => onConnect(peer)}
                onBrowseFiles={() => onBrowseFiles?.(peer)}
              />
            ))}
          </>
        )}
      </div>
    </div>
  );
}
