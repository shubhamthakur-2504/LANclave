import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { PeerInfo } from "../../types";
import { deviceTag } from "../../lib/identity";
import PeersListPanel from "./PeersListPanel";
import EmptyState from "../ui/EmptyState";
import ScanAnimation from "../brand/ScanAnimation";

interface PeersPageProps {
  peers: PeerInfo[];
  onOpenConnection: (peer: PeerInfo) => void;
  onBrowseFiles?: (peer: PeerInfo) => void;
  /** Pick files and offer them to this peer. */
  onSendFiles?: (peer: PeerInfo) => void;
  isScanning?: boolean;
  onScan?: () => void;
  onRescanPeer?: (peer: PeerInfo) => void;
  dropTargetId?: string | null;
}

export default function PeersPage({
  peers,
  onOpenConnection,
  onBrowseFiles,
  onSendFiles,
  isScanning = false,
  onScan,
  onRescanPeer,
  dropTargetId = null,
}: PeersPageProps) {
  // The name and tag other devices list this one under, so two people can
  // tell each other which card to pick.
  const [self, setSelf] = useState<{ name: string; tag: string } | null>(null);
  useEffect(() => {
    Promise.all([
      invoke<{ display_name: string }>("get_settings"),
      invoke<string>("get_device_id"),
    ])
      .then(([settings, id]) => setSelf({ name: settings.display_name, tag: deviceTag(id) }))
      .catch(() => setSelf(null));
  }, []);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-4 border-b border-border bg-surface-raised px-6 py-4">
        <div className="flex-1">
          <h2 className="text-lg font-semibold text-content">Network Peers</h2>
          <p className="text-xs text-content-muted">
            Other LANclave devices on your network
            {self && (
              <>
                {" · You appear as "}
                <span className="text-content">{self.name}</span>{" "}
                <span className="font-mono">{self.tag}</span>
              </>
            )}
          </p>
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
          <EmptyState
            kind="peers"
            visual={isScanning ? <div className="mb-2"><ScanAnimation size={200} /></div> : undefined}
            message={isScanning ? "Scanning the network…" : undefined}
            hint={isScanning ? "Checking every address on this network." : undefined}
            action={
              !isScanning && onScan ? (
                <button
                  type="button"
                  onClick={onScan}
                  className="rounded-md bg-action px-4 py-2 text-xs font-medium text-on-action transition-colors hover:bg-action-hover"
                >
                  Scan for devices
                </button>
              ) : undefined
            }
          />
        ) : (
          <div className="flex h-full flex-col">
            {/* Scanning with devices already listed (the usual case: paired
                devices are always here). The empty state above only covers
                a list with nothing in it. */}
            {isScanning && (
              <div
                className="flex items-center gap-4 border-b border-border bg-surface-raised px-6 py-3"
                aria-live="polite"
              >
                <ScanAnimation size={128} />
                <div>
                  <p className="text-sm font-medium text-content">Looking for nearby devices…</p>
                  <p className="mt-0.5 text-xs text-content-faint">
                    Checking every address on this network. New devices appear under Nearby.
                  </p>
                </div>
              </div>
            )}
            <div className="min-h-0 flex-1">
              <PeersListPanel
                peers={peers}
                onConnect={onOpenConnection}
                onBrowseFiles={onBrowseFiles}
                onSendFiles={onSendFiles}
                onRescanPeer={onRescanPeer}
                dropTargetId={dropTargetId}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
