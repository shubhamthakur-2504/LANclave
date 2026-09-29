import { useId } from "react";
import { ARROW_BOTTOM, ARROW_TOP, FOLDER } from "./geometry";

/**
 * The LANclave mark as inline SVG, in the current text colour (use
 * `text-action` for the brand accent). The arrows are a mask, so it sits
 * correctly on any background.
 */
export default function Mark({ size = 32, className = "" }: { size?: number; className?: string }) {
  const id = useId();
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" className={className} aria-hidden="true">
      <mask id={id} maskUnits="userSpaceOnUse" x="-10" y="-10" width="68" height="68">
        <rect x="-10" y="-10" width="68" height="68" fill="#fff" />
        <path d={`${ARROW_TOP}${ARROW_BOTTOM}`} fill="none" stroke="#000" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
      </mask>
      <path d={FOLDER} fill="currentColor" mask={`url(#${id})`} />
    </svg>
  );
}
