"use client";

/**
 * The context bar — present on every scoped surface (INV-06).
 *
 * It never disappears. At narrow widths it compresses to a sticky two-line
 * header whose whole accessible name is the six facts, opening the scope sheet
 * for the full values; it does not collapse to nothing, because a surface
 * without visible scope is a surface where the user cannot tell which client's
 * money they are looking at.
 *
 * Timezone disagreement and staleness are the two states that change colour,
 * and both carry their word as well, so meaning survives without colour.
 */
import { scopeFactRows, type ScopeFacts } from "@/components/zero-base/primitives/scope-sheet";

export function ContextBar({
  facts,
  compact,
  onOpenScopeSheet,
}: {
  facts: ScopeFacts;
  compact: boolean;
  onOpenScopeSheet: () => void;
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

  const visible = rows.filter((row) => ["account", "window", "currency", "timezone", "freshness"].includes(row.id));

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
      {visible.map((row) => (
        <button
          key={row.id}
          type="button"
          data-context-fact={row.id}
          onClick={onOpenScopeSheet}
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
            cursor: "pointer",
            whiteSpace: "nowrap",
            fontSize: 12,
          }}
        >
          <span style={{ color: "var(--ledger-ink-tertiary)" }}>{row.label}</span>
          <strong style={{ fontWeight: 500, color: "var(--ledger-ink-primary)" }}>{row.value}</strong>
          {row.id === "account" || row.id === "window" ? <span aria-hidden="true">▾</span> : null}
        </button>
      ))}
    </div>
  );
}
