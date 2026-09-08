import {
  META_DECISIONS_AD_CANDIDATE_LANE_RESERVE,
  type MetaCanonicalDecision,
  type MetaDecisionAuthorityBlocker,
  type MetaDecisionsWorkspaceReadModel,
} from "@/lib/meta/decisions-workspace-contract";
import {
  resolveProvisionalCampaignKind,
  type MetaCurrentAdStatusSourceRow,
  type MetaDecisionCampaignContextSourceRow,
} from "@/lib/meta/decisions-workspace-read-model";
import type { MetaRecommendation } from "@/lib/meta/recommendations";
import { buildMetaWatchingSegments } from "@/lib/meta/watching-segments";
import type {
  MetaLanePayload,
  MetaStructureInventoryEntity,
} from "@/components/meta/redesign/types";
import type { MetaDecisionPipelineHealth } from "@/lib/meta/decision-pipeline-health";
import { isCampaignContextResolverAuthorityValidated } from "@/lib/creative-decision-engine/campaign-context/source";
import {
  toCanonicalDecisionAction,
  type ValidatedBudgetIntent,
} from "@/lib/meta/budget-intent-contract";
import {
  META_OS_DECISIONS_PRESENTATION_VERSION,
  type MetaOsAdDecision,
  type MetaOsCampaignRoleExplanation,
  assertCanonicalDecisionAction,
  type MetaOsBudgetDecisionAction,
  type MetaOsCommandIntent,
  type MetaOsLegacyDecisionAction,
  type MetaOsDecisionAuthorityProvenance,
  type MetaOsDecisionAction,
  type MetaOsDecisionLane,
  type MetaOsDecisionPriority,
  type MetaOsDecisionUrgency,
  type MetaOsDecisionsPresentation,
  type MetaOsInactiveAsset,
  type MetaOsStructureGroup,
  type MetaOsStructureNode,
} from "@/lib/meta/decisions-os-contract";

const META_DECISION_CANONICAL_AD_UNIVERSE = Symbol.for(
  "adsecute.meta.decisions.canonical-ad-universe",
);

type ReadModelWithCanonicalAdUniverse = MetaDecisionsWorkspaceReadModel & {
  [META_DECISION_CANONICAL_AD_UNIVERSE]?: ReadonlySet<string>;
};

function readCanonicalAdUniverseIds(
  readModel: MetaDecisionsWorkspaceReadModel,
): ReadonlySet<string> | null {
  return (
    (readModel as ReadModelWithCanonicalAdUniverse)[
      META_DECISION_CANONICAL_AD_UNIVERSE
    ] ?? null
  );
}

const AUTHORITY_BLOCKER_PRESENTATION: Record<
  MetaDecisionAuthorityBlocker,
  { label: string; explanation: string }
> = {
  profile_hard_action_ineligible: {
    label: "Profile is not eligible for a hard action",
    explanation:
      "The account profile did not meet the evidence requirements for a hard provider action.",
  },
  source_freshness: {
    label: "Source evidence is not fresh enough",
    explanation:
      "The mathematical verdict was held until the required source evidence is fresh.",
  },
  campaign_context: {
    label: "Campaign context withheld authority",
    explanation:
      "Campaign role evidence did not support publishing the hard verdict as an actionable decision.",
  },
  native_metrics_unavailable: {
    label: "Native Ad metrics are unavailable",
    explanation:
      "Exact Ad-grain metrics were unavailable, so the hard verdict cannot authorize a provider action.",
  },
  native_profile_unavailable: {
    label: "Native decision profile is unavailable",
    explanation:
      "The native Ad profile required to authorize the verdict was unavailable.",
  },
  recent_recovery_unverifiable: {
    label: "Recent economic recovery cannot be ruled out",
    explanation:
      "The Cut verdict is held until a sufficiently sampled recent window confirms ROAS remains below break-even.",
  },
};

function authorityProvenanceForDecision(
  decision: MetaCanonicalDecision,
): MetaOsDecisionAuthorityProvenance {
  const blocker = decision.sourceDecision.authorityBlocker;
  return {
    availability:
      decision.sourceDecision.preAuthorityLabel === null
        ? "historical_unavailable"
        : "available",
    preAuthorityLabel: decision.sourceDecision.preAuthorityLabel,
    postAuthorityRawLabel: decision.sourceDecision.rawLabel,
    publishedLabel: decision.sourceDecision.label,
    firstBlocker: blocker
      ? {
          code: blocker,
          ...AUTHORITY_BLOCKER_PRESENTATION[blocker],
        }
      : null,
  };
}

type InactiveStructureInput = {
  id: string;
  level: "campaign" | "adset";
  name: string;
  campaignName?: string | null;
  status: string;
  statusLabel: string;
  spend: number;
  roas: number;
  cpa: number | null;
  purchases: number;
  diagnosticNote: string | null;
  advisory?: {
    decisionLabel: string | null;
    primaryActionLabel: string;
    why: string;
    confidence: "high" | "medium" | "low";
  } | null;
};

type StructureInput = {
  rec: MetaRecommendation;
  lane: MetaOsDecisionLane;
  targetAuthorityBlocker: MetaTargetHardAction | null;
};

export type MetaTargetHardAction = "scale" | "cut";

export type MetaTargetHardActionEligibility = Readonly<
  Record<MetaTargetHardAction, boolean>
>;

const PRIORITY_WEIGHT = { high: 3, medium: 2, low: 1 } as const;
const CONFIDENCE_WEIGHT = { high: 3, medium: 2, low: 1 } as const;
const URGENCY_WEIGHT: Record<MetaOsDecisionUrgency["level"], number> = {
  critical: 4,
  high: 3,
  medium: 2,
  none: 0,
};

