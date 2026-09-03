import type {
  MetaDecisionAuthorityBlocker,
  MetaDecisionConfirmationCeremony,
  MetaDecisionRiskTier,
} from "@/lib/meta/decisions-workspace-contract";

export const META_OS_DECISIONS_PRESENTATION_VERSION =
  "meta-os-decisions.presentation.v5" as const;

export type MetaOsWorkspaceBannerScope =
  | "workspace"
  | "target_hard_actions";

export interface MetaOsWorkspaceBanner {
  id: string;
  tone: "info" | "warning" | "danger" | "success";
  title: string;
  detail: string;
  blocking: boolean;
  /** Omitted by v1 payloads, where the banner applies to the full workspace. */
  scope?: MetaOsWorkspaceBannerScope;
  action?: {
    label: string;
    href: string;
  };
}

export type MetaOsDecisionLane = "act" | "blocked" | "monitor";
export type MetaOsDecisionLevel = "campaign" | "adset" | "ad";
export type MetaOsCommandIntent =
  "execute" | "launchpad" | "brief" | "manual" | "review" | "none";

/**
 * D081 — the ONE canonical budget-intent payload.
 *
 * It is defined here, in the served contract, and re-exported by
 * `lib/meta/budget-intent-contract` so a validated intent and the canonical
 * member cannot drift into two shapes. It is LOSSLESS: every binding D081
 * requires travels with it, so a consumer can inspect the authority, the
 * rounding provenance and the read-back contract without going back to the
 * producer.
 *
 * It is deliberately NOT dispatchable. `providerMutation` is `null` on the
 * budget branch, no budget verb is added to the live dispatch contract, and no
 * endpoint exists, because D080A established that an approvable action with no
 * endpoint could only ever fail.
 */
export interface MetaOsBudgetIntentPayload {
  kind: "budget_intent";
  /** `meta.budget-intent.v*`, from lib/meta/budget-intent-contract. */
  contractVersion: string;
  intentKey: string;
  idempotencyKey: string;
  /** The full composite scope, including parent campaign identity. */
  scope: {
    businessId: string;
    providerAccountId: string;
    entityGrain: "campaign" | "adset";
    entityId: string;
    parentCampaignId: string | null;
  };
  ownerMode: string;
  budgetField: "daily_budget" | "lifetime_budget";
  direction: "increase" | "decrease";
  percent: number;
  currency: string;
  currencyExponent: number;
  currencyRegistry: { version: string; source: string };
  currentMinorUnits: number;
  proposedMinorUnits: number;
  deltaMinorUnits: number;
  rounding: { applied: boolean; rule: string; exactUnrounded: string };
  /** Point-in-time clocks, so a reader can check the evidence was knowable. */
  originDate: string;
  effectiveAsOf: string;
  knowledgeAsOf: string;
  authorityEvidenceAsOf: string;
  sourceFingerprints: {
    configStateHash: string;
    ownerStateHash: string;
    roleAuthorityHash: string;
  };
  evidenceWindow: { from: string; to: string };
  targetSource: { source: string; version: string } | null;
  authorityStatus: "authorised" | "blocked" | "not_determinable";
  blockerCodes: string[];
  /** Always `validated_only` in this slice. */
  executionState: "validated_only";
  rollback: { priorMinorUnits: number; field: string; operation: string };
  readback: { field: string; expectedMinorUnits: number; independentRead: true };
  createdBy: { module: string; contractVersion: string };
}

/** Fields every action carries, whichever branch it is. */
interface MetaOsDecisionActionBase {
  code: string;
  label: string;
  intent: MetaOsCommandIntent;
  targetLevel: MetaOsDecisionLevel;
  providerMutation: "pause" | "resume" | "apply_bid" | null;
  scopeNote: string;
}

/**
 * The legacy branch: every creative and ad action. It carries no budget
 * payload, and `budgetIntent?: never` makes that a compile-time fact rather
 * than a convention, while leaving the serialized shape byte-identical.
 */
export interface MetaOsLegacyDecisionAction extends MetaOsDecisionActionBase {
  budgetIntent?: never;
}

/**
 * The budget branch. The combination is constrained by the TYPE, not by the
 * preferred producer's habits: a budget payload paired with `execute` or with
 * a provider mutation does not type-check, and `assertCanonicalDecisionAction`
 * refuses it at runtime for callers that reach the contract through JSON.
 */
export interface MetaOsBudgetDecisionAction extends MetaOsDecisionActionBase {
  intent: "review";
  providerMutation: null;
  targetLevel: "campaign" | "adset";
  budgetIntent: MetaOsBudgetIntentPayload;
}

export type MetaOsDecisionAction =
  | MetaOsLegacyDecisionAction
  | MetaOsBudgetDecisionAction;

/**
 * Runtime guard for the same rule, because a value deserialized from JSON has
 * no compile-time branch. Returns the action, or throws naming the violation.
 */
