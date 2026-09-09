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

/**
 * The bid branch's payload.
 *
 * Deliberately the budget payload's twin: same scope shape, same currency
 * triple, same before/after/delta in minor units, same clocks, same rounding
 * record, same rollback and read-back. A bid cap is a different control from a
 * budget, but the questions a reader has to be able to answer about a proposed
 * money change are the same ones — what it was, what it will be, in which
 * currency, on what evidence, as of when, and how to undo it.
 *
 * The one field with no budget counterpart is `bidStrategyType`. A cap only
 * exists on a cap strategy, and the strategy at write time is what decides
 * whether the write is legal at all — so the intent records the strategy it
 * was reasoned about, and the read-back asserts it did not change underneath.
 */
export interface MetaOsBidIntentPayload {
  kind: "bid_intent";
  /** `meta.bid-intent.v*`. */
  contractVersion: string;
  intentKey: string;
  idempotencyKey: string;
  scope: {
    businessId: string;
    providerAccountId: string;
    /** A bid amount lives on an ad set. There is no campaign-grain bid write. */
    entityGrain: "adset";
    entityId: string;
    parentCampaignId: string | null;
  };
  /** The strategy this intent was reasoned about, re-proved before the write. */
  bidStrategyType: string;
  direction: "increase" | "decrease";
  percent: number;
  currency: string;
  currencyExponent: number;
  currencyRegistry: { version: string; source: string };
  currentMinorUnits: number;
  proposedMinorUnits: number;
  deltaMinorUnits: number;
  rounding: { applied: boolean; rule: string; exactUnrounded: string };
  originDate: string;
  effectiveAsOf: string;
  knowledgeAsOf: string;
  evidenceWindow: { from: string; to: string };
  authorityStatus: "authorised" | "blocked" | "not_determinable";
  blockerCodes: string[];
  executionState: "validated_only";
  rollback: { priorMinorUnits: number; field: "bid_amount"; operation: "set" };
  /**
   * What a verified write must show.
   *
   * `bid_strategy_unchanged` is not decoration: writing a cap onto an ad set
   * whose strategy changed since the decision would be setting a number that
   * now means something else.
   */
  readback: {
    field: "bid_amount";
    expectedMinorUnits: number;
    independentRead: true;
    alsoAsserts: readonly ["bid_strategy_unchanged"];
  };
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
  bidIntent?: never;
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
  bidIntent?: never;
}

/**
 * The bid branch, constrained the same way the budget branch is.
 *
 * `intent: "review"` and `providerMutation: null` because a decision is a
 * proposal: execution happens through the queue, under an authority the
 * decision itself does not carry.
 */
export interface MetaOsBidDecisionAction extends MetaOsDecisionActionBase {
  intent: "review";
  providerMutation: null;
  targetLevel: "adset";
  bidIntent: MetaOsBidIntentPayload;
  /** Never both: see `assertCanonicalDecisionAction`. */
  budgetIntent?: never;
}

export type MetaOsDecisionAction =
  | MetaOsLegacyDecisionAction
  | MetaOsBudgetDecisionAction
  | MetaOsBidDecisionAction;

/**
 * Runtime guard for the same rule, because a value deserialized from JSON has
 * no compile-time branch. Returns the action, or throws naming the violation.
 */
