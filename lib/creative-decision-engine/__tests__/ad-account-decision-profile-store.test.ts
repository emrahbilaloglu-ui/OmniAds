import { describe, expect, it, vi } from "vitest";
import { NATIVE_AD_CALIBRATION_CONTRACT_VERSION } from "../jobs/ad-calibration-job";

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
  buildNativeAdCalibrationPersistencePayload,
  NATIVE_AD_CALIBRATION_POLICY_VERSION,
  NATIVE_AD_CALIBRATION_TABLE,
  READ_NATIVE_AD_TARGET_AUTHORITY_FOR_ACCOUNT_SQL,
  NATIVE_AD_SPEND_UNIT_AUTHORITY_CONTRACT_VERSION,
  buildNativeAdOptimizationContext,
  computeNativeAdCalibrationBatch,
  recomputeNativeAdCalibrationCellInputManifestHash,
  resolveNativeAdCalibrationCutoff,
  resolveNativeAdCalibrationActionReadiness,
  resolveNativeAdTargetAuthority,
  recomputeNativeAdSpendUnitAuthorityHash,
  type NativeAdCalibrationCell,
  type NativeAdCalibrationMetricSampleCounts,
  type NativeAdCalibrationSourceRow,
  type NativeAdSpendUnitAuthority,
  type NativeAdTargetAuthorityInput,
} from "../jobs/ad-calibration-job";
import { NATIVE_AD_ENGINE_VERSION } from "../types";
import { makeAccountDecisionProfile } from "./helpers";

const BUSINESS_ID = "00000000-0000-4000-8000-000000000751";
const PROVIDER_ACCOUNT_REF_ID = "00000000-0000-4000-8000-000000000750";
const CALIBRATION_ROW_ID = "00000000-0000-4000-8000-000000000752";
const AS_OF = "2026-07-12";
const CUTOFF = "2026-07-12T03:05:00.000Z";
const JOB_RUN_ID = "00000000-0000-4000-8000-000000000755";
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
const AOV_ONLY_TARGET: NativeAdTargetAuthorityInput = {
  ...TARGET,
  targetCpa: null,
  operatorAovAssumption: null,
};

/*
  RE-PINNED for the reordered spend-unit ladder.

  This helper used to mint `basis: "target_cpa"` over an `unavailable` account
  AOV evidence. The target pack it is built against carries a Target ROAS as
  well as a legacy Target CPA, and with a Target ROAS the only lane
  `buildNativeAdSpendUnitAuthority` has is Meta's own attributed AOV over that
  ratio — so a stored `target_cpa` basis now matches no expected basis and
  `nativeSpendUnitAuthorityMatchesTarget` fails it CLOSED as
  `native_target_authority_mismatch`. That refusal is the new rule working, not
  a defect in these fixtures.

  The evidence below is therefore `ready` at a mean of 100.00 over 20 purchases,
  which reproduces the SAME `baseSpendUnit` of 50 (100 / targetRoas 2) that the
  Target CPA supplied, so every downstream threshold in these suites is
  unchanged and only the provenance moved.
*/
function persistedSpendUnitAuthority(
  targetAuthority: ReturnType<typeof resolveNativeAdTargetAuthority>,
): NativeAdSpendUnitAuthority {
  /*
    Both cases of the ladder, because these suites build cells for packs with a
    Target ROAS and for packs without one. It mirrors
    `buildNativeAdSpendUnitAuthority`: with a Target ROAS the basis is the
    platform AOV over that ratio, and only without one does the legacy Target
    CPA govern.
  */
  const roasAnchored =
    targetAuthority.targetRoasAuthority &&
    typeof targetAuthority.targetRoas === "number" &&
    targetAuthority.targetRoas > 0;
  const authority: NativeAdSpendUnitAuthority = {
    /*
      THE CURRENT CONTRACT, where this fixture used to hardcode `.v1`.

      Every case in this file that expects a hydrated cell to AUTHORIZE was
      therefore asserting that a historical authority governs a current
      decision — which is the defect Codex A6 closes. The subject of those
      cases is target-authority staleness and proof semantics, not spend-
      authority versioning, so the fixture now mints what the producer mints
      and the version transition is exercised deliberately, once, at the end of
      this file.
    */
    contractVersion: NATIVE_AD_SPEND_UNIT_AUTHORITY_CONTRACT_VERSION,
    status: "ready",
    basis: roasAnchored
      ? "physical_account_purchase_aov_90d"
      : "target_cpa",
    businessId: BUSINESS_ID,
    providerAccountRefId: PROVIDER_ACCOUNT_REF_ID,
    providerAccountId: "act-native",
    accountCurrency: "USD",
    asOfCutoff: CUTOFF,
    targetAuthorityHash: targetAuthority.authorityHash,
    baseSpendUnit: roasAnchored
      ? 100 / targetAuthority.targetRoas!
      : targetAuthority.targetCpa,
    accountAovEvidence: {
      status: "ready",
      scope: "business_provider_account_currency",
      businessId: BUSINESS_ID,
      providerAccountRefId: PROVIDER_ACCOUNT_REF_ID,
      providerAccountId: "act-native",
      accountCurrency: "USD",
      sampleWindowStart: "2026-04-14",
      sampleWindowEnd: AS_OF,
      asOfCutoff: CUTOFF,
      observedPurchaseCount: 20,
      requiredPurchaseCount: 20,
      revenueBackedRowCount: 20,
      canonicalRowCount: 20,
      contradictoryRowCount: 0,
      legacySchemaRowCount: 0,
      unsupportedSchemaRowCount: 0,
      totalRevenue: 2000,
      meanAov: 100,
      evidenceHash: "4".repeat(64),
    },
    authorityHash: "",
  };
  authority.authorityHash = recomputeNativeAdSpendUnitAuthorityHash(authority);
  return authority;
}

