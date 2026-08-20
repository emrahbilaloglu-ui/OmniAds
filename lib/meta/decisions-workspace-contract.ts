export const META_DECISIONS_WORKSPACE_CONTRACT_VERSION =
  "meta-decisions-workspace.read.v4" as const;

export const META_DECISIONS_CLASSIFICATION_OVERLAY_VERSION =
  "meta-decisions-classification-overlay.v4" as const;

export const META_DECISIONS_SECTION_SELECTION_VERSION =
  "meta-decisions-section-selection.v1" as const;

export const META_DECISIONS_WORKSPACE_SECTION_LIMIT = 5;
export const META_DECISIONS_AD_CANDIDATE_LIMIT = 60;
export const META_DECISIONS_AD_CANDIDATE_MAX_LIMIT = 300;
export const META_DECISIONS_AD_CANDIDATE_LANE_RESERVE = 10;
export const META_DECISIONS_AD_CANDIDATE_SELECTION_VERSION =
  "meta-decisions-ad-candidate-selection.v2" as const;

export const META_DECISION_QUEUE_SECTION_KEYS = [
  "integrity_fires",
  "money_moves",
  "creative_rotation",
] as const;

export type MetaDecisionQueueSectionKey =
  (typeof META_DECISION_QUEUE_SECTION_KEYS)[number];

export type MetaDecisionRiskTier = "low" | "medium" | "high";
export type MetaDecisionConfirmationCeremony =
  "standard" | "elevated" | "highest";

export type MetaDecisionBuyerAction =
  | "scale"
  | "cut"
  | "refresh"
  | "protect"
  | "test_more"
  | "watch_launch"
  | "fix_delivery"
  | "fix_policy"
  | "diagnose_data";

export type MetaDecisionServedBuyerAction = Exclude<
  MetaDecisionBuyerAction,
  "diagnose_data"
>;

export type MetaDecisionAuthorityBlocker =
  | "profile_hard_action_ineligible"
  | "source_freshness"
  | "campaign_context"
  | "native_metrics_unavailable"
  | "native_profile_unavailable"
  | "recent_recovery_unverifiable";

export type MetaDecisionState =
  "act" | "monitor" | "blocked" | "not_applicable";

export interface MetaDecisionResolution {
  code: string;
  category:
    | "data"
    | "tracking"
    | "commercial_truth"
    | "campaign_context"
    | "delivery"
    | "policy"
    | "funnel"
    | "system";
  owner: "system" | "operator" | "integration";
  label: string;
  nextStep: string;
}

export type MetaDecisionExecutionAction =
  "promote_to_main" | "scale_budget" | "controlled_scale";

export type MetaDecisionLifecycleRole =
  "test" | "main" | "mixed" | "label_needed";

export type MetaDecisionCreativeAssessment =
  | "proven_winner"
  | "above_target_not_scale_ready"
  | "fatigued_former_winner"
  | "below_target"
  | "learning"
  | "stable"
  | "refresh_candidate"
  | "funnel_bottleneck"
  | "decision_blocked"
  | "evidence_incomplete"
  | "out_of_scope"
  | "cant_assess";

export interface MetaDecisionProvenance {
  source: string;
  field: string;
  recordId: string | null;
  asOf: string | null;
  version: string | null;
}

export interface MetaDecisionBlocker {
  code: string;
  label: string;
  category:
    "data" | "delivery" | "policy" | "campaign_context" | "assessment" | "risk";
  provenance: MetaDecisionProvenance;
}

/**
 * A statement about THIS pipeline, never a finding about the ad.
 *
 * An advisory is served in the same shape as a blocker and is meant to be read
 * like one: it names something the operator should know before acting. The one
 * thing it must not do is VETO an action the engine already authorized — and
 * that is exactly why it does not live in `classification.blockers`. Every
 * action gate in this codebase asks `blockers.length > 0`
 * (`authorizeMetaNativeAdPause`, `buildMetaLaunchpadHandoffAuthorization`), so
 * a code parked in an array with that name acquires a veto from the field name
 * alone, whatever comment sits beside it. Moving it out is the only form of
 * the demotion that cannot silently regress.
 *
 * `reason` is the producer-side statement of WHY the advisory exists. For
 * `risk_tier_unclassified` it is the same `risk_tier_producer_not_persisted`
 * that the envelope's `riskTierProvenance` already carries.
 */
