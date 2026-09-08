import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("@/lib/db", () => ({
  getDb: () => ({ query: mocks.query }),
  /*
    `computeNativeAdDecisions` is imported below so the band hydration can be
    driven all the way into a native decision. `jobs/ad-decisions-job.ts`
    NAMED-imports `runDbTransaction` at module scope, and an ESM named import
    that the mock factory does not provide fails at link time even when nothing
    calls it. It stays a throwing stub because no test here may reach a
    transaction.
  */
  runDbTransaction: () => {
    throw new Error("runDbTransaction is not available in this unit test.");
  },
}));

import {
  HYDRATE_AD_DECISION_INPUTS_QUERY,
  READ_AD_HYDRATION_COMPLETENESS_RECEIPTS_QUERY,
  READ_AD_ENTITY_STATE_AS_OF_QUERY,
  READ_PRESENT_AD_STATE_SEEDS_QUERY,
  WarehouseDataSource,
  isPresentDayAdDecisionAsOf,
} from "../data-source";
import { NATIVE_AD_DB_BATCH_SIZE } from "../batching";
import {
  // Imported rather than spelled: a contract bump must not require editing a
  // string literal in a test that is not about the version.
  NATIVE_AD_LIFECYCLE_EVIDENCE_CONTRACT,
  computeNativeAdDecisions,
  computeNativeAdLifecycleEvidence,
  resolveNativeAdFrequencyPressureThresholdsByAccount,
} from "../jobs/ad-decisions-job";
import {
  makeAccountCalibration,
  makeAccountDecisionProfile,
  makeDataHealth,
} from "./helpers";

const BUSINESS_ID = "00000000-0000-4000-8000-000000000701";
const HISTORICAL_AS_OF = "2026-07-10";
const HISTORICAL_CUTOFF = "2026-07-10T03:15:00.000Z";

/**
 * The `ad_bands` columns exactly as node-postgres returns them.
 *
 * `impressions`, `clicks` and `link_clicks` are BIGINT in `meta_ad_daily`, and
 * node-postgres hands BIGINT back as a STRING rather than a number. These
 * fixtures therefore carry strings for those three and numbers for the
 * DOUBLE PRECISION columns, which is what an ephemeral-PostgreSQL run of
 * `HYDRATE_AD_DECISION_INPUTS_QUERY` produced against real rows on
 * 2026-09-07: recent14 `{"recent14_impressions":"84000",
 * "recent14_link_clicks":"560"}` beside `"recent14_spend":140`. A fixture that
 * used numbers everywhere would not exercise the parse the mapper actually
 * has to perform.
 */
function bandColumns(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    band_cutoff_date: "2026-07-10",
    recent14_start_date: "2026-06-27",
    recent14_end_date: "2026-07-10",
    prior14_start_date: "2026-06-13",
    prior14_end_date: "2026-06-26",
    recent14_row_count: 14,
    recent14_spend: 140,
    recent14_conversions: 4,
    recent14_revenue: 140,
    recent14_impressions: "84000",
    recent14_clicks: "840",
    recent14_link_clicks: "560",
    /*
      COMPLETENESS, which the query now carries beside the sum. Zero delivered
      rows are missing their link clicks, so this band's total is measured
      rather than partial. A fixture that omits these columns reads as UNKNOWN
      and fails closed, which is the intended answer for a row hydrated by a
      query that cannot report coverage.
    */
    recent14_link_clicks_measured_rows: 14,
    recent14_link_clicks_missing_delivered_rows: 0,
    prior14_row_count: 14,
    prior14_spend: 280,
    prior14_conversions: 21,
    prior14_revenue: 1120,
    prior14_impressions: "140000",
    prior14_clicks: "2800",
    prior14_link_clicks: "1960",
    prior14_link_clicks_measured_rows: 14,
    prior14_link_clicks_missing_delivered_rows: 0,
    ...overrides,
  };
}

