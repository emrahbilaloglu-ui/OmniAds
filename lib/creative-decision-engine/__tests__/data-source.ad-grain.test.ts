import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("@/lib/db", () => ({
  getDb: () => ({ query: mocks.query }),
}));

import {
  HYDRATE_AD_DECISION_INPUTS_QUERY,
  READ_AD_HYDRATION_COMPLETENESS_RECEIPTS_QUERY,
  READ_AD_ENTITY_STATE_AS_OF_QUERY,
  READ_PRESENT_AD_STATE_SEEDS_QUERY,
  WarehouseDataSource,
  isPresentDayAdDecisionAsOf,
} from "../data-source";

const BUSINESS_ID = "00000000-0000-4000-8000-000000000701";
const HISTORICAL_AS_OF = "2026-07-10";
const HISTORICAL_CUTOFF = "2026-07-10T03:15:00.000Z";

function hydrationRow(overrides: Record<string, unknown> = {}) {
  return {
    provider_account_id: "act_account_1",
    provider_account_ref_id: "00000000-0000-4000-8000-000000000711",
    ad_id: "ad-1",
    ad_name: "Ad 1",
    creative_id: "creative-shared",
    creative_name: "Shared creative",
    campaign_id: "campaign-1",
    adset_id: "adset-1",
    objective: "OUTCOME_SALES",
    optimization_goal: "PURCHASE",
    custom_event_type: "PURCHASE",
    campaign_count: 1,
    adset_count: 1,
    optimization_context_count: 1,
    objective_count: 1,
    context_identity_unknown: false,
    metric_row_count: 28,
    event_metrics_observed: true,
    spend: 100,
    conversions: 4,
    revenue: 300,
    impressions: 10_000,
    link_clicks: 200,
    roas: 3,
    cpa: 25,
    ctr: 2,
    frequency: 1.25,
    recent_spend: 30,
    recent_conversions: 1,
    recent_revenue: 90,
    recent_impressions: 3_000,
    recent_roas: 3,
    spend_24h: 5,
    impressions_24h: 500,
    first_seen_at: "2026-06-01T00:00:00.000Z",
    first_spend_at: "2026-06-02",
    last_spend_date: "2026-07-10",
    data_freshness_hours: 1,
    target_roas: 2,
    break_even_roas: 1.5,
    target_pack_updated_at: "2026-07-09T00:00:00.000Z",
    cpm: 10,
    outbound_clicks: 180,
    landing_page_views: 150,
    add_to_cart: 20,
    initiate_checkout: 10,
    thumbstop: 25,
    video25_rate: 18,
    video50_rate: 10,
    video75_rate: 6,
    video100_rate: 3,
    current_dimension_id: "00000000-0000-4000-8000-000000000801",
    current_ad_status: "ACTIVE",
    lifecycle_row_id: "00000000-0000-4000-8000-000000000901",
    lifecycle_as_of_date: "2026-07-10",
    lifecycle_position: "plateau",
    days_since_peak: 4,
    peak_roas_30d: 4,
    peak_confidence: 0.8,
    spend_trajectory_30d: "flat",
    spend_slope_7d: 0.1,
    spend_slope_30d: 0.2,
    roas_slope_7d: -0.1,
    roas_slope_30d: 0,
    fatigue_status: "watch",
    quality_ranking: "average",
    engagement_rate_ranking: "above_average",
    conversion_rate_ranking: "average",
    creative_format: "video",
    ...overrides,
  };
}

function receiptRow(
  expectedAdIds: string[],
  overrides: Record<string, unknown> = {},
) {
  return {
    business_ref_id: BUSINESS_ID,
    business_id: BUSINESS_ID,
    provider_account_ref_id: "00000000-0000-4000-8000-000000000711",
    provider_account_id: "act_account_1",
    source_run_id: "00000000-0000-4000-8000-000000000712",
    source_observed_at: "2026-07-10T02:00:00.000Z",
    source_captured_at: "2026-07-10T02:01:00.000Z",
    source_run_hash: "a".repeat(64),
    source_payload_hash: "b".repeat(64),
    source_expected_row_count: expectedAdIds.length,
    source_persisted_row_count: expectedAdIds.length,
    expected_ad_ids: expectedAdIds,
    ...overrides,
  };
}

