import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MetaCampaignRow } from "@/app/api/meta/campaigns/route";
import { LEGACY_META_CALIBRATION_THRESHOLDS } from "@/lib/meta/calibration";
import {
  readMetaDecisionSnapshotForRange,
  runMetaSnapshotForAllBusinesses,
  runMetaSnapshotForBusiness,
} from "@/lib/meta/snapshot";

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(),
}));

vi.mock("@/lib/sync/active-businesses", () => ({
  getActiveBusinesses: vi.fn(),
}));

vi.mock("@/lib/meta/calibration", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/meta/calibration")>();
  return {
    ...actual,
    runMetaCalibrationForBusiness: vi.fn(),
    getMetaCalibrationScope: vi.fn(),
  };
});

vi.mock("@/lib/meta/campaigns-source", () => ({
  getMetaCampaignsForRange: vi.fn(),
}));

vi.mock("@/lib/meta/adsets-source", () => ({
  getMetaAdSetsForRange: vi.fn(),
}));

vi.mock("@/lib/meta/breakdowns-source", () => ({
  getMetaBreakdownsForRange: vi.fn(),
}));

vi.mock("@/lib/meta/config-snapshots", () => ({
  readMetaBidRegimeHistorySummaries: vi.fn(),
}));

vi.mock("@/lib/meta/campaign-labels", () => ({
  readMetaCampaignLabels: vi.fn(async () => []),
}));

vi.mock("@/lib/meta/anomalies", () => ({
  detectAnomaliesForBusiness: vi.fn(),
}));

vi.mock("@/lib/meta/evidence-trail", () => ({
  buildEvidenceTrailsForRecommendations: vi.fn(),
}));

vi.mock("@/lib/meta/entity-signals", () => ({
  readMetaEntityDecisionSignalsDaily: vi.fn(),
}));

vi.mock("@/lib/meta/entity-signals-backfill", () => ({
  runMetaSignalsBackfillForBusiness: vi.fn(),
}));

vi.mock("@/lib/meta/commercial-targets", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/meta/commercial-targets")>();
  return {
    ...actual,
    readMetaCommercialTargets: vi.fn(async () => ({
      source: "configured_targets",
      targetRoas: 2.2,
      breakEvenRoas: 1.5,
      targetCpa: 120,
      breakEvenCpa: 160,
      riskPosture: "balanced",
    })),
  };
});

const db = await import("@/lib/db");
const activeBusinesses = await import("@/lib/sync/active-businesses");
const calibration = await import("@/lib/meta/calibration");
const campaignSource = await import("@/lib/meta/campaigns-source");
const adsetsSource = await import("@/lib/meta/adsets-source");
const breakdownsSource = await import("@/lib/meta/breakdowns-source");
const configSnapshots = await import("@/lib/meta/config-snapshots");
const campaignLabels = await import("@/lib/meta/campaign-labels");
const anomalies = await import("@/lib/meta/anomalies");
const evidenceTrail = await import("@/lib/meta/evidence-trail");
const entitySignals = await import("@/lib/meta/entity-signals");
const entitySignalsBackfill = await import("@/lib/meta/entity-signals-backfill");

function makeSqlMock(tagRows: unknown[] = []) {
  const calls: string[] = [];
  const queryPayloads: unknown[] = [];
  const tag = vi.fn((strings: TemplateStringsArray) => {
    calls.push(strings.join("?"));
    return Promise.resolve(tagRows);
  }) as unknown as ReturnType<typeof db.getDb>;
  tag.query = vi.fn((text: string, params?: unknown[]) => {
    calls.push(text);
    queryPayloads.push(params?.[0]);
    return Promise.resolve([]);
  });
  return { tag, calls, queryPayloads };
}

function campaign(overrides: Partial<MetaCampaignRow> = {}) {
  return {
    id: "cmp_1",
    accountId: "act_1",
    name: "Campaign 1",
    status: "ACTIVE",
    objective: "OUTCOME_SALES",
    optimizationGoal: "Purchase",
    spend: 1500,
    purchases: 24,
    revenue: 4800,
    roas: 3.2,
    cpa: 62.5,
    ctr: 1.4,
    cpm: 12,
    impressions: 10000,
    clicks: 140,
    isBudgetMixed: false,
    isConfigMixed: false,
    isOptimizationGoalMixed: false,
    isBidStrategyMixed: false,
    isBidValueMixed: false,
    bidStrategyType: "lowest_cost",
    bidStrategyLabel: "Lowest Cost",
    bidValue: null,
    bidValueFormat: null,
    currency: "USD",
    budgetLevel: "campaign",
    ...overrides,
  } as unknown as MetaCampaignRow;
}

