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
    if (text.includes("GROUP BY adset.provider_account_id, adset.campaign_id, adset.adset_id")) {
      return Promise.resolve(input.metricRows ?? []);
    }
    if (text.includes("WITH adset_samples")) {
      const count = input.matureCount?.(values) ?? 0;
      return Promise.resolve(
        Array.from({ length: count }, (_, index) => ({
          adset_id: `mature_${index}`,
          optimization_goal: "PURCHASE",
          custom_event_type: null,
          spend_28d: 100,
          impressions_28d: 1000,
        })),
      );
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
  linkClicks?: number;
  addToCart?: number;
  initiateCheckout?: number;
  viewContent?: number;
  landingPageViews?: number;
  thruplayActions?: number;
  postEngagement?: number;
  leads?: number;
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
    link_clicks_28d: input.linkClicks ?? input.clicks ?? 50,
    add_to_cart_28d: input.addToCart ?? 0,
    initiate_checkout_28d: input.initiateCheckout ?? 0,
    view_content_28d: input.viewContent ?? 0,
    landing_page_views_28d: input.landingPageViews ?? 0,
    thruplay_actions_28d: input.thruplayActions ?? 0,
    post_engagement_28d: input.postEngagement ?? 0,
    leads_28d: input.leads ?? 0,
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
    cohort: string;
    p25: number;
    p50: number;
    p75: number;
    sample_size: number;
  }>;
}