function hydrationRow(overrides: Record<string, unknown> = {}) {
  return {
    ...bandColumns(),
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
          presence: "present",
          id: "00000000-0000-4000-8000-000000000991",
          provider_account_ref_id: "00000000-0000-4000-8000-000000000711",
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
          presence: "present",
          id: "00000000-0000-4000-8000-000000000992",
          provider_account_ref_id: "00000000-0000-4000-8000-000000000711",
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

  it("keeps reused external account/ad identities separate by provider account ref", async () => {
    const firstRef = "00000000-0000-4000-8000-000000000711";
    const secondRef = "00000000-0000-4000-8000-000000000712";
    mocks.query.mockImplementation(
      async (query: string, params?: unknown[]) => {
        if (query.includes("ad-decision-present-state-seeds")) return [];
        if (query.includes("ad-decision-hydration-receipts")) return [];
        if (query.includes("ad-decision-hydration")) {
          return [
            hydrationRow({ provider_account_ref_id: firstRef }),
            hydrationRow({ provider_account_ref_id: secondRef }),
          ];
        }
        if (query.includes("ad-decision-state-asof")) {
          const providerAccountRefId = String(params?.[1]);
          return [
            {
              event_kind: "state",
              presence: "present",
              id: `state-${providerAccountRefId}`,
              provider_account_ref_id: providerAccountRefId,
              provider_account_id: "act_account_1",
              entity_id: "ad-1",
              campaign_id: "campaign-1",
              adset_id: "adset-1",
              creative_id: "creative-shared",
              configured_status: "ACTIVE",
              effective_status: "ACTIVE",
              observed_at: "2026-07-10T02:30:00.000Z",
              captured_at: "2026-07-10T02:31:00.000Z",
            },
          ];
        }
        throw new Error(`Unexpected query: ${query.slice(0, 80)}`);
      },
    );
    const warehouse = new WarehouseDataSource();
    vi.spyOn(warehouse, "getBusinessTargetPack").mockResolvedValue(null);

    const result = await warehouse.listAdDecisionInputs({
      businessId: BUSINESS_ID,
      asOf: HISTORICAL_AS_OF,
      decisionCutoff: HISTORICAL_CUTOFF,
    });

    expect(result).toHaveLength(2);
    expect(result.map((row) => row.providerAccountRefId).sort()).toEqual([
      firstRef,
      secondRef,
    ]);
    expect(
      mocks.query.mock.calls
        .filter(([query]) => String(query).includes("ad-decision-state-asof"))
        .map(([, params]) => params?.[1])
        .sort(),
    ).toEqual([firstRef, secondRef]);
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
          presence: "present",
          provider_account_ref_id: "00000000-0000-4000-8000-000000000711",
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
    expect(stateCall?.[1]?.[4]).toBe(HISTORICAL_CUTOFF);
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
          provider_account_ref_id: "00000000-0000-4000-8000-000000000711",
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

  it("hydrates a complete large account manifest through bounded identity batches", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const cutoff = `${today}T12:00:00.000Z`;
    const adIds = Array.from(
      { length: NATIVE_AD_DB_BATCH_SIZE + 1 },
      (_, index) => `ad-${index + 1}`,
    );
    const hydrationBatchSizes: number[] = [];
    const stateBatchSizes: number[] = [];
    mocks.query.mockImplementation(
      async (query: string, params?: unknown[]) => {
        if (query.includes("ad-decision-hydration-receipts")) {
          return [receiptRow(adIds)];
        }
        if (query.includes("ad-decision-state-asof")) {
          const batch = (params?.[3] ?? []) as string[];
          stateBatchSizes.push(batch.length);
          expect(params?.[1]).toBe("00000000-0000-4000-8000-000000000711");
          expect(params?.[5]).toBe("2026-07-10T02:01:00.000Z");
          return batch.map((adId) => ({
            event_kind: "state",
            presence: "present",
            id: `state-${adId}`,
            provider_account_ref_id: "00000000-0000-4000-8000-000000000711",
            provider_account_id: "act_account_1",
            entity_id: adId,
            campaign_id: "campaign-1",
            adset_id: "adset-1",
            creative_id: `creative-${adId}`,
            configured_status: "ACTIVE",
            effective_status: "ACTIVE",
            observed_at: `${today}T02:30:00.000Z`,
            captured_at: `${today}T02:31:00.000Z`,
          }));
        }
        if (query.includes("ad-decision-hydration")) {
          const batch = (params?.[4] ?? []) as string[];
          hydrationBatchSizes.push(batch.length);
          return batch.map((adId) =>
            hydrationRow({
              ad_id: adId,
              creative_id: `creative-${adId}`,
            }),
          );
        }
        if (query.includes("ad-decision-present-state-seeds")) {
          throw new Error("complete manifests must not scan all state history");
        }
        throw new Error(`Unexpected query: ${query.slice(0, 80)}`);
      },
    );
    const warehouse = new WarehouseDataSource();
    vi.spyOn(warehouse, "getBusinessTargetPack").mockResolvedValue(null);

    const result = await warehouse.hydrateAdDecisionInputs({
      businessId: BUSINESS_ID,
      asOf: today,
      decisionCutoff: cutoff,
    });

    expect(result.inputs).toHaveLength(adIds.length);
    expect(result.accountCoverageComplete).toBe(true);
    expect(hydrationBatchSizes).toEqual([NATIVE_AD_DB_BATCH_SIZE, 1]);
    expect(stateBatchSizes).toEqual([NATIVE_AD_DB_BATCH_SIZE, 1]);
  });

  it("hydrates every metricless ad in a cutoff-strict historical complete manifest", async () => {
    const adIds = ["paused-no-metrics", "active-no-metrics"];
    mocks.query.mockImplementation(
      async (query: string, params?: unknown[]) => {
        if (query.includes("ad-decision-hydration-receipts")) {
          return [receiptRow(adIds)];
        }
        if (query.includes("ad-decision-state-asof")) {
          const batch = (params?.[3] ?? []) as string[];
          return batch.map((adId) => ({
            event_kind: "state",
            presence: "present",
            id: `state-${adId}`,
            provider_account_ref_id:
              "00000000-0000-4000-8000-000000000711",
            provider_account_id: "act_account_1",
            entity_id: adId,
            campaign_id: "campaign-1",
            adset_id: "adset-1",
            creative_id: `creative-${adId}`,
            configured_status: adId.startsWith("paused")
              ? "PAUSED"
              : "ACTIVE",
            effective_status: adId.startsWith("paused")
              ? "PAUSED"
              : "ACTIVE",
            observed_at: "2026-07-10T02:30:00.000Z",
            captured_at: "2026-07-10T02:31:00.000Z",
          }));
        }
        if (query.includes("ad-decision-hydration")) {
          const seeds = JSON.parse(String(params?.[12] ?? "[]")) as Array<{
            ad_id: string;
          }>;
          return seeds.map((seed) =>
            hydrationRow({
              ad_id: seed.ad_id,
              creative_id: `creative-${seed.ad_id}`,
              campaign_count: 0,
              adset_count: 0,
              optimization_context_count: 0,
              objective_count: 0,
              context_identity_unknown: true,
              metric_row_count: 0,
              event_metrics_observed: false,
              spend: null,
              conversions: null,
              revenue: null,
              impressions: null,
              link_clicks: null,
              current_dimension_id: null,
              current_ad_status: null,
            }),
          );
        }
        if (query.includes("ad-decision-present-state-seeds")) {
          throw new Error("complete manifests must use cutoff-strict state rows");
        }
        throw new Error(`Unexpected query: ${query.slice(0, 80)}`);
      },
    );
    const warehouse = new WarehouseDataSource();
    vi.spyOn(warehouse, "getBusinessTargetPack").mockResolvedValue(null);

    const result = await warehouse.hydrateAdDecisionInputs({
      businessId: BUSINESS_ID,
      asOf: HISTORICAL_AS_OF,
      decisionCutoff: HISTORICAL_CUTOFF,
    });

    expect(result.inputs.map((row) => row.adId)).toEqual(adIds.sort());
    expect(result.inputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          adId: "paused-no-metrics",
          effectiveStatus: "PAUSED",
          spend: 0,
          metricEvidence: expect.objectContaining({
            sourceRowCount: 0,
            performanceMetricsObserved: false,
          }),
        }),
        expect.objectContaining({
          adId: "active-no-metrics",
          effectiveStatus: "ACTIVE",
        }),
      ]),
    );
    expect(result.accountCoverageComplete).toBe(true);
    expect(result.receipts[0]).toMatchObject({
      expectedAdCount: 2,
      hydratedAdCount: 2,
      hydrationComplete: true,
      authoritativeForPrune: true,
      reason: null,
    });
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

  it.each(["source_observed_at", "source_captured_at"])(
    "fails source completeness closed when %s is missing",
    async (missingTimestamp) => {
      mocks.query.mockImplementation(async (query: string) => {
        if (query.includes("ad-decision-hydration-receipts")) {
          return [receiptRow(["ad-1"], { [missingTimestamp]: null })];
        }
        if (query.includes("ad-decision-present-state-seeds")) return [];
        if (query.includes("ad-decision-hydration")) return [hydrationRow()];
        if (query.includes("ad-decision-state-asof")) return [];
        throw new Error(`Unexpected query: ${query.slice(0, 80)}`);
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
        hydrationComplete: false,
        authoritativeForPrune: false,
      });
    },
  );

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

/*
  The producer half of the ad-level fatigue contract.

  `AdDisjointBandEvidence` existed on the type with no producer, so
  `computeNativeAdLifecycleEvidence` fell to `fatigueStatus: "unknown"` for
  every ad in existence and a Refresh could only ever be HELD. These tests
  drive the real `WarehouseDataSource` mapper over rows in the wire shape
  node-postgres actually returns, and then drive the hydrated inputs into the
  real decision producer, so the path from `meta_ad_daily` to an authorized
  Refresh is checked end to end rather than assumed.
*/
describe("native ad 14/14 band hydration", () => {
  beforeEach(() => {
    mocks.query.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /*
    Cutoff-strict ACTIVE state for every hydrated ad.

    Without it `effectiveStatus` is null and the delivery gate serves
    `diagnose` ("Delivery status is unavailable") before any ROAS zone runs,
    which would make these tests assert nothing about Refresh.
  */
  function activeStates(rows: Array<Record<string, unknown>>) {
    return rows.map((row, index) => ({
      event_kind: "state",
      presence: "present",
      id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      provider_account_ref_id: "00000000-0000-4000-8000-000000000711",
      provider_account_id: "act_account_1",
      entity_id: row.ad_id,
      creative_id: "creative-shared",
      configured_status: "ACTIVE",
      effective_status: "ACTIVE",
      observed_at: "2026-07-10T02:30:00.000Z",
      captured_at: "2026-07-10T02:31:00.000Z",
    }));
  }

  /** Resolved campaign role, so the label guard does not hold the row first. */
  function campaignContext() {
    return new Map([
      [
        "campaign-1",
        {
          kind: "main" as const,
          testDimension: null,
          contextTrust: "high" as const,
          provenance: {
            mode: "automatic" as const,
            source: "system_inferred" as const,
            campaignId: "campaign-1",
            kind: "main" as const,
            testDimension: null,
            contextTrust: "high" as const,
            sourceRecordType: "engine_v3_campaign_context_daily" as const,
            sourceRecordId: "context-campaign-1",
            sourceAsOfDate: HISTORICAL_AS_OF,
            sourceUpdatedAt: `${HISTORICAL_AS_OF}T01:00:00.000Z`,
            sourceHash: "a".repeat(64),
          },
        },
      ],
    ]);
  }

  async function hydrate(rows: Array<Record<string, unknown>>) {
    return await warehouseWithRows({
      hydration: rows,
      states: activeStates(rows),
    }).listAdDecisionInputs({
      businessId: BUSINESS_ID,
      asOf: HISTORICAL_AS_OF,
      decisionCutoff: HISTORICAL_CUTOFF,
    });
  }

  function bandProfile() {
    return makeAccountDecisionProfile({
      businessId: BUSINESS_ID,
      asOfDate: HISTORICAL_AS_OF,
      accountBaselines: makeAccountCalibration({
        matureCreativeCount: 35,
        winnerPurchaseP50: 6,
        refreshRatioP10: 0.8,
      }),
      thresholds: {
        recentSampleMinSpend: 50,
        winnerMemoryMinSpend: 150,
        winnerMemoryMinPurchases: 5,
        scaleMinPurchases: 8,
        commercialMaturitySpend: 400,
      },
    });
  }

  it("hydrates the equal, disjoint, directly adjacent pair the contract requires", async () => {
    const [input] = await hydrate([hydrationRow()]);

    expect(input?.adBandEvidence).toEqual({
      cutoffDate: "2026-07-10",
      recent14: {
        startDate: "2026-06-27",
        endDate: "2026-07-10",
        spend: 140,
        purchases: 4,
        revenue: 140,
        impressions: 84_000,
        clicks: 840,
        linkClicks: 560,
      },
      prior14: {
        startDate: "2026-06-13",
        endDate: "2026-06-26",
        spend: 280,
        purchases: 21,
        revenue: 1120,
        impressions: 140_000,
        clicks: 2800,
        linkClicks: 1960,
      },
    });
    // Equal, and directly adjacent: 2026-06-26 is the calendar day before
    // 2026-06-27, which is what `resolveNativeAdCompositeBands` checks
    // arithmetically before it will compare the two.
    expect(
      Date.parse("2026-06-27T00:00:00.000Z") -
        Date.parse("2026-06-26T00:00:00.000Z"),
    ).toBe(86_400_000);
    expect(input?.adBandEvidence?.recent14.endDate).toBe(
      input?.adBandEvidence?.cutoffDate,
    );
  });

  it("separates an unsupplied link-click window from a measured zero one", async () => {
    /*
      `meta_ad_daily.link_clicks` is NULL for a day the provider supplied
      nothing and a number for a measured day, INCLUDING a measured 0. The
      `ad_bands` CTE sums the raw column so a band is NULL only when every day
      in it was unsupplied, and the mapper must carry that through instead of
      flattening either case to the other. Both are inadmissible for
      click-to-purchase, but only one of them is a claim about delivery.
    */
    const [unsupplied] = await hydrate([
      hydrationRow({
        ad_id: "ad-unsupplied",
        recent14_link_clicks: null,
        prior14_link_clicks: null,
      }),
    ]);
    expect(unsupplied?.adBandEvidence?.recent14.linkClicks).toBeNull();
    expect(unsupplied?.adBandEvidence?.prior14.linkClicks).toBeNull();

    const [measuredZero] = await hydrate([
      hydrationRow({
        ad_id: "ad-measured-zero",
        recent14_link_clicks: "0",
        prior14_link_clicks: "0",
      }),
    ]);
    expect(measuredZero?.adBandEvidence?.recent14.linkClicks).toBe(0);
    expect(measuredZero?.adBandEvidence?.prior14.linkClicks).toBe(0);
  });

  it("reports a band the ad never delivered into as null, not as zero", async () => {
    // PostgreSQL SUM over zero rows is NULL, and the mapper keeps it: "this ad
    // has no admissible delivery in this window" is not "this ad delivered
    // nothing", and only the first is true of an ad that started mid-window.
    const [input] = await hydrate([
      hydrationRow({
        prior14_row_count: null,
        prior14_spend: null,
        prior14_conversions: null,
        prior14_revenue: null,
        prior14_impressions: null,
        prior14_clicks: null,
        prior14_link_clicks: null,
      }),
    ]);

    expect(input?.adBandEvidence?.prior14).toEqual({
      startDate: "2026-06-13",
      endDate: "2026-06-26",
      spend: null,
      purchases: null,
      revenue: null,
      impressions: null,
      clicks: null,
      linkClicks: null,
    });
    // The window bounds still come from the query, so the withheld reason is
    // "no delivery", never "no window".
    const evidence = computeNativeAdLifecycleEvidence({
      ad: input!,
      profile: bandProfile(),
      frequencyPressureThreshold: 3.5,
    });
    expect(evidence.missingEvidence).toContain(
      "ad_prior14_window_delivery_unavailable",
    );
    expect(evidence.missingEvidence).not.toContain(
      "ad_prior14_window_unavailable",
    );
    expect(evidence.fatigueStatus).toBe("unknown");
  });

  it("withholds band evidence entirely from an ad with no observed metrics", async () => {
    // A present-day dimension/state seed with no ad-day rows. Emitting two
    // all-null bands for it would report "these windows had no delivery" where
    // the truth is "this ad has no observed metrics at all".
    const [input] = await hydrate([
      hydrationRow({ metric_row_count: 0, event_metrics_observed: false }),
    ]);

    expect(input?.metricEvidence.performanceMetricsObserved).toBe(false);
    expect(input?.adBandEvidence).toBeNull();
    const evidence = computeNativeAdLifecycleEvidence({
      ad: input!,
      profile: bandProfile(),
      frequencyPressureThreshold: 3.5,
    });
    expect(evidence.missingEvidence).toContain(
      "ad_performance_metrics_unobserved",
    );
    expect(evidence.fatigueStatus).toBe("unknown");
  });

  /**
   * Eight hydrated siblings so the account-relative frequency P75 exists, plus
   * the decayed ad under test. The siblings' own bands are flat: they supply
   * the percentile, they are not the case.
   */
  /*
    The default `hydrationRow` carries a full funnel payload (outbound clicks,
    landing-page views, add-to-cart, initiate-checkout). Left in place beside
    these purchase counts it makes the funnel diagnosis fire and the row serves
    `diagnose`, which is a different question from the Refresh one under test.
    Nulled here so the ROAS zone is what decides the label.
  */
  const NO_FUNNEL_PAYLOAD = {
    outbound_clicks: null,
    landing_page_views: null,
    add_to_cart: null,
    initiate_checkout: null,
    thumbstop: null,
    video25_rate: null,
    video50_rate: null,
    video75_rate: null,
    video100_rate: null,
  };

  function bandPopulation(
    adOverrides: Record<string, unknown>,
  ): Array<Record<string, unknown>> {
    const siblings = [1, 1.2, 1.4, 1.6, 1.8, 2, 2.2, 2.4].map(
      (frequency, index) =>
        hydrationRow({
          ad_id: `ad-sibling-${index}`,
          frequency,
          spend: 400,
          conversions: 12,
          revenue: 760,
          roas: 1.9,
          impressions: 200_000,
          recent_spend: 100,
          recent_conversions: 3,
          recent_revenue: 180,
          recent_roas: 1.8,
          recent_impressions: 90_000,
          ...NO_FUNNEL_PAYLOAD,
          ...bandColumns({
            recent14_spend: 100,
            recent14_conversions: 7,
            recent14_revenue: 367,
            recent14_impressions: "150000",
            recent14_clicks: "3000",
            recent14_link_clicks: "2000",
          }),
        }),
    );
    return [...siblings, hydrationRow(adOverrides)];
  }

  /** The decayed ad under test, in the cumulative shape the resolver reads. */
  function decayedAdRow(
    bandOverrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      ad_id: "ad-decayed",
      frequency: 9,
      spend: 400,
      conversions: 12,
      revenue: 760,
      roas: 1.9,
      impressions: 200_000,
      recent_spend: 100,
      recent_conversions: 1,
      recent_revenue: 50,
      recent_roas: 0.5,
      recent_impressions: 90_000,
      ...NO_FUNNEL_PAYLOAD,
      ...bandColumns(bandOverrides),
    };
  }

  it("carries hydrated band evidence into an AUTHORIZED native Refresh", async () => {
    /*
      The positive direction, which a contract that can only ever hold does not
      have. Nothing here builds `adBandEvidence` by hand: the bands come out of
      the hydration mapper, the account-relative P75 comes out of the hydrated
      population, and the decision comes out of the real producer.

      The decayed ad's own bands collapse on all three composite stages —
      CTR 2.00% to 1.00%, click-to-purchase 0.0100 to 0.0033, ROAS 3.67 to
      1.00 — and its frequency of 9 clears the sibling P75.
    */
    const inputs = await hydrate(bandPopulation(decayedAdRow()));
    const thresholds =
      resolveNativeAdFrequencyPressureThresholdsByAccount(inputs);
    expect(thresholds.get("act_account_1")).toBe(2.2);

    const decayed = inputs.find((row) => row.adId === "ad-decayed");
    const evidence = computeNativeAdLifecycleEvidence({
      ad: decayed!,
      profile: bandProfile(),
      frequencyPressureThreshold: thresholds.get("act_account_1") ?? null,
    });
    expect(evidence.missingEvidence).toEqual([]);
    expect(evidence.fatigueStatus).toBe("fatigued");

    const decisions = computeNativeAdDecisions({
      businessId: BUSINESS_ID,
      profile: bandProfile(),
      dataHealth: makeDataHealth(),
      adInputs: inputs,
      campaignContextMode: "automatic",
      campaignContextById: campaignContext(),
      previousLabels: new Map(),
      frequencyPressureThresholdByAccount: thresholds,
    });
    const decision = decisions.find(
      (row) => row.input.adId === "ad-decayed",
    )?.decision;
    expect(decision?.preAuthorityLabel).toBe("refresh");
    expect(decision?.reason).toContain("Fatigued");

    // Authorized, so the provenance says the contract PASSED and carries the
    // full hash rather than a withheld-evidence entry.
    const provenance = (decision?.blockers ?? []).find(
      (entry) => entry.predicate === "refresh_ad_lifecycle_evidence_contract",
    );
    expect(provenance?.status).toBe("passed");
    expect(provenance?.observed).toBe(
      `${NATIVE_AD_LIFECYCLE_EVIDENCE_CONTRACT}#${evidence.evidenceHash}`,
    );
    expect(
      (decision?.blockers ?? []).map((entry) => entry.predicate),
    ).not.toContain("refresh_ad_lifecycle_evidence");
  });

  it("keeps the same ad HELD when its link-click denominator is absent", async () => {
    /*
      The negative direction on the same population, changing one fact.
      Read-only inspection of the live warehouse on 2026-09-07 found
      `meta_ad_daily.link_clicks` with no positive value anywhere in the
      current 28-day window (2,461 measured rows, every one exactly 0, plus
      7,885 NULL), so this is the branch production takes today — and the
      verdict is withheld, not converted into a healthy Keep.
    */
    const inputs = await hydrate(
      bandPopulation(
        decayedAdRow({
          recent14_link_clicks: null,
          prior14_link_clicks: null,
        }),
      ),
    );
    const thresholds =
      resolveNativeAdFrequencyPressureThresholdsByAccount(inputs);
    const decayed = inputs.find((row) => row.adId === "ad-decayed");
    const evidence = computeNativeAdLifecycleEvidence({
      ad: decayed!,
      profile: bandProfile(),
      frequencyPressureThreshold: thresholds.get("act_account_1") ?? null,
    });
    expect(evidence.missingEvidence).toContain(
      "ad_recent14_window_link_clicks_unavailable",
    );
    expect(evidence.missingEvidence).toContain(
      "ad_prior14_window_link_clicks_unavailable",
    );
    expect(evidence.fatigueStatus).toBe("unknown");

    const decisions = computeNativeAdDecisions({
      businessId: BUSINESS_ID,
      profile: bandProfile(),
      dataHealth: makeDataHealth(),
      adInputs: inputs,
      campaignContextMode: "automatic",
      campaignContextById: campaignContext(),
      previousLabels: new Map(),
      frequencyPressureThresholdByAccount: thresholds,
    });
    const decision = decisions.find(
      (row) => row.input.adId === "ad-decayed",
    )?.decision;

    // Execution shut, verdict kept and named.
    expect(decision?.label).toBe("keep");
    expect(decision?.preAuthorityLabel).toBe("refresh");
    expect(decision?.blockedActionType).toBe("refresh");
    const provenance = (decision?.blockers ?? []).find(
      (entry) => entry.predicate === "refresh_ad_lifecycle_evidence_contract",
    );
    expect(provenance?.status).toBe("missing");
    expect(provenance?.reason).toContain(
      "ad_recent14_window_link_clicks_unavailable",
    );
  });

  it("resolves the frequency percentile per provider account, not per hydrated cell", async () => {
    /*
      INVARIANTS.md requires the percentile to be account-relative, and the
      production job builds it from the whole hydrated population BEFORE the
      split into calibration cells. Here the eight siblings are split across
      two optimization contexts, which is exactly the split a profile group
      makes; resolved per cell each half is four observations and returns null,
      and the decayed ad would be withheld on an account that has ample
      observations.
    */
    const population = bandPopulation(decayedAdRow());
    const split = population.map((row, index) =>
      index < 4
        ? { ...row, optimization_goal: "LEAD", custom_event_type: "LEAD" }
        : row,
    );
    const inputs = await hydrate(split);
    const accountWide =
      resolveNativeAdFrequencyPressureThresholdsByAccount(inputs);
    expect(accountWide.get("act_account_1")).toBe(2.2);

    const leadCell = inputs.filter((row) => row.customEventType === "LEAD");
    const purchaseCell = inputs.filter(
      (row) => row.customEventType !== "LEAD",
    );
    expect(leadCell).toHaveLength(4);
    expect(
      resolveNativeAdFrequencyPressureThresholdsByAccount(leadCell).get(
        "act_account_1",
      ),
    ).toBeNull();

    const decayed = purchaseCell.find((row) => row.adId === "ad-decayed");
    expect(
      computeNativeAdLifecycleEvidence({
        ad: decayed!,
        profile: bandProfile(),
        frequencyPressureThreshold: accountWide.get("act_account_1") ?? null,
      }).fatigueStatus,
    ).toBe("fatigued");
    expect(
      computeNativeAdLifecycleEvidence({
        ad: decayed!,
        profile: bandProfile(),
        frequencyPressureThreshold:
          resolveNativeAdFrequencyPressureThresholdsByAccount(
            purchaseCell,
          ).get("act_account_1") ?? null,
      }).fatigueStatus,
    ).toBe("unknown");
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

  it("fills missing current hierarchy context from cutoff-safe config history", () => {
    expect(HYDRATE_AD_DECISION_INPUTS_QUERY).toContain(
      "current_adset_config ON $12::boolean",
    );
    expect(HYDRATE_AD_DECISION_INPUTS_QUERY).toContain(
      "current_campaign_config ON $12::boolean",
    );
    expect(HYDRATE_AD_DECISION_INPUTS_QUERY).toContain(
      "config.captured_at <= $11::timestamptz",
    );
    expect(HYDRATE_AD_DECISION_INPUTS_QUERY).toContain(
      "config.created_at <= $11::timestamptz",
    );
  });

  it("prefers cutoff-safe fact timezone and currency over current provider dimensions for hydration", () => {
    expect(HYDRATE_AD_DECISION_INPUTS_QUERY).toContain(
      "account_identity.account_timezone,\n    CASE WHEN $12::boolean THEN NULLIF(BTRIM(provider_account.timezone), '') END",
    );
    expect(HYDRATE_AD_DECISION_INPUTS_QUERY).toContain(
      "account_identity.account_currency,\n    CASE WHEN $12::boolean THEN NULLIF(BTRIM(provider_account.currency), '') END",
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
      "observed_at <= $5::timestamptz",
    );
    expect(READ_AD_ENTITY_STATE_AS_OF_QUERY).toContain(
      "captured_at <= $5::timestamptz",
    );
    expect(READ_AD_ENTITY_STATE_AS_OF_QUERY).toContain(
      "provider_account_ref_id = $2::uuid",
    );
    expect(READ_AD_ENTITY_STATE_AS_OF_QUERY).toContain(
      "captured_at >= $6::timestamptz",
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
      "COALESCE(run.last_seen_at, run.observed_at) >= $2::date",
    );
    expect(READ_AD_HYDRATION_COMPLETENESS_RECEIPTS_QUERY).toContain(
      "source_expected_row_count",
    );
  });

  it("skips compacted positive-row runs while preserving legitimate empty runs", () => {
    expect(READ_AD_HYDRATION_COMPLETENESS_RECEIPTS_QUERY).toContain(
      "run.row_count = 0",
    );
    expect(READ_AD_HYDRATION_COMPLETENESS_RECEIPTS_QUERY).toContain(
      "retained_state.run_id = run.id",
    );
    expect(READ_AD_HYDRATION_COMPLETENESS_RECEIPTS_QUERY).toContain(
      "OR EXISTS (",
    );
  });

  it("binds receipt membership to the exact complete payload while heartbeat clocks prove freshness", () => {
    expect(READ_AD_HYDRATION_COMPLETENESS_RECEIPTS_QUERY).toContain(
      "state.run_id = run.source_run_id",
    );
    // Tombstones are written under their own point_lookup runs, so binding
    // them to the source run id would make the arm unmatchable and freeze
    // deleted ads into the manifest. Membership is identity-scoped instead.
    expect(READ_AD_HYDRATION_COMPLETENESS_RECEIPTS_QUERY).not.toContain(
      "tombstone.run_id = run.source_run_id",
    );
    expect(READ_AD_HYDRATION_COMPLETENESS_RECEIPTS_QUERY).toContain(
      "COALESCE(run.last_captured_at, run.captured_at)",
    );
    // The payload clock (the run's ORIGINAL capture time) travels beside the
    // heartbeat freshness clocks so hydration can floor on the payload, not
    // the heartbeat.
    expect(READ_AD_HYDRATION_COMPLETENESS_RECEIPTS_QUERY).toContain(
      "run.captured_at AS source_payload_captured_at",
    );
    expect(READ_AD_HYDRATION_COMPLETENESS_RECEIPTS_QUERY).toContain(
      "source_payload_captured_at::text AS source_payload_captured_at",
    );
    // The freshness pair may never invert: a transitional row whose
    // last_seen_at advanced under pre-last_captured_at code is clamped.
    expect(READ_AD_HYDRATION_COMPLETENESS_RECEIPTS_QUERY).toContain("LEAST(");
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

  it("materializes two equal, disjoint, directly adjacent 14-day ad bands", () => {
    // Equal: both windows span 14 inclusive days. Disjoint and directly
    // adjacent: prior14 ends at cutoff-14 and recent14 starts at cutoff-13.
    expect(HYDRATE_AD_DECISION_INPUTS_QUERY).toContain(
      "('recent14', d.date BETWEEN ($2::date - INTERVAL '13 days') AND $2::date)",
    );
    expect(HYDRATE_AD_DECISION_INPUTS_QUERY).toContain(
      "('prior14', d.date BETWEEN ($2::date - INTERVAL '27 days') AND ($2::date - INTERVAL '14 days'))",
    );
    // Materialized, not differenced: DECISION_LOG.md D037 forbids
    // reconstructing prior14 by subtracting recent14 from a cumulative window.
    expect(HYDRATE_AD_DECISION_INPUTS_QUERY).toContain("FROM ad_band_days");
    expect(HYDRATE_AD_DECISION_INPUTS_QUERY).toContain(
      "GROUP BY provider_account_id, ad_id, band_key",
    );
    // Both composite denominators, which the 7-day `recent` CTE has neither of.
    for (const column of [
      "MAX(clicks) FILTER (WHERE band_key = 'recent14') AS recent14_clicks",
      "MAX(link_clicks) FILTER (WHERE band_key = 'recent14') AS recent14_link_clicks",
      "MAX(clicks) FILTER (WHERE band_key = 'prior14') AS prior14_clicks",
      "MAX(link_clicks) FILTER (WHERE band_key = 'prior14') AS prior14_link_clicks",
    ]) {
      expect(HYDRATE_AD_DECISION_INPUTS_QUERY).toContain(column);
    }
  });

  it("draws the bands only from cutoff-bound, finalized, validated ad days", () => {
    // `ad_band_days` reads `selected_ad_days`, which is already bounded to the
    // 28 days ending at the cutoff and to finalized/validated rows created and
    // updated before the decision cutoff. Reading `meta_ad_daily` directly
    // would let a row dated after the cutoff into a band.
    expect(HYDRATE_AD_DECISION_INPUTS_QUERY).toContain(
      "  FROM selected_ad_days d\n  CROSS JOIN LATERAL (\n    VALUES\n      ('recent14'",
    );
    expect(HYDRATE_AD_DECISION_INPUTS_QUERY).toContain(
      "$2::date::text AS band_cutoff_date",
    );
    expect(HYDRATE_AD_DECISION_INPUTS_QUERY).toContain(
      "($2::date - INTERVAL '13 days')::date::text AS recent14_start_date",
    );
  });

  it("keeps an unsupplied band link-click sum null instead of coercing it to zero", () => {
    /*
      `metric_cumulative` wraps the same column in COALESCE(x, 0) so its 28-day
      answer stays byte-identical to the one it gave when `link_clicks` was NOT
      NULL. The band columns are new and carry the honest three-valued answer
      instead: NULL when every day in the window was unsupplied, 0 when the
      days were measured and were zero.
    */
    /*
      Scoped to the BAND aggregate, not the whole query: `metric_cumulative`
      legitimately coalesces the same column so its 28-day answer stays
      byte-identical to the one it gave when `link_clicks` was NOT NULL. An
      unscoped negative would match that one and mean nothing.
    */
    const bandBlock = HYDRATE_AD_DECISION_INPUTS_QUERY.slice(
      HYDRATE_AD_DECISION_INPUTS_QUERY.indexOf("ad_band_aggregates AS ("),
      HYDRATE_AD_DECISION_INPUTS_QUERY.indexOf("FROM ad_band_days"),
    );
    expect(bandBlock).toContain("SUM(link_clicks) AS link_clicks");
    expect(bandBlock).not.toContain("COALESCE(link_clicks");
    /*
      AND THE SUM ALONE IS NOT ENOUGH, which is why the band also carries
      coverage. `SUM` returns NULL only when EVERY row is NULL, so a band with
      some measured days and some delivered-but-unreported days came back as a
      positive number indistinguishable from full coverage.
    */
    expect(HYDRATE_AD_DECISION_INPUTS_QUERY).toContain(
      "link_clicks_missing_delivered_rows",
    );
    // The 28-day rollup keeps its coalesce; this test must not be read as
    // having changed that one.
    expect(HYDRATE_AD_DECISION_INPUTS_QUERY).toContain(
      "SUM(COALESCE(link_clicks, 0)) AS link_clicks",
    );
  });
});

/*
  CODEX B9 — PARTIAL LINK-CLICK COVERAGE IS UNKNOWN, NOT MEASURED.

  `SUM(link_clicks)` ignores NULLs and returns NULL only when EVERY row in the
  band is NULL. A band with three measured days and eleven delivered days the
  provider never reported therefore came back as a positive number
  indistinguishable from complete coverage, and the click-to-purchase composite
  divided by it — a denominator built from part of a window, presented as the
  whole of it, and able to authorize a Refresh.

  The four states the review named are pinned here: unavailable, measured zero,
  mixed incomplete, and complete positive.
*/
describe("band link-click completeness", () => {
  async function bandOf(overrides: Record<string, unknown>) {
    const rows = [hydrationRow(overrides)];
    const inputs = await warehouseWithRows({
      hydration: rows,
      states: rows.map((row, index) => ({
        event_kind: "state",
        presence: "present",
        id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        provider_account_ref_id: "00000000-0000-4000-8000-000000000711",
        provider_account_id: "act_account_1",
        entity_id: row.ad_id,
        creative_id: "creative-shared",
        configured_status: "ACTIVE",
        effective_status: "ACTIVE",
        observed_at: "2026-07-10T02:30:00.000Z",
        captured_at: "2026-07-10T02:31:00.000Z",
      })),
    }).listAdDecisionInputs({
      businessId: BUSINESS_ID,
      asOf: HISTORICAL_AS_OF,
      decisionCutoff: HISTORICAL_CUTOFF,
    });
    return inputs[0]?.adBandEvidence?.recent14 ?? null;
  }

  it("reports a fully measured positive band as measured", async () => {
    const band = await bandOf({
      recent14_link_clicks: "560",
      recent14_link_clicks_measured_rows: 14,
      recent14_link_clicks_missing_delivered_rows: 0,
    });
    expect(band?.linkClicks).toBe(560);
  });

  it("keeps a fully measured ZERO band as a measured zero, not unknown", async () => {
    // The distinction the raw column exists to preserve: reported-and-zero is
    // an observation, and it must survive the completeness gate.
    const band = await bandOf({
      recent14_link_clicks: "0",
      recent14_link_clicks_measured_rows: 14,
      recent14_link_clicks_missing_delivered_rows: 0,
    });
    expect(band?.linkClicks).toBe(0);
  });

  it("reports an entirely unsupplied band as unknown", async () => {
    const band = await bandOf({
      recent14_link_clicks: null,
      recent14_link_clicks_measured_rows: 0,
      recent14_link_clicks_missing_delivered_rows: 14,
    });
    expect(band?.linkClicks).toBeNull();
  });

  it("reports a MIXED band as unknown even though its sum is positive", async () => {
    /*
      THE CASE THIS EXISTS FOR. Three days measured 560 link clicks between
      them; eleven delivered days reported nothing. `SUM` answers 560 and the
      old mapper took it. The band is partial, so the honest answer is unknown.
    */
    const band = await bandOf({
      recent14_link_clicks: "560",
      recent14_link_clicks_measured_rows: 3,
      recent14_link_clicks_missing_delivered_rows: 11,
    });
    expect(band?.linkClicks).toBeNull();
    // And the rest of the band is untouched: only the link-click denominator
    // is unknown, not the whole observation.
    expect(band?.impressions).toBe(84000);
    expect(band?.clicks).toBe(840);
  });

  it("does not treat an undelivered day's missing link clicks as a gap", async () => {
    // A day with no impressions and no spend legitimately has no link clicks.
    // The query counts only DELIVERED rows, so this band stays measured.
    const band = await bandOf({
      recent14_link_clicks: "560",
      recent14_link_clicks_measured_rows: 9,
      recent14_link_clicks_missing_delivered_rows: 0,
    });
    expect(band?.linkClicks).toBe(560);
  });

  it("fails closed when the hydration row cannot report coverage at all", async () => {
    // A row from a query that predates the coverage columns cannot prove its
    // own completeness, and an unprovable denominator is unknown.
    const band = await bandOf({
      recent14_link_clicks: "560",
      recent14_link_clicks_measured_rows: undefined,
      recent14_link_clicks_missing_delivered_rows: undefined,
    });
    expect(band?.linkClicks).toBeNull();
  });
});
