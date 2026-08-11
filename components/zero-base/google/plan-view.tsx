"use client";

/**
 * Google manual plan (H32/H33).
 *
 * The manual path is primary and comes first on the page: the plan, the copy
 * and CSV that carry it out of here, and the exact links that land on the right
 * entity. The reference write states come after, clearly marked as shapes
 * rather than controls.
 */
import { useCallback, useState } from "react";

import { Button } from "@/components/zero-base/primitives/button";
import { DataTable } from "@/components/zero-base/collections/data-table";
import { GoogleScopeHeader, GoogleSourceBadge } from "@/components/zero-base/google/google-views";
import {
  GOOGLE_PENDING_COPY,
  MAX_BATCH_ITEMS,
  REFERENCE_WRITE_STATES,
  gateBatch,
  LINK_WITHHELD,
  googleDeepLink,
  planToCsv,
  planToText,
  supportsPartiallyApplied,
  type PlanStep,
} from "@/lib/zero-base/google/manual-plan";
import type { GoogleScope, GoogleSourceState } from "@/lib/zero-base/google/google-contract";

export function GooglePlanView({
  scope,
  source,
  steps,
  servedStatuses,
}: {
  scope: GoogleScope;
  source: GoogleSourceState;
  steps: readonly PlanStep[];
  /** Statuses the response contract actually carries. */
  servedStatuses: readonly string[];
}) {
  const [copied, setCopied] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [batchError, setBatchError] = useState<string | null>(null);

  const copy = useCallback(() => {
    void navigator.clipboard?.writeText?.(planToText(steps)).catch(() => {});
    setCopied(true);
  }, [steps]);

  const download = useCallback(() => {
    const blob = new Blob([planToCsv(steps)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "google-plan.csv";
    anchor.click();
    URL.revokeObjectURL(url);
  }, [steps]);

  return (
    <div data-google-surface="plan" style={{ display: "grid", gap: 20 }}>
      <GoogleScopeHeader title="Google plan" scope={scope} />
      <GoogleSourceBadge state={source} />

      {/* ------------------------------------------- manual path, first */}
      <section aria-label="Manual plan">
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Your plan</h2>
        <p data-manual-primary="" style={{ margin: "4px 0 8px", fontSize: 12.5, color: "var(--ledger-ink-secondary)" }}>
          Carry these out in Google Ads yourself. Nothing on this page changes anything in Google.
        </p>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
          <Button variant="secondary" data-plan-copy="" onClick={copy}>
            {copied ? "Plan copied" : "Copy plan"}
          </Button>
          <Button variant="secondary" data-plan-csv="" onClick={download}>
            Download CSV
          </Button>
        </div>

        <DataTable
          caption="Google manual plan"
          rows={[...steps]}
          rowKey={(row) => row.id}
          columns={[
            { id: "position", header: "#", numeric: true, render: (row) => String(row.position) },
            {
              id: "title",
              header: "Step",
              render: (row) => (
                <span data-plan-step={row.id}>
                  {row.title}
                  {row.rationale ? (
                    <span style={{ display: "block", fontSize: 11, color: "var(--ledger-ink-tertiary)" }}>
                      {row.rationale}
                    </span>
                  ) : null}
                  {row.weaknesses.map((weakness) => (
                    <span
                      key={weakness}
                      data-plan-weakness={row.id}
                      style={{ display: "block", fontSize: 11, color: "var(--ledger-semantic-warn)" }}
                    >
                      {weakness}
                    </span>
                  ))}
                </span>
              ),
            },
            {
              id: "link",
              header: "Open in Google",
              render: (row) => {
                const href = googleDeepLink(row);
                // Withheld rather than guessed: a link assembled from an
                // account we were never given points at the wrong account.
                return href ? (
                  <a
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    data-plan-link={row.id}
                    style={{ color: "var(--ledger-accent-action)" }}
                  >
                    Open
                  </a>
                ) : (
                  <span data-plan-link-withheld={row.id} style={{ color: "var(--ledger-ink-tertiary)", fontSize: 11 }}>
                    {LINK_WITHHELD}
                  </span>
                );
              },
            },
            {
              id: "select",
              header: "Batch",
              render: (row) => (
                <input
                  type="checkbox"
                  aria-label={`Include ${row.title} in the reference batch`}
                  data-plan-select={row.id}
                  checked={selected.includes(row.id)}
                  onChange={(event) =>
                    setSelected((current) =>
                      event.target.checked ? [...current, row.id] : current.filter((id) => id !== row.id),
                    )
                  }
                />
              ),
            },
          ]}
        />
      </section>

      {/* ---------------------------------------------- activity / pending */}
      <section aria-label="Activity">
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Activity</h2>
        <p data-google-pending="" style={{ margin: "4px 0 0", fontSize: 12.5 }}>
          {GOOGLE_PENDING_COPY}
        </p>
        {supportsPartiallyApplied(servedStatuses) ? (
          <p
            data-partially-applied=""
            style={{ margin: "6px 0 0", fontSize: 12.5, color: "var(--ledger-semantic-warn)" }}
          >
            Some changes report as partially applied: part of the change took effect in Google and
            part did not. Open the entity to see which.
          </p>
        ) : null}
      </section>

      {/* ------------------------------------------------- reference states */}
      <section aria-label="Reference write states">
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Reference — not enabled</h2>
        {REFERENCE_WRITE_STATES.map((state) => (
          <p
            key={state.mode}
            data-reference-write={state.mode}
            style={{ margin: "6px 0 0", fontSize: 12.5, color: "var(--ledger-ink-secondary)" }}
          >
            <strong style={{ fontWeight: 600 }}>{state.mode === "single" ? "Single" : "Batch"}:</strong>{" "}
            {state.reason}
          </p>
        ))}
        <p style={{ margin: "8px 0 0", fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>
          A batch would be one execution target type, up to {MAX_BATCH_ITEMS} items.
        </p>
        <Button
          variant="secondary"
          data-batch-validate=""
          style={{ marginTop: 8 }}
          onClick={() => {
            const gate = gateBatch({ steps, selectedIds: selected });
            setBatchError(gate.ok ? null : gate.reason);
          }}
        >
          Check this selection
        </Button>
        {batchError ? (
          <p role="status" data-batch-error="" style={{ margin: "6px 0 0", fontSize: 12.5, color: "var(--ledger-semantic-warn)" }}>
            {batchError}
          </p>
        ) : null}
      </section>
    </div>
  );
}
