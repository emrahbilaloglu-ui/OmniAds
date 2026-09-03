// D077 acceptance correction 3: durable proof that the canonical execution
// payload hash BINDS the per-reason protection counts — including the
// multi-endpoint exclusion — and that the executor's payload-integrity gate
// refuses a stale hash after any such mutation, before any write.
import { describe, expect, it } from "vitest";
import {
  computeExecutionPayloadHash,
  expectedApprovalToken,
  STATE_HISTORY_COMPACTION_CONTRACT,
  type StateHistoryCompactionPlan,
} from "@/lib/meta/state-history-compaction";
import { executeStateHistoryCompaction } from "@/lib/meta/state-history-compaction-executor";

function protections(multi: { runs: number; rows: number }) {
  return {
    headDuplicate: { runs: 0, rows: 0 },
    liveLineagePinned: { runs: 0, rows: 0 },
    archivedLineagePinned: { runs: 0, rows: 0 },
    responseEventPinned: { runs: 0, rows: 0 },
    interleavedExcluded: { runs: 0, rows: 0 },
    multiEndpointExcluded: multi,
  };
}

function planShape(): Omit<StateHistoryCompactionPlan, "planHash"> {
  return {
    contract: STATE_HISTORY_COMPACTION_CONTRACT,
    businessIds: ["biz-1"],
    scopes: [
      {
        businessId: "biz-1",
        providerAccountId: "act-1",
        entityType: "adset",
        endpoint: "endpoint_one",
        completeRuns: 3,
        candidateRuns: 0,
        candidateRows: 0,
        pinnedRuns: 0,
        pinnedRunRows: 0,
        removableRuns: 0,
        removableRows: 0,
        interleavedExcludedRuns: 0,
        interleavedExcludedRows: 0,
        removable: [],
        multiEndpointUnsupported: true,
        protectionsByReason: protections({ runs: 3, rows: 9 }),
      },
    ],
    timelines: [],
    totals: {
      candidateRuns: 0,
      candidateRows: 0,
      pinnedRuns: 0,
      pinnedRunRows: 0,
      removableRuns: 0,
      removableRows: 0,
      protectionsByReason: protections({ runs: 3, rows: 9 }),
    },
    fence: {
      metric: "raw_fallback",
      rawBytes: 1000,
      heapBytes: null,
      effectiveBytes: 1000,
      budgetBytes: 5000,
      breachedRaw: false,
      breachedEffective: false,
      provenFreeSpaceBytes: null,
      fallbackReason: "extension_missing",
    } as never,
    fenceProjection: {
      raw: { clearedByDeleteAlone: false, detail: "raw" },
      effectiveReusableHeap: {
        proofAvailable: false,
        projectedFreedHeapBytes: null,
        projectedEffectiveBytes: null,
        budgetBytes: 5000,
        cleared: null,
        preconditions: [],
      },
    },
    status: "nothing_to_do",
    insufficiencyReasons: ["no_removable_rows"],
    scopeFingerprint: "f".repeat(64),
  };
}

describe("multi-endpoint exclusion is hash-bound (correction 3)", () => {
  it("mutating a scope's multiEndpointExcluded runs or rows changes the canonical hash", () => {
    const base = planShape();
    const baseHash = computeExecutionPayloadHash(base);
    const runsMutated = planShape();
    runsMutated.scopes[0]!.protectionsByReason.multiEndpointExcluded = {
      runs: 4,
      rows: 9,
    };
    const rowsMutated = planShape();
    rowsMutated.scopes[0]!.protectionsByReason.multiEndpointExcluded = {
      runs: 3,
      rows: 10,
    };
    expect(computeExecutionPayloadHash(runsMutated)).not.toBe(baseHash);
    expect(computeExecutionPayloadHash(rowsMutated)).not.toBe(baseHash);
  });

  it("mutating totals' multiEndpointExcluded runs or rows changes the canonical hash", () => {
    const base = planShape();
    const baseHash = computeExecutionPayloadHash(base);
    const runsMutated = planShape();
    runsMutated.totals.protectionsByReason.multiEndpointExcluded = {
      runs: 4,
      rows: 9,
    };
    const rowsMutated = planShape();
    rowsMutated.totals.protectionsByReason.multiEndpointExcluded = {
      runs: 3,
      rows: 10,
    };
    expect(computeExecutionPayloadHash(runsMutated)).not.toBe(baseHash);
    expect(computeExecutionPayloadHash(rowsMutated)).not.toBe(baseHash);
  });

  it("a stale planHash cannot validate after a multi-endpoint count mutation: the executor refuses before any write", async () => {
    const base = planShape();
    const staleHash = computeExecutionPayloadHash(base);
    const mutated = planShape();
    mutated.scopes[0]!.protectionsByReason.multiEndpointExcluded = {
      runs: 4,
      rows: 12,
    };
    mutated.totals.protectionsByReason.multiEndpointExcluded = {
      runs: 4,
      rows: 12,
    };
    // The tampered payload carries the ORIGINAL hash and its token: the
    // executor's payload-integrity gate (hash recomputation) must refuse
    // with zero writes — this runs entirely inside the validation phase,
    // before any database access.
    const result = await executeStateHistoryCompaction({
      plan: { ...mutated, planHash: staleHash },
      approvalToken: expectedApprovalToken(staleHash),
      acknowledgePhysicalShrinkRequired: true,
    });
    expect(result.status).toBe("refused");
    expect(result.refusalReason).toBe("plan_payload_tampered");
    expect(result.batchesExecuted).toBe(0);
    expect(result.rowsDeleted).toBe(0);
  });
});
