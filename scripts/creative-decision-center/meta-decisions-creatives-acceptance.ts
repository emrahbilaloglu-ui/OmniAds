/**
 * READ-ONLY acceptance harness for Meta Decisions -> Creatives.
 *
 * For each business named with --business (1..4, never "all"), and optionally
 * one --negative-control business, it runs four lanes, each in its OWN pinned
 * REPEATABLE READ READ ONLY transaction:
 *
 *   LEDGER            what the source data says over the window, through the
 *                     production SQL builders (missing vs measured zero,
 *                     restatements, config receipts, D101 coverage at the
 *                     production run slots, AOV, target, campaign role).
 *   DECISION          the CURRENT code's verdicts for the last --chain days,
 *                     chained through in-memory hysteresis priors, per account.
 *   PRESENTATION      the last simulated day projected through the production
 *                     read model, governance, briefing and OS presentation,
 *                     IN MEMORY, only when its hydration receipt passes the
 *                     production receipt gate.
 *   PERSISTED-SERVED  what HEAD would serve from the persisted generation today.
 *
 * It persists nothing, calls no provider (no Graph/Meta API, no media
 * backfill), and mints only visibly synthetic ids ("read-only-simulation:").
 *
 * Run from the repository root:
 *   TZ=UTC PGOPTIONS="-c default_transaction_read_only=on" npx tsx \
 *     scripts/creative-decision-center/meta-decisions-creatives-acceptance.ts \
 *     --business <uuid[,uuid...]> \
 *     [--negative-control <uuid> --negative-control-campaign <meta campaign id>] \
 *     [--window YYYY-MM-DD:YYYY-MM-DD] [--chain 2] [--ad-limits 60,300] \
 *     [--cutoff-slot end-of-day|natural-0305|natural-1505 | --cutoffs <iso,...>
 *      | --knowledge-cutoffs <iso,...>] \
 *     [--gate pre_deploy|post_deploy] [--require-clean] [--require-hard-authority] \
 *     [--skip-decisions] [--diagnostic] [--out <file outside the repo> --write 1]
 *
 * Verdicts are kept apart: INVARIANT VIOLATIONS (fail-open or fabrication) and
 * two RELEASE GATES computed from the same lanes, both always in the JSON:
 *   pre_deploy   HEAD's simulated days and presentations succeed for every
 *                --business AND each carries at least one real, source-backed
 *                decision into the inventory, the Briefing and the OS rows at
 *                the smallest --ad-limits value (never a hard or authorized
 *                action); the served path may still be on the deployed epoch
 *                (only native_latest_job_engine_mismatch, over a complete run).
 *   post_deploy  pre_deploy AND an available, non-degraded HEAD-epoch persisted
 *                generation for every selected account.
 * With --negative-control, both gates also require the control to be MET:
 * the campaign found with ledger rows in the window, no decision-authority
 * objective on the target days, and an unauthorized held/raw hard verdict
 * from real data. A control that merely ran is NOT MET.
 * Separately, hardAuthorityOutcome says whether any row carries a
 * SOURCE-AUTHORIZED hard action on an ACTIVE ad/ad set/campaign hierarchy at
 * the decision cutoff; stdout prints it beside the gate so a
 * presence PASS never reads as one. Only --require-hard-authority lets it
 * change the exit code. The report records git HEAD, the porcelain status and
 * the hashes of dirty loaded modules; --require-clean refuses a dirty tree.
 * Source gaps are observations; they can make a gate NOT MET, never pass it.
 * --knowledge-cutoffs is diagnostic-only: later knowledge bounds the ledger,
 * config and D101 readings. Native Ad calibration, decisions and presentation
 * retain the report-day UTC cutoff, because native calibration cannot be
 * re-dated to a later knowledge day. This mode never grants release success.
 *
 * Exit codes (ACCEPTANCE_CLAIMS.exitCodes), following --gate only (default
 * pre_deploy):
 *   0  release mode, the selected gate met, no violation
 *   1  invariant violation (either mode)
 *   2  usage error or read-only / UTC guard
 *   3  release mode, the selected gate NOT met, or the harness crashed
 *   4  diagnostic mode (--skip-decisions / --diagnostic) without a violation;
 *      a diagnostic run is never release success
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type {
  NativeAdAccountProfileDataSource,
  NativeAdCalibrationCellQuery,
} from "@/lib/creative-decision-engine/ad-account-decision-profile";
import { CAMPAIGN_CONTEXT_RESOLVER_VERSION } from "@/lib/creative-decision-engine/campaign-context/resolver";
import {
  campaignContextAuthorityResolverVersion,
  resolveCampaignContextMode,
  type CampaignContextPitExclusion,
} from "@/lib/creative-decision-engine/campaign-context/source";
import { WarehouseDataSource } from "@/lib/creative-decision-engine/data-source";
import {
  adDecisionStabilityKey,
  readPreviousPublishedAdLabels,
  type PreviousAdPublishedLabel,
  type PreviousLabelPitExclusion,
} from "@/lib/creative-decision-engine/decision-stability";
import type { AdCanonicalEvaluationProvenance } from "@/lib/creative-decision-engine/evaluation-store";
import {
  resolveEngineV3Flags,
  type EngineV3Flags,
} from "@/lib/creative-decision-engine/feature-flags";
import {
  LIST_NATIVE_AD_PROVIDER_BINDINGS_SQL,
  READ_NATIVE_AD_CALIBRATION_SOURCE_SQL,
  READ_NATIVE_AD_TARGET_AUTHORITY_FOR_ACCOUNT_SQL,
  computeNativeAdCalibrationBatch,
  mapNativeAdCalibrationSourceRow,
  mapNativeAdTargetAuthorityRow,
  type NativeAdCalibrationBatch,
  type NativeAdCalibrationCell,
  type NativeAdTargetAuthorityInput,
} from "@/lib/creative-decision-engine/jobs/ad-calibration-job";
import {
  AD_DECISIONS_JOB_NAME,
  assertEmptyNativeAdHydrationIsAuthoritative,
  buildNativeAdDataHealth,
  computeReadyNativeAdDecisions,
  computeSoftOnlyNativeAdDecisions,
  groupNativeProfileInputsByScope,
  mergeUniqueMap,
  readAdCampaignContext,
  readAdAdsetRoles,
  resolveNativeAdDecisionProfileGroups,
  resolveNativeAdFrequencyPressureThresholdsByAccount,
  toNativeSnapshotPayload,
  type AdDecisionComputation,
  type NativeAdDecisionProfileGroup,
  type NativeAdProfileRuntimeDataSource,
  type NativeSnapshotPayloadRow,
} from "@/lib/creative-decision-engine/jobs/ad-decisions-job";
import { computeMetaAttributedAov } from "@/lib/creative-decision-engine/meta-aov-calculator";
import { NATIVE_AD_ENGINE_VERSION } from "@/lib/creative-decision-engine/types";
import { getDb, runDbTransaction, type DbClient } from "@/lib/db";
import { readEffectiveMetaWriteGovernance } from "@/lib/meta/automation-control-plane";
import { isInBriefing } from "@/lib/meta/briefing-filter";
import {
  buildMetaAdsetConfigFieldSourceSql,
  buildMetaConfigFieldSourceSql,
} from "@/lib/meta/config-field-source-contract";
import type { MetaCanonicalDecision } from "@/lib/meta/decisions-workspace-contract";
import {
  buildMetaOsDecisionsPresentation,
  targetHardActionEligibilityFromAccountProfile,
} from "@/lib/meta/decisions-os-presentation";
import {
  NATIVE_DECISION_LAST_SUCCESS_MAX_AGE_DAYS,
  READ_NATIVE_DECISION_GENERATION_QUERY,
  applyMetaExecutionGovernanceToCanonicalDecisions,
  applyMetaExecutionGovernanceToReadModel,
  buildNativeMetaCanonicalDecisionInventory,
  buildNativeMetaDecisionsWorkspaceReadModel,
  readMetaDecisionCampaignContextRows,
  readMetaDecisionAdsetRoleRows,
  readMetaDecisionsWorkspaceReadModel,
  readValidatedMetaNativeDecisionGenerationBundle,
  validateMetaNativeDecisionGenerationBundle,
  type MetaDecisionExecutionGovernanceFacts,
  type MetaNativeDecisionSnapshotSourceRow,
} from "@/lib/meta/decisions-workspace-read-model";
import { buildMetaFunnelStageSql } from "@/lib/meta/funnel-stage-parse";
import { buildAdDayAuthoritativeLinkClicksSql } from "@/lib/meta/link-click-parse";
import { buildMetaAdDayProviderZeroReceiptSql } from "@/lib/meta/ad-day-provider-zero-receipt";
import { projectCanonicalNativeAdDecisionToBriefing } from "@/app/api/creatives/briefing/canonical-projection";
import { buildServedCreativeClassifications } from "@/components/creatives/creative-served-classification";
import { buildMetaDecisionCenterExactViewModel } from "@/components/meta/decision-center/meta-decision-center-exact-adapter";

import { configureOperationalScriptRuntime } from "../_operational-runtime";
import {
  COUNT_AD_DAYS_RESTATED_AFTER_CUTOFF_SQL,
  RESTATED_AFTER_CUTOFF_WINDOW_DAYS,
  buildSimulationEvaluation,
  describeSimulationPolicy,
  mergePriorLabelSources,
  toCarriedPriorLabels,
  verifySimulationHashIntegrity,
} from "./native-ad-current-code-historical-simulation";
import {
  ACCEPTANCE_CLAIMS,
  ACCEPTANCE_CONTRACT_VERSION,
  AcceptanceUsageError,
  D101_COVERAGE_AT_CUTOFFS_SQL,
  IDENTITY_AT_CUTOFF_SQL,
  NATIVE_AD_ACCOUNT_AOV_PURCHASE_SAMPLE_FLOOR,
  PRODUCTION_RUN_SLOTS,
  addUtcDays,
  auditPresentationMode,
  buildSimulatedGeneration,
  classifyConfigTier,
  classifyCoverage,
  classifyFunnelStageRow,
  classifyLinkClickRow,
  classifyPurchaseRow,
  countBy,
  coverageSlotParams,
  decideExitCode,
  describeBriefingVersusOs,
  describeHardAuthority,
  describeResolverArming,
  endOfUtcDayCutoff,
  enumerateUtcDays,
  evaluateAcceptanceInvariants,
  evaluateReceiptGate,
  evaluateReleaseGates,
  evaluateRuntimeGuard,
  diffProvenanceSnapshots,
  findLeakedCalibrationBatchIds,
  hardActionEligibilityOf,
  hydrationClaims,
  isHardRowEntry,
  locateHeldVerdicts,
  nativeAdDecisionDay,
  numericSign,
  parseAcceptanceArgs,
  parseGitPorcelainZ,
  productionRunSlotCutoffs,
  sha256Hex,
  simulatedCalibrationBatchId,
  simulatedJobRunId,
  summarizeAccountDecisions,
  summarizeHierarchyAtCutoff,
  summarizeProvenance,
  summarizeReport,
  tallyStates,
  toHardRowRecord,
  type AcceptanceArgs,
  type AcceptanceReport,
  type BusinessAcceptanceReport,
  type ConfigTierSummary,
  type CoverageSlotRecord,
  type DecisionAccountDayReport,
  type DecisionDayReport,
  type DecisionLaneReport,
  type EpisodeMark,
  type FunnelStageRowState,
  type IndependentReading,
  type InvariantFinding,
  type LaneFailure,
  type LedgerAccountReport,
  type LedgerLaneReport,
  type LinkClickRowState,
  type NegativeControlReport,
  type OsItemSource,
  type ProvenanceSnapshot,
  type PersistedServedAccountReport,
  type PersistedServedLaneReport,
  type PresentationAccountReport,
  type PresentationLaneReport,
  type PresentationModeReport,
  type PurchaseRowState,
  type ReleaseGatesReport,
  type SimulatedDecisionEntry,
  type SimulatedHydrationReceipt,
  type SimulatedIdentity,
  type SnapshotIdentity,
} from "./meta-decisions-creatives-acceptance-core";

type Row = Record<string, unknown>;

/** Long enough for Bilsem's chained decision lane (~270 s measured). */
const LANE_TIMEOUT_MS = 900_000;
const FUNNEL_STAGES = ["landing_page_view", "add_to_cart", "initiate_checkout"] as const;

class ReadOnlyGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReadOnlyGuardError";
  }
}

/* ================================================================ helpers */

function errorMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function text(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  const stringValue = String(value).trim();
  return stringValue === "" ? null : stringValue;
}