function nativeCellRow(
  targetInput: NativeAdTargetAuthorityInput = TARGET,
): Record<string, unknown> {
  const profile = makeAccountDecisionProfile({
    businessId: BUSINESS_ID,
    asOfDate: AS_OF,
  });
  const accountCalibration = {
    ...profile.accountBaselines,
    businessId: BUSINESS_ID,
    computedAt: CUTOFF,
    matureCreativeCount: 30,
  };
  const cutoff = resolveNativeAdCalibrationCutoff(AS_OF, CUTOFF);
  const target = resolveNativeAdTargetAuthority(targetInput, cutoff.asOfCutoff);
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
  ) as unknown as NativeAdCalibrationMetricSampleCounts;
  const key = {
    businessId: BUSINESS_ID,
    providerAccountRefId: PROVIDER_ACCOUNT_REF_ID,
    providerAccountId: "act-native",
    accountTimezone: "Europe/Istanbul",
    accountCurrency: "USD",
    cellScope: "objective_cohort_context" as const,
    objective: "OUTCOME_SALES",
    cohort: "purchase" as const,
    optimizationContext: buildNativeAdOptimizationContext(
      "PURCHASE",
      "PURCHASE",
    )!,
  };
  const spendUnitAuthority = persistedSpendUnitAuthority(target);
  const actionReadiness = resolveNativeAdCalibrationActionReadiness({
    key,
    matureAdCount: 30,
    metricSampleCounts: metricCounts,
    targetAuthority: target,
    accountCalibration,
    spendUnitAuthority,
  });
  const qualityCounts = {
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
    peerTruthFinalizedAtMissingSourceRowCount: 0,
    peerTruthFinalizedAtMissingAdCount: 0,
    censoredSourceRowExclusionCount: 0,
    censoredAdExclusionCount: 0,
    freshnessSourceRowExclusionCount: 0,
    freshnessAdExclusionCount: 0,
    commercialAuthorityAdExclusionCount: 0,
  };
  const row: Record<string, unknown> = {
    business_id: BUSINESS_ID,
    provider: "meta",
    provider_account_ref_id: PROVIDER_ACCOUNT_REF_ID,
    provider_account_id: "act-native",
    account_timezone: "Europe/Istanbul",
    account_currency: "USD",
    cell_scope: "objective_cohort_context",
    objective: "OUTCOME_SALES",
    funnel_cohort: "purchase",
    optimization_context: key.optimizationContext,
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
    roas_p75: accountCalibration.roasP75,
    roas_p60: accountCalibration.roasP60,
    refresh_ratio_p10: accountCalibration.refreshRatioP10,
    low_ctr_p10: accountCalibration.lowCtrP10,
    account_cpa_p50: accountCalibration.accountCpaP50,
    account_cpa_sample_count: accountCalibration.accountCpaSampleCount,
    meta_attributed_aov_mean_90d:
      accountCalibration.metaAttributedAovMean90d,
    meta_attributed_aov_purchase_count_90d:
      accountCalibration.metaAttributedAovPurchaseCount90d,
    meta_attributed_revenue_90d:
      accountCalibration.metaAttributedRevenue90d,
    meta_aov_quality: accountCalibration.metaAovQuality,
    mature_spend_p50: accountCalibration.matureSpendP50,
    mature_spend_p75: accountCalibration.matureSpendP75,
    winner_spend_p25: accountCalibration.winnerSpendP25,
    winner_spend_p50: accountCalibration.winnerSpendP50,
    winner_purchase_p50: accountCalibration.winnerPurchaseP50,
    roas_ratio_p10: accountCalibration.roasRatioP10,
    roas_ratio_p25: accountCalibration.roasRatioP25,
    roas_ratio_p50: accountCalibration.roasRatioP50,
    roas_ratio_p75: accountCalibration.roasRatioP75,
    funnel_calibration_json: profile.funnelCalibration,
    metric_sample_counts_json: metricCounts,
    action_readiness_json: actionReadiness,
    quality_counts_json: qualityCounts,
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
    // ROUND 9 ITEM 5. A persisted row carries its minted contract, and the cell
    // must agree with its batch — the reader enforces both.
    contract_version: NATIVE_AD_CALIBRATION_CONTRACT_VERSION,
    batch_contract_version: NATIVE_AD_CALIBRATION_CONTRACT_VERSION,
    batch_cell_count: 1,
    batch_cell_set_hash: "4".repeat(64),
  };
  const cell = {
    batchId: String(row.batch_id),
    batchCompleteness: "complete" as const,
    batchCellCount: 1,
    batchCellSetHash: String(row.batch_cell_set_hash),
    key,
    asOfDate: AS_OF,
    asOfCutoff: cutoff.asOfCutoff,
    sampleWindowStart: cutoff.sampleWindowStart,
    sampleWindowEnd: cutoff.sampleWindowEnd,
    sampleWindowDays: 90,
    computedAt: CUTOFF,
    engineVersion: NATIVE_AD_ENGINE_VERSION,
    policyVersion: NATIVE_AD_CALIBRATION_POLICY_VERSION,
    qualityStatus: "ready" as const,
    sourceAdCount: 30,
    sourceDayCount: 30,
    eligibleAdCount: 30,
    matureAdCount: 30,
    zeroConversionAdCount: 0,
    metricSampleCounts: metricCounts,
    actionReadiness,
    sourceMinDate: cutoff.sampleWindowStart,
    sourceMaxDate: cutoff.sampleWindowEnd,
    sourceMaxUpdatedAt: `${AS_OF}T02:00:00.000Z`,
    targetAuthority: target,
    accountCalibration,
    funnelCalibration: profile.funnelCalibration,
    batchInputManifestHash: String(row.batch_input_manifest_hash),
    inputManifestHash: "0".repeat(64),
    sourceManifestHash: String(row.source_manifest_hash),
    qualityCounts,
    contractVersion: NATIVE_AD_CALIBRATION_CONTRACT_VERSION,
  } satisfies NativeAdCalibrationCell;
  row.input_manifest_hash =
    recomputeNativeAdCalibrationCellInputManifestHash(cell);
  return row;
}

