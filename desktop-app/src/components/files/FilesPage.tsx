import { useState } from "react";
import type { SandboxFile } from "../../mockdata";
import FileListPanel from "./FileListPanel";
import FileDetailPanel from "./FileDetailPanel";
import EmptyState from "../ui/EmptyState";

interface FilesPageProps {
  files: SandboxFile[];
}

export default function FilesPage({ files }: FilesPageProps) {
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null);
  const selectedFile = files.find((f) => f.id === selectedFileId) ?? null;

  return (
    <div className="flex h-full">
      <div className="w-96 shrink-0 border-r border-slate-800">
        <FileListPanel
          files={files}
          selectedId={selectedFileId}
          onSelect={setSelectedFileId}
        />
      </div>
      <div className="flex-1">
        {selectedFile ? (
          <FileDetailPanel file={selectedFile} />
        ) : (
          <EmptyState message="Select a file to view details" />
        )}
      </div>
    </div>
  );
}
