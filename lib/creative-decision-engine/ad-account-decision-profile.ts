import { resolveAccountDecisionProfile } from "./account-decision-profile";
import type {
  BusinessTargetPack,
  CreativeDecisionDataSource,
  DecisionCalibrationProfileConfig,
} from "./data-source";
import type { EngineV3Flags } from "./feature-flags";
import {
  NATIVE_AD_ENGINE_VERSION,
  type AccountDecisionProfile,
  type HardActionEligibility,
} from "./types";
import {
  buildNativeAdOptimizationContext,
  NATIVE_AD_ACCOUNT_WIDE_OPTIMIZATION_CONTEXT,
  NATIVE_AD_CALIBRATION_BATCH_TABLE,
  NATIVE_AD_FUNNEL_METRIC_SAMPLE_FLOOR,
  NATIVE_AD_CALIBRATION_POLICY_VERSION,
  NATIVE_AD_CALIBRATION_TABLE,
  resolveNativeAdCalibrationDate,
  resolveNativeAdCalibrationActionReadiness,
  resolveNativeAdTargetAuthority,
  type NativeAdCalibrationCell,
  type NativeAdCalibrationCellKey,
  type NativeAdCalibrationCellScope,
  type NativeAdTargetAuthorityInput,
} from "./jobs/ad-calibration-job";
import type { MetaFunnelCohort } from "@/lib/meta/funnel-cohort";

