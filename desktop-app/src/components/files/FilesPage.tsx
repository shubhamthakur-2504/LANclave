import { useState } from "react";
import type { FileEntry, PeerInfo } from "../../types";
import * as api from "../../api";
import { useOffers } from "../../contexts/OffersContext";
import { useTransfers } from "../../contexts/TransferContext";
import FileListPanel from "./FileListPanel";
import FileDetailPanel from "./FileDetailPanel";
import EmptyState from "../ui/EmptyState";
import { useToast } from "../ui/Toast";

interface FilesPageProps {
  files: FileEntry[];
  /** Paired peers, for "Send to". */
  peers: PeerInfo[];
  /** True while files are being dragged over the window (U3.1). */
  isDropping?: boolean;
}

export default function FilesPage({ files, peers, isDropping = false }: FilesPageProps) {
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const selected = files.find((f) => f.name === selectedName && !f.is_directory) ?? null;
  const { sendFiles } = useOffers();
  const { startUpload } = useTransfers();
  const toast = useToast();

  const sendTargets = peers.filter((p) => p.paired && p.addr !== "" && !p.untrusted);

  /**
   * Open with the default app. A program or script from a peer is not
   * opened on a double-click: say who sent it and ask first.
   */
  const openFile = async (name: string) => {
    try {
      const result = await api.openSandboxFile(name, false);
      if (result.kind === "confirm") {
        const who = result.sender ? `${result.sender} sent this file.` : "This file came from another device.";
        const ok = await api.confirmAction(
          `${who} It can run programs on this computer. Only open it if you trust it.`,
          { title: `Open ${name}?`, okLabel: "Open anyway" },
        );
        if (ok) await api.openSandboxFile(name, true);
      }
    } catch (err) {
      toast.error(err, name);
    }
  };

  const sendTo = async (peer: PeerInfo, name: string) => {
    const who = peer.device_name || "peer";
    try {
      if ((await sendFiles(peer, [name])) === "offer") {
        toast.success(`Offered ${name} to ${who}.`, "It will be sent once accepted.");
      } else {
        await startUpload(peer, name, name);
      }
    } catch (err) {
      toast.error(err, who);
    }
  };

  return (
    <div
      className={`flex h-full flex-col ${
        isDropping ? "ring-2 ring-inset ring-action" : ""
      }`}
    >
      <div className="flex items-center gap-4 border-b border-border bg-surface-raised px-6 py-4">
        <div>
          <h2 className="text-lg font-semibold text-content">Local Sandbox</h2>
          <p className="text-xs text-content-muted">Files stored on this computer · double-click to open</p>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-hidden">
          {isDropping ? (
            <div className="flex h-full items-center justify-center text-sm text-action">
              Drop files to add them to your sandbox
            </div>
          ) : files.length === 0 ? (
            <EmptyState kind="files" />
          ) : (
            <FileListPanel
              files={files}
              selectedName={selected?.name ?? null}
              onSelect={setSelectedName}
              onOpen={openFile}
            />
          )}
        </div>
        {selected && !isDropping && (
          <aside className="w-72 shrink-0 border-l border-border bg-surface-raised">
            <FileDetailPanel
              file={selected}
              sendTargets={sendTargets}
              onOpen={() => openFile(selected.name)}
              onReveal={() => api.revealInSandbox(selected.name).catch((err) => toast.error(err))}
              onSend={(peer) => sendTo(peer, selected.name)}
              onClose={() => setSelectedName(null)}
            />
          </aside>
        )}
      </div>
    </div>
  );
}
