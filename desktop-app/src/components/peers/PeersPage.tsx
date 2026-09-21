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
  dropTargetId?: string | null;
}

export default function PeersPage({
  peers,
  onOpenConnection,
  onBrowseFiles,
  isScanning = false,
  onScan,
  onRescanPeer,
  dropTargetId = null,
}: PeersPageProps) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-4 border-b border-border bg-surface-raised px-6 py-4">
        <div className="flex-1">
          <h2 className="text-lg font-semibold text-content">Network Peers</h2>
          <p className="text-xs text-content-muted">Other LANclave devices on your network</p>
        </div>
        {onScan && (
          <button
            type="button"
            onClick={onScan}
            disabled={isScanning}
            className="rounded-md bg-surface-active px-3 py-1.5 text-xs font-medium text-content hover:bg-border-strong disabled:cursor-not-allowed disabled:opacity-50"
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
            dropTargetId={dropTargetId}
          />
        )}
      </div>
    </div>
  );
}
