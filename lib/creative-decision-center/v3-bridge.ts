/**
 * V3 DecisionOutput -> Creative Decision Center v2.1 bridge.
 *
 * This module translates an already-produced active V3 output into the
 * V2.1 engine-root object consumed by the existing shadow buyer adapter.
 * It does not call V3 gates/resolvers and it does not inspect raw platform
 * signals. All behavior here is deterministic mapping policy from D022 and
 * V3_TO_V21_MAPPING.md.
 */

import type {
  DecisionBadge,
  DecisionLabel,
  DecisionOutput,
} from "@/lib/creative-decision-engine/types";

import type {
  CreativeDecisionCenterAdapterContext,
  CreativeDecisionCenterAdapterInput,
} from "./adapter";
import {
  CREATIVE_DECISION_OS_V21_CONTRACT_VERSION,
  type CreativeDecisionCenterActionability,
  type CreativeDecisionCenterIdentityGrain,
  type CreativeDecisionCenterMaturity,
  type CreativeDecisionCenterPriority,
  type CreativeDecisionCenterProblemClass,
  type CreativeDecisionOsV21Output,
  type CreativeDecisionOsV21PrimaryDecision,
} from "./contracts";

export const CREATIVE_DECISION_CENTER_V3_BRIDGE_VERSION =
  "creative-decision-center.v3-bridge.v1";

type V3BadgeType = DecisionBadge["type"];

type BridgeCampaignKind = CreativeDecisionCenterAdapterContext["campaignKind"];

export interface CreativeDecisionCenterV3BridgeContext {
  creativeId?: string;
  rowId?: string;
  identityGrain?: CreativeDecisionCenterIdentityGrain;
  familyId?: string | null;
  campaignKind?: BridgeCampaignKind;
  dataHealthDegraded?: boolean;
}

export type V3BridgeOmitReason = "plain_keep_no_action" | "out_of_scope";

export interface V3BridgeMappedTrace {
  sourceLabel: DecisionLabel;
  labelTransform: DecisionOutput["labelTransform"] | null;
  mappedPrimaryDecision: CreativeDecisionOsV21PrimaryDecision;
  problemClass: CreativeDecisionCenterProblemClass;
  missingData: string[];
  reasonTags: string[];
}

export interface V3BridgeOmittedTrace {
  sourceLabel: DecisionLabel;
  labelTransform: DecisionOutput["labelTransform"] | null;
  reasonTags: string[];
}

export interface V3BridgeMappedResult {
  kind: "mapped";
  engine: CreativeDecisionOsV21Output;
  adapterInput: CreativeDecisionCenterAdapterInput;
  sourceDecision: string;
  trace: V3BridgeMappedTrace;
}

export interface V3BridgeOmittedResult {
  kind: "omitted";
  omitReason: V3BridgeOmitReason;
  sourceDecision: string;
  trace: V3BridgeOmittedTrace;
}

export type V3BridgeResult = V3BridgeMappedResult | V3BridgeOmittedResult;

interface MappingDecision {
  primaryDecision: CreativeDecisionOsV21PrimaryDecision;
  problemClass: CreativeDecisionCenterProblemClass;
  actionability: CreativeDecisionCenterActionability;
  reasonTags: string[];
}

interface MissingDataDecision {
  missingData: string[];
  missingReasonTags: string[];
}

const DATA_QUALITY_BADGES = new Set<V3BadgeType>([
  "tracking_anomaly",
  "truth_account_baseline_thin",
  "truth_global_default",
  "missing_recent_data",
  "stale_evidence",
  "stale_calibration",
  "stale_lifecycle",
  "stale_decision_context",
  "lifecycle_unavailable",
  "scale_calibration_thin",
]);

const FATIGUE_BADGES = new Set<V3BadgeType>([
  "fatigue_watch",
  "fatigue_fatigued",
]);

const PERFORMANCE_BADGES = new Set<V3BadgeType>([
  "cut_candidate",
  "low_ctr",
  "weak_performance",
  "below_breakeven",
  "landing_page_issue",
  "checkout_breakdown",
  "upper_funnel_strong_site_weak",
  "stop_loss_review",
]);

const REVIEW_WORTHY_KEEP_BADGES = new Set<V3BadgeType>([
  "pending_transition",
  "campaign_context_unresolved",
  "unlabeled_campaign_context",
  "scale_readiness_blocked",
  "scale_calibration_thin",
  "weak_performance",
  "low_ctr",
  "below_breakeven",
  "stop_loss_review",
]);

const HARD_V3_ACTION_LABELS = new Set<DecisionLabel>([
  "scale",
  "cut",
  "refresh",
]);