function finite(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function metaStructureTargetHardAction(
  rec: MetaRecommendation,
): MetaTargetHardAction | null {
  if (rec.decisionLabel === "scale") return "scale";
  if (
    rec.decisionLabel === "cut" ||
    rec.decisionLabel === "below_breakeven" ||
    rec.actionKind === "execute_pause"
  ) {
    return "cut";
  }
  // A malformed legacy bid row without a decision label must still fail closed.
  if (rec.actionKind === "execute_bid") return "scale";
  return null;
}

function targetAuthorityBlocker(
  rec: MetaRecommendation,
  eligibility: MetaTargetHardActionEligibility,
) {
  const action = metaStructureTargetHardAction(rec);
  return action && !eligibility[action] ? action : null;
}

function guardStructureRecommendationForCurrentTargets(
  rec: MetaRecommendation,
  eligibility: MetaTargetHardActionEligibility,
) {
  const blocker = targetAuthorityBlocker(rec, eligibility);
  if (!blocker) return { rec, blocked: false as const };
  const blockerLabel =
    blocker === "scale"
      ? "Current target ROAS authority"
      : "Current break-even ROAS authority";
  const automationReadiness = rec.automationReadiness
    ? {
        ...rec.automationReadiness,
        tier: "manual_review" as const,
        autoExecuteEligible: false,
        operatorReviewRequired: true,
        blockers: Array.from(
          new Set([
            ...rec.automationReadiness.blockers,
            "missing_commercial_anchor" as const,
          ]),
        ),
        missingEvidence: Array.from(
          new Set([
            ...rec.automationReadiness.missingEvidence,
            blocker === "scale"
              ? "current_target_roas_authority"
              : "current_break_even_roas_authority",
          ]),
        ),
        reason: `${blockerLabel} is unavailable, so the persisted hard action is review-only.`,
      }
    : undefined;

  return {
    blocked: true as const,
    rec: {
      ...rec,
      decisionState: "watch" as const,
      stateReason: "current_commercial_target_authority_unavailable",
      actionKind: "review_drill" as const,
      primaryActionLabel: "Review Commercial Truth",
      recommendedAction: "Review Commercial Truth",
      expectedImpact:
        "No provider change until current commercial truth is authoritative.",
      proposedAction: undefined,
      targetValue: undefined,
      watchSegment: "missing_target" as const,
      rowPresentation: {
        ...rec.rowPresentation,
        signal: "blocker" as const,
        blockerLabel,
        autoBadge: false,
      },
      ...(automationReadiness ? { automationReadiness } : {}),
    },
  };
}

export function revalidateMetaStructureLanesForCurrentTargets(
  lanes: MetaLanePayload,
  eligibility: MetaTargetHardActionEligibility,
): MetaLanePayload {
  const actionNow: MetaRecommendation[] = [];
  const movedToWatching: MetaRecommendation[] = [];
  for (const rec of lanes.actionNow) {
    const guarded = guardStructureRecommendationForCurrentTargets(
      rec,
      eligibility,
    );
    if (guarded.blocked) movedToWatching.push(guarded.rec);
    else actionNow.push(guarded.rec);
  }
  const watching = [
    ...lanes.watching.map(
      (rec) => guardStructureRecommendationForCurrentTargets(rec, eligibility).rec,
    ),
    ...movedToWatching,
  ];
  const nonSales = lanes.nonSales.map(
    (rec) => guardStructureRecommendationForCurrentTargets(rec, eligibility).rec,
  );
  return {
    ...lanes,
    actionNow,
    watching,
    nonSales,
    counts: {
      ...lanes.counts,
      actionNow: actionNow.length,
      watching: watching.length,
      nonSales: nonSales.length,
    },
    watchingSegments: buildMetaWatchingSegments(watching),
  };
}

export function providerCurrencyValue(
  value: number | null | undefined,
  format: "currency" | "roas" | null | undefined,
) {
  const numeric = finite(value);
  if (numeric === null) return null;
  return format === "currency" ? numeric / 100 : numeric;
}

export function providerBudgetValue(value: number | null | undefined) {
  const numeric = finite(value);
  return numeric === null ? null : numeric / 100;
}

function priorityForRecommendation(
  rec: MetaRecommendation,
): MetaOsDecisionPriority {
  return {
    band: rec.priority,
    rank:
      PRIORITY_WEIGHT[rec.priority] * 100 +
      CONFIDENCE_WEIGHT[rec.confidence] * 10,
    version: META_OS_DECISIONS_PRESENTATION_VERSION,
  };
}

function priorityForDecision(
  decision: MetaCanonicalDecision,
): MetaOsDecisionPriority {
  const actionWeight: Record<string, number> = {
    fix_policy: 9,
    fix_delivery: 8,
    cut: 7,
    diagnose_data: 6,
    refresh: 5,
    test_more: 4,
    scale: 3,
    protect: 2,
    watch_launch: 1,
  };
  const confidenceWeight =
    decision.sourceDecision.confidenceBand === "high"
      ? 3
      : decision.sourceDecision.confidenceBand === "medium"
        ? 2
        : 1;
  const priorityAction =
    decision.classification.heldAction ??
    decision.classification.legacyBuyerAction;
  return {
    band: decision.sourceDecision.confidenceBand,
    rank:
      (actionWeight[priorityAction] ?? 0) * 100 +
      confidenceWeight * 10,
    version: META_OS_DECISIONS_PRESENTATION_VERSION,
  };
}

function structureUrgency(input: StructureInput): MetaOsDecisionUrgency {
  const priority = input.rec.priority;
  let level: MetaOsDecisionUrgency["level"] = "none";
  if (input.lane === "act") {
    level =
      priority === "high"
        ? "critical"
        : priority === "medium"
          ? "high"
          : "medium";
  } else if (input.lane === "blocked") {
    level = priority === "high" ? "high" : "medium";
  } else if (priority === "high") {
    level = "medium";
  }
  return {
    level,
    rank: URGENCY_WEIGHT[level],
    label:
      level === "critical"
        ? "Urgent"
        : level === "high"
          ? "High priority"
          : level === "medium"
            ? "Watch"
            : "No alert",
    reason:
      level === "none"
        ? null
        : input.rec.why?.trim() || input.rec.summary?.trim() || null,
  };
}

function noUrgency(): MetaOsDecisionUrgency {
  return { level: "none", rank: 0, label: "No alert", reason: null };
}

function compareStructureInputs(a: StructureInput, b: StructureInput) {
  const aPriority = priorityForRecommendation(a.rec).rank ?? 0;
  const bPriority = priorityForRecommendation(b.rec).rank ?? 0;
  if (aPriority !== bPriority) return bPriority - aPriority;
  const laneWeight: Record<MetaOsDecisionLane, number> = {
    act: 3,
    blocked: 2,
    monitor: 1,
  };
  const laneDelta = laneWeight[b.lane] - laneWeight[a.lane];
  if (laneDelta !== 0) return laneDelta;
  const aSpend = finite(a.rec.metrics?.spend) ?? -1;
  const bSpend = finite(b.rec.metrics?.spend) ?? -1;
  if (aSpend !== bSpend) return bSpend - aSpend;
  return a.rec.id.localeCompare(b.rec.id);
}

function isExplicitlyActiveStructureRecommendation(rec: MetaRecommendation) {
  return rec.entityConfiguration?.status?.trim().toUpperCase() === "ACTIVE";
}

function lifecycleRole(
  rec: MetaRecommendation,
): MetaOsStructureNode["lifecycleRole"] {
  if (rec.campaignKind === "main") return "main";
  if (rec.campaignKind === "test") return "test";
  if (rec.campaignKind === "mixed") return "mixed";
  return "unknown";
}

function structureBudgetOwnership(rec: MetaRecommendation) {
  if (rec.entityConfiguration) {
    return {
      budgetOwner: rec.entityConfiguration.budgetOwner,
      budgetMode: rec.entityConfiguration.budgetMode,
      controlOwner: rec.entityConfiguration.controlOwner,
    };
  }
  if (rec.level === "adset") {
    return {
      budgetOwner: "adset" as const,
      budgetMode: "adset_budget" as const,
      controlOwner: "adset" as const,
    };
  }
  if (
    rec.type === "scenario_i2_abo_to_cbo" ||
    rec.type === "scenario_k1_mixed_config_rebuild"
  ) {
    return {
      budgetOwner: "mixed" as const,
      budgetMode: "mixed" as const,
      controlOwner: "mixed" as const,
    };
  }
  if (
    rec.strategyLayer === "budget" ||
    rec.type === "scenario_b2_lowest_cost_budget_scale" ||
    rec.type === "scenario_c1_controlled_scale"
  ) {
    return {
      budgetOwner: "campaign" as const,
      budgetMode: "campaign_budget" as const,
      controlOwner: "campaign" as const,
    };
  }
  return {
    budgetOwner: "unknown" as const,
    budgetMode: "unknown" as const,
    controlOwner: "unknown" as const,
  };
}

/**
 * WHICH SHAPE OF STRUCTURE ACTION IS THIS?
 *
 * Decided from TYPED fields only — the authority blocker, `decisionLabel`,
 * `actionKind` and `campaignKind` — never from the producer's operator copy.
 *
 * Its predecessor decided the same question by matching English against that
 * copy: `/\bscale\b/i.test(label)` chose the budget rewrite, `/^cut\b/i` chose
 * the pause verb, `/review structure\s*&\s*scale/i` chose the structure label
 * and `/budget/i.test(label)` chose the served `intent`. Two consequences,
 * both real in this repository:
 *
 *   - `/\bscale\b/i` matches "Review structure & scale", and it was tested
 *     FIRST, so the branch written to serve "Review Structure" was
 *     unreachable and the one campaign kind D016 says must review its
 *     structure before any execution instruction — `mixed` — was served a
 *     budget instruction instead. An inversion, produced by word order.
 *   - `intent` is authority-bearing. `launchModeForServedStructureAction` in
 *     components/meta/redesign/MetaPlatformPage.tsx refuses to open Launchpad
 *     unless the served `intent` is `launchpad`, so adding or removing the
 *     word "budget" from a label moved a row between authorities.
 *
 * Nothing below reads a character of copy, so a rewrite, a translation or an
 * empty label cannot change the code, the intent, the authority, or — for the
 * shapes that name their own action — the label.
 */
type StructureActionShape =
  | "commercial_truth_withheld"
  | "resolve_decision_inputs"
  | "bid_review"
  | "structure_review"
  | "budget_review"
  | "pause_entity"
  | "producer_copy";

function structureActionShape(
  rec: MetaRecommendation,
  targetAuthorityBlocker: MetaTargetHardAction | null,
): StructureActionShape {
  if (targetAuthorityBlocker) return "commercial_truth_withheld";
  if (rec.decisionLabel === "diagnose") return "resolve_decision_inputs";
  /*
    Ordered ahead of the Scale case, exactly as the regex chain's first branch
    was: a bid row's control applies a cap, so it keeps the producer's own copy
    and must not be relabelled as a budget move.
  */
  if (rec.actionKind === "execute_bid") return "bid_review";
  if (rec.decisionLabel === "scale") {
    /*
      D016: a Scale verdict answers "is this a winner", not "where does the
      operator execute". On a Mixed campaign the answer is a structure review
      first; on Test and Main it is the budget the ownership resolved.
    */
    return rec.campaignKind === "mixed" ? "structure_review" : "budget_review";
  }
  /*
    "Pause" is an execute verb, so it is served only for the row that actually
    carries a pause control. The predecessor served it whenever the producer's
    copy happened to start with the word "Cut", which could label a row that
    had no provider mutation at all as a pause.
  */
  if (rec.decisionLabel === "cut" && rec.actionKind === "execute_pause") {
    return "pause_entity";
  }
  return "producer_copy";
}

function structureAction(
  rec: MetaRecommendation,
  ownership: ReturnType<typeof structureBudgetOwnership>,
  targetAuthorityBlocker: MetaTargetHardAction | null,
): MetaOsDecisionAction {
  const configuredTarget =
    rec.actionKind === "execute_bid"
      ? ownership.controlOwner
      : rec.strategyLayer === "budget" || rec.decisionLabel === "scale"
        ? ownership.budgetOwner
        : rec.level;
  const targetLevel = configuredTarget === "adset" ? "adset" : "campaign";
  const targetNoun = targetLevel === "adset" ? "Ad Set" : "Campaign";
  const shape = structureActionShape(rec, targetAuthorityBlocker);
  /** The producer's own operator copy; null when it supplied none. */
  const producerCopy =
    rec.primaryActionLabel?.trim() ||
    rec.recommendedAction?.trim() ||
    rec.decision?.trim() ||
    null;

  if (shape === "commercial_truth_withheld") {
    return {
      code: "review_commercial_truth",
      label: "Review Commercial Truth",
      intent: "review",
      targetLevel,
      providerMutation: null,
      scopeNote:
        targetAuthorityBlocker === "scale"
          ? "Current target ROAS authority is unavailable; no Scale action is authorized"
          : "Current break-even ROAS authority is unavailable; no Cut action is authorized",
    };
  }

  if (shape === "resolve_decision_inputs") {
    return {
      code: "resolve_decision_inputs",
      label: "Resolve Decision Inputs",
      intent: "review",
      targetLevel,
      providerMutation: null,
      scopeNote:
        "Complete the missing server evidence before changing provider state",
    };
  }

  let intent: MetaOsCommandIntent = "review";
  let providerMutation: MetaOsDecisionAction["providerMutation"] = null;
  if (rec.actionKind === "execute_pause") {
    intent = "review";
    providerMutation = "pause";
  } else if (rec.actionKind === "execute_resume") {
    intent = "review";
    providerMutation = "resume";
  } else if (rec.actionKind === "execute_bid") {
    intent = "review";
    providerMutation = "apply_bid";
  } else if (
    rec.actionKind === "route_launchpad_duplicate" ||
    rec.actionKind === "route_launchpad_rebuild"
  ) {
    intent = "launchpad";
  } else if (rec.actionKind === "review_drill") {
    intent = "review";
  }

  const label =
    shape === "structure_review"
      ? "Review Structure"
      : shape === "budget_review"
        ? `Review ${targetNoun} Budget`
        : shape === "pause_entity"
          ? `Pause ${targetNoun}`
          : shape === "bid_review"
            ? // The fallback the predecessor's `label || "Review Bid
              // Adjustment"` could never reach, because `label` had already
              // been defaulted to "Review" one statement earlier.
              (producerCopy ?? "Review Bid Adjustment")
            : (producerCopy ?? "Review");

  /*
    The operator performs this one themselves.

    A budget or structure review with no provider control behind it is not a
    review the product can run, so the served intent says `manual`. This was
    `/budget/i.test(label)`, which reached the same answer for today's
    producers only because the Scale rewrite above had just put the word
    "budget" into the label — and would have reached a different one for any
    other row whose copy happened to contain it.
  */
  if (
    (shape === "budget_review" || shape === "structure_review") &&
    providerMutation === null
  ) {
    intent = "manual";
  }

  return {
    code: rec.actionKind ?? rec.decisionLabel ?? "review",
    label,
    intent,
    targetLevel,
    providerMutation,
    scopeNote:
      targetLevel === "campaign"
        ? "Affects this campaign only"
        : "Affects this ad set only",
  };
}

function assessmentForRecommendation(rec: MetaRecommendation) {
  if (rec.decisionLabel === "scale") return "Budget opportunity";
  if (rec.decisionLabel === "cut" || rec.decisionLabel === "below_breakeven") {
    return "Underperformer";
  }
  if (rec.decisionLabel === "fatigue" || rec.decisionLabel === "refresh") {
    return "Fatigue risk";
  }
  if (rec.decisionLabel === "diagnose") return "Decision Blocked";
  if (rec.decisionLabel === "keep") return "Stable";
  return "Needs review";
}

function recommendationMetrics(
  rec: MetaRecommendation,
  currency: string | null,
): MetaOsStructureNode["metrics"] {
  return {
    spend: finite(rec.metrics?.spend),
    purchases: finite(rec.metrics?.purchases),
    roas: finite(rec.metrics?.roas),
    cpa: finite(rec.metrics?.cpa),
    ctr: finite(rec.metrics?.ctr),
    frequency: finite(rec.metrics?.frequency),
    effectiveTargetRoas: null,
    ratioToTarget: null,
    currency,
    attribution: "meta_attributed",
    grain: "campaign_or_adset",
  };
}

function structureNode(
  input: StructureInput,
  currency: string | null,
  suppressedAlternativeCount: number,
  contexts: ReadonlyMap<string, MetaDecisionCampaignContextSourceRow>,
): MetaOsStructureNode {
  const rec = input.rec;
  const campaignId = rec.campaignId?.trim() || null;
  const providerEntityId =
    rec.level === "adset" ? rec.adsetId?.trim() || null : campaignId;
  const name =
    (rec.level === "adset" ? rec.adsetName : rec.campaignName)?.trim() ||
    rec.title?.trim() ||
    providerEntityId ||
    "Entity unavailable";
  const ownership = structureBudgetOwnership(rec);
  const campaignRole = presentedCampaignRole({
    campaignId,
    campaignName: rec.campaignName?.trim() || null,
    currentValue: lifecycleRole(rec),
    contexts,
  });
  return {
    id: `${rec.level}:${providerEntityId ?? rec.id}`,
    sourceRecommendationId: rec.id,
    level: rec.level === "adset" ? "adset" : "campaign",
    providerEntityId,
    campaignId,
    campaignName: rec.campaignName?.trim() || null,
    name,
    lifecycleRole: campaignRole.value,
    campaignRoleSource: campaignRole.source,
    campaignRoleConfidence: campaignRole.confidence,
    campaignRoleTrustedForAction: campaignRole.trustedForAction,
    campaignRoleExplanation: campaignRole.explanation,
    ...ownership,
    status: rec.entityConfiguration?.status ?? null,
    optimizationGoal: rec.entityConfiguration?.optimizationGoal ?? null,
    bidConfiguration: rec.entityConfiguration
      ? {
          strategyType: rec.entityConfiguration.bidStrategyType,
          strategyLabel: rec.entityConfiguration.bidStrategyLabel ?? null,
          currentValue: providerCurrencyValue(
            rec.entityConfiguration.bidValue,
            rec.entityConfiguration.bidValueFormat,
          ),
          currentValueFormat: rec.entityConfiguration.bidValueFormat ?? null,
          previousValue: providerCurrencyValue(
            rec.entityConfiguration.previousBidValue,
            rec.entityConfiguration.previousBidValueFormat,
          ),
          previousValueFormat:
            rec.entityConfiguration.previousBidValueFormat ?? null,
          previousValueCapturedAt:
            rec.entityConfiguration.previousBidValueCapturedAt ?? null,
          dailyBudget: providerBudgetValue(rec.entityConfiguration.dailyBudget),
          lifetimeBudget: providerBudgetValue(
            rec.entityConfiguration.lifetimeBudget,
          ),
          budgetUtilization: rec.entityConfiguration.budgetUtilization ?? null,
        }
      : undefined,
    action: structureAction(rec, ownership, input.targetAuthorityBlocker),
    lane: input.lane,
    priority: priorityForRecommendation(rec),
    urgency: structureUrgency(input),
    confidence: rec.confidence,
    assessment: input.targetAuthorityBlocker
      ? "Decision Blocked"
      : assessmentForRecommendation(rec),
    whyNow: input.targetAuthorityBlocker
      ? "Current commercial target authority is unavailable; the persisted verdict remains visible but cannot authorize an action."
      : rec.why || rec.summary || "Evidence unavailable.",
    expectedImpact: input.targetAuthorityBlocker
      ? "Cannot calculate until commercial truth is current"
      : rec.expectedImpact || "Cannot calculate",
    evidence: rec.evidence ?? [],
    metrics: recommendationMetrics(rec, currency),
    suppressedAlternativeCount,
  };
}

function inventoryStructureNode(
  row: MetaStructureInventoryEntity,
  currency: string | null,
  contexts: ReadonlyMap<string, MetaDecisionCampaignContextSourceRow>,
): MetaOsStructureNode {
  const campaignId = row.campaignId?.trim() || null;
  const status = row.status?.trim() || null;
  const active = status?.toUpperCase() === "ACTIVE";
  const campaignRole = presentedCampaignRole({
    campaignId,
    campaignName: row.campaignName,
    currentValue:
      row.campaignKind === "main" ||
      row.campaignKind === "test" ||
      row.campaignKind === "mixed"
        ? row.campaignKind
        : "unknown",
    contexts,
  });
  const configuration = row.entityConfiguration;
  return {
    id: `${row.level}:${row.id}`,
    sourceRecommendationId: null,
    level: row.level,
    providerEntityId: row.id,
    campaignId,
    campaignName: row.campaignName,
    name: row.name,
    lifecycleRole: campaignRole.value,
    campaignRoleSource: campaignRole.source,
    campaignRoleConfidence: campaignRole.confidence,
    campaignRoleTrustedForAction: campaignRole.trustedForAction,
    campaignRoleExplanation: campaignRole.explanation,
    budgetOwner: configuration.budgetOwner,
    budgetMode: configuration.budgetMode,
    controlOwner: configuration.controlOwner,
    status,
    optimizationGoal: configuration.optimizationGoal ?? null,
    bidConfiguration: {
      strategyType: configuration.bidStrategyType ?? null,
      strategyLabel: configuration.bidStrategyLabel ?? null,
      currentValue: providerCurrencyValue(
        configuration.bidValue,
        configuration.bidValueFormat,
      ),
      currentValueFormat: configuration.bidValueFormat ?? null,
      previousValue: providerCurrencyValue(
        configuration.previousBidValue,
        configuration.previousBidValueFormat,
      ),
      previousValueFormat: configuration.previousBidValueFormat ?? null,
      previousValueCapturedAt: configuration.previousBidValueCapturedAt ?? null,
      dailyBudget: providerBudgetValue(configuration.dailyBudget),
      lifetimeBudget: providerBudgetValue(configuration.lifetimeBudget),
      budgetUtilization: configuration.budgetUtilization ?? null,
    },
    action: {
      code: active ? "no_current_intervention" : "inactive_inventory",
      label: active ? "No Current Action" : row.statusLabel || "Not Active",
      intent: "none",
      targetLevel: row.level,
      providerMutation: null,
      scopeNote: active
        ? "No current server decision authorizes a provider change"
        : "Inventory only; inactive assets cannot authorize a provider write",
    },
    lane: "monitor",
    priority: {
      band: "unrankable",
      rank: null,
      version: META_OS_DECISIONS_PRESENTATION_VERSION,
    },
    urgency: noUrgency(),
    confidence: "unknown",
    assessment: active ? "No urgent change" : "Not currently delivering",
    whyNow: active
      ? "The asset is in the account inventory and has no current server-owned intervention."
      : `The asset is ${row.statusLabel.toLowerCase()} and is shown for structure visibility only.`,
    expectedImpact: "No provider change",
    evidence: [],
    metrics: {
      ...row.metrics,
      effectiveTargetRoas: null,
      ratioToTarget: null,
      currency,
      attribution: "meta_attributed",
      grain: "campaign_or_adset",
    },
    suppressedAlternativeCount: 0,
  };
}

function syntheticCampaignNode(
  campaignId: string | null,
  campaignName: string | null,
  child: MetaOsStructureNode,
  currency: string | null,
): MetaOsStructureNode {
  return {
    id: `campaign:${campaignId ?? `unknown:${child.id}`}`,
    sourceRecommendationId: null,
    level: "campaign",
    providerEntityId: campaignId,
    campaignId,
    campaignName,
    name: campaignName ?? "Campaign unavailable",
    lifecycleRole: child.lifecycleRole,
    campaignRoleSource: child.campaignRoleSource,
    campaignRoleConfidence: child.campaignRoleConfidence,
    campaignRoleTrustedForAction: child.campaignRoleTrustedForAction,
    campaignRoleExplanation: child.campaignRoleExplanation,
    budgetOwner: child.budgetOwner === "adset" ? "adset" : "unknown",
    budgetMode:
      child.budgetMode === "adset_budget" ? "adset_budget" : "unknown",
    controlOwner: "unknown",
    status: null,
    optimizationGoal: null,
    action: {
      code: "child_decisions",
      label: "Review Child Decisions",
      intent: "none",
      targetLevel: "campaign",
      providerMutation: null,
      scopeNote: "Grouping row; no campaign mutation",
    },
    lane: child.lane,
    priority: child.priority,
    urgency: child.urgency,
    confidence: child.confidence,
    assessment: "Child decisions available",
    whyNow: "This campaign contains one or more ad-set decisions.",
    expectedImpact: "See the child decisions.",
    evidence: [],
    metrics: {
      spend: null,
      purchases: null,
      roas: null,
      cpa: null,
      ctr: null,
      frequency: null,
      effectiveTargetRoas: null,
      ratioToTarget: null,
      currency,
      attribution: "meta_attributed",
      grain: "campaign_or_adset",
    },
    suppressedAlternativeCount: 0,
  };
}

function adAssessment(decision: MetaCanonicalDecision) {
  const assessment = decision.classification.assessment.value;
  if (assessment === "proven_winner") return "Proven Winner";
  if (assessment === "above_target_not_scale_ready")
    return "Above Target · Not Proven";
  if (assessment === "fatigued_former_winner") return "Fatigued Former Winner";
  if (assessment === "below_target") return "Underperformer";
  if (assessment === "learning") return "Learning";
  if (assessment === "stable") return "Stable";
  if (assessment === "refresh_candidate") return "Refresh Candidate";
  if (assessment === "funnel_bottleneck") return "Funnel Bottleneck";
  if (assessment === "decision_blocked") return "Decision Blocked";
  if (assessment === "out_of_scope") return "Out of Scope";
  return "Evidence Incomplete";
}

function adAction(
  decision: MetaCanonicalDecision,
  targetHardActionEligibility: Readonly<{
    scale: boolean;
    cut: boolean;
  }>,
): {
  action: MetaOsDecisionAction;
  lane: MetaOsDecisionLane;
} {
  const buyerAction = decision.classification.buyerAction;
  const role = decision.classification.lifecycleRole.value;
  const targetLevel = "ad" as const;
  const nativeDecisionAuthorized =
    decision.sourceAuthority?.status === "native_exact" &&
    decision.sourceAuthority.actionEligible === true &&
    decision.sourceAuthority.realAdId === decision.parentChain.ad?.id;
  const nativeActionEligible =
    nativeDecisionAuthorized &&
    decision.sourceAuthority?.executionReadiness ===
      "live_preflight_required";
  // D081 C2 — this builder produces the LEGACY branch only. Naming the branch
  // keeps every existing creative/ad action byte-identical while making it a
  // compile-time fact that no budget payload leaks in here; budget actions are
  // produced by `toCanonicalDecisionAction` inside this builder and served in
  // the optional `budgetReview` block.
  const base = (
    input: Omit<MetaOsLegacyDecisionAction, "targetLevel">,
  ): MetaOsLegacyDecisionAction => ({
    ...input,
    targetLevel,
  });

  /*
    A HELD VERDICT IS BLOCKED, WHATEVER STATE THE PAYLOAD CLAIMS.

    `heldAction` is only ever set when the engine reached a hard Scale, Cut or
    Refresh and an authority gate withheld it, and INVARIANTS.md requires such
    a row to serve as `decisionState: blocked` with `buyerAction: null`, never
    inheriting an affirmative soft action from the published compatibility
    label. `projectMetaDecisionSemantics` guarantees exactly that pairing, so
    for every decision the current producers build this condition is already
    implied by the first one.

    It is stated anyway because the consequence of the pairing being violated
    is not cosmetic. Reading `buyerAction` alone, a payload carrying
    `heldAction: "cut"` beside `decisionState: "act"` and a native exact
    authority falls through to the Cut branch below and is served with
    `intent: "execute"` and `providerMutation: "pause"` — a provider write
    originating from a verdict that was explicitly withheld. Reading a held
    `keep` publishes `code: "keep_running"`, which is the affirmative soft
    action the invariant forbids and the reason a held Refresh reached the
    operator as "Keep Running".
  */
  if (
    decision.classification.decisionState === "blocked" ||
    decision.classification.heldAction !== null
  ) {
    const resolution = decision.classification.resolution;
    return {
      lane: "blocked",
      action: base({
        code: resolution?.code ?? "resolve_evidence_gap",
        label: resolution?.label ?? "Resolve Evidence Gap",
        intent: "review",
        providerMutation: null,
        scopeNote:
          resolution?.nextStep ??
          "Complete the missing server evidence before changing provider state",
      }),
    };
  }

  if (
    (buyerAction === "scale" || buyerAction === "cut") &&
    !targetHardActionEligibility[buyerAction]
  ) {
    return {
      lane: "blocked",
      action: base({
        code: "review_commercial_truth",
        label: "Review Commercial Truth",
        intent: "review",
        providerMutation: null,
        scopeNote:
          "Current commercial target authority is unavailable; no hard Scale/Cut action is authorized",
      }),
    };
  }

  if (
    buyerAction === "cut" &&
    nativeDecisionAuthorized &&
    !nativeActionEligible
  ) {
    const readiness = decision.sourceAuthority?.executionReadiness;
    const stale = readiness === "stale_decision";
    const killed = readiness === "kill_switched";
    const versionDrift = readiness === "engine_version_drift";
    return {
      lane: "blocked",
      action: base({
        code: stale
          ? "refresh_decision_data"
          : killed
            ? "review_kill_switch"
            : versionDrift
              ? "review_engine_version"
              : "review_execution_governance",
        label: stale
          ? "Refresh Decision"
          : killed
            ? "Review Kill Switch"
            : versionDrift
              ? "Review Engine Version"
              : "Review Execution Governance",
        intent: "review",
        providerMutation: null,
        scopeNote: stale
          ? "The exact-Ad decision is outside the 12-hour execution window"
          : "No provider write is offered until server governance is verified and a live preflight can run",
      }),
    };
  }

  if (buyerAction === "scale") {
    if (role === "test") {
      return {
        lane: "act",
        action: base({
          code: "plan_promotion",
          label: "Promote to Main",
          intent: "launchpad",
          providerMutation: null,
          scopeNote:
            "Creates a PAUSED Main copy after an eligible target is reviewed",
        }),
      };
    }
    if (role === "mixed") {
      return {
        lane: "act",
        action: base({
          code: "review_structure",
          label: "Review Structure",
          intent: "review",
          providerMutation: null,
          scopeNote: "No Ad-level budget action",
        }),
      };
    }
    return {
      lane: "monitor",
      action: base({
        code: "keep_running",
        label: "Keep Running",
        intent: "none",
        providerMutation: null,
        scopeNote: "No provider write",
      }),
    };
  }

  if (buyerAction === "cut") {
    return {
      lane: "act",
      action: base({
        code: "cut",
        label: "Cut",
        intent:
          nativeActionEligible &&
          decision.sourceAuthority?.authorizedAction === "cut"
            ? "execute"
            : "review",
        providerMutation:
          nativeActionEligible &&
          decision.sourceAuthority?.authorizedAction === "cut"
            ? "pause"
            : null,
        scopeNote: nativeActionEligible
          ? "Runs a live preflight, then pauses this exact ad only"
          : "Review only until exact native ad authority is available",
      }),
    };
  }
  if (buyerAction === "refresh") {
    return {
      lane: "act",
      action: base({
        code: "refresh_creative",
        label: "Refresh Creative",
        intent: "brief",
        providerMutation: null,
        scopeNote: "Creates a replacement brief; does not pause this ad",
      }),
    };
  }
  if (buyerAction === "test_more") {
    return {
      lane: "monitor",
      action: base({
        code: "continue_test",
        label: "Continue Test",
        intent: "none",
        providerMutation: null,
        scopeNote:
          "Keeps this ad running and re-evaluates the next eligible snapshot",
      }),
    };
  }
  if (buyerAction === "protect") {
    return {
      lane: "monitor",
      action: base({
        code: "keep_running",
        label: "Keep Running",
        intent: "none",
        providerMutation: null,
        scopeNote: "No provider write",
      }),
    };
  }
  if (buyerAction === "watch_launch") {
    return {
      lane: "monitor",
      action: base({
        code: "watch",
        label: "Watch",
        intent: "none",
        providerMutation: null,
        scopeNote: "Re-evaluates with the next eligible snapshot",
      }),
    };
  }

  if (buyerAction !== "fix_delivery" && buyerAction !== "fix_policy") {
    return {
      lane: "blocked",
      action: base({
        code: "resolve_contract_state",
        label: "Resolve Decision State",
        intent: "review",
        providerMutation: null,
        scopeNote:
          "The server decision contract is incomplete; no provider action is available",
      }),
    };
  }
  return {
    lane: "act",
    action: base({
      code: buyerAction,
      label: buyerAction === "fix_delivery" ? "Fix Delivery" : "Fix Policy",
      intent: "manual",
      providerMutation: null,
      scopeNote: "Review evidence before changing provider state",
    }),
  };
}

/**
 * D074/D076: the served explanation for one campaign's automatically inferred
 * role, restated VERBATIM from the resolver's context row. No kind is computed
 * here: a campaign the resolver has not resolved keeps `kind: null` with the
 * server-derived unresolved reason, and a campaign with no context row at all
 * reads as not yet evaluated.
 */
function campaignRoleExplanationFor(
  context: MetaDecisionCampaignContextSourceRow | null,
): MetaOsCampaignRoleExplanation {
  if (!context) {
    return {
      kind: null,
      confidenceClass: "unknown",
      confidenceScore: null,
      evidence: [],
      conflictReasons: [],
      unresolvedReason: "not_yet_evaluated",
      lastEvaluatedAt: null,
      resolverVersion: null,
    };
  }
  const kind = context.kind ?? null;
  return {
    kind,
    confidenceClass: context.confidenceClass,
    confidenceScore: context.confidenceScore ?? null,
    evidence: [...(context.evidence ?? [])],
    conflictReasons: [...(context.conflictReasons ?? [])],
    // The reader derives the reason from the persisted row; a row built before
    // these fields existed defaults to the conservative "not yet evaluated"
    // rather than to a fabricated diagnosis.
    unresolvedReason: kind
      ? null
      : (context.unresolvedReason ?? "not_yet_evaluated"),
    lastEvaluatedAt: context.lastEvaluatedAt ?? context.sourceUpdatedAt ?? null,
    resolverVersion: context.resolverVersion,
  };
}

function presentedCampaignRole(input: {
  campaignId: string | null;
  campaignName?: string | null;
  currentValue?: MetaOsAdDecision["lifecycleRole"];
  currentSource?: MetaOsAdDecision["campaignRoleSource"];
  currentConfidence?: MetaOsAdDecision["campaignRoleConfidence"];
  currentTrustedForAction?: boolean;
  contexts: ReadonlyMap<string, MetaDecisionCampaignContextSourceRow>;
}): {
  value: MetaOsAdDecision["lifecycleRole"];
  source: MetaOsAdDecision["campaignRoleSource"];
  confidence: MetaOsAdDecision["campaignRoleConfidence"];
  trustedForAction: boolean;
  explanation: MetaOsCampaignRoleExplanation;
} {
  const context = input.campaignId
    ? (input.contexts.get(input.campaignId) ?? null)
    : null;
  const explanation = campaignRoleExplanationFor(context);
  const contextValue = context?.kind ?? context?.suggestedKind ?? null;
  const contextSource =
    context?.source === "system_inferred"
      ? ("automatic" as const)
      : ("unknown" as const);
  if (
    input.currentValue &&
    input.currentValue !== "label_needed" &&
    input.currentValue !== "role_unresolved" &&
    input.currentValue !== "unknown" &&
    input.currentSource === "automatic" &&
    contextValue === input.currentValue
  ) {
    return {
      value: input.currentValue,
      source: contextSource,
      confidence: context?.confidenceClass ?? "unknown",
      trustedForAction: Boolean(
        context?.kind &&
          context.source === "system_inferred" &&
          context.confidenceClass === "high" &&
          isCampaignContextResolverAuthorityValidated(
            context.resolverVersion,
          ) &&
          input.currentTrustedForAction !== false,
      ),
      explanation,
    };
  }
  const hasCampaignIdentity = Boolean(input.campaignId?.trim());
  const value =
    context?.kind ??
    context?.suggestedKind ??
    (hasCampaignIdentity
      ? resolveProvisionalCampaignKind({
          kind: null,
          signalScores: null,
          campaignName: input.campaignName,
        })
      : "unknown");
  return {
    value,
    source:
      contextSource !== "unknown"
        ? contextSource
        : hasCampaignIdentity
          ? ("automatic" as const)
          : ("unknown" as const),
    confidence: context?.confidenceClass ?? ("unknown" as const),
    trustedForAction: Boolean(
        context?.kind &&
        context.source === "system_inferred" &&
        context.confidenceClass === "high" &&
        isCampaignContextResolverAuthorityValidated(context.resolverVersion),
    ),
    explanation,
  };
}

function adDecision(
  decision: MetaCanonicalDecision,
  contexts: ReadonlyMap<string, MetaDecisionCampaignContextSourceRow>,
  targetHardActionEligibility: Readonly<{
    scale: boolean;
    cut: boolean;
  }>,
): MetaOsAdDecision | null {
  const ad = decision.parentChain.ad;
  if (!ad?.id?.trim() || !/^\d+$/.test(ad.id.trim())) return null;
  if (
    decision.identityResolution &&
    !decision.identityResolution.adActionEligible
  ) {
    return null;
  }
  const mapped = adAction(decision, targetHardActionEligibility);
  const campaignRole = presentedCampaignRole({
    campaignId: decision.parentChain.campaign?.id ?? null,
    campaignName: decision.parentChain.campaign?.name ?? null,
    currentValue: decision.classification.lifecycleRole.value,
    currentSource:
      decision.classification.lifecycleRole.provenance?.source ===
      "engine_v3_campaign_context_daily"
          ? "automatic"
          : "unknown",
    currentConfidence: decision.classification.lifecycleRole.confidence,
    currentTrustedForAction:
      decision.classification.lifecycleRole.trustedForAction,
    contexts,
  });
  return {
    id: `ad:${ad.id}`,
    decisionId: decision.decisionId,
    sourceSnapshotId: decision.sourceSnapshotId,
    episodeId: decision.episodeId,
    providerAccountId: decision.providerAccountId,
    adId: ad.id,
    adName:
      ad.name?.trim() || decision.parentChain.creative?.name?.trim() || ad.id,
    campaignId: decision.parentChain.campaign?.id ?? null,
    campaignName: decision.parentChain.campaign?.name ?? null,
    adsetId: decision.parentChain.adset?.id ?? null,
    adsetName: decision.parentChain.adset?.name ?? null,
    creativeId: decision.parentChain.creative?.id ?? null,
    creativeName: decision.parentChain.creative?.name ?? null,
    thumbnailUrl: decision.media.thumbnail.url,
    lifecycleRole: campaignRole.value,
    campaignRoleSource: campaignRole.source,
    campaignRoleConfidence: campaignRole.confidence,
    campaignRoleTrustedForAction: campaignRole.trustedForAction,
    campaignRoleExplanation: campaignRole.explanation,
    action: mapped.action,
    lane: mapped.lane,
    priority: priorityForDecision(decision),
    assessment: adAssessment(decision),
    confidence: decision.sourceDecision.confidenceBand,
    confidenceScore: decision.sourceDecision.confidence,
    riskTier: decision.riskTier,
    confirmationCeremony: decision.confirmationCeremony,
    whyNow: decision.sourceDecision.reason,
    blockers: decision.classification.blockers.map((blocker) => ({
      code: blocker.code,
      label: blocker.label,
    })),
    resolution: decision.classification.resolution,
    /*
      The withheld verdict, served BESIDE the published label rather than
      instead of it.

      `heldAction` already existed on the canonical classification and this
      module read it in exactly one place — `priorityForDecision`, to rank the
      row — so the verdict decided where the row sorted and was then dropped
      before anything could say what it was. A held Refresh published `keep`,
      the surface rendered "Keep Running", and the Refresh pipeline, which
      selects on the served verdict, omitted the row entirely.

      `heldResolution` is the resolution belonging to THAT verdict:
      `projectMetaDecisionSemantics` produces it from the authority blocker and
      the held action together (`resolutionForAuthorityBlocker` in
      lib/meta/decision-semantics.ts names the held action in its nextStep), so
      it says which readiness floor failed for the Scale or Cut that was held.
      It is never `adAction`'s `resolve_evidence_gap` fallback: a payload that
      carries a held verdict and no resolution serves null here, because a
      fabricated generic resolution would read as a measured one.

      Both are evidence. Every execution field on this row is null — the held
      branch of `adAction` above returns `intent: "review"` and
      `providerMutation: null` — and no consumer may treat either field as
      authority to write.
    */
    heldAction: decision.classification.heldAction ?? null,
    heldResolution:
      decision.classification.heldAction === null
        ? null
        : (decision.classification.resolution ?? null),
    metrics: {
      spend: decision.metrics.spend,
      purchases: decision.metrics.purchases,
      roas: decision.metrics.roas,
      cpa: null,
      // 28-day figures from the lifecycle row the engine decided from. Both
      // were pinned to null here, so the creative rows and the posture band had
      // nothing to read even though the decision behind them carried it.
      ctr: decision.metrics.ctr ?? null,
      frequency: decision.metrics.frequency ?? null,
      effectiveTargetRoas: commercialTarget(decision.metrics.effectiveTargetRoas),
      ratioToTarget: ratioToCommercialTarget(
        decision.metrics.ratioToTarget,
        decision.metrics.effectiveTargetRoas,
      ),
      currency: decision.metrics.currency,
      attribution: "meta_attributed",
      grain: decision.identityGrain === "ad" ? "ad" : "creative_context",
    },
    creativeFormat: decision.creativeFormat ?? null,
    fatigueStatus: decision.fatigueStatus ?? null,
    rawLabel: decision.sourceDecision.rawLabel,
    publishedLabel: decision.sourceDecision.label,
    authorityProvenance: authorityProvenanceForDecision(decision),
    engineVersion: decision.sourceDecision.engineVersion,
    snapshotAsOf: decision.sourceDecision.snapshotAsOf,
    sourceGrain: decision.identityGrain === "ad" ? "ad" : "creative_context",
    decisionAvailability: "available",
  };
}

/**
 * IS THIS ACTIVE PROVIDER INVENTORY THAT NO PRODUCER HAS DECIDED?
 *
 * A census, not a decision. This used to be `activeInventoryAd`, which built a
 * whole 40-field `MetaOsAdDecision` for the answer "no decision exists": an
 * `await_ad_grain_evidence` action, a `lane: "blocked"`, an `unrankable`
 * priority band, a `not_evaluated` published label, a synthesised `resolution`,
 * and every metric null. That object was then published into the decision
 * lanes, where it consumed a slot of the response cap, counted into
 * `blockedCount` and `statePreCapCounts.blocked`, and inflated
 * `eligiblePreCapCount` so the surface offered to fetch more decisions that do
 * not exist. On an account whose producer had failed, the whole page was those
 * rows and the real held verdicts were pushed off it.
 *
 * The fact is real and is still served — as `ads.pendingInventoryCount` and the
 * `active_ad_inventory_pending_native_decision` limitation — so nothing is
 * hidden. What is gone is the fabricated decision that carried it. Building an
 * object shaped like a verdict is how it ends up read as one, so this returns
 * an identity or nothing.
 *
 * `campaignRole` is deliberately NOT resolved here: an inferred role qualifies
 * a verdict, and there is no verdict to qualify.
 */
function activeInventoryAdId(row: MetaCurrentAdStatusSourceRow): string | null {
  const adId = row.adId.trim();
  if (!/^\d+$/.test(adId)) return null;
  if (row.effectiveStatus?.trim().toUpperCase() !== "ACTIVE") return null;
  return adId;
}

/**
 * A commercial ROAS target, or null when there is not one.
 *
 * WHY THIS EXISTS. `truth_source = 'global_default'` writes a target of ZERO
 * and forwards it as a number, so `effectiveTargetRoas` arrives finite and the
 * surfaces that format it printed "vs 0.00 target" beside a real ROAS — a
 * target nobody set, rendered as a target that was met by definition. On the
 * current account set that is the majority of rows: 6,365 of the served rows
 * carry `global_default`, all of them with a zero target.
 *
 * A non-positive target is the ABSENCE of a target, so it is served as null and
 * every consumer's existing "no target" branch handles it. `ratioToTarget` is
 * held to the same rule: a ratio against zero is not a measurement.
 */
function commercialTarget(value: number | null | undefined): number | null {
  const target = finite(value);
  return target === null || target <= 0 ? null : target;
}

/**
 * A ratio to target, kept only when the target it was measured against exists.
 *
 * Divided by a zero or absent target the ratio is either infinite or meaningless,
 * and either way it is not evidence. @see commercialTarget
 */
function ratioToCommercialTarget(
  ratio: number | null | undefined,
  target: number | null | undefined,
): number | null {
  if (commercialTarget(target) === null) return null;
  return finite(ratio);
}

function displayDecisionLabel(value: string | null | undefined) {
  const label = value?.trim();
  if (!label) return "Review prior evidence";
  return label
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function inactiveStructureAsset(
  row: InactiveStructureInput,
  currency: string | null,
): MetaOsInactiveAsset {
  const normalizedStatus = row.status.trim().toUpperCase();
  return {
    id: `inactive:${row.level}:${row.id}`,
    level: row.level,
    providerEntityId: row.id,
    name: row.name,
    campaignName: row.campaignName?.trim() || null,
    adsetName: row.level === "adset" ? row.name : null,
    status: row.statusLabel || row.status || "Unknown",
    deliveryState:
      !normalizedStatus ||
      normalizedStatus === "UNKNOWN" ||
      normalizedStatus === "UNAVAILABLE"
        ? "unknown"
        : "inactive",
    advisoryLabel:
      row.advisory?.primaryActionLabel?.trim() || "Review prior evidence",
    advisoryReason:
      row.advisory?.why?.trim() ||
      row.diagnosticNote?.trim() ||
      "This entity is not currently live. Historical evidence is advisory only.",
    confidence: row.advisory?.confidence ?? "low",
    metrics: {
      spend: finite(row.spend),
      purchases: finite(row.purchases),
      roas: finite(row.roas),
      cpa: finite(row.cpa),
      ctr: null,
      frequency: null,
      effectiveTargetRoas: null,
      ratioToTarget: null,
      currency,
      attribution: "meta_attributed",
      grain: "campaign_or_adset",
    },
    source: "structure_archive",
    providerWriteAuthority: "none",
  };
}

function inactiveAdAsset(
  decision: MetaCanonicalDecision,
): MetaOsInactiveAsset | null {
  const ad = decision.parentChain.ad;
  const delivery = decision.deliveryScope;
  if (!delivery || delivery.state === "active") return null;
  const verifiedAdId =
    ad?.id?.trim() && /^\d+$/.test(ad.id.trim()) ? ad.id.trim() : null;
  const creativeId = decision.parentChain.creative?.id?.trim() || null;
  const entityId = verifiedAdId ?? creativeId ?? decision.decisionId;
  const level = verifiedAdId ? "ad" : "creative";
  const statuses = [
    delivery.campaignStatus,
    delivery.adsetStatus,
    delivery.adStatus,
  ]
    .filter((value): value is string => Boolean(value?.trim()))
    .filter((value, index, values) => values.indexOf(value) === index);
  return {
    id: `inactive:${level}:${entityId}`,
    level,
    providerEntityId: entityId,
    name:
      (verifiedAdId ? ad?.name?.trim() : null) ||
      decision.parentChain.creative?.name?.trim() ||
      entityId,
    campaignName: decision.parentChain.campaign?.name ?? null,
    adsetName: decision.parentChain.adset?.name ?? null,
    status: statuses.length > 0 ? statuses.join(" / ") : "Status unknown",
    deliveryState: delivery.state,
    advisoryLabel: displayDecisionLabel(
      decision.classification.buyerLabel || decision.sourceDecision.label,
    ),
    advisoryReason: decision.sourceDecision.reason,
    confidence: decision.sourceDecision.confidenceBand,
    metrics: {
      spend: decision.metrics.spend,
      purchases: decision.metrics.purchases,
      roas: decision.metrics.roas,
      cpa: null,
      ctr: null,
      frequency: null,
      effectiveTargetRoas: commercialTarget(decision.metrics.effectiveTargetRoas),
      ratioToTarget: ratioToCommercialTarget(
        decision.metrics.ratioToTarget,
        decision.metrics.effectiveTargetRoas,
      ),
      currency: decision.metrics.currency,
      attribution: "meta_attributed",
      grain: decision.identityGrain === "ad" ? "ad" : "creative_context",
    },
    source: "canonical_decision_snapshot",
    providerWriteAuthority: "none",
  };
}

function compactQueueItems(readModel: MetaDecisionsWorkspaceReadModel) {
  const seen = new Set<string>();
  const items: MetaCanonicalDecision[] = [];
  for (const section of Object.values(readModel.queue?.sections ?? {})) {
    for (const decision of section.items) {
      if (seen.has(decision.decisionId)) continue;
      seen.add(decision.decisionId);
      items.push(decision);
    }
  }
  return items;
}

function adCandidateItems(readModel: MetaDecisionsWorkspaceReadModel) {
  return readModel.queue?.adCandidates?.items ?? compactQueueItems(readModel);
}

const OS_AD_LANES = ["act", "blocked", "monitor"] as const satisfies readonly MetaOsDecisionLane[];

const OS_AD_LANE_WEIGHT: Record<MetaOsDecisionLane, number> = {
  act: 3,
  blocked: 2,
  monitor: 1,
};

function compareOsAdDecisions(
  left: MetaOsAdDecision,
  right: MetaOsAdDecision,
) {
  return (
    OS_AD_LANE_WEIGHT[right.lane] - OS_AD_LANE_WEIGHT[left.lane] ||
    (right.priority.rank ?? -1) - (left.priority.rank ?? -1) ||
    left.adId.localeCompare(right.adId) ||
    left.decisionId.localeCompare(right.decisionId)
  );
}

/**
 * One final, deterministic Ad sequence across canonical decisions and current
 * ACTIVE inventory whose exact decision is pending.
 *
 * The response used to append pending rows after the canonical list had
 * already filled the cap, then slice. When pending inventory was the only
 * Blocked population, all of it disappeared even though the response claimed
 * a non-empty Blocked pre-cap count. The fixed lane-reserve prefix below is the
 * same selection law as the canonical read model: every non-empty lane is
 * represented first, then the remaining capacity is filled by global priority.
 * The completed selection is deliberately not re-sorted, so increasing the
 * limit exposes a longer prefix instead of moving newly admitted Act rows ahead
 * of Blocked/Monitor rows the smaller response had already served.
 */
function selectOsAdDecisions(
  items: readonly MetaOsAdDecision[],
  limit: number,
): MetaOsAdDecision[] {
  const buckets = Object.fromEntries(
    OS_AD_LANES.map((lane) => [
      lane,
      items
        .filter((item) => item.lane === lane)
        .sort(compareOsAdDecisions),
    ]),
  ) as Record<MetaOsDecisionLane, MetaOsAdDecision[]>;
  const nonEmptyLanes = OS_AD_LANES.filter(
    (lane) => buckets[lane].length > 0,
  );
  const reserve =
    nonEmptyLanes.length === 0
      ? 0
      : Math.min(
          META_DECISIONS_AD_CANDIDATE_LANE_RESERVE,
          Math.floor(limit / nonEmptyLanes.length),
        );
  const selected = nonEmptyLanes.flatMap((lane) =>
    buckets[lane].slice(0, reserve),
  );
  const selectedAdIds = new Set(selected.map((item) => item.adId));
  selected.push(
    ...items
      .filter((item) => !selectedAdIds.has(item.adId))
      .sort(compareOsAdDecisions)
      .slice(0, Math.max(0, limit - selected.length)),
  );
  return selected;
}

export function buildMetaOsDecisionsPresentation(input: {
  actionNow: MetaRecommendation[];
  watching: MetaRecommendation[];
  nonSales: MetaRecommendation[];
  structureInventory?: readonly MetaStructureInventoryEntity[];
  inactiveStructure?: InactiveStructureInput[];
  decisionReadModel: MetaDecisionsWorkspaceReadModel;
  currentAds?: readonly MetaCurrentAdStatusSourceRow[];
  currentAdCampaignContexts?: readonly MetaDecisionCampaignContextSourceRow[];
  currency: string | null;
  targetHardActionEligibility?: MetaTargetHardActionEligibility;
  pipelineHealth?: Pick<
    MetaDecisionPipelineHealth,
    "overall" | "executionReady" | "blockers"
  >;
  generatedAt?: string;
  /**
   * D081 — validated budget intents to serve as canonical review-only actions.
   *
   * The builder ASSEMBLES; it does not decide. It picks no rung, no entity and
   * no magnitude — the validated intent already carries the operation and the
   * composite scope. Omitted or empty means the served payload is byte-identical
   * to a build without this parameter.
   */
  budgetIntents?: readonly ValidatedBudgetIntent[];
}): MetaOsDecisionsPresentation {
  const currentAdCampaignContexts = new Map(
    (input.currentAdCampaignContexts ?? []).map((context) => [
      context.campaignId,
      context,
    ]),
  );
  const targetHardActionEligibility = input.targetHardActionEligibility ?? {
    scale: true,
    cut: true,
  };
  const structureInputs: StructureInput[] = [
    ...input.actionNow.map((rec) => ({
      rec,
      lane: "act" as const,
      targetAuthorityBlocker: targetAuthorityBlocker(
        rec,
        targetHardActionEligibility,
      ),
    })),
    ...input.watching.map((rec) => ({
      rec,
      lane: "monitor" as const,
      targetAuthorityBlocker: targetAuthorityBlocker(
        rec,
        targetHardActionEligibility,
      ),
    })),
    ...input.nonSales.map((rec) => ({
      rec,
      lane:
        rec.decisionState === "act" ? ("act" as const) : ("monitor" as const),
      targetAuthorityBlocker: targetAuthorityBlocker(
        rec,
        targetHardActionEligibility,
      ),
    })),
  ]
    .filter(
      (item) => item.rec.level === "campaign" || item.rec.level === "adset",
    )
    .filter((item) => isExplicitlyActiveStructureRecommendation(item.rec))
    .map((item) => ({
      ...item,
      lane:
        item.rec.decisionLabel === "diagnose" || item.targetAuthorityBlocker
          ? ("blocked" as const)
          : item.lane,
    }));

  const entityBuckets = new Map<string, StructureInput[]>();
  for (const item of structureInputs) {
    const entityId =
      item.rec.level === "campaign"
        ? item.rec.campaignId?.trim() || item.rec.id
        : item.rec.adsetId?.trim() || item.rec.id;
    const key = `${item.rec.level}:${entityId}`;
    const bucket = entityBuckets.get(key) ?? [];
    bucket.push(item);
    entityBuckets.set(key, bucket);
  }

  const recommendationNodes = Array.from(entityBuckets.values()).map(
    (bucket) => {
      const sorted = bucket.slice().sort(compareStructureInputs);
      return structureNode(
        sorted[0]!,
        input.currency,
        Math.max(0, sorted.length - 1),
        currentAdCampaignContexts,
      );
    },
  );
  const selectedNodesById = new Map<string, MetaOsStructureNode>();
  for (const row of input.structureInventory ?? []) {
    const node = inventoryStructureNode(
      row,
      input.currency,
      currentAdCampaignContexts,
    );
    selectedNodesById.set(node.id, node);
  }
  // A live recommendation owns action semantics; inventory only guarantees
  // complete account structure and never overrides recommendation authority.
  for (const node of recommendationNodes) selectedNodesById.set(node.id, node);
  const selectedNodes = [...selectedNodesById.values()];
  const campaignNodes = selectedNodes.filter(
    (node) => node.level === "campaign",
  );
  const adsetNodes = selectedNodes.filter((node) => node.level === "adset");
  const groupsByCampaign = new Map<string, MetaOsStructureGroup>();

  for (const campaign of campaignNodes) {
    const key = campaign.campaignId ?? campaign.id;
    groupsByCampaign.set(key, {
      id: `group:${key}`,
      campaign,
      adsets: [],
      highestPriority: campaign.priority,
      highestUrgency: campaign.urgency,
      urgentAdsetCount: 0,
    });
  }
  for (const adset of adsetNodes) {
    const key = adset.campaignId ?? `unknown:${adset.id}`;
    let group = groupsByCampaign.get(key);
    if (!group) {
      const campaign = syntheticCampaignNode(
        adset.campaignId,
        adset.campaignName,
        adset,
        input.currency,
      );
      group = {
        id: `group:${key}`,
        campaign,
        adsets: [],
        highestPriority: campaign.priority,
        highestUrgency: campaign.urgency,
        urgentAdsetCount: 0,
      };
      groupsByCampaign.set(key, group);
    }
    group.adsets.push(adset);
    if ((adset.priority.rank ?? -1) > (group.highestPriority.rank ?? -1)) {
      group.highestPriority = adset.priority;
    }
    if (adset.urgency.rank > group.highestUrgency.rank) {
      group.highestUrgency = adset.urgency;
    }
    if (adset.urgency.level === "critical" || adset.urgency.level === "high") {
      group.urgentAdsetCount += 1;
    }
  }

  const groups = Array.from(groupsByCampaign.values())
    .map((group) => ({
      ...group,
      adsets: group.adsets.sort(
        (a, b) =>
          (b.priority.rank ?? -1) - (a.priority.rank ?? -1) ||
          a.id.localeCompare(b.id),
      ),
    }))
    .sort(
      (a, b) =>
        b.highestUrgency.rank - a.highestUrgency.rank ||
        (b.highestPriority.rank ?? -1) - (a.highestPriority.rank ?? -1) ||
        (b.campaign.metrics.spend ?? -1) - (a.campaign.metrics.spend ?? -1) ||
        a.id.localeCompare(b.id),
    );

  const canonical = adCandidateItems(input.decisionReadModel);
  let omittedWithoutVerifiedAdId =
    input.decisionReadModel.queue?.adCandidates?.omittedWithoutVerifiedAdId ??
    0;
  let omittedAmbiguousIdentity =
    input.decisionReadModel.queue?.adCandidates?.omittedAmbiguousIdentity ?? 0;
  const omittedNotApplicable =
    input.decisionReadModel.queue?.adCandidates?.omittedNotApplicable ?? 0;
  const countsProvidedByCandidateEnvelope = Boolean(
    input.decisionReadModel.queue?.adCandidates,
  );
  const adBuckets = new Map<string, MetaOsAdDecision[]>();
  for (const decision of canonical) {
    const item = adDecision(
      decision,
      currentAdCampaignContexts,
      targetHardActionEligibility,
    );
    if (!item) {
      if (
        !countsProvidedByCandidateEnvelope &&
        decision.identityResolution?.basis === "creative_ambiguous"
      ) {
        omittedAmbiguousIdentity += 1;
      } else if (!countsProvidedByCandidateEnvelope) {
        omittedWithoutVerifiedAdId += 1;
      }
      continue;
    }
    const bucket = adBuckets.get(item.adId) ?? [];
    bucket.push(item);
    adBuckets.set(item.adId, bucket);
  }
  const canonicalAds = Array.from(adBuckets.values())
    .map(
      (bucket) =>
        bucket.sort(
          (a, b) =>
            (b.priority.rank ?? -1) - (a.priority.rank ?? -1) ||
            a.decisionId.localeCompare(b.decisionId),
        )[0]!,
    )
    .sort(compareOsAdDecisions);
  const canonicalAdIds = new Set(canonicalAds.map((item) => item.adId));
  const canonicalAdUniverseIds =
    readCanonicalAdUniverseIds(input.decisionReadModel) ?? canonicalAdIds;
  const pendingInventoryAdIds = new Set(
    (input.currentAds ?? [])
      .map(activeInventoryAdId)
      .filter((adId): adId is string => adId !== null)
      .filter((adId) => !canonicalAdUniverseIds.has(adId)),
  );
  const adLimit =
    input.decisionReadModel.queue?.adCandidates?.limit ?? canonicalAds.length;
  /*
   * The decision lanes carry DECISIONS. Provider inventory is not one.
   *
   * `activeInventoryAd` synthesises a placeholder for an ACTIVE Ad that no
   * producer has decided: `lane: "blocked"`, priority band `unrankable`,
   * label `not_evaluated`, every metric null. Those placeholders used to be
   * concatenated onto `canonicalAds` and cut to the same `adLimit`, which had
   * three consequences an operator cannot act on, all of them observed on this
   * account set:
   *
   *   1. They COMPETED for the cap. On Grandmix the queue served 60 rows and
   *      every one of them was a placeholder, so the real held verdicts the
   *      engine had produced were pushed out of the page by rows that state
   *      only "no decision exists".
   *   2. They INFLATED the lane counts. `blockedCount` and
   *      `statePreCapCounts.blocked` counted them, so "33 blocked" mixed
   *      withheld verdicts with un-evaluated inventory and no reader could
   *      tell which number was which.
   *   3. They INFLATED `eligiblePreCapCount`, which drives the surface's
   *      "load more" affordance — so the surface offered to fetch more
   *      decisions that do not exist.
   *
   * They are still SERVED, because an ACTIVE Ad with no decision is a real
   * source-health fact and hiding it would be its own lie. They are served as
   * one count and one sentence — `pendingInventoryCount` plus the
   * `active_ad_inventory_pending_native_decision` limitation — not as rows in
   * a decision lane.
   *
   * The cap no longer applies to them: nothing is "withheld by the response
   * cap" when the population is summarised rather than paginated, so the
   * sentence states the whole count once.
   *
   * The placeholder is not merely unpublished — it is no longer BUILT. What
   * remains is `activeInventoryAdId`, a census that answers only "is this
   * un-decided ACTIVE inventory" with an identity. @see activeInventoryAdId
   */
  const ads = selectOsAdDecisions(canonicalAds, adLimit);
  const pendingInventoryPreCapCount = pendingInventoryAdIds.size;
  const pendingInventoryLimitation =
    pendingInventoryPreCapCount === 0
      ? null
      : `${pendingInventoryPreCapCount} ACTIVE ${pendingInventoryPreCapCount === 1 ? "Ad has" : "Ads have"} no exact Ad-grain decision yet, so ${pendingInventoryPreCapCount === 1 ? "it is" : "they are"} not listed as ${pendingInventoryPreCapCount === 1 ? "a decision" : "decisions"}.`;

  const allStructureNodes = groups.flatMap((group) => [
    group.campaign,
    ...group.adsets,
  ]);
  const inactiveById = new Map<string, MetaOsInactiveAsset>();
  for (const row of input.inactiveStructure ?? []) {
    const item = inactiveStructureAsset(row, input.currency);
    inactiveById.set(item.id, item);
  }
  for (const decision of input.decisionReadModel.queue?.inactiveAssets?.items ??
    []) {
    const item = inactiveAdAsset(decision);
    if (item) inactiveById.set(item.id, item);
  }
  const inactiveItems = [...inactiveById.values()].sort(
    (left, right) =>
      (right.metrics.spend ?? -1) - (left.metrics.spend ?? -1) ||
      left.id.localeCompare(right.id),
  );
  // D081 — assemble the canonical budget actions from the validated intents the
  // caller supplied. Each is validated again through the shared runtime guard,
  // so an invalid branch cannot enter the served payload.
  const budgetActions = (input.budgetIntents ?? []).map((intent) =>
    assertCanonicalDecisionAction(toCanonicalDecisionAction(intent)),
  ) as MetaOsBudgetDecisionAction[];

  return {
    contractVersion: META_OS_DECISIONS_PRESENTATION_VERSION,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    source: {
      snapshotAsOf: input.decisionReadModel.source?.snapshotAsOf ?? null,
      engineVersion: input.decisionReadModel.source?.engineVersion ?? null,
      structureSource: "meta_recommendations",
      adsSource:
        input.decisionReadModel.source?.authority === "native_ad"
          ? "native_ad_decision"
          : "legacy_creative_review_only",
      health:
        input.decisionReadModel.source?.status === "available" &&
        input.decisionReadModel.source.authority === "native_ad" &&
        input.decisionReadModel.source.fallbackReason == null &&
        input.pipelineHealth?.executionReady === true
          ? "healthy"
          : "degraded",
      fallbackReason:
        input.decisionReadModel.source?.fallbackReason ??
        input.decisionReadModel.unavailable?.code ??
        input.pipelineHealth?.blockers[0] ??
        null,
    },
    structure: {
      groups,
      actCount: allStructureNodes.filter((node) => node.lane === "act").length,
      blockedCount: allStructureNodes.filter((node) => node.lane === "blocked")
        .length,
      monitorCount: allStructureNodes.filter((node) => node.lane === "monitor")
        .length,
      suppressedAlternativeCount: allStructureNodes.reduce(
        (sum, node) => sum + node.suppressedAlternativeCount,
        0,
      ),
    },
    ads: {
      items: ads,
      actCount: ads.filter((item) => item.lane === "act").length,
      blockedCount: ads.filter((item) => item.lane === "blocked").length,
      monitorCount: ads.filter((item) => item.lane === "monitor").length,
      /*
       * WHICH verdicts were held, over the same SERVED rows the three lane
       * counts above describe.
       *
       * Deliberately a second, orthogonal tally rather than a lane: every held
       * row is already counted once in `blockedCount`, and adding it to a lane
       * count again would report the same decision twice. Without this the
       * only served evidence that a Refresh verdict existed was the per-row
       * `heldAction`, and a count the surface could not compute cheaply is a
       * count the surface did not show.
       */
      heldCounts: {
        scale: ads.filter((item) => item.heldAction === "scale").length,
        cut: ads.filter((item) => item.heldAction === "cut").length,
        refresh: ads.filter((item) => item.heldAction === "refresh").length,
      },
      statePreCapCounts: {
        act:
          input.decisionReadModel.queue?.adCandidates?.stateCounts?.act
            ?.preCapCount ?? ads.filter((item) => item.lane === "act").length,
        // Withheld VERDICTS only. Un-evaluated ACTIVE inventory is counted by
        // `pendingInventoryCount`, never added here: adding it made "blocked"
        // a mixture of two populations that need different operator answers.
        blocked:
          input.decisionReadModel.queue?.adCandidates?.stateCounts?.blocked
            ?.preCapCount ??
          canonicalAds.filter((item) => item.lane === "blocked").length,
        monitor:
          input.decisionReadModel.queue?.adCandidates?.stateCounts?.monitor
            ?.preCapCount ??
          ads.filter((item) => item.lane === "monitor").length,
      },
      // The pre-cap size of the population that produced `items`, which is now
      // the canonical decisions alone. The surface pairs this with the shown
      // count to decide whether more decisions can be fetched, so counting
      // un-evaluated inventory here offered a page of rows that do not exist.
      eligiblePreCapCount:
        input.decisionReadModel.queue?.adCandidates?.eligiblePreCapCount ??
        canonicalAds.length,
      /*
       * ACTIVE provider inventory carrying no exact Ad-grain decision.
       *
       * Deliberately NOT part of any lane count above: these are not decisions
       * and an operator cannot act on them. Served so the surface can state
       * the source-health fact once, beside the `active_ad_inventory_pending_native_decision`
       * limitation that carries the sentence.
       */
      pendingInventoryCount: pendingInventoryPreCapCount,
      omittedWithoutVerifiedAdId,
      omittedAmbiguousIdentity,
      omittedNotApplicable,
      sourcePreCapCount: input.decisionReadModel.queue?.sourcePreCapCount ?? 0,
    },
    inactive: {
      items: inactiveItems,
      count: inactiveItems.length,
      inactiveCount: inactiveItems.filter(
        (item) => item.deliveryState === "inactive",
      ).length,
      unknownCount: inactiveItems.filter(
        (item) => item.deliveryState === "unknown",
      ).length,
    },
    // Spread, not assigned: with no intents the key is absent entirely and the
    // serialized payload is byte-identical to a build without this feature.
    ...(budgetActions.length > 0
      ? { budgetReview: { actions: budgetActions, count: budgetActions.length } }
      : {}),
    limitations: [
      ...(input.decisionReadModel.source?.authority === "native_ad"
        ? []
        : [
            {
              code: "legacy_creative_review_only",
              message:
                "Legacy creative-grain decisions remain visible for continuity but cannot authorize Ad writes.",
            },
            {
              code: "ad_metrics_are_creative_context",
              message:
                "Legacy rows use creative-grain metrics and are review-only even when one exact Ad identity is displayed.",
            },
          ]),
      ...(pendingInventoryPreCapCount > 0
        ? [
            {
              code: "active_ad_inventory_pending_native_decision",
              message: pendingInventoryLimitation!,
            },
          ]
        : []),
    ],
  };
}
