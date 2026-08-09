import { describe, expect, it } from "vitest";
import { decideCreative } from "../engine";
import {
  NATIVE_AD_ACCOUNT_FALLBACK_CELL,
  NATIVE_AD_THIN_EXACT_FALLBACK_CELL,
  READ_NATIVE_AD_ACCOUNT_CALIBRATION_CELL_SQL,
  commercialStopLossAovRepairAuthorityFromExactCell,
  reconcilePersistedNativeCutEligibilityWithAccountAov,
  resolveNativeAdAccountDecisionProfile,
  type NativeAdAccountProfileDataSource,
  type NativeAdCalibrationCellQuery,
} from "../ad-account-decision-profile";
import type { EngineV3Flags } from "../feature-flags";
import {
  computeNativeAdCalibrationBatch,
  NATIVE_AD_ACCOUNT_WIDE_OPTIMIZATION_CONTEXT,
  NATIVE_AD_CALIBRATION_TABLE,
  recomputeNativeAdSpendUnitAuthorityHash,
  type NativeAdCalibrationCell,
  type NativeAdCalibrationSourceRow,
  type NativeAdTargetAuthorityInput,
} from "../jobs/ad-calibration-job";
import { makeCreativeInput } from "./helpers";

const BUSINESS_ID = "00000000-0000-4000-8000-000000000711";
const PROVIDER_ACCOUNT_REF_ID = "00000000-0000-4000-8000-000000000710";
const BATCH_ID = "00000000-0000-4000-8000-000000000712";
const AS_OF = "2026-07-12";
const FRESH_TARGET: NativeAdTargetAuthorityInput = {
  sourceRowId: "00000000-0000-4000-8000-000000000719",
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
const STALE_TARGET: NativeAdTargetAuthorityInput = {
  ...FRESH_TARGET,
  effectiveAt: "2026-05-01T00:00:00.000Z",
  recordedAt: "2026-05-01T00:00:01.000Z",
};
const AOV_ONLY_TARGET: NativeAdTargetAuthorityInput = {
  ...FRESH_TARGET,
  targetCpa: null,
  operatorAovAssumption: null,
};

function makeFlags(): EngineV3Flags {
  return {
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
  };
}

function makeSourceRow(
  index: number,
  overrides: Partial<NativeAdCalibrationSourceRow> = {},
): NativeAdCalibrationSourceRow {
  const adId = overrides.adId ?? `ad-${String(index).padStart(2, "0")}`;
  return {
    sourceRowId: overrides.sourceRowId ?? `source-${adId}`,
    businessId: BUSINESS_ID,
    providerAccountRefId: PROVIDER_ACCOUNT_REF_ID,
    providerAccountId: "act-native",
    date: "2026-07-11",
    campaignId: "campaign-native",
    adsetId: "adset-native",
    adId,
    accountTimezone: "Europe/Istanbul",
    accountCurrency: "USD",
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
    revenue: 240 + index * 3,
    landingPageViews: 200,
    addToCart: 50,
    initiateCheckout: 20,
    thumbstop: 0.3,
    truthState: "finalized",
    validationStatus: "passed",
    finalizedAt: "2026-07-12T01:00:00.000Z",
    createdAt: "2026-07-12T01:00:00.000Z",
    updatedAt: "2026-07-12T02:00:00.000Z",
    campaignSourceRowId: "campaign-source",
    campaignTruthState: "finalized",
    campaignValidationStatus: "passed",
    campaignCreatedAt: "2026-07-12T01:00:00.000Z",
    campaignUpdatedAt: "2026-07-12T02:00:00.000Z",
    adsetSourceRowId: "adset-source",
    adsetTruthState: "finalized",
    adsetValidationStatus: "passed",
    adsetCreatedAt: "2026-07-12T01:00:00.000Z",
    adsetUpdatedAt: "2026-07-12T02:00:00.000Z",
    ...overrides,
    sourceAccountTimezone:
      overrides.sourceAccountTimezone === undefined
        ? "Europe/Istanbul"
        : overrides.sourceAccountTimezone,
  };
}

function buildCells(
  count: number,
  overrides: Partial<NativeAdCalibrationSourceRow> = {},
  targetAuthority: NativeAdTargetAuthorityInput = FRESH_TARGET,
) {
  return computeNativeAdCalibrationBatch({
    businessId: BUSINESS_ID,
    providerAccountRefId: PROVIDER_ACCOUNT_REF_ID,
    providerAccountId: "act-native",
    asOf: AS_OF,
    computationCutoff: "2026-07-12T03:05:00.000Z",
    sourceRows: Array.from({ length: count }, (_, index) =>
      makeSourceRow(index + 1, overrides),
    ),
    targetAuthority,
  }).cells.map((cell) => ({
    ...cell,
    batchId: BATCH_ID,
    batchCompleteness: "complete" as const,
  }));
}

function buildMixedOptimizationCells() {
  return computeNativeAdCalibrationBatch({
    businessId: BUSINESS_ID,
    providerAccountRefId: PROVIDER_ACCOUNT_REF_ID,
    providerAccountId: "act-native",
    asOf: AS_OF,
    computationCutoff: "2026-07-12T03:05:00.000Z",
    sourceRows: Array.from({ length: 30 }, (_, index) =>
      makeSourceRow(index + 1, {
        optimizationGoal: index < 15 ? "PURCHASE" : "VALUE",
        customEventType: index < 15 ? "PURCHASE" : "VALUE",
      }),
    ),
    targetAuthority: FRESH_TARGET,
  }).cells.map((cell) => ({
    ...cell,
    batchId: BATCH_ID,
    batchCompleteness: "complete" as const,
  }));
}

function buildP25ReadyCellsWithUnrelatedAovContradiction() {
  const purchaseRows = Array.from({ length: 30 }, (_, index) =>
    makeSourceRow(index + 1, {
      sourceRowId: `purchase-ready-${index}`,
      adId: `purchase-ready-${index}`,
      optimizationGoal: "PURCHASE",
      customEventType: "PURCHASE",
      revenue: 60 + index,
    }),
  );
  const contradictoryValueContext = makeSourceRow(31, {
    sourceRowId: "value-context-contradiction",
    adId: "value-context-contradiction",
    optimizationGoal: "VALUE",
    customEventType: "VALUE",
    conversions: 0,
    revenue: 100,
  });
  return computeNativeAdCalibrationBatch({
    businessId: BUSINESS_ID,
    providerAccountRefId: PROVIDER_ACCOUNT_REF_ID,
    providerAccountId: "act-native",
    asOf: AS_OF,
    computationCutoff: "2026-07-12T03:05:00.000Z",
    sourceRows: [...purchaseRows, contradictoryValueContext],
    targetAuthority: AOV_ONLY_TARGET,
  }).cells.map((cell) => ({
    ...cell,
    batchId: BATCH_ID,
    batchCompleteness: "complete" as const,
  }));
}

function buildAccountAovAuthorityCells(input: {
  exactCount: number;
  accountOnlyCount: number;
}) {
  const exact = Array.from({ length: input.exactCount }, (_, index) =>
    makeSourceRow(index + 1, {
      sourceRowId: `aov-exact-${index}`,
      adId: `aov-exact-${index}`,
      conversions: 1,
      revenue: 80,
    }),
  );
  const accountOnly = Array.from(
    { length: input.accountOnlyCount },
    (_, index) =>
      makeSourceRow(index + 1, {
        sourceRowId: `aov-account-${index}`,
        adId: `aov-account-${index}`,
        campaignId: null,
        adsetId: null,
        campaignSourceRowId: null,
        campaignTruthState: null,
        campaignValidationStatus: null,
        campaignCreatedAt: null,
        campaignUpdatedAt: null,
        adsetSourceRowId: null,
        adsetTruthState: null,
        adsetValidationStatus: null,
        adsetCreatedAt: null,
        adsetUpdatedAt: null,
        conversions: 1,
        revenue: 100,
      }),
  );
  return computeNativeAdCalibrationBatch({
    businessId: BUSINESS_ID,
    providerAccountRefId: PROVIDER_ACCOUNT_REF_ID,
    providerAccountId: "act-native",
    asOf: AS_OF,
    computationCutoff: "2026-07-12T03:05:00.000Z",
    sourceRows: [...exact, ...accountOnly],
    targetAuthority: AOV_ONLY_TARGET,
  }).cells.map((cell) => ({
    ...cell,
    batchId: BATCH_ID,
    batchCompleteness: "complete" as const,
  }));
}

class NativeOnlyProfileDataSource implements NativeAdAccountProfileDataSource {
  readonly calibrationCalls: NativeAdCalibrationCellQuery[] = [];
  readonly targetInputs: Array<{
    businessId: string;
    providerAccountRefId: string;
    providerAccountId: string;
    asOfCutoff: string;
  }> = [];
  targetCalls = 0;

  constructor(
    private readonly cells: NativeAdCalibrationCell[],
    private readonly target: NativeAdTargetAuthorityInput | null = FRESH_TARGET,
  ) {}

  async getNativeAdCalibrationCell(input: NativeAdCalibrationCellQuery) {
    this.calibrationCalls.push(input);
    return (
      this.cells.find(
        (cell) =>
          cell.key.businessId === input.businessId &&
          cell.key.providerAccountId === input.providerAccountId &&
          cell.key.accountTimezone === input.accountTimezone &&
          cell.key.accountCurrency === input.accountCurrency &&
          cell.key.cellScope === input.cellScope &&
          cell.key.objective === input.objective &&
          cell.key.cohort === input.cohort &&
          cell.key.optimizationContext === input.optimizationContext &&
          cell.asOfDate === input.asOfDate,
      ) ?? null
    );
  }

  async getNativeTargetAuthorityAsOf(input: {
    businessId: string;
    providerAccountRefId: string;
    providerAccountId: string;
    asOfCutoff: string;
  }) {
    this.targetCalls += 1;
    this.targetInputs.push(input);
    return this.target;
  }

  async getNativeDecisionCalibrationProfileAsOf() {
    return null;
  }
}

function resolveWith(
  dataSource: NativeOnlyProfileDataSource,
  overrides: Partial<
    Parameters<typeof resolveNativeAdAccountDecisionProfile>[0]
  > = {},
) {
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
    dataSource,
    flags: makeFlags(),
    ...overrides,
  });
}

