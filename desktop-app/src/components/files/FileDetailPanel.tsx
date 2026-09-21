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
          <svg className="h-12 w-12 text-action" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
          </svg>
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
