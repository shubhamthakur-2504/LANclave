import type { PeerInfo } from "../../types";
import PeersListPanel from "./PeersListPanel";
import EmptyState from "../ui/EmptyState";

interface PeersPageProps {
  peers: PeerInfo[];
  onOpenConnection: (peer: PeerInfo) => void;
  onBrowseFiles?: (peer: PeerInfo) => void;
}

export default function PeersPage({ peers, onOpenConnection, onBrowseFiles }: PeersPageProps) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-4 border-b border-slate-800 bg-slate-900/50 px-6 py-4">
        <div>
          <h2 className="text-lg font-semibold text-slate-100">Network Peers</h2>
          <p className="text-xs text-slate-400">Other LANclave devices on your network</p>
        </div>
      </div>
      
      <div className="flex-1 overflow-hidden">
        {peers.length === 0 ? (
          <EmptyState message="No peers found on network" />
        ) : (
          <PeersListPanel
            peers={peers}
            onConnect={onOpenConnection}
            onBrowseFiles={onBrowseFiles}
          />
        )}
      </div>
    </div>
  );
}
