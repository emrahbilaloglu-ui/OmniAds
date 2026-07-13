import type {
  MetaCanonicalDecision,
  MetaDecisionsWorkspaceReadModel,
} from "@/lib/meta/decisions-workspace-contract";
import {
  resolveProvisionalCampaignKind,
  type MetaCurrentAdStatusSourceRow,
  type MetaDecisionCampaignContextSourceRow,
} from "@/lib/meta/decisions-workspace-read-model";
import type { MetaRecommendation } from "@/lib/meta/recommendations";
import type { MetaStructureInventoryEntity } from "@/components/meta/redesign/types";
import {
  META_OS_DECISIONS_PRESENTATION_VERSION,
  type MetaOsAdDecision,
  type MetaOsCommandIntent,
  type MetaOsDecisionAction,
  type MetaOsDecisionLane,
  type MetaOsDecisionPriority,
  type MetaOsDecisionUrgency,
  type MetaOsDecisionsPresentation,
  type MetaOsInactiveAsset,
  type MetaOsStructureGroup,
  type MetaOsStructureNode,
} from "@/lib/meta/decisions-os-contract";

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
};

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
  return {
    band: decision.sourceDecision.confidenceBand,
    rank:
      (actionWeight[decision.classification.legacyBuyerAction] ?? 0) * 100 +
      confidenceWeight * 10,
    version: META_OS_DECISIONS_PRESENTATION_VERSION,
  };
}

