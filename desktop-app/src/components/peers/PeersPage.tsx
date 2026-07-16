import { useState } from "react";
import type { PeerInfo } from "../../types";
import PeersListPanel from "./PeersListPanel";
import PeerDetailPanel from "./PeerDetailPanel";
import EmptyState from "../ui/EmptyState";

interface PeersPageProps {
  peers: PeerInfo[];
  onOpenConnection: (peer: PeerInfo) => void;
}

export default function PeersPage({ peers, onOpenConnection }: PeersPageProps) {
  const [selectedPeerId, setSelectedPeerId] = useState<string | null>(null);
  const selectedPeer = peers.find((p) => p.device_id === selectedPeerId) ?? null;

  return (
    <div className="flex h-full">
      <div className="w-80 shrink-0 border-r border-slate-800">
        <PeersListPanel
          peers={peers}
          selectedId={selectedPeerId}
          onSelect={setSelectedPeerId}
        />
      </div>
      <div className="flex-1">
        {selectedPeer ? (
          <PeerDetailPanel
            peer={selectedPeer}
            onOpenConnection={() => onOpenConnection(selectedPeer)}
          />
        ) : (
          <EmptyState message="Select a peer to view details" />
        )}
      </div>
    </div>
  );
}
