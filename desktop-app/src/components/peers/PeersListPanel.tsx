import type { PeerInfo } from "../../types";

interface PeersListPanelProps {
  peers: PeerInfo[];
  selectedId: string | null;
  onSelect: (deviceId: string) => void;
}

function shortId(full: string): string {
  if (full.length <= 12) return full;
  return `${full.slice(0, 8)}…`;
}

function PeerRow({
  peer,
  isSelected,
  onSelect,
}: {
  peer: PeerInfo;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const isOnline = peer.addr !== "";
  return (
    <button
      onClick={onSelect}
      className={`flex w-full items-center gap-3 border-b border-slate-800/50 px-5 py-3 text-left transition-colors ${
        isSelected ? "bg-sky-500/10" : "hover:bg-slate-800/30"
      }`}
    >
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
            {shortId(peer.device_id)}
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
    </button>
  );
}

export default function PeersListPanel({
  peers,
  selectedId,
  onSelect,
}: PeersListPanelProps) {
  const paired = peers.filter((p) => p.paired);
  const nearby = peers.filter((p) => !p.paired);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-slate-800 px-5 py-3">
        <h2 className="text-sm font-semibold text-slate-200">Peers</h2>
        <span className="text-xs text-slate-500">{peers.length} total</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* ── Paired Devices ── */}
        {paired.length > 0 && (
          <>
            <div className="px-5 pt-3 pb-1">
              <span className="text-[10px] font-semibold uppercase tracking-widest text-emerald-500">
                Paired Devices
              </span>
            </div>
            {paired.map((peer) => (
              <PeerRow
                key={peer.device_id}
                peer={peer}
                isSelected={peer.device_id === selectedId}
                onSelect={() => onSelect(peer.device_id)}
              />
            ))}
          </>
        )}

        {/* ── Nearby (unpaired) ── */}
        {nearby.length > 0 && (
          <>
            <div className="px-5 pt-3 pb-1">
              <span className="text-[10px] font-semibold uppercase tracking-widest text-sky-500">
                Nearby (unpaired)
              </span>
            </div>
            {nearby.map((peer) => (
              <PeerRow
                key={peer.device_id}
                peer={peer}
                isSelected={peer.device_id === selectedId}
                onSelect={() => onSelect(peer.device_id)}
              />
            ))}
          </>
        )}

        {peers.length === 0 && (
          <div className="p-6 text-center text-xs text-slate-500">
            No peers found — make sure server is running on both devices
          </div>
        )}
      </div>
    </div>
  );
}
