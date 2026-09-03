import { createHash } from "node:crypto";
import { CREATIVE_DECISION_CENTER_ADAPTER_VERSION } from "@/lib/creative-decision-center/adapter";
import { CREATIVE_DECISION_CENTER_V3_BRIDGE_VERSION } from "@/lib/creative-decision-center/v3-bridge";
import {
  DECISION_BADGE_DISPLAY,
  DECISION_AUTHORITY_BLOCKERS,
  NATIVE_AD_ENGINE_VERSION,
  type DecisionAuthorityBlocker,
  type DecisionBadge,
  type DecisionLabel,
  type DecisionOutput,
  type TruthSource,
} from "@/lib/creative-decision-engine/types";
import { hashAdDecisionIdentityManifest } from "@/lib/creative-decision-engine/data-source";
import { ENGINE_V3_JOB_TRANSACTION_TIMEOUT_MS } from "@/lib/creative-decision-engine/jobs/job-runtime";
import {
  evaluateDecisionOriginAdDecisionFreshness,
} from "@/lib/creative-decision-engine/execution-safety";
import { getDb, getDbWithTimeout } from "@/lib/db";
import {
  CAMPAIGN_CONTEXT_MAX_AGE_DAYS,
  isCampaignContextResolverAuthorityValidated,
  resolveCampaignContextMode,
} from "@/lib/creative-decision-engine/campaign-context/source";
import { DEFAULT_CONTEXT_CONFIG } from "@/lib/creative-decision-engine/campaign-context/resolver";
import { evaluateAccountScopedRoleAuthority } from "@/lib/meta/campaign-role-authority";
import type { MetaCreativeAssessmentPresentation } from "@/lib/meta/creative-assessment";
import { projectCanonicalMetaDecisionPresentation } from "@/lib/meta/canonical-decision-presentation";
import {
  META_DECISIONS_AD_CANDIDATE_LANE_RESERVE,
  META_DECISIONS_AD_CANDIDATE_MAX_LIMIT,
  META_DECISIONS_AD_CANDIDATE_SELECTION_VERSION,
  META_DECISIONS_CLASSIFICATION_OVERLAY_VERSION,
  META_DECISIONS_AD_CANDIDATE_LIMIT,
  META_DECISIONS_SECTION_SELECTION_VERSION,
  META_DECISIONS_WORKSPACE_CONTRACT_VERSION,
  META_DECISIONS_WORKSPACE_SECTION_LIMIT,
  META_DECISION_QUEUE_SECTION_KEYS,
  type MetaCanonicalDecision,
  type MetaDecisionAdvisory,
  type MetaDecisionAssessmentOverlay,
  type MetaDecisionBlocker,
  type MetaDecisionBuyerAction,
  type MetaDecisionCapabilityState,
  type MetaDecisionExposure,
  type MetaDecisionHistoryEnvelope,
  type MetaDecisionLifecycleRoleOverlay,
  type MetaDecisionProvenance,
  type MetaDecisionQueueSection,
  type MetaDecisionQueueSectionKey,
  type MetaDecisionSuppressionReason,
  type MetaDecisionsReadModelUnavailableCode,
  type MetaDecisionsWorkspaceReadModel,
} from "@/lib/meta/decisions-workspace-contract";

const META_DECISION_HISTORY_EVENT_LIMIT = 10;
const META_DECISION_HISTORY_EVENT_READ_LIMIT = 50;
const NATIVE_AD_DECISIONS_JOB_NAME = "engine_v3_native_ad_decisions_shadow_job";
export const NATIVE_DECISION_RUNNING_GRACE_MS =
  ENGINE_V3_JOB_TRANSACTION_TIMEOUT_MS * 4;
// The verified native generation currently hydrates thousands of exact-Ad
// rows. On the production-sized Grandmix account the read completes in about
// seven seconds, leaving virtually no headroom under the generic 8s web query
// budget. This is still bounded well below the workspace request deadline and
// changes only read tolerance, never decision generation or authority.
const NATIVE_DECISION_READ_TIMEOUT_MS = 20_000;

const SECTION_LABELS: Record<MetaDecisionQueueSectionKey, string> = {
  integrity_fires: "Integrity Fires",
  money_moves: "Money Moves",
  creative_rotation: "Creative Rotation",
};

const TRUTH_SOURCES = new Set<TruthSource>([
  "commercial_truth",
  "commercial_truth_stale",
  "account_baseline",
  "account_baseline_thin",
  "global_default",
]);

const DECISION_LABELS = new Set<DecisionLabel>([
  "scale",
  "keep",
  "refresh",
  "cut",
  "test_more",
  "diagnose",
  "out_of_scope",
]);

const AUTHORITY_BLOCKERS = new Set<DecisionAuthorityBlocker>(
  DECISION_AUTHORITY_BLOCKERS,
);

function persistedDecisionLabel(value: unknown): DecisionLabel | null {
  return DECISION_LABELS.has(value as DecisionLabel)
    ? (value as DecisionLabel)
    : null;
}

function persistedAuthorityBlocker(
  value: unknown,
): DecisionAuthorityBlocker | null {
  return AUTHORITY_BLOCKERS.has(value as DecisionAuthorityBlocker)
    ? (value as DecisionAuthorityBlocker)
    : null;
}

const BLOCKER_LABELS: Record<string, string> = {
  campaign_context_unresolved: "Campaign context is unresolved",
  campaign_context_low_confidence: "Campaign context confidence is too low",
  campaign_context_resolver_unvalidated:
    "Automatic campaign-role resolver has not passed its authority gate",
  campaign_context_conflict: "Campaign context sources conflict",
  campaign_role_unresolved: "Campaign context is missing",
  // Pre-D074b alias key: only older persisted payloads carry it.
  campaign_label_missing: "Campaign context is missing",
  data_health: "Data health is degraded",
  delivery_proof: "Delivery proof is missing",
  fatigue_proof_not_persisted: "Composite fatigue proof is unavailable",
  freshness: "Freshness evidence is missing",
  risk_tier_unclassified: "Risk is unclassified",
  scale_calibration: "Scale calibration is unavailable",
  stale_evidence: "Evidence is stale",
  tracking: "Tracking evidence is degraded",
  truth: "Commercial truth is degraded",
  commercial_truth_stale: "Commercial target evidence is stale",
  account_baseline_not_economic:
    "Account baseline is relative, not economic proof",
  winner_evidence_insufficient: "Winner evidence is insufficient",
  recent_recovery_unverifiable:
    "Recent economic recovery evidence is missing or too thin",
};

export interface MetaDecisionSnapshotSourceRow {
  snapshot_id: string;
  provider_account_id: string;
  creative_id: string;
  as_of_date: string;
  engine_version: string;
  scope_type: string;
  scope_id: string;
  label: string;
  pre_authority_label: string | null;
  authority_blocker: string | null;
  raw_label: string | null;
  confidence: unknown;
  truth_source: string;
  effective_target_roas: unknown;
  ratio_to_target: unknown;
  badges: unknown;
  reason: string;
  spend: unknown;
  purchases: unknown;
  roas: unknown;
  recent7d_roas: unknown;
  label_transform: string | null;
  blocked_action_type: string | null;
  computed_at: string;
  episode_started_at: string;
  creative_format?: string | null;
  ctr_28d?: unknown;
  frequency_28d?: unknown;
  fatigue_status?: string | null;
}

export interface MetaNativeDecisionSnapshotSourceRow {
  snapshot_id: string;
  evaluation_id: string;
  job_run_id: string;
  provider_account_ref_id: string;
  provider_account_id: string;
  ad_id: string;
  creative_id: string | null;
  as_of_date: string;
  engine_version: string;
  scope_type: string;
  scope_id: string;
  label: string;
  pre_authority_label: string | null;
  authority_blocker: string | null;
  raw_label: string | null;
  confidence: unknown;
  truth_source: string;
  effective_target_roas: unknown;
  ratio_to_target: unknown;
  badges: unknown;
  reason: string;
  spend: unknown;
  purchases: unknown;
  roas: unknown;
  recent7d_roas: unknown;
  label_transform: string | null;
  blocked_action_type: string | null;
  authorized_action: string | null;
  input_hash: string;
  decision_hash: string;
  computed_at: string;
  episode_started_at: string;
  lineage_valid: boolean;
  creative_name: string | null;
  campaign_id: string | null;
  campaign_name: string | null;
  adset_id: string | null;
  adset_name: string | null;
  ad_name: string | null;
  campaign_status?: string | null;
  adset_status?: string | null;
  ad_status?: string | null;
  currency: string | null;
  thumbnail_url: string | null;
  media_source_present: boolean;
  media_available: boolean;
  media_source: string | null;
  source_updated_at: string | null;
  /**
   * Lineage read from the lifecycle row the engine decided from. Optional so a
   * generation persisted before this join stays readable; absent is unknown.
   */
  creative_format?: string | null;
  ctr_28d?: unknown;
  frequency_28d?: unknown;
  fatigue_status?: string | null;
}

export interface MetaNativeDecisionGenerationSourceRow {
  job_status: string;
  job_run_id: string;
  as_of_date: string;
  engine_version: string;
  provider_account_ref_id: string | null;
  provider_account_id: string | null;
  expected_ad_count: unknown;
  expected_manifest_hash: string | null;
  hydrated_ad_count: unknown;
  hydrated_manifest_hash: string | null;
  authoritative_for_prune: unknown;
}

export interface MetaNativeDecisionResponseSourceRow {
  decision_snapshot_id: string;
  episode_key: string;
  response_id: string | null;
  observation_status: string | null;
  response_type: string | null;
  detected_at: string | null;
  response_cutoff: string | null;
  action_receipt_id: string | null;
}

export interface MetaDecisionIdentitySourceRow {
  provider_account_id: string | null;
  creative_id: string;
  creative_name: string | null;
  campaign_id: string | null;
  campaign_name: string | null;
  adset_id: string | null;
  adset_name: string | null;
  ad_id: string | null;
  ad_name: string | null;
  campaign_status?: string | null;
  adset_status?: string | null;
  ad_status?: string | null;
  currency: string | null;
  thumbnail_url: string | null;
  media_source_present: boolean;
  media_available: boolean;
  media_source: string | null;
  source_updated_at: string | null;
  candidate_ad_count?: unknown;
  status_source?: "warehouse_dimensions" | "meta_graph_ad_configs";
}

export interface MetaCurrentAdStatusSourceRow {
  providerAccountId: string;
  adId: string;
  adName: string | null;
  campaignId: string | null;
  campaignName?: string | null;
  adsetId: string | null;
  creativeId: string | null;
  configuredStatus: string | null;
  effectiveStatus: string | null;
  providerUpdatedAt: string | null;
  fetchedAt: string;
}

export interface MetaDecisionCampaignContextSourceRow {
  campaignId: string;
  kind: "main" | "test" | "mixed" | null;
  suggestedKind?: "main" | "test" | "mixed" | null;
  source: "system_inferred" | "unknown";
  confidenceClass: "high" | "medium" | "low" | "unknown" | "conflict";
  sourceUpdatedAt: string | null;
  resolverVersion: string | null;
  /**
   * D074/D076 explanation fields, additive and served verbatim.
   *
   * Optional only so previously built rows and fixtures stay valid; the reader
   * always populates them. `confidenceScore` is the resolver's own number for
   * its published kind, null when it persisted none.
   */
  confidenceScore?: number | null;
  /** The resolver's persisted evidence strings; malformed jsonb reads as []. */
  evidence?: string[];
  /** The resolver's persisted conflict reasons; malformed jsonb reads as []. */
  conflictReasons?: string[];
  /**
   * Why no kind is published, derived at read time from the persisted row:
   * confidence_class `unknown` → `insufficient_evidence`, `conflict` →
   * `conflicting_signals`, anything else (including no row at all) →
   * `not_yet_evaluated`. Null whenever a kind IS published.
   */
  unresolvedReason?:
    | "insufficient_evidence"
    | "conflicting_signals"
    | "not_yet_evaluated"
    | null;
  /** When the resolver last evaluated this campaign: updated_at, else as_of_date. */
  lastEvaluatedAt?: string | null;
}

export interface MetaDecisionEventSourceRow {
  id: string;
  creative_id: string;
  event_date: string;
  event_type:
    | "decision_changed"
    | "operator_action"
    | "data_disabled"
    | "manual_override";
  previous_label: string | null;
  current_label: string | null;
  operator_action_type: string | null;
  notes: string | null;
  pre_cap_count: unknown;
}

export interface MetaDecisionOutcomeSourceRow {
  id: string;
  decision_snapshot_id: string;
  outcome_window_days: unknown;
  evaluation_date: string;
  realized_outcome: "positive" | "negative" | "neutral" | "unknown";
  severity: "critical" | "high" | "medium" | "low";
  classifier_version: string;
}

interface MetaDecisionCampaignContextDbRow {
  campaign_id: string;
  inferred_kind: string | null;
  confidence_class: string | null;
  confidence_score: unknown;
  signal_scores_json: unknown;
  evidence_json: unknown;
  conflict_reasons_json: unknown;
  context_updated_at: string | null;
  context_as_of_date: string | null;
  resolver_version: string | null;
  /** The persisted origin. Only an exact `system_inferred` carries authority. */
  kind_source: string | null;
}

export interface BuildMetaDecisionsWorkspaceReadModelInput {
  businessId: string;
  providerAccountId: string;
  snapshotRows: MetaDecisionSnapshotSourceRow[];
  identityRows: MetaDecisionIdentitySourceRow[];
  campaignContextRows?: MetaDecisionCampaignContextSourceRow[];
  eventRows?: MetaDecisionEventSourceRow[];
  outcomeRows?: MetaDecisionOutcomeSourceRow[];
  eventSourceAvailable?: boolean;
  outcomeSourceAvailable?: boolean;
  generatedAt?: string;
  sectionLimit?: number;
  adCandidateLimit?: number;
  requireActiveHierarchy?: boolean;
  authorityMode?: "legacy_review_only" | "native_exact";
}

function stableId(prefix: string, values: readonly unknown[]) {
  const digest = createHash("sha256")
    .update(values.map((value) => String(value ?? "")).join("\u001f"))
    .digest("hex")
    .slice(0, 24);
  return `${prefix}_${digest}`;
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
}

/**
 * D081 C4 — the ONE exact-source mapping for a persisted campaign-context row.
 *
 * Raw equality against the retained value, with no `text()`, no `trim()`, no
 * case folding and no inference from mode, table presence or timestamps. An
 * earlier form compared `text(row.kind_source)`, which trims first, so
 * `" system_inferred"` and `"system_inferred "` were accepted as the automatic
 * origin; and a second arm synthesized the value from `mode === "automatic"`
 * entirely.
 *
 * Anything that is not byte-for-byte `system_inferred` is `unknown`, which
 * fails closed at the shared authority helper.
 */
export function exactCampaignContextSource(
  value: unknown,
): "system_inferred" | "unknown" {
  return value === "system_inferred" ? "system_inferred" : "unknown";
}

function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * A jsonb string array read defensively: the driver may hand back a parsed
 * array or raw JSON text, and the column may hold null or malformed content.
 * Anything that is not an array of strings reads as an empty array — never a
 * throw, and never a fabricated entry.
 */
function jsonStringArray(value: unknown): string[] {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed) as unknown;
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * A timestamp column as an ISO string. Postgres `::text` timestamps parse in
 * Node; an unparseable non-empty value travels verbatim rather than being
 * replaced with a fabricated time, and an empty column stays null.
 */
function isoTimestamp(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : raw;
}

/**
 * D074/D076: why the resolver publishes no kind for a campaign, said from the
 * persisted row's own confidence_class. `unknown` means the resolver ran and
 * found too little; `conflict` means it ran and found signals disagreeing;
 * anything else — including a campaign with no context row at all — has not
 * been evaluated yet.
 */
function campaignContextUnresolvedReason(
  confidenceClass: string | null,
): "insufficient_evidence" | "conflicting_signals" | "not_yet_evaluated" {
  if (confidenceClass === "unknown") return "insufficient_evidence";
  if (confidenceClass === "conflict") return "conflicting_signals";
  return "not_yet_evaluated";
}

export function resolveProvisionalCampaignKind(input: {
  kind: unknown;
  signalScores: unknown;
  campaignName?: unknown;
}): "main" | "test" | "mixed" {
  const persistedKind = text(input.kind);
  if (
    persistedKind === "main" ||
    persistedKind === "test" ||
    persistedKind === "mixed"
  ) {
    return persistedKind;
  }
  let scores = input.signalScores;
  if (typeof scores === "string") {
    try {
      scores = JSON.parse(scores) as unknown;
    } catch {
      scores = null;
    }
  }
  const scoreRecord =
    scores && typeof scores === "object"
      ? (scores as Record<string, unknown>)
      : {};
  const mainScore = finiteNumber(scoreRecord.mainScore) ?? 0;
  const testScore = finiteNumber(scoreRecord.testScore) ?? 0;
  const mixedScore = finiteNumber(scoreRecord.mixedScore) ?? 0;
  if (mixedScore > Math.max(mainScore, testScore)) return "mixed";
  if (Math.max(mainScore, testScore, mixedScore) <= 0) {
    const campaignName = text(input.campaignName)?.toLowerCase() ?? "";
    const testName = DEFAULT_CONTEXT_CONFIG.testNameTokens.some((token) =>
      campaignName.includes(token),
    );
    const mainName = DEFAULT_CONTEXT_CONFIG.mainNameTokens.some((token) =>
      campaignName.includes(token),
    );
    if (testName && mainName) return "mixed";
    if (testName) return "test";
    if (mainName) return "main";
  }
  // Mirrors the resolver's deterministic top-kind tie break. This is a
  // presentation-only provisional role and never grants decision authority.
  // Main is the deterministic display fallback when the current campaign has
  // not reached the daily resolver source; evaluation remains role-neutral.
  return testScore >= mainScore && testScore > 0 ? "test" : "main";
}

function exactNonNegativeInteger(value: unknown): number | null {
  const parsed = finiteNumber(value);
  return parsed !== null && Number.isInteger(parsed) && parsed >= 0
    ? parsed
    : null;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function nonNegativeInteger(value: unknown): number {
  const parsed = finiteNumber(value);
  return parsed === null ? 0 : Math.max(0, Math.trunc(parsed));
}

function verifiedMetaAdId(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized && /^\d+$/.test(normalized) ? normalized : null;
}

/** A trimmed string, or null — an empty column is unknown, not an empty label. */
function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeCurrency(value: unknown): string | null {
  const normalized = text(value)?.toUpperCase() ?? null;
  return normalized && /^[A-Z]{3}$/.test(normalized) ? normalized : null;
}

function normalizeDeliveryStatus(value: unknown): string | null {
  const normalized = text(value)?.toUpperCase() ?? null;
  return normalized || null;
}

function deliveryScopeForIdentity(
  identity: MetaDecisionIdentitySourceRow,
): NonNullable<MetaCanonicalDecision["deliveryScope"]> {
  const campaignStatus = normalizeDeliveryStatus(identity.campaign_status);
  const adsetStatus = normalizeDeliveryStatus(identity.adset_status);
  const adStatus = normalizeDeliveryStatus(identity.ad_status);
  const statuses = [campaignStatus, adsetStatus, adStatus];
  const knownStatuses = statuses.filter((status): status is string =>
    Boolean(status),
  );
  const allKnown = knownStatuses.length === statuses.length;
  const allActive =
    allKnown && knownStatuses.every((status) => status === "ACTIVE");
  const state = allActive ? "active" : allKnown ? "inactive" : "unknown";
  return {
    state,
    campaignStatus,
    adsetStatus,
    adStatus,
    reason:
      state === "active"
        ? "active_hierarchy"
        : state === "inactive"
          ? "hierarchy_not_active"
          : "hierarchy_status_unknown",
    provenance: provenance({
      source:
        identity.status_source === "meta_graph_ad_configs"
          ? "meta_graph_ad_configs"
          : "meta_campaign_dimensions+meta_adset_dimensions+meta_ad_dimensions",
      field: "campaign_status,adset_status,ad_status",
      recordId: identity.ad_id ?? identity.creative_id,
      asOf: identity.source_updated_at,
    }),
  };
}

function currentEffectiveAdStatus(row: MetaCurrentAdStatusSourceRow) {
  return normalizeDeliveryStatus(row.effectiveStatus);
}

export function reconcileMetaDecisionIdentityRowsWithCurrentAds(input: {
  identityRows: readonly MetaDecisionIdentitySourceRow[];
  currentAds: readonly MetaCurrentAdStatusSourceRow[];
  sourceComplete: boolean;
}): MetaDecisionIdentitySourceRow[] {
  if (!input.sourceComplete) return [...input.identityRows];
  const currentByAdId = new Map(
    input.currentAds.map((row) => [row.adId.trim(), row]),
  );

  return input.identityRows.map((identity) => {
    const adId = verifiedMetaAdId(identity.ad_id);
    const current = adId ? currentByAdId.get(adId) : null;
    if (!current) {
      return {
        ...identity,
        campaign_status: "NOT_ACTIVE",
        adset_status: "NOT_ACTIVE",
        ad_status: "NOT_ACTIVE",
        status_source: "meta_graph_ad_configs",
      };
    }
    const identityMatches =
      current.providerAccountId === identity.provider_account_id &&
      (!current.creativeId || current.creativeId === identity.creative_id);
    const effectiveStatus = identityMatches
      ? currentEffectiveAdStatus(current)
      : null;
    const status = effectiveStatus ?? "UNKNOWN";
    const sameCampaign = current.campaignId === identity.campaign_id;
    const sameAdset = current.adsetId === identity.adset_id;
    return {
      ...identity,
      ad_name: current.adName?.trim() || identity.ad_name,
      campaign_id: current.campaignId,
      campaign_name: sameCampaign ? identity.campaign_name : null,
      adset_id: current.adsetId,
      adset_name: sameAdset ? identity.adset_name : null,
      campaign_status: status,
      adset_status: status,
      ad_status: status,
      source_updated_at: current.providerUpdatedAt ?? current.fetchedAt,
      status_source: "meta_graph_ad_configs",
    };
  });
}

function reconcileNativeSnapshotRowsWithCurrentAds(input: {
  snapshotRows: readonly MetaNativeDecisionSnapshotSourceRow[];
  currentAds: readonly MetaCurrentAdStatusSourceRow[];
  sourceComplete: boolean;
}): MetaNativeDecisionSnapshotSourceRow[] {
  if (!input.sourceComplete) return [...input.snapshotRows];
  const currentByAdId = new Map(
    input.currentAds.map((row) => [row.adId.trim(), row]),
  );
  return input.snapshotRows.map((snapshot) => {
    const current = currentByAdId.get(snapshot.ad_id.trim());
    const identityMatches =
      current?.providerAccountId === snapshot.provider_account_id &&
      (!current.creativeId ||
        !snapshot.creative_id ||
        current.creativeId === snapshot.creative_id);
    const status =
      current && identityMatches
        ? (currentEffectiveAdStatus(current) ?? "UNKNOWN")
        : current
          ? "UNKNOWN"
          : "NOT_ACTIVE";
    return {
      ...snapshot,
      ad_name: current?.adName?.trim() || snapshot.ad_name,
      campaign_id: current?.campaignId ?? snapshot.campaign_id,
      adset_id: current?.adsetId ?? snapshot.adset_id,
      campaign_status: status,
      adset_status: status,
      ad_status: status,
      source_updated_at:
        current?.providerUpdatedAt ??
        current?.fetchedAt ??
        snapshot.source_updated_at,
    };
  });
}

function isUndefinedRelationError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; message?: unknown };
  return (
    candidate.code === "42P01" ||
    (typeof candidate.message === "string" &&
      candidate.message.includes(
        'relation "meta_entity_state_history" does not exist',
      ))
  );
}

