import type { FileEntry } from "../../types";
import FileListPanel from "./FileListPanel";
import EmptyState from "../ui/EmptyState";

interface FilesPageProps {
  files: FileEntry[];
  /** True while files are being dragged over the window (U3.1). */
  isDropping?: boolean;
}

export default function FilesPage({ files, isDropping = false }: FilesPageProps) {
  return (
    <div
      className={`flex h-full flex-col ${
        isDropping ? "ring-2 ring-inset ring-action" : ""
      }`}
    >
      <div className="flex items-center gap-4 border-b border-border bg-surface-raised px-6 py-4">
        <div>
          <h2 className="text-lg font-semibold text-content">Local Sandbox</h2>
          <p className="text-xs text-content-muted">Files stored on this computer</p>
        </div>
      </div>
      
      <div className="flex-1 overflow-hidden">
        {isDropping ? (
          <div className="flex h-full items-center justify-center text-sm text-action">
            Drop files to add them to your sandbox
          </div>
        ) : files.length === 0 ? (
          <EmptyState kind="files" />
        ) : (
          <FileListPanel files={files} />
        )}
      </div>
    </div>
  );
}
