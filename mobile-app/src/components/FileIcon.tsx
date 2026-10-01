// One module per icon: importing from the package root bundles all ~1,500
// icons (Metro does not tree-shake), which added 2 MB to the app.
import Archive from "lucide-react-native/icons/archive";
import BookOpen from "lucide-react-native/icons/book-open";
import CodeXml from "lucide-react-native/icons/code-xml";
import Database from "lucide-react-native/icons/database";
import Disc3 from "lucide-react-native/icons/disc-3";
import File from "lucide-react-native/icons/file";
import FileText from "lucide-react-native/icons/file-text";
import Film from "lucide-react-native/icons/film";
import Folder from "lucide-react-native/icons/folder";
import Image from "lucide-react-native/icons/image";
import Music from "lucide-react-native/icons/music";
import NotepadText from "lucide-react-native/icons/notepad-text";
import Package from "lucide-react-native/icons/package";
import Presentation from "lucide-react-native/icons/presentation";
import ScrollText from "lucide-react-native/icons/scroll-text";
import Sheet from "lucide-react-native/icons/sheet";
import Type from "lucide-react-native/icons/type";
import type { LucideIcon } from "lucide-react-native";
import { StyleSheet, Text, View } from "react-native";

import { C } from "@/constants/colors";
import { extLabel, fileKind, type FileKindId, type FileTone } from "@/constants/file-kind";

/**
 * A file's icon: a tinted tile with the kind's glyph and the extension
 * printed under it ("MP4", "PDF"). The glyph and colour give the kind at a
 * glance; the label tells formats of the same kind apart, and still says
 * something for formats the table has never heard of.
 *
 * Same glyphs (lucide), tones and layout as the desktop's FileIcon. Drawn
 * with react-native-svg from icons bundled in the app, so it needs no
 * network and looks the same on any platform.
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

/** The tile behind the glyph: the tone at 15%, or a neutral surface. */
function tileColor(tone: FileTone): string {
  return tone === "contentMuted" ? C.surfaceActive : `${C[tone]}26`;
}

export function FileIcon({ name, isDirectory = false, size = 40 }: { name: string; isDirectory?: boolean; size?: number }) {
  const kind = fileKind(name, isDirectory);
  const Glyph = GLYPH[kind.id];
  const label = isDirectory ? "" : extLabel(name);
  const color = C[kind.tone];
  const glyph = size * (label ? 0.44 : 0.52);
  return (
    <View
      style={[styles.tile, { width: size, height: size, gap: size * 0.03, backgroundColor: tileColor(kind.tone) }]}
      accessible={false}
      importantForAccessibility="no-hide-descendants"
    >
      <Glyph size={glyph} color={color} strokeWidth={1.75} />
      {label !== "" && (
        <Text style={[styles.label, { color, fontSize: Math.max(7, size * 0.21), lineHeight: Math.max(8, size * 0.23) }]} allowFontScaling={false}>
          {label}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  tile: { borderRadius: 10, alignItems: "center", justifyContent: "center" },
  label: { fontWeight: "700", letterSpacing: 0.3 },
});