function countReasons(
  codes: readonly string[],
): MetaDecisionSuppressionReason[] {
  const counts = new Map<string, number>();
  for (const code of codes) counts.set(code, (counts.get(code) ?? 0) + 1);
  return [...counts.entries()]
    .map(([code, count]) => ({ code, count }))
    .sort((left, right) => left.code.localeCompare(right.code));
}

function provenance(input: {
  source: string;
  field: string;
  recordId?: string | null;
  asOf?: string | null;
  version?: string | null;
}): MetaDecisionProvenance {
  return {
    source: input.source,
    field: input.field,
    recordId: input.recordId ?? null,
    asOf: input.asOf ?? null,
    version: input.version ?? null,
  };
}

function baseCapabilities(input: {
  providerScopeAvailable: boolean;
  snapshotAvailable: boolean;
}): MetaDecisionsWorkspaceReadModel["capabilities"] {
  const available = (
    reason: string | null = null,
  ): MetaDecisionCapabilityState => ({
    status: "available",
    reason,
  });
  const unavailable = (reason: string): MetaDecisionCapabilityState => ({
    status: "unavailable",
    reason,
  });
  const proposed = (reason: string): MetaDecisionCapabilityState => ({
    status: "proposed",
    reason,
  });
  return {
    providerAccountScope: input.providerScopeAvailable
      ? available("provider_account_id_required_and_source_join_scoped")
      : unavailable("provider_account_scope_not_verified"),
    stableDecisionIdentity: input.snapshotAvailable
      ? available("deterministic_hash_of_account_scope_and_creative_identity")
      : unavailable("decision_snapshot_unavailable"),
    stableEpisodeIdentity: input.snapshotAvailable
      ? available("derived_from_contiguous_persisted_label_history")
      : unavailable("decision_snapshot_history_unavailable"),
    classificationOverlay: input.snapshotAvailable
      ? available(META_DECISIONS_CLASSIFICATION_OVERLAY_VERSION)
      : unavailable("classification_source_snapshot_unavailable"),
    riskTierProducer: proposed("risk_tier_producer_not_persisted"),
    promotionBasisProducer: proposed("promotion_basis_not_persisted"),
    responseAttribution: unavailable(
      "legacy_response_journal_not_keyed_by_decision_episode",
    ),
    providerWriteLinkage: unavailable(
      "provider_write_journal_not_keyed_by_decision_episode",
    ),
  };
}

function emptySection(input: {
  businessId: string;
  providerAccountId: string | null;
  key: MetaDecisionQueueSectionKey;
  topN: number;
}): MetaDecisionQueueSection {
  return {
    key: input.key,
    label: SECTION_LABELS[input.key],
    topN: input.topN,
    preCapCount: 0,
    selectedCount: 0,
    rankablePreCapCount: 0,
    unrankablePreCapCount: 0,
    items: [],
    exposureDigest: {
      basis: "pre_cap",
      byCurrency: [],
      unavailableCount: 0,
      crossCurrencyTotal: null,
    },
    suppressionReceipt: {
      receiptId: stableId("mdsr", [
        input.businessId,
        input.providerAccountId,
        input.key,
        "empty",
      ]),
      selectionVersion: META_DECISIONS_SECTION_SELECTION_VERSION,
      topN: input.topN,
      preCapCount: 0,
      selectedCount: 0,
      suppressedCount: 0,
      reasons: [],
    },
  };
}

export function buildUnavailableMetaDecisionsWorkspaceReadModel(input: {
  businessId: string;
  providerAccountId: string | null;
  code: MetaDecisionsReadModelUnavailableCode;
  message: string;
  generatedAt?: string;
  sectionLimit?: number;
  adCandidateLimit?: number;
}): MetaDecisionsWorkspaceReadModel {
  const topN = Math.max(
    1,
    Math.min(input.sectionLimit ?? META_DECISIONS_WORKSPACE_SECTION_LIMIT, 20),
  );
  const sections = Object.fromEntries(
    META_DECISION_QUEUE_SECTION_KEYS.map((key) => [
      key,
      emptySection({
        businessId: input.businessId,
        providerAccountId: input.providerAccountId,
        key,
        topN,
      }),
    ]),
  ) as Record<MetaDecisionQueueSectionKey, MetaDecisionQueueSection>;
  const adCandidateLimit = Math.max(
    1,
    Math.min(
      input.adCandidateLimit ?? META_DECISIONS_AD_CANDIDATE_LIMIT,
      META_DECISIONS_AD_CANDIDATE_MAX_LIMIT,
    ),
  );
  return {
    contractVersion: META_DECISIONS_WORKSPACE_CONTRACT_VERSION,
    status: "unavailable",
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    scope: {
      businessId: input.businessId,
      providerAccountId: input.providerAccountId,
      decisionMode: "current",
      metricsRangeAffectsDecisionSnapshot: false,
    },
    unavailable: { code: input.code, message: input.message },
    source: {
      status: "unavailable",
      authority: "unavailable",
      table: "engine_v3_decision_snapshots_daily",
      snapshotAsOf: null,
      computedAt: null,
      engineVersion: null,
      fallbackReason: null,
      generation: null,
    },
    queue: {
      deduplicationGrain: "creative",
      sourcePreCapCount: 0,
      queuedPreCapCount: 0,
      sections,
      adCandidates: {
        selectionVersion: META_DECISIONS_AD_CANDIDATE_SELECTION_VERSION,
        limit: adCandidateLimit,
        preCapCount: 0,
        eligiblePreCapCount: 0,
        selectedCount: 0,
        stateCounts: {
          act: { preCapCount: 0, selectedCount: 0 },
          blocked: { preCapCount: 0, selectedCount: 0 },
          monitor: { preCapCount: 0, selectedCount: 0 },
        },
        omittedAmbiguousIdentity: 0,
        omittedWithoutVerifiedAdId: 0,
        omittedNotApplicable: 0,
        items: [],
      },
      inactiveAssets: {
        preCapCount: 0,
        inactiveCount: 0,
        unknownCount: 0,
        items: [],
      },
      omittedFromQueue: { count: 0, reasons: [] },
    },
    capabilities: baseCapabilities({
      providerScopeAvailable: false,
      snapshotAvailable: false,
    }),
  };
}

function parseBadges(value: unknown): {
  badges: DecisionBadge[];
  codes: string[];
} {
  if (!Array.isArray(value)) return { badges: [], codes: [] };
  const badges: DecisionBadge[] = [];
  const codes: string[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const code = text((entry as { type?: unknown }).type);
    if (!code) continue;
    codes.push(code);
    if (!Object.prototype.hasOwnProperty.call(DECISION_BADGE_DISPLAY, code))
      continue;
    const badgeType = code as DecisionBadge["type"];
    const display = DECISION_BADGE_DISPLAY[badgeType];
    badges.push({
      type: badgeType,
      label: text((entry as { label?: unknown }).label) ?? display.label,
      severity:
        (entry as { severity?: unknown }).severity === "warning"
          ? "warning"
          : display.severity,
    });
  }
  return { badges, codes: [...new Set(codes)].sort() };
}

function campaignRole(input: {
  identity: MetaDecisionIdentitySourceRow;
  context: MetaDecisionCampaignContextSourceRow | null;
}): MetaDecisionLifecycleRoleOverlay {
  const { context } = input;
  const contextKind = context?.kind ?? null;
  const confidence = context?.confidenceClass ?? "unknown";
  // The canonical validator is called EXACTLY once per row. Calling it twice —
  // once here and once inside the shared helper — silently changed behaviour
  // for any caller that stubs it per-call.
  const resolverVersionValidated = isCampaignContextResolverAuthorityValidated(
    context?.resolverVersion,
  );
  const resolverAuthorityValidated =
    context?.source === "system_inferred" && resolverVersionValidated;
  /**
   * D081 C2 — the account-scoped point-in-time authority is computed by the
   * shared helper, not by a second copy of the rule here. The two must agree:
   * a divergence would mean this surface and the audit were enforcing
   * different things, so the disagreement is asserted rather than tolerated.
   */
  const scopedAuthority = evaluateAccountScopedRoleAuthority({
    kind: contextKind,
    source: context?.source ?? null,
    confidenceClass: context?.confidenceClass ?? null,
    resolverVersion: context?.resolverVersion ?? null,
    // The single call above is reused; the helper never calls out again.
    isResolverVersionValidated: () => resolverVersionValidated,
  });
  const trustedForAction = scopedAuthority.satisfiesRoleAuthority;
  let blockerCode: string | null = null;
  if (context?.confidenceClass === "conflict")
    blockerCode = "campaign_context_conflict";
  else if (
    contextKind &&
    context?.confidenceClass === "high" &&
    !resolverAuthorityValidated
  )
    blockerCode = "campaign_context_resolver_unvalidated";
  else if (contextKind && !trustedForAction)
    blockerCode = "campaign_context_low_confidence";
  else if (!contextKind) blockerCode = "campaign_context_unresolved";
  return {
    value: contextKind ?? "role_unresolved",
    confidence,
    trustedForAction,
    blockerCode,
    provenance: provenance({
      source:
        context?.source === "system_inferred"
          ? "engine_v3_campaign_context_daily"
          : "meta_decisions_classification_overlay",
      field: "inferred_kind",
      recordId: input.identity.campaign_id,
      asOf: context?.sourceUpdatedAt ?? null,
      version: context?.resolverVersion ?? null,
    }),
  };
}

function assessmentFor(input: {
  snapshot: MetaDecisionSnapshotSourceRow;
  classification: MetaCreativeAssessmentPresentation;
}): MetaDecisionAssessmentOverlay {
  return {
    value: input.classification.value,
    blockerCode: input.classification.blockerCode,
    provenance: provenance({
      source: "engine_v3_decision_snapshots_daily",
      field: "label,badges",
      recordId: input.snapshot.snapshot_id,
      asOf: input.snapshot.as_of_date,
      version: META_DECISIONS_CLASSIFICATION_OVERLAY_VERSION,
    }),
  };
}

function blockerCategory(code: string): MetaDecisionBlocker["category"] {
  if (code.includes("policy")) return "policy";
  if (code.includes("delivery")) return "delivery";
  if (code.includes("campaign")) return "campaign_context";
  if (code.includes("risk")) return "risk";
  if (code.includes("assessment") || code.includes("fatigue"))
    return "assessment";
  return "data";
}

function blockerLabel(code: string) {
  return (
    BLOCKER_LABELS[code] ??
    code
      .split("_")
      .filter(Boolean)
      .map((part, index) =>
        index === 0 ? `${part.charAt(0).toUpperCase()}${part.slice(1)}` : part,
      )
      .join(" ")
  );
}

/**
 * The one risk-tier envelope, written once and read everywhere it is stated.
 *
 * The advisory below and `MetaCanonicalDecision.riskTierProvenance` are the
 * same claim in two places; sharing the constant is what stops them drifting
 * into a producer that contradicts its own explanation.
 */
const RISK_TIER_PROVENANCE = {
  status: "proposed",
  reason: "risk_tier_producer_not_persisted",
} as const;

/**
 * Statements about THIS pipeline. They inform; they never gate.
 *
 * `risk_tier_unclassified` used to be appended to every canonical decision's
 * blocker list unconditionally — there was no `if`. `buildBlockers` is the only
 * producer of `classification.blockers`, and both of its call sites run through
 * `buildCanonicalDecision`, so EVERY decision this server could produce carried
 * at least one blocker. Every guard written as `blockers.length > 0` therefore
 * refused every real ad: the exact-Ad pause control could not be offered on any
 * account, and its unit test passed only because it hand-built `blockers: []`,
 * a state no producer could reach.
 *
 * It is advisory because the envelope beside it already says the risk-tier
 * PRODUCER does not exist: `riskTierProvenance.status === "proposed"` with
 * reason `risk_tier_producer_not_persisted`. A producer this pipeline has not
 * built yet is a gap in the pipeline, not a finding about the ad, so it states
 * itself — with the reason attached — and stops there.
 *
 * It is served in `classification.advisories` rather than kept in `blockers`
 * with a flag because a code inside a field named "blockers" re-acquires its
 * veto the moment anyone writes the next `blockers.length > 0` guard.
 */
function buildAdvisories(input: {
  snapshot: MetaDecisionSnapshotSourceRow;
}): MetaDecisionAdvisory[] {
  const code = "risk_tier_unclassified";
  return [
    {
      code,
      label: blockerLabel(code),
      category: blockerCategory(code),
      reason: RISK_TIER_PROVENANCE.reason,
      provenance: provenance({
        source: META_DECISIONS_CLASSIFICATION_OVERLAY_VERSION,
        field: "riskTier,riskTierProvenance.reason",
        recordId: input.snapshot.snapshot_id,
        asOf: input.snapshot.as_of_date,
        version: META_DECISIONS_CLASSIFICATION_OVERLAY_VERSION,
      }),
    },
  ];
}

function buildBlockers(input: {
  bridgeCodes: readonly string[];
  role: MetaDecisionLifecycleRoleOverlay;
  assessment: MetaDecisionAssessmentOverlay;
  snapshot: MetaDecisionSnapshotSourceRow;
}): MetaDecisionBlocker[] {
  const entries: Array<{ code: string; source: string; field: string }> =
    input.bridgeCodes.map((code) => ({
      code,
      source: CREATIVE_DECISION_CENTER_V3_BRIDGE_VERSION,
      field: "engine.blockerReasons",
    }));
  if (input.role.blockerCode) {
    entries.push({
      code: input.role.blockerCode,
      source: input.role.provenance.source,
      field: input.role.provenance.field,
    });
  }
  if (input.assessment.blockerCode) {
    entries.push({
      code: input.assessment.blockerCode,
      source: META_DECISIONS_CLASSIFICATION_OVERLAY_VERSION,
      field: "assessment",
    });
  }
  const authorityBlocker = persistedAuthorityBlocker(
    input.snapshot.authority_blocker,
  );
  if (authorityBlocker) {
    entries.push({
      code: authorityBlocker,
      source: "engine_v3_decision_snapshots_daily",
      field: "authority_blocker",
    });
  }
  const unique = new Map(entries.map((entry) => [entry.code, entry]));
  return [...unique.values()]
    .sort((left, right) => left.code.localeCompare(right.code))
    .map((entry) => ({
      code: entry.code,
      label: blockerLabel(entry.code),
      category: blockerCategory(entry.code),
      provenance: provenance({
        source: entry.source,
        field: entry.field,
        recordId: input.snapshot.snapshot_id,
        asOf: input.snapshot.as_of_date,
        version: META_DECISIONS_CLASSIFICATION_OVERLAY_VERSION,
      }),
    }));
}

function mediaEnvelope(identity: MetaDecisionIdentitySourceRow) {
  const sourceAvailable = identity.media_source_present === true;
  const mediaAvailable = sourceAvailable && identity.media_available === true;
  const thumbnailUrl = text(identity.thumbnail_url);
  return {
    state: sourceAvailable
      ? mediaAvailable
        ? "available"
        : "missing"
      : "unavailable",
    missingMedia: sourceAvailable ? !mediaAvailable : null,
    thumbnail: {
      state: thumbnailUrl
        ? "available"
        : sourceAvailable
          ? "missing"
          : "unavailable",
      url: thumbnailUrl,
    },
    provenance: provenance({
      source: identity.media_source ?? "meta_creative_identity_sources",
      field: "thumbnail_url,media_available",
      recordId: identity.creative_id,
      asOf: identity.source_updated_at,
    }),
  } as MetaCanonicalDecision["media"];
}

function exposureFor(input: {
  snapshot: MetaDecisionSnapshotSourceRow;
  identity: MetaDecisionIdentitySourceRow;
}): {
  exposure: MetaDecisionExposure | null;
  reason: MetaCanonicalDecision["exposureUnavailableReason"];
} {
  const amount = finiteNumber(input.snapshot.spend);
  if (amount === null || amount < 0) {
    return { exposure: null, reason: "spend_unavailable" };
  }
  const currency = normalizeCurrency(input.identity.currency);
  if (!currency) return { exposure: null, reason: "currency_unavailable" };
  return {
    exposure: {
      kind: "exposure_proxy",
      amount,
      currency,
      attribution: "meta_attributed",
      grain: "creative",
      provenance: provenance({
        source: "engine_v3_decision_snapshots_daily+meta_creative_daily",
        field: "spend,account_currency",
        recordId: input.snapshot.snapshot_id,
        asOf: input.snapshot.as_of_date,
        version: input.snapshot.engine_version,
      }),
    },
    reason: null,
  };
}

function historyFor(input: {
  snapshot: MetaDecisionSnapshotSourceRow;
  events: readonly MetaDecisionEventSourceRow[];
  outcomes: readonly MetaDecisionOutcomeSourceRow[];
  eventSourceAvailable: boolean;
  outcomeSourceAvailable: boolean;
}): MetaDecisionHistoryEnvelope {
  const events = [...input.events]
    .sort(
      (left, right) =>
        right.event_date.localeCompare(left.event_date) ||
        right.id.localeCompare(left.id),
    )
    .slice(0, META_DECISION_HISTORY_EVENT_LIMIT)
    .map((event) => ({
      id: event.id,
      eventType: event.event_type,
      eventDate: event.event_date,
      previousLabel: event.previous_label,
      currentLabel: event.current_label,
      operatorActionType: event.operator_action_type,
      notes: event.notes,
      actor: null,
      actorAttributionStatus: "unavailable" as const,
    }));
  const outcomes = input.outcomes.flatMap((outcome) => {
    const windowDays = finiteNumber(outcome.outcome_window_days);
    if (windowDays !== 3 && windowDays !== 7 && windowDays !== 14) return [];
    return [
      {
        id: outcome.id,
        outcomeWindowDays: windowDays as 3 | 7 | 14,
        evaluationDate: outcome.evaluation_date,
        realizedOutcome: outcome.realized_outcome,
        severity: outcome.severity,
        classifierVersion: outcome.classifier_version,
      },
    ];
  });
  return {
    events: {
      status: input.eventSourceAvailable ? "available" : "unavailable",
      reason: input.eventSourceAvailable
        ? null
        : "decision_event_journal_unavailable",
      preCapCount:
        input.events.length > 0
          ? nonNegativeInteger(input.events[0]?.pre_cap_count)
          : 0,
      items: events,
    },
    outcomes: {
      status: outcomes.length > 0 ? "available" : "unavailable",
      reason:
        outcomes.length > 0
          ? null
          : input.outcomeSourceAvailable
            ? "outcome_window_not_mature_or_not_accrued"
            : "decision_outcome_journal_unavailable",
      items: outcomes,
    },
    responses: {
      status: "unavailable",
      reason: "legacy_response_journal_not_keyed_by_decision_episode",
    },
    providerWrites: {
      status: "unavailable",
      reason: "provider_write_journal_not_keyed_by_decision_episode",
    },
  };
}

