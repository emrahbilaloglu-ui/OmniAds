import { afterAll, afterEach, describe, expect, it } from "vitest";
import { getDb, resetDbClientCache } from "@/lib/db";
import { ENGINE_VERSION, WarehouseDataSource, type CreativeInput } from "..";

const AS_OF = "2026-05-04";
const THESWAF_BUSINESS_ID = "172d0ab8-495b-4679-a4c6-ffa404c389d3";
const IWASTORE_BUSINESS_ID = "f8a3b5ac-588c-462f-8702-11cd24ff3cd2";
const PRECOMPUTED_TEST_BUSINESS_ID = "00000000-0000-4000-8000-000000000421";
const PRECOMPUTED_LIFECYCLE_CREATIVE_ID = "precomputed-lifecycle-creative-1";

type CreativeLookupRow = Record<string, unknown> & {
  creative_id: unknown;
};

async function findCreativeWithSpend(businessId: string, asOf = AS_OF) {
  const [row] = await getDb().query<CreativeLookupRow>(
    `
    SELECT creative_id
    FROM meta_creative_daily
    WHERE business_ref_id = $1::uuid
      AND date BETWEEN ($2::date - INTERVAL '27 days') AND $2::date
    GROUP BY creative_id
    HAVING SUM(spend) > 0
    ORDER BY SUM(spend) DESC
    LIMIT 1
    `,
    [businessId, asOf],
  );

  return typeof row?.creative_id === "string" ? row.creative_id : null;
}

async function cleanupPrecomputedTestRows() {
  await getDb().query(
    `
    DELETE FROM engine_v3_creative_lifecycle_daily
    WHERE business_ref_id = $1::uuid
    `,
    [PRECOMPUTED_TEST_BUSINESS_ID],
  );
  await getDb().query(
    `
    DELETE FROM engine_v3_account_calibration_daily
    WHERE business_ref_id = $1::uuid
    `,
    [PRECOMPUTED_TEST_BUSINESS_ID],
  );
}

async function cleanupLifecycleRowsForAsOf(input: {
  businessId: string;
  asOf: string;
}) {
  await getDb().query(
    `
    DELETE FROM engine_v3_creative_lifecycle_daily
    WHERE business_ref_id = $1::uuid
      AND as_of_date = $2::date
    `,
    [input.businessId, input.asOf],
  );
}

