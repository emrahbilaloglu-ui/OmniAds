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
  AD_DAY_AUTHORITATIVE_LINK_CLICKS_SQL,
  AD_DAY_DECISION_BEARING_ACTIVITY_SQL,
  CHOSEN_OBJECTIVE_SQL,
  CHOSEN_OPTIMIZATION_GOAL_SQL,
  HYDRATE_AD_DECISION_INPUTS_QUERY,
  READ_AD_HYDRATION_COMPLETENESS_RECEIPTS_QUERY,
  READ_AD_ENTITY_STATE_AS_OF_QUERY,
  READ_PRESENT_AD_STATE_SEEDS_QUERY,
  WarehouseDataSource,
  isPresentDayAdDecisionAsOf,
} from "../data-source";
import { NATIVE_AD_DB_BATCH_SIZE } from "../batching";
import { buildAdDayAuthoritativeLinkClicksSql } from "@/lib/meta/link-click-parse";
import { buildMetaCompleteWindowSql } from "@/lib/meta/funnel-stage-parse";
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
    account_timezone: "UTC",
    account_currency: "USD",
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
    source_coverage_status: "complete",
    source_coverage_expected_through_day: "2026-07-09",
    source_coverage_through_day: "2026-07-09",
    source_coverage_source_completed_at: "2026-07-10T00:30:00.000Z",
    source_coverage_published_at: "2026-07-10T01:00:00.000Z",
    data_freshness_hours: 3,
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

  it("ages complete coverage from the verified provider-local day, not the latest spending row or publication clock", async () => {
    const warehouse = warehouseWithRows({
      hydration: [
        hydrationRow({
          last_spend_date: "2026-07-03",
          source_coverage_status: "complete",
          source_coverage_expected_through_day: "2026-07-09",
          source_coverage_through_day: "2026-07-09",
          source_coverage_source_completed_at: "2026-07-10T00:30:00.000Z",
          source_coverage_published_at: "2026-07-10T01:00:00.000Z",
          data_freshness_hours: 3,
        }),
      ],
    });

    const [result] = await warehouse.listAdDecisionInputs({
      businessId: BUSINESS_ID,
      asOf: HISTORICAL_AS_OF,
      decisionCutoff: HISTORICAL_CUTOFF,
    });

    expect(result).toMatchObject({
      dataFreshnessHours: 3,
      metricEvidence: {
        sourceCoverage: {
          contractVersion: "meta-ad-source-coverage-freshness.v1",
          status: "complete",
          expectedThroughDay: "2026-07-09",
          coverageThroughDay: "2026-07-09",
          sourceCompletedAt: "2026-07-10T00:30:00.000Z",
          publishedAt: "2026-07-10T01:00:00.000Z",
        },
      },
    });
  });

  it("keeps a recently republished older day partial and refuses to turn it into fresh coverage", async () => {
    const warehouse = warehouseWithRows({
      hydration: [
        hydrationRow({
          source_coverage_status: "partial",
          source_coverage_expected_through_day: "2026-07-09",
          source_coverage_through_day: "2026-07-08",
          source_coverage_source_completed_at: "2026-07-10T02:45:00.000Z",
          source_coverage_published_at: "2026-07-10T03:00:00.000Z",
          // A producer bug must not make this authoritative while the expected
          // provider-local day is absent.
          data_freshness_hours: 1,
        }),
      ],
    });

    const [result] = await warehouse.listAdDecisionInputs({
      businessId: BUSINESS_ID,
      asOf: HISTORICAL_AS_OF,
      decisionCutoff: HISTORICAL_CUTOFF,
    });

    expect(result).toMatchObject({
      dataFreshnessHours: null,
      metricEvidence: {
        sourceCoverage: {
          status: "partial",
          expectedThroughDay: "2026-07-09",
          coverageThroughDay: "2026-07-08",
          sourceCompletedAt: "2026-07-10T02:45:00.000Z",
          publishedAt: "2026-07-10T03:00:00.000Z",
        },
      },
    });
  });

  it.each([
    {
      name: "publication after the decision cutoff",
      sourceCompletedAt: "2026-07-10T03:00:00.000Z",
      publishedAt: "2026-07-10T03:30:00.000Z",
    },
    {
      name: "source completion after publication",
      sourceCompletedAt: "2026-07-10T02:30:00.000Z",
      publishedAt: "2026-07-10T02:00:00.000Z",
    },
  ])("fails malformed coverage clocks closed: $name", async (clock) => {
    const warehouse = warehouseWithRows({
      hydration: [
        hydrationRow({
          source_coverage_source_completed_at: clock.sourceCompletedAt,
          source_coverage_published_at: clock.publishedAt,
          data_freshness_hours: 0,
        }),
      ],
    });

    const [result] = await warehouse.listAdDecisionInputs({
      businessId: BUSINESS_ID,
      asOf: HISTORICAL_AS_OF,
      decisionCutoff: HISTORICAL_CUTOFF,
    });

    expect(result).toMatchObject({
      dataFreshnessHours: null,
      metricEvidence: {
        sourceCoverage: {
          status: "unavailable",
          coverageThroughDay: null,
          sourceCompletedAt: null,
          publishedAt: null,
        },
      },
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
          dataFreshnessHours: 3,
          metricEvidence: expect.objectContaining({
            sourceRowCount: 0,
            performanceMetricsObserved: false,
            sourceCoverage: expect.objectContaining({ status: "complete" }),
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
      dataFreshnessHours: 3,
      metricEvidence: {
        sourceRowCount: 0,
        performanceMetricsObserved: false,
        eventMetricsObserved: false,
        sourceCoverage: expect.objectContaining({ status: "complete" }),
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

  it("does not infer a native purchase cohort from purchase results when config is absent", async () => {
    const warehouse = warehouseWithRows({
      hydration: [
        hydrationRow({
          objective: null,
          optimization_goal: null,
          custom_event_type: null,
          conversions: 4,
          revenue: 300,
          roas: 3,
          cpa: 25,
          recent_conversions: 1,
          recent_roas: 3,
          campaign_count: 1,
          adset_count: 1,
          optimization_context_count: 1,
          objective_count: 1,
          context_identity_unknown: false,
        }),
      ],
    });

    const [result] = await warehouse.listAdDecisionInputs({
      businessId: BUSINESS_ID,
      asOf: HISTORICAL_AS_OF,
      decisionCutoff: HISTORICAL_CUTOFF,
    });

    expect(result).toMatchObject({
      objective: null,
      optimizationGoal: null,
      customEventType: null,
      effectiveCohort: "unknown",
      purchases: 0,
      purchaseValue: null,
      roas: null,
      cpa: null,
      recent7dPurchases: 0,
      recent7dRoas: null,
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

  it("keeps the same ad HELD when a legacy zero makes its positive band partial", async () => {
    /*
      The negative direction on the same population, changing one fact.
      Read-only inspection of the live warehouse on 2026-09-07 found
      A legacy stored zero without row-local payload provenance is projected as
      NULL by the SQL classifier. Newer positive days can still leave a
      positive SUM, so the missing-row counter is the fact that prevents that
      partial denominator from authorizing Refresh.
    */
    const inputs = await hydrate(
      bandPopulation(
        decayedAdRow({
          recent14_link_clicks: "600",
          recent14_link_clicks_measured_rows: 13,
          recent14_link_clicks_missing_delivered_rows: 1,
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
    expect(evidence.missingEvidence).not.toContain(
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
  const coverageSql = HYDRATE_AD_DECISION_INPUTS_QUERY.slice(
    HYDRATE_AD_DECISION_INPUTS_QUERY.indexOf(
      "source_coverage_manifest_identity AS (",
    ),
    HYDRATE_AD_DECISION_INPUTS_QUERY.indexOf("current_config_scope AS ("),
  );
  const accountIdentitySql = HYDRATE_AD_DECISION_INPUTS_QUERY.slice(
    HYDRATE_AD_DECISION_INPUTS_QUERY.indexOf("account_identity AS ("),
    HYDRATE_AD_DECISION_INPUTS_QUERY.indexOf(
      "source_coverage_manifest_identity AS (",
    ),
  );

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

  it("binds freshness proof to the exact business, physical account, surface, day and run", () => {
    expect(accountIdentitySql).toContain(
      "assignment.provider_account_ref_id = d.provider_account_ref_id",
    );
    expect(coverageSql).toContain(
      "pointer.business_ref_id::text = scope.business_id",
    );
    expect(coverageSql).toContain(
      "pointer.provider_account_ref_id = scope.provider_account_ref_id",
    );
    expect(coverageSql).toContain(
      "pointer.provider_account_id = scope.provider_account_id",
    );
    expect(coverageSql).toContain("pointer.surface = 'ad_daily'");
    expect(coverageSql).toContain("slice.day = pointer.day");
    expect(coverageSql).toContain("manifest.day = slice.day");
    expect(coverageSql).toContain(
      "pointer.published_by_run_id = slice.source_run_id",
    );
    expect(coverageSql).toContain("manifest.run_id = slice.source_run_id");
  });

  it("admits only cutoff-safe finalized verified publication lineage", () => {
    expect(coverageSql).toContain("manifest.fetch_status = 'completed'");
    expect(coverageSql).toContain("slice.state = 'finalized_verified'");
    expect(coverageSql).toContain("slice.truth_state = 'finalized'");
    expect(coverageSql).toContain("slice.validation_status = 'passed'");
    expect(coverageSql).toContain("slice.status = 'published'");
    expect(coverageSql).toContain(
      "manifest.completed_at <= pointer.published_at",
    );
    for (const clock of [
      "manifest.created_at",
      "manifest.updated_at",
      "manifest.completed_at",
      "slice.created_at",
      "slice.updated_at",
      "slice.published_at",
      "pointer.created_at",
      "pointer.updated_at",
      "pointer.published_at",
    ]) {
      expect(coverageSql).toContain(`${clock} <= $11::timestamptz`);
    }
  });

  it("defines complete coverage by the last closed provider-local day and keeps older repairs partial", () => {
    expect(coverageSql).toContain(
      "$11::timestamptz AT TIME ZONE COALESCE(",
    );
    expect(coverageSql).toContain(
      "coverage.coverage_through_day = scope.expected_through_day",
    );
    expect(coverageSql).toContain("ELSE 'partial'");
    expect(coverageSql).toContain(
      "(pointer.day + 1)::timestamp AT TIME ZONE scope.account_timezone",
    );
  });

  it("derives freshness age from the reporting-day boundary and not a row, sync or publication clock", () => {
    const projectionSql = HYDRATE_AD_DECISION_INPUTS_QUERY.slice(
      HYDRATE_AD_DECISION_INPUTS_QUERY.indexOf(
        "source_coverage.coverage_status AS source_coverage_status",
      ),
      HYDRATE_AD_DECISION_INPUTS_QUERY.indexOf(
        "$7::double precision AS target_roas",
      ),
    );
    expect(projectionSql).toContain(
      "(source_coverage.coverage_through_day + 1)::timestamp",
    );
    expect(projectionSql).toContain(
      "AT TIME ZONE source_coverage.account_timezone",
    );
    expect(projectionSql).not.toContain("source_max_updated_at");
    expect(projectionSql).not.toContain("source_completed_at))");
    expect(projectionSql).not.toContain("published_at))");
  });

  it("computes account coverage independently of whether a target ad has a metric row", () => {
    expect(coverageSql).toContain("FROM selected_accounts selected");
    expect(coverageSql).not.toContain("FROM meta_ad_daily");
    expect(coverageSql).not.toContain("ad_id");
    expect(coverageSql).toContain(
      "ELSE COALESCE(\n        account_identity.account_timezone,\n        manifest_identity.account_timezone",
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

  it("keys the as-of config on the OBSERVATION clock, not the validity clock", () => {
    /*
      meta_campaign_config_history carries effective_from, captured_at and
      created_at. Measured on production, captured_at precedes created_at on all
      305,176 rows by up to 103 DAYS, so the choice is load-bearing: a decision
      input must answer "what did we know on that day", and effective_from would
      back-date a late observation into a day nobody could have acted on.

      Cost, measured over 90 days and 38,326 spending ad-days: effective_from
      finds an objective on 40 rows captured_at does not, and where both find
      one they disagree on 0. Those 40 are real missing evidence. This case
      exists so a later reader does not close them by switching clocks.
    */
    expect(HYDRATE_AD_DECISION_INPUTS_QUERY).toContain("config.captured_at <");
    expect(HYDRATE_AD_DECISION_INPUTS_QUERY).not.toContain("config.effective_from");
  });

  it("keeps the daily arm ahead of the as-of lateral, which is where a repair lands", () => {
    /*
      The historical config repair writes meta_campaign_daily / meta_adset_daily
      config columns and does NOT create typed history, so a repaired day can
      only be seen through the daily value. If the COALESCE ever put the
      lateral first, every repaired day would be silently overridden by whatever
      typed history happened to hold.
    */
    /*
      Asserted on the EXPRESSION, not on a byte offset in the whole query. The
      offset search used to look for the first "AS objective" and read the 400
      characters before it; the field-source contract's own CTE now also
      projects a column by that name, so the locator found the wrong expression
      and the test passed or failed for reasons unrelated to the COALESCE.
    */
    expect(CHOSEN_OBJECTIVE_SQL.indexOf("c.objective")).toBeLessThan(
      CHOSEN_OBJECTIVE_SQL.indexOf("asof_campaign_config.objective"),
    );
    expect(HYDRATE_AD_DECISION_INPUTS_QUERY).toContain(CHOSEN_OBJECTIVE_SQL);
    /* The same order for the ad-set fields, which the repair also writes. */
    expect(CHOSEN_OPTIMIZATION_GOAL_SQL.indexOf("a.optimization_goal")).toBeLessThan(
      CHOSEN_OPTIMIZATION_GOAL_SQL.indexOf("asof_adset_config.optimization_goal"),
    );
  });

  it("fills missing hierarchy context from config history AS OF THE METRIC DAY", () => {
    /*
      The aliases are `asof_*` and the laterals carry a `d.date` bound.

      They used to be `current_*` bounded only by the evaluation cutoff, so a
      July metric day could take the newest configuration captured up to TODAY —
      one that did not exist on the day whose spend it was classifying.

      The boundary is PROVIDER-LOCAL. d.date is a provider-local reporting day,
      and a bare (d.date + 1) casts through the SESSION zone (Etc/UTC here),
      which is the wrong midnight twice over: it admits the next local day for
      UTC+ accounts and truncates the real one for UTC- accounts.

      Measured read-only on production over 90 days, 38,326 spending ad-days:
      the naive UTC bound left 126 genuine future leaks AND removed 171 real
      same-day configs; the provider-local bound keeps 35,037 true as-of
      objectives and removes both errors.
    */
    expect(HYDRATE_AD_DECISION_INPUTS_QUERY).toContain(
      "asof_adset_config ON $12::boolean",
    );
    expect(HYDRATE_AD_DECISION_INPUTS_QUERY).toContain(
      "asof_campaign_config ON $12::boolean",
    );
    expect(HYDRATE_AD_DECISION_INPUTS_QUERY).not.toContain("current_adset_config");
    expect(HYDRATE_AD_DECISION_INPUTS_QUERY).not.toContain("current_campaign_config");
    expect(HYDRATE_AD_DECISION_INPUTS_QUERY).toContain(
      "config.captured_at < ((d.date + 1)::timestamp AT TIME ZONE COALESCE(NULLIF(BTRIM(d.account_timezone), ''), 'UTC'))",
    );
    // A bare date bound would cast through the session zone.
    expect(HYDRATE_AD_DECISION_INPUTS_QUERY).not.toContain(
      "config.captured_at < (d.date + 1)\n",
    );
    expect(HYDRATE_AD_DECISION_INPUTS_QUERY).toContain(
      "config.captured_at <= $11::timestamptz",
    );
    expect(HYDRATE_AD_DECISION_INPUTS_QUERY).toContain(
      "config.created_at <= $11::timestamptz",
    );
    /*
      The day bound belongs to the metric-day CTE only; the present-day context
      CTE stays anchored to $2::date, which is a different question.

      Counted on the DAY BOUND itself, which only the two as-of laterals emit —
      the present-day laterals bound by the cutoff alone.
      The previous proxy counted every use of the provider-local timezone
      expression, and the field-source contract legitimately uses it many times
      for its own day boundaries — so the count measured the contract's size
      rather than this rule.
    */
    expect(
      (
        HYDRATE_AD_DECISION_INPUTS_QUERY.match(
          /config\.captured_at < \(\(d\.date \+ 1\)/g,
        ) ?? []
      ).length,
    ).toBe(2);
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
    for (const query of [
      HYDRATE_AD_DECISION_INPUTS_QUERY,
      READ_AD_HYDRATION_COMPLETENESS_RECEIPTS_QUERY,
    ]) {
      expect(query).toContain("JOIN provider_accounts account");
      expect(query).toContain("account.provider = binding.provider");
      expect(query).toContain(
        "account.external_account_id = binding.provider_account_id",
      );
      expect(query).toContain("AND binding.is_selected");
    }
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
    // outbound/thumbstop/video are not requested at ad grain and have no
    // verified numerator or denominator there: NULL by contract, with no cast
    // of unvalidated payload text that a malformed value could make raise.
    for (const column of [
      "NULL::numeric AS outbound_clicks",
      "NULL::double precision AS thumbstop",
      "NULL::double precision AS video25_rate",
      "NULL::double precision AS video100_rate",
    ]) {
      expect(HYDRATE_AD_DECISION_INPUTS_QUERY).toContain(column);
    }
    expect(HYDRATE_AD_DECISION_INPUTS_QUERY).not.toContain(
      "payload_json->>'outbound_clicks'",
    );
    expect(HYDRATE_AD_DECISION_INPUTS_QUERY).not.toContain(
      "payload_json->>'thumbstop'",
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
    // `ad_band_days` reads the context-admitted subset of selected_ad_days.
    // selected_ad_days is bounded to the cutoff and finalized/validated rows;
    // the admitted subset also prevents older, different config economics from
    // being silently counted under the current context.
    expect(HYDRATE_AD_DECISION_INPUTS_QUERY).toContain(
      "  FROM decision_ad_days d\n  CROSS JOIN LATERAL (\n    VALUES\n      ('recent14'",
    );
    expect(HYDRATE_AD_DECISION_INPUTS_QUERY).toContain(
      "$2::date::text AS band_cutoff_date",
    );
    expect(HYDRATE_AD_DECISION_INPUTS_QUERY).toContain(
      "($2::date - INTERVAL '13 days')::date::text AS recent14_start_date",
    );
  });

  it("requires today's custom-conversion identity to match the admitted decision context", () => {
    const sql = HYDRATE_AD_DECISION_INPUTS_QUERY;
    expect(sql).toContain(
      "NULLIF(BTRIM(today_config.custom_conversion_id), '')\n        IS NOT DISTINCT FROM NULLIF(BTRIM(latest.custom_conversion_id), '')",
    );
    expect(sql).toContain(
      "ELSE 'none'\n  END AS current_optimization_goal_readiness",
    );
    expect(sql).toContain(
      "ELSE 'none'\n  END AS current_custom_conversion_id_readiness",
    );
  });

  it("keeps an unsupplied band link-click sum null instead of coercing it to zero", () => {
    /*
      The band columns carry the honest three-valued answer: NULL when every
      day in the window was unsupplied, 0 when the days were measured and were
      zero. Scoped to the BAND aggregate so the assertion names the block it is
      about.
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
    // The 28-day rollup no longer coalesces (see the next describe block).
    expect(HYDRATE_AD_DECISION_INPUTS_QUERY).not.toContain(
      "SUM(COALESCE(link_clicks, 0)) AS link_clicks",
    );
    const bandDaysBlock = HYDRATE_AD_DECISION_INPUTS_QUERY.slice(
      HYDRATE_AD_DECISION_INPUTS_QUERY.indexOf("ad_band_days AS ("),
      HYDRATE_AD_DECISION_INPUTS_QUERY.indexOf("ad_band_aggregates AS ("),
    );
    // The band reads the D095 value computed once per row in decision_ad_days.
    expect(bandDaysBlock).toContain("d.authoritative_link_clicks AS link_clicks");
    const decisionDaysBlock = HYDRATE_AD_DECISION_INPUTS_QUERY.slice(
      HYDRATE_AD_DECISION_INPUTS_QUERY.indexOf("decision_ad_days AS ("),
      HYDRATE_AD_DECISION_INPUTS_QUERY.indexOf("admitted_metric_context_days AS ("),
    );
    expect(decisionDaysBlock).toContain(
      `${buildAdDayAuthoritativeLinkClicksSql({
        qualifier: "d", providerZeroProofSql: "d.provider_zero_receipt_verified",
      })} AS authoritative_link_clicks`,
    );
    expect(AD_DAY_AUTHORITATIVE_LINK_CLICKS_SQL).toContain(
      "jsonb_typeof(payload_json->'actions') = 'array'",
    );
    expect(AD_DAY_AUTHORITATIVE_LINK_CLICKS_SQL).toContain(
      "WHEN COUNT(*) = 0 THEN TRUE",
    );
    expect(AD_DAY_AUTHORITATIVE_LINK_CLICKS_SQL).toContain(
      "ELSE '[]'::jsonb",
    );
  });
});

/*
  THE 28-DAY ROLLUP READS UNDER THE WINDOW RULE (2026-09-22).

  metric_cumulative used SUM(COALESCE(link_clicks, 0)) over the raw column and
  SUM(stage) FILTER (WHERE measured) for the funnel stages. Both fabricate: an
  unsupplied day became a measured zero, a partially reported window passed as
  complete, and the raw column admitted legacy zeros the bands in the same
  query refuse under D095. These pins hold the replacement in place; the
  PostgreSQL behaviour is proven in ad-band-completeness.db.test.ts.
*/
describe("the native 28-day rollup aggregates complete-or-null", () => {
  // Executable lines only: the comments legitimately name the old expressions.
  const cumulative = HYDRATE_AD_DECISION_INPUTS_QUERY.slice(
    HYDRATE_AD_DECISION_INPUTS_QUERY.indexOf("metric_cumulative AS ("),
    HYDRATE_AD_DECISION_INPUTS_QUERY.indexOf("cumulative AS (", HYDRATE_AD_DECISION_INPUTS_QUERY.indexOf("metric_cumulative AS (") + 10),
  )
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");

  it("sums the D095 row value only when no decision-bearing day is missing", () => {
    const window = buildMetaCompleteWindowSql({
      valueSql: "authoritative_link_clicks",
      missingSql: "authoritative_link_clicks IS NULL",
      activitySql: AD_DAY_DECISION_BEARING_ACTIVITY_SQL,
    });
    expect(cumulative).toContain(`${window.sumSql} AS link_clicks`);
    expect(cumulative).not.toContain("COALESCE(link_clicks");
  });

  it("gives every funnel stage the same window rule instead of a partial FILTER sum", () => {
    for (const column of ["landing_page_views", "add_to_cart", "initiate_checkout"]) {
      const line = cumulative
        .split("\n")
        .find((candidate) => candidate.trimEnd().endsWith(`AS ${column},`));
      expect(line, column).toBeDefined();
    }
    expect(cumulative).not.toMatch(/FILTER \(WHERE [^)]*measured[^)]*\) AS landing_page_views/);
    expect(cumulative.match(/WHEN COUNT\(\*\) FILTER \(WHERE TRUE AND/g)?.length).toBe(4);
  });

  it("no longer claims an event observation from keys meta_ad_daily never carries", () => {
    expect(cumulative).not.toContain("payload_json ? 'thumbstop'");
    expect(cumulative).not.toContain("payload_json ? 'outbound_clicks'");
    expect(cumulative).toContain("OR authoritative_link_clicks IS NOT NULL");
  });
});

/*
  THE RECEIPT-REFERENCE LATERALS ARE OPTIMIZATION FENCES (2026-09-22).

  Each reference is a scalar subquery over the whole tier ladder, and the
  coherence gate reads the column about thirty times per field. Without
  OFFSET 0 the planner inlined the subquery into every reader: measured
  read-only on production (TheSwaf, 183 ads) the hydration statement took
  176.8 s — past the job's 30 s statement timeout — against 8.5 s fenced.
*/
describe("the receipt-reference laterals are evaluated once per row", () => {
  it.each(["config_refs", "today_refs"])("%s ends in an OFFSET 0 fence", (alias) => {
    const end = HYDRATE_AD_DECISION_INPUTS_QUERY.indexOf(`) ${alias} ON TRUE`);
    expect(end).toBeGreaterThan(0);
    const start = HYDRATE_AD_DECISION_INPUTS_QUERY.lastIndexOf("LEFT JOIN LATERAL (", end);
    const lateral = HYDRATE_AD_DECISION_INPUTS_QUERY.slice(start, end);
    expect(lateral).toMatch(/OFFSET 0\s*$/);
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

/*
  ── ONE EVALUATION DAY PER ACCOUNT, EVEN WHEN ITS STORED TIMEZONE CHANGED ───

  `current_config_scope` derived the account's own as-of day from each ROW's
  timezone label. An account whose stored timezone changed inside the 28-day
  window got one scope row per timezone; `current_config` fanned out with it;
  the final join matched on account+campaign+adset only, duplicated every ad of
  that account, and the whole business hydration threw "Duplicate ad decision
  hydration row". Reproduced read-only on production: Tiles Workshop
  (act_904404985140555, America/Chicago until 2026-07-24, UTC from 07-25) at
  as-of 2026-08-10. `provider_local_as_of_date` in the same query already used
  `account_identity`; the scope now does too.
*/
describe("current-config scope takes the account's timezone once", () => {
  const scope = HYDRATE_AD_DECISION_INPUTS_QUERY.slice(
    HYDRATE_AD_DECISION_INPUTS_QUERY.indexOf("current_config_scope AS ("),
    HYDRATE_AD_DECISION_INPUTS_QUERY.indexOf("current_config AS ("),
  );

  it("joins account_identity for the day boundary", () => {
    expect(scope).toContain("LEFT JOIN account_identity scope_account");
    expect(scope).toContain("COALESCE(scope_account.account_timezone, 'UTC')");
  });

  it("NEGATIVE: never reads the per-row timezone label for the scope", () => {
    const code = scope.replace(/\/\*[\s\S]*?\*\//g, " ");
    expect(code).not.toContain("d.account_timezone");
  });
});
