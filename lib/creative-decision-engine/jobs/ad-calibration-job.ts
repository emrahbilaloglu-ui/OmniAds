import {
  resolveObservedShopifyAov,
  type ObservedShopifyAovEvidence,
} from "../shopify-aov-source";
import {
  projectAccountCpaForIdentity,
  projectNativeTargetAuthorityForIdentity,
} from "@/lib/creative-decision-engine/commercial-semantic-projection";
import { commercialTargetInstantMs } from "@/lib/meta/commercial-target-instant";
import {
  resolveMetaFunnelCohort,
  type MetaFunnelCohort,
} from "@/lib/meta/funnel-cohort";
import { META_CANONICAL_METRIC_SCHEMA_VERSION } from "@/lib/meta/canonical-metrics";
import { resolveMinorUnitExponent } from "@/lib/currency/iso-4217-minor-units";
import { getDb, runDbTransaction, type DbClient } from "@/lib/db";
import { canonicalSha256 } from "../canonical-evaluation";
import {
  MIN_ACCOUNT_SCALE_CALIBRATION_SAMPLE,
  NATIVE_AD_ACCOUNT_AOV_PURCHASE_SAMPLE_FLOOR,
  SAMPLE_WINDOW_DAYS,
} from "../config-values";
import { resolveEngineV3Flags, type EngineV3Flags } from "../feature-flags";
import {
  NATIVE_AD_ENGINE_VERSION,
  type AccountCalibration,
  type AccountFunnelCalibration,
  type FormatFunnelBaseline,
  type MetaAovQuality,
} from "../types";
import { getBusinessGuardFailure } from "./business-guard";
import { hashAdvisoryLock } from "./calibration-job";
import { ENGINE_V3_JOB_TRANSACTION_TIMEOUT_MS } from "./job-runtime";

export const NATIVE_AD_CALIBRATION_TABLE =
  "engine_v3_ad_account_calibration_daily" as const;
export const NATIVE_AD_CALIBRATION_BATCH_TABLE =
  "engine_v3_ad_account_calibration_batches" as const;
export const NATIVE_AD_CALIBRATION_CONTRACT_VERSION =
  /*
  `.v5` — three changes, all of which move the bytes this key labels, so one
  version carries them together rather than letting `.v4` mean four encodings.

  1. RAW ACCOUNT CPA LEFT THE CELL MANIFEST. `.v4` projected the CPA out of the
     target AUTHORITY but still hashed `accountCalibration` whole, and that
     object carries `accountCpaP50` / `accountCpaSampleCount`. On a
     ROAS-governed account those choose nothing — `resolveSpendUnit`'s governed
     branch answers READY-or-`insufficient` and never reaches the
     `account_history` rung — so a re-measured CPA moved `inputManifestHash`,
     `cellSetHash` and through them the retained profile's agreement check,
     discarding a verdict it could not have changed. The shared projection now
     runs before the hash, and leaves the no-Target-ROAS case byte-identical.
  2. CUT READINESS HOLDS OUTRIGHT WITHOUT A READY SPEND UNIT. `.v4` let a
     P25-backed cell stay `ready` with basis `calibrated_relative` while a
     Target ROAS governed and the spend-unit authority was NOT ready. Readiness
     is what the retained profile and the downstream gates read, so "ready, but
     a later gate will refuse" is a different fact from "not ready" and it
     travelled into identity as the former.
  3. THE TARGET ROW'S CLOCKS ARE READ STRICTLY. `effectiveAt` / `recordedAt`
     went through `Date.parse`, which silently rolls `2026-02-30` into March
     and accepts a naked local time. The cutoff-safety verdict those clocks
     produce is hashed as `status`, so a rolled-over date could mint a `fresh`
     authority from a day that does not exist.

  `.v4` and earlier stay READABLE under their own key and are never recomputed
  under current semantics: `assertNativeAdCalibrationBatchIntegrity` refuses a
  batch whose `contractVersion` is not the current one before any hash is
  re-derived, so a historical row is history and not a candidate.
*/
  "engine-v3-native-ad-calibration.v5" as const;
/**
 * The stamp a row written BEFORE `contract_version` existed carries.
 *
 * ── ROUND 9 ITEM 5: WHY NOT `.v4`, AND WHY NOT `.v3` EITHER ────────────────
 * The audit allowed backfilling as `.v4` only on proof that `.v4` was the sole
 * deployed writer. The repository proves the opposite:
 *
 *   git show HEAD:lib/creative-decision-engine/jobs/ad-calibration-job.ts
 *     -> "engine-v3-native-ad-calibration.v3"
 *   git log -S'engine-v3-native-ad-calibration.v4' -- <this file>   -> 0 commits
 *   git log -S'engine-v3-native-ad-calibration.v1"' -- <this file>  -> 2 commits
 *   git log -S'engine-v3-native-ad-calibration.v2"' -- <this file>  -> 2 commits
 *   git log -S'engine-v3-native-ad-calibration.v3"' -- <this file>  -> 1 commit
 *
 * So `.v4` never wrote a row anywhere, and `.v1`, `.v2` and `.v3` were EACH a
 * deployed writer at some point in these tables' life. Nothing in the schema,
 * the git history or the migrations records which of the three wrote any
 * particular existing row, and the rows themselves carry no discriminator.
 *
 * Stamping them `.v3` would therefore be inventing lineage for however many
 * were written by `.v1` or `.v2`, and a wrong stamp is worse than none: it
 * would make a row recompute against a formula it was not written with and
 * fail as if it were corrupt. `legacy_unknown` says the true thing, and it
 * fails CLOSED — a row carrying it is refused for current authority with its
 * own named reason rather than guessed at.
 */
export const NATIVE_AD_CALIBRATION_LEGACY_UNKNOWN_CONTRACT =
  "legacy_unknown" as const;

/** Every value the durable `contract_version` column may hold. */
/**
 * The exact `CHECK` body both the DDL and the capability contract use.
 *
 * ── ROUND 10 ITEM 1 ────────────────────────────────────────────────────────
 * Written once and rendered the way PostgreSQL itself renders `IN (...)` —
 * `= ANY (ARRAY[...])` — because `inspectNativeAdCalibrationSchemaCapability`
 * compares `pg_get_constraintdef` output to this string literally. A DDL that
 * said `IN` and a contract that said `= ANY` would report `mismatched` forever
 * on a correctly migrated database.
 */
export function nativeAdCalibrationContractVersionCheck(): string {
  /*
    The `::text` casts are what `pg_get_constraintdef` prints back, so emitting
    them here makes the DDL, this contract and the database's own rendering the
    SAME string. The capability comparison normalizes casts away either way;
    matching exactly means the acceptance test can assert byte equality against
    the catalog rather than against a normalizer.
  */
  const values = NATIVE_AD_CALIBRATION_DURABLE_CONTRACT_VALUES.map(
    (value) => `'${value}'::text`,
  ).join(", ");
  return `CHECK (contract_version = ANY (ARRAY[${values}]))`;
}

export const NATIVE_AD_CALIBRATION_DURABLE_CONTRACT_VALUES: readonly string[] =
  Object.freeze([
    "engine-v3-native-ad-calibration.v1",
    "engine-v3-native-ad-calibration.v2",
    "engine-v3-native-ad-calibration.v3",
    NATIVE_AD_CALIBRATION_CONTRACT_VERSION,
    NATIVE_AD_CALIBRATION_LEGACY_UNKNOWN_CONTRACT,
  ]);

export const NATIVE_AD_CALIBRATION_POLICY_VERSION =
  `retained-account-calibration.${NATIVE_AD_ENGINE_VERSION}` as const;
export const NATIVE_AD_ACCOUNT_WIDE_OPTIMIZATION_CONTEXT = "*" as const;
export const NATIVE_AD_FUNNEL_METRIC_SAMPLE_FLOOR = 20;
export { NATIVE_AD_ACCOUNT_AOV_PURCHASE_SAMPLE_FLOOR } from "../config-values";
export const AD_CALIBRATION_JOB_NAME =
  "engine_v3_native_ad_calibration_shadow_job" as const;

export interface NativeAdCalibrationCurrencyAdmission {
  contractVersion: "engine-v3-native-ad-currency-admission.v1";
  status: "ready" | "blocked" | "unavailable";
  keyBasis: "immutable_source" | "bound_provider_fallback" | null;
  accountCurrency: string | null;
  reason:
    | "source_currency_unavailable"
    | "source_currency_missing"
    | "resolved_currency_missing"
    | "resolved_source_currency_mismatch"
    | "mixed_source_currency"
    | null;
  candidateRowCount: number;
  admittedRowCount: number;
  anomalyRowCount: number;
  sourceCurrencyMissingRowCount: number;
  resolvedCurrencyMissingRowCount: number;
  resolvedSourceMismatchRowCount: number;
  distinctSourceCurrencyCount: number;
  distinctResolvedCurrencyCount: number;
  manifestHash: string;
}

export interface NativeAdCalibrationTimezoneAdmission {
  contractVersion: "engine-v3-native-ad-timezone-admission.v1";
  status: "ready" | "blocked" | "unavailable";
  keyBasis: "immutable_latest_source_date" | null;
  accountTimezone: string | null;
  reason:
    | "source_timezone_unavailable"
    | "latest_source_timezone_missing"
    | "mixed_latest_source_timezone"
    | null;
  candidateRowCount: number;
  latestSourceDate: string | null;
  latestSourceRowCount: number;
  admittedRowCount: number;
  anomalyRowCount: number;
  sourceTimezoneMissingRowCount: number;
  distinctSourceTimezoneCount: number;
  manifestHash: string;
}

export interface NativeAdCalibrationSourceProvenance {
  mode: "current_transaction_snapshot";
  providerAccountRefId: string;
  providerAccountId: string;
  transactionCutoff: string;
  transactionIsolation: "repeatable read";
  currencyAdmission: NativeAdCalibrationCurrencyAdmission;
  timezoneAdmission: NativeAdCalibrationTimezoneAdmission;
}

export type NativeAdCalibrationAction = "scale" | "cut" | "refresh";

export type NativeAdCalibrationActionBlockReason =
  | "pooled_optimization_context_soft_only"
  | "unsupported_cohort"
  | "target_roas_authority_missing"
  /**
   * Retained for READ compatibility only: no path mints this any more (see
   * `hasCommercialTargetAuthority`), and rows persisted while an explicit
   * break-even ROAS was a required Cut input still carry it.
   */
  | "break_even_roas_authority_missing"
  | "commercial_spend_unit_authority_missing"
  | "scale_calibration_sample_low"
  | "scale_winner_benchmark_missing"
  | "cut_calibration_sample_low"
  | "refresh_calibration_sample_low";

export type NativeAdCalibrationActionAuthorityBasis =
  | "calibrated_relative"
  | "calibrated_relative_with_economic_stop_loss"
  | "commercial_stop_loss";

export type NativeAdAccountAovEvidenceStatus =
  | "ready"
  | "insufficient_sample"
  | "contradictory_purchase_truth"
  | "unavailable";

export interface NativeAdAccountAovEvidence {
  status: NativeAdAccountAovEvidenceStatus;
  scope: "business_provider_account_currency";
  businessId: string;
  providerAccountRefId: string;
  providerAccountId: string;
  accountCurrency: string | null;
  sampleWindowStart: string;
  sampleWindowEnd: string;
  asOfCutoff: string;
  observedPurchaseCount: number;
  requiredPurchaseCount: number;
  revenueBackedRowCount: number;
  canonicalRowCount: number;
  contradictoryRowCount: number;
  legacySchemaRowCount: number;
  unsupportedSchemaRowCount: number;
  totalRevenue: number;
  meanAov: number | null;
  evidenceHash: string;
}

export type NativeAdSpendUnitAuthorityBasis =
  | "target_cpa"
  | "operator_aov"
  /**
   * RETIRED as a native basis: readable, never minted, never expected.
   *
   * The store's average order value used to sit here, above Meta's attributed
   * view of the same quantity. It cannot: for a Meta decision the canonical
   * money-per-purchase unit is Meta's OWN attributed AOV
   * (`physical_account_purchase_aov_90d`), so the store observation is
   * contextual evidence beside the authority, never the authority itself.
   *
   * It also could not be held to the cutoff. `resolveObservedShopifyAov` stamps
   * `knowledgeAsOf` from the wall clock at read time
   * (`shopify-aov-source.ts:711-712`), and no production caller passes a cutoff,
   * so on 2026-09-07 four production accounts carried store evidence stamped
   * about a second AFTER the cell cutoff it was built for (act_805150454596350:
   * cutoff 03:13:19.302Z, knowledgeAsOf 03:13:20.188Z). The builder's cutoff
   * test rejected it and chose the Meta basis; the validator had no cutoff test
   * and expected this one; the disagreement failed the profile closed. Three of
   * those accounts logged 39 failed `engine_v3_native_ad_decisions_shadow_job`
   * runs each — 117 in 24h, every one `native_target_authority_mismatch`.
   * Retiring the basis removes the race by construction rather than adding a
   * fourth clock comparison the validator could drift on again.
   *
   * The member stays in the union so persisted rows that name it still parse
   * (`ad-account-decision-profile-store.ts:632-639`). No production row does —
   * verified on prod: zero rows in `engine_v3_ad_account_calibration_daily`, on
   * any `as_of_date`, carry this basis. One that appeared would now fail the
   * validator's basis equality and fail CLOSED, which is the intended reading of
   * a retired authority.
   */
  | "observed_shopify_aov"
  | "physical_account_purchase_aov_90d";

/**
 * The version every newly minted authority carries.
 *
 * `.v3` exists because `.v2` hashed the store observation. Retiring
 * `observed_shopify_aov` as a BASIS fixed the arithmetic and left identity
 * alone, so a store-only change — observed, stale, unavailable,
 * observed-zero-orders, or simply a different AOV — still moved
 * `authorityHash`, `generationContentHash`, `inputManifestHash` and
 * `cellSetHash`. Evidence that chooses nothing must not move identity either.
 *
 * It is minted UNCONDITIONALLY, including when the store was never consulted.
 * Deciding the version from whether Shopify was consulted would have put the
 * store back into identity through the version string itself, since
 * `contractVersion` is part of the hashed content.
 */
export const NATIVE_AD_SPEND_UNIT_AUTHORITY_CONTRACT_VERSION =
  /*
  `.v4` — minted alongside the calibration `.v4` because the authority this
  spend unit is bound to is now hashed through the semantic projection. `.v1`,
  `.v2` and `.v3` stay READABLE as history and are never re-minted.
*/
  "engine-v3-native-ad-spend-unit-authority.v4" as const;

export interface NativeAdSpendUnitAuthority {
  /**
   * FOUR versions are READ; only `.v4` is minted.
   *
   * `.v1` predates the store source entirely and carries no
   * `observedShopifyAovEvidence` member. `.v2` added it AND hashed it, so a
   * `.v2` row's stored `authorityHash` only recomputes when the store evidence
   * is hashed exactly as it was minted — 118 such rows are live in
   * `engine_v3_ad_account_calibration_daily`, so that path is kept verbatim.
   * `.v3` carries the same evidence and excludes it from every hash. `.v4`,
   * the current mint, keeps that exclusion and additionally binds the
   * authority through the semantic projection.
   *
   * `nativeAdAuthorityHashesStoreObservation` is the one switch that decides
   * INCLUDE (`.v1`, `.v2`) versus EXCLUDE (`.v3`, `.v4`), and its `default`
   * arm is `never`-checked, so adding a fifth version without answering the
   * question fails to compile rather than silently defaulting.
   *
   * Rows are never backfilled between versions: each recomputes under its own
   * key, and an unrecognized key fails CLOSED
   * (`nativeAdSpendUnitAuthorityHashContent` throws;
   * `nativeSpendUnitAuthorityMatchesCell` and the store parser reject it first).
   */
  contractVersion:
    | "engine-v3-native-ad-spend-unit-authority.v1"
    | "engine-v3-native-ad-spend-unit-authority.v2"
    | "engine-v3-native-ad-spend-unit-authority.v3"
    | typeof NATIVE_AD_SPEND_UNIT_AUTHORITY_CONTRACT_VERSION;
  status: "ready" | "blocked";
  basis: NativeAdSpendUnitAuthorityBasis | null;
  businessId: string;
  providerAccountRefId: string;
  providerAccountId: string;
  accountCurrency: string | null;
  asOfCutoff: string;
  targetAuthorityHash: string;
  baseSpendUnit: number | null;
  accountAovEvidence: NativeAdAccountAovEvidence;
  /**
   * The store-side observation, kept beside the Meta-attributed one and never
   * merged into it. They answer the same question from different books, and an
   * operator reading a blocked authority needs to see which book was consulted.
   *
   * Contextual only, in the arithmetic AND in identity: it never sets `basis`
   * or `baseSpendUnit`, the validator never derives an expected basis from it,
   * and under `.v3` it is excluded from `authorityHash`, from the generation
   * content and from the cell input manifest. It is still CARRIED and served.
   *
   * Under `.v2` it IS hashed, because those rows were minted that way and their
   * stored hashes have to keep recomputing;
   * `nativeAdSpendUnitAuthorityHashContent` is the single place that split lives.
   *
   * Absent on `.v1` rows; `null` on `.v2`/`.v3` when the store was consulted and
   * the result was not usable — the status inside says why.
   */
  observedShopifyAovEvidence?: ObservedShopifyAovEvidence | null;
  authorityHash: string;
}

export interface NativeAdCalibrationActionReadinessEntry {
  ready: boolean;
  reason: NativeAdCalibrationActionBlockReason | null;
  authorityBasis: NativeAdCalibrationActionAuthorityBasis | null;
  observedSampleCount: number;
  requiredSampleCount: number;
}

export type NativeAdCalibrationActionReadiness = Record<
  NativeAdCalibrationAction,
  NativeAdCalibrationActionReadinessEntry
> & {
  spendUnitAuthority: NativeAdSpendUnitAuthority;
};

export type NativeAdCalibrationCellScope =
  "objective_cohort_context" | "account_objective_cohort";

export type NativeAdCalibrationQualityStatus =
  | "ready"
  | "low_sample"
  | "insufficient"
  | "blocked_commercial"
  | "unsupported_cohort";

export type NativeAdTargetAuthorityStatus =
  "fresh" | "stale" | "missing" | "cutoff_unsafe";

const NATIVE_AD_TARGET_AUTHORITY_CUTOFF_SAFE_BY_STATUS = {
  fresh: true,
  stale: true,
  missing: false,
  cutoff_unsafe: false,
} as const satisfies Record<NativeAdTargetAuthorityStatus, boolean>;

export function isNativeAdTargetAuthorityCutoffSafe(
  status: NativeAdTargetAuthorityStatus,
): boolean {
  return NATIVE_AD_TARGET_AUTHORITY_CUTOFF_SAFE_BY_STATUS[status];
}

export interface NativeAdTargetAuthorityInput {
  sourceRowId: string | null;
  operation: "upsert" | "delete";
  targetCpa: number | null;
  targetRoas: number | null;
  breakEvenCpa: number | null;
  breakEvenRoas: number | null;
  operatorAovAssumption: number | null;
  defaultRiskPosture: "aggressive" | "balanced" | "conservative" | null;
  effectiveAt: string | null;
  recordedAt: string | null;
}

/**
 * The one commercial-target rule the native path shares with the structure
 * path's `resolveHardActionEligibility` in `account-decision-profile.ts`, which
 * spells it `breakEvenAnchored || targetRoasAnchored`.
 *
 * An explicit break-even ROAS used to be mandatory here as well
 * (`targetRoasAuthority && breakEvenRoasAuthority`), so a ROAS-only account got
 * every Cut refused with `break_even_roas_authority_missing`, its purchase
 * observations counted into `commercialAuthorityAdExclusionCount`, and its cell
 * stamped `blocked_commercial`. Nothing on this path reads break-even to
 * DECIDE: every lane in `buildNativeAdSpendUnitAuthority` either takes Target
 * CPA whole or divides an AOV by Target ROAS, and the relative Cut boundary is
 * a Target-ROAS ratio (`roasRatios` is empty without one). The requirement was
 * therefore a gate on an input the computation never consumed.
 *
 * Break-even is still USED wherever it exists — a real break-even is better
 * evidence for an economic Cut than a target alone, and `cut-policy` keeps
 * keying its economic strip off it — its absence just no longer refuses the
 * action.
 *
 * The refusal that remains is real: with NEITHER target present there is no
 * commercial anchor at all, and the action is still blocked by name.
 */
function hasCommercialTargetAuthority(
  targetAuthority: Pick<
    ResolvedNativeAdTargetAuthority,
    "targetRoasAuthority" | "breakEvenRoasAuthority"
  >,
): boolean {
  return (
    targetAuthority.targetRoasAuthority ||
    targetAuthority.breakEvenRoasAuthority
  );
}

export interface ResolvedNativeAdTargetAuthority {
  status: NativeAdTargetAuthorityStatus;
  sourceRowId: string | null;
  targetCpa: number | null;
  targetRoas: number | null;
  breakEvenCpa: number | null;
  breakEvenRoas: number | null;
  operatorAovAssumption: number | null;
  defaultRiskPosture: "aggressive" | "balanced" | "conservative" | null;
  effectiveAt: string | null;
  recordedAt: string | null;
  targetRoasAuthority: boolean;
  breakEvenRoasAuthority: boolean;
  authorityHash: string;
}

/**
 * One warehouse fact plus the exact same-day campaign/ad-set context. Creative
 * and lifecycle fields are optional overlays only and are intentionally not
 * used by identity, aggregation, cell selection, or manifests.
 */
export interface NativeAdCalibrationSourceRow {
  sourceRowId: string;
  businessId: string;
  providerAccountRefId: string;
  providerAccountId: string;
  date: string;
  campaignId: string | null;
  adsetId: string | null;
  adId: string;
  accountTimezone: string | null;
  accountCurrency: string | null;
  sourceAccountTimezone: string | null;
  sourceAccountCurrency: string | null;
  metricSchemaVersion: number;
  objective: string | null;
  optimizationGoal: string | null;
  customEventType: string | null;
  spend: number;
  impressions: number;
  clicks: number;
  /**
   * NULLABLE, because absent and zero are different observations.
   *
   * This was coerced to 0 at the mapper, so an ad-day the provider never
   * reported was counted as a measured zero and entered the account's
   * link-click rate as real evidence. `meta_ad_daily.link_clicks` can hold
   * NULL precisely to keep that distinction; flattening it here threw the
   * distinction away one layer later.
   */
  linkClicks: number | null;
  conversions: number;
  revenue: number;
  landingPageViews?: number | null;
  addToCart?: number | null;
  initiateCheckout?: number | null;
  thumbstop?: number | null;
  truthState: string | null;
  validationStatus: string | null;
  finalizedAt: string | null;
  createdAt: string;
  updatedAt: string;
  campaignSourceRowId: string | null;
  campaignTruthState: string | null;
  campaignValidationStatus: string | null;
  campaignCreatedAt: string | null;
  campaignUpdatedAt: string | null;
  adsetSourceRowId: string | null;
  adsetTruthState: string | null;
  adsetValidationStatus: string | null;
  adsetCreatedAt: string | null;
  adsetUpdatedAt: string | null;
  creativeId?: string | null;
  stateOverlay?: unknown;
  lifecycleOverlay?: unknown;
}

export interface NativeAdCalibrationObservation {
  businessId: string;
  providerAccountRefId: string;
  providerAccountId: string;
  adId: string;
  accountTimezone: string;
  accountCurrency: string;
  campaignId: string;
  adsetId: string;
  objective: string;
  optimizationGoal: string | null;
  customEventType: string | null;
  cohort: MetaFunnelCohort;
  sourceRowIds: string[];
  sourceDayCount: number;
  sourceMinDate: string;
  sourceMaxDate: string;
  sourceMaxUpdatedAt: string;
  totalSpend: number;
  totalConversions: number;
  totalRevenue: number;
  totalImpressions: number;
  totalClicks: number;
  /**
   * Null when ANY contributing row was unreported. The rates derived from it
   * are absent in that case rather than computed over a partial population.
   */
  totalLinkClicks: number | null;
  totalLandingPageViews: number | null;
  totalAddToCart: number | null;
  totalInitiateCheckout: number | null;
  aggregateRoas: number | null;
  aggregateCpa: number | null;
  ctrRate: number | null;
  cpm: number | null;
  thumbstopRate: number | null;
  linkToLpvRate: number | null;
  linkToAtcRate: number | null;
  lpvToAtcRate: number | null;
  atcToIcRate: number | null;
  icToPurchaseRate: number | null;
  clickToPurchaseRate: number | null;
  cumulative28dRoas: number | null;
  cumulative28dCtr: number | null;
  recent7dRoas: number | null;
  recentTotalRatio: number | null;
}

export interface NativeAdCalibrationQualityCounts {
  candidateSourceRowCount: number;
  cutoffSafeSourceRowCount: number;
  candidateAdCount: number;
  eligibleAdObservationCount: number;
  identitySourceRowExclusionCount: number;
  duplicateSourceRowExclusionCount: number;
  duplicateConflictAdExclusionCount: number;
  missingContextAdExclusionCount: number;
  mixedContextAdExclusionCount: number;
  mixedCurrencyAdExclusionCount: number;
  mixedObjectiveAdExclusionCount: number;
  mixedCohortAdExclusionCount: number;
  peerTruthFinalizedAtMissingSourceRowCount: number;
  peerTruthFinalizedAtMissingAdCount: number;
  censoredSourceRowExclusionCount: number;
  censoredAdExclusionCount: number;
  freshnessSourceRowExclusionCount: number;
  freshnessAdExclusionCount: number;
  commercialAuthorityAdExclusionCount: number;
}

export interface NativeAdCalibrationMetricSampleCounts {
  roas: number;
  roasRatio: number;
  cpa: number;
  winner: number;
  refreshRatio: number;
  lowCtr: number;
  ctr: number;
  cpm: number;
  thumbstop: number;
  linkToLpv: number;
  linkToAtc: number;
  lpvToAtc: number;
  atcToIc: number;
  icToPurchase: number;
  clickToPurchase: number;
}

export interface NativeAdCalibrationCellKey {
  businessId: string;
  providerAccountRefId: string;
  providerAccountId: string;
  accountTimezone: string;
  accountCurrency: string;
  cellScope: NativeAdCalibrationCellScope;
  objective: string;
  cohort: MetaFunnelCohort;
  optimizationContext: string;
}

export interface NativeAdCalibrationCell {
  /**
   * The calibration contract this row was MINTED with, read from the durable
   * column rather than assumed to be the current one.
   *
   * Typed as the readable union PLUS the legacy sentinel and a bare string,
   * because a value the database holds is not a value this build gets to
   * assume: an unrecognised stamp must be REFUSABLE, not unrepresentable.
   */
  contractVersion:
    | NativeAdCalibrationReadableContractVersion
    | typeof NATIVE_AD_CALIBRATION_LEGACY_UNKNOWN_CONTRACT
    | (string & {});
  batchId: string | null;
  batchCompleteness: "computed" | "complete";
  batchCellCount: number;
  batchCellSetHash: string;
  key: NativeAdCalibrationCellKey;
  asOfDate: string;
  asOfCutoff: string;
  sampleWindowStart: string;
  sampleWindowEnd: string;
  sampleWindowDays: number;
  computedAt: string;
  engineVersion: string;
  policyVersion: string;
  qualityStatus: NativeAdCalibrationQualityStatus;
  sourceAdCount: number;
  sourceDayCount: number;
  eligibleAdCount: number;
  matureAdCount: number;
  zeroConversionAdCount: number;
  metricSampleCounts: NativeAdCalibrationMetricSampleCounts;
  actionReadiness: NativeAdCalibrationActionReadiness;
  sourceMinDate: string | null;
  sourceMaxDate: string | null;
  sourceMaxUpdatedAt: string | null;
  targetAuthority: ResolvedNativeAdTargetAuthority;
  accountCalibration: AccountCalibration;
  funnelCalibration: AccountFunnelCalibration;
  batchInputManifestHash: string;
  inputManifestHash: string;
  sourceManifestHash: string;
  qualityCounts: NativeAdCalibrationQualityCounts;
}

export interface NativeAdCalibrationBatch {
  contractVersion: typeof NATIVE_AD_CALIBRATION_CONTRACT_VERSION;
  policyVersion: typeof NATIVE_AD_CALIBRATION_POLICY_VERSION;
  engineVersion: string;
  businessId: string;
  providerAccountRefId: string;
  providerAccountId: string;
  sourceProvenance: NativeAdCalibrationSourceProvenance;
  asOfDate: string;
  asOfCutoff: string;
  sampleWindowStart: string;
  sampleWindowEnd: string;
  sampleWindowDays: number;
  computedAt: string;
  targetAuthority: ResolvedNativeAdTargetAuthority;
  spendUnitAuthority: NativeAdSpendUnitAuthority;
  observations: NativeAdCalibrationObservation[];
  qualityCounts: NativeAdCalibrationQualityCounts;
  generationContentHash: string;
  inputManifestHash: string;
  sourceManifestHash: string;
  expectedCellCount: number;
  cellSetHash: string;
  cells: NativeAdCalibrationCell[];
}

export interface ComputeNativeAdCalibrationInput {
  businessId: string;
  providerAccountRefId: string;
  providerAccountId: string;
  asOf: string;
  computationCutoff: string;
  sourceRows: NativeAdCalibrationSourceRow[];
  targetAuthority: NativeAdTargetAuthorityInput | null;
  /**
   * The store's own observed average order value, resolved by the caller.
   *
   * Diagnostic only. It is recorded on the authority so a blocked spend unit
   * can be read against what the store said, and it never chooses the basis —
   * a Meta decision is sized by Meta's attributed AOV.
   *
   * `undefined` means the store was never consulted (a `.v1`-shaped
   * authority); `null` means it was and produced nothing usable.
   */
  observedShopifyAovEvidence?: ObservedShopifyAovEvidence | null;
}

export interface AdCalibrationJobInput {
  businessId: string;
  asOf: string;
}

export interface AdCalibrationJobResult {
  jobRunId: string;
  status: "success" | "failed" | "skipped";
  rowsWritten: number;
  expectedCellCount: number;
  idempotentReplay: boolean;
  inputManifestHash: string | null;
  sourceManifestHash: string | null;
  cellSetHash: string | null;
  batches: NativeAdCalibrationJobBatchResult[];
  durationMs: number;
  reason?:
    | "invalid_business_id"
    | "business_not_found"
    | "engine_v3_disabled"
    | "advisory_lock_not_acquired"
    | "schema_not_ready"
    | "historical_as_of_unsafe";
  errorMessage?: string;
}

export interface NativeAdCalibrationJobBatchResult {
  providerAccountRefId: string;
  providerAccountId: string;
  batchId: string;
  rowsWritten: number;
  expectedCellCount: number;
  idempotentReplay: boolean;
  generationContentHash: string;
  inputManifestHash: string;
  sourceManifestHash: string;
  cellSetHash: string;
  currencyAdmission: NativeAdCalibrationCurrencyAdmission;
  timezoneAdmission: NativeAdCalibrationTimezoneAdmission;
}

export interface NativeAdCalibrationReplacementResult {
  batchId: string;
  rowsWritten: number;
  expectedCellCount: number;
  idempotentReplay: boolean;
  generationContentHash: string;
  inputManifestHash: string;
  sourceManifestHash: string;
  cellSetHash: string;
}

export interface AdCalibrationJobRuntimeOptions {
  db?: DbClient;
  transaction?: <T>(fn: () => Promise<T>) => Promise<T>;
  businessGuard?: typeof getBusinessGuardFailure;
  resolveFlags?: (businessId: string) => Promise<EngineV3Flags>;
  /**
   * The store's observed average order value, per ad account.
   *
   * Injectable for the same reason every other reader here is: this job's
   * tests drive a SQL double that answers a fixed set of statements, and a
   * reader that opens its own connection would fail them for a reason that
   * has nothing to do with calibration. Production uses the real resolver.
   */
  resolveObservedAov?: (
    input: Parameters<typeof resolveObservedShopifyAov>[0],
  ) => Promise<ObservedShopifyAovEvidence | null | undefined>;
}

export class NativeAdHistoricalCalibrationUnsafeError extends Error {
  readonly code = "native_ad_historical_calibration_unsafe";

  constructor(message: string) {
    super(message);
    this.name = "NativeAdHistoricalCalibrationUnsafeError";
  }
}

class NativeAdCalibrationSchemaNotReadyError extends Error {
  readonly code = "native_ad_calibration_schema_not_ready";

  constructor(readonly missing: string[]) {
    super(`Native ad calibration schema is not ready: ${missing.join(", ")}`);
    this.name = "NativeAdCalibrationSchemaNotReadyError";
  }
}

