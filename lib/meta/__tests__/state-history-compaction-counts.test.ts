// D077 acceptance correction: the planner's count invariant is fail-closed
// at ROW level, not only run level, through an exported validator the
// production planner calls per scope and on totals. These tests perturb
// counts and prove refusal — the rejected implementation had no row-level
// reconciliation at all.
import { describe, expect, it } from "vitest";
import {
  validateCompactionScopeCounts,
  type CompactionProtectionsByReason,
} from "@/lib/meta/state-history-compaction";

function reasons(
  overrides: Partial<CompactionProtectionsByReason> = {},
): CompactionProtectionsByReason {
  return {
    headDuplicate: { runs: 1, rows: 2 },
    liveLineagePinned: { runs: 2, rows: 4 },
    archivedLineagePinned: { runs: 1, rows: 2 },
    responseEventPinned: { runs: 2, rows: 4 },
    interleavedExcluded: { runs: 1, rows: 3 },
    multiEndpointExcluded: { runs: 0, rows: 0 },
    ...overrides,
  };
}

// Matches the seam fixture family: union 4 runs / 8 rows over overlapping
// families (one run pinned by live AND response), 1 interleaved (3 rows),
// 1 removable (2 rows).
function validScope() {
  return {
    label: "biz/acct/ad/endpoint",
    candidateRuns: 6,
    candidateRows: 13,
    pinnedRuns: 4,
    pinnedRunRows: 8,
    interleavedExcludedRuns: 1,
    interleavedExcludedRows: 3,
    removableRuns: 1,
    removableRows: 2,
    protectionsByReason: reasons(),
  };
}

