import { getDb, type DbClient } from "@/lib/db";
import {
  READ_NATIVE_AD_ACCOUNT_CALIBRATION_CELL_SQL,
  type NativeAdAccountProfileDataSource,
  type NativeAdCalibrationCellQuery,
} from "./ad-account-decision-profile";
import type { AccountFunnelCalibration, MetaAovQuality } from "./types";
import {
  NATIVE_AD_CALIBRATION_TABLE,
  NATIVE_AD_CALIBRATION_BATCH_TABLE,
  inspectNativeAdCalibrationSchemaCapability,
  isNativeAdTargetAuthorityCutoffSafe,
  READ_NATIVE_AD_TARGET_AUTHORITY_FOR_ACCOUNT_SQL,
  type NativeAdCalibrationCell,
  type NativeAdCalibrationMetricSampleCounts,
  type NativeAdCalibrationQualityCounts,
  type NativeAdCalibrationQualityStatus,
  type NativeAdCalibrationActionReadiness,
  type NativeAdCalibrationActionBlockReason,
  type NativeAdCalibrationActionAuthorityBasis,
  type NativeAdSpendUnitAuthority,
  type NativeAdTargetAuthorityInput,
  type NativeAdTargetAuthorityStatus,
} from "./jobs/ad-calibration-job";

type Row = Record<string, unknown>;

export interface NativeAdProfileSchemaCapability {
  ready: boolean;
  missing: string[];
}

export const NATIVE_AD_PROFILE_REQUIRED_COLUMNS = [
  "id",
  "batch_id",
  "business_ref_id",
  "business_id",
  "provider",
  "provider_account_ref_id",
  "provider_account_id",
  "account_timezone",
  "account_currency",
  "cell_scope",
  "objective",
  "funnel_cohort",
  "optimization_context",
  "as_of_date",
  "as_of_cutoff",
  "engine_version",
  "policy_version",
  "sample_window_start",
  "sample_window_end",
  "sample_window_days",
  "source_ad_count",
  "source_day_count",
  "eligible_ad_count",
  "mature_ad_count",
  "zero_conversion_ad_count",
  "funnel_calibration_json",
  "metric_sample_counts_json",
  "action_readiness_json",
  "quality_counts_json",
  "quality_status",
  "target_authority_status",
  "target_authority_hash",
  "batch_input_manifest_hash",
  "input_manifest_hash",
  "source_manifest_hash",
  "computed_at",
] as const;

export const NATIVE_AD_PROFILE_BATCH_REQUIRED_COLUMNS = [
  "id",
  "business_ref_id",
  "business_id",
  "provider",
  "provider_account_ref_id",
  "provider_account_id",
  "as_of_date",
  "as_of_cutoff",
  "engine_version",
  "policy_version",
  "expected_cell_count",
  "input_manifest_hash",
  "source_manifest_hash",
  "cell_set_hash",
  "completeness_status",
] as const;

export const READ_NATIVE_AD_CALIBRATION_ROW_ID_SQL = `
SELECT calibration.id::text AS id
FROM ${NATIVE_AD_CALIBRATION_TABLE} calibration
JOIN ${NATIVE_AD_CALIBRATION_BATCH_TABLE} batch
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
 AND batch.completeness_status = 'complete'
 AND batch.input_manifest_hash = calibration.batch_input_manifest_hash
 AND batch.source_manifest_hash = calibration.source_manifest_hash
JOIN business_provider_accounts binding
  ON binding.business_id = calibration.business_id
 AND binding.provider = 'meta'
 AND binding.provider_account_ref_id = calibration.provider_account_ref_id
 AND binding.provider_account_id = calibration.provider_account_id
JOIN provider_accounts account
  ON account.id = binding.provider_account_ref_id
 AND account.external_account_id = binding.provider_account_id
WHERE calibration.business_ref_id = $1::uuid
  AND calibration.business_id = $1::text
  AND calibration.provider = 'meta'
  AND calibration.provider_account_ref_id = $2::uuid
  AND calibration.provider_account_id = $3
  AND calibration.account_timezone = $4
  AND calibration.account_currency = $5
  AND calibration.cell_scope = $6
  AND calibration.objective = $7
  AND calibration.funnel_cohort = $8
  AND calibration.optimization_context = $9
  AND calibration.as_of_cutoff = $10::timestamptz
  AND calibration.engine_version = $11
  AND calibration.policy_version = $12
  AND calibration.input_manifest_hash = $13
  AND calibration.source_manifest_hash = $14
  AND calibration.computed_at = $15::timestamptz
  AND calibration.batch_id = $16::uuid
ORDER BY calibration.id
LIMIT 2
`;