export const READ_NATIVE_AD_CALIBRATION_SOURCE_SQL = `
/* native-ad-calibration-source: one physical account inside the transaction snapshot */
SELECT
  d.id::text AS source_row_id,
  d.business_ref_id::text AS business_id,
  d.provider_account_ref_id::text AS provider_account_ref_id,
  d.provider_account_id,
  d.date::text AS date,
  d.campaign_id,
  d.adset_id,
  d.ad_id,
  NULLIF(BTRIM(d.account_timezone), '') AS account_timezone,
  COALESCE(
    NULLIF(BTRIM(d.account_currency), ''),
    NULLIF(BTRIM(account.currency), '')
  ) AS account_currency,
  NULLIF(BTRIM(d.account_timezone), '') AS source_account_timezone,
  NULLIF(BTRIM(d.account_currency), '') AS source_account_currency,
  d.metric_schema_version,
  campaign.objective,
  COALESCE(adset.optimization_goal, campaign.optimization_goal) AS optimization_goal,
  COALESCE(adset.custom_event_type, campaign.custom_event_type) AS custom_event_type,
  d.spend,
  d.impressions,
  d.clicks,
  d.link_clicks,
  d.conversions,
  d.revenue,
  (NULLIF(d.payload_json->>'landing_page_views', ''))::double precision AS landing_page_views,
  (NULLIF(d.payload_json->>'add_to_cart', ''))::double precision AS add_to_cart,
  (NULLIF(d.payload_json->>'initiate_checkout', ''))::double precision AS initiate_checkout,
  (NULLIF(d.payload_json->>'thumbstop', ''))::double precision AS thumbstop,
  d.truth_state,
  d.validation_status,
  d.finalized_at,
  d.created_at,
  d.updated_at,
  campaign.id::text AS campaign_source_row_id,
  campaign.truth_state AS campaign_truth_state,
  campaign.validation_status AS campaign_validation_status,
  campaign.created_at AS campaign_created_at,
  campaign.updated_at AS campaign_updated_at,
  adset.id::text AS adset_source_row_id,
  adset.truth_state AS adset_truth_state,
  adset.validation_status AS adset_validation_status,
  adset.created_at AS adset_created_at,
  adset.updated_at AS adset_updated_at
FROM meta_ad_daily d
JOIN business_provider_accounts binding
 ON binding.business_id = d.business_ref_id::text
 AND binding.provider = 'meta'
 AND binding.provider_account_id = d.provider_account_id
 AND binding.provider_account_ref_id = d.provider_account_ref_id
JOIN provider_accounts account
  ON account.id = binding.provider_account_ref_id
 AND account.external_account_id = binding.provider_account_id
LEFT JOIN meta_campaign_daily campaign
  ON campaign.business_ref_id = d.business_ref_id
 AND campaign.provider_account_id = d.provider_account_id
 AND campaign.provider_account_ref_id = d.provider_account_ref_id
 AND campaign.campaign_id = d.campaign_id
 AND campaign.date = d.date
 AND campaign.created_at <= $5::timestamptz
 AND campaign.updated_at <= $5::timestamptz
LEFT JOIN meta_adset_daily adset
  ON adset.business_ref_id = d.business_ref_id
 AND adset.provider_account_id = d.provider_account_id
 AND adset.provider_account_ref_id = d.provider_account_ref_id
 AND adset.adset_id = d.adset_id
 AND adset.date = d.date
 AND adset.created_at <= $5::timestamptz
 AND adset.updated_at <= $5::timestamptz
WHERE d.business_ref_id = $1::uuid
  AND d.date BETWEEN ($2::date - INTERVAL '89 days') AND $2::date
  AND d.provider_account_ref_id = $3::uuid
  AND d.provider_account_id = $4
  AND d.created_at <= $5::timestamptz
  AND d.updated_at <= $5::timestamptz
ORDER BY d.ad_id, d.date, d.id
`;

export const READ_NATIVE_AD_TARGET_AUTHORITY_FOR_ACCOUNT_SQL = `
/* native-ad-calibration-target-account: exact tenant/account binding plus bitemporal authority */
SELECT
  history.id::text AS source_row_id,
  history.operation,
  history.target_cpa,
  history.target_roas,
  history.break_even_cpa,
  history.break_even_roas,
  history.aov_assumption AS operator_aov_assumption,
  history.default_risk_posture,
  history.effective_at,
  history.recorded_at
FROM business_target_pack_history history
JOIN business_provider_accounts binding
  ON binding.business_id = history.business_id::text
 AND binding.provider = 'meta'
 AND binding.provider_account_ref_id = $2::uuid
 AND binding.provider_account_id = $3
JOIN provider_accounts account
  ON account.id = binding.provider_account_ref_id
 AND account.external_account_id = binding.provider_account_id
WHERE history.business_id = $1::uuid
  AND history.effective_at <= $4::timestamptz
  AND history.recorded_at <= $4::timestamptz
ORDER BY history.effective_at DESC, history.recorded_at DESC, history.id DESC
LIMIT 1
`;

export const READ_NATIVE_AD_CALIBRATION_TRANSACTION_RECEIPT_SQL = `
SELECT
  transaction_timestamp() AS computation_cutoff,
  lower(current_setting('transaction_isolation')) AS transaction_isolation
`;