async function insertPrecomputedCalibration(input?: {
  sourceMaxUpdatedAt?: string;
  engineVersion?: string;
  asOf?: string;
}) {
  await cleanupPrecomputedTestRows();
  const asOf = input?.asOf ?? AS_OF;
  await getDb().query(
    `
    INSERT INTO engine_v3_account_calibration_daily (
      business_ref_id, business_id, scope_type, scope_id, creative_format, as_of_date, engine_version,
      sample_window_start, sample_window_end, sample_window_days,
      eligible_creative_count, mature_creative_count, zero_conversion_count,
      roas_p75, roas_p60, refresh_ratio_p10, low_ctr_p10,
      ctr_p25, ctr_p50, cpm_p50, cpm_p75, thumbstop_p25, thumbstop_p50,
      link_to_lpv_p25, link_to_lpv_p50, link_to_atc_p25, link_to_atc_p50,
      lpv_to_atc_p25, lpv_to_atc_p50, atc_to_ic_p25, atc_to_ic_p50,
      ic_to_purchase_p25, ic_to_purchase_p50, click_to_purchase_p25, click_to_purchase_p50,
      funnel_sample_count, funnel_quality_status,
      source_min_date, source_max_date, source_max_updated_at,
      quality_status, computed_at
    )
    VALUES (
      $1::uuid, $1, 'account', '*', 'overall', $2::date, $3,
      ($2::date - INTERVAL '89 days')::date, $2::date, 90,
      42, 35, 4,
      3.4, 2.6, 0.72, 0.44,
      0.7, 1.2, 12, 18, 15, 25,
      60, 75, 8, 12,
      10, 16, 35, 50,
      20, 30, 0.8, 1.2,
      35, 'ready',
      ($2::date - INTERVAL '89 days')::date, $2::date, $4::timestamptz,
      'ready', now()
    )
    `,
    [
      PRECOMPUTED_TEST_BUSINESS_ID,
      asOf,
      input?.engineVersion ?? ENGINE_VERSION,
      input?.sourceMaxUpdatedAt ?? new Date().toISOString(),
    ],
  );
  await getDb().query(
    `
    INSERT INTO engine_v3_account_calibration_daily (
      business_ref_id, business_id, scope_type, scope_id, creative_format, as_of_date, engine_version,
      sample_window_start, sample_window_end, sample_window_days,
      eligible_creative_count, mature_creative_count, zero_conversion_count,
      roas_p75, roas_p60, refresh_ratio_p10, low_ctr_p10,
      ctr_p25, ctr_p50, cpm_p50, cpm_p75, thumbstop_p25, thumbstop_p50,
      link_to_lpv_p25, link_to_lpv_p50, link_to_atc_p25, link_to_atc_p50,
      lpv_to_atc_p25, lpv_to_atc_p50, atc_to_ic_p25, atc_to_ic_p50,
      ic_to_purchase_p25, ic_to_purchase_p50, click_to_purchase_p25, click_to_purchase_p50,
      funnel_sample_count, funnel_quality_status,
      source_min_date, source_max_date, source_max_updated_at,
      quality_status, computed_at
    )
    VALUES (
      $1::uuid, $1, 'account', '*', 'video', $2::date, $3,
      ($2::date - INTERVAL '89 days')::date, $2::date, 90,
      20, 15, 2,
      3.1, 2.3, 0.68, 0.5,
      0.9, 1.4, 14, 20, 20, 30,
      65, 80, 9, 14,
      11, 18, 38, 55,
      22, 32, 0.9, 1.4,
      15, 'low_sample',
      ($2::date - INTERVAL '89 days')::date, $2::date, $4::timestamptz,
      'low_sample', now()
    )
    `,
    [
      PRECOMPUTED_TEST_BUSINESS_ID,
      asOf,
      input?.engineVersion ?? ENGINE_VERSION,
      input?.sourceMaxUpdatedAt ?? new Date().toISOString(),
    ],
  );
}

async function insertPrecomputedLifecycle(input?: {
  sourceMaxUpdatedAt?: string;
  creativeId?: string;
  engineVersion?: string;
  asOf?: string;
  spend28d?: number;
  cleanup?: boolean;
}) {
  if (input?.cleanup !== false) {
    await cleanupPrecomputedTestRows();
  }
  const asOf = input?.asOf ?? AS_OF;
  await getDb().query(
    `
    INSERT INTO engine_v3_creative_lifecycle_daily (
      business_ref_id, business_id, creative_id, as_of_date, engine_version,
      campaign_id, objective,
      spend_28d, purchases_28d, purchase_value_28d, impressions_28d, link_clicks_28d,
      roas_28d, cpa_28d, ctr_28d, frequency_28d,
      spend_7d, purchases_7d, roas_7d, impressions_7d,
      first_seen_date, last_active_date, active_days_30d, age_days,
      peak_roas_30d, peak_roas_date, days_since_peak, peak_confidence,
      spend_slope_7d, spend_slope_30d, roas_slope_7d, roas_slope_30d,
      spend_trajectory_30d, lifecycle_position,
      fatigue_status, fatigue_confidence, fatigue_evidence,
      cpm_28d, outbound_clicks_28d, landing_page_views_28d, add_to_cart_28d,
      initiate_checkout_28d, thumbstop_28d, video25_rate_28d, video50_rate_28d,
      video75_rate_28d, video100_rate_28d, quality_ranking, engagement_rate_ranking,
      conversion_rate_ranking, creative_format,
      outbound_click_rate_28d, link_to_lpv_rate_28d, link_to_atc_rate_28d,
      lpv_to_atc_rate_28d, atc_to_ic_rate_28d, ic_to_purchase_rate_28d,
      atc_to_purchase_rate_28d, click_to_purchase_rate_28d,
      funnel_primary_weak_stage, funnel_confidence, funnel_evidence,
      creative_responsibility_score, site_responsibility_score,
      checkout_responsibility_score, tracking_anomaly_score,
      effective_status, source_max_date, source_max_updated_at,
      eligible_for_lifecycle, computed_at
    )
    VALUES (
      $1::uuid, $1, $2, $3::date, $4,
      'campaign-precomputed-1', 'OUTCOME_SALES',
      $6, 6, 963, 12345, 456,
      2.995334370139969, 53.583333333333336, 1.23, 1.8,
      88.25, 2, 2.7, 2345,
      ($3::date - INTERVAL '32 days')::date, $3::date, 18, 32,
      3.4, ($3::date - INTERVAL '4 days')::date, 4, 0.71,
      1.2, 0.4, -0.02, -0.01,
      'flat', 'plateau',
      'watch', 0.66, '{"evidence":["test"],"missingContext":[],"decays":{"ctr":0.1,"roas":0.2,"c2p":0.3}}'::jsonb,
      10.5, 300, 260, 40,
      20, 24, 18, 10,
      6, 3, 'average', 'average',
      'average', 'video',
      2.43, 57.02, 8.77,
      15.38, 50, 30,
      15, 1.32,
      'none', 1, '["funnel healthy"]'::jsonb,
      0, 0, 0, 0,
      'ACTIVE', $3::date, $5::timestamptz,
      true, now()
    )
    `,
    [
      PRECOMPUTED_TEST_BUSINESS_ID,
      input?.creativeId ?? PRECOMPUTED_LIFECYCLE_CREATIVE_ID,
      asOf,
      input?.engineVersion ?? ENGINE_VERSION,
      input?.sourceMaxUpdatedAt ?? new Date().toISOString(),
      input?.spend28d ?? 321.5,
    ],
  );
}