function hasBadge(
  decision: DecisionOutput,
  badgeType: V3BadgeType,
): boolean {
  return decision.badges.some((badge) => badge.type === badgeType);
}

function hasAnyBadge(
  decision: DecisionOutput,
  badgeTypes: ReadonlySet<V3BadgeType>,
): boolean {
  return decision.badges.some((badge) => badgeTypes.has(badge.type));
}

function uniqueStable(values: readonly string[]): string[] {
  return Array.from(new Set(values)).sort();
}

function sourceDecisionFor(decision: DecisionOutput): string {
  return decision.labelTransform ?? `v3:${decision.label}`;
}

/**
 * Local fail-closed role-status fold (D074b acceptance correction). The
 * module-isolation contract forbids value imports from the active engine, so
 * this mirrors lib/creative-decision-engine/campaign-label-guard's
 * resolveCampaignRoleStatus exactly; the vocabulary-closure test pins both.
 * Only an uncontradicted canonical "resolved" avoids the campaign-context
 * gap: legacy-only "labeled", missing status, and contradictions all gap.
 */
function bridgeCampaignRoleStatus(
  decision: DecisionOutput,
): "resolved" | "unresolved" | "no_campaign" {
  const canonical = decision.campaignRoleStatus ?? null;
  const legacy = decision.campaignLabelStatus ?? null;
  if (canonical !== null && legacy !== null) {
    const sameClaim =
      (canonical === "resolved" && legacy === "labeled") ||
      (canonical === "unresolved" && legacy === "unlabeled") ||
      (canonical === "no_campaign" && legacy === "no_campaign");
    return sameClaim ? canonical : "unresolved";
  }
  if (canonical !== null) return canonical;
  if (legacy === "no_campaign") return "no_campaign";
  return "unresolved";
}

function hasCampaignLabelGap(decision: DecisionOutput): boolean {
  return (
    hasBadge(decision, "campaign_context_unresolved") ||
    hasBadge(decision, "unlabeled_campaign_context") ||
    bridgeCampaignRoleStatus(decision) !== "resolved"
  );
}

function normalizedCampaignKind(
  decision: DecisionOutput,
  context: CreativeDecisionCenterV3BridgeContext,
): BridgeCampaignKind {
  return context.campaignKind ?? decision.campaignKind ?? null;
}

function deriveBridgeContext(
  decision: DecisionOutput,
  context: CreativeDecisionCenterV3BridgeContext = {},
): CreativeDecisionCenterAdapterContext {
  return {
    creativeId: context.creativeId ?? decision.creativeId,
    rowId: context.rowId,
    identityGrain: context.identityGrain ?? "creative",
    familyId: context.familyId ?? null,
    campaignKind: normalizedCampaignKind(decision, context),
  };
}

function deriveMissingData(
  decision: DecisionOutput,
  context: CreativeDecisionCenterV3BridgeContext,
  mapping: MappingDecision,
): MissingDataDecision {
  const missingData: string[] = [];
  const missingReasonTags: string[] = [];

  if (context.dataHealthDegraded) {
    missingData.push("data_health");
    missingReasonTags.push("data_health_degraded");
  }

  if (
    decision.truthSource === "account_baseline_thin" ||
    decision.truthSource === "global_default" ||
    hasBadge(decision, "truth_account_baseline_thin") ||
    hasBadge(decision, "truth_global_default")
  ) {
    missingData.push("truth");
    missingReasonTags.push("truth_degraded");
  }

  if (hasBadge(decision, "tracking_anomaly")) {
    missingData.push("tracking");
    missingReasonTags.push("tracking_anomaly_present");
  }

  if (hasBadge(decision, "missing_recent_data")) {
    missingData.push("freshness");
  }

  if (hasBadge(decision, "stale_evidence")) {
    missingData.push("stale_evidence");
    missingReasonTags.push("stale_evidence");
  }

  if (
    hasBadge(decision, "delivery_limited") &&
    mapping.primaryDecision === "Diagnose"
  ) {
    missingData.push("delivery_proof");
  }

  if (hasBadge(decision, "scale_calibration_thin")) {
    missingData.push("scale_calibration");
  }

  return {
    missingData: uniqueStable(missingData),
    missingReasonTags: uniqueStable(missingReasonTags),
  };
}

function deriveProblemClass(
  decision: DecisionOutput,
  label: DecisionLabel,
): CreativeDecisionCenterProblemClass {
  if (hasBadge(decision, "policy_blocked")) return "policy";
  if (hasBadge(decision, "delivery_no_spend_24h")) return "delivery";
  if (hasBadge(decision, "launch_monitoring")) return "launch_monitoring";
  if (hasAnyBadge(decision, DATA_QUALITY_BADGES)) return "data_quality";
  if (hasCampaignLabelGap(decision)) return "campaign_context";
  if (hasAnyBadge(decision, FATIGUE_BADGES)) return "fatigue";
  if (hasBadge(decision, "delivery_limited")) return "data_quality";
  if (hasAnyBadge(decision, PERFORMANCE_BADGES)) return "performance";

  if (label === "diagnose") return "data_quality";
  if (label === "test_more") return "insufficient_signal";
  if (label === "refresh") return "creative";
  return "performance";
}

