/**
 * File extension → icon + colour.
 *
 * Replaces the old `fileIcon()`, which covered five extensions and fell back
 * to a **folder** emoji for every unrecognised file — a folder icon on a file
 * is actively wrong, not merely plain.
 *
 * Colours come from the token palette so the list stays legible in both
 * themes, and every branch returns a genuine file glyph.
 */

import type { IconName } from "@/components/Icon";
import type { Tokens } from "@/constants/colors";

export interface FileKind {
  icon: IconName;
  /** Resolves against the active token set. */
  tone: keyof Pick<Tokens, "action" | "ok" | "warn" | "danger" | "contentMuted">;
  label: string;
}

const BY_EXT: Record<string, FileKind> = {};

function register(kind: FileKind, exts: string[]) {
  for (const e of exts) BY_EXT[e] = kind;
}

register({ icon: "image", tone: "action", label: "Image" },
  ["jpg", "jpeg", "png", "gif", "webp", "bmp", "heic", "heif", "svg", "avif", "tiff"]);

register({ icon: "video", tone: "danger", label: "Video" },
  ["mp4", "mkv", "mov", "avi", "webm", "m4v", "3gp", "flv", "wmv"]);

register({ icon: "audio", tone: "ok", label: "Audio" },
  ["mp3", "m4a", "wav", "flac", "aac", "ogg", "opus", "wma", "aiff"]);

register({ icon: "document", tone: "warn", label: "Document" },
  ["pdf", "doc", "docx", "odt", "rtf", "txt", "md", "xls", "xlsx", "csv",
   "ppt", "pptx", "epub", "pages"]);

register({ icon: "archive", tone: "contentMuted", label: "Archive" },
  ["zip", "rar", "7z", "tar", "gz", "bz2", "xz", "apk", "iso", "dmg"]);

register({ icon: "code", tone: "action", label: "Code" },
  ["js", "jsx", "ts", "tsx", "rs", "kt", "java", "py", "go", "rb", "c", "h",
   "cpp", "cs", "swift", "php", "sh", "json", "yml", "yaml", "toml", "xml",
   "html", "css", "sql"]);

const GENERIC: FileKind = { icon: "file", tone: "contentMuted", label: "File" };
const DIRECTORY: FileKind = { icon: "folder", tone: "warn", label: "Folder" };

/** Classify a filename. Pass `isDirectory` when the caller knows. */
export function fileKind(name: string, isDirectory = false): FileKind {
  if (isDirectory) return DIRECTORY;

  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return GENERIC;

  return BY_EXT[name.slice(dot + 1).toLowerCase()] ?? GENERIC;
}