function positiveFinite(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export const NATIVE_AD_ACCOUNT_FALLBACK_CELL =
  "provider_account_currency_objective_cohort_all_optimization_contexts" as const;
export const NATIVE_AD_THIN_EXACT_FALLBACK_CELL =
  "thin_exact_provider_account_currency_objective_cohort_all_optimization_contexts" as const;

export type NativeAdAccountProfileFallbackPolicy =
  | "fail_closed"
  | typeof NATIVE_AD_ACCOUNT_FALLBACK_CELL
  | typeof NATIVE_AD_THIN_EXACT_FALLBACK_CELL;

export type NativeAdAccountProfileFailureReason =
  | "native_calibration_missing"
  | "native_calibration_low_sample"
  | "native_calibration_contract_invalid"
  | "native_account_fallback_missing"
  | "native_account_fallback_low_sample"
  | "native_non_purchase_roas_unsupported"
  | "native_target_authority_missing"
  | "native_target_authority_stale"
  | "native_target_authority_cutoff_unsafe"
  | "native_target_authority_mismatch";

export interface NativeAdCalibrationCellQuery {
  businessId: string;
  providerAccountId: string;
  accountTimezone: string;
  accountCurrency: string;
  cellScope: NativeAdCalibrationCellScope;
  objective: string;
  cohort: MetaFunnelCohort;
  optimizationContext: string;
  asOfDate: string;
  engineVersion: string;
  policyVersion: string;
}

/**
 * Native producer dependency boundary. There is deliberately no creative or
 * legacy calibration method on this interface.
 */
export interface NativeAdAccountProfileDataSource {
  getNativeAdCalibrationCell(
    input: NativeAdCalibrationCellQuery,
  ): Promise<NativeAdCalibrationCell | null>;
  getNativeTargetAuthorityAsOf(input: {
    businessId: string;
    providerAccountRefId: string;
    providerAccountId: string;
    asOfCutoff: string;
  }): Promise<NativeAdTargetAuthorityInput | null>;
  getNativeDecisionCalibrationProfileAsOf?(input: {
    businessId: string;
    asOfCutoff: string;
    channel: "meta";
    objectiveFamily: "sales";
  }): Promise<DecisionCalibrationProfileConfig | null>;
}

export interface ResolveNativeAdAccountProfileInput {
  businessId: string;
  providerAccountId: string;
  accountTimezone: string;
  accountCurrency: string;
  objective: string;
  optimizationGoal: string | null;
  customEventType: string | null;
  cohort: MetaFunnelCohort;
  asOf: string;
  dataSource: NativeAdAccountProfileDataSource;
  flags: EngineV3Flags;
  fallbackPolicy?: NativeAdAccountProfileFallbackPolicy;
}

export interface NativeAdAccountProfileResult {
  status: "ready" | "fail_closed";
  reason: NativeAdAccountProfileFailureReason | null;
  calibrationSource: NativeAdCalibrationCellScope | null;
  fallbackPolicy: NativeAdAccountProfileFallbackPolicy;
  requestedCell: NativeAdCalibrationCellQuery;
  selectedCell: NativeAdCalibrationCell | null;
  profile: AccountDecisionProfile | null;
  hardActionEligibility: HardActionEligibility;
}

export const READ_NATIVE_AD_ACCOUNT_CALIBRATION_CELL_SQL = `
/* native-ad-profile-cell: latest complete generation for one exact physical binding/date */
WITH exact_binding AS (
  SELECT DISTINCT
    binding.provider_account_ref_id,
    binding.provider_account_id
  FROM business_provider_accounts binding
  JOIN provider_accounts account
    ON account.id = binding.provider_account_ref_id
   AND account.external_account_id = binding.provider_account_id
  WHERE binding.business_id = $1
    AND binding.provider = 'meta'
    AND binding.provider_account_id = $2
    -- Current selection; the JOIN already pins physical identity.
    AND binding.is_selected
), latest_batch AS (
  SELECT batch.*
  FROM ${NATIVE_AD_CALIBRATION_BATCH_TABLE} batch
  JOIN exact_binding binding
    ON binding.provider_account_ref_id = batch.provider_account_ref_id
   AND binding.provider_account_id = batch.provider_account_id
  WHERE batch.business_ref_id = $1::uuid
    AND batch.business_id = $1
    AND batch.provider = 'meta'
    AND batch.as_of_date = $9::date
    AND batch.engine_version = $10
    AND batch.policy_version = $11
    AND batch.completeness_status = 'complete'
  ORDER BY batch.as_of_cutoff DESC, batch.id DESC
  LIMIT 1
)
SELECT
  calibration.*,
  calibration.business_ref_id::text AS business_id,
  calibration.as_of_date::text AS as_of_date,
  calibration.sample_window_start::text AS sample_window_start,
  calibration.sample_window_end::text AS sample_window_end,
  calibration.source_min_date::text AS source_min_date,
  calibration.source_max_date::text AS source_max_date,
  batch.completeness_status AS batch_completeness,
  batch.expected_cell_count AS batch_cell_count,
  batch.cell_set_hash AS batch_cell_set_hash
FROM latest_batch batch
JOIN ${NATIVE_AD_CALIBRATION_TABLE} calibration
  ON batch.id = calibration.batch_id
 AND batch.business_ref_id = calibration.business_ref_id
 AND batch.business_id = calibration.business_id
 AND batch.provider = calibration.provider
 AND batch.provider_account_ref_id = calibration.provider_account_ref_id
 AND batch.provider_account_id = calibration.provider_account_id
 AND batch.as_of_date = calibration.as_of_date
 AND batch.as_of_cutoff = calibration.as_of_cutoff
 AND batch.engine_version = calibration.engine_version
 AND batch.policy_version = calibration.policy_version
 AND batch.input_manifest_hash = calibration.batch_input_manifest_hash
 AND batch.source_manifest_hash = calibration.source_manifest_hash
WHERE calibration.business_ref_id = $1::uuid
  AND calibration.business_id = $1
  AND calibration.provider = 'meta'
  AND calibration.provider_account_id = $2
  AND calibration.account_timezone = $3
  AND calibration.account_currency = $4
  AND calibration.cell_scope = $5
  AND calibration.objective = $6
  AND calibration.funnel_cohort = $7
  AND calibration.optimization_context = $8
  AND calibration.as_of_date = $9::date
  AND calibration.engine_version = $10
  AND calibration.policy_version = $11
ORDER BY calibration.computed_at DESC, calibration.id DESC
LIMIT 1
`;

export async function resolveNativeAdAccountDecisionProfile(
  input: ResolveNativeAdAccountProfileInput,
): Promise<NativeAdAccountProfileResult> {
  const cutoff = resolveNativeAdCalibrationDate(input.asOf);
  const businessId = requiredText(input.businessId, "businessId");
  const providerAccountId = requiredText(
    input.providerAccountId,
    "providerAccountId",
  );
  const accountTimezone = requiredText(
    input.accountTimezone,
    "accountTimezone",
  );
  const accountCurrency = normalizeToken(
    requiredText(input.accountCurrency, "accountCurrency"),
  );
  const objective = normalizeToken(requiredText(input.objective, "objective"));
  const optimizationContext = buildNativeAdOptimizationContext(
    input.optimizationGoal,
    input.customEventType,
  );
  if (optimizationContext === null) {
    throw new TypeError(
      "optimizationGoal or customEventType is required for native profile selection.",
    );
  }
  const fallbackPolicy = input.fallbackPolicy ?? "fail_closed";
  const requestedCell = buildQuery({
    businessId,
    providerAccountId,
    accountTimezone,
    accountCurrency,
    cellScope: "objective_cohort_context",
    objective,
    cohort: input.cohort,
    optimizationContext,
    asOfDate: cutoff.asOfDate,
  });
  const exactCell =
    await input.dataSource.getNativeAdCalibrationCell(requestedCell);
  const exactValidation = validateCell(exactCell, requestedCell);
  if (exactValidation === "invalid") {
    return failClosed({
      reason: "native_calibration_contract_invalid",
      fallbackPolicy,
      requestedCell,
      selectedCell: exactCell,
    });
  }
  if (exactCell !== null && input.cohort !== "purchase") {
    return failClosed({
      reason: "native_non_purchase_roas_unsupported",
      fallbackPolicy,
      requestedCell,
      selectedCell: exactCell,
    });
  }

  let selectedCell = exactCell;
  let calibrationSource: NativeAdCalibrationCellScope | null =
    exactCell === null ? null : "objective_cohort_context";

  if (
    exactCell !== null &&
    (fallbackPolicy === NATIVE_AD_ACCOUNT_FALLBACK_CELL ||
      fallbackPolicy === NATIVE_AD_THIN_EXACT_FALLBACK_CELL) &&
    (!exactCell.targetAuthority.targetRoasAuthority ||
      !exactCell.targetAuthority.breakEvenRoasAuthority) &&
    exactCell.matureAdCount < 10
  ) {
    const fallbackQuery = buildQuery({
      ...requestedCell,
      cellScope: "account_objective_cohort",
      optimizationContext: NATIVE_AD_ACCOUNT_WIDE_OPTIMIZATION_CONTEXT,
    });
    const fallbackCell =
      await input.dataSource.getNativeAdCalibrationCell(fallbackQuery);
    const fallbackValidation = validateCell(fallbackCell, fallbackQuery);
    if (
      fallbackValidation === "valid" &&
      fallbackCell !== null &&
      fallbackCell.matureAdCount >= 10 &&
      positiveFinite(fallbackCell.accountCalibration.roasP60)
    ) {
      selectedCell = fallbackCell;
      calibrationSource = "account_objective_cohort";
    }
  }

  if (exactCell === null) {
    if (
      fallbackPolicy === "fail_closed" ||
      fallbackPolicy === NATIVE_AD_THIN_EXACT_FALLBACK_CELL
    ) {
      return failClosed({
        reason: "native_calibration_missing",
        fallbackPolicy,
        requestedCell,
        selectedCell: null,
      });
    }

    const fallbackQuery = buildQuery({
      ...requestedCell,
      cellScope: "account_objective_cohort",
      optimizationContext: NATIVE_AD_ACCOUNT_WIDE_OPTIMIZATION_CONTEXT,
    });
    const fallbackCell =
      await input.dataSource.getNativeAdCalibrationCell(fallbackQuery);
    const fallbackValidation = validateCell(fallbackCell, fallbackQuery);
    if (fallbackValidation === "invalid") {
      return failClosed({
        reason: "native_calibration_contract_invalid",
        fallbackPolicy,
        requestedCell,
        selectedCell: fallbackCell,
      });
    }
    if (fallbackCell === null) {
      return failClosed({
        reason: "native_account_fallback_missing",
        fallbackPolicy,
        requestedCell,
        selectedCell: null,
      });
    }
    selectedCell = fallbackCell;
    calibrationSource = "account_objective_cohort";
  }

  if (selectedCell === null) {
    return failClosed({
      reason: "native_calibration_missing",
      fallbackPolicy,
      requestedCell,
      selectedCell: null,
    });
  }
  if (input.cohort !== "purchase") {
    return failClosed({
      reason: "native_non_purchase_roas_unsupported",
      fallbackPolicy,
      requestedCell,
      selectedCell,
    });
  }

  const targetInput = await input.dataSource.getNativeTargetAuthorityAsOf({
    businessId,
    providerAccountRefId: selectedCell.key.providerAccountRefId,
    providerAccountId,
    asOfCutoff: selectedCell.asOfCutoff,
  });
  const targetAuthority = resolveNativeAdTargetAuthority(
    targetInput,
    selectedCell.asOfCutoff,
  );
  if (
    selectedCell.targetAuthority.status !== targetAuthority.status ||
    selectedCell.targetAuthority.authorityHash !== targetAuthority.authorityHash
  ) {
    return failClosed({
      reason: "native_target_authority_mismatch",
      fallbackPolicy,
      requestedCell,
      selectedCell,
    });
  }

  const profileConfig = input.dataSource.getNativeDecisionCalibrationProfileAsOf
    ? await input.dataSource.getNativeDecisionCalibrationProfileAsOf({
        businessId,
        asOfCutoff: selectedCell.asOfCutoff,
        channel: "meta",
        objectiveFamily: "sales",
      })
    : null;
  const compatibilityDataSource = buildCompatibilityDataSource({
    selectedCell,
    targetPack: targetAuthorityToBusinessTargetPack(targetAuthority),
    profileConfig,
  });
  const retainedProfile = await resolveAccountDecisionProfile({
    businessId,
    asOf: cutoff.asOfDate,
    dataSource: compatibilityDataSource,
    flags: input.flags,
  });
  const hardActionEligibility = intersectNativeActionReadiness({
    retained: retainedProfile.hardActionEligibility,
    readiness: selectedCell.actionReadiness,
  });
  const profile: AccountDecisionProfile = {
    ...retainedProfile,
    scope: { type: "account", id: selectedCell.key.providerAccountId },
    hardActionEligibility,
  };

  return {
    status: "ready",
    reason: null,
    calibrationSource,
    fallbackPolicy,
    requestedCell,
    selectedCell,
    profile,
    hardActionEligibility,
  };
}

function buildCompatibilityDataSource(input: {
  selectedCell: NativeAdCalibrationCell;
  targetPack: BusinessTargetPack;
  profileConfig: DecisionCalibrationProfileConfig | null;
}): CreativeDecisionDataSource {
  return {
    async getCreativeInput() {
      return null;
    },
    async getAccountCalibration() {
      return input.selectedCell.accountCalibration;
    },
    async getCampaignCalibration() {
      return { calibration: null, matureCreativeCount: null };
    },
    async getAccountFunnelCalibration() {
      return input.selectedCell.funnelCalibration;
    },
    async listCreativeInputs() {
      return [];
    },
    async getDataHealth() {
      throw new Error("Native profile math adapter does not read data health.");
    },
    async getLatestFunnelDiagnosis() {
      return null;
    },
    async getLatestOperatorResponse() {
      return null;
    },
    async getBusinessTargetPack() {
      return input.targetPack;
    },
    async getDecisionCalibrationProfile() {
      return input.profileConfig;
    },
    async getMetaAttributedAov() {
      const calibration = input.selectedCell.accountCalibration;
      return {
        aovMean: calibration.metaAttributedAovMean90d,
        purchaseCount: calibration.metaAttributedAovPurchaseCount90d,
        totalRevenue: calibration.metaAttributedRevenue90d,
        windowStart: input.selectedCell.sampleWindowStart,
        windowEnd: input.selectedCell.sampleWindowEnd,
      };
    },
  };
}

function targetAuthorityToBusinessTargetPack(
  authority: ReturnType<typeof resolveNativeAdTargetAuthority>,
): BusinessTargetPack {
  return {
    targetCpa: authority.targetCpa,
    targetRoas: authority.targetRoas,
    breakEvenCpa: authority.breakEvenCpa,
    breakEvenRoas: authority.breakEvenRoas,
    operatorAovAssumption: authority.operatorAovAssumption,
    defaultRiskPosture: authority.defaultRiskPosture,
    updatedAt: authority.effectiveAt,
    freshness:
      authority.status === "fresh"
        ? "fresh"
        : authority.status === "stale"
          ? "stale"
          : "unknown",
  };
}

function validateCell(
  cell: NativeAdCalibrationCell | null,
  query: NativeAdCalibrationCellQuery,
): "valid" | "invalid" | "missing" {
  if (cell === null) return "missing";
  const expected: NativeAdCalibrationCellKey = {
    businessId: query.businessId,
    providerAccountRefId: cell?.key.providerAccountRefId ?? "",
    providerAccountId: query.providerAccountId,
    accountTimezone: query.accountTimezone,
    accountCurrency: query.accountCurrency,
    cellScope: query.cellScope,
    objective: query.objective,
    cohort: query.cohort,
    optimizationContext: query.optimizationContext,
  };
  const identityMatches =
    cell.key.businessId === expected.businessId &&
    cell.key.providerAccountId === expected.providerAccountId &&
    cell.key.accountTimezone === expected.accountTimezone &&
    cell.key.accountCurrency === expected.accountCurrency &&
    cell.key.cellScope === expected.cellScope &&
    cell.key.objective === expected.objective &&
    cell.key.cohort === expected.cohort &&
    cell.key.optimizationContext === expected.optimizationContext;
  const contractMatches =
    typeof cell.batchId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      cell.batchId,
    ) &&
    cell.batchCompleteness === "complete" &&
    cell.batchCellCount > 0 &&
    /^[0-9a-f]{64}$/.test(cell.batchCellSetHash) &&
    cell.asOfDate === query.asOfDate &&
    cell.asOfCutoff.slice(0, 10) === query.asOfDate &&
    cell.computedAt === cell.asOfCutoff &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      cell.key.providerAccountRefId,
    ) &&
    cell.engineVersion === query.engineVersion &&
    cell.policyVersion === query.policyVersion &&
    cell.accountCalibration.businessId === query.businessId &&
    cell.accountCalibration.matureCreativeCount === cell.matureAdCount &&
    /^[0-9a-f]{64}$/.test(cell.batchInputManifestHash) &&
    /^[0-9a-f]{64}$/.test(cell.inputManifestHash) &&
    /^[0-9a-f]{64}$/.test(cell.sourceManifestHash) &&
    nativeCutBoundaryAuthorityMatchesCell(cell) &&
    (["scale", "cut", "refresh"] as const).every((action) => {
      const readiness = cell.actionReadiness[action];
      const validReadyBasis =
        readiness.ready &&
        (readiness.authorityBasis === "calibrated_relative"
          ? readiness.requiredSampleCount > 0 &&
            readiness.observedSampleCount >= readiness.requiredSampleCount
          : readiness.authorityBasis === "commercial_stop_loss" &&
            action === "cut" &&
            readiness.requiredSampleCount === 0);
      return (
        typeof readiness.ready === "boolean" &&
        Number.isInteger(readiness.observedSampleCount) &&
        readiness.observedSampleCount >= 0 &&
        Number.isInteger(readiness.requiredSampleCount) &&
        readiness.requiredSampleCount >= 0 &&
        (readiness.ready
          ? readiness.reason === null && validReadyBasis
          : readiness.reason !== null && readiness.authorityBasis === null)
      );
    }) &&
    nativeActionReadinessMatchesComputedCell(cell);
  return identityMatches && contractMatches ? "valid" : "invalid";
}