function toDecisionOutput(input: {
  snapshot: MetaDecisionSnapshotSourceRow;
  identity: MetaDecisionIdentitySourceRow;
  role: MetaDecisionLifecycleRoleOverlay;
  badges: DecisionBadge[];
}): DecisionOutput | null {
  if (!DECISION_LABELS.has(input.snapshot.label as DecisionLabel)) return null;
  if (!TRUTH_SOURCES.has(input.snapshot.truth_source as TruthSource))
    return null;
  const confidence = finiteNumber(input.snapshot.confidence);
  if (confidence === null) return null;
  const persistedPreAuthorityLabel = persistedDecisionLabel(
    input.snapshot.pre_authority_label,
  );
  const trustedKind =
    input.role.trustedForAction &&
    input.role.value !== "label_needed" &&
    input.role.value !== "role_unresolved"
      ? input.role.value
      : null;
  return {
    creativeId: input.snapshot.creative_id,
    creativeName: input.identity.creative_name,
    label: input.snapshot.label as DecisionLabel,
    reason: input.snapshot.reason,
    confidence,
    truthSource: input.snapshot.truth_source as TruthSource,
    effectiveTargetRoas:
      finiteNumber(input.snapshot.effective_target_roas) ?? Number.NaN,
    ratioToTarget: finiteNumber(input.snapshot.ratio_to_target),
    badges: input.badges,
    metrics: {
      spend: finiteNumber(input.snapshot.spend) ?? Number.NaN,
      purchases: finiteNumber(input.snapshot.purchases) ?? Number.NaN,
      roas: finiteNumber(input.snapshot.roas),
      recent7dRoas: finiteNumber(input.snapshot.recent7d_roas),
    },
    campaignRoleStatus: input.identity.campaign_id
      ? trustedKind
        ? "resolved"
        : "unresolved"
      : "no_campaign",
    campaignKind: trustedKind,
    // The adapter does not consume authority provenance. Historical rows still
    // need an adapter-compatible DecisionOutput, while the canonical contract
    // below preserves their persisted null as unavailable rather than inferring
    // provenance from reason, badges, or the published label.
    preAuthorityLabel:
      persistedPreAuthorityLabel ?? (input.snapshot.label as DecisionLabel),
    authorityBlocker: persistedAuthorityBlocker(
      input.snapshot.authority_blocker,
    ),
    labelTransform:
      input.snapshot.label_transform === "test_cohort_refresh_to_cut"
        ? "test_cohort_refresh_to_cut"
        : null,
    blockedActionType:
      input.snapshot.blocked_action_type === "scale" ||
      input.snapshot.blocked_action_type === "cut" ||
      input.snapshot.blocked_action_type === "refresh"
        ? input.snapshot.blocked_action_type
        : input.snapshot.engine_version !== NATIVE_AD_ENGINE_VERSION &&
            input.badges.some((badge) => badge.type === "stop_loss_review")
          ? "cut"
          : null,
    engineVersion: input.snapshot.engine_version,
    generatedAt: input.snapshot.computed_at,
  };
}

function buildCanonicalDecision(input: {
  businessId: string;
  providerAccountId: string;
  authorityMode: "legacy_review_only" | "native_exact";
  snapshot: MetaDecisionSnapshotSourceRow;
  identity: MetaDecisionIdentitySourceRow;
  campaignContext: MetaDecisionCampaignContextSourceRow | null;
  eventRows: readonly MetaDecisionEventSourceRow[];
  outcomeRows: readonly MetaDecisionOutcomeSourceRow[];
  eventSourceAvailable: boolean;
  outcomeSourceAvailable: boolean;
}): { decision: MetaCanonicalDecision | null; omissionReason: string | null } {
  const parsedBadges = parseBadges(input.snapshot.badges);
  const role = campaignRole({
    identity: input.identity,
    context: input.campaignContext,
  });
  const decisionOutput = toDecisionOutput({
    snapshot: input.snapshot,
    identity: input.identity,
    role,
    badges: parsedBadges.badges,
  });
  if (!decisionOutput) {
    return { decision: null, omissionReason: "snapshot_contract_invalid" };
  }
  const presentation = projectCanonicalMetaDecisionPresentation({
    decision: decisionOutput,
    context: {
      creativeId: input.snapshot.creative_id,
      identityGrain: "creative",
      familyId: null,
      campaignKind: decisionOutput.campaignKind ?? null,
    },
    lifecycleRole: role.value,
    // Only real gates go into the evidence set the semantics projector reads.
    // `risk_tier_unclassified` was injected here too; it is inert in
    // `projectMetaDecisionSemantics` (no branch tests it, and it is not in
    // FRESHNESS_AUTHORITY_BLOCKERS), so removing it changes no decisionState
    // and no resolution — pinned by decisions-workspace-read-model.test.ts,
    // "demoting the risk-tier advisory changes no lane and no classification".
    blockerCodes: role.blockerCode ? [role.blockerCode] : [],
    reviewOnly: true,
  });
  if (presentation.kind === "omitted") {
    return {
      decision: null,
      omissionReason: presentation.bridge.omitReason,
    };
  }
  const bridged = presentation.bridge;
  const adapted = presentation.adapterRow;
  // This read model is creative-grain only. Campaign/ad-set money moves and
  // account integrity events are composed by their own server producers; a
  // creative label never crosses into those grains merely because its action
  // vocabulary contains scale/cut/diagnose.
  const queueSection: MetaDecisionQueueSectionKey = "creative_rotation";
  const heldAction = presentation.heldAction;
  const assessment = assessmentFor({
    snapshot: input.snapshot,
    classification: presentation.assessment,
  });
  const blockers = buildBlockers({
    bridgeCodes: bridged.engine.blockerReasons,
    role,
    assessment,
    snapshot: input.snapshot,
  });
  const advisories = buildAdvisories({ snapshot: input.snapshot });
  const semantics = {
    ...presentation.semantics,
    // A legacy creative verdict remains useful review evidence, but this
    // source is explicitly not action authority. Preserve the buyer verdict
    // while preventing an act-state classification from contradicting the
    // legacy_review_only sourceAuthority envelope below.
    decisionState:
      input.authorityMode === "legacy_review_only" &&
      presentation.semantics.decisionState === "act"
        ? ("monitor" as const)
        : presentation.semantics.decisionState,
  };
  const exposure = exposureFor({
    snapshot: input.snapshot,
    identity: input.identity,
  });
  const decisionId = stableId("mdd", [
    input.businessId,
    input.providerAccountId,
    "creative",
    input.snapshot.creative_id,
    input.snapshot.scope_type,
    input.snapshot.scope_id,
  ]);
  const episodeStartedAt =
    input.snapshot.episode_started_at || input.snapshot.as_of_date;
  const episodeId = stableId("mde", [
    decisionId,
    input.snapshot.label,
    episodeStartedAt,
  ]);
  const sourceProvenance = provenance({
    source: "engine_v3_decision_snapshots_daily",
    field:
      "label,pre_authority_label,authority_blocker,raw_label,confidence,reason,badges",
    recordId: input.snapshot.snapshot_id,
    asOf: input.snapshot.as_of_date,
    version: input.snapshot.engine_version,
  });
  const verifiedAdId = verifiedMetaAdId(input.identity.ad_id);
  const candidateAdCount = nonNegativeInteger(
    input.identity.candidate_ad_count,
  );
  return {
    omissionReason: null,
    decision: {
      decisionId,
      episodeId,
      episodeStartedAt,
      providerAccountId: input.providerAccountId,
      identityGrain: "creative",
      sourceSnapshotId: input.snapshot.snapshot_id,
      sourceAuthority: {
        status: "legacy_review_only",
        actionEligible: false,
        reviewOnlyReason: "legacy_creative_grain_is_not_ad_action_authority",
        snapshotId: input.snapshot.snapshot_id,
        evaluationId: null,
        inputHash: null,
        decisionHash: null,
        providerAccountRefId: null,
        engineVersion: input.snapshot.engine_version,
        realAdId: candidateAdCount === 1 ? verifiedAdId : null,
        authorizedAction: null,
        jobRunId: null,
      },
      sourceDecision: {
        label: input.snapshot.label,
        preAuthorityLabel: persistedDecisionLabel(
          input.snapshot.pre_authority_label,
        ),
        authorityBlocker: persistedAuthorityBlocker(
          input.snapshot.authority_blocker,
        ),
        rawLabel: input.snapshot.raw_label,
        reason: input.snapshot.reason,
        confidence: finiteNumber(input.snapshot.confidence) ?? 0,
        confidenceBand: adapted.confidenceBand,
        truthSource: input.snapshot.truth_source,
        engineVersion: input.snapshot.engine_version,
        snapshotAsOf: input.snapshot.as_of_date,
        computedAt: input.snapshot.computed_at,
        badges: parsedBadges.codes,
        provenance: sourceProvenance,
      },
      parentChain: {
        account: { id: input.providerAccountId, name: null },
        campaign: input.identity.campaign_id
          ? {
              id: input.identity.campaign_id,
              name: input.identity.campaign_name,
            }
          : null,
        adset: input.identity.adset_id
          ? { id: input.identity.adset_id, name: input.identity.adset_name }
          : null,
        ad:
          candidateAdCount === 1 && verifiedAdId
            ? { id: verifiedAdId, name: input.identity.ad_name }
            : null,
        creative: {
          id: input.snapshot.creative_id,
          name: input.identity.creative_name,
        },
        provenance: provenance({
          source: "meta_creative_dimensions+meta_ad_dimensions",
          field:
            "provider_account_id,campaign_id,adset_id,verified_ad_id,creative_id",
          recordId: input.snapshot.creative_id,
          asOf: input.identity.source_updated_at,
        }),
      },
      identityResolution: {
        basis:
          candidateAdCount === 1 && verifiedAdId
            ? "single_ad_creative_equivalent"
            : candidateAdCount > 1
              ? "creative_ambiguous"
              : "unresolved",
        candidateAdCount,
        metricsEquivalent: candidateAdCount === 1 && Boolean(verifiedAdId),
        // Identity-only capability: this says one provider Ad can be named.
        // Provider execution still requires sourceAuthority.actionEligible,
        // which is always false for this legacy creative builder.
        adActionEligible: candidateAdCount === 1 && Boolean(verifiedAdId),
      },
      media: mediaEnvelope(input.identity),
      deliveryScope: deliveryScopeForIdentity(input.identity),
      classification: {
        overlayVersion: META_DECISIONS_CLASSIFICATION_OVERLAY_VERSION,
        queueSection,
        lifecycleRole: role,
        assessment,
        decisionState: semantics.decisionState,
        heldAction,
        legacyBuyerAction: semantics.legacyBuyerAction,
        buyerAction: semantics.buyerAction,
        buyerLabel: presentation.buyerLabel,
        executionAction: presentation.executionAction,
        resolution: semantics.resolution,
        blockers,
        advisories,
        provenance: provenance({
          source: `${CREATIVE_DECISION_CENTER_V3_BRIDGE_VERSION}+${CREATIVE_DECISION_CENTER_ADAPTER_VERSION}`,
          field: "buyerAction,executionAction,queueSection",
          recordId: input.snapshot.snapshot_id,
          asOf: input.snapshot.as_of_date,
          version: META_DECISIONS_CLASSIFICATION_OVERLAY_VERSION,
        }),
      },
      riskTier: null,
      confirmationCeremony: "highest",
      riskTierProvenance: RISK_TIER_PROVENANCE,
      promotionBasis: {
        status: "proposed",
        value: null,
        reason: "promotion_basis_not_persisted",
      },
      metrics: {
        spend: finiteNumber(input.snapshot.spend),
        purchases: finiteNumber(input.snapshot.purchases),
        roas: finiteNumber(input.snapshot.roas),
        recent7dRoas: finiteNumber(input.snapshot.recent7d_roas),
        ctr: finiteNumber(input.snapshot.ctr_28d),
        frequency: finiteNumber(input.snapshot.frequency_28d),
        effectiveTargetRoas: finiteNumber(input.snapshot.effective_target_roas),
        ratioToTarget: finiteNumber(input.snapshot.ratio_to_target),
        currency: normalizeCurrency(input.identity.currency),
        attribution: "meta_attributed",
        provenance: provenance({
          source: "engine_v3_decision_snapshots_daily+meta_creative_daily",
          field:
            "spend,purchases,roas,recent7d_roas,ctr_28d,frequency_28d,effective_target_roas,ratio_to_target,account_currency",
          recordId: input.snapshot.snapshot_id,
          asOf: input.snapshot.as_of_date,
          version: input.snapshot.engine_version,
        }),
      },
      creativeFormat: nonEmptyString(input.snapshot.creative_format),
      fatigueStatus: nonEmptyString(input.snapshot.fatigue_status),
      exposure: exposure.exposure,
      exposureUnavailableReason: exposure.reason,
      history: historyFor({
        snapshot: input.snapshot,
        events: input.eventRows,
        outcomes: input.outcomeRows,
        eventSourceAvailable: input.eventSourceAvailable,
        outcomeSourceAvailable: input.outcomeSourceAvailable,
      }),
    },
  };
}

function compareDecisions(
  left: MetaCanonicalDecision,
  right: MetaCanonicalDecision,
) {
  return (
    right.sourceDecision.confidence - left.sourceDecision.confidence ||
    (right.exposure?.amount ?? -1) - (left.exposure?.amount ?? -1) ||
    left.decisionId.localeCompare(right.decisionId)
  );
}

const AD_CANDIDATE_STATE_WEIGHT = {
  act: 3,
  blocked: 2,
  monitor: 1,
} as const;

const AD_CANDIDATE_ACTION_WEIGHT: Record<MetaDecisionBuyerAction, number> = {
  fix_policy: 9,
  fix_delivery: 8,
  cut: 7,
  diagnose_data: 6,
  refresh: 5,
  scale: 4,
  test_more: 3,
  protect: 2,
  watch_launch: 1,
};

type SelectableAdState = keyof typeof AD_CANDIDATE_STATE_WEIGHT;

function compareAdCandidates(
  left: MetaCanonicalDecision,
  right: MetaCanonicalDecision,
) {
  const leftState = left.classification.decisionState as SelectableAdState;
  const rightState = right.classification.decisionState as SelectableAdState;
  return (
    AD_CANDIDATE_STATE_WEIGHT[rightState] -
      AD_CANDIDATE_STATE_WEIGHT[leftState] ||
    AD_CANDIDATE_ACTION_WEIGHT[right.classification.legacyBuyerAction] -
      AD_CANDIDATE_ACTION_WEIGHT[left.classification.legacyBuyerAction] ||
    compareDecisions(left, right)
  );
}

/*
 * The public read-model envelope intentionally serializes only the selected
 * candidates. OS composition happens before serialization, though, and needs
 * to distinguish a genuinely pending ACTIVE Ad from an exact candidate that
 * was merely omitted by the response cap. Keep that full identity universe as
 * process-local metadata so the wire contract stays unchanged.
 */
const META_DECISION_CANONICAL_AD_UNIVERSE = Symbol.for(
  "adsecute.meta.decisions.canonical-ad-universe",
);

function attachCanonicalAdUniverse(
  readModel: MetaDecisionsWorkspaceReadModel,
  adIds: ReadonlySet<string>,
) {
  Object.defineProperty(readModel, META_DECISION_CANONICAL_AD_UNIVERSE, {
    value: adIds,
    enumerable: false,
    configurable: false,
    writable: false,
  });
}

function selectAdCandidates(items: MetaCanonicalDecision[], limit: number) {
  const states: SelectableAdState[] = ["act", "blocked", "monitor"];
  const buckets = Object.fromEntries(
    states.map((state) => [
      state,
      items
        .filter((item) => item.classification.decisionState === state)
        .sort(compareAdCandidates),
    ]),
  ) as Record<SelectableAdState, MetaCanonicalDecision[]>;
  const nonEmptyStates = states.filter((state) => buckets[state].length > 0);
  const reserve =
    nonEmptyStates.length === 0
      ? 0
      : Math.min(
          META_DECISIONS_AD_CANDIDATE_LANE_RESERVE,
          Math.floor(limit / nonEmptyStates.length),
        );
  const selected = nonEmptyStates.flatMap((state) =>
    buckets[state].slice(0, reserve),
  );
  const selectedIds = new Set(selected.map((item) => item.decisionId));
  selected.push(
    ...items
      .filter((item) => !selectedIds.has(item.decisionId))
      .sort(compareAdCandidates)
      .slice(0, Math.max(0, limit - selected.length)),
  );
  /*
   * The lane reserves are the beginning of the canonical ordering, not a
   * temporary set that may be re-sorted away.
   *
   * Re-sorting the completed selection made the 60-row response unstable when
   * the same request expanded to 120. With 100 Act, 20 Blocked and 20 Monitor
   * rows, the 60-row result reserved ten rows for each lane and then filled
   * with Act. The 120-row result admitted more Act rows and a final global sort
   * moved those new rows ahead of the previously served Blocked/Monitor rows,
   * so its first 60 no longer matched the original response.
   *
   * Keeping the fixed reserve chunks first and appending the globally ranked
   * remainder gives one deterministic sequence. Increasing the limit exposes
   * a longer prefix of that sequence; it cannot rewrite an already served
   * prefix, and every non-empty lane remains represented.
   */
  return {
    selected,
    stateCounts: Object.fromEntries(
      states.map((state) => [
        state,
        {
          preCapCount: buckets[state].length,
          selectedCount: selected.filter(
            (item) => item.classification.decisionState === state,
          ).length,
        },
      ]),
    ) as Record<
      SelectableAdState,
      { preCapCount: number; selectedCount: number }
    >,
  };
}

function selectSectionItems(items: MetaCanonicalDecision[], topN: number) {
  const rankable = items
    .filter((item) => item.exposure !== null)
    .sort(compareDecisions);
  const unrankable = items
    .filter((item) => item.exposure === null)
    .sort(compareDecisions);
  if (rankable.length === 0)
    return { selected: unrankable.slice(0, topN), rankable, unrankable };
  if (unrankable.length === 0)
    return { selected: rankable.slice(0, topN), rankable, unrankable };
  if (topN === 1)
    return { selected: rankable.slice(0, 1), rankable, unrankable };

  const selectedRankable = rankable.slice(0, topN - 1);
  const selectedUnrankable = unrankable.slice(0, 1);
  let selected = [...selectedRankable, ...selectedUnrankable];
  if (selected.length < topN) {
    const selectedIds = new Set(selected.map((item) => item.decisionId));
    selected = [
      ...selected,
      ...[...rankable, ...unrankable]
        .filter((item) => !selectedIds.has(item.decisionId))
        .slice(0, topN - selected.length),
    ];
  }
  return { selected, rankable, unrankable };
}

function exposureDigest(items: readonly MetaCanonicalDecision[]) {
  const totals = new Map<string, { amount: number; decisionCount: number }>();
  let unavailableCount = 0;
  for (const item of items) {
    if (!item.exposure) {
      unavailableCount += 1;
      continue;
    }
    const current = totals.get(item.exposure.currency) ?? {
      amount: 0,
      decisionCount: 0,
    };
    current.amount += item.exposure.amount;
    current.decisionCount += 1;
    totals.set(item.exposure.currency, current);
  }
  return {
    basis: "pre_cap" as const,
    byCurrency: [...totals.entries()]
      .map(([currency, total]) => ({ currency, ...total }))
      .sort((left, right) => left.currency.localeCompare(right.currency)),
    unavailableCount,
    crossCurrencyTotal: null,
  };
}

function buildSection(input: {
  businessId: string;
  providerAccountId: string;
  snapshotAsOf: string;
  key: MetaDecisionQueueSectionKey;
  items: MetaCanonicalDecision[];
  topN: number;
}): MetaDecisionQueueSection {
  const selection = selectSectionItems(input.items, input.topN);
  const selectedRankableCount = selection.selected.filter(
    (item) => item.exposure,
  ).length;
  const selectedUnrankableCount =
    selection.selected.length - selectedRankableCount;
  const reasons: MetaDecisionSuppressionReason[] = [];
  const suppressedRankable = selection.rankable.length - selectedRankableCount;
  const suppressedUnrankable =
    selection.unrankable.length - selectedUnrankableCount;
  if (suppressedRankable > 0)
    reasons.push({ code: "section_top_n_ranked", count: suppressedRankable });
  if (suppressedUnrankable > 0)
    reasons.push({
      code: "section_top_n_unrankable",
      count: suppressedUnrankable,
    });
  return {
    key: input.key,
    label: SECTION_LABELS[input.key],
    topN: input.topN,
    preCapCount: input.items.length,
    selectedCount: selection.selected.length,
    rankablePreCapCount: selection.rankable.length,
    unrankablePreCapCount: selection.unrankable.length,
    items: selection.selected,
    exposureDigest: exposureDigest(input.items),
    suppressionReceipt: {
      receiptId: stableId("mdsr", [
        input.businessId,
        input.providerAccountId,
        input.snapshotAsOf,
        input.key,
        input.items.length,
        META_DECISIONS_SECTION_SELECTION_VERSION,
      ]),
      selectionVersion: META_DECISIONS_SECTION_SELECTION_VERSION,
      topN: input.topN,
      preCapCount: input.items.length,
      selectedCount: selection.selected.length,
      suppressedCount: input.items.length - selection.selected.length,
      reasons,
    },
  };
}

