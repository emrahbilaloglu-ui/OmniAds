// D077 hardening: the recovery-readiness section renders server-owned facts
// verbatim on both surfaces, offers no mutation affordance, and shows read
// failure as visibly unavailable — never as empty/ready.
import React from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StateHistoryRecoverySection } from "@/app/(dashboard)/platforms/meta/automation/automation-view";
import type { StateHistoryCompactionReadiness } from "@/lib/meta/state-history-compaction-readiness";

function readiness(
  overrides: Partial<StateHistoryCompactionReadiness> = {},
): StateHistoryCompactionReadiness {
  return {
    contract: "d077.state-history-compaction-readiness.v3",
    businessId: "biz-1",
    journalRead: "ok",
    fence: {
      metric: "raw_fallback",
      rawBytes: 5_368_750_080,
      heapBytes: null,
      effectiveBytes: 5_368_750_080,
      budgetBytes: 5_368_709_120,
      breachedRaw: true,
      breachedEffective: true,
      provenFreeSpaceBytes: null,
      fallbackReason: "extension_missing",
    } as never,
    approvalStatus: "NOT_EXECUTED",
    latestJournal: [],
    plannedReclaim: null,
    d075WriterEvidence: {
      state: "not_observed",
      detail: "No observation run carries manifest_kind.",
    },
    blockers: [
      "free_space_proof_unavailable:extension_missing (operator: CREATE EXTENSION pgstattuple)",
      "fence_breached_on_governing_metric",
      "d075_writer_evidence_not_observed (no manifest_kind runs measured; reclaim may refill at the pre-D075 rate)",
    ],
    ...overrides,
  };
}

describe("StateHistoryRecoverySection", () => {
  it("renders every server-owned fact and no mutation affordance", () => {
    const html = renderToStaticMarkup(
      <StateHistoryRecoverySection readiness={readiness()} />,
    );
    expect(html).toContain("raw_fallback");
    expect(html).toContain("5,368,750,080 B");
    expect(html).toContain("5,368,709,120 B");
    expect(html).toContain("BREACHED");
    expect(html).toContain("NOT_EXECUTED");
    expect(html).toContain("no journal entries for this business");
    expect(html).toContain("unknown — no operator dry-run plan artifact");
    expect(html).toContain("not_observed");
    expect(html).toContain("free_space_proof_unavailable:extension_missing");
    // Display-only: no buttons, no forms, no token, no compaction verbs as
    // controls.
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("approve-state-history-compaction");
    expect(html).toContain('data-display-only="true"');
  });

  it("shows executed state with business-scoped journal entries", () => {
    const html = renderToStaticMarkup(
      <StateHistoryRecoverySection
        readiness={readiness({
          approvalStatus: "EXECUTED_SEE_JOURNAL",
          latestJournal: [
            {
              event: "completed",
              planHash: "a".repeat(64),
              rowsDeleted: 12,
              createdAt: "2026-08-30T00:00:00Z",
            },
          ],
        })}
      />,
    );
    expect(html).toContain("EXECUTED_SEE_JOURNAL");
    expect(html).toContain("completed@2026-08-30T00:00:00Z");
    // The journal plan hash (token precursor) is not rendered.
    expect(html).not.toContain("a".repeat(64));
  });

  it("renders D075 writer evidence in all three measured states", () => {
    for (const state of ["observed", "not_observed", "unknown"] as const) {
      const html = renderToStaticMarkup(
        <StateHistoryRecoverySection
          readiness={readiness({
            d075WriterEvidence: { state, detail: "detail" },
          })}
        />,
      );
      expect(html).toContain(`>${state}<`);
    }
  });

  it("a journal-ONLY failure renders as unavailable/unknown — never NOT_EXECUTED or 'no journal entries' (acceptance correction)", () => {
    const html = renderToStaticMarkup(
      <StateHistoryRecoverySection
        readiness={readiness({
          journalRead: "unavailable",
          approvalStatus: "UNKNOWN_JOURNAL_UNAVAILABLE",
          latestJournal: [],
          blockers: ["compaction_journal_read_unavailable"],
        })}
      />,
    );
    expect(html).toContain("journal state unavailable");
    expect(html).toContain("execution state is unknown");
    expect(html).not.toContain("NOT_EXECUTED");
    expect(html).not.toContain("no journal entries");
    expect(html).toContain("compaction_journal_read_unavailable");
    // Still display-only in the failure state.
    expect(html).not.toContain("<button");
  });

  it("a missing server read is visibly unavailable, never ready", () => {
    const html = renderToStaticMarkup(
      <StateHistoryRecoverySection readiness={null} />,
    );
    expect(html).toContain("Readiness read unavailable");
    expect(html).not.toContain("NOT_EXECUTED");
    expect(html).not.toContain("none reported");
  });

  it("is not mounted on the operator Automation surfaces", () => {
    const source = readFileSync(
      "app/(dashboard)/platforms/meta/automation/automation-view.tsx",
      "utf8",
    );
    expect(source).not.toContain(
      "<StateHistoryRecoverySection readiness={stateHistoryReadiness}",
    );
    expect(source).toContain("export function StateHistoryRecoverySection");
  });
});
