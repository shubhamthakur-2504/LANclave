import {
  Archive,
  BookOpen,
  CodeXml,
  Database,
  Disc3,
  File,
  FileText,
  Film,
  Folder,
  Image,
  Music,
  NotepadText,
  Package,
  Presentation,
  ScrollText,
  Sheet,
  Type,
  type LucideIcon,
} from "lucide-react";
import { extLabel, fileKind, type FileKindId, type FileTone } from "../../lib/fileKind";

/**
 * A file's icon: a tinted tile with the kind's glyph and the extension
 * printed under it ("MP4", "PDF"). The glyph and colour give the kind at a
 * glance; the label tells formats of the same kind apart, and still says
 * something for formats the table has never heard of.
 *
 * Same glyphs (lucide), tones and layout as the phone's FileIcon.
 */

const GLYPH: Record<FileKindId, LucideIcon> = {
  image: Image,
  video: Film,
  audio: Music,
  pdf: FileText,
  document: NotepadText,
  spreadsheet: Sheet,
  presentation: Presentation,
  text: ScrollText,
  ebook: BookOpen,
  archive: Archive,
  code: CodeXml,
  app: Package,
  disk: Disc3,
  font: Type,
  data: Database,
  file: File,
  folder: Folder,
};

const TONE: Record<FileTone, string> = {
  action: "bg-action/15 text-action",
  ok: "bg-ok/15 text-ok",
  warn: "bg-warn/15 text-warn",
  danger: "bg-danger/15 text-danger",
  contentMuted: "bg-surface-active text-content-muted",
};

export default function FileIcon({ name, isDirectory = false, size = 36 }: { name: string; isDirectory?: boolean; size?: number }) {
  const kind = fileKind(name, isDirectory);
  const Glyph = GLYPH[kind.id];
  const label = isDirectory ? "" : extLabel(name);
  return (
    <span
      className={`flex shrink-0 flex-col items-center justify-center rounded-[10px] ${TONE[kind.tone]}`}
      style={{ width: size, height: size, gap: size * 0.03 }}
      title={kind.label}
      aria-hidden="true"
    >
      <Glyph style={{ width: size * (label ? 0.44 : 0.52), height: size * (label ? 0.44 : 0.52) }} strokeWidth={1.75} />
      {label && (
        <span className="font-bold leading-none tracking-wide" style={{ fontSize: Math.max(7, size * 0.21) }}>
          {label}
        </span>
      )}
    </span>
  );
}