describe("meta snapshot job", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const sql = makeSqlMock();
    vi.mocked(db.getDb).mockReturnValue(sql.tag);
    vi.mocked(calibration.runMetaCalibrationForBusiness).mockResolvedValue({
      businessId: "biz_1",
      snapshotDate: "2026-05-06",
      rowsWritten: 6,
      accountScopes: 1,
      campaignScopes: 1,
      sampleRowsTotal: 6,
      sampleRowsByCohort: {
        purchase: 6,
        mid_funnel: 0,
        lead: 0,
        traffic: 0,
        upper_funnel: 0,
        engagement: 0,
        unknown: 0,
      },
      sampleRowsAfterCohortFilter: 6,
    });
    vi.mocked(calibration.getMetaCalibrationScope).mockResolvedValue({
      thresholds: {
        ...LEGACY_META_CALIBRATION_THRESHOLDS,
        metrics: {
          ...LEGACY_META_CALIBRATION_THRESHOLDS.metrics,
          roas_28d: {
            p10: 1,
            p25: 1.5,
            p50: 2,
            p75: 2.8,
            p90: 4,
            sampleSize: 12,
          },
        },
        source: "calibrated",
      },
      scope: {
        type: "campaign",
        id: "cmp_1",
        snapshotDate: "2026-05-06",
      },
    });
    vi.mocked(campaignSource.getMetaCampaignsForRange).mockResolvedValue({
      status: "ok",
      rows: [campaign()],
      evidenceSource: "live",
    } as never);
    vi.mocked(adsetsSource.getMetaAdSetsForRange).mockResolvedValue({
      status: "ok",
      rows: [],
      evidenceSource: "live",
    } as never);
    vi.mocked(breakdownsSource.getMetaBreakdownsForRange).mockResolvedValue({
      status: "ok",
      age: [],
      location: [],
      placement: [],
      budget: { campaign: [], adset: [] },
      audience: { available: false },
      products: { available: false },
    } as never);
    vi.mocked(configSnapshots.readMetaBidRegimeHistorySummaries).mockResolvedValue(new Map());
    vi.mocked(campaignLabels.readMetaCampaignLabels).mockResolvedValue([]);
    vi.mocked(anomalies.detectAnomaliesForBusiness).mockResolvedValue([]);
    vi.mocked(entitySignals.readMetaEntityDecisionSignalsDaily).mockResolvedValue(new Map());
    vi.mocked(entitySignalsBackfill.runMetaSignalsBackfillForBusiness).mockResolvedValue({
      businessId: "biz_1",
      asOfDate: "2026-05-06",
      rowsWritten: 0,
      campaignSignals: 0,
      adsetSignals: 0,
      signalCounts: {
        frequencyP80: 0,
        ctrDecayPct: 0,
        creativeAgeDaysMax: 0,
        lastSignificantEditAt: 0,
        learningState: 0,
        trackingQualityStatus: 0,
        monthlyPacingStatus: 0,
        placementMix: 0,
      },
    });
    vi.mocked(evidenceTrail.buildEvidenceTrailsForRecommendations).mockImplementation(
      async ({ recommendations }) =>
        Object.fromEntries(
          recommendations.map((recommendation) => [
            recommendation.id,
            {
              roas_history: [2.8, 3.2],
              peer_comparison: { p10: 1, p50: 2, p90: 4, this_value: 3.2 },
              regime_stability: 1,
              age_days: 28,
              recent_changes: [],
            },
          ]),
        ),
    );
  });

  it("deletes and rewrites same-day rows on re-run", async () => {
    const sql = makeSqlMock();
    vi.mocked(db.getDb).mockReturnValue(sql.tag);

    await runMetaSnapshotForBusiness("biz_1", "2026-05-06");
    await runMetaSnapshotForBusiness("biz_1", "2026-05-06");

    expect(sql.calls.filter((text) => text.includes("DELETE FROM meta_decision_snapshots_daily"))).toHaveLength(2);
    expect(sql.calls.filter((text) => text.includes("INSERT INTO meta_decision_snapshots_daily"))).toHaveLength(2);
  });

  it("runs calibration before fetching decision inputs", async () => {
    const order: string[] = [];
    vi.mocked(calibration.runMetaCalibrationForBusiness).mockImplementation(async () => {
      order.push("calibration");
      return {
        businessId: "biz_1",
        snapshotDate: "2026-05-06",
        rowsWritten: 6,
        accountScopes: 1,
        campaignScopes: 1,
        sampleRowsTotal: 6,
        sampleRowsByCohort: {
          purchase: 6,
          mid_funnel: 0,
          lead: 0,
          traffic: 0,
          upper_funnel: 0,
          engagement: 0,
          unknown: 0,
        },
        sampleRowsAfterCohortFilter: 6,
      };
    });
    vi.mocked(campaignSource.getMetaCampaignsForRange).mockImplementation(async () => {
      order.push("campaigns");
      return {
        status: "ok",
        rows: [campaign()],
        evidenceSource: "live",
      } as never;
    });

    await runMetaSnapshotForBusiness("biz_1", "2026-05-06");

    expect(order[0]).toBe("calibration");
    expect(order).toContain("campaigns");
  });

  it("uses allSettled for all business snapshots", async () => {
    vi.mocked(activeBusinesses.getActiveBusinesses).mockResolvedValue([
      { id: "biz_ok", name: "OK" },
      { id: "biz_fail", name: "Fail" },
    ] as never);
    vi.mocked(calibration.runMetaCalibrationForBusiness).mockImplementation(async (businessId: string) => {
      if (businessId === "biz_fail") throw new Error("calibration failed");
      return {
        businessId,
        snapshotDate: "2026-05-06",
        rowsWritten: 6,
        accountScopes: 1,
        campaignScopes: 1,
        sampleRowsTotal: 6,
        sampleRowsByCohort: {
          purchase: 6,
          mid_funnel: 0,
          lead: 0,
          traffic: 0,
          upper_funnel: 0,
          engagement: 0,
          unknown: 0,
        },
        sampleRowsAfterCohortFilter: 6,
      };
    });

    const result = await runMetaSnapshotForAllBusinesses("2026-05-06");

    expect(result.businessCount).toBe(2);
    expect(result.results.map((item) => item.status)).toEqual(["fulfilled", "rejected"]);
    expect(result.results[1]?.reason).toContain("calibration failed");
  });

  it("persists anomaly rows alongside recommendation rows", async () => {
    const sql = makeSqlMock();
    vi.mocked(db.getDb).mockReturnValue(sql.tag);
    vi.mocked(anomalies.detectAnomaliesForBusiness).mockResolvedValue([
      {
        id: "meta_anomaly_2026-05-06_campaign_cmp_1_roas_drop_sudden",
        type: "roas_drop_sudden",
        scopeType: "campaign",
        scopeId: "cmp_1",
        scopeLabel: "Campaign 1",
        severity: "high",
        kind: "anomaly",
        title: "Sudden ROAS drop",
        detail: "7d ROAS fell sharply.",
        diagnostics: ["Tracking interruption candidate"],
        detectedAt: "2026-05-06T03:00:00.000Z",
      },
    ]);

    await runMetaSnapshotForBusiness("biz_1", "2026-05-06");

    const payloads = sql.queryPayloads
      .filter(Boolean)
      .map((payload) => JSON.parse(String(payload)) as Array<Record<string, unknown>>);
    const anomalyPayload = payloads.flat().find((row) => row.kind === "anomaly");

    expect(anomalyPayload).toMatchObject({
      kind: "anomaly",
      rec_type: "roas_drop_sudden",
      decision_label: "diagnose",
      severity: "high",
      diagnostics: ["Tracking interruption candidate"],
      detected_at: "2026-05-06T03:00:00.000Z",
    });
  });

  it("persists evidence_trail for recommendation rows", async () => {
    const sql = makeSqlMock();
    vi.mocked(db.getDb).mockReturnValue(sql.tag);

    await runMetaSnapshotForBusiness("biz_1", "2026-05-06");

    const recommendationPayload = sql.queryPayloads
      .filter(Boolean)
      .map((payload) => JSON.parse(String(payload)) as Array<Record<string, unknown>>)
      .flat()
      .find((row) => row.kind === "recommendation" && !String(row.rec_type).endsWith("_state"));

    expect(recommendationPayload?.evidence_trail).toEqual({
      roas_history: [2.8, 3.2],
      peer_comparison: { p10: 1, p50: 2, p90: 4, this_value: 3.2 },
      regime_stability: 1,
      age_days: 28,
      recent_changes: [],
    });
    expect(recommendationPayload?.campaign_role).toBe("prospecting_validation");
    expect(recommendationPayload?.bid_regime).toBe("lowest_cost");
  });

  it("emits high-priority scenario recommendations through the snapshot path", async () => {
    const sql = makeSqlMock();
    vi.mocked(db.getDb).mockReturnValue(sql.tag);
    vi.mocked(campaignSource.getMetaCampaignsForRange).mockResolvedValue({
      status: "ok",
      rows: [campaign({ isBudgetMixed: true })],
      evidenceSource: "live",
    } as never);

    await runMetaSnapshotForBusiness("biz_1", "2026-05-06");

    const rows = sql.queryPayloads
      .filter(Boolean)
      .map((payload) => JSON.parse(String(payload)) as Array<Record<string, unknown>>)
      .flat();

    expect(rows.some((row) => row.rec_type === "scenario_k1_mixed_config_rebuild")).toBe(true);
  });

  it("persists entity state rows for campaign and adset coverage", async () => {
    const sql = makeSqlMock();
    vi.mocked(db.getDb).mockReturnValue(sql.tag);
    vi.mocked(adsetsSource.getMetaAdSetsForRange).mockResolvedValue({
      status: "ok",
      rows: [
        {
          id: "adset_1",
          accountId: "act_1",
          campaignId: "cmp_1",
          name: "Adset 1",
          status: "ACTIVE",
          spend: 100,
          purchases: 1,
          revenue: 100,
          roas: 1,
          cpa: 100,
          ctr: 0.5,
          cpm: 10,
          cpc: 1,
          impressions: 1000,
          clicks: 10,
          frequency: 1.2,
          currency: "USD",
          dailyBudget: 25,
          lifetimeBudget: null,
          optimizationGoal: "Purchase",
          bidStrategyType: "lowest_cost",
          bidStrategyLabel: "Lowest Cost",
          manualBidAmount: null,
          bidValue: null,
          bidValueFormat: null,
          isBudgetMixed: false,
          isConfigMixed: false,
        },
      ],
      evidenceSource: "live",
    } as never);

    await runMetaSnapshotForBusiness("biz_1", "2026-05-06");

    const rows = sql.queryPayloads
      .filter(Boolean)
      .map((payload) => JSON.parse(String(payload)) as Array<Record<string, unknown>>)
      .flat();
    const stateRows = rows.filter((row) => String(row.rec_type).endsWith("_state"));

    expect(stateRows).toHaveLength(2);
    expect(stateRows.map((row) => row.scope_type).sort()).toEqual(["adset", "campaign"]);
    expect(stateRows.map((row) => row.rec_type).sort()).toEqual(["adset_state", "campaign_state"]);
    expect(stateRows.every((row) => row.decision_label)).toBe(true);
    expect(stateRows.every((row) => row.state_reason)).toBe(true);
  });

  it("iterates every mature campaign into a state row even when only adsets have action recs", async () => {
    const sql = makeSqlMock();
    vi.mocked(db.getDb).mockReturnValue(sql.tag);
    vi.mocked(campaignSource.getMetaCampaignsForRange).mockResolvedValue({
      status: "ok",
      rows: [
        campaign({ id: "cmp_1", name: "Campaign 1", purchases: 1, roas: 0.8 }),
        campaign({ id: "cmp_2", name: "Campaign 2", purchases: 0, roas: 0 }),
        campaign({ id: "cmp_3", name: "Campaign 3", purchases: 12, roas: 3.6 }),
      ],
      evidenceSource: "live",
    } as never);
    vi.mocked(adsetsSource.getMetaAdSetsForRange).mockResolvedValue({
      status: "ok",
      rows: [
        {
          id: "adset_1",
          accountId: "act_1",
          campaignId: "cmp_1",
          name: "Adset 1",
          status: "ACTIVE",
          spend: 100,
          purchases: 1,
          revenue: 100,
          roas: 1,
          cpa: 100,
          ctr: 0.5,
          cpm: 10,
          cpc: 1,
          impressions: 1000,
          clicks: 10,
          frequency: 1.2,
          currency: "USD",
          dailyBudget: 25,
          lifetimeBudget: null,
          optimizationGoal: "Purchase",
          bidStrategyType: "lowest_cost",
          bidStrategyLabel: "Lowest Cost",
          manualBidAmount: null,
          bidValue: null,
          bidValueFormat: null,
          isBudgetMixed: false,
          isConfigMixed: false,
        },
      ],
      evidenceSource: "live",
    } as never);

    await runMetaSnapshotForBusiness("biz_1", "2026-05-06");

    const rows = sql.queryPayloads
      .filter(Boolean)
      .map((payload) => JSON.parse(String(payload)) as Array<Record<string, unknown>>)
      .flat();
    const campaignStateRows = rows.filter((row) => row.scope_type === "campaign" && row.rec_type === "campaign_state");
    const adsetStateRows = rows.filter((row) => row.scope_type === "adset" && row.rec_type === "adset_state");

    expect(campaignStateRows).toHaveLength(3);
    expect(campaignStateRows.map((row) => row.scope_id).sort()).toEqual(["cmp_1", "cmp_2", "cmp_3"]);
    expect(adsetStateRows).toHaveLength(1);
  });

  it("allows campaign state and action recommendations to coexist for the same entity", async () => {
    const sql = makeSqlMock();
    vi.mocked(db.getDb).mockReturnValue(sql.tag);

    await runMetaSnapshotForBusiness("biz_1", "2026-05-06");

    const rows = sql.queryPayloads
      .filter(Boolean)
      .map((payload) => JSON.parse(String(payload)) as Array<Record<string, unknown>>)
      .flat();
    const campaignRows = rows.filter((row) => row.scope_type === "campaign" && row.scope_id === "cmp_1");
    const recTypes = new Set(campaignRows.map((row) => row.rec_type));

    expect(recTypes.has("campaign_state")).toBe(true);
    expect([...recTypes].some((recType) => recType !== "campaign_state")).toBe(true);
  });

  it("hydrates taxonomy fields from persisted snapshot rows", async () => {
    const sql = makeSqlMock([
      {
        scope_type: "campaign",
        scope_id: "cmp_1",
        business_id: "biz_1",
        snapshot_date: "2026-05-06",
        rec_id: "bid-cmp_1",
        rec_type: "bid_strategy_fit",
        level: "campaign",
        decision_state: "act",
        confidence_score: "0.82",
        evidence: { items: [] },
        recommended_action: "Test Cost Cap",
        target_value: null,
        expected_impact: "Better profit control.",
        reasoning: "Lowest Cost is not protecting profitability.",
        predictive_overlay: "Persisted snapshot.",
        engine_version: "v3.6.0-meta-taxonomy",
        evidence_trail: {},
        campaign_role: "retargeting",
        bid_regime: "lowest_cost",
        created_at: "2026-05-06T03:00:00.000Z",
      },
    ]);
    vi.mocked(db.getDb).mockReturnValue(sql.tag);

    const result = await readMetaDecisionSnapshotForRange({
      businessId: "biz_1",
      startDate: "2026-05-01",
      endDate: "2026-05-06",
    });

    expect(result?.recommendations[0]).toMatchObject({
      campaignRole: "retargeting",
      bidRegime: "lowest_cost",
    });
  });

  it("guards pre-existing persisted hard actions at read time when campaign label is missing", async () => {
    const sql = makeSqlMock([
      {
        scope_type: "campaign",
        scope_id: "cmp_1",
        business_id: "biz_1",
        snapshot_date: "2026-05-06",
        rec_id: "scale-cmp_1",
        rec_type: "scale_for_volume",
        level: "campaign",
        decision_state: "act",
        confidence_score: "0.9",
        evidence: { items: [] },
        recommended_action: "Increase budget 10-15%.",
        target_value: null,
        expected_impact: "More volume.",
        reasoning: "Strong scale signal.",
        predictive_overlay: "Persisted snapshot.",
        engine_version: "v1.0.0",
        evidence_trail: {},
        campaign_role: "prospecting_scale",
        bid_regime: "lowest_cost",
        created_at: "2026-05-06T03:00:00.000Z",
      },
    ]);
    vi.mocked(db.getDb).mockReturnValue(sql.tag);
    vi.mocked(campaignLabels.readMetaCampaignLabels).mockResolvedValue([]);

    const result = await readMetaDecisionSnapshotForRange({
      businessId: "biz_1",
      startDate: "2026-05-01",
      endDate: "2026-05-06",
    });

    expect(result?.recommendations[0]).toMatchObject({
      kind: "state",
      decisionState: "watch",
      decisionLabel: "diagnose",
      confidence: "low",
      confidenceReason: "unlabeled_campaign_soft_only",
      signalQuality: {
        label_status: "unlabeled",
        blocked_action_type: "scale_for_volume",
      },
    });
  });

  it("keeps persisted hard actions when the campaign label exists", async () => {
    const sql = makeSqlMock([
      {
        scope_type: "campaign",
        scope_id: "cmp_1",
        business_id: "biz_1",
        snapshot_date: "2026-05-06",
        rec_id: "scale-cmp_1",
        rec_type: "scale_for_volume",
        level: "campaign",
        decision_state: "act",
        confidence_score: "0.9",
        evidence: { items: [] },
        recommended_action: "Increase budget 10-15%.",
        target_value: null,
        expected_impact: "More volume.",
        reasoning: "Strong scale signal.",
        predictive_overlay: "Persisted snapshot.",
        engine_version: "v1.0.0",
        evidence_trail: {},
        campaign_role: "prospecting_scale",
        bid_regime: "lowest_cost",
        created_at: "2026-05-06T03:00:00.000Z",
      },
    ]);
    vi.mocked(db.getDb).mockReturnValue(sql.tag);
    vi.mocked(campaignLabels.readMetaCampaignLabels).mockResolvedValue([
      {
        businessId: "biz_1",
        campaignId: "cmp_1",
        kind: "main",
        testDimension: null,
        source: "user",
        providerAccountId: "act_1",
        campaignName: "Campaign 1",
        labeledBy: "user_1",
        labeledAt: "2026-05-15T00:00:00.000Z",
        updatedAt: "2026-05-15T00:00:00.000Z",
      },
    ]);

    const result = await readMetaDecisionSnapshotForRange({
      businessId: "biz_1",
      startDate: "2026-05-01",
      endDate: "2026-05-06",
    });

    expect(result?.recommendations[0]).toMatchObject({
      type: "scale_for_volume",
      decisionState: "act",
      confidence: "high",
    });
    expect(result?.recommendations[0]?.confidenceReason).not.toBe("unlabeled_campaign_soft_only");
  });

  it("marks previously active anomalies resolved when absent on rerun", async () => {
    const sql = makeSqlMock();
    vi.mocked(db.getDb).mockReturnValue(sql.tag);
    vi.mocked(anomalies.detectAnomaliesForBusiness)
      .mockResolvedValueOnce([
        {
          id: "meta_anomaly_2026-05-06_campaign_cmp_1_roas_drop_sudden",
          type: "roas_drop_sudden",
          scopeType: "campaign",
          scopeId: "cmp_1",
          scopeLabel: "Campaign 1",
          severity: "medium",
          kind: "anomaly",
          title: "Sudden ROAS drop",
          detail: "7d ROAS fell.",
          diagnostics: ["Recent bid change candidate"],
          detectedAt: "2026-05-06T03:00:00.000Z",
        },
      ])
      .mockResolvedValueOnce([]);

    await runMetaSnapshotForBusiness("biz_1", "2026-05-06");
    await runMetaSnapshotForBusiness("biz_1", "2026-05-06");

    expect(
      sql.calls.some(
        (text) =>
          text.includes("SET resolved_at = now()") &&
          text.includes("kind = 'anomaly'") &&
          text.includes("resolved_at IS NULL"),
      ),
    ).toBe(true);
  });
});