export interface MetaDecisionAdvisory {
  code: string;
  label: string;
  category: MetaDecisionBlocker["category"];
  reason: string | null;
  provenance: MetaDecisionProvenance;
}

export interface MetaDecisionLifecycleRoleOverlay {
  value: MetaDecisionLifecycleRole;
  confidence: "high" | "medium" | "low" | "unknown" | "conflict";
  trustedForAction: boolean;
  blockerCode: string | null;
  provenance: MetaDecisionProvenance;
}

export interface MetaDecisionAssessmentOverlay {
  value: MetaDecisionCreativeAssessment;
  blockerCode: string | null;
  provenance: MetaDecisionProvenance;
}

export interface MetaDecisionParentRef {
  id: string;
  name: string | null;
}

export interface MetaDecisionParentChain {
  account: MetaDecisionParentRef;
  campaign: MetaDecisionParentRef | null;
  adset: MetaDecisionParentRef | null;
  ad: MetaDecisionParentRef | null;
  creative: MetaDecisionParentRef | null;
  provenance: MetaDecisionProvenance;
}

export interface MetaDecisionMediaEnvelope {
  state: "available" | "missing" | "unavailable";
  missingMedia: boolean | null;
  thumbnail: {
    state: "available" | "missing" | "unavailable";
    url: string | null;
  };
  provenance: MetaDecisionProvenance;
}

export type MetaDecisionDeliveryScopeState =
  | "active"
  | "inactive"
  | "unknown";

export interface MetaDecisionDeliveryScope {
  state: MetaDecisionDeliveryScopeState;
  campaignStatus: string | null;
  adsetStatus: string | null;
  adStatus: string | null;
  reason:
    | "active_hierarchy"
    | "hierarchy_not_active"
    | "hierarchy_status_unknown";
  provenance: MetaDecisionProvenance;
}

/**
 * Provider-write authority requires explicit current delivery truth at every
 * native hierarchy level. Effective states such as WITH_ISSUES are visible
 * context, but they are not equivalent to ACTIVE.
 */
export function isExactActiveMetaDecisionDeliveryScope(
  scope: MetaDecisionDeliveryScope | null | undefined,
): boolean {
  const isActive = (status: string | null | undefined) =>
    status?.trim().toUpperCase() === "ACTIVE";
  return Boolean(
    scope?.state === "active" &&
      isActive(scope.campaignStatus) &&
      isActive(scope.adsetStatus) &&
      isActive(scope.adStatus),
  );
}

export interface MetaDecisionExposure {
  kind: "exposure_proxy";
  amount: number;
  currency: string;
  attribution: "meta_attributed";
  grain: "ad" | "creative";
  provenance: MetaDecisionProvenance;
}

export interface MetaDecisionHistoryEvent {
  id: string;
  eventType:
    | "decision_changed"
    | "operator_action"
    | "data_disabled"
    | "manual_override";
  eventDate: string;
  previousLabel: string | null;
  currentLabel: string | null;
  operatorActionType: string | null;
  notes: string | null;
  actor: null;
  actorAttributionStatus: "unavailable";
}

export interface MetaDecisionOutcome {
  id: string;
  outcomeWindowDays: 3 | 7 | 14;
  evaluationDate: string;
  realizedOutcome: "positive" | "negative" | "neutral" | "unknown";
  severity: "critical" | "high" | "medium" | "low";
  classifierVersion: string;
}

export interface MetaDecisionHistoryEnvelope {
  events: {
    status: "available" | "unavailable";
    reason: string | null;
    preCapCount: number;
    items: MetaDecisionHistoryEvent[];
  };
  outcomes: {
    status: "available" | "unavailable";
    reason: string | null;
    items: MetaDecisionOutcome[];
  };
  responses: {
    status: "available" | "unavailable";
    reason: string | null;
    items?: Array<{
      id: string;
      observationStatus:
        "observed_response" | "observed_no_response" | "unknown_incomplete";
      responseType: string;
      detectedAt: string | null;
      responseCutoff: string;
    }>;
  };
  providerWrites: {
    status: "available" | "unavailable";
    reason: string | null;
  };
}

export interface MetaDecisionSourceAuthority {
  status:
    | "native_exact"
    | "legacy_review_only"
    | "demo_synthetic_review_only";
  actionEligible: boolean;
  reviewOnlyReason: string | null;
  snapshotId: string;
  evaluationId: string | null;
  inputHash: string | null;
  decisionHash: string | null;
  providerAccountRefId: string | null;
  engineVersion: string;
  realAdId: string | null;
  authorizedAction: "scale" | "cut" | "refresh" | null;
  jobRunId: string | null;
}