export function assertCanonicalDecisionAction(action: MetaOsDecisionAction): MetaOsDecisionAction {
  const budget = (action as MetaOsBudgetDecisionAction).budgetIntent;
  const bid = (action as MetaOsBidDecisionAction).bidIntent;
  const refuse = (why: string): never => {
    throw new Error(`D081 refuses this canonical decision action: ${why}`);
  };
  /*
    One action, one typed payload.

    Two would make "what is being proposed here" a question with two answers,
    and the queue projects a row per payload — so a double-payload action would
    become two proposals for one decision.
  */
  if (budget !== undefined && bid !== undefined) {
    refuse("an action carries both a budget and a bid payload");
  }
  if (bid !== undefined) {
    if (bid.kind !== "bid_intent") {
      refuse(`bid payload discriminator is ${JSON.stringify(bid.kind)}`);
    }
    if (action.intent !== "review") {
      refuse(`a bid action must be served for review, not ${JSON.stringify(action.intent)}`);
    }
    if (action.providerMutation !== null) {
      refuse(`a bid action must carry no provider mutation, found ${JSON.stringify(action.providerMutation)}`);
    }
    // There is no campaign-grain bid write, so a campaign-grain bid intent
    // describes an endpoint that does not exist.
    if (action.targetLevel !== "adset") {
      refuse(`a bid amount lives on an ad set, not ${JSON.stringify(action.targetLevel)}`);
    }
    if (bid.scope.entityGrain !== "adset") {
      refuse(`the payload grain ${JSON.stringify(bid.scope.entityGrain)} is not an ad set`);
    }
    if (bid.executionState !== "validated_only") {
      refuse(`execution state ${JSON.stringify(bid.executionState)} is beyond this slice`);
    }
    if (!bid.readback.alsoAsserts.includes("bid_strategy_unchanged")) {
      refuse("a bid read-back must also assert the strategy did not change");
    }
    return action;
  }
  if (budget === undefined) return action;
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

/**
 * The versioned resolution a server produced for one decision.
 *
 * Extracted from the inline shape `MetaOsAdDecision.resolution` already
 * carried, byte-for-byte, so it can be NAMED by the held-verdict field below.
 * `category` stays widened to `string` — as the inline shape had it — because
 * a payload serialized under an earlier category vocabulary must keep parsing.
 */
export interface MetaOsDecisionResolution {
  code: string;
  category: string;
  owner: "system" | "operator" | "integration";
  label: string;
  nextStep: string;
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
   * Nullable because a decision can reach this contract without one, and a
   * render whose own rule is that a MEASURED zero stays zero must not be handed
   * a fabricated zero. The case that made this nullable was the
   * `await_ad_grain_evidence` placeholder the presentation used to emit for a
   * live Ad with no Ad-grain snapshot: no engine behind it, a hardcoded 0, and
   * an evidence window printing "low · score 0.00" as if it had been measured.
   * That placeholder is no longer produced at all — un-decided ACTIVE inventory
   * is served as `ads.pendingInventoryCount` and one limitation sentence — but
   * the field stays nullable, because payloads serialized before that change
   * still carry such rows and must keep rendering an em dash rather than a
   * zero.
   *
   * A served 0 is therefore a real engine score of zero and must still print as
   * 0.00. Never coalesce this field to 0 on read.
   */
  confidenceScore: number | null;
  riskTier: MetaDecisionRiskTier | null;
  confirmationCeremony: MetaDecisionConfirmationCeremony;
  whyNow: string;
  blockers: Array<{ code: string; label: string }>;
  resolution: MetaOsDecisionResolution | null;
  /**
   * The mathematical verdict the engine reached and then WITHHELD, typed.
   * Null when no hard verdict was held. Evidence, never authorization: a
   * non-null value always accompanies an unauthorized published label and
   * every execution field stays null.
   */
  heldAction?: "scale" | "cut" | "refresh" | null;
  /** The specific resolution for the HELD verdict, not the published one. */
  heldResolution?: MetaOsDecisionResolution | null;
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
  /**
   * `pending_native_evidence` is a COMPATIBILITY value, not a live one.
   *
   * The current producer never emits it: un-decided ACTIVE inventory is served
   * as `ads.pendingInventoryCount` plus the
   * `active_ad_inventory_pending_native_decision` limitation, and no synthetic
   * decision is built. The member remains so that payloads serialized before
   * that separation stay readable, and so the reader's own copy for those rows
   * keeps working.
   */
  decisionAvailability: "available" | "pending_native_evidence";
}

/**
 * A decision that definitely carries a held verdict.
 *
 * `heldAction` and `heldResolution` are OPTIONAL on `MetaOsAdDecision` so that
 * payloads serialized before D091 stay readable. A consumer that is
 * specifically about the held case — a fixture that must supply one, a renderer
 * branch that has already narrowed — wants them REQUIRED, and writing
 * `NonNullable<...>` at each such site invites one of them to drift. This names
 * the narrowing once.
 *
 * Intersect it with `MetaOsAdDecision`; it is not a standalone decision shape.
 */
export interface MetaOsAdDecisionHeldVerdict {
  heldAction: "scale" | "cut" | "refresh";
  heldResolution: MetaOsDecisionResolution | null;
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
    /**
     * How many SERVED rows carry each held verdict, counted SEPARATELY from
     * the three lane counts above.
     *
     * A held row is already counted once as `blockedCount`, because that is
     * the lane it is served in. These are a second, orthogonal tally of WHICH
     * mathematical verdict was withheld, so a surface can say "3 Refresh
     * verdicts held" without re-deriving it from the rows — and so a held
     * Refresh stops being invisible behind the published `keep` label.
     * Adding these to any lane count would double-count the same decisions.
     *
     * Optional only so payloads serialized before this field stay readable: an
     * absent key means the counts were not measured, which is not the same as
     * three zeroes. The current builder always emits it.
     */
    heldCounts?: { scale: number; cut: number; refresh: number };
    statePreCapCounts: Record<MetaOsDecisionLane, number>;
    eligiblePreCapCount: number;
    /**
     * ACTIVE provider inventory that carries no exact Ad-grain decision.
     *
     * These are NOT decisions and are excluded from `items` and from every
     * count above; they are summarised here and in the
     * `active_ad_inventory_pending_native_decision` limitation. Optional only
     * so payloads serialized before the separation stay readable — a reader
     * that finds the key absent knows the count was not measured, which is not
     * the same as zero.
     */
    pendingInventoryCount?: number;
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