function warehouseWithRows(input: {
  hydration: Array<Record<string, unknown>>;
  states?: Array<Record<string, unknown>>;
}) {
  mocks.query.mockImplementation(async (query: string) => {
    if (query.includes("ad-decision-present-state-seeds")) return [];
    if (query.includes("ad-decision-hydration-receipts")) return [];
    if (query.includes("ad-decision-hydration")) return input.hydration;
    if (query.includes("ad-decision-state-asof")) return input.states ?? [];
    throw new Error(
      `Unexpected query in ad hydration test: ${query.slice(0, 80)}`,
    );
  });
  const warehouse = new WarehouseDataSource();
  vi.spyOn(warehouse, "getBusinessTargetPack").mockResolvedValue({
    targetCpa: null,
    targetRoas: 2,
    breakEvenCpa: null,
    breakEvenRoas: 1.5,
    operatorAovAssumption: null,
    defaultRiskPosture: null,
    updatedAt: "2026-07-09T00:00:00.000Z",
    freshness: "fresh",
  });
  return warehouse;
}

describe("WarehouseDataSource native ad-grain hydration", () => {
  beforeEach(() => {
    mocks.query.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps two ads sharing one creative separate across campaign and optimization context", async () => {
    const warehouse = warehouseWithRows({
      hydration: [
        hydrationRow({
          ad_id: "ad-z-lead",
          campaign_id: "campaign-lead",
          adset_id: "adset-lead",
          objective: "OUTCOME_LEADS",
          optimization_goal: "LEAD",
          custom_event_type: "LEAD",
          spend: 25,
          conversions: 7,
          revenue: 0,
          roas: 0,
          cpa: 25 / 7,
        }),
        hydrationRow({
          ad_id: "ad-a-purchase",
          campaign_id: "campaign-sales",
          adset_id: "adset-sales",
          spend: 100,
          conversions: 4,
          revenue: 300,
        }),
      ],
      states: [
        {
          event_kind: "state",
          id: "00000000-0000-4000-8000-000000000991",
          provider_account_ref_id:
            "00000000-0000-4000-8000-000000000711",
          provider_account_id: "act_account_1",
          entity_id: "ad-a-purchase",
          creative_id: "creative-shared",
          configured_status: "ACTIVE",
          effective_status: "ACTIVE",
          observed_at: "2026-07-10T02:30:00.000Z",
          captured_at: "2026-07-10T02:31:00.000Z",
        },
        {
          event_kind: "state",
          id: "00000000-0000-4000-8000-000000000992",
          provider_account_ref_id:
            "00000000-0000-4000-8000-000000000711",
          provider_account_id: "act_account_1",
          entity_id: "ad-z-lead",
          creative_id: "creative-shared",
          configured_status: "ACTIVE",
          effective_status: "ACTIVE",
          observed_at: "2026-07-10T02:30:00.000Z",
          captured_at: "2026-07-10T02:31:00.000Z",
        },
      ],
    });

    const result = await warehouse.listAdDecisionInputs({
      businessId: BUSINESS_ID,
      asOf: HISTORICAL_AS_OF,
      decisionCutoff: HISTORICAL_CUTOFF,
    });

    expect(result.map((row) => row.adId)).toEqual([
      "ad-a-purchase",
      "ad-z-lead",
    ]);
    expect(result[0]).toMatchObject({
      decisionEntityType: "ad",
      decisionEntityId: "ad-a-purchase",
      creativeId: "creative-shared",
      campaignId: "campaign-sales",
      adsetId: "adset-sales",
      optimizationGoal: "PURCHASE",
      effectiveCohort: "purchase",
      spend: 100,
      purchases: 4,
      roas: 3,
    });
    expect(result[1]).toMatchObject({
      decisionEntityId: "ad-z-lead",
      creativeId: "creative-shared",
      campaignId: "campaign-lead",
      adsetId: "adset-lead",
      optimizationGoal: "LEAD",
      effectiveCohort: "lead",
      spend: 25,
      purchases: 0,
      roas: null,
    });
    expect(result[0]?.creativeEvidence.sourceLifecycleRowId).toBe(
      result[1]?.creativeEvidence.sourceLifecycleRowId,
    );
  });

  it("does not drop a valid ad when creativeId is missing", async () => {
    const warehouse = warehouseWithRows({
      hydration: [
        hydrationRow({
          ad_id: "ad-without-creative",
          creative_id: null,
          creative_name: null,
        }),
      ],
    });

    const [result] = await warehouse.listAdDecisionInputs({
      businessId: BUSINESS_ID,
      asOf: HISTORICAL_AS_OF,
      decisionCutoff: HISTORICAL_CUTOFF,
    });

    expect(result).toMatchObject({
      adId: "ad-without-creative",
      decisionEntityId: "ad-without-creative",
      creativeId: null,
      creativeName: "Ad 1",
      spend: 100,
    });
  });

  it("uses cutoff-strict state history ahead of current dimension status", async () => {
    const warehouse = warehouseWithRows({
      hydration: [hydrationRow()],
      states: [
        {
          id: "00000000-0000-4000-8000-000000000999",
          event_kind: "state",
          provider_account_ref_id:
            "00000000-0000-4000-8000-000000000711",
          provider_account_id: "act_account_1",
          entity_id: "ad-1",
          configured_status: "ACTIVE",
          effective_status: "ADSET_PAUSED",
          review_status: "APPROVED",
          policy_status: null,
          policy_reasons_json: [],
          observed_at: "2026-07-10T02:30:00.000Z",
          captured_at: "2026-07-10T02:31:00.000Z",
        },
      ],
    });

    const [result] = await warehouse.listAdDecisionInputs({
      businessId: BUSINESS_ID,
      asOf: HISTORICAL_AS_OF,
      decisionCutoff: HISTORICAL_CUTOFF,
    });

    expect(result).toMatchObject({
      effectiveStatus: "PAUSED",
      reviewStatus: "APPROVED",
      statusEvidence: {
        source: "entity_state_history",
        sourceRecordId: "00000000-0000-4000-8000-000000000999",
        observedAt: "2026-07-10T02:30:00.000Z",
        capturedAt: "2026-07-10T02:31:00.000Z",
      },
    });
    const stateCall = mocks.query.mock.calls.find(([query]) =>
      String(query).includes("ad-decision-state-asof"),
    );
    expect(stateCall?.[1]?.[3]).toBe(HISTORICAL_CUTOFF);
  });

  it("never treats current dimension state as historical truth", async () => {
    const warehouse = warehouseWithRows({ hydration: [hydrationRow()] });

    const [result] = await warehouse.listAdDecisionInputs({
      businessId: BUSINESS_ID,
      asOf: HISTORICAL_AS_OF,
      decisionCutoff: HISTORICAL_CUTOFF,
    });

    expect(result?.effectiveStatus).toBeNull();
    expect(result?.statusEvidence.source).toBe("missing");
  });

  it("lets a newer or equal explicit tombstone defeat an older ACTIVE state", async () => {
    const warehouse = warehouseWithRows({
      hydration: [hydrationRow()],
      states: [
        {
          event_kind: "tombstone",
          id: "00000000-0000-4000-8000-000000000998",
          provider_account_ref_id:
            "00000000-0000-4000-8000-000000000711",
          provider_account_id: "act_account_1",
          entity_id: "ad-1",
          tombstone_reason: "explicit_not_found",
          observed_at: "2026-07-10T02:45:00.000Z",
          captured_at: "2026-07-10T02:46:00.000Z",
        },
      ],
    });

    const [result] = await warehouse.listAdDecisionInputs({
      businessId: BUSINESS_ID,
      asOf: HISTORICAL_AS_OF,
      decisionCutoff: HISTORICAL_CUTOFF,
    });

    expect(result).toMatchObject({
      creativeId: null,
      effectiveStatus: "DELETED",
      statusEvidence: {
        source: "entity_tombstone",
        sourceRecordId: "00000000-0000-4000-8000-000000000998",
      },
    });
  });

  it("exposes authoritative account manifests and proves a true empty set", async () => {
    mocks.query.mockImplementation(async (query: string) => {
      if (query.includes("ad-decision-present-state-seeds")) return [];
      if (query.includes("ad-decision-hydration-receipts")) {
        return [receiptRow([])];
      }
      if (query.includes("ad-decision-hydration")) {
        return [hydrationRow({ ad_id: "stale-ad" })];
      }
      throw new Error(`Unexpected query: ${query.slice(0, 80)}`);
    });
    const warehouse = new WarehouseDataSource();
    vi.spyOn(warehouse, "getBusinessTargetPack").mockResolvedValue(null);

    const result = await warehouse.hydrateAdDecisionInputs({
      businessId: BUSINESS_ID,
      asOf: HISTORICAL_AS_OF,
      decisionCutoff: HISTORICAL_CUTOFF,
    });

    expect(result.inputs).toEqual([]);
    expect(result.accountCoverageComplete).toBe(true);
    expect(result.receipts).toEqual([
      expect.objectContaining({
        expectedAdCount: 0,
        hydratedAdCount: 0,
        sourceComplete: true,
        hydrationComplete: true,
        authoritativeForPrune: true,
      }),
    ]);
  });

  it("marks partial or count-mismatched source proof as non-authoritative", async () => {
    mocks.query.mockImplementation(async (query: string) => {
      if (query.includes("ad-decision-hydration-receipts")) {
        return [
          receiptRow(["ad-1"], {
            source_expected_row_count: 2,
            source_persisted_row_count: 1,
          }),
        ];
      }
      if (query.includes("ad-decision-hydration")) return [hydrationRow()];
      if (query.includes("ad-decision-state-asof")) return [];
      return [];
    });
    const warehouse = new WarehouseDataSource();
    vi.spyOn(warehouse, "getBusinessTargetPack").mockResolvedValue(null);

    const result = await warehouse.hydrateAdDecisionInputs({
      businessId: BUSINESS_ID,
      asOf: HISTORICAL_AS_OF,
      decisionCutoff: HISTORICAL_CUTOFF,
    });

    expect(result.inputs).toHaveLength(1);
    expect(result.accountCoverageComplete).toBe(false);
    expect(result.receipts[0]).toMatchObject({
      sourceComplete: false,
      authoritativeForPrune: false,
    });
  });

  it("allows current dimension status only for present-day runtime", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const cutoff = `${today}T12:00:00.000Z`;
    const warehouse = warehouseWithRows({ hydration: [hydrationRow()] });

    const [result] = await warehouse.listAdDecisionInputs({
      businessId: BUSINESS_ID,
      asOf: today,
      decisionCutoff: cutoff,
    });

    expect(isPresentDayAdDecisionAsOf(today, cutoff)).toBe(true);
    expect(result).toMatchObject({
      effectiveStatus: "ACTIVE",
      statusEvidence: {
        source: "current_dimension",
        sourceRecordId: "00000000-0000-4000-8000-000000000801",
      },
    });
  });

  it("includes a present-day active dimension-only ad with explicit unknown metric evidence", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const cutoff = `${today}T12:00:00.000Z`;
    mocks.query.mockImplementation(
      async (query: string, params?: unknown[]) => {
        if (query.includes("ad-decision-present-state-seeds")) return [];
        if (query.includes("ad-decision-hydration-receipts")) return [];
        if (query.includes("ad-decision-hydration")) {
          if (params?.[11] !== true) return [];
          return [
            hydrationRow({
              ad_id: "ad-dimension-only",
              metric_row_count: 0,
              event_metrics_observed: false,
              spend: null,
              conversions: null,
              revenue: null,
              impressions: null,
              link_clicks: null,
              outbound_clicks: null,
              landing_page_views: null,
              add_to_cart: null,
              initiate_checkout: null,
              recent_spend: null,
              recent_conversions: null,
              recent_revenue: null,
              recent_impressions: null,
              spend_24h: null,
              impressions_24h: null,
              data_freshness_hours: null,
            }),
          ];
        }
        if (query.includes("ad-decision-hydration-receipts")) return [];
        if (query.includes("ad-decision-state-asof")) return [];
        throw new Error(`Unexpected query: ${query.slice(0, 80)}`);
      },
    );
    const warehouse = new WarehouseDataSource();
    vi.spyOn(warehouse, "getBusinessTargetPack").mockResolvedValue(null);

    const [result] = await warehouse.listAdDecisionInputs({
      businessId: BUSINESS_ID,
      asOf: today,
      decisionCutoff: cutoff,
    });

    expect(result).toMatchObject({
      adId: "ad-dimension-only",
      spend: 0,
      purchases: 0,
      impressions: null,
      outboundClicks: null,
      landingPageViews: null,
      dataFreshnessHours: null,
      metricEvidence: {
        sourceRowCount: 0,
        performanceMetricsObserved: false,
        eventMetricsObserved: false,
      },
    });
  });

  it("does not seed a historical decision from current dimensions alone", async () => {
    mocks.query.mockImplementation(
      async (query: string, params?: unknown[]) => {
        if (query.includes("ad-decision-hydration-receipts")) return [];
        if (query.includes("ad-decision-hydration: native")) {
          return params?.[11] === true
            ? [hydrationRow({ ad_id: "ad-dimension-only" })]
            : [];
        }
        throw new Error(
          `Historical empty hydration must not query state: ${query}`,
        );
      },
    );
    const warehouse = new WarehouseDataSource();
    vi.spyOn(warehouse, "getBusinessTargetPack").mockResolvedValue(null);

    await expect(
      warehouse.listAdDecisionInputs({
        businessId: BUSINESS_ID,
        asOf: HISTORICAL_AS_OF,
        decisionCutoff: HISTORICAL_CUTOFF,
      }),
    ).resolves.toEqual([]);
    const hydrationCall = mocks.query.mock.calls.find(([query]) =>
      String(query).includes("ad-decision-hydration: native"),
    );
    expect(hydrationCall?.[1]?.[11]).toBe(false);
  });

  it("rejects duplicate final business/account/ad identities", async () => {
    const warehouse = warehouseWithRows({
      hydration: [hydrationRow(), hydrationRow({ spend: 999 })],
    });

    await expect(
      warehouse.listAdDecisionInputs({
        businessId: BUSINESS_ID,
        asOf: HISTORICAL_AS_OF,
        decisionCutoff: HISTORICAL_CUTOFF,
      }),
    ).rejects.toThrow(
      "Duplicate ad decision hydration row for act_account_1/ad-1.",
    );
    expect(
      mocks.query.mock.calls.some(([query]) =>
        String(query).includes("ad-decision-state-asof"),
      ),
    ).toBe(false);
  });

  it("fails context closed when an ad has mixed or incomplete hierarchy context", async () => {
    const warehouse = warehouseWithRows({
      hydration: [
        hydrationRow({
          campaign_id: null,
          adset_id: null,
          objective: null,
          optimization_goal: null,
          custom_event_type: null,
          campaign_count: 2,
          adset_count: 2,
          optimization_context_count: 2,
          objective_count: 2,
          context_identity_unknown: true,
        }),
      ],
    });

    const [result] = await warehouse.listAdDecisionInputs({
      businessId: BUSINESS_ID,
      asOf: HISTORICAL_AS_OF,
      decisionCutoff: HISTORICAL_CUTOFF,
    });

    expect(result).toMatchObject({
      campaignId: null,
      adsetId: null,
      objective: null,
      optimizationGoal: null,
      effectiveCohort: "unknown",
      contextGrain: {
        providerAccountCount: 1,
        campaignCount: 2,
        adsetCount: 2,
        optimizationContextCount: 2,
        objectiveCount: 2,
        contextIdentityUnknown: true,
      },
    });
  });

  it("passes exact account/ad filters through getAdDecisionInput", async () => {
    const warehouse = warehouseWithRows({ hydration: [hydrationRow()] });

    const result = await warehouse.getAdDecisionInput({
      businessId: BUSINESS_ID,
      providerAccountId: "act_account_1",
      adId: "ad-1",
      asOf: HISTORICAL_AS_OF,
      decisionCutoff: HISTORICAL_CUTOFF,
    });

    expect(result?.adId).toBe("ad-1");
    const hydrationCall = mocks.query.mock.calls.find(([query]) =>
      String(query).includes("ad-decision-hydration: native"),
    );
    expect(hydrationCall?.[1]?.[2]).toEqual(["act_account_1"]);
    expect(hydrationCall?.[1]?.[4]).toEqual(["ad-1"]);
    expect(warehouse.getBusinessTargetPack).toHaveBeenCalledWith({
      businessId: BUSINESS_ID,
      asOf: HISTORICAL_CUTOFF,
    });
  });
});