export function buildMetaDecisionsWorkspaceReadModel(
  input: BuildMetaDecisionsWorkspaceReadModelInput,
): MetaDecisionsWorkspaceReadModel {
  if (input.snapshotRows.length === 0) {
    return buildUnavailableMetaDecisionsWorkspaceReadModel({
      businessId: input.businessId,
      providerAccountId: input.providerAccountId,
      code: "snapshot_unavailable",
      message:
        "No persisted creative decision snapshot is available for this Meta account.",
      generatedAt: input.generatedAt,
      sectionLimit: input.sectionLimit,
      adCandidateLimit: input.adCandidateLimit,
    });
  }
  const topN = Math.max(
    1,
    Math.min(input.sectionLimit ?? META_DECISIONS_WORKSPACE_SECTION_LIMIT, 20),
  );
  const adCandidateLimit = Math.max(
    1,
    Math.min(
      input.adCandidateLimit ?? META_DECISIONS_AD_CANDIDATE_LIMIT,
      META_DECISIONS_AD_CANDIDATE_MAX_LIMIT,
    ),
  );
  const identityByCreativeId = new Map(
    input.identityRows
      .filter((row) => row.provider_account_id === input.providerAccountId)
      .map((row) => [row.creative_id, row]),
  );
  const contextByCampaignId = new Map(
    (input.campaignContextRows ?? []).map((row) => [row.campaignId, row]),
  );
  const eventsByCreativeId = new Map<string, MetaDecisionEventSourceRow[]>();
  for (const row of input.eventRows ?? []) {
    const rows = eventsByCreativeId.get(row.creative_id) ?? [];
    rows.push(row);
    eventsByCreativeId.set(row.creative_id, rows);
  }
  const outcomesBySnapshotId = new Map<
    string,
    MetaDecisionOutcomeSourceRow[]
  >();
  for (const row of input.outcomeRows ?? []) {
    const rows = outcomesBySnapshotId.get(row.decision_snapshot_id) ?? [];
    rows.push(row);
    outcomesBySnapshotId.set(row.decision_snapshot_id, rows);
  }

  const sectionItems = new Map<
    MetaDecisionQueueSectionKey,
    MetaCanonicalDecision[]
  >(META_DECISION_QUEUE_SECTION_KEYS.map((key) => [key, []]));
  const omissions: string[] = [];
  const inactiveAssets: MetaCanonicalDecision[] = [];
  const seenCreativeIds = new Set<string>();
  for (const snapshot of [...input.snapshotRows].sort((left, right) =>
    right.computed_at.localeCompare(left.computed_at),
  )) {
    if (seenCreativeIds.has(snapshot.creative_id)) {
      omissions.push("duplicate_creative_snapshot");
      continue;
    }
    seenCreativeIds.add(snapshot.creative_id);
    const identity = identityByCreativeId.get(snapshot.creative_id);
    if (!identity) {
      omissions.push("provider_account_identity_unavailable");
      continue;
    }
    const result = buildCanonicalDecision({
      businessId: input.businessId,
      providerAccountId: input.providerAccountId,
      authorityMode: input.authorityMode ?? "legacy_review_only",
      snapshot,
      identity,
      campaignContext: identity.campaign_id
        ? (contextByCampaignId.get(identity.campaign_id) ?? null)
        : null,
      eventRows: eventsByCreativeId.get(snapshot.creative_id) ?? [],
      outcomeRows: outcomesBySnapshotId.get(snapshot.snapshot_id) ?? [],
      eventSourceAvailable: input.eventSourceAvailable !== false,
      outcomeSourceAvailable: input.outcomeSourceAvailable !== false,
    });
    if (!result.decision) {
      omissions.push(result.omissionReason ?? "classification_unavailable");
      continue;
    }
    if (
      input.requireActiveHierarchy !== false &&
      result.decision.deliveryScope?.state !== "active"
    ) {
      result.decision.sourceAuthority = result.decision.sourceAuthority
        ? {
            ...result.decision.sourceAuthority,
            actionEligible: false,
            reviewOnlyReason:
              result.decision.deliveryScope?.state === "inactive"
                ? "current_hierarchy_is_not_active"
                : "current_hierarchy_status_is_unknown",
            authorizedAction: null,
          }
        : result.decision.sourceAuthority;
      inactiveAssets.push(result.decision);
      continue;
    }
    sectionItems
      .get(result.decision.classification.queueSection)
      ?.push(result.decision);
  }

  const snapshotAsOf =
    input.snapshotRows
      .map((row) => row.as_of_date)
      .sort()
      .at(-1) ?? null;
  const computedAt =
    input.snapshotRows
      .map((row) => row.computed_at)
      .sort()
      .at(-1) ?? null;
  const engineVersions = [
    ...new Set(input.snapshotRows.map((row) => row.engine_version)),
  ];
  const engineVersion =
    engineVersions.length === 1 ? engineVersions[0]! : "mixed";
  const sections = Object.fromEntries(
    META_DECISION_QUEUE_SECTION_KEYS.map((key) => [
      key,
      buildSection({
        businessId: input.businessId,
        providerAccountId: input.providerAccountId,
        snapshotAsOf: snapshotAsOf ?? "unknown",
        key,
        items: sectionItems.get(key) ?? [],
        topN,
      }),
    ]),
  ) as Record<MetaDecisionQueueSectionKey, MetaDecisionQueueSection>;
  const queuedPreCapCount = META_DECISION_QUEUE_SECTION_KEYS.reduce(
    (sum, key) => sum + sections[key].preCapCount,
    0,
  );
  const canonicalDecisions = META_DECISION_QUEUE_SECTION_KEYS.flatMap(
    (key) => sectionItems.get(key) ?? [],
  );
  const identityEligibleAdCandidates = canonicalDecisions.filter(
    (decision) =>
      decision.identityResolution?.adActionEligible === true &&
      Boolean(decision.parentChain.ad?.id?.trim()),
  );
  const omittedNotApplicable = identityEligibleAdCandidates.filter(
    (decision) => decision.classification.decisionState === "not_applicable",
  ).length;
  const exactAdCandidates = identityEligibleAdCandidates.filter(
    (decision) => decision.classification.decisionState !== "not_applicable",
  );
  const omittedAmbiguousIdentity = canonicalDecisions.filter(
    (decision) => decision.identityResolution?.basis === "creative_ambiguous",
  ).length;
  const omittedWithoutVerifiedAdId = Math.max(
    0,
    canonicalDecisions.length -
      identityEligibleAdCandidates.length -
      omittedAmbiguousIdentity,
  );
  const adCandidateSelection = selectAdCandidates(
    exactAdCandidates,
    adCandidateLimit,
  );
  const readModel: MetaDecisionsWorkspaceReadModel = {
    contractVersion: META_DECISIONS_WORKSPACE_CONTRACT_VERSION,
    status: "available",
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    scope: {
      businessId: input.businessId,
      providerAccountId: input.providerAccountId,
      decisionMode: "current",
      metricsRangeAffectsDecisionSnapshot: false,
    },
    unavailable: null,
    source: {
      status: "available",
      authority: "legacy_creative",
      table: "engine_v3_decision_snapshots_daily",
      snapshotAsOf,
      computedAt,
      engineVersion,
      fallbackReason: null,
      generation: null,
    },
    queue: {
      deduplicationGrain: "creative",
      sourcePreCapCount: Math.max(
        0,
        input.snapshotRows.length - inactiveAssets.length,
      ),
      queuedPreCapCount,
      sections,
      adCandidates: {
        selectionVersion: META_DECISIONS_AD_CANDIDATE_SELECTION_VERSION,
        limit: adCandidateLimit,
        preCapCount: canonicalDecisions.length,
        eligiblePreCapCount: exactAdCandidates.length,
        selectedCount: adCandidateSelection.selected.length,
        stateCounts: adCandidateSelection.stateCounts,
        omittedAmbiguousIdentity,
        omittedWithoutVerifiedAdId,
        omittedNotApplicable,
        items: adCandidateSelection.selected,
      },
      inactiveAssets: {
        preCapCount: inactiveAssets.length,
        inactiveCount: inactiveAssets.filter(
          (decision) => decision.deliveryScope?.state === "inactive",
        ).length,
        unknownCount: inactiveAssets.filter(
          (decision) => decision.deliveryScope?.state === "unknown",
        ).length,
        items: inactiveAssets.sort(compareDecisions),
      },
      omittedFromQueue: {
        count: omissions.length,
        reasons: countReasons(omissions),
      },
    },
    capabilities: baseCapabilities({
      providerScopeAvailable: true,
      snapshotAvailable: true,
    }),
  };
  attachCanonicalAdUniverse(
    readModel,
    new Set(
      identityEligibleAdCandidates
        .map((decision) => decision.parentChain.ad?.id?.trim() ?? "")
        .filter(Boolean),
    ),
  );
  return readModel;
}

export interface MetaNativeDecisionGeneration {
  jobRunId: string;
  asOfDate: string;
  providerAccountRefId: string;
  manifestHash: string;
  expectedAdCount: number;
}

export type MetaNativeGenerationValidationIssue =
  | "snapshot_count_mismatch"
  | "duplicate_ad_identity"
  | "manifest_hash_mismatch"
  | "lineage_incomplete"
  | "job_run_mismatch"
  | "provider_scope_mismatch"
  | "engine_epoch_mismatch"
  | "snapshot_as_of_mismatch"
  | "decision_scope_mismatch"
  | "ad_identity_missing"
  | "snapshot_authority_invalid"
  | "input_hash_invalid"
  | "decision_hash_invalid";

export type MetaValidatedNativeDecisionGenerationBundle =
  | {
      status: "available";
      generation: Readonly<MetaNativeDecisionGeneration>;
      snapshotRows: readonly MetaNativeDecisionSnapshotSourceRow[];
      unavailableReason: null;
      validationIssue: null;
    }
  | {
      status: "unavailable";
      generation: null;
      snapshotRows: readonly [];
      unavailableReason: string;
      validationIssue: MetaNativeGenerationValidationIssue | null;
    };

export interface ReadValidatedMetaNativeDecisionGenerationBundleInput {
  businessId: string;
  providerAccountId: string;
  asOfDate?: string;
  /** Explicit evaluation instant for deterministic serving/tests. */
  generatedAt?: string;
  currentAds?: readonly MetaCurrentAdStatusSourceRow[];
  currentAdSourceComplete?: boolean;
  /** Optional serving projection. Full generation authority is still proven. */
  creativeIds?: readonly string[];
  /** Optional exact-Ad serving projection. Full generation authority is still proven. */
  adIds?: readonly string[];
}

function nativeSnapshotHardAction(value: string | null) {
  return value === "scale" || value === "cut" || value === "refresh"
    ? value
    : null;
}

function hasValidNativeSnapshotAuthority(
  row: MetaNativeDecisionSnapshotSourceRow,
) {
  if (
    !DECISION_LABELS.has(row.label as DecisionLabel) ||
    !DECISION_LABELS.has(row.raw_label as DecisionLabel) ||
    (row.authority_blocker !== null &&
      !AUTHORITY_BLOCKERS.has(
        row.authority_blocker as DecisionAuthorityBlocker,
      ))
  ) {
    return false;
  }
  const authorizedAction = nativeSnapshotHardAction(row.authorized_action);
  const blockedAction = nativeSnapshotHardAction(row.blocked_action_type);
  if (
    (row.authorized_action !== null && authorizedAction === null) ||
    (row.blocked_action_type !== null && blockedAction === null) ||
    (authorizedAction !== null && blockedAction !== null)
  ) {
    return false;
  }
  if (row.authority_blocker !== null) {
    return (
      authorizedAction === null &&
      (nativeSnapshotHardAction(row.label) === null ||
        row.label === row.raw_label)
    );
  }
  const rawAction = nativeSnapshotHardAction(row.raw_label);
  if (rawAction !== null) {
    const authorized =
      row.label === rawAction && authorizedAction === rawAction;
    const pending =
      nativeSnapshotHardAction(row.label) === null &&
      authorizedAction === null &&
      blockedAction === rawAction &&
      parseBadges(row.badges).codes.includes("pending_transition");
    return authorized || pending;
  }
  return (
    nativeSnapshotHardAction(row.label) === null && authorizedAction === null
  );
}

export type MetaNativeCanonicalDecisionInventory =
  | {
      status: "available";
      generation: Readonly<MetaNativeDecisionGeneration>;
      items: readonly MetaCanonicalDecision[];
      unavailableReason: null;
    }
  | {
      status: "unavailable";
      generation: null;
      items: readonly [];
      unavailableReason: string;
    };

export interface BuildNativeMetaDecisionsWorkspaceReadModelInput {
  businessId: string;
  providerAccountId: string;
  generation: MetaNativeDecisionGeneration;
  snapshotRows: readonly MetaNativeDecisionSnapshotSourceRow[];
  campaignContextRows?: MetaDecisionCampaignContextSourceRow[];
  eventRows?: MetaDecisionEventSourceRow[];
  outcomeRows?: MetaDecisionOutcomeSourceRow[];
  responseRows?: MetaNativeDecisionResponseSourceRow[];
  eventSourceAvailable?: boolean;
  outcomeSourceAvailable?: boolean;
  responseSourceAvailable?: boolean;
  generatedAt?: string;
  sectionLimit?: number;
  adCandidateLimit?: number;
}

function unavailableNativeGenerationBundle(input: {
  reason: string;
  validationIssue?: MetaNativeGenerationValidationIssue | null;
}): MetaValidatedNativeDecisionGenerationBundle {
  return {
    status: "unavailable",
    generation: null,
    snapshotRows: [],
    unavailableReason: input.reason,
    validationIssue: input.validationIssue ?? null,
  };
}

export function validateMetaNativeDecisionGenerationBundle(input: {
  businessId: string;
  providerAccountId: string;
  generation: MetaNativeDecisionGeneration;
  snapshotRows: readonly MetaNativeDecisionSnapshotSourceRow[];
}): MetaValidatedNativeDecisionGenerationBundle {
  const fail = (
    validationIssue: MetaNativeGenerationValidationIssue,
  ): MetaValidatedNativeDecisionGenerationBundle =>
    unavailableNativeGenerationBundle({
      reason: "native_generation_lineage_or_manifest_invalid",
      validationIssue,
    });
  if (input.snapshotRows.length !== input.generation.expectedAdCount) {
    return fail("snapshot_count_mismatch");
  }
  const adIds = input.snapshotRows.map((row) => row.ad_id).sort();
  if (new Set(adIds).size !== adIds.length) {
    return fail("duplicate_ad_identity");
  }
  if (
    hashAdDecisionIdentityManifest({
      businessId: input.businessId,
      providerAccountId: input.providerAccountId,
      asOfDate: input.generation.asOfDate,
      adIds,
    }) !== input.generation.manifestHash
  ) {
    return fail("manifest_hash_mismatch");
  }
  for (const row of input.snapshotRows) {
    if (!row.lineage_valid) return fail("lineage_incomplete");
    if (row.job_run_id !== input.generation.jobRunId) {
      return fail("job_run_mismatch");
    }
    if (
      row.provider_account_id !== input.providerAccountId ||
      row.provider_account_ref_id !== input.generation.providerAccountRefId
    ) {
      return fail("provider_scope_mismatch");
    }
    if (row.engine_version !== NATIVE_AD_ENGINE_VERSION) {
      return fail("engine_epoch_mismatch");
    }
    if (row.as_of_date !== input.generation.asOfDate) {
      return fail("snapshot_as_of_mismatch");
    }
    if (
      row.scope_type !== "account" ||
      row.scope_id !== input.providerAccountId
    ) {
      return fail("decision_scope_mismatch");
    }
    if (row.ad_id.trim() === "") return fail("ad_identity_missing");
    if (!hasValidNativeSnapshotAuthority(row)) {
      return fail("snapshot_authority_invalid");
    }
    if (!isSha256(row.input_hash)) return fail("input_hash_invalid");
    if (!isSha256(row.decision_hash)) return fail("decision_hash_invalid");
  }
  return {
    status: "available",
    generation: input.generation,
    snapshotRows: input.snapshotRows,
    unavailableReason: null,
    validationIssue: null,
  };
}

function nativeResponseHistory(input: {
  snapshotId: string;
  rows: readonly MetaNativeDecisionResponseSourceRow[];
  sourceAvailable: boolean;
}): Pick<MetaDecisionHistoryEnvelope, "responses" | "providerWrites"> & {
  episodeKey: string | null;
} {
  const candidates = input.rows.filter(
    (row) => row.decision_snapshot_id === input.snapshotId,
  );
  const episodeKey = candidates[0]?.episode_key?.trim() || null;
  const valid: NonNullable<MetaDecisionHistoryEnvelope["responses"]["items"]> =
    candidates.flatMap((row) => {
      const observationStatus = row.observation_status;
      if (
        !row.response_id ||
        !row.response_cutoff ||
        (observationStatus !== "observed_response" &&
          observationStatus !== "observed_no_response" &&
          observationStatus !== "unknown_incomplete") ||
        !row.response_type
      ) {
        return [];
      }
      return [
        {
          id: row.response_id,
          observationStatus,
          responseType: row.response_type,
          detectedAt: row.detected_at,
          responseCutoff: row.response_cutoff,
        },
      ];
    });
  if (!input.sourceAvailable || valid.length === 0) {
    return {
      episodeKey,
      responses: {
        status: "unavailable",
        reason: input.sourceAvailable
          ? "native_operator_response_not_accrued"
          : "native_operator_response_source_unavailable",
        items: [],
      },
      providerWrites: {
        status: "unavailable",
        reason: input.sourceAvailable
          ? "native_action_receipt_not_observed"
          : "native_action_receipt_source_unavailable",
      },
    };
  }
  return {
    episodeKey,
    responses: { status: "available", reason: null, items: valid },
    providerWrites: candidates.some((row) => Boolean(row.action_receipt_id))
      ? { status: "available", reason: null }
      : { status: "unavailable", reason: "native_action_receipt_not_observed" },
  };
}

function nativeSnapshotToInternalSnapshot(
  row: MetaNativeDecisionSnapshotSourceRow,
): MetaDecisionSnapshotSourceRow {
  return {
    snapshot_id: row.snapshot_id,
    provider_account_id: row.provider_account_id,
    creative_id: row.ad_id,
    as_of_date: row.as_of_date,
    engine_version: row.engine_version,
    scope_type: row.scope_type,
    scope_id: row.scope_id,
    label: row.label,
    pre_authority_label: row.pre_authority_label,
    authority_blocker: row.authority_blocker,
    raw_label: row.raw_label,
    confidence: row.confidence,
    truth_source: row.truth_source,
    effective_target_roas: row.effective_target_roas,
    ratio_to_target: row.ratio_to_target,
    badges: row.badges,
    reason: row.reason,
    spend: row.spend,
    purchases: row.purchases,
    roas: row.roas,
    recent7d_roas: row.recent7d_roas,
    label_transform: row.label_transform,
    blocked_action_type: row.blocked_action_type,
    computed_at: row.computed_at,
    episode_started_at: row.episode_started_at,
    creative_format: row.creative_format,
    ctr_28d: row.ctr_28d,
    frequency_28d: row.frequency_28d,
    fatigue_status: row.fatigue_status,
  };
}

function nativeSnapshotToIdentity(
  row: MetaNativeDecisionSnapshotSourceRow,
): MetaDecisionIdentitySourceRow {
  return {
    provider_account_id: row.provider_account_id,
    creative_id: row.ad_id,
    creative_name: row.creative_name,
    campaign_id: row.campaign_id,
    campaign_name: row.campaign_name,
    adset_id: row.adset_id,
    adset_name: row.adset_name,
    ad_id: row.ad_id,
    ad_name: row.ad_name,
    campaign_status: row.campaign_status,
    adset_status: row.adset_status,
    ad_status: row.ad_status,
    currency: row.currency,
    thumbnail_url: row.thumbnail_url,
    media_source_present: row.media_source_present,
    media_available: row.media_available,
    media_source: row.media_source,
    source_updated_at: row.source_updated_at,
    candidate_ad_count: 1,
  };
}

