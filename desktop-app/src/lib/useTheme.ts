/**
 * Light / dark / follow-the-system (U4.1).
 *
 * The tokens themselves live in App.css. This only decides which set is
 * active, by setting `data-theme` on <html>:
 *
 *   - "system" removes the attribute, so the media query in App.css wins
 *   - "light" / "dark" pin it
 *
 * That split is deliberate: theming is a CSS concern, and keeping the
 * colours out of JS is what made light mode one block of CSS rather than a
 * pass over every component.
 */

import { useCallback, useEffect, useState } from "react";

export type ThemePreference = "system" | "light" | "dark";

const STORAGE_KEY = "lanclave.theme";

function readStored(): ThemePreference {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === "light" || raw === "dark" || raw === "system") return raw;
  } catch {
    // Private mode or blocked storage: fall back to following the system.
  }
  return "system";
}

function apply(pref: ThemePreference) {
  const root = document.documentElement;
  if (pref === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", pref);
}

export function useTheme() {
  const [preference, setPreference] = useState<ThemePreference>(readStored);

  useEffect(() => {
    apply(preference);
    try {
      localStorage.setItem(STORAGE_KEY, preference);
    } catch {
      // Not fatal — the preference just will not survive a restart.
    }
  }, [preference]);

  const cycle = useCallback(() => {
    setPreference((p) => (p === "system" ? "light" : p === "light" ? "dark" : "system"));
  }, []);

  return { preference, setPreference, cycle };
}