describe("native ad hydration SQL contract", () => {
  it("aggregates 28d, 7d and 24h windows at provider-account/ad grain", () => {
    expect(HYDRATE_AD_DECISION_INPUTS_QUERY).toContain(
      "d.date BETWEEN ($2::date - INTERVAL '27 days') AND $2::date",
    );
    expect(HYDRATE_AD_DECISION_INPUTS_QUERY).toContain(
      "date BETWEEN ($2::date - INTERVAL '6 days') AND $2::date",
    );
    expect(HYDRATE_AD_DECISION_INPUTS_QUERY).toContain("WHERE date = $2::date");
    expect(HYDRATE_AD_DECISION_INPUTS_QUERY).toContain(
      "GROUP BY provider_account_id, ad_id",
    );
    expect(HYDRATE_AD_DECISION_INPUTS_QUERY).toContain(
      "ORDER BY cumulative.provider_account_id, cumulative.ad_id",
    );
  });

  it("joins hierarchy by the ad's account/date/entity IDs, never by creative", () => {
    expect(HYDRATE_AD_DECISION_INPUTS_QUERY).toContain(
      "a.provider_account_id = d.provider_account_id",
    );
    expect(HYDRATE_AD_DECISION_INPUTS_QUERY).toContain("a.date = d.date");
    expect(HYDRATE_AD_DECISION_INPUTS_QUERY).toContain(
      "a.adset_id = d.adset_id",
    );
    expect(HYDRATE_AD_DECISION_INPUTS_QUERY).toContain(
      "c.campaign_id = d.campaign_id",
    );
    expect(HYDRATE_AD_DECISION_INPUTS_QUERY).not.toContain(
      "a.creative_id = d.creative_id",
    );
  });

  it("uses creative lifecycle only as an overlay and never copies its spend/ROAS", () => {
    expect(HYDRATE_AD_DECISION_INPUTS_QUERY).toContain(
      "row.creative_id = COALESCE(",
    );
    expect(HYDRATE_AD_DECISION_INPUTS_QUERY).not.toContain("row.spend_28d");
    expect(HYDRATE_AD_DECISION_INPUTS_QUERY).not.toContain("row.roas_28d");
    expect(HYDRATE_AD_DECISION_INPUTS_QUERY).toContain(
      "dimensions.creative_id",
    );
  });

  it("requires state observations and captures to precede the decision cutoff", () => {
    expect(READ_AD_ENTITY_STATE_AS_OF_QUERY).toContain(
      "observed_at <= $4::timestamptz",
    );
    expect(READ_AD_ENTITY_STATE_AS_OF_QUERY).toContain(
      "captured_at <= $4::timestamptz",
    );
    expect(READ_AD_ENTITY_STATE_AS_OF_QUERY).toContain(
      "business_ref_id = $1::uuid",
    );
    expect(READ_PRESENT_AD_STATE_SEEDS_QUERY).toContain(
      "observed_at <= $2::timestamptz",
    );
    expect(READ_PRESENT_AD_STATE_SEEDS_QUERY).toContain(
      "captured_at <= $2::timestamptz",
    );
    expect(HYDRATE_AD_DECISION_INPUTS_QUERY).toContain(
      "FROM meta_ad_dimensions d",
    );
    expect(HYDRATE_AD_DECISION_INPUTS_QUERY).toContain(
      "d.last_seen_at::date = $2::date",
    );
    expect(HYDRATE_AD_DECISION_INPUTS_QUERY).toContain("WHERE $12::boolean");
    expect(HYDRATE_AD_DECISION_INPUTS_QUERY).toContain(
      "AND NOT EXISTS (\n      SELECT 1\n      FROM selected_ad_days day",
    );
  });

  it("compares present state and tombstone in one cutoff-strict truth ordering", () => {
    expect(READ_AD_ENTITY_STATE_AS_OF_QUERY).toContain(
      "FROM meta_entity_tombstones tombstone",
    );
    expect(READ_AD_ENTITY_STATE_AS_OF_QUERY).toContain(
      "(event_kind = 'tombstone') DESC",
    );
    expect(READ_PRESENT_AD_STATE_SEEDS_QUERY).toContain(
      "WHERE event_kind = 'state'",
    );
  });

  it("gates every SCD0 dimension join behind present-day mode", () => {
    expect(HYDRATE_AD_DECISION_INPUTS_QUERY).toContain(
      "LEFT JOIN meta_ad_dimensions dimensions\n  ON $12::boolean",
    );
    expect(HYDRATE_AD_DECISION_INPUTS_QUERY).toContain(
      "LEFT JOIN meta_creative_dimensions creative_dimensions\n  ON $12::boolean",
    );
  });

  it("requires a same-day complete account run for a prune receipt", () => {
    expect(READ_AD_HYDRATION_COMPLETENESS_RECEIPTS_QUERY).toContain(
      "run.completeness = 'complete'",
    );
    expect(READ_AD_HYDRATION_COMPLETENESS_RECEIPTS_QUERY).toContain(
      "run.observed_at >= $2::date",
    );
    expect(READ_AD_HYDRATION_COMPLETENESS_RECEIPTS_QUERY).toContain(
      "source_expected_row_count",
    );
  });

  it("uses capture time rather than provider update time for receipt membership", () => {
    expect(READ_AD_HYDRATION_COMPLETENESS_RECEIPTS_QUERY).toContain(
      "state.captured_at >= run.source_captured_at",
    );
    expect(READ_AD_HYDRATION_COMPLETENESS_RECEIPTS_QUERY).toContain(
      "tombstone.captured_at >= run.source_captured_at",
    );
    expect(READ_AD_HYDRATION_COMPLETENESS_RECEIPTS_QUERY).not.toContain(
      "state.observed_at >= run.source_observed_at",
    );
    expect(READ_AD_HYDRATION_COMPLETENESS_RECEIPTS_QUERY).not.toContain(
      "tombstone.observed_at >= run.source_observed_at",
    );
  });

  it("keeps absent event payload metrics null instead of coercing them to zero", () => {
    expect(HYDRATE_AD_DECISION_INPUTS_QUERY).toContain(
      "FILTER (WHERE payload_json ? 'outbound_clicks')",
    );
    expect(HYDRATE_AD_DECISION_INPUTS_QUERY).not.toContain(
      "SUM(COALESCE((NULLIF(payload_json->>'outbound_clicks', ''))::numeric, 0))",
    );
  });
});
