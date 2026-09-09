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
  NATIVE_AD_ACCOUNT_AOV_PURCHASE_SAMPLE_FLOOR,
  NATIVE_AD_FUNNEL_METRIC_SAMPLE_FLOOR,
  NATIVE_AD_CALIBRATION_POLICY_VERSION,
  NATIVE_AD_CALIBRATION_TABLE,
  NATIVE_AD_SPEND_UNIT_AUTHORITY_CONTRACT_VERSION,
  NATIVE_AD_CALIBRATION_CONTRACT_VERSION,
  NATIVE_AD_CALIBRATION_LEGACY_UNKNOWN_CONTRACT,
  isNativeAdCalibrationReadableContract,
  nativeAdCalibrationDurablyRecomputable,
  isNativeAdTargetAuthorityCutoffSafe,
  resolveNativeAdCalibrationDate,
  resolveNativeAdCalibrationActionReadiness,
  resolveNativeAdTargetAuthority,
  recomputeNativeAdCalibrationCellInputManifestHash,
  recomputeNativeAdSpendUnitAuthorityHash,
  type NativeAdCalibrationCell,
  type NativeAdCalibrationCellKey,
  type NativeAdCalibrationCellScope,
  type NativeAdTargetAuthorityInput,
  type NativeAdSpendUnitAuthority,
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
  /**
   * The row is INTACT and re-derives exactly under its own contract — and that
   * contract is not the one this deployment mints. Distinct from
   * `native_calibration_contract_invalid`, which means the row does not verify
   * at all: one is "old", the other is "broken", and an operator debugging a
   * fail-closed account needs to know which.
   */
  | "native_calibration_contract_superseded"
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
  to_char(calibration.target_effective_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS target_effective_at,
  to_char(calibration.target_recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS target_recorded_at,
  batch.completeness_status AS batch_completeness,
  batch.expected_cell_count AS batch_cell_count,
  batch.cell_set_hash AS batch_cell_set_hash,
  batch.contract_version AS batch_contract_version
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
 /*
   ROUND 9 ITEM 5. A cell and its batch must agree about the contract they were
   written with. Enforced in the JOIN so a disagreeing pair does not resolve at
   all, rather than resolving and then being judged by whichever version the
   reader happened to look at first.
 */
 AND batch.contract_version = calibration.contract_version
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
  if (exactValidation === "superseded") {
    return failClosed({
      reason: "native_calibration_contract_superseded",
      fallbackPolicy,
      requestedCell,
      selectedCell: exactCell,
    });
  }
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
    selectedCell.targetAuthority.authorityHash !==
      targetAuthority.authorityHash ||
    !nativeSpendUnitAuthorityMatchesTarget(
      selectedCell.actionReadiness.spendUnitAuthority,
      targetAuthority,
    )
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
    // The selected cell and target were admitted at this exact cutoff. Passing
    // only the day would rewind commercial authority to the scheduled 03:00Z
    // boundary and hold targets saved later that morning. The compatibility
    // datasource is already bound to this cell; all canonical and stop-loss
    // checks must finish at its cutoff before exposing the calendar day below.
    asOf: selectedCell.asOfCutoff,
    dataSource: compatibilityDataSource,
    flags: input.flags,
    commercialStopLossAovAuthority:
      commercialStopLossAovRepairAuthorityFromExactCell(selectedCell),
  });
  const hardActionEligibility = intersectNativeActionReadiness({
    retained: retainedProfile.hardActionEligibility,
    readiness: selectedCell.actionReadiness,
  });
  const commercialStopLossCanonicalHardActionEligibility =
    retainedProfile.commercialStopLossCanonicalHardActionEligibility
      ? intersectNativeActionReadiness({
          retained:
            retainedProfile.commercialStopLossCanonicalHardActionEligibility,
          readiness: selectedCell.actionReadiness,
        })
      : null;
  const profile: AccountDecisionProfile = {
    ...retainedProfile,
    asOfDate: cutoff.asOfDate,
    scope: { type: "account", id: selectedCell.key.providerAccountId },
    hardActionEligibility,
    commercialStopLossCanonicalHardActionEligibility,
    expandedEconomicCutAuthority:
      expandedEconomicCutAuthorityFromNativeCell(selectedCell),
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

export function expandedEconomicCutAuthorityFromNativeCell(
  cell: NativeAdCalibrationCell,
): NonNullable<AccountDecisionProfile["expandedEconomicCutAuthority"]> {
  const readiness = cell.actionReadiness.cut;
  const authorityBasis = readiness.authorityBasis;
  const eligible =
    readiness.ready &&
    (authorityBasis ===
      "calibrated_relative_with_economic_stop_loss" ||
      authorityBasis === "commercial_stop_loss");
  return {
    eligible,
    authorityBasis: eligible ? authorityBasis : null,
    reason: eligible
      ? null
      : readiness.ready && authorityBasis === "calibrated_relative"
        ? "economic_spend_unit_authority_missing"
        : `native_ad_calibration:${readiness.reason ?? "cut_not_ready"}`,
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

export function targetAuthorityToBusinessTargetPack(
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

export function commercialStopLossAovAuthorityFromProof(
  authority: NativeAdSpendUnitAuthority,
) {
  const evidence = authority.accountAovEvidence;
  if (
    authority.status !== "ready" ||
    authority.basis !== "physical_account_purchase_aov_90d" ||
    evidence.status !== "ready" ||
    !positiveFinite(evidence.meanAov) ||
    !Number.isInteger(evidence.observedPurchaseCount) ||
    evidence.observedPurchaseCount <
      NATIVE_AD_ACCOUNT_AOV_PURCHASE_SAMPLE_FLOOR ||
    !positiveFinite(evidence.totalRevenue)
  ) {
    return null;
  }
  return {
    meanAov: evidence.meanAov,
    purchaseCount: evidence.observedPurchaseCount,
    totalRevenue: evidence.totalRevenue,
  };
}

/**
 * The account/currency AOV proof is a repair authority, not a second profile.
 * It is reachable only when the selected exact decision cell is itself thin
 * and its persisted Cut readiness explicitly names commercial stop-loss as
 * the zero-sample fallback authority. Mature/calibrated cells keep their
 * canonical D049 thresholds and authority byte-for-byte.
 */
export function commercialStopLossAovRepairAuthorityFromExactCell(
  cell: NativeAdCalibrationCell,
) {
  const cutReadiness = cell.actionReadiness.cut;
  const exactAovPurchaseCount =
    cell.accountCalibration.metaAttributedAovPurchaseCount90d;
  const exactAovIsThin =
    Number.isInteger(exactAovPurchaseCount) &&
    exactAovPurchaseCount >= 0 &&
    exactAovPurchaseCount < NATIVE_AD_ACCOUNT_AOV_PURCHASE_SAMPLE_FLOOR &&
    cell.accountCalibration.metaAovQuality !== "ready";
  const isExactRepairCell =
    cell.key.cellScope === "objective_cohort_context" &&
    exactAovIsThin &&
    cutReadiness.ready &&
    cutReadiness.authorityBasis === "commercial_stop_loss" &&
    cutReadiness.requiredSampleCount === 0;

  return isExactRepairCell
    ? commercialStopLossAovAuthorityFromProof(
        cell.actionReadiness.spendUnitAuthority,
      )
    : null;
}

function approximatelyEqual(
  left: number | null,
  right: number | null,
): boolean {
  if (left === null || right === null) return left === right;
  return (
    Number.isFinite(left) &&
    Number.isFinite(right) &&
    Math.abs(left - right) <= Math.max(1e-9, Math.abs(right) * 1e-9)
  );
}

function nativeSpendUnitAuthorityMatchesTarget(
  authority: NativeAdSpendUnitAuthority,
  target: ReturnType<typeof resolveNativeAdTargetAuthority>,
): boolean {
  /*
    A HISTORICAL AUTHORITY IS READABLE, NOT AUTHORITATIVE.

    The ladder below is TODAY's semantics. It was applied to every persisted
    authority regardless of the contract that minted it, so a `.v1`, `.v2` or
    `.v3` row — written when the rungs, the hashed content, or both, were
    different — was judged against a rule it was never produced under. Two
    outcomes, both wrong: a row minted under an older rung could be declared a
    match and go on to AUTHORIZE a current decision, and a row that was
    perfectly valid under its own contract could be declared a mismatch and
    take the whole native job down with `native_target_authority_mismatch`.

    Old versions stay parseable and their stored `authorityHash` stays
    verifiable — `.v1`/`.v2`/`.v3` are still READ, and the serializer still
    recomputes their digests under their own rules. What they may not do is
    authorize under semantics that are not theirs. Anything not minted by the
    current contract fails CLOSED here; the producer re-mints it on the next
    run, which is the safe direction and the only one that keeps "what
    authorized this decision" answerable.
  */
  if (
    authority.contractVersion !== NATIVE_AD_SPEND_UNIT_AUTHORITY_CONTRACT_VERSION
  ) {
    return false;
  }
  if (authority.targetAuthorityHash !== target.authorityHash) return false;
  let expectedBasis: NativeAdSpendUnitAuthority["basis"] = null;
  let expectedBaseSpendUnit: number | null = null;
  /*
    THE SAME SPLIT, IN THE SAME ORDER, AS `buildNativeAdSpendUnitAuthority` IN
    `lib/creative-decision-engine/jobs/ad-calibration-job.ts`.

    These two ladders are one rule read twice. When they disagree by a single
    rung this function returns false, `resolveNativeAdAccountDecisionProfile`
    raises `native_target_authority_mismatch`, and the whole native job rolls
    back — which is what took Grandmix, IwaStore and TheSwaf offline on
    2026-09-07 (117 failed `engine_v3_native_ad_decisions_shadow_job` runs in
    24h) when a store-observation lane existed here that the builder had already
    rejected on a cutoff test this side did not have. Anything changed below
    must be changed there in the same commit.

    `targetRoasAuthority` already folds in the cutoff test
    (`resolveNativeAdTargetAuthority`: `cutoffSafeStatus && positiveFinite`), so
    CASE 1 needs no separate `isNativeAdTargetAuthorityCutoffSafe` call and the
    two sides cannot drift on a clock comparison only one of them makes.
  */
  const targetRoas = target.targetRoas;
  const targetRoasAnchored =
    target.targetRoasAuthority && positiveFinite(targetRoas);
  if (targetRoasAnchored) {
    /*
      CASE 1 — A TARGET ROAS IS CONFIGURED: Meta's attributed AOV over that
      ratio, and nothing else. A legacy Target CPA and an operator AOV
      assumption are both present on `target` and neither is consulted.

      If Meta's AOV is not `ready` the expected basis stays null and the
      authority must be `blocked` — an explicit hold on missing Meta evidence,
      never a quiet substitution and never a fall back to the CPA.
    */
    if (
      authority.accountAovEvidence.status === "ready" &&
      positiveFinite(authority.accountAovEvidence.meanAov)
    ) {
      expectedBasis = "physical_account_purchase_aov_90d";
      expectedBaseSpendUnit =
        authority.accountAovEvidence.meanAov / targetRoas;
    }
  } else if (
    isNativeAdTargetAuthorityCutoffSafe(target.status) &&
    positiveFinite(target.targetCpa)
  ) {
    /*
      CASE 2 — NO TARGET ROAS: the legacy Target CPA, taken whole. Unchanged.

      `operator_aov` is expected nowhere now, because it only ever built
      `operatorAovAssumption / targetRoas` and CASE 1 owns every shape that
      carries a ratio. A persisted row naming it therefore matches no expected
      basis and fails CLOSED, exactly as `observed_shopify_aov` does.
    */
    expectedBasis = "target_cpa";
    expectedBaseSpendUnit = target.targetCpa;
  }
  return (
    authority.basis === expectedBasis &&
    authority.status === (expectedBasis === null ? "blocked" : "ready") &&
    approximatelyEqual(authority.baseSpendUnit, expectedBaseSpendUnit)
  );
}

function nativeSpendUnitAuthorityMatchesCell(
  cell: NativeAdCalibrationCell,
): boolean {
  const authority = cell.actionReadiness.spendUnitAuthority;
  const evidence = authority.accountAovEvidence;
  const integers = [
    evidence.observedPurchaseCount,
    evidence.requiredPurchaseCount,
    evidence.revenueBackedRowCount,
    evidence.canonicalRowCount,
    evidence.contradictoryRowCount,
    evidence.legacySchemaRowCount,
    evidence.unsupportedSchemaRowCount,
  ];
  /*
    FOUR contract versions are read; only `.v4` is minted.

    `.v1` predates the store source and carries no `observedShopifyAovEvidence`
    member. `.v2` carries one and HASHES it. `.v3` carries one and excludes it
    from identity. `.v4` — the current mint, and the version this file's own
    `expectedBasis` check is written against — carries the same exclusion and
    binds the authority through the semantic projection.
    `recomputeNativeAdSpendUnitAuthorityHash` applies each row's own rule, so a
    persisted row of any of the four still recomputes to the hash it was
    written with. Reading only the current version would have made every row
    written before the change unreadable, which is the migration this product
    deliberately does not do — old snapshots stay readable and are not
    backfilled.

    A version outside this set fails CLOSED here, BEFORE the recompute below is
    reached: `nativeAdSpendUnitAuthorityHashContent` throws on an unknown
    version rather than hashing an unknown shape, and this short-circuit is what
    turns that into a rejected profile instead of a thrown job.
  */
  if (
    /*
      STRUCTURAL / HASH verification admits every READABLE version, including
      `.v3`. It was omitted here, so minting `.v4` made every persisted `.v3`
      cell fail this check before its hash was ever recomputed — a row that is
      perfectly verifiable under its own contract read as structurally invalid.

      Whether such a cell may AUTHORIZE a current decision is a different
      question, and it is answered separately by the version gate in
      `nativeSpendUnitAuthorityMatchesTarget`. Readable here; not authoritative
      there.
    */
    (authority.contractVersion !==
      "engine-v3-native-ad-spend-unit-authority.v1" &&
      authority.contractVersion !==
        "engine-v3-native-ad-spend-unit-authority.v2" &&
      authority.contractVersion !==
        "engine-v3-native-ad-spend-unit-authority.v3" &&
      authority.contractVersion !==
        NATIVE_AD_SPEND_UNIT_AUTHORITY_CONTRACT_VERSION) ||
    authority.businessId !== cell.key.businessId ||
    authority.providerAccountRefId !== cell.key.providerAccountRefId ||
    authority.providerAccountId !== cell.key.providerAccountId ||
    authority.accountCurrency !== cell.key.accountCurrency ||
    authority.asOfCutoff !== cell.asOfCutoff ||
    authority.targetAuthorityHash !== cell.targetAuthority.authorityHash ||
    !/^[0-9a-f]{64}$/.test(authority.authorityHash) ||
    recomputeNativeAdSpendUnitAuthorityHash(authority) !==
      authority.authorityHash ||
    evidence.scope !== "business_provider_account_currency" ||
    evidence.businessId !== cell.key.businessId ||
    evidence.providerAccountRefId !== cell.key.providerAccountRefId ||
    evidence.providerAccountId !== cell.key.providerAccountId ||
    evidence.accountCurrency !== cell.key.accountCurrency ||
    evidence.sampleWindowStart !== cell.sampleWindowStart ||
    evidence.sampleWindowEnd !== cell.sampleWindowEnd ||
    evidence.asOfCutoff !== cell.asOfCutoff ||
    evidence.requiredPurchaseCount !==
      NATIVE_AD_ACCOUNT_AOV_PURCHASE_SAMPLE_FLOOR ||
    integers.some((value) => !Number.isInteger(value) || value < 0) ||
    evidence.contradictoryRowCount < evidence.unsupportedSchemaRowCount ||
    evidence.revenueBackedRowCount > evidence.canonicalRowCount ||
    evidence.observedPurchaseCount < evidence.revenueBackedRowCount ||
    evidence.observedPurchaseCount > 0 !== evidence.revenueBackedRowCount > 0 ||
    evidence.observedPurchaseCount > 0 !== evidence.totalRevenue > 0 ||
    !Number.isFinite(evidence.totalRevenue) ||
    evidence.totalRevenue < 0 ||
    !/^[0-9a-f]{64}$/.test(evidence.evidenceHash)
  ) {
    return false;
  }
  const expectedEvidenceStatus =
    evidence.contradictoryRowCount > 0
      ? "contradictory_purchase_truth"
      : evidence.observedPurchaseCount >= evidence.requiredPurchaseCount &&
          evidence.totalRevenue > 0
        ? "ready"
        : evidence.canonicalRowCount === 0
          ? "unavailable"
          : "insufficient_sample";
  const expectedMean =
    evidence.observedPurchaseCount > 0
      ? evidence.totalRevenue / evidence.observedPurchaseCount
      : null;
  const structurallyReady =
    authority.status === "ready" &&
    authority.basis !== null &&
    positiveFinite(authority.baseSpendUnit);
  return (
    evidence.status === expectedEvidenceStatus &&
    approximatelyEqual(evidence.meanAov, expectedMean) &&
    (authority.status === "ready"
      ? structurallyReady
      : authority.basis === null && authority.baseSpendUnit === null) &&
    (authority.basis !== "physical_account_purchase_aov_90d" ||
      evidence.status === "ready")
  );
}

function validateCell(
  cell: NativeAdCalibrationCell | null,
  query: NativeAdCalibrationCellQuery,
): "valid" | "invalid" | "missing" | "superseded" {
  if (cell === null) return "missing";
  /*
    ── ROUND 9 ITEM 5: THE ROW'S OWN CONTRACT, THEN THIS DEPLOYMENT'S ────────

    Two questions, asked in this order and never collapsed:

      1. Does this row re-derive under the contract it was WRITTEN with? That is
         an integrity question, and answering it with today's formula makes
         every historical row look corrupt.
      2. Is that contract the one this deployment mints? That is an AUTHORITY
         question, and a row can be perfectly intact and still not permitted to
         authorize a current decision.

    Before this, the runtime had no stored version at all: it recomputed
    everything with the current formula, so (1) silently answered (2) and the
    named reason was always `native_calibration_contract_invalid` — "broken" —
    for rows that were merely old.

    `legacy_unknown` reaches the same refusal by a different route: a row whose
    writer cannot be identified cannot be verified under any formula, so it is
    superseded rather than guessed at. @see
    NATIVE_AD_CALIBRATION_LEGACY_UNKNOWN_CONTRACT for the git evidence.
  */
  const stamped = cell.contractVersion;
  if (
    stamped === NATIVE_AD_CALIBRATION_LEGACY_UNKNOWN_CONTRACT ||
    !isNativeAdCalibrationReadableContract(stamped)
  ) {
    return "superseded";
  }
  if (stamped !== NATIVE_AD_CALIBRATION_CONTRACT_VERSION) {
    /*
      ── ROUND 10 ITEM 2 ─────────────────────────────────────────────────────
      Intact-or-not is worth knowing where it CAN be known. `.v3` re-derives
      from durable columns, so a `.v3` row that does not verify is corrupt and
      is reported as such — a different fact from "old".

      `.v1` and `.v2` cannot be re-derived from a database row at all: their
      manifest digested per-cell `observations`, which the table does not store.
      Attempting it would either throw or, worse, compare against a `.v3`-shaped
      digest and report a perfectly good historical row as corrupt. They are
      SUPERSEDED and unverifiable, and that is what is said.
    */
    if (!nativeAdCalibrationDurablyRecomputable(stamped)) return "superseded";
    return recomputeNativeAdCalibrationCellInputManifestHash(cell, stamped) ===
      cell.inputManifestHash
      ? "superseded"
      : "invalid";
  }
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
    recomputeNativeAdCalibrationCellInputManifestHash(cell, stamped) ===
      cell.inputManifestHash &&
    /^[0-9a-f]{64}$/.test(cell.sourceManifestHash) &&
    nativeSpendUnitAuthorityMatchesCell(cell) &&
    nativeCutBoundaryAuthorityMatchesCell(cell) &&
    (["scale", "cut", "refresh"] as const).every((action) => {
      const readiness = cell.actionReadiness[action];
      const validReadyBasis =
        readiness.ready &&
        (readiness.authorityBasis === "calibrated_relative"
          ? readiness.requiredSampleCount > 0 &&
            readiness.observedSampleCount >= readiness.requiredSampleCount
          : readiness.authorityBasis ===
                "calibrated_relative_with_economic_stop_loss"
            ? action === "cut" &&
              readiness.requiredSampleCount > 0 &&
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
  const calibratedRelativeReady =
    cell.metricSampleCounts.roasRatio >=
      NATIVE_AD_FUNNEL_METRIC_SAMPLE_FLOOR && positiveFinite(accountP25);
  /*
    THE SAME GATE AS THE PRODUCER, AND IT HAS TO MOVE WITH IT.

    This validator restates the producer's economic-authority rule so a
    persisted cell that disagrees with it is refused. The producer no longer
    accepts a sample-backed account CPA as economic authority while a Target
    ROAS governs — the account's own median cost-per-purchase is observed
    evidence there, not a money-per-purchase anchor — so the validator must
    apply the same condition or every newly minted ROAS-governed cell would
    fail its own check.

    `targetAuthority.targetRoasAuthority` is carried ON THE CELL, so this reads
    the same fact the producer read at mint time rather than re-deriving it
    from today's target pack.
  */
  const targetRoasGoverns = cell.targetAuthority.targetRoasAuthority;
  const exactSpendAuthorityReady =
    !targetRoasGoverns &&
    cell.accountCalibration.accountCpaSampleCount >=
      NATIVE_AD_FUNNEL_METRIC_SAMPLE_FLOOR &&
    positiveFinite(cell.accountCalibration.accountCpaP50);
  const economicSpendAuthorityReady =
    cell.actionReadiness.spendUnitAuthority.status === "ready" ||
    exactSpendAuthorityReady;
  if (readiness.authorityBasis === "calibrated_relative") {
    return calibratedRelativeReady && !economicSpendAuthorityReady;
  }
  if (
    readiness.authorityBasis ===
    "calibrated_relative_with_economic_stop_loss"
  ) {
    return calibratedRelativeReady && economicSpendAuthorityReady;
  }
  return (
    readiness.authorityBasis === "commercial_stop_loss" &&
    cell.actionReadiness.spendUnitAuthority.status === "ready" &&
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
    spendUnitAuthority: cell.actionReadiness.spendUnitAuthority,
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

export function intersectNativeActionReadiness(input: {
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

const LEGACY_NATIVE_ACCOUNT_AOV_CUT_BLOCKER =
  "native_ad_calibration:commercial_spend_unit_authority_missing";

function eligibilityReason(
  eligibility: HardActionEligibility,
  action: "scale" | "cut" | "refresh",
) {
  return (
    eligibility.reasons?.[action] ??
    (eligibility[action] ? null : eligibility.reason)
  );
}

/**
 * Reconciles a persisted native profile with the new account-AOV Cut overlay.
 *
 * This is intentionally narrower than action-readiness intersection: it may
 * repair only the legacy missing-commercial-spend-unit Cut veto. Every other
 * persisted Cut veto remains closed, while Scale and Refresh are copied from
 * the persisted profile without recomputation.
 */
export function reconcilePersistedNativeCutEligibilityWithAccountAov(input: {
  persisted: HardActionEligibility;
  accountAovOverlay: HardActionEligibility;
}): HardActionEligibility {
  const persistedCutReason = eligibilityReason(input.persisted, "cut");
  const cutMayFollowOverlay =
    input.persisted.cut ||
    persistedCutReason === LEGACY_NATIVE_ACCOUNT_AOV_CUT_BLOCKER;
  const cut = cutMayFollowOverlay && input.accountAovOverlay.cut;
  const reasons = {
    scale: eligibilityReason(input.persisted, "scale"),
    cut: cutMayFollowOverlay
      ? eligibilityReason(input.accountAovOverlay, "cut")
      : persistedCutReason,
    refresh: eligibilityReason(input.persisted, "refresh"),
  };
  return {
    scale: input.persisted.scale,
    cut,
    refresh: input.persisted.refresh,
    reason:
      input.persisted.scale && cut && input.persisted.refresh
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