export function assertCanonicalDecisionAction(action: MetaOsDecisionAction): MetaOsDecisionAction {
  const budget = (action as MetaOsBudgetDecisionAction).budgetIntent;
  if (budget === undefined) return action;
  const refuse = (why: string): never => {
    throw new Error(`D081 refuses this canonical decision action: ${why}`);
  };
  if (budget.kind !== "budget_intent") refuse(`budget payload discriminator is ${JSON.stringify(budget.kind)}`);
  if (action.intent !== "review") refuse(`a budget action must be served for review, not ${JSON.stringify(action.intent)}`);
  if (action.providerMutation !== null) refuse(`a budget action must carry no provider mutation, found ${JSON.stringify(action.providerMutation)}`);
  if (action.targetLevel !== "campaign" && action.targetLevel !== "adset") {
    refuse(`a budget lives at campaign or adset grain, not ${JSON.stringify(action.targetLevel)}`);
  }
  if (budget.executionState !== "validated_only") refuse(`execution state ${JSON.stringify(budget.executionState)} is beyond this slice`);
  if (budget.scope.entityGrain !== action.targetLevel) {
    refuse(`the payload grain ${JSON.stringify(budget.scope.entityGrain)} disagrees with targetLevel ${JSON.stringify(action.targetLevel)}`);
  }
  if (budget.scope.entityGrain === "adset" && budget.scope.parentCampaignId === null) {
    refuse("an ad-set budget intent must name its parent campaign");
  }
  return action;
}

export interface MetaOsDecisionPriority {
  band: "high" | "medium" | "low" | "unrankable";
  rank: number | null;
  version: typeof META_OS_DECISIONS_PRESENTATION_VERSION;
}

export interface MetaOsDecisionUrgency {
  level: "critical" | "high" | "medium" | "none";
  rank: number;
  label: string;
  reason: string | null;
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
  grain: "campaign_or_adset" | "ad" | "creative_context";
}

export interface MetaOsDecisionAuthorityProvenance {
  availability: "available" | "historical_unavailable";
  /** Mathematical/semantic verdict before the first authority gate. */
  preAuthorityLabel: string | null;
  /** Decision after authority gates and before publication hysteresis. */
  postAuthorityRawLabel: string | null;
  /** Final label served to the operator. */
  publishedLabel: string;
  firstBlocker: {
    code: MetaDecisionAuthorityBlocker;
    label: string;
    explanation: string;
  } | null;
}

export interface MetaOsStructureBidConfiguration {
  strategyType: string | null;
  strategyLabel: string | null;
  currentValue: number | null;
  currentValueFormat: "currency" | "roas" | null;
  previousValue: number | null;
  previousValueFormat: "currency" | "roas" | null;
  previousValueCapturedAt: string | null;
  dailyBudget: number | null;
  lifetimeBudget: number | null;
  budgetUtilization: number | null;
}

/**
 * D074/D076: the resolver's own account of a campaign's automatically inferred
 * role, served verbatim so a surface can EXPLAIN the role without computing
 * one.
 *
 * `kind` is the kind the daily resolver actually published and stays null when
 * it published none — deliberately distinct from a node's `lifecycleRole`,
 * which may carry a presentation-only provisional display value. When `kind`
 * is null, `unresolvedReason` says why in the server's own vocabulary; when a
 * kind is published, `unresolvedReason` is null.
 */
export interface MetaOsCampaignRoleExplanation {
  kind: "main" | "test" | "mixed" | null;
  confidenceClass: "high" | "medium" | "low" | "unknown" | "conflict";
  /** The resolver's own confidence number; null when it persisted none. */
  confidenceScore: number | null;
  /** The resolver's persisted evidence strings, verbatim. */
  evidence: string[];
  /** The resolver's persisted conflict reasons, verbatim. */
  conflictReasons: string[];
  unresolvedReason:
    | "insufficient_evidence"
    | "conflicting_signals"
    | "not_yet_evaluated"
    | null;
  /** When the resolver last evaluated this campaign; null when it never has. */
  lastEvaluatedAt: string | null;
  resolverVersion: string | null;
}

