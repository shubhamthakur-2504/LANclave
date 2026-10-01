/**
 * File extension -> kind, for file icons and labels.
 *
 * MUST MATCH desktop-app/src/lib/fileKind.ts, entry for entry: the two apps
 * show the same file with the same icon, colour and label. Everything below
 * this comment is identical in both files.
 *
 * `tone` is a colour token, not a palette name, so both themes stay legible.
 */

export type FileKindId =
  | "image"
  | "video"
  | "audio"
  | "pdf"
  | "document"
  | "spreadsheet"
  | "presentation"
  | "text"
  | "ebook"
  | "archive"
  | "code"
  | "app"
  | "disk"
  | "font"
  | "data"
  | "file"
  | "folder";

export type FileTone = "action" | "ok" | "warn" | "danger" | "contentMuted";

export interface FileKind {
  id: FileKindId;
  tone: FileTone;
  /** "Video", "Spreadsheet"... shown next to the size. */
  label: string;
}

const KINDS: [FileKind, string[]][] = [
  [{ id: "image", tone: "action", label: "Image" },
    ["jpg", "jpeg", "png", "gif", "webp", "bmp", "heic", "heif", "svg", "avif", "tiff", "tif", "ico", "raw", "psd"]],
  [{ id: "video", tone: "danger", label: "Video" },
    ["mp4", "mkv", "mov", "avi", "webm", "m4v", "3gp", "flv", "wmv", "mpg", "mpeg"]],
  [{ id: "audio", tone: "ok", label: "Audio" },
    ["mp3", "m4a", "wav", "flac", "aac", "ogg", "opus", "wma", "aiff", "amr", "mid", "midi"]],
  [{ id: "pdf", tone: "danger", label: "PDF" }, ["pdf"]],
  [{ id: "document", tone: "action", label: "Document" },
    ["doc", "docx", "odt", "rtf", "pages"]],
  [{ id: "spreadsheet", tone: "ok", label: "Spreadsheet" },
    ["xls", "xlsx", "ods", "csv", "tsv", "numbers"]],
  [{ id: "presentation", tone: "warn", label: "Presentation" },
    ["ppt", "pptx", "odp", "key"]],
  [{ id: "text", tone: "contentMuted", label: "Text" },
    ["txt", "md", "log", "ini", "cfg", "conf"]],
  [{ id: "ebook", tone: "warn", label: "Ebook" }, ["epub", "mobi", "azw3", "fb2"]],
  [{ id: "archive", tone: "contentMuted", label: "Archive" },
    ["zip", "rar", "7z", "tar", "gz", "bz2", "xz", "tgz", "zst"]],
  [{ id: "code", tone: "action", label: "Code" },
    ["js", "jsx", "ts", "tsx", "mjs", "rs", "kt", "java", "py", "go", "rb", "c", "h", "cpp", "cs", "swift",
     "php", "sh", "bat", "ps1", "json", "yml", "yaml", "toml", "xml", "html", "css", "sql"]],
  [{ id: "app", tone: "ok", label: "App" },
    ["apk", "aab", "exe", "msi", "dmg", "deb", "rpm", "appimage", "ipa"]],
  [{ id: "disk", tone: "contentMuted", label: "Disk image" }, ["iso", "img", "vhd", "vmdk"]],
  [{ id: "font", tone: "contentMuted", label: "Font" }, ["ttf", "otf", "woff", "woff2"]],
  [{ id: "data", tone: "contentMuted", label: "Database" }, ["db", "sqlite", "sqlite3", "mdb"]],
];

const BY_EXT: Record<string, FileKind> = {};
for (const [kind, exts] of KINDS) {
  for (const e of exts) BY_EXT[e] = kind;
}

const GENERIC: FileKind = { id: "file", tone: "contentMuted", label: "File" };
const DIRECTORY: FileKind = { id: "folder", tone: "warn", label: "Folder" };

/** The extension, lowercased, or "" when the name has none. */
export function fileExt(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toLowerCase();
}

/** Classify a filename. Pass `isDirectory` when the caller knows. */
export function fileKind(name: string, isDirectory = false): FileKind {
  if (isDirectory) return DIRECTORY;
  return BY_EXT[fileExt(name)] ?? GENERIC;
}

/** "MP4 video", "PDF document", "XYZ file"; plain "File" with no extension. */
export function describeFile(name: string, isDirectory = false): string {
  const kind = fileKind(name, isDirectory);
  const ext = fileExt(name).toUpperCase();
  if (isDirectory || !ext) return kind.label;
  if (kind.id === "pdf") return "PDF document";
  return `${ext} ${kind.label.toLowerCase()}`;
}

/**
 * The extension as printed on the file tile: "MP4", "DOCX". Up to four
 * characters, so unknown formats are still told apart; longer ones are cut.
 */
export function extLabel(name: string): string {
  return fileExt(name).slice(0, 4).toUpperCase();
}