export interface MetaCanonicalDecision {
  decisionId: string;
  episodeId: string;
  episodeStartedAt: string;
  providerAccountId: string;
  identityGrain: "ad" | "creative";
  sourceSnapshotId: string;
  sourceAuthority?: MetaDecisionSourceAuthority;
  sourceDecision: {
    label: string;
    /** Persisted mathematical/semantic verdict before the first authority gate.
     * Null means the historical snapshot predates this provenance contract. */
    preAuthorityLabel: string | null;
    /** First effective authority gate only. This is evidence and never grants
     * execution authority. */
    authorityBlocker: MetaDecisionAuthorityBlocker | null;
    rawLabel: string | null;
    reason: string;
    confidence: number;
    confidenceBand: "high" | "medium" | "low";
    truthSource: string;
    engineVersion: string;
    snapshotAsOf: string;
    computedAt: string;
    badges: string[];
    provenance: MetaDecisionProvenance;
  };
  parentChain: MetaDecisionParentChain;
  identityResolution?: {
    basis:
      | "native_ad_exact"
      | "single_ad_creative_equivalent"
      | "creative_ambiguous"
      | "unresolved";
    candidateAdCount: number;
    metricsEquivalent: boolean;
    adActionEligible: boolean;
  };
  media: MetaDecisionMediaEnvelope;
  /** Current provider delivery truth. Provider-write authority requires the
   * campaign, ad set, and ad to each be exactly ACTIVE. WITH_ISSUES,
   * closed, or unknown assets remain visible as advisory-only context. */
  deliveryScope?: MetaDecisionDeliveryScope;
  classification: {
    overlayVersion: typeof META_DECISIONS_CLASSIFICATION_OVERLAY_VERSION;
    queueSection: MetaDecisionQueueSectionKey;
    lifecycleRole: MetaDecisionLifecycleRoleOverlay;
    assessment: MetaDecisionAssessmentOverlay;
    decisionState: MetaDecisionState;
    heldAction: "scale" | "cut" | "refresh" | null;
    legacyBuyerAction: MetaDecisionBuyerAction;
    buyerAction: MetaDecisionServedBuyerAction | null;
    buyerLabel: string;
    executionAction: MetaDecisionExecutionAction | null;
    resolution: MetaDecisionResolution | null;
    /**
     * Gates. Every entry here withholds provider authority, and callers are
     * entitled to read `blockers.length > 0` as "do not offer an action".
     */
    blockers: MetaDecisionBlocker[];
    /**
     * Statements that inform without gating. Optional because a payload
     * serialized before this field existed carries none, and an absent
     * envelope must read as "nothing was served", never as a measured empty
     * list. Readers default it to `[]`.
     */
    advisories?: MetaDecisionAdvisory[];
    provenance: MetaDecisionProvenance;
  };
  riskTier: MetaDecisionRiskTier | null;
  confirmationCeremony: MetaDecisionConfirmationCeremony;
  riskTierProvenance: {
    status: "proposed";
    reason: "risk_tier_producer_not_persisted";
  };
  promotionBasis: {
    status: "proposed";
    value: null;
    reason: "promotion_basis_not_persisted";
  };
  metrics: {
    spend: number | null;
    purchases: number | null;
    roas: number | null;
    recent7dRoas: number | null;
    /**
     * 28-day CTR and frequency read back from the lifecycle row the engine
     * decided from. Optional because payloads serialized before the lineage
     * join must stay renderable; absent means unknown, never zero.
     */
    ctr?: number | null;
    frequency?: number | null;
    effectiveTargetRoas: number | null;
    ratioToTarget: number | null;
    currency: string | null;
    attribution: "meta_attributed";
    provenance: MetaDecisionProvenance;
  };
  /** `image` | `video` | `catalog` from the decided-from lifecycle row. */
  creativeFormat?: string | null;
  /** `none` | `watch` | `fatigued` | `unknown` from the same row. */
  fatigueStatus?: string | null;
  exposure: MetaDecisionExposure | null;
  exposureUnavailableReason:
    "spend_unavailable" | "currency_unavailable" | null;
  history: MetaDecisionHistoryEnvelope;
}