function nativeCutBoundaryAuthorityMatchesCell(
  cell: NativeAdCalibrationCell,
): boolean {
  const readiness = cell.actionReadiness.cut;
  if (!readiness.ready) return readiness.authorityBasis === null;
  const accountP25 = cell.accountCalibration.roasRatioP25;
  if (readiness.authorityBasis === "calibrated_relative") {
    return (
      cell.metricSampleCounts.roasRatio >=
        NATIVE_AD_FUNNEL_METRIC_SAMPLE_FLOOR && positiveFinite(accountP25)
    );
  }
  return (
    readiness.authorityBasis === "commercial_stop_loss" &&
    (accountP25 === null || accountP25 === 0)
  );
}

function nativeActionReadinessMatchesComputedCell(
  cell: NativeAdCalibrationCell,
) {
  const computed = resolveNativeAdCalibrationActionReadiness({
    key: cell.key,
    matureAdCount: cell.matureAdCount,
    metricSampleCounts: cell.metricSampleCounts,
    targetAuthority: cell.targetAuthority,
    accountCalibration: cell.accountCalibration,
  });
  return (["scale", "cut", "refresh"] as const).every((action) => {
    const stored = cell.actionReadiness[action];
    const expected = computed[action];
    return (
      stored.ready === expected.ready &&
      stored.reason === expected.reason &&
      stored.authorityBasis === expected.authorityBasis &&
      stored.observedSampleCount === expected.observedSampleCount &&
      stored.requiredSampleCount === expected.requiredSampleCount
    );
  });
}

