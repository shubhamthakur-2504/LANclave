import type { PeerInfo } from "../../types";
import PeersListPanel from "./PeersListPanel";
import EmptyState from "../ui/EmptyState";

interface PeersPageProps {
  peers: PeerInfo[];
  onOpenConnection: (peer: PeerInfo) => void;
  onBrowseFiles?: (peer: PeerInfo) => void;
  isScanning?: boolean;
  onScan?: () => void;
  onRescanPeer?: (peer: PeerInfo) => void;
}

export default function PeersPage({
  peers,
  onOpenConnection,
  onBrowseFiles,
  isScanning = false,
  onScan,
  onRescanPeer,
}: PeersPageProps) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-4 border-b border-slate-800 bg-slate-900/50 px-6 py-4">
        <div className="flex-1">
          <h2 className="text-lg font-semibold text-slate-100">Network Peers</h2>
          <p className="text-xs text-slate-400">Other LANclave devices on your network</p>
        </div>
        {onScan && (
          <button
            type="button"
            onClick={onScan}
            disabled={isScanning}
            className="rounded-md bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isScanning ? "Scanning..." : "Scan"}
          </button>
        )}
      </div>
      
      <div className="flex-1 overflow-hidden">
        {peers.length === 0 ? (
          <EmptyState message={isScanning ? "Scanning network..." : "No peers found - tap Scan to search"} />
        ) : (
          <PeersListPanel
            peers={peers}
            onConnect={onOpenConnection}
            onBrowseFiles={onBrowseFiles}
            onRescanPeer={onRescanPeer}
          />
        )}
      </div>
    </div>
  );
}
