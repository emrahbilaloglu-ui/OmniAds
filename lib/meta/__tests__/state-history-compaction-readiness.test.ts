// D077 hardening: the readiness read model is business-scoped, measured,
// display-only, and fails visible — never empty/ready.
import { describe, expect, it } from "vitest";
import {
  readStateHistoryCompactionReadiness,
} from "@/lib/meta/state-history-compaction-readiness";

type Call = { text: string; params: unknown[] };

function mockDb(handler: (text: string, params: unknown[]) => unknown[]) {
  const calls: Call[] = [];
  return {
    calls,
    query: async <T extends Record<string, unknown>>(
      text: string,
      params: unknown[] = [],
    ): Promise<T[]> => {
      calls.push({ text, params });
      return handler(text, params) as T[];
    },
  };
}

function fenceRows(text: string): unknown[] | null {
  if (text.includes("pg_total_relation_size")) {
    return [{ raw_bytes: "1000" }];
  }
  if (text.includes("pg_extension")) return [{ present: false }];
  if (text.includes("pg_table_size")) return [{ bytes: "800" }];
  return null;
}

describe("readStateHistoryCompactionReadiness", () => {
  it("scopes the journal read to the requested business (multi-business plans included)", async () => {
    const db = mockDb((text) => {
      const fence = fenceRows(text);
      if (fence) return fence;
      if (text.includes("meta_state_history_compaction_journal")) {
        return [
          {
            event: "completed",
            plan_hash: "a".repeat(64),
            rows_deleted: "10",
            created_at: "2026-08-30T00:00:00Z",
          },
        ];
      }
      if (text.includes("manifest_kind")) return [{ observed: true }];
      return [];
    });
    const readiness = await readStateHistoryCompactionReadiness(db, {
      businessId: "biz-1",
    });
    const journalCall = db.calls.find((call) =>
      call.text.includes("meta_state_history_compaction_journal"),
    );
    expect(journalCall).toBeDefined();
    // The canonical business id travels as a SQL parameter and the predicate
    // is membership in the plan's business_ids array — a multi-business plan
    // containing this business matches; a global latest-N does not exist.
    expect(journalCall!.text).toContain("$1 = ANY(business_ids)");
    expect(journalCall!.params).toEqual(["biz-1"]);
    expect(readiness.businessId).toBe("biz-1");
    expect(readiness.approvalStatus).toBe("EXECUTED_SEE_JOURNAL");
    expect(readiness.latestJournal).toHaveLength(1);
  });

  it("measures D075 writer evidence: observed when manifest_kind rows exist", async () => {
    const db = mockDb((text) => {
      const fence = fenceRows(text);
      if (fence) return fence;
      if (text.includes("manifest_kind")) return [{ observed: true }];
      return [];
    });
    const readiness = await readStateHistoryCompactionReadiness(db, {
      businessId: "biz-1",
    });
    expect(readiness.d075WriterEvidence.state).toBe("observed");
    expect(
      readiness.blockers.some((blocker) => blocker.startsWith("d075_writer")),
    ).toBe(false);
  });

  it("reports not_observed as absence of evidence, never as a deployment claim", async () => {
    const db = mockDb((text) => {
      const fence = fenceRows(text);
      if (fence) return fence;
      if (text.includes("manifest_kind")) return [{ observed: false }];
      return [];
    });
    const readiness = await readStateHistoryCompactionReadiness(db, {
      businessId: "biz-1",
    });
    expect(readiness.d075WriterEvidence.state).toBe("not_observed");
    expect(readiness.d075WriterEvidence.detail).toContain(
      "absence of evidence",
    );
    expect(
      readiness.blockers.some((blocker) =>
        blocker.startsWith("d075_writer_evidence_not_observed"),
      ),
    ).toBe(true);
    // The withdrawn hard-coded assertion must not return.
    expect(JSON.stringify(readiness)).not.toContain(
      "d075_delta_manifests_not_deployed",
    );
  });

  it("reports unknown when the evidence measurement itself fails", async () => {
    const db = mockDb((text) => {
      const fence = fenceRows(text);
      if (fence) return fence;
      if (text.includes("manifest_kind")) {
        throw new Error("boom");
      }
      return [];
    });
    const readiness = await readStateHistoryCompactionReadiness(db, {
      businessId: "biz-1",
    });
    expect(readiness.d075WriterEvidence.state).toBe("unknown");
    expect(readiness.blockers).toContain("d075_writer_evidence_unknown");
  });

  it("a failed read is visibly unavailable, never empty/ready", async () => {
    // The fence measurer itself fails closed to an explicit unavailable
    // measurement (it never throws), the journal read reports its OWN
    // unavailable provenance (v3: UNKNOWN_JOURNAL_UNAVAILABLE + blocker,
    // never an empty array presented as NOT_EXECUTED), and the D075
    // evidence reports unknown — every field states its own failure
    // rather than looking ready.
    const db = mockDb(() => {
      throw new Error("db down");
    });
    const readiness = await readStateHistoryCompactionReadiness(db, {
      businessId: "biz-1",
    });
    expect(readiness.fence?.metric).toBe("unavailable");
    expect(readiness.blockers).toContain("fence_measurement_unavailable");
    // Acceptance correction: a total outage includes the journal, so the
    // execution state is UNKNOWN — never a factual "NOT_EXECUTED" claim.
    expect(readiness.approvalStatus).toBe("UNKNOWN_JOURNAL_UNAVAILABLE");
    expect(readiness.journalRead).toBe("unavailable");
    expect(readiness.blockers).toContain("compaction_journal_read_unavailable");
    expect(readiness.d075WriterEvidence.state).toBe("unknown");
  });

  it("a journal-ONLY read failure is an explicit unavailable state, never NOT_EXECUTED/empty (acceptance correction)", async () => {
    // Fence and D075 reads succeed; only the business-scoped journal query
    // fails. The rejected implementation swallowed this to [] and claimed
    // "NOT_EXECUTED — no journal entries", conflating unreadable with
    // proven empty.
    const db = mockDb((text) => {
      const fence = fenceRows(text);
      if (fence) return fence;
      if (text.includes("meta_state_history_compaction_journal")) {
        throw new Error("journal down");
      }
      if (text.includes("manifest_kind")) return [{ observed: true }];
      return [];
    });
    const readiness = await readStateHistoryCompactionReadiness(db, {
      businessId: "biz-1",
    });
    expect(readiness.journalRead).toBe("unavailable");
    expect(readiness.approvalStatus).toBe("UNKNOWN_JOURNAL_UNAVAILABLE");
    expect(readiness.blockers).toContain(
      "compaction_journal_read_unavailable",
    );
    expect(readiness.latestJournal).toEqual([]);
    // The measured D075 evidence is unaffected by the journal outage.
    expect(readiness.d075WriterEvidence.state).toBe("observed");
  });

  it("a successful EMPTY business-scoped journal is honestly NOT_EXECUTED", async () => {
    const db = mockDb((text) => {
      const fence = fenceRows(text);
      if (fence) return fence;
      if (text.includes("manifest_kind")) return [{ observed: true }];
      return [];
    });
    const readiness = await readStateHistoryCompactionReadiness(db, {
      businessId: "biz-1",
    });
    expect(readiness.journalRead).toBe("ok");
    expect(readiness.approvalStatus).toBe("NOT_EXECUTED");
    expect(readiness.blockers).not.toContain(
      "compaction_journal_read_unavailable",
    );
  });

  it("returns no approval token and no executable affordance", async () => {
    const db = mockDb((text) => fenceRows(text) ?? []);
    const readiness = await readStateHistoryCompactionReadiness(db, {
      businessId: "biz-1",
    });
    const serialized = JSON.stringify(readiness);
    expect(serialized).not.toContain("approve-state-history-compaction");
    expect(serialized).not.toContain("approvalToken");
    expect(readiness.plannedReclaim).toBeNull();
  });
});