function applyNativeCanonicalDecisionAuthority(input: {
  businessId: string;
  decision: MetaCanonicalDecision;
  row: MetaNativeDecisionSnapshotSourceRow;
  responseRows: readonly MetaNativeDecisionResponseSourceRow[];
  responseSourceAvailable: boolean;
  now: Date;
}): MetaCanonicalDecision {
  const { decision, row } = input;
  const response = nativeResponseHistory({
    snapshotId: row.snapshot_id,
    rows: input.responseRows,
    sourceAvailable: input.responseSourceAvailable,
  });
  decision.decisionId = stableId("mdd", [
    input.businessId,
    row.provider_account_ref_id,
    row.provider_account_id,
    "ad",
    row.ad_id,
    row.scope_type,
    row.scope_id,
  ]);
  decision.episodeId =
    response.episodeKey ??
    stableId("mde", [decision.decisionId, row.label, row.episode_started_at]);
  decision.identityGrain = "ad";
  decision.parentChain.ad = { id: row.ad_id, name: row.ad_name };
  decision.parentChain.creative = row.creative_id
    ? { id: row.creative_id, name: row.creative_name }
    : null;
  decision.deliveryScope = deliveryScopeForIdentity(
    nativeSnapshotToIdentity(row),
  );
  decision.parentChain.provenance = provenance({
    source: "engine_v3_ad_decision_snapshots_daily+meta_ad_dimensions",
    field: "provider_account_ref_id,provider_account_id,ad_id,creative_id",
    recordId: row.snapshot_id,
    asOf: row.source_updated_at,
    version: row.engine_version,
  });
  const hasExactCreativeIdentity = Boolean(row.creative_id?.trim());
  decision.identityResolution = {
    basis: "native_ad_exact",
    candidateAdCount: 1,
    metricsEquivalent: true,
    adActionEligible: hasExactCreativeIdentity,
  };
  const authorizedAction =
    row.authorized_action === "scale" ||
    row.authorized_action === "cut" ||
    row.authorized_action === "refresh"
      ? row.authorized_action
      : null;
  const activeHierarchy = decision.deliveryScope.state === "active";
  const actionEligible =
    activeHierarchy &&
    hasExactCreativeIdentity &&
    decision.classification.decisionState === "act" &&
    authorizedAction !== null &&
    decision.classification.buyerAction === authorizedAction;
  const decisionFreshness = evaluateDecisionOriginAdDecisionFreshness({
    computedAt: row.computed_at,
    now: input.now,
  });
  const executionReadiness = !actionEligible
    ? ("decision_not_authorized" as const)
    : row.engine_version !== NATIVE_AD_ENGINE_VERSION
      ? ("engine_version_drift" as const)
      : decisionFreshness.status !== "fresh"
        ? ("stale_decision" as const)
        : ("governance_unavailable" as const);
  decision.sourceAuthority = {
    status: "native_exact",
    actionEligible,
    reviewOnlyReason: !hasExactCreativeIdentity
      ? "current_creative_identity_is_missing"
      : !activeHierarchy
        ? decision.deliveryScope.state === "inactive"
          ? "current_hierarchy_is_not_active"
          : "current_hierarchy_status_is_unknown"
        : decision.classification.decisionState !== "act"
          ? "served_decision_is_not_actionable"
          : authorizedAction !== null &&
              decision.classification.buyerAction === authorizedAction
            ? null
            : "native_snapshot_did_not_authorize_the_served_action",
    snapshotId: row.snapshot_id,
    evaluationId: row.evaluation_id,
    inputHash: row.input_hash,
    decisionHash: row.decision_hash,
    providerAccountRefId: row.provider_account_ref_id,
    engineVersion: row.engine_version,
    realAdId: row.ad_id,
    authorizedAction: actionEligible ? authorizedAction : null,
    jobRunId: row.job_run_id,
    executionReadiness,
    decisionFreshness,
  };
  decision.sourceDecision.provenance = provenance({
    source: "engine_v3_ad_decision_snapshots_daily",
    field:
      "label,pre_authority_label,authority_blocker,raw_label,confidence,reason,badges,authorized_action",
    recordId: row.snapshot_id,
    asOf: row.as_of_date,
    version: row.engine_version,
  });
  decision.metrics.provenance = provenance({
    source: "engine_v3_ad_decision_snapshots_daily+meta_ad_daily",
    field:
      "spend,purchases,roas,recent7d_roas,effective_target_roas,ratio_to_target,account_currency",
    recordId: row.snapshot_id,
    asOf: row.as_of_date,
    version: row.engine_version,
  });
  if (decision.exposure) decision.exposure.grain = "ad";
  decision.history.responses = response.responses;
  decision.history.providerWrites = response.providerWrites;
  return decision;
}

export interface BuildNativeMetaCanonicalDecisionInventoryInput {
  businessId: string;
  providerAccountId: string;
  generation: MetaNativeDecisionGeneration;
  snapshotRows: readonly MetaNativeDecisionSnapshotSourceRow[];
  campaignContextRows?: readonly MetaDecisionCampaignContextSourceRow[];
  eventRows?: readonly MetaDecisionEventSourceRow[];
  outcomeRows?: readonly MetaDecisionOutcomeSourceRow[];
  responseRows?: readonly MetaNativeDecisionResponseSourceRow[];
  eventSourceAvailable?: boolean;
  outcomeSourceAvailable?: boolean;
  responseSourceAvailable?: boolean;
  generatedAt?: string;
}

export function buildNativeMetaCanonicalDecisionInventory(
  input: BuildNativeMetaCanonicalDecisionInventoryInput,
): MetaNativeCanonicalDecisionInventory {
  const validatedBundle = validateMetaNativeDecisionGenerationBundle({
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
    generation: input.generation,
    snapshotRows: input.snapshotRows,
  });
  if (validatedBundle.status === "unavailable") {
    return {
      status: "unavailable",
      generation: null,
      items: [],
      unavailableReason: validatedBundle.unavailableReason,
    };
  }

  const contextByCampaignId = new Map(
    (input.campaignContextRows ?? []).map((row) => [row.campaignId, row]),
  );
  const eventsByAdId = new Map<string, MetaDecisionEventSourceRow[]>();
  for (const row of input.eventRows ?? []) {
    const rows = eventsByAdId.get(row.creative_id) ?? [];
    rows.push(row);
    eventsByAdId.set(row.creative_id, rows);
  }
  const outcomesBySnapshotId = new Map<
    string,
    MetaDecisionOutcomeSourceRow[]
  >();
  for (const row of input.outcomeRows ?? []) {
    const rows = outcomesBySnapshotId.get(row.decision_snapshot_id) ?? [];
    rows.push(row);
    outcomesBySnapshotId.set(row.decision_snapshot_id, rows);
  }

  const items: MetaCanonicalDecision[] = [];
  const generatedAt = new Date(input.generatedAt ?? Date.now());
  for (const row of [...validatedBundle.snapshotRows].sort((left, right) =>
    left.ad_id.localeCompare(right.ad_id),
  )) {
    const canonical = buildCanonicalDecision({
      businessId: input.businessId,
      providerAccountId: input.providerAccountId,
      authorityMode: "native_exact",
      snapshot: nativeSnapshotToInternalSnapshot(row),
      identity: nativeSnapshotToIdentity(row),
      campaignContext: row.campaign_id
        ? (contextByCampaignId.get(row.campaign_id) ?? null)
        : null,
      eventRows: eventsByAdId.get(row.ad_id) ?? [],
      outcomeRows: outcomesBySnapshotId.get(row.snapshot_id) ?? [],
      eventSourceAvailable: input.eventSourceAvailable !== false,
      outcomeSourceAvailable: input.outcomeSourceAvailable !== false,
    });
    if (!canonical.decision) {
      return {
        status: "unavailable",
        generation: null,
        items: [],
        unavailableReason: "native_canonical_projection_incomplete",
      };
    }
    items.push(
      applyNativeCanonicalDecisionAuthority({
        businessId: input.businessId,
        decision: canonical.decision,
        row,
        responseRows: input.responseRows ?? [],
        responseSourceAvailable: input.responseSourceAvailable === true,
        now: generatedAt,
      }),
    );
  }
  if (items.length !== input.generation.expectedAdCount) {
    return {
      status: "unavailable",
      generation: null,
      items: [],
      unavailableReason: "native_canonical_projection_incomplete",
    };
  }
  return {
    status: "available",
    generation: input.generation,
    items,
    unavailableReason: null,
  };
}

export function buildNativeMetaDecisionsWorkspaceReadModel(
  input: BuildNativeMetaDecisionsWorkspaceReadModelInput,
): MetaDecisionsWorkspaceReadModel {
  const validatedBundle = validateMetaNativeDecisionGenerationBundle({
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
    generation: input.generation,
    snapshotRows: input.snapshotRows,
  });
  if (validatedBundle.status === "unavailable") {
    throw new Error("Native ad generation lineage or manifest is incomplete.");
  }

  const internalSnapshotRows = input.snapshotRows.map(
    nativeSnapshotToInternalSnapshot,
  );
  const identityRows = input.snapshotRows.map(nativeSnapshotToIdentity);

  if (input.snapshotRows.length === 0) {
    const empty = buildUnavailableMetaDecisionsWorkspaceReadModel({
      businessId: input.businessId,
      providerAccountId: input.providerAccountId,
      code: "snapshot_unavailable",
      message: "The authoritative native account generation contains zero ads.",
      generatedAt: input.generatedAt,
      sectionLimit: input.sectionLimit,
      adCandidateLimit: input.adCandidateLimit,
    });
    empty.status = "available";
    empty.unavailable = null;
    empty.source = {
      status: "available",
      authority: "native_ad",
      table: "engine_v3_ad_decision_snapshots_daily",
      snapshotAsOf: input.generation.asOfDate,
      computedAt: null,
      engineVersion: NATIVE_AD_ENGINE_VERSION,
      fallbackReason: null,
      generation: {
        jobRunId: input.generation.jobRunId,
        providerAccountRefId: input.generation.providerAccountRefId,
        manifestHash: input.generation.manifestHash,
        expectedAdCount: 0,
      },
    };
    empty.queue.deduplicationGrain = "ad";
    empty.capabilities = baseCapabilities({
      providerScopeAvailable: true,
      snapshotAvailable: true,
    });
    return empty;
  }

  const model = buildMetaDecisionsWorkspaceReadModel({
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
    snapshotRows: internalSnapshotRows,
    identityRows,
    campaignContextRows: input.campaignContextRows,
    eventRows: input.eventRows,
    outcomeRows: input.outcomeRows,
    eventSourceAvailable: input.eventSourceAvailable,
    outcomeSourceAvailable: input.outcomeSourceAvailable,
    generatedAt: input.generatedAt,
    sectionLimit: input.sectionLimit,
    adCandidateLimit: input.adCandidateLimit,
    requireActiveHierarchy: true,
    authorityMode: "native_exact",
  });
  const nativeBySnapshot = new Map(
    input.snapshotRows.map((row) => [row.snapshot_id, row]),
  );
  const generatedAt = new Date(input.generatedAt ?? Date.now());
  const allDecisions = new Map<string, MetaCanonicalDecision>();
  for (const section of Object.values(model.queue.sections)) {
    for (const decision of section.items)
      allDecisions.set(decision.sourceSnapshotId, decision);
  }
  for (const decision of model.queue.adCandidates?.items ?? [])
    allDecisions.set(decision.sourceSnapshotId, decision);
  for (const decision of model.queue.inactiveAssets?.items ?? [])
    allDecisions.set(decision.sourceSnapshotId, decision);

  for (const decision of allDecisions.values()) {
    const row = nativeBySnapshot.get(decision.sourceSnapshotId);
    if (!row) throw new Error("Native decision lost its snapshot identity.");
    applyNativeCanonicalDecisionAuthority({
      businessId: input.businessId,
      decision,
      row,
      responseRows: input.responseRows ?? [],
      responseSourceAvailable: input.responseSourceAvailable === true,
      now: generatedAt,
    });
  }
  model.source = {
    status: "available",
    authority: "native_ad",
    table: "engine_v3_ad_decision_snapshots_daily",
    snapshotAsOf: input.generation.asOfDate,
    computedAt:
      input.snapshotRows
        .map((row) => row.computed_at)
        .sort()
        .at(-1) ?? null,
    engineVersion: NATIVE_AD_ENGINE_VERSION,
    fallbackReason: null,
    generation: {
      jobRunId: input.generation.jobRunId,
      providerAccountRefId: input.generation.providerAccountRefId,
      manifestHash: input.generation.manifestHash,
      expectedAdCount: input.generation.expectedAdCount,
    },
  };
  model.queue.deduplicationGrain = "ad";
  model.capabilities.stableDecisionIdentity = {
    status: "available",
    reason: "native_exact_ad_snapshot_evaluation_hash_and_job_lineage",
  };
  model.capabilities.stableEpisodeIdentity = {
    status: "available",
    reason: "native_exact_ad_label_episode",
  };
  model.capabilities.responseAttribution = input.responseSourceAvailable
    ? { status: "available", reason: "native_exact_ad_episode" }
    : { status: "unavailable", reason: "native_response_source_unavailable" };
  model.capabilities.providerWriteLinkage = input.responseRows?.some((row) =>
    Boolean(row.action_receipt_id),
  )
    ? { status: "available", reason: "native_immutable_action_receipt" }
    : { status: "unavailable", reason: "native_action_receipt_not_observed" };
  return model;
}

export interface MetaDecisionExecutionGovernanceFacts {
  verified: boolean;
  controlsConfigured: boolean;
  writeBlocked: boolean;
  blockReason: string | null;
}

function hydrateMetaCanonicalDecisionExecutionGovernance(input: {
  decision: MetaCanonicalDecision;
  governance: MetaDecisionExecutionGovernanceFacts;
  pipeline: {
    verified: boolean;
    executionReady: boolean;
  };
  now: Date;
}) {
  const authority = input.decision.sourceAuthority;
  if (authority?.status !== "native_exact") return;
  const decisionFreshness = evaluateDecisionOriginAdDecisionFreshness({
    computedAt: input.decision.sourceDecision.computedAt,
    now: input.now,
  });
  authority.decisionFreshness = decisionFreshness;
  authority.executionReadiness = !authority.actionEligible
    ? "decision_not_authorized"
    : authority.engineVersion !== NATIVE_AD_ENGINE_VERSION ||
        input.decision.sourceDecision.engineVersion !== NATIVE_AD_ENGINE_VERSION
      ? "engine_version_drift"
      : decisionFreshness.status !== "fresh"
        ? "stale_decision"
        : input.governance.blockReason === "META_ADS_WRITE_KILL_SWITCH" ||
            input.governance.blockReason === "business_kill_switch"
          ? "kill_switched"
          : !input.governance.verified ||
              !input.governance.controlsConfigured ||
              input.governance.writeBlocked
            ? "governance_unavailable"
            : !input.pipeline.verified || !input.pipeline.executionReady
              ? "source_pipeline_unready"
              : "live_preflight_required";
}

/**
 * Apply the same request-time governance contract to canonical inventories
 * served outside the Decisions workspace, such as Creative Briefing. The
 * source inventory is cloned so cache/shared-reader results stay immutable.
 */
export function applyMetaExecutionGovernanceToCanonicalDecisions(input: {
  decisions: readonly MetaCanonicalDecision[];
  governance: MetaDecisionExecutionGovernanceFacts;
  pipeline: {
    verified: boolean;
    executionReady: boolean;
  };
  now?: Date;
}): MetaCanonicalDecision[] {
  const decisions = structuredClone([...input.decisions]);
  const now = input.now ?? new Date();
  for (const decision of decisions) {
    hydrateMetaCanonicalDecisionExecutionGovernance({
      decision,
      governance: input.governance,
      pipeline: input.pipeline,
      now,
    });
  }
  return decisions;
}

/**
 * Hydrate the deterministic, server-owned execution posture onto every exact
 * native-Ad projection. This is intentionally separate from the live provider
 * preflight: rendering may prove that a row is eligible to attempt that
 * preflight, but only the submit boundary may prove current provider state.
 *
 * The freshness calculation is repeated at serve time so a cached decision
 * inventory cannot keep an enabled control after crossing the age ceiling.
 */
export function applyMetaExecutionGovernanceToReadModel(input: {
  model: MetaDecisionsWorkspaceReadModel;
  governance: MetaDecisionExecutionGovernanceFacts;
  pipeline: {
    verified: boolean;
    executionReady: boolean;
  };
  now?: Date;
}): MetaDecisionsWorkspaceReadModel {
  // The inventory may come from the short-lived server cache. Never mutate the
  // cached object with request-specific governance or clock state.
  const model = structuredClone(input.model);
  const now = input.now ?? new Date();
  const decisions = new Set<MetaCanonicalDecision>();
  for (const section of Object.values(model.queue.sections ?? {})) {
    for (const decision of section.items) decisions.add(decision);
  }
  for (const decision of model.queue.adCandidates?.items ?? [])
    decisions.add(decision);
  for (const decision of model.queue.inactiveAssets?.items ?? [])
    decisions.add(decision);

  for (const decision of decisions) {
    hydrateMetaCanonicalDecisionExecutionGovernance({
      decision,
      governance: input.governance,
      pipeline: input.pipeline,
      now,
    });
  }
  return model;
}

export const READ_NATIVE_DECISION_GENERATION_QUERY = `
    WITH candidate_runs AS (
      SELECT
        run.*,
        CASE
          WHEN run.status = 'running'
            AND run.started_at < statement_timestamp()
              - make_interval(secs => $5::double precision / 1000.0)
          THEN 'failed'
          WHEN run.status = 'running' THEN 'running'
          WHEN run.finished_at IS NULL
            OR run.finished_at > statement_timestamp()
          THEN 'failed'
          ELSE run.status
        END AS effective_status
      FROM engine_v3_job_runs run
      WHERE run.job_name = $3
        AND run.business_ref_id = $1::uuid
        AND run.business_id = $1::text
        AND run.as_of_date <= COALESCE(
          $4::date,
          (statement_timestamp() AT TIME ZONE 'UTC')::date
        )
        AND run.started_at <= statement_timestamp()
    ), effective_runs AS (
      SELECT run.*
      FROM candidate_runs run
      WHERE NOT (
        run.status = 'skipped'
        AND COALESCE(run.error_message, '') ILIKE 'Advisory lock not acquired%'
        AND EXISTS (
          SELECT 1
          FROM candidate_runs holder
          WHERE holder.business_ref_id = run.business_ref_id
            AND holder.job_name = run.job_name
            AND holder.as_of_date = run.as_of_date
            AND holder.id <> run.id
            AND holder.status IN ('success', 'failed')
            AND holder.started_at <= COALESCE(run.finished_at, run.started_at)
            AND holder.finished_at >= run.started_at
            AND holder.finished_at <= statement_timestamp()
        )
      )
    ), latest_effective_terminal_job AS (
      SELECT run.*
      FROM effective_runs run
      WHERE run.effective_status <> 'running'
      ORDER BY run.as_of_date DESC, run.started_at DESC, run.id DESC
      LIMIT 1
    )
    SELECT
      job.effective_status AS job_status,
      job.id::text AS job_run_id,
      job.as_of_date::text AS as_of_date,
      job.engine_version,
      receipt->>'provider_account_ref_id' AS provider_account_ref_id,
      receipt->>'provider_account_id' AS provider_account_id,
      receipt->>'expected_ad_count' AS expected_ad_count,
      receipt->>'expected_manifest_hash' AS expected_manifest_hash,
      receipt->>'hydrated_ad_count' AS hydrated_ad_count,
      receipt->>'hydrated_manifest_hash' AS hydrated_manifest_hash,
      receipt->>'authoritative_for_prune' AS authoritative_for_prune
    FROM latest_effective_terminal_job job
    LEFT JOIN LATERAL jsonb_array_elements(
      COALESCE(
        job.error_json->'metadata'->'hydration_receipts',
        '[]'::jsonb
      )
    ) receipt ON receipt->>'provider_account_id' = $2
`;

async function readNativeGeneration(input: {
  businessId: string;
  providerAccountId: string;
  asOfDate?: string;
}): Promise<{
  generation: MetaNativeDecisionGeneration | null;
  fallbackReason: string;
}> {
  const rows = await getDbWithTimeout(
    NATIVE_DECISION_READ_TIMEOUT_MS,
  ).query<MetaNativeDecisionGenerationSourceRow>(
    READ_NATIVE_DECISION_GENERATION_QUERY,
    [
      input.businessId,
      input.providerAccountId,
      NATIVE_AD_DECISIONS_JOB_NAME,
      input.asOfDate ?? null,
      NATIVE_DECISION_RUNNING_GRACE_MS,
    ],
  );
  if (rows.length > 1) {
    return {
      generation: null,
      fallbackReason: "native_account_receipt_cardinality_invalid",
    };
  }
  const row = rows[0];
  if (!row)
    return { generation: null, fallbackReason: "native_job_unavailable" };
  if (row.job_status !== "success") {
    return {
      generation: null,
      fallbackReason:
        row.job_status === "failed"
          ? "native_latest_job_failed"
          : row.job_status === "skipped"
            ? "native_latest_job_skipped"
            : "native_job_unavailable",
    };
  }
  if (row.engine_version !== NATIVE_AD_ENGINE_VERSION) {
    return {
      generation: null,
      fallbackReason: "native_latest_job_engine_mismatch",
    };
  }
  const expectedAdCount = exactNonNegativeInteger(row.expected_ad_count);
  const hydratedAdCount = exactNonNegativeInteger(row.hydrated_ad_count);
  const authoritative =
    row.authoritative_for_prune === true ||
    row.authoritative_for_prune === "true";
  if (
    row.provider_account_id !== input.providerAccountId ||
    !row.provider_account_ref_id ||
    expectedAdCount === null ||
    hydratedAdCount !== expectedAdCount ||
    !isSha256(row.expected_manifest_hash) ||
    row.hydrated_manifest_hash !== row.expected_manifest_hash ||
    !authoritative
  ) {
    return {
      generation: null,
      fallbackReason: "native_account_manifest_incomplete",
    };
  }
  return {
    generation: {
      jobRunId: row.job_run_id,
      asOfDate: row.as_of_date,
      providerAccountRefId: row.provider_account_ref_id,
      manifestHash: row.expected_manifest_hash,
      expectedAdCount,
    },
    fallbackReason: "native_generation_ready",
  };
}