export async function inspectNativeAdProfileSchemaCapability(
  db: DbClient = getDb(),
): Promise<NativeAdProfileSchemaCapability> {
  const capability = await inspectNativeAdCalibrationSchemaCapability(db);
  return {
    ready: capability.ready,
    missing: [...capability.missing, ...capability.mismatched],
  };
}

/**
 * Production adapter for the native profile resolver. Every calibration read
 * is exact-cutoff and native-table-only; no legacy calibration API exists on
 * this class.
 */
export class WarehouseNativeAdAccountProfileDataSource implements NativeAdAccountProfileDataSource {
  constructor(private readonly db: DbClient = getDb()) {}

  async getNativeAdCalibrationCell(input: NativeAdCalibrationCellQuery) {
    const [row] = await this.db.query<Row>(
      READ_NATIVE_AD_ACCOUNT_CALIBRATION_CELL_SQL,
      nativeCalibrationQueryParams(input),
    );
    return row ? mapNativeAdCalibrationCell(row) : null;
  }

  async getNativeTargetAuthorityAsOf(input: {
    businessId: string;
    providerAccountRefId: string;
    providerAccountId: string;
    asOfCutoff: string;
  }) {
    const [row] = await this.db.query<Row>(
      READ_NATIVE_AD_TARGET_AUTHORITY_FOR_ACCOUNT_SQL,
      [
        input.businessId,
        input.providerAccountRefId,
        input.providerAccountId,
        input.asOfCutoff,
      ],
    );
    return row ? mapNativeAdTargetAuthorityInput(row) : null;
  }

  async getNativeCalibrationRowId(cell: NativeAdCalibrationCell) {
    const rows = await this.db.query<Row>(
      READ_NATIVE_AD_CALIBRATION_ROW_ID_SQL,
      [
        cell.key.businessId,
        cell.key.providerAccountRefId,
        cell.key.providerAccountId,
        cell.key.accountTimezone,
        cell.key.accountCurrency,
        cell.key.cellScope,
        cell.key.objective,
        cell.key.cohort,
        cell.key.optimizationContext,
        cell.asOfCutoff,
        cell.engineVersion,
        cell.policyVersion,
        cell.inputManifestHash,
        cell.sourceManifestHash,
        cell.computedAt,
        requiredText(cell.batchId, "native calibration batch id"),
      ],
    );
    if (rows.length !== 1) {
      throw new Error(
        `Native calibration lineage must resolve exactly one row for ${cell.key.providerAccountId}/${cell.key.objective}/${cell.key.optimizationContext}; resolved ${rows.length}.`,
      );
    }
    return requiredText(rows[0]?.id, "native calibration row id");
  }
}

function nativeCalibrationQueryParams(input: NativeAdCalibrationCellQuery) {
  return [
    input.businessId,
    input.providerAccountId,
    input.accountTimezone,
    input.accountCurrency,
    input.cellScope,
    input.objective,
    input.cohort,
    input.optimizationContext,
    input.asOfDate,
    input.engineVersion,
    input.policyVersion,
  ];
}

