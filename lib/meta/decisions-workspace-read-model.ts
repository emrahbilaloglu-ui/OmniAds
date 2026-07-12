import { createHash } from "node:crypto";
import {
  CREATIVE_DECISION_CENTER_ADAPTER_VERSION,
  adaptCreativeDecisionToRow,
} from "@/lib/creative-decision-center/adapter";
import {
  CREATIVE_DECISION_CENTER_V3_BRIDGE_VERSION,
  bridgeV3DecisionToV21,
} from "@/lib/creative-decision-center/v3-bridge";
import {
  DECISION_BADGE_DISPLAY,
  type DecisionBadge,
  type DecisionLabel,
  type DecisionOutput,
  type TruthSource,
} from "@/lib/creative-decision-engine/types";
import { getDb } from "@/lib/db";
import { resolveCampaignContextMode } from "@/lib/creative-decision-engine/campaign-context/source";
import { classifyMetaCreativeAssessment } from "@/lib/meta/creative-assessment";
import { projectMetaDecisionSemantics } from "@/lib/meta/decision-semantics";
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

const BLOCKER_LABELS: Record<string, string> = {
  campaign_context_unresolved: "Campaign context is unresolved",
  campaign_context_low_confidence: "Campaign context confidence is too low",
  campaign_context_conflict: "Campaign context sources conflict",
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
  currency: string | null;
  thumbnail_url: string | null;
  media_source_present: boolean;
  media_available: boolean;
  media_source: string | null;
  source_updated_at: string | null;
  candidate_ad_count?: unknown;
}

