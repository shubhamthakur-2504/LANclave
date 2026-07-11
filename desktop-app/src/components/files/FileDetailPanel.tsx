import type { SandboxFile } from "../../mockdata";

interface FileDetailPanelProps {
  file: SandboxFile;
}

function formatSize(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(1)} KB`;
  return `${bytes} B`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function FileDetailPanel({ file }: FileDetailPanelProps) {
  return (
    <div className="flex h-full flex-col">
      {/* Preview */}
      <div className="flex items-center justify-center border-b border-slate-800 px-6 py-12">
        <div className="flex h-24 w-24 items-center justify-center rounded-2xl bg-sky-500/10">
          <svg className="h-12 w-12 text-sky-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
          </svg>
        </div>
      </div>

      {/* File info */}
      <div className="px-6 py-4">
        <h3 className="text-lg font-semibold text-slate-100">{file.name}</h3>

        <dl className="mt-4 space-y-3">
          <div className="flex justify-between">
            <dt className="text-xs text-slate-500">Type</dt>
            <dd className="text-xs text-slate-300">
              {file.isDirectory ? "Directory" : file.mimeType}
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-xs text-slate-500">Size</dt>
            <dd className="text-xs text-slate-300">
              {file.isDirectory ? "—" : formatSize(file.size)}
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-xs text-slate-500">Modified</dt>
            <dd className="text-xs text-slate-300">
              {formatDate(file.modifiedAt)}
            </dd>
          </div>
        </dl>
      </div>

      {/* Actions */}
      <div className="mt-auto border-t border-slate-800 px-6 py-4">
        <div className="space-y-2">
          <button className="flex w-full items-center justify-center gap-2 rounded-lg bg-sky-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-sky-400">
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3" />
            </svg>
            Download
          </button>
          <button className="flex w-full items-center justify-center gap-2 rounded-lg border border-slate-700 px-4 py-2 text-sm font-medium text-slate-300 transition-colors hover:bg-slate-800">
            Send To&hellip;
          </button>
          <button className="flex w-full items-center justify-center gap-2 rounded-lg border border-red-800/50 px-4 py-2 text-sm font-medium text-red-400 transition-colors hover:bg-red-950/30">
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" />
            </svg>
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}
