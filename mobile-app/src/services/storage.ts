/**
 * Local sandbox storage service — expo-file-system SDK 57 (new class-based API).
 *
 * Uses `Directory`, `File`, and `Paths` from `expo-file-system` instead of the
 * now-deprecated `*Async` helpers.
 *
 * All paths are validated to stay strictly inside the sandbox folder before any
 * I/O is performed (path-traversal protection).
 */

import { Directory, File } from "expo-file-system";
import { getSettings } from "./settings";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SandboxFileEntry {
  name: string;
  uri: string;
  size: number;
  isDirectory: boolean;
  /** Last modified, Unix ms, for sorting. Null when the platform can't say. */
  modified: number | null;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

async function getSandboxDir(): Promise<Directory> {
  const settings = await getSettings();
  return new Directory(settings.sandboxPath);
}

function resolveSafeFile(sandboxDir: Directory, filename: string): File {
  if (filename.includes("..")) {
    throw new Error(
      `storage: filename "${filename}" contains a path traversal sequence.`,
    );
  }

  const sanitised = filename.replace(/^\/+/, "");

  if (!sanitised) {
    throw new Error("storage: filename must not be empty.");
  }

  const file = new File(sandboxDir, sanitised);

  if (!file.uri.startsWith(sandboxDir.uri)) {
    throw new Error(
      `storage: resolved path "${file.uri}" escapes the sandbox root.`,
    );
  }

  return file;
}

function isVisible(name: string): boolean {
  return !name.startsWith(".");
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function getLocalSandboxFiles(): Promise<SandboxFileEntry[]> {
  const dir = await getSandboxDir();

  let items: (File | Directory)[];
  try {
    items = dir.list();
  } catch (err) {
    console.warn("[storage] Failed to list sandbox directory:", err);
    return [];
  }

  const entries: SandboxFileEntry[] = [];

  for (const item of items) {
    const isDir = item instanceof Directory;
    const name = item.name;

    if (!isVisible(name)) continue;

    if (isDir) {
      entries.push({
        name,
        uri: item.uri,
        size: 0,
        isDirectory: true,
        modified: null,
      });
    } else {
      const file = item as File;
      entries.push({
        name,
        uri: file.uri,
        size: file.size,
        isDirectory: false,
        modified: file.modificationTime ?? null,
      });
    }
  }

  return entries.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

export async function saveToSandbox(
  sourceUri: string,
  filename: string,
): Promise<string> {
  const sandboxDir = await getSandboxDir();
  const dest = resolveSafeFile(sandboxDir, filename);
  const source = new File(sourceUri);

  try {
    await source.copy(dest);
  } catch (err) {
    throw new Error(
      `storage: Failed to copy "${filename}" into sandbox. ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return dest.uri;
}

export async function deleteFromSandbox(filename: string): Promise<void> {
  const sandboxDir = await getSandboxDir();
  const target = resolveSafeFile(sandboxDir, filename);

  if (!target.exists) return;

  try {
    target.delete();
  } catch (err) {
    throw new Error(
      `storage: Failed to delete "${filename}" from sandbox. ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