function expectNoUndefinedFields(input: CreativeInput) {
  const keys: Array<keyof CreativeInput> = [
    "creativeId",
    "creativeName",
    "businessId",
    "campaignId",
    "objective",
    "spend",
    "purchases",
    "purchaseValue",
    "impressions",
    "linkClicks",
    "roas",
    "cpa",
    "ctr",
    "frequency",
    "recent7dSpend",
    "recent7dPurchases",
    "recent7dRoas",
    "recent7dImpressions",
    "effectiveStatus",
    "ageDays",
    "lastSpendAt",
    "policyReason",
    "dataFreshnessHours",
    "fatigueStatus",
    "targetRoas",
    "breakevenRoas",
    "lifecyclePosition",
    "daysSincePeak",
    "peakRoas30d",
    "peakConfidence",
    "spendTrajectory30d",
    "spendSlope7d",
    "spendSlope30d",
    "roasSlope7d",
    "roasSlope30d",
    "cpm",
    "outboundClicks",
    "landingPageViews",
    "addToCart",
    "initiateCheckout",
    "thumbstop",
    "video25Rate",
    "video50Rate",
    "video75Rate",
    "video100Rate",
    "qualityRanking",
    "engagementRateRanking",
    "conversionRateRanking",
    "creativeFormat",
  ];

  for (const key of keys) {
    expect(input[key], `${key} should not be undefined`).not.toBeUndefined();
  }
}

