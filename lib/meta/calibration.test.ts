import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  computeMetaPercentiles,
  getMetaCalibrationScope,
  MIN_CAMPAIGN_CALIBRATION_SAMPLE,
  runMetaCalibrationForBusiness,
} from "@/lib/meta/calibration";

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(),
  runDbTransaction: vi.fn((callback: () => Promise<unknown>) => callback()),
}));

const db = await import("@/lib/db");

function makeSqlMock(input: {
  metricRows?: Array<Record<string, unknown>>;
  calibrationRows?: (values: unknown[]) => Array<Record<string, unknown>>;
  matureCount?: (values: unknown[]) => number;
}) {
  const queryCalls: Array<{ text: string; params?: unknown[] }> = [];
  const tagCalls: string[] = [];
  const tag = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    tagCalls.push(text);
    if (text.includes("GROUP BY provider_account_id, campaign_id, adset_id")) {
      return Promise.resolve(input.metricRows ?? []);
    }
    if (text.includes("COUNT(*)::int AS mature_count")) {
      return Promise.resolve([{ mature_count: input.matureCount?.(values) ?? 0 }]);
    }
    if (text.includes("FROM meta_decision_calibration_daily")) {
      return Promise.resolve(input.calibrationRows?.(values) ?? []);
    }
    return Promise.resolve([]);
  }) as unknown as ReturnType<typeof db.getDb>;
  tag.query = vi.fn((text: string, params?: unknown[]) => {
    queryCalls.push({ text, params });
    return Promise.resolve([]);
  });
  return { tag, queryCalls, tagCalls };
}

function metricRow(input: {
  accountId?: string;
  campaignId: string;
  adsetId: string;
  optimizationGoal?: string | null;
  customEventType?: string | null;
  spend: number;
  revenue: number;
  conversions: number;
  impressions?: number;
  clicks?: number;
  reach?: number;
}) {
  return {
    account_id: input.accountId ?? "act_1",
    campaign_id: input.campaignId,
    adset_id: input.adsetId,
    optimization_goal: input.optimizationGoal ?? "PURCHASE",
    custom_event_type: input.customEventType ?? null,
    spend_28d: input.spend,
    revenue_28d: input.revenue,
    conversions_28d: input.conversions,
    impressions_28d: input.impressions ?? 1000,
    clicks_28d: input.clicks ?? 50,
    spend_14d: input.spend / 2,
    impressions_14d: (input.impressions ?? 1000) / 2,
    reach_14d: input.reach ?? 400,
  };
}

function insertedPayload(sql: ReturnType<typeof makeSqlMock>) {
  return JSON.parse(String(sql.queryCalls[0]?.params?.[0] ?? "[]")) as Array<{
    scope_type: string;
    scope_id: string;
    metric_name: string;
    p50: number;
    sample_size: number;
  }>;
}

function calibrationMetricRow(scopeType: "account" | "campaign", scopeId: string) {
  return {
    scope_type: scopeType,
    scope_id: scopeId,
    snapshot_date: "2026-05-06",
    metric_name: "roas_28d",
    p10: 1,
    p25: 1.5,
    p50: 2,
    p75: 3,
    p90: 4,
    sample_size: 12,
  };
}

