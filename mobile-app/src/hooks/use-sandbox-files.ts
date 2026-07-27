/**
 * useSandboxFiles — React hook for the device's local sandbox file list.
 *
 * Wraps `getLocalSandboxFiles` from the storage service and manages loading
 * state. Automatically fetches the file list on mount and exposes a
 * `refreshFiles` callback so screens can trigger a reload (e.g. after a
 * download or document-picker import).
 *
 * Usage:
 *   const { files, isLoading, refreshFiles } = useSandboxFiles();
 */

import { useCallback, useEffect, useState } from "react";

import { SandboxFileEntry, getLocalSandboxFiles } from "@/services/storage";

// ─── Return type ──────────────────────────────────────────────────────────────

export interface UseSandboxFilesResult {
  /** Current list of files in the sandbox directory. */
  files: SandboxFileEntry[];
  /** True while a read is in progress. */
  isLoading: boolean;
  /** Manually trigger a re-read of the sandbox directory. */
  refreshFiles: () => Promise<void>;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useSandboxFiles(): UseSandboxFilesResult {
  const [files, setFiles] = useState<SandboxFileEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const refreshFiles = useCallback(async () => {
    setIsLoading(true);
    try {
      const result = await getLocalSandboxFiles();
      setFiles(result);
    } catch (err) {
      // getLocalSandboxFiles swallows individual stat errors internally;
      // this catch is a safety net for unexpected failures.
      console.warn("[useSandboxFiles] Unexpected error:", err);
      setFiles([]);
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Load on mount.
  useEffect(() => {
    refreshFiles();
  }, [refreshFiles]);

  return { files, isLoading, refreshFiles };
}
