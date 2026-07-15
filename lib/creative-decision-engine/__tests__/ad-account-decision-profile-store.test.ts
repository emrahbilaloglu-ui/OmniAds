import { describe, expect, it, vi } from "vitest";

import type { DbClient } from "@/lib/db";
import {
  READ_NATIVE_AD_CALIBRATION_ROW_ID_SQL,
  WarehouseNativeAdAccountProfileDataSource,
  inspectNativeAdProfileSchemaCapability,
} from "../ad-account-decision-profile-store";
import {
  READ_NATIVE_AD_ACCOUNT_CALIBRATION_CELL_SQL,
  resolveNativeAdAccountDecisionProfile,
} from "../ad-account-decision-profile";
import {
  NATIVE_AD_CALIBRATION_POLICY_VERSION,
  NATIVE_AD_CALIBRATION_TABLE,
  READ_NATIVE_AD_TARGET_AUTHORITY_FOR_ACCOUNT_SQL,
  buildNativeAdOptimizationContext,
  resolveNativeAdCalibrationCutoff,
  resolveNativeAdCalibrationActionReadiness,
  resolveNativeAdTargetAuthority,
  type NativeAdTargetAuthorityInput,
} from "../jobs/ad-calibration-job";
import { NATIVE_AD_ENGINE_VERSION } from "../types";
import { makeAccountDecisionProfile } from "./helpers";

const BUSINESS_ID = "00000000-0000-4000-8000-000000000751";
const PROVIDER_ACCOUNT_REF_ID = "00000000-0000-4000-8000-000000000750";
const CALIBRATION_ROW_ID = "00000000-0000-4000-8000-000000000752";
const AS_OF = "2026-07-12";
const CUTOFF = "2026-07-12T03:05:00.000Z";
const TARGET: NativeAdTargetAuthorityInput = {
  sourceRowId: "00000000-0000-4000-8000-000000000753",
  operation: "upsert",
  targetCpa: 50,
  targetRoas: 2,
  breakEvenCpa: 70,
  breakEvenRoas: 1.5,
  operatorAovAssumption: 100,
  defaultRiskPosture: "balanced",
  effectiveAt: "2026-07-01T00:00:00.000Z",
  recordedAt: "2026-07-01T00:00:01.000Z",
};

