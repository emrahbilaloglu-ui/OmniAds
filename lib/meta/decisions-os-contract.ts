import type {
  MetaDecisionConfirmationCeremony,
  MetaDecisionRiskTier,
} from "@/lib/meta/decisions-workspace-contract";

export const META_OS_DECISIONS_PRESENTATION_VERSION =
  "meta-os-decisions.presentation.v2" as const;

export type MetaOsDecisionLane = "act" | "blocked" | "monitor";
export type MetaOsDecisionLevel = "campaign" | "adset" | "ad";
export type MetaOsCommandIntent =
  | "execute"
  | "launchpad"
  | "brief"
  | "manual"
  | "review"
  | "none";

export interface MetaOsDecisionAction {
  code: string;
  label: string;
  intent: MetaOsCommandIntent;
  targetLevel: MetaOsDecisionLevel;
  providerMutation: "pause" | "resume" | "apply_bid" | null;
  scopeNote: string;
}

export interface MetaOsDecisionPriority {
  band: "high" | "medium" | "low" | "unrankable";
  rank: number | null;
  version: typeof META_OS_DECISIONS_PRESENTATION_VERSION;
}

export interface MetaOsDecisionMetrics {
  spend: number | null;
  purchases: number | null;
  roas: number | null;
  cpa: number | null;
  ctr: number | null;
  frequency: number | null;
  effectiveTargetRoas: number | null;
  ratioToTarget: number | null;
  currency: string | null;
  attribution: "meta_attributed";
  grain: "campaign_or_adset" | "creative_context";
}

export interface MetaOsStructureNode {
  id: string;
  sourceRecommendationId: string | null;
  level: "campaign" | "adset";
  providerEntityId: string | null;
  campaignId: string | null;
  campaignName: string | null;
  name: string;
  lifecycleRole: "test" | "main" | "mixed" | "label_needed" | "unknown";
  budgetOwner: "campaign" | "adset" | "mixed" | "unknown";
  budgetMode: "campaign_budget" | "adset_budget" | "mixed" | "unknown";
  controlOwner: "campaign" | "adset" | "mixed" | "unknown";
  status: string | null;
  optimizationGoal: string | null;
  action: MetaOsDecisionAction;
  lane: MetaOsDecisionLane;
  priority: MetaOsDecisionPriority;
  confidence: "high" | "medium" | "low" | "unknown";
  assessment: string;
  whyNow: string;
  expectedImpact: string;
  evidence: Array<{
    label: string;
    value: string;
    tone: "positive" | "warning" | "neutral";
  }>;
  metrics: MetaOsDecisionMetrics;
  suppressedAlternativeCount: number;
}

export interface MetaOsStructureGroup {
  id: string;
  campaign: MetaOsStructureNode;
  adsets: MetaOsStructureNode[];
  highestPriority: MetaOsDecisionPriority;
}

export interface MetaOsAdDecision {
  id: string;
  decisionId: string;
  sourceSnapshotId: string;
  episodeId: string;
  providerAccountId: string;
  adId: string;
  adName: string;
  campaignId: string | null;
  campaignName: string | null;
  adsetId: string | null;
  adsetName: string | null;
  creativeId: string;
  creativeName: string | null;
  thumbnailUrl: string | null;
  lifecycleRole: "test" | "main" | "mixed" | "label_needed";
  action: MetaOsDecisionAction;
  lane: MetaOsDecisionLane;
  priority: MetaOsDecisionPriority;
  assessment: string;
  confidence: "high" | "medium" | "low";
  confidenceScore: number;
  riskTier: MetaDecisionRiskTier | null;
  confirmationCeremony: MetaDecisionConfirmationCeremony;
  whyNow: string;
  blockers: Array<{ code: string; label: string }>;
  resolution: {
    code: string;
    category: string;
    owner: "system" | "operator" | "integration";
    label: string;
    nextStep: string;
  } | null;
  metrics: MetaOsDecisionMetrics;
  rawLabel: string | null;
  publishedLabel: string;
  engineVersion: string;
  snapshotAsOf: string;
  sourceGrain: "creative_context";
}

export interface MetaOsDecisionsPresentation {
  contractVersion: typeof META_OS_DECISIONS_PRESENTATION_VERSION;
  generatedAt: string;
  source: {
    snapshotAsOf: string | null;
    engineVersion: string | null;
    structureSource: "meta_recommendations";
    adsSource: "creative_decision_with_verified_ad_identity";
  };
  structure: {
    groups: MetaOsStructureGroup[];
    actCount: number;
    blockedCount: number;
    monitorCount: number;
    suppressedAlternativeCount: number;
  };
  ads: {
    items: MetaOsAdDecision[];
    actCount: number;
    blockedCount: number;
    monitorCount: number;
    statePreCapCounts: Record<MetaOsDecisionLane, number>;
    eligiblePreCapCount: number;
    omittedWithoutVerifiedAdId: number;
    omittedAmbiguousIdentity: number;
    omittedNotApplicable: number;
    sourcePreCapCount: number;
  };
  limitations: Array<{
    code: string;
    message: string;
  }>;
}