export interface MetaDecisionCampaignContextSourceRow {
  campaignId: string;
  kind: "main" | "test" | "mixed" | null;
  source: "persisted_label" | "system_inferred" | "unknown";
  confidenceClass: "high" | "medium" | "low" | "unknown" | "conflict";
  sourceUpdatedAt: string | null;
  resolverVersion: string | null;
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
  label_kind: string | null;
  label_source: string | null;
  label_updated_at: string | null;
  inferred_kind: string | null;
  confidence_class: string | null;
  context_updated_at: string | null;
  resolver_version: string | null;
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

function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nonNegativeInteger(value: unknown): number {
  const parsed = finiteNumber(value);
  return parsed === null ? 0 : Math.max(0, Math.trunc(parsed));
}

function verifiedMetaAdId(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized && /^\d+$/.test(normalized) ? normalized : null;
}

function hardBlockedAction(
  value: DecisionLabel | string | null | undefined,
): "scale" | "cut" | "refresh" | null {
  return value === "scale" || value === "cut" || value === "refresh"
    ? value
    : null;
}

function normalizeCurrency(value: unknown): string | null {
  const normalized = text(value)?.toUpperCase() ?? null;
  return normalized && /^[A-Z]{3}$/.test(normalized) ? normalized : null;
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
      table: "engine_v3_decision_snapshots_daily",
      snapshotAsOf: null,
      computedAt: null,
      engineVersion: null,
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
  const trustedForAction = Boolean(
    contextKind &&
    (context?.source === "persisted_label" ||
      context?.confidenceClass === "high"),
  );
  let blockerCode: string | null = null;
  if (context?.confidenceClass === "conflict")
    blockerCode = "campaign_context_conflict";
  else if (contextKind && !trustedForAction)
    blockerCode = "campaign_context_low_confidence";
  else if (!contextKind) blockerCode = "campaign_context_unresolved";
  return {
    value: contextKind ?? "label_needed",
    confidence: context?.confidenceClass ?? "unknown",
    trustedForAction,
    blockerCode,
    provenance: provenance({
      source:
        context?.source === "persisted_label"
          ? "meta_campaign_labels"
          : context?.source === "system_inferred"
            ? "engine_v3_campaign_context_daily"
            : "meta_decisions_classification_overlay",
      field:
        context?.source === "persisted_label"
          ? "campaign_kind"
          : "inferred_kind",
      recordId: input.identity.campaign_id,
      asOf: context?.sourceUpdatedAt ?? null,
      version: context?.resolverVersion ?? null,
    }),
  };
}

function assessmentFor(input: {
  snapshot: MetaDecisionSnapshotSourceRow;
  badgeCodes: readonly string[];
  heldAction: "scale" | "cut" | "refresh" | null;
}): MetaDecisionAssessmentOverlay {
  const classification = classifyMetaCreativeAssessment({
    label: input.snapshot.label,
    truthSource: input.snapshot.truth_source,
    badgeCodes: input.badgeCodes,
    heldAction: input.heldAction,
  });
  return {
    value: classification.value,
    blockerCode: classification.blockerCode,
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
  entries.push({
    code: "risk_tier_unclassified",
    source: META_DECISIONS_CLASSIFICATION_OVERLAY_VERSION,
    field: "riskTier",
  });
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
    if (windowDays !== 7 && windowDays !== 14) return [];
    return [
      {
        id: outcome.id,
        outcomeWindowDays: windowDays as 7 | 14,
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
  const trustedKind =
    input.role.trustedForAction && input.role.value !== "label_needed"
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
    campaignLabelStatus: input.identity.campaign_id
      ? trustedKind
        ? "labeled"
        : "unlabeled"
      : "no_campaign",
    campaignKind: trustedKind,
    labelTransform:
      input.snapshot.label_transform === "test_cohort_refresh_to_cut"
        ? "test_cohort_refresh_to_cut"
        : null,
    blockedActionType:
      input.snapshot.blocked_action_type === "scale" ||
      input.snapshot.blocked_action_type === "cut" ||
      input.snapshot.blocked_action_type === "refresh"
        ? input.snapshot.blocked_action_type
        : input.badges.some((badge) => badge.type === "stop_loss_review")
          ? "cut"
          : null,
    engineVersion: input.snapshot.engine_version,
    generatedAt: input.snapshot.computed_at,
  };
}

function buildCanonicalDecision(input: {
  businessId: string;
  providerAccountId: string;
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
  const bridged = bridgeV3DecisionToV21({
    decision: decisionOutput,
    context: {
      creativeId: input.snapshot.creative_id,
      identityGrain: "creative",
      familyId: null,
      campaignKind: decisionOutput.campaignKind ?? null,
    },
  });
  if (bridged.kind === "omitted") {
    return { decision: null, omissionReason: bridged.omitReason };
  }
  const adapted = adaptCreativeDecisionToRow(bridged.adapterInput).row;
  const legacyBuyerAction = adapted.buyerAction as MetaDecisionBuyerAction;
  // This read model is creative-grain only. Campaign/ad-set money moves and
  // account integrity events are composed by their own server producers; a
  // creative label never crosses into those grains merely because its action
  // vocabulary contains scale/cut/diagnose.
  const queueSection: MetaDecisionQueueSectionKey = "creative_rotation";
  const heldAction = hardBlockedAction(decisionOutput.blockedActionType);
  const assessment = assessmentFor({
    snapshot: input.snapshot,
    badgeCodes: parsedBadges.codes,
    heldAction,
  });
  const blockers = buildBlockers({
    bridgeCodes: bridged.engine.blockerReasons,
    role,
    assessment,
    snapshot: input.snapshot,
  });
  const semantics = projectMetaDecisionSemantics({
    legacyBuyerAction,
    sourceLabel: input.snapshot.label,
    lifecycleRole: role.value,
    badgeCodes: parsedBadges.codes,
    blockerCodes: blockers.map((blocker) => blocker.code),
  });
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
    field: "label,confidence,reason,badges",
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
      sourceDecision: {
        label: input.snapshot.label,
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
        ad: verifiedAdId
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
        adActionEligible: candidateAdCount === 1 && Boolean(verifiedAdId),
      },
      media: mediaEnvelope(input.identity),
      classification: {
        overlayVersion: META_DECISIONS_CLASSIFICATION_OVERLAY_VERSION,
        queueSection,
        lifecycleRole: role,
        assessment,
        decisionState: semantics.decisionState,
        heldAction,
        legacyBuyerAction: semantics.legacyBuyerAction,
        buyerAction: semantics.buyerAction,
        buyerLabel: adapted.buyerLabel,
        executionAction:
          (adapted.executionAction as MetaCanonicalDecision["classification"]["executionAction"]) ??
          null,
        resolution: semantics.resolution,
        blockers,
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
      riskTierProvenance: {
        status: "proposed",
        reason: "risk_tier_producer_not_persisted",
      },
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
        effectiveTargetRoas: finiteNumber(input.snapshot.effective_target_roas),
        ratioToTarget: finiteNumber(input.snapshot.ratio_to_target),
        currency: normalizeCurrency(input.identity.currency),
        attribution: "meta_attributed",
        provenance: provenance({
          source: "engine_v3_decision_snapshots_daily+meta_creative_daily",
          field:
            "spend,purchases,roas,recent7d_roas,effective_target_roas,ratio_to_target,account_currency",
          recordId: input.snapshot.snapshot_id,
          asOf: input.snapshot.as_of_date,
          version: input.snapshot.engine_version,
        }),
      },
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

function selectAdCandidates(
  items: MetaCanonicalDecision[],
  limit: number,
) {
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
  selected.sort(compareAdCandidates);
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
  const identityEligibleAdCandidates = canonicalDecisions
    .filter(
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
    (decision) =>
      decision.identityResolution?.basis === "creative_ambiguous",
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
  return {
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
      table: "engine_v3_decision_snapshots_daily",
      snapshotAsOf,
      computedAt,
      engineVersion,
    },
    queue: {
      deduplicationGrain: "creative",
      sourcePreCapCount: input.snapshotRows.length,
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
}

async function readSnapshotRows(input: {
  businessId: string;
  providerAccountId: string;
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
    [input.businessId, input.providerAccountId],
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

async function readCampaignContextRows(input: {
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
    }));
  }
  const rows = await getDb().query<MetaDecisionCampaignContextDbRow>(
    `
    WITH requested AS (
      SELECT UNNEST($3::text[]) AS campaign_id
    )
    SELECT
      requested.campaign_id,
      label.campaign_kind AS label_kind,
      label.source AS label_source,
      label.updated_at::text AS label_updated_at,
      inferred.inferred_kind,
      inferred.confidence_class,
      inferred.updated_at::text AS context_updated_at,
      inferred.resolver_version
    FROM requested
    LEFT JOIN LATERAL (
      SELECT *
      FROM meta_campaign_labels
      WHERE business_id = $1
        AND campaign_id = requested.campaign_id
        AND (provider_account_id = $2 OR provider_account_id IS NULL)
      ORDER BY (provider_account_id = $2) DESC, updated_at DESC
      LIMIT 1
    ) label ON TRUE
    LEFT JOIN LATERAL (
      SELECT *
      FROM engine_v3_campaign_context_daily
      WHERE business_id = $1
        AND campaign_id = requested.campaign_id
        AND (provider_account_id = $2 OR provider_account_id IS NULL)
        AND as_of_date <= $4::date
      ORDER BY (provider_account_id = $2) DESC, as_of_date DESC, updated_at DESC
      LIMIT 1
    ) inferred ON TRUE
    ORDER BY requested.campaign_id
    `,
    [
      input.businessId,
      input.providerAccountId,
      input.campaignIds,
      input.snapshotAsOf,
    ],
  );
  return rows.map((row) => {
    const labelKind = text(row.label_kind);
    const inferredKind = text(row.inferred_kind);
    if (labelKind === "main" || labelKind === "test" || labelKind === "mixed") {
      return {
        campaignId: row.campaign_id,
        kind: labelKind,
        source: "persisted_label" as const,
        confidenceClass: "high" as const,
        sourceUpdatedAt: row.label_updated_at,
        resolverVersion: row.label_source,
      };
    }
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
        source: "system_inferred" as const,
        confidenceClass:
          confidence === "high" ||
          confidence === "medium" ||
          confidence === "low" ||
          confidence === "conflict"
            ? confidence
            : "unknown",
        sourceUpdatedAt: row.context_updated_at,
        resolverVersion: row.resolver_version,
      };
    }
    return {
      campaignId: row.campaign_id,
      kind: null,
      source: "unknown" as const,
      confidenceClass:
        row.confidence_class === "conflict"
          ? ("conflict" as const)
          : ("unknown" as const),
      sourceUpdatedAt: row.context_updated_at ?? row.label_updated_at,
      resolverVersion: row.resolver_version,
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
  generatedAt?: string;
  sectionLimit?: number;
  adCandidateLimit?: number;
}): Promise<MetaDecisionsWorkspaceReadModel> {
  const snapshotRows = await readSnapshotRows(input);
  if (snapshotRows.length === 0) {
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
  const creativeIds = [...new Set(snapshotRows.map((row) => row.creative_id))];
  const snapshotIds = [...new Set(snapshotRows.map((row) => row.snapshot_id))];
  const snapshotAsOf = snapshotRows
    .map((row) => row.as_of_date)
    .sort()
    .at(-1)!;
  const identityRows = await readIdentityRows({
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
    creativeIds,
    snapshotAsOf,
  });
  const campaignIds = [
    ...new Set(
      identityRows
        .map((row) => row.campaign_id)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const [contextResult, eventResult, outcomeResult] = await Promise.allSettled([
    readCampaignContextRows({
      businessId: input.businessId,
      providerAccountId: input.providerAccountId,
      campaignIds,
      snapshotAsOf,
    }),
    readEventRows({ businessId: input.businessId, creativeIds }),
    readOutcomeRows(snapshotIds),
  ]);
  return buildMetaDecisionsWorkspaceReadModel({
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
  });
}
