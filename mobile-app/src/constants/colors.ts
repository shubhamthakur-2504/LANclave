/**
 * Shared design tokens for the LANclave mobile app dark theme.
 * Import from here instead of re-defining colors in each component.
 */
export const C = {
  bg:           "#080C14",    // root background
  surface:      "#0F1520",    // card / row background
  surfaceRaised:"#141E30",    // selected / highlighted surface

  border:       "#1E2A3F",    // subtle border
  borderStrong: "#2A3A58",    // emphasis border / icon bg

  textPrimary:  "#E8EDF5",    // headings, file names
  textSecond:   "#94A3B8",    // secondary labels
  textMuted:    "#64748B",    // section labels / placeholders

  accent:       "#38BDF8",    // sky-400 — interactive
  accentBtn:    "#0EA5E9",    // sky-500 — button fill
  accentBtnDim: "#0369A1",    // sky-700 — pressed / active

  online:       "#34D399",    // emerald-400 — status dot
  onlineBg:     "#052E16",    // dark green badge bg
  onlineBorder: "#064E3B",    // green badge border

  progressBg:   "#0C2040",    // download progress track
  progressFill: "#38BDF8",    // download progress fill

  errorBg:      "#1A0C0C",
  errorBorder:  "#5B1A1A",
  errorText:    "#F87171",    // red-400
} as const;

/** Format a byte count as a human-readable MB string. */
export function mb(bytes: number): string {
  if (bytes === 0) return "—";
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/** Truncate a string to `max` chars with an ellipsis. */
export function short(s: string, max = 16): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

/** Pick an emoji icon based on file extension. */
export function fileIcon(name: string): string {
  const ext = name.split(".").pop();
  if (ext === "jpg" || ext === "png") return "🖼";
  if (ext === "pdf") return "📄";
  if (ext === "m4a") return "🎙";
  if (ext === "txt") return "📝";
  return "📁";
}