function structureUrgency(input: StructureInput): MetaOsDecisionUrgency {
  const priority = input.rec.priority;
  let level: MetaOsDecisionUrgency["level"] = "none";
  if (input.lane === "act") {
    level = priority === "high" ? "critical" : priority === "medium" ? "high" : "medium";
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

function structureAction(
  rec: MetaRecommendation,
  ownership: ReturnType<typeof structureBudgetOwnership>,
): MetaOsDecisionAction {
  const configuredTarget =
    rec.actionKind === "execute_bid"
      ? ownership.controlOwner
      : rec.strategyLayer === "budget" || rec.decisionLabel === "scale"
        ? ownership.budgetOwner
        : rec.level;
  const targetLevel = configuredTarget === "adset" ? "adset" : "campaign";
  const targetNoun = targetLevel === "adset" ? "Ad Set" : "Campaign";
  let label =
    rec.primaryActionLabel?.trim() ||
    rec.recommendedAction?.trim() ||
    rec.decision?.trim() ||
    "Review";

  if (rec.decisionLabel === "diagnose") {
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

  if (rec.actionKind === "execute_bid") {
    label = label || "Review Bid Adjustment";
  } else if (
    (rec.decisionLabel === "scale" &&
      !/^(increase|reduce)\b.*\bbudget\b/i.test(label)) ||
    /\bscale\b/i.test(label)
  ) {
    label = `Review ${targetNoun} Budget`;
  } else if (rec.decisionLabel === "cut" && /^cut\b/i.test(label)) {
    label = `Pause ${targetNoun}`;
  } else if (/review structure\s*&\s*scale/i.test(label)) {
    label = "Review Structure";
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

  if (/budget/i.test(label) && providerMutation === null) intent = "manual";

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
    action: structureAction(rec, ownership),
    lane: input.lane,
    priority: priorityForRecommendation(rec),
    urgency: structureUrgency(input),
    confidence: rec.confidence,
    assessment: assessmentForRecommendation(rec),
    whyNow: rec.why || rec.summary || "Evidence unavailable.",
    expectedImpact: rec.expectedImpact || "Cannot calculate",
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
      previousValueCapturedAt:
        configuration.previousBidValueCapturedAt ?? null,
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

function adAction(decision: MetaCanonicalDecision): {
  action: MetaOsDecisionAction;
  lane: MetaOsDecisionLane;
} {
  const buyerAction = decision.classification.buyerAction;
  const role = decision.classification.lifecycleRole.value;
  const targetLevel = "ad" as const;
  const nativeActionEligible =
    decision.sourceAuthority?.status === "native_exact" &&
    decision.sourceAuthority.actionEligible === true &&
    decision.sourceAuthority.realAdId === decision.parentChain.ad?.id;
  const base = (input: Omit<MetaOsDecisionAction, "targetLevel">) => ({
    ...input,
    targetLevel,
  });

  if (decision.classification.decisionState === "blocked") {
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
          ? "Pauses this exact ad only"
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
} {
  if (
    input.currentValue &&
    input.currentValue !== "label_needed" &&
    input.currentValue !== "unknown"
  ) {
    return {
      value: input.currentValue,
      source: input.currentSource ?? ("unknown" as const),
      confidence: input.currentConfidence ?? ("unknown" as const),
      trustedForAction: input.currentTrustedForAction ?? false,
    };
  }
  const context = input.campaignId
    ? input.contexts.get(input.campaignId) ?? null
    : null;
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
      context?.source === "persisted_label"
        ? ("user_override" as const)
        : context?.source === "system_inferred"
          ? ("automatic" as const)
          : hasCampaignIdentity
            ? ("automatic" as const)
            : ("unknown" as const),
    confidence: context?.confidenceClass ?? ("unknown" as const),
    trustedForAction: Boolean(
      context?.kind && context.source === "persisted_label",
    ),
  };
}

function adDecision(
  decision: MetaCanonicalDecision,
  contexts: ReadonlyMap<string, MetaDecisionCampaignContextSourceRow>,
): MetaOsAdDecision | null {
  const ad = decision.parentChain.ad;
  if (!ad?.id?.trim() || !/^\d+$/.test(ad.id.trim())) return null;
  if (
    decision.identityResolution &&
    !decision.identityResolution.adActionEligible
  ) {
    return null;
  }
  const mapped = adAction(decision);
  const campaignRole = presentedCampaignRole({
    campaignId: decision.parentChain.campaign?.id ?? null,
    campaignName: decision.parentChain.campaign?.name ?? null,
    currentValue: decision.classification.lifecycleRole.value,
    currentSource:
      decision.classification.lifecycleRole.provenance?.source ===
      "meta_campaign_labels"
        ? "user_override"
        : decision.classification.lifecycleRole.provenance?.source ===
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
    metrics: {
      spend: decision.metrics.spend,
      purchases: decision.metrics.purchases,
      roas: decision.metrics.roas,
      cpa: null,
      ctr: null,
      frequency: null,
      effectiveTargetRoas: decision.metrics.effectiveTargetRoas,
      ratioToTarget: decision.metrics.ratioToTarget,
      currency: decision.metrics.currency,
      attribution: "meta_attributed",
      grain: decision.identityGrain === "ad" ? "ad" : "creative_context",
    },
    rawLabel: decision.sourceDecision.rawLabel,
    publishedLabel: decision.sourceDecision.label,
    engineVersion: decision.sourceDecision.engineVersion,
    snapshotAsOf: decision.sourceDecision.snapshotAsOf,
    sourceGrain: decision.identityGrain === "ad" ? "ad" : "creative_context",
    decisionAvailability: "available",
  };
}

function activeInventoryAd(
  row: MetaCurrentAdStatusSourceRow,
  currency: string | null,
  contexts: ReadonlyMap<string, MetaDecisionCampaignContextSourceRow>,
): MetaOsAdDecision | null {
  const adId = row.adId.trim();
  if (!/^\d+$/.test(adId)) return null;
  if (row.effectiveStatus?.trim().toUpperCase() !== "ACTIVE") return null;
  const fetchedDate = row.fetchedAt.slice(0, 10);
  const campaignRole = presentedCampaignRole({
    campaignId: row.campaignId,
    campaignName: row.campaignName,
    contexts,
  });
  return {
    id: `ad:${adId}`,
    decisionId: `inventory:${adId}`,
    sourceSnapshotId: `inventory:${adId}:${fetchedDate}`,
    episodeId: `inventory:${adId}`,
    providerAccountId: row.providerAccountId,
    adId,
    adName: row.adName?.trim() || adId,
    campaignId: row.campaignId,
    campaignName: row.campaignName ?? null,
    adsetId: row.adsetId,
    adsetName: null,
    creativeId: row.creativeId,
    creativeName: null,
    thumbnailUrl: null,
    lifecycleRole: campaignRole.value,
    campaignRoleSource: campaignRole.source,
    campaignRoleConfidence: campaignRole.confidence,
    campaignRoleTrustedForAction: campaignRole.trustedForAction,
    action: {
      code: "await_ad_grain_evidence",
      label: "Evidence pending",
      intent: "review",
      targetLevel: "ad",
      providerMutation: null,
      scopeNote:
        "The Ad is live, but no exact Ad-grain decision snapshot can authorize an action yet",
    },
    lane: "blocked",
    priority: {
      band: "unrankable",
      rank: null,
      version: META_OS_DECISIONS_PRESENTATION_VERSION,
    },
    assessment: "Ad-grain evidence pending",
    confidence: "low",
    confidenceScore: 0,
    riskTier: null,
    confirmationCeremony: "highest",
    whyNow:
      "Meta confirms this Ad is ACTIVE, but the exact Ad-grain decision snapshot is not available.",
    blockers: [
      {
        code: "native_ad_decision_unavailable",
        label: "Exact Ad-grain decision evidence is unavailable",
      },
    ],
    resolution: {
      code: "produce_native_ad_decision",
      category: "system",
      owner: "system",
      label: "Produce exact Ad decision",
      nextStep:
        "Complete the native Ad decision schema and producer lineage gate.",
    },
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
      grain: "ad",
    },
    rawLabel: null,
    publishedLabel: "not_evaluated",
    engineVersion: "not_evaluated",
    snapshotAsOf: fetchedDate,
    sourceGrain: "ad",
    decisionAvailability: "pending_native_evidence",
  };
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
      effectiveTargetRoas: decision.metrics.effectiveTargetRoas,
      ratioToTarget: decision.metrics.ratioToTarget,
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
  generatedAt?: string;
}): MetaOsDecisionsPresentation {
  const currentAdCampaignContexts = new Map(
    (input.currentAdCampaignContexts ?? []).map((context) => [
      context.campaignId,
      context,
    ]),
  );
  const structureInputs: StructureInput[] = [
    ...input.actionNow.map((rec) => ({ rec, lane: "act" as const })),
    ...input.watching.map((rec) => ({ rec, lane: "monitor" as const })),
    ...input.nonSales.map((rec) => ({
      rec,
      lane:
        rec.decisionState === "act" ? ("act" as const) : ("monitor" as const),
    })),
  ]
    .filter(
      (item) => item.rec.level === "campaign" || item.rec.level === "adset",
    )
    .filter((item) => isExplicitlyActiveStructureRecommendation(item.rec))
    .map((item) => ({
      ...item,
      lane:
        item.rec.decisionLabel === "diagnose"
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

  const recommendationNodes = Array.from(entityBuckets.values()).map((bucket) => {
    const sorted = bucket.slice().sort(compareStructureInputs);
    return structureNode(
      sorted[0]!,
      input.currency,
      Math.max(0, sorted.length - 1),
      currentAdCampaignContexts,
    );
  });
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
        (b.campaign.metrics.spend ?? -1) -
          (a.campaign.metrics.spend ?? -1) ||
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
    const item = adDecision(decision, currentAdCampaignContexts);
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
    .sort((a, b) => {
      const laneWeight: Record<MetaOsDecisionLane, number> = {
        act: 3,
        blocked: 2,
        monitor: 1,
      };
      return (
        laneWeight[b.lane] - laneWeight[a.lane] ||
        (b.priority.rank ?? -1) - (a.priority.rank ?? -1) ||
        a.adId.localeCompare(b.adId)
      );
    });
  const canonicalAdIds = new Set(canonicalAds.map((item) => item.adId));
  const pendingInventoryAds = (input.currentAds ?? [])
    .map((row) =>
      activeInventoryAd(row, input.currency, currentAdCampaignContexts),
    )
    .filter((item): item is MetaOsAdDecision => Boolean(item))
    .filter((item) => !canonicalAdIds.has(item.adId))
    .sort((left, right) => left.adId.localeCompare(right.adId));
  const adLimit =
    input.decisionReadModel.queue?.adCandidates?.limit ??
    canonicalAds.length + pendingInventoryAds.length;
  const ads = [...canonicalAds, ...pendingInventoryAds].slice(0, adLimit);
  const pendingInventoryPreCapCount = pendingInventoryAds.length;

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
      statePreCapCounts: {
        act:
          input.decisionReadModel.queue?.adCandidates?.stateCounts?.act
            ?.preCapCount ?? ads.filter((item) => item.lane === "act").length,
        blocked:
          (input.decisionReadModel.queue?.adCandidates?.stateCounts?.blocked
            ?.preCapCount ??
            canonicalAds.filter((item) => item.lane === "blocked").length) +
          pendingInventoryPreCapCount,
        monitor:
          input.decisionReadModel.queue?.adCandidates?.stateCounts?.monitor
            ?.preCapCount ??
          ads.filter((item) => item.lane === "monitor").length,
      },
      eligiblePreCapCount: Math.max(
        input.decisionReadModel.queue?.adCandidates?.eligiblePreCapCount ??
          canonicalAds.length,
        canonicalAds.length + pendingInventoryPreCapCount,
      ),
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
              message: `${pendingInventoryPreCapCount} ACTIVE Ads are visible from the current provider inventory but remain blocked until exact Ad-grain decisions exist.`,
            },
          ]
        : []),
    ],
  };
}
