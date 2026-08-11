"use client";

/**
 * Skip link.
 *
 * Visible only on focus, so it changes nothing visually while saving keyboard
 * users from tabbing through the whole rail on every page. `<main>` takes
 * `tabIndex={-1}` so the jump actually moves focus rather than only the
 * scroll position.
 */
export const MAIN_CONTENT_ID = "zero-base-main";

export function SkipLink() {
  return (
    <a
      href={`#${MAIN_CONTENT_ID}`}
      data-skip-link=""
      style={{
        position: "absolute",
        left: 8,
        top: -48,
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
        event.currentTarget.style.top = "-48px";
      }}
    >
      Skip to main content
    </a>
  );
}