function productionSourceRow(index: number): NativeAdCalibrationSourceRow {
  return {
    sourceRowId: `roundtrip-source-${index}`,
    businessId: BUSINESS_ID,
    providerAccountRefId: PROVIDER_ACCOUNT_REF_ID,
    providerAccountId: "act-native",
    date: "2026-07-11",
    campaignId: "campaign-native",
    adsetId: "adset-native",
    adId: `roundtrip-ad-${index}`,
    accountTimezone: "Europe/Istanbul",
    accountCurrency: "USD",
    sourceAccountTimezone: "Europe/Istanbul",
    sourceAccountCurrency: "USD",
    metricSchemaVersion: 2,
    objective: "OUTCOME_SALES",
    optimizationGoal: "PURCHASE",
    customEventType: "PURCHASE",
    spend: 100 + index,
    impressions: 10_000,
    clicks: 300,
    linkClicks: 250,
    conversions: 2,
    revenue: 250,
    landingPageViews: 200,
    addToCart: 50,
    initiateCheckout: 20,
    thumbstop: 0.3,
    truthState: "finalized",
    validationStatus: "passed",
    finalizedAt: "2026-07-12T01:00:00.000Z",
    createdAt: "2026-07-12T01:00:00.000Z",
    updatedAt: "2026-07-12T02:00:00.000Z",
    campaignSourceRowId: "roundtrip-campaign-source",
    campaignTruthState: "finalized",
    campaignValidationStatus: "passed",
    campaignCreatedAt: "2026-07-12T01:00:00.000Z",
    campaignUpdatedAt: "2026-07-12T02:00:00.000Z",
    adsetSourceRowId: "roundtrip-adset-source",
    adsetTruthState: "finalized",
    adsetValidationStatus: "passed",
    adsetCreatedAt: "2026-07-12T01:00:00.000Z",
    adsetUpdatedAt: "2026-07-12T02:00:00.000Z",
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
    fakeDb((query) => (query.includes("native-ad-profile-cell") ? [row] : [])),
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

function targetAuthorityRow(target: NativeAdTargetAuthorityInput) {
  return {
    source_row_id: target.sourceRowId,
    operation: target.operation,
    target_cpa: target.targetCpa,
    target_roas: target.targetRoas,
    break_even_cpa: target.breakEvenCpa,
    break_even_roas: target.breakEvenRoas,
    operator_aov_assumption: target.operatorAovAssumption,
    default_risk_posture: target.defaultRiskPosture,
    effective_at: target.effectiveAt,
    recorded_at: target.recordedAt,
  };
}

function resolveNativeCell(
  row: Record<string, unknown>,
  target: NativeAdTargetAuthorityInput = TARGET,
) {
  const store = new WarehouseNativeAdAccountProfileDataSource(
    fakeDb((query) => {
      if (query.includes("native-ad-profile-cell")) return [row];
      if (query === READ_NATIVE_AD_TARGET_AUTHORITY_FOR_ACCOUNT_SQL) {
        return [targetAuthorityRow(target)];
      }
      return [];
    }),
  );
  return resolveNativeAdAccountDecisionProfile({
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
  });
}

type NativeActionReadinessJson = {
  spendUnitAuthority: NativeAdSpendUnitAuthority;
  scale: Record<string, unknown>;
  cut: Record<string, unknown>;
  refresh: Record<string, unknown>;
};

function forgeSpendUnitAuthority(
  row: Record<string, unknown>,
  mutate: (authority: NativeAdSpendUnitAuthority) => void,
  options: { recomputeHash?: boolean } = {},
) {
  const actionReadiness = structuredClone(
    row["action_readiness_json"],
  ) as NativeActionReadinessJson;
  mutate(actionReadiness.spendUnitAuthority);
  if (options.recomputeHash !== false) {
    actionReadiness.spendUnitAuthority.authorityHash =
      recomputeNativeAdSpendUnitAuthorityHash(
        actionReadiness.spendUnitAuthority,
      );
  }
  return {
    ...row,
    action_readiness_json: actionReadiness,
  };
}

describe("WarehouseNativeAdAccountProfileDataSource", () => {
  it("round-trips a production-computed cell through the persistence payload and resolver", async () => {
    const batch = computeNativeAdCalibrationBatch({
      businessId: BUSINESS_ID,
      providerAccountRefId: PROVIDER_ACCOUNT_REF_ID,
      providerAccountId: "act-native",
      asOf: AS_OF,
      computationCutoff: CUTOFF,
      sourceRows: Array.from({ length: 30 }, (_, index) =>
        productionSourceRow(index + 1),
      ),
      targetAuthority: TARGET,
    });
    const payload = buildNativeAdCalibrationPersistencePayload(batch, {
      batchId: "00000000-0000-4000-8000-000000000754",
      jobRunId: JOB_RUN_ID,
    });
    const row = payload.find(
      (candidate) =>
        candidate.cell_scope === "objective_cohort_context" &&
        candidate.optimization_context ===
          buildNativeAdOptimizationContext("PURCHASE", "PURCHASE"),
    );
    expect(row).toBeDefined();
    const persistedRow = {
      ...row!,
      batch_completeness: "complete",
      contract_version: NATIVE_AD_CALIBRATION_CONTRACT_VERSION,
      batch_contract_version: NATIVE_AD_CALIBRATION_CONTRACT_VERSION,
      batch_cell_count: batch.expectedCellCount,
      batch_cell_set_hash: batch.cellSetHash,
    };
    const hydrated = await readNativeCell(persistedRow);

    expect(hydrated).not.toBeNull();
    expect(recomputeNativeAdCalibrationCellInputManifestHash(hydrated!)).toBe(
      hydrated!.inputManifestHash,
    );
    await expect(resolveNativeCell(persistedRow, TARGET)).resolves.toMatchObject(
      {
        status: "ready",
        reason: null,
      },
    );
  });

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
    expect(recomputeNativeAdCalibrationCellInputManifestHash(cell!)).toBe(
      cell!.inputManifestHash,
    );
    expect(
      resolveNativeAdCalibrationActionReadiness({
        key: cell!.key,
        matureAdCount: cell!.matureAdCount,
        metricSampleCounts: cell!.metricSampleCounts,
        targetAuthority: cell!.targetAuthority,
        accountCalibration: cell!.accountCalibration,
        spendUnitAuthority: cell!.actionReadiness.spendUnitAuthority,
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

  it("preserves same-ms target ordering through the native profile database adapter", async () => {
    const db = fakeDb(() => [{
      ...targetAuthorityRow(TARGET),
      effective_at: "2026-07-12T03:05:00.000900Z",
      recorded_at: "2026-07-12T03:05:00.000100Z",
    }]);
    const target = await new WarehouseNativeAdAccountProfileDataSource(db)
      .getNativeTargetAuthorityAsOf({
        businessId: BUSINESS_ID,
        providerAccountRefId: PROVIDER_ACCOUNT_REF_ID,
        providerAccountId: "act-native",
        asOfCutoff: "2026-07-12T03:05:00.001000999Z",
      });
    expect(db.query).toHaveBeenCalledWith(READ_NATIVE_AD_TARGET_AUTHORITY_FOR_ACCOUNT_SQL, [
      BUSINESS_ID, PROVIDER_ACCOUNT_REF_ID, "act-native", "2026-07-12T03:05:00.001000Z",
    ]);
    expect(resolveNativeAdTargetAuthority(target, "2026-07-12T03:05:00.001000999Z"))
      .toMatchObject({ status: "cutoff_unsafe", targetRoasAuthority: false });
  });

  it.each(["invalid", "delete_all"])("rejects unsupported target operations (%s) after sharing the mapper", async (operation) => {
    const db = fakeDb(() => [{ ...targetAuthorityRow(TARGET), operation }]);
    await expect(new WarehouseNativeAdAccountProfileDataSource(db).getNativeTargetAuthorityAsOf({
      businessId: BUSINESS_ID, providerAccountRefId: PROVIDER_ACCOUNT_REF_ID,
      providerAccountId: "act-native", asOfCutoff: CUTOFF,
    })).rejects.toThrow("Unsupported native target operation");
  });

  it("preserves the target risk-posture validation after sharing the mapper", async () => {
    const db = fakeDb(() => [{ ...targetAuthorityRow(TARGET), default_risk_posture: "invalid" }]);
    await expect(new WarehouseNativeAdAccountProfileDataSource(db).getNativeTargetAuthorityAsOf({
      businessId: BUSINESS_ID, providerAccountRefId: PROVIDER_ACCOUNT_REF_ID,
      providerAccountId: "act-native", asOfCutoff: CUTOFF,
    })).rejects.toThrow("Unsupported target risk posture");
  });

  it.each(["engine-v3-native-ad-calibration.v1", "engine-v3-native-ad-calibration.v2", "engine-v3-native-ad-calibration.v3"])(
    "keeps %s clocks under their original millisecond hash semantics", async (contractVersion) => {
      const raw = nativeCellRow();
      const baseline = await readNativeCell({ ...raw, contract_version: contractVersion,
        batch_contract_version: contractVersion });
      const hydrated = await readNativeCell({
        ...raw, contract_version: contractVersion, batch_contract_version: contractVersion,
        target_effective_at: TARGET.effectiveAt!.replace(".000Z", ".000900Z"),
        target_recorded_at: TARGET.recordedAt!.replace(".000Z", ".000100Z"),
      });
      expect(hydrated?.targetAuthority.effectiveAt).toBe(TARGET.effectiveAt);
      expect(hydrated?.targetAuthority.recordedAt).toBe(TARGET.recordedAt);
      expect(recomputeNativeAdCalibrationCellInputManifestHash(hydrated!))
        .toBe(recomputeNativeAdCalibrationCellInputManifestHash(baseline!));
    },
  );

  it("retains nonzero target microseconds on current persisted cells", async () => {
    const hydrated = await readNativeCell({
      ...nativeCellRow(), target_effective_at: "2026-07-01T00:00:00.000900Z",
      target_recorded_at: "2026-07-01T00:00:01.000100Z",
    });
    expect(hydrated?.targetAuthority.effectiveAt).toBe("2026-07-01T00:00:00.000900Z");
    expect(hydrated?.targetAuthority.recordedAt).toBe("2026-07-01T00:00:01.000100Z");
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

  it("rejects forged spend-unit proof hashes and cell identities", async () => {
    const row = nativeCellRow();
    const cases: Array<{
      label: string;
      recomputeHash?: boolean;
      mutate: (authority: NativeAdSpendUnitAuthority) => void;
    }> = [
      {
        label: "authority hash",
        recomputeHash: false,
        mutate: (authority) => {
          authority.authorityHash = "f".repeat(64);
        },
      },
      {
        label: "authority business id",
        mutate: (authority) => {
          authority.businessId = "00000000-0000-4000-8000-000000000799";
        },
      },
      {
        label: "authority account currency",
        mutate: (authority) => {
          authority.accountCurrency = "EUR";
        },
      },
      {
        label: "authority provider-account ref",
        mutate: (authority) => {
          authority.providerAccountRefId =
            "00000000-0000-4000-8000-000000000798";
        },
      },
      {
        label: "authority provider-account id",
        mutate: (authority) => {
          authority.providerAccountId = "act-forged";
        },
      },
      {
        label: "authority cutoff",
        mutate: (authority) => {
          authority.asOfCutoff = "2026-07-12T03:06:00.000Z";
        },
      },
      {
        label: "target authority hash",
        mutate: (authority) => {
          authority.targetAuthorityHash = "9".repeat(64);
        },
      },
      {
        label: "evidence business id",
        mutate: (authority) => {
          authority.accountAovEvidence.businessId =
            "00000000-0000-4000-8000-000000000797";
        },
      },
      {
        label: "evidence account currency",
        mutate: (authority) => {
          authority.accountAovEvidence.accountCurrency = "EUR";
        },
      },
      {
        label: "evidence provider-account ref",
        mutate: (authority) => {
          authority.accountAovEvidence.providerAccountRefId =
            "00000000-0000-4000-8000-000000000796";
        },
      },
      {
        label: "evidence provider-account id",
        mutate: (authority) => {
          authority.accountAovEvidence.providerAccountId = "act-forged";
        },
      },
      {
        label: "evidence cutoff",
        mutate: (authority) => {
          authority.accountAovEvidence.asOfCutoff = "2026-07-12T03:06:00.000Z";
        },
      },
    ];

    for (const testCase of cases) {
      const result = await resolveNativeCell(
        forgeSpendUnitAuthority(row, testCase.mutate, {
          recomputeHash: testCase.recomputeHash,
        }),
      );
      expect(result, testCase.label).toMatchObject({
        status: "fail_closed",
        reason: "native_calibration_contract_invalid",
      });
    }
  });

  it("rejects contradictory account-AOV proof semantics", async () => {
    const row = nativeCellRow();
    const cases: Array<{
      label: string;
      mutate: (authority: NativeAdSpendUnitAuthority) => void;
    }> = [
      {
        label: "mean does not equal revenue divided by purchases",
        mutate: (authority) => {
          authority.accountAovEvidence = {
            ...authority.accountAovEvidence,
            status: "ready",
            observedPurchaseCount: 20,
            revenueBackedRowCount: 20,
            canonicalRowCount: 20,
            totalRevenue: 2_000,
            meanAov: 99,
          };
        },
      },
      {
        label: "physical-account AOV basis carries unavailable evidence",
        mutate: (authority) => {
          // The base fixture now mints this basis over READY evidence, so the
          // forgery has to withdraw the evidence rather than only rename the
          // basis: the rule under test is that the two cannot disagree.
          authority.basis = "physical_account_purchase_aov_90d";
          authority.baseSpendUnit = 50;
          authority.accountAovEvidence = {
            ...authority.accountAovEvidence,
            status: "unavailable",
            observedPurchaseCount: 0,
            revenueBackedRowCount: 0,
            canonicalRowCount: 0,
            totalRevenue: 0,
            meanAov: null,
          };
        },
      },
      {
        label: "purchase totals have no revenue-backed source rows",
        mutate: (authority) => {
          authority.accountAovEvidence = {
            ...authority.accountAovEvidence,
            status: "ready",
            observedPurchaseCount: 20,
            revenueBackedRowCount: 0,
            canonicalRowCount: 20,
            totalRevenue: 2_000,
            meanAov: 100,
          };
        },
      },
      {
        label: "revenue-backed rows exceed canonical rows and purchases",
        mutate: (authority) => {
          authority.accountAovEvidence = {
            ...authority.accountAovEvidence,
            status: "ready",
            observedPurchaseCount: 20,
            revenueBackedRowCount: 21,
            canonicalRowCount: 20,
            totalRevenue: 2_000,
            meanAov: 100,
          };
        },
      },
      {
        label: "zero purchases carry positive revenue",
        mutate: (authority) => {
          authority.accountAovEvidence = {
            ...authority.accountAovEvidence,
            status: "insufficient_sample",
            observedPurchaseCount: 0,
            revenueBackedRowCount: 0,
            canonicalRowCount: 1,
            totalRevenue: 100,
            meanAov: null,
          };
        },
      },
      {
        label: "unsupported future schema is omitted from contradictions",
        mutate: (authority) => {
          authority.accountAovEvidence = {
            ...authority.accountAovEvidence,
            unsupportedSchemaRowCount: 1,
            contradictoryRowCount: 0,
          };
        },
      },
    ];

    for (const testCase of cases) {
      const result = await resolveNativeCell(
        forgeSpendUnitAuthority(row, testCase.mutate),
      );
      expect(result, testCase.label).toMatchObject({
        status: "fail_closed",
        reason: "native_calibration_contract_invalid",
      });
    }
  });

  it("rejects a physical-account AOV proof that omits future schema rows from contradictions", async () => {
    const row = nativeCellRow(AOV_ONLY_TARGET);
    const forged = forgeSpendUnitAuthority(row, (authority) => {
      authority.status = "ready";
      authority.basis = "physical_account_purchase_aov_90d";
      authority.baseSpendUnit = 50;
      authority.accountAovEvidence = {
        ...authority.accountAovEvidence,
        status: "ready",
        observedPurchaseCount: 20,
        revenueBackedRowCount: 20,
        canonicalRowCount: 20,
        contradictoryRowCount: 0,
        unsupportedSchemaRowCount: 1,
        totalRevenue: 2_000,
        meanAov: 100,
      };
    });

    await expect(
      resolveNativeCell(forged, AOV_ONLY_TARGET),
    ).resolves.toMatchObject({
      status: "fail_closed",
      reason: "native_calibration_contract_invalid",
    });
  });

  it("rejects a blocked spend-unit proof that still carries a base spend unit", async () => {
    const target = {
      ...TARGET,
      targetCpa: null,
      operatorAovAssumption: null,
    };
    const row = nativeCellRow(target);
    const forged = forgeSpendUnitAuthority(row, (authority) => {
      authority.status = "blocked";
      authority.basis = null;
      authority.baseSpendUnit = 50;
    });
    const actionReadiness = forged[
      "action_readiness_json"
    ] as NativeActionReadinessJson;
    actionReadiness.cut = {
      ready: false,
      reason: "commercial_spend_unit_authority_missing",
      authorityBasis: null,
      observedSampleCount: 30,
      requiredSampleCount: 20,
    };

    await expect(resolveNativeCell(forged, target)).resolves.toMatchObject({
      status: "fail_closed",
      reason: "native_calibration_contract_invalid",
    });
  });

  it("rejects non-number spend-unit scalar values while parsing persisted JSON", async () => {
    const row = nativeCellRow();
    const cases: Array<{
      label: string;
      mutate: (authority: NativeAdSpendUnitAuthority) => void;
    }> = [
      {
        label: "base spend unit",
        mutate: (authority) => {
          authority.baseSpendUnit = "50" as unknown as number;
        },
      },
      {
        label: "observed purchase count",
        mutate: (authority) => {
          authority.accountAovEvidence.observedPurchaseCount =
            "0" as unknown as number;
        },
      },
      {
        label: "required purchase count",
        mutate: (authority) => {
          authority.accountAovEvidence.requiredPurchaseCount =
            "20" as unknown as number;
        },
      },
      {
        label: "total revenue",
        mutate: (authority) => {
          authority.accountAovEvidence.totalRevenue = "0" as unknown as number;
        },
      },
      {
        label: "mean AOV",
        mutate: (authority) => {
          authority.accountAovEvidence.meanAov = "100" as unknown as number;
        },
      },
    ];

    for (const testCase of cases) {
      await expect(
        readNativeCell(
          forgeSpendUnitAuthority(row, testCase.mutate, {
            recomputeHash: false,
          }),
        ),
        testCase.label,
      ).rejects.toThrow(TypeError);
    }
  });

  it("rejects omitted required-nullable spend-unit proof fields", async () => {
    const row = nativeCellRow();
    const cases: Array<{
      label: string;
      mutate: (authority: NativeAdSpendUnitAuthority) => void;
    }> = [
      {
        label: "basis",
        mutate: (authority) => {
          authority.basis =
            undefined as unknown as NativeAdSpendUnitAuthority["basis"];
        },
      },
      {
        label: "authority account currency",
        mutate: (authority) => {
          authority.accountCurrency = undefined as unknown as string | null;
        },
      },
      {
        label: "base spend unit",
        mutate: (authority) => {
          authority.baseSpendUnit = undefined as unknown as number | null;
        },
      },
      {
        label: "evidence account currency",
        mutate: (authority) => {
          authority.accountAovEvidence.accountCurrency =
            undefined as unknown as string | null;
        },
      },
      {
        label: "mean AOV",
        mutate: (authority) => {
          authority.accountAovEvidence.meanAov = undefined as unknown as
            number | null;
        },
      },
    ];

    for (const testCase of cases) {
      await expect(
        readNativeCell(
          forgeSpendUnitAuthority(row, testCase.mutate, {
            recomputeHash: false,
          }),
        ),
        testCase.label,
      ).rejects.toThrow(TypeError);
    }
  });

  it("rejects forged action-authority bases before profile authority", async () => {
    const row = nativeCellRow();
    const valid = row["action_readiness_json"] as Record<
      "scale" | "cut" | "refresh",
      Record<string, unknown>
    >;
    const forgedProofs = [
      {
        ...valid,
        scale: {
          ...valid.scale,
          authorityBasis: "commercial_stop_loss",
          requiredSampleCount: 0,
        },
      },
      {
        ...valid,
        cut: {
          ...valid.cut,
          authorityBasis: "commercial_stop_loss",
          requiredSampleCount: 1,
        },
      },
      {
        ...valid,
        cut: {
          ...valid.cut,
          ready: false,
          reason: "cut_calibration_sample_low",
          authorityBasis: "calibrated_relative",
        },
      },
      {
        ...valid,
        refresh: {
          ...valid.refresh,
          authorityBasis: "untrusted_override",
        },
      },
      {
        ...valid,
        cut: {
          ready: true,
          reason: null,
          observedSampleCount: 30,
          requiredSampleCount: 20,
        },
      },
    ];

    for (const actionReadiness of forgedProofs) {
      await expect(
        readNativeCell({
          ...row,
          action_readiness_json: actionReadiness,
        }),
      ).rejects.toThrow(/invalid readiness proof/);
    }
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

/*
  CODEX A6 — A HISTORICAL SPEND AUTHORITY IS READABLE, NOT AUTHORITATIVE.

  `nativeSpendUnitAuthorityMatchesTarget` applied TODAY's ladder to every
  persisted authority, whatever contract minted it. A row written under an
  older contract — when the rungs, the hashed content, or both, were different
  — was therefore judged under semantics it had never been produced under. Two
  ways that goes wrong, and only one of them is loud: an old row could be
  declared a match and go on to AUTHORIZE a current decision, or a row valid
  under its own contract could be declared a mismatch and take the whole native
  job down with `native_target_authority_mismatch`.

  These cases drive the REAL exported resolver over a hydrated cell, so they
  exercise the gate where production reaches it.
*/
describe("spend-authority version transitions", () => {
  it("reads a persisted historical store basis without granting current authority", async () => {
    const row = forgeSpendUnitAuthority(nativeCellRow(AOV_ONLY_TARGET), (authority) => {
      (authority as { contractVersion: string }).contractVersion = "engine-v3-native-ad-spend-unit-authority.v2";
      authority.basis = "observed_shopify_aov";
      authority.baseSpendUnit = 45;
      authority.observedShopifyAovEvidence = {
        contract: "meta.observed-shopify-aov.v1", status: "observed",
        source: "shopify_revenue_ledger", providerAccountId: "store.myshopify.com",
        revenueBasis: "net_ledger", window: { from: "2026-06-14", to: "2026-07-11" },
        zoneName: "UTC", orderCount: 60, currency: "USD", currencyExponent: 2,
        revenueMinor: 540000, aovMinor: 9000,
        observedAt: "2026-07-12T00:00:00.000Z", knowledgeAsOf: CUTOFF,
      };
    });
    const hydrated = await readNativeCell(row);
    expect(hydrated?.actionReadiness.spendUnitAuthority).toMatchObject({
      basis: "observed_shopify_aov", baseSpendUnit: 45,
      observedShopifyAovEvidence: { aovMinor: 9000, orderCount: 60 },
    });
    expect(await resolveNativeCell(row)).not.toMatchObject({ status: "ready" });
  });
  const HISTORICAL_VERSIONS = [
    "engine-v3-native-ad-spend-unit-authority.v1",
    "engine-v3-native-ad-spend-unit-authority.v2",
    "engine-v3-native-ad-spend-unit-authority.v3",
  ] as const;

  it("refuses to authorize on any superseded contract version", async () => {
    const row = nativeCellRow();
    for (const version of HISTORICAL_VERSIONS) {
      /*
        Everything else about the row is left exactly as the current producer
        wrote it, and the authority hash is RECOMPUTED so the row stays
        internally consistent and hash-verifiable. The only thing that differs
        is the contract that claims to have minted it — which is precisely the
        state a real historical row is in.
      */
      const result = await resolveNativeCell(
        forgeSpendUnitAuthority(row, (authority) => {
          (authority as { contractVersion: string }).contractVersion = version;
        }),
      );
      expect(result, version).not.toMatchObject({ status: "ready" });
    }
  });

  it("still authorizes the current contract version, so the gate is not blanket", async () => {
    // The control. Without it, a resolver that refused everything would pass
    // the case above while proving nothing about version scoping.
    const result = await resolveNativeCell(nativeCellRow());
    expect(result).toMatchObject({ status: "ready" });
  });
});