export const CREATE_NATIVE_AD_CALIBRATION_BATCH_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS engine_v3_ad_account_calibration_batches (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  -- ROUND 9 ITEM 5. The contract this row was MINTED with, stored rather than
  -- assumed. Without it the runtime recomputed every historical row hash with
  -- today formula, so a version-scoped recompute had no version to scope to and
  -- the whole lineage was decorative.
  contract_version TEXT NOT NULL,
  business_ref_id UUID NOT NULL,
  business_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_account_ref_id UUID NOT NULL,
  provider_account_id TEXT NOT NULL,
  as_of_date DATE NOT NULL,
  as_of_cutoff TIMESTAMPTZ NOT NULL,
  transaction_isolation TEXT NOT NULL,
  engine_version TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  source_mode TEXT NOT NULL,
  source_provenance_json JSONB NOT NULL,
  expected_cell_count INTEGER NOT NULL,
  generation_content_hash CHAR(64) NOT NULL,
  input_manifest_hash CHAR(64) NOT NULL,
  source_manifest_hash CHAR(64) NOT NULL,
  cell_set_hash CHAR(64) NOT NULL,
  completeness_status TEXT NOT NULL,
  job_run_id UUID NOT NULL,
  computed_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT engine_v3_ad_account_calibration_batches_pkey PRIMARY KEY (id),
  CONSTRAINT engine_v3_ad_calibration_batches_business_fk
    FOREIGN KEY (business_ref_id) REFERENCES businesses(id) ON DELETE RESTRICT,
  CONSTRAINT engine_v3_ad_calibration_batches_account_fk
    FOREIGN KEY (provider_account_ref_id, provider, provider_account_id)
    REFERENCES provider_accounts(id, provider, external_account_id) ON DELETE RESTRICT,
  CONSTRAINT engine_v3_ad_calibration_batches_binding_fk
    FOREIGN KEY (business_id, provider, provider_account_ref_id, provider_account_id)
    REFERENCES business_provider_accounts(
      business_id, provider, provider_account_ref_id, provider_account_id
    ) ON DELETE RESTRICT,
  CONSTRAINT engine_v3_ad_calibration_batches_job_fk
    FOREIGN KEY (job_run_id, business_ref_id, business_id, engine_version)
    REFERENCES engine_v3_job_runs(id, business_ref_id, business_id, engine_version)
    ON DELETE RESTRICT,
  CONSTRAINT engine_v3_ad_calibration_batches_business_identity_check
    CHECK (business_id = business_ref_id::text),
  CONSTRAINT engine_v3_ad_calibration_batches_provider_check
    CHECK (provider = 'meta'),
  CONSTRAINT engine_v3_ad_calibration_batches_source_mode_check
    CHECK (source_mode = 'current_transaction_snapshot'),
  CONSTRAINT engine_v3_ad_calibration_batches_isolation_check
    CHECK (transaction_isolation = 'repeatable read'),
  CONSTRAINT engine_v3_ad_calibration_batches_provenance_check
    CHECK (
      jsonb_typeof(source_provenance_json) = 'object' AND
      source_provenance_json->>'mode' = source_mode AND
      source_provenance_json->>'providerAccountRefId' = provider_account_ref_id::text AND
      source_provenance_json->>'providerAccountId' = provider_account_id AND
      (source_provenance_json->>'transactionCutoff')::timestamptz = as_of_cutoff AND
      source_provenance_json->>'transactionIsolation' = transaction_isolation
    ),
  CONSTRAINT engine_v3_ad_calibration_batches_cutoff_date_check
    CHECK ((as_of_cutoff AT TIME ZONE 'UTC')::date = as_of_date),
  CONSTRAINT engine_v3_ad_calibration_batches_computed_cutoff_check
    CHECK (computed_at = as_of_cutoff),
  CONSTRAINT engine_v3_ad_calibration_batches_expected_count_check
    CHECK (expected_cell_count >= 0),
  CONSTRAINT engine_v3_ad_calibration_batches_generation_hash_check
    CHECK (generation_content_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT engine_v3_ad_calibration_batches_input_hash_check
    CHECK (input_manifest_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT engine_v3_ad_calibration_batches_source_hash_check
    CHECK (source_manifest_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT engine_v3_ad_calibration_batches_cell_hash_check
    CHECK (cell_set_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT engine_v3_ad_calibration_batches_completeness_check
    CHECK (
      (completeness_status = 'writing' AND completed_at IS NULL) OR
      (completeness_status = 'complete' AND completed_at IS NOT NULL)
    ),
  CONSTRAINT engine_v3_ad_calibration_batches_content_unique UNIQUE (
    business_ref_id, provider_account_ref_id, provider_account_id,
    as_of_date, engine_version, policy_version, generation_content_hash
  ),
  CONSTRAINT engine_v3_ad_calibration_batches_cutoff_unique UNIQUE (
    business_ref_id, provider_account_ref_id, provider_account_id,
    as_of_cutoff, engine_version, policy_version
  ),
  CONSTRAINT engine_v3_ad_calibration_batches_lineage_unique UNIQUE (
    id, business_ref_id, business_id, provider, provider_account_ref_id,
    provider_account_id, as_of_date, as_of_cutoff, engine_version,
    policy_version, input_manifest_hash, source_manifest_hash
  )
)
`;

export const CREATE_NATIVE_AD_CALIBRATION_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS engine_v3_ad_account_calibration_daily (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  -- Must equal its batch's. Enforced in the reader JOIN and asserted again in
  -- validateCell: a cell and its batch disagreeing about the formula they were
  -- written with is a corrupt generation, not a version to choose between.
  contract_version TEXT NOT NULL,
  batch_id UUID NOT NULL,
  business_ref_id UUID NOT NULL,
  business_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_account_ref_id UUID NOT NULL,
  provider_account_id TEXT NOT NULL,
  account_timezone TEXT NOT NULL,
  account_currency TEXT NOT NULL,
  cell_scope TEXT NOT NULL,
  objective TEXT NOT NULL,
  funnel_cohort TEXT NOT NULL,
  optimization_context TEXT NOT NULL,
  as_of_date DATE NOT NULL,
  as_of_cutoff TIMESTAMPTZ NOT NULL,
  engine_version TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  sample_window_start DATE NOT NULL,
  sample_window_end DATE NOT NULL,
  sample_window_days INTEGER NOT NULL,
  source_ad_count INTEGER NOT NULL,
  source_day_count INTEGER NOT NULL,
  eligible_ad_count INTEGER NOT NULL,
  mature_ad_count INTEGER NOT NULL,
  zero_conversion_ad_count INTEGER NOT NULL,
  roas_p75 DOUBLE PRECISION,
  roas_p60 DOUBLE PRECISION,
  refresh_ratio_p10 DOUBLE PRECISION,
  low_ctr_p10 DOUBLE PRECISION,
  account_cpa_p50 DOUBLE PRECISION,
  account_cpa_sample_count INTEGER NOT NULL,
  meta_attributed_aov_mean_90d DOUBLE PRECISION,
  meta_attributed_aov_purchase_count_90d INTEGER NOT NULL,
  meta_attributed_revenue_90d DOUBLE PRECISION NOT NULL DEFAULT 0,
  meta_aov_quality TEXT NOT NULL,
  mature_spend_p50 DOUBLE PRECISION,
  mature_spend_p75 DOUBLE PRECISION,
  winner_spend_p25 DOUBLE PRECISION,
  winner_spend_p50 DOUBLE PRECISION,
  winner_purchase_p50 DOUBLE PRECISION,
  roas_ratio_p10 DOUBLE PRECISION,
  roas_ratio_p25 DOUBLE PRECISION,
  roas_ratio_p50 DOUBLE PRECISION,
  roas_ratio_p75 DOUBLE PRECISION,
  funnel_calibration_json JSONB NOT NULL,
  metric_sample_counts_json JSONB NOT NULL,
  action_readiness_json JSONB NOT NULL,
  quality_counts_json JSONB NOT NULL,
  quality_status TEXT NOT NULL,
  target_authority_status TEXT NOT NULL,
  target_roas DOUBLE PRECISION,
  break_even_roas DOUBLE PRECISION,
  target_effective_at TIMESTAMPTZ,
  target_recorded_at TIMESTAMPTZ,
  target_authority_hash CHAR(64) NOT NULL,
  source_min_date DATE,
  source_max_date DATE,
  source_max_updated_at TIMESTAMPTZ,
  batch_input_manifest_hash CHAR(64) NOT NULL,
  input_manifest_hash CHAR(64) NOT NULL,
  source_manifest_hash CHAR(64) NOT NULL,
  job_run_id UUID NOT NULL,
  computed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT engine_v3_ad_account_calibration_daily_pkey PRIMARY KEY (id),
  CONSTRAINT engine_v3_ad_calibration_daily_business_fk
    FOREIGN KEY (business_ref_id) REFERENCES businesses(id) ON DELETE RESTRICT,
  CONSTRAINT engine_v3_ad_calibration_daily_account_fk
    FOREIGN KEY (provider_account_ref_id, provider, provider_account_id)
    REFERENCES provider_accounts(id, provider, external_account_id) ON DELETE RESTRICT,
  CONSTRAINT engine_v3_ad_calibration_daily_binding_fk
    FOREIGN KEY (business_id, provider, provider_account_ref_id, provider_account_id)
    REFERENCES business_provider_accounts(
      business_id, provider, provider_account_ref_id, provider_account_id
    ) ON DELETE RESTRICT,
  CONSTRAINT engine_v3_ad_calibration_daily_job_fk
    FOREIGN KEY (job_run_id, business_ref_id, business_id, engine_version)
    REFERENCES engine_v3_job_runs(id, business_ref_id, business_id, engine_version)
    ON DELETE RESTRICT,
  CONSTRAINT engine_v3_ad_calibration_daily_batch_fk FOREIGN KEY (
    batch_id, business_ref_id, business_id, provider, provider_account_ref_id,
    provider_account_id, as_of_date, as_of_cutoff, engine_version,
    policy_version, batch_input_manifest_hash, source_manifest_hash
  ) REFERENCES engine_v3_ad_account_calibration_batches (
    id, business_ref_id, business_id, provider, provider_account_ref_id,
    provider_account_id, as_of_date, as_of_cutoff, engine_version,
    policy_version, input_manifest_hash, source_manifest_hash
  ) ON DELETE RESTRICT,
  CONSTRAINT engine_v3_ad_calibration_daily_business_identity_check
    CHECK (business_id = business_ref_id::text),
  CONSTRAINT engine_v3_ad_calibration_daily_provider_check
    CHECK (provider = 'meta'),
  CONSTRAINT engine_v3_ad_calibration_daily_scope_check
    CHECK (cell_scope IN ('objective_cohort_context', 'account_objective_cohort')),
  CONSTRAINT engine_v3_ad_calibration_daily_cohort_check
    CHECK (funnel_cohort IN ('purchase', 'mid_funnel', 'lead', 'traffic', 'upper_funnel', 'engagement', 'unknown')),
  CONSTRAINT engine_v3_ad_calibration_daily_window_check
    CHECK (sample_window_days > 0 AND sample_window_start <= sample_window_end),
  CONSTRAINT engine_v3_ad_calibration_daily_counts_check CHECK (
    source_ad_count >= 0 AND source_day_count >= 0 AND
    eligible_ad_count >= 0 AND mature_ad_count >= 0 AND
    zero_conversion_ad_count >= 0 AND account_cpa_sample_count >= 0 AND
    meta_attributed_aov_purchase_count_90d >= 0
  ),
  CONSTRAINT engine_v3_ad_calibration_daily_action_readiness_check
    CHECK (jsonb_typeof(action_readiness_json) = 'object'),
  CONSTRAINT engine_v3_ad_calibration_daily_meta_aov_quality_check
    CHECK (meta_aov_quality IN ('unavailable', 'unstable', 'low_sample', 'ready')),
  CONSTRAINT engine_v3_ad_calibration_daily_quality_status_check
    CHECK (quality_status IN ('ready', 'low_sample', 'insufficient', 'blocked_commercial', 'unsupported_cohort')),
  CONSTRAINT engine_v3_ad_calibration_daily_target_status_check
    CHECK (target_authority_status IN ('fresh', 'stale', 'missing', 'cutoff_unsafe')),
  CONSTRAINT engine_v3_ad_calibration_daily_hashes_check CHECK (
    target_authority_hash ~ '^[0-9a-f]{64}$' AND
    batch_input_manifest_hash ~ '^[0-9a-f]{64}$' AND
    input_manifest_hash ~ '^[0-9a-f]{64}$' AND
    source_manifest_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT engine_v3_ad_calibration_daily_computed_cutoff_check
    CHECK (computed_at = as_of_cutoff),
  CONSTRAINT engine_v3_ad_calibration_daily_cell_unique UNIQUE (
    batch_id,
    account_currency,
    account_timezone,
    cell_scope,
    objective,
    funnel_cohort,
    optimization_context
  )
)
`;

export const CREATE_NATIVE_AD_CALIBRATION_DEPENDENCY_INDEX_SQL = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_accounts_physical_identity
ON provider_accounts (id, provider, external_account_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_business_provider_accounts_physical_binding
ON business_provider_accounts (
  business_id, provider, provider_account_ref_id, provider_account_id
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_engine_v3_job_runs_native_lineage
ON engine_v3_job_runs (id, business_ref_id, business_id, engine_version)
`;

export const CREATE_NATIVE_AD_CALIBRATION_INDEX_SQL = `
CREATE INDEX IF NOT EXISTS idx_engine_v3_ad_calibration_batch_lookup
ON engine_v3_ad_account_calibration_batches (
  business_ref_id,
  provider_account_ref_id,
  provider_account_id,
  as_of_date,
  engine_version,
  policy_version,
  completeness_status,
  as_of_cutoff DESC,
  id DESC
);
CREATE INDEX IF NOT EXISTS idx_engine_v3_ad_account_calibration_lookup
ON engine_v3_ad_account_calibration_daily (
  batch_id,
  account_currency,
  account_timezone,
  funnel_cohort,
  objective,
  optimization_context
)
`;

export const CREATE_NATIVE_AD_CALIBRATION_IMMUTABILITY_SQL = `
CREATE OR REPLACE FUNCTION engine_v3_native_ad_calibration_batch_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'completed native ad calibration batches are append-only';
  END IF;
  IF OLD.completeness_status <> 'writing'
     OR NEW.completeness_status <> 'complete'
     OR NEW.completed_at IS NULL
     OR (to_jsonb(NEW) - ARRAY['completeness_status', 'completed_at']::text[])
        IS DISTINCT FROM
        (to_jsonb(OLD) - ARRAY['completeness_status', 'completed_at']::text[])
  THEN
    RAISE EXCEPTION 'native ad calibration batch mutation is forbidden';
  END IF;
  IF (
    SELECT count(*)
    FROM engine_v3_ad_account_calibration_daily cell
    WHERE cell.batch_id = OLD.id
  ) <> NEW.expected_cell_count THEN
    RAISE EXCEPTION 'native ad calibration batch cardinality proof failed';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS engine_v3_native_ad_calibration_batch_immutable_trigger
  ON engine_v3_ad_account_calibration_batches;
CREATE TRIGGER engine_v3_native_ad_calibration_batch_immutable_trigger
BEFORE UPDATE OR DELETE ON engine_v3_ad_account_calibration_batches
FOR EACH ROW EXECUTE FUNCTION engine_v3_native_ad_calibration_batch_immutable();

CREATE OR REPLACE FUNCTION engine_v3_native_ad_calibration_cell_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (
      SELECT 1
      FROM engine_v3_ad_account_calibration_batches batch
      WHERE batch.id = NEW.batch_id
        AND batch.completeness_status = 'writing'
    ) THEN
      RAISE EXCEPTION 'native ad calibration cells require a writing batch';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'native ad calibration cells are immutable';
END
$$;
DROP TRIGGER IF EXISTS engine_v3_native_ad_calibration_cell_immutable_trigger
  ON engine_v3_ad_account_calibration_daily;
CREATE TRIGGER engine_v3_native_ad_calibration_cell_immutable_trigger
BEFORE INSERT OR UPDATE OR DELETE ON engine_v3_ad_account_calibration_daily
FOR EACH ROW EXECUTE FUNCTION engine_v3_native_ad_calibration_cell_immutable()
`;

/**
 * The additive migration that gives EXISTING rows a truthful contract stamp.
 *
 * ── ROUND 9 ITEM 5 ─────────────────────────────────────────────────────────
 * `ADD COLUMN ... DEFAULT ... NOT NULL` is a metadata-only operation on
 * PostgreSQL 11+ — it rewrites no rows and, decisively, fires no row triggers.
 * That matters here: both tables carry BEFORE UPDATE triggers that raise
 * unconditionally, so a backfill written as `UPDATE ... SET contract_version`
 * would abort the migration on the first existing row.
 *
 * The default is then DROPPED, so every new insert must state its contract
 * explicitly and a future writer cannot silently inherit `legacy_unknown`.
 *
 * On a fresh database the `CREATE TABLE` above already declares the column and
 * every statement here is a no-op; on an existing one the `CREATE TABLE` is the
 * no-op and these do the work. Both orders converge on the same schema.
 */
export const ALTER_NATIVE_AD_CALIBRATION_CONTRACT_VERSION_SQL = `
ALTER TABLE engine_v3_ad_account_calibration_batches
  ADD COLUMN IF NOT EXISTS contract_version TEXT NOT NULL
  DEFAULT '${NATIVE_AD_CALIBRATION_LEGACY_UNKNOWN_CONTRACT}';
ALTER TABLE engine_v3_ad_account_calibration_batches
  ALTER COLUMN contract_version DROP DEFAULT;
ALTER TABLE engine_v3_ad_account_calibration_batches
  DROP CONSTRAINT IF EXISTS engine_v3_ad_calibration_batches_contract_version_check;
ALTER TABLE engine_v3_ad_account_calibration_batches
  ADD CONSTRAINT engine_v3_ad_calibration_batches_contract_version_check
  ${nativeAdCalibrationContractVersionCheck()};

ALTER TABLE engine_v3_ad_account_calibration_daily
  ADD COLUMN IF NOT EXISTS contract_version TEXT NOT NULL
  DEFAULT '${NATIVE_AD_CALIBRATION_LEGACY_UNKNOWN_CONTRACT}';
ALTER TABLE engine_v3_ad_account_calibration_daily
  ALTER COLUMN contract_version DROP DEFAULT;
ALTER TABLE engine_v3_ad_account_calibration_daily
  DROP CONSTRAINT IF EXISTS engine_v3_ad_calibration_cells_contract_version_check;
ALTER TABLE engine_v3_ad_account_calibration_daily
  ADD CONSTRAINT engine_v3_ad_calibration_cells_contract_version_check
  ${nativeAdCalibrationContractVersionCheck()}
`;

export const NATIVE_AD_CALIBRATION_MIGRATION_SQL = [
  CREATE_NATIVE_AD_CALIBRATION_DEPENDENCY_INDEX_SQL,
  CREATE_NATIVE_AD_CALIBRATION_BATCH_TABLE_SQL,
  CREATE_NATIVE_AD_CALIBRATION_TABLE_SQL,
  ALTER_NATIVE_AD_CALIBRATION_CONTRACT_VERSION_SQL,
  CREATE_NATIVE_AD_CALIBRATION_INDEX_SQL,
  CREATE_NATIVE_AD_CALIBRATION_IMMUTABILITY_SQL,
].join(";\n");

export const INSERT_NATIVE_AD_CALIBRATION_SQL = `
INSERT INTO engine_v3_ad_account_calibration_daily (
  contract_version,
  batch_id,
  business_ref_id,
  business_id,
  provider,
  provider_account_ref_id,
  provider_account_id,
  account_timezone,
  account_currency,
  cell_scope,
  objective,
  funnel_cohort,
  optimization_context,
  as_of_date,
  as_of_cutoff,
  engine_version,
  policy_version,
  sample_window_start,
  sample_window_end,
  sample_window_days,
  source_ad_count,
  source_day_count,
  eligible_ad_count,
  mature_ad_count,
  zero_conversion_ad_count,
  roas_p75,
  roas_p60,
  refresh_ratio_p10,
  low_ctr_p10,
  account_cpa_p50,
  account_cpa_sample_count,
  meta_attributed_aov_mean_90d,
  meta_attributed_aov_purchase_count_90d,
  meta_attributed_revenue_90d,
  meta_aov_quality,
  mature_spend_p50,
  mature_spend_p75,
  winner_spend_p25,
  winner_spend_p50,
  winner_purchase_p50,
  roas_ratio_p10,
  roas_ratio_p25,
  roas_ratio_p50,
  roas_ratio_p75,
  funnel_calibration_json,
  metric_sample_counts_json,
  action_readiness_json,
  quality_counts_json,
  quality_status,
  target_authority_status,
  target_roas,
  break_even_roas,
  target_effective_at,
  target_recorded_at,
  target_authority_hash,
  source_min_date,
  source_max_date,
  source_max_updated_at,
  batch_input_manifest_hash,
  input_manifest_hash,
  source_manifest_hash,
  job_run_id,
  computed_at
)
SELECT
  row.contract_version,
  row.batch_id,
  row.business_ref_id,
  row.business_id,
  row.provider,
  row.provider_account_ref_id,
  row.provider_account_id,
  row.account_timezone,
  row.account_currency,
  row.cell_scope,
  row.objective,
  row.funnel_cohort,
  row.optimization_context,
  row.as_of_date,
  row.as_of_cutoff,
  row.engine_version,
  row.policy_version,
  row.sample_window_start,
  row.sample_window_end,
  row.sample_window_days,
  row.source_ad_count,
  row.source_day_count,
  row.eligible_ad_count,
  row.mature_ad_count,
  row.zero_conversion_ad_count,
  row.roas_p75,
  row.roas_p60,
  row.refresh_ratio_p10,
  row.low_ctr_p10,
  row.account_cpa_p50,
  row.account_cpa_sample_count,
  row.meta_attributed_aov_mean_90d,
  row.meta_attributed_aov_purchase_count_90d,
  row.meta_attributed_revenue_90d,
  row.meta_aov_quality,
  row.mature_spend_p50,
  row.mature_spend_p75,
  row.winner_spend_p25,
  row.winner_spend_p50,
  row.winner_purchase_p50,
  row.roas_ratio_p10,
  row.roas_ratio_p25,
  row.roas_ratio_p50,
  row.roas_ratio_p75,
  row.funnel_calibration_json,
  row.metric_sample_counts_json,
  row.action_readiness_json,
  row.quality_counts_json,
  row.quality_status,
  row.target_authority_status,
  row.target_roas,
  row.break_even_roas,
  row.target_effective_at,
  row.target_recorded_at,
  row.target_authority_hash,
  row.source_min_date,
  row.source_max_date,
  row.source_max_updated_at,
  row.batch_input_manifest_hash,
  row.input_manifest_hash,
  row.source_manifest_hash,
  row.job_run_id,
  row.computed_at
FROM jsonb_to_recordset($1::jsonb) AS row(
  contract_version text,
  batch_id uuid,
  business_ref_id uuid,
  business_id text,
  provider text,
  provider_account_ref_id uuid,
  provider_account_id text,
  account_timezone text,
  account_currency text,
  cell_scope text,
  objective text,
  funnel_cohort text,
  optimization_context text,
  as_of_date date,
  as_of_cutoff timestamptz,
  engine_version text,
  policy_version text,
  sample_window_start date,
  sample_window_end date,
  sample_window_days integer,
  source_ad_count integer,
  source_day_count integer,
  eligible_ad_count integer,
  mature_ad_count integer,
  zero_conversion_ad_count integer,
  roas_p75 double precision,
  roas_p60 double precision,
  refresh_ratio_p10 double precision,
  low_ctr_p10 double precision,
  account_cpa_p50 double precision,
  account_cpa_sample_count integer,
  meta_attributed_aov_mean_90d double precision,
  meta_attributed_aov_purchase_count_90d integer,
  meta_attributed_revenue_90d double precision,
  meta_aov_quality text,
  mature_spend_p50 double precision,
  mature_spend_p75 double precision,
  winner_spend_p25 double precision,
  winner_spend_p50 double precision,
  winner_purchase_p50 double precision,
  roas_ratio_p10 double precision,
  roas_ratio_p25 double precision,
  roas_ratio_p50 double precision,
  roas_ratio_p75 double precision,
  funnel_calibration_json jsonb,
  metric_sample_counts_json jsonb,
  action_readiness_json jsonb,
  quality_counts_json jsonb,
  quality_status text,
  target_authority_status text,
  target_roas double precision,
  break_even_roas double precision,
  target_effective_at timestamptz,
  target_recorded_at timestamptz,
  target_authority_hash char(64),
  source_min_date date,
  source_max_date date,
  source_max_updated_at timestamptz,
  batch_input_manifest_hash char(64),
  input_manifest_hash char(64),
  source_manifest_hash char(64),
  job_run_id uuid,
  computed_at timestamptz
)
`;

export const LIST_NATIVE_AD_PROVIDER_BINDINGS_SQL = `
SELECT DISTINCT
  binding.provider_account_ref_id::text AS provider_account_ref_id,
  binding.provider_account_id,
  -- The account's own currency, carried so the caller can resolve a store
  -- benchmark in the SAME currency. No conversion is ever performed.
  account.currency AS account_currency
FROM business_provider_accounts binding
JOIN provider_accounts account
  ON account.id = binding.provider_account_ref_id
 AND account.external_account_id = binding.provider_account_id
WHERE binding.business_id = $1
  AND binding.provider = 'meta'
ORDER BY provider_account_ref_id, provider_account_id
`;

export const ASSERT_NATIVE_AD_PROVIDER_BINDINGS_SQL = `
SELECT
  binding.provider_account_ref_id::text AS provider_account_ref_id,
  binding.provider_account_id
FROM business_provider_accounts binding
JOIN provider_accounts account
  ON account.id = binding.provider_account_ref_id
 AND account.external_account_id = binding.provider_account_id
WHERE binding.business_id = $1
  AND binding.provider = 'meta'
  AND binding.provider_account_ref_id = $2::uuid
  AND binding.provider_account_id = $3
`;

export const READ_EXISTING_NATIVE_AD_CALIBRATION_BATCH_BY_CONTENT_SQL = `
SELECT
  id::text AS id,
  as_of_cutoff,
  generation_content_hash,
  input_manifest_hash,
  source_manifest_hash,
  cell_set_hash,
  expected_cell_count
FROM engine_v3_ad_account_calibration_batches
WHERE business_ref_id = $1::uuid
  AND provider_account_ref_id = $2::uuid
  AND provider_account_id = $3
  AND as_of_date = $4::date
  AND engine_version = $5
  AND policy_version = $6
  AND generation_content_hash = $7
  AND completeness_status = 'complete'
ORDER BY as_of_cutoff DESC, id DESC
LIMIT 2
`;

export const READ_NATIVE_AD_CALIBRATION_BATCH_AT_CUTOFF_SQL = `
SELECT id::text AS id, completeness_status, generation_content_hash
FROM engine_v3_ad_account_calibration_batches
WHERE business_ref_id = $1::uuid
  AND provider_account_ref_id = $2::uuid
  AND provider_account_id = $3
  AND as_of_cutoff = $4::timestamptz
  AND engine_version = $5
  AND policy_version = $6
LIMIT 2
`;

export const INSERT_NATIVE_AD_CALIBRATION_BATCH_SQL = `
INSERT INTO engine_v3_ad_account_calibration_batches (
  contract_version,
  business_ref_id,
  business_id,
  provider,
  provider_account_ref_id,
  provider_account_id,
  as_of_date,
  as_of_cutoff,
  transaction_isolation,
  engine_version,
  policy_version,
  source_mode,
  source_provenance_json,
  expected_cell_count,
  generation_content_hash,
  input_manifest_hash,
  source_manifest_hash,
  cell_set_hash,
  completeness_status,
  job_run_id,
  computed_at
) VALUES (
  $19, $1::uuid, $2, 'meta', $3::uuid, $4, $5::date, $6::timestamptz, $7,
  $8, $9, $10, $11::jsonb, $12::integer, $13, $14, $15, $16,
  'writing', $17::uuid, $18::timestamptz
)
RETURNING id::text AS id
`;

export const READ_NATIVE_AD_CALIBRATION_CELL_SET_PROOF_SQL = `
SELECT
  business_ref_id::text AS business_id,
  provider_account_ref_id::text AS provider_account_ref_id,
  provider_account_id,
  account_timezone,
  account_currency,
  cell_scope,
  objective,
  funnel_cohort,
  optimization_context,
  input_manifest_hash,
  source_manifest_hash
FROM engine_v3_ad_account_calibration_daily
WHERE batch_id = $1::uuid
ORDER BY
  provider_account_id,
  account_timezone,
  account_currency,
  cell_scope,
  objective,
  funnel_cohort,
  optimization_context
`;

export const COMPLETE_NATIVE_AD_CALIBRATION_BATCH_SQL = `
UPDATE engine_v3_ad_account_calibration_batches
SET completeness_status = 'complete', completed_at = transaction_timestamp()
WHERE id = $1::uuid
  AND completeness_status = 'writing'
  AND expected_cell_count = $2::integer
  AND input_manifest_hash = $3
  AND source_manifest_hash = $4
  AND cell_set_hash = $5
RETURNING id::text AS id
`;

interface NormalizedSourceRow extends NativeAdCalibrationSourceRow {
  businessId: string;
  providerAccountRefId: string;
  providerAccountId: string;
  date: string;
  campaignId: string | null;
  adsetId: string | null;
  adId: string;
  accountTimezone: string | null;
  accountCurrency: string | null;
  sourceAccountTimezone: string | null;
  sourceAccountCurrency: string | null;
  metricSchemaVersion: number;
  objective: string | null;
  optimizationGoal: string | null;
  customEventType: string | null;
  finalizedAt: string | null;
  createdAt: string;
  updatedAt: string;
  campaignCreatedAt: string | null;
  campaignUpdatedAt: string | null;
  adsetCreatedAt: string | null;
  adsetUpdatedAt: string | null;
}

interface ObservationBuildResult {
  observations: NativeAdCalibrationObservation[];
  qualityCounts: NativeAdCalibrationQualityCounts;
  eligibleSourceRows: NormalizedSourceRow[];
}

interface NativeAdSpendUnitAuthorityBuild {
  authority: NativeAdSpendUnitAuthority;
  manifestRows: NormalizedSourceRow[];
}

export function resolveNativeAdCalibrationDate(asOf: string): {
  asOfDate: string;
  sampleWindowStart: string;
  sampleWindowEnd: string;
} {
  const trimmed = asOf.trim();
  const parsed = new Date(`${trimmed}T00:00:00.000Z`);
  if (
    !isDateOnly(trimmed) ||
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== trimmed
  ) {
    throw new NativeAdHistoricalCalibrationUnsafeError(
      "Native ad calibration is current-only and requires a valid date-only asOf.",
    );
  }
  return {
    asOfDate: trimmed,
    sampleWindowStart: addUtcDays(trimmed, -(SAMPLE_WINDOW_DAYS - 1)),
    sampleWindowEnd: trimmed,
  };
}

export function resolveNativeAdCalibrationCutoff(
  asOf: string,
  computationCutoff: string,
): {
  asOfDate: string;
  asOfCutoff: string;
  sampleWindowStart: string;
  sampleWindowEnd: string;
} {
  const window = resolveNativeAdCalibrationDate(asOf);
  /*
    THE CUTOFF IS AN AUTHORITY BOUNDARY, so it is read strictly too.

    `normalizeRequiredTimestamp` is the same laundering helper as above. At the
    production call site this value is already `Date#toISOString()` output from
    the driver's `transaction_timestamp()`, so nothing legitimate changes; what
    closes is every OTHER caller — replays, fixtures, future plumbing — being
    able to hand in a date-only or impossible cutoff and have it rewritten into
    a usable one. A cutoff that is not a real instant cannot bound anything.
  */
  const asOfCutoff = strictCommercialClock(computationCutoff);
  if (asOfCutoff === null) {
    throw new TypeError(
      "computationCutoff must be a strict RFC 3339 UTC instant with an explicit offset.",
    );
  }
  if (asOfCutoff.slice(0, 10) !== window.asOfDate) {
    throw new NativeAdHistoricalCalibrationUnsafeError(
      "Native ad calibration is current-only: asOf must equal the database transaction cutoff UTC date.",
    );
  }
  return {
    ...window,
    asOfCutoff,
  };
}

function assertNativeAdSourceBindings(input: {
  businessId: string;
  providerAccountRefId: string;
  providerAccountId: string;
  rows: NormalizedSourceRow[];
}) {
  for (const row of input.rows) {
    if (row.businessId !== input.businessId) {
      throw new Error(
        `Native ad calibration source business binding mismatch for ${row.sourceRowId || "unknown source row"}.`,
      );
    }
    if (
      row.providerAccountRefId !== input.providerAccountRefId ||
      row.providerAccountId !== input.providerAccountId
    ) {
      throw new Error(
        `Native ad calibration source provider binding mismatch for ${row.sourceRowId || "unknown source row"}.`,
      );
    }
  }
}

interface NativeAdCalibrationAdmissionInput {
  businessId: string;
  providerAccountRefId: string;
  providerAccountId: string;
  sampleWindowStart: string;
  sampleWindowEnd: string;
  asOfCutoff: string;
  rows: NormalizedSourceRow[];
}

function nativeAdCalibrationAdmissionCandidateRows(
  input: NativeAdCalibrationAdmissionInput,
) {
  return input.rows
    .filter(
      (row) =>
        row.date >= input.sampleWindowStart &&
        row.date <= input.sampleWindowEnd &&
        hasFinalizedAdFact(row) &&
        isAdFactAvailableAtCutoff(row, input.asOfCutoff),
    )
    .sort((left, right) =>
      sourceManifestEntry(left).sortKey.localeCompare(
        sourceManifestEntry(right).sortKey,
      ),
    );
}

function resolveNativeAdCalibrationCurrencyAdmission(
  input: NativeAdCalibrationAdmissionInput,
): NativeAdCalibrationCurrencyAdmission {
  const candidateRows = nativeAdCalibrationAdmissionCandidateRows(input);
  const sourceCurrencies = new Set(
    candidateRows
      .map((row) => row.sourceAccountCurrency)
      .filter((value): value is string => value !== null),
  );
  const resolvedCurrencies = new Set(
    candidateRows
      .map((row) => row.accountCurrency)
      .filter((value): value is string => value !== null),
  );
  const sourceCurrencyMissingRowCount = candidateRows.filter(
    (row) => row.sourceAccountCurrency === null,
  ).length;
  const resolvedCurrencyMissingRowCount = candidateRows.filter(
    (row) => row.accountCurrency === null,
  ).length;
  const resolvedSourceMismatchRowCount = candidateRows.filter(
    (row) =>
      row.sourceAccountCurrency !== null &&
      row.accountCurrency !== row.sourceAccountCurrency,
  ).length;
  const mixedCurrency =
    sourceCurrencies.size > 1 || resolvedCurrencies.size > 1;
  const accountCurrency =
    sourceCurrencies.size === 1
      ? ([...sourceCurrencies][0] ?? null)
      : sourceCurrencies.size === 0 && resolvedCurrencies.size === 1
        ? ([...resolvedCurrencies][0] ?? null)
        : null;
  const keyBasis =
    sourceCurrencies.size === 1
      ? ("immutable_source" as const)
      : sourceCurrencies.size === 0 && resolvedCurrencies.size === 1
        ? ("bound_provider_fallback" as const)
        : null;

  let status: NativeAdCalibrationCurrencyAdmission["status"];
  let reason: NativeAdCalibrationCurrencyAdmission["reason"];
  if (candidateRows.length === 0) {
    status = "unavailable";
    reason = "source_currency_unavailable";
  } else if (resolvedCurrencyMissingRowCount > 0) {
    status = "blocked";
    reason = "resolved_currency_missing";
  } else if (resolvedSourceMismatchRowCount > 0) {
    status = "blocked";
    reason = "resolved_source_currency_mismatch";
  } else if (mixedCurrency) {
    status = "blocked";
    reason = "mixed_source_currency";
  } else if (sourceCurrencyMissingRowCount > 0) {
    status = "blocked";
    reason = "source_currency_missing";
  } else {
    status = "ready";
    reason = null;
  }
  const anomalyRowCount =
    status === "ready" || status === "unavailable"
      ? 0
      : mixedCurrency
        ? candidateRows.length
        : candidateRows.filter(
            (row) =>
              row.sourceAccountCurrency === null ||
              row.accountCurrency === null ||
              row.accountCurrency !== row.sourceAccountCurrency,
          ).length;
  const manifestHash = canonicalSha256({
    contractVersion: "engine-v3-native-ad-currency-admission.v1",
    businessId: input.businessId,
    providerAccountRefId: input.providerAccountRefId,
    providerAccountId: input.providerAccountId,
    sampleWindowStart: input.sampleWindowStart,
    sampleWindowEnd: input.sampleWindowEnd,
    asOfCutoff: input.asOfCutoff,
    rows: candidateRows.map((row) => ({
      sourceRowId: row.sourceRowId,
      adId: row.adId,
      date: row.date,
      accountCurrency: row.accountCurrency,
      sourceAccountCurrency: row.sourceAccountCurrency,
      truthState: row.truthState,
      validationStatus: row.validationStatus,
      finalizedAt: row.finalizedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    })),
  });
  return {
    contractVersion: "engine-v3-native-ad-currency-admission.v1",
    status,
    keyBasis,
    accountCurrency,
    reason,
    candidateRowCount: candidateRows.length,
    admittedRowCount: status === "ready" ? candidateRows.length : 0,
    anomalyRowCount,
    sourceCurrencyMissingRowCount,
    resolvedCurrencyMissingRowCount,
    resolvedSourceMismatchRowCount,
    distinctSourceCurrencyCount: sourceCurrencies.size,
    distinctResolvedCurrencyCount: resolvedCurrencies.size,
    manifestHash,
  };
}

function resolveNativeAdCalibrationTimezoneAdmission(
  input: NativeAdCalibrationAdmissionInput,
): NativeAdCalibrationTimezoneAdmission {
  const candidateRows = nativeAdCalibrationAdmissionCandidateRows(input);
  const latestSourceDate = maxText(candidateRows.map((row) => row.date));
  const latestSourceRows =
    latestSourceDate === null
      ? []
      : candidateRows.filter((row) => row.date === latestSourceDate);
  const sourceTimezones = new Set(
    latestSourceRows
      .map((row) => row.sourceAccountTimezone)
      .filter((value): value is string => value !== null),
  );
  const sourceTimezoneMissingRowCount = latestSourceRows.filter(
    (row) => row.sourceAccountTimezone === null,
  ).length;
  const mixedTimezone = sourceTimezones.size > 1;
  const accountTimezone =
    sourceTimezones.size === 1 ? ([...sourceTimezones][0] ?? null) : null;

  let status: NativeAdCalibrationTimezoneAdmission["status"];
  let reason: NativeAdCalibrationTimezoneAdmission["reason"];
  if (candidateRows.length === 0) {
    status = "unavailable";
    reason = "source_timezone_unavailable";
  } else if (sourceTimezoneMissingRowCount > 0) {
    status = "blocked";
    reason = "latest_source_timezone_missing";
  } else if (mixedTimezone) {
    status = "blocked";
    reason = "mixed_latest_source_timezone";
  } else {
    status = "ready";
    reason = null;
  }
  const anomalyRowCount =
    status === "ready" || status === "unavailable"
      ? 0
      : mixedTimezone
        ? latestSourceRows.length
        : sourceTimezoneMissingRowCount;
  const manifestHash = canonicalSha256({
    contractVersion: "engine-v3-native-ad-timezone-admission.v1",
    businessId: input.businessId,
    providerAccountRefId: input.providerAccountRefId,
    providerAccountId: input.providerAccountId,
    sampleWindowStart: input.sampleWindowStart,
    sampleWindowEnd: input.sampleWindowEnd,
    asOfCutoff: input.asOfCutoff,
    latestSourceDate,
    rows: candidateRows.map((row) => ({
      sourceRowId: row.sourceRowId,
      adId: row.adId,
      date: row.date,
      sourceAccountTimezone: row.sourceAccountTimezone,
      truthState: row.truthState,
      validationStatus: row.validationStatus,
      finalizedAt: row.finalizedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    })),
  });
  return {
    contractVersion: "engine-v3-native-ad-timezone-admission.v1",
    status,
    keyBasis:
      status === "ready" ? "immutable_latest_source_date" : null,
    accountTimezone,
    reason,
    candidateRowCount: candidateRows.length,
    latestSourceDate,
    latestSourceRowCount: latestSourceRows.length,
    admittedRowCount: status === "ready" ? candidateRows.length : 0,
    anomalyRowCount,
    sourceTimezoneMissingRowCount,
    distinctSourceTimezoneCount: sourceTimezones.size,
    manifestHash,
  };
}

function bindNativeAdCalibrationTimezone(
  rows: NormalizedSourceRow[],
  admission: NativeAdCalibrationTimezoneAdmission,
): NormalizedSourceRow[] {
  if (admission.status !== "ready" || admission.accountTimezone === null) {
    return rows;
  }
  return rows.map((row) => ({
    ...row,
    accountTimezone: admission.accountTimezone,
  }));
}

export function resolveNativeAdTargetAuthority(
  input: NativeAdTargetAuthorityInput | null,
  asOfCutoff: string,
): ResolvedNativeAdTargetAuthority {
  /*
    ── ROUND 9 ITEM 1: THE RAW VALUES, BEFORE ANYTHING CAN LAUNDER THEM ───────

    Round 8 put `commercialTargetInstantMs` here but read it off the NORMALIZED
    object, and `normalizeTargetAuthorityInput` had already run
    `normalizeTimestamp` over both clocks. That helper is
    `new Date(text).toISOString()`, so it does not reject an impossible date —
    it REWRITES it into a valid one. Measured on this runtime:

      "2026-02-30"               -> "2026-03-02T00:00:00.000Z"
      "2026-02-30T00:00:00.000Z" -> "2026-03-02T00:00:00.000Z"
      "2026-09-05"               -> "2026-09-05T00:00:00.000Z"
      "2026-09-05T03:00:00"      -> host-local, then serialized as UTC
      "September 5, 2026"        -> "2026-09-04T21:00:00.000Z"

    Every one of those reached the strict parser already wearing a well-formed
    RFC 3339 face, passed it, and produced a `fresh` authority from a day that
    does not exist or from a host's local midnight. The strict check was
    therefore inert at this seam — the one seam that decides `cutoffSafe`, and
    whose verdict is hashed into `authorityHash`.

    So the three raw values are read FIRST. `normalizeTargetAuthorityInput`
    below now also uses the strict parser for these two fields, so a laundered
    instant cannot enter the hashed payload either — the decision and the bytes
    are taken from the same reading.
  */
  const cutoffMs = commercialTargetInstantMs(asOfCutoff);
  if (cutoffMs === null) {
    throw new TypeError(
      "asOfCutoff must be a strict RFC 3339 UTC instant with an explicit offset.",
    );
  }
  const effectiveMs = commercialTargetInstantMs(input?.effectiveAt ?? null);
  const recordedMs = commercialTargetInstantMs(input?.recordedAt ?? null);
  const normalized = normalizeTargetAuthorityInput(input);
  const cutoffSafe =
    normalized !== null &&
    normalized.operation === "upsert" &&
    effectiveMs !== null &&
    recordedMs !== null &&
    effectiveMs <= recordedMs &&
    effectiveMs <= cutoffMs &&
    recordedMs <= cutoffMs;

  let status: NativeAdTargetAuthorityStatus;
  if (normalized === null || normalized.operation === "delete") {
    status = "missing";
  } else if (!cutoffSafe) {
    status = "cutoff_unsafe";
  } else {
    const ageHours = (cutoffMs - effectiveMs) / 3_600_000;
    status = ageHours > 24 * 30 ? "stale" : "fresh";
  }

  const cutoffSafeStatus = isNativeAdTargetAuthorityCutoffSafe(status);
  if (cutoffSafeStatus !== cutoffSafe) {
    throw new Error(
      `Native ad target authority status invariant failed for ${status}.`,
    );
  }

  const targetRoas = normalized?.targetRoas ?? null;
  const breakEvenRoas = normalized?.breakEvenRoas ?? null;
  /*
    THE PROJECTION, not the raw row.

    This hashed `normalized` whole, so `targetCpa`, `breakEvenCpa` and
    `operatorAovAssumption` keyed the native authority — and so did
    `sourceRowId`, `effectiveAt` and `recordedAt`, which move whenever the
    target pack row is re-saved. Under a governing Target ROAS an operator
    editing only their Target CPA therefore minted a new `authorityHash`, and
    with it a new generation and a new calibration cell, for an edit that could
    not reach the verdict. What those clocks DECIDED is still hashed: `status`
    below carries the cutoff-safety verdict they produced.
  */
  const authorityHash = canonicalSha256({
    contractVersion: NATIVE_AD_CALIBRATION_CONTRACT_VERSION,
    authority: projectNativeTargetAuthorityForIdentity(normalized),
    status,
  });

  return {
    status,
    sourceRowId: normalized?.sourceRowId ?? null,
    targetCpa: normalized?.targetCpa ?? null,
    targetRoas,
    breakEvenCpa: normalized?.breakEvenCpa ?? null,
    breakEvenRoas,
    operatorAovAssumption: normalized?.operatorAovAssumption ?? null,
    defaultRiskPosture: normalized?.defaultRiskPosture ?? null,
    effectiveAt: normalized?.effectiveAt ?? null,
    recordedAt: normalized?.recordedAt ?? null,
    // Age is audit provenance, not economic authority. A cutoff-safe upsert
    // remains authoritative until a later semantic upsert or delete replaces it.
    targetRoasAuthority: cutoffSafeStatus && positiveFinite(targetRoas),
    breakEvenRoasAuthority: cutoffSafeStatus && positiveFinite(breakEvenRoas),
    authorityHash,
  };
}

/**
 * The exact bytes `authorityHash` is taken over, for ONE authority version.
 *
 * Minting and recomputation both go through here so they cannot drift: before
 * this existed, `buildNativeAdSpendUnitAuthority` hashed its `content` literal
 * while `recomputeNativeAdSpendUnitAuthorityHash` stripped `authorityHash` off
 * the finished object — one rule written twice, which is the shape of defect
 * that produced 117 `native_target_authority_mismatch` runs in 24h when the
 * builder and the validator disagreed by a single rung.
 *
 * Unknown versions THROW rather than hashing whatever they carry. Both callers
 * that reach persisted data reject an unknown version before getting here
 * (`nativeSpendUnitAuthorityMatchesCell` in ad-account-decision-profile.ts,
 * `nativeSpendUnitAuthority` in ad-account-decision-profile-store.ts), so this
 * is the guard for a version added to the union without a hashing rule.
 */
function nativeAdSpendUnitAuthorityHashContent(
  content: Omit<NativeAdSpendUnitAuthority, "authorityHash">,
): Record<string, unknown> {
  switch (content.contractVersion) {
    case "engine-v3-native-ad-spend-unit-authority.v1":
    case "engine-v3-native-ad-spend-unit-authority.v2":
      /*
        LEGACY, VERBATIM. `.v1` carries no `observedShopifyAovEvidence` member
        at all and `.v2` carries one that was hashed when the row was minted.
        Returning the content unchanged is what makes a persisted `.v2` row
        still recompute to its stored `authorityHash`.
      */
      return content;
    /*
      `.v3` EXCLUDED the store evidence from the hash, exactly as the current
      contract does, so its rows recompute under the same rule that minted
      them. It moved into this branch when `.v4` was minted for the semantic
      projection; dropping it from the readable set instead would have made
      every persisted `.v3` row unverifiable, which is the opposite of what
      "readable as history" means.
    */
    case "engine-v3-native-ad-spend-unit-authority.v3":
    case NATIVE_AD_SPEND_UNIT_AUTHORITY_CONTRACT_VERSION: {
      const { observedShopifyAovEvidence: _observed, ...hashed } = content;
      return hashed;
    }
    default: {
      const unsupported: never = content.contractVersion;
      throw new Error(
        `Unsupported native spend-unit authority contract ${String(unsupported)}.`,
      );
    }
  }
}

export function recomputeNativeAdSpendUnitAuthorityHash(
  authority: NativeAdSpendUnitAuthority,
): string {
  const { authorityHash: _authorityHash, ...content } = authority;
  return canonicalSha256(nativeAdSpendUnitAuthorityHashContent(content));
}

/**
 * The authority as the CELL manifest sees it.
 *
 * `nativeAdCalibrationCellInputManifestContent` binds the whole
 * `actionReadiness` object, which carries `spendUnitAuthority` verbatim — so
 * before this projection existed the cell's `inputManifestHash` (and through it
 * `cellSetHash`) moved on a store-only change even after the authority's own
 * hash stopped moving. Same version split as
 * `nativeAdSpendUnitAuthorityHashContent`, and for the same reason: `.v2` rows
 * were persisted with the evidence bound in and must keep recomputing.
 */
function nativeAdCalibrationActionReadinessManifestContent(
  actionReadiness: NativeAdCalibrationActionReadiness,
): Record<string, unknown> {
  const { spendUnitAuthority, ...actions } = actionReadiness;
  /*
    THE SAME EXPLICIT SWITCH the generation content uses. This compared against
    the CURRENT version, so minting `.v4` silently reclassified every persisted
    `.v3` row as legacy and put the store evidence back into its cell manifest
    — breaking the very hashes `.v3` was minted to stabilise.
  */
  if (nativeAdAuthorityHashesStoreObservation(spendUnitAuthority.contractVersion)) {
    return actionReadiness;
  }
  const { observedShopifyAovEvidence: _observed, ...boundAuthority } =
    spendUnitAuthority;
  return { ...actions, spendUnitAuthority: boundAuthority };
}

type NativeAdCalibrationCellInputManifestSource = Omit<
  NativeAdCalibrationCell,
  "inputManifestHash"
>;

function nativeAdCalibrationCellInputManifestContent(
  cell: NativeAdCalibrationCellInputManifestSource,
  contractVersion: NativeAdCalibrationReadableContractVersion =
    NATIVE_AD_CALIBRATION_CONTRACT_VERSION,
) {
  /*
    VERSION-SCOPED, where this used to be unconditional.

    The CPA fields were nulled here for every account, which was right for a
    ROAS-governed one and WRONG for the no-Target-ROAS compatibility case: there
    the legacy Target CPA is the only anchor there is, it genuinely governs the
    unit, and blanking it made two accounts differing only in their CPA share a
    cell manifest. The shared projection keeps that case whole and blanks only
    where a Target ROAS governs — and it blanks the row's clocks with the
    numbers, because `effectiveAt`/`recordedAt` move on any re-save. The
    cutoff-safety booleans below still carry what those clocks decided.
  */
  /*
    ── ROUND 9 ITEM 4/5: THE HISTORICAL SHAPE, REPRODUCED EXACTLY ────────────

    `.v1`–`.v3` did NOT use the shared projection here. They blanked five
    fields unconditionally and KEPT the row's clocks — the exact literal from
    `git show HEAD:lib/creative-decision-engine/jobs/ad-calibration-job.ts`:

        sourceRowId: null, targetCpa: null, breakEvenCpa: null,
        operatorAovAssumption: null, defaultRiskPosture: null,
        effectiveAt: <kept>, recordedAt: <kept>

    `effectiveAt` / `recordedAt` are the discriminating fields: a version-scoped
    recompute that quietly nulled them would produce a different digest for
    every historical row that carries them, and the failure would look like
    corruption rather than like a formula mismatch.
  */
  if (!nativeAdCalibrationProjectsTargetAuthority(contractVersion)) {
    return nativeAdCalibrationCellInputManifestContentLegacy(
      cell,
      contractVersion,
    );
  }
  const projected = projectNativeTargetAuthorityForIdentity(
    cell.targetAuthority,
  );
  const persistedTargetAuthority = {
    status: cell.targetAuthority.status,
    ...(projected ?? {}),
    /*
      Two fields the CELL manifest has never carried, pinned here rather than
      in the shared projection.

      `operation` and `defaultRiskPosture` are not persisted on the calibration
      row, so a hydrated cell cannot restore them. Letting the projection's
      values through made the manifest depend on facts that survive only in
      memory, and `recomputeNativeAdCalibrationCellInputManifestHash` on a
      round-tripped cell then disagreed with the hash stored beside it — which
      is exactly the "identity that cannot be re-derived" failure the manifest
      exists to prevent. The authority hash above keeps reading them, because
      it is computed once where they are real.
    */
    operation: null,
    defaultRiskPosture: null,
    targetRoasAuthority: cell.targetAuthority.targetRoasAuthority,
    breakEvenRoasAuthority: cell.targetAuthority.breakEvenRoasAuthority,
    authorityHash: cell.targetAuthority.authorityHash,
  };
  return {
    contractVersion,
    policyVersion: cell.policyVersion,
    engineVersion: cell.engineVersion,
    key: cell.key,
    asOfDate: cell.asOfDate,
    asOfCutoff: cell.asOfCutoff,
    sampleWindowStart: cell.sampleWindowStart,
    sampleWindowEnd: cell.sampleWindowEnd,
    sampleWindowDays: cell.sampleWindowDays,
    computedAt: cell.computedAt,
    qualityStatus: cell.qualityStatus,
    sourceAdCount: cell.sourceAdCount,
    sourceDayCount: cell.sourceDayCount,
    eligibleAdCount: cell.eligibleAdCount,
    matureAdCount: cell.matureAdCount,
    zeroConversionAdCount: cell.zeroConversionAdCount,
    metricSampleCounts: cell.metricSampleCounts,
    actionReadiness: nativeAdCalibrationActionReadinessManifestContent(
      cell.actionReadiness,
    ),
    sourceMinDate: cell.sourceMinDate,
    sourceMaxDate: cell.sourceMaxDate,
    sourceMaxUpdatedAt: cell.sourceMaxUpdatedAt,
    // Bind the exact projection persisted by the calibration row. The full
    // bitemporal target payload is separately authenticated by authorityHash
    // and re-read at the same cutoff before a profile is admitted.
    targetAuthority: persistedTargetAuthority,
    /*
      THE SAME PROJECTION THE AUTHORITY ABOVE USES, applied to the account's own
      measured cost-per-purchase.

      `accountCalibration` was hashed whole, and it carries `accountCpaP50` and
      `accountCpaSampleCount`. Under a governing Target ROAS neither chooses
      anything: `resolveSpendUnit` answers READY-or-`insufficient` in that
      branch and never falls through to the `account_history` rung, and the Cut
      readiness gate below now refuses outright without a READY spend unit
      rather than sizing anything from a CPA. Evidence that chooses nothing must
      not key identity, or one more purchase in the account's history discards a
      retained verdict it could not have changed.

      Without a Target ROAS the rung is reachable, the CPA genuinely governs,
      and the projection returns both fields untouched — so the compatibility
      digest is byte-identical to `.v4`'s.
    */
    accountCalibration: nativeAdCalibrationProjectsAccountCpa(contractVersion)
      ? {
          ...cell.accountCalibration,
          ...projectAccountCpaForIdentity(cell.targetAuthority, {
            accountCpaP50: cell.accountCalibration.accountCpaP50,
            accountCpaSampleCount:
              cell.accountCalibration.accountCpaSampleCount,
          }),
        }
      : cell.accountCalibration,
    funnelCalibration: cell.funnelCalibration,
    batchInputManifestHash: cell.batchInputManifestHash,
    sourceManifestHash: cell.sourceManifestHash,
    qualityCounts: cell.qualityCounts,
  };
}

/**
 * Recompute a BATCH's `generationContentHash` and `inputManifestHash` from the
 * batch's own persisted fields.
 *
 * Round 6, item 9. `recomputeNativeAdCalibrationCellInputManifestHash` above
 * verifies a CELL, and a cell carries `batchGenerationContentHash` as a
 * supplied value — so a fixture test built on it accepts the generation hash
 * rather than proving it. Nothing could therefore detect the generation content
 * itself changing shape, which is precisely the failure the `.v3`/`.v4`
 * include/exclude switch exists to prevent.
 *
 * This restates NOTHING: it is the same expression `computeNativeAdCalibrationBatch`
 * digests, reading the persisted members instead of the in-flight locals, so a
 * change to that expression that is not mirrored here fails the frozen fixture
 * immediately.
 */
export function recomputeNativeAdCalibrationBatchGenerationHashes(
  batch: Pick<
    NativeAdCalibrationBatch,
    | "contractVersion"
    | "policyVersion"
    | "engineVersion"
    | "businessId"
    | "providerAccountRefId"
    | "providerAccountId"
    | "sourceProvenance"
    | "asOfDate"
    | "asOfCutoff"
    | "sampleWindowStart"
    | "sampleWindowEnd"
    | "targetAuthority"
    | "spendUnitAuthority"
    | "observations"
    | "qualityCounts"
    | "sourceManifestHash"
  >,
): { generationContentHash: string; inputManifestHash: string } {
  const generationContentHash = canonicalSha256(
    nativeAdCalibrationBatchGenerationContent(batch),
  );
  return {
    generationContentHash,
    inputManifestHash: canonicalSha256(
      nativeAdCalibrationBatchInputManifestContent(batch, generationContentHash),
    ),
  };
}

/** The facts a batch's generation content is built from. */
export type NativeAdCalibrationBatchGenerationFacts = Pick<
  NativeAdCalibrationBatch,
  | "contractVersion"
  | "policyVersion"
  | "engineVersion"
  | "businessId"
  | "providerAccountRefId"
  | "providerAccountId"
  | "asOfDate"
  | "sampleWindowStart"
  | "sampleWindowEnd"
  | "targetAuthority"
  | "spendUnitAuthority"
  | "observations"
  | "qualityCounts"
  | "sourceManifestHash"
>;

/**
 * THE ONE PLACE THE BATCH GENERATION CONTENT IS SPELLED.
 *
 * This expression existed in THREE copies: the producer inside
 * `computeNativeAdCalibrationBatch`, the durable-write validator in
 * `assertNativeAdCalibrationBatchIntegrity`, and the recompute the frozen-v3
 * fixture verifies with. Three copies of a hash formula is three chances for a
 * field to be added to one and not the others, and the failure is silent in the
 * worst direction: the producer mints a hash the validator then reproduces
 * because both were edited, while the recompute — the only one a FROZEN
 * historical batch is checked against — quietly verifies different content.
 *
 * Every caller now digests this. A field added here moves the producer, the
 * validator and the frozen fixture in the same commit or the fixture fails.
 *
 * Canonical serialization is unchanged: `canonicalSha256` still owns key order
 * and encoding, and the member list and its order are byte-identical to what
 * the three copies agreed on, so no persisted hash moves.
 */
export function nativeAdCalibrationBatchGenerationContent(
  batch: NativeAdCalibrationBatchGenerationFacts,
): Record<string, unknown> {
  return {
    contractVersion: batch.contractVersion,
    policyVersion: batch.policyVersion,
    engineVersion: batch.engineVersion,
    businessId: batch.businessId,
    providerAccountRefId: batch.providerAccountRefId,
    providerAccountId: batch.providerAccountId,
    asOfDate: batch.asOfDate,
    sampleWindowStart: batch.sampleWindowStart,
    sampleWindowEnd: batch.sampleWindowEnd,
    sourceManifestHash: batch.sourceManifestHash,
    /*
      THE PROJECTION, scoped to the version this batch was minted with. @see
      `nativeAdCalibrationProjectsTargetAuthority` for what leaked and how far.
      The cutoff-safety verdict those clocks produced is NOT lost: `status` and
      the derived `targetRoasAuthority` / `breakEvenRoasAuthority` booleans are
      part of the projected object, so what the timestamps decided still keys
      the hash while their raw values no longer do.
    */
    targetAuthority: nativeAdCalibrationProjectsTargetAuthority(
      batch.contractVersion,
    )
      ? {
          status: batch.targetAuthority.status,
          ...(projectNativeTargetAuthorityForIdentity(batch.targetAuthority) ??
            {}),
          targetRoasAuthority: batch.targetAuthority.targetRoasAuthority,
          breakEvenRoasAuthority: batch.targetAuthority.breakEvenRoasAuthority,
          authorityHash: batch.targetAuthority.authorityHash,
        }
      : batch.targetAuthority,
    /*
      ── ROUND 10 ITEM 2 ─────────────────────────────────────────────────────
      SPREAD, not assigned. `.v1` and `.v2` had no `spendUnitAuthority` key in
      their generation content at all — the member first appears in the `.v3`
      blob — and an explicit `spendUnitAuthority: undefined` is NOT the same
      digest as an absent key. Spreading an empty object is what actually
      reproduces "the key was never there".
    */
    ...(nativeAdCalibrationBatchHashesSpendUnitAuthority(batch.contractVersion)
      ? {
          spendUnitAuthority: nativeAdSpendUnitAuthorityGenerationContent(
            batch.spendUnitAuthority,
          ),
        }
      : {}),
    qualityCounts: batch.qualityCounts,
    observations: batch.observations.map(observationManifestEntry),
  };
}

/** The batch input manifest content, wrapping the generation hash. */
export function nativeAdCalibrationBatchInputManifestContent(
  batch: Pick<NativeAdCalibrationBatch, "sourceProvenance" | "asOfCutoff">,
  generationContentHash: string,
): Record<string, unknown> {
  return {
    generationContentHash,
    sourceProvenance: batch.sourceProvenance,
    asOfCutoff: batch.asOfCutoff,
  };
}

/**
 * The `.v1`–`.v3` cell manifest content, byte-for-byte as those versions built
 * it.
 *
 * A separate function rather than a branch inside the current one, so a future
 * edit to the CURRENT formula cannot silently drift the historical one — which
 * is the whole failure mode a version-scoped recompute exists to prevent.
 */
function nativeAdCalibrationCellInputManifestContentLegacy(
  cell: NativeAdCalibrationCellInputManifestSource,
  contractVersion: NativeAdCalibrationReadableContractVersion,
) {
  const persistedTargetAuthority = {
    status: cell.targetAuthority.status,
    sourceRowId: null,
    targetCpa: null,
    targetRoas: cell.targetAuthority.targetRoas,
    breakEvenCpa: null,
    breakEvenRoas: cell.targetAuthority.breakEvenRoas,
    operatorAovAssumption: null,
    defaultRiskPosture: null,
    effectiveAt: cell.targetAuthority.effectiveAt,
    recordedAt: cell.targetAuthority.recordedAt,
    targetRoasAuthority: cell.targetAuthority.targetRoasAuthority,
    breakEvenRoasAuthority: cell.targetAuthority.breakEvenRoasAuthority,
    authorityHash: cell.targetAuthority.authorityHash,
  };
  return {
    contractVersion,
    policyVersion: cell.policyVersion,
    engineVersion: cell.engineVersion,
    key: cell.key,
    asOfDate: cell.asOfDate,
    asOfCutoff: cell.asOfCutoff,
    sampleWindowStart: cell.sampleWindowStart,
    sampleWindowEnd: cell.sampleWindowEnd,
    sampleWindowDays: cell.sampleWindowDays,
    computedAt: cell.computedAt,
    qualityStatus: cell.qualityStatus,
    sourceAdCount: cell.sourceAdCount,
    sourceDayCount: cell.sourceDayCount,
    eligibleAdCount: cell.eligibleAdCount,
    matureAdCount: cell.matureAdCount,
    zeroConversionAdCount: cell.zeroConversionAdCount,
    metricSampleCounts: cell.metricSampleCounts,
    // Raw, as `.v1`-`.v3` hashed it. Those versions had no store-observation
    // switch, and their spend-unit authorities are `.v1`/`.v2`, which the
    // switch would answer INCLUDE for anyway.
    actionReadiness: cell.actionReadiness,
    sourceMinDate: cell.sourceMinDate,
    sourceMaxDate: cell.sourceMaxDate,
    sourceMaxUpdatedAt: cell.sourceMaxUpdatedAt,
    targetAuthority: persistedTargetAuthority,
    accountCalibration: cell.accountCalibration,
    funnelCalibration: cell.funnelCalibration,
    batchInputManifestHash: cell.batchInputManifestHash,
    sourceManifestHash: cell.sourceManifestHash,
    qualityCounts: cell.qualityCounts,
  };
}

/**
 * Recompute ONE cell's input manifest hash under the contract it was minted
 * with.
 *
 * `contractVersion` defaults to the current one, because a caller verifying a
 * row it just produced is verifying a current row. A caller reading PERSISTED
 * data passes the batch's own `contractVersion` — otherwise a historical cell
 * is checked against a formula that did not exist when it was written, which
 * fails it for a reason that has nothing to do with the row and is exactly the
 * "identity that cannot be re-derived" failure the manifest exists to prevent.
 */
export function recomputeNativeAdCalibrationCellInputManifestHash(
  cell: NativeAdCalibrationCell,
  contractVersion: NativeAdCalibrationReadableContractVersion =
    NATIVE_AD_CALIBRATION_CONTRACT_VERSION,
): string {
  /*
    ROUND 10 ITEM 2. `.v1` / `.v2` digested per-cell `observations` and a
    cohort-purchase discriminator, and the calibration table persists neither —
    so there is no honest answer to give from a durable row. Throwing is the
    fail-closed one; returning a `.v3`-shaped digest would report a historical
    row as corrupt.
  */
  if (!nativeAdCalibrationDurablyRecomputable(contractVersion)) {
    throw new Error(
      `Native ad calibration ${contractVersion} cannot be recomputed from durable columns: its manifest digested per-cell observations, which are not persisted.`,
    );
  }
  const { inputManifestHash: _inputManifestHash, ...source } = cell;
  return canonicalSha256(
    nativeAdCalibrationCellInputManifestContent(source, contractVersion),
  );
}


/**
 * Does THIS authority version hash the store observation?
 *
 * An explicit version switch, not a comparison against "the current one". The
 * projections below asked `contractVersion === NATIVE_AD_SPEND_UNIT_AUTHORITY_
 * CONTRACT_VERSION`, so the moment `.v4` was minted every persisted `.v3` row
 * became "legacy" and had the Shopify evidence RE-INCLUDED in its generation
 * and manifest content — which is precisely the hashing rule `.v3` was created
 * to stop. Their stored `generationContentHash`, `inputManifestHash` and
 * `cellSetHash` therefore stopped recomputing, and a historical batch could no
 * longer be verified at all.
 *
 * `.v1` and `.v2` genuinely hashed it and must keep doing so. `.v3` and `.v4`
 * exclude it. `.v4` additionally carries the commercial semantic projection on
 * the target authority, which is a different question and lives with the
 * authority hash.
 */
/**
 * Every calibration contract version a PERSISTED row may carry.
 *
 * The batch type pins `contractVersion` to the current constant, because a row
 * being minted can only be current. A row being READ can be anything that was
 * ever minted, and the recompute path has to be able to say which — otherwise
 * a historical row is verified against today's formula and fails for a reason
 * that has nothing to do with the row.
 */
export type NativeAdCalibrationReadableContractVersion =
  | "engine-v3-native-ad-calibration.v1"
  | "engine-v3-native-ad-calibration.v2"
  | "engine-v3-native-ad-calibration.v3"
  | typeof NATIVE_AD_CALIBRATION_CONTRACT_VERSION;

/*
  `.v4` IS ABSENT FROM THIS UNION ON PURPOSE, and the evidence is in git.

    git show HEAD:lib/creative-decision-engine/jobs/ad-calibration-job.ts
      -> "engine-v3-native-ad-calibration.v3"
    git log -S'engine-v3-native-ad-calibration.v4' -- <this file>
      -> 0 commits

  `.v4` was minted in an uncommitted working tree and never reached a writer,
  so no row anywhere carries it and its manifest formula was never observable.
  Listing it here would claim a lineage rung that never existed, and picking a
  formula for it would be inventing one. A row that somehow arrived stamped
  `.v4` hits the `never` arm of the switches below and fails closed, which is
  the correct answer for a stamp this deployment cannot account for.

  `.v1`, `.v2` and `.v3` are all present in committed history and are therefore
  real possible writers of the rows on disk.
*/

/**
 * Does THIS calibration version project the account's own CPA out of the cell
 * manifest?
 *
 * `.v5` does, because under a governing Target ROAS `accountCpaP50` /
 * `accountCpaSampleCount` choose nothing and must not key identity. `.v4` and
 * earlier hashed `accountCalibration` whole and their rows are on disk that
 * way, so recomputing one under `.v5`'s rule would fail every historical row
 * for a formula it was never written with.
 *
 * Same shape as `nativeAdAuthorityHashesStoreObservation` and for the same
 * reason: the `default` arm is `never`-checked, so a sixth version cannot be
 * added without answering this question.
 */
/** Is this durable stamp one of the formulas this build can reproduce? */
export function isNativeAdCalibrationReadableContract(
  value: string,
): value is NativeAdCalibrationReadableContractVersion {
  return (
    value === "engine-v3-native-ad-calibration.v1" ||
    value === "engine-v3-native-ad-calibration.v2" ||
    value === "engine-v3-native-ad-calibration.v3" ||
    value === NATIVE_AD_CALIBRATION_CONTRACT_VERSION
  );
}

function nativeAdCalibrationProjectsAccountCpa(
  contractVersion: NativeAdCalibrationReadableContractVersion,
): boolean {
  switch (contractVersion) {
    case "engine-v3-native-ad-calibration.v1":
    case "engine-v3-native-ad-calibration.v2":
    case "engine-v3-native-ad-calibration.v3":
      return false;
    case NATIVE_AD_CALIBRATION_CONTRACT_VERSION:
      return true;
    default: {
      const unsupported: never = contractVersion;
      throw new Error(
        `Unsupported native ad calibration contract ${String(unsupported)}.`,
      );
    }
  }
}

/**
 * Does THIS calibration version hash the target authority through the shared
 * SEMANTIC projection, or as the raw row?
 *
 * ── ROUND 9 ITEM 4 ─────────────────────────────────────────────────────────
 * The cell manifest was projected; the BATCH generation content was not. It
 * digested `batch.targetAuthority` whole — `targetCpa`, `breakEvenCpa`,
 * `operatorAovAssumption`, `sourceRowId`, `effectiveAt`, `recordedAt` — and
 * `generationContentHash` feeds `inputManifestHash`, which every cell carries
 * as `batchInputManifestHash`, which is inside `inputManifestHash`, which is
 * inside `cellSetHash`. So under an unchanged governing Target ROAS, an
 * operator typing a Target CPA — or merely re-saving the pack, which moves
 * `effectiveAt`/`recordedAt` and `sourceRowId` on its own — minted a new
 * generation, new cell manifests and a new cell set for a change that cannot
 * reach a verdict. Projecting one of the two hash families and not the other
 * left the leak fully open.
 *
 * `.v1`–`.v3` hashed the raw row in the batch content and used their own
 * five-field blanking in the cell manifest, KEEPING the row's clocks. Their
 * rows are on disk that way and must recompute to their stored hashes.
 */
/**
 * Does THIS version's BATCH generation content include the spend-unit
 * authority at all?
 *
 * ── ROUND 10 ITEM 2 ────────────────────────────────────────────────────────
 * Read out of the blobs that minted each version, not inferred:
 *
 *   git show 6d7b54ce3:…/ad-calibration-job.ts   (mints `.v1`) — no key
 *   git show 8147d5e27:…/ad-calibration-job.ts   (mints `.v2`) — no key
 *   git show f07105197:…/ad-calibration-job.ts   (mints `.v3`) — key present
 *
 * Round 9 routed `.v1`–`.v3` through one `.v3`-era formula, which silently
 * added a whole member to `.v1` and `.v2` generation content. Those two digests
 * would never have matched a real historical batch.
 */
function nativeAdCalibrationBatchHashesSpendUnitAuthority(
  contractVersion: NativeAdCalibrationReadableContractVersion,
): boolean {
  switch (contractVersion) {
    case "engine-v3-native-ad-calibration.v1":
    case "engine-v3-native-ad-calibration.v2":
      return false;
    case "engine-v3-native-ad-calibration.v3":
    case NATIVE_AD_CALIBRATION_CONTRACT_VERSION:
      return true;
    default: {
      const unsupported: never = contractVersion;
      throw new Error(
        `Unsupported native ad calibration contract ${String(unsupported)}.`,
      );
    }
  }
}

/**
 * Can a PERSISTED row of this version be re-derived from its DURABLE columns?
 *
 * ── ROUND 10 ITEM 2: THE HONEST BOUNDARY ───────────────────────────────────
 * `.v1` and `.v2` cannot. Their cell manifest digested
 * `observations: observations.map(observationManifestEntry)` and
 * `targetAuthority: purchase ? batch.targetAuthority : null`, and NEITHER input
 * survives persistence: the calibration cell table has no observations column
 * and no cohort-purchase discriminator for that expression. The v1/v2 formula
 * is therefore reproducible OFFLINE, against a fixture that still carries the
 * observations, and not against a database row.
 *
 * Round 9 claimed durable readability for `.v1`–`.v3` alike. That was wrong for
 * two of the three, and the failure mode is the bad direction: a v1 row would
 * have been recomputed under a v3-era formula, mismatched, and been reported as
 * CORRUPT rather than as unverifiable.
 *
 * `.v3` and `.v5` are durably recomputable: every field their formulas read is
 * a persisted column.
 */
export function nativeAdCalibrationDurablyRecomputable(
  contractVersion: NativeAdCalibrationReadableContractVersion,
): boolean {
  switch (contractVersion) {
    case "engine-v3-native-ad-calibration.v1":
    case "engine-v3-native-ad-calibration.v2":
      return false;
    case "engine-v3-native-ad-calibration.v3":
    case NATIVE_AD_CALIBRATION_CONTRACT_VERSION:
      return true;
    default: {
      const unsupported: never = contractVersion;
      throw new Error(
        `Unsupported native ad calibration contract ${String(unsupported)}.`,
      );
    }
  }
}

/**
 * The `.v1`/`.v2` CELL manifest content, byte-for-byte from the blobs that
 * minted them.
 *
 * OFFLINE ONLY. It takes `observations` and `purchase` as arguments precisely
 * because a persisted row carries neither; the only callers are the frozen
 * synthetic fixtures that still hold them. Exported so a fixture cannot restate
 * the formula and drift from it.
 */
export function nativeAdCalibrationCellInputManifestContentV1V2(input: {
  contractVersion:
    | "engine-v3-native-ad-calibration.v1"
    | "engine-v3-native-ad-calibration.v2";
  policyVersion: string;
  engineVersion: string;
  key: NativeAdCalibrationCellKey;
  asOfDate: string;
  asOfCutoff: string;
  sampleWindowStart: string;
  sampleWindowEnd: string;
  targetAuthority: ResolvedNativeAdTargetAuthority;
  /** `purchase ? batch.targetAuthority : null` in the original expression. */
  purchase: boolean;
  qualityStatus: NativeAdCalibrationQualityStatus;
  metricSampleCounts: NativeAdCalibrationMetricSampleCounts;
  actionReadiness: NativeAdCalibrationActionReadiness;
  /** Already mapped through `observationManifestEntry` by the caller. */
  observations: readonly unknown[];
}): Record<string, unknown> {
  return {
    contractVersion: input.contractVersion,
    policyVersion: input.policyVersion,
    engineVersion: input.engineVersion,
    key: input.key,
    asOfDate: input.asOfDate,
    asOfCutoff: input.asOfCutoff,
    sampleWindowStart: input.sampleWindowStart,
    sampleWindowEnd: input.sampleWindowEnd,
    targetAuthority: input.purchase ? input.targetAuthority : null,
    qualityStatus: input.qualityStatus,
    metricSampleCounts: input.metricSampleCounts,
    actionReadiness: input.actionReadiness,
    observations: input.observations,
  };
}

function nativeAdCalibrationProjectsTargetAuthority(
  contractVersion: NativeAdCalibrationReadableContractVersion,
): boolean {
  switch (contractVersion) {
    case "engine-v3-native-ad-calibration.v1":
    case "engine-v3-native-ad-calibration.v2":
    case "engine-v3-native-ad-calibration.v3":
      return false;
    case NATIVE_AD_CALIBRATION_CONTRACT_VERSION:
      return true;
    default: {
      const unsupported: never = contractVersion;
      throw new Error(
        `Unsupported native ad calibration contract ${String(unsupported)}.`,
      );
    }
  }
}

function nativeAdAuthorityHashesStoreObservation(
  contractVersion: NativeAdSpendUnitAuthority["contractVersion"],
): boolean {
  switch (contractVersion) {
    case "engine-v3-native-ad-spend-unit-authority.v1":
    case "engine-v3-native-ad-spend-unit-authority.v2":
      return true;
    case "engine-v3-native-ad-spend-unit-authority.v3":
    case NATIVE_AD_SPEND_UNIT_AUTHORITY_CONTRACT_VERSION:
      return false;
    default: {
      const unsupported: never = contractVersion;
      throw new Error(
        `Unsupported native spend-unit authority contract ${String(unsupported)}.`,
      );
    }
  }
}

function nativeAdSpendUnitAuthorityGenerationContent(
  authority: NativeAdSpendUnitAuthority,
) {
  const {
    authorityHash: _authorityHash,
    asOfCutoff: _asOfCutoff,
    accountAovEvidence,
    observedShopifyAovEvidence,
    ...authorityContent
  } = authority;
  const {
    evidenceHash: _evidenceHash,
    asOfCutoff: _evidenceCutoff,
    ...accountAovContent
  } = accountAovEvidence;
  /*
    LEGACY ONLY. Under `.v2` the store observation is part of the generation
    content — its own read clock stripped, because when it was read is not part
    of what was read, but its window, order count, currency and amounts bound —
    and it stays that way so a persisted `.v2` batch recomputes the
    `generationContentHash` it was written with.

    Under `.v3` it is not here at all. A store-only change may not move
    `generationContentHash`, and `inputManifestHash` is taken over that hash, so
    excluding it here is what makes both stop moving. The evidence is still
    carried on the authority and still served.
  */
  const legacyHashedObserved = nativeAdAuthorityHashesStoreObservation(
    authorityContent.contractVersion,
  )
    ? observedShopifyAovEvidence
    : undefined;
  const observedContent =
    legacyHashedObserved === undefined
      ? undefined
      : legacyHashedObserved === null
        ? null
        : (() => {
            const { knowledgeAsOf: _knowledgeAsOf, ...rest } =
              legacyHashedObserved;
            return rest;
          })();
  return {
    ...authorityContent,
    accountAovEvidence: accountAovContent,
    ...(observedContent === undefined
      ? {}
      : { observedShopifyAovEvidence: observedContent }),
  };
}

function buildNativeAdSpendUnitAuthority(input: {
  businessId: string;
  providerAccountRefId: string;
  providerAccountId: string;
  sampleWindowStart: string;
  sampleWindowEnd: string;
  asOfCutoff: string;
  rows: NormalizedSourceRow[];
  targetAuthority: ResolvedNativeAdTargetAuthority;
  currencyAdmission: NativeAdCalibrationCurrencyAdmission;
  timezoneAdmission: NativeAdCalibrationTimezoneAdmission;
  /**
   * Resolved by the caller, which is where the IO belongs. Undefined means the
   * store was never consulted (a `.v1`-shaped authority); null means it was and
   * produced nothing usable.
   */
  observedShopifyAovEvidence?: ObservedShopifyAovEvidence | null;
}): NativeAdSpendUnitAuthorityBuild {
  const accountCurrency = input.currencyAdmission.accountCurrency;
  const cutoffSafeFinalizedRows = input.rows.filter(
    (row) =>
      row.date >= input.sampleWindowStart &&
      row.date <= input.sampleWindowEnd &&
      hasFinalizedAdFact(row) &&
      isAdFactAvailableAtCutoff(row, input.asOfCutoff),
  );
  const manifestRows = [...cutoffSafeFinalizedRows].sort((left, right) =>
    sourceManifestEntry(left).sortKey.localeCompare(
      sourceManifestEntry(right).sortKey,
    ),
  );
  const rowsByAdDate = new Map<string, NormalizedSourceRow[]>();
  for (const row of manifestRows) {
    const key = `${row.adId}\u0000${row.date}`;
    const rows = rowsByAdDate.get(key) ?? [];
    rows.push(row);
    rowsByAdDate.set(key, rows);
  }
  const deduplicated: NormalizedSourceRow[] = [];
  let duplicateConflictCount = 0;
  for (const rows of rowsByAdDate.values()) {
    const signatures = new Set(rows.map(accountAovFactSignature));
    if (signatures.size > 1) {
      duplicateConflictCount += rows.length;
    } else if (rows[0]) {
      deduplicated.push(rows[0]);
    }
  }
  const uniqueRows = deduplicated.sort((left, right) =>
    sourceManifestEntry(left).sortKey.localeCompare(
      sourceManifestEntry(right).sortKey,
    ),
  );
  const canonicalRows = uniqueRows.filter(
    (row) => row.metricSchemaVersion === META_CANONICAL_METRIC_SCHEMA_VERSION,
  );
  const legacySchemaRowCount = uniqueRows.filter(
    (row) => row.metricSchemaVersion < META_CANONICAL_METRIC_SCHEMA_VERSION,
  ).length;
  const unsupportedSchemaRowCount = uniqueRows.filter(
    (row) => row.metricSchemaVersion > META_CANONICAL_METRIC_SCHEMA_VERSION,
  ).length;
  const invalidCanonicalRows = canonicalRows.filter(
    (row) =>
      hasInvalidMetric(row) ||
      (row.conversions > 0 && row.revenue <= 0) ||
      (row.revenue > 0 && row.conversions <= 0),
  );
  const revenueBackedRows = canonicalRows.filter(
    (row) =>
      !hasInvalidMetric(row) &&
      Number.isInteger(row.conversions) &&
      row.conversions > 0 &&
      Number.isFinite(row.revenue) &&
      row.revenue > 0,
  );
  const observedPurchaseCount = sum(
    revenueBackedRows,
    (row) => row.conversions,
  );
  const totalRevenue = sum(revenueBackedRows, (row) => row.revenue);
  const contradictoryRowCount =
    invalidCanonicalRows.length +
    duplicateConflictCount +
    unsupportedSchemaRowCount +
    input.currencyAdmission.anomalyRowCount;
  const status: NativeAdAccountAovEvidenceStatus =
    contradictoryRowCount > 0
      ? "contradictory_purchase_truth"
      : observedPurchaseCount >= NATIVE_AD_ACCOUNT_AOV_PURCHASE_SAMPLE_FLOOR &&
          totalRevenue > 0
        ? "ready"
        : canonicalRows.length === 0
          ? "unavailable"
          : "insufficient_sample";
  const evidenceHash = canonicalSha256({
    contractVersion: NATIVE_AD_CALIBRATION_CONTRACT_VERSION,
    scope: "business_provider_account_currency",
    businessId: input.businessId,
    providerAccountRefId: input.providerAccountRefId,
    providerAccountId: input.providerAccountId,
    accountCurrency,
    sampleWindowStart: input.sampleWindowStart,
    sampleWindowEnd: input.sampleWindowEnd,
    asOfCutoff: input.asOfCutoff,
    duplicateConflictCount,
    currencyAdmission: input.currencyAdmission,
    timezoneAdmission: input.timezoneAdmission,
    rows: manifestRows.map((row) => ({
      sourceRowId: row.sourceRowId,
      adId: row.adId,
      date: row.date,
      accountCurrency: row.accountCurrency,
      sourceAccountCurrency: row.sourceAccountCurrency,
      metricSchemaVersion: row.metricSchemaVersion,
      conversions: manifestNumber(row.conversions),
      revenue: manifestNumber(row.revenue),
      truthState: row.truthState,
      validationStatus: row.validationStatus,
      finalizedAt: row.finalizedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    })),
  });
  const accountAovEvidence: NativeAdAccountAovEvidence = {
    status,
    scope: "business_provider_account_currency",
    businessId: input.businessId,
    providerAccountRefId: input.providerAccountRefId,
    providerAccountId: input.providerAccountId,
    accountCurrency,
    sampleWindowStart: input.sampleWindowStart,
    sampleWindowEnd: input.sampleWindowEnd,
    asOfCutoff: input.asOfCutoff,
    observedPurchaseCount,
    requiredPurchaseCount: NATIVE_AD_ACCOUNT_AOV_PURCHASE_SAMPLE_FLOOR,
    revenueBackedRowCount: revenueBackedRows.length,
    canonicalRowCount: canonicalRows.length,
    contradictoryRowCount,
    legacySchemaRowCount,
    unsupportedSchemaRowCount,
    totalRevenue,
    meanAov:
      observedPurchaseCount > 0 ? totalRevenue / observedPurchaseCount : null,
    evidenceHash,
  };
  const targetCutoffSafe = isNativeAdTargetAuthorityCutoffSafe(
    input.targetAuthority.status,
  );
  const accountDimensionsReady =
    input.currencyAdmission.status === "ready" &&
    input.timezoneAdmission.status === "ready";
  /*
    The store observation is carried, never consulted, and never identity.

    It is persisted below so an operator reading a blocked authority can see
    what the store said. It takes no part in choosing the basis: for a Meta
    decision the canonical money-per-purchase unit is Meta's own attributed AOV,
    and a second book that disagrees with it is context, not authority. See
    `NativeAdSpendUnitAuthorityBasis` for the production incident that settled
    this.

    Under the `.v3` this mint stamps it is also excluded from every hash the
    authority feeds — `authorityHash`, `generationContentHash`,
    `inputManifestHash`, `cellSetHash` — so a store-only change moves nothing.
    `.v2` rows keep hashing it, because that is what they were minted over.
  */
  const observedEvidence = input.observedShopifyAovEvidence ?? null;

  /*
    The Target ROAS test, hoisted because it is what SPLITS the two cases below
    rather than a condition inside one of them.

    `resolveNativeAdTargetAuthority` already folds the cutoff test into
    `targetRoasAuthority` (`cutoffSafeStatus && positiveFinite(targetRoas)`), so
    this is cutoff-safe by construction and needs no second clock comparison —
    the class of drift that produced the 117 failed runs recorded on
    `NativeAdSpendUnitAuthorityBasis`.
  */
  const targetRoas = input.targetAuthority.targetRoas;
  const targetRoasAnchored =
    input.targetAuthority.targetRoasAuthority && positiveFinite(targetRoas);

  let basis: NativeAdSpendUnitAuthorityBasis | null = null;
  let baseSpendUnit: number | null = null;
  if (accountDimensionsReady && targetRoasAnchored) {
    /*
      CASE 1 — A TARGET ROAS IS CONFIGURED.

      Meta's own attributed AOV over that ratio is the canonical derived CPA
      benchmark for a Meta decision, and it is the ONLY lane this case has. A
      legacy Target CPA and an operator AOV assumption are both READ from the
      same target authority and neither one chooses the basis: they used to sit
      above this lane and no longer do.

      When the evidence is not `ready` the authority stays BLOCKED and the
      readiness resolver names it (`commercial_spend_unit_authority_missing`,
      with `accountAovEvidence.status` saying which absence it is). It
      deliberately does not fall back to the Target CPA: substituting any other
      number here would decide Meta spend on revenue Meta never attributed, and
      would report a missing platform AOV as a ready authority.

      This lane must stay identical to the CASE 1 branch of
      `nativeSpendUnitAuthorityMatchesTarget` in `ad-account-decision-profile.ts`.
      One rung of disagreement raises `native_target_authority_mismatch` and
      rolls the whole native job back.
    */
    if (
      accountAovEvidence.status === "ready" &&
      positiveFinite(accountAovEvidence.meanAov)
    ) {
      basis = "physical_account_purchase_aov_90d";
      baseSpendUnit = accountAovEvidence.meanAov / targetRoas;
    }
  } else if (
    accountDimensionsReady &&
    targetCutoffSafe &&
    positiveFinite(input.targetAuthority.targetCpa)
  ) {
    /*
      CASE 2 — NO TARGET ROAS.

      Nothing native divides an average order value without a ratio, so an
      explicitly configured Target CPA is the only anchor this case has and it
      legitimately governs. Unchanged legacy compatibility.

      `operator_aov` has no case left: it only ever built
      `operatorAovAssumption / targetRoas`, so CASE 1 owns every input shape
      that could reach it. The member stays in `NativeAdSpendUnitAuthorityBasis`
      so a persisted row naming it still parses — and, having no expected basis
      to match, such a row now fails the validator CLOSED, which is the intended
      reading of a retired authority.
    */
    basis = "target_cpa";
    baseSpendUnit = input.targetAuthority.targetCpa;
  }
  const content: Omit<NativeAdSpendUnitAuthority, "authorityHash"> = {
    /*
      One version for every mint, whatever the store said or whether it was
      asked at all. The previous rule picked `.v1` vs `.v2` from
      `observedEvidence === undefined`, which put a Shopify-only fact back into
      the hashed content through the version string.
    */
    contractVersion: NATIVE_AD_SPEND_UNIT_AUTHORITY_CONTRACT_VERSION,
    status: basis === null ? "blocked" : "ready",
    basis,
    businessId: input.businessId,
    providerAccountRefId: input.providerAccountRefId,
    providerAccountId: input.providerAccountId,
    accountCurrency,
    asOfCutoff: input.asOfCutoff,
    targetAuthorityHash: input.targetAuthority.authorityHash,
    baseSpendUnit,
    accountAovEvidence,
    ...(input.observedShopifyAovEvidence === undefined
      ? {}
      : { observedShopifyAovEvidence: observedEvidence }),
  };
  const authority: NativeAdSpendUnitAuthority = {
    ...content,
    // Through the shared projection, never over `content` directly, so the mint
    // and `recomputeNativeAdSpendUnitAuthorityHash` cannot disagree about which
    // members are identity.
    authorityHash: canonicalSha256(
      nativeAdSpendUnitAuthorityHashContent(content),
    ),
  };
  return { authority, manifestRows };
}

export function computeNativeAdCalibrationBatch(
  input: ComputeNativeAdCalibrationInput,
): NativeAdCalibrationBatch {
  const businessId = requiredText(input.businessId, "businessId");
  const providerAccountRefId = requiredUuid(
    input.providerAccountRefId,
    "providerAccountRefId",
  );
  const providerAccountId = requiredText(
    input.providerAccountId,
    "providerAccountId",
  );
  const cutoff = resolveNativeAdCalibrationCutoff(
    input.asOf,
    input.computationCutoff,
  );
  const computedAt = cutoff.asOfCutoff;
  const targetAuthority = resolveNativeAdTargetAuthority(
    input.targetAuthority,
    cutoff.asOfCutoff,
  );
  const normalizedRows = input.sourceRows.map(normalizeSourceRow);
  assertNativeAdSourceBindings({
    businessId,
    providerAccountRefId,
    providerAccountId,
    rows: normalizedRows,
  });
  const currencyAdmission = resolveNativeAdCalibrationCurrencyAdmission({
    businessId,
    providerAccountRefId,
    providerAccountId,
    sampleWindowStart: cutoff.sampleWindowStart,
    sampleWindowEnd: cutoff.sampleWindowEnd,
    asOfCutoff: cutoff.asOfCutoff,
    rows: normalizedRows,
  });
  const timezoneAdmission = resolveNativeAdCalibrationTimezoneAdmission({
    businessId,
    providerAccountRefId,
    providerAccountId,
    sampleWindowStart: cutoff.sampleWindowStart,
    sampleWindowEnd: cutoff.sampleWindowEnd,
    asOfCutoff: cutoff.asOfCutoff,
    rows: normalizedRows,
  });
  const dimensionBoundRows = bindNativeAdCalibrationTimezone(
    normalizedRows,
    timezoneAdmission,
  );
  const sourceProvenance: NativeAdCalibrationSourceProvenance = {
    mode: "current_transaction_snapshot",
    providerAccountRefId,
    providerAccountId,
    transactionCutoff: cutoff.asOfCutoff,
    transactionIsolation: "repeatable read",
    currencyAdmission,
    timezoneAdmission,
  };
  const spendUnitAuthorityBuild = buildNativeAdSpendUnitAuthority({
    businessId,
    providerAccountRefId,
    providerAccountId,
    sampleWindowStart: cutoff.sampleWindowStart,
    sampleWindowEnd: cutoff.sampleWindowEnd,
    asOfCutoff: cutoff.asOfCutoff,
    rows: dimensionBoundRows,
    targetAuthority,
    currencyAdmission,
    timezoneAdmission,
    // Forwarded rather than omitted. Every call site dropped it, which made
    // the observed-Shopify basis unreachable in production.
    observedShopifyAovEvidence: input.observedShopifyAovEvidence,
  });
  const spendUnitAuthority = spendUnitAuthorityBuild.authority;
  const peerObservationRows =
    currencyAdmission.status === "ready" &&
    timezoneAdmission.status === "ready"
      ? dimensionBoundRows
      : currencyAdmission.status === "unavailable" &&
          timezoneAdmission.status === "unavailable"
        ? normalizedRows
        : [];
  const built = buildObservations({
    businessId,
    asOfCutoff: cutoff.asOfCutoff,
    sampleWindowStart: cutoff.sampleWindowStart,
    sampleWindowEnd: cutoff.sampleWindowEnd,
    // The strict Ad-finalized dimension lane owns account AOV/spend authority.
    // A wholly unavailable strict lane (legacy rows with null finalized_at)
    // must not censor otherwise exact, cutoff-safe peer observations. Each peer
    // Ad still has to prove its own singular context in buildObservations.
    // A contradictory/blocked strict lane remains account-fatal and emits no
    // cells, so peer facts can never launder a strict dimension anomaly.
    rows: peerObservationRows,
  });
  const sourceManifestRows = new Map<string, NormalizedSourceRow>();
  for (const row of [
    ...built.eligibleSourceRows,
    ...spendUnitAuthorityBuild.manifestRows,
  ]) {
    sourceManifestRows.set(sourceManifestEntry(row).sortKey, row);
  }
  const sourceManifestHash = canonicalSha256({
    contractVersion: NATIVE_AD_CALIBRATION_CONTRACT_VERSION,
    businessId,
    providerAccountRefId,
    providerAccountId,
    sampleWindowStart: cutoff.sampleWindowStart,
    sampleWindowEnd: cutoff.sampleWindowEnd,
    rows: [...sourceManifestRows.values()]
      .map(sourceManifestEntry)
      .sort((left, right) => left.sortKey.localeCompare(right.sortKey)),
  });
  built.qualityCounts.commercialAuthorityAdExclusionCount =
    hasCommercialTargetAuthority(targetAuthority)
      ? 0
      : built.observations.filter((row) => row.cohort === "purchase").length;

  // One shared content builder, so the producer, the durable-write validator
  // and the frozen-fixture recompute cannot drift apart.
  const generationContentHash = canonicalSha256(
    nativeAdCalibrationBatchGenerationContent({
      contractVersion: NATIVE_AD_CALIBRATION_CONTRACT_VERSION,
      policyVersion: NATIVE_AD_CALIBRATION_POLICY_VERSION,
      engineVersion: NATIVE_AD_ENGINE_VERSION,
      businessId,
      providerAccountRefId,
      providerAccountId,
      asOfDate: cutoff.asOfDate,
      sampleWindowStart: cutoff.sampleWindowStart,
      sampleWindowEnd: cutoff.sampleWindowEnd,
      sourceManifestHash,
      targetAuthority,
      spendUnitAuthority,
      qualityCounts: built.qualityCounts,
      observations: built.observations,
    }),
  );
  const inputManifestHash = canonicalSha256(
    nativeAdCalibrationBatchInputManifestContent(
      { sourceProvenance, asOfCutoff: cutoff.asOfCutoff },
      generationContentHash,
    ),
  );

  const batchBase = {
    contractVersion: NATIVE_AD_CALIBRATION_CONTRACT_VERSION,
    policyVersion: NATIVE_AD_CALIBRATION_POLICY_VERSION,
    engineVersion: NATIVE_AD_ENGINE_VERSION,
    businessId,
    providerAccountRefId,
    providerAccountId,
    sourceProvenance,
    asOfDate: cutoff.asOfDate,
    asOfCutoff: cutoff.asOfCutoff,
    sampleWindowStart: cutoff.sampleWindowStart,
    sampleWindowEnd: cutoff.sampleWindowEnd,
    sampleWindowDays: SAMPLE_WINDOW_DAYS,
    computedAt,
    targetAuthority,
    spendUnitAuthority,
    observations: built.observations,
    qualityCounts: built.qualityCounts,
    generationContentHash,
    inputManifestHash,
    sourceManifestHash,
  } satisfies Omit<
    NativeAdCalibrationBatch,
    "cells" | "expectedCellCount" | "cellSetHash"
  >;
  const provisionalCells = buildCells(batchBase);
  const cellSetHash = computeNativeAdCalibrationCellSetHash(provisionalCells);
  const cells = provisionalCells.map((cell) => ({
    ...cell,
    batchCellCount: provisionalCells.length,
    batchCellSetHash: cellSetHash,
  }));

  return {
    ...batchBase,
    expectedCellCount: cells.length,
    cellSetHash,
    cells,
  };
}

export function buildNativeAdCalibrationPersistencePayload(
  batch: NativeAdCalibrationBatch,
  input: { batchId: string; jobRunId: string },
): Array<Record<string, unknown>> {
  return batch.cells.map((cell) => ({
    // The cell inherits the BATCH's contract, which is what makes the
    // agreement the reader enforces true by construction on every new row.
    contract_version: batch.contractVersion,
    batch_id: input.batchId,
    business_ref_id: cell.key.businessId,
    business_id: cell.key.businessId,
    provider: "meta",
    provider_account_ref_id: cell.key.providerAccountRefId,
    provider_account_id: cell.key.providerAccountId,
    account_timezone: cell.key.accountTimezone,
    account_currency: cell.key.accountCurrency,
    cell_scope: cell.key.cellScope,
    objective: cell.key.objective,
    funnel_cohort: cell.key.cohort,
    optimization_context: cell.key.optimizationContext,
    as_of_date: cell.asOfDate,
    as_of_cutoff: cell.asOfCutoff,
    engine_version: cell.engineVersion,
    policy_version: cell.policyVersion,
    sample_window_start: cell.sampleWindowStart,
    sample_window_end: cell.sampleWindowEnd,
    sample_window_days: cell.sampleWindowDays,
    source_ad_count: cell.sourceAdCount,
    source_day_count: cell.sourceDayCount,
    eligible_ad_count: cell.eligibleAdCount,
    mature_ad_count: cell.matureAdCount,
    zero_conversion_ad_count: cell.zeroConversionAdCount,
    roas_p75: cell.accountCalibration.roasP75,
    roas_p60: cell.accountCalibration.roasP60,
    refresh_ratio_p10: cell.accountCalibration.refreshRatioP10,
    low_ctr_p10: cell.accountCalibration.lowCtrP10,
    account_cpa_p50: cell.accountCalibration.accountCpaP50,
    account_cpa_sample_count: cell.accountCalibration.accountCpaSampleCount,
    meta_attributed_aov_mean_90d:
      cell.accountCalibration.metaAttributedAovMean90d,
    meta_attributed_aov_purchase_count_90d:
      cell.accountCalibration.metaAttributedAovPurchaseCount90d,
    meta_attributed_revenue_90d:
      cell.accountCalibration.metaAttributedRevenue90d,
    meta_aov_quality: cell.accountCalibration.metaAovQuality,
    mature_spend_p50: cell.accountCalibration.matureSpendP50,
    mature_spend_p75: cell.accountCalibration.matureSpendP75,
    winner_spend_p25: cell.accountCalibration.winnerSpendP25,
    winner_spend_p50: cell.accountCalibration.winnerSpendP50,
    winner_purchase_p50: cell.accountCalibration.winnerPurchaseP50,
    roas_ratio_p10: cell.accountCalibration.roasRatioP10,
    roas_ratio_p25: cell.accountCalibration.roasRatioP25,
    roas_ratio_p50: cell.accountCalibration.roasRatioP50,
    roas_ratio_p75: cell.accountCalibration.roasRatioP75,
    funnel_calibration_json: cell.funnelCalibration,
    metric_sample_counts_json: cell.metricSampleCounts,
    action_readiness_json: cell.actionReadiness,
    quality_counts_json: cell.qualityCounts,
    quality_status: cell.qualityStatus,
    target_authority_status: cell.targetAuthority.status,
    target_roas: cell.targetAuthority.targetRoas,
    break_even_roas: cell.targetAuthority.breakEvenRoas,
    target_effective_at: cell.targetAuthority.effectiveAt,
    target_recorded_at: cell.targetAuthority.recordedAt,
    target_authority_hash: cell.targetAuthority.authorityHash,
    source_min_date: cell.sourceMinDate,
    source_max_date: cell.sourceMaxDate,
    source_max_updated_at: cell.sourceMaxUpdatedAt,
    batch_input_manifest_hash: cell.batchInputManifestHash,
    input_manifest_hash: cell.inputManifestHash,
    source_manifest_hash: cell.sourceManifestHash,
    job_run_id: input.jobRunId,
    computed_at: cell.computedAt,
  }));
}

export function computeNativeAdCalibrationCellSetHash(
  cells: Array<
    Pick<
      NativeAdCalibrationCell,
      "key" | "inputManifestHash" | "sourceManifestHash"
    >
  >,
  contractVersion: NativeAdCalibrationReadableContractVersion =
    NATIVE_AD_CALIBRATION_CONTRACT_VERSION,
): string {
  return canonicalSha256({
    contractVersion,
    cells: cells
      .map((cell) => ({
        identity: cellIdentity(cell.key),
        inputManifestHash: cell.inputManifestHash,
        sourceManifestHash: cell.sourceManifestHash,
      }))
      .sort((left, right) => left.identity.localeCompare(right.identity)),
  });
}

export interface NativeAdCalibrationSchemaCapability {
  ready: boolean;
  missing: string[];
  mismatched: string[];
}

interface NativeAdCalibrationColumnContract {
  type: string;
  notNull: boolean;
  default: string | null;
}

const BATCH_COLUMN_CONTRACT: Record<string, NativeAdCalibrationColumnContract> =
  {
    id: { type: "uuid", notNull: true, default: "gen_random_uuid()" },
    /*
      ── ROUND 10 ITEM 1: THE GATE MUST REQUIRE THE STAMP ────────────────────
      `lib/migrations.ts` runs the calibration migration ONLY when capability
      says `ready: false`. Omitting this column from the contract meant a
      pre-Round-9 database reported `ready: true`, the ALTER never ran, and the
      first `SELECT batch.contract_version` or stamped `INSERT` then crashed at
      runtime — a schema gap that the gate designed to catch it declared
      healthy.

      `default: null` is not cosmetic either: the migration adds the column with
      a `legacy_unknown` default and then DROPS it, so a database that stopped
      halfway would still be caught here.
    */
    contract_version: { type: "text", notNull: true, default: null },
    business_ref_id: { type: "uuid", notNull: true, default: null },
    business_id: { type: "text", notNull: true, default: null },
    provider: { type: "text", notNull: true, default: null },
    provider_account_ref_id: { type: "uuid", notNull: true, default: null },
    provider_account_id: { type: "text", notNull: true, default: null },
    as_of_date: { type: "date", notNull: true, default: null },
    as_of_cutoff: {
      type: "timestamp with time zone",
      notNull: true,
      default: null,
    },
    transaction_isolation: { type: "text", notNull: true, default: null },
    engine_version: { type: "text", notNull: true, default: null },
    policy_version: { type: "text", notNull: true, default: null },
    source_mode: { type: "text", notNull: true, default: null },
    source_provenance_json: { type: "jsonb", notNull: true, default: null },
    expected_cell_count: { type: "integer", notNull: true, default: null },
    generation_content_hash: {
      type: "character(64)",
      notNull: true,
      default: null,
    },
    input_manifest_hash: {
      type: "character(64)",
      notNull: true,
      default: null,
    },
    source_manifest_hash: {
      type: "character(64)",
      notNull: true,
      default: null,
    },
    cell_set_hash: {
      type: "character(64)",
      notNull: true,
      default: null,
    },
    completeness_status: { type: "text", notNull: true, default: null },
    job_run_id: { type: "uuid", notNull: true, default: null },
    computed_at: {
      type: "timestamp with time zone",
      notNull: true,
      default: null,
    },
    completed_at: {
      type: "timestamp with time zone",
      notNull: false,
      default: null,
    },
    created_at: {
      type: "timestamp with time zone",
      notNull: true,
      default: "now()",
    },
  };

const CELL_COLUMN_CONTRACT: Record<string, NativeAdCalibrationColumnContract> =
  Object.fromEntries(
    [
      ["id", "uuid", true, "gen_random_uuid()"],
      // ROUND 10 ITEM 1. Same reason as the batch column above; the cell is the
      // row the production reader actually SELECTs the stamp from.
      ["contract_version", "text", true, null],
      ["batch_id", "uuid", true, null],
      ["business_ref_id", "uuid", true, null],
      ["business_id", "text", true, null],
      ["provider", "text", true, null],
      ["provider_account_ref_id", "uuid", true, null],
      ["provider_account_id", "text", true, null],
      ["account_timezone", "text", true, null],
      ["account_currency", "text", true, null],
      ["cell_scope", "text", true, null],
      ["objective", "text", true, null],
      ["funnel_cohort", "text", true, null],
      ["optimization_context", "text", true, null],
      ["as_of_date", "date", true, null],
      ["as_of_cutoff", "timestamp with time zone", true, null],
      ["engine_version", "text", true, null],
      ["policy_version", "text", true, null],
      ["sample_window_start", "date", true, null],
      ["sample_window_end", "date", true, null],
      ["sample_window_days", "integer", true, null],
      ["source_ad_count", "integer", true, null],
      ["source_day_count", "integer", true, null],
      ["eligible_ad_count", "integer", true, null],
      ["mature_ad_count", "integer", true, null],
      ["zero_conversion_ad_count", "integer", true, null],
      ["roas_p75", "double precision", false, null],
      ["roas_p60", "double precision", false, null],
      ["refresh_ratio_p10", "double precision", false, null],
      ["low_ctr_p10", "double precision", false, null],
      ["account_cpa_p50", "double precision", false, null],
      ["account_cpa_sample_count", "integer", true, null],
      ["meta_attributed_aov_mean_90d", "double precision", false, null],
      ["meta_attributed_aov_purchase_count_90d", "integer", true, null],
      ["meta_attributed_revenue_90d", "double precision", true, "0"],
      ["meta_aov_quality", "text", true, null],
      ["mature_spend_p50", "double precision", false, null],
      ["mature_spend_p75", "double precision", false, null],
      ["winner_spend_p25", "double precision", false, null],
      ["winner_spend_p50", "double precision", false, null],
      ["winner_purchase_p50", "double precision", false, null],
      ["roas_ratio_p10", "double precision", false, null],
      ["roas_ratio_p25", "double precision", false, null],
      ["roas_ratio_p50", "double precision", false, null],
      ["roas_ratio_p75", "double precision", false, null],
      ["funnel_calibration_json", "jsonb", true, null],
      ["metric_sample_counts_json", "jsonb", true, null],
      ["action_readiness_json", "jsonb", true, null],
      ["quality_counts_json", "jsonb", true, null],
      ["quality_status", "text", true, null],
      ["target_authority_status", "text", true, null],
      ["target_roas", "double precision", false, null],
      ["break_even_roas", "double precision", false, null],
      ["target_effective_at", "timestamp with time zone", false, null],
      ["target_recorded_at", "timestamp with time zone", false, null],
      ["target_authority_hash", "character(64)", true, null],
      ["source_min_date", "date", false, null],
      ["source_max_date", "date", false, null],
      ["source_max_updated_at", "timestamp with time zone", false, null],
      ["batch_input_manifest_hash", "character(64)", true, null],
      ["input_manifest_hash", "character(64)", true, null],
      ["source_manifest_hash", "character(64)", true, null],
      ["job_run_id", "uuid", true, null],
      ["computed_at", "timestamp with time zone", true, null],
      ["created_at", "timestamp with time zone", true, "now()"],
    ].map(([name, type, notNull, defaultValue]) => [
      name,
      { type, notNull, default: defaultValue },
    ]),
  ) as Record<string, NativeAdCalibrationColumnContract>;

export const NATIVE_AD_CALIBRATION_REQUIRED_SCHEMA = {
  columns: {
    [NATIVE_AD_CALIBRATION_BATCH_TABLE]: BATCH_COLUMN_CONTRACT,
    [NATIVE_AD_CALIBRATION_TABLE]: CELL_COLUMN_CONTRACT,
  },
  constraints: {
    engine_v3_ad_account_calibration_batches_pkey: "PRIMARY KEY (id)",
    engine_v3_ad_calibration_batches_business_fk:
      "FOREIGN KEY (business_ref_id) REFERENCES businesses(id) ON DELETE RESTRICT",
    engine_v3_ad_calibration_batches_account_fk:
      "FOREIGN KEY (provider_account_ref_id, provider, provider_account_id) REFERENCES provider_accounts(id, provider, external_account_id) ON DELETE RESTRICT",
    engine_v3_ad_calibration_batches_binding_fk:
      "FOREIGN KEY (business_id, provider, provider_account_ref_id, provider_account_id) REFERENCES business_provider_accounts(business_id, provider, provider_account_ref_id, provider_account_id) ON DELETE RESTRICT",
    engine_v3_ad_calibration_batches_job_fk:
      "FOREIGN KEY (job_run_id, business_ref_id, business_id, engine_version) REFERENCES engine_v3_job_runs(id, business_ref_id, business_id, engine_version) ON DELETE RESTRICT",
    engine_v3_ad_calibration_batches_business_identity_check:
      "CHECK (business_id = business_ref_id::text)",
    engine_v3_ad_calibration_batches_provider_check:
      "CHECK (provider = 'meta')",
    // ROUND 10 ITEM 1: derived from the same builder the DDL uses.
    engine_v3_ad_calibration_batches_contract_version_check:
      nativeAdCalibrationContractVersionCheck(),
    engine_v3_ad_calibration_batches_source_mode_check:
      "CHECK (source_mode = 'current_transaction_snapshot')",
    engine_v3_ad_calibration_batches_isolation_check:
      "CHECK (transaction_isolation = 'repeatable read')",
    engine_v3_ad_calibration_batches_provenance_check:
      "CHECK (jsonb_typeof(source_provenance_json) = 'object' AND source_provenance_json->>'mode' = source_mode AND source_provenance_json->>'providerAccountRefId' = provider_account_ref_id::text AND source_provenance_json->>'providerAccountId' = provider_account_id AND (source_provenance_json->>'transactionCutoff')::timestamptz = as_of_cutoff AND source_provenance_json->>'transactionIsolation' = transaction_isolation)",
    engine_v3_ad_calibration_batches_cutoff_date_check:
      "CHECK ((as_of_cutoff AT TIME ZONE 'UTC')::date = as_of_date)",
    engine_v3_ad_calibration_batches_computed_cutoff_check:
      "CHECK (computed_at = as_of_cutoff)",
    engine_v3_ad_calibration_batches_expected_count_check:
      "CHECK (expected_cell_count >= 0)",
    engine_v3_ad_calibration_batches_generation_hash_check:
      "CHECK (generation_content_hash ~ '^[0-9a-f]{64}$')",
    engine_v3_ad_calibration_batches_input_hash_check:
      "CHECK (input_manifest_hash ~ '^[0-9a-f]{64}$')",
    engine_v3_ad_calibration_batches_source_hash_check:
      "CHECK (source_manifest_hash ~ '^[0-9a-f]{64}$')",
    engine_v3_ad_calibration_batches_cell_hash_check:
      "CHECK (cell_set_hash ~ '^[0-9a-f]{64}$')",
    engine_v3_ad_calibration_batches_completeness_check:
      "CHECK ((completeness_status = 'writing' AND completed_at IS NULL) OR (completeness_status = 'complete' AND completed_at IS NOT NULL))",
    engine_v3_ad_calibration_batches_content_unique:
      "UNIQUE (business_ref_id, provider_account_ref_id, provider_account_id, as_of_date, engine_version, policy_version, generation_content_hash)",
    engine_v3_ad_calibration_batches_cutoff_unique:
      "UNIQUE (business_ref_id, provider_account_ref_id, provider_account_id, as_of_cutoff, engine_version, policy_version)",
    engine_v3_ad_calibration_batches_lineage_unique:
      "UNIQUE (id, business_ref_id, business_id, provider, provider_account_ref_id, provider_account_id, as_of_date, as_of_cutoff, engine_version, policy_version, input_manifest_hash, source_manifest_hash)",
    engine_v3_ad_account_calibration_daily_pkey: "PRIMARY KEY (id)",
    engine_v3_ad_calibration_daily_business_fk:
      "FOREIGN KEY (business_ref_id) REFERENCES businesses(id) ON DELETE RESTRICT",
    engine_v3_ad_calibration_daily_account_fk:
      "FOREIGN KEY (provider_account_ref_id, provider, provider_account_id) REFERENCES provider_accounts(id, provider, external_account_id) ON DELETE RESTRICT",
    engine_v3_ad_calibration_daily_binding_fk:
      "FOREIGN KEY (business_id, provider, provider_account_ref_id, provider_account_id) REFERENCES business_provider_accounts(business_id, provider, provider_account_ref_id, provider_account_id) ON DELETE RESTRICT",
    engine_v3_ad_calibration_daily_job_fk:
      "FOREIGN KEY (job_run_id, business_ref_id, business_id, engine_version) REFERENCES engine_v3_job_runs(id, business_ref_id, business_id, engine_version) ON DELETE RESTRICT",
    engine_v3_ad_calibration_daily_batch_fk:
      "FOREIGN KEY (batch_id, business_ref_id, business_id, provider, provider_account_ref_id, provider_account_id, as_of_date, as_of_cutoff, engine_version, policy_version, batch_input_manifest_hash, source_manifest_hash) REFERENCES engine_v3_ad_account_calibration_batches(id, business_ref_id, business_id, provider, provider_account_ref_id, provider_account_id, as_of_date, as_of_cutoff, engine_version, policy_version, input_manifest_hash, source_manifest_hash) ON DELETE RESTRICT",
    engine_v3_ad_calibration_daily_business_identity_check:
      "CHECK (business_id = business_ref_id::text)",
    engine_v3_ad_calibration_daily_provider_check: "CHECK (provider = 'meta')",
    engine_v3_ad_calibration_cells_contract_version_check:
      nativeAdCalibrationContractVersionCheck(),
    engine_v3_ad_calibration_daily_scope_check:
      "CHECK (cell_scope = ANY (ARRAY['objective_cohort_context', 'account_objective_cohort']))",
    engine_v3_ad_calibration_daily_cohort_check:
      "CHECK (funnel_cohort = ANY (ARRAY['purchase', 'mid_funnel', 'lead', 'traffic', 'upper_funnel', 'engagement', 'unknown']))",
    engine_v3_ad_calibration_daily_window_check:
      "CHECK (sample_window_days > 0 AND sample_window_start <= sample_window_end)",
    engine_v3_ad_calibration_daily_counts_check:
      "CHECK (source_ad_count >= 0 AND source_day_count >= 0 AND eligible_ad_count >= 0 AND mature_ad_count >= 0 AND zero_conversion_ad_count >= 0 AND account_cpa_sample_count >= 0 AND meta_attributed_aov_purchase_count_90d >= 0)",
    engine_v3_ad_calibration_daily_action_readiness_check:
      "CHECK (jsonb_typeof(action_readiness_json) = 'object')",
    engine_v3_ad_calibration_daily_meta_aov_quality_check:
      "CHECK (meta_aov_quality = ANY (ARRAY['unavailable', 'unstable', 'low_sample', 'ready']))",
    engine_v3_ad_calibration_daily_quality_status_check:
      "CHECK (quality_status = ANY (ARRAY['ready', 'low_sample', 'insufficient', 'blocked_commercial', 'unsupported_cohort']))",
    engine_v3_ad_calibration_daily_target_status_check:
      "CHECK (target_authority_status = ANY (ARRAY['fresh', 'stale', 'missing', 'cutoff_unsafe']))",
    engine_v3_ad_calibration_daily_hashes_check:
      "CHECK (target_authority_hash ~ '^[0-9a-f]{64}$' AND batch_input_manifest_hash ~ '^[0-9a-f]{64}$' AND input_manifest_hash ~ '^[0-9a-f]{64}$' AND source_manifest_hash ~ '^[0-9a-f]{64}$')",
    engine_v3_ad_calibration_daily_computed_cutoff_check:
      "CHECK (computed_at = as_of_cutoff)",
    engine_v3_ad_calibration_daily_cell_unique:
      "UNIQUE (batch_id, account_currency, account_timezone, cell_scope, objective, funnel_cohort, optimization_context)",
  },
  indexes: {
    idx_provider_accounts_physical_identity:
      "CREATE UNIQUE INDEX idx_provider_accounts_physical_identity ON provider_accounts (id, provider, external_account_id)",
    idx_business_provider_accounts_physical_binding:
      "CREATE UNIQUE INDEX idx_business_provider_accounts_physical_binding ON business_provider_accounts (business_id, provider, provider_account_ref_id, provider_account_id)",
    idx_engine_v3_job_runs_native_lineage:
      "CREATE UNIQUE INDEX idx_engine_v3_job_runs_native_lineage ON engine_v3_job_runs (id, business_ref_id, business_id, engine_version)",
    idx_engine_v3_ad_calibration_batch_lookup:
      "CREATE INDEX idx_engine_v3_ad_calibration_batch_lookup ON engine_v3_ad_account_calibration_batches (business_ref_id, provider_account_ref_id, provider_account_id, as_of_date, engine_version, policy_version, completeness_status, as_of_cutoff DESC, id DESC)",
    idx_engine_v3_ad_account_calibration_lookup:
      "CREATE INDEX idx_engine_v3_ad_account_calibration_lookup ON engine_v3_ad_account_calibration_daily (batch_id, account_currency, account_timezone, funnel_cohort, objective, optimization_context)",
  },
  triggers: {
    engine_v3_native_ad_calibration_batch_immutable_trigger:
      "CREATE TRIGGER engine_v3_native_ad_calibration_batch_immutable_trigger BEFORE DELETE OR UPDATE ON engine_v3_ad_account_calibration_batches FOR EACH ROW EXECUTE FUNCTION engine_v3_native_ad_calibration_batch_immutable()",
    engine_v3_native_ad_calibration_cell_immutable_trigger:
      "CREATE TRIGGER engine_v3_native_ad_calibration_cell_immutable_trigger BEFORE INSERT OR DELETE OR UPDATE ON engine_v3_ad_account_calibration_daily FOR EACH ROW EXECUTE FUNCTION engine_v3_native_ad_calibration_cell_immutable()",
  },
} as const;

export async function inspectNativeAdCalibrationSchemaCapability(
  db: DbClient = getDb(),
): Promise<NativeAdCalibrationSchemaCapability> {
  const tableNames = Object.keys(NATIVE_AD_CALIBRATION_REQUIRED_SCHEMA.columns);
  const columns = await db.query<Record<string, unknown>>(
    `
    SELECT c.relname AS table_name, a.attname AS column_name,
      format_type(a.atttypid, a.atttypmod) AS data_type,
      a.attnotnull AS not_null,
      pg_get_expr(ad.adbin, ad.adrelid) AS column_default
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid
      AND a.attnum > 0 AND NOT a.attisdropped
    LEFT JOIN pg_attrdef ad ON ad.adrelid = c.oid AND ad.adnum = a.attnum
    WHERE n.nspname = current_schema()
      AND c.relkind = 'r'
      AND c.relname = ANY($1::text[])
    `,
    [tableNames],
  );
  const constraints = await db.query<Record<string, unknown>>(
    `
    SELECT con.conname AS name, pg_get_constraintdef(con.oid, true) AS definition
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = ANY($1::text[])
    `,
    [tableNames],
  );
  const indexes = await db.query<Record<string, unknown>>(
    `
    SELECT index_class.relname AS name, pg_get_indexdef(index_class.oid) AS definition
    FROM pg_index index_row
    JOIN pg_class table_class ON table_class.oid = index_row.indrelid
    JOIN pg_class index_class ON index_class.oid = index_row.indexrelid
    JOIN pg_namespace n ON n.oid = table_class.relnamespace
    WHERE n.nspname = current_schema() AND table_class.relname = ANY($1::text[])
    `,
    [
      [
        ...tableNames,
        "provider_accounts",
        "business_provider_accounts",
        "engine_v3_job_runs",
      ],
    ],
  );
  const triggers = await db.query<Record<string, unknown>>(
    `
    SELECT trigger_row.tgname AS name,
      pg_get_triggerdef(trigger_row.oid, true) AS definition
    FROM pg_trigger trigger_row
    JOIN pg_class c ON c.oid = trigger_row.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema()
      AND c.relname = ANY($1::text[])
      AND NOT trigger_row.tgisinternal
    `,
    [tableNames],
  );

  const missing: string[] = [];
  const mismatched: string[] = [];
  const availableColumns = new Map(
    columns.map((row) => [
      `${dbRequiredText(row.table_name, "table_name")}.${dbRequiredText(row.column_name, "column_name")}`,
      row,
    ]),
  );
  for (const [tableName, contract] of Object.entries(
    NATIVE_AD_CALIBRATION_REQUIRED_SCHEMA.columns,
  )) {
    for (const [columnName, expected] of Object.entries(contract)) {
      const key = `${tableName}.${columnName}`;
      const actual = availableColumns.get(key);
      if (!actual) {
        missing.push(key);
        continue;
      }
      if (
        dbRequiredText(actual.data_type, `${key}.type`) !== expected.type ||
        actual.not_null !== expected.notNull ||
        normalizeSchemaDefinition(actual.column_default) !==
          normalizeSchemaDefinition(expected.default)
      ) {
        mismatched.push(`${key}:column_contract`);
      }
    }
  }
  compareNamedSchemaDefinitions({
    kind: "constraint",
    expected: NATIVE_AD_CALIBRATION_REQUIRED_SCHEMA.constraints,
    actual: constraints,
    missing,
    mismatched,
  });
  compareNamedSchemaDefinitions({
    kind: "index",
    expected: NATIVE_AD_CALIBRATION_REQUIRED_SCHEMA.indexes,
    actual: indexes,
    missing,
    mismatched,
  });
  compareNamedSchemaDefinitions({
    kind: "trigger",
    expected: NATIVE_AD_CALIBRATION_REQUIRED_SCHEMA.triggers,
    actual: triggers,
    missing,
    mismatched,
  });
  return {
    ready: missing.length === 0 && mismatched.length === 0,
    missing,
    mismatched,
  };
}

export async function replaceNativeAdCalibrationBatch(
  input: { batch: NativeAdCalibrationBatch; jobRunId: string },
  options: {
    db?: DbClient;
    transaction?: <T>(fn: () => Promise<T>) => Promise<T>;
  } = {},
): Promise<NativeAdCalibrationReplacementResult> {
  assertNativeAdCalibrationBatchContract(input.batch);
  const transaction = options.transaction ?? runDbTransaction;
  return transaction(async () => {
    const db = options.db ?? getDb();
    await assertNativeCalibrationTransactionReceipt(input.batch, db);
    await assertPersistedProviderBindings(input.batch, db);

    const cutoffRows = await db.query<Record<string, unknown>>(
      READ_NATIVE_AD_CALIBRATION_BATCH_AT_CUTOFF_SQL,
      [
        input.batch.businessId,
        input.batch.providerAccountRefId,
        input.batch.providerAccountId,
        input.batch.asOfCutoff,
        NATIVE_AD_ENGINE_VERSION,
        NATIVE_AD_CALIBRATION_POLICY_VERSION,
      ],
    );
    if (cutoffRows.length > 1) {
      throw new Error("Native ad calibration cutoff scope is not unique.");
    }
    const cutoffRow = cutoffRows[0];
    if (cutoffRow) {
      const persistedGenerationHash = requiredHash(
        cutoffRow.generation_content_hash,
        "cutoff generation_content_hash",
      );
      if (persistedGenerationHash !== input.batch.generationContentHash) {
        throw new Error(
          "Native ad calibration same_cutoff_generation_conflict: the persisted cutoff already represents different source content.",
        );
      }
      if (cutoffRow.completeness_status !== "complete") {
        throw new Error(
          "Native ad calibration same_cutoff_generation_conflict: an incomplete batch already owns the cutoff.",
        );
      }
    }

    const existingRows = await db.query<Record<string, unknown>>(
      READ_EXISTING_NATIVE_AD_CALIBRATION_BATCH_BY_CONTENT_SQL,
      [
        input.batch.businessId,
        input.batch.providerAccountRefId,
        input.batch.providerAccountId,
        input.batch.asOfDate,
        NATIVE_AD_ENGINE_VERSION,
        NATIVE_AD_CALIBRATION_POLICY_VERSION,
        input.batch.generationContentHash,
      ],
    );
    if (existingRows.length > 1) {
      throw new Error(
        "Native ad calibration generation content scope is not unique.",
      );
    }
    const existing = existingRows[0];
    if (existing) {
      return verifiedExistingCalibrationBatch(existing, db);
    }

    const [insertedBatch] = await db.query<Record<string, unknown>>(
      INSERT_NATIVE_AD_CALIBRATION_BATCH_SQL,
      [
        input.batch.businessId,
        input.batch.businessId,
        input.batch.providerAccountRefId,
        input.batch.providerAccountId,
        input.batch.asOfDate,
        input.batch.asOfCutoff,
        input.batch.sourceProvenance.transactionIsolation,
        NATIVE_AD_ENGINE_VERSION,
        NATIVE_AD_CALIBRATION_POLICY_VERSION,
        input.batch.sourceProvenance.mode,
        JSON.stringify(input.batch.sourceProvenance),
        input.batch.expectedCellCount,
        input.batch.generationContentHash,
        input.batch.inputManifestHash,
        input.batch.sourceManifestHash,
        input.batch.cellSetHash,
        input.jobRunId,
        input.batch.computedAt,
        /*
          $19 — the contract this generation was minted with, taken from the
          batch itself rather than from the module constant, so a batch built
          under one version can never be persisted under another.
        */
        input.batch.contractVersion,
      ],
    );
    const batchId = requiredUuid(insertedBatch?.id, "calibration batch id");
    const payload = buildNativeAdCalibrationPersistencePayload(input.batch, {
      batchId,
      jobRunId: input.jobRunId,
    });
    if (payload.length > 0) {
      await db.query(INSERT_NATIVE_AD_CALIBRATION_SQL, [
        JSON.stringify(payload),
      ]);
    }
    await assertPersistedCellSetProof(input.batch, batchId, db);
    const completed = await db.query<Record<string, unknown>>(
      COMPLETE_NATIVE_AD_CALIBRATION_BATCH_SQL,
      [
        batchId,
        input.batch.expectedCellCount,
        input.batch.inputManifestHash,
        input.batch.sourceManifestHash,
        input.batch.cellSetHash,
      ],
    );
    if (
      completed.length !== 1 ||
      requiredUuid(completed[0]?.id, "completed calibration batch id") !==
        batchId
    ) {
      throw new Error("Native ad calibration batch completion proof failed.");
    }
    return {
      batchId,
      rowsWritten: payload.length,
      expectedCellCount: input.batch.expectedCellCount,
      idempotentReplay: false,
      generationContentHash: input.batch.generationContentHash,
      inputManifestHash: input.batch.inputManifestHash,
      sourceManifestHash: input.batch.sourceManifestHash,
      cellSetHash: input.batch.cellSetHash,
    };
  });
}

async function assertNativeCalibrationTransactionReceipt(
  batch: NativeAdCalibrationBatch,
  db: DbClient,
) {
  const rows = await db.query<Record<string, unknown>>(
    READ_NATIVE_AD_CALIBRATION_TRANSACTION_RECEIPT_SQL,
  );
  if (rows.length !== 1) {
    throw new Error(
      "Native ad calibration transaction receipt must resolve exactly once.",
    );
  }
  const cutoff = dbRequiredTimestamp(
    rows[0]?.computation_cutoff,
    "transaction computation_cutoff",
  );
  const isolation = dbRequiredText(
    rows[0]?.transaction_isolation,
    "transaction_isolation",
  ).toLowerCase();
  if (
    cutoff !== batch.asOfCutoff ||
    isolation !== "repeatable read" ||
    batch.sourceProvenance.transactionCutoff !== cutoff ||
    batch.sourceProvenance.transactionIsolation !== isolation
  ) {
    throw new Error(
      "Native ad calibration transaction receipt does not match its persisted cutoff or REPEATABLE READ isolation.",
    );
  }
}

async function verifiedExistingCalibrationBatch(
  existing: Record<string, unknown>,
  db: DbClient,
): Promise<NativeAdCalibrationReplacementResult> {
  const batchId = requiredUuid(existing.id, "existing calibration batch id");
  const expectedCellCount = requiredInteger(
    existing.expected_cell_count,
    "existing expected_cell_count",
  );
  const cellSetHash = requiredHash(
    existing.cell_set_hash,
    "existing cell_set_hash",
  );
  await assertPersistedCellSetProofValues(
    { expectedCellCount, cellSetHash },
    batchId,
    db,
  );
  return {
    batchId,
    rowsWritten: 0,
    expectedCellCount,
    idempotentReplay: true,
    generationContentHash: requiredHash(
      existing.generation_content_hash,
      "existing generation_content_hash",
    ),
    inputManifestHash: requiredHash(
      existing.input_manifest_hash,
      "existing input_manifest_hash",
    ),
    sourceManifestHash: requiredHash(
      existing.source_manifest_hash,
      "existing source_manifest_hash",
    ),
    cellSetHash,
  };
}

async function assertPersistedProviderBindings(
  batch: NativeAdCalibrationBatch,
  db: DbClient,
) {
  const requestedRows = await db.query<Record<string, unknown>>(
    ASSERT_NATIVE_AD_PROVIDER_BINDINGS_SQL,
    [batch.businessId, batch.providerAccountRefId, batch.providerAccountId],
  );
  if (
    requestedRows.length !== 1 ||
    dbRequiredText(
      requestedRows[0]?.provider_account_ref_id,
      "provider_account_ref_id",
    ) !== batch.providerAccountRefId ||
    dbRequiredText(
      requestedRows[0]?.provider_account_id,
      "provider_account_id",
    ) !== batch.providerAccountId
  ) {
    throw new Error(
      "Native ad calibration provider account is not the exact physical business binding.",
    );
  }
}

async function assertPersistedCellSetProof(
  batch: NativeAdCalibrationBatch,
  batchId: string,
  db: DbClient,
) {
  const rows = await db.query<Record<string, unknown>>(
    READ_NATIVE_AD_CALIBRATION_CELL_SET_PROOF_SQL,
    [batchId],
  );
  return assertPersistedCellSetProofRows(
    {
      expectedCellCount: batch.expectedCellCount,
      cellSetHash: batch.cellSetHash,
    },
    rows,
  );
}

async function assertPersistedCellSetProofValues(
  expected: { expectedCellCount: number; cellSetHash: string },
  batchId: string,
  db: DbClient,
) {
  const rows = await db.query<Record<string, unknown>>(
    READ_NATIVE_AD_CALIBRATION_CELL_SET_PROOF_SQL,
    [batchId],
  );
  return assertPersistedCellSetProofRows(expected, rows);
}

function assertPersistedCellSetProofRows(
  expected: { expectedCellCount: number; cellSetHash: string },
  rows: Record<string, unknown>[],
) {
  if (rows.length !== expected.expectedCellCount) {
    throw new Error(
      `Native ad calibration generation cardinality mismatch: expected ${expected.expectedCellCount}, persisted ${rows.length}.`,
    );
  }
  const hash = computePersistedCellSetHash(rows);
  if (hash !== expected.cellSetHash) {
    throw new Error(
      `Native ad calibration generation hash mismatch: expected ${expected.cellSetHash}, persisted ${hash}.`,
    );
  }
}

export function assertNativeAdCalibrationBatchContract(
  batch: NativeAdCalibrationBatch,
) {
  requiredHash(batch.generationContentHash, "generationContentHash");
  requiredHash(batch.inputManifestHash, "inputManifestHash");
  requiredHash(batch.sourceManifestHash, "sourceManifestHash");
  requiredHash(batch.cellSetHash, "cellSetHash");
  requiredUuid(batch.providerAccountRefId, "providerAccountRefId");
  assertNativeAdCalibrationCurrencyAdmission(
    batch.sourceProvenance.currencyAdmission,
  );
  assertNativeAdCalibrationTimezoneAdmission(
    batch.sourceProvenance.timezoneAdmission,
  );
  const window = resolveNativeAdCalibrationCutoff(
    batch.asOfDate,
    batch.asOfCutoff,
  );
  // The SAME builder the producer digests, so this check cannot pass on a
  // formula the producer no longer uses.
  const recomputedGenerationContentHash = canonicalSha256(
    nativeAdCalibrationBatchGenerationContent({
      ...batch,
      contractVersion: NATIVE_AD_CALIBRATION_CONTRACT_VERSION,
      policyVersion: NATIVE_AD_CALIBRATION_POLICY_VERSION,
      engineVersion: NATIVE_AD_ENGINE_VERSION,
    }),
  );
  const recomputedInputManifestHash = canonicalSha256(
    nativeAdCalibrationBatchInputManifestContent(
      batch,
      recomputedGenerationContentHash,
    ),
  );
  if (
    batch.contractVersion !== NATIVE_AD_CALIBRATION_CONTRACT_VERSION ||
    batch.engineVersion !== NATIVE_AD_ENGINE_VERSION ||
    batch.policyVersion !== NATIVE_AD_CALIBRATION_POLICY_VERSION ||
    batch.providerAccountRefId !==
      batch.sourceProvenance.providerAccountRefId ||
    batch.providerAccountId !== batch.sourceProvenance.providerAccountId ||
    batch.asOfCutoff !== batch.sourceProvenance.transactionCutoff ||
    batch.sourceProvenance.mode !== "current_transaction_snapshot" ||
    batch.sourceProvenance.transactionIsolation !== "repeatable read" ||
    batch.computedAt !== batch.asOfCutoff ||
    batch.sampleWindowStart !== window.sampleWindowStart ||
    batch.sampleWindowEnd !== window.sampleWindowEnd ||
    batch.sampleWindowDays !== SAMPLE_WINDOW_DAYS ||
    batch.generationContentHash !== recomputedGenerationContentHash ||
    batch.inputManifestHash !== recomputedInputManifestHash
  ) {
    throw new Error(
      "Native ad calibration batch uses a non-native engine epoch.",
    );
  }
  if (
    batch.cells.length !== batch.expectedCellCount ||
    computeNativeAdCalibrationCellSetHash(batch.cells) !== batch.cellSetHash
  ) {
    throw new Error(
      "Native ad calibration batch completeness proof is invalid.",
    );
  }
  for (const cell of batch.cells) {
    if (
      cell.key.businessId !== batch.businessId ||
      cell.key.providerAccountRefId !== batch.providerAccountRefId ||
      cell.key.providerAccountId !== batch.providerAccountId ||
      cell.asOfCutoff !== batch.asOfCutoff ||
      cell.engineVersion !== NATIVE_AD_ENGINE_VERSION ||
      cell.policyVersion !== NATIVE_AD_CALIBRATION_POLICY_VERSION ||
      cell.batchInputManifestHash !== batch.inputManifestHash ||
      cell.sourceManifestHash !== batch.sourceManifestHash ||
      recomputeNativeAdCalibrationCellInputManifestHash(cell) !==
        cell.inputManifestHash ||
      cell.batchCellCount !== batch.expectedCellCount ||
      cell.batchCellSetHash !== batch.cellSetHash ||
      cell.batchCompleteness !== "computed"
    ) {
      throw new Error(
        "Native ad calibration cell is outside its batch contract.",
      );
    }
  }
}

function assertNativeAdCalibrationCurrencyAdmission(
  admission: NativeAdCalibrationCurrencyAdmission,
) {
  const counts = [
    admission.candidateRowCount,
    admission.admittedRowCount,
    admission.anomalyRowCount,
    admission.sourceCurrencyMissingRowCount,
    admission.resolvedCurrencyMissingRowCount,
    admission.resolvedSourceMismatchRowCount,
    admission.distinctSourceCurrencyCount,
    admission.distinctResolvedCurrencyCount,
  ];
  if (
    admission.contractVersion !==
      "engine-v3-native-ad-currency-admission.v1" ||
    counts.some((value) => !Number.isInteger(value) || value < 0) ||
    admission.admittedRowCount > admission.candidateRowCount ||
    admission.anomalyRowCount > admission.candidateRowCount ||
    admission.sourceCurrencyMissingRowCount > admission.candidateRowCount ||
    admission.resolvedCurrencyMissingRowCount > admission.candidateRowCount ||
    admission.resolvedSourceMismatchRowCount > admission.candidateRowCount ||
    admission.distinctSourceCurrencyCount > admission.candidateRowCount ||
    admission.distinctResolvedCurrencyCount > admission.candidateRowCount ||
    !/^[0-9a-f]{64}$/.test(admission.manifestHash)
  ) {
    throw new Error(
      "Native ad calibration currency admission receipt is malformed.",
    );
  }
  if (
    admission.status === "ready" &&
    (admission.reason !== null ||
      admission.keyBasis !== "immutable_source" ||
      admission.accountCurrency === null ||
      admission.candidateRowCount === 0 ||
      admission.admittedRowCount !== admission.candidateRowCount ||
      admission.anomalyRowCount !== 0 ||
      admission.sourceCurrencyMissingRowCount !== 0 ||
      admission.resolvedCurrencyMissingRowCount !== 0 ||
      admission.resolvedSourceMismatchRowCount !== 0 ||
      admission.distinctSourceCurrencyCount !== 1 ||
      admission.distinctResolvedCurrencyCount !== 1)
  ) {
    throw new Error(
      "Native ad calibration ready currency admission receipt is contradictory.",
    );
  }
  if (
    admission.status === "unavailable" &&
    (admission.reason !== "source_currency_unavailable" ||
      admission.keyBasis !== null ||
      admission.accountCurrency !== null ||
      admission.candidateRowCount !== 0 ||
      admission.admittedRowCount !== 0 ||
      admission.anomalyRowCount !== 0)
  ) {
    throw new Error(
      "Native ad calibration unavailable currency admission receipt is contradictory.",
    );
  }
  if (
    admission.status === "blocked" &&
    (admission.reason === null ||
      admission.reason === "source_currency_unavailable" ||
      admission.candidateRowCount === 0 ||
      admission.admittedRowCount !== 0 ||
      admission.anomalyRowCount === 0)
  ) {
    throw new Error(
      "Native ad calibration blocked currency admission receipt is contradictory.",
    );
  }
}

function assertNativeAdCalibrationTimezoneAdmission(
  admission: NativeAdCalibrationTimezoneAdmission,
) {
  const counts = [
    admission.candidateRowCount,
    admission.latestSourceRowCount,
    admission.admittedRowCount,
    admission.anomalyRowCount,
    admission.sourceTimezoneMissingRowCount,
    admission.distinctSourceTimezoneCount,
  ];
  if (
    admission.contractVersion !==
      "engine-v3-native-ad-timezone-admission.v1" ||
    counts.some((value) => !Number.isInteger(value) || value < 0) ||
    admission.latestSourceRowCount > admission.candidateRowCount ||
    admission.admittedRowCount > admission.candidateRowCount ||
    admission.anomalyRowCount > admission.latestSourceRowCount ||
    admission.sourceTimezoneMissingRowCount >
      admission.latestSourceRowCount ||
    admission.distinctSourceTimezoneCount >
      admission.latestSourceRowCount ||
    !/^[0-9a-f]{64}$/.test(admission.manifestHash)
  ) {
    throw new Error(
      "Native ad calibration timezone admission receipt is malformed.",
    );
  }
  if (
    admission.status === "ready" &&
    (admission.reason !== null ||
      admission.keyBasis !== "immutable_latest_source_date" ||
      admission.accountTimezone === null ||
      admission.candidateRowCount === 0 ||
      admission.latestSourceDate === null ||
      !isDateOnly(admission.latestSourceDate) ||
      admission.latestSourceRowCount === 0 ||
      admission.admittedRowCount !== admission.candidateRowCount ||
      admission.anomalyRowCount !== 0 ||
      admission.sourceTimezoneMissingRowCount !== 0 ||
      admission.distinctSourceTimezoneCount !== 1)
  ) {
    throw new Error(
      "Native ad calibration ready timezone admission receipt is contradictory.",
    );
  }
  if (
    admission.status === "unavailable" &&
    (admission.reason !== "source_timezone_unavailable" ||
      admission.keyBasis !== null ||
      admission.accountTimezone !== null ||
      admission.candidateRowCount !== 0 ||
      admission.latestSourceDate !== null ||
      admission.latestSourceRowCount !== 0 ||
      admission.admittedRowCount !== 0 ||
      admission.anomalyRowCount !== 0 ||
      admission.sourceTimezoneMissingRowCount !== 0 ||
      admission.distinctSourceTimezoneCount !== 0)
  ) {
    throw new Error(
      "Native ad calibration unavailable timezone admission receipt is contradictory.",
    );
  }
  if (
    admission.status === "blocked" &&
    (admission.reason === null ||
      admission.reason === "source_timezone_unavailable" ||
      admission.keyBasis !== null ||
      admission.accountTimezone !== null ||
      admission.candidateRowCount === 0 ||
      admission.latestSourceDate === null ||
      !isDateOnly(admission.latestSourceDate) ||
      admission.latestSourceRowCount === 0 ||
      admission.admittedRowCount !== 0 ||
      admission.anomalyRowCount === 0 ||
      (admission.reason === "latest_source_timezone_missing" &&
        admission.sourceTimezoneMissingRowCount === 0) ||
      (admission.reason === "mixed_latest_source_timezone" &&
        (admission.sourceTimezoneMissingRowCount !== 0 ||
          admission.distinctSourceTimezoneCount <= 1 ||
          admission.anomalyRowCount !== admission.latestSourceRowCount)))
  ) {
    throw new Error(
      "Native ad calibration blocked timezone admission receipt is contradictory.",
    );
  }
}

function providerBindingsFromRows(rows: Record<string, unknown>[]) {
  return rows
    .map((row) => ({
      providerAccountRefId: requiredUuid(
        row.provider_account_ref_id,
        "provider_account_ref_id",
      ),
      providerAccountId: dbRequiredText(
        row.provider_account_id,
        "provider_account_id",
      ),
      // Optional by absence: a binding read before this column was selected
      // simply has no currency, and the store benchmark then yields nothing.
      accountCurrency:
        typeof row.account_currency === "string"
        && row.account_currency.trim().length > 0
          ? row.account_currency.trim().toUpperCase()
          : null,
    }))
    .sort((left, right) =>
      `${left.providerAccountRefId}\u0000${left.providerAccountId}`.localeCompare(
        `${right.providerAccountRefId}\u0000${right.providerAccountId}`,
      ),
    );
}

function computePersistedCellSetHash(rows: Record<string, unknown>[]) {
  return canonicalSha256({
    contractVersion: NATIVE_AD_CALIBRATION_CONTRACT_VERSION,
    cells: rows
      .map((row) => ({
        identity: [
          requiredText(String(row.business_id ?? ""), "business_id"),
          requiredText(
            String(row.provider_account_ref_id ?? ""),
            "provider_account_ref_id",
          ),
          requiredText(
            String(row.provider_account_id ?? ""),
            "provider_account_id",
          ),
          requiredText(String(row.account_timezone ?? ""), "account_timezone"),
          requiredText(String(row.account_currency ?? ""), "account_currency"),
          requiredText(String(row.cell_scope ?? ""), "cell_scope"),
          requiredText(String(row.objective ?? ""), "objective"),
          requiredText(String(row.funnel_cohort ?? ""), "funnel_cohort"),
          requiredText(
            String(row.optimization_context ?? ""),
            "optimization_context",
          ),
        ].join("\u0000"),
        inputManifestHash: requiredHash(
          row.input_manifest_hash,
          "input_manifest_hash",
        ),
        sourceManifestHash: requiredHash(
          row.source_manifest_hash,
          "source_manifest_hash",
        ),
      }))
      .sort((left, right) => left.identity.localeCompare(right.identity)),
  });
}

export function adCalibrationJobAdvisoryLockKey(
  input: AdCalibrationJobInput,
): bigint {
  return hashAdvisoryLock(
    `${AD_CALIBRATION_JOB_NAME}:${input.businessId}:${input.asOf}:${NATIVE_AD_ENGINE_VERSION}`,
  );
}

export async function runAdCalibrationJob(
  input: AdCalibrationJobInput,
  options: AdCalibrationJobRuntimeOptions = {},
): Promise<AdCalibrationJobResult> {
  const startedAt = Date.now();
  let requestedDate: ReturnType<typeof resolveNativeAdCalibrationDate>;
  try {
    requestedDate = resolveNativeAdCalibrationDate(input.asOf);
  } catch (error) {
    return failedAdCalibrationWithoutRun({
      startedAt,
      reason: "historical_as_of_unsafe",
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }
  const businessGuard = options.businessGuard ?? getBusinessGuardFailure;
  const guardFailure = await businessGuard(input.businessId);
  if (guardFailure) {
    return failedAdCalibrationWithoutRun({
      startedAt,
      reason: guardFailure.reason,
      errorMessage: guardFailure.message,
    });
  }
  const flags = await (options.resolveFlags ?? resolveEngineV3Flags)(
    input.businessId,
  );
  if (!flags.enabled) {
    return {
      jobRunId: "",
      status: "skipped",
      rowsWritten: 0,
      expectedCellCount: 0,
      idempotentReplay: false,
      inputManifestHash: null,
      sourceManifestHash: null,
      cellSetHash: null,
      batches: [],
      durationMs: Date.now() - startedAt,
      reason: "engine_v3_disabled",
    };
  }

  const transaction =
    options.transaction ??
    (<T>(fn: () => Promise<T>) =>
      runDbTransaction(fn, {
        timeoutMs: ENGINE_V3_JOB_TRANSACTION_TIMEOUT_MS,
      }));
  return transaction(async () => {
    const db = options.db ?? getDb();
    await db.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    const [lock] = await db.query<Record<string, unknown>>(
      "SELECT pg_try_advisory_xact_lock($1::bigint) AS acquired",
      [adCalibrationJobAdvisoryLockKey(input).toString()],
    );
    if (lock?.acquired !== true) {
      const durationMs = Date.now() - startedAt;
      const errorMessage =
        "Advisory lock not acquired (native ad calibration may already be running)";
      const jobRunId = await insertAdCalibrationJobRun(
        {
          ...input,
          status: "skipped",
          durationMs,
          errorMessage,
        },
        db,
      );
      return {
        jobRunId,
        status: "skipped" as const,
        rowsWritten: 0,
        expectedCellCount: 0,
        idempotentReplay: false,
        inputManifestHash: null,
        sourceManifestHash: null,
        cellSetHash: null,
        batches: [],
        durationMs,
        reason: "advisory_lock_not_acquired" as const,
        errorMessage,
      };
    }

    const jobRunId = await insertAdCalibrationJobRun(
      { ...input, status: "running" },
      db,
    );
    await db.query("SAVEPOINT engine_v3_ad_calibration_job_work");
    try {
      const capability = await inspectNativeAdCalibrationSchemaCapability(db);
      if (!capability.ready) {
        throw new NativeAdCalibrationSchemaNotReadyError([
          ...capability.missing,
          ...capability.mismatched,
        ]);
      }
      const receiptRows = await db.query<Record<string, unknown>>(
        READ_NATIVE_AD_CALIBRATION_TRANSACTION_RECEIPT_SQL,
      );
      if (receiptRows.length !== 1) {
        throw new Error(
          "Native ad calibration transaction receipt must resolve exactly once.",
        );
      }
      const computationCutoff = dbRequiredTimestamp(
        receiptRows[0]?.computation_cutoff,
        "computation_cutoff",
      );
      const transactionIsolation = dbRequiredText(
        receiptRows[0]?.transaction_isolation,
        "transaction_isolation",
      ).toLowerCase();
      if (transactionIsolation !== "repeatable read") {
        throw new Error(
          "Native ad calibration requires a REPEATABLE READ transaction snapshot.",
        );
      }
      resolveNativeAdCalibrationCutoff(
        requestedDate.asOfDate,
        computationCutoff,
      );
      const providerRows = await db.query<Record<string, unknown>>(
        LIST_NATIVE_AD_PROVIDER_BINDINGS_SQL,
        [input.businessId],
      );
      const bindings = providerBindingsFromRows(providerRows);
      const completed: Array<{
        batch: NativeAdCalibrationBatch;
        replacement: NativeAdCalibrationReplacementResult;
      }> = [];
      for (const binding of bindings) {
        const sourceRows = await db.query<Record<string, unknown>>(
          READ_NATIVE_AD_CALIBRATION_SOURCE_SQL,
          [
            input.businessId,
            requestedDate.asOfDate,
            binding.providerAccountRefId,
            binding.providerAccountId,
            computationCutoff,
          ],
        );
        const [targetRow] = await db.query<Record<string, unknown>>(
          READ_NATIVE_AD_TARGET_AUTHORITY_FOR_ACCOUNT_SQL,
          [
            input.businessId,
            binding.providerAccountRefId,
            binding.providerAccountId,
            computationCutoff,
          ],
        );
        /*
          The store's observed average order value, for THIS account.

          Resolved here because this is where the IO belongs and where the
          account's currency is known — the benchmark is in the ad account's
          own currency and no conversion is performed, so a store selling in
          another currency yields nothing rather than a translated guess. A
          currency with no ISO exponent yields nothing for the same reason: a
          number whose scale is unknown is not a number.
        */
        const accountCurrency = binding.accountCurrency ?? null;
        const exponent = resolveMinorUnitExponent(accountCurrency);
        const observedShopifyAovEvidence = await (
          options.resolveObservedAov ?? resolveObservedShopifyAov
        )({
          businessId: input.businessId,
          accountCurrency,
          currencyExponent:
            exponent.status === "resolved" ? exponent.exponent : null,
        }).catch(() => null);

        const batch = computeNativeAdCalibrationBatch({
          businessId: input.businessId,
          providerAccountRefId: binding.providerAccountRefId,
          providerAccountId: binding.providerAccountId,
          asOf: requestedDate.asOfDate,
          computationCutoff,
          sourceRows: sourceRows.map(mapNativeAdCalibrationSourceRow),
          targetAuthority: targetRow
            ? mapNativeAdTargetAuthorityRow(targetRow)
            : null,
          observedShopifyAovEvidence,
        });
        const replacement = await replaceNativeAdCalibrationBatch(
          { batch, jobRunId },
          { db, transaction: async (fn) => fn() },
        );
        completed.push({ batch, replacement });
      }
      const durationMs = Date.now() - startedAt;
      await markAdCalibrationJobSuccess(
        { jobRunId, durationMs, completed },
        db,
      );
      const batches = completed.map(({ batch, replacement }) => ({
        providerAccountRefId: batch.providerAccountRefId,
        providerAccountId: batch.providerAccountId,
        batchId: replacement.batchId,
        rowsWritten: replacement.rowsWritten,
        expectedCellCount: replacement.expectedCellCount,
        idempotentReplay: replacement.idempotentReplay,
        generationContentHash: replacement.generationContentHash,
        inputManifestHash: replacement.inputManifestHash,
        sourceManifestHash: replacement.sourceManifestHash,
        cellSetHash: replacement.cellSetHash,
        currencyAdmission: batch.sourceProvenance.currencyAdmission,
        timezoneAdmission: batch.sourceProvenance.timezoneAdmission,
      }));
      const proof = aggregateCalibrationJobProof(batches);
      return {
        jobRunId,
        status: "success" as const,
        rowsWritten: sum(batches, (batch) => batch.rowsWritten),
        expectedCellCount: sum(batches, (batch) => batch.expectedCellCount),
        idempotentReplay:
          batches.length > 0 &&
          batches.every((batch) => batch.idempotentReplay),
        inputManifestHash: proof.inputManifestHash,
        sourceManifestHash: proof.sourceManifestHash,
        cellSetHash: proof.cellSetHash,
        batches,
        durationMs,
      };
    } catch (error) {
      await db.query("ROLLBACK TO SAVEPOINT engine_v3_ad_calibration_job_work");
      const durationMs = Date.now() - startedAt;
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      await markAdCalibrationJobFailed(
        { jobRunId, durationMs, error, errorMessage },
        db,
      );
      return {
        jobRunId,
        status: "failed" as const,
        rowsWritten: 0,
        expectedCellCount: 0,
        idempotentReplay: false,
        inputManifestHash: null,
        sourceManifestHash: null,
        cellSetHash: null,
        batches: [],
        durationMs,
        ...(error instanceof NativeAdCalibrationSchemaNotReadyError
          ? { reason: "schema_not_ready" as const }
          : error instanceof NativeAdHistoricalCalibrationUnsafeError
            ? { reason: "historical_as_of_unsafe" as const }
            : {}),
        errorMessage,
      };
    }
  });
}

async function insertAdCalibrationJobRun(
  input: AdCalibrationJobInput & {
    status: AdCalibrationJobResult["status"] | "running";
    durationMs?: number;
    errorMessage?: string;
  },
  db: DbClient,
) {
  const [row] = await db.query<Record<string, unknown>>(
    `
    INSERT INTO engine_v3_job_runs (
      job_name, business_ref_id, business_id, as_of_date, engine_version, status,
      finished_at, duration_ms, row_count, error_message
    ) VALUES (
      $1, $2::uuid, $3, $4::date, $5, $6,
      CASE WHEN $6 = 'running' THEN NULL ELSE now() END,
      $7::integer, CASE WHEN $6 = 'running' THEN NULL ELSE 0 END, $8
    )
    RETURNING id::text AS id
    `,
    [
      AD_CALIBRATION_JOB_NAME,
      input.businessId,
      input.businessId,
      input.asOf,
      NATIVE_AD_ENGINE_VERSION,
      input.status,
      input.durationMs ?? null,
      input.errorMessage ?? null,
    ],
  );
  return requiredUuid(row?.id, "native ad calibration job run id");
}

async function markAdCalibrationJobSuccess(
  input: {
    jobRunId: string;
    durationMs: number;
    completed: Array<{
      batch: NativeAdCalibrationBatch;
      replacement: NativeAdCalibrationReplacementResult;
    }>;
  },
  db: DbClient,
) {
  const observations = input.completed.flatMap(
    ({ batch }) => batch.observations,
  );
  const rows = await db.query<Record<string, unknown>>(
    `
    UPDATE engine_v3_job_runs
    SET status = 'success', finished_at = clock_timestamp(), duration_ms = $1::integer,
      row_count = $2::integer, source_min_date = $3::date,
      source_max_date = $4::date, source_max_updated_at = $5::timestamptz,
      error_json = $6::jsonb, updated_at = clock_timestamp()
    WHERE id = $7::uuid AND status = 'running'
    RETURNING id::text AS id
    `,
    [
      input.durationMs,
      sum(input.completed, ({ replacement }) => replacement.expectedCellCount),
      minText(observations.map((row) => row.sourceMinDate)),
      maxText(observations.map((row) => row.sourceMaxDate)),
      maxText(observations.map((row) => row.sourceMaxUpdatedAt)),
      JSON.stringify({
        metadata: {
          native_ad_grain: true,
          shadow_only: true,
          source_mode: "current_transaction_snapshot",
          provider_account_count: input.completed.length,
          expected_cell_count: sum(
            input.completed,
            ({ replacement }) => replacement.expectedCellCount,
          ),
          rows_written: sum(
            input.completed,
            ({ replacement }) => replacement.rowsWritten,
          ),
          idempotent_replay:
            input.completed.length > 0 &&
            input.completed.every(
              ({ replacement }) => replacement.idempotentReplay,
            ),
          batches: input.completed.map(({ batch, replacement }) => ({
            provider_account_ref_id: batch.providerAccountRefId,
            provider_account_id: batch.providerAccountId,
            batch_id: replacement.batchId,
            generation_content_hash: replacement.generationContentHash,
            input_manifest_hash: replacement.inputManifestHash,
            source_manifest_hash: replacement.sourceManifestHash,
            cell_set_hash: replacement.cellSetHash,
            currency_admission: batch.sourceProvenance.currencyAdmission,
            timezone_admission: batch.sourceProvenance.timezoneAdmission,
          })),
        },
      }),
      input.jobRunId,
    ],
  );
  assertTerminalJobRunUpdate(rows, input.jobRunId, "success");
}

async function markAdCalibrationJobFailed(
  input: {
    jobRunId: string;
    durationMs: number;
    error: unknown;
    errorMessage: string;
  },
  db: DbClient,
) {
  const rows = await db.query<Record<string, unknown>>(
    `
    UPDATE engine_v3_job_runs
    SET status = 'failed', finished_at = clock_timestamp(), duration_ms = $1::integer,
      row_count = 0, error_message = $2, error_json = $3::jsonb,
      updated_at = clock_timestamp()
    WHERE id = $4::uuid AND status = 'running'
    RETURNING id::text AS id
    `,
    [
      input.durationMs,
      input.errorMessage,
      JSON.stringify(errorToJson(input.error)),
      input.jobRunId,
    ],
  );
  assertTerminalJobRunUpdate(rows, input.jobRunId, "failed");
}

function assertTerminalJobRunUpdate(
  rows: Record<string, unknown>[],
  jobRunId: string,
  status: "success" | "failed",
) {
  if (
    rows.length !== 1 ||
    requiredUuid(rows[0]?.id, `${status} native calibration job run id`) !==
      jobRunId
  ) {
    throw new Error(
      `Native ad calibration ${status} terminal update did not affect exactly its running job row.`,
    );
  }
}

function aggregateCalibrationJobProof(
  batches: NativeAdCalibrationJobBatchResult[],
): Pick<
  AdCalibrationJobResult,
  "inputManifestHash" | "sourceManifestHash" | "cellSetHash"
> {
  if (batches.length === 0) {
    return {
      inputManifestHash: null,
      sourceManifestHash: null,
      cellSetHash: null,
    };
  }
  if (batches.length === 1) {
    return {
      inputManifestHash: batches[0]?.inputManifestHash ?? null,
      sourceManifestHash: batches[0]?.sourceManifestHash ?? null,
      cellSetHash: batches[0]?.cellSetHash ?? null,
    };
  }
  const ordered = [...batches].sort((left, right) =>
    `${left.providerAccountRefId}\u0000${left.providerAccountId}`.localeCompare(
      `${right.providerAccountRefId}\u0000${right.providerAccountId}`,
    ),
  );
  return {
    inputManifestHash: canonicalSha256(
      ordered.map((batch) => batch.inputManifestHash),
    ),
    sourceManifestHash: canonicalSha256(
      ordered.map((batch) => batch.sourceManifestHash),
    ),
    cellSetHash: canonicalSha256(ordered.map((batch) => batch.cellSetHash)),
  };
}

function failedAdCalibrationWithoutRun(input: {
  startedAt: number;
  reason:
    "invalid_business_id" | "business_not_found" | "historical_as_of_unsafe";
  errorMessage: string;
}): AdCalibrationJobResult {
  return {
    jobRunId: "",
    status: "failed",
    rowsWritten: 0,
    expectedCellCount: 0,
    idempotentReplay: false,
    inputManifestHash: null,
    sourceManifestHash: null,
    cellSetHash: null,
    batches: [],
    durationMs: Date.now() - input.startedAt,
    reason: input.reason,
    errorMessage: input.errorMessage,
  };
}

function buildObservations(input: {
  businessId: string;
  asOfCutoff: string;
  sampleWindowStart: string;
  sampleWindowEnd: string;
  rows: NormalizedSourceRow[];
}): ObservationBuildResult {
  const qualityCounts = emptyQualityCounts(input.rows.length);
  const grouped = new Map<string, NormalizedSourceRow[]>();
  const eligibleSourceRows: NormalizedSourceRow[] = [];

  for (const row of input.rows) {
    if (
      row.businessId !== input.businessId ||
      !row.providerAccountRefId ||
      !row.providerAccountId ||
      !row.adId ||
      !isDateOnly(row.date) ||
      row.date < input.sampleWindowStart ||
      row.date > input.sampleWindowEnd
    ) {
      qualityCounts.identitySourceRowExclusionCount += 1;
      continue;
    }
    const key = `${row.businessId}\u0000${row.providerAccountRefId}\u0000${row.providerAccountId}\u0000${row.adId}`;
    const list = grouped.get(key) ?? [];
    list.push(row);
    grouped.set(key, list);
  }

  qualityCounts.candidateAdCount = grouped.size;
  const observations: NativeAdCalibrationObservation[] = [];
  const sortedAdGroups = [...grouped.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  );

  for (const [, rows] of sortedAdGroups) {
    const censoredRows = rows.filter((row) => !hasFinalizedTruth(row));
    if (censoredRows.length > 0) {
      qualityCounts.censoredSourceRowExclusionCount += censoredRows.length;
      qualityCounts.censoredAdExclusionCount += 1;
      continue;
    }

    const freshnessRows = rows.filter(
      (row) => !isRowAvailableAtCutoff(row, input.asOfCutoff),
    );
    if (freshnessRows.length > 0) {
      qualityCounts.freshnessSourceRowExclusionCount += freshnessRows.length;
      qualityCounts.freshnessAdExclusionCount += 1;
      continue;
    }
    qualityCounts.cutoffSafeSourceRowCount += rows.length;
    const peerTruthFinalizedAtMissingRows = rows.filter(
      (row) => row.finalizedAt === null,
    );
    qualityCounts.peerTruthFinalizedAtMissingSourceRowCount +=
      peerTruthFinalizedAtMissingRows.length;
    if (peerTruthFinalizedAtMissingRows.length > 0) {
      qualityCounts.peerTruthFinalizedAtMissingAdCount += 1;
    }

    const dayGroups = groupBy(rows, (row) => row.date);
    const deduplicated: NormalizedSourceRow[] = [];
    let duplicateConflict = false;
    for (const dayRows of [...dayGroups.values()]) {
      const signatures = new Set(dayRows.map(sourceContentSignature));
      if (signatures.size > 1) {
        qualityCounts.duplicateSourceRowExclusionCount += dayRows.length;
        duplicateConflict = true;
        break;
      }
      const sorted = [...dayRows].sort((left, right) =>
        left.sourceRowId.localeCompare(right.sourceRowId),
      );
      const first = sorted[0];
      if (first) deduplicated.push(first);
      qualityCounts.duplicateSourceRowExclusionCount += Math.max(
        0,
        dayRows.length - 1,
      );
    }
    if (duplicateConflict) {
      qualityCounts.duplicateConflictAdExclusionCount += 1;
      continue;
    }

    const totalSpend = sum(deduplicated, (row) => row.spend);
    if (totalSpend <= 0 || deduplicated.some(hasInvalidMetric)) {
      qualityCounts.censoredSourceRowExclusionCount += deduplicated.length;
      qualityCounts.censoredAdExclusionCount += 1;
      continue;
    }

    const positiveSpendRows = deduplicated.filter((row) => row.spend > 0);
    const contexts = positiveSpendRows.map(normalizedExactContext);
    if (contexts.some((context) => context === null)) {
      qualityCounts.missingContextAdExclusionCount += 1;
      continue;
    }
    const exactContexts = contexts.filter(
      (context): context is NonNullable<typeof context> => context !== null,
    );
    const cardinality = contextCardinality(exactContexts);
    if (cardinality.mixed) {
      qualityCounts.mixedContextAdExclusionCount += 1;
      if (cardinality.currency > 1) {
        qualityCounts.mixedCurrencyAdExclusionCount += 1;
      }
      if (cardinality.objective > 1) {
        qualityCounts.mixedObjectiveAdExclusionCount += 1;
      }
      if (cardinality.cohort > 1) {
        qualityCounts.mixedCohortAdExclusionCount += 1;
      }
      continue;
    }

    const context = exactContexts[0];
    if (!context) {
      qualityCounts.missingContextAdExclusionCount += 1;
      continue;
    }
    const acceptedSourceRowIds = deduplicated
      .map((row) => row.sourceRowId)
      .sort((left, right) => left.localeCompare(right));
    eligibleSourceRows.push(...deduplicated);
    observations.push(
      aggregateObservation({
        rows: deduplicated.sort((left, right) =>
          left.date.localeCompare(right.date),
        ),
        sourceRowIds: acceptedSourceRowIds,
        context,
        sampleWindowEnd: input.sampleWindowEnd,
      }),
    );
  }

  observations.sort((left, right) =>
    observationIdentity(left).localeCompare(observationIdentity(right)),
  );
  qualityCounts.eligibleAdObservationCount = observations.length;
  eligibleSourceRows.sort((left, right) =>
    sourceManifestEntry(left).sortKey.localeCompare(
      sourceManifestEntry(right).sortKey,
    ),
  );
  return { observations, qualityCounts, eligibleSourceRows };
}

function buildCells(
  batch: Omit<
    NativeAdCalibrationBatch,
    "cells" | "expectedCellCount" | "cellSetHash"
  >,
): NativeAdCalibrationCell[] {
  const grouped = new Map<
    string,
    { key: NativeAdCalibrationCellKey; rows: NativeAdCalibrationObservation[] }
  >();

  for (const observation of batch.observations) {
    const optimizationContext = buildNativeAdOptimizationContext(
      observation.optimizationGoal,
      observation.customEventType,
    );
    if (optimizationContext === null) {
      throw new Error("Native ad observation is missing optimization context.");
    }
    const exactKey: NativeAdCalibrationCellKey = {
      businessId: observation.businessId,
      providerAccountRefId: observation.providerAccountRefId,
      providerAccountId: observation.providerAccountId,
      accountTimezone: observation.accountTimezone,
      accountCurrency: observation.accountCurrency,
      cellScope: "objective_cohort_context",
      objective: observation.objective,
      cohort: observation.cohort,
      optimizationContext,
    };
    const fallbackKey: NativeAdCalibrationCellKey = {
      ...exactKey,
      cellScope: "account_objective_cohort",
      optimizationContext: NATIVE_AD_ACCOUNT_WIDE_OPTIMIZATION_CONTEXT,
    };
    addCellObservation(grouped, exactKey, observation);
    addCellObservation(grouped, fallbackKey, observation);
  }

  return [...grouped.values()]
    .sort((left, right) =>
      cellIdentity(left.key).localeCompare(cellIdentity(right.key)),
    )
    .map(({ key, rows }) => computeCell(batch, key, rows));
}

function computeCell(
  batch: Omit<
    NativeAdCalibrationBatch,
    "cells" | "expectedCellCount" | "cellSetHash"
  >,
  key: NativeAdCalibrationCellKey,
  observations: NativeAdCalibrationObservation[],
): NativeAdCalibrationCell {
  const purchase = key.cohort === "purchase";
  const converterPopulation = purchase
    ? observations.filter(
        (row) =>
          row.totalConversions >= 1 &&
          row.totalRevenue > 0 &&
          row.totalSpend > 0,
      )
    : [];
  const targetRoas = batch.targetAuthority.targetRoasAuthority
    ? batch.targetAuthority.targetRoas
    : null;
  const winnerPopulation =
    purchase && positiveFinite(targetRoas)
      ? converterPopulation.filter(
          (row) =>
            row.aggregateRoas !== null && row.aggregateRoas >= targetRoas,
        )
      : [];
  const cpaValues = converterPopulation
    .map((row) => row.aggregateCpa)
    .filter(isFiniteNumber);
  const roasValues = converterPopulation
    .map((row) => row.aggregateRoas)
    .filter(isFiniteNumber);
  const roasRatios =
    purchase && positiveFinite(targetRoas)
      ? converterPopulation
          .map((row) =>
            row.aggregateRoas === null ? null : row.aggregateRoas / targetRoas,
          )
          .filter(isFiniteNumber)
      : [];
  const refreshRatios = purchase
    ? observations.map((row) => row.recentTotalRatio).filter(isFiniteNumber)
    : [];
  const lowCtrValues = observations
    .map((row) => row.cumulative28dCtr)
    .filter(isFiniteNumber);
  const purchaseCount = purchase
    ? sum(observations, (row) => row.totalConversions)
    : 0;
  const purchaseRevenue = purchase
    ? sum(observations, (row) => row.totalRevenue)
    : 0;
  const metaAovQuality = classifyMetaAovQuality(purchaseCount);
  const funnelCalibration = buildFunnelCalibration(observations);
  const baseline = funnelCalibration.byFormat.overall;
  if (!baseline) {
    throw new Error("Native ad overall funnel baseline was not built.");
  }
  const metricSampleCounts = buildMetricSampleCounts({
    observations,
    roasValues,
    roasRatios,
    cpaValues,
    winnerPopulation,
    refreshRatios,
  });
  const accountCalibration: AccountCalibration = {
    businessId: key.businessId,
    computedAt: batch.computedAt,
    matureCreativeCount: converterPopulation.length,
    roasP75:
      purchase && converterPopulation.length >= 30
        ? percentile(roasValues, 0.75)
        : null,
    roasP60:
      purchase && converterPopulation.length >= 10
        ? percentile(roasValues, 0.6)
        : null,
    refreshRatioP10:
      purchase && refreshRatios.length >= 20
        ? percentile(refreshRatios, 0.1)
        : null,
    lowCtrP10: lowCtrValues.length >= 20 ? percentile(lowCtrValues, 0.1) : null,
    accountCpaP50:
      purchase && cpaValues.length >= 20 ? percentile(cpaValues, 0.5) : null,
    accountCpaSampleCount: purchase ? cpaValues.length : 0,
    metaAttributedAovMean90d:
      purchase && purchaseCount > 0 ? purchaseRevenue / purchaseCount : null,
    metaAttributedAovPurchaseCount90d: purchase ? purchaseCount : 0,
    metaAttributedRevenue90d: purchase ? purchaseRevenue : 0,
    matureSpendP50: purchase
      ? percentile(
          converterPopulation.map((row) => row.totalSpend),
          0.5,
        )
      : null,
    matureSpendP75: purchase
      ? percentile(
          converterPopulation.map((row) => row.totalSpend),
          0.75,
        )
      : null,
    winnerSpendP25: purchase
      ? percentile(
          winnerPopulation.map((row) => row.totalSpend),
          0.25,
        )
      : null,
    winnerSpendP50: purchase
      ? percentile(
          winnerPopulation.map((row) => row.totalSpend),
          0.5,
        )
      : null,
    winnerPurchaseP50: purchase
      ? percentile(
          winnerPopulation.map((row) => row.totalConversions),
          0.5,
        )
      : null,
    roasRatioP10:
      purchase && roasRatios.length >= NATIVE_AD_FUNNEL_METRIC_SAMPLE_FLOOR
        ? percentile(roasRatios, 0.1)
        : null,
    roasRatioP25:
      purchase && roasRatios.length >= NATIVE_AD_FUNNEL_METRIC_SAMPLE_FLOOR
        ? percentile(roasRatios, 0.25)
        : null,
    roasRatioP50:
      purchase && roasRatios.length >= NATIVE_AD_FUNNEL_METRIC_SAMPLE_FLOOR
        ? percentile(roasRatios, 0.5)
        : null,
    roasRatioP75:
      purchase && roasRatios.length >= NATIVE_AD_FUNNEL_METRIC_SAMPLE_FLOOR
        ? percentile(roasRatios, 0.75)
        : null,
    metaAovQuality,
  };
  const actionReadiness = resolveNativeAdCalibrationActionReadiness({
    key,
    matureAdCount: converterPopulation.length,
    metricSampleCounts,
    targetAuthority: batch.targetAuthority,
    accountCalibration,
    spendUnitAuthority: batch.spendUnitAuthority,
  });
  const sourceMinDate = minText(observations.map((row) => row.sourceMinDate));
  const sourceMaxDate = maxText(observations.map((row) => row.sourceMaxDate));
  const sourceMaxUpdatedAt = maxText(
    observations.map((row) => row.sourceMaxUpdatedAt),
  );
  const sourceDayCount = sum(observations, (row) => row.sourceDayCount);
  const qualityStatus = resolveCellQualityStatus({
    cohort: key.cohort,
    matureAdCount: converterPopulation.length,
    targetAuthority: batch.targetAuthority,
  });
  const cellWithoutInputManifest: NativeAdCalibrationCellInputManifestSource = {
    // A cell being MINTED carries the version being minted, by construction.
    contractVersion: NATIVE_AD_CALIBRATION_CONTRACT_VERSION,
    batchId: null,
    batchCompleteness: "computed",
    batchCellCount: 0,
    batchCellSetHash: "0".repeat(64),
    key,
    asOfDate: batch.asOfDate,
    asOfCutoff: batch.asOfCutoff,
    sampleWindowStart: batch.sampleWindowStart,
    sampleWindowEnd: batch.sampleWindowEnd,
    sampleWindowDays: batch.sampleWindowDays,
    computedAt: batch.computedAt,
    engineVersion: batch.engineVersion,
    policyVersion: batch.policyVersion,
    qualityStatus,
    sourceAdCount: observations.length,
    sourceDayCount,
    eligibleAdCount: observations.length,
    matureAdCount: converterPopulation.length,
    zeroConversionAdCount: observations.filter(
      (row) => row.totalConversions === 0,
    ).length,
    metricSampleCounts,
    actionReadiness,
    sourceMinDate,
    sourceMaxDate,
    sourceMaxUpdatedAt,
    targetAuthority: batch.targetAuthority,
    accountCalibration,
    funnelCalibration,
    batchInputManifestHash: batch.inputManifestHash,
    sourceManifestHash: batch.sourceManifestHash,
    qualityCounts: batch.qualityCounts,
  };
  return {
    ...cellWithoutInputManifest,
    inputManifestHash: canonicalSha256(
      nativeAdCalibrationCellInputManifestContent(cellWithoutInputManifest),
    ),
  };
}

function buildFunnelCalibration(
  observations: NativeAdCalibrationObservation[],
): AccountFunnelCalibration {
  const sampleSize = observations.filter((row) =>
    [
      row.ctrRate,
      row.cpm,
      row.thumbstopRate,
      row.linkToLpvRate,
      row.linkToAtcRate,
      row.lpvToAtcRate,
      row.atcToIcRate,
      row.icToPurchaseRate,
      row.clickToPurchaseRate,
    ].some(isFiniteNumber),
  ).length;
  const baseline: FormatFunnelBaseline = {
    creativeFormat: "overall",
    ctrP25: gatedPercentile(observations, "ctrRate", 0.25),
    ctrP50: gatedPercentile(observations, "ctrRate", 0.5),
    cpmP50: gatedPercentile(observations, "cpm", 0.5),
    cpmP75: gatedPercentile(observations, "cpm", 0.75),
    thumbstopP25: gatedPercentile(observations, "thumbstopRate", 0.25),
    thumbstopP50: gatedPercentile(observations, "thumbstopRate", 0.5),
    linkToLpvP25: gatedPercentile(observations, "linkToLpvRate", 0.25),
    linkToLpvP50: gatedPercentile(observations, "linkToLpvRate", 0.5),
    linkToAtcP25: gatedPercentile(observations, "linkToAtcRate", 0.25),
    linkToAtcP50: gatedPercentile(observations, "linkToAtcRate", 0.5),
    lpvToAtcP25: gatedPercentile(observations, "lpvToAtcRate", 0.25),
    lpvToAtcP50: gatedPercentile(observations, "lpvToAtcRate", 0.5),
    atcToIcP25: gatedPercentile(observations, "atcToIcRate", 0.25),
    atcToIcP50: gatedPercentile(observations, "atcToIcRate", 0.5),
    icToPurchaseP25: gatedPercentile(observations, "icToPurchaseRate", 0.25),
    icToPurchaseP50: gatedPercentile(observations, "icToPurchaseRate", 0.5),
    clickToPurchaseP25: gatedPercentile(
      observations,
      "clickToPurchaseRate",
      0.25,
    ),
    clickToPurchaseP50: gatedPercentile(
      observations,
      "clickToPurchaseRate",
      0.5,
    ),
    sampleSize,
    qualityStatus:
      sampleSize >= 30
        ? "ready"
        : sampleSize >= 10
          ? "low_sample"
          : "insufficient",
  };
  return { byFormat: { overall: baseline } };
}

function buildMetricSampleCounts(input: {
  observations: NativeAdCalibrationObservation[];
  roasValues: number[];
  roasRatios: number[];
  cpaValues: number[];
  winnerPopulation: NativeAdCalibrationObservation[];
  refreshRatios: number[];
}): NativeAdCalibrationMetricSampleCounts {
  return {
    roas: input.roasValues.length,
    roasRatio: input.roasRatios.length,
    cpa: input.cpaValues.length,
    winner: input.winnerPopulation.length,
    refreshRatio: input.refreshRatios.length,
    lowCtr: metricCount(input.observations, "cumulative28dCtr"),
    ctr: metricCount(input.observations, "ctrRate"),
    cpm: metricCount(input.observations, "cpm"),
    thumbstop: metricCount(input.observations, "thumbstopRate"),
    linkToLpv: metricCount(input.observations, "linkToLpvRate"),
    linkToAtc: metricCount(input.observations, "linkToAtcRate"),
    lpvToAtc: metricCount(input.observations, "lpvToAtcRate"),
    atcToIc: metricCount(input.observations, "atcToIcRate"),
    icToPurchase: metricCount(input.observations, "icToPurchaseRate"),
    clickToPurchase: metricCount(input.observations, "clickToPurchaseRate"),
  };
}

function aggregateObservation(input: {
  rows: NormalizedSourceRow[];
  sourceRowIds: string[];
  context: ExactContext;
  sampleWindowEnd: string;
}): NativeAdCalibrationObservation {
  const first = input.rows[0];
  if (!first) throw new Error("Cannot aggregate an empty ad-day set.");
  const cumulative28Start = addUtcDays(input.sampleWindowEnd, -27);
  const recent7Start = addUtcDays(input.sampleWindowEnd, -6);
  const cumulative28Rows = input.rows.filter(
    (row) => row.date >= cumulative28Start,
  );
  const recent7Rows = input.rows.filter((row) => row.date >= recent7Start);
  const totalSpend = sum(input.rows, (row) => row.spend);
  const totalConversions = sum(input.rows, (row) => row.conversions);
  const totalRevenue = sum(input.rows, (row) => row.revenue);
  const totalImpressions = sum(input.rows, (row) => row.impressions);
  const totalClicks = sum(input.rows, (row) => row.clicks);
  /*
    COMPLETE-ONLY, like the other optional provider metrics beside it. `sum`
    would have added the coerced zeros; `sumOptionalComplete` answers null the
    moment any contributing row is unreported, so a link-click rate is either
    measured across the whole population or absent.
  */
  const totalLinkClicks = sumOptionalComplete(input.rows, (row) => row.linkClicks);
  const totalLandingPageViews = sumOptionalComplete(
    input.rows,
    (row) => row.landingPageViews,
  );
  const totalAddToCart = sumOptionalComplete(
    input.rows,
    (row) => row.addToCart,
  );
  const totalInitiateCheckout = sumOptionalComplete(
    input.rows,
    (row) => row.initiateCheckout,
  );
  const cumulative28Spend = sum(cumulative28Rows, (row) => row.spend);
  const cumulative28Revenue = sum(cumulative28Rows, (row) => row.revenue);
  const cumulative28Impressions = sum(
    cumulative28Rows,
    (row) => row.impressions,
  );
  const cumulative28Clicks = sum(cumulative28Rows, (row) => row.clicks);
  const recent7Spend = sum(recent7Rows, (row) => row.spend);
  const recent7Revenue = sum(recent7Rows, (row) => row.revenue);
  const cumulative28dRoas = ratio(cumulative28Revenue, cumulative28Spend);
  const recent7dRoas = ratio(recent7Revenue, recent7Spend);
  const thumbstopWeighted = input.rows.every((row) => row.thumbstop != null)
    ? sum(input.rows, (row) => (row.thumbstop as number) * row.impressions)
    : null;

  return {
    businessId: first.businessId,
    providerAccountRefId: first.providerAccountRefId,
    providerAccountId: first.providerAccountId,
    adId: first.adId,
    accountTimezone: input.context.accountTimezone,
    accountCurrency: input.context.accountCurrency,
    campaignId: input.context.campaignId,
    adsetId: input.context.adsetId,
    objective: input.context.objective,
    optimizationGoal: input.context.optimizationGoal,
    customEventType: input.context.customEventType,
    cohort: input.context.cohort,
    sourceRowIds: input.sourceRowIds,
    sourceDayCount: input.rows.length,
    sourceMinDate: input.rows[0]?.date ?? input.sampleWindowEnd,
    sourceMaxDate:
      input.rows[input.rows.length - 1]?.date ?? input.sampleWindowEnd,
    sourceMaxUpdatedAt:
      maxText(input.rows.map((row) => row.updatedAt)) ?? first.updatedAt,
    totalSpend,
    totalConversions,
    totalRevenue,
    totalImpressions,
    totalClicks,
    totalLinkClicks,
    totalLandingPageViews,
    totalAddToCart,
    totalInitiateCheckout,
    aggregateRoas: ratio(totalRevenue, totalSpend),
    aggregateCpa: ratio(totalSpend, totalConversions),
    ctrRate:
      totalImpressions > 0 ? (totalClicks / totalImpressions) * 100 : null,
    cpm: totalImpressions > 0 ? (totalSpend / totalImpressions) * 1000 : null,
    thumbstopRate:
      totalImpressions > 0 && thumbstopWeighted !== null
        ? thumbstopWeighted / totalImpressions
        : null,
    /*
      Every link-click rate now requires COMPLETE link-click evidence. A null
      total means at least one contributing row was unreported, and a rate
      computed over part of a population is not that population's rate.
    */
    linkToLpvRate:
      totalLinkClicks !== null &&
      totalLinkClicks > 0 &&
      totalLandingPageViews !== null
        ? (totalLandingPageViews / totalLinkClicks) * 100
        : null,
    linkToAtcRate:
      totalLinkClicks !== null && totalLinkClicks > 0 && totalAddToCart !== null
        ? (totalAddToCart / totalLinkClicks) * 100
        : null,
    lpvToAtcRate:
      totalLandingPageViews !== null &&
      totalLandingPageViews > 0 &&
      totalAddToCart !== null
        ? (totalAddToCart / totalLandingPageViews) * 100
        : null,
    atcToIcRate:
      totalAddToCart !== null &&
      totalAddToCart > 0 &&
      totalInitiateCheckout !== null
        ? (totalInitiateCheckout / totalAddToCart) * 100
        : null,
    icToPurchaseRate:
      totalInitiateCheckout !== null && totalInitiateCheckout > 0
        ? (totalConversions / totalInitiateCheckout) * 100
        : null,
    clickToPurchaseRate:
      totalLinkClicks !== null && totalLinkClicks > 0
        ? (totalConversions / totalLinkClicks) * 100
        : null,
    cumulative28dRoas,
    cumulative28dCtr:
      cumulative28Impressions > 0
        ? (cumulative28Clicks / cumulative28Impressions) * 100
        : null,
    recent7dRoas,
    recentTotalRatio:
      positiveFinite(recent7dRoas) && positiveFinite(cumulative28dRoas)
        ? recent7dRoas / cumulative28dRoas
        : null,
  };
}

interface ExactContext {
  accountTimezone: string;
  accountCurrency: string;
  campaignId: string;
  adsetId: string;
  objective: string;
  optimizationGoal: string | null;
  customEventType: string | null;
  optimizationContext: string;
  cohort: MetaFunnelCohort;
}

function normalizedExactContext(row: NormalizedSourceRow): ExactContext | null {
  if (
    !row.accountTimezone ||
    !row.accountCurrency ||
    !row.campaignId ||
    !row.adsetId ||
    !row.objective ||
    (!row.optimizationGoal && !row.customEventType)
  ) {
    return null;
  }
  const cohort = resolveMetaFunnelCohort({
    objective: row.objective,
    optimizationGoal: row.optimizationGoal,
    customEventType: row.customEventType,
  });
  const optimizationContext = buildNativeAdOptimizationContext(
    row.optimizationGoal,
    row.customEventType,
  );
  if (optimizationContext === null) return null;
  return {
    accountTimezone: row.accountTimezone,
    accountCurrency: row.accountCurrency,
    campaignId: row.campaignId,
    adsetId: row.adsetId,
    objective: row.objective,
    optimizationGoal: row.optimizationGoal,
    customEventType: row.customEventType,
    optimizationContext,
    cohort,
  };
}

export function buildNativeAdOptimizationContext(
  optimizationGoal: string | null | undefined,
  customEventType: string | null | undefined,
): string | null {
  const goal = normalizeGoal(optimizationGoal);
  const event = normalizeGoal(customEventType);
  if (!goal && !event) return null;
  return `goal=${goal ?? ""}|event=${event ?? ""}`;
}

function contextCardinality(contexts: ExactContext[]) {
  const cardinality = {
    timezone: distinctCount(contexts.map((row) => row.accountTimezone)),
    currency: distinctCount(contexts.map((row) => row.accountCurrency)),
    campaign: distinctCount(contexts.map((row) => row.campaignId)),
    adset: distinctCount(contexts.map((row) => row.adsetId)),
    objective: distinctCount(contexts.map((row) => row.objective)),
    optimizationContext: distinctCount(
      contexts.map((row) => row.optimizationContext),
    ),
    cohort: distinctCount(contexts.map((row) => row.cohort)),
  };
  return {
    ...cardinality,
    mixed: Object.values(cardinality).some((count) => count !== 1),
  };
}

function normalizeSourceRow(
  row: NativeAdCalibrationSourceRow,
): NormalizedSourceRow {
  if (
    !Number.isInteger(row.metricSchemaVersion) ||
    row.metricSchemaVersion < 1
  ) {
    throw new TypeError("metricSchemaVersion must be a positive integer.");
  }
  return {
    ...row,
    sourceRowId: normalizeText(row.sourceRowId) ?? "",
    businessId: normalizeText(row.businessId) ?? "",
    providerAccountRefId: normalizeText(row.providerAccountRefId) ?? "",
    providerAccountId: normalizeText(row.providerAccountId) ?? "",
    date: normalizeDate(row.date) ?? "",
    campaignId: normalizeText(row.campaignId),
    adsetId: normalizeText(row.adsetId),
    adId: normalizeText(row.adId) ?? "",
    accountTimezone: normalizeText(row.accountTimezone),
    accountCurrency: normalizeGoal(row.accountCurrency),
    sourceAccountTimezone: normalizeText(row.sourceAccountTimezone),
    sourceAccountCurrency: normalizeGoal(row.sourceAccountCurrency),
    metricSchemaVersion: row.metricSchemaVersion,
    objective: normalizeGoal(row.objective),
    optimizationGoal: normalizeGoal(row.optimizationGoal),
    customEventType: normalizeGoal(row.customEventType),
    truthState: normalizeGoal(row.truthState),
    validationStatus: normalizeGoal(row.validationStatus),
    finalizedAt: normalizeTimestamp(row.finalizedAt),
    createdAt: normalizeTimestamp(row.createdAt) ?? "",
    updatedAt: normalizeTimestamp(row.updatedAt) ?? "",
    campaignSourceRowId: normalizeText(row.campaignSourceRowId),
    campaignTruthState: normalizeGoal(row.campaignTruthState),
    campaignValidationStatus: normalizeGoal(row.campaignValidationStatus),
    campaignCreatedAt: normalizeTimestamp(row.campaignCreatedAt),
    campaignUpdatedAt: normalizeTimestamp(row.campaignUpdatedAt),
    adsetSourceRowId: normalizeText(row.adsetSourceRowId),
    adsetTruthState: normalizeGoal(row.adsetTruthState),
    adsetValidationStatus: normalizeGoal(row.adsetValidationStatus),
    adsetCreatedAt: normalizeTimestamp(row.adsetCreatedAt),
    adsetUpdatedAt: normalizeTimestamp(row.adsetUpdatedAt),
  };
}

function hasFinalizedTruth(row: NormalizedSourceRow) {
  return (
    row.truthState === "FINALIZED" &&
    row.validationStatus === "PASSED" &&
    row.campaignSourceRowId !== null &&
    row.campaignTruthState === "FINALIZED" &&
    row.campaignValidationStatus === "PASSED" &&
    row.adsetSourceRowId !== null &&
    row.adsetTruthState === "FINALIZED" &&
    row.adsetValidationStatus === "PASSED"
  );
}

function hasFinalizedAdFact(row: NormalizedSourceRow) {
  return (
    row.truthState === "FINALIZED" &&
    row.validationStatus === "PASSED" &&
    row.finalizedAt !== null
  );
}

function isAdFactAvailableAtCutoff(
  row: NormalizedSourceRow,
  asOfCutoff: string,
) {
  const cutoffMs = requireTimestamp(asOfCutoff, "asOfCutoff");
  return [row.createdAt, row.updatedAt, row.finalizedAt].every((timestamp) => {
    const parsed = timestampOrNull(timestamp);
    return parsed !== null && parsed <= cutoffMs;
  });
}

function isRowAvailableAtCutoff(row: NormalizedSourceRow, asOfCutoff: string) {
  const cutoffMs = requireTimestamp(asOfCutoff, "asOfCutoff");
  const timestamps = [
    row.createdAt,
    row.updatedAt,
    row.campaignCreatedAt,
    row.campaignUpdatedAt,
    row.adsetCreatedAt,
    row.adsetUpdatedAt,
  ];
  if (row.finalizedAt !== null) timestamps.push(row.finalizedAt);
  return timestamps.every((timestamp) => {
    const parsed = timestampOrNull(timestamp);
    return parsed !== null && parsed <= cutoffMs;
  });
}

function hasInvalidMetric(row: NormalizedSourceRow) {
  const required = [
    row.spend,
    row.impressions,
    row.clicks,
    row.conversions,
    row.revenue,
  ];
  const optional = [
    // Nullable now: an unreported link-click day is incomplete evidence, not
    // an invalid row.
    row.linkClicks,
    row.landingPageViews,
    row.addToCart,
    row.initiateCheckout,
    row.thumbstop,
  ];
  return (
    required.some((value) => !Number.isFinite(value) || value < 0) ||
    !Number.isInteger(row.conversions) ||
    (row.conversions > 0 && row.revenue <= 0) ||
    (row.revenue > 0 && row.conversions <= 0) ||
    optional.some(
      (value) => value != null && (!Number.isFinite(value) || value < 0),
    )
  );
}

function sourceContentSignature(row: NormalizedSourceRow) {
  return canonicalSha256({
    businessId: row.businessId,
    providerAccountRefId: row.providerAccountRefId,
    providerAccountId: row.providerAccountId,
    date: row.date,
    campaignId: row.campaignId,
    adsetId: row.adsetId,
    adId: row.adId,
    accountTimezone: row.accountTimezone,
    accountCurrency: row.accountCurrency,
    sourceAccountTimezone: row.sourceAccountTimezone,
    sourceAccountCurrency: row.sourceAccountCurrency,
    metricSchemaVersion: row.metricSchemaVersion,
    objective: row.objective,
    optimizationGoal: row.optimizationGoal,
    customEventType: row.customEventType,
    spend: manifestNumber(row.spend),
    impressions: manifestNumber(row.impressions),
    clicks: manifestNumber(row.clicks),
    linkClicks: manifestNumber(row.linkClicks),
    conversions: manifestNumber(row.conversions),
    revenue: manifestNumber(row.revenue),
    landingPageViews: manifestNumber(row.landingPageViews ?? null),
    addToCart: manifestNumber(row.addToCart ?? null),
    initiateCheckout: manifestNumber(row.initiateCheckout ?? null),
    thumbstop: manifestNumber(row.thumbstop ?? null),
  });
}

function accountAovFactSignature(row: NormalizedSourceRow) {
  return canonicalSha256({
    sourceContentHash: sourceContentSignature(row),
    truthState: row.truthState,
    validationStatus: row.validationStatus,
  });
}

function sourceManifestEntry(row: NormalizedSourceRow) {
  const sortKey = [
    row.businessId,
    row.providerAccountRefId,
    row.providerAccountId,
    row.adId,
    row.date,
    row.sourceRowId,
  ].join("\u0000");
  return {
    sortKey,
    sourceRowId: row.sourceRowId,
    businessId: row.businessId,
    providerAccountRefId: row.providerAccountRefId,
    providerAccountId: row.providerAccountId,
    adId: row.adId,
    date: row.date,
    sourceAccountTimezone: row.sourceAccountTimezone,
    accountCurrency: row.accountCurrency,
    sourceAccountCurrency: row.sourceAccountCurrency,
    metricSchemaVersion: row.metricSchemaVersion,
    campaignSourceRowId: row.campaignSourceRowId,
    adsetSourceRowId: row.adsetSourceRowId,
    truthState: row.truthState,
    validationStatus: row.validationStatus,
    finalizedAt: row.finalizedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    campaignTruthState: row.campaignTruthState,
    campaignValidationStatus: row.campaignValidationStatus,
    campaignCreatedAt: row.campaignCreatedAt,
    campaignUpdatedAt: row.campaignUpdatedAt,
    adsetTruthState: row.adsetTruthState,
    adsetValidationStatus: row.adsetValidationStatus,
    adsetCreatedAt: row.adsetCreatedAt,
    adsetUpdatedAt: row.adsetUpdatedAt,
    contentHash: sourceContentSignature(row),
  };
}

function observationManifestEntry(row: NativeAdCalibrationObservation) {
  return {
    businessId: row.businessId,
    providerAccountRefId: row.providerAccountRefId,
    providerAccountId: row.providerAccountId,
    adId: row.adId,
    accountTimezone: row.accountTimezone,
    accountCurrency: row.accountCurrency,
    campaignId: row.campaignId,
    adsetId: row.adsetId,
    objective: row.objective,
    optimizationGoal: row.optimizationGoal,
    customEventType: row.customEventType,
    cohort: row.cohort,
    sourceRowIds: row.sourceRowIds,
    sourceDayCount: row.sourceDayCount,
    sourceMinDate: row.sourceMinDate,
    sourceMaxDate: row.sourceMaxDate,
    totalSpend: row.totalSpend,
    totalConversions: row.totalConversions,
    totalRevenue: row.totalRevenue,
    totalImpressions: row.totalImpressions,
    totalClicks: row.totalClicks,
    totalLinkClicks: row.totalLinkClicks,
    totalLandingPageViews: row.totalLandingPageViews,
    totalAddToCart: row.totalAddToCart,
    totalInitiateCheckout: row.totalInitiateCheckout,
    aggregateRoas: row.aggregateRoas,
    aggregateCpa: row.aggregateCpa,
    ctrRate: row.ctrRate,
    cpm: row.cpm,
    thumbstopRate: row.thumbstopRate,
    linkToLpvRate: row.linkToLpvRate,
    linkToAtcRate: row.linkToAtcRate,
    lpvToAtcRate: row.lpvToAtcRate,
    atcToIcRate: row.atcToIcRate,
    icToPurchaseRate: row.icToPurchaseRate,
    clickToPurchaseRate: row.clickToPurchaseRate,
    cumulative28dRoas: row.cumulative28dRoas,
    cumulative28dCtr: row.cumulative28dCtr,
    recent7dRoas: row.recent7dRoas,
    recentTotalRatio: row.recentTotalRatio,
  };
}

function normalizeTargetAuthorityInput(
  input: NativeAdTargetAuthorityInput | null,
): NativeAdTargetAuthorityInput | null {
  if (input === null) return null;
  return {
    sourceRowId: normalizeText(input.sourceRowId),
    operation: input.operation,
    targetCpa: finiteOrNull(input.targetCpa),
    targetRoas: finiteOrNull(input.targetRoas),
    breakEvenCpa: finiteOrNull(input.breakEvenCpa),
    breakEvenRoas: finiteOrNull(input.breakEvenRoas),
    operatorAovAssumption: finiteOrNull(input.operatorAovAssumption),
    defaultRiskPosture: input.defaultRiskPosture,
    /*
      STRICT, not `normalizeTimestamp`. These two are commercial-target clocks
      whose verdict is hashed; `normalizeTimestamp` would rewrite an impossible
      or date-only value into a well-formed instant and put THAT in the payload,
      so the object a hash is taken over would disagree with the strict reading
      the resolver just made about the same bytes. A value the strict parser
      refuses is an ABSENT clock here, which is what `cutoffSafe` already knows
      how to fail closed on.
    */
    effectiveAt: strictCommercialClock(input.effectiveAt),
    recordedAt: strictCommercialClock(input.recordedAt),
  };
}

/** One commercial-target clock, or null when it is not a real UTC instant. */
function strictCommercialClock(value: string | null | undefined): string | null {
  return commercialTargetInstantMs(value) === null
    ? null
    : normalizeText(value);
}

function resolveCellQualityStatus(input: {
  cohort: MetaFunnelCohort;
  matureAdCount: number;
  targetAuthority: ResolvedNativeAdTargetAuthority;
}): NativeAdCalibrationQualityStatus {
  if (input.cohort !== "purchase") return "unsupported_cohort";
  if (!hasCommercialTargetAuthority(input.targetAuthority)) {
    return "blocked_commercial";
  }
  if (input.matureAdCount >= MIN_ACCOUNT_SCALE_CALIBRATION_SAMPLE) {
    return "ready";
  }
  if (input.matureAdCount >= 10) return "low_sample";
  return "insufficient";
}

export function resolveNativeAdCalibrationActionReadiness(input: {
  key: NativeAdCalibrationCellKey;
  matureAdCount: number;
  metricSampleCounts: NativeAdCalibrationMetricSampleCounts;
  targetAuthority: ResolvedNativeAdTargetAuthority;
  accountCalibration: AccountCalibration;
  spendUnitAuthority: NativeAdSpendUnitAuthority;
}): NativeAdCalibrationActionReadiness {
  const scaleObserved = Math.min(
    input.matureAdCount,
    input.metricSampleCounts.roasRatio,
  );
  const cutObserved = input.metricSampleCounts.roasRatio;
  const refreshObserved = input.metricSampleCounts.refreshRatio;

  if (input.key.cellScope === "account_objective_cohort") {
    return blockedActionReadiness(
      "pooled_optimization_context_soft_only",
      {
        scale: scaleObserved,
        cut: cutObserved,
        refresh: refreshObserved,
      },
      input.spendUnitAuthority,
    );
  }
  if (input.key.cohort !== "purchase") {
    return blockedActionReadiness(
      "unsupported_cohort",
      {
        scale: scaleObserved,
        cut: cutObserved,
        refresh: refreshObserved,
      },
      input.spendUnitAuthority,
    );
  }

  /*
    ── ROUND 9 ITEM 3: THE HOLD IS TOTAL ACROSS ALL THREE ACTIONS ────────────

    Round 8 closed CUT when a Target ROAS governs and no READY same-account,
    same-cutoff Meta AOV exists, and left SCALE and REFRESH open. That is the
    same defect one action to the left: all three are purchase-budget
    authorities on this cell, all three are persisted in `actionReadiness`, and
    all three are read back by the retained profile as grants.

      - Scale sizes a budget INCREASE. Without the canonical unit there is no
        admissible arithmetic for how much, and its own gate only asked about
        the account's calibration sample and a winner benchmark — neither of
        which is a money-per-purchase unit.
      - Refresh authorizes spend to continue against a creative-fatigue
        boundary. Its gate asked only about `refreshRatioP10`, a ratio of
        ratios, so a governed account with no economic unit could still be
        told to keep spending on evidence that never priced a purchase.

    `commercialSpendUnitHold` is computed once and applied to all three, so the
    three cannot drift apart again. The reason is the existing named blocker,
    because the missing thing is unchanged.

    Preserved exactly: with no positive Target ROAS none of this applies and
    each action keeps its own historical gate.
  */
  const cutTargetRoasGoverns = input.targetAuthority.targetRoasAuthority;
  const cutHasReadySpendUnit = input.spendUnitAuthority.status === "ready";
  const commercialSpendUnitHold = cutTargetRoasGoverns && !cutHasReadySpendUnit;

  const scaleReason: NativeAdCalibrationActionBlockReason | null = !input
    .targetAuthority.targetRoasAuthority
    ? "target_roas_authority_missing"
    : commercialSpendUnitHold
      ? "commercial_spend_unit_authority_missing"
      : scaleObserved < MIN_ACCOUNT_SCALE_CALIBRATION_SAMPLE
        ? "scale_calibration_sample_low"
        : !positiveFinite(input.accountCalibration.winnerPurchaseP50)
          ? "scale_winner_benchmark_missing"
          : null;
  const cutUsesCalibratedRelativeBoundary =
    cutObserved >= NATIVE_AD_FUNNEL_METRIC_SAMPLE_FLOOR &&
    positiveFinite(input.accountCalibration.roasRatioP25);
  /*
    THE ACCOUNT'S OWN CPA IS OBSERVED EVIDENCE, NOT ECONOMIC AUTHORITY, WHILE A
    TARGET ROAS GOVERNS.

    `cutHasCanonicalExactSpendAuthority` is a sample-backed account CPA median.
    It sat in an `||` with the READY spend-unit authority, so on an account
    whose Target ROAS says only ready Meta AOV may answer, a re-measured
    account CPA alone could open the economic stop-loss strip: it selected
    `calibrated_relative_with_economic_stop_loss` instead of
    `calibrated_relative`, which is a different boundary, a different verdict,
    and — because the readiness basis is part of the cell — a different
    generation and retention identity.

    Under a positive Target ROAS the economic authority is the READY spend unit
    and nothing else. The legacy branch is preserved exactly where it is
    legitimate: no positive Target ROAS, where the account CPA is a real
    money-per-purchase anchor because there is no ratio to divide.
  */
  const targetRoasGoverns = input.targetAuthority.targetRoasAuthority;
  const cutHasCanonicalExactSpendAuthority =
    !targetRoasGoverns &&
    input.accountCalibration.accountCpaSampleCount >=
      NATIVE_AD_FUNNEL_METRIC_SAMPLE_FLOOR &&
    positiveFinite(input.accountCalibration.accountCpaP50);
  const cutHasEconomicSpendAuthority =
    input.spendUnitAuthority.status === "ready" ||
    cutHasCanonicalExactSpendAuthority;
  // A sample-backed positive P25 is the retained D049 Cut authority and must
  // not depend on an account-wide AOV receipt. The economic spend authority is
  // additive there: when ready it opens D063's bounded expanded strip; when
  // blocked the legacy-safe relative region remains available. A P25-null cell
  // has no retained peer boundary and therefore still requires the commercial
  // stop-loss proof to become Cut-ready at all.
  /*
    `target_roas_authority_missing` is the named refusal for having NO
    commercial target at all. It keeps that spelling because Target ROAS is the
    one this product asks an operator to configure and the only one any native
    lane can consume; `break_even_roas_authority_missing` stays in the block
    reason union unused by new rows, because rows minted before this rule are
    persisted with it and must still parse.
  */
  /*
    ── THE HOLD IS TOTAL, NOT DOWNSTREAM ───────────────────────────────────────

    This read "no calibrated relative boundary AND no ready spend unit", so a
    P25-backed cell on a ROAS-governed account stayed `ready` with basis
    `calibrated_relative` even when the account had NO ready Meta-attributed
    AOV. The defence was that a later gate would refuse the action anyway. That
    is not the same fact:

      - `actionReadiness.cut.ready` is persisted on the calibration row and read
        back by the retained profile, so the row asserted an authority the
        account does not have, and asserted it in identity.
      - A ready cell with a null economic unit still selects a BOUNDARY (the
        account-relative P25), and a boundary is arithmetic. Under a positive
        Target ROAS the only admissible spend arithmetic is READY Meta AOV over
        that ratio; a peer-relative percentile is a different quantity.
      - "Ready, but something downstream will stop it" is exactly the shape that
        lets a refactor of the downstream gate silently authorize the action.

    So while a Target ROAS governs, a non-READY spend-unit authority blocks Cut
    readiness itself, whatever the P25 says. The named reason is unchanged
    (`commercial_spend_unit_authority_missing`), because the missing thing is
    unchanged — only the scope of what its absence stops.

    The legacy path is preserved exactly. Without a governing Target ROAS the
    condition is the one it has always been: a calibrated relative boundary is
    sufficient on its own, and only a cell that has neither boundary nor
    economic unit is refused.
  */
  const cutReason: NativeAdCalibrationActionBlockReason | null =
    !hasCommercialTargetAuthority(input.targetAuthority)
      ? "target_roas_authority_missing"
      : !cutHasReadySpendUnit &&
          (cutTargetRoasGoverns || !cutUsesCalibratedRelativeBoundary)
        ? "commercial_spend_unit_authority_missing"
        : null;
  const refreshReason: NativeAdCalibrationActionBlockReason | null =
    commercialSpendUnitHold
      ? "commercial_spend_unit_authority_missing"
      : refreshObserved < NATIVE_AD_FUNNEL_METRIC_SAMPLE_FLOOR ||
          !positiveFinite(input.accountCalibration.refreshRatioP10)
        ? "refresh_calibration_sample_low"
        : null;

  return {
    spendUnitAuthority: input.spendUnitAuthority,
    scale: actionReadinessEntry(
      scaleReason,
      scaleObserved,
      MIN_ACCOUNT_SCALE_CALIBRATION_SAMPLE,
    ),
    cut: actionReadinessEntry(
      cutReason,
      cutObserved,
      cutUsesCalibratedRelativeBoundary
        ? NATIVE_AD_FUNNEL_METRIC_SAMPLE_FLOOR
        : 0,
      /*
        `calibrated_relative` — a relative boundary with NO economic unit
        behind it — is now reachable only on the no-Target-ROAS legacy path,
        because the gate above refuses readiness outright in the governed case.
        The arm is kept rather than deleted: rows minted under `.v4` and
        earlier carry this basis and must keep parsing and rendering as the
        history they are.
      */
      cutReason === null
        ? cutUsesCalibratedRelativeBoundary
          ? cutHasEconomicSpendAuthority
            ? "calibrated_relative_with_economic_stop_loss"
            : "calibrated_relative"
          : "commercial_stop_loss"
        : null,
    ),
    refresh: actionReadinessEntry(
      refreshReason,
      refreshObserved,
      NATIVE_AD_FUNNEL_METRIC_SAMPLE_FLOOR,
    ),
  };
}

function blockedActionReadiness(
  reason: NativeAdCalibrationActionBlockReason,
  observed: Record<NativeAdCalibrationAction, number>,
  spendUnitAuthority: NativeAdSpendUnitAuthority,
): NativeAdCalibrationActionReadiness {
  return {
    spendUnitAuthority,
    scale: actionReadinessEntry(
      reason,
      observed.scale,
      MIN_ACCOUNT_SCALE_CALIBRATION_SAMPLE,
    ),
    cut: actionReadinessEntry(
      reason,
      observed.cut,
      NATIVE_AD_FUNNEL_METRIC_SAMPLE_FLOOR,
    ),
    refresh: actionReadinessEntry(
      reason,
      observed.refresh,
      NATIVE_AD_FUNNEL_METRIC_SAMPLE_FLOOR,
    ),
  };
}

function actionReadinessEntry(
  reason: NativeAdCalibrationActionBlockReason | null,
  observedSampleCount: number,
  requiredSampleCount: number,
  authorityBasis: NativeAdCalibrationActionAuthorityBasis | null = reason ===
  null
    ? "calibrated_relative"
    : null,
): NativeAdCalibrationActionReadinessEntry {
  return {
    ready: reason === null,
    reason,
    authorityBasis,
    observedSampleCount,
    requiredSampleCount,
  };
}

function addCellObservation(
  grouped: Map<
    string,
    { key: NativeAdCalibrationCellKey; rows: NativeAdCalibrationObservation[] }
  >,
  key: NativeAdCalibrationCellKey,
  observation: NativeAdCalibrationObservation,
) {
  const identity = cellIdentity(key);
  const entry = grouped.get(identity) ?? { key, rows: [] };
  entry.rows.push(observation);
  grouped.set(identity, entry);
}

function cellIdentity(key: NativeAdCalibrationCellKey) {
  return [
    key.businessId,
    key.providerAccountRefId,
    key.providerAccountId,
    key.accountTimezone,
    key.accountCurrency,
    key.cellScope,
    key.objective,
    key.cohort,
    key.optimizationContext,
  ].join("\u0000");
}

function observationIdentity(row: NativeAdCalibrationObservation) {
  return `${row.businessId}\u0000${row.providerAccountRefId}\u0000${row.providerAccountId}\u0000${row.adId}`;
}

function emptyQualityCounts(
  candidateSourceRowCount: number,
): NativeAdCalibrationQualityCounts {
  return {
    candidateSourceRowCount,
    cutoffSafeSourceRowCount: 0,
    candidateAdCount: 0,
    eligibleAdObservationCount: 0,
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
}

function gatedPercentile(
  rows: NativeAdCalibrationObservation[],
  key:
    | "ctrRate"
    | "cpm"
    | "thumbstopRate"
    | "linkToLpvRate"
    | "linkToAtcRate"
    | "lpvToAtcRate"
    | "atcToIcRate"
    | "icToPurchaseRate"
    | "clickToPurchaseRate",
  quantile: number,
) {
  const values = rows.map((row) => row[key]).filter(isFiniteNumber);
  return values.length >= NATIVE_AD_FUNNEL_METRIC_SAMPLE_FLOOR
    ? percentile(values, quantile)
    : null;
}

function metricCount(
  rows: NativeAdCalibrationObservation[],
  key:
    | "cumulative28dCtr"
    | "ctrRate"
    | "cpm"
    | "thumbstopRate"
    | "linkToLpvRate"
    | "linkToAtcRate"
    | "lpvToAtcRate"
    | "atcToIcRate"
    | "icToPurchaseRate"
    | "clickToPurchaseRate",
) {
  return rows.map((row) => row[key]).filter(isFiniteNumber).length;
}

function percentile(values: number[], quantile: number): number | null {
  const sorted = values
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0] ?? null;
  const position = (sorted.length - 1) * quantile;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const lower = sorted[lowerIndex];
  const upper = sorted[upperIndex];
  if (lower === undefined || upper === undefined) return null;
  if (lowerIndex === upperIndex) return lower;
  return lower + (upper - lower) * (position - lowerIndex);
}

function classifyMetaAovQuality(purchaseCount: number): MetaAovQuality {
  if (purchaseCount >= 20) return "ready";
  if (purchaseCount >= 5) return "low_sample";
  if (purchaseCount >= 1) return "unstable";
  return "unavailable";
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function sum<T>(rows: T[], value: (row: T) => number) {
  return rows.reduce((total, row) => total + value(row), 0);
}

function sumOptionalComplete<T>(
  rows: T[],
  value: (row: T) => number | null | undefined,
): number | null {
  const values = rows.map(value);
  if (
    values.some(
      (entry) =>
        entry === null || entry === undefined || !Number.isFinite(entry),
    )
  ) {
    return null;
  }
  let total = 0;
  for (const entry of values) total += entry as number;
  return total;
}

function groupBy<T>(rows: T[], key: (row: T) => string) {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const identity = key(row);
    const list = grouped.get(identity) ?? [];
    list.push(row);
    grouped.set(identity, list);
  }
  return grouped;
}

function distinctCount(values: string[]) {
  return new Set(values).size;
}

function positiveFinite(value: number | null): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isFiniteNumber(value: number | null): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function finiteOrNull(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function manifestNumber(value: number | null) {
  if (value === null) return null;
  if (Number.isNaN(value)) return "NaN";
  if (value === Number.POSITIVE_INFINITY) return "+Infinity";
  if (value === Number.NEGATIVE_INFINITY) return "-Infinity";
  return value;
}

function compareNamedSchemaDefinitions(input: {
  kind: "constraint" | "index" | "trigger";
  expected: Readonly<Record<string, string>>;
  actual: Record<string, unknown>[];
  missing: string[];
  mismatched: string[];
}) {
  const available = new Map(
    input.actual.map((row) => [
      dbRequiredText(row.name, `${input.kind}.name`),
      dbRequiredText(row.definition, `${input.kind}.definition`),
    ]),
  );
  for (const [name, expected] of Object.entries(input.expected)) {
    const actual = available.get(name);
    if (!actual) {
      input.missing.push(`${input.kind}:${name}`);
      continue;
    }
    if (
      normalizeSchemaDefinition(actual) !== normalizeSchemaDefinition(expected)
    ) {
      input.mismatched.push(`${input.kind}:${name}`);
    }
  }
}

function normalizeSchemaDefinition(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  return String(value)
    .toLowerCase()
    .replaceAll('"', "")
    .replace(/\bpublic\./g, "")
    .replace(/\busing btree\b/g, "")
    .replace(
      /::(?:text|date|double precision|timestamptz|timestamp with time zone|character varying)/g,
      "",
    )
    .replace(/\s*(->>|->)\s*/g, "$1")
    .replace(/[()]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s*,\s*/g, ",")
    .trim();
}

function requiredText(value: string, label: string) {
  const normalized = normalizeText(value);
  if (!normalized) throw new TypeError(`${label} is required.`);
  return normalized;
}

function normalizeText(value: string | null | undefined) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeGoal(value: string | null | undefined) {
  const text = normalizeText(value);
  return text ? text.replace(/[\s-]+/g, "_").toUpperCase() : null;
}

function normalizeDate(value: string | null | undefined) {
  const text = normalizeText(value);
  if (!text) return null;
  const match = /^\d{4}-\d{2}-\d{2}/.exec(text);
  if (!match) return null;
  const parsed = new Date(`${match[0]}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? null : match[0];
}

function normalizeTimestamp(value: string | null | undefined) {
  const text = normalizeText(value);
  if (!text) return null;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function normalizeRequiredTimestamp(value: string, label: string) {
  const normalized = normalizeTimestamp(value);
  if (!normalized) throw new TypeError(`${label} must be an ISO timestamp.`);
  return normalized;
}

function requireTimestamp(value: string, label: string) {
  const parsed = timestampOrNull(value);
  if (parsed === null)
    throw new TypeError(`${label} must be an ISO timestamp.`);
  return parsed;
}

function timestampOrNull(value: string | null) {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isDateOnly(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function addUtcDays(date: string, days: number) {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function minText(values: string[]) {
  return values.length > 0
    ? ([...values].sort((left, right) => left.localeCompare(right))[0] ?? null)
    : null;
}

function maxText(values: string[]) {
  return values.length > 0
    ? ([...values].sort((left, right) => right.localeCompare(left))[0] ?? null)
    : null;
}

export function mapNativeAdCalibrationSourceRow(
  row: Record<string, unknown>,
): NativeAdCalibrationSourceRow {
  return {
    sourceRowId: dbRequiredText(row.source_row_id, "source_row_id"),
    businessId: dbRequiredText(row.business_id, "business_id"),
    providerAccountRefId: requiredUuid(
      row.provider_account_ref_id,
      "provider_account_ref_id",
    ),
    providerAccountId: dbRequiredText(
      row.provider_account_id,
      "provider_account_id",
    ),
    date: dbRequiredDate(row.date, "date"),
    campaignId: dbOptionalText(row.campaign_id),
    adsetId: dbOptionalText(row.adset_id),
    adId: dbRequiredText(row.ad_id, "ad_id"),
    accountTimezone: dbOptionalText(row.account_timezone),
    accountCurrency: dbOptionalText(row.account_currency),
    sourceAccountTimezone: dbOptionalText(row.source_account_timezone),
    sourceAccountCurrency: dbOptionalText(row.source_account_currency),
    metricSchemaVersion: dbRequiredInteger(
      row.metric_schema_version,
      "metric_schema_version",
    ),
    objective: dbOptionalText(row.objective),
    optimizationGoal: dbOptionalText(row.optimization_goal),
    customEventType: dbOptionalText(row.custom_event_type),
    spend: dbRequiredNumber(row.spend, "spend"),
    impressions: dbRequiredNumber(row.impressions, "impressions"),
    clicks: dbRequiredNumber(row.clicks, "clicks"),
    // NULL-SAFETY ONLY. NOT a decision change.
    //
    // `meta_ad_daily.link_clicks` was `BIGINT NOT NULL DEFAULT 0`, and the only
    // production writer of it typed a literal `0` on the provider's behalf
    // because the sync holds no link-click value at all. Storage can now hold
    // NULL so that "nobody clicked" and "nothing was supplied" stop being the
    // same stored value. `dbRequiredNumber` THROWS on NULL, so leaving it here
    // would abort the whole native ad calibration job for any account carrying
    // an unsupplied ad-day.
    //
    // The engine saw 0 for these rows before and sees 0 for them now. Every row
    // that reaches this mapper today is non-null, so this coalesce is currently
    // unreachable and the job's output is byte-identical; once a row is stored
    // unsupplied it yields exactly the number that row yielded when the same
    // absence was stored as a fabricated 0. `linkClicks` stays `number`, so no
    // threshold, comparison, branch, label, confidence or authority gate
    // downstream sees a shape it did not see before.
    //
    // This is deliberately NOT the place to start supplying a real link-click
    // count from the provider payload: that would change the numbers the engine
    // reads, which is a different change with a different proof.
    /*
      NOT COERCED. This read `dbOptionalNumber(row.link_clicks) ?? 0`, which
      turned "the provider supplied nothing" into "the provider measured zero"
      — the exact collapse the nullable column was introduced to prevent. The
      rate below is now computed only from COMPLETE evidence, so an incomplete
      population yields no rate instead of a rate built on fabricated zeros.
    */
    linkClicks: dbOptionalNumber(row.link_clicks),
    // PostgreSQL double precision can represent NaN/Infinity. Keep malformed
    // canonical purchase truth in the source manifest so the account-AOV
    // receipt becomes contradictory instead of aborting the whole job before
    // a durable fail-closed proof is produced.
    conversions: dbRequiredManifestNumber(row.conversions, "conversions"),
    revenue: dbRequiredManifestNumber(row.revenue, "revenue"),
    landingPageViews: dbOptionalNumber(row.landing_page_views),
    addToCart: dbOptionalNumber(row.add_to_cart),
    initiateCheckout: dbOptionalNumber(row.initiate_checkout),
    thumbstop: dbOptionalNumber(row.thumbstop),
    truthState: dbOptionalText(row.truth_state),
    validationStatus: dbOptionalText(row.validation_status),
    finalizedAt: dbOptionalTimestamp(row.finalized_at),
    createdAt: dbRequiredTimestamp(row.created_at, "created_at"),
    updatedAt: dbRequiredTimestamp(row.updated_at, "updated_at"),
    campaignSourceRowId: dbOptionalText(row.campaign_source_row_id),
    campaignTruthState: dbOptionalText(row.campaign_truth_state),
    campaignValidationStatus: dbOptionalText(row.campaign_validation_status),
    campaignCreatedAt: dbOptionalTimestamp(row.campaign_created_at),
    campaignUpdatedAt: dbOptionalTimestamp(row.campaign_updated_at),
    adsetSourceRowId: dbOptionalText(row.adset_source_row_id),
    adsetTruthState: dbOptionalText(row.adset_truth_state),
    adsetValidationStatus: dbOptionalText(row.adset_validation_status),
    adsetCreatedAt: dbOptionalTimestamp(row.adset_created_at),
    adsetUpdatedAt: dbOptionalTimestamp(row.adset_updated_at),
  };
}

export function mapNativeAdTargetAuthorityRow(
  row: Record<string, unknown>,
): NativeAdTargetAuthorityInput {
  const operation = dbRequiredText(row.operation, "target operation");
  if (operation !== "upsert" && operation !== "delete") {
    throw new TypeError(`Unsupported native target operation: ${operation}`);
  }
  const risk = dbOptionalText(row.default_risk_posture);
  if (
    risk !== null &&
    risk !== "aggressive" &&
    risk !== "balanced" &&
    risk !== "conservative"
  ) {
    throw new TypeError(`Unsupported target risk posture: ${risk}`);
  }
  return {
    sourceRowId: dbOptionalText(row.source_row_id),
    operation,
    targetCpa: dbOptionalNumber(row.target_cpa),
    targetRoas: dbOptionalNumber(row.target_roas),
    breakEvenCpa: dbOptionalNumber(row.break_even_cpa),
    breakEvenRoas: dbOptionalNumber(row.break_even_roas),
    operatorAovAssumption: dbOptionalNumber(row.operator_aov_assumption),
    defaultRiskPosture: risk,
    effectiveAt: dbOptionalTimestamp(row.effective_at),
    recordedAt: dbOptionalTimestamp(row.recorded_at),
  };
}

function dbOptionalText(value: unknown): string | null {
  if (typeof value !== "string") return value == null ? null : String(value);
  const text = value.trim();
  return text || null;
}

function dbRequiredText(value: unknown, field: string): string {
  const text = dbOptionalText(value);
  if (!text) throw new TypeError(`${field} is required.`);
  return text;
}

function dbOptionalNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function dbRequiredNumber(value: unknown, field: string): number {
  const number = dbOptionalNumber(value);
  if (number === null) throw new TypeError(`${field} must be finite.`);
  return number;
}

function dbRequiredManifestNumber(value: unknown, field: string): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const normalized = value.trim();
    if (/^(?:NaN|[+-]?Infinity)$/i.test(normalized)) {
      return Number(normalized);
    }
  }
  return dbRequiredNumber(value, field);
}

function dbRequiredInteger(value: unknown, field: string): number {
  const number = dbRequiredNumber(value, field);
  if (!Number.isInteger(number)) {
    throw new TypeError(`${field} must be an integer.`);
  }
  return number;
}

function dbOptionalTimestamp(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function dbRequiredTimestamp(value: unknown, field: string): string {
  const timestamp = dbOptionalTimestamp(value);
  if (timestamp === null) throw new TypeError(`${field} must be a timestamp.`);
  return timestamp;
}

function dbRequiredDate(value: unknown, field: string): string {
  const text = dbOptionalText(value);
  const match = text?.match(/^\d{4}-\d{2}-\d{2}/);
  if (!match) throw new TypeError(`${field} must be an ISO date.`);
  return match[0];
}

function requiredInteger(value: unknown, field: string): number {
  const number = dbRequiredNumber(value, field);
  if (!Number.isInteger(number)) {
    throw new TypeError(`${field} must be an integer.`);
  }
  return number;
}

function requiredHash(value: unknown, field: string): string {
  const hash = dbRequiredText(value, field);
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    throw new TypeError(`${field} must be a lowercase SHA-256 hash.`);
  }
  return hash;
}

function requiredUuid(value: unknown, field: string): string {
  const id = dbRequiredText(value, field);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      id,
    )
  ) {
    throw new TypeError(`${field} must be a UUID.`);
  }
  return id;
}

function errorToJson(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error instanceof NativeAdCalibrationSchemaNotReadyError
        ? { missing: error.missing }
        : {}),
      ...(error instanceof NativeAdHistoricalCalibrationUnsafeError
        ? { code: error.code }
        : {}),
    };
  }
  return { name: "Error", message: String(error) };
}