async function readNativeSnapshotRows(input: {
  businessId: string;
  providerAccountId: string;
  generation: BuildNativeMetaDecisionsWorkspaceReadModelInput["generation"];
  creativeIds?: readonly string[];
  adIds?: readonly string[];
}) {
  const creativeIds = [...new Set(input.creativeIds ?? [])]
    .map((value) => value.trim())
    .filter(Boolean)
    .sort();
  const adIds = [...new Set(input.adIds ?? [])]
    .map((value) => value.trim())
    .filter(Boolean)
    .sort();
  return getDbWithTimeout(
    NATIVE_DECISION_READ_TIMEOUT_MS,
  ).query<MetaNativeDecisionSnapshotSourceRow>(
    `
    /* ACCOUNT CURRENCY -- ONE PASS OVER THE ACCOUNT, NOT ONE SEEK PER AD.

       This reads exactly what the per-ad LATERAL read: the account_currency on
       the newest meta_ad_daily row for that ad at or before the served day.
       DISTINCT ON with the same ORDER BY is the same row, and it cannot pick a
       different one on a tie because there are none --
       meta_ad_daily_business_id_provider_account_id_date_ad_id_key makes
       (business, account, date, ad) unique, so date alone already decides.
       Verified by fingerprinting both forms: identical md5 over
       (ad_id, account_currency), identical non-null count (1,079 of 2,849).

       The LATERAL was sargable but the planner would not take it. Two indexes
       both offered the ordering, and it costed them 59.07 vs 61.35 -- so on
       one production account it chose the account-wide unique index and walked
       every ad of every day backwards looking for one ad_id: 1.6-3.4 ms per
       ad, 872,487 buffers, 8,910-11,214 ms for this column alone, against an
       8,000 ms statement timeout. Batched: 10,644 buffers, 1,298-1,558 ms. */
    -- The cutoff below is $4 rather than snapshot.as_of_date, and those are the
    -- same day ONLY because the outer WHERE pins snapshot.as_of_date = $4::date.
    -- Do not let this query span more than one as_of_date without changing the
    -- cutoff too: the CTE would then read each ad's currency at the newest day
    -- in range and hand it to every older row, silently.
    WITH ad_daily AS MATERIALIZED (
      SELECT DISTINCT ON (daily.ad_id)
        daily.ad_id,
        daily.account_currency
      FROM meta_ad_daily daily
      WHERE daily.business_id = $1
        AND daily.provider_account_id = $2
        AND daily.date <= $4::date
        AND (NOT $9::boolean OR daily.ad_id = ANY($10::text[]))
      ORDER BY daily.ad_id, daily.date DESC, daily.updated_at DESC
    )
    SELECT
      snapshot.id::text AS snapshot_id,
      snapshot.evaluation_id::text AS evaluation_id,
      snapshot.job_run_id::text AS job_run_id,
      snapshot.provider_account_ref_id::text AS provider_account_ref_id,
      snapshot.provider_account_id,
      snapshot.ad_id,
      snapshot.creative_id,
      snapshot.as_of_date::text AS as_of_date,
      snapshot.engine_version,
      snapshot.scope_type,
      snapshot.scope_id,
      snapshot.label,
      snapshot.pre_authority_label,
      snapshot.authority_blocker,
      snapshot.raw_label,
      snapshot.confidence,
      snapshot.truth_source,
      snapshot.effective_target_roas,
      snapshot.ratio_to_target,
      snapshot.badges,
      snapshot.reason,
      snapshot.spend,
      snapshot.purchases,
      snapshot.roas,
      snapshot.recent7d_roas,
      snapshot.label_transform,
      snapshot.blocked_action_type,
      snapshot.authorized_action,
      snapshot.input_hash,
      snapshot.decision_hash,
      snapshot.computed_at::text AS computed_at,
      COALESCE(episode.episode_started_at, snapshot.as_of_date)::text
        AS episode_started_at,
      (
        evaluation.id IS NOT NULL AND context.id IS NOT NULL AND
        evaluation.input_hash = snapshot.input_hash AND
        evaluation.decision_hash = snapshot.decision_hash AND
        evaluation.job_run_id = snapshot.job_run_id AND
        evaluation.provider_account_ref_id = snapshot.provider_account_ref_id AND
        evaluation.provider_account_id = snapshot.provider_account_id AND
        evaluation.ad_id = snapshot.ad_id AND
        context.job_run_id = snapshot.job_run_id AND
        context.provider_account_ref_id = snapshot.provider_account_ref_id AND
        context.provider_account_id = snapshot.provider_account_id
      ) AS lineage_valid,
      creative_dim.creative_name AS creative_name,
      ad_dim.campaign_id,
      COALESCE(campaign_dim.campaign_name_current, campaign_dim.campaign_name_historical)
        AS campaign_name,
      ad_dim.adset_id,
      COALESCE(adset_dim.adset_name_current, adset_dim.adset_name_historical)
        AS adset_name,
      COALESCE(ad_dim.ad_name_current, ad_dim.ad_name_historical) AS ad_name,
      -- D075 consumer sweep: an absent_unconfirmed winner is absence
      -- EVIDENCE, never a provider state. It must not fabricate 'DELETED'
      -- (which downstream archive/exclude filters treat as a real provider
      -- status) and must not resurrect any stale present status — the honest
      -- served value is NULL (status unknown), which delivery gating maps to
      -- 'unknown', not 'inactive'.
      CASE
        WHEN campaign_state.presence = 'present' THEN COALESCE(
          campaign_state.effective_status,
          campaign_state.configured_status
        )
        ELSE NULL
      END AS campaign_status,
      CASE
        WHEN adset_state.presence = 'present' THEN COALESCE(
          adset_state.effective_status,
          adset_state.configured_status
        )
        ELSE NULL
      END AS adset_status,
      CASE
        WHEN ad_state.presence = 'present' THEN COALESCE(
          ad_state.effective_status,
          ad_state.configured_status
        )
        ELSE NULL
      END AS ad_status,
      ad_daily.account_currency AS currency,
      COALESCE(
        media.table_thumbnail_url, media.thumbnail_url, media.card_preview_url,
        media.poster_url, media.image_url, media.preview_url,
        creative_dim.thumbnail_url
      ) AS thumbnail_url,
      (media.creative_id IS NOT NULL OR creative_dim.creative_id IS NOT NULL OR
        ad_dim.creative_id IS NOT NULL) AS media_source_present,
      COALESCE(
        media.table_thumbnail_url, media.thumbnail_url, media.card_preview_url,
        media.poster_url, media.image_url, media.preview_url, media.video_url,
        creative_dim.thumbnail_url
      ) IS NOT NULL AS media_available,
      CASE
        WHEN media.creative_id IS NOT NULL THEN 'meta_creative_media'
        WHEN creative_dim.creative_id IS NOT NULL THEN 'meta_creative_dimensions'
        WHEN ad_dim.ad_id IS NOT NULL THEN 'meta_ad_dimensions'
        ELSE NULL
      END AS media_source,
      COALESCE(media.updated_at, creative_dim.updated_at, ad_dim.updated_at)::text
        AS source_updated_at,
      lifecycle.creative_format AS creative_format,
      lifecycle.ctr_28d AS ctr_28d,
      lifecycle.frequency_28d AS frequency_28d,
      lifecycle.fatigue_status AS fatigue_status
    FROM engine_v3_ad_decision_snapshots_daily snapshot
    /* The engine already recorded which lifecycle row it decided from. Joining
       it back is a lineage read, not a second opinion: format, 28d CTR, 28d
       frequency and fatigue status come from the exact row behind the verdict,
       never from a re-aggregation that could disagree with it. */
    LEFT JOIN engine_v3_creative_lifecycle_daily lifecycle
      ON lifecycle.id = snapshot.creative_evidence_lifecycle_row_id
     AND lifecycle.business_ref_id = snapshot.business_ref_id
     AND lifecycle.business_id = snapshot.business_id
    LEFT JOIN engine_v3_ad_decision_evaluations evaluation
      ON evaluation.id = snapshot.evaluation_id
     AND evaluation.business_ref_id = snapshot.business_ref_id
     AND evaluation.business_id = snapshot.business_id
     AND evaluation.provider_account_ref_id = snapshot.provider_account_ref_id
     AND evaluation.provider_account_id = snapshot.provider_account_id
     AND evaluation.decision_entity_type = snapshot.decision_entity_type
     AND evaluation.decision_entity_id = snapshot.decision_entity_id
     AND evaluation.ad_id = snapshot.ad_id
     AND evaluation.as_of_date = snapshot.as_of_date
     AND evaluation.engine_version = snapshot.engine_version
     AND evaluation.scope_type = snapshot.scope_type
     AND evaluation.scope_id = snapshot.scope_id
    LEFT JOIN engine_v3_ad_decision_evaluation_contexts context
      ON context.id = evaluation.context_id
     AND context.business_ref_id = evaluation.business_ref_id
     AND context.business_id = evaluation.business_id
     AND context.provider_account_ref_id = evaluation.provider_account_ref_id
     AND context.provider_account_id = evaluation.provider_account_id
     AND context.as_of_date = evaluation.as_of_date
     AND context.engine_version = evaluation.engine_version
     AND context.scope_type = evaluation.scope_type
     AND context.scope_id = evaluation.scope_id
    /* EPISODE START -- TWO BOUNDED INDEX SCANS PER AD, NOT AN ANTI-JOIN PER
       HISTORY ROW.

       The episode start is the first day of the unbroken run of identical
       labels that ends on the served day. It used to be read by scanning the
       entity's timeline and, for EVERY row of it, re-scanning that same
       timeline through a NOT EXISTS anti-join: O(ads x history x history). On
       a 3,200-ad account the inner scan ran 25,453 times and burned 1,149,283
       of the statement's 1,289,559 buffers (89%); the whole read measured
       12,068-23,052 ms against an 8,000 ms web statement timeout, so two
       production accounts ALWAYS timed out, fell back to legacy_creative, and
       told the operator the native generation was unavailable.

       The rewrite states the same rule in the equivalent closed form. A day h
       belongs to the served day's run exactly when no differently-labelled day
       lies in (h, served] -- which is exactly h >= the LAST differently-
       labelled day at or before the served day. So one backwards index scan
       finds that boundary, and one forward scan takes the MIN from it. Same
       rows, same MIN, same NULL behaviour (a run with no boundary keeps the
       open-ended lower bound, and an empty MIN still reads as the snapshot's
       own day through the COALESCE above).

       This form is deliberately not a window-function CTE. That version reads
       the timeline once (28,710 buffers) but the served rows carry a rows=1
       estimate, so the planner joins the CTE by nested loop and rescans it per
       row -- measured 10,236,800 comparisons and 660 ms of pure join CPU on
       the same account, growing as O(ads^2). These two scans stay O(ads x
       history depth) whatever the planner estimates. */
    LEFT JOIN LATERAL (
      SELECT changed.as_of_date
      FROM engine_v3_ad_decision_snapshots_daily changed
      WHERE changed.business_ref_id = snapshot.business_ref_id
        AND changed.provider_account_ref_id = snapshot.provider_account_ref_id
        AND changed.provider_account_id = snapshot.provider_account_id
        AND changed.decision_entity_type = snapshot.decision_entity_type
        AND changed.decision_entity_id = snapshot.decision_entity_id
        AND changed.ad_id = snapshot.ad_id
        AND changed.engine_version = snapshot.engine_version
        AND changed.scope_type = snapshot.scope_type
        AND changed.scope_id = snapshot.scope_id
        AND changed.as_of_date <= snapshot.as_of_date
        AND changed.label <> snapshot.label
      ORDER BY changed.as_of_date DESC
      LIMIT 1
    ) episode_boundary ON TRUE
    LEFT JOIN LATERAL (
      SELECT MIN(history.as_of_date) AS episode_started_at
      FROM engine_v3_ad_decision_snapshots_daily history
      /* The two entity predicates below are redundant with history.ad_id --
         the outer WHERE pins decision_entity_id = ad_id -- but they are what
         makes this lookup use engine_v3_ad_snapshots_ad_identity_unique.
         Filtering on ad_id alone left decision_entity_type and
         decision_entity_id unconstrained in the middle of that index, so each
         of the ~2.5k rows scanned ~15k history rows and threw them away:
         309 million buffer hits and 258 seconds for one read, against an 8s
         query timeout. */
      WHERE history.business_ref_id = snapshot.business_ref_id
        AND history.provider_account_ref_id = snapshot.provider_account_ref_id
        AND history.provider_account_id = snapshot.provider_account_id
        AND history.decision_entity_type = snapshot.decision_entity_type
        AND history.decision_entity_id = snapshot.decision_entity_id
        AND history.ad_id = snapshot.ad_id
        AND history.engine_version = snapshot.engine_version
        AND history.scope_type = snapshot.scope_type
        AND history.scope_id = snapshot.scope_id
        AND history.as_of_date <= snapshot.as_of_date
        AND history.label = snapshot.label
        AND (
          episode_boundary.as_of_date IS NULL
          OR history.as_of_date >= episode_boundary.as_of_date
        )
    ) episode ON TRUE
    LEFT JOIN LATERAL (
      SELECT dimension.*
      FROM meta_ad_dimensions dimension
      WHERE dimension.business_id = $1
        AND dimension.provider_account_id = $2
        AND dimension.ad_id = snapshot.ad_id
      ORDER BY dimension.updated_at DESC
      LIMIT 1
    ) ad_dim ON TRUE
    LEFT JOIN LATERAL (
      SELECT dimension.*
      FROM meta_creative_dimensions dimension
      WHERE snapshot.creative_id IS NOT NULL
        AND dimension.business_id = $1
        AND dimension.provider_account_id = $2
        AND dimension.creative_id = snapshot.creative_id
      ORDER BY dimension.updated_at DESC
      LIMIT 1
    ) creative_dim ON TRUE
    LEFT JOIN LATERAL (
      SELECT source.*
      FROM meta_creative_media source
      WHERE snapshot.creative_id IS NOT NULL
        AND source.business_id = $1
        AND source.provider_account_id = $2
        AND source.creative_id = snapshot.creative_id
      ORDER BY source.date DESC, source.updated_at DESC
      LIMIT 1
    ) media ON TRUE
    LEFT JOIN ad_daily ON ad_daily.ad_id = snapshot.ad_id
    LEFT JOIN LATERAL (
      SELECT dimension.*
      FROM meta_adset_dimensions dimension
      WHERE dimension.business_id = $1
        AND dimension.provider_account_id = $2
        AND dimension.adset_id = ad_dim.adset_id
      ORDER BY dimension.updated_at DESC
      LIMIT 1
    ) adset_dim ON TRUE
    LEFT JOIN LATERAL (
      SELECT dimension.*
      FROM meta_campaign_dimensions dimension
      WHERE dimension.business_id = $1
        AND dimension.provider_account_id = $2
        AND dimension.campaign_id = ad_dim.campaign_id
      ORDER BY dimension.updated_at DESC
      LIMIT 1
    ) campaign_dim ON TRUE
    LEFT JOIN LATERAL (
      SELECT state.presence, state.configured_status, state.effective_status, state.observed_at
      FROM meta_entity_state_history state
      WHERE state.business_ref_id = $1::uuid
        AND state.business_id = $1
        AND state.provider_account_ref_id = snapshot.provider_account_ref_id
        AND state.provider_account_id = $2
        AND state.entity_type = 'campaign'
        AND state.entity_id = ad_dim.campaign_id
      ORDER BY state.observed_at DESC, state.captured_at DESC, state.id DESC
      LIMIT 1
    ) campaign_state ON TRUE
    LEFT JOIN LATERAL (
      SELECT state.presence, state.configured_status, state.effective_status, state.observed_at
      FROM meta_entity_state_history state
      WHERE state.business_ref_id = $1::uuid
        AND state.business_id = $1
        AND state.provider_account_ref_id = snapshot.provider_account_ref_id
        AND state.provider_account_id = $2
        AND state.entity_type = 'adset'
        AND state.entity_id = ad_dim.adset_id
      ORDER BY state.observed_at DESC, state.captured_at DESC, state.id DESC
      LIMIT 1
    ) adset_state ON TRUE
    LEFT JOIN LATERAL (
      SELECT state.presence, state.configured_status, state.effective_status, state.observed_at
      FROM meta_entity_state_history state
      WHERE state.business_ref_id = $1::uuid
        AND state.business_id = $1
        AND state.provider_account_ref_id = snapshot.provider_account_ref_id
        AND state.provider_account_id = $2
        AND state.entity_type = 'ad'
        AND state.entity_id = snapshot.ad_id
      ORDER BY state.observed_at DESC, state.captured_at DESC, state.id DESC
      LIMIT 1
    ) ad_state ON TRUE
    WHERE snapshot.business_ref_id = $1::uuid
      AND snapshot.business_id = $1::text
      AND snapshot.provider_account_ref_id = $5::uuid
      AND snapshot.provider_account_id = $2
      AND snapshot.job_run_id = $3::uuid
      AND snapshot.as_of_date = $4::date
      AND snapshot.engine_version = $6
      AND snapshot.decision_entity_type = 'ad'
      AND snapshot.decision_entity_id = snapshot.ad_id
      AND snapshot.scope_type = 'account'
      AND snapshot.scope_id = $2
      AND (NOT $7::boolean OR snapshot.creative_id = ANY($8::text[]))
      AND (NOT $9::boolean OR snapshot.ad_id = ANY($10::text[]))
    ORDER BY snapshot.confidence DESC, snapshot.spend DESC NULLS LAST,
      snapshot.ad_id
    `,
    [
      input.businessId,
      input.providerAccountId,
      input.generation.jobRunId,
      input.generation.asOfDate,
      input.generation.providerAccountRefId,
      NATIVE_AD_ENGINE_VERSION,
      input.creativeIds !== undefined,
      creativeIds,
      input.adIds !== undefined,
      adIds,
    ],
  );
}

async function readNativeSnapshotManifestAdIds(input: {
  businessId: string;
  providerAccountId: string;
  generation: MetaNativeDecisionGeneration;
}) {
  return getDbWithTimeout(NATIVE_DECISION_READ_TIMEOUT_MS).query<{
    ad_id: string;
  }>(
    `
    /* native-ad-serving-manifest: cheap full-generation integrity proof */
    SELECT snapshot.ad_id
    FROM engine_v3_ad_decision_snapshots_daily snapshot
    WHERE snapshot.business_ref_id = $1::uuid
      AND snapshot.business_id = $1::text
      AND snapshot.provider_account_ref_id = $5::uuid
      AND snapshot.provider_account_id = $2
      AND snapshot.job_run_id = $3::uuid
      AND snapshot.as_of_date = $4::date
      AND snapshot.engine_version = $6
      AND snapshot.decision_entity_type = 'ad'
      AND snapshot.decision_entity_id = snapshot.ad_id
      AND snapshot.scope_type = 'account'
      AND snapshot.scope_id = $2
    ORDER BY snapshot.ad_id
    `,
    [
      input.businessId,
      input.providerAccountId,
      input.generation.jobRunId,
      input.generation.asOfDate,
      input.generation.providerAccountRefId,
      NATIVE_AD_ENGINE_VERSION,
    ],
  );
}

function nativeSnapshotManifestIsComplete(input: {
  businessId: string;
  providerAccountId: string;
  generation: MetaNativeDecisionGeneration;
  adIds: readonly string[];
}) {
  const adIds = input.adIds.map((value) => value.trim()).sort();
  return (
    adIds.length === input.generation.expectedAdCount &&
    adIds.every(Boolean) &&
    new Set(adIds).size === adIds.length &&
    hashAdDecisionIdentityManifest({
      businessId: input.businessId,
      providerAccountId: input.providerAccountId,
      asOfDate: input.generation.asOfDate,
      adIds,
    }) === input.generation.manifestHash
  );
}

type MetaValidatedNativeDecisionSubset =
  | {
      status: "available";
      fullGeneration: MetaNativeDecisionGeneration;
      bundle: Extract<
        MetaValidatedNativeDecisionGenerationBundle,
        { status: "available" }
      >;
      unavailableReason: null;
    }
  | {
      status: "unavailable";
      fullGeneration: null;
      bundle: null;
      unavailableReason: string;
    };

async function readValidatedMetaNativeDecisionSubset(
  input: ReadValidatedMetaNativeDecisionGenerationBundleInput,
): Promise<MetaValidatedNativeDecisionSubset> {
  const generationRead = await readNativeGeneration(input);
  if (!generationRead.generation) {
    return {
      status: "unavailable",
      fullGeneration: null,
      bundle: null,
      unavailableReason: generationRead.fallbackReason,
    };
  }
  const fullGeneration = generationRead.generation;
  const manifestRows = await readNativeSnapshotManifestAdIds({
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
    generation: fullGeneration,
  });
  if (
    !nativeSnapshotManifestIsComplete({
      businessId: input.businessId,
      providerAccountId: input.providerAccountId,
      generation: fullGeneration,
      adIds: manifestRows.map((row) => row.ad_id),
    })
  ) {
    return {
      status: "unavailable",
      fullGeneration: null,
      bundle: null,
      unavailableReason: "native_generation_lineage_or_manifest_invalid",
    };
  }
  const storedSnapshotRows = await readNativeSnapshotRows({
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
    generation: fullGeneration,
    creativeIds: input.creativeIds,
    adIds: input.adIds,
  });
  if (input.adIds !== undefined) {
    const requestedAdIds = [
      ...new Set(input.adIds.map((value) => value.trim()).filter(Boolean)),
    ];
    const storedAdIds = new Set(
      storedSnapshotRows.map((row) => row.ad_id.trim()),
    );
    if (requestedAdIds.some((adId) => !storedAdIds.has(adId))) {
      return {
        status: "unavailable",
        fullGeneration: null,
        bundle: null,
        unavailableReason: "native_serving_subset_incomplete",
      };
    }
  }
  const snapshotRows = reconcileNativeSnapshotRowsWithCurrentAds({
    snapshotRows: storedSnapshotRows,
    currentAds: input.currentAds ?? [],
    sourceComplete: input.currentAdSourceComplete === true,
  });
  const subsetGeneration: MetaNativeDecisionGeneration = {
    ...fullGeneration,
    expectedAdCount: snapshotRows.length,
    manifestHash: hashAdDecisionIdentityManifest({
      businessId: input.businessId,
      providerAccountId: input.providerAccountId,
      asOfDate: fullGeneration.asOfDate,
      adIds: snapshotRows.map((row) => row.ad_id),
    }),
  };
  const bundle = validateMetaNativeDecisionGenerationBundle({
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
    generation: subsetGeneration,
    snapshotRows,
  });
  if (bundle.status === "unavailable") {
    return {
      status: "unavailable",
      fullGeneration: null,
      bundle: null,
      unavailableReason: bundle.unavailableReason,
    };
  }
  return {
    status: "available",
    fullGeneration,
    bundle,
    unavailableReason: null,
  };
}