function nativeCellRow(
  targetInput: NativeAdTargetAuthorityInput = TARGET,
): Record<string, unknown> {
  const profile = makeAccountDecisionProfile({
    businessId: BUSINESS_ID,
    asOfDate: AS_OF,
  });
  const cutoff = resolveNativeAdCalibrationCutoff(AS_OF, CUTOFF);
  const target = resolveNativeAdTargetAuthority(
    targetInput,
    cutoff.asOfCutoff,
  );
  const metricCounts = Object.fromEntries(
    [
      "roas",
      "roasRatio",
      "cpa",
      "winner",
      "refreshRatio",
      "lowCtr",
      "ctr",
      "cpm",
      "thumbstop",
      "linkToLpv",
      "linkToAtc",
      "lpvToAtc",
      "atcToIc",
      "icToPurchase",
      "clickToPurchase",
    ].map((key) => [key, 30]),
  );
  return {
    business_id: BUSINESS_ID,
    provider: "meta",
    provider_account_ref_id: PROVIDER_ACCOUNT_REF_ID,
    provider_account_id: "act-native",
    account_timezone: "Europe/Istanbul",
    account_currency: "USD",
    cell_scope: "objective_cohort_context",
    objective: "OUTCOME_SALES",
    funnel_cohort: "purchase",
    optimization_context: buildNativeAdOptimizationContext(
      "PURCHASE",
      "PURCHASE",
    ),
    as_of_date: AS_OF,
    as_of_cutoff: cutoff.asOfCutoff,
    engine_version: NATIVE_AD_ENGINE_VERSION,
    policy_version: NATIVE_AD_CALIBRATION_POLICY_VERSION,
    sample_window_start: cutoff.sampleWindowStart,
    sample_window_end: cutoff.sampleWindowEnd,
    sample_window_days: 90,
    source_ad_count: 30,
    source_day_count: 30,
    eligible_ad_count: 30,
    mature_ad_count: 30,
    zero_conversion_ad_count: 0,
    roas_p75: profile.accountBaselines.roasP75,
    roas_p60: profile.accountBaselines.roasP60,
    refresh_ratio_p10: profile.accountBaselines.refreshRatioP10,
    low_ctr_p10: profile.accountBaselines.lowCtrP10,
    account_cpa_p50: profile.accountBaselines.accountCpaP50,
    account_cpa_sample_count: profile.accountBaselines.accountCpaSampleCount,
    meta_attributed_aov_mean_90d:
      profile.accountBaselines.metaAttributedAovMean90d,
    meta_attributed_aov_purchase_count_90d:
      profile.accountBaselines.metaAttributedAovPurchaseCount90d,
    meta_attributed_revenue_90d:
      profile.accountBaselines.metaAttributedRevenue90d,
    meta_aov_quality: profile.accountBaselines.metaAovQuality,
    mature_spend_p50: profile.accountBaselines.matureSpendP50,
    mature_spend_p75: profile.accountBaselines.matureSpendP75,
    winner_spend_p25: profile.accountBaselines.winnerSpendP25,
    winner_spend_p50: profile.accountBaselines.winnerSpendP50,
    winner_purchase_p50: profile.accountBaselines.winnerPurchaseP50,
    roas_ratio_p10: profile.accountBaselines.roasRatioP10,
    roas_ratio_p25: profile.accountBaselines.roasRatioP25,
    roas_ratio_p50: profile.accountBaselines.roasRatioP50,
    roas_ratio_p75: profile.accountBaselines.roasRatioP75,
    funnel_calibration_json: profile.funnelCalibration,
    metric_sample_counts_json: metricCounts,
    action_readiness_json: {
      scale: {
        ready: true,
        reason: null,
        observedSampleCount: 30,
        requiredSampleCount: 30,
      },
      cut: {
        ready: true,
        reason: null,
        observedSampleCount: 30,
        requiredSampleCount: 20,
      },
      refresh: {
        ready: true,
        reason: null,
        observedSampleCount: 30,
        requiredSampleCount: 20,
      },
    },
    quality_counts_json: {
      candidateSourceRowCount: 30,
      cutoffSafeSourceRowCount: 30,
      candidateAdCount: 30,
      eligibleAdObservationCount: 30,
      identitySourceRowExclusionCount: 0,
      duplicateSourceRowExclusionCount: 0,
      duplicateConflictAdExclusionCount: 0,
      missingContextAdExclusionCount: 0,
      mixedContextAdExclusionCount: 0,
      mixedCurrencyAdExclusionCount: 0,
      mixedObjectiveAdExclusionCount: 0,
      mixedCohortAdExclusionCount: 0,
      censoredSourceRowExclusionCount: 0,
      censoredAdExclusionCount: 0,
      freshnessSourceRowExclusionCount: 0,
      freshnessAdExclusionCount: 0,
      commercialAuthorityAdExclusionCount: 0,
    },
    quality_status: "ready",
    target_authority_status: target.status,
    target_roas: target.targetRoas,
    break_even_roas: target.breakEvenRoas,
    target_effective_at: target.effectiveAt,
    target_recorded_at: target.recordedAt,
    target_authority_hash: target.authorityHash,
    source_min_date: cutoff.sampleWindowStart,
    source_max_date: cutoff.sampleWindowEnd,
    source_max_updated_at: `${AS_OF}T02:00:00.000Z`,
    batch_input_manifest_hash: "1".repeat(64),
    input_manifest_hash: "2".repeat(64),
    source_manifest_hash: "3".repeat(64),
    computed_at: CUTOFF,
    batch_id: "00000000-0000-4000-8000-000000000754",
    batch_completeness: "complete",
    batch_cell_count: 1,
    batch_cell_set_hash: "4".repeat(64),
  };
}