function mapNativeAdCalibrationCell(row: Row): NativeAdCalibrationCell {
  const businessId = requiredText(row.business_id, "business_id");
  if (requiredText(row.provider, "provider") !== "meta") {
    throw new TypeError("Native calibration profile requires provider=meta.");
  }
  const computedAt = requiredTimestamp(row.computed_at, "computed_at");
  const targetStatus = nativeTargetStatus(row.target_authority_status);
  const targetRoas = optionalNumber(row.target_roas);
  const breakEvenRoas = optionalNumber(row.break_even_roas);
  const cutoffSafeTargetAuthority =
    isNativeAdTargetAuthorityCutoffSafe(targetStatus);
  const matureAdCount = requiredInteger(row.mature_ad_count, "mature_ad_count");
  const batchCompleteness = nativeBatchCompleteness(row.batch_completeness);
  if (batchCompleteness !== "complete") {
    throw new TypeError(
      "Native profile reads require a complete calibration batch.",
    );
  }
  return {
    batchId: requiredUuid(row.batch_id, "batch_id"),
    batchCompleteness,
    batchCellCount: requiredInteger(row.batch_cell_count, "batch_cell_count"),
    batchCellSetHash: requiredHash(
      row.batch_cell_set_hash,
      "batch_cell_set_hash",
    ),
    key: {
      businessId,
      providerAccountRefId: requiredUuid(
        row.provider_account_ref_id,
        "provider_account_ref_id",
      ),
      providerAccountId: requiredText(
        row.provider_account_id,
        "provider_account_id",
      ),
      accountTimezone: requiredText(row.account_timezone, "account_timezone"),
      accountCurrency: requiredText(row.account_currency, "account_currency"),
      cellScope: nativeCellScope(row.cell_scope),
      objective: requiredText(row.objective, "objective"),
      cohort: nativeFunnelCohort(row.funnel_cohort),
      optimizationContext: requiredText(
        row.optimization_context,
        "optimization_context",
      ),
    },
    asOfDate: requiredDate(row.as_of_date, "as_of_date"),
    asOfCutoff: requiredTimestamp(row.as_of_cutoff, "as_of_cutoff"),
    sampleWindowStart: requiredDate(
      row.sample_window_start,
      "sample_window_start",
    ),
    sampleWindowEnd: requiredDate(row.sample_window_end, "sample_window_end"),
    sampleWindowDays: requiredInteger(
      row.sample_window_days,
      "sample_window_days",
    ),
    computedAt,
    engineVersion: requiredText(row.engine_version, "engine_version"),
    policyVersion: requiredText(row.policy_version, "policy_version"),
    qualityStatus: nativeQualityStatus(row.quality_status),
    sourceAdCount: requiredInteger(row.source_ad_count, "source_ad_count"),
    sourceDayCount: requiredInteger(row.source_day_count, "source_day_count"),
    eligibleAdCount: requiredInteger(
      row.eligible_ad_count,
      "eligible_ad_count",
    ),
    matureAdCount,
    zeroConversionAdCount: requiredInteger(
      row.zero_conversion_ad_count,
      "zero_conversion_ad_count",
    ),
    metricSampleCounts: nativeMetricSampleCounts(row.metric_sample_counts_json),
    actionReadiness: nativeActionReadiness(row.action_readiness_json),
    sourceMinDate: optionalDate(row.source_min_date),
    sourceMaxDate: optionalDate(row.source_max_date),
    sourceMaxUpdatedAt: optionalTimestamp(row.source_max_updated_at),
    targetAuthority: {
      status: targetStatus,
      sourceRowId: null,
      targetCpa: null,
      targetRoas,
      breakEvenCpa: null,
      breakEvenRoas,
      operatorAovAssumption: null,
      defaultRiskPosture: null,
      effectiveAt: optionalTimestamp(row.target_effective_at),
      recordedAt: optionalTimestamp(row.target_recorded_at),
      targetRoasAuthority: cutoffSafeTargetAuthority && positive(targetRoas),
      breakEvenRoasAuthority:
        cutoffSafeTargetAuthority && positive(breakEvenRoas),
      authorityHash: requiredHash(
        row.target_authority_hash,
        "target_authority_hash",
      ),
    },
    accountCalibration: {
      businessId,
      computedAt,
      matureCreativeCount: matureAdCount,
      roasP75: optionalNumber(row.roas_p75),
      roasP60: optionalNumber(row.roas_p60),
      refreshRatioP10: optionalNumber(row.refresh_ratio_p10),
      lowCtrP10: optionalNumber(row.low_ctr_p10),
      accountCpaP50: optionalNumber(row.account_cpa_p50),
      accountCpaSampleCount: requiredInteger(
        row.account_cpa_sample_count,
        "account_cpa_sample_count",
      ),
      metaAttributedAovMean90d: optionalNumber(
        row.meta_attributed_aov_mean_90d,
      ),
      metaAttributedAovPurchaseCount90d: requiredInteger(
        row.meta_attributed_aov_purchase_count_90d,
        "meta_attributed_aov_purchase_count_90d",
      ),
      metaAttributedRevenue90d: requiredNumber(
        row.meta_attributed_revenue_90d,
        "meta_attributed_revenue_90d",
      ),
      metaAovQuality: metaAovQuality(row.meta_aov_quality),
      matureSpendP50: optionalNumber(row.mature_spend_p50),
      matureSpendP75: optionalNumber(row.mature_spend_p75),
      winnerSpendP25: optionalNumber(row.winner_spend_p25),
      winnerSpendP50: optionalNumber(row.winner_spend_p50),
      winnerPurchaseP50: optionalNumber(row.winner_purchase_p50),
      roasRatioP10: optionalNumber(row.roas_ratio_p10),
      roasRatioP25: optionalNumber(row.roas_ratio_p25),
      roasRatioP50: optionalNumber(row.roas_ratio_p50),
      roasRatioP75: optionalNumber(row.roas_ratio_p75),
    },
    funnelCalibration: requiredJsonObject(
      row.funnel_calibration_json,
      "funnel_calibration_json",
    ) as unknown as AccountFunnelCalibration,
    batchInputManifestHash: requiredHash(
      row.batch_input_manifest_hash,
      "batch_input_manifest_hash",
    ),
    inputManifestHash: requiredHash(
      row.input_manifest_hash,
      "input_manifest_hash",
    ),
    sourceManifestHash: requiredHash(
      row.source_manifest_hash,
      "source_manifest_hash",
    ),
    qualityCounts: requiredJsonObject(
      row.quality_counts_json,
      "quality_counts_json",
    ) as unknown as NativeAdCalibrationQualityCounts,
  };
}

