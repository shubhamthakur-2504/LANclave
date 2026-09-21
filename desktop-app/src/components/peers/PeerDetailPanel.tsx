import { Check, Laptop, ShieldCheck } from "lucide-react";
import { colorForDevice, initialForDevice } from "../../lib/identity";
import type { PeerInfo } from "../../types";
import { pickFile } from "../../api";
import { useTransfers } from "../../contexts/TransferContext";

interface PeerDetailPanelProps {
  peer: PeerInfo;
  onOpenConnection: (peer: PeerInfo) => void;
  onBrowseFiles?: () => void;
}

function shortId(full: string): string {
  if (full.length <= 12) return full;
  return `${full.slice(0, 10)}…`;
}

export default function PeerDetailPanel({
  peer,
  onOpenConnection,
  onBrowseFiles,
}: PeerDetailPanelProps) {
  const { startUpload } = useTransfers();

  const handleSendFile = async () => {
    try {
      const relPath = await pickFile();
      if (!relPath) return; // User cancelled or selected file outside sandbox
      
      // In a real app, we might want to get the file size from the backend before starting
      // but for now we'll pass 0 and let the backend update it.
      // The remote path is just the filename for now (basename of relative path).
      const fileName = relPath.split('/').pop() || relPath;
      await startUpload(peer, relPath, fileName, 0);
    } catch (err) {
      console.error("Failed to pick or send file:", err);
      // To-do: show toast error if user picked outside sandbox
    }
  };

  return (
    <div className="flex h-full flex-col">
      {/* Profile header */}
      <div className="flex flex-col items-center border-b border-border px-6 py-8">
        <div
          className="mb-3 flex h-20 w-20 items-center justify-center rounded-full text-2xl font-bold"
          style={{
            backgroundColor: `${colorForDevice(peer.device_id)}22`,
            color: colorForDevice(peer.device_id),
          }}
        >
          {initialForDevice(peer.device_name) ?? (
            <Laptop className="h-9 w-9" strokeWidth={1.5} aria-hidden="true" />
          )}
        </div>
        <h3 className="text-lg font-semibold text-content">
          {peer.device_name || shortId(peer.device_id)}
        </h3>
        <p className="mt-0.5 text-xs text-content-faint">
          {peer.addr || <span className="text-content-faint italic">Offline / unreachable</span>}
        </p>
        <div className="mt-2">
          {peer.paired ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-ok/10 px-3 py-1 text-xs font-medium text-ok">
              <Check className="h-3 w-3" strokeWidth={2.5} aria-hidden="true" />
              Paired
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-full bg-warn/10 px-3 py-1 text-xs font-medium text-warn">
              Not paired
            </span>
          )}
        </div>
      </div>

      {/* Action buttons */}
      <div className="flex gap-3 border-b border-border px-6 py-4">
        <button
          onClick={onBrowseFiles}
          disabled={!peer.paired}
          className="flex-1 rounded-lg bg-action px-4 py-2 text-sm font-medium text-on-action transition-colors hover:bg-action-hover disabled:opacity-40"
        >
          Browse Files
        </button>
        <button
          onClick={handleSendFile}
          disabled={!peer.paired}
          className="flex-1 rounded-lg border border-border-strong px-4 py-2 text-sm font-medium text-content transition-colors hover:bg-surface-active disabled:opacity-40"
        >
          Send File
        </button>
      </div>

      {/* Info area */}
      <div className="flex-1 px-6 py-4">
        <h4 className="mb-3 text-xs font-semibold uppercase tracking-wider text-content-faint">
          Device Info
        </h4>
        <dl className="space-y-2">
          <div className="flex justify-between">
            <dt className="text-xs text-content-faint">Device ID</dt>
            <dd className="max-w-[180px] truncate text-xs text-content font-mono">
              {peer.device_id}
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-xs text-content-faint">Address</dt>
            <dd className="text-xs text-content">{peer.addr}</dd>
          </div>
        </dl>
      </div>

      {/* Pair device */}
      <div className="border-t border-border px-6 py-4">
        <button
          onClick={() => onOpenConnection(peer)}
          disabled={peer.paired}
          className="flex w-full items-center justify-center gap-2 rounded-lg border border-action/30 bg-action/5 px-4 py-2.5 text-sm font-medium text-action transition-colors hover:bg-action/10 disabled:opacity-40"
        >
          <ShieldCheck className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
          {peer.paired ? "Already Paired" : "Pair Device"}
        </button>
      </div>
    </div>
  );
}