function num(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function isoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/** Reads a nested value from an object whose shape this file does not own. */
function pick(value: unknown, path: readonly string[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

async function assertTransactionAlive(db: DbClient, after: string, originalError?: unknown): Promise<void> {
  try {
    await db.query("SELECT 1 AS alive");
  } catch (error) {
    const original = originalError === undefined ? "" : `; original failure: ${errorMessage(originalError)}`;
    throw new Error(`transaction aborted after ${after}: ${errorMessage(error)}${original}`);
  }
}

/**
 * One pinned REPEATABLE READ READ ONLY transaction. `pinReadOnlySnapshot` is
 * the FIRST statement and proves the session default, the isolation and the
 * transaction's read-only mode before anything reads.
 */
async function inPinnedReadOnlyTransaction<T>(
  fn: (db: DbClient, snapshot: SnapshotIdentity) => Promise<T>,
): Promise<T> {
  const { pinReadOnlySnapshot } = await import("./read-only-snapshot");
  return runDbTransaction(
    async () => {
      const db = getDb();
      const pinned = await pinReadOnlySnapshot((statement, values) =>
        db.query<Row>(statement, values as unknown[]),
      );
      await db.query("SET LOCAL work_mem = '16MB'");
      return fn(db, {
        transactionStartedAt: pinned.transactionStartedAt,
        snapshotId: pinned.snapshotId,
      });
    },
    { timeoutMs: LANE_TIMEOUT_MS },
  );
}

async function safeLane<T>(label: string, fn: () => Promise<T>): Promise<T | LaneFailure> {
  const started = Date.now();
  try {
    const result = await fn();
    console.error(`  [${label}] done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    return result;
  } catch (error) {
    console.error(`  [${label}] FAILED after ${((Date.now() - started) / 1000).toFixed(1)}s: ${errorMessage(error)}`);
    return { status: "failed", error: errorMessage(error) };
  }
}

interface Binding {
  providerAccountRefId: string;
  providerAccountId: string;
}

async function readSelectedBindings(db: DbClient, businessId: string): Promise<Binding[]> {
  const rows = await db.query<Row>(LIST_NATIVE_AD_PROVIDER_BINDINGS_SQL, [businessId]);
  return rows
    .map((row) => ({
      providerAccountRefId: text(row.provider_account_ref_id) ?? "",
      providerAccountId: text(row.provider_account_id) ?? "",
    }))
    .filter((row) => row.providerAccountRefId && row.providerAccountId);
}

/* ============================================================ ledger SQL */

/** Current-state bindings, selected AND deselected (the production list is selected-only). */
const ALL_META_BINDINGS_SQL = `
SELECT
  binding.provider_account_ref_id::text AS provider_account_ref_id,
  binding.provider_account_id,
  binding.is_selected,
  account.currency,
  account.timezone
FROM business_provider_accounts binding
JOIN provider_accounts account
  ON account.id = binding.provider_account_ref_id
 AND account.provider = binding.provider
 AND account.external_account_id = binding.provider_account_id
WHERE binding.business_id = $1
  AND binding.provider = 'meta'
ORDER BY binding.is_selected DESC, binding.provider_account_id
`;

const AD_DAYS_SQL = `
SELECT
  COUNT(*)::int AS ad_days,
  COUNT(*) FILTER (WHERE d.spend > 0)::int AS spend_positive,
  COUNT(*) FILTER (WHERE d.truth_state = 'finalized' AND d.validation_status = 'passed')::int AS finalized_passed,
  COUNT(*) FILTER (
    WHERE d.truth_state = 'finalized' AND d.validation_status = 'passed' AND d.finalized_at IS NOT NULL
  )::int AS strict_finalized,
  COUNT(DISTINCT d.ad_id)::int AS ads,
  COUNT(DISTINCT d.date)::int AS days,
  COALESCE(ROUND(SUM(d.spend)::numeric, 2), 0)::text AS spend,
  COALESCE(SUM(d.conversions), 0)::text AS conversions,
  COUNT(*) FILTER (WHERE NULLIF(BTRIM(d.account_timezone), '') IS NULL)::int AS timezone_missing,
  COUNT(*) FILTER (
    WHERE d.truth_state = 'finalized' AND d.validation_status = 'passed'
      AND NULLIF(BTRIM(d.account_timezone), '') IS NOT NULL
      AND d.updated_at > ((d.date + 1)::timestamp AT TIME ZONE d.account_timezone) + INTERVAL '72 hours'
  )::int AS current_version_visible_after_72h,
  COUNT(*) FILTER (
    WHERE d.truth_state = 'finalized' AND d.validation_status = 'passed'
      AND NULLIF(BTRIM(d.account_timezone), '') IS NOT NULL
      AND d.created_at > ((d.date + 1)::timestamp AT TIME ZONE d.account_timezone) + INTERVAL '72 hours'
  )::int AS created_after_72h
FROM meta_ad_daily d
WHERE d.business_id = $1
  AND d.provider_account_id = $2
  AND d.date BETWEEN $3::date AND $4::date
`;

/** The hydration window (asOf-27 .. asOf) as `selected_ad_days` admits it. */
const RESTATED_HYDRATION_WINDOW_SQL = `
SELECT
  COUNT(*) FILTER (WHERE d.created_at <= $4::timestamptz AND d.updated_at <= $4::timestamptz)::int AS visible_at_cutoff_rows,
  COUNT(*) FILTER (WHERE d.created_at <= $4::timestamptz AND d.updated_at > $4::timestamptz)::int AS restated_rows,
  COUNT(*) FILTER (
    WHERE d.created_at <= $4::timestamptz AND d.updated_at > $4::timestamptz
      AND (COALESCE(d.spend, 0) <> 0 OR COALESCE(d.conversions, 0) <> 0 OR COALESCE(d.revenue, 0) <> 0)
  )::int AS restated_economic_rows,
  COUNT(*) FILTER (WHERE d.created_at > $4::timestamptz)::int AS created_after_cutoff_rows
FROM meta_ad_daily d
WHERE d.business_id = $1
  AND d.provider_account_id = $2
  AND d.date BETWEEN ($3::date - 27) AND $3::date
  AND d.truth_state = 'finalized'
  AND d.validation_status = 'passed'
`;

const LEDGER_ROW_FILTER = `
  d.business_id = $1
  AND d.provider_account_id = $2
  AND d.date BETWEEN $3::date AND $4::date
  AND d.truth_state = 'finalized'
  AND d.validation_status = 'passed'`;

const ACTIONS_IS_ARRAY_SQL = "(jsonb_typeof(d.payload_json->'actions') IS NOT DISTINCT FROM 'array')";
const PROVIDER_ZERO_RECEIPT_SQL = buildMetaAdDayProviderZeroReceiptSql({
  qualifier: "d", cutoffSql: "$5::timestamptz",
});
const PROVIDER_ZERO_LATERAL_SQL = `LEFT JOIN LATERAL (
  SELECT ${PROVIDER_ZERO_RECEIPT_SQL} AS verified OFFSET 0
) source_receipt ON TRUE`;

function signCaseSql(expression: string): string {
  return `CASE WHEN (${expression}) IS NULL THEN 'null' WHEN (${expression}) > 0 THEN 'positive' WHEN (${expression}) = 0 THEN 'zero' ELSE 'negative' END`;
}

function buildLinkClickStatesSql(): string {
  const authoritative = buildAdDayAuthoritativeLinkClicksSql({
    qualifier: "d", providerZeroProofSql: "source_receipt.verified",
  });
  return `
SELECT lc.sign AS lc_sign, ${ACTIONS_IS_ARRAY_SQL} AS actions_is_array,
  source_receipt.verified AS provider_zero_verified, COUNT(*)::int AS n
FROM meta_ad_daily d
${PROVIDER_ZERO_LATERAL_SQL}
CROSS JOIN LATERAL (SELECT ${signCaseSql(authoritative)} AS sign) lc
WHERE ${LEDGER_ROW_FILTER}
GROUP BY 1, 2, 3`;
}

function buildFunnelStatesSql(): string {
  const funnel = buildMetaFunnelStageSql({
    payloadExpression: "d.payload_json",
    lateralAlias: "acc_funnel",
    stages: [...FUNNEL_STAGES],
    providerZeroProofSql: "source_receipt.verified",
  });
  const columns = FUNNEL_STAGES.map(
    (stage) =>
      `${funnel.stateSql(stage)} AS ${stage}_state, ${funnel.valueSql(stage)} AS ${stage}_value`,
  ).join(",\n    ");
  const unions = FUNNEL_STAGES.map(
    (stage) => `SELECT '${stage}'::text AS stage, ${stage}_state AS state,
    ${signCaseSql(`${stage}_value`)} AS value_sign, actions_is_array,
    provider_zero_verified, COUNT(*)::int AS n
  FROM staged GROUP BY 1, 2, 3, 4, 5`,
  ).join("\n  UNION ALL\n  ");
  return `
WITH staged AS MATERIALIZED (
  SELECT ${ACTIONS_IS_ARRAY_SQL} AS actions_is_array,
    source_receipt.verified AS provider_zero_verified,
    ${columns}
  FROM meta_ad_daily d
  ${PROVIDER_ZERO_LATERAL_SQL}
  ${funnel.lateralSql}
  WHERE ${LEDGER_ROW_FILTER}
)
${unions}`;
}

const PURCHASE_STATES_SQL = `
SELECT ${signCaseSql("d.conversions")} AS conversions_sign,
  ${ACTIONS_IS_ARRAY_SQL} AS actions_is_array,
  source_receipt.verified AS provider_zero_verified,
  COUNT(*)::int AS n
FROM meta_ad_daily d
${PROVIDER_ZERO_LATERAL_SQL}
WHERE ${LEDGER_ROW_FILTER}
  AND d.spend > 0
GROUP BY 1, 2, 3`;

/** Economic campaign-days, as the config readers scope them. */
const ECONOMIC_CAMPAIGN_DAYS_SQL = `
SELECT DISTINCT d.provider_account_id, NULLIF(BTRIM(d.campaign_id), '') AS campaign_id, d.date,
  COALESCE(NULLIF(BTRIM(d.account_timezone), ''), 'UTC') AS account_timezone
FROM meta_ad_daily d
WHERE ${LEDGER_ROW_FILTER}
  AND (d.spend <> 0 OR d.conversions <> 0 OR d.revenue <> 0)
  AND NULLIF(BTRIM(d.campaign_id), '') IS NOT NULL`;

const ECONOMIC_ADSET_DAYS_SQL = `
SELECT DISTINCT d.provider_account_id, NULLIF(BTRIM(d.adset_id), '') AS adset_id, d.date,
  COALESCE(NULLIF(BTRIM(d.account_timezone), ''), 'UTC') AS account_timezone
FROM meta_ad_daily d
WHERE ${LEDGER_ROW_FILTER}
  AND (d.spend <> 0 OR d.conversions <> 0 OR d.revenue <> 0)
  AND NULLIF(BTRIM(d.adset_id), '') IS NOT NULL`;

/**
 * The campaign objective tier through the production builder. Parameters:
 * $1 business, $2 account, $3 scope start, $4 scope end, $5 evaluation cutoff,
 * then whatever `scopeSql` itself needs.
 */
function buildObjectiveTierSql(scopeSql: string): string {
  const config = buildMetaConfigFieldSourceSql({
    dayExpression: "d.date",
    timezoneExpression: "d.account_timezone",
    businessParam: "$1::text",
    scopeStartParam: "$3::date",
    scopeEndParam: "$4::date",
    evaluationCutoffParam: "$5::timestamptz",
    accountExpression: "d.provider_account_id",
    accountScopeSql: "SELECT $2::text",
    campaignExpression: "d.campaign_id",
    campaignScopeSql: "SELECT DISTINCT campaign_id FROM acc_cscope",
    scopeRelationSql:
      "SELECT provider_account_id, campaign_id, date, account_timezone FROM acc_cscope",
    aliasPrefix: "acc_c",
  });
  return `
WITH acc_cscope AS MATERIALIZED (${scopeSql}),
${config.withSql}
SELECT d.campaign_id, d.date::text AS date,
  ${config.tierSql("objective")} AS tier,
  ${config.readinessSql("objective")} AS readiness,
  ${config.valueSql("objective")} AS value,
  ${config.pitClassSql("objective")} AS pit_class
FROM acc_cscope d
${config.lateralSql}
ORDER BY 1, 2`;
}

function buildAdsetGoalTierSql(): string {
  const config = buildMetaAdsetConfigFieldSourceSql({
    dayExpression: "d.date",
    timezoneExpression: "d.account_timezone",
    businessParam: "$1::text",
    scopeStartParam: "$3::date",
    scopeEndParam: "$4::date",
    evaluationCutoffParam: "$5::timestamptz",
    accountExpression: "d.provider_account_id",
    accountScopeSql: "SELECT $2::text",
    adsetExpression: "d.adset_id",
    adsetScopeSql: "SELECT DISTINCT adset_id FROM acc_ascope",
    scopeRelationSql:
      "SELECT provider_account_id, adset_id, date, account_timezone FROM acc_ascope",
    aliasPrefix: "acc_a",
  });
  return `
WITH acc_ascope AS MATERIALIZED (${ECONOMIC_ADSET_DAYS_SQL}),
${config.withSql}
SELECT d.adset_id, d.date::text AS date,
  ${config.tierSql("optimization_goal")} AS tier,
  ${config.readinessSql("optimization_goal")} AS readiness
FROM acc_ascope d
${config.lateralSql}
ORDER BY 1, 2`;
}

const CONFIG_OBSERVATIONS_SQL = `
SELECT
  o.endpoint_name AS endpoint,
  to_char((o.observed_at AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS utc_day,
  COUNT(*)::int AS obs,
  COUNT(*) FILTER (WHERE o.status = 'fetched' AND o.provider_http_status = 200)::int AS ok200,
  COUNT(*) FILTER (
    WHERE o.status = 'fetched' AND o.provider_http_status = 200
      AND o.request_context->'pagination'->>'complete' = 'true'
      AND o.request_context->'pagination'->>'termination' = 'natural_end'
  )::int AS complete200,
  COUNT(*) FILTER (WHERE o.provider_http_status = 400)::int AS http400,
  COUNT(*) FILTER (
    WHERE o.provider_http_status IS DISTINCT FROM 200 AND o.provider_http_status IS DISTINCT FROM 400
  )::int AS other_status
FROM meta_raw_snapshot_observations o
WHERE o.business_id = $1
  AND o.provider_account_id = $2
  AND o.endpoint_name IN ('campaign_configs', 'adset_configs')
  AND o.observed_at >= ($3::date)::timestamp AT TIME ZONE 'UTC'
  AND o.observed_at < (($4::date + 1)::timestamp AT TIME ZONE 'UTC')
GROUP BY 1, 2
ORDER BY 1, 2`;



const CAMPAIGN_CONTEXT_GROUPS_SQL = `
SELECT
  resolver_version,
  kind_source,
  confidence_class,
  COUNT(*)::int AS rows,
  COUNT(DISTINCT campaign_id)::int AS campaigns,
  COUNT(DISTINCT as_of_date)::int AS days,
  to_char(MIN(as_of_date), 'YYYY-MM-DD') AS min_day,
  to_char(MAX(as_of_date), 'YYYY-MM-DD') AS max_day,
  COUNT(*) FILTER (WHERE updated_at > (as_of_date + 2)::timestamptz)::int AS rewritten_after_d_plus_2,
  COUNT(*) FILTER (WHERE provider_account_id IS NULL)::int AS account_null
FROM engine_v3_campaign_context_daily
WHERE business_id = $1
  AND as_of_date BETWEEN $2::date AND $3::date
GROUP BY 1, 2, 3
ORDER BY 1, 2, 3`;

const CAMPAIGN_CONTEXT_DAYS_SQL = `
SELECT DISTINCT to_char(as_of_date, 'YYYY-MM-DD') AS day
FROM engine_v3_campaign_context_daily
WHERE business_id = $1
  AND as_of_date BETWEEN $2::date AND $3::date`;

/* =========================================================== ledger lane */

function summarizeConfigTiers(rows: readonly Row[], cutoff: string): ConfigTierSummary {
  const classified = rows.map((row) => {
    const classification = classifyConfigTier(row.tier);
    return {
      date: text(row.date) ?? "",
      classification,
      sqlReadiness: text(row.readiness) ?? "none",
    };
  });
  const disagreements = classified.filter(
    (row) => row.sqlReadiness !== row.classification.readiness,
  );
  return {
    cutoff,
    scopeRows: rows.length,
    byTier: countBy(classified, (row) => row.classification.tier),
    byReadiness: countBy(classified, (row) => row.classification.readiness),
    unknownTierStrings: classified.filter((row) => !row.classification.knownTier).length,
    readinessDisagreements: disagreements.length,
    sqlGrantedBeyondLadder: disagreements.filter(
      (row) => row.sqlReadiness === "decision_authority",
    ).length,
    decisionAuthorityDays: [
      ...new Set(
        classified
          .filter((row) => row.classification.readiness === "decision_authority")
          .map((row) => row.date),
      ),
    ].sort(),
  };
}

async function runLedgerLane(input: {
  businessId: string;
  args: AcceptanceArgs;
  resolverApprovedVersion: string | null;
}): Promise<LedgerLaneReport> {
  const started = Date.now();
  const { businessId, args } = input;
  const { start, end } = args.window;
  // The certified point in time: the last chain cutoff (end of day by default, or the natural slot).
  const windowEndCutoff = args.chain.at(-1)?.cutoff ?? endOfUtcDayCutoff(end);
  return inPinnedReadOnlyTransaction(async (db, snapshot) => {
    const selected = await readSelectedBindings(db, businessId);
    const all = await db.query<Row>(ALL_META_BINDINGS_SQL, [businessId]);
    const selectedIds = new Set(selected.map((binding) => binding.providerAccountId));
    const deselected = all
      .filter((row) => !selectedIds.has(text(row.provider_account_id) ?? ""))
      .map((row) => ({
        providerAccountRefId: text(row.provider_account_ref_id) ?? "",
        providerAccountId: text(row.provider_account_id) ?? "",
      }));

    const perAccount: LedgerAccountReport[] = [];
    for (const binding of [...selected, ...deselected]) {
      const isSelected = selectedIds.has(binding.providerAccountId);
      const base = [businessId, binding.providerAccountId, start, end];
      const [adDaysRow] = await db.query<Row>(AD_DAYS_SQL, base);
      const adDays = {
        adDays: num(adDaysRow?.ad_days),
        spendPositive: num(adDaysRow?.spend_positive),
        finalizedPassed: num(adDaysRow?.finalized_passed),
        strictFinalized: num(adDaysRow?.strict_finalized),
        ads: num(adDaysRow?.ads),
        days: num(adDaysRow?.days),
        spend: text(adDaysRow?.spend),
        conversions: text(adDaysRow?.conversions),
        timezoneMissing: num(adDaysRow?.timezone_missing),
        currentVersionVisibleAfter72h: num(adDaysRow?.current_version_visible_after_72h),
        createdAfter72h: num(adDaysRow?.created_after_72h),
      };
      const account: LedgerAccountReport = {
        providerAccountId: binding.providerAccountId,
        providerAccountRefId: binding.providerAccountRefId,
        selected: isSelected,
        adDays,
        restatedAfterCutoff: [],
        linkClicks: {},
        funnel: {},
        purchasesOnSpendRows: {},
        objective: null,
        adsetGoal: null,
        configObservations: [],
        coverageAtRunSlots: null,
        metaAov: null,
        targetAuthority: null,
      };
      perAccount.push(account);
      // A deselected account receives no decision; only its ad-day facts are listed.
      if (!isSelected) continue;

      for (const day of args.chain) {
        const [restated] = await db.query<Row>(RESTATED_HYDRATION_WINDOW_SQL, [
          businessId,
          binding.providerAccountId,
          day.asOf,
          day.cutoff,
        ]);
        account.restatedAfterCutoff.push({
          asOf: day.asOf,
          cutoff: day.cutoff,
          hydrationWindow28d: {
            visibleAtCutoffRows: num(restated?.visible_at_cutoff_rows),
            restatedRows: num(restated?.restated_rows),
            restatedEconomicRows: num(restated?.restated_economic_rows),
            createdAfterCutoffRows: num(restated?.created_after_cutoff_rows),
          },
        });
      }

      const metricParams = [...base, windowEndCutoff];
      const linkRows = await db.query<Row>(buildLinkClickStatesSql(), metricParams);
      account.linkClicks = tallyStates<LinkClickRowState>(
        linkRows.map((row) => ({
          state: classifyLinkClickRow({
            authoritativeSign: (text(row.lc_sign) ?? "null") as ReturnType<typeof numericSign>,
            actionsIsArray: row.actions_is_array === true,
            providerZeroVerified: row.provider_zero_verified === true,
          }),
          n: num(row.n),
        })),
      );

      const funnelRows = await db.query<Row>(buildFunnelStatesSql(), metricParams);
      for (const stage of FUNNEL_STAGES) {
        account.funnel[stage] = tallyStates<FunnelStageRowState>(
          funnelRows
            .filter((row) => row.stage === stage)
            .map((row) => ({
              state: classifyFunnelStageRow({
                state: text(row.state),
                valueSign: (text(row.value_sign) ?? "null") as ReturnType<typeof numericSign>,
                actionsIsArray: row.actions_is_array === true,
                providerZeroVerified: row.provider_zero_verified === true,
              }),
              n: num(row.n),
            })),
        );
      }

      const purchaseRows = await db.query<Row>(PURCHASE_STATES_SQL, metricParams);
      account.purchasesOnSpendRows = tallyStates<PurchaseRowState>(
        purchaseRows.map((row) => ({
          state: classifyPurchaseRow({
            conversionsSign: (text(row.conversions_sign) ?? "null") as ReturnType<typeof numericSign>,
            actionsIsArray: row.actions_is_array === true,
            providerZeroVerified: row.provider_zero_verified === true,
          }),
          n: num(row.n),
        })),
      );

      const configParams = [businessId, binding.providerAccountId, start, end, windowEndCutoff];
      account.objective = summarizeConfigTiers(
        await db.query<Row>(buildObjectiveTierSql(ECONOMIC_CAMPAIGN_DAYS_SQL), configParams),
        windowEndCutoff,
      );
      account.adsetGoal = summarizeConfigTiers(
        await db.query<Row>(buildAdsetGoalTierSql(), configParams),
        windowEndCutoff,
      );

      const observations = await db.query<Row>(CONFIG_OBSERVATIONS_SQL, base);
      const observed = new Map(
        observations.map((row) => [`${text(row.endpoint)}|${text(row.utc_day)}`, row]),
      );
      for (const endpoint of ["campaign_configs", "adset_configs"]) {
        for (const utcDay of enumerateUtcDays(start, end)) {
          const row = observed.get(`${endpoint}|${utcDay}`);
          account.configObservations.push({
            endpoint,
            utcDay,
            obs: num(row?.obs),
            ok200: num(row?.ok200),
            complete200: num(row?.complete200),
            http400: num(row?.http400),
            otherStatus: num(row?.other_status),
          });
        }
      }

      const coverageRows = await db.query<Row>(D101_COVERAGE_AT_CUTOFFS_SQL, [
        businessId,
        binding.providerAccountId,
        binding.providerAccountRefId,
        ...coverageSlotParams(productionRunSlotCutoffs(start, end)),
      ]);
      const slots: CoverageSlotRecord[] = coverageRows.map((row) => {
        const expectedThroughDay = text(row.expected_through_day);
        const coverageThroughDay = text(row.coverage_through_day);
        const classification = classifyCoverage({ expectedThroughDay, coverageThroughDay });
        return {
          asOf: text(row.as_of) ?? "",
          slot: text(row.slot) ?? "",
          cutoff: isoOrNull(row.cutoff) ?? "",
          accountTimezone: text(row.account_timezone),
          expectedThroughDay,
          coverageThroughDay,
          status: classification.status,
          lagDays: classification.lagDays,
        };
      });
      const bySlot: Record<string, Record<string, number>> = {};
      for (const slot of PRODUCTION_RUN_SLOTS) {
        bySlot[`${slot}Z`] = countBy(
          slots.filter((record) => record.slot === `${slot}Z`),
          (record) => record.status,
        );
      }
      account.coverageAtRunSlots = {
        counts: countBy(slots, (record) => record.status),
        bySlot,
        slots,
      };

      const aov = await computeMetaAttributedAov({
        businessId,
        asOf: windowEndCutoff,
        windowDays: 90,
        providerAccountId: binding.providerAccountId,
        db,
      });
      account.metaAov = {
        cutoff: windowEndCutoff,
        aovMean: aov.aovMean,
        purchaseCount: aov.purchaseCount,
        totalRevenue: aov.totalRevenue,
        windowStart: aov.windowStart,
        windowEnd: aov.windowEnd,
        sampleFloor: NATIVE_AD_ACCOUNT_AOV_PURCHASE_SAMPLE_FLOOR,
        aboveFloor: aov.purchaseCount >= NATIVE_AD_ACCOUNT_AOV_PURCHASE_SAMPLE_FLOOR,
      };

      const [targetRow] = await db.query<Row>(READ_NATIVE_AD_TARGET_AUTHORITY_FOR_ACCOUNT_SQL, [
        businessId,
        binding.providerAccountRefId,
        binding.providerAccountId,
        windowEndCutoff,
      ]);
      const target = targetRow ? mapNativeAdTargetAuthorityRow(targetRow) : null;
      account.targetAuthority = target
        ? {
            cutoff: windowEndCutoff,
            operation: target.operation,
            targetRoas: target.targetRoas,
            breakEvenRoas: target.breakEvenRoas,
            targetCpa: target.targetCpa,
            effectiveAt: target.effectiveAt,
            recordedAt: target.recordedAt,
          }
        : { cutoff: windowEndCutoff, status: "no_target_row" };
    }

    const contextGroups = await db.query<Row>(CAMPAIGN_CONTEXT_GROUPS_SQL, [businessId, start, end]);
    const contextDays = new Set(
      (await db.query<Row>(CAMPAIGN_CONTEXT_DAYS_SQL, [businessId, start, end])).map(
        (row) => text(row.day) ?? "",
      ),
    );
    const arming = describeResolverArming({
      approvedVersion: input.resolverApprovedVersion,
      requiredVersion: CAMPAIGN_CONTEXT_RESOLVER_VERSION,
    });
    const byConfidenceClass: Record<string, number> = {};
    for (const group of contextGroups) {
      const key = text(group.confidence_class) ?? "null";
      byConfidenceClass[key] = (byConfidenceClass[key] ?? 0) + num(group.rows);
    }
    return {
      status: "computed",
      snapshot,
      runtimeMs: Date.now() - started,
      accounts: {
        selected: selected.map((binding) => binding.providerAccountId),
        deselected: deselected.map((binding) => binding.providerAccountId),
      },
      perAccount,
      campaignContext: {
        resolverArmed: arming.resolverArmed,
        approvedVersion: arming.approvedVersion,
        requiredVersion: arming.requiredVersion,
        groups: contextGroups.map((group) => ({
          resolverVersion: text(group.resolver_version),
          kindSource: text(group.kind_source),
          confidenceClass: text(group.confidence_class),
          rows: num(group.rows),
          campaigns: num(group.campaigns),
          days: num(group.days),
          minDay: text(group.min_day),
          maxDay: text(group.max_day),
          rewrittenAfterDPlus2: num(group.rewritten_after_d_plus_2),
          accountNull: num(group.account_null),
        })),
        byConfidenceClass,
        rowsMatchingRequiredResolver: contextGroups
          .filter((group) => text(group.resolver_version) === CAMPAIGN_CONTEXT_RESOLVER_VERSION)
          .reduce((sum, group) => sum + num(group.rows), 0),
        rows: contextGroups.reduce((sum, group) => sum + num(group.rows), 0),
        windowDaysWithoutRows: enumerateUtcDays(start, end).filter((day) => !contextDays.has(day)),
      },
      restatedAfterCutoffBusiness90d: await Promise.resolve().then(async () => {
        const out: Array<Record<string, unknown>> = [];
        for (const day of args.chain) {
          const [row] = await db.query<Row>(COUNT_AD_DAYS_RESTATED_AFTER_CUTOFF_SQL, [
            businessId,
            day.asOf,
            day.cutoff,
          ]);
          out.push({
            asOf: day.asOf,
            cutoff: day.cutoff,
            windowDays: RESTATED_AFTER_CUTOFF_WINDOW_DAYS,
            rows: num(row?.rows),
            economicRows: num(row?.economic_rows),
          });
        }
        return out;
      }),
    };
  });
}

/* ========================================================= decision lane */

function profileCellMatches(cell: NativeAdCalibrationCell, query: NativeAdCalibrationCellQuery): boolean {
  return (
    cell.key.businessId === query.businessId &&
    cell.key.providerAccountId === query.providerAccountId &&
    cell.key.accountTimezone === query.accountTimezone &&
    cell.key.accountCurrency === query.accountCurrency &&
    cell.key.cellScope === query.cellScope &&
    cell.key.objective === query.objective &&
    cell.key.cohort === query.cohort &&
    cell.key.optimizationContext === query.optimizationContext &&
    cell.asOfDate === query.asOfDate &&
    cell.engineVersion === query.engineVersion &&
    cell.policyVersion === query.policyVersion
  );
}

/** The existing simulator's in-memory profile source, restated (it is not exported). */
class InMemoryNativeProfileDataSource
  implements NativeAdAccountProfileDataSource, NativeAdProfileRuntimeDataSource
{
  constructor(
    private readonly cells: NativeAdCalibrationCell[],
    private readonly targets: ReadonlyMap<string, NativeAdTargetAuthorityInput | null>,
  ) {}

  async getNativeAdCalibrationCell(query: NativeAdCalibrationCellQuery) {
    return this.cells.find((cell) => profileCellMatches(cell, query)) ?? null;
  }

  async getNativeTargetAuthorityAsOf(input: {
    businessId: string;
    providerAccountRefId: string;
    providerAccountId: string;
    asOfCutoff: string;
  }) {
    return this.targets.get(`${input.providerAccountRefId}\u0000${input.providerAccountId}`) ?? null;
  }

  async getNativeCalibrationRowId(cell: NativeAdCalibrationCell) {
    return `read-only-simulation:${cell.inputManifestHash}`;
  }
}

interface ScopedDecision {
  scope: { type: "account" | "campaign"; id: string };
  computation: AdDecisionComputation;
  evaluation: AdCanonicalEvaluationProvenance;
  payload: NativeSnapshotPayloadRow;
  group: NativeAdDecisionProfileGroup;
}

function accountDayReport(input: {
  providerAccountId: string;
  entries: readonly ScopedDecision[];
  receipt: SimulatedHydrationReceipt | null;
  batches: readonly NativeAdCalibrationBatch[];
  campaignContextById: ReadonlyMap<string, unknown>;
  independent: IndependentReading | null;
}): DecisionAccountDayReport {
  const { entries } = input;
  const cellOf = (entry: ScopedDecision) => entry.group.calibrationCell;
  const batch = input.batches.find((candidate) => candidate.providerAccountId === input.providerAccountId);
  // Every count but calibration is the pure core mapping (summarizeAccountDecisions), tested there.
  const summary = summarizeAccountDecisions({ entries, campaignContextById: input.campaignContextById });
  return {
    providerAccountId: input.providerAccountId,
    receipt: input.receipt
      ? {
          sourceComplete: input.receipt.sourceComplete,
          hydrationComplete: input.receipt.hydrationComplete,
          authoritativeForPrune: input.receipt.authoritativeForPrune,
          expectedAdCount: input.receipt.expectedAdCount,
          hydratedAdCount: input.receipt.hydratedAdCount,
          reason: input.receipt.reason,
          gate: evaluateReceiptGate(input.receipt),
        }
      : null,
    ...summary,
    calibration: {
      cells: batch?.cells.length ?? 0,
      qualityCounts: batch?.qualityCounts ?? null,
      groupBlocker: countBy(entries, (entry) => entry.group.blocker ?? "ready"),
      hardActionEligibility: countBy(entries, (entry) => {
        const eligibility = hardActionEligibilityOf(entry.group);
        return `scale=${eligibility.scale},cut=${eligibility.cut},refresh=${eligibility.refresh}`;
      }),
      spendUnitAuthority: countBy(entries, (entry) => {
        const authority = pick(cellOf(entry), ["actionReadiness", "spendUnitAuthority"]);
        return authority ? `${String(pick(authority, ["status"]))}|${String(pick(authority, ["basis"]))}` : "no_cell";
      }),
      aovEvidence: countBy(entries, (entry) => {
        const evidence = pick(cellOf(entry), ["actionReadiness", "spendUnitAuthority", "accountAovEvidence"]);
        return evidence
          ? `${String(pick(evidence, ["status"]))}:${String(pick(evidence, ["observedPurchaseCount"]))}/${String(pick(evidence, ["requiredPurchaseCount"]))}`
          : "no_cell";
      }),
      targetAuthority: countBy(entries, (entry) => {
        const target = pick(cellOf(entry), ["targetAuthority"]);
        return target
          ? `${String(pick(target, ["status"]))}|tROAS=${String(pick(target, ["targetRoas"]))}|beROAS=${String(pick(target, ["breakEvenRoas"]))}`
          : "no_cell";
      }),
      calibrationQuality: countBy(entries, (entry) => String(pick(cellOf(entry), ["qualityStatus"]) ?? "no_cell")),
      exactCellSpendUnit: countBy(entries, (entry) => {
        const source = pick(entry.group.profile, ["spendUnitSource"]);
        return source
          ? `${String(source)}|${String(pick(entry.group.profile, ["spendUnitConfidence"]))}|aov=${String(pick(entry.group.profile, ["quality", "metaAovQuality"]))}`
          : "soft_only_profile";
      }),
    },
    crossCheck: { ...hydrationClaims(entries), independent: input.independent },
  };
}

function toSimulatedReceipt(receipt: {
  providerAccountRefId: string;
  providerAccountId: string;
  expectedAdCount: number;
  hydratedAdCount: number;
  expectedManifestHash: string;
  hydratedManifestHash: string;
  authoritativeForPrune: boolean;
  sourceComplete: boolean;
  hydrationComplete: boolean;
  reason: string | null;
}): SimulatedHydrationReceipt {
  return {
    providerAccountRefId: receipt.providerAccountRefId,
    providerAccountId: receipt.providerAccountId,
    expectedAdCount: receipt.expectedAdCount,
    hydratedAdCount: receipt.hydratedAdCount,
    expectedManifestHash: receipt.expectedManifestHash,
    hydratedManifestHash: receipt.hydratedManifestHash,
    authoritativeForPrune: receipt.authoritativeForPrune,
    sourceComplete: receipt.sourceComplete,
    hydrationComplete: receipt.hydrationComplete,
    reason: receipt.reason,
  };
}



function identityFromRow(row: Row): Partial<SimulatedIdentity> {
  return {
    creative_name: text(row.creative_name),
    campaign_id: text(row.campaign_id),
    campaign_name: text(row.campaign_name),
    adset_id: text(row.adset_id),
    adset_name: text(row.adset_name),
    ad_name: text(row.ad_name),
    campaign_status: text(row.campaign_status),
    adset_status: text(row.adset_status),
    ad_status: text(row.ad_status),
    currency: text(row.currency),
    thumbnail_url: text(row.thumbnail_url),
    media_source_present: row.media_source_present === true,
    media_available: row.media_available === true,
    media_source: text(row.media_source),
    source_updated_at: isoOrNull(row.source_updated_at),
  };
}

const COUNTERFACTUAL_GOVERNANCE: MetaDecisionExecutionGovernanceFacts = {
  verified: true,
  controlsConfigured: true,
  writeBlocked: false,
  blockReason: null,
};

type ExactAdapterWorkspace = Parameters<typeof buildMetaDecisionCenterExactViewModel>[0]["workspace"];

/** A minimal, labelled stub of the Decisions payload: only the read model and OS presentation are real. */
function stubWorkspacePayload(input: {
  businessId: string;
  model: unknown;
  os: unknown;
  asOf: string;
}): ExactAdapterWorkspace {
  return {
    businessId: input.businessId,
    window: "7d",
    startDate: input.asOf,
    endDate: input.asOf,
    pulse: {
      lastSyncAt: null,
      pacing: { spendToday: null, avg7dSpend: null, conversionsToday: null, avg7dConversions: null, windowSpend: null },
      roas: { selected: null, target: null, targetFreshness: null, target_source: null, median: null },
      roasHistory: [],
      operatingMode: null,
      seasonalRegime: null,
      trackingHealth: null,
      campaignRoleCoverage: null,
    },
    lanes: {
      actionNow: [], watching: [], healthy: [], nonSales: [], archive: [],
      structureInventory: [], watchingSegments: [], deferredIds: [],
      counts: { actionNow: 0, watching: 0, healthy: 0, nonSales: 0, archive: 0 },
      snapshotDate: null,
    },
    queue: { groups: [], actionStates: {} },
    system: {
      trackingBlocked: false, dataReadiness: null, snapshotHealth: null, laneSnapshotDate: null,
      laneSnapshotCreatedAt: null, engineVersion: "", currency: null, killSwitchEngaged: false, killSwitchReason: null,
    },
    viewer: null,
    banners: [],
    digest: null,
    decisionReadModel: input.model,
    os: input.os,
  } as unknown as ExactAdapterWorkspace;
}

function inventorySummary(decisions: readonly MetaCanonicalDecision[]) {
  return {
    items: decisions.length,
    decisionState: countBy(decisions, (decision) => decision.classification.decisionState),
    heldAction: countBy(decisions, (decision) => decision.classification.heldAction ?? "none"),
    actionEligible: countBy(decisions, (decision) => decision.sourceAuthority?.actionEligible ?? "null"),
    executionReadiness: countBy(decisions, (decision) => pick(decision.sourceAuthority, ["executionReadiness"]) ?? "null"),
    reviewOnlyReason: countBy(decisions, (decision) => pick(decision.sourceAuthority, ["reviewOnlyReason"]) ?? "null"),
    deliveryScope: countBy(decisions, (decision) => decision.deliveryScope?.state ?? "none"),
    configEvidenceVerified: countBy(decisions, (decision) => pick(decision.configEvidence, ["verified"]) ?? "null"),
  };
}

async function presentAccount(input: {
  db: DbClient;
  businessId: string;
  asOf: string;
  cutoff: string;
  receipt: SimulatedHydrationReceipt;
  scoped: readonly ScopedDecision[];
  priorEpisodes: ReadonlyMap<string, EpisodeMark>;
  hashIntegrityVerified: boolean;
  governance: MetaDecisionExecutionGovernanceFacts & Record<string, unknown>;
  adLimits: readonly number[];
}): Promise<{ report: PresentationAccountReport; episodes: Map<string, EpisodeMark> | null }> {
  const { db, businessId, asOf, cutoff, receipt } = input;
  const now = new Date(cutoff);
  const report: PresentationAccountReport = {
    providerAccountId: receipt.providerAccountId,
    asOf,
    cutoff,
    status: "failed",
    receiptGate: { pass: false, failures: [] },
    refusal: null,
    validation: null,
    generation: null,
    identity: null,
    hierarchyAtCutoff: null,
    targetHardActionEligibility: null,
    modes: [],
    error: null,
  };
  const accountEntries = input.scoped.filter(
    (entry) =>
      entry.payload.provider_account_id === receipt.providerAccountId &&
      entry.payload.provider_account_ref_id === receipt.providerAccountRefId,
  );
  // Nothing is read, built or presented for a receipt that fails the production gate.
  const gate = evaluateReceiptGate(receipt);
  if (!gate.pass) {
    report.status = "receipt_unreconstructable";
    report.receiptGate = gate;
    report.refusal = `hydration receipt fails the production gate: ${gate.failures.join(", ")} (reason ${receipt.reason ?? "none"})`;
    return { report, episodes: null };
  }
  const identityRows = await input.db.query<Row>(IDENTITY_AT_CUTOFF_SQL, [
    businessId,
    receipt.providerAccountId,
    accountEntries.map((entry) => entry.payload.ad_id),
    accountEntries.map((entry) => entry.payload.creative_id),
    asOf,
    receipt.providerAccountRefId,
    cutoff,
  ]);
  const identityByAdId = new Map<string, Partial<SimulatedIdentity>>(identityRows.map((row) => [text(row.ad_id) ?? "", identityFromRow(row)]));
  const hydratedCampaignMismatch = accountEntries.filter((entry) => {
    const hydrated = entry.computation.input.campaignId ?? null;
    const served = identityByAdId.get(entry.payload.ad_id)?.campaign_id ?? null;
    return hydrated !== null && served !== null && hydrated !== served;
  }).length;
  report.identity = {
    rows: identityRows.length,
    withCampaignId: identityRows.filter((row) => text(row.campaign_id)).length,
    hydratedCampaignIdDisagreesWithDimension: hydratedCampaignMismatch,
    adStatusAtCutoff: countBy(identityRows, (row) => text(row.ad_status) ?? "unknown"),
    campaignStatusAtCutoff: countBy(identityRows, (row) => text(row.campaign_status) ?? "unknown"),
    statusSource: "meta_entity_state_history observed/captured/created <= cutoff",
    nameSource: "present dimension tables (labels only)",
  };

  const built = buildSimulatedGeneration({
    businessId,
    asOf,
    cutoff,
    receipt,
    entries: accountEntries.map(
      (entry): SimulatedDecisionEntry => ({
        payload: entry.payload,
        evaluation: {
          contractVersion: entry.evaluation.contractVersion,
          inputPayload: entry.evaluation.inputPayload as Record<string, unknown>,
          decisionPayload: entry.evaluation.decisionPayload as Record<string, unknown>,
          inputHash: entry.evaluation.inputHash,
          decisionHash: entry.evaluation.decisionHash,
        },
      }),
    ),
    identityByAdId,
    priorEpisodes: input.priorEpisodes,
    hashIntegrityVerified: input.hashIntegrityVerified,
  });
  report.receiptGate = built.receiptGate;
  if (built.status === "refused") {
    report.status = built.reason === "receipt_unreconstructable" ? "receipt_unreconstructable" : "refused";
    report.refusal = `${built.reason}: ${built.detail}`;
    return { report, episodes: null };
  }
  const rows: MetaNativeDecisionSnapshotSourceRow[] = built.rows;
  report.hierarchyAtCutoff = summarizeHierarchyAtCutoff(rows);
  report.generation = {
    jobRunId: built.generation.jobRunId,
    manifestHash: built.generation.manifestHash,
    expectedAdCount: built.generation.expectedAdCount,
    rows: rows.length,
    lineageValidRows: built.lineageValidRows,
  };
  const validation = validateMetaNativeDecisionGenerationBundle({
    businessId,
    providerAccountId: receipt.providerAccountId,
    generation: built.generation,
    snapshotRows: rows,
  });
  report.validation = { status: validation.status, issue: validation.validationIssue ?? null };
  if (validation.status !== "available") {
    report.status = "generation_invalid";
    return { report, episodes: built.episodes };
  }

  // Serve the simulated generation with the same entity-role readers as
  // production, but bound declarations to this historical knowledge cutoff.
  const campaignIds = [...new Set(rows.map((row) => row.campaign_id).filter((id): id is string => Boolean(id)))];
  const campaignContextRows = await readMetaDecisionCampaignContextRows({
    businessId,
    providerAccountId: receipt.providerAccountId,
    campaignIds,
    snapshotAsOf: asOf,
    visibleAtCutoff: cutoff,
  });
  await assertTransactionAlive(db, "readMetaDecisionCampaignContextRows");
  const adsets = [...new Map(rows
    .filter((row) => Boolean(row.adset_id))
    .map((row) => [row.adset_id!, { adsetId: row.adset_id!, campaignId: row.campaign_id ?? null }]))
    .values()];
  const adsetRoleRows = await readMetaDecisionAdsetRoleRows({
    businessId,
    providerAccountId: receipt.providerAccountId,
    adsets,
    snapshotAsOf: asOf,
    campaignRows: campaignContextRows,
    visibleAtCutoff: cutoff,
  });
  await assertTransactionAlive(db, "readMetaDecisionAdsetRoleRows");

  const common = {
    businessId,
    providerAccountId: receipt.providerAccountId,
    generation: built.generation,
    snapshotRows: rows,
    campaignContextRows,
    adsetRoleRows,
    eventRows: [],
    outcomeRows: [],
    responseRows: [],
    eventSourceAvailable: false,
    outcomeSourceAvailable: false,
    responseSourceAvailable: false,
    generatedAt: cutoff,
  };
  const inventory = buildNativeMetaCanonicalDecisionInventory(common);
  if (inventory.status !== "available") {
    report.status = "generation_invalid";
    report.refusal = `canonical inventory unavailable: ${inventory.unavailableReason}`;
    return { report, episodes: built.episodes };
  }

  // Target hard-action eligibility for the OS presentation: the conjunction of
  // this account's READY simulated native profile groups (the route's own
  // account-profile closure is not exported and reads current state).
  const readyGroups = input.scoped
    .filter((entry) => entry.payload.provider_account_id === receipt.providerAccountId && entry.group.blocker === null)
    .map((entry) => entry.group);
  const uniqueReady = [...new Map(readyGroups.map((group) => [group.key, group])).values()];
  const eligibility = {
    scale: uniqueReady.length > 0 && uniqueReady.every((group) => hardActionEligibilityOf(group).scale),
    cut: uniqueReady.length > 0 && uniqueReady.every((group) => hardActionEligibilityOf(group).cut),
    refresh: uniqueReady.length > 0 && uniqueReady.every((group) => hardActionEligibilityOf(group).refresh),
  };
  const targetHardActionEligibility = targetHardActionEligibilityFromAccountProfile(eligibility);
  report.targetHardActionEligibility = {
    basis: "conjunction_of_ready_simulated_native_profile_groups",
    readyGroups: uniqueReady.length,
    ...eligibility,
  };

  const heldAdIds = rows.filter((row) => row.blocked_action_type !== null).map((row) => row.ad_id);
  const currency = rows.find((row) => row.currency)?.currency ?? null;
  // Source backing: the ad's decision input carries at least one metric row in the decision window.
  const sourceBackedAdIds = new Set(
    accountEntries
      .filter((entry) => num(entry.computation.input.metricEvidence.sourceRowCount) > 0)
      .map((entry) => entry.payload.ad_id),
  );
  const smallestAdLimit = input.adLimits.length > 0 ? Math.min(...input.adLimits) : null;
  const models = input.adLimits.map((limit) => {
    try {
      return { limit, model: buildNativeMetaDecisionsWorkspaceReadModel({ ...common, adCandidateLimit: limit }), error: null };
    } catch (error) {
      return { limit, model: null, error: errorMessage(error) };
    }
  });

  const modes: Array<{
    mode: PresentationModeReport["mode"];
    governance: MetaDecisionExecutionGovernanceFacts;
    pipeline: { verified: boolean; executionReady: boolean; basis: string };
  }> = [
    {
      mode: "actual_governance",
      governance: {
        verified: input.governance.verified,
        controlsConfigured: input.governance.controlsConfigured,
        writeBlocked: input.governance.writeBlocked,
        blockReason: input.governance.blockReason,
      },
      pipeline: { verified: false, executionReady: false, basis: "not_reconstructable_at_cutoff_fail_closed" },
    },
    {
      mode: "governance_verified_counterfactual",
      governance: COUNTERFACTUAL_GOVERNANCE,
      pipeline: { verified: true, executionReady: true, basis: "counterfactual_assumed_verified" },
    },
  ];

  for (const mode of modes) {
    const governed = applyMetaExecutionGovernanceToCanonicalDecisions({
      decisions: inventory.items,
      governance: mode.governance,
      pipeline: mode.pipeline,
      now,
    });
    const projected = governed.map((decision) => ({
      decision,
      projection: projectCanonicalNativeAdDecisionToBriefing({ decision, row: null, deferred: false }),
    }));
    const projectionNulls = projected.filter((entry) => entry.projection === null).length;
    let briefing: PresentationModeReport["briefing"] = null;
    const briefingCards: Array<{ adId: string | null; lane: string }> = [];
    const briefingAdIds: string[] = [];
    if (projectionNulls === 0) {
      const lanes: Record<"action" | "watching" | "healthy", unknown[]> = { action: [], watching: [], healthy: [] };
      for (const entry of projected) {
        if (!isInBriefing({ status: entry.decision.deliveryScope?.adStatus ?? null }, "active")) continue;
        const lane = entry.projection!.lane as "action" | "watching" | "healthy";
        lanes[lane].push(entry.projection!.card);
        briefingAdIds.push(entry.decision.parentChain.ad?.id ?? "(no ad id)");
        briefingCards.push({ adId: entry.decision.parentChain.ad?.id ?? null, lane });
      }
      const index = buildServedCreativeClassifications({
        actionNow: lanes.action,
        watching: lanes.watching,
        healthy: lanes.healthy,
        source: { canonicalDecisionInventory: { status: "available" } },
      } as unknown as Parameters<typeof buildServedCreativeClassifications>[0]);
      briefing = {
        projectionNulls,
        statusFilter: "active",
        lanes: { action: lanes.action.length, watching: lanes.watching.length, healthy: lanes.healthy.length },
        servedClassifications: index.size,
        studioAdsIndexed: index.servedDecisionsByAdId.size,
      };
    } else {
      briefing = {
        projectionNulls,
        statusFilter: "active",
        lanes: { action: 0, watching: 0, healthy: 0 },
        servedClassifications: 0,
        studioAdsIndexed: 0,
      };
    }

    const workspace: PresentationModeReport["workspace"] = [];
    const osItemsByLimit: Array<readonly OsItemSource[]> = [];
    const exactAdapterRows: Array<{ id: string; actionTone?: string | null }> = [];
    let smallestLimitOsAdIds: string[] = [];
    for (const { limit, model, error } of models) {
      if (!model) {
        workspace.push({ limit, status: "build_failed", os: null, heldServed: null, eligiblePreCapCount: null, exactAdapter: null, error });
        continue;
      }
      try {
        const governedModel = applyMetaExecutionGovernanceToReadModel({
          model,
          governance: mode.governance,
          pipeline: mode.pipeline,
          now,
        });
        const os = buildMetaOsDecisionsPresentation({
          actionNow: [],
          watching: [],
          nonSales: [],
          structureInventory: [],
          inactiveStructure: [],
          decisionReadModel: governedModel,
          currentAds: [],
          currentAdCampaignContexts: [],
          currency,
          targetHardActionEligibility,
          pipelineHealth:
            mode.mode === "governance_verified_counterfactual"
              ? { overall: "healthy", executionReady: true, blockers: [] }
              : undefined,
          generatedAt: cutoff,
        });
        if (limit === smallestAdLimit) smallestLimitOsAdIds = os.ads.items.map((item) => item.adId);
        osItemsByLimit.push(os.ads.items);
        const adCandidates = governedModel.queue?.adCandidates ?? null;
        const osSummary: Record<string, unknown> = {
          items: os.ads.items.length,
          act: os.ads.actCount,
          blocked: os.ads.blockedCount,
          monitor: os.ads.monitorCount,
          heldCounts: os.ads.heldCounts,
          statePreCapCounts: os.ads.statePreCapCounts,
          eligiblePreCapCount: os.ads.eligiblePreCapCount,
          pendingInventoryCount: os.ads.pendingInventoryCount,
          sourcePreCapCount: os.ads.sourcePreCapCount,
          archive: os.inactive
            ? { count: os.inactive.count, inactive: os.inactive.inactiveCount, unknown: os.inactive.unknownCount }
            : null,
          sourceHealth: os.source.health ?? null,
          fallbackReason: os.source.fallbackReason ?? null,
          actionCodes: countBy(os.ads.items, (item) => `${item.lane}:${item.action.code}:${item.action.intent}:${item.action.providerMutation}`),
          readModelAdCandidates: adCandidates
            ? {
                limit: adCandidates.limit,
                preCap: adCandidates.preCapCount,
                eligiblePreCap: adCandidates.eligiblePreCapCount,
                selected: adCandidates.selectedCount,
                stateCounts: adCandidates.stateCounts,
              }
            : null,
          limitations: os.limitations.map((limitation) => limitation.code),
        };
        let exactAdapter: Record<string, unknown> | null = null;
        if (mode.mode === "actual_governance") {
          try {
            const viewModel: unknown = buildMetaDecisionCenterExactViewModel({
              workspace: stubWorkspacePayload({ businessId, model: governedModel, os, asOf }),
              now: now.getTime(),
              selection: null,
            });
            const groups = pick(viewModel, ["creativeGroups"]);
            const creativeRows = pick(viewModel, ["creativeDecisions"]);
            if (Array.isArray(creativeRows)) {
              for (const row of creativeRows) {
                exactAdapterRows.push({ id: String(pick(row, ["id"])), actionTone: text(pick(row, ["actionTone"])) });
              }
            }
            exactAdapter = {
              basis: "labelled_stub_payload_only_decisionReadModel_and_os_are_real",
              creativeDecisions: (pick(viewModel, ["creativeDecisions"]) as unknown[] | undefined)?.length ?? null,
              creativeGroups: Array.isArray(groups)
                ? groups.map((group) => `${String(pick(group, ["id"]))}: ${String(pick(group, ["count"]))}${pick(group, ["note"]) ? ` [${String(pick(group, ["note"]))}]` : ""}`)
                : null,
              countsCreatives: pick(viewModel, ["counts", "creatives"]) ?? null,
              countsArchive: pick(viewModel, ["counts", "archive"]) ?? null,
            };
          } catch (adapterError) {
            exactAdapter = { error: errorMessage(adapterError) };
          }
        }
        workspace.push({
          limit,
          status: governedModel.status,
          os: osSummary,
          heldServed: locateHeldVerdicts({
            heldAdIds,
            servedAdIds: os.ads.items.map((item) => item.adId),
            archivedAdIds: (os.inactive?.items ?? []).map((item) => item.providerEntityId),
          }),
          eligiblePreCapCount: os.ads.eligiblePreCapCount,
          exactAdapter,
          error: null,
        });
      } catch (buildError) {
        workspace.push({ limit, status: "build_failed", os: null, heldServed: null, eligiblePreCapCount: null, exactAdapter: null, error: errorMessage(buildError) });
      }
    }

    report.modes.push({
      mode: mode.mode,
      governance: { ...mode.governance },
      pipeline: mode.pipeline,
      inventory: inventorySummary(governed),
      sourceBacking: {
        basis: "metricEvidence.sourceRowCount_gt_0_in_decision_window",
        sourceBackedAds: rows.filter((row) => sourceBackedAdIds.has(row.ad_id)).length,
        sourceBackedInventoryItems: governed.filter((decision) => sourceBackedAdIds.has(decision.parentChain.ad?.id ?? "")).length,
        sourceBackedBriefingCards: briefingAdIds.filter((adId) => sourceBackedAdIds.has(adId)).length,
        smallestAdLimit,
        sourceBackedOsItemsAtSmallestLimit: smallestLimitOsAdIds.filter((adId) => sourceBackedAdIds.has(adId)).length,
        sourceBackedPresentedAds: new Set(
          [...briefingAdIds, ...smallestLimitOsAdIds].filter((adId) => sourceBackedAdIds.has(adId)),
        ).size,
      },
      briefing,
      // The audit input mapping is the pure core function (auditPresentationMode), tested there.
      authorityAudit: auditPresentationMode({
        rows,
        governed,
        briefingCards,
        osItemsByLimit,
        exactAdapterRows,
      }),
      workspace,
    });
  }
  report.status = "presented";
  return { report, episodes: built.episodes };
}

/** Days before the as-of day the independent config reading covers; wider than any hydration window. */
const INDEPENDENT_LOOKBACK_DAYS = 59;

/**
 * The independent reading at one chain cutoff, in the decision lane's own
 * snapshot: the ledger's production tier SQL (campaign objective, ad set goal
 * over economic days, read at this cutoff) and the D101 port at this cutoff.
 * A day is decision_authority when either the SQL or the production ladder
 * says so, so the reading can only be MORE permissive than hydration; a
 * verified claim it does not support is a contradiction.
 */
async function readIndependentAtCutoff(input: {
  db: DbClient;
  businessId: string;
  binding: { providerAccountId: string; providerAccountRefId: string };
  asOf: string;
  cutoff: string;
}): Promise<IndependentReading> {
  const { db, businessId, binding, asOf, cutoff } = input;
  const scope = { start: addUtcDays(asOf, -INDEPENDENT_LOOKBACK_DAYS), end: asOf };
  const reading: IndependentReading = {
    cutoff,
    scope,
    coverage: null,
    objectiveAuthorityCampaigns: [],
    objectiveEconomicCampaigns: 0,
    adsetGoalAuthorityAdsets: [],
    adsetGoalEconomicAdsets: 0,
    error: null,
  };
  try {
    const params = [businessId, binding.providerAccountId, scope.start, scope.end, cutoff];
    const isAuthority = (row: Row) =>
      classifyConfigTier(row.tier).readiness === "decision_authority" || text(row.readiness) === "decision_authority";
    const objective = await db.query<Row>(buildObjectiveTierSql(ECONOMIC_CAMPAIGN_DAYS_SQL), params);
    reading.objectiveEconomicCampaigns = new Set(objective.map((row) => text(row.campaign_id))).size;
    reading.objectiveAuthorityCampaigns = [
      ...new Set(objective.filter(isAuthority).map((row) => text(row.campaign_id)).filter((id): id is string => id !== null)),
    ].sort();
    const goal = await db.query<Row>(buildAdsetGoalTierSql(), params);
    reading.adsetGoalEconomicAdsets = new Set(goal.map((row) => text(row.adset_id))).size;
    reading.adsetGoalAuthorityAdsets = [
      ...new Set(goal.filter(isAuthority).map((row) => text(row.adset_id)).filter((id): id is string => id !== null)),
    ].sort();
    const [coverageRow] = await db.query<Row>(D101_COVERAGE_AT_CUTOFFS_SQL, [
      businessId,
      binding.providerAccountId,
      binding.providerAccountRefId,
      ...coverageSlotParams([{ asOf, slot: "chain_cutoff", cutoff }]),
    ]);
    const expectedThroughDay = text(coverageRow?.expected_through_day);
    const coverageThroughDay = text(coverageRow?.coverage_through_day);
    reading.coverage = {
      status: classifyCoverage({ expectedThroughDay, coverageThroughDay }).status,
      expectedThroughDay,
      coverageThroughDay,
      accountTimezone: text(coverageRow?.account_timezone),
    };
  } catch (error) {
    reading.error = errorMessage(error);
    await assertTransactionAlive(db, "independent cross-check");
  }
  return reading;
}

async function runDecisionLane(input: {
  businessId: string;
  args: AcceptanceArgs;
}): Promise<{ decisions: DecisionLaneReport; presentation: PresentationLaneReport }> {
  const started = Date.now();
  const { businessId, args } = input;
  return inPinnedReadOnlyTransaction(async (db, snapshot) => {
    const flags: EngineV3Flags = await resolveEngineV3Flags(businessId);
    const policy = describeSimulationPolicy(flags);
    if (!flags.enabled) {
      return {
        decisions: {
          status: "skipped",
          reason: "engine_v3_disabled",
          snapshot,
          runtimeMs: Date.now() - started,
          policy: policy as unknown as Record<string, unknown>,
          days: [],
        },
        presentation: { status: "skipped", reason: "engine_v3_disabled", asOf: null, cutoff: null, accounts: [] },
      };
    }
    const bindings = await readSelectedBindings(db, businessId);
    const governance = await readEffectiveMetaWriteGovernance({ businessId });
    await assertTransactionAlive(db, "readEffectiveMetaWriteGovernance");

    const days: DecisionDayReport[] = [];
    let presentation: PresentationLaneReport = {
      status: "computed",
      reason: null,
      asOf: args.chain.at(-1)?.asOf ?? null,
      cutoff: args.chain.at(-1) ? nativeAdDecisionDay(args.chain.at(-1)!, args.cutoffMode).cutoff : null,
      accounts: [],
    };
    let carried = new Map<string, PreviousAdPublishedLabel>();
    let episodes = new Map<string, EpisodeMark>();
    for (const [index, knowledgeDay] of args.chain.entries()) {
      // D105's later knowledge instant is for independent source diagnostics.
      // Native Ad calibration, hydration and presentation remain on the
      // report-day boundary so their current-only calibration is never relabelled.
      const day = nativeAdDecisionDay(knowledgeDay, args.cutoffMode);
      const isLastDay = index === args.chain.length - 1;
      const timings: Record<string, number> = {};
      const mark = (stage: string, since: number) => {
        timings[stage] = Date.now() - since;
      };
      const dayReport: DecisionDayReport = {
        asOf: day.asOf,
        cutoff: day.cutoff,
        status: "failed",
        reason: null,
        timingsMs: timings,
        hashIntegrity: null,
        hysteresis: null,
        pointInTime: null,
        perAccount: [],
        hardRows: [],
      };
      days.push(dayReport);
      console.error(`    [decisions] ${day.asOf} (cutoff ${day.cutoff})`);
      try {
        let since = Date.now();
        const batches: NativeAdCalibrationBatch[] = [];
        const targets = new Map<string, NativeAdTargetAuthorityInput | null>();
        for (const binding of bindings) {
          const sourceRows = await db.query<Row>(READ_NATIVE_AD_CALIBRATION_SOURCE_SQL, [
            businessId,
            day.asOf,
            binding.providerAccountRefId,
            binding.providerAccountId,
            day.cutoff,
          ]);
          const [targetRow] = await db.query<Row>(READ_NATIVE_AD_TARGET_AUTHORITY_FOR_ACCOUNT_SQL, [
            businessId,
            binding.providerAccountRefId,
            binding.providerAccountId,
            day.cutoff,
          ]);
          const target = targetRow ? mapNativeAdTargetAuthorityRow(targetRow) : null;
          targets.set(`${binding.providerAccountRefId}\u0000${binding.providerAccountId}`, target);
          batches.push(
            computeNativeAdCalibrationBatch({
              businessId,
              providerAccountRefId: binding.providerAccountRefId,
              providerAccountId: binding.providerAccountId,
              asOf: day.asOf,
              computationCutoff: day.cutoff,
              sourceRows: sourceRows.map(mapNativeAdCalibrationSourceRow),
              targetAuthority: target,
              observedShopifyAovEvidence: null,
            }),
          );
        }
        mark("calibration", since);

        since = Date.now();
        const hydration = await new WarehouseDataSource().hydrateAdDecisionInputs({
          businessId,
          asOf: day.asOf,
          decisionCutoff: day.cutoff,
        });
        mark("hydration", since);
        const receipts = hydration.receipts.map(toSimulatedReceipt);
        try {
          assertEmptyNativeAdHydrationIsAuthoritative(hydration);
        } catch (error) {
          dayReport.reason = `hydration not authoritative: ${errorMessage(error)}`;
          dayReport.perAccount = receipts.map((receipt) =>
            accountDayReport({ providerAccountId: receipt.providerAccountId, entries: [], receipt, batches, campaignContextById: new Map(), independent: null }),
          );
          if (isLastDay) {
            presentation = { ...presentation, accounts: receipts.map((receipt) => ({
              providerAccountId: receipt.providerAccountId, asOf: day.asOf, cutoff: day.cutoff,
              status: "failed", receiptGate: { pass: false, failures: ["hydration_not_authoritative"] },
              refusal: dayReport.reason, validation: null, generation: null, identity: null, hierarchyAtCutoff: null,
              targetHardActionEligibility: null, modes: [], error: dayReport.reason,
            })) };
          }
          continue;
        }

        since = Date.now();
        const cells = batches.flatMap((batch, batchIndex) =>
          batch.cells.map((cell) => ({
            ...cell,
            batchId: simulatedCalibrationBatchId(batchIndex),
            batchCompleteness: "complete" as const,
          })),
        );
        const groups = await resolveNativeAdDecisionProfileGroups({
          businessId,
          asOf: day.asOf,
          adInputs: hydration.inputs,
          flags,
          dataSource: new InMemoryNativeProfileDataSource(cells, targets),
        });
        mark("profiles", since);

        since = Date.now();
        const campaignContextMode = resolveCampaignContextMode();
        const contextExclusions = new Map<string, CampaignContextPitExclusion>();
        const campaignContextById = await readAdCampaignContext({
          businessId,
          asOf: day.asOf,
          adInputs: hydration.inputs,
          mode: campaignContextMode,
          visibleAtCutoff: day.cutoff,
          pitExclusions: contextExclusions,
        });
        const adsetRoleByKey = await readAdAdsetRoles({
          businessId,
          asOf: day.asOf,
          adInputs: hydration.inputs,
          mode: campaignContextMode,
          campaignContextById,
          visibleAtCutoff: day.cutoff,
        });
        mark("campaign_context", since);

        since = Date.now();
        const persisted = new Map<string, PreviousAdPublishedLabel>();
        const persistedWithheld = new Map<string, PreviousLabelPitExclusion>();
        const keysInScope = new Set<string>();
        for (const scopeGroup of groupNativeProfileInputsByScope(groups)) {
          for (const ad of scopeGroup.adInputs) {
            keysInScope.add(
              adDecisionStabilityKey({
                businessId,
                providerAccountRefId: ad.providerAccountRefId,
                providerAccountId: ad.providerAccountId,
                decisionEntityType: "ad",
                decisionEntityId: ad.decisionEntityId,
                scopeType: scopeGroup.scope.type,
                scopeId: scopeGroup.scope.id,
              }),
            );
          }
          const rows = await readPreviousPublishedAdLabels(
            {
              businessId,
              asOf: day.asOf,
              identities: scopeGroup.adInputs.map((ad) => ({
                providerAccountRefId: ad.providerAccountRefId,
                providerAccountId: ad.providerAccountId,
                decisionEntityType: "ad" as const,
                decisionEntityId: ad.decisionEntityId,
              })),
              scopeType: scopeGroup.scope.type,
              scopeId: scopeGroup.scope.id,
              visibleAtCutoff: day.cutoff,
              pitExclusions: persistedWithheld,
            },
            db,
          );
          mergeUniqueMap(persisted, rows, "hysteresis lineage");
        }
        const prior = mergePriorLabelSources({ persisted, carried, persistedWithheld, keysInScope });
        mark("prior_labels", since);

        since = Date.now();
        const frequency = resolveNativeAdFrequencyPressureThresholdsByAccount(hydration.inputs);
        const scoped: ScopedDecision[] = [];
        for (const group of groups) {
          const dataHealth = buildNativeAdDataHealth({
            calibrationCell: group.calibrationCell,
            blocker: group.blocker,
            adInputs: group.adInputs,
            previousLabels: prior.labels,
            scope: group.profile.scope,
            evaluatedAt: day.cutoff,
          });
          const computations =
            group.blocker === null
              ? computeReadyNativeAdDecisions({
                  group,
                  businessId,
                  dataHealth,
                  campaignContextMode,
                  campaignContextById,
                  adsetRoleByKey,
                  previousLabels: prior.labels,
                  frequencyPressureThresholdByAccount: frequency,
                })
              : computeSoftOnlyNativeAdDecisions({
                  businessId,
                  blocker: group.blocker,
                  profile: group.profile,
                  adInputs: group.adInputs,
                  campaignContextMode,
                  campaignContextById,
                  adsetRoleByKey,
                  previousLabels: prior.labels,
                  evaluatedAt: day.cutoff,
                });
          for (const computation of computations) {
            const evaluation = buildSimulationEvaluation({
              computation,
              profile: group.profile,
              dataHealth,
              flags,
              evaluatedAt: day.cutoff,
            });
            const payload = toNativeSnapshotPayload({
              businessId,
              asOf: day.asOf,
              // ONE synthetic job run per business/account/cutoff, never per ad.
              jobRunId: simulatedJobRunId({
                businessId,
                providerAccountId: computation.input.providerAccountId,
                cutoff: day.cutoff,
              }),
              scope: group.profile.scope,
              computation,
              stored: {
                evaluationId: `read-only-simulation:evaluation:${evaluation.decisionHash}`,
                providerAccountRefId: computation.input.providerAccountRefId,
                providerAccountId: computation.input.providerAccountId,
                decisionEntityId: computation.input.decisionEntityId,
                inputHash: evaluation.inputHash,
                decisionHash: evaluation.decisionHash,
              },
              calibrationRowId: group.calibrationRowId,
              hardActionEligibility: group.profile.hardActionEligibility,
              computedAt: day.cutoff,
            });
            scoped.push({ scope: group.profile.scope, computation, evaluation, payload, group });
          }
        }
        mark("decide", since);

        const published = toCarriedPriorLabels({
          businessId,
          asOf: day.asOf,
          cutoff: day.cutoff,
          decisions: scoped,
        });
        let hashIntegrityVerified = false;
        try {
          const integrity = verifySimulationHashIntegrity(scoped, published);
          hashIntegrityVerified = integrity.canonicalHashesVerified === true;
          dayReport.hashIntegrity = { ...integrity };
        } catch (error) {
          dayReport.hashIntegrity = { canonicalHashesVerified: false, error: errorMessage(error) };
        }
        dayReport.hysteresis = {
          ...prior.counts,
          coldStart: keysInScope.size - prior.labels.size,
          hardVerdictsHeldForSecondEvaluation: scoped.filter((entry) => entry.computation.hysteresisSuppressed).length,
        };
        const [restated] = await db.query<Row>(COUNT_AD_DAYS_RESTATED_AFTER_CUTOFF_SQL, [businessId, day.asOf, day.cutoff]);
        dayReport.pointInTime = {
          campaignContextWithheldRewrittenAfterCutoff: contextExclusions.size,
          priorLabelsWithheldRewrittenAfterCutoff: persistedWithheld.size,
          adDaysRestatedAfterCutoff90d: { rows: num(restated?.rows), economicRows: num(restated?.economic_rows) },
          hydrationInputs: hydration.inputs.length,
          accountCoverageComplete: hydration.accountCoverageComplete,
        };
        const contextMap = campaignContextById as ReadonlyMap<string, unknown>;
        const accountIds = [...new Set([
          ...receipts.map((receipt) => receipt.providerAccountId),
          ...scoped.map((entry) => entry.payload.provider_account_id),
        ])];
        since = Date.now();
        const independentByAccount = new Map<string, IndependentReading>();
        for (const binding of bindings) {
          independentByAccount.set(
            binding.providerAccountId,
            await readIndependentAtCutoff({ db, businessId, binding, asOf: day.asOf, cutoff: day.cutoff }),
          );
        }
        mark("independent_cross_check", since);
        dayReport.perAccount = accountIds.map((providerAccountId) =>
          accountDayReport({
            providerAccountId,
            entries: scoped.filter((entry) => entry.payload.provider_account_id === providerAccountId),
            receipt: receipts.find((receipt) => receipt.providerAccountId === providerAccountId) ?? null,
            batches,
            campaignContextById: contextMap,
            independent: independentByAccount.get(providerAccountId) ?? null,
          }),
        );
        // Release proof must come from a currently delivering hierarchy at
        // this cutoff. The producer also evaluates archived ads, so its raw
        // hard-row count alone cannot prove a useful live recommendation.
        const hardEntries = scoped.filter((entry) => isHardRowEntry(entry));
        const hardIdentityByAd = new Map<string, Partial<SimulatedIdentity>>();
        for (const receipt of receipts) {
          const entries = hardEntries.filter((entry) =>
            entry.payload.provider_account_id === receipt.providerAccountId &&
            entry.payload.provider_account_ref_id === receipt.providerAccountRefId,
          );
          if (entries.length === 0) continue;
          const identities = await db.query<Row>(IDENTITY_AT_CUTOFF_SQL, [
            businessId, receipt.providerAccountId,
            entries.map((entry) => entry.payload.ad_id),
            entries.map((entry) => entry.payload.creative_id),
            day.asOf, receipt.providerAccountRefId, day.cutoff,
          ]);
          for (const identity of identities) {
            hardIdentityByAd.set(
              `${receipt.providerAccountId}\u0000${text(identity.ad_id) ?? ""}`,
              identityFromRow(identity),
            );
          }
        }
        dayReport.hardRows = hardEntries.map((entry) => toHardRowRecord({
          asOf: day.asOf, entry, campaignContextById: contextMap,
          identityAtCutoff: hardIdentityByAd.get(`${entry.payload.provider_account_id}\u0000${entry.payload.ad_id}`),
        }));
        dayReport.status = "computed";

        // Episodes advance on every computed day, so a later day's episode start is chain-derived.
        const nextEpisodes = new Map(episodes);
        if (isLastDay) {
          since = Date.now();
          const accounts: PresentationAccountReport[] = [];
          for (const receipt of receipts) {
            try {
              const presented = await presentAccount({
                db,
                businessId,
                asOf: day.asOf,
                cutoff: day.cutoff,
                receipt,
                scoped,
                priorEpisodes: episodes,
                hashIntegrityVerified,
                governance: governance as unknown as MetaDecisionExecutionGovernanceFacts & Record<string, unknown>,
                adLimits: args.adLimits,
              });
              accounts.push(presented.report);
            } catch (error) {
              accounts.push({
                providerAccountId: receipt.providerAccountId, asOf: day.asOf, cutoff: day.cutoff,
                status: "failed", receiptGate: { pass: false, failures: [] }, refusal: null, validation: null,
                generation: null, identity: null, hierarchyAtCutoff: null, targetHardActionEligibility: null, modes: [], error: errorMessage(error),
              });
              await assertTransactionAlive(db, `presentation of ${receipt.providerAccountId}`);
            }
          }
          presentation = { ...presentation, accounts };
          mark("presentation", since);
        } else {
          for (const entry of scoped) {
            const key = `${entry.payload.provider_account_id}\u0000${entry.payload.ad_id}`;
            const previous = episodes.get(key);
            nextEpisodes.set(key, {
              label: entry.payload.label,
              start: previous && previous.label === entry.payload.label ? previous.start : entry.payload.as_of_date,
            });
          }
        }
        episodes = nextEpisodes;
        carried = new Map([...carried, ...published]);
      } catch (error) {
        dayReport.status = "failed";
        dayReport.reason = errorMessage(error);
        await assertTransactionAlive(db, `decision day ${day.asOf}`, error);
      }
    }
    return {
      decisions: {
        status: "computed",
        reason: null,
        snapshot,
        runtimeMs: Date.now() - started,
        policy: {
          ...(policy as unknown as Record<string, unknown>),
          campaignContextMode: resolveCampaignContextMode(),
          engineVersion: NATIVE_AD_ENGINE_VERSION,
          governanceReadAt: "harness_run_time_current_state",
          governance,
        },
        days,
      },
      presentation,
    };
  });
}

/* ================================================ persisted-served lane */

const GENERATION_COUNTS_SQL = `
SELECT
  s.engine_version,
  to_char(s.as_of_date, 'YYYY-MM-DD') AS as_of_date,
  COUNT(*)::int AS rows,
  COUNT(*) FILTER (WHERE s.raw_label IN ('scale', 'cut', 'refresh'))::int AS raw_hard,
  COUNT(*) FILTER (WHERE s.label IN ('scale', 'cut', 'refresh'))::int AS published_hard,
  COUNT(*) FILTER (WHERE s.authorized_action IS NOT NULL)::int AS authorized,
  COUNT(*) FILTER (WHERE s.blocked_action_type IS NOT NULL)::int AS held,
  to_char(MIN(s.computed_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS min_computed_at,
  to_char(MAX(s.computed_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS max_computed_at
FROM engine_v3_ad_decision_snapshots_daily s
WHERE s.business_id = $1
  AND s.provider_account_id = $2
  AND s.job_run_id = $3::uuid
  AND s.as_of_date = $4::date
  AND s.decision_entity_type = 'ad'
GROUP BY 1, 2`;

const GENERATION_LABELS_SQL = `
SELECT s.label, s.raw_label, s.authority_blocker, s.blocked_action_type, COUNT(*)::int AS n
FROM engine_v3_ad_decision_snapshots_daily s
WHERE s.business_id = $1
  AND s.provider_account_id = $2
  AND s.job_run_id = $3::uuid
  AND s.as_of_date = $4::date
  AND s.decision_entity_type = 'ad'
GROUP BY 1, 2, 3, 4
ORDER BY 5 DESC`;

async function runPersistedServedLane(input: { businessId: string }): Promise<PersistedServedLaneReport> {
  const started = Date.now();
  const { businessId } = input;
  return inPinnedReadOnlyTransaction(async (db, snapshot) => {
    const now = new Date();
    const servingInstant = now.toISOString();
    const servingDay = servingInstant.slice(0, 10);
    const accounts: PersistedServedAccountReport[] = [];
    for (const binding of await readSelectedBindings(db, businessId)) {
      const bundle = await readValidatedMetaNativeDecisionGenerationBundle({
        businessId,
        providerAccountId: binding.providerAccountId,
        generatedAt: servingInstant,
        allowLastSuccessfulGenerationFallback: true,
      });
      await assertTransactionAlive(db, "readValidatedMetaNativeDecisionGenerationBundle");
      // The production reader's own query and parameters (readNativeGeneration).
      const generationRows = await db.query<Row>(READ_NATIVE_DECISION_GENERATION_QUERY, [
        businessId,
        binding.providerAccountId,
        AD_DECISIONS_JOB_NAME,
        null,
        NATIVE_AD_ENGINE_VERSION,
        servingDay,
        NATIVE_DECISION_LAST_SUCCESS_MAX_AGE_DAYS,
      ]);
      const latest = generationRows.find((row) => row.selection === "latest") ?? null;
      let latestGenerationCounts: Record<string, unknown> | null = null;
      if (latest && text(latest.job_run_id) && text(latest.as_of_date)) {
        const params = [businessId, binding.providerAccountId, text(latest.job_run_id), text(latest.as_of_date)];
        const [counts] = await db.query<Row>(GENERATION_COUNTS_SQL, params);
        const labels = await db.query<Row>(GENERATION_LABELS_SQL, params);
        latestGenerationCounts = {
          engineVersion: text(counts?.engine_version),
          asOfDate: text(counts?.as_of_date),
          rows: num(counts?.rows),
          rawHard: num(counts?.raw_hard),
          publishedHard: num(counts?.published_hard),
          authorized: num(counts?.authorized),
          held: num(counts?.held),
          minComputedAt: text(counts?.min_computed_at),
          maxComputedAt: text(counts?.max_computed_at),
          byLabel: labels.map((row) => ({
            label: text(row.label),
            rawLabel: text(row.raw_label),
            authorityBlocker: text(row.authority_blocker),
            blockedActionType: text(row.blocked_action_type),
            n: num(row.n),
          })),
        };
      }
      let workspace: Record<string, unknown> | null = null;
      try {
        const model = await readMetaDecisionsWorkspaceReadModel({
          businessId,
          providerAccountId: binding.providerAccountId,
          asOfDate: text(latest?.as_of_date) ?? servingDay,
          generatedAt: servingInstant,
          adCandidateLimit: 60,
        });
        await assertTransactionAlive(db, "readMetaDecisionsWorkspaceReadModel");
        workspace = {
          asOfDateBasis: "latest native job as_of_date (approximates the route's D090 end date)",
          status: model.status,
          sourceStatus: model.source?.status ?? null,
          authority: model.source?.authority ?? null,
          fallbackReason: model.source?.fallbackReason ?? null,
          engineVersion: model.source?.engineVersion ?? null,
          snapshotAsOf: model.source?.snapshotAsOf ?? null,
          adCandidatesSelected: model.queue?.adCandidates?.selectedCount ?? null,
          adCandidatesPreCap: model.queue?.adCandidates?.preCapCount ?? null,
          inactive: model.queue?.inactiveAssets?.preCapCount ?? null,
        };
      } catch (error) {
        workspace = { error: errorMessage(error) };
        await assertTransactionAlive(db, "readMetaDecisionsWorkspaceReadModel (failed)", error);
      }
      accounts.push({
        providerAccountId: binding.providerAccountId,
        bundle: {
          status: bundle.status,
          unavailableReason: bundle.unavailableReason,
          validationIssue: bundle.validationIssue ?? null,
          degraded: bundle.status === "available" && Boolean(bundle.sourceDegradation),
        },
        latestRow: latest
          ? {
              job_run_id: text(latest.job_run_id),
              job_status: text(latest.job_status),
              engine_version: text(latest.engine_version),
              as_of_date: text(latest.as_of_date),
              // NULL stays null: the pre_deploy gate requires both counts, never 0 == 0.
              expected_ad_count: numOrNull(latest.expected_ad_count),
              hydrated_ad_count: numOrNull(latest.hydrated_ad_count),
              manifest_matches: text(latest.expected_manifest_hash) !== null && latest.expected_manifest_hash === latest.hydrated_manifest_hash,
              authoritative_for_prune: latest.authoritative_for_prune === true || latest.authoritative_for_prune === "true",
            }
          : null,
        headEngineVersion: NATIVE_AD_ENGINE_VERSION,
        latestEngineMatchesHead: latest ? text(latest.engine_version) === NATIVE_AD_ENGINE_VERSION : null,
        latestGenerationCounts,
        workspace,
      });
    }
    return { status: "computed", snapshot, runtimeMs: Date.now() - started, servingInstant, accounts };
  });
}

/* ============================================= negative-control check */

const CAMPAIGN_ACCOUNTS_SQL = `
SELECT d.provider_account_id,
  (ARRAY_AGG(NULLIF(BTRIM(d.account_timezone), '') ORDER BY d.date DESC) FILTER (WHERE NULLIF(BTRIM(d.account_timezone), '') IS NOT NULL))[1] AS account_timezone,
  COUNT(*)::int AS ad_days,
  COUNT(*) FILTER (WHERE d.spend > 0)::int AS spend_positive_ad_days,
  COUNT(*) FILTER (WHERE d.date = ANY($5::date[]))::int AS target_day_ad_days
FROM meta_ad_daily d
WHERE d.business_id = $1
  AND d.campaign_id = $2
  AND d.date BETWEEN $3::date AND $4::date
GROUP BY 1`;

const CAMPAIGN_DAY_SCOPE_SQL = `
SELECT $2::text AS provider_account_id, $6::text AS campaign_id, day::date AS date, $7::text AS account_timezone
FROM generate_series($3::date, $4::date, INTERVAL '1 day') AS day`;

const PERSISTED_CAMPAIGN_HARD_ROWS_SQL = `
SELECT s.ad_id, s.raw_label, s.label, s.pre_authority_label, s.authority_blocker,
  s.blocked_action_type, s.authorized_action, to_char(s.as_of_date, 'YYYY-MM-DD') AS as_of_date, s.engine_version
FROM engine_v3_ad_decision_snapshots_daily s
WHERE s.business_id = $1
  AND s.provider_account_id = $2
  AND s.job_run_id = $3::uuid
  AND s.as_of_date = $4::date
  AND (s.raw_label IN ('scale', 'cut', 'refresh') OR s.pre_authority_label IN ('scale', 'cut', 'refresh'))
  AND EXISTS (
    SELECT 1 FROM meta_ad_dimensions ad
    WHERE ad.business_id = s.business_id AND ad.provider_account_id = s.provider_account_id
      AND ad.ad_id = s.ad_id AND ad.campaign_id = $5
  )
ORDER BY s.ad_id`;

async function runNegativeControlCheck(input: {
  businessId: string;
  args: AcceptanceArgs;
  decisions: DecisionLaneReport | LaneFailure;
  persisted: PersistedServedLaneReport | LaneFailure;
}): Promise<NegativeControlReport> {
  const { businessId, args } = input;
  // Nothing hard-coded: the campaign is --negative-control-campaign, the dates are the --window,
  // and the target days are the --chain days.
  const campaignId = args.negativeControlCampaign;
  if (campaignId === null) throw new Error("--negative-control-campaign is required with --negative-control");
  const from = args.window.start;
  const to = args.window.end;
  const windowEndCutoff = args.chain.at(-1)?.cutoff ?? endOfUtcDayCutoff(args.window.end);
  const targetDays = args.chain.map((day) => day.asOf);
  return inPinnedReadOnlyTransaction(async (db, snapshot) => {
    const accounts = await db.query<Row>(CAMPAIGN_ACCOUNTS_SQL, [businessId, campaignId, from, to, targetDays]);
    const objectiveByDay: NegativeControlReport["objectiveByDay"] = [];
    const objectiveAtTargetCutoffs: NegativeControlReport["objectiveAtTargetCutoffs"] = [];
    for (const account of accounts) {
      const providerAccountId = text(account.provider_account_id) ?? "";
      const timezone = text(account.account_timezone) ?? "UTC";
      const rows = await db.query<Row>(buildObjectiveTierSql(CAMPAIGN_DAY_SCOPE_SQL), [
        businessId,
        providerAccountId,
        from,
        to,
        windowEndCutoff,
        campaignId,
        timezone,
      ]);
      for (const row of rows) {
        const classification = classifyConfigTier(row.tier);
        objectiveByDay.push({
          day: text(row.date) ?? "",
          tier: classification.tier,
          readiness: classification.readiness,
          value: text(row.value),
          pitClass: text(row.pit_class),
        });
      }
      // Each report day reads at its own knowledge cutoff. In replay mode that
      // instant is later than the report day and is not backdated evidence.
      for (const day of args.chain) {
        const [row] = await db.query<Row>(buildObjectiveTierSql(CAMPAIGN_DAY_SCOPE_SQL), [
          businessId,
          providerAccountId,
          day.asOf,
          day.asOf,
          day.cutoff,
          campaignId,
          timezone,
        ]);
        if (!row) continue;
        const classification = classifyConfigTier(row.tier);
        const sqlReadiness = text(row.readiness);
        objectiveAtTargetCutoffs.push({
          day: day.asOf,
          cutoff: day.cutoff,
          providerAccountId,
          tier: classification.tier,
          // Either reading granting authority counts as authority: the control must see none.
          readiness: sqlReadiness === "decision_authority" ? "decision_authority" : classification.readiness,
        });
      }
    }
    const simulatedHardRows = "days" in input.decisions
      ? input.decisions.days.flatMap((day) => day.hardRows.filter((row) => row.campaignId === campaignId))
      : [];
    const persistedHardRows: Array<Record<string, unknown>> = [];
    if ("accounts" in input.persisted) {
      for (const account of input.persisted.accounts) {
        const jobRunId = text(account.latestRow?.job_run_id);
        const asOf = text(account.latestRow?.as_of_date);
        if (!jobRunId || !asOf) continue;
        const rows = await db.query<Row>(PERSISTED_CAMPAIGN_HARD_ROWS_SQL, [
          businessId, account.providerAccountId, jobRunId, asOf, campaignId,
        ]);
        persistedHardRows.push(...rows.map((row) => ({ providerAccountId: account.providerAccountId, ...row })));
      }
    }
    return {
      campaignId,
      from,
      to,
      snapshot,
      targetDays,
      campaignFound: accounts.some((account) => num(account.ad_days) > 0),
      campaignAccounts: accounts.map((account) => ({
        providerAccountId: text(account.provider_account_id) ?? "",
        adDays: num(account.ad_days),
        spendPositiveAdDays: num(account.spend_positive_ad_days),
        targetDayAdDays: num(account.target_day_ad_days),
      })),
      objectiveByDay,
      objectiveAtTargetCutoffs,
      decisionAuthorityDays: objectiveByDay
        .filter((row) => row.readiness === "decision_authority")
        .map((row) => row.day),
      simulatedHardRows,
      simulatedAuthorizedActions: simulatedHardRows.filter((row) => row.authorizedAction !== null).length,
      persistedHardRows,
    };
  });
}

/* ================================================================= main */

function runtimeGuard(): string | null {
  return evaluateRuntimeGuard({
    tzEnv: process.env.TZ,
    timezoneOffsetMinutes: new Date().getTimezoneOffset(),
    resolvedZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    pgOptions: process.env.PGOPTIONS,
  });
}

async function assertSessionReadOnly(): Promise<void> {
  await runDbTransaction(
    async () => {
      const rows = await getDb().query<Row>("SHOW default_transaction_read_only");
      if (String(rows[0]?.default_transaction_read_only ?? "").toLowerCase() !== "on") {
        throw new ReadOnlyGuardError("SHOW default_transaction_read_only is not on.");
      }
    },
    { timeoutMs: 30_000 },
  );
}

async function runBusiness(input: {
  businessId: string;
  role: "subject" | "negative_control";
  args: AcceptanceArgs;
  resolverApprovedVersion: string | null;
}): Promise<BusinessAcceptanceReport> {
  const { businessId, role, args } = input;
  console.error(`business ${businessId} (${role})`);
  const ledger = await safeLane("ledger", () =>
    runLedgerLane({ businessId, args, resolverApprovedVersion: input.resolverApprovedVersion }),
  );
  let decisions: DecisionLaneReport | LaneFailure;
  let presentation: PresentationLaneReport | LaneFailure;
  if (args.skipDecisions) {
    decisions = { status: "skipped", reason: "--skip-decisions", snapshot: null, runtimeMs: 0, policy: null, days: [] };
    presentation = { status: "skipped", reason: "--skip-decisions", asOf: null, cutoff: null, accounts: [] };
  } else {
    const lane = await safeLane("decisions+presentation", () => runDecisionLane({ businessId, args }));
    if ("error" in lane) {
      decisions = lane;
      presentation = lane;
    } else {
      decisions = lane.decisions;
      presentation = lane.presentation;
    }
  }
  const persistedServed = await safeLane("persisted-served", () => runPersistedServedLane({ businessId }));
  const negativeControl =
    role === "negative_control"
      ? await safeLane("negative-control", () =>
          runNegativeControlCheck({ businessId, args, decisions, persisted: persistedServed }),
        )
      : null;
  return { businessId, role, ledger, decisions, presentation, persistedServed, negativeControl };
}

function printSummary(
  report: AcceptanceReport,
  evaluation: ReturnType<typeof evaluateAcceptanceInvariants>,
  release: ReleaseGatesReport,
) {
  const rows = summarizeReport(report);
  console.log(`\n${ACCEPTANCE_CONTRACT_VERSION}  MODE ${report.mode.toUpperCase()}  GATE ${report.args.gate}  window ${report.args.window.start}..${report.args.window.end}  cutoff mode ${report.args.cutoffMode}  chain ${report.args.chain.map((day) => day.cutoff).join(",")}  runtime ${(report.runtimeMs / 1000).toFixed(1)}s`);
  for (const row of rows) {
    console.log(`\n[${row.business} ${row.role}] lanes(ledger,decisions,presentation,persisted)=${row.lanes}`);
    console.log(`  accounts ${row.accounts} | ad-days ${row.adDays} | link-click missing ${row.lcMissing} | purchases zero w/o actions ${row.purchZeroNoKey}`);
    console.log(`  objective decision-authority campaign-days ${row.objectiveAuthority} | D101 complete run slots ${row.covCompleteSlots} | Meta AOV/purchases ${row.aov}`);
    console.log(`  decisions: ${row.days}`);
    console.log(`  presentation ${row.lastDay}: ${row.presented} ${row.served}`);
    console.log(`  persisted-served: ${row.persisted}`);
  }
  const printFindings = (title: string, findings: readonly InvariantFinding[]) => {
    console.log(`\n${title} (${findings.length})`);
    for (const finding of findings) {
      const where = [finding.businessId.slice(0, 8), finding.providerAccountId, finding.asOf].filter(Boolean).join(" ");
      const count = finding.count !== undefined ? ` n=${finding.count}` : "";
      console.log(`  - ${finding.code} [${where}]${count}: ${finding.detail.slice(0, 220)}${finding.sample?.length ? ` e.g. ${finding.sample.slice(0, 3).join(",")}` : ""}`);
    }
  };
  const provenance = report.provenance;
  if (provenance) {
    console.log(`\nPROVENANCE: git HEAD ${provenance.gitHead ?? "unknown"}; certifies ${provenance.certifies}`);
    console.log(
      `  git status --porcelain: ${provenance.gitStatusPorcelain.length} entries; loaded repo modules ${provenance.loadedRepoModules} (${provenance.moduleEnumeration}); dirty loaded ${provenance.dirtyLoadedModules.length}, of which production ${provenance.dirtyProductionModules.length}; --require-clean ${provenance.requireClean}`,
    );
    for (const line of provenance.gitStatusPorcelain) console.log(`    ${line}`);
    for (const module of provenance.dirtyLoadedModules) {
      console.log(`  dirty loaded ${module.production ? "production" : "script    "} ${module.status} ${module.path} sha256 ${module.sha256 ?? "(unreadable)"}`);
    }
    for (const change of provenance.changedDuringRun) console.log(`  changed during run: ${change}`);
  }
  printFindings("INVARIANT VIOLATIONS", evaluation.violations);
  printFindings("LANE FAILURES", evaluation.laneFailures);
  printFindings("OBSERVATIONS (source gaps, expected)", evaluation.observations);
  for (const gate of ["pre_deploy", "post_deploy"] as const) {
    const verdict = release.gates[gate];
    const selected = gate === release.selectedGate ? "  <- exit code follows this gate" : "";
    console.log(`\n${verdict.label} [${gate}, mode ${verdict.mode}; negative control ${verdict.negativeControl}]${selected}`);
    console.log(`  certifies: ${verdict.certifies}`);
    for (const business of verdict.businesses) {
      console.log(
        `  [${business.businessId.slice(0, 8)} ${business.role}] ${business.accepted ? "met" : "NOT met"}: successful days ${business.successfulDecisionDays.join(",") || "none"}; failed days ${business.failedDecisionDays.join(",") || "none"}; presented ${business.presentedAccounts.join(",") || "none"}; failed presentations ${business.failedPresentations.join(",") || "none"}; persisted available ${business.persistedServedAvailable.join(",") || "none"}; unavailable ${business.persistedServedUnavailable.join(",") || "none"}`,
      );
      if (business.presence) {
        console.log(
          `    presence: decisions on successful days ${business.presence.decisionsOnSuccessfulDays}; accounts with presence ${business.presence.accountsWithPresence.join(",") || "none"}`,
        );
        for (const record of business.presence.accounts) {
          console.log(
            `    ${record.providerAccountId}: decision rows ${record.decisionRows} | ledger ad-days ${record.ledgerAdDays} (${record.ledgerSpendPositiveAdDays} spend>0) | inventory ${record.inventoryItems} (source-backed ${record.sourceBackedInventoryItems}) | briefing ${record.briefingCards} cards / ${record.servedClassifications} classifications | OS@${record.smallestAdLimit ?? "?"} ${record.osItemsAtSmallestLimit} rows | source-backed ads presented ${record.sourceBackedPresentedAds}${record.missing.length > 0 ? ` | MISSING ${record.missing.join(",")}` : ""}`,
          );
          console.log(`      ${describeBriefingVersusOs(record)}`);
        }
      }
      const control = business.negativeControl;
      if (control) {
        console.log(
          `    negative control ${control.met ? "MET" : "NOT MET"}: campaign ${control.campaignId ?? "?"} ad-days ${control.campaignAdDays} (${control.campaignSpendPositiveAdDays} spend>0, ${control.campaignTargetDayAdDays} on target days) on ${control.campaignAccountsSelected.join(",") || "no selected account"}; objective on target days ${control.objectiveOnTargetDays.map((entry) => `${entry.day}:${entry.readiness.join("/") || "unevaluated"}`).join(" ") || "none"}; unauthorized hard evidence simulated ${control.unauthorizedHardEvidence.simulated} / persisted ${control.unauthorizedHardEvidence.persisted}`,
        );
      }
    }
    for (const failure of verdict.failures) console.log(`  - ${failure.slice(0, 600)}`);
  }
  // Side by side, so a presence PASS can never read as a source-authorized hard action.
  const selected = release.gates[release.selectedGate];
  console.log("");
  for (const outcome of release.hardAuthorityOutcome) {
    const business = selected.businesses.find((entry) => entry.businessId === outcome.businessId);
    const presence = selected.mode === "diagnostic" ? "DIAGNOSTIC" : business?.accepted ? "PASS" : "NOT MET";
    console.log(
      `[${outcome.businessId.slice(0, 8)}] PRESENCE (${release.selectedGate}): ${presence} | HARD AUTHORITY: ${describeHardAuthority(outcome)}${release.requireHardAuthority ? "  [--require-hard-authority]" : "  [reported only; exit code unaffected]"}`,
    );
    for (const day of outcome.days) {
      console.log(
        `    ${day.asOf} @ ${day.cutoff}: ${day.status}; raw ${day.rawHard}, pre ${day.preAuthorityHard}, held ${day.held}, authorized ${day.authorized}, source-authorized ${day.authorizedGrounded}; effective blockers ${JSON.stringify(day.effectiveBlockers)}`,
      );
    }
  }
}

/* ============================================================ provenance */

/** A read-only git command (rev-parse / status with optional locks off); null when git is unavailable. */
function gitReadOnly(args: readonly string[], cwd: string): string | null {
  try {
    return execFileSync("git", ["--no-optional-locks", ...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

function repoRootOf(): string | null {
  const root = gitReadOnly(["rev-parse", "--show-toplevel"], process.cwd());
  return root ? root.trim() : null;
}

/** Repository-relative paths of every loaded repo module (CommonJS require.cache under tsx). */
function loadedRepoModules(repoRoot: string): string[] | null {
  const cache = typeof require === "undefined" ? undefined : require.cache;
  if (!cache) return null;
  return Object.keys(cache)
    .filter((file) => file.startsWith(`${repoRoot}${path.sep}`) && !file.includes(`${path.sep}node_modules${path.sep}`))
    .map((file) => path.relative(repoRoot, file).split(path.sep).join("/"))
    .sort();
}

function captureProvenance(repoRoot: string | null): ProvenanceSnapshot {
  if (!repoRoot) {
    return { gitHead: null, porcelainLines: [], dirty: new Map(), loadedModules: null, hashes: new Map() };
  }
  const gitHead = gitReadOnly(["rev-parse", "HEAD"], repoRoot)?.trim() || null;
  const porcelainZ = gitReadOnly(["status", "--porcelain=v1", "-z", "--untracked-files=all"], repoRoot) ?? "";
  const dirty = parseGitPorcelainZ(porcelainZ);
  const porcelainLines = [...dirty.entries()].map(([file, status]) => `${status} ${file}`);
  const loadedModules = loadedRepoModules(repoRoot);
  const hashes = new Map<string, string | null>();
  const candidates = loadedModules === null ? [...dirty.keys()] : loadedModules.filter((module) => dirty.has(module));
  for (const module of candidates) {
    try {
      hashes.set(module, sha256Hex(readFileSync(path.join(repoRoot, module))));
    } catch {
      hashes.set(module, null);
    }
  }
  return { gitHead, porcelainLines, dirty, loadedModules, hashes };
}

async function main(): Promise<number> {
  let args: AcceptanceArgs;
  const repoRoot = repoRootOf();
  try {
    args = parseAcceptanceArgs(process.argv.slice(2), new Date(), {
      repoRoot,
      cwd: process.cwd(),
      pathExists: (file) => existsSync(file),
    });
  } catch (error) {
    console.error(error instanceof AcceptanceUsageError ? `usage: ${error.message}` : errorMessage(error));
    return 2;
  }
  configureOperationalScriptRuntime({ lane: "read_only_observation" });
  // lib/db prints its pool settings as "[startup]" console.info; keep stdout to the summary.
  const originalInfo = console.info;
  console.info = (...values: unknown[]) => {
    if (typeof values[0] === "string" && values[0].startsWith("[startup]")) return;
    originalInfo(...values);
  };
  const guard = runtimeGuard();
  if (guard) {
    console.error(`refused: ${guard}`);
    return 2;
  }
  try {
    await assertSessionReadOnly();
  } catch (error) {
    console.error(`refused: read-only guard failed: ${errorMessage(error)}`);
    return 2;
  }

  // Every static import is loaded by now: this is the code the run executes.
  const provenanceAtStart = captureProvenance(repoRoot);
  const started = Date.now();
  const resolverApprovedVersion = campaignContextAuthorityResolverVersion();
  const businesses: BusinessAcceptanceReport[] = [];
  for (const businessId of args.businesses) {
    businesses.push(await runBusiness({ businessId, role: "subject", args, resolverApprovedVersion }));
  }
  if (args.negativeControl) {
    businesses.push(
      await runBusiness({ businessId: args.negativeControl, role: "negative_control", args, resolverApprovedVersion }),
    );
  }
  const report: AcceptanceReport = {
    contract: ACCEPTANCE_CONTRACT_VERSION,
    mode: args.mode,
    generatedAt: new Date().toISOString(),
    runtimeMs: Date.now() - started,
    args: { ...args },
    runtime: {
      tz: process.env.TZ ?? null,
      sessionDefaultReadOnly: true,
      headNativeAdEngineVersion: NATIVE_AD_ENGINE_VERSION,
      campaignContextMode: resolveCampaignContextMode(),
      ...describeResolverArming({
        approvedVersion: resolverApprovedVersion,
        requiredVersion: CAMPAIGN_CONTEXT_RESOLVER_VERSION,
      }),
      nodeVersion: process.version,
    },
    claims: ACCEPTANCE_CLAIMS,
    provenance: null,
    businesses,
  };
  const provenanceAtEnd = captureProvenance(repoRoot);
  report.provenance = summarizeProvenance({
    gitHead: provenanceAtStart.gitHead,
    porcelainLines: provenanceAtStart.porcelainLines,
    dirty: provenanceAtStart.dirty,
    loadedModules: provenanceAtStart.loadedModules,
    hashes: provenanceAtStart.hashes,
    changedDuringRun: diffProvenanceSnapshots(provenanceAtStart, provenanceAtEnd),
    requireClean: args.requireClean,
  });
  const evaluation = evaluateAcceptanceInvariants(report);
  // The UUID-shaped in-memory calibration batch id must never reach the report.
  const leaked = findLeakedCalibrationBatchIds(JSON.stringify(report));
  if (leaked.length > 0) {
    evaluation.violations.push({
      code: "synthetic_calibration_batch_id_leaked",
      businessId: "-",
      count: leaked.length,
      detail: "a complete in-memory calibration batch id appears in the report",
      sample: leaked.slice(0, 5),
    });
  }
  const release = evaluateReleaseGates(report, args.gate);
  let exitCode: number = decideExitCode({ invariants: evaluation, release: release.gates[args.gate] });
  const output = { ...report, invariants: evaluation, releaseGates: release, exitCode };
  if (args.write && args.outPath) {
    try {
      // "wx": never overwrite; the parser already refused an existing path and one inside the repository.
      writeFileSync(args.outPath, `${JSON.stringify(output, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      console.error(`report written: ${args.outPath}`);
    } catch (error) {
      console.error(`report NOT written: ${errorMessage(error)}`);
      if (exitCode === 0) exitCode = 3;
    }
  } else if (args.outPath) {
    console.error(`report NOT written: --write 1 is required with --out`);
  }
  printSummary(report, evaluation, release);
  console.log(`\nexit ${exitCode}: ${ACCEPTANCE_CLAIMS.exitCodes[String(exitCode) as keyof typeof ACCEPTANCE_CLAIMS.exitCodes]}`);
  return exitCode;
}

const invokedPath = process.argv[1] ?? "";
if (invokedPath.endsWith("meta-decisions-creatives-acceptance.ts")) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      // A crash proves nothing: never exit 0, and never report it as a violation (1).
      console.error(errorMessage(error));
      process.exit(error instanceof ReadOnlyGuardError ? 2 : 3);
    });
}
