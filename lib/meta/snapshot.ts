import type { MetaBreakdownsResponse } from "@/app/api/meta/breakdowns/route";
import { getProviderAccountAssignments } from "@/lib/provider-account-assignments";
import type { MetaCampaignRow } from "@/app/api/meta/campaigns/route";
import type { MetaAdSetData } from "@/lib/api/meta";
import { getDb } from "@/lib/db";
import { getDbSchemaReadiness } from "@/lib/db-schema-readiness";
import { getActiveBusinesses } from "@/lib/sync/active-businesses";
import { getMetaAdSetsForRange } from "@/lib/meta/adsets-source";
import { getMetaBreakdownsForRange } from "@/lib/meta/breakdowns-source";
import { getMetaCampaignsForRange } from "@/lib/meta/campaigns-source";
import { readMetaBidRegimeHistorySummaries } from "@/lib/meta/config-snapshots";
import { META_WAREHOUSE_HISTORY_DAYS } from "@/lib/meta/history";
import {
  getMetaCalibrationScope,
  runMetaCalibrationForBusiness,
  type RunMetaCalibrationResult,
} from "@/lib/meta/calibration";
import { metaConfidenceBucket } from "@/lib/meta/confidence-thresholds";
import {
  readPreviousMetaDecisionStates,
  stabilizeMetaRecommendations,
} from "@/lib/meta/decision-stability";
import {
  deliveryConstrainedAdsetIdsFrom,
  detectAnomaliesForBusiness,
  type MetaAnomaly,
  type MetaAnomalySeverity,
} from "@/lib/meta/anomalies";
import {
  buildEvidenceTrailsForRecommendations,
  type MetaEvidenceTrail,
} from "@/lib/meta/evidence-trail";
import { produceRetainedAccountProfileOutputs } from "@/lib/meta/account-profile-output-producer";
import { restampProposedActions } from "@/lib/meta/recommendations";
import { buildMetaAdsetRecommendations } from "@/lib/meta/adset-decisions";
import { projectMetaAutomationProposals } from "@/lib/meta/automation-proposals";
import {
  insertBudgetProposalRow,
  projectMetaBudgetProposals,
} from "@/lib/meta/budget-proposal-producer";
import {
  insertBidProposalRow,
  projectMetaBidProposals,
} from "@/lib/meta/bid-proposal-producer";
import { projectMetaLaunchIntents } from "@/lib/meta/launch-intent-producer";
import {
  insertLaunchProposalRow,
  projectMetaLaunchProposals,
} from "@/lib/meta/launch-proposal-producer";
import {
  insertActivationProposalRow,
  projectMetaActivationProposals,
} from "@/lib/meta/activation-proposal-producer";
import { loadBudgetCompositionSourcesForCandidate }
  from "@/lib/meta/budget-proposal-source-loader";
import { buildMetaEntityStateRows } from "@/lib/meta/engine-v1/state-rows";
import type { MetaCampaignKind } from "@/lib/meta/campaign-label-types";
import {
  applyMetaCampaignLabelGuard,
  type MetaCampaignContextGuardEntry,
  type MetaCampaignContextGuardMap,
  type MetaCampaignLabelKindMap,
} from "@/lib/meta/campaign-label-guard";
import {
  readCampaignContextLabelMap,
  resolveCampaignContextMode,
} from "@/lib/creative-decision-engine/campaign-context/source";
import { readMetaEntityDecisionSignalsDaily } from "@/lib/meta/entity-signals";
import { runMetaSignalsBackfillForBusiness } from "@/lib/meta/entity-signals-backfill";
import { attachMetaEmpiricalOutcomeSummariesFromLogs } from "@/lib/meta/empirical-outcome-integration";
import { decisionLabelForMetaRec } from "@/lib/meta/rec-label-mapping";
import {
  buildMetaRecommendations,
  META_RECOMMENDATION_ENGINE_VERSION,
  type MetaCalibrationContext,
  type MetaDecisionSummary,
  type MetaRecommendation,
  type MetaRecommendationConfidence,
  type MetaRecommendationLevel,
  type MetaRecommendationLens,
  type MetaRecommendationPriority,
  type MetaRecommendationsResponse,
} from "@/lib/meta/recommendations";
import { resolveMetaFunnelCohort } from "@/lib/meta/funnel-cohort";
import { resolveMinorUnitExponent } from "@/lib/currency/iso-4217-minor-units";
import {
  observedShopifyAovIsUsable,
  resolveObservedShopifyAov,
} from "@/lib/creative-decision-engine/shopify-aov-source";
import {
  getMetaAutomationControlPlane,
} from "@/lib/meta/automation-control-plane";
import { readIntentProjectionContexts } from "@/lib/meta/intent-projection-context";
import { projectBudgetIntents } from "@/lib/meta/budget-intent-projection";
import { projectBidIntents } from "@/lib/meta/bid-intent-projection";
import { META_BUDGET_INTENT_CONTRACT_VERSION } from "@/lib/meta/budget-intent-contract";
import type { MetaBidRegime, MetaCampaignRole } from "@/lib/meta/types";
import {
  metaLossBudgetMaturity,
  normalizeMetaCommercialTargets,
  readMetaCommercialTargets,
} from "@/lib/meta/commercial-targets";
import { enforceMetaCommercialActionAuthority } from "@/lib/meta/commercial-action-authority";

export interface RunMetaSnapshotResult {
  businessId: string;
  snapshotDate: string;
  calibration: RunMetaCalibrationResult;
  recommendationsWritten: number;
  anomaliesWritten: number;
  /**
   * Confirmation-queue projection for this run.
   *
   * `null` when the projection could not run at all (schema not ready, or the
   * projection threw). A count of zero and "we do not know" are different
   * facts, and the queue's read completeness depends on telling them apart.
   */
  proposals: { projected: number; expired: number } | null;
  /** D088: the canonical budget producer's own result, reported separately. */
  budgetProposals?: { candidates: number; projected: number } | null;
  /** The bid producer's own result, reported separately for the same reason. */
  bidProposals?: { candidates: number; projected: number } | null;
  /** The launch producer's, which counts staged intents rather than rows. */
  launchProposals?: { candidates: number; projected: number } | null;
  /**
   * The activation producer's — launches that created something and are not
   * delivering. Counted separately from `launchProposals` because "we staged
   * nothing today" and "nothing is waiting to be turned on" are different facts.
   */
  activationProposals?: { candidates: number; projected: number } | null;
  /**
   * The accounts THIS attempt generated for, so a caller can record completion
   * from what happened rather than from what exists.
   *
   * `""` is the unattributed batch a business with no assignment produces.
   */
  succeededAccountIds?: string[];
  /**
   * Accounts whose generation threw, by id.
   *
   * Empty on a clean run. A per-account failure is CONTAINED — INVARIANTS is
   * explicit for the sibling native path that it "must not abort or prune
   * unrelated ready" work — so the run reports which accounts are missing
   * rather than discarding the ones that succeeded.
   */
  failedAccountIds?: string[];
  /**
   * The newest source day each account's generation actually read, or an
   * absent key when the reading itself failed.
   *
   * The scheduler stores it as the slot's source cut-off. It used to store the
   * date the scheduler had ASKED for, so the cut-off advanced every successful
   * slot whether or not the warehouse had received a single new day. "We did
   * not read" and "the source is empty" are different facts and the scheduler
   * needs both: the first must leave the last real reading alone, the second
   * is a reading of its own.
   *
   * Keyed the same way `succeededAccountIds` is, `""` for the unattributed
   * batch.
   */
  sourceMaxDateByAccountId?: Record<string, string | null>;
  /** Set when the run refused before computing anything. */
  skippedReason?: "provider_account_not_assigned";
}

export interface RunMetaSnapshotAllBusinessesResult {
  snapshotDate: string;
  businessCount: number;
  results: Array<{
    businessId: string;
    status: "fulfilled" | "rejected";
    value?: RunMetaSnapshotResult;
    reason?: string;
  }>;
}

type SnapshotDbRow = {
  scope_type: "account" | "campaign" | "adset";
  scope_id: string;
  business_id: string;
  snapshot_date: string;
  rec_id: string;
  rec_type: string;
  level: MetaRecommendationLevel;
  decision_state: MetaRecommendation["decisionState"];
  confidence_score: unknown;
  evidence: unknown;
  recommended_action: string;
  target_value: unknown;
  expected_impact: string | null;
  reasoning: string;
  predictive_overlay: string | null;
  engine_version: string;
  created_at: string;
  kind?: "recommendation" | "anomaly";
  evidence_trail?: unknown;
  campaign_role?: MetaCampaignRole | null;
  bid_regime?: MetaBidRegime | null;
  decision_label?: MetaRecommendation["decisionLabel"] | null;
  state_reason?: string | null;
  calibration_scope?: unknown;
  signal_quality?: unknown;
};

interface SnapshotPayloadRow {
  scope_type: "account" | "campaign" | "adset";
  scope_id: string;
  business_id: string;
  /**
   * The PHYSICAL provider account this recommendation is about, when it can be
   * proven — never inferred from `scope_id`, which holds the business id for
   * account-level rows. Null when the lineage genuinely cannot be established,
   * and an account-scoped read WITHHOLDS those rows rather than showing them
   * for every account.
   */
  provider_account_id: string | null;
  snapshot_date: string;
  rec_id: string;
  rec_type: string;
  level: MetaRecommendationLevel;
  decision_state: MetaRecommendation["decisionState"];
  confidence_score: number | null;
  evidence: unknown;
  recommended_action: string;
  target_value: unknown;
  expected_impact: string | null;
  reasoning: string;
  predictive_overlay: string | null;
  engine_version: string;
  kind: "recommendation" | "anomaly";
  severity?: MetaAnomalySeverity | null;
  diagnostics?: string[];
  detected_at?: string | null;
  resolved_at?: string | null;
  evidence_trail?: MetaEvidenceTrail | Record<string, never>;
  campaign_role?: MetaCampaignRole | null;
  bid_regime?: MetaBidRegime | null;
  decision_label?: MetaRecommendation["decisionLabel"] | null;
  state_reason?: string | null;
  calibration_scope?: Record<string, unknown>;
  signal_quality?: Record<string, unknown>;
}

