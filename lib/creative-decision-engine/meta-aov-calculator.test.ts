import { describe, expect, it, vi } from "vitest";

import type { DbClient } from "@/lib/db";
import {
  computeMetaAttributedAov,
  READ_META_ATTRIBUTED_AOV_SQL,
} from "@/lib/creative-decision-engine/meta-aov-calculator";
import { META_CANONICAL_METRIC_SCHEMA_VERSION } from "@/lib/meta/canonical-metrics";

function dbReturning(rows: Array<Record<string, unknown>>) {
  const query = vi.fn(async (_sql: string, _params?: unknown[]) => rows);
  return {
    db: { query } as unknown as DbClient,
    query,
  };
}

describe("computeMetaAttributedAov", () => {
  it("reads only cutoff-safe finalized canonical facts for the exact Meta account", async () => {
    const { db, query } = dbReturning([
      {
        aov_mean: "58",
        purchase_count: "20",
        total_revenue: "1160",
        window_start: "2026-06-08",
        window_end: "2026-09-05",
      },
    ]);

    const result = await computeMetaAttributedAov({
      businessId: "d0000000-0000-4000-8000-000000000501",
      providerAccountId: " act_5000000000001 ",
      asOf: "2026-09-05",
      db,
    });

    expect(query).toHaveBeenCalledOnce();
    const [sql, params] = query.mock.calls[0]!;
    expect(sql).toBe(READ_META_ATTRIBUTED_AOV_SQL);
    expect(sql).toContain("FROM meta_ad_daily d");
    expect(sql).not.toContain("meta_creative_daily");
    expect(sql).toContain("d.business_ref_id = $1::uuid");
    expect(sql).toContain("d.provider_account_id = $4::text");
    expect(sql).toContain("UPPER(BTRIM(d.truth_state)) = 'FINALIZED'");
    expect(sql).toContain("UPPER(BTRIM(d.validation_status)) = 'PASSED'");
    expect(sql).toContain("d.finalized_at IS NOT NULL");
    for (const clock of ["created_at", "updated_at", "finalized_at"]) {
      expect(sql).toContain(`d.${clock} <= $5::timestamptz`);
    }
    expect(sql).toContain("d.metric_schema_version > $6::integer");
    expect(sql).toContain("COUNT(DISTINCT source_currency)::integer");
    expect(sql).toContain("source_currency_count = 1");
    expect(sql).toContain("NULLIF(UPPER(BTRIM(account.currency)), '') AS bound_account_currency");
    expect(sql).toContain("bound_currency_count = 1");
    expect(sql).toContain("source_currency = bound_account_currency");
    expect(params).toEqual([
      "d0000000-0000-4000-8000-000000000501",
      "2026-09-05",
      90,
      "act_5000000000001",
      "2026-09-05T03:00:00.000Z",
      META_CANONICAL_METRIC_SCHEMA_VERSION,
    ]);
    expect(result).toEqual({
      aovMean: 58,
      purchaseCount: 20,
      totalRevenue: 1160,
      windowStart: "2026-06-08",
      windowEnd: "2026-09-05",
    });
  });

  it("cannot pool sibling accounts when no physical account is named", async () => {
    const { db, query } = dbReturning([
      {
        aov_mean: "999",
        purchase_count: "20",
        total_revenue: "19980",
      },
    ]);

    await expect(
      computeMetaAttributedAov({
        businessId: "d0000000-0000-4000-8000-000000000501",
        providerAccountId: null,
        asOf: "2026-09-05",
        db,
      }),
    ).resolves.toEqual({
      aovMean: null,
      purchaseCount: 0,
      totalRevenue: 0,
      windowStart: "2026-06-08",
      windowEnd: "2026-09-05",
    });
    expect(query).not.toHaveBeenCalled();
  });

  it("refuses an invalid historical cutoff before reading facts", async () => {
    const { db, query } = dbReturning([]);

    await expect(
      computeMetaAttributedAov({
        businessId: "d0000000-0000-4000-8000-000000000501",
        providerAccountId: "act_5000000000001",
        asOf: "2026-02-30",
        db,
      }),
    ).rejects.toThrow("asOf must be a strict");
    expect(query).not.toHaveBeenCalled();
  });
});
