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

export default function PeersListPanel({
  peers,
  selectedId,
  onSelect,
}: PeersListPanelProps) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-slate-800 px-5 py-3">
        <h2 className="text-sm font-semibold text-slate-200">Peers</h2>
        <svg
          className="h-4 w-4 text-slate-500"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={1.5}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z"
          />
        </svg>
      </div>

      <div className="flex-1 overflow-y-auto">
        {peers.length === 0 && (
          <div className="p-6 text-center text-xs text-slate-500">
            No peers found on the LAN
          </div>
        )}
        {peers.map((peer) => {
          const isSelected = peer.device_id === selectedId;
          return (
            <button
              key={peer.device_id}
              onClick={() => onSelect(peer.device_id)}
              className={`flex w-full items-center gap-3 border-b border-slate-800/50 px-5 py-3 text-left transition-colors ${
                isSelected ? "bg-sky-500/10" : "hover:bg-slate-800/30"
              }`}
            >
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-sky-500/20 text-sm font-semibold text-sky-400">
                {peer.addr[0].toUpperCase()}
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
                  {peer.addr}
                </p>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