describe("validateCompactionScopeCounts", () => {
  it("accepts an internally consistent scope with overlapping pin families", () => {
    expect(() => validateCompactionScopeCounts(validScope())).not.toThrow();
  });

  it("fails closed when candidate ROWS do not reconcile disjointly", () => {
    expect(() =>
      validateCompactionScopeCounts({
        ...validScope(),
        candidateRows: 14, // pinned 8 + interleaved 3 + removable 2 = 13
      }),
    ).toThrow(/count inconsistency/);
  });

  it("fails closed when the pinned ROW union exceeds the overlapping family row sum", () => {
    expect(() =>
      validateCompactionScopeCounts({
        ...validScope(),
        candidateRows: 16,
        pinnedRunRows: 11, // families sum to 4+2+4 = 10
      }),
    ).toThrow(/count inconsistency/);
  });

  it("fails closed when the pinned ROW union undercuts the largest family", () => {
    expect(() =>
      validateCompactionScopeCounts({
        ...validScope(),
        candidateRows: 8,
        pinnedRunRows: 3, // largest family carries 4 rows
      }),
    ).toThrow(/count inconsistency/);
  });

  it("fails closed when the pinned RUN union violates family bounds", () => {
    expect(() =>
      validateCompactionScopeCounts({
        ...validScope(),
        pinnedRuns: 6, // families sum to 5
      }),
    ).toThrow(/count inconsistency/);
    expect(() =>
      validateCompactionScopeCounts({
        ...validScope(),
        pinnedRuns: 1, // largest family has 2 runs
      }),
    ).toThrow(/count inconsistency/);
  });

  it("fails closed when candidate RUNS do not reconcile", () => {
    expect(() =>
      validateCompactionScopeCounts({
        ...validScope(),
        candidateRuns: 7,
      }),
    ).toThrow(/count inconsistency/);
  });

  it("fails closed when interleave mirrors disagree", () => {
    expect(() =>
      validateCompactionScopeCounts({
        ...validScope(),
        protectionsByReason: reasons({
          interleavedExcluded: { runs: 1, rows: 4 },
        }),
      }),
    ).toThrow(/count inconsistency/);
  });

  it("multi-endpoint exclusion is disjoint: an excluded scope carries no other classification", () => {
    // A multi-endpoint scope is excluded wholesale before candidate
    // classification: its only nonzero reason is multiEndpointExcluded.
    expect(() =>
      validateCompactionScopeCounts({
        label: "multi",
        candidateRuns: 0,
        candidateRows: 0,
        pinnedRuns: 0,
        pinnedRunRows: 0,
        interleavedExcludedRuns: 0,
        interleavedExcludedRows: 0,
        removableRuns: 0,
        removableRows: 0,
        protectionsByReason: reasons({
          headDuplicate: { runs: 0, rows: 0 },
          liveLineagePinned: { runs: 0, rows: 0 },
          archivedLineagePinned: { runs: 0, rows: 0 },
          responseEventPinned: { runs: 0, rows: 0 },
          interleavedExcluded: { runs: 0, rows: 0 },
          multiEndpointExcluded: { runs: 3, rows: 9 },
        }),
      }),
    ).not.toThrow();
    expect(() =>
      validateCompactionScopeCounts({
        label: "multi-bad",
        candidateRuns: 1,
        candidateRows: 2,
        pinnedRuns: 0,
        pinnedRunRows: 0,
        interleavedExcludedRuns: 0,
        interleavedExcludedRows: 0,
        removableRuns: 1,
        removableRows: 2,
        protectionsByReason: reasons({
          headDuplicate: { runs: 0, rows: 0 },
          liveLineagePinned: { runs: 0, rows: 0 },
          archivedLineagePinned: { runs: 0, rows: 0 },
          responseEventPinned: { runs: 0, rows: 0 },
          interleavedExcluded: { runs: 0, rows: 0 },
          multiEndpointExcluded: { runs: 3, rows: 9 },
        }),
      }),
    ).toThrow(/count inconsistency/);
  });

  it("multi presence is derived from runs OR rows, and asymmetric presence is rejected (correction 3)", () => {
    const multiOnly = (runs: number, rows: number) => ({
      label: "multi-asym",
      candidateRuns: 0,
      candidateRows: 0,
      pinnedRuns: 0,
      pinnedRunRows: 0,
      interleavedExcludedRuns: 0,
      interleavedExcludedRows: 0,
      removableRuns: 0,
      removableRows: 0,
      protectionsByReason: reasons({
        headDuplicate: { runs: 0, rows: 0 },
        liveLineagePinned: { runs: 0, rows: 0 },
        archivedLineagePinned: { runs: 0, rows: 0 },
        responseEventPinned: { runs: 0, rows: 0 },
        interleavedExcluded: { runs: 0, rows: 0 },
        multiEndpointExcluded: { runs, rows },
      }),
    });
    // Rows without runs: rows require runs to exist — impossible evidence.
    expect(() => validateCompactionScopeCounts(multiOnly(0, 9))).toThrow(
      /count inconsistency/,
    );
    // Runs without rows: the measured complete-run/physical-row exclusion
    // must be symmetric; an all-empty multi-endpoint scope fails closed for
    // operator investigation rather than serializing asymmetric evidence.
    expect(() => validateCompactionScopeCounts(multiOnly(3, 0))).toThrow(
      /count inconsistency/,
    );
  });

  it("a multi-endpoint-excluded scope tolerates NO row-only leakage in any other classification (correction 3)", () => {
    const base = () => ({
      label: "multi-mixed",
      candidateRuns: 0,
      candidateRows: 0,
      pinnedRuns: 0,
      pinnedRunRows: 0,
      interleavedExcludedRuns: 0,
      interleavedExcludedRows: 0,
      removableRuns: 0,
      removableRows: 0,
      protectionsByReason: reasons({
        headDuplicate: { runs: 0, rows: 0 },
        liveLineagePinned: { runs: 0, rows: 0 },
        archivedLineagePinned: { runs: 0, rows: 0 },
        responseEventPinned: { runs: 0, rows: 0 },
        interleavedExcluded: { runs: 0, rows: 0 },
        multiEndpointExcluded: { runs: 3, rows: 9 },
      }),
    });
    // headDuplicate ROW-only leakage beside a valid multi exclusion.
    const headRows = base();
    headRows.protectionsByReason.headDuplicate = { runs: 0, rows: 1 };
    expect(() => validateCompactionScopeCounts(headRows)).toThrow(
      /count inconsistency/,
    );
    // A second row-only leakage in another reason family.
    const eventRows = base();
    eventRows.protectionsByReason.responseEventPinned = { runs: 0, rows: 2 };
    expect(() => validateCompactionScopeCounts(eventRows)).toThrow(
      /count inconsistency/,
    );
    // Scalar ROW-only leakage (pinnedRunRows without pinnedRuns).
    const scalarRows = base();
    scalarRows.pinnedRunRows = 4;
    expect(() => validateCompactionScopeCounts(scalarRows)).toThrow(
      /count inconsistency/,
    );
    // The valid multi-only shape stays green.
    expect(() => validateCompactionScopeCounts(base())).not.toThrow();
    // Totals legitimately mix supported and excluded scopes.
    const totals = base();
    totals.candidateRuns = 6;
    totals.candidateRows = 13;
    totals.pinnedRuns = 4;
    totals.pinnedRunRows = 8;
    totals.interleavedExcludedRuns = 1;
    totals.interleavedExcludedRows = 3;
    totals.removableRuns = 1;
    totals.removableRows = 2;
    totals.protectionsByReason.headDuplicate = { runs: 1, rows: 2 };
    totals.protectionsByReason.liveLineagePinned = { runs: 2, rows: 4 };
    totals.protectionsByReason.archivedLineagePinned = { runs: 1, rows: 2 };
    totals.protectionsByReason.responseEventPinned = { runs: 2, rows: 4 };
    totals.protectionsByReason.interleavedExcluded = { runs: 1, rows: 3 };
    expect(() =>
      validateCompactionScopeCounts({ ...totals, multiEndpointDisjoint: false }),
    ).not.toThrow();
  });

  it("rows cannot be negative or fractional", () => {
    expect(() =>
      validateCompactionScopeCounts({
        ...validScope(),
        removableRows: -1,
        candidateRows: 10,
      }),
    ).toThrow(/count inconsistency/);
  });
});