function mapNativeAdTargetAuthorityInput(
  row: Row,
): NativeAdTargetAuthorityInput {
  const operation = requiredText(row.operation, "target operation");
  if (operation !== "upsert" && operation !== "delete") {
    throw new TypeError(`Unsupported native target operation: ${operation}`);
  }
  const risk = optionalText(row.default_risk_posture);
  if (
    risk !== null &&
    risk !== "aggressive" &&
    risk !== "balanced" &&
    risk !== "conservative"
  ) {
    throw new TypeError(`Unsupported target risk posture: ${risk}`);
  }
  return {
    sourceRowId: optionalText(row.source_row_id),
    operation,
    targetCpa: optionalNumber(row.target_cpa),
    targetRoas: optionalNumber(row.target_roas),
    breakEvenCpa: optionalNumber(row.break_even_cpa),
    breakEvenRoas: optionalNumber(row.break_even_roas),
    operatorAovAssumption: optionalNumber(row.operator_aov_assumption),
    defaultRiskPosture: risk,
    effectiveAt: optionalTimestamp(row.effective_at),
    recordedAt: optionalTimestamp(row.recorded_at),
  };
}

function nativeCellScope(value: unknown) {
  const text = requiredText(value, "cell_scope");
  if (
    text === "objective_cohort_context" ||
    text === "account_objective_cohort"
  ) {
    return text;
  }
  throw new TypeError(`Unsupported native calibration cell scope: ${text}`);
}

function nativeBatchCompleteness(value: unknown): "computed" | "complete" {
  const text = requiredText(value, "batch_completeness");
  if (text === "computed" || text === "complete") return text;
  throw new TypeError(`Unsupported native batch completeness: ${text}`);
}

function nativeFunnelCohort(value: unknown) {
  const text = requiredText(value, "funnel_cohort");
  if (
    text === "purchase" ||
    text === "mid_funnel" ||
    text === "lead" ||
    text === "traffic" ||
    text === "upper_funnel" ||
    text === "engagement" ||
    text === "unknown"
  ) {
    return text;
  }
  throw new TypeError(`Unsupported native funnel cohort: ${text}`);
}

function nativeQualityStatus(value: unknown): NativeAdCalibrationQualityStatus {
  const text = requiredText(value, "quality_status");
  if (
    text === "ready" ||
    text === "low_sample" ||
    text === "insufficient" ||
    text === "blocked_commercial" ||
    text === "unsupported_cohort"
  ) {
    return text;
  }
  throw new TypeError(`Unsupported native calibration quality: ${text}`);
}

const NATIVE_METRIC_SAMPLE_COUNT_KEYS = [
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
] as const satisfies readonly (keyof NativeAdCalibrationMetricSampleCounts)[];

function nativeMetricSampleCounts(
  value: unknown,
): NativeAdCalibrationMetricSampleCounts {
  const object = requiredJsonObject(value, "metric_sample_counts_json");
  return Object.fromEntries(
    NATIVE_METRIC_SAMPLE_COUNT_KEYS.map((key) => {
      if (typeof object[key] !== "number") {
        throw new TypeError(
          `metric_sample_counts_json.${key} must be an integer.`,
        );
      }
      const count = requiredInteger(
        object[key],
        `metric_sample_counts_json.${key}`,
      );
      if (count < 0) {
        throw new TypeError(
          `metric_sample_counts_json.${key} must be non-negative.`,
        );
      }
      return [key, count];
    }),
  ) as unknown as NativeAdCalibrationMetricSampleCounts;
}

