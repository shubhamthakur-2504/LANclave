import { FileText } from "lucide-react";
import type { FileEntry } from "../../types";

interface FileDetailPanelProps {
  file: FileEntry;
}

function formatSize(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(1)} KB`;
  return `${bytes} B`;
}

export default function FileDetailPanel({ file }: FileDetailPanelProps) {
  return (
    <div className="flex h-full flex-col">
      {/* Preview */}
      <div className="flex items-center justify-center border-b border-border px-6 py-12">
        <div className="flex h-24 w-24 items-center justify-center rounded-2xl bg-action/10">
          <FileText className="h-12 w-12 text-action" strokeWidth={1.5} aria-hidden="true" />
        </div>
      </div>

      {/* File info */}
      <div className="px-6 py-4">
        <h3 className="text-lg font-semibold text-content">{file.name}</h3>

        <dl className="mt-4 space-y-3">
          <div className="flex justify-between">
            <dt className="text-xs text-content-faint">Type</dt>
            <dd className="text-xs text-content">
              {file.is_directory ? "Directory" : "—"}
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-xs text-content-faint">Size</dt>
            <dd className="text-xs text-content">
              {file.is_directory ? "—" : formatSize(file.size)}
            </dd>
          </div>
        </dl>
      </div>

      {/* Actions */}
      <div className="mt-auto border-t border-border px-6 py-4">
        <div className="space-y-2">
          <button className="flex w-full items-center justify-center gap-2 rounded-lg border border-border-strong px-4 py-2 text-sm font-medium text-content transition-colors hover:bg-surface-active">
            Send To&hellip;
          </button>
        </div>
      </div>
    </div>
  );
}
