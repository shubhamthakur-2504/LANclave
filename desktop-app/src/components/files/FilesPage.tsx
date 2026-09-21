import type { FileEntry } from "../../types";
import FileListPanel from "./FileListPanel";
import EmptyState from "../ui/EmptyState";

interface FilesPageProps {
  files: FileEntry[];
}

export default function FilesPage({ files }: FilesPageProps) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-4 border-b border-border bg-surface-raised px-6 py-4">
        <div>
          <h2 className="text-lg font-semibold text-content">Local Sandbox</h2>
          <p className="text-xs text-content-muted">Files stored on this computer</p>
        </div>
      </div>
      
      <div className="flex-1 overflow-hidden">
        {files.length === 0 ? (
          <EmptyState message="Your local sandbox is empty" />
        ) : (
          <FileListPanel files={files} />
        )}
      </div>
    </div>
  );
}