export interface MetaOsStructureNode {
  id: string;
  sourceRecommendationId: string | null;
  level: "campaign" | "adset";
  providerEntityId: string | null;
  campaignId: string | null;
  campaignName: string | null;
  name: string;
  lifecycleRole:
    | "test"
    | "main"
    | "mixed"
    | "role_unresolved"
    /** @deprecated Historical snapshots only; new runtime output uses role_unresolved. */
    | "label_needed"
    | "unknown";
  campaignRoleSource?: MetaOsAdDecision["campaignRoleSource"];
  campaignRoleConfidence?: MetaOsAdDecision["campaignRoleConfidence"];
  campaignRoleTrustedForAction?: boolean;
  /** Optional only so previously serialized payloads remain renderable; the
   * current builder always emits it. */
  campaignRoleExplanation?: MetaOsCampaignRoleExplanation;
  budgetOwner: "campaign" | "adset" | "mixed" | "unknown";
  budgetMode: "campaign_budget" | "adset_budget" | "mixed" | "unknown";
  controlOwner: "campaign" | "adset" | "mixed" | "unknown";
  status: string | null;
  optimizationGoal: string | null;
  bidConfiguration?: MetaOsStructureBidConfiguration;
  action: MetaOsDecisionAction;
  lane: MetaOsDecisionLane;
  priority: MetaOsDecisionPriority;
  urgency: MetaOsDecisionUrgency;
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
  highestUrgency: MetaOsDecisionUrgency;
  urgentAdsetCount: number;
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
  creativeId: string | null;
  creativeName: string | null;
  thumbnailUrl: string | null;
  lifecycleRole:
    | "test"
    | "main"
    | "mixed"
    | "role_unresolved"
    /** @deprecated Historical snapshots only; new runtime output uses role_unresolved. */
    | "label_needed"
    | "unknown";
  campaignRoleSource: "automatic" | "user_override" | "unknown";
  campaignRoleConfidence: "high" | "medium" | "low" | "unknown" | "conflict";
  campaignRoleTrustedForAction: boolean;
  /** Optional only so previously serialized payloads remain renderable; the
   * current builder always emits it. */
  campaignRoleExplanation?: MetaOsCampaignRoleExplanation;
  action: MetaOsDecisionAction;
  lane: MetaOsDecisionLane;
  priority: MetaOsDecisionPriority;
  assessment: string;
  confidence: "high" | "medium" | "low";
  /**
   * The engine's own confidence number for this decision, or null when NO
   * confidence was computed for it.
   *
   * Nullable because a synthesised placeholder row is not a measurement. The
   * `await_ad_grain_evidence` row this presentation emits for a live Ad with no
   * Ad-grain snapshot has no engine behind it at all; it used to carry a
   * hardcoded 0, and the evidence window rendered that constant as
   * "low · score 0.00" — a fabricated number printed as a measured one, under a
   * render whose own rule is that a MEASURED zero stays zero. A row with no
   * computed confidence now serves null and renders an em dash.
   *
   * A served 0 is therefore a real engine score of zero and must still print as
   * 0.00. Never coalesce this field to 0 on read.
   */
  confidenceScore: number | null;
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
  /** `image` | `video` | `catalog` from the decided-from lifecycle row. */
  creativeFormat?: string | null;
  /** `none` | `watch` | `fatigued` | `unknown` from the same row. */
  fatigueStatus?: string | null;
  rawLabel: string | null;
  publishedLabel: string;
  /** Optional only so previously serialized v2 payloads remain renderable. The
   * current v3 builder always emits this evidence envelope. */
  authorityProvenance?: MetaOsDecisionAuthorityProvenance;
  engineVersion: string;
  snapshotAsOf: string;
  sourceGrain: "ad" | "creative_context";
  decisionAvailability: "available" | "pending_native_evidence";
}

export interface MetaOsInactiveAsset {
  id: string;
  level: MetaOsDecisionLevel | "creative";
  providerEntityId: string;
  name: string;
  campaignName: string | null;
  adsetName: string | null;
  status: string;
  deliveryState: "inactive" | "unknown";
  advisoryLabel: string;
  advisoryReason: string;
  confidence: "high" | "medium" | "low";
  metrics: MetaOsDecisionMetrics;
  source: "structure_archive" | "canonical_decision_snapshot";
  providerWriteAuthority: "none";
}

export interface MetaOsDecisionsPresentation {
  contractVersion: typeof META_OS_DECISIONS_PRESENTATION_VERSION;
  generatedAt: string;
  source: {
    snapshotAsOf: string | null;
    engineVersion: string | null;
    structureSource: "meta_recommendations";
    adsSource: "native_ad_decision" | "legacy_creative_review_only";
    /** Always emitted by the current builder; optional only while persisted v2
     * payloads without source health remain readable. */
    health?: "healthy" | "degraded";
    fallbackReason?: string | null;
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
  inactive?: {
    items: MetaOsInactiveAsset[];
    count: number;
    inactiveCount: number;
    unknownCount: number;
  };
  /**
   * D081 — canonical review-only budget actions, present ONLY when the caller
   * supplied validated budget intents.
   *
   * Optional so a presentation built without any intent serializes exactly as
   * it did before this field existed. Each entry is a `MetaOsBudgetDecisionAction`,
   * so it carries the whole lossless operation, is served for `review`, and has
   * `providerMutation: null`. Nothing here is dispatchable.
   */
  budgetReview?: {
    actions: MetaOsBudgetDecisionAction[];
    count: number;
  };
  limitations: Array<{
    code: string;
    message: string;
  }>;
}
