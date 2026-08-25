"use client";

import { useEffect, useState } from "react";

/**
 * The one width at which the console's rail becomes a drawer.
 *
 * It is declared here and consumed by both the CSS-facing components and the
 * JavaScript that has to know the same thing, because the number was previously
 * only in `app/globals.css` — so anything in TypeScript that needed to reason
 * about the drawer had to hard-code a copy and hope.
 */
export const DRAWER_BREAKPOINT_PX = 1023;

/**
 * Whether the viewport is narrow enough that the rail is a drawer.
 *
 * `false` until mounted, deliberately. The server cannot know the viewport, and
 * a hook that guessed would make the first client render disagree with the
 * markup React just hydrated — which is a hydration error, not a layout
 * preference. The desktop composition is the safe first answer because at
 * desktop the rail is simply visible, whereas guessing "narrow" would render a
 * closed drawer over content that should be showing.
 */
export function useIsNarrow(): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(`(max-width: ${DRAWER_BREAKPOINT_PX}px)`);
    const apply = () => setNarrow(query.matches);
    apply();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, []);
  return narrow;
}
