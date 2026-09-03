// D077 acceptance correction 3: safety-critical planner counts are parsed
// strictly. A PostgreSQL COUNT string is accepted; null/malformed count
// evidence REFUSES the planner before any plan or hash can be serialized —
// it is never manufactured into a measured zero. These tests exercise the
// REAL plan-construction path through a mock SQL client.
import { describe, expect, it } from "vitest";
import {
  planStateHistoryCompaction,
  type SqlClient,
} from "@/lib/meta/state-history-compaction";

type Row = Record<string, unknown>;

function mockSql(overrides: {
  completeRuns?: unknown;
  liveRows?: unknown;
  detailRows?: Row[];
  multiRows?: unknown;
  twoEndpoints?: boolean;
}): SqlClient {
  const scopeRow = (endpoint: string): Row => ({
    business_id: "biz-1",
    provider_account_id: "act-1",
    entity_type: "adset",
    endpoint,
    complete_runs: "completeRuns" in overrides ? overrides.completeRuns : "3",
    max_run_id: "00000000-0000-0000-0000-000000000001",
  });
  return {
    query: async <T extends Row>(text: string): Promise<T[]> => {
      if (text.includes("transaction_read_only")) {
        return [{ transaction_read_only: "on" }] as unknown as T[];
      }
      if (text.includes("transaction_isolation")) {
        return [{ transaction_isolation: "repeatable read" }] as unknown as T[];
      }
      if (text.includes("GROUP BY 1, 2, 3, 4")) {
        return (
          overrides.twoEndpoints
            ? [scopeRow("endpoint_one"), scopeRow("endpoint_two")]
            : [scopeRow("endpoint_one")]
        ) as unknown as T[];
      }
      if (text.includes("to_regclass")) {
        return [{ present: false }] as unknown as T[];
      }
      if (text.includes("run_manifest")) {
        return (overrides.detailRows ?? []) as unknown as T[];
      }
      if (text.includes("transitions")) {
        return [] as unknown as T[];
      }
      if (text.includes("live_rows")) {
        return [
          { live_rows: "liveRows" in overrides ? overrides.liveRows : "5" },
        ] as unknown as T[];
      }
      if (text.includes("COUNT(s.id)::bigint AS rows")) {
        return [
          { rows: "multiRows" in overrides ? overrides.multiRows : "3" },
        ] as unknown as T[];
      }
      if (
        text.includes("pg_total_relation_size") ||
        text.includes("pg_extension") ||
        text.includes("pg_table_size")
      ) {
        if (text.includes("pg_total_relation_size")) {
          return [{ raw_bytes: "1000" }] as unknown as T[];
        }
        if (text.includes("pg_extension")) {
          return [{ present: false }] as unknown as T[];
        }
        return [{ bytes: "800" }] as unknown as T[];
      }
      return [] as unknown as T[];
    },
  };
}

describe("planStateHistoryCompaction strict count evidence (correction 3)", () => {
  it("accepts PostgreSQL string counts through the real plan path", async () => {
    const plan = await planStateHistoryCompaction(mockSql({}), {
      businessIds: ["biz-1"],
    });
    expect(plan.scopes).toHaveLength(1);
    expect(plan.scopes[0]!.completeRuns).toBe(3);
    expect(plan.status).toBe("nothing_to_do");
    expect(plan.planHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses NULL live-row count evidence — no plan, no hash", async () => {
    await expect(
      planStateHistoryCompaction(mockSql({ liveRows: null }), {
        businessIds: ["biz-1"],
      }),
    ).rejects.toThrow(/count evidence.*live_rows/i);
  });

  it("refuses malformed string count evidence with the count named", async () => {
    await expect(
      planStateHistoryCompaction(mockSql({ liveRows: "garbage" }), {
        businessIds: ["biz-1"],
      }),
    ).rejects.toThrow(/count evidence.*live_rows/i);
    await expect(
      planStateHistoryCompaction(mockSql({ completeRuns: "12abc" }), {
        businessIds: ["biz-1"],
      }),
    ).rejects.toThrow(/count evidence/i);
  });

  it("refuses negative, fractional, and non-finite counts", async () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(
        planStateHistoryCompaction(mockSql({ liveRows: bad }), {
          businessIds: ["biz-1"],
        }),
      ).rejects.toThrow(/count evidence/i);
    }
  });

  it("refuses malformed physical-row evidence on a candidate run", async () => {
    await expect(
      planStateHistoryCompaction(
        mockSql({
          detailRows: [
            {
              run_id: "00000000-0000-0000-0000-000000000002",
              physical_rows: null,
              manifest_sig: "sig",
              observed_at: "2026-06-02T00:00:00Z",
              previous_observed_at: "2026-06-01T00:00:00Z",
              recency_rank: "2",
              pinned_live: false,
              pinned_archived: false,
              pinned_event: false,
              interleaved_partial: false,
            },
          ],
        }),
        { businessIds: ["biz-1"] },
      ),
    ).rejects.toThrow(/count evidence.*physical_rows/i);
  });

  it("refuses malformed multi-endpoint row evidence instead of measuring zero", async () => {
    await expect(
      planStateHistoryCompaction(
        mockSql({ twoEndpoints: true, multiRows: null }),
        { businessIds: ["biz-1"] },
      ),
    ).rejects.toThrow(/count evidence/i);
  });
});