function calibrationMetricRow(scopeType: "account" | "campaign", scopeId: string, cohort = "purchase") {
  return {
    scope_type: scopeType,
    scope_id: scopeId,
    snapshot_date: "2026-05-06",
    metric_name: "roas_28d",
    cohort,
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
    expect(result.sampleRowsByCohort.purchase).toBe(rows.length);
    expect(payload.some((row) => row.scope_type === "account" && row.scope_id === "act_1")).toBe(true);
    expect(payload.some((row) => row.scope_type === "campaign" && row.scope_id === "cmp_ready")).toBe(true);
    expect(payload.some((row) => row.scope_type === "campaign" && row.scope_id === "cmp_thin")).toBe(false);
  });

  it("writes purchase rows and skips mid_funnel calibration when the cohort sample is below eight", async () => {
    const rows = [
      ...Array.from({ length: 10 }, (_, index) =>
        metricRow({
          campaignId: "cmp_purchase",
          adsetId: `purchase_${index}`,
          spend: 100,
          revenue: 150 + index * 10,
          conversions: 2 + index,
        }),
      ),
      ...Array.from({ length: 3 }, (_, index) =>
        metricRow({
          campaignId: "cmp_atc",
          adsetId: `atc_${index}`,
          optimizationGoal: "OFFSITE_CONVERSIONS",
          customEventType: "ADD_TO_CART",
          spend: 80,
          revenue: 0,
          conversions: 0,
          addToCart: 10 + index,
        }),
      ),
    ];
    const sql = makeSqlMock({ metricRows: rows });
    vi.mocked(db.getDb).mockReturnValue(sql.tag);

    const result = await runMetaCalibrationForBusiness("biz_1", "2026-05-06");
    const payload = insertedPayload(sql);

    expect(payload.some((row) => row.cohort === "purchase" && row.metric_name === "roas_28d")).toBe(true);
    expect(payload.some((row) => row.cohort === "mid_funnel")).toBe(false);
    expect(result.sampleRowsByCohort.purchase).toBe(10);
    expect(result.sampleRowsByCohort.mid_funnel).toBe(3);
  });

  it("writes mid_funnel percentile rows when the cohort has eight mature adsets", async () => {
    const rows = [
      metricRow({ campaignId: "cmp_purchase", adsetId: "purchase_1", spend: 100, revenue: 300, conversions: 3 }),
      ...Array.from({ length: 8 }, (_, index) =>
        metricRow({
          campaignId: "cmp_atc",
          adsetId: `atc_${index}`,
          optimizationGoal: "OFFSITE_CONVERSIONS",
          customEventType: "ADD_TO_CART",
          spend: 80 + index,
          revenue: index,
          conversions: index % 2,
          impressions: 1000,
          clicks: 40 + index,
          addToCart: 8 + index,
          initiateCheckout: 3 + index,
          viewContent: 20 + index,
        }),
      ),
    ];
    const sql = makeSqlMock({ metricRows: rows });
    vi.mocked(db.getDb).mockReturnValue(sql.tag);

    const result = await runMetaCalibrationForBusiness("biz_1", "2026-05-06");
    const payload = insertedPayload(sql);
    const midMetrics = new Set(
      payload
        .filter((row) => row.cohort === "mid_funnel" && row.scope_type === "account")
        .map((row) => row.metric_name),
    );

    expect(result.sampleRowsByCohort.purchase).toBe(1);
    expect(result.sampleRowsByCohort.mid_funnel).toBe(8);
    expect([...midMetrics]).toEqual(expect.arrayContaining([
      "cost_per_atc_28d",
      "atc_rate_28d",
      "atc_to_purchase_rate_28d",
      "ctr_28d",
    ]));
  });

  it("calibrates ROAS percentiles from the purchase cohort without pooling non-purchase rows", async () => {
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
    expect(result.sampleRowsByCohort.purchase).toBe(4);
    expect(result.sampleRowsByCohort.upper_funnel).toBe(2);
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
      text.includes("FROM meta_adset_daily") && text.includes("GROUP BY adset.provider_account_id")
    );
    const roasRow = insertedPayload(sql).find((row) =>
      row.scope_type === "account" && row.scope_id === "act_1" && row.metric_name === "roas_28d"
    );

    expect(aggregateSql).toContain("GROUP BY adset.provider_account_id, adset.campaign_id, adset.adset_id, adset.optimization_goal, adset.custom_event_type");
    expect(aggregateSql).not.toContain("MAX(optimization_goal)");
    expect(aggregateSql).not.toContain("MAX(custom_event_type)");
    expect(result.sampleRowsTotal).toBe(2);
    expect(result.sampleRowsByCohort.purchase).toBe(1);
    expect(result.sampleRowsByCohort.mid_funnel).toBe(1);
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
    expect(result.sampleRowsByCohort.purchase).toBe(0);
    expect(result.sampleRowsByCohort.upper_funnel).toBe(2);
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
    expect(result.sampleRowsByCohort.purchase).toBe(1);
    expect(result.sampleRowsByCohort.mid_funnel).toBe(1);
    expect(result.sampleRowsByCohort.purchase).toBeLessThan(result.sampleRowsTotal);
    expect(roasRow?.sample_size).toBe(1);
    expect(roasRow?.p50).toBe(3);
  });

  it("excludes unknown-cohort adsets entirely from calibration writes", async () => {
    const rows = [
      metricRow({
        campaignId: "cmp_unknown",
        adsetId: "unknown_1",
        optimizationGoal: "SOME_NEW_GOAL",
        customEventType: null,
        spend: 100,
        revenue: 0,
        conversions: 0,
      }),
    ];
    const sql = makeSqlMock({ metricRows: rows });
    vi.mocked(db.getDb).mockReturnValue(sql.tag);

    const result = await runMetaCalibrationForBusiness("biz_1", "2026-05-06");

    expect(result.rowsWritten).toBe(0);
    expect(result.sampleRowsByCohort.unknown).toBe(1);
    expect(sql.queryCalls).toHaveLength(0);
  });

  it("coexists purchase and mid_funnel rows for the same scope and metric through the cohort PK", async () => {
    const rows = [
      ...Array.from({ length: 8 }, (_, index) =>
        metricRow({
          campaignId: "cmp_purchase",
          adsetId: `purchase_${index}`,
          spend: 100,
          revenue: 240 + index,
          conversions: 3 + index,
          clicks: 30 + index,
        }),
      ),
      ...Array.from({ length: 8 }, (_, index) =>
        metricRow({
          campaignId: "cmp_atc",
          adsetId: `atc_${index}`,
          optimizationGoal: "OFFSITE_CONVERSIONS",
          customEventType: "ADD_TO_CART",
          spend: 90,
          revenue: 10,
          conversions: 1,
          clicks: 45 + index,
          addToCart: 9 + index,
          initiateCheckout: 4 + index,
          viewContent: 25 + index,
        }),
      ),
    ];
    const sql = makeSqlMock({ metricRows: rows });
    vi.mocked(db.getDb).mockReturnValue(sql.tag);

    await runMetaCalibrationForBusiness("biz_1", "2026-05-06");
    const payload = insertedPayload(sql);
    const accountCtrRows = payload.filter((row) =>
      row.scope_type === "account" && row.scope_id === "act_1" && row.metric_name === "ctr_28d"
    );

    expect(accountCtrRows.map((row) => row.cohort).sort()).toEqual(["mid_funnel", "purchase"]);
    expect(sql.queryCalls[0]?.text).toContain(
      "ON CONFLICT (business_id, scope_type, scope_id, snapshot_date, metric_name, cohort)",
    );
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
