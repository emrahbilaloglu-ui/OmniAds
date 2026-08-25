"use client";

/**
 * The console's scope, stated on a phone.
 *
 * At desktop the topbar states scope with three controls — business, provider
 * account, date range — and an operator can read all three at once. Below
 * 1023px the topbar wraps and those three controls are still there, so the
 * SELECTORS are reachable; what is not reachable is the rest of what scope
 * means. Currency proof, timezone proof, evidence freshness and the snapshot
 * instant have no representation anywhere on a narrow screen, and those are
 * precisely the facts that decide whether a number on the page can be trusted.
 *
 * The accepted design draws exactly this: a compact scope line that opens a
 * sheet listing all eight facts. Both already existed in
 * `components/zero-base/shell/` — behind a shell no route mounts — so the
 * product had the implementation and not the affordance. This mounts them in
 * `DashboardFrame`, which is the shell every route renders.
 *
 * The pickers are deliberately sparse. `ScopePickers` treats an omitted handler
 * as "this actor genuinely cannot do this", and the row then shows no picker at
 * all rather than a disabled one — so a handler is passed only where the
 * console really can act, and the rest of the rows are readings.
 */
import { useState } from "react";

import {
  ScopeSheet,
  type ScopeFacts,
} from "@/components/zero-base/primitives/scope-sheet";
import { scopeFactRows } from "@/components/zero-base/primitives/scope-sheet";
import { useIsNarrow } from "@/components/layout/v2/use-narrow";

export function MobileScope({ facts }: { facts: ScopeFacts | null }) {
  const narrow = useIsNarrow();
  const [open, setOpen] = useState(false);

  // Nothing to say without an envelope, and nowhere to say it at desktop —
  // where the topbar already carries scope and a second bar would be a second
  // answer to the same question.
  if (!narrow || !facts) return null;

  const rows = scopeFactRows(facts);
  const summary = rows.map((row) => `${row.label}: ${row.value}`).join(" · ");
  /*
   * The two proofs that change what a number means. A disagreement between the
   * account's clock and the business's, or evidence known to be stale, is not a
   * detail — it is the reason a figure below may not mean what it appears to.
   */
  const warn = facts.timezoneProof === "disagreement" || facts.freshness === "stale";

  return (
    <div
      data-el="mobile-scope"
      style={{
        position: "sticky",
        top: 0,
        zIndex: 10,
        background: "var(--adv-fill, #f7f9fc)",
        borderBottom: "1px solid var(--adv-border, #e4e8f0)",
      }}
    >
      <button
        type="button"
        data-context-bar="compact"
        data-ctl="live:MOBILE-02 scope-sheet"
        aria-label={`Scope — ${summary}`}
        aria-expanded={open}
        onClick={() => setOpen(true)}
        style={{
          width: "100%",
          textAlign: "left",
          // Two lines, ellipsized. The full values live in the sheet.
          display: "-webkit-box",
          WebkitLineClamp: 2,
          WebkitBoxOrient: "vertical",
          overflow: "hidden",
          minHeight: 44,
          padding: "8px 16px",
          fontSize: 12,
          lineHeight: "16px",
          color: warn ? "var(--adv-warn, #b45309)" : "var(--adv-ink-2, #45526b)",
          background: "transparent",
          border: 0,
          cursor: "pointer",
        }}
      >
        {summary}
      </button>
      {/*
        At 320 the two-line clamp hides most of the summary, and nothing would
        say it had been truncated — a surface showing part of its scope and
        claiming none of the omission. Drawn only at the narrowest tier, where
        the summary genuinely does not fit.
      */}
      <p
        data-el="win-320"
        style={{
          display: "none",
          margin: 0,
          padding: "0 16px 6px",
          fontSize: 12,
          lineHeight: "14px",
          color: "var(--adv-ink-3, #555d6d)",
        }}
      >
        Scope is shortened at this width. Open it to read every fact in full.
      </p>
      <style>{`@media (max-width: 360px){[data-el="win-320"]{display:block!important}}`}</style>
      <ScopeSheet open={open} onOpenChange={setOpen} facts={facts} />
    </div>
  );
}