describe("meta calibration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("computes interpolated percentiles", () => {
    expect(computeMetaPercentiles([1, 2, 3, 4, 5])).toEqual({
      p10: 1.4,
      p25: 2,
      p50: 3,
      p75: 4,
      p90: 4.6,
      sampleSize: 5,
    });
  });

  it("writes account calibration and gates campaign calibration at eight mature adsets", async () => {
    const rows = [
      ...Array.from({ length: MIN_CAMPAIGN_CALIBRATION_SAMPLE }, (_, index) =>
        metricRow({
          campaignId: "cmp_ready",
          adsetId: `ready_${index}`,
          spend: 100 + index,
          revenue: 220 + index * 3,
          conversions: 2 + index,
        }),
      ),
      ...Array.from({ length: MIN_CAMPAIGN_CALIBRATION_SAMPLE - 1 }, (_, index) =>
        metricRow({
          campaignId: "cmp_thin",
          adsetId: `thin_${index}`,
          spend: 80 + index,
          revenue: 120 + index,
          conversions: 1 + index,
        }),
      ),
    ];
    const sql = makeSqlMock({ metricRows: rows });
    vi.mocked(db.getDb).mockReturnValue(sql.tag);

    const result = await runMetaCalibrationForBusiness("biz_1", "2026-05-06");
    const payload = insertedPayload(sql);

    expect(result.accountScopes).toBe(1);
    expect(result.campaignScopes).toBe(1);
    expect(result.sampleRowsTotal).toBe(rows.length);
    expect(result.sampleRowsAfterCohortFilter).toBe(rows.length);
    expect(payload.some((row) => row.scope_type === "account" && row.scope_id === "act_1")).toBe(true);
    expect(payload.some((row) => row.scope_type === "campaign" && row.scope_id === "cmp_ready")).toBe(true);
    expect(payload.some((row) => row.scope_type === "campaign" && row.scope_id === "cmp_thin")).toBe(false);
  });

  it("calibrates ROAS percentiles from purchase adsets only", async () => {
    const rows = [
      metricRow({ campaignId: "cmp_1", adsetId: "purchase_1", spend: 100, revenue: 150, conversions: 2 }),
      metricRow({ campaignId: "cmp_1", adsetId: "purchase_2", spend: 100, revenue: 200, conversions: 3 }),
      metricRow({ campaignId: "cmp_1", adsetId: "purchase_3", spend: 100, revenue: 300, conversions: 4 }),
      metricRow({ campaignId: "cmp_1", adsetId: "purchase_4", spend: 100, revenue: 400, conversions: 5 }),
      metricRow({ campaignId: "cmp_2", adsetId: "thruplay_1", optimizationGoal: "THRUPLAY", spend: 100, revenue: 0, conversions: 0 }),
      metricRow({ campaignId: "cmp_2", adsetId: "thruplay_2", optimizationGoal: "THRUPLAY", spend: 100, revenue: 0, conversions: 0 }),
    ];
    const sql = makeSqlMock({ metricRows: rows });
    vi.mocked(db.getDb).mockReturnValue(sql.tag);

    const result = await runMetaCalibrationForBusiness("biz_1", "2026-05-06");
    const roasRow = insertedPayload(sql).find((row) =>
      row.scope_type === "account" && row.scope_id === "act_1" && row.metric_name === "roas_28d"
    );

    expect(result.sampleRowsTotal).toBe(6);
    expect(result.sampleRowsAfterCohortFilter).toBe(4);
    expect(roasRow?.sample_size).toBe(4);
    expect(roasRow?.p50).toBe(2.5);
  });

  it("groups calibration rows by goal and event before cohort filtering", async () => {
    const rows = [
      metricRow({ campaignId: "cmp_1", adsetId: "mixed_1", optimizationGoal: "OFFSITE_CONVERSIONS", customEventType: "PURCHASE", spend: 100, revenue: 300, conversions: 3 }),
      metricRow({ campaignId: "cmp_1", adsetId: "mixed_1", optimizationGoal: "OFFSITE_CONVERSIONS", customEventType: "ADD_TO_CART", spend: 100, revenue: 0, conversions: 10 }),
    ];
    const sql = makeSqlMock({ metricRows: rows });
    vi.mocked(db.getDb).mockReturnValue(sql.tag);

    const result = await runMetaCalibrationForBusiness("biz_1", "2026-05-06");
    const aggregateSql = sql.tagCalls.find((text) =>
      text.includes("FROM meta_adset_daily") && text.includes("GROUP BY provider_account_id")
    );
    const roasRow = insertedPayload(sql).find((row) =>
      row.scope_type === "account" && row.scope_id === "act_1" && row.metric_name === "roas_28d"
    );

    expect(aggregateSql).toContain("GROUP BY provider_account_id, campaign_id, adset_id, optimization_goal, custom_event_type");
    expect(aggregateSql).not.toContain("MAX(optimization_goal)");
    expect(aggregateSql).not.toContain("MAX(custom_event_type)");
    expect(result.sampleRowsTotal).toBe(2);
    expect(result.sampleRowsAfterCohortFilter).toBe(1);
    expect(roasRow?.sample_size).toBe(1);
    expect(roasRow?.p50).toBe(3);
  });

  it("writes zero calibration rows when the account has no purchase adsets", async () => {
    const rows = [
      metricRow({ campaignId: "cmp_1", adsetId: "thruplay_1", optimizationGoal: "THRUPLAY", spend: 100, revenue: 0, conversions: 0 }),
      metricRow({ campaignId: "cmp_1", adsetId: "thruplay_2", optimizationGoal: "THRUPLAY", spend: 100, revenue: 0, conversions: 0 }),
    ];
    const sql = makeSqlMock({ metricRows: rows });
    vi.mocked(db.getDb).mockReturnValue(sql.tag);

    const result = await runMetaCalibrationForBusiness("biz_1", "2026-05-06");

    expect(result.rowsWritten).toBe(0);
    expect(result.accountScopes).toBe(0);
    expect(result.campaignScopes).toBe(0);
    expect(result.sampleRowsTotal).toBe(2);
    expect(result.sampleRowsAfterCohortFilter).toBe(0);
    expect(sql.queryCalls).toHaveLength(0);
  });

  it("excludes ADD_TO_CART custom-event adsets even under a sales optimization goal", async () => {
    const rows = [
      metricRow({ campaignId: "cmp_1", adsetId: "purchase_1", optimizationGoal: "OFFSITE_CONVERSIONS", customEventType: "PURCHASE", spend: 100, revenue: 300, conversions: 3 }),
      metricRow({ campaignId: "cmp_1", adsetId: "atc_1", optimizationGoal: "OFFSITE_CONVERSIONS", customEventType: "ADD_TO_CART", spend: 100, revenue: 100, conversions: 10 }),
    ];
    const sql = makeSqlMock({ metricRows: rows });
    vi.mocked(db.getDb).mockReturnValue(sql.tag);

    const result = await runMetaCalibrationForBusiness("biz_1", "2026-05-06");
    const roasRow = insertedPayload(sql).find((row) =>
      row.scope_type === "account" && row.scope_id === "act_1" && row.metric_name === "roas_28d"
    );

    expect(result.sampleRowsTotal).toBe(2);
    expect(result.sampleRowsAfterCohortFilter).toBe(1);
    expect(result.sampleRowsAfterCohortFilter).toBeLessThan(result.sampleRowsTotal);
    expect(roasRow?.sample_size).toBe(1);
    expect(roasRow?.p50).toBe(3);
  });

  it("returns campaign fallback reasons and account-missing legacy fallback", async () => {
    const sql = makeSqlMock({
      calibrationRows: (values) => {
        const scopeType = values[1];
        const scopeId = values[2];
        if (scopeType === "account" && scopeId === "act_1") {
          return [calibrationMetricRow("account", "act_1")];
        }
        return [];
      },
      matureCount: (values) => (values.includes("cmp_thin") ? 7 : 9),
    });
    vi.mocked(db.getDb).mockReturnValue(sql.tag);

    const thin = await getMetaCalibrationScope("biz_1", {
      accountId: "act_1",
      campaignId: "cmp_thin",
      snapshotDate: "2026-05-06",
    });
    const missing = await getMetaCalibrationScope("biz_1", {
      accountId: "act_1",
      campaignId: "cmp_missing",
      snapshotDate: "2026-05-06",
    });

    expect(thin.scope.type).toBe("account");
    expect(thin.reason).toBe("campaign_sample_below_threshold");
    expect(missing.scope.type).toBe("account");
    expect(missing.reason).toBe("campaign_calibration_missing");

    const noAccountSql = makeSqlMock({
      calibrationRows: () => [],
      matureCount: () => 9,
    });
    vi.mocked(db.getDb).mockReturnValue(noAccountSql.tag);

    const noAccount = await getMetaCalibrationScope("biz_1", {
      accountId: "act_missing",
      snapshotDate: "2026-05-06",
    });
    expect(noAccount.reason).toBe("account_calibration_missing");
    expect(noAccount.thresholds.source).toBe("legacy_fallback");
  });
});
