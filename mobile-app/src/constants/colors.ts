/**
 * Design tokens for LANclave mobile.
 *
 * Names are deliberately **semantic**, not palette names, and they mirror the
 * desktop `@theme` block in `desktop-app/src/App.css` one-for-one. Sharing a
 * vocabulary is what lets a component be ported between the two apps almost
 * verbatim, and it forces the question "is this actually interactive?" before
 * reaching for the accent.
 *
 * `action` is THE accent. It marks things you can act on — nothing else.
 * Headings, decorative icons and plain labels use `content*`.
 */

export interface Tokens {
  /** App background. */
  surface: string;
  /** Cards, rows, panels. */
  surfaceRaised: string;
  /** Wells, progress tracks, inputs. */
  surfaceInset: string;
  /** Selected / pressed row. */
  surfaceActive: string;

  border: string;
  borderStrong: string;

  /** Primary text. */
  content: string;
  /** Secondary text. */
  contentMuted: string;
  /** Labels, timestamps. */
  contentFaint: string;

  /** Interactive accent. */
  action: string;
  actionHover: string;
  actionPressed: string;
  /** Text/icon colour on top of an `action` fill. */
  onAction: string;

  ok: string;
  okBg: string;
  okBorder: string;

  warn: string;

  danger: string;
  dangerBg: string;
  dangerBorder: string;
}

export const darkTokens: Tokens = {
  surface: "#080C14",
  surfaceRaised: "#0F1520",
  surfaceInset: "#070D18",
  surfaceActive: "#141E30",

  border: "#1E2A3F",
  borderStrong: "#2A3A58",

  content: "#E8EDF5",
  contentMuted: "#94A3B8",
  contentFaint: "#7C8CA4",

  action: "#0EA5E9",
  actionHover: "#38BDF8",
  actionPressed: "#0369A1",
  onAction: "#04121F",

  ok: "#34D399",
  okBg: "#052E16",
  okBorder: "#064E3B",

  warn: "#FBBF24",

  danger: "#F87171",
  dangerBg: "#1A0C0C",
  dangerBorder: "#5B1A1A",
};

export const lightTokens: Tokens = {
  surface: "#F6F8FC",
  surfaceRaised: "#FFFFFF",
  surfaceInset: "#EDF1F7",
  surfaceActive: "#E2E9F3",

  border: "#D8E0EC",
  borderStrong: "#B6C3D6",

  content: "#0B1729",
  contentMuted: "#4A5A70",
  contentFaint: "#64748B",

  action: "#0284C7",
  actionHover: "#0369A1",
  actionPressed: "#075985",
  onAction: "#FFFFFF",

  ok: "#047857",
  okBg: "#ECFDF5",
  okBorder: "#A7F3D0",

  warn: "#B45309",

  danger: "#B91C1C",
  dangerBg: "#FEF2F2",
  dangerBorder: "#FECACA",
};

/**
 * Default token set.
 *
 * Screens that have not been migrated to `useTokens()` import this directly,
 * which is why it stays a plain object rather than a hook.
 */
export const C = darkTokens;

// ─── Formatting helpers ──────────────────────────────────────────────────────

/** Format a byte count as a human-readable string. */
export function mb(bytes: number): string {
  if (bytes === 0) return "—";
  if (bytes < 1_000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(1)} KB`;
  if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
}

/** Truncate a string to `max` chars with an ellipsis. */
export function short(s: string, max = 16): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}


/**
 * Deterministic colour for a device, derived from its id.
 *
 * Gives every peer a stable identity colour, which doubles as a cheap visual
 * check that the peer you are looking at is the one you paired with.
 */
export function idColor(id: string): string {
  const palette = [
    "#38BDF8",
    "#34D399",
    "#FBBF24",
    "#F472B6",
    "#A78BFA",
    "#FB923C",
    "#2DD4BF",
  ];
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  }
  return palette[hash % palette.length];
}