const NATIVE_ACTION_BLOCK_REASONS =
  new Set<NativeAdCalibrationActionBlockReason>([
    "pooled_optimization_context_soft_only",
    "unsupported_cohort",
    "target_roas_authority_missing",
    "break_even_roas_authority_missing",
    "commercial_spend_unit_authority_missing",
    "scale_calibration_sample_low",
    "scale_winner_benchmark_missing",
    "cut_calibration_sample_low",
    "refresh_calibration_sample_low",
  ]);

const NATIVE_ACTION_AUTHORITY_BASES =
  new Set<NativeAdCalibrationActionAuthorityBasis>([
    "calibrated_relative",
    "calibrated_relative_with_economic_stop_loss",
    "commercial_stop_loss",
  ]);

function nativeActionReadiness(
  value: unknown,
): NativeAdCalibrationActionReadiness {
  const object = requiredJsonObject(value, "action_readiness_json");
  const parse = (action: "scale" | "cut" | "refresh") => {
    const entry = requiredJsonObject(
      object[action],
      `action_readiness_json.${action}`,
    );
    if (typeof entry.ready !== "boolean") {
      throw new TypeError(
        `action_readiness_json.${action}.ready must be boolean.`,
      );
    }
    if (
      typeof entry.observedSampleCount !== "number" ||
      typeof entry.requiredSampleCount !== "number"
    ) {
      throw new TypeError(
        `action_readiness_json.${action} sample counts must be integers.`,
      );
    }
    const observedSampleCount = requiredInteger(
      entry.observedSampleCount,
      `action_readiness_json.${action}.observedSampleCount`,
    );
    const requiredSampleCount = requiredInteger(
      entry.requiredSampleCount,
      `action_readiness_json.${action}.requiredSampleCount`,
    );
    const reasonText = optionalText(entry.reason);
    const reason = reasonText as NativeAdCalibrationActionBlockReason | null;
    const authorityBasisText = optionalText(entry.authorityBasis);
    const authorityBasis =
      authorityBasisText as NativeAdCalibrationActionAuthorityBasis | null;
    const validReadyBasis =
      entry.ready &&
      authorityBasis !== null &&
      NATIVE_ACTION_AUTHORITY_BASES.has(authorityBasis) &&
      (authorityBasis === "commercial_stop_loss"
        ? action === "cut" && requiredSampleCount === 0
        : authorityBasis ===
              "calibrated_relative_with_economic_stop_loss"
          ? action === "cut" &&
            requiredSampleCount > 0 &&
            observedSampleCount >= requiredSampleCount
          : requiredSampleCount > 0 &&
          observedSampleCount >= requiredSampleCount);
    if (
      observedSampleCount < 0 ||
      requiredSampleCount < 0 ||
      (entry.ready && (reason !== null || !validReadyBasis)) ||
      (!entry.ready &&
        (reason === null ||
          !NATIVE_ACTION_BLOCK_REASONS.has(reason) ||
          authorityBasis !== null))
    ) {
      throw new TypeError(
        `action_readiness_json.${action} has an invalid readiness proof.`,
      );
    }
    return {
      ready: entry.ready,
      reason,
      authorityBasis,
      observedSampleCount,
      requiredSampleCount,
    };
  };
  return {
    spendUnitAuthority: nativeSpendUnitAuthority(object.spendUnitAuthority),
    scale: parse("scale"),
    cut: parse("cut"),
    refresh: parse("refresh"),
  };
}