function intersectNativeActionReadiness(input: {
  retained: HardActionEligibility;
  readiness: NativeAdCalibrationCell["actionReadiness"];
}): HardActionEligibility {
  const readinessReason = (action: "scale" | "cut" | "refresh") =>
    input.readiness[action].ready
      ? null
      : `native_ad_calibration:${input.readiness[action].reason ?? "not_ready"}`;
  const reasons = {
    scale:
      readinessReason("scale") ??
      input.retained.reasons?.scale ??
      (input.retained.scale ? null : input.retained.reason),
    cut:
      readinessReason("cut") ??
      input.retained.reasons?.cut ??
      (input.retained.cut ? null : input.retained.reason),
    refresh:
      readinessReason("refresh") ??
      input.retained.reasons?.refresh ??
      (input.retained.refresh ? null : input.retained.reason),
  };
  const scale = input.retained.scale && input.readiness.scale.ready;
  const cut = input.retained.cut && input.readiness.cut.ready;
  const refresh = input.retained.refresh && input.readiness.refresh.ready;
  return {
    scale,
    cut,
    refresh,
    reason:
      scale && cut && refresh
        ? null
        : (reasons.scale ?? reasons.cut ?? reasons.refresh),
    reasons,
  };
}

function buildQuery(input: {
  businessId: string;
  providerAccountId: string;
  accountTimezone: string;
  accountCurrency: string;
  cellScope: NativeAdCalibrationCellScope;
  objective: string;
  cohort: MetaFunnelCohort;
  optimizationContext: string;
  asOfDate: string;
}): NativeAdCalibrationCellQuery {
  return {
    ...input,
    engineVersion: NATIVE_AD_ENGINE_VERSION,
    policyVersion: NATIVE_AD_CALIBRATION_POLICY_VERSION,
  };
}

function failClosed(input: {
  reason: NativeAdAccountProfileFailureReason;
  fallbackPolicy: NativeAdAccountProfileFallbackPolicy;
  requestedCell: NativeAdCalibrationCellQuery;
  selectedCell: NativeAdCalibrationCell | null;
}): NativeAdAccountProfileResult {
  return {
    status: "fail_closed",
    reason: input.reason,
    calibrationSource: input.selectedCell?.key.cellScope ?? null,
    fallbackPolicy: input.fallbackPolicy,
    requestedCell: input.requestedCell,
    selectedCell: input.selectedCell,
    profile: null,
    hardActionEligibility: blockedHardActionEligibility(input.reason),
  };
}

function blockedHardActionEligibility(
  reason: NativeAdAccountProfileFailureReason,
): HardActionEligibility {
  const message = `native_ad_profile_fail_closed:${reason}`;
  return {
    scale: false,
    cut: false,
    refresh: false,
    reason: message,
    reasons: {
      scale: message,
      cut: message,
      refresh: message,
    },
  };
}

function requiredText(value: string, label: string) {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${label} is required.`);
  return normalized;
}

function normalizeToken(value: string) {
  return value.replace(/[\s-]+/g, "_").toUpperCase();
}
