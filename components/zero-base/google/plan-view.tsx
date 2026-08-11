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
import { ZeroBaseDialog } from "@/components/zero-base/primitives/overlays";
import {
  APPLIED_MANUAL_LABEL,
  JOURNAL_ACTION_LABEL,
  appliedStepIds,
  markIsReversible,
  type JournalPage,
} from "@/lib/zero-base/google/activity-journal";
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
import { useCopy } from "@/components/zero-base/i18n/copy-provider";

export function GooglePlanView({
  scope,
  source,
  steps,
  servedStatuses,
  journal,
  onMarkApplied,
  onCopyStep,
  onCsvStep,
  onDismiss,
  markError,
  batchPartial = false,
}: {
  scope: GoogleScope;
  source: GoogleSourceState;
  steps: readonly PlanStep[];
  /** Statuses the response contract actually carries. */
  servedStatuses: readonly string[];
  /** Absent when the journal could not be read at all. */
  journal?: JournalPage | null;
  onMarkApplied?: (stepId: string, applied: boolean) => void;
  onCopyStep?: (stepId: string) => void;
  onCsvStep?: (stepId: string) => void;
  /** Dismissing is workflow state only; it never writes to Google. */
  onDismiss?: (stepId: string) => void;
  /** Verbatim journal-write failure. The checkbox reverts; nothing is claimed. */
  markError?: string | null;
  /** Some of the batch landed and some did not; neither word covers it. */
  batchPartial?: boolean;
}) {
  const t = useCopy();
  const [copied, setCopied] = useState(false);
  const applied = journal ? appliedStepIds(journal) : new Set<string>();
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
      <GoogleScopeHeader title={t.googlePlan} scope={scope} />
      <GoogleSourceBadge state={source} />

      {/* ------------------------------------------- manual path, first */}
      <section aria-label={t.manualPlan}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{t.yourPlan}</h2>
        <p data-manual-primary="" style={{ margin: "4px 0 8px", fontSize: 12.5, color: "var(--ledger-ink-secondary)" }}>
          {t.carryOutInGoogle}
        </p>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
          <Button
            variant="secondary"
            data-plan-copy=""
            data-ctl="live:GOOGLE-ESC-01 copy-all"
            onClick={copy}
          >
            {copied ? "Plan copied" : "Copy plan"}
          </Button>
          <Button
            variant="secondary"
            data-plan-csv=""
            data-ctl="live:GOOGLE-ESC-01 csv-all"
            onClick={download}
          >
            {t.downloadCsv}
          </Button>
        </div>

        <DataTable
          collection="plan"
          caption={t.googleManualPlan}
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
                    <span style={{ display: "block", fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>
                      {row.rationale}
                    </span>
                  ) : null}
                  {row.weaknesses.map((weakness) => (
                    <span
                      key={weakness}
                      data-plan-weakness={row.id}
                      style={{ display: "block", fontSize: 12, color: "var(--ledger-semantic-warn)" }}
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
                    data-ctl="live:GOOGLE-30 deeplink"
                    style={{ color: "var(--ledger-accent-action)" }}
                  >
                    {t.open}
                  </a>
                ) : (
                  <span data-plan-link-withheld={row.id} style={{ color: "var(--ledger-ink-tertiary)", fontSize: 12 }}>
                    {LINK_WITHHELD}
                  </span>
                );
              },
            },
            {
              id: "applied",
              header: "Applied",
              render: (row) => {
                const isApplied = applied.has(row.id);
                const reversible = journal ? markIsReversible(journal, row.id) : true;
                return (
                  <span data-plan-applied={row.id}>
                    <input
                      type="checkbox"
                      data-ctl="live:GOOGLE-28 mark-applied"
                      aria-label={`Mark ${row.title} as applied in Google`}
                      checked={isApplied}
                      // Once the batch has been exported the record has left
                      // the system; un-marking here would make our journal
                      // disagree with the file the operator is working from.
                      aria-disabled={isApplied && !reversible ? "true" : undefined}
                      onChange={(event) => {
                        if (isApplied && !reversible) return;
                        onMarkApplied?.(row.id, event.target.checked);
                      }}
                    />
                    {isApplied ? (
                      // Never "applied": the qualifier is the difference
                      // between a fact we observed and a claim someone made.
                      <span style={{ marginLeft: 6, fontSize: 12 }}>{APPLIED_MANUAL_LABEL}</span>
                    ) : null}
                  </span>
                );
              },
            },
            {
              id: "export",
              header: "Copy",
              render: (row) => (
                <span style={{ display: "inline-flex", gap: 6 }}>
                  {/* Per-step, not only whole-plan: an operator applying one
                      change at a time should not have to copy the whole plan
                      and find their line in it. Each export writes its own
                      journal entry. */}
                  <Button
                    variant="quiet"
                    data-ctl="live:GOOGLE-26 dismiss"
                    aria-label={`Dismiss ${row.title}`}
                    onClick={() => onDismiss?.(row.id)}
                  >
                    {t.dismiss}
                  </Button>
                  <Button
                    variant="secondary"
                    data-ctl="live:GOOGLE-ESC-01 copy"
                    aria-label={`Copy ${row.title}`}
                    onClick={() => onCopyStep?.(row.id)}
                  >
                    {t.copy}
                  </Button>
                  <Button
                    variant="secondary"
                    data-ctl="live:GOOGLE-ESC-01 csv"
                    aria-label={`Download ${row.title} as CSV`}
                    onClick={() => onCsvStep?.(row.id)}
                  >
                    {t.downloadCsv}
                  </Button>
                </span>
              ),
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
      <section aria-label={t.activity}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{t.activity}</h2>
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
      <section aria-label={t.referenceWriteStates}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{t.referenceNotEnabled}</h2>
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
        {batchPartial ? (
          <p
            data-el="batch-partial"
            style={{ margin: "6px 0 0", fontSize: 12.5, color: "var(--ledger-semantic-warn)" }}
          >
            {/* Neither "applied" nor "failed" describes a batch where some
                steps landed. Saying either would be wrong about the rest. */}
            {t.batchPartiallyApplied}
          </p>
        ) : null}
        <ul data-collection="batch" style={{ margin: "6px 0 0", paddingLeft: 18 }}>
          {steps.map((step) => (
            <li key={step.id} style={{ fontSize: 12.5 }}>
              {step.title}
            </li>
          ))}
        </ul>
        {batchPartial ? (
          <ZeroBaseDialog
            open
            onOpenChange={() => {}}
            title={t.confirmBatch}
            description={t.batchIsReferenceOnly}
            confirmLabel={t.checkThisSelection}
            onConfirm={() => {}}
          />
        ) : null}
        <Button
          variant="secondary"
          data-batch-validate=""
          style={{ marginTop: 8 }}
          onClick={() => {
            const gate = gateBatch({ steps, selectedIds: selected });
            setBatchError(gate.ok ? null : gate.reason);
          }}
        >
          {t.checkThisSelection}
        </Button>
        {batchError ? (
          <p role="status" data-batch-error="" style={{ margin: "6px 0 0", fontSize: 12.5, color: "var(--ledger-semantic-warn)" }}>
            {batchError}
          </p>
        ) : null}
      </section>

      {journal ? (
        <section aria-label={t.activity} style={{ marginTop: 20 }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{t.activity}</h2>
          <p style={{ margin: "4px 0 8px", fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>
            What was recorded here, by whom and when. These are our records of
            manual confirmations — Adsecute never reads Google back to verify
            them.
          </p>
          {markError ? (
            <p
              role="alert"
              data-journal-error=""
              style={{ margin: "0 0 8px", fontSize: 12.5, color: "var(--ledger-semantic-danger)" }}
            >
              {markError}
            </p>
          ) : null}
          {journal.hasGap ? (
            <p
              data-el="journal-gap"
              style={{ margin: "0 0 8px", fontSize: 12.5, color: "var(--ledger-semantic-warn)" }}
            >
              {journal.gapReason}
            </p>
          ) : null}
          <DataTable
            collection="journal"
            caption={t.activityJournal}
            rows={[...journal.entries]}
            rowKey={(row) => row.id}
            columns={[
              { id: "at", header: "When", render: (row) => row.at },
              { id: "actor", header: "Who", render: (row) => row.actor },
              {
                id: "action",
                header: "What",
                render: (row) => JOURNAL_ACTION_LABEL[row.action],
              },
              { id: "detail", header: "Detail", render: (row) => row.detail },
            ]}
          />
        </section>
      ) : null}
    </div>
  );
}