function nativeSpendUnitAuthority(value: unknown): NativeAdSpendUnitAuthority {
  const object = requiredJsonObject(
    value,
    "action_readiness_json.spendUnitAuthority",
  );
  const evidence = requiredJsonObject(
    object.accountAovEvidence,
    "action_readiness_json.spendUnitAuthority.accountAovEvidence",
  );
  const contractVersion = requiredText(
    object.contractVersion,
    "spendUnitAuthority.contractVersion",
  );
  if (contractVersion !== "engine-v3-native-ad-spend-unit-authority.v1") {
    throw new TypeError("Unsupported native spend-unit authority contract.");
  }
  const status = requiredText(object.status, "spendUnitAuthority.status");
  if (status !== "ready" && status !== "blocked") {
    throw new TypeError("Invalid native spend-unit authority status.");
  }
  const basis = requiredNullableText(object.basis, "spendUnitAuthority.basis");
  if (
    basis !== null &&
    basis !== "target_cpa" &&
    basis !== "operator_aov" &&
    basis !== "physical_account_purchase_aov_90d"
  ) {
    throw new TypeError("Invalid native spend-unit authority basis.");
  }
  const evidenceStatus = requiredText(
    evidence.status,
    "spendUnitAuthority.accountAovEvidence.status",
  );
  if (
    evidenceStatus !== "ready" &&
    evidenceStatus !== "insufficient_sample" &&
    evidenceStatus !== "contradictory_purchase_truth" &&
    evidenceStatus !== "unavailable"
  ) {
    throw new TypeError("Invalid native account-AOV evidence status.");
  }
  const scope = requiredText(
    evidence.scope,
    "spendUnitAuthority.accountAovEvidence.scope",
  );
  if (scope !== "business_provider_account_currency") {
    throw new TypeError("Invalid native account-AOV evidence scope.");
  }
  return {
    contractVersion,
    status,
    basis,
    businessId: requiredText(
      object.businessId,
      "spendUnitAuthority.businessId",
    ),
    providerAccountRefId: requiredText(
      object.providerAccountRefId,
      "spendUnitAuthority.providerAccountRefId",
    ),
    providerAccountId: requiredText(
      object.providerAccountId,
      "spendUnitAuthority.providerAccountId",
    ),
    accountCurrency: requiredNullableText(
      object.accountCurrency,
      "spendUnitAuthority.accountCurrency",
    ),
    asOfCutoff: requiredTimestamp(
      object.asOfCutoff,
      "spendUnitAuthority.asOfCutoff",
    ),
    targetAuthorityHash: requiredHash(
      object.targetAuthorityHash,
      "spendUnitAuthority.targetAuthorityHash",
    ),
    baseSpendUnit: optionalJsonNumber(
      object.baseSpendUnit,
      "spendUnitAuthority.baseSpendUnit",
    ),
    accountAovEvidence: {
      status: evidenceStatus,
      scope,
      businessId: requiredText(
        evidence.businessId,
        "spendUnitAuthority.accountAovEvidence.businessId",
      ),
      providerAccountRefId: requiredText(
        evidence.providerAccountRefId,
        "spendUnitAuthority.accountAovEvidence.providerAccountRefId",
      ),
      providerAccountId: requiredText(
        evidence.providerAccountId,
        "spendUnitAuthority.accountAovEvidence.providerAccountId",
      ),
      accountCurrency: requiredNullableText(
        evidence.accountCurrency,
        "spendUnitAuthority.accountAovEvidence.accountCurrency",
      ),
      sampleWindowStart: requiredDate(
        evidence.sampleWindowStart,
        "spendUnitAuthority.accountAovEvidence.sampleWindowStart",
      ),
      sampleWindowEnd: requiredDate(
        evidence.sampleWindowEnd,
        "spendUnitAuthority.accountAovEvidence.sampleWindowEnd",
      ),
      asOfCutoff: requiredTimestamp(
        evidence.asOfCutoff,
        "spendUnitAuthority.accountAovEvidence.asOfCutoff",
      ),
      observedPurchaseCount: requiredJsonInteger(
        evidence.observedPurchaseCount,
        "spendUnitAuthority.accountAovEvidence.observedPurchaseCount",
      ),
      requiredPurchaseCount: requiredJsonInteger(
        evidence.requiredPurchaseCount,
        "spendUnitAuthority.accountAovEvidence.requiredPurchaseCount",
      ),
      revenueBackedRowCount: requiredJsonInteger(
        evidence.revenueBackedRowCount,
        "spendUnitAuthority.accountAovEvidence.revenueBackedRowCount",
      ),
      canonicalRowCount: requiredJsonInteger(
        evidence.canonicalRowCount,
        "spendUnitAuthority.accountAovEvidence.canonicalRowCount",
      ),
      contradictoryRowCount: requiredJsonInteger(
        evidence.contradictoryRowCount,
        "spendUnitAuthority.accountAovEvidence.contradictoryRowCount",
      ),
      legacySchemaRowCount: requiredJsonInteger(
        evidence.legacySchemaRowCount,
        "spendUnitAuthority.accountAovEvidence.legacySchemaRowCount",
      ),
      unsupportedSchemaRowCount: requiredJsonInteger(
        evidence.unsupportedSchemaRowCount,
        "spendUnitAuthority.accountAovEvidence.unsupportedSchemaRowCount",
      ),
      totalRevenue: requiredJsonNumber(
        evidence.totalRevenue,
        "spendUnitAuthority.accountAovEvidence.totalRevenue",
      ),
      meanAov: optionalJsonNumber(
        evidence.meanAov,
        "spendUnitAuthority.accountAovEvidence.meanAov",
      ),
      evidenceHash: requiredHash(
        evidence.evidenceHash,
        "spendUnitAuthority.accountAovEvidence.evidenceHash",
      ),
    },
    authorityHash: requiredHash(
      object.authorityHash,
      "spendUnitAuthority.authorityHash",
    ),
  };
}