export interface MetaDecisionSuppressionReason {
  code: string;
  count: number;
}

export interface MetaDecisionSuppressionReceipt {
  receiptId: string;
  selectionVersion: typeof META_DECISIONS_SECTION_SELECTION_VERSION;
  topN: number;
  preCapCount: number;
  selectedCount: number;
  suppressedCount: number;
  reasons: MetaDecisionSuppressionReason[];
}

export interface MetaDecisionExposureDigest {
  basis: "pre_cap";
  byCurrency: Array<{
    currency: string;
    amount: number;
    decisionCount: number;
  }>;
  unavailableCount: number;
  crossCurrencyTotal: null;
}

export interface MetaDecisionQueueSection {
  key: MetaDecisionQueueSectionKey;
  label: string;
  topN: number;
  preCapCount: number;
  selectedCount: number;
  rankablePreCapCount: number;
  unrankablePreCapCount: number;
  items: MetaCanonicalDecision[];
  exposureDigest: MetaDecisionExposureDigest;
  suppressionReceipt: MetaDecisionSuppressionReceipt;
}

export interface MetaDecisionCapabilityState {
  status: "available" | "unavailable" | "proposed";
  reason: string | null;
}

export type MetaDecisionsReadModelUnavailableCode =
  | "provider_account_required"
  | "provider_account_scope_unverified"
  | "snapshot_unavailable"
  | "source_read_failed";

export interface MetaDecisionsWorkspaceReadModel {
  contractVersion: typeof META_DECISIONS_WORKSPACE_CONTRACT_VERSION;
  status: "available" | "unavailable";
  generatedAt: string;
  scope: {
    businessId: string;
    providerAccountId: string | null;
    decisionMode: "current";
    metricsRangeAffectsDecisionSnapshot: false;
  };
  unavailable: {
    code: MetaDecisionsReadModelUnavailableCode;
    message: string;
  } | null;
  source: {
    status: "available" | "unavailable";
    authority: "native_ad" | "legacy_creative" | "unavailable";
    table:
      | "engine_v3_ad_decision_snapshots_daily"
      | "engine_v3_decision_snapshots_daily";
    snapshotAsOf: string | null;
    computedAt: string | null;
    engineVersion: string | null;
    fallbackReason: string | null;
    generation: {
      jobRunId: string;
      providerAccountRefId: string;
      manifestHash: string;
      expectedAdCount: number;
    } | null;
  };
  queue: {
    deduplicationGrain: "ad" | "creative";
    sourcePreCapCount: number;
    queuedPreCapCount: number;
    sections: Record<MetaDecisionQueueSectionKey, MetaDecisionQueueSection>;
    /**
     * Exact provider-ad identities are selected independently from the compact
     * operator queue. A section top-N must never make a valid Ad disappear.
     * Optional preserves compatibility with previously serialized v1 payloads.
     */
    adCandidates?: {
      selectionVersion: typeof META_DECISIONS_AD_CANDIDATE_SELECTION_VERSION;
      limit: number;
      preCapCount: number;
      eligiblePreCapCount: number;
      selectedCount: number;
      stateCounts: Record<
        Exclude<MetaDecisionState, "not_applicable">,
        { preCapCount: number; selectedCount: number }
      >;
      omittedAmbiguousIdentity: number;
      omittedWithoutVerifiedAdId: number;
      omittedNotApplicable: number;
      items: MetaCanonicalDecision[];
    };
    /** Advisory-only rows withheld from the live decision queues because at
     * least one current campaign/ad-set/ad status is closed or unknown. */
    inactiveAssets?: {
      preCapCount: number;
      inactiveCount: number;
      unknownCount: number;
      items: MetaCanonicalDecision[];
    };
    omittedFromQueue: {
      count: number;
      reasons: MetaDecisionSuppressionReason[];
    };
  };
  capabilities: {
    providerAccountScope: MetaDecisionCapabilityState;
    stableDecisionIdentity: MetaDecisionCapabilityState;
    stableEpisodeIdentity: MetaDecisionCapabilityState;
    classificationOverlay: MetaDecisionCapabilityState;
    riskTierProducer: MetaDecisionCapabilityState;
    promotionBasisProducer: MetaDecisionCapabilityState;
    responseAttribution: MetaDecisionCapabilityState;
    providerWriteLinkage: MetaDecisionCapabilityState;
  };
}
