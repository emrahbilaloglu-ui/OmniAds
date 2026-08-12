"use client";

import { useCopy } from "@/components/zero-base/i18n/copy-provider";

/**
 * Skip link.
 *
 * Visible only on focus, so it changes nothing visually while saving keyboard
 * users from tabbing through the whole rail on every page. `<main>` takes
 * `tabIndex={-1}` so the jump actually moves focus rather than only the
 * scroll position.
 */
export const MAIN_CONTENT_ID = "zero-base-main";

/**
 * The tabindex `<main>` carries.
 *
 * Zero, because main owns both scroll axes: a scroll container that cannot be
 * focused is unreachable by keyboard on any page whose content has no focusable
 * element of its own. Exported so the non-production harness renders the same
 * value the shell does — it previously hand-wrote `-1` in a string template and
 * silently drifted from the component it claims to represent.
 */
export const MAIN_CONTENT_TABINDEX = 0;

export function SkipLink() {
  const copy = useCopy();
  return (
    <a
      href={`#${MAIN_CONTENT_ID}`}
      data-skip-link=""
      style={{
        position: "absolute",
        left: 8,
        top: -100,
        zIndex: 60,
        padding: "10px 14px",
        minHeight: 44,
        borderRadius: "var(--ledger-radius-button)",
        background: "var(--ledger-bg-surface)",
        color: "var(--ledger-accent-action)",
        border: "1px solid var(--ledger-accent-action)",
        fontSize: 13,
        fontWeight: 600,
        textDecoration: "none",
      }}
      onFocus={(event) => {
        event.currentTarget.style.top = "8px";
      }}
      onBlur={(event) => {
        event.currentTarget.style.top = "-100px";
      }}
    >
      {copy.skipToMain}
    </a>
  );
}
