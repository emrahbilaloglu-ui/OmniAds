export const META_DECISIONS_WORKSPACE_CONTRACT_VERSION =
  "meta-decisions-workspace.read.v1" as const;

export const META_DECISIONS_CLASSIFICATION_OVERLAY_VERSION =
  "meta-decisions-classification-overlay.v2" as const;

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

export type MetaDecisionState =
  | "act"
  | "monitor"
  | "blocked"
  | "not_applicable";

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
  creative: MetaDecisionParentRef;
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

export interface MetaDecisionExposure {
  kind: "exposure_proxy";
  amount: number;
  currency: string;
  attribution: "meta_attributed";
  grain: "creative";
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
  outcomeWindowDays: 7 | 14;
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
    status: "unavailable";
    reason: "legacy_response_journal_not_keyed_by_decision_episode";
  };
  providerWrites: {
    status: "unavailable";
    reason: "provider_write_journal_not_keyed_by_decision_episode";
  };
}

export interface MetaCanonicalDecision {
  decisionId: string;
  episodeId: string;
  episodeStartedAt: string;
  providerAccountId: string;
  identityGrain: "creative";
  sourceSnapshotId: string;
  sourceDecision: {
    label: string;
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
      | "single_ad_creative_equivalent"
      | "creative_ambiguous"
      | "unresolved";
    candidateAdCount: number;
    metricsEquivalent: boolean;
    adActionEligible: boolean;
  };
  media: MetaDecisionMediaEnvelope;
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
    blockers: MetaDecisionBlocker[];
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
    effectiveTargetRoas: number | null;
    ratioToTarget: number | null;
    currency: string | null;
    attribution: "meta_attributed";
    provenance: MetaDecisionProvenance;
  };
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
    table: "engine_v3_decision_snapshots_daily";
    snapshotAsOf: string | null;
    computedAt: string | null;
    engineVersion: string | null;
  };
  queue: {
    deduplicationGrain: "creative";
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
