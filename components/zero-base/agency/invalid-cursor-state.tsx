import Link from "next/link";

/**
 * A directory link whose cursor cannot be read.
 *
 * Recoverable rather than not-found: the operator's own client list still
 * exists, only the position in it is unreadable, and a bare 404 would be a
 * worse answer to "my bookmark stopped working".
 *
 * What it must not do is pretend. Silently serving the first page hides that a
 * link is broken and — worse in the version this replaces — leaves the rejected
 * cursor attached to every row's return state, so the bad value spreads. The
 * one action here points at a clean URL with no cursor and no search, so
 * following it cannot carry the bad value forward.
 */
export const INVALID_CURSOR_TITLE = "This directory link is out of date";
export const INVALID_CURSOR_BODY =
  "The position it points to could not be read, so nothing was loaded. Your clients are unaffected — start again from the first page.";

export function InvalidCursorState({
  returnPath,
}: {
  returnPath: "/a/desk" | "/a/desk/clients";
}) {
  return (
    <section data-invalid-cursor="">
      <h2 style={{ fontSize: 20, fontWeight: 700, lineHeight: "26px", margin: "0 0 8px" }}>
        Clients
      </h2>
      <div
        style={{
          borderRadius: "var(--ledger-radius-card)",
          border: "1px solid var(--ledger-semantic-warn)",
          padding: "10px 14px",
          fontSize: 13,
          lineHeight: "19px",
        }}
      >
        <p style={{ margin: 0, fontWeight: 600, color: "var(--ledger-semantic-warn)" }}>
          {INVALID_CURSOR_TITLE}
        </p>
        <p style={{ margin: "4px 0 0", color: "var(--ledger-ink-secondary)" }}>
          {INVALID_CURSOR_BODY}
        </p>
        <Link
          href={returnPath}
          data-invalid-cursor-recovery=""
          style={{
            display: "inline-flex",
            alignItems: "center",
            minHeight: 44,
            marginTop: 8,
            fontWeight: 600,
            color: "var(--ledger-accent-action)",
          }}
        >
          Return to first page
        </Link>
      </div>
    </section>
  );
}
