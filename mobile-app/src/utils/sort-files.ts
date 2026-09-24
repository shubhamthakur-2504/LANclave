/**
 * File-list sorting for the local sandbox and a peer's sandbox — same rules
 * as the desktop's `lib/sortFiles.ts`. Folders always stay above files.
 */

export type SortKey = "name" | "size" | "modified" | "type";
export type SortDir = "asc" | "desc";
export interface SortState {
  key: SortKey;
  dir: SortDir;
}

export const DEFAULT_SORT: SortState = { key: "name", dir: "asc" };

/** Direction a key starts in: A→Z for text, biggest/newest first for numbers. */
const INITIAL_DIR: Record<SortKey, SortDir> = {
  name: "asc",
  type: "asc",
  size: "desc",
  modified: "desc",
};

/** Tapping the active key flips it; tapping another starts that key fresh. */
export function nextSort(current: SortState, key: SortKey): SortState {
  return current.key === key
    ? { key, dir: current.dir === "asc" ? "desc" : "asc" }
    : { key, dir: INITIAL_DIR[key] };
}

export interface SortFields {
  name: string;
  size: number;
  isDirectory: boolean;
  modified?: number | null;
}

// Numeric collation, so "photo (2)" sorts before "photo (10)".
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function extension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** Sort any file shape; `fields` maps an item to what sorting needs. */
export function sortFiles<T>(files: T[], sort: SortState, fields: (item: T) => SortFields): T[] {
  const sign = sort.dir === "asc" ? 1 : -1;

  return [...files].sort((x, y) => {
    const a = fields(x);
    const b = fields(y);
    const byName = () => collator.compare(a.name, b.name);
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;

    switch (sort.key) {
      case "size":
        return sign * (a.size - b.size) || byName();
      case "modified":
        // Unknown dates go last whichever way the list runs.
        if (a.modified == null || b.modified == null) {
          return (a.modified == null ? 1 : 0) - (b.modified == null ? 1 : 0) || byName();
        }
        return sign * (a.modified - b.modified) || byName();
      case "type":
        return sign * collator.compare(extension(a.name), extension(b.name)) || byName();
      default:
        return sign * byName();
    }
  });
}

// The last sort picked, shared by both file screens for this app session.
let lastSort: SortState = DEFAULT_SORT;
export const getLastSort = (): SortState => lastSort;
export function rememberSort(sort: SortState): void {
  lastSort = sort;
}