/**
 * Say why the native decision read failed, once per distinct cause.
 *
 * The caller fails closed to the legacy source either way; what it must not do
 * is fail closed silently. A missing relation behind a capability gate and a
 * query that has outgrown its timeout produce the same fallback reason and look
 * identical in the UI, which is how a permanent timeout survived unnoticed.
 */
const reportedNativeReadFailures = new Set<string>();

function reportNativeGenerationReadFailure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (reportedNativeReadFailures.has(message)) return;
  reportedNativeReadFailures.add(message);
  console.error("[meta] native decision generation read failed", { message });
}

export async function readValidatedMetaNativeDecisionGenerationBundle(
  input: ReadValidatedMetaNativeDecisionGenerationBundleInput,
): Promise<MetaValidatedNativeDecisionGenerationBundle> {
  try {
    const generationRead = await readNativeGeneration(input);
    if (!generationRead.generation) {
      return unavailableNativeGenerationBundle({
        reason: generationRead.fallbackReason,
      });
    }
    const storedSnapshotRows = await readNativeSnapshotRows({
      businessId: input.businessId,
      providerAccountId: input.providerAccountId,
      generation: generationRead.generation,
    });
    const snapshotRows = reconcileNativeSnapshotRowsWithCurrentAds({
      snapshotRows: storedSnapshotRows,
      currentAds: input.currentAds ?? [],
      sourceComplete: input.currentAdSourceComplete === true,
    });
    return validateMetaNativeDecisionGenerationBundle({
      businessId: input.businessId,
      providerAccountId: input.providerAccountId,
      generation: generationRead.generation,
      snapshotRows,
    });
  } catch (error) {
    // This catch hid a 258-second query behind a generic "schema read failed"
    // for as long as the native path has existed. Report it so the next cause
    // is visible on the first occurrence instead of the hundredth.
    reportNativeGenerationReadFailure(error);
    return unavailableNativeGenerationBundle({
      reason: "native_schema_or_generation_read_failed",
    });
  }
}

async function readNativeEventRows(input: {
  businessId: string;
  providerAccountId: string;
  providerAccountRefId: string;
  adIds: string[];
}) {
  if (input.adIds.length === 0) return [];
  return getDb().query<MetaDecisionEventSourceRow>(
    `
    WITH ranked AS (
      SELECT
        event.id::text AS id,
        event.ad_id AS creative_id,
        event.event_date::text AS event_date,
        event.event_type,
        event.previous_label,
        event.current_label,
        event.operator_action_type,
        event.notes,
        COUNT(*) OVER (PARTITION BY event.ad_id) AS pre_cap_count,
        ROW_NUMBER() OVER (
          PARTITION BY event.ad_id
          ORDER BY event.event_date DESC, event.created_at DESC, event.id DESC
        ) AS row_number
      FROM engine_v3_ad_decision_events event
      WHERE event.business_ref_id = $1::uuid
        AND event.business_id = $1
        AND event.provider_account_ref_id = $2::uuid
        AND event.provider_account_id = $3
        AND event.engine_version = $4
        AND event.decision_entity_type = 'ad'
        AND event.decision_entity_id = event.ad_id
        AND event.ad_id = ANY($5::text[])
    )
    SELECT id, creative_id, event_date, event_type, previous_label,
      current_label, operator_action_type, notes, pre_cap_count
    FROM ranked
    WHERE row_number <= $6
    ORDER BY creative_id, event_date DESC, id DESC
    `,
    [
      input.businessId,
      input.providerAccountRefId,
      input.providerAccountId,
      NATIVE_AD_ENGINE_VERSION,
      input.adIds,
      META_DECISION_HISTORY_EVENT_READ_LIMIT,
    ],
  );
}

async function readNativeOutcomeRows(input: {
  businessId: string;
  providerAccountId: string;
  providerAccountRefId: string;
  snapshotIds: string[];
}) {
  if (input.snapshotIds.length === 0) return [];
  return getDb().query<MetaDecisionOutcomeSourceRow>(
    `
    SELECT DISTINCT ON (
      outcome.decision_snapshot_id, outcome.outcome_window_days
    )
      outcome.id::text AS id,
      outcome.decision_snapshot_id::text AS decision_snapshot_id,
      outcome.outcome_window_days,
      outcome.evaluation_date::text AS evaluation_date,
      outcome.realized_outcome,
      outcome.severity,
      outcome.classifier_version
    FROM engine_v3_ad_decision_outcomes_daily outcome
    INNER JOIN engine_v3_ad_decision_outcome_publications publication
      ON publication.active_outcome_run_id = outcome.outcome_run_id
     AND publication.active_job_run_id = outcome.job_run_id
     AND publication.business_ref_id = outcome.business_ref_id
     AND publication.engine_version = outcome.engine_version
     AND publication.outcome_window_days = outcome.outcome_window_days
     AND publication.evaluation_date = outcome.evaluation_date
    WHERE outcome.business_ref_id = $1::uuid
      AND outcome.business_id = $1
      AND outcome.provider_account_ref_id = $2::uuid
      AND outcome.provider_account_id = $3
      AND outcome.engine_version = $4
      AND outcome.decision_entity_type = 'ad'
      AND outcome.decision_entity_id = outcome.ad_id
      AND outcome.decision_snapshot_id = ANY($5::uuid[])
    ORDER BY outcome.decision_snapshot_id, outcome.outcome_window_days,
      outcome.evaluation_date DESC, outcome.computed_at DESC, outcome.id DESC
    `,
    [
      input.businessId,
      input.providerAccountRefId,
      input.providerAccountId,
      NATIVE_AD_ENGINE_VERSION,
      input.snapshotIds,
    ],
  );
}

async function readNativeResponseRows(input: {
  businessId: string;
  providerAccountId: string;
  providerAccountRefId: string;
  snapshotIds: string[];
}) {
  if (input.snapshotIds.length === 0) return [];
  return getDb().query<MetaNativeDecisionResponseSourceRow>(
    `
    SELECT
      episode.decision_snapshot_id::text AS decision_snapshot_id,
      episode.episode_key::text AS episode_key,
      response.id::text AS response_id,
      response.observation_status,
      response.response_type,
      response.detected_at::text AS detected_at,
      response.response_cutoff::text AS response_cutoff,
      response.action_receipt_id::text AS action_receipt_id
    FROM engine_v3_ad_recommendation_episodes episode
    LEFT JOIN LATERAL (
      SELECT observed.*
      FROM engine_v3_ad_operator_responses observed
      WHERE observed.episode_key = episode.episode_key
        AND observed.business_ref_id = episode.business_ref_id
        AND observed.provider_account_ref_id = episode.provider_account_ref_id
        AND observed.provider_account_id = episode.provider_account_id
      ORDER BY observed.response_cutoff DESC, observed.created_at DESC,
        observed.id DESC
      LIMIT 1
    ) response ON TRUE
    WHERE episode.business_ref_id = $1::uuid
      AND episode.business_id = $1
      AND episode.provider_account_ref_id = $2::uuid
      AND episode.provider_account_id = $3
      AND episode.engine_version = $4
      AND episode.decision_entity_type = 'ad'
      AND episode.decision_entity_id = episode.ad_id
      AND episode.decision_snapshot_id = ANY($5::uuid[])
    ORDER BY episode.decision_snapshot_id, episode.recommended_at DESC
    `,
    [
      input.businessId,
      input.providerAccountRefId,
      input.providerAccountId,
      NATIVE_AD_ENGINE_VERSION,
      input.snapshotIds,
    ],
  );
}

interface MetaNativeDecisionAncillaryRows {
  campaignContextRows: MetaDecisionCampaignContextSourceRow[];
  eventRows: MetaDecisionEventSourceRow[];
  outcomeRows: MetaDecisionOutcomeSourceRow[];
  responseRows: MetaNativeDecisionResponseSourceRow[];
  eventSourceAvailable: boolean;
  outcomeSourceAvailable: boolean;
  responseSourceAvailable: boolean;
}

