import type { Peer } from "../../mockdata";
import StatusDot from "../ui/StatusDot";

interface PeersListPanelProps {
  peers: Peer[];
  selectedId: string | null;
  onSelect: (id: string) => void;
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
        {peers.map((peer) => {
          const isSelected = peer.id === selectedId;
          return (
            <button
              key={peer.id}
              onClick={() => onSelect(peer.id)}
              className={`flex w-full items-center gap-3 border-b border-slate-800/50 px-5 py-3 text-left transition-colors ${
                isSelected
                  ? "bg-sky-500/10"
                  : "hover:bg-slate-800/30"
              }`}
            >
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-sky-500/20 text-sm font-semibold text-sky-400">
                {peer.name[0]}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium text-slate-200">
                    {peer.name}
                  </span>
                  <StatusDot status={peer.status} />
                </div>
                <p className="truncate text-xs text-slate-500">
                  {peer.status === "online"
                    ? "Online"
                    : peer.status === "away"
                      ? "Away"
                      : "Offline"}
                </p>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
