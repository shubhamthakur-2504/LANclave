/**
 * OS-level file drag-and-drop (U3.1).
 *
 * For a file-sharing app this was the most conspicuous missing affordance.
 * Tauri reports drops on the whole webview, not per element, so the position
 * it gives is hit-tested against registered drop zones here.
 *
 * Positions arrive in physical pixels; DOM rects are in CSS pixels, so every
 * comparison divides by devicePixelRatio. Getting that wrong puts the
 * highlight on the wrong element on any scaled display, which is most of them.
 */

import { useEffect, useRef, useState } from "react";

export interface DropPosition {
  x: number;
  y: number;
}

type DropHandler = (paths: string[], position: DropPosition) => void;

interface DragDropState {
  /** True while files are hovering anywhere over the window. */
  isDragging: boolean;
  /** Cursor position while dragging, in CSS pixels. */
  position: DropPosition | null;
}

/**
 * Subscribe to file drops on the window.
 *
 * `onDrop` is kept in a ref so callers can pass an inline function without
 * re-subscribing on every render.
 */
export function useFileDrop(onDrop: DropHandler): DragDropState {
  const [state, setState] = useState<DragDropState>({
    isDragging: false,
    position: null,
  });

  const handlerRef = useRef(onDrop);
  handlerRef.current = onDrop;

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let disposed = false;

    const toCssPixels = (p: { x: number; y: number }): DropPosition => {
      const ratio = window.devicePixelRatio || 1;
      return { x: p.x / ratio, y: p.y / ratio };
    };

    import("@tauri-apps/api/webview")
      .then(({ getCurrentWebview }) =>
        getCurrentWebview().onDragDropEvent((event) => {
          const payload = event.payload;

          if (payload.type === "over") {
            setState({ isDragging: true, position: toCssPixels(payload.position) });
            return;
          }

          if (payload.type === "drop") {
            const position = toCssPixels(payload.position);
            setState({ isDragging: false, position: null });
            if (payload.paths.length > 0) {
              handlerRef.current(payload.paths, position);
            }
            return;
          }

          // "enter" / "leave" / anything else: stop showing the affordance.
          setState({ isDragging: false, position: null });
        }),
      )
      .then((un) => {
        if (disposed) un();
        else unlisten = un;
      })
      .catch(() => {
        // Not running under Tauri (e.g. plain vite dev in a browser).
      });

    return () => {
      disposed = true;
      if (unlisten) unlisten();
    };
  }, []);

  return state;
}

/** True when `position` falls inside `el`'s box. */
export function isOver(el: HTMLElement | null, position: DropPosition | null): boolean {
  if (!el || !position) return false;
  const r = el.getBoundingClientRect();
  return (
    position.x >= r.left &&
    position.x <= r.right &&
    position.y >= r.top &&
    position.y <= r.bottom
  );
}