describe.skipIf(!process.env.DATABASE_URL)(
  "WarehouseDataSource integration",
  () => {
    const warehouse = new WarehouseDataSource();

    afterAll(() => {
      resetDbClientCache();
    });

    afterEach(async () => {
      await cleanupPrecomputedTestRows();
    });

    it("hydrates a known TheSwaf creative from warehouse rows", async () => {
      const creativeId = await findCreativeWithSpend(THESWAF_BUSINESS_ID);
      expect(creativeId).not.toBeNull();

      const input = await warehouse.getCreativeInput({
        creativeId: creativeId ?? "",
        businessId: THESWAF_BUSINESS_ID,
        asOf: AS_OF,
      });

      expect(input).not.toBeNull();
      expect(input?.creativeId).toBe(creativeId);
      expect(input?.creativeName).not.toBeNull();
      expect(input?.businessId).toBe(THESWAF_BUSINESS_ID);
      expect(input?.spend).toBeGreaterThan(0);
      expectNoUndefinedFields(input!);
    });

    it("returns null for a non-existent creative_id", async () => {
      const input = await warehouse.getCreativeInput({
        creativeId: "creative-does-not-exist-phase-2-1",
        businessId: THESWAF_BUSINESS_ID,
        asOf: AS_OF,
      });

      expect(input).toBeNull();
    });

    it("lists IwaStore active and recently-active creatives", async () => {
      const inputs = await warehouse.listCreativeInputs({
        businessId: IWASTORE_BUSINESS_ID,
        asOf: AS_OF,
      });

      expect(inputs.length).toBeGreaterThanOrEqual(10);
      expect(inputs.every((input) => input.businessId === IWASTORE_BUSINESS_ID))
        .toBe(true);
    });

    it("reads a creative input from the lifecycle table when a fresh row exists", async () => {
      await insertPrecomputedLifecycle();
      const precomputedWarehouse = new WarehouseDataSource();

      const input = await precomputedWarehouse.getCreativeInput({
        creativeId: PRECOMPUTED_LIFECYCLE_CREATIVE_ID,
        businessId: PRECOMPUTED_TEST_BUSINESS_ID,
        asOf: AS_OF,
      });

      expect(input).toMatchObject({
        creativeId: PRECOMPUTED_LIFECYCLE_CREATIVE_ID,
        businessId: PRECOMPUTED_TEST_BUSINESS_ID,
        campaignId: "campaign-precomputed-1",
        objective: "OUTCOME_SALES",
        spend: 321.5,
        purchases: 6,
        roas: 2.995334370139969,
        recent7dSpend: 88.25,
        recent7dPurchases: 2,
        recent7dRoas: 2.7,
        effectiveStatus: "ACTIVE",
        fatigueStatus: "watch",
        lifecyclePosition: "plateau",
        daysSincePeak: 4,
        peakRoas30d: 3.4,
        peakConfidence: 0.71,
        spendTrajectory30d: "flat",
        spendSlope7d: 1.2,
        spendSlope30d: 0.4,
        roasSlope7d: -0.02,
        roasSlope30d: -0.01,
        cpm: 10.5,
        outboundClicks: 300,
        landingPageViews: 260,
        addToCart: 40,
        initiateCheckout: 20,
        thumbstop: 24,
        video25Rate: 18,
        creativeFormat: "video",
      });
      expectNoUndefinedFields(input!);
    });

    it("falls back to runtime SQL when a lifecycle row is missing", async () => {
      const fallbackAsOf = "2026-05-03";
      await cleanupLifecycleRowsForAsOf({
        businessId: THESWAF_BUSINESS_ID,
        asOf: fallbackAsOf,
      });
      const creativeId = await findCreativeWithSpend(
        THESWAF_BUSINESS_ID,
        fallbackAsOf,
      );
      expect(creativeId).not.toBeNull();

      const input = await warehouse.getCreativeInput({
        creativeId: creativeId ?? "",
        businessId: THESWAF_BUSINESS_ID,
        asOf: fallbackAsOf,
      });

      expect(input).not.toBeNull();
      expect(input?.creativeId).toBe(creativeId);
      expect(input?.spend).toBeGreaterThan(0);
      expect(input).toMatchObject({
        lifecyclePosition: null,
        daysSincePeak: null,
        peakRoas30d: null,
        peakConfidence: null,
        spendTrajectory30d: null,
        spendSlope7d: null,
        spendSlope30d: null,
        roasSlope7d: null,
        roasSlope30d: null,
      });
    });

    it("lists creative inputs from the lifecycle table when rows exist", async () => {
      await insertPrecomputedLifecycle();
      const precomputedWarehouse = new WarehouseDataSource();

      const inputs = await precomputedWarehouse.listCreativeInputs({
        businessId: PRECOMPUTED_TEST_BUSINESS_ID,
        asOf: AS_OF,
      });

      expect(inputs.length).toBeGreaterThanOrEqual(1);
      expect(inputs[0]?.creativeId).toBe(PRECOMPUTED_LIFECYCLE_CREATIVE_ID);
      expect(inputs[0]?.spend).toBe(321.5);
    });

    it("computes IwaStore account calibration with sample-size gating", async () => {
      const calibration = await warehouse.getAccountCalibration({
        businessId: IWASTORE_BUSINESS_ID,
        asOf: AS_OF,
      });

      expect(calibration.businessId).toBe(IWASTORE_BUSINESS_ID);
      expect(calibration.matureCreativeCount).toBeGreaterThanOrEqual(0);
      expect(calibration.roasP75 === null).toBe(
        calibration.matureCreativeCount < 30,
      );
      expect(calibration.roasP60 === null).toBe(
        calibration.matureCreativeCount < 10,
      );
    });

    it("computes TheSwaf account calibration with sample-size gating", async () => {
      const calibration = await warehouse.getAccountCalibration({
        businessId: THESWAF_BUSINESS_ID,
        asOf: AS_OF,
      });

      expect(calibration.businessId).toBe(THESWAF_BUSINESS_ID);
      expect(calibration.matureCreativeCount).toBeGreaterThanOrEqual(0);
      expect(calibration.roasP75 === null).toBe(
        calibration.matureCreativeCount < 30,
      );
      expect(calibration.roasP60 === null).toBe(
        calibration.matureCreativeCount < 10,
      );
    });

    it("reads account calibration from the precomputed table when fresh", async () => {
      await insertPrecomputedCalibration();
      const precomputedWarehouse = new WarehouseDataSource();

      const calibration = await precomputedWarehouse.getAccountCalibration({
        businessId: PRECOMPUTED_TEST_BUSINESS_ID,
        asOf: AS_OF,
      });
      const health = await precomputedWarehouse.getDataHealth({
        businessId: PRECOMPUTED_TEST_BUSINESS_ID,
        asOf: AS_OF,
      });

      expect(calibration).toMatchObject({
        businessId: PRECOMPUTED_TEST_BUSINESS_ID,
        matureCreativeCount: 35,
        roasP75: 3.4,
        roasP60: 2.6,
        refreshRatioP10: 0.72,
        lowCtrP10: 0.44,
      });
      expect(health.calibration.fallbackMode).toBe("precomputed");
      expect(health.calibration.note).toBe(
        `computed by engine ${ENGINE_VERSION}`,
      );
    });

    it("reads account funnel calibration by format from the precomputed table", async () => {
      await insertPrecomputedCalibration();
      const precomputedWarehouse = new WarehouseDataSource();

      const calibration = await precomputedWarehouse.getAccountFunnelCalibration({
        businessId: PRECOMPUTED_TEST_BUSINESS_ID,
        asOf: AS_OF,
      });

      expect(Object.keys(calibration.byFormat).sort()).toEqual([
        "overall",
        "video",
      ]);
      expect(calibration.byFormat.overall).toMatchObject({
        ctrP25: 0.7,
        linkToLpvP50: 75,
        sampleSize: 35,
        qualityStatus: "ready",
      });
      expect(calibration.byFormat.video).toMatchObject({
        creativeFormat: "video",
        thumbstopP50: 30,
        qualityStatus: "low_sample",
      });
    });

    it("reads account calibration across engine version bumps", async () => {
      await insertPrecomputedCalibration({
        engineVersion: "v3-2026-05-04-phase-3.5",
      });
      const precomputedWarehouse = new WarehouseDataSource();

      const calibration = await precomputedWarehouse.getAccountCalibration({
        businessId: PRECOMPUTED_TEST_BUSINESS_ID,
        asOf: AS_OF,
      });
      const health = await precomputedWarehouse.getDataHealth({
        businessId: PRECOMPUTED_TEST_BUSINESS_ID,
        asOf: AS_OF,
      });

      expect(calibration.matureCreativeCount).toBe(35);
      expect(health.calibration.fallbackMode).toBe("precomputed");
      expect(health.calibration.note).toBe(
        "computed by engine v3-2026-05-04-phase-3.5",
      );
    });

    it("reports lifecycle health as precomputed when lifecycle rows exist", async () => {
      await insertPrecomputedLifecycle();
      const precomputedWarehouse = new WarehouseDataSource();

      const health = await precomputedWarehouse.getDataHealth({
        businessId: PRECOMPUTED_TEST_BUSINESS_ID,
        asOf: AS_OF,
      });

      expect(health.lifecycle.fallbackMode).toBe("precomputed");
      expect(health.lifecycle.note).toBeNull();
      expect(health.lifecycle.staleTier).toBe("none");
    });

    it("reads lifecycle rows from the latest available as-of date", async () => {
      await insertPrecomputedLifecycle({
        asOf: "2026-05-03",
        engineVersion: "v3-2026-05-04-phase-3.5",
      });
      const precomputedWarehouse = new WarehouseDataSource();

      const input = await precomputedWarehouse.getCreativeInput({
        creativeId: PRECOMPUTED_LIFECYCLE_CREATIVE_ID,
        businessId: PRECOMPUTED_TEST_BUSINESS_ID,
        asOf: AS_OF,
      });

      expect(input?.creativeId).toBe(PRECOMPUTED_LIFECYCLE_CREATIVE_ID);
      expect(input?.spend).toBe(321.5);
    });

    it("uses the latest lifecycle row on or before asOf for bulk hydration", async () => {
      await insertPrecomputedLifecycle({
        asOf: "2026-05-03",
        spend28d: 111,
      });
      await insertPrecomputedLifecycle({
        asOf: AS_OF,
        spend28d: 444,
        cleanup: false,
      });
      const precomputedWarehouse = new WarehouseDataSource();

      const inputs = await precomputedWarehouse.listCreativeInputs({
        businessId: PRECOMPUTED_TEST_BUSINESS_ID,
        asOf: AS_OF,
      });

      expect(inputs[0]?.creativeId).toBe(PRECOMPUTED_LIFECYCLE_CREATIVE_ID);
      expect(inputs[0]?.spend).toBe(444);
    });

    it("falls back when no precomputed calibration row exists", async () => {
      const fallbackWarehouse = new WarehouseDataSource();

      const calibration = await fallbackWarehouse.getAccountCalibration({
        businessId: PRECOMPUTED_TEST_BUSINESS_ID,
        asOf: AS_OF,
      });
      const health = await fallbackWarehouse.getDataHealth({
        businessId: PRECOMPUTED_TEST_BUSINESS_ID,
        asOf: AS_OF,
      });

      expect(calibration).toMatchObject({
        businessId: PRECOMPUTED_TEST_BUSINESS_ID,
        matureCreativeCount: 0,
        roasP75: null,
        roasP60: null,
      });
      expect(health.calibration.fallbackMode).toBe("insufficient");
      expect(health.calibration.staleTier).toBe("warning");
      expect(health.calibration.note).toBe(
        "no precomputed row available; runtime fallback in use",
      );
    });

    it("reports warehouse lifecycle health as warning when no precomputed row exists", async () => {
      const fallbackWarehouse = new WarehouseDataSource();

      const health = await fallbackWarehouse.getDataHealth({
        businessId: PRECOMPUTED_TEST_BUSINESS_ID,
        asOf: AS_OF,
      });

      expect(health.lifecycle.fallbackMode).toBe("runtime_sql");
      expect(health.lifecycle.staleTier).toBe("warning");
      expect(health.lifecycle.note).toBe(
        "no precomputed row available; runtime fallback in use",
      );
    });

    it("returns data health with calibration, lifecycle, and decision layer paths", async () => {
      const health = await warehouse.getDataHealth({
        businessId: IWASTORE_BUSINESS_ID,
        asOf: AS_OF,
      });

      expect(health.calibration.sourceFreshnessHours).not.toBeNull();
      expect(health.lifecycle.sourceFreshnessHours).not.toBeNull();
      expect(health.decisions.sourceFreshnessHours).not.toBeNull();
      expect(["precomputed", "runtime_sql", "insufficient"]).toContain(
        health.calibration.fallbackMode,
      );
      expect(["precomputed", "runtime_sql"]).toContain(
        health.lifecycle.fallbackMode,
      );
      expect(health.decisions.note).toContain("Decision snapshots");
      expect(["none", "warning", "disabled"]).toContain(health.worstTier);
    });
  },
);