describe("resolveNativeAdAccountDecisionProfile", () => {
  it("repairs only the legacy account-AOV Cut veto and preserves Scale/Refresh", () => {
    const accountAovOverlay = {
      scale: true,
      cut: true,
      refresh: true,
      reason: null,
      reasons: { scale: null, cut: null, refresh: null },
    };

    expect(
      reconcilePersistedNativeCutEligibilityWithAccountAov({
        persisted: {
          scale: false,
          cut: false,
          refresh: false,
          reason: "persisted_scale_blocker",
          reasons: {
            scale: "persisted_scale_blocker",
            cut: "native_ad_calibration:commercial_spend_unit_authority_missing",
            refresh: "persisted_refresh_blocker",
          },
        },
        accountAovOverlay,
      }),
    ).toEqual({
      scale: false,
      cut: true,
      refresh: false,
      reason: "persisted_scale_blocker",
      reasons: {
        scale: "persisted_scale_blocker",
        cut: null,
        refresh: "persisted_refresh_blocker",
      },
    });

    expect(
      reconcilePersistedNativeCutEligibilityWithAccountAov({
        persisted: {
          scale: true,
          cut: false,
          refresh: true,
          reason: "native_ad_calibration:break_even_roas_authority_missing",
          reasons: {
            scale: null,
            cut: "native_ad_calibration:break_even_roas_authority_missing",
            refresh: null,
          },
        },
        accountAovOverlay,
      }),
    ).toEqual({
      scale: true,
      cut: false,
      refresh: true,
      reason: "native_ad_calibration:break_even_roas_authority_missing",
      reasons: {
        scale: null,
        cut: "native_ad_calibration:break_even_roas_authority_missing",
        refresh: null,
      },
    });
  });

  it("reuses retained profile math with a ready exact native cell", async () => {
    const cells = buildCells(30);
    const exact = cells.find(
      (cell) => cell.key.cellScope === "objective_cohort_context",
    );
    expect(exact?.qualityStatus).toBe("ready");
    const dataSource = new NativeOnlyProfileDataSource(cells);

    const result = await resolveWith(dataSource);

    expect(result).toMatchObject({
      status: "ready",
      reason: null,
      calibrationSource: "objective_cohort_context",
    });
    expect(result.profile?.scope).toEqual({
      type: "account",
      id: "act-native",
    });
    expect(result.profile?.thresholds.bottomQuartileRatio).toBe(
      exact?.accountCalibration.roasRatioP25,
    );
    expect(result.hardActionEligibility).toMatchObject({
      scale: true,
      cut: true,
      refresh: true,
    });
    expect(dataSource.calibrationCalls).toHaveLength(1);
    expect(dataSource.targetCalls).toBe(1);
    expect(dataSource.targetInputs).toEqual([
      {
        businessId: BUSINESS_ID,
        providerAccountRefId: PROVIDER_ACCOUNT_REF_ID,
        providerAccountId: "act-native",
        asOfCutoff: "2026-07-12T03:05:00.000Z",
      },
    ]);
  });

  it("preserves production P25-backed Cut readiness when another optimization context blocks account AOV", async () => {
    const cells = buildP25ReadyCellsWithUnrelatedAovContradiction();
    const exact = cells.find(
      (cell) =>
        cell.key.cellScope === "objective_cohort_context" &&
        cell.key.optimizationContext ===
          "goal=PURCHASE|event=PURCHASE",
    );
    expect(exact?.actionReadiness.spendUnitAuthority).toMatchObject({
      status: "blocked",
      accountAovEvidence: {
        status: "contradictory_purchase_truth",
      },
    });
    expect(exact?.actionReadiness.cut).toMatchObject({
      ready: true,
      reason: null,
      authorityBasis: "calibrated_relative_with_economic_stop_loss",
      observedSampleCount: 30,
      requiredSampleCount: 20,
    });

    const result = await resolveWith(
      new NativeOnlyProfileDataSource(cells, AOV_ONLY_TARGET),
    );

    expect(result).toMatchObject({
      status: "ready",
      calibrationSource: "objective_cohort_context",
      hardActionEligibility: {
        cut: true,
      },
    });
    expect(result.selectedCell?.key.optimizationContext).toBe(
      "goal=PURCHASE|event=PURCHASE",
    );
    expect(result.profile?.commercialStopLossSpendUnit).toBeNull();
    expect(result.profile?.commercialStopLossThresholds).toBeNull();
    expect(
      result.profile?.commercialStopLossCanonicalHardActionEligibility,
    ).toBeNull();
    expect(result.profile?.expandedEconomicCutAuthority).toEqual({
      eligible: true,
      authorityBasis: "calibrated_relative_with_economic_stop_loss",
      reason: null,
    });
    if (!result.profile) throw new Error("Expected a ready native profile.");
    expect(result.profile.thresholds.bottomQuartileRatio).toBeLessThan(0.5);
    const expandedDecision = decideCreative(
      makeCreativeInput({
        effectiveCohort: "purchase",
        targetRoas: 2,
        breakevenRoas: 1.5,
        spend: 500,
        purchases: 5,
        purchaseValue: 500,
        roas: 1,
        recent7dSpend: 100,
        recent7dPurchases: 1,
        recent7dRoas: 1,
        linkClicks: 100,
        landingPageViews: 80,
        addToCart: 20,
        initiateCheckout: 10,
      }),
      result.profile,
    );
    expect(expandedDecision.label).toBe("cut");
    expect(expandedDecision.reason).toContain("[economic stop-loss]");
  });

  it("fails closed on a missing native row without consulting any legacy calibration surface", async () => {
    const dataSource = new NativeOnlyProfileDataSource([]);

    const result = await resolveWith(dataSource);

    expect(result).toMatchObject({
      status: "fail_closed",
      reason: "native_calibration_missing",
      calibrationSource: null,
      profile: null,
      hardActionEligibility: {
        scale: false,
        cut: false,
        refresh: false,
      },
    });
    expect(dataSource.calibrationCalls).toHaveLength(1);
    expect(dataSource.targetCalls).toBe(0);
    expect(READ_NATIVE_AD_ACCOUNT_CALIBRATION_CELL_SQL).toContain(
      `JOIN ${NATIVE_AD_CALIBRATION_TABLE} calibration`,
    );
    expect(READ_NATIVE_AD_ACCOUNT_CALIBRATION_CELL_SQL).not.toContain(
      "engine_v3_account_calibration_daily",
    );
    expect(READ_NATIVE_AD_ACCOUNT_CALIBRATION_CELL_SQL).not.toContain(
      "meta_creative_daily",
    );
  });

  it("uses only the explicitly named account-cohort native fallback cell", async () => {
    const dataSource = new NativeOnlyProfileDataSource(
      buildMixedOptimizationCells().filter(
        (cell) => cell.key.cellScope === "account_objective_cohort",
      ),
    );

    const result = await resolveWith(dataSource, {
      fallbackPolicy: NATIVE_AD_ACCOUNT_FALLBACK_CELL,
    });

    expect(result).toMatchObject({
      status: "ready",
      calibrationSource: "account_objective_cohort",
      fallbackPolicy: NATIVE_AD_ACCOUNT_FALLBACK_CELL,
    });
    expect(result.selectedCell?.matureAdCount).toBe(30);
    expect(result.hardActionEligibility).toMatchObject({
      scale: false,
      cut: false,
      refresh: false,
    });
    expect(dataSource.calibrationCalls).toHaveLength(2);
    expect(dataSource.calibrationCalls[1]).toMatchObject({
      cellScope: "account_objective_cohort",
      objective: "OUTCOME_SALES",
      optimizationContext: NATIVE_AD_ACCOUNT_WIDE_OPTIMIZATION_CONTEXT,
      providerAccountId: "act-native",
      accountTimezone: "Europe/Istanbul",
      accountCurrency: "USD",
      cohort: "purchase",
    });
  });

  it("keeps a missing exact cell fail-closed under the thin-exact policy", async () => {
    const dataSource = new NativeOnlyProfileDataSource(
      buildMixedOptimizationCells().filter(
        (cell) => cell.key.cellScope === "account_objective_cohort",
      ),
    );

    const result = await resolveWith(dataSource, {
      fallbackPolicy: NATIVE_AD_THIN_EXACT_FALLBACK_CELL,
    });

    expect(result).toMatchObject({
      status: "fail_closed",
      reason: "native_calibration_missing",
      calibrationSource: null,
    });
    expect(dataSource.calibrationCalls).toHaveLength(1);
  });

  it("keeps low-sample scale and refresh soft-only while preserving commercial stop-loss cut authority", async () => {
    const dataSource = new NativeOnlyProfileDataSource(buildCells(10));

    const result = await resolveWith(dataSource, {
      fallbackPolicy: NATIVE_AD_THIN_EXACT_FALLBACK_CELL,
    });

    expect(result).toMatchObject({
      status: "ready",
      reason: null,
      calibrationSource: "objective_cohort_context",
      hardActionEligibility: {
        scale: false,
        cut: true,
        refresh: false,
      },
    });
    expect(result.hardActionEligibility.reasons).toMatchObject({
      scale: "native_ad_calibration:scale_calibration_sample_low",
      cut: null,
      refresh: "native_ad_calibration:refresh_calibration_sample_low",
    });
    expect(result.selectedCell?.actionReadiness.cut).toEqual({
      ready: true,
      reason: null,
      authorityBasis: "commercial_stop_loss",
      observedSampleCount: 10,
      requiredSampleCount: 0,
    });
    expect(dataSource.targetCalls).toBe(1);
    expect(dataSource.calibrationCalls).toHaveLength(1);
  });

  it("repairs the thin exact Cut veto with account/currency AOV without opening Scale or Refresh", async () => {
    const cells = buildAccountAovAuthorityCells({
      exactCount: 5,
      accountOnlyCount: 15,
    });
    const dataSource = new NativeOnlyProfileDataSource(
      cells,
      AOV_ONLY_TARGET,
    );

    const result = await resolveWith(dataSource, {
      fallbackPolicy: NATIVE_AD_THIN_EXACT_FALLBACK_CELL,
    });

    expect(result).toMatchObject({
      status: "ready",
      calibrationSource: "objective_cohort_context",
      hardActionEligibility: {
        scale: false,
        cut: true,
        refresh: false,
      },
    });
    expect(result.profile?.spendUnitConfidence).toBe("low");
    expect(result.profile?.commercialStopLossSpendUnit).toMatchObject({
      spendUnitSource: "meta_derived_aov",
      spendUnitConfidence: "medium",
      hardEligibleByDefault: true,
    });
    expect(result.profile?.commercialStopLossThresholds).not.toEqual(
      result.profile?.thresholds,
    );
    expect(result.hardActionEligibility.reasons).toMatchObject({
      cut: null,
      scale: "native_ad_calibration:scale_calibration_sample_low",
      refresh: "native_ad_calibration:refresh_calibration_sample_low",
    });
  });

  it("keeps the thin exact profile fail-closed when account/currency AOV has only 19 purchases", async () => {
    const dataSource = new NativeOnlyProfileDataSource(
      buildAccountAovAuthorityCells({ exactCount: 5, accountOnlyCount: 14 }),
      AOV_ONLY_TARGET,
    );

    const result = await resolveWith(dataSource, {
      fallbackPolicy: NATIVE_AD_THIN_EXACT_FALLBACK_CELL,
    });

    expect(result).toMatchObject({
      status: "ready",
      hardActionEligibility: {
        scale: false,
        cut: false,
        refresh: false,
      },
    });
    expect(result.profile?.commercialStopLossSpendUnit).toBeNull();
    expect(result.hardActionEligibility.reasons?.cut).toBe(
      "native_ad_calibration:commercial_spend_unit_authority_missing",
    );
    expect(result.profile?.expandedEconomicCutAuthority).toEqual({
      eligible: false,
      authorityBasis: null,
      reason:
        "native_ad_calibration:commercial_spend_unit_authority_missing",
    });
  });

  it("uses ready exact-context AOV without borrowing the account-wide repair overlay", async () => {
    const cells = computeNativeAdCalibrationBatch({
      businessId: BUSINESS_ID,
      providerAccountRefId: PROVIDER_ACCOUNT_REF_ID,
      providerAccountId: "act-native",
      asOf: AS_OF,
      computationCutoff: "2026-07-12T03:05:00.000Z",
      sourceRows: Array.from({ length: 12 }, (_, index) =>
        makeSourceRow(index + 1, {
          sourceRowId: `ready-aov-p25-null-${index}`,
          adId: `ready-aov-p25-null-${index}`,
          conversions: 2,
          revenue: 160,
        }),
      ),
      targetAuthority: AOV_ONLY_TARGET,
    }).cells.map((cell) => ({
      ...cell,
      batchId: BATCH_ID,
      batchCompleteness: "complete" as const,
    }));
    const exact = cells.find(
      (cell) => cell.key.cellScope === "objective_cohort_context",
    );
    if (!exact) throw new Error("Expected an exact purchase cell.");
    expect(exact.accountCalibration).toMatchObject({
      metaAttributedAovPurchaseCount90d: 24,
      metaAovQuality: "ready",
      roasRatioP25: null,
    });
    expect(exact.actionReadiness.cut).toMatchObject({
      ready: true,
      authorityBasis: "commercial_stop_loss",
      requiredSampleCount: 0,
    });
    expect(
      commercialStopLossAovRepairAuthorityFromExactCell(exact),
    ).toBeNull();

    const result = await resolveWith(
      new NativeOnlyProfileDataSource(cells, AOV_ONLY_TARGET),
      { fallbackPolicy: NATIVE_AD_THIN_EXACT_FALLBACK_CELL },
    );

    expect(result).toMatchObject({
      status: "ready",
      hardActionEligibility: {
        scale: false,
        cut: true,
        refresh: false,
      },
    });
    expect(result.profile?.commercialStopLossSpendUnit).toBeNull();
    expect(result.profile?.commercialStopLossThresholds).toBeNull();
  });

  it("keeps a mature D049 exact cell entirely canonical even with physical account-AOV proof", async () => {
    const dataSource = new NativeOnlyProfileDataSource(
      buildCells(30, {}, AOV_ONLY_TARGET),
      AOV_ONLY_TARGET,
    );

    const result = await resolveWith(dataSource);

    expect(result.hardActionEligibility).toMatchObject({
      scale: true,
      cut: true,
      refresh: true,
    });
    expect(result.selectedCell?.actionReadiness.cut.authorityBasis).toBe(
      "calibrated_relative_with_economic_stop_loss",
    );
    expect(result.profile?.commercialStopLossThresholds).toBeNull();
    expect(result.profile?.commercialStopLossSpendUnit).toBeNull();
    expect(
      result.profile?.commercialStopLossCanonicalHardActionEligibility,
    ).toBeNull();
  });

  it("does not let target age select a pooled account cell", async () => {
    const cells = computeNativeAdCalibrationBatch({
      businessId: BUSINESS_ID,
      providerAccountRefId: PROVIDER_ACCOUNT_REF_ID,
      providerAccountId: "act-native",
      asOf: AS_OF,
      computationCutoff: "2026-07-12T03:05:00.000Z",
      sourceRows: Array.from({ length: 20 }, (_, index) =>
        makeSourceRow(index + 1, {
          optimizationGoal: index < 5 ? "PURCHASE" : "VALUE",
          customEventType: index < 5 ? "PURCHASE" : "VALUE",
        }),
      ),
      targetAuthority: STALE_TARGET,
    }).cells.map((cell) => ({
      ...cell,
      batchId: BATCH_ID,
      batchCompleteness: "complete" as const,
    }));
    const dataSource = new NativeOnlyProfileDataSource(cells, STALE_TARGET);

    const result = await resolveWith(dataSource, {
      fallbackPolicy: NATIVE_AD_THIN_EXACT_FALLBACK_CELL,
    });

    expect(result).toMatchObject({
      status: "ready",
      calibrationSource: "objective_cohort_context",
      hardActionEligibility: { scale: false, cut: true, refresh: false },
    });
    expect(result.selectedCell?.matureAdCount).toBe(5);
    expect(dataSource.calibrationCalls).toHaveLength(1);
  });

  it("keeps an old valid target authoritative in a mature exact cell", async () => {
    const dataSource = new NativeOnlyProfileDataSource(
      buildCells(30, {}, STALE_TARGET),
      STALE_TARGET,
    );

    const result = await resolveWith(dataSource);

    expect(result).toMatchObject({
      status: "ready",
      reason: null,
      calibrationSource: "objective_cohort_context",
      hardActionEligibility: { scale: true, cut: true, refresh: true },
    });
    expect(result.profile?.quality).toMatchObject({
      commercialTruthReady: true,
      commercialTruthFreshness: "stale",
    });
  });

  it("intersects retained authority with the exact cell per action instead of collapsing the whole profile", async () => {
    const targetWithoutBreakEven = {
      ...FRESH_TARGET,
      breakEvenRoas: null,
    };
    const dataSource = new NativeOnlyProfileDataSource(
      buildCells(30, {}, targetWithoutBreakEven),
      targetWithoutBreakEven,
    );

    const result = await resolveWith(dataSource);

    expect(result).toMatchObject({
      status: "ready",
      calibrationSource: "objective_cohort_context",
      hardActionEligibility: {
        scale: true,
        cut: false,
        refresh: true,
      },
    });
    expect(result.hardActionEligibility.reasons?.cut).toBe(
      "native_ad_calibration:break_even_roas_authority_missing",
    );
  });

  it("rejects an uncompleted batch before any target or retained-profile read", async () => {
    const cells = buildCells(30).map((cell) => ({
      ...cell,
      batchCompleteness: "computed" as const,
    }));
    const dataSource = new NativeOnlyProfileDataSource(cells);

    const result = await resolveWith(dataSource);

    expect(result).toMatchObject({
      status: "fail_closed",
      reason: "native_calibration_contract_invalid",
      profile: null,
    });
    expect(dataSource.targetCalls).toBe(0);
  });

  it("rejects persisted action-readiness JSON that does not recompute from the cell evidence", async () => {
    const cells = buildCells(10).map((cell) => ({
      ...cell,
      actionReadiness: {
        ...cell.actionReadiness,
        scale: {
          ...cell.actionReadiness.scale,
          ready: true,
          reason: null,
        },
      },
    }));
    const dataSource = new NativeOnlyProfileDataSource(cells);

    const result = await resolveWith(dataSource);

    expect(result).toMatchObject({
      status: "fail_closed",
      reason: "native_calibration_contract_invalid",
    });
    expect(dataSource.targetCalls).toBe(0);
  });

  it("rejects a self-consistent rehashed account-AOV proof that breaks the persisted cell manifest", async () => {
    const cells = buildAccountAovAuthorityCells({
      exactCount: 5,
      accountOnlyCount: 14,
    }).map((cell) => {
      const original = cell.actionReadiness.spendUnitAuthority;
      const forgedWithoutHash = {
        ...original,
        status: "ready" as const,
        basis: "physical_account_purchase_aov_90d" as const,
        baseSpendUnit: 50,
        accountAovEvidence: {
          ...original.accountAovEvidence,
          status: "ready" as const,
          observedPurchaseCount: 20,
          revenueBackedRowCount: 20,
          canonicalRowCount: 20,
          totalRevenue: 2_000,
          meanAov: 100,
          evidenceHash: "f".repeat(64),
        },
        authorityHash: "0".repeat(64),
      };
      const forged = {
        ...forgedWithoutHash,
        authorityHash:
          recomputeNativeAdSpendUnitAuthorityHash(forgedWithoutHash),
      };
      return {
        ...cell,
        actionReadiness: {
          ...cell.actionReadiness,
          spendUnitAuthority: forged,
          cut: {
            ready: true,
            reason: null,
            authorityBasis: "commercial_stop_loss" as const,
            observedSampleCount:
              cell.actionReadiness.cut.observedSampleCount,
            requiredSampleCount: 0,
          },
        },
      };
    });
    const dataSource = new NativeOnlyProfileDataSource(
      cells,
      AOV_ONLY_TARGET,
    );

    const result = await resolveWith(dataSource, {
      fallbackPolicy: NATIVE_AD_THIN_EXACT_FALLBACK_CELL,
    });

    expect(result).toMatchObject({
      status: "fail_closed",
      reason: "native_calibration_contract_invalid",
    });
    expect(dataSource.targetCalls).toBe(0);
  });

  it("rejects a structurally valid commercial stop-loss proof when the cell has calibrated relative evidence", async () => {
    const cells = buildCells(30).map((cell) => ({
      ...cell,
      actionReadiness: {
        ...cell.actionReadiness,
        cut: {
          ready: true,
          reason: null,
          authorityBasis: "commercial_stop_loss" as const,
          observedSampleCount: cell.actionReadiness.cut.observedSampleCount,
          requiredSampleCount: 0,
        },
      },
    }));
    const dataSource = new NativeOnlyProfileDataSource(cells);

    const result = await resolveWith(dataSource);

    expect(result).toMatchObject({
      status: "fail_closed",
      reason: "native_calibration_contract_invalid",
    });
    expect(dataSource.targetCalls).toBe(0);
  });

  it("rejects a low-sample cell that carries an untrusted positive P25 into the commercial path", async () => {
    const cells = buildCells(10).map((cell) => ({
      ...cell,
      accountCalibration: {
        ...cell.accountCalibration,
        roasRatioP25: 0.9,
      },
    }));
    const dataSource = new NativeOnlyProfileDataSource(cells);

    const result = await resolveWith(dataSource);

    expect(result).toMatchObject({
      status: "fail_closed",
      reason: "native_calibration_contract_invalid",
    });
    expect(dataSource.targetCalls).toBe(0);
  });

  it("keeps a non-purchase native cohort separate and refuses ROAS profile authority", async () => {
    const trafficCells = buildCells(30, {
      campaignId: "campaign-traffic",
      adsetId: "adset-traffic",
      objective: "OUTCOME_TRAFFIC",
      optimizationGoal: "LINK_CLICKS",
      customEventType: null,
      conversions: 0,
      revenue: 0,
    });
    const dataSource = new NativeOnlyProfileDataSource(trafficCells);

    const result = await resolveWith(dataSource, {
      objective: "OUTCOME_TRAFFIC",
      optimizationGoal: "LINK_CLICKS",
      customEventType: null,
      cohort: "traffic",
    });

    expect(result).toMatchObject({
      status: "fail_closed",
      reason: "native_non_purchase_roas_unsupported",
      calibrationSource: "objective_cohort_context",
      profile: null,
    });
    expect(result.selectedCell?.accountCalibration.roasRatioP25).toBeNull();
    expect(dataSource.targetCalls).toBe(0);
  });

  it("rejects a fresh target whose authority hash differs from the calibration row", async () => {
    const dataSource = new NativeOnlyProfileDataSource(buildCells(30), {
      ...FRESH_TARGET,
      targetRoas: 2.1,
    });

    const result = await resolveWith(dataSource);

    expect(result).toMatchObject({
      status: "fail_closed",
      reason: "native_target_authority_mismatch",
      profile: null,
    });
    expect(result.hardActionEligibility.scale).toBe(false);
  });

  it("selects only the latest complete batch for the requested date", () => {
    expect(READ_NATIVE_AD_ACCOUNT_CALIBRATION_CELL_SQL).toContain(
      "batch.as_of_date = $9::date",
    );
    expect(READ_NATIVE_AD_ACCOUNT_CALIBRATION_CELL_SQL).toContain(
      "policy_version = $11",
    );
    expect(READ_NATIVE_AD_ACCOUNT_CALIBRATION_CELL_SQL).toContain(
      "ORDER BY batch.as_of_cutoff DESC, batch.id DESC",
    );
  });
});