async function readNativeDecisionAncillaryRows(input: {
  businessId: string;
  providerAccountId: string;
  bundle: Extract<
    MetaValidatedNativeDecisionGenerationBundle,
    { status: "available" }
  >;
}): Promise<MetaNativeDecisionAncillaryRows> {
  const adIds = input.bundle.snapshotRows.map((row) => row.ad_id);
  const snapshotIds = input.bundle.snapshotRows.map((row) => row.snapshot_id);
  const campaignIds = [
    ...new Set(
      input.bundle.snapshotRows
        .map((row) => row.campaign_id)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const [contextResult, eventResult, outcomeResult, responseResult] =
    await Promise.allSettled([
      readMetaDecisionCampaignContextRows({
        businessId: input.businessId,
        providerAccountId: input.providerAccountId,
        campaignIds,
        snapshotAsOf: input.bundle.generation.asOfDate,
      }),
      readNativeEventRows({
        businessId: input.businessId,
        providerAccountId: input.providerAccountId,
        providerAccountRefId: input.bundle.generation.providerAccountRefId,
        adIds,
      }),
      readNativeOutcomeRows({
        businessId: input.businessId,
        providerAccountId: input.providerAccountId,
        providerAccountRefId: input.bundle.generation.providerAccountRefId,
        snapshotIds,
      }),
      readNativeResponseRows({
        businessId: input.businessId,
        providerAccountId: input.providerAccountId,
        providerAccountRefId: input.bundle.generation.providerAccountRefId,
        snapshotIds,
      }),
    ]);
  return {
    campaignContextRows:
      contextResult.status === "fulfilled" ? contextResult.value : [],
    eventRows: eventResult.status === "fulfilled" ? eventResult.value : [],
    outcomeRows:
      outcomeResult.status === "fulfilled" ? outcomeResult.value : [],
    responseRows:
      responseResult.status === "fulfilled" ? responseResult.value : [],
    eventSourceAvailable: eventResult.status === "fulfilled",
    outcomeSourceAvailable: outcomeResult.status === "fulfilled",
    responseSourceAvailable: responseResult.status === "fulfilled",
  };
}

export async function readMetaNativeCanonicalDecisionInventory(
  input: ReadValidatedMetaNativeDecisionGenerationBundleInput,
): Promise<MetaNativeCanonicalDecisionInventory> {
  if (input.creativeIds !== undefined || input.adIds !== undefined) {
    try {
      const subsetRead = await readValidatedMetaNativeDecisionSubset(input);
      if (subsetRead.status === "unavailable") {
        return {
          status: "unavailable",
          generation: null,
          items: [],
          unavailableReason: subsetRead.unavailableReason,
        };
      }
      const ancillary = await readNativeDecisionAncillaryRows({
        businessId: input.businessId,
        providerAccountId: input.providerAccountId,
        bundle: subsetRead.bundle,
      });
      const subset = buildNativeMetaCanonicalDecisionInventory({
        businessId: input.businessId,
        providerAccountId: input.providerAccountId,
        generation: subsetRead.bundle.generation,
        snapshotRows: subsetRead.bundle.snapshotRows,
        ...ancillary,
        generatedAt: input.generatedAt,
      });
      return subset.status === "available"
        ? { ...subset, generation: subsetRead.fullGeneration }
        : subset;
    } catch {
      return {
        status: "unavailable",
        generation: null,
        items: [],
        unavailableReason: "native_canonical_inventory_read_failed",
      };
    }
  }
  const bundle = await readValidatedMetaNativeDecisionGenerationBundle(input);
  if (bundle.status === "unavailable") {
    return {
      status: "unavailable",
      generation: null,
      items: [],
      unavailableReason: bundle.unavailableReason,
    };
  }
  try {
    const ancillary = await readNativeDecisionAncillaryRows({
      businessId: input.businessId,
      providerAccountId: input.providerAccountId,
      bundle,
    });
    return buildNativeMetaCanonicalDecisionInventory({
      businessId: input.businessId,
      providerAccountId: input.providerAccountId,
      generation: bundle.generation,
      snapshotRows: bundle.snapshotRows,
      ...ancillary,
      generatedAt: input.generatedAt,
    });
  } catch {
    return {
      status: "unavailable",
      generation: null,
      items: [],
      unavailableReason: "native_canonical_inventory_read_failed",
    };
  }
}

async function readSnapshotRows(input: {
  businessId: string;
  providerAccountId: string;
  asOfDate?: string;
}) {
  return getDb().query<MetaDecisionSnapshotSourceRow>(
    `
    WITH account_creatives AS (
      SELECT creative_id
      FROM meta_creative_dimensions
      WHERE business_id = $1
        AND provider_account_id = $2
      UNION
      SELECT creative_id
      FROM meta_creative_daily
      WHERE business_id = $1
        AND provider_account_id = $2
    ),
    scoped_history AS (
      SELECT snapshot.*
      FROM engine_v3_decision_snapshots_daily snapshot
      INNER JOIN account_creatives account_creative
        ON account_creative.creative_id = snapshot.creative_id
      WHERE (snapshot.business_id = $1 OR snapshot.business_ref_id::text = $1)
        AND snapshot.scope_type = 'account'
        AND snapshot.scope_id = '*'
        AND snapshot.as_of_date <= COALESCE(
          $3::date,
          (statement_timestamp() AT TIME ZONE 'UTC')::date
        )
    ),
    canonical_daily AS (
      SELECT DISTINCT ON (creative_id, as_of_date, scope_type, scope_id)
        history.*
      FROM scoped_history history
      ORDER BY
        creative_id,
        as_of_date,
        scope_type,
        scope_id,
        computed_at DESC,
        engine_version DESC,
        id DESC
    ),
    with_previous AS (
      SELECT
        history.*,
        LAG(label) OVER (
          PARTITION BY creative_id, scope_type, scope_id
          ORDER BY as_of_date, computed_at, id
        ) AS previous_label
      FROM canonical_daily history
    ),
    segmented AS (
      SELECT
        history.*,
        SUM(CASE WHEN previous_label IS DISTINCT FROM label THEN 1 ELSE 0 END) OVER (
          PARTITION BY creative_id, scope_type, scope_id
          ORDER BY as_of_date, computed_at, id
        ) AS episode_group
      FROM with_previous history
    ),
    annotated AS (
      SELECT
        history.*,
        MIN(as_of_date) OVER (
          PARTITION BY creative_id, scope_type, scope_id, episode_group
        ) AS episode_started_at,
        MAX(as_of_date) OVER () AS latest_as_of_date
      FROM segmented history
    )
    SELECT
      id::text AS snapshot_id,
      $2::text AS provider_account_id,
      creative_id,
      as_of_date::text AS as_of_date,
      engine_version,
      scope_type,
      scope_id,
      label,
      pre_authority_label,
      authority_blocker,
      raw_label,
      confidence,
      truth_source,
      effective_target_roas,
      ratio_to_target,
      badges,
      reason,
      spend,
      purchases,
      roas,
      recent7d_roas,
      label_transform,
      to_jsonb(annotated)->>'blocked_action_type' AS blocked_action_type,
      computed_at::text AS computed_at,
      episode_started_at::text AS episode_started_at
    FROM annotated
    WHERE as_of_date = latest_as_of_date
    ORDER BY confidence DESC, spend DESC NULLS LAST, creative_id
    `,
    [input.businessId, input.providerAccountId, input.asOfDate ?? null],
  );
}

async function readIdentityRows(input: {
  businessId: string;
  providerAccountId: string;
  creativeIds: string[];
  snapshotAsOf: string;
}) {
  return getDb().query<MetaDecisionIdentitySourceRow>(
    `
    WITH requested AS (
      SELECT UNNEST($3::text[]) AS creative_id
    )
    SELECT
      COALESCE(creative_dim.provider_account_id, creative_daily.provider_account_id) AS provider_account_id,
      requested.creative_id,
      COALESCE(creative_dim.creative_name, creative_daily.creative_name) AS creative_name,
      COALESCE(ad_dim.campaign_id, creative_dim.campaign_id, creative_daily.campaign_id) AS campaign_id,
      COALESCE(campaign_dim.campaign_name_current, campaign_dim.campaign_name_historical) AS campaign_name,
      COALESCE(ad_dim.adset_id, creative_dim.adset_id, creative_daily.adset_id) AS adset_id,
      COALESCE(adset_dim.adset_name_current, adset_dim.adset_name_historical) AS adset_name,
      ad_dim.ad_id AS ad_id,
      COALESCE(ad_dim.ad_name_current, ad_dim.ad_name_historical) AS ad_name,
      -- D075 consumer sweep: absence evidence serves NULL — never a
      -- fabricated 'DELETED', and never the stale dimension status (that
      -- would resurrect a pre-exit state past the newer absent row).
      CASE
        WHEN campaign_state.presence IS NULL THEN campaign_dim.campaign_status
        WHEN campaign_state.presence = 'present' THEN COALESCE(
          campaign_state.effective_status,
          campaign_state.configured_status,
          campaign_dim.campaign_status
        )
        ELSE NULL
      END AS campaign_status,
      CASE
        WHEN adset_state.presence IS NULL THEN adset_dim.adset_status
        WHEN adset_state.presence = 'present' THEN COALESCE(
          adset_state.effective_status,
          adset_state.configured_status,
          adset_dim.adset_status
        )
        ELSE NULL
      END AS adset_status,
      CASE
        WHEN ad_state.presence IS NULL THEN ad_dim.ad_status
        WHEN ad_state.presence = 'present' THEN COALESCE(
          ad_state.effective_status,
          ad_state.configured_status,
          ad_dim.ad_status
        )
        ELSE NULL
      END AS ad_status,
      COALESCE(ad_identity.candidate_ad_count, 0) AS candidate_ad_count,
      creative_daily.account_currency AS currency,
      COALESCE(
        media.table_thumbnail_url,
        media.thumbnail_url,
        media.card_preview_url,
        media.poster_url,
        media.image_url,
        media.preview_url,
        creative_dim.thumbnail_url,
        creative_daily.thumbnail_url
      ) AS thumbnail_url,
      (media.creative_id IS NOT NULL OR creative_dim.creative_id IS NOT NULL OR creative_daily.creative_id IS NOT NULL)
        AS media_source_present,
      (
        COALESCE(
          media.table_thumbnail_url,
          media.thumbnail_url,
          media.card_preview_url,
          media.poster_url,
          media.image_url,
          media.preview_url,
          media.video_url,
          creative_dim.thumbnail_url,
          creative_daily.thumbnail_url
        ) IS NOT NULL
      ) AS media_available,
      CASE
        WHEN media.creative_id IS NOT NULL THEN 'meta_creative_media'
        WHEN creative_dim.creative_id IS NOT NULL THEN 'meta_creative_dimensions'
        WHEN creative_daily.creative_id IS NOT NULL THEN 'meta_creative_daily'
        ELSE NULL
      END AS media_source,
      COALESCE(
        media.updated_at,
        creative_dim.source_updated_at,
        creative_dim.updated_at,
        creative_daily.updated_at
      )::text AS source_updated_at
    FROM requested
    LEFT JOIN LATERAL (
      SELECT *
      FROM meta_creative_dimensions
      WHERE business_id = $1
        AND provider_account_id = $2
        AND creative_id = requested.creative_id
      ORDER BY updated_at DESC
      LIMIT 1
    ) creative_dim ON TRUE
    LEFT JOIN LATERAL (
      SELECT *
      FROM meta_creative_daily
      WHERE business_id = $1
        AND provider_account_id = $2
        AND creative_id = requested.creative_id
        AND date <= $4::date
      ORDER BY date DESC, updated_at DESC
      LIMIT 1
    ) creative_daily ON TRUE
    LEFT JOIN LATERAL (
      SELECT *
      FROM meta_creative_media
      WHERE business_id = $1
        AND provider_account_id = $2
        AND creative_id = requested.creative_id
        AND date <= $4::date
      ORDER BY date DESC, updated_at DESC
      LIMIT 1
    ) media ON TRUE
    LEFT JOIN LATERAL (
      SELECT *
      FROM meta_ad_dimensions
      WHERE business_id = $1
        AND provider_account_id = $2
        AND ad_id ~ '^[0-9]+$'
        AND (
          ad_id = COALESCE(creative_dim.ad_id, creative_daily.ad_id)
          OR creative_id = requested.creative_id
        )
      ORDER BY updated_at DESC
      LIMIT 1
    ) ad_dim ON TRUE
    LEFT JOIN LATERAL (
      SELECT COUNT(DISTINCT candidate.ad_id)::integer AS candidate_ad_count
      FROM (
        SELECT ad_id
        FROM meta_ad_dimensions
        WHERE business_id = $1
          AND provider_account_id = $2
          AND creative_id = requested.creative_id
          AND ad_id IS NOT NULL
          AND ad_id ~ '^[0-9]+$'
      ) candidate
    ) ad_identity ON TRUE
    LEFT JOIN LATERAL (
      SELECT *
      FROM meta_adset_dimensions
      WHERE business_id = $1
        AND provider_account_id = $2
        AND adset_id = COALESCE(ad_dim.adset_id, creative_dim.adset_id, creative_daily.adset_id)
      ORDER BY updated_at DESC
      LIMIT 1
    ) adset_dim ON TRUE
    LEFT JOIN LATERAL (
      SELECT *
      FROM meta_campaign_dimensions
      WHERE business_id = $1
        AND provider_account_id = $2
        AND campaign_id = COALESCE(
          ad_dim.campaign_id,
          creative_dim.campaign_id,
          creative_daily.campaign_id,
          adset_dim.campaign_id
        )
      ORDER BY updated_at DESC
      LIMIT 1
    ) campaign_dim ON TRUE
    LEFT JOIN LATERAL (
      SELECT state.presence, state.configured_status, state.effective_status
      FROM meta_entity_state_history state
      WHERE state.business_ref_id = $1::uuid
        AND state.business_id = $1
        AND state.provider_account_id = $2
        AND state.entity_type = 'campaign'
        AND state.entity_id = COALESCE(
          ad_dim.campaign_id,
          creative_dim.campaign_id,
          creative_daily.campaign_id,
          adset_dim.campaign_id
        )
      ORDER BY state.observed_at DESC, state.captured_at DESC, state.id DESC
      LIMIT 1
    ) campaign_state ON TRUE
    LEFT JOIN LATERAL (
      SELECT state.presence, state.configured_status, state.effective_status
      FROM meta_entity_state_history state
      WHERE state.business_ref_id = $1::uuid
        AND state.business_id = $1
        AND state.provider_account_id = $2
        AND state.entity_type = 'adset'
        AND state.entity_id = COALESCE(
          ad_dim.adset_id,
          creative_dim.adset_id,
          creative_daily.adset_id
        )
      ORDER BY state.observed_at DESC, state.captured_at DESC, state.id DESC
      LIMIT 1
    ) adset_state ON TRUE
    LEFT JOIN LATERAL (
      SELECT state.presence, state.configured_status, state.effective_status
      FROM meta_entity_state_history state
      WHERE state.business_ref_id = $1::uuid
        AND state.business_id = $1
        AND state.provider_account_id = $2
        AND state.entity_type = 'ad'
        AND state.entity_id = ad_dim.ad_id
      ORDER BY state.observed_at DESC, state.captured_at DESC, state.id DESC
      LIMIT 1
    ) ad_state ON TRUE
    WHERE COALESCE(creative_dim.provider_account_id, creative_daily.provider_account_id) = $2
    ORDER BY requested.creative_id
    `,
    [
      input.businessId,
      input.providerAccountId,
      input.creativeIds,
      input.snapshotAsOf,
    ],
  );
}

async function readIdentityRowsWithoutStateHistory(input: {
  businessId: string;
  providerAccountId: string;
  creativeIds: string[];
  snapshotAsOf: string;
}) {
  return getDb().query<MetaDecisionIdentitySourceRow>(
    `
    WITH requested AS (
      SELECT UNNEST($3::text[]) AS creative_id
    )
    SELECT
      COALESCE(creative_dim.provider_account_id, creative_daily.provider_account_id)
        AS provider_account_id,
      requested.creative_id,
      COALESCE(creative_dim.creative_name, creative_daily.creative_name)
        AS creative_name,
      COALESCE(ad_dim.campaign_id, creative_dim.campaign_id, creative_daily.campaign_id)
        AS campaign_id,
      COALESCE(campaign_dim.campaign_name_current, campaign_dim.campaign_name_historical)
        AS campaign_name,
      COALESCE(ad_dim.adset_id, creative_dim.adset_id, creative_daily.adset_id)
        AS adset_id,
      COALESCE(adset_dim.adset_name_current, adset_dim.adset_name_historical)
        AS adset_name,
      ad_dim.ad_id,
      COALESCE(ad_dim.ad_name_current, ad_dim.ad_name_historical) AS ad_name,
      NULL::text AS campaign_status,
      NULL::text AS adset_status,
      NULL::text AS ad_status,
      COALESCE(ad_identity.candidate_ad_count, 0) AS candidate_ad_count,
      creative_daily.account_currency AS currency,
      COALESCE(
        media.table_thumbnail_url, media.thumbnail_url, media.card_preview_url,
        media.poster_url, media.image_url, media.preview_url,
        creative_dim.thumbnail_url, creative_daily.thumbnail_url
      ) AS thumbnail_url,
      (
        media.creative_id IS NOT NULL OR creative_dim.creative_id IS NOT NULL OR
        creative_daily.creative_id IS NOT NULL
      ) AS media_source_present,
      COALESCE(
        media.table_thumbnail_url, media.thumbnail_url, media.card_preview_url,
        media.poster_url, media.image_url, media.preview_url, media.video_url,
        creative_dim.thumbnail_url, creative_daily.thumbnail_url
      ) IS NOT NULL AS media_available,
      CASE
        WHEN media.creative_id IS NOT NULL THEN 'meta_creative_media'
        WHEN creative_dim.creative_id IS NOT NULL THEN 'meta_creative_dimensions'
        WHEN creative_daily.creative_id IS NOT NULL THEN 'meta_creative_daily'
        ELSE NULL
      END AS media_source,
      COALESCE(
        media.updated_at, creative_dim.source_updated_at,
        creative_dim.updated_at, creative_daily.updated_at
      )::text AS source_updated_at
    FROM requested
    LEFT JOIN LATERAL (
      SELECT *
      FROM meta_creative_dimensions
      WHERE business_id = $1
        AND provider_account_id = $2
        AND creative_id = requested.creative_id
      ORDER BY updated_at DESC
      LIMIT 1
    ) creative_dim ON TRUE
    LEFT JOIN LATERAL (
      SELECT *
      FROM meta_creative_daily
      WHERE business_id = $1
        AND provider_account_id = $2
        AND creative_id = requested.creative_id
        AND date <= $4::date
      ORDER BY date DESC, updated_at DESC
      LIMIT 1
    ) creative_daily ON TRUE
    LEFT JOIN LATERAL (
      SELECT *
      FROM meta_creative_media
      WHERE business_id = $1
        AND provider_account_id = $2
        AND creative_id = requested.creative_id
        AND date <= $4::date
      ORDER BY date DESC, updated_at DESC
      LIMIT 1
    ) media ON TRUE
    LEFT JOIN LATERAL (
      SELECT *
      FROM meta_ad_dimensions
      WHERE business_id = $1
        AND provider_account_id = $2
        AND ad_id ~ '^[0-9]+$'
        AND (
          ad_id = COALESCE(creative_dim.ad_id, creative_daily.ad_id)
          OR creative_id = requested.creative_id
        )
      ORDER BY updated_at DESC
      LIMIT 1
    ) ad_dim ON TRUE
    LEFT JOIN LATERAL (
      SELECT COUNT(DISTINCT ad_id)::integer AS candidate_ad_count
      FROM meta_ad_dimensions
      WHERE business_id = $1
        AND provider_account_id = $2
        AND creative_id = requested.creative_id
        AND ad_id IS NOT NULL
        AND ad_id ~ '^[0-9]+$'
    ) ad_identity ON TRUE
    LEFT JOIN LATERAL (
      SELECT *
      FROM meta_adset_dimensions
      WHERE business_id = $1
        AND provider_account_id = $2
        AND adset_id = COALESCE(
          ad_dim.adset_id, creative_dim.adset_id, creative_daily.adset_id
        )
      ORDER BY updated_at DESC
      LIMIT 1
    ) adset_dim ON TRUE
    LEFT JOIN LATERAL (
      SELECT *
      FROM meta_campaign_dimensions
      WHERE business_id = $1
        AND provider_account_id = $2
        AND campaign_id = COALESCE(
          ad_dim.campaign_id, creative_dim.campaign_id,
          creative_daily.campaign_id, adset_dim.campaign_id
        )
      ORDER BY updated_at DESC
      LIMIT 1
    ) campaign_dim ON TRUE
    WHERE COALESCE(creative_dim.provider_account_id, creative_daily.provider_account_id) = $2
    ORDER BY requested.creative_id
    `,
    [
      input.businessId,
      input.providerAccountId,
      input.creativeIds,
      input.snapshotAsOf,
    ],
  );
}

export async function readMetaDecisionCampaignContextRows(input: {
  businessId: string;
  providerAccountId: string;
  campaignIds: string[];
  snapshotAsOf: string;
}): Promise<MetaDecisionCampaignContextSourceRow[]> {
  const mode = resolveCampaignContextMode();
  if (input.campaignIds.length === 0 || mode === "unknown") {
    return input.campaignIds.map((campaignId) => ({
      campaignId,
      kind: null,
      source: "unknown",
      confidenceClass: "unknown",
      sourceUpdatedAt: null,
      resolverVersion: null,
      confidenceScore: null,
      evidence: [],
      conflictReasons: [],
      // The daily resolver source was never read here, so this is absence of
      // an evaluation, not a low-confidence one.
      unresolvedReason: "not_yet_evaluated",
      lastEvaluatedAt: null,
    }));
  }
  const rows = await getDb().query<MetaDecisionCampaignContextDbRow>(
    `
    WITH requested AS (
      SELECT UNNEST($3::text[]) AS campaign_id
    )
    SELECT
      requested.campaign_id,
      inferred.inferred_kind,
      inferred.confidence_class,
      inferred.confidence_score,
      inferred.signal_scores_json,
      inferred.evidence_json,
      inferred.conflict_reasons_json,
      inferred.updated_at::text AS context_updated_at,
      inferred.as_of_date::text AS context_as_of_date,
      inferred.resolver_version,
      inferred.kind_source
    FROM requested
    LEFT JOIN LATERAL (
      SELECT *
      FROM engine_v3_campaign_context_daily
      WHERE business_id = $1
        AND campaign_id = requested.campaign_id
        AND provider_account_id = $2
        AND as_of_date <= $4::date
        AND as_of_date >= ($4::date - ($5 * INTERVAL '1 day'))
      ORDER BY as_of_date DESC, updated_at DESC
      LIMIT 1
    ) inferred ON TRUE
    ORDER BY requested.campaign_id
    `,
    [
      input.businessId,
      input.providerAccountId,
      input.campaignIds,
      input.snapshotAsOf,
      CAMPAIGN_CONTEXT_MAX_AGE_DAYS,
    ],
  );
  return rows.map((row) => {
    const inferredKind = text(row.inferred_kind);
    /**
     * D074/D076 explanation fields, identical in both arms: they restate the
     * persisted resolver row verbatim (score, evidence, conflicts, last
     * evaluation time) and never depend on how the kind is presented.
     */
    const explanation = {
      confidenceScore: finiteNumber(row.confidence_score),
      evidence: jsonStringArray(row.evidence_json),
      conflictReasons: jsonStringArray(row.conflict_reasons_json),
      lastEvaluatedAt:
        isoTimestamp(row.context_updated_at) ??
        isoTimestamp(row.context_as_of_date),
    };
    if (
      mode === "automatic" &&
      (inferredKind === "main" ||
        inferredKind === "test" ||
        inferredKind === "mixed")
    ) {
      const confidence = text(row.confidence_class);
      return {
        campaignId: row.campaign_id,
        kind: inferredKind,
        suggestedKind: inferredKind,
        // D081 C3 — the RETAINED source, never a synthesized one. This
        // previously wrote the literal `system_inferred` whenever the mode was
        // automatic and the kind parsed, which meant the authority helper's
        // exact-source rule was checking a value the reader had invented.
        // Only an exact match maps through; everything else stays unknown and
        // fails closed downstream.
        source: exactCampaignContextSource(row.kind_source),
        confidenceClass:
          confidence === "high" ||
          confidence === "medium" ||
          confidence === "low" ||
          confidence === "conflict"
            ? confidence
            : "unknown",
        sourceUpdatedAt: row.context_updated_at,
        resolverVersion: row.resolver_version,
        ...explanation,
        unresolvedReason: null,
      };
    }
    const hasAutomaticContext = Boolean(row.context_updated_at);
    return {
      campaignId: row.campaign_id,
      kind: null,
      suggestedKind:
        mode === "automatic" && hasAutomaticContext
          ? resolveProvisionalCampaignKind({
              kind: row.inferred_kind,
              signalScores: row.signal_scores_json,
            })
          : null,
      // The retained origin, exactly as stored. This arm previously synthesized
      // `system_inferred` from the mode and the presence of a context row, so
      // an unresolved row still served fabricated automatic provenance.
      source: exactCampaignContextSource(row.kind_source),
      confidenceClass:
        row.confidence_class === "conflict"
          ? ("conflict" as const)
          : ("unknown" as const),
      sourceUpdatedAt: row.context_updated_at,
      resolverVersion: row.resolver_version,
      ...explanation,
      // Derived from the PERSISTED confidence_class, not the presented one: a
      // campaign with no context row at all has a null class and reads as
      // not-yet-evaluated rather than as insufficient evidence.
      unresolvedReason: campaignContextUnresolvedReason(
        text(row.confidence_class),
      ),
    };
  });
}

async function readEventRows(input: {
  businessId: string;
  creativeIds: string[];
}) {
  if (input.creativeIds.length === 0) return [];
  return getDb().query<MetaDecisionEventSourceRow>(
    `
    WITH ranked AS (
      SELECT
        event.id::text AS id,
        event.creative_id,
        event.event_date::text AS event_date,
        event.event_type,
        event.previous_label,
        event.current_label,
        event.operator_action_type,
        event.notes,
        COUNT(*) OVER (PARTITION BY event.creative_id) AS pre_cap_count,
        ROW_NUMBER() OVER (
          PARTITION BY event.creative_id
          ORDER BY event.event_date DESC, event.created_at DESC, event.id DESC
        ) AS row_number
      FROM engine_v3_decision_events event
      WHERE (event.business_id = $1 OR event.business_ref_id::text = $1)
        AND event.creative_id = ANY($2::text[])
    )
    SELECT
      id,
      creative_id,
      event_date,
      event_type,
      previous_label,
      current_label,
      operator_action_type,
      notes,
      pre_cap_count
    FROM ranked
    WHERE row_number <= $3
    ORDER BY creative_id, event_date DESC, id DESC
    `,
    [
      input.businessId,
      input.creativeIds,
      META_DECISION_HISTORY_EVENT_READ_LIMIT,
    ],
  );
}

async function readOutcomeRows(snapshotIds: string[]) {
  if (snapshotIds.length === 0) return [];
  return getDb().query<MetaDecisionOutcomeSourceRow>(
    `
    SELECT
      outcome.id::text AS id,
      outcome.decision_snapshot_id::text AS decision_snapshot_id,
      outcome.outcome_window_days,
      outcome.evaluation_date::text AS evaluation_date,
      outcome.realized_outcome,
      outcome.severity,
      outcome.classifier_version
    FROM engine_v3_decision_outcomes_daily outcome
    WHERE outcome.decision_snapshot_id = ANY($1::uuid[])
    ORDER BY outcome.decision_snapshot_id, outcome.outcome_window_days
    `,
    [snapshotIds],
  );
}

export async function readMetaDecisionsWorkspaceReadModel(input: {
  businessId: string;
  providerAccountId: string;
  asOfDate?: string;
  currentAds?: readonly MetaCurrentAdStatusSourceRow[];
  currentAdSourceComplete?: boolean;
  /** Exact active-Ad projection for the compact operator surface. */
  adIds?: readonly string[];
  generatedAt?: string;
  sectionLimit?: number;
  adCandidateLimit?: number;
}): Promise<MetaDecisionsWorkspaceReadModel> {
  if (input.adIds !== undefined) {
    const subsetRead = await readValidatedMetaNativeDecisionSubset(input);
    if (subsetRead.status === "unavailable") {
      const unavailable = buildUnavailableMetaDecisionsWorkspaceReadModel({
        businessId: input.businessId,
        providerAccountId: input.providerAccountId,
        code: "snapshot_unavailable",
        message:
          "The complete native decision generation could not be verified for the active Ad inventory.",
        generatedAt: input.generatedAt,
        sectionLimit: input.sectionLimit,
        adCandidateLimit: input.adCandidateLimit,
      });
      unavailable.source.fallbackReason = subsetRead.unavailableReason;
      return unavailable;
    }
    const ancillary = await readNativeDecisionAncillaryRows({
      businessId: input.businessId,
      providerAccountId: input.providerAccountId,
      bundle: subsetRead.bundle,
    });
    const model = buildNativeMetaDecisionsWorkspaceReadModel({
      businessId: input.businessId,
      providerAccountId: input.providerAccountId,
      generation: subsetRead.bundle.generation,
      snapshotRows: [...subsetRead.bundle.snapshotRows],
      ...ancillary,
      generatedAt: input.generatedAt,
      sectionLimit: input.sectionLimit,
      adCandidateLimit: input.adCandidateLimit,
    });
    if (model.source.generation) {
      model.source.generation = {
        jobRunId: subsetRead.fullGeneration.jobRunId,
        providerAccountRefId: subsetRead.fullGeneration.providerAccountRefId,
        manifestHash: subsetRead.fullGeneration.manifestHash,
        expectedAdCount: subsetRead.fullGeneration.expectedAdCount,
      };
    }
    return model;
  }
  const nativeBundle =
    await readValidatedMetaNativeDecisionGenerationBundle(input);
  let nativeFallbackReason =
    nativeBundle.status === "available"
      ? "native_generation_ready"
      : nativeBundle.unavailableReason;
  if (nativeBundle.status === "available") {
    try {
      const ancillary = await readNativeDecisionAncillaryRows({
        businessId: input.businessId,
        providerAccountId: input.providerAccountId,
        bundle: nativeBundle,
      });
      return buildNativeMetaDecisionsWorkspaceReadModel({
        businessId: input.businessId,
        providerAccountId: input.providerAccountId,
        generation: nativeBundle.generation,
        snapshotRows: nativeBundle.snapshotRows,
        ...ancillary,
        generatedAt: input.generatedAt,
        sectionLimit: input.sectionLimit,
        adCandidateLimit: input.adCandidateLimit,
      });
    } catch {
      nativeFallbackReason = "native_canonical_projection_failed";
    }
  }

  const snapshotRows = await readSnapshotRows(input);
  if (snapshotRows.length === 0) {
    const unavailable = buildUnavailableMetaDecisionsWorkspaceReadModel({
      businessId: input.businessId,
      providerAccountId: input.providerAccountId,
      code: "snapshot_unavailable",
      message:
        "No persisted creative decision snapshot is available for this Meta account.",
      generatedAt: input.generatedAt,
      sectionLimit: input.sectionLimit,
      adCandidateLimit: input.adCandidateLimit,
    });
    unavailable.source.fallbackReason = nativeFallbackReason;
    return unavailable;
  }
  const creativeIds = [...new Set(snapshotRows.map((row) => row.creative_id))];
  const snapshotIds = [...new Set(snapshotRows.map((row) => row.snapshot_id))];
  const snapshotAsOf = snapshotRows
    .map((row) => row.as_of_date)
    .sort()
    .at(-1)!;
  let storedIdentityRows: MetaDecisionIdentitySourceRow[];
  try {
    storedIdentityRows = await readIdentityRows({
      businessId: input.businessId,
      providerAccountId: input.providerAccountId,
      creativeIds,
      snapshotAsOf,
    });
  } catch (error) {
    if (!isUndefinedRelationError(error)) throw error;
    storedIdentityRows = await readIdentityRowsWithoutStateHistory({
      businessId: input.businessId,
      providerAccountId: input.providerAccountId,
      creativeIds,
      snapshotAsOf,
    });
  }
  const identityRows = reconcileMetaDecisionIdentityRowsWithCurrentAds({
    identityRows: storedIdentityRows,
    currentAds: input.currentAds ?? [],
    sourceComplete: input.currentAdSourceComplete === true,
  });
  const campaignIds = [
    ...new Set(
      identityRows
        .map((row) => row.campaign_id)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const [contextResult, eventResult, outcomeResult] = await Promise.allSettled([
    readMetaDecisionCampaignContextRows({
      businessId: input.businessId,
      providerAccountId: input.providerAccountId,
      campaignIds,
      snapshotAsOf,
    }),
    readEventRows({ businessId: input.businessId, creativeIds }),
    readOutcomeRows(snapshotIds),
  ]);
  const legacyModel = buildMetaDecisionsWorkspaceReadModel({
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
    snapshotRows,
    identityRows,
    campaignContextRows:
      contextResult.status === "fulfilled" ? contextResult.value : [],
    eventRows: eventResult.status === "fulfilled" ? eventResult.value : [],
    outcomeRows:
      outcomeResult.status === "fulfilled" ? outcomeResult.value : [],
    eventSourceAvailable: eventResult.status === "fulfilled",
    outcomeSourceAvailable: outcomeResult.status === "fulfilled",
    generatedAt: input.generatedAt,
    sectionLimit: input.sectionLimit,
    adCandidateLimit: input.adCandidateLimit,
    requireActiveHierarchy: true,
  });
  legacyModel.source.fallbackReason = nativeFallbackReason;
  return legacyModel;
}
