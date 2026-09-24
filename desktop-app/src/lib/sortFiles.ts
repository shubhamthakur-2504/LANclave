/**
 * File-list sorting, shared by the local sandbox and a peer's sandbox.
 * Folders always stay above files; the chosen key orders within each group.
 */

export type SortKey = "name" | "size" | "modified" | "type";
export type SortDir = "asc" | "desc";
export interface SortState {
  key: SortKey;
  dir: SortDir;
}

export const DEFAULT_SORT: SortState = { key: "name", dir: "asc" };

/** Direction a key starts in: A→Z for text, biggest/newest first for numbers. */
export const INITIAL_DIR: Record<SortKey, SortDir> = {
  name: "asc",
  type: "asc",
  size: "desc",
  modified: "desc",
};

/** Clicking the active key flips it; clicking another starts that key fresh. */
export function nextSort(current: SortState, key: SortKey): SortState {
  return current.key === key
    ? { key, dir: current.dir === "asc" ? "desc" : "asc" }
    : { key, dir: INITIAL_DIR[key] };
}

interface Sortable {
  name: string;
  size: number;
  is_directory: boolean;
  modified?: number | null;
}

// Numeric collation, so "photo (2)" sorts before "photo (10)".
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function extension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function sortFiles<T extends Sortable>(files: T[], sort: SortState): T[] {
  const sign = sort.dir === "asc" ? 1 : -1;
  const byName = (a: T, b: T) => collator.compare(a.name, b.name);

  return [...files].sort((a, b) => {
    if (a.is_directory !== b.is_directory) return a.is_directory ? -1 : 1;

    switch (sort.key) {
      case "size":
        return sign * (a.size - b.size) || byName(a, b);
      case "modified": {
        // Unknown dates go last whichever way the list runs.
        if (a.modified == null || b.modified == null) {
          return (a.modified == null ? 1 : 0) - (b.modified == null ? 1 : 0) || byName(a, b);
        }
        return sign * (a.modified - b.modified) || byName(a, b);
      }
      case "type":
        return sign * collator.compare(extension(a.name), extension(b.name)) || byName(a, b);
      default:
        return sign * byName(a, b);
    }
  });
}

const STORAGE_KEY = "lanclave.fileSort";

/** The last sort the user picked. Per-viewer convenience; falls back quietly. */
export function loadSort(): SortState {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (saved && saved.key in INITIAL_DIR && (saved.dir === "asc" || saved.dir === "desc")) {
      return saved;
    }
  } catch {
    // Storage unavailable or corrupt: use the default.
  }
  return DEFAULT_SORT;
}

export function saveSort(sort: SortState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sort));
  } catch {
    // Not persisting is fine.
  }
}
