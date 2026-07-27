/**
 * Local sandbox storage service — expo-file-system SDK 57 (new class-based API).
 *
 * Uses `Directory`, `File`, and `Paths` from `expo-file-system` instead of the
 * now-deprecated `*Async` helpers.
 *
 * All paths are validated to stay strictly inside `Paths.document` before any
 * I/O is performed (path-traversal protection).
 */

import { Directory, File, Paths } from "expo-file-system";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SandboxFileEntry {
  /** Display name (filename only, no path). */
  name: string;
  /** Full `file://` URI usable with Expo FileSystem or Image. */
  uri: string;
  /** File size in bytes. Directories report 0. */
  size: number;
  /** True when the entry is a directory. */
  isDirectory: boolean;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/** The app's persistent document directory. */
function documentDir(): Directory {
  return Paths.document;
}

/**
 * Resolve `filename` against the sandbox root, reject traversal sequences, and
 * return a `File` instance strictly inside the sandbox.
 *
 * @throws {Error} On path traversal attempts.
 */
function resolveSafeFile(filename: string): File {
  if (filename.includes("..")) {
    throw new Error(
      `storage: filename "${filename}" contains a path traversal sequence.`,
    );
  }

  // Strip leading slashes so the filename cannot be treated as absolute.
  const sanitised = filename.replace(/^\/+/, "");

  if (!sanitised) {
    throw new Error("storage: filename must not be empty.");
  }

  const file = new File(documentDir(), sanitised);

  // Final guard: ensure the resolved URI still starts with the document root.
  if (!file.uri.startsWith(documentDir().uri)) {
    throw new Error(
      `storage: resolved path "${file.uri}" escapes the sandbox root.`,
    );
  }

  return file;
}

/** Filter hidden / system files (names starting with "."). */
function isVisible(name: string): boolean {
  return !name.startsWith(".");
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * List the contents of the app's sandboxed document directory.
 *
 * Hidden files (names that start with ".") are filtered out. Returns a sorted
 * array — directories first, then files, each group sorted alphabetically.
 *
 * `Directory.list()` is synchronous in SDK 57; the async wrapper here is kept
 * so callers don't need to change their call-site if the API evolves.
 */
export async function getLocalSandboxFiles(): Promise<SandboxFileEntry[]> {
  const dir = documentDir();

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
      });
    } else {
      const file = item as File;
      entries.push({
        name,
        uri: file.uri,
        size: file.size,        // synchronous property in SDK 57
        isDirectory: false,
      });
    }
  }

  // Directories first, then alphabetically within each group.
  return entries.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/**
 * Copy an external file (e.g. from `expo-document-picker`) into the sandbox.
 *
 * `sourceUri` must be a valid `file://` URI accessible by the app.
 * `filename` is the target name inside the sandbox; must not contain `..`.
 *
 * @returns The `file://` URI of the newly saved file.
 * @throws On path traversal or copy failure.
 */
export async function saveToSandbox(
  sourceUri: string,
  filename: string,
): Promise<string> {
  const dest = resolveSafeFile(filename);
  const source = new File(sourceUri);

  try {
    // copy() is async and accepts a File or Directory as destination.
    await source.copy(dest);
  } catch (err) {
    throw new Error(
      `storage: Failed to copy "${filename}" into sandbox. ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return dest.uri;
}

/**
 * Delete a file from the sandbox by name.
 *
 * Silently succeeds if the file does not exist (idempotent).
 *
 * @throws On path traversal or deletion failure (other than file-not-found).
 */
export async function deleteFromSandbox(filename: string): Promise<void> {
  const target = resolveSafeFile(filename);

  if (!target.exists) return; // already gone — idempotent

  try {
    target.delete(); // synchronous in SDK 57
  } catch (err) {
    throw new Error(
      `storage: Failed to delete "${filename}" from sandbox. ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
