"use client";

/**
 * The context bar — present on scoped provider surfaces (INV-06).
 *
 * On a provider surface it never disappears. At narrow widths it compresses to a sticky two-line
 * header whose whole accessible name is the six facts, opening the scope sheet
 * for the full values; it does not collapse to nothing, because a surface
 * without visible scope is a surface where the user cannot tell which client's
 * money they are looking at.
 *
 * Timezone disagreement and staleness are the two states that change colour,
 * and both carry their word as well, so meaning survives without colour.
 */
import {
  scopeFactRows,
  type ScopeFacts,
  type ScopePickers,
} from "@/components/zero-base/primitives/scope-sheet";

export function ContextBar({
  facts,
  compact,
  onOpenScopeSheet,
  pickers,
}: {
  facts: ScopeFacts;
  compact: boolean;
  onOpenScopeSheet: () => void;
  pickers?: ScopePickers;
}) {
  const rows = scopeFactRows(facts);
  const summary = rows.map((row) => `${row.label}: ${row.value}`).join(" · ");

  const tone =
    facts.timezoneProof === "disagreement" || facts.freshness === "stale"
      ? "var(--ledger-semantic-warn)"
      : "var(--ledger-ink-secondary)";

  if (compact) {
    return (
      <button
        type="button"
        data-context-bar="compact"
        data-ctl="live:MOBILE-02 scope-sheet"
        aria-label={`Scope — ${summary}`}
        onClick={onOpenScopeSheet}
        style={{
          position: "sticky",
          top: 0,
          zIndex: 10,
          width: "100%",
          textAlign: "left",
          // Two lines, ellipsized. Full values live in the sheet.
          display: "-webkit-box",
          WebkitLineClamp: 2,
          WebkitBoxOrient: "vertical",
          overflow: "hidden",
          minHeight: 44,
          padding: "8px 16px",
          fontSize: 12,
          lineHeight: "16px",
          color: tone,
          background: "var(--ledger-bg-inset)",
          border: 0,
          borderBottom: "1px solid var(--ledger-border-subtle)",
          cursor: "pointer",
        }}
      >
        {summary}
      </button>
    );
  }

  // Desktop shows only facts this surface can actually prove or change. An
  // unknown value remains available in the full mobile scope sheet, but it no
  // longer consumes permanent horizontal space on every provider page.
  const visible = rows.filter((row) => {
    if (row.id === "account") {
      return Boolean(facts.providerAccountLabel || pickers?.onPickAccount);
    }
    if (row.id === "window") {
      return Boolean(facts.evidenceWindowLabel || pickers?.onPickWindow);
    }
    if (row.id === "currency") return Boolean(facts.configuredCurrency);
    if (row.id === "timezone") return Boolean(facts.businessTimezone);
    if (row.id === "freshness") {
      return Boolean(facts.snapshotAt || facts.freshness !== "unknown");
    }
    return false;
  });

  if (visible.length === 0) return null;

  return (
    <div
      data-context-bar="full"
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 8,
        minHeight: 36,
        padding: "4px 16px",
        fontSize: 12,
        lineHeight: "16px",
        color: tone,
        background: "var(--ledger-bg-inset)",
        borderBottom: "1px solid var(--ledger-border-subtle)",
      }}
    >
      {visible.map((row) => {
        const handler =
          row.id === "account"
            ? pickers?.onPickAccount
            : row.id === "window"
              ? pickers?.onPickWindow
              : undefined;
        const Tag = handler ? "button" : "span";
        return (
        <Tag
          key={row.id}
          {...(handler ? { type: "button" as const, onClick: handler } : {})}
          data-context-fact={row.id}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            minHeight: 26,
            marginLeft: row.id === "freshness" ? "auto" : 0,
            padding: "2px 8px",
            border: "1px solid var(--ledger-border-control)",
            borderRadius: "var(--ledger-radius-button)",
            background: "var(--ledger-bg-surface)",
            color: row.id === "freshness" ? tone : "var(--ledger-ink-secondary)",
            cursor: handler ? "pointer" : "default",
            whiteSpace: "nowrap",
            fontSize: 12,
          }}
        >
          <span style={{ color: "var(--ledger-ink-tertiary)" }}>{row.label}</span>
          <strong style={{ fontWeight: 500, color: "var(--ledger-ink-primary)" }}>{row.value}</strong>
          {handler ? <span aria-hidden="true">▾</span> : null}
        </Tag>
        );
      })}
    </div>
  );
}
