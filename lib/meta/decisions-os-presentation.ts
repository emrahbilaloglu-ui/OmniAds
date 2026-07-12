import type {
  MetaCanonicalDecision,
  MetaDecisionsWorkspaceReadModel,
} from "@/lib/meta/decisions-workspace-contract";
import type { MetaRecommendation } from "@/lib/meta/recommendations";
import {
  META_OS_DECISIONS_PRESENTATION_VERSION,
  type MetaOsAdDecision,
  type MetaOsCommandIntent,
  type MetaOsDecisionAction,
  type MetaOsDecisionLane,
  type MetaOsDecisionPriority,
  type MetaOsDecisionsPresentation,
  type MetaOsStructureGroup,
  type MetaOsStructureNode,
} from "@/lib/meta/decisions-os-contract";

type StructureInput = {
  rec: MetaRecommendation;
  lane: MetaOsDecisionLane;
};

const PRIORITY_WEIGHT = { high: 3, medium: 2, low: 1 } as const;
const CONFIDENCE_WEIGHT = { high: 3, medium: 2, low: 1 } as const;

function finite(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function priorityForRecommendation(rec: MetaRecommendation): MetaOsDecisionPriority {
  return {
    band: rec.priority,
    rank: PRIORITY_WEIGHT[rec.priority] * 100 + CONFIDENCE_WEIGHT[rec.confidence] * 10,
    version: META_OS_DECISIONS_PRESENTATION_VERSION,
  };
}

function priorityForDecision(decision: MetaCanonicalDecision): MetaOsDecisionPriority {
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

function lifecycleRole(rec: MetaRecommendation): MetaOsStructureNode["lifecycleRole"] {
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
  if (rec.type === "scenario_i2_abo_to_cbo" || rec.type === "scenario_k1_mixed_config_rebuild") {
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
      scopeNote: "Complete the missing server evidence before changing provider state",
    };
  }

  if (
    (rec.decisionLabel === "scale" && !/^(increase|reduce)\b.*\bbudget\b/i.test(label)) ||
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
  return {
    id: `${rec.level}:${providerEntityId ?? rec.id}`,
    sourceRecommendationId: rec.id,
    level: rec.level === "adset" ? "adset" : "campaign",
    providerEntityId,
    campaignId,
    campaignName: rec.campaignName?.trim() || null,
    name,
    lifecycleRole: lifecycleRole(rec),
    ...ownership,
    status: rec.entityConfiguration?.status ?? null,
    optimizationGoal: rec.entityConfiguration?.optimizationGoal ?? null,
    action: structureAction(rec, ownership),
    lane: input.lane,
    priority: priorityForRecommendation(rec),
    confidence: rec.confidence,
    assessment: assessmentForRecommendation(rec),
    whyNow: rec.why || rec.summary || "Evidence unavailable.",
    expectedImpact: rec.expectedImpact || "Cannot calculate",
    evidence: rec.evidence ?? [],
    metrics: recommendationMetrics(rec, currency),
    suppressedAlternativeCount,
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
    budgetMode: child.budgetMode === "adset_budget" ? "adset_budget" : "unknown",
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
  if (assessment === "above_target_not_scale_ready") return "Above Target · Not Proven";
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
): { action: MetaOsDecisionAction; lane: MetaOsDecisionLane } {
  const buyerAction = decision.classification.buyerAction;
  const role = decision.classification.lifecycleRole.value;
  const targetLevel = "ad" as const;
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
          scopeNote: "Creates a PAUSED Main copy after an eligible target is reviewed",
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
        intent: "review",
        providerMutation: null,
        scopeNote: "Pauses this ad only",
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
        scopeNote: "Keeps this ad running and re-evaluates the next eligible snapshot",
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

function adDecision(
  decision: MetaCanonicalDecision,
): MetaOsAdDecision | null {
  const ad = decision.parentChain.ad;
  if (!ad?.id?.trim() || !/^\d+$/.test(ad.id.trim())) return null;
  if (decision.identityResolution && !decision.identityResolution.adActionEligible) {
    return null;
  }
  const mapped = adAction(decision);
  return {
    id: `ad:${ad.id}`,
    decisionId: decision.decisionId,
    sourceSnapshotId: decision.sourceSnapshotId,
    episodeId: decision.episodeId,
    providerAccountId: decision.providerAccountId,
    adId: ad.id,
    adName: ad.name?.trim() || decision.parentChain.creative.name?.trim() || ad.id,
    campaignId: decision.parentChain.campaign?.id ?? null,
    campaignName: decision.parentChain.campaign?.name ?? null,
    adsetId: decision.parentChain.adset?.id ?? null,
    adsetName: decision.parentChain.adset?.name ?? null,
    creativeId: decision.parentChain.creative.id,
    creativeName: decision.parentChain.creative.name,
    thumbnailUrl: decision.media.thumbnail.url,
    lifecycleRole: decision.classification.lifecycleRole.value,
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
      grain: "creative_context",
    },
    rawLabel: decision.sourceDecision.rawLabel,
    publishedLabel: decision.sourceDecision.label,
    engineVersion: decision.sourceDecision.engineVersion,
    snapshotAsOf: decision.sourceDecision.snapshotAsOf,
    sourceGrain: "creative_context",
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
  decisionReadModel: MetaDecisionsWorkspaceReadModel;
  currency: string | null;
  generatedAt?: string;
}): MetaOsDecisionsPresentation {
  const structureInputs: StructureInput[] = [
    ...input.actionNow.map((rec) => ({ rec, lane: "act" as const })),
    ...input.watching.map((rec) => ({ rec, lane: "monitor" as const })),
    ...input.nonSales.map((rec) => ({
      rec,
      lane: rec.decisionState === "act" ? ("act" as const) : ("monitor" as const),
    })),
  ]
    .filter((item) => item.rec.level === "campaign" || item.rec.level === "adset")
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

  const selectedNodes = Array.from(entityBuckets.values()).map((bucket) => {
    const sorted = bucket.slice().sort(compareStructureInputs);
    return structureNode(sorted[0]!, input.currency, Math.max(0, sorted.length - 1));
  });
  const campaignNodes = selectedNodes.filter((node) => node.level === "campaign");
  const adsetNodes = selectedNodes.filter((node) => node.level === "adset");
  const groupsByCampaign = new Map<string, MetaOsStructureGroup>();

  for (const campaign of campaignNodes) {
    const key = campaign.campaignId ?? campaign.id;
    groupsByCampaign.set(key, {
      id: `group:${key}`,
      campaign,
      adsets: [],
      highestPriority: campaign.priority,
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
      };
      groupsByCampaign.set(key, group);
    }
    group.adsets.push(adset);
    if ((adset.priority.rank ?? -1) > (group.highestPriority.rank ?? -1)) {
      group.highestPriority = adset.priority;
    }
  }

  const groups = Array.from(groupsByCampaign.values())
    .map((group) => ({
      ...group,
      adsets: group.adsets.sort(
        (a, b) => (b.priority.rank ?? -1) - (a.priority.rank ?? -1) || a.id.localeCompare(b.id),
      ),
    }))
    .sort(
      (a, b) =>
        (b.highestPriority.rank ?? -1) - (a.highestPriority.rank ?? -1) ||
        a.id.localeCompare(b.id),
    );

  const canonical = adCandidateItems(input.decisionReadModel);
  let omittedWithoutVerifiedAdId =
    input.decisionReadModel.queue?.adCandidates
      ?.omittedWithoutVerifiedAdId ?? 0;
  let omittedAmbiguousIdentity =
    input.decisionReadModel.queue?.adCandidates
      ?.omittedAmbiguousIdentity ?? 0;
  const omittedNotApplicable =
    input.decisionReadModel.queue?.adCandidates?.omittedNotApplicable ?? 0;
  const countsProvidedByCandidateEnvelope = Boolean(
    input.decisionReadModel.queue?.adCandidates,
  );
  const adBuckets = new Map<string, MetaOsAdDecision[]>();
  for (const decision of canonical) {
    const item = adDecision(decision);
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
  const ads = Array.from(adBuckets.values())
    .map((bucket) =>
      bucket.sort(
        (a, b) =>
          (b.priority.rank ?? -1) - (a.priority.rank ?? -1) ||
          a.decisionId.localeCompare(b.decisionId),
      )[0]!,
    )
    .sort(
      (a, b) => {
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
      },
    );

  const allStructureNodes = groups.flatMap((group) => [group.campaign, ...group.adsets]);
  return {
    contractVersion: META_OS_DECISIONS_PRESENTATION_VERSION,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    source: {
      snapshotAsOf: input.decisionReadModel.source?.snapshotAsOf ?? null,
      engineVersion: input.decisionReadModel.source?.engineVersion ?? null,
      structureSource: "meta_recommendations",
      adsSource: "creative_decision_with_verified_ad_identity",
    },
    structure: {
      groups,
      actCount: allStructureNodes.filter((node) => node.lane === "act").length,
      blockedCount: allStructureNodes.filter((node) => node.lane === "blocked").length,
      monitorCount: allStructureNodes.filter((node) => node.lane === "monitor").length,
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
          input.decisionReadModel.queue?.adCandidates?.stateCounts?.blocked
            ?.preCapCount ?? ads.filter((item) => item.lane === "blocked").length,
        monitor:
          input.decisionReadModel.queue?.adCandidates?.stateCounts?.monitor
            ?.preCapCount ?? ads.filter((item) => item.lane === "monitor").length,
      },
      eligiblePreCapCount:
        input.decisionReadModel.queue?.adCandidates?.eligiblePreCapCount ??
        ads.length,
      omittedWithoutVerifiedAdId,
      omittedAmbiguousIdentity,
      omittedNotApplicable,
      sourcePreCapCount: input.decisionReadModel.queue?.sourcePreCapCount ?? 0,
    },
    limitations: [
      {
        code: "ad_metrics_are_creative_context",
        message:
          "Ad rows use an exact provider ad identity, but the current decision metrics remain creative-grain context.",
      },
      {
        code: "ad_reuse_not_expanded",
        message:
          "A creative reused by multiple ads is not expanded until an ad-grain decision producer is persisted.",
      },
    ],
  };
}