function fakeDb(
  handler: (query: string, params?: unknown[]) => Record<string, unknown>[],
): DbClient {
  const query = vi.fn(async (sql: string, params?: unknown[]) =>
    handler(sql, params),
  );
  return Object.assign(vi.fn(), { query }) as unknown as DbClient;
}

function readNativeCell(row: Record<string, unknown>) {
  const store = new WarehouseNativeAdAccountProfileDataSource(
    fakeDb((query) =>
      query.includes("native-ad-profile-cell") ? [row] : [],
    ),
  );
  return store.getNativeAdCalibrationCell({
    businessId: BUSINESS_ID,
    providerAccountId: "act-native",
    accountTimezone: "Europe/Istanbul",
    accountCurrency: "USD",
    cellScope: "objective_cohort_context",
    objective: "OUTCOME_SALES",
    cohort: "purchase",
    optimizationContext: String(row["optimization_context"]),
    asOfDate: AS_OF,
    engineVersion: NATIVE_AD_ENGINE_VERSION,
    policyVersion: NATIVE_AD_CALIBRATION_POLICY_VERSION,
  });
}

describe("WarehouseNativeAdAccountProfileDataSource", () => {
  it("round-trips one native epoch cell and resolves its exact native row id", async () => {
    const row = nativeCellRow();
    const db = fakeDb((query) => {
      if (query.includes("native-ad-profile-cell")) return [row];
      if (query.includes(`FROM ${NATIVE_AD_CALIBRATION_TABLE}`)) {
        return [{ id: CALIBRATION_ROW_ID }];
      }
      throw new Error(`Unexpected SQL: ${query}`);
    });
    const store = new WarehouseNativeAdAccountProfileDataSource(db);
    const cell = await store.getNativeAdCalibrationCell({
      businessId: BUSINESS_ID,
      providerAccountId: "act-native",
      accountTimezone: "Europe/Istanbul",
      accountCurrency: "USD",
      cellScope: "objective_cohort_context",
      objective: "OUTCOME_SALES",
      cohort: "purchase",
      optimizationContext: String(row["optimization_context"]),
      asOfDate: AS_OF,
      engineVersion: NATIVE_AD_ENGINE_VERSION,
      policyVersion: NATIVE_AD_CALIBRATION_POLICY_VERSION,
    });

    expect(cell).toMatchObject({
      key: {
        businessId: BUSINESS_ID,
        providerAccountRefId: PROVIDER_ACCOUNT_REF_ID,
        providerAccountId: "act-native",
        accountCurrency: "USD",
        objective: "OUTCOME_SALES",
        cohort: "purchase",
      },
      engineVersion: NATIVE_AD_ENGINE_VERSION,
      qualityStatus: "ready",
      targetAuthority: {
        status: "fresh",
        targetRoasAuthority: true,
        breakEvenRoasAuthority: true,
      },
    });
    await expect(store.getNativeCalibrationRowId(cell!)).resolves.toBe(
      CALIBRATION_ROW_ID,
    );
    expect(READ_NATIVE_AD_ACCOUNT_CALIBRATION_CELL_SQL).not.toContain(
      "engine_v3_account_calibration_daily",
    );
    expect(READ_NATIVE_AD_ACCOUNT_CALIBRATION_CELL_SQL).toContain(
      "batch.completeness_status = 'complete'",
    );
    expect(READ_NATIVE_AD_ACCOUNT_CALIBRATION_CELL_SQL).toContain(
      "binding.provider_account_ref_id = batch.provider_account_ref_id",
    );
    expect(READ_NATIVE_AD_CALIBRATION_ROW_ID_SQL).not.toContain(
      "engine_v3_account_calibration_daily",
    );
    expect(READ_NATIVE_AD_ACCOUNT_CALIBRATION_CELL_SQL).toContain(
      "batch.completeness_status = 'complete'",
    );
    expect(READ_NATIVE_AD_ACCOUNT_CALIBRATION_CELL_SQL).toContain(
      "FROM business_provider_accounts binding",
    );
    expect(READ_NATIVE_AD_CALIBRATION_ROW_ID_SQL).toContain(
      "JOIN provider_accounts account",
    );
    expect(READ_NATIVE_AD_CALIBRATION_ROW_ID_SQL).toContain(
      "batch.id = calibration.batch_id",
    );
    expect(READ_NATIVE_AD_CALIBRATION_ROW_ID_SQL).toContain(
      "calibration.business_id = $1::text",
    );
  });

  it("keeps an old cutoff-safe target authoritative when hydrating a persisted native cell", async () => {
    const oldTarget: NativeAdTargetAuthorityInput = {
      ...TARGET,
      effectiveAt: "2026-05-01T00:00:00.000Z",
      recordedAt: "2026-05-01T00:00:01.000Z",
    };
    const row = nativeCellRow(oldTarget);
    const db = fakeDb((query) => {
      if (query.includes("native-ad-profile-cell")) return [row];
      if (query === READ_NATIVE_AD_TARGET_AUTHORITY_FOR_ACCOUNT_SQL) {
        return [
          {
            source_row_id: oldTarget.sourceRowId,
            operation: oldTarget.operation,
            target_cpa: oldTarget.targetCpa,
            target_roas: oldTarget.targetRoas,
            break_even_cpa: oldTarget.breakEvenCpa,
            break_even_roas: oldTarget.breakEvenRoas,
            operator_aov_assumption: oldTarget.operatorAovAssumption,
            default_risk_posture: oldTarget.defaultRiskPosture,
            effective_at: oldTarget.effectiveAt,
            recorded_at: oldTarget.recordedAt,
          },
        ];
      }
      return [];
    });
    const store = new WarehouseNativeAdAccountProfileDataSource(db);
    const cell = await store.getNativeAdCalibrationCell({
      businessId: BUSINESS_ID,
      providerAccountId: "act-native",
      accountTimezone: "Europe/Istanbul",
      accountCurrency: "USD",
      cellScope: "objective_cohort_context",
      objective: "OUTCOME_SALES",
      cohort: "purchase",
      optimizationContext: String(row["optimization_context"]),
      asOfDate: AS_OF,
      engineVersion: NATIVE_AD_ENGINE_VERSION,
      policyVersion: NATIVE_AD_CALIBRATION_POLICY_VERSION,
    });

    expect(cell?.targetAuthority).toMatchObject({
      status: "stale",
      targetRoasAuthority: true,
      breakEvenRoasAuthority: true,
    });
    expect(
      resolveNativeAdCalibrationActionReadiness({
        key: cell!.key,
        matureAdCount: cell!.matureAdCount,
        metricSampleCounts: cell!.metricSampleCounts,
        targetAuthority: cell!.targetAuthority,
        accountCalibration: cell!.accountCalibration,
      }),
    ).toEqual(cell!.actionReadiness);

    await expect(
      resolveNativeAdAccountDecisionProfile({
        businessId: BUSINESS_ID,
        providerAccountId: "act-native",
        accountTimezone: "Europe/Istanbul",
        accountCurrency: "USD",
        objective: "OUTCOME_SALES",
        optimizationGoal: "PURCHASE",
        customEventType: "PURCHASE",
        cohort: "purchase",
        asOf: AS_OF,
        dataSource: store,
        flags: {
          businessId: BUSINESS_ID,
          enabled: true,
          surfaceVisible: false,
          shadowOnly: false,
          presetOverride: null,
          source: {
            enabled: "env",
            surfaceVisible: "env",
            shadowOnly: "env",
            presetOverride: null,
          },
          envDefaults: {
            enabled: true,
            surfaceVisible: false,
            shadowOnly: false,
          },
        },
      }),
    ).resolves.toMatchObject({
      status: "ready",
      reason: null,
      selectedCell: {
        targetAuthority: {
          status: "stale",
          targetRoasAuthority: true,
          breakEvenRoasAuthority: true,
        },
      },
    });
  });

  it("keeps missing and cutoff-unsafe persisted targets fail-closed", async () => {
    const cases: NativeAdTargetAuthorityInput[] = [
      { ...TARGET, operation: "delete" },
      {
        ...TARGET,
        effectiveAt: "2026-08-01T00:00:00.000Z",
        recordedAt: "2026-08-01T00:00:01.000Z",
      },
    ];

    for (const targetInput of cases) {
      const cell = await readNativeCell(nativeCellRow(targetInput));
      expect(cell?.targetAuthority).toMatchObject({
        targetRoasAuthority: false,
        breakEvenRoasAuthority: false,
      });
    }
  });

  it("keeps persisted target authority action-specific", async () => {
    const cell = await readNativeCell(
      nativeCellRow({
        ...TARGET,
        targetRoas: null,
      }),
    );

    expect(cell?.targetAuthority).toMatchObject({
      status: "fresh",
      targetRoasAuthority: false,
      breakEvenRoasAuthority: true,
    });
  });

  it("maps bitemporal native target authority without a current-state fallback", async () => {
    const db = fakeDb((query) => {
      if (query === READ_NATIVE_AD_TARGET_AUTHORITY_FOR_ACCOUNT_SQL) {
        return [
          {
            source_row_id: TARGET.sourceRowId,
            operation: TARGET.operation,
            target_cpa: TARGET.targetCpa,
            target_roas: TARGET.targetRoas,
            break_even_cpa: TARGET.breakEvenCpa,
            break_even_roas: TARGET.breakEvenRoas,
            operator_aov_assumption: TARGET.operatorAovAssumption,
            default_risk_posture: TARGET.defaultRiskPosture,
            effective_at: TARGET.effectiveAt,
            recorded_at: TARGET.recordedAt,
          },
        ];
      }
      throw new Error(`Unexpected SQL: ${query}`);
    });

    await expect(
      new WarehouseNativeAdAccountProfileDataSource(
        db,
      ).getNativeTargetAuthorityAsOf({
        businessId: BUSINESS_ID,
        providerAccountRefId: PROVIDER_ACCOUNT_REF_ID,
        providerAccountId: "act-native",
        asOfCutoff: CUTOFF,
      }),
    ).resolves.toEqual(TARGET);
    expect(READ_NATIVE_AD_TARGET_AUTHORITY_FOR_ACCOUNT_SQL).toContain(
      "binding.provider_account_ref_id = $2::uuid",
    );
    expect(READ_NATIVE_AD_TARGET_AUTHORITY_FOR_ACCOUNT_SQL).toContain(
      "history.recorded_at <= $4::timestamptz",
    );
  });

  it("rejects string-coerced or negative persisted sample counts before profile authority", async () => {
    const row = nativeCellRow();
    const metricCounts = row["metric_sample_counts_json"] as Record<
      string,
      unknown
    >;
    const db = fakeDb((query) =>
      query.includes("native-ad-profile-cell")
        ? [
            {
              ...row,
              metric_sample_counts_json: { ...metricCounts, roas: "30" },
            },
          ]
        : [],
    );
    const store = new WarehouseNativeAdAccountProfileDataSource(db);

    await expect(
      store.getNativeAdCalibrationCell({
        businessId: BUSINESS_ID,
        providerAccountId: "act-native",
        accountTimezone: "Europe/Istanbul",
        accountCurrency: "USD",
        cellScope: "objective_cohort_context",
        objective: "OUTCOME_SALES",
        cohort: "purchase",
        optimizationContext: "goal=PURCHASE|event=PURCHASE",
        asOfDate: AS_OF,
        engineVersion: NATIVE_AD_ENGINE_VERSION,
        policyVersion: NATIVE_AD_CALIBRATION_POLICY_VERSION,
      }),
    ).rejects.toThrow(/metric_sample_counts_json.roas must be an integer/);
  });
});

describe("native ad profile schema gate", () => {
  it("fails closed when the exact native schema contract is absent", async () => {
    const missingDb = fakeDb(() => []);

    await expect(
      inspectNativeAdProfileSchemaCapability(missingDb),
    ).resolves.toMatchObject({ ready: false });
  });
});
