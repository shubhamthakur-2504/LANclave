import { useState } from "react";
import type { FileEntry } from "../../types";
import FileListPanel from "./FileListPanel";
import FileDetailPanel from "./FileDetailPanel";
import EmptyState from "../ui/EmptyState";

interface FilesPageProps {
  files: FileEntry[];
}

export default function FilesPage({ files }: FilesPageProps) {
  const [selectedFile, setSelectedFile] = useState<FileEntry | null>(null);

  return (
    <div className="flex h-full">
      <div className="w-96 shrink-0 border-r border-slate-800">
        <FileListPanel
          files={files}
          selectedName={selectedFile?.name ?? null}
          onSelect={(name) => {
            const f = files.find((x) => x.name === name) ?? null;
            setSelectedFile(f);
          }}
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