function parseISODate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function addDaysToISO(value: string, days: number): string {
  const date = parseISODate(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function normalizeDate(value: string | Date | null | undefined) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const text = String(value ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  const parsed = new Date(text);
  if (Number.isFinite(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  return new Date().toISOString().slice(0, 10);
}

function dayDiffInclusive(startDate: string, endDate: string): number {
  const start = parseISODate(startDate).getTime();
  const end = parseISODate(endDate).getTime();
  return Math.max(1, Math.floor((end - start) / 86_400_000) + 1);
}

function confidenceLabel(score: number): MetaRecommendationConfidence {
  return metaConfidenceBucket(score);
}

async function readCampaignContextGuardState(input: {
  businessId: string;
  providerAccountId: string | null;
  campaignIds: string[];
  asOf: string;
}): Promise<{
  campaignLabelsById: MetaCampaignLabelKindMap;
  campaignContextById: MetaCampaignContextGuardMap;
  automaticContextEnabled: boolean;
}> {
  const mode = resolveCampaignContextMode();
  try {
    const resolved = await readCampaignContextLabelMap({
      businessId: input.businessId,
      providerAccountId: input.providerAccountId,
      campaignIds: input.campaignIds,
      asOf: input.asOf,
      mode,
    });
    const context = new Map<string, MetaCampaignContextGuardEntry>();
    const labels = new Map<string, MetaCampaignKind>();
    for (const [campaignId, entry] of resolved) {
      const source = entry.provenance.source;
      const contextTrust = entry.contextTrust ?? "unknown";
      context.set(campaignId, {
        kind: entry.kind,
        contextTrust,
        source,
        inferenceConfidenceClass: entry.inferenceConfidenceClass,
        resolverAuthorityValidated: entry.resolverAuthorityValidated,
      });
      if (
        entry.kind &&
        contextTrust === "high" &&
        source === "system_inferred"
      ) {
        labels.set(campaignId, entry.kind);
      }
    }
    return {
      campaignLabelsById: labels,
      campaignContextById: context,
      automaticContextEnabled: mode === "automatic",
    };
  } catch (error) {
    console.warn("[meta-snapshot] campaign_context_read_failed", {
      businessId: input.businessId,
      message: error instanceof Error ? error.message : String(error),
    });
    return {
      campaignLabelsById: new Map(),
      campaignContextById: new Map(),
      automaticContextEnabled: mode === "automatic",
    };
  }
}

function scopeForRecommendation(recommendation: MetaRecommendation, businessId: string) {
  if (recommendation.level === "adset" && recommendation.adsetId) {
    return { scopeType: "adset" as const, scopeId: recommendation.adsetId };
  }
  if (recommendation.level === "campaign" && recommendation.campaignId) {
    return { scopeType: "campaign" as const, scopeId: recommendation.campaignId };
  }
  return { scopeType: "account" as const, scopeId: businessId };
}

function snapshotEvidencePayload(recommendation: MetaRecommendation) {
  return {
    items: recommendation.evidence,
    recommendation,
  };
}

/**
 * Which physical provider account a recommendation belongs to.
 *
 * Resolved from the rows the engine already read: every `MetaCampaignRow` and
 * every ad-set row carries `accountId`, and the recommendation names its
 * campaign or ad set. Nothing is inferred from `scope_id`.
 *
 * Null is a real answer and the important one. An account-LEVEL recommendation
 * for a business with more than one assigned account is genuinely about all of
 * them, and a campaign whose dimension row was not read cannot be placed. Both
 * stay null, and an account-scoped read withholds them — there is deliberately
 * no "belongs to every account" fallback, which is the shape that would make
 * one account's screen show another's decisions.
 */
export interface SnapshotAccountLineage {
  accountByCampaignId: Map<string, string>;
  accountByAdsetId: Map<string, string>;
  /** The one assigned account, when the business has exactly one. */
  soleAssignedAccountId: string | null;
}

function accountForRecommendation(
  recommendation: MetaRecommendation,
  lineage: SnapshotAccountLineage | null,
): string | null {
  if (!lineage) return null;
  if (recommendation.adsetId) {
    const viaAdset = lineage.accountByAdsetId.get(recommendation.adsetId);
    if (viaAdset) return viaAdset;
  }
  if (recommendation.campaignId) {
    const viaCampaign = lineage.accountByCampaignId.get(recommendation.campaignId);
    if (viaCampaign) return viaCampaign;
  }
  // Account-level, or an entity whose row was not read. The sole assigned
  // account is the only case where "the business" and "one account" are the
  // same fact; with two or more, this stays null.
  return lineage.soleAssignedAccountId;
}

function recommendationToSnapshotRow(
  recommendation: MetaRecommendation,
  businessId: string,
  snapshotDate: string,
  evidenceTrail: MetaEvidenceTrail | null,
  lineage: SnapshotAccountLineage | null = null,
): SnapshotPayloadRow {
  const scope = scopeForRecommendation(recommendation, businessId);
  const recommendationWithTrail = evidenceTrail
    ? { ...recommendation, evidenceTrail }
    : recommendation;
  return {
    scope_type: scope.scopeType,
    scope_id: scope.scopeId,
    business_id: businessId,
    provider_account_id: accountForRecommendation(recommendation, lineage),
    snapshot_date: snapshotDate,
    rec_id: recommendation.id,
    rec_type: recommendation.type,
    level: recommendation.level,
    decision_state: recommendation.decisionState,
    confidence_score: recommendation.confidenceScore ?? null,
    evidence: snapshotEvidencePayload(recommendationWithTrail),
    recommended_action: recommendation.recommendedAction,
    target_value: recommendation.targetValue ?? null,
    expected_impact: recommendation.expectedImpact ?? null,
    reasoning: recommendation.why,
    predictive_overlay:
      recommendation.predictiveOverlay ??
      recommendation.timeframeContext?.selectedRangeOverlay ??
      null,
    engine_version:
      recommendation.engineVersion ?? META_RECOMMENDATION_ENGINE_VERSION,
    kind: "recommendation",
    evidence_trail: evidenceTrail ?? {},
    campaign_role: recommendation.campaignRole ?? null,
    bid_regime: recommendation.bidRegime ?? null,
    decision_label: decisionLabelForMetaRec(recommendation),
    state_reason: recommendation.stateReason ?? null,
    calibration_scope: recommendation.calibrationScope ?? {},
    signal_quality: recommendation.signalQuality ?? {},
  };
}

function decisionStateForAnomaly(severity: MetaAnomalySeverity): MetaRecommendation["decisionState"] {
  if (severity === "high") return "act";
  if (severity === "medium") return "test";
  return "watch";
}

function confidenceForAnomaly(severity: MetaAnomalySeverity) {
  if (severity === "high") return 0.85;
  if (severity === "medium") return 0.65;
  return 0.45;
}

function anomalyToSnapshotRow(
  anomaly: MetaAnomaly,
  businessId: string,
  snapshotDate: string,
  lineage: SnapshotAccountLineage | null = null,
): SnapshotPayloadRow {
  return {
    scope_type: anomaly.scopeType,
    scope_id: anomaly.scopeId,
    business_id: businessId,
    /*
     * Anomalies carry the same lineage question, resolved the same way. An
     * anomaly names its scope id directly, so a campaign or ad-set anomaly can
     * be placed from the maps the engine already built.
     */
    provider_account_id: lineage
      ? (anomaly.scopeType === "adset"
          ? (lineage.accountByAdsetId.get(anomaly.scopeId) ?? null)
          : anomaly.scopeType === "campaign"
            ? (lineage.accountByCampaignId.get(anomaly.scopeId) ?? null)
            : null) ?? lineage.soleAssignedAccountId
      : null,
    snapshot_date: snapshotDate,
    rec_id: anomaly.id,
    rec_type: anomaly.type,
    level: anomaly.scopeType,
    decision_state: decisionStateForAnomaly(anomaly.severity),
    confidence_score: confidenceForAnomaly(anomaly.severity),
    evidence: { anomaly },
    recommended_action: anomaly.title,
    target_value: null,
    expected_impact: null,
    reasoning: anomaly.detail,
    predictive_overlay: "Diagnose-first anomaly signal.",
    engine_version: META_RECOMMENDATION_ENGINE_VERSION,
    kind: "anomaly",
    severity: anomaly.severity,
    diagnostics: anomaly.diagnostics,
    detected_at: anomaly.detectedAt,
    resolved_at: anomaly.resolvedAt ?? null,
    evidence_trail: {},
    campaign_role: null,
    bid_regime: null,
    decision_label: "diagnose",
    state_reason: null,
    calibration_scope: {},
    signal_quality: {},
  };
}

/**
 * Clear this date's recommendation rows that carry NO proven account.
 *
 * Run ONCE per business refresh, before the per-account loop. It cannot live
 * inside the loop: `provider_account_id = $a` never matches NULL, so legacy
 * rows would survive every refresh forever — invisible to an account-scoped
 * read and still visible to every business-scoped one — while a predicate of
 * `(= $a OR IS NULL)` inside the loop would have each account delete whatever
 * the previous account had just written under NULL.
 */
async function clearUnattributedRecommendationRows(input: {
  businessId: string;
  snapshotDate: string;
}) {
  const sql = getDb();
  await sql`
    DELETE FROM meta_decision_snapshots_daily
    WHERE business_id = ${input.businessId}
      AND snapshot_date = ${input.snapshotDate}::date
      AND kind = 'recommendation'
      AND provider_account_id IS NULL
  `;
}

async function upsertSnapshotRows(input: {
  businessId: string;
  snapshotDate: string;
  /**
   * The account this write is FOR. Only its rows are replaced.
   *
   * The delete used to take every recommendation row for the business and
   * date, which under per-account generation means account B's refresh erases
   * account A's snapshot — and INVARIANTS is explicit for the sibling native
   * path that a per-account run "must not abort or prune unrelated ready" work.
   * Scoping the delete is what makes a rerun of one account deterministic and
   * a rerun of another harmless.
   *
   * Null means "the unattributed batch" — anomalies, and businesses with no
   * assigned account. `IS NOT DISTINCT FROM` rather than `=` so that null
   * matches null.
   */
  providerAccountId?: string | null;
  /**
   * Whether this call owns the recommendation batch for its account.
   *
   * False for the anomaly epilogue, which writes only anomalies. Without it
   * that call's DELETE would take the recommendation rows the loop just wrote
   * under a NULL account — the case of a business with nothing assigned, whose
   * whole snapshot would vanish one statement after it landed.
   */
  replaceRecommendations?: boolean;
  rows: SnapshotPayloadRow[];
}) {
  const sql = getDb();
  const account = input.providerAccountId?.trim() || null;
  const recommendationRows = input.rows.filter((row) => row.kind === "recommendation");
  const anomalyRows = input.rows.filter((row) => row.kind === "anomaly");

  /*
   * Replace THIS account's batch for THIS date. Not leaving an older same-day
   * batch serving is the other half of the law: a rerun must supersede its own
   * previous attempt, and touch nothing else.
   */
  if (input.replaceRecommendations !== false) {
    await sql`
      DELETE FROM meta_decision_snapshots_daily
      WHERE business_id = ${input.businessId}
        AND snapshot_date = ${input.snapshotDate}::date
        AND kind = 'recommendation'
        AND provider_account_id IS NOT DISTINCT FROM ${account}
    `;
  }
  if (recommendationRows.length > 0) {
    await sql.query(
      `
        WITH payload AS (
          SELECT *
          FROM jsonb_to_recordset($1::jsonb) AS row(
            scope_type text,
            scope_id text,
            business_id text,
            provider_account_id text,
            snapshot_date date,
            rec_id text,
            rec_type text,
            level text,
            decision_state text,
            confidence_score numeric,
            evidence jsonb,
            recommended_action text,
            target_value jsonb,
            expected_impact text,
            reasoning text,
            predictive_overlay text,
            engine_version text,
            kind text,
            evidence_trail jsonb,
            campaign_role text,
            bid_regime text,
            decision_label text,
            state_reason text,
            calibration_scope jsonb,
            signal_quality jsonb
          )
        )
        INSERT INTO meta_decision_snapshots_daily (
          scope_type,
          scope_id,
          business_id,
          provider_account_id,
          snapshot_date,
          rec_id,
          rec_type,
          level,
          decision_state,
          confidence_score,
          evidence,
          recommended_action,
          target_value,
          expected_impact,
          reasoning,
          predictive_overlay,
          engine_version,
          kind,
          evidence_trail,
          campaign_role,
          bid_regime,
          decision_label,
          state_reason,
          calibration_scope,
          signal_quality
        )
        SELECT
          scope_type,
          scope_id,
          business_id,
          provider_account_id,
          snapshot_date,
          rec_id,
          rec_type,
          level,
          decision_state,
          confidence_score,
          evidence,
          recommended_action,
          target_value,
          expected_impact,
          reasoning,
          predictive_overlay,
          engine_version,
          kind,
          evidence_trail,
          campaign_role,
          bid_regime,
          decision_label,
          state_reason,
          calibration_scope,
          signal_quality
        FROM payload
        ON CONFLICT (scope_type, scope_id, snapshot_date, rec_type, provider_account_id)
        DO UPDATE SET
          business_id = EXCLUDED.business_id,
          provider_account_id = EXCLUDED.provider_account_id,
          rec_id = EXCLUDED.rec_id,
          level = EXCLUDED.level,
          decision_state = EXCLUDED.decision_state,
          confidence_score = EXCLUDED.confidence_score,
          evidence = EXCLUDED.evidence,
          recommended_action = EXCLUDED.recommended_action,
          target_value = EXCLUDED.target_value,
          expected_impact = EXCLUDED.expected_impact,
          reasoning = EXCLUDED.reasoning,
          predictive_overlay = EXCLUDED.predictive_overlay,
          engine_version = EXCLUDED.engine_version,
          kind = EXCLUDED.kind,
          evidence_trail = EXCLUDED.evidence_trail,
          campaign_role = EXCLUDED.campaign_role,
          bid_regime = EXCLUDED.bid_regime,
          decision_label = EXCLUDED.decision_label,
          state_reason = EXCLUDED.state_reason,
          calibration_scope = EXCLUDED.calibration_scope,
          signal_quality = EXCLUDED.signal_quality,
          severity = NULL,
          diagnostics = '[]'::jsonb,
          detected_at = NULL,
          resolved_at = NULL,
          created_at = now()
      `,
      [JSON.stringify(recommendationRows)],
    );
  }

  if (anomalyRows.length === 0) {
    await sql`
      UPDATE meta_decision_snapshots_daily
      SET resolved_at = now()
      WHERE business_id = ${input.businessId}
        AND snapshot_date = ${input.snapshotDate}::date
        AND kind = 'anomaly'
        AND resolved_at IS NULL
    `;
    return;
  }

  await sql.query(
    `
      WITH payload AS (
        SELECT *
        FROM jsonb_to_recordset($1::jsonb) AS row(
          scope_type text,
          scope_id text,
          business_id text,
          provider_account_id text,
          snapshot_date date,
          rec_id text,
          rec_type text,
          level text,
          decision_state text,
          confidence_score numeric,
          evidence jsonb,
          recommended_action text,
          target_value jsonb,
          expected_impact text,
          reasoning text,
          predictive_overlay text,
          engine_version text,
          kind text,
          severity text,
          diagnostics jsonb,
          detected_at timestamptz,
          resolved_at timestamptz,
          evidence_trail jsonb,
          campaign_role text,
          bid_regime text,
          decision_label text,
          state_reason text,
          calibration_scope jsonb,
          signal_quality jsonb
        )
      ),
      resolved AS (
        UPDATE meta_decision_snapshots_daily existing
        SET resolved_at = now()
        WHERE existing.business_id = $2
          AND existing.snapshot_date = $3::date
          AND existing.kind = 'anomaly'
          AND existing.resolved_at IS NULL
          AND NOT EXISTS (
            SELECT 1
            FROM payload
            WHERE payload.scope_type = existing.scope_type
              AND payload.scope_id = existing.scope_id
              AND payload.rec_type = existing.rec_type
          )
        RETURNING existing.rec_id
      )
      INSERT INTO meta_decision_snapshots_daily (
        scope_type,
        scope_id,
        business_id,
        provider_account_id,
        snapshot_date,
        rec_id,
        rec_type,
        level,
        decision_state,
        confidence_score,
        evidence,
        recommended_action,
        target_value,
        expected_impact,
        reasoning,
        predictive_overlay,
        engine_version,
        kind,
        severity,
        diagnostics,
        detected_at,
        resolved_at,
        evidence_trail,
        campaign_role,
        bid_regime,
        decision_label,
        state_reason,
        calibration_scope,
        signal_quality
      )
      SELECT
        scope_type,
        scope_id,
        business_id,
        provider_account_id,
        snapshot_date,
        rec_id,
        rec_type,
        level,
        decision_state,
        confidence_score,
        evidence,
        recommended_action,
        target_value,
        expected_impact,
        reasoning,
        predictive_overlay,
        engine_version,
        kind,
        severity,
        diagnostics,
        detected_at,
        resolved_at,
        evidence_trail,
        campaign_role,
        bid_regime,
        decision_label,
        state_reason,
        calibration_scope,
        signal_quality
      FROM payload
      ON CONFLICT (scope_type, scope_id, snapshot_date, rec_type, provider_account_id)
      DO UPDATE SET
        business_id = EXCLUDED.business_id,
        provider_account_id = EXCLUDED.provider_account_id,
        rec_id = EXCLUDED.rec_id,
        level = EXCLUDED.level,
        decision_state = EXCLUDED.decision_state,
        confidence_score = EXCLUDED.confidence_score,
        evidence = EXCLUDED.evidence,
        recommended_action = EXCLUDED.recommended_action,
        target_value = EXCLUDED.target_value,
        expected_impact = EXCLUDED.expected_impact,
        reasoning = EXCLUDED.reasoning,
        predictive_overlay = EXCLUDED.predictive_overlay,
        engine_version = EXCLUDED.engine_version,
        kind = EXCLUDED.kind,
        severity = EXCLUDED.severity,
        diagnostics = EXCLUDED.diagnostics,
        evidence_trail = EXCLUDED.evidence_trail,
        campaign_role = EXCLUDED.campaign_role,
        bid_regime = EXCLUDED.bid_regime,
        decision_label = EXCLUDED.decision_label,
        state_reason = EXCLUDED.state_reason,
        calibration_scope = EXCLUDED.calibration_scope,
        signal_quality = EXCLUDED.signal_quality,
        detected_at = EXCLUDED.detected_at,
        resolved_at = NULL,
        created_at = now()
    `,
    [JSON.stringify(anomalyRows), input.businessId, input.snapshotDate],
  );
}


/**
 * Give the decisions that earned one an exact amount to move.
 *
 * The two sizing policies are pure and were already tested; what was missing
 * was a caller. Without one, `target_value` never carried a typed intent, so
 * the budget candidate query matched nothing and an ad set on a cost cap far
 * above its own CPA had no in-product way to move.
 *
 * It fails quietly and completely: an unreadable context proposes nothing and
 * returns the recommendations untouched. A decision without an amount is still
 * a decision worth showing; a decision with an amount nobody could verify is
 * not.
 */
async function attachSizedIntents(input: {
  recommendations: MetaRecommendation[];
  businessId: string;
  providerAccountId: string | null;
  snapshotDate: string;
  campaigns: MetaCampaignRow[];
  adsets: readonly MetaAdSetData[];
  campaignLabelsById: MetaCampaignLabelKindMap;
  commercialTargets: Awaited<ReturnType<typeof readMetaCommercialTargets>> | null;
  accountCurrency: string | null;
  contexts: { byCampaignId: Record<string, MetaCalibrationContext> };
  adsetCalibrationContextByAdsetId: Record<string, MetaCalibrationContext>;
  /** Ad sets whose delivery is measurably limited, from this run's anomalies. */
  deliveryConstrainedAdsetIds?: Set<string>;
}): Promise<MetaRecommendation[]> {
  if (!input.providerAccountId) return input.recommendations;

  const targets = normalizeMetaCommercialTargets(input.commercialTargets);
  /*
    The guardrails the operator saved, including which sizing policy versions
    their configuration is bound to.

    An unstamped business proposes nothing: the sizing policies refuse on the
    version themselves, and reading the control plane once here is cheaper
    than discovering it per entity.
  */
  const control = await getMetaAutomationControlPlane({
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
  }).catch(() => null);
  if (!control) return input.recommendations;
  const guardrails = control.businessControl.guardrails;
  /*
    The CPA benchmark a bid cap is measured against, in minor units.

    The plan's order, and the whole point of it: an explicitly configured
    target CPA first, then the operator's own average-order-value assumption
    divided by the target ROAS, then the STORE's observed average order value
    divided by the same target. ROAS stays the only required commercial target;
    the last rung is what makes that true, because a business with only a
    target ROAS and real Shopify sales gets a benchmark without anybody being
    asked for a CPA or an AOV.

    The store's own reader owns every refusal — a thin sample, a mixed
    currency, an unavailable sync — and yields nothing rather than a guess.
    Nothing here converts currencies: a benchmark in another currency is not a
    benchmark for this account. A currency with no ISO exponent gives no
    benchmark either, because a number whose scale is unknown is not a number.
  */
  const exponent = resolveMinorUnitExponent(input.accountCurrency);
  const currencyExponent =
    exponent.status === "resolved" ? exponent.exponent : null;
  const observedAov = targets.targetCpa || targets.aovAssumption
    ? null
    : await resolveObservedShopifyAov({
      businessId: input.businessId,
      accountCurrency: input.accountCurrency,
      currencyExponent,
    }).catch(() => null);
  const observedAovMajor =
    observedAov && observedShopifyAovIsUsable(observedAov)
    && currencyExponent !== null
      ? observedAov.aovMinor / 10 ** currencyExponent
      : null;

  const majorSpendUnit = targets.targetCpa
    ?? (targets.aovAssumption && targets.targetRoas
      ? targets.aovAssumption / targets.targetRoas
      : observedAovMajor && targets.targetRoas
        ? observedAovMajor / targets.targetRoas
        : null);
  const spendUnitMinor = currencyExponent !== null && majorSpendUnit
    ? Math.round(majorSpendUnit * 10 ** currencyExponent)
    : null;

  /*
    The role gate, taken from the SAME map the label guard used.

    A campaign carries a published role only when the context resolver
    returned high trust from a system inference — the exact condition the
    budget policy's role check is about. Re-deriving it here from other
    evidence could disagree with the guard the operator already saw.
  */
  const roleAuthorityByCampaignId = new Map<string, boolean>();
  for (const campaign of input.campaigns) {
    roleAuthorityByCampaignId.set(
      campaign.id,
      input.campaignLabelsById.has(campaign.id),
    );
  }

  const cohortByEntityId = new Map<string, string>();
  const maturityByEntityId = new Map<string, boolean>();
  const calibrationSampleByEntityId = new Map<string, number | null>();
  /*
    Maturity measured against the SAME benchmark the sizing uses.

    `metaLossBudgetMaturity` derives its spend threshold from a CPA baseline,
    and for a business with only a target ROAS every configured source of one
    is null — so maturity was never satisfied and nothing was ever sized,
    whatever the store's sales said. Handing it the derived benchmark closes
    that: one number, used for both the gate and the rungs.
  */
  const lossBudget = metaLossBudgetMaturity({
    targets: input.commercialTargets,
    accountCpaBaseline: majorSpendUnit,
  });
  for (const campaign of input.campaigns) {
    cohortByEntityId.set(campaign.id, resolveMetaFunnelCohort({
      optimizationGoal: campaign.optimizationGoal,
      customEventType: campaign.customEventType,
      objective: campaign.objective,
    }));
    maturityByEntityId.set(
      campaign.id,
      // Maturity is the loss budget actually spent: below it, an outcome is
      // too small a sample to move money on.
      lossBudget !== null && (campaign.spend ?? 0) >= lossBudget.spendThreshold,
    );
    calibrationSampleByEntityId.set(
      campaign.id,
      input.contexts.byCampaignId[campaign.id]?.thresholds?.minRequiredSample ?? null,
    );
  }
  for (const adset of input.adsets) {
    const adsetId = adset.id?.trim() || null;
    if (!adsetId) continue;
    const parentId = adset.campaignId?.trim() || null;
    cohortByEntityId.set(
      adsetId,
      (parentId ? cohortByEntityId.get(parentId) : null) ?? "unknown",
    );
    const spend = adset.spend ?? 0;
    maturityByEntityId.set(
      adsetId,
      lossBudget !== null && spend >= lossBudget.spendThreshold,
    );
    calibrationSampleByEntityId.set(
      adsetId,
      input.adsetCalibrationContextByAdsetId[adsetId]?.thresholds?.minRequiredSample ?? null,
    );
  }

  const contexts = await readIntentProjectionContexts({
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
    snapshotDate: input.snapshotDate,
    cohortByEntityId,
    roleAuthorityByCampaignId,
    maturityByEntityId,
    calibrationSampleByEntityId,
    /*
      Delivery constraint is what makes RAISING a cap sensible; without it, a
      higher cap only pays more for the same result.

      It comes from this run's own `delivery_stall` anomalies, so the card and
      the bid intent cite one fact rather than two opinions. An absent set is
      still "no ad set qualified", which withholds every raise — the safe
      direction, and what the policy says by name.
    */
    deliveryConstrainedAdsetIds: input.deliveryConstrainedAdsetIds ?? new Set<string>(),
  }).catch(() => null);
  if (!contexts) return input.recommendations;

  const pausedEntityIds = new Set(
    input.recommendations
      .filter((rec) => rec.decisionLabel === "cut")
      .map((rec) => (rec.level === "adset" ? rec.adsetId : rec.campaignId) ?? "")
      .filter(Boolean),
  );

  const budget = projectBudgetIntents({
    recommendations: input.recommendations,
    targetRoas: targets.targetRoas,
    breakEvenRoas: targets.breakEvenRoas,
    accountCurrency: input.accountCurrency,
    policy: {
      maxBudgetIncreasePct: guardrails.maxBudgetIncreasePct,
      perActionSpendCeilingMinor: guardrails.perActionSpendCeilingValid
        ? guardrails.perActionSpendCeilingMinor
        : null,
      perActionSpendCeilingCurrency: guardrails.perActionSpendCeilingValid
        ? guardrails.perActionSpendCeilingCurrency
        : null,
      budgetMinHoursBetweenChanges: guardrails.budgetMinHoursBetweenChanges,
      budgetMaxChangesPer7d: guardrails.budgetMaxChangesPer7d,
      budgetMaxAccountConcentrationPct: guardrails.budgetMaxAccountConcentrationPct,
      budgetSizingPolicyVersion: guardrails.budgetSizingPolicyVersion,
    },
    contextByEntityId: contexts.budgetByEntityId,
    pausedEntityIds,
  });

  const budgetChangedAdsetIds = new Set(
    budget.recommendations
      .filter((rec: MetaRecommendation) => rec.level === "adset"
        && (rec.targetValue as { contractVersion?: string } | null)?.contractVersion
          === META_BUDGET_INTENT_CONTRACT_VERSION)
      .map((rec: MetaRecommendation) => rec.adsetId ?? "")
      .filter(Boolean),
  );

  const bid = projectBidIntents({
    recommendations: budget.recommendations,
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
    spendUnitMinor,
    accountCurrency: input.accountCurrency,
    policy: {
      budgetMinHoursBetweenChanges: guardrails.budgetMinHoursBetweenChanges,
      budgetMaxChangesPer7d: guardrails.budgetMaxChangesPer7d,
      bidSizingPolicyVersion: guardrails.bidSizingPolicyVersion,
    },
    contextByAdsetId: contexts.bidByAdsetId,
    budgetChangedAdsetIds,
    originDate: input.snapshotDate,
    effectiveAsOf: input.snapshotDate,
    knowledgeAsOf: new Date().toISOString(),
    evidenceWindow: {
      from: addDaysToISO(input.snapshotDate, -27),
      to: input.snapshotDate,
    },
  });

  /*
    Re-stamp, because the intent arrived AFTER the recommendation was stamped.

    `buildMetaRecommendations` maps `stampRecommendation` over its output, and
    that is where `proposedAction` — the field the decision card's Apply reads —
    is derived from `targetValue`. The sizing above attaches the target value
    later, so the stamp had already been taken against a recommendation that
    carried no intent: an ad set could be persisted with a validated
    1320-minor-unit cap raise and `proposedAction` absent, and the card offered
    nothing while the queue offered the same amount.
  */
  return restampProposedActions(bid.recommendations);
}

async function buildCalibrationContexts(input: {
  businessId: string;
  snapshotDate: string;
  campaigns: MetaCampaignRow[];
  campaignLabelsById?: MetaCampaignLabelKindMap | null;
}) {
  const byCampaignId: Record<string, MetaCalibrationContext> = {};
  for (const campaign of input.campaigns) {
    const cohort = resolveMetaFunnelCohort({
      optimizationGoal: campaign.optimizationGoal,
      customEventType: campaign.customEventType,
    });
    const scope = await getMetaCalibrationScope(input.businessId, {
      campaignId: campaign.id,
      accountId: campaign.accountId,
      snapshotDate: input.snapshotDate,
      cohort,
      campaignKind: input.campaignLabelsById?.get(campaign.id) ?? "all",
    });
    byCampaignId[campaign.id] = {
      thresholds: scope.thresholds,
      scope: scope.scope,
      reason: scope.reason,
      cohort,
    };
  }
  const firstCampaign = input.campaigns[0];
  const accountContext = firstCampaign
    ? byCampaignId[firstCampaign.id] ?? null
    : null;
  return { accountContext, byCampaignId };
}

async function buildAdsetCalibrationContexts(input: {
  businessId: string;
  snapshotDate: string;
  adsets: MetaAdSetData[];
  campaignLabelsById?: MetaCampaignLabelKindMap | null;
}) {
  const byAdsetId: Record<string, MetaCalibrationContext> = {};
  const cache = new Map<string, MetaCalibrationContext>();
  for (const adset of input.adsets) {
    const cohort = resolveMetaFunnelCohort({
      optimizationGoal: adset.optimizationGoal,
      customEventType: adset.customEventType,
    });
    const campaignKind = input.campaignLabelsById?.get(adset.campaignId) ?? "all";
    const cacheKey = `${adset.accountId ?? ""}:${adset.campaignId}:${cohort}:${campaignKind}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      byAdsetId[adset.id] = cached;
      continue;
    }
    const scope = await getMetaCalibrationScope(input.businessId, {
      campaignId: adset.campaignId,
      accountId: adset.accountId ?? "",
      snapshotDate: input.snapshotDate,
      cohort,
      campaignKind,
    });
    const context: MetaCalibrationContext = {
      thresholds: scope.thresholds,
      scope: scope.scope,
      reason: scope.reason,
      cohort,
    };
    cache.set(cacheKey, context);
    byAdsetId[adset.id] = context;
  }
  return byAdsetId;
}

async function buildSnapshotRecommendations(input: {
  businessId: string;
  snapshotDate: string;
  /**
   * Ad sets whose delivery is measurably limited, from this run's own
   * anomalies.
   *
   * The bid policy only raises a cap when delivery is constrained, and this is
   * the evidence. Empty means no ad set qualified — which is a real answer and
   * not the unconditional placeholder it used to be.
   */
  deliveryConstrainedAdsetIds?: Set<string>;
  /**
   * The ONE physical provider account this generation is for.
   *
   * D-M011: every input below is narrowed to it BEFORE the decision is
   * computed. Tagging rows with an account after a business-wide computation —
   * which is what D-M009 did — produces a row that says "account A" while its
   * spend, ROAS, percentiles, calibration context and hysteresis were pooled
   * across every assigned account. That is a labelled aggregate, not an
   * account-scoped decision, and D6 asks for the latter.
   *
   * Null is still accepted and still means business-wide, because the
   * business-scoped callers that are not account surfaces have not moved.
   */
  providerAccountId?: string | null;
}): Promise<{
  recommendations: MetaRecommendation[];
  lineage: SnapshotAccountLineage;
}> {
  const accountId = input.providerAccountId?.trim() || null;
  const endDate = normalizeDate(input.snapshotDate);
  const startDate = addDaysToISO(endDate, -29);
  const selectedSpanDays = dayDiffInclusive(startDate, endDate);
  const previousEnd = addDaysToISO(startDate, -1);
  const previousStart = addDaysToISO(previousEnd, -(selectedSpanDays - 1));
  const last3Start = addDaysToISO(endDate, -2);
  const last7Start = addDaysToISO(endDate, -6);
  const last14Start = addDaysToISO(endDate, -13);
  const last30Start = addDaysToISO(endDate, -29);
  const last90Start = addDaysToISO(endDate, -89);
  const allHistoryStart = addDaysToISO(endDate, -(META_WAREHOUSE_HISTORY_DAYS - 1));

  const selectedCampaigns = await getMetaCampaignsForRange({
    businessId: input.businessId,
    accountId,
    startDate,
    endDate,
    includePrev: true,
  });
  const previousSelectedCampaigns = await getMetaCampaignsForRange({
    businessId: input.businessId,
    accountId,
    startDate: previousStart,
    endDate: previousEnd,
  });
  const last3Campaigns = await getMetaCampaignsForRange({
    businessId: input.businessId,
    accountId,
    startDate: last3Start,
    endDate,
  });
  const last7Campaigns = await getMetaCampaignsForRange({
    businessId: input.businessId,
    accountId,
    startDate: last7Start,
    endDate,
  });
  const last14Campaigns = await getMetaCampaignsForRange({
    businessId: input.businessId,
    accountId,
    startDate: last14Start,
    endDate,
  });
  const last30Campaigns = await getMetaCampaignsForRange({
    businessId: input.businessId,
    accountId,
    startDate: last30Start,
    endDate,
  });
  const last90Campaigns = await getMetaCampaignsForRange({
    businessId: input.businessId,
    accountId,
    startDate: last90Start,
    endDate,
  });
  const allHistoryCampaigns = await getMetaCampaignsForRange({
    businessId: input.businessId,
    accountId,
    startDate: allHistoryStart,
    endDate,
  });
  const breakdowns = await getMetaBreakdownsForRange({
    businessId: input.businessId,
    providerAccountId: accountId,
    startDate,
    endDate,
  });

  const campaigns = selectedCampaigns.rows ?? [];
  const campaignIds = campaigns.map((campaign) => campaign.id);
  const campaignContextState = await readCampaignContextGuardState({
    businessId: input.businessId,
    providerAccountId: accountId,
    campaignIds,
    asOf: endDate,
  });
  const campaignLabelsById = campaignContextState.campaignLabelsById;
  const entitySignals = await readMetaEntityDecisionSignalsDaily({
    businessId: input.businessId,
    providerAccountId: accountId,
    asOfDate: endDate,
  });
  const entitySignalsByCampaignId = Object.fromEntries(
    Array.from(entitySignals.values())
      .filter((signal) => signal.scopeType === "campaign")
      .map((signal) => [signal.scopeId, signal]),
  );
  const entitySignalsByAdsetId = Object.fromEntries(
    Array.from(entitySignals.values())
      .filter((signal) => signal.scopeType === "adset")
      .map((signal) => [signal.scopeId, signal]),
  );
  const contexts = await buildCalibrationContexts({
    businessId: input.businessId,
    snapshotDate: endDate,
    campaigns,
    campaignLabelsById,
  });
  const historicalBidRegimes = Object.fromEntries(
    (
      await readMetaBidRegimeHistorySummaries({
        businessId: input.businessId,
        entityLevel: "campaign",
        entityIds: campaignIds,
      })
    ).entries(),
  );
  const commercialTargets = await readMetaCommercialTargets(input.businessId, {
    asOf: endDate,
  }).catch(() => null);

  const campaignRecommendations = buildMetaRecommendations({
    windows: {
      selected: campaigns,
      previousSelected: previousSelectedCampaigns.rows ?? [],
      last3: last3Campaigns.rows ?? [],
      last7: last7Campaigns.rows ?? [],
      last14: last14Campaigns.rows ?? [],
      last30: last30Campaigns.rows ?? [],
      last90: last90Campaigns.rows ?? [],
      allHistory: allHistoryCampaigns.rows ?? [],
    },
    breakdowns: breakdowns as MetaBreakdownsResponse,
    historicalBidRegimes,
    calibrationContext: contexts.accountContext,
    calibrationContextByCampaignId: contexts.byCampaignId,
    entitySignalsByCampaignId,
    commercialTargets,
    language: "en",
  }).recommendations;

  const adsetRows = await getMetaAdSetsForRange({
    businessId: input.businessId,
    accountId,
    startDate,
    endDate,
    campaignIds,
  });
  const adsetCalibrationContextByAdsetId = await buildAdsetCalibrationContexts({
    businessId: input.businessId,
    snapshotDate: endDate,
    adsets: adsetRows.rows ?? [],
    campaignLabelsById,
  });
  const adsetRecommendations = buildMetaAdsetRecommendations({
    adsets: adsetRows.rows ?? [],
    campaigns,
    calibrationContext: contexts.accountContext,
    calibrationContextByCampaignId: contexts.byCampaignId,
    calibrationContextByAdsetId: adsetCalibrationContextByAdsetId,
    entitySignalsByAdsetId,
    commercialTargets,
  });
  const stateRows = buildMetaEntityStateRows({
    campaigns,
    adsets: adsetRows.rows ?? [],
    calibrationContext: contexts.accountContext,
    calibrationContextByCampaignId: contexts.byCampaignId,
    campaignLabelsById,
  });

  const labelGuarded = applyMetaCampaignLabelGuard({
    recommendations: [...stateRows, ...campaignRecommendations, ...adsetRecommendations],
    campaignLabelsById,
    campaignContextById: campaignContextState.campaignContextById,
    automaticContextEnabled: campaignContextState.automaticContextEnabled,
    activeCampaignIds: campaignIds,
  }).recommendations;

  /*
    The sizing step, which had never had a caller.

    Both policies were written and tested and neither ran: nothing wrote a
    typed intent into `target_value`, so the budget candidate query matched
    nothing and the ad-set card offered no bid. The decision was there; the
    amount was not, and an amount is what makes a decision applicable.

    It is attached HERE, after the label guard, because a recommendation the
    guard withheld must not be given money to move. A failed context read
    proposes nothing rather than proposing on assumed values.
  */
  const guardedRecommendations = await attachSizedIntents({
    deliveryConstrainedAdsetIds: input.deliveryConstrainedAdsetIds,
    recommendations: labelGuarded,
    businessId: input.businessId,
    providerAccountId: accountId,
    snapshotDate: endDate,
    campaigns,
    adsets: adsetRows.rows ?? [],
    campaignLabelsById,
    commercialTargets,
    /*
      The account's own currency, from the rows this run already read.

      A budget or a bid is a number of minor units, which means nothing without
      it — and no ceiling comparison is valid across two currencies. Absent, the
      sizing contracts refuse rather than assume.
    */
    accountCurrency: campaigns.find((campaign) => campaign.currency)?.currency ?? null,
    contexts,
    adsetCalibrationContextByAdsetId,
  });
  /*
   * The account lineage, built from the rows this run already read.
   *
   * Every campaign and ad-set row carries `accountId`; the engine simply never
   * carried it forward. Collected here rather than re-queried, so the lineage
   * is exactly the one the recommendations were computed from.
   *
   * `soleAssignedAccountId` is the only case in which an account-LEVEL
   * recommendation can be placed: with one assigned account, "this business"
   * and "this account" are the same fact. With two or more it stays null and
   * the row is withheld from an account-scoped read.
   */
  const accountByCampaignId = new Map<string, string>();
  for (const campaign of campaigns) {
    if (campaign.id && campaign.accountId) {
      accountByCampaignId.set(campaign.id, campaign.accountId);
    }
  }
  const accountByAdsetId = new Map<string, string>();
  for (const adset of adsetRows.rows ?? []) {
    const adsetId = (adset as { id?: unknown }).id;
    const accountId = (adset as { accountId?: unknown }).accountId;
    if (typeof adsetId === "string" && typeof accountId === "string" && accountId) {
      accountByAdsetId.set(adsetId, accountId);
    }
  }
  const assignedAccountIds = await readAssignedMetaAccountIds(input.businessId);

  return {
    recommendations: await attachMetaEmpiricalOutcomeSummariesFromLogs({
      businessId: input.businessId,
      /*
       * The account THIS generation run is for (the outer binding from the top
       * of this function, not the loop-local `accountId` a few lines above).
       *
       * Omitting it made the integration pass null, and null reads outcome
       * history business-wide — so account A's recommendation carried account
       * B's empirical evidence for the same rec type. Every other input to this
       * function is narrowed per account (D-M011); this was the last one that
       * was not, and it is the one an operator actually reads as "how this kind
       * of decision has worked out here".
       */
      providerAccountId: accountId,
      recommendations: guardedRecommendations,
    }),
    lineage: {
      accountByCampaignId,
      accountByAdsetId,
      soleAssignedAccountId:
        assignedAccountIds.length === 1 ? assignedAccountIds[0]! : null,
    },
  };
}

/**
 * The accounts currently assigned to this business, or an empty list.
 *
 * Deliberately tolerant: a failed read means the lineage cannot claim a sole
 * account, which leaves account-level rows null — the fail-closed direction.
 */
async function readAssignedMetaAccountIds(businessId: string): Promise<string[]> {
  try {
    const assignments = await getProviderAccountAssignments(businessId, "meta");
    return assignments?.account_ids ?? [];
  } catch {
    return [];
  }
}

/**
 * The newest source day one account's generation actually read.
 *
 * `meta_structure_snapshot_runs.source_max_date` was being stamped with the
 * date the scheduler ASKED for, so the cut-off advanced on every successful
 * slot whether or not the warehouse had received a single new day — the one
 * thing A5.4 forbids. This is the reading instead: the newest warehouse day at
 * or before the day this run computed. A smaller value than last time is an
 * honest reading, not an error, and no rows at all is NULL.
 *
 * Both tables, because the generation genuinely reads both. `GREATEST` ignores
 * a NULL argument, and the account-scoped and business-scoped forms are
 * written out separately rather than folded into one `OR $2 IS NULL`
 * predicate: that form defeats the (business, account, date DESC) indexes and
 * turns an index-only scan of two of the largest tables in the schema into a
 * full one.
 */
async function readSnapshotSourceMaxDate(input: {
  businessId: string;
  providerAccountId: string | null;
  throughDate: string;
}): Promise<string | null> {
  const sql = getDb();
  const rows = (input.providerAccountId
    ? await sql`
        SELECT GREATEST(
          (
            SELECT MAX(date) FROM meta_campaign_daily
            WHERE business_id = ${input.businessId}
              AND provider_account_id = ${input.providerAccountId}
              AND date <= ${input.throughDate}::date
          ),
          (
            SELECT MAX(date) FROM meta_adset_daily
            WHERE business_id = ${input.businessId}
              AND provider_account_id = ${input.providerAccountId}
              AND date <= ${input.throughDate}::date
          )
        )::text AS max_date
      `
    : await sql`
        SELECT GREATEST(
          (
            SELECT MAX(date) FROM meta_campaign_daily
            WHERE business_id = ${input.businessId}
              AND date <= ${input.throughDate}::date
          ),
          (
            SELECT MAX(date) FROM meta_adset_daily
            WHERE business_id = ${input.businessId}
              AND date <= ${input.throughDate}::date
          )
        )::text AS max_date
      `) as Array<{ max_date: string | null }>;
  return rows[0]?.max_date ?? null;
}

export async function runMetaSnapshotForBusiness(
  businessId: string,
  snapshotDate: string,
  /**
   * Compute the NAMED assigned accounts instead of every one.
   *
   * A selected-account manual control passes its account, and gets exactly the
   * computation the surface reads back. Omitted orchestrates every currently
   * assigned account — still computing and persisting each independently, so
   * the whole-business entry point never creates pooled truth.
   *
   * It takes a list because a slot retry owes a list: one account of a
   * business can succeed while two others fail in the same run, and expressing
   * that as "one account or all of them" forced the retry to regenerate the
   * account that had already succeeded.
   *
   * An account that is not currently assigned is refused rather than computed,
   * and one unassigned member refuses the whole call: a stale selection must
   * not mint a snapshot for an account this workspace no longer has.
   */
  providerAccountIds?: string | readonly string[] | null,
): Promise<RunMetaSnapshotResult> {
  const normalizedSnapshotDate = normalizeDate(snapshotDate);
  const calibration = await runMetaCalibrationForBusiness(
    businessId,
    normalizedSnapshotDate,
  );
  await runMetaSignalsBackfillForBusiness(
    businessId,
    normalizedSnapshotDate,
  ).catch((error) => {
    console.warn("[meta-snapshot] signals_backfill_failed", {
      businessId,
      snapshotDate: normalizedSnapshotDate,
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  });
  /*
   * PER-ACCOUNT GENERATION (D-M011).
   *
   * D-M009 computed one business-wide decision and then LABELLED each row with
   * an account derived from its campaign. Every number inside that row — spend,
   * ROAS, the percentile it was compared against, the calibration context, the
   * hysteresis memory — came from a pool of every assigned account. A row that
   * says "account A" while its evidence is A+B is not an account-scoped
   * decision; it is an aggregate wearing a label, and D6 asks for the former.
   *
   * So the inputs are narrowed BEFORE the computation, once per assigned
   * account, and each account is computed and persisted independently.
   *
   * ## What stays once per business, and why
   *
   * CALIBRATION runs above this loop. `getMetaCalibrationScope` is already
   * called per campaign WITH `accountId` (see `buildCalibrationContexts`), so
   * the cells it produces are account-scoped already; running the whole
   * calibration pass per account would recompute the same cells N times.
   *
   * ANOMALIES stay once per business, in the epilogue. Their detector resolves
   * open anomalies with a business-wide `NOT EXISTS` that has no account
   * predicate available, so running it inside the loop would let account A's
   * run resolve account B's open anomalies. They are written with NULL lineage
   * for a multi-account business, which the account-scoped read then withholds
   * — the fail-closed direction, and honest about what the detector can prove.
   *
   * ## Failure is contained per account
   *
   * INVARIANTS is explicit for the sibling native path: a per-account failure
   * "must not abort healthy sibling accounts". `Promise.allSettled` here is
   * that law. One account failing leaves the others written, and the result
   * reports which failed instead of throwing the whole run away.
   */
  const assignedAccounts = await readAssignedMetaAccountIds(businessId);
  const requestedAccounts = (
    typeof providerAccountIds === "string"
      ? [providerAccountIds]
      : (providerAccountIds ?? [])
  )
    .map((account) => account.trim())
    .filter((account) => account.length > 0);
  if (
    requestedAccounts.some((account) => !assignedAccounts.includes(account))
  ) {
    /*
     * A stale or revoked selection is refused, not computed. Generating a
     * snapshot for an account this workspace no longer has would mint decisions
     * about spend nobody here controls, and the respond boundary would then
     * treat them as authority.
     */
    return {
      businessId,
      snapshotDate: normalizedSnapshotDate,
      calibration,
      recommendationsWritten: 0,
      anomaliesWritten: 0,
      proposals: null,
      budgetProposals: null,
      bidProposals: null,
      launchProposals: null,
      activationProposals: null,
      failedAccountIds: [],
      skippedReason: "provider_account_not_assigned",
    };
  }
  /*
   * A business with no assigned account still runs once, unscoped. That is not
   * a fallback to pooling — with nothing assigned there is nothing to pool —
   * and it preserves the pre-change behaviour for a workspace mid-setup.
   */
  const generationAccounts: Array<string | null> =
    requestedAccounts.length > 0
      ? requestedAccounts
      : assignedAccounts.length > 0
        ? assignedAccounts
        : [null];

  /*
   * Legacy NULL-lineage rows for this date are cleared ONCE, before the loop.
   *
   * They cannot be cleared inside it: `provider_account_id = $a` never matches
   * NULL, so they would survive every refresh forever — invisible to an
   * account-scoped read and visible to every business-scoped one. And a
   * predicate of `(= $a OR IS NULL)` inside the loop would have each account
   * delete the previous account's rows on its way past. Once, here, is the
   * only placement that is both complete and non-destructive.
   */
  await clearUnattributedRecommendationRows({
    businessId,
    snapshotDate: normalizedSnapshotDate,
  });

  /*
    Anomalies are detected BEFORE the per-account loop, and written after it.

    The detection has to come first because the bid sizing policy needs one of
    its results: a cap may only be RAISED when delivery is measurably
    constrained, and the only evidence of that in this product is the
    `delivery_stall` anomaly. The snapshot used to pass an empty set
    unconditionally, so no cap increase could ever be produced however well the
    ad set qualified.

    The WRITE still happens once, after every account — the detector is
    business-wide and its resolve pass has no account predicate, which is why
    it was outside the loop to begin with. Only the reading moved.

    The two profile numbers below are what the newer detectors need, from what
    this business has already configured. Neither runs without them: "spent
    this much with no purchases" and "spent the budget by mid-morning" are both
    claims about a threshold, and a threshold this module chose for itself
    would be a universal rule wearing a profile's clothes.
  */
  const anomalyTargets = await readMetaCommercialTargets(businessId, {
    asOf: normalizedSnapshotDate,
  }).catch(() => null);
  const lossBudget = metaLossBudgetMaturity({ targets: anomalyTargets });
  const businessZone = (await getDb()`
    SELECT timezone FROM businesses WHERE id = ${businessId}::uuid LIMIT 1
  `.catch(() => null)) as Array<{ timezone: string | null }> | null;

  const anomalies = await detectAnomaliesForBusiness({
    businessId,
    snapshotDate: normalizedSnapshotDate,
    calibrationContext: null,
    profile: {
      lossBudgetSpend: lossBudget?.spendThreshold ?? null,
      timezone: businessZone?.[0]?.timezone ?? null,
    },
  }).catch(() => [] as MetaAnomaly[]);
  const deliveryConstrainedAdsetIds = deliveryConstrainedAdsetIdsFrom(anomalies);

  const perAccount = await Promise.allSettled(
    generationAccounts.map(async (accountId) => {
      const { recommendations: rawRecommendations, lineage: accountLineage } =
        await buildSnapshotRecommendations({
          businessId,
          snapshotDate: normalizedSnapshotDate,
          providerAccountId: accountId,
          deliveryConstrainedAdsetIds,
        });
      // CDC discipline: act-boundary state flips must hold two consecutive
      // snapshots before publishing. Memory-read failure degrades to
      // no-hysteresis (publish raw) instead of failing the snapshot run. The
      // memory is THIS account's; a sibling account's flips are not evidence
      // about this one.
      const previousStates = await readPreviousMetaDecisionStates({
        businessId,
        asOf: normalizedSnapshotDate,
        engineVersion: META_RECOMMENDATION_ENGINE_VERSION,
        providerAccountId: accountId,
      }).catch((error) => {
        console.warn("[meta-snapshot] previous_state_read_failed", {
          businessId,
          providerAccountId: accountId,
          snapshotDate: normalizedSnapshotDate,
          message: error instanceof Error ? error.message : String(error),
        });
        return new Map<string, never>();
      });
      const { recommendations, suppressedCount } = stabilizeMetaRecommendations({
        recommendations: rawRecommendations,
        previousByKey: previousStates,
        scopeFor: (recommendation) => {
          const scope = scopeForRecommendation(recommendation, businessId);
          return { scopeType: scope.scopeType, scopeId: scope.scopeId };
        },
        providerAccountId: accountId,
      });
      if (suppressedCount > 0) {
        console.info("[meta-snapshot] state_transitions_suppressed", {
          businessId,
          providerAccountId: accountId,
          snapshotDate: normalizedSnapshotDate,
          suppressedCount,
        });
      }
      const evidenceTrails = await buildEvidenceTrailsForRecommendations({
        businessId,
        providerAccountId: accountId,
        snapshotDate: normalizedSnapshotDate,
        recommendations,
      });
      /*
       * The row's account is the account this run was FOR, not one derived
       * from a campaign after the fact. `accountLineage` still resolves
       * campaign and ad-set rows, but with the window narrowed those all
       * belong to this account anyway — so the two agree, and where they
       * cannot (an account-level row), the run's own account is the answer.
       */
      const scopedLineage: SnapshotAccountLineage = accountId
        ? { ...accountLineage, soleAssignedAccountId: accountId }
        : accountLineage;
      const rows = recommendations.map((recommendation) =>
        recommendationToSnapshotRow(
          recommendation,
          businessId,
          normalizedSnapshotDate,
          evidenceTrails[recommendation.id] ?? null,
          scopedLineage,
        ),
      );
      await upsertSnapshotRows({
        businessId,
        snapshotDate: normalizedSnapshotDate,
        providerAccountId: accountId,
        rows,
      });
      /*
        What this account's generation saw of the source, read here and never
        inferred from the request. A reading that itself fails reports nothing
        rather than a value — "we did not read" must not overwrite the last
        real observation — and it must not take the generation down with it,
        since the rows above are already written and correct.
      */
      const sourceMaxDateRead = await readSnapshotSourceMaxDate({
        businessId,
        providerAccountId: accountId,
        throughDate: normalizedSnapshotDate,
      })
        .then((maxDate) => ({ maxDate }))
        .catch((error) => {
          console.warn("[meta-snapshot] source_max_date_unread", {
            businessId,
            providerAccountId: accountId,
            snapshotDate: normalizedSnapshotDate,
            message: error instanceof Error ? error.message : String(error),
          });
          return null;
        });
      return { accountId, recommendations, rows: rows.length, sourceMaxDateRead };
    }),
  );

  const failedAccounts = perAccount
    .map((outcome, index) => ({ outcome, accountId: generationAccounts[index] ?? null }))
    .filter((entry) => entry.outcome.status === "rejected");
  for (const failure of failedAccounts) {
    console.warn("[meta-snapshot] account_generation_failed", {
      businessId,
      providerAccountId: failure.accountId,
      snapshotDate: normalizedSnapshotDate,
      message:
        failure.outcome.status === "rejected"
          ? String((failure.outcome as PromiseRejectedResult).reason)
          : "",
    });
  }
  const recommendations = perAccount.flatMap((outcome) =>
    outcome.status === "fulfilled" ? outcome.value.recommendations : [],
  );
  const sourceMaxDateByAccountId: Record<string, string | null> = {};
  for (const outcome of perAccount) {
    if (outcome.status !== "fulfilled") continue;
    const reading = outcome.value.sourceMaxDateRead;
    if (reading === null) continue;
    sourceMaxDateByAccountId[outcome.value.accountId ?? ""] = reading.maxDate;
  }

  /*
   * Anomalies, once, after every account has been written. Their detector is
   * business-wide and its resolve pass has no account predicate, so it belongs
   * outside the loop — see the note above.
   */
  await upsertSnapshotRows({
    businessId,
    snapshotDate: normalizedSnapshotDate,
    providerAccountId: null,
    // Anomalies only. The recommendation batches are already written and each
    // belongs to an account this call knows nothing about.
    replaceRecommendations: false,
    rows: anomalies.map((anomaly) =>
      anomalyToSnapshotRow(anomaly, businessId, normalizedSnapshotDate, null),
    ),
  });
  // The confirmation queue is a projection of the rows that just landed, so it
  // is refreshed here and nowhere else. This is what "expired proposals
  // re-evaluate on the next snapshot" means literally: the sweep ages out what
  // the previous snapshot proposed, and the insert re-raises whatever this one
  // still says. A failure degrades to "the queue was not projected" rather than
  // failing the snapshot — the decisions themselves are already durable.
  const proposals = await projectMetaAutomationProposals({
    businessId,
    snapshotDate: normalizedSnapshotDate,
  })
    .then((result) =>
      result.ran
        ? { projected: result.projected, expired: result.expired }
        : null,
    )
    .catch((error) => {
      console.warn("[meta-snapshot] proposal_projection_failed", {
        businessId,
        snapshotDate: normalizedSnapshotDate,
        message: error instanceof Error ? error.message : String(error),
      });
      return null;
    });
  /*
    D088: the CANONICAL BUDGET producer, on the same chain and the same tick.

    It raises rows only from a persisted `increase_budget`/`decrease_budget`
    recommendation carrying an exact minor-unit target, and only when D083 →
    D085 → D087 admit the candidate. With today's retained decisions it projects
    zero; when a qualifying typed intent appears it needs no source change.

    A failure degrades exactly like the pause projection above: the queue was
    not projected, and the snapshot still stands.
  */
  /*
    The day's RETAINED COMMERCIAL VERDICT, before anything asks for it.

    `engine_v3_account_profile_output` is what the budget composition reads to
    answer "is this account commercially eligible today, and if not, by which
    named blocker". The table was described in a prepared pack, never applied
    and never written, so the loader's read failed, the failure became
    `composition_sources_unavailable`, and no budget candidate could ever be
    admitted. The producer exists now; this is its first production caller, on
    the same chain and the same tick as every other producer.

    Per account, because the verdict is an account's own and pooling two
    accounts' facts would be inventing a third account. It degrades like the
    projections below: a failure means the verdict was not retained this tick,
    the loader's own ensure-probe still covers the gap, and every reader treats
    an absent verdict as review-only rather than as permission.
  */
  for (const accountId of generationAccounts) {
    /*
      `null` means this business has no assigned account at all, and the
      generation ran unscoped. There is no account whose verdict this would be,
      so nothing is retained rather than a row keyed on an empty identity.
    */
    if (!accountId) continue;
    await produceRetainedAccountProfileOutputs({
      businessId,
      providerAccountId: accountId,
      asOfDate: normalizedSnapshotDate,
    }).catch((error: unknown) => {
      console.warn("[meta-snapshot] account_profile_output_failed", {
        businessId,
        providerAccountId: accountId,
        snapshotDate: normalizedSnapshotDate,
        message: error instanceof Error ? error.message : String(error),
      });
      return null;
    });
  }
  const budgetProposals = await projectMetaBudgetProposals({
    businessId,
    snapshotDate: normalizedSnapshotDate,
    loadCompositionSources: loadBudgetCompositionSourcesForCandidate,
    insertProposal: async (insert) => insertBudgetProposalRow({
      businessId,
      proposalId: insert.proposalId,
      candidate: insert.candidate,
      envelopeJson: insert.envelopeJson,
      actionLabel: insert.actionLabel,
    }),
  })
    .then((result) => ({ candidates: result.candidates, projected: result.projected }))
    .catch((error) => {
      console.warn("[meta-snapshot] budget_proposal_projection_failed", {
        businessId,
        snapshotDate: normalizedSnapshotDate,
        message: error instanceof Error ? error.message : String(error),
      });
      return null;
    });
  /*
    The BID producer, on the same chain and the same tick as the budget one.

    `bid` has been an allowed queue action since the table was created and
    nothing has ever raised one, which is why unattended bid execution was
    excluded rather than built. The sizing policy and the intent contract were
    already here; this is the step that turns the typed intent the snapshot
    just wrote into a row an operator can approve.

    Like the two projections above, a failure degrades to "the queue was not
    projected" — the decisions are already durable and the card still shows the
    amount.
  */
  const bidProposals = await projectMetaBidProposals({
    businessId,
    snapshotDate: normalizedSnapshotDate,
    insertProposal: async (insert) => insertBidProposalRow({
      businessId,
      proposalId: insert.proposalId,
      candidate: insert.candidate,
      envelopeJson: insert.envelopeJson,
      actionLabel: insert.actionLabel,
    }),
  })
    .then((result) => ({ candidates: result.candidates, projected: result.projected }))
    .catch((error) => {
      console.warn("[meta-snapshot] bid_proposal_projection_failed", {
        businessId,
        snapshotDate: normalizedSnapshotDate,
        message: error instanceof Error ? error.message : String(error),
      });
      return null;
    });

  /*
    First the STAGING producer, because the queue producer below it reads what
    this one writes and both belong to the same tick.

    The launch row's candidate query wants a prepared intent carrying decision,
    snapshot or brief lineage, and nothing in the product ever wrote one — the
    wizard stages and executes inside a single request, and the operator intent
    API stages one with no lineage — so the row was unreachable by construction
    and the creative operation matrix had no first caller. This is that caller.
    It composes nothing: the decision, the reviewed brief and the operator's own
    draft supply the asset, the copy mode and the exact destination, and a
    candidate missing any of them is refused by name rather than filled in.

    It degrades exactly like the projections around it: a failure means nothing
    was staged this tick, and the decisions themselves are already durable.
  */
  await projectMetaLaunchIntents({
    businessId,
    snapshotDate: normalizedSnapshotDate,
  }).catch((error) => {
    console.warn("[meta-snapshot] launch_intent_staging_failed", {
      businessId,
      snapshotDate: normalizedSnapshotDate,
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  });

  /*
    And the launch producer, which points at intents rather than decisions.

    `launch` became an allowed queue action with a CHECK requiring the intent
    id, and nothing ever raised one: a validated intent sat in `ready` where
    only the Launchpad screen could see it, so the queue an operator actually
    works from never mentioned it. The row is a pointer; the intent stays the
    authority, and creating anything remains an operator's act.
  */
  const launchProposals = await projectMetaLaunchProposals({
    businessId,
    snapshotDate: normalizedSnapshotDate,
    insertProposal: async (insert) => insertLaunchProposalRow({
      candidate: insert.candidate,
      snapshotDate: normalizedSnapshotDate,
      actionLabel: insert.actionLabel,
    }),
  })
    .then((result) => ({ candidates: result.candidates, projected: result.projected }))
    .catch((error) => {
      console.warn("[meta-snapshot] launch_proposal_projection_failed", {
        businessId,
        snapshotDate: normalizedSnapshotDate,
        message: error instanceof Error ? error.message : String(error),
      });
      return null;
    });

  /*
    And the activation producer, which is the other half of the same story.

    A launch intent may only create PAUSED entities, so a successful launch is a
    receipt for something nobody can see. Nothing raised a row for it, and the
    Launchpad receipt has no activation control, so a created campaign could sit
    switched off with nothing anywhere reminding the operator it was waiting.

    The batch-level catch below each of these producers still stands, but a
    single duplicate no longer needs it: both absorb a per-candidate conflict
    inside the loop, so one clash cannot drop the candidates behind it.
  */
  const activationProposals = await projectMetaActivationProposals({
    businessId,
    snapshotDate: normalizedSnapshotDate,
    insertProposal: async (insert) => insertActivationProposalRow({
      candidate: insert.candidate,
      snapshotDate: normalizedSnapshotDate,
      actionLabel: insert.actionLabel,
    }),
  })
    .then((result) => ({ candidates: result.candidates, projected: result.projected }))
    .catch((error) => {
      console.warn("[meta-snapshot] activation_proposal_projection_failed", {
        businessId,
        snapshotDate: normalizedSnapshotDate,
        message: error instanceof Error ? error.message : String(error),
      });
      return null;
    });

  return {
    businessId,
    snapshotDate: normalizedSnapshotDate,
    calibration,
    budgetProposals,
    bidProposals,
    launchProposals,
    activationProposals,
    recommendationsWritten: recommendations.length,
    failedAccountIds: failedAccounts
      .map((entry) => entry.accountId)
      .filter((id): id is string => typeof id === "string"),
    /*
      Which accounts THIS attempt actually generated for.

      The scheduler needs it to record slot completion from the attempt rather
      than from a row query: rows written at 03:00 are still there at 15:00, so
      a failed afternoon run could be closed by the morning's own output and
      the retry suppressed. `""` is the unattributed batch a business with no
      assignment produces, and it is a real account key here for the same
      reason the coverage query treats it as one.
    */
    succeededAccountIds: perAccount
      .map((outcome, index) => ({ outcome, accountId: generationAccounts[index] ?? "" }))
      .filter((entry) => entry.outcome.status === "fulfilled")
      .map((entry) => entry.accountId ?? ""),
    sourceMaxDateByAccountId,
    anomaliesWritten: anomalies.length,
    proposals,
  };
}

/**
 * The accounts a retry should name for one business, or null for all of them.
 *
 * `null` means "the whole business", which is what an unqualified run has
 * always meant — and what the `""` unattributed pair must also resolve to,
 * since a business with no assignment produces exactly one unscoped batch and
 * naming `""` as an account would refuse the run outright.
 */
export function metaSnapshotRetryAccountsFor(
  requested: ReadonlyArray<{ businessId: string; providerAccountId: string }> | null,
  businessId: string,
): string[] | null {
  if (!requested) return null;
  const accounts = requested
    .filter((pair) => pair.businessId === businessId)
    .map((pair) => pair.providerAccountId)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  return accounts.length > 0 ? accounts : null;
}

export async function runMetaSnapshotForAllBusinesses(
  snapshotDate: string,
  input?: {
    /**
     * The (business, account) pairs still outstanding for this slot.
     *
     * Omitted runs every active business, which is what every existing caller
     * means. Supplied, it runs only what is missing — the scheduler's retry
     * of a failed afternoon slot must not regenerate the accounts that already
     * succeeded in it.
     */
    onlyPairs?: ReadonlyArray<{ businessId: string; providerAccountId: string }>;
  },
): Promise<RunMetaSnapshotAllBusinessesResult> {
  const normalizedSnapshotDate = normalizeDate(snapshotDate);
  const businesses = await getActiveBusinesses();
  /*
    Only the pairs the caller says are missing, when it says so.

    A slot that failed for one account must not re-run every account: the
    others already produced this slot's rows, and re-running them costs a full
    generation each and rewrites truth that was already correct.
  */
  const requested = input?.onlyPairs ?? null;
  const targeted = requested
    ? businesses.filter((business) =>
      requested.some((pair) => pair.businessId === business.id))
    : businesses;
  const settled = await Promise.allSettled(
    targeted.map((business) => {
      const accounts = metaSnapshotRetryAccountsFor(requested, business.id);
      // EVERY account this slot still owes for this business, in one run. The
      // test used to be `accounts.length === 1`, which sent a business with
      // two missing accounts down the unqualified path — and that regenerates
      // every ASSIGNED account, including the one that already succeeded in
      // this slot, at the cost of a full generation and a rewrite of truth
      // that was already correct.
      return accounts
        ? runMetaSnapshotForBusiness(business.id, normalizedSnapshotDate, accounts)
        : runMetaSnapshotForBusiness(business.id, normalizedSnapshotDate);
    }),
  );
  const businessesForResult = targeted;
  return {
    snapshotDate: normalizedSnapshotDate,
    businessCount: businessesForResult.length,
    results: settled.map((result, index) => {
      const businessId = businessesForResult[index]?.id ?? "unknown";
      if (result.status === "fulfilled") {
        return {
          businessId,
          status: "fulfilled" as const,
          value: result.value,
        };
      }
      return {
        businessId,
        status: "rejected" as const,
        reason:
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason),
      };
    }),
  };
}

function decisionWeight(state: MetaRecommendation["decisionState"]) {
  if (state === "act") return 30;
  if (state === "test") return 20;
  return 10;
}

function priorityFromScore(score: number): MetaRecommendationPriority {
  return metaConfidenceBucket(score);
}

function lensFromLevel(level: MetaRecommendationLevel): MetaRecommendationLens {
  return level === "account" ? "structure" : "profitability";
}

function fallbackTimeframeContext(row: SnapshotDbRow): MetaRecommendation["timeframeContext"] {
  return {
    coreVerdict: row.reasoning,
    selectedRangeOverlay:
      row.predictive_overlay ?? "Persisted daily Meta decision snapshot.",
    historicalSupport:
      row.engine_version === META_RECOMMENDATION_ENGINE_VERSION
        ? "Generated by calibrated Meta snapshot engine."
        : "Generated by persisted Meta snapshot engine.",
    seasonalityFlag: "none",
    note: null,
  };
}

function evidenceItems(value: unknown): MetaRecommendation["evidence"] {
  if (Array.isArray(value)) return value as MetaRecommendation["evidence"];
  if (value && typeof value === "object") {
    const items = (value as { items?: unknown }).items;
    if (Array.isArray(items)) return items as MetaRecommendation["evidence"];
  }
  return [];
}

function storedRecommendation(value: unknown): MetaRecommendation | null {
  if (!value || typeof value !== "object") return null;
  const recommendation = (value as { recommendation?: unknown }).recommendation;
  if (!recommendation || typeof recommendation !== "object") return null;
  return recommendation as MetaRecommendation;
}

function hydrateRecommendation(row: SnapshotDbRow): MetaRecommendation {
  const parsedScore =
    row.confidence_score == null ? null : Number(row.confidence_score);
  const score =
    parsedScore != null && Number.isFinite(parsedScore) ? parsedScore : null;
  const stored = storedRecommendation(row.evidence);
  const confidence =
    stored?.confidence === "low" ||
    stored?.confidence === "medium" ||
    stored?.confidence === "high"
      ? stored.confidence
      : score == null
        ? "low"
        : confidenceLabel(score);
  if (stored) {
    return {
      ...stored,
      id: row.rec_id,
      type: row.rec_type as MetaRecommendation["type"],
      level: row.level,
      decisionState: row.decision_state,
      confidenceScore: score ?? undefined,
      confidence,
      confidenceReason:
        score == null ? "confidence_score_missing" : stored.confidenceReason,
      evidence: evidenceItems(row.evidence),
      recommendedAction: row.recommended_action,
      expectedImpact: row.expected_impact ?? stored.expectedImpact,
      why: row.reasoning,
      predictiveOverlay: row.predictive_overlay ?? stored.predictiveOverlay ?? null,
      engineVersion: row.engine_version,
      evidenceTrail:
        row.evidence_trail && typeof row.evidence_trail === "object"
          ? (row.evidence_trail as MetaEvidenceTrail)
          : stored.evidenceTrail,
      campaignRole: row.campaign_role ?? stored.campaignRole,
      bidRegime: row.bid_regime ?? stored.bidRegime,
      decisionLabel: row.decision_label ?? stored.decisionLabel,
      stateReason: row.state_reason ?? stored.stateReason,
      calibrationScope:
        row.calibration_scope && typeof row.calibration_scope === "object"
          ? (row.calibration_scope as Record<string, unknown>)
          : stored.calibrationScope,
      signalQuality:
        row.signal_quality && typeof row.signal_quality === "object"
          ? (row.signal_quality as Record<string, unknown>)
          : stored.signalQuality,
    };
  }

  return {
    id: row.rec_id,
    level: row.level,
    ...(row.level === "campaign" ? { campaignId: row.scope_id } : {}),
    ...(row.level === "adset" ? { adsetId: row.scope_id } : {}),
    type: row.rec_type as MetaRecommendation["type"],
    lens: lensFromLevel(row.level),
    priority: score == null ? "low" : priorityFromScore(score),
    confidence,
    confidenceScore: score ?? undefined,
    confidenceReason: score == null ? "confidence_score_missing" : null,
    decisionState: row.decision_state,
    decision: row.recommended_action,
    title: row.recommended_action,
    why: row.reasoning,
    summary: row.reasoning,
    recommendedAction: row.recommended_action,
    expectedImpact: row.expected_impact ?? "",
    evidence: evidenceItems(row.evidence),
    timeframeContext: fallbackTimeframeContext(row),
    targetValue: row.target_value,
    predictiveOverlay: row.predictive_overlay,
    engineVersion: row.engine_version,
    evidenceTrail:
      row.evidence_trail && typeof row.evidence_trail === "object"
        ? (row.evidence_trail as MetaEvidenceTrail)
        : undefined,
    campaignRole: row.campaign_role ?? undefined,
    bidRegime: row.bid_regime ?? undefined,
    decisionLabel: row.decision_label ?? undefined,
    stateReason: row.state_reason ?? undefined,
    calibrationScope:
      row.calibration_scope && typeof row.calibration_scope === "object"
        ? (row.calibration_scope as Record<string, unknown>)
        : undefined,
    signalQuality:
      row.signal_quality && typeof row.signal_quality === "object"
        ? (row.signal_quality as Record<string, unknown>)
        : undefined,
  };
}

function buildSnapshotSummary(recommendations: MetaRecommendation[]): MetaDecisionSummary {
  if (recommendations.length === 0) {
    return {
      title: "No persisted Meta recommendation snapshot",
      summary: "No daily Meta decision snapshot rows were found for the selected range.",
      primaryLens: "structure",
      confidence: "low",
      recommendationCount: 0,
    };
  }
  const sorted = [...recommendations].sort(
    (left, right) =>
      decisionWeight(right.decisionState) - decisionWeight(left.decisionState) ||
      (right.confidenceScore ?? 0) - (left.confidenceScore ?? 0),
  );
  const top = sorted[0]!;
  const actCount = sorted.filter((item) => item.decisionState === "act").length;
  return {
    title:
      top.decisionState === "act"
        ? "Highest-priority Meta action"
        : "Meta watchlist and tests",
    summary:
      actCount > 0
        ? `${actCount} persisted recommendation${actCount === 1 ? "" : "s"} are strong enough to act on now. Highest priority: ${top.title}.`
        : `No persisted act-now recommendation yet. Strongest current signal: ${top.title}.`,
    primaryLens: top.lens,
    confidence: top.confidence,
    recommendationCount: sorted.length,
    operatingMode: "Calibrated snapshot mode",
    currentRegime: null,
    recommendedMode: null,
  };
}

/**
 * Reads the latest persisted decision truth. startDate/endDate describe the
 * metric context returned to the caller; they never time-travel buyer actions.
 */
export async function readLatestMetaDecisionSnapshot(input: {
  businessId: string;
  startDate: string;
  endDate: string;
  /**
   * The ONE physical provider account this read is scoped to.
   *
   * When given, rows are restricted to it and rows whose lineage cannot be
   * proven — legacy rows written before `provider_account_id` existed, and
   * account-level rows for a business with more than one assigned account —
   * are WITHHELD rather than shown. D6 says one physical provider account;
   * showing a row that might belong to another account is the failure mode
   * this exists to remove, and a synthetic "belongs to all accounts" fallback
   * would be exactly that failure wearing a default.
   *
   * Omitted keeps the pre-lineage behaviour: business-wide, every row. The
   * business-scoped callers (History, lane classification, the cron marker)
   * are not account surfaces and are unchanged.
   */
  providerAccountId?: string | null;
}): Promise<MetaRecommendationsResponse | null> {
  const readiness = await getDbSchemaReadiness({
    tables: ["meta_decision_snapshots_daily"],
  }).catch(() => null);
  if (!readiness?.ready) return null;

  const sql = getDb();
  /*
   * Account scope, applied to BOTH halves.
   *
   * The `latest` CTE has to carry it too: without that, a business whose newest
   * snapshot happens to contain only another account's rows would resolve a
   * date this account has nothing on, and the surface would report an empty
   * current snapshot rather than this account's real one.
   *
   * `IS NOT DISTINCT FROM` is deliberately NOT used. A null lineage must not
   * match a requested account — that is the withholding this exists for.
   */
  const account = input.providerAccountId?.trim() || null;
  const rows = (await sql`
    WITH latest AS (
      SELECT MAX(snapshot_date) AS snapshot_date
      FROM meta_decision_snapshots_daily
      WHERE business_id = ${input.businessId}
        AND kind = 'recommendation'
        AND (${account}::text IS NULL OR provider_account_id = ${account})
    )
    SELECT
      scope_type,
      scope_id,
      business_id,
      snapshot_date::text AS snapshot_date,
      rec_id,
      rec_type,
      level,
      decision_state,
      confidence_score,
      evidence,
      recommended_action,
      target_value,
      expected_impact,
      reasoning,
      predictive_overlay,
      engine_version,
      evidence_trail,
      campaign_role,
      bid_regime,
      decision_label,
      state_reason,
      calibration_scope,
      signal_quality,
      created_at::text AS created_at
    FROM meta_decision_snapshots_daily
    WHERE business_id = ${input.businessId}
      AND snapshot_date = (SELECT snapshot_date FROM latest)
      AND kind = 'recommendation'
      AND (${account}::text IS NULL OR provider_account_id = ${account})
    ORDER BY
      CASE decision_state
        WHEN 'act' THEN 3
        WHEN 'test' THEN 2
        ELSE 1
      END DESC,
      confidence_score DESC,
      rec_type ASC
  `) as SnapshotDbRow[];

  if (rows.length === 0) return null;
  const hydratedRecommendations = rows.map(hydrateRecommendation);
  const currentCommercialTargets = await readMetaCommercialTargets(
    input.businessId,
  ).catch(() => null);
  const commerciallyGuardedRecommendations = hydratedRecommendations.map(
    (recommendation) =>
      enforceMetaCommercialActionAuthority(
        recommendation,
        currentCommercialTargets,
      ),
  );
  const campaignIds = Array.from(
    new Set(
      commerciallyGuardedRecommendations
        .map((recommendation) => recommendation.campaignId)
        .filter((campaignId): campaignId is string => Boolean(campaignId)),
    ),
  );
  const campaignContextState = await readCampaignContextGuardState({
    businessId: input.businessId,
    providerAccountId: account,
    campaignIds,
    asOf: rows[0]?.snapshot_date ?? normalizeDate(input.endDate),
  });
  const campaignLabelsById = campaignContextState.campaignLabelsById;
  const guardedRecommendations = applyMetaCampaignLabelGuard({
    recommendations: commerciallyGuardedRecommendations,
    campaignLabelsById,
    campaignContextById: campaignContextState.campaignContextById,
    automaticContextEnabled: campaignContextState.automaticContextEnabled,
    activeCampaignIds: campaignIds,
  }).recommendations;
  const recommendations = await attachMetaEmpiricalOutcomeSummariesFromLogs({
    businessId: input.businessId,
    // The same account this read already withholds rows by. Serving a row that
    // belongs to this account with outcome evidence pooled across every account
    // would reintroduce, in the evidence, exactly what the row filter removes.
    providerAccountId: account,
    recommendations: guardedRecommendations,
  });
  const servedSnapshotDate = rows[0]?.snapshot_date ?? null;
  const servedSnapshotCreatedAt = rows.reduce<string | null>(
    (latest, row) =>
      row.created_at && (!latest || row.created_at > latest) ? row.created_at : latest,
    null,
  );
  return {
    status: "ok",
    businessId: input.businessId,
    startDate: normalizeDate(input.startDate),
    endDate: normalizeDate(input.endDate),
    summary: buildSnapshotSummary(recommendations),
    recommendations,
    sourceModel: "snapshot_persistent",
    snapshotDate: servedSnapshotDate,
    snapshotCreatedAt: servedSnapshotCreatedAt,
    analysisSource: {
      system: "snapshot_persistent",
      decisionOsAvailable: false,
      fallbackReason: "meta_engine_v1_snapshot",
    },
  };
}

// Compatibility export for existing callers and mocks. The selected range is
// metric context only; the decision snapshot itself is always the latest one.
export const readMetaDecisionSnapshotForRange = readLatestMetaDecisionSnapshot;