function mapKeep(
  decision: DecisionOutput,
): MappingDecision | V3BridgeOmitReason {
  if (hasBadge(decision, "pending_transition")) {
    return {
      primaryDecision: "Test More",
      problemClass: "insufficient_signal",
      actionability: "review_only",
      reasonTags: ["pending_hard_action"],
    };
  }

  if (hasCampaignLabelGap(decision)) {
    return {
      primaryDecision: "Diagnose",
      problemClass: "campaign_context",
      actionability: "diagnose",
      reasonTags: ["campaign_role_unresolved"],
    };
  }

  if (hasBadge(decision, "scale_readiness_blocked")) {
    return {
      primaryDecision: "Test More",
      problemClass: "insufficient_signal",
      actionability: "review_only",
      reasonTags: ["near_scale_blocked"],
    };
  }

  if (hasBadge(decision, "scale_calibration_thin")) {
    return {
      primaryDecision: "Test More",
      problemClass: "data_quality",
      actionability: "review_only",
      reasonTags: ["scale_calibration_thin"],
    };
  }

  for (const badgeType of ["weak_performance", "low_ctr", "below_breakeven"] as const) {
    if (hasBadge(decision, badgeType)) {
      return {
        primaryDecision: "Test More",
        problemClass: "insufficient_signal",
        actionability: "review_only",
        reasonTags: [badgeType],
      };
    }
  }

  if (!hasAnyBadge(decision, REVIEW_WORTHY_KEEP_BADGES)) {
    return {
      primaryDecision: "Protect",
      problemClass: "performance",
      actionability: "review_only",
      reasonTags: ["v3_keep", "stable_keep_running"],
    };
  }

  return {
    primaryDecision: "Protect",
    problemClass: deriveProblemClass(decision, decision.label),
    actionability: "review_only",
    reasonTags: ["v3_keep", "stable_keep_running"],
  };
}

function mapDecision(
  decision: DecisionOutput,
): MappingDecision | V3BridgeOmitReason {
  if (
    HARD_V3_ACTION_LABELS.has(decision.label) &&
    hasCampaignLabelGap(decision)
  ) {
    return {
      primaryDecision: "Diagnose",
      problemClass: deriveProblemClass(decision, decision.label),
      actionability: "diagnose",
      reasonTags: ["campaign_role_unresolved"],
    };
  }

  switch (decision.label) {
    case "scale":
      return {
        primaryDecision: "Scale",
        problemClass: "performance",
        actionability: "review_only",
        reasonTags: ["v3_scale"],
      };
    case "cut":
      return {
        primaryDecision: "Cut",
        problemClass: "performance",
        actionability: "review_only",
        reasonTags: ["v3_cut"],
      };
    case "refresh":
      return {
        primaryDecision: "Refresh",
        problemClass: hasAnyBadge(decision, FATIGUE_BADGES)
          ? "fatigue"
          : "creative",
        actionability: "review_only",
        reasonTags: ["v3_refresh"],
      };
    case "test_more":
      return {
        primaryDecision: "Test More",
        problemClass: hasBadge(decision, "launch_monitoring")
          ? "launch_monitoring"
          : "insufficient_signal",
        actionability: "review_only",
        reasonTags: hasBadge(decision, "launch_monitoring")
          ? ["v3_test_more", "launch_monitoring"]
          : ["v3_test_more"],
      };
    case "diagnose":
      return {
        primaryDecision: "Diagnose",
        problemClass: deriveProblemClass(decision, decision.label),
        actionability: "diagnose",
        reasonTags: ["v3_diagnose"],
      };
    case "keep":
      return mapKeep(decision);
    case "out_of_scope":
      return {
        primaryDecision: "Protect",
        problemClass: "performance",
        actionability: "review_only",
        reasonTags: ["v3_out_of_scope", "compat_not_applicable"],
      };
  }
}

function deriveMaturity(decision: DecisionOutput): CreativeDecisionCenterMaturity {
  const spend = decision.metrics?.spend;
  const purchases = decision.metrics?.purchases;

  if (!Number.isFinite(spend) || !Number.isFinite(purchases) || spend <= 0) {
    return "too_early";
  }
  if (purchases === 0) return "learning";
  if (decision.confidence < 70) return "actionable";
  return "mature";
}