function nativeTargetStatus(value: unknown): NativeAdTargetAuthorityStatus {
  const text = requiredText(value, "target_authority_status");
  if (
    text === "fresh" ||
    text === "stale" ||
    text === "missing" ||
    text === "cutoff_unsafe"
  ) {
    return text;
  }
  throw new TypeError(`Unsupported native target authority status: ${text}`);
}

function metaAovQuality(value: unknown): MetaAovQuality {
  const text = requiredText(value, "meta_aov_quality");
  if (
    text === "unavailable" ||
    text === "unstable" ||
    text === "low_sample" ||
    text === "ready"
  ) {
    return text;
  }
  throw new TypeError(`Unsupported Meta AOV quality: ${text}`);
}

function requiredJsonObject(value: unknown, field: string) {
  const parsed =
    typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new TypeError(`${field} must be a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

function optionalText(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  return text || null;
}

function requiredText(value: unknown, field: string): string {
  const text = optionalText(value);
  if (text === null) throw new TypeError(`${field} is required.`);
  return text;
}

function optionalNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function requiredNumber(value: unknown, field: string): number {
  const numeric = optionalNumber(value);
  if (numeric === null) throw new TypeError(`${field} must be finite.`);
  return numeric;
}

function requiredInteger(value: unknown, field: string): number {
  const numeric = requiredNumber(value, field);
  if (!Number.isInteger(numeric))
    throw new TypeError(`${field} must be an integer.`);
  return numeric;
}

function optionalJsonNumber(value: unknown, field: string): number | null {
  if (value === null) return null;
  if (value === undefined) {
    throw new TypeError(
      `${field} is required and must be a JSON number or null.`,
    );
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${field} must be a finite JSON number or null.`);
  }
  return value;
}

function requiredNullableText(value: unknown, field: string): string | null {
  if (value === null) return null;
  return requiredText(value, field);
}

function requiredJsonNumber(value: unknown, field: string): number {
  const numeric = optionalJsonNumber(value, field);
  if (numeric === null)
    throw new TypeError(`${field} must be a finite JSON number.`);
  return numeric;
}

function requiredJsonInteger(value: unknown, field: string): number {
  const numeric = requiredJsonNumber(value, field);
  if (!Number.isInteger(numeric)) {
    throw new TypeError(`${field} must be a JSON integer.`);
  }
  return numeric;
}

function optionalTimestamp(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function requiredTimestamp(value: unknown, field: string): string {
  const timestamp = optionalTimestamp(value);
  if (timestamp === null) throw new TypeError(`${field} must be a timestamp.`);
  return timestamp;
}

function optionalDate(value: unknown): string | null {
  const text = optionalText(value);
  if (text === null) return null;
  const match = text.match(/^\d{4}-\d{2}-\d{2}/);
  return match?.[0] ?? null;
}

function requiredDate(value: unknown, field: string): string {
  const date = optionalDate(value);
  if (date === null) throw new TypeError(`${field} must be an ISO date.`);
  return date;
}

function requiredHash(value: unknown, field: string): string {
  const hash = requiredText(value, field);
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    throw new TypeError(`${field} must be a lowercase SHA-256 hash.`);
  }
  return hash;
}

function requiredUuid(value: unknown, field: string): string {
  const id = requiredText(value, field);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      id,
    )
  ) {
    throw new TypeError(`${field} must be a UUID.`);
  }
  return id;
}

function positive(value: number | null): boolean {
  return value !== null && value > 0;
}