function derivePriority(
  decision: DecisionOutput,
  context: CreativeDecisionCenterV3BridgeContext,
  mapping: MappingDecision,
): CreativeDecisionCenterPriority {
  if (
    context.dataHealthDegraded ||
    (mapping.problemClass === "data_quality" && decision.label === "diagnose")
  ) {
    return "high";
  }
  if (
    (decision.label === "scale" ||
      decision.label === "cut" ||
      decision.label === "refresh") &&
    decision.confidence >= 70
  ) {
    return "high";
  }
  if (decision.confidence >= 40) return "medium";
  return "low";
}

function finiteConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
}

function evidenceSummaryFor(decision: DecisionOutput): string {
  const reason = decision.reason.trim();
  if (reason.length > 0) return reason;
  return `V3 ${decision.label} decision.`;
}

function buildReasonTags(
  decision: DecisionOutput,
  mappingTags: readonly string[],
  missingTags: readonly string[],
): string[] {
  const badgeTags = decision.badges.map((badge) => badge.type);
  const labelTag = `v3_${decision.label}`;
  return uniqueStable([...badgeTags, labelTag, ...mappingTags, ...missingTags]);
}

function buildBlockerReasons(
  mapping: MappingDecision,
  missingData: readonly string[],
): string[] {
  const blockers = [...missingData];
  if (mapping.reasonTags.includes("campaign_role_unresolved")) {
    blockers.push("campaign_role_unresolved");
  }
  return uniqueStable(blockers);
}

function buildOmittedResult(
  decision: DecisionOutput,
  omitReason: V3BridgeOmitReason,
): V3BridgeOmittedResult {
  const reasonTags = buildReasonTags(decision, [omitReason], []);
  return {
    kind: "omitted",
    omitReason,
    sourceDecision: sourceDecisionFor(decision),
    trace: {
      sourceLabel: decision.label,
      labelTransform: decision.labelTransform ?? null,
      reasonTags,
    },
  };
}

export function bridgeV3DecisionToV21(input: {
  decision: DecisionOutput;
  context?: CreativeDecisionCenterV3BridgeContext;
}): V3BridgeResult {
  const { decision } = input;
  const context = input.context ?? {};
  const mapping = mapDecision(decision);

  if (typeof mapping === "string") {
    return buildOmittedResult(decision, mapping);
  }

  const missingData = deriveMissingData(decision, context, mapping);
  const reasonTags = buildReasonTags(
    decision,
    mapping.reasonTags,
    missingData.missingReasonTags,
  );
  const engine: CreativeDecisionOsV21Output = {
    contractVersion: CREATIVE_DECISION_OS_V21_CONTRACT_VERSION,
    engineVersion: decision.engineVersion,
    primaryDecision: mapping.primaryDecision,
    actionability:
      mapping.primaryDecision === "Diagnose" ? "diagnose" : mapping.actionability,
    problemClass: mapping.problemClass,
    confidence: finiteConfidence(decision.confidence),
    maturity: deriveMaturity(decision),
    priority: derivePriority(decision, context, mapping),
    reasonTags,
    evidenceSummary: evidenceSummaryFor(decision),
    blockerReasons: buildBlockerReasons(mapping, missingData.missingData),
    missingData: missingData.missingData,
    queueEligible: false,
    applyEligible: false,
  };
  const adapterInput: CreativeDecisionCenterAdapterInput = {
    engine,
    context: deriveBridgeContext(decision, context),
    sourceDecision: sourceDecisionFor(decision),
  };

  return {
    kind: "mapped",
    engine,
    adapterInput,
    sourceDecision: adapterInput.sourceDecision ?? sourceDecisionFor(decision),
    trace: {
      sourceLabel: decision.label,
      labelTransform: decision.labelTransform ?? null,
      mappedPrimaryDecision: mapping.primaryDecision,
      problemClass: mapping.problemClass,
      missingData: missingData.missingData,
      reasonTags,
    },
  };
}

export function bridgeV3DecisionToAdapterInput(input: {
  decision: DecisionOutput;
  context?: CreativeDecisionCenterV3BridgeContext;
}): CreativeDecisionCenterAdapterInput | null {
  const result = bridgeV3DecisionToV21(input);
  return result.kind === "mapped" ? result.adapterInput : null;
}

export function bridgeV3DecisionsToAdapterInputs(
  inputs: readonly {
    decision: DecisionOutput;
    context?: CreativeDecisionCenterV3BridgeContext;
  }[],
): CreativeDecisionCenterAdapterInput[] {
  return inputs.flatMap((input) => {
    const adapterInput = bridgeV3DecisionToAdapterInput(input);
    return adapterInput ? [adapterInput] : [];
  });
}
