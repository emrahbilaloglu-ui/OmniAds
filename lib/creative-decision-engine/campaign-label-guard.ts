import type {
  MetaCampaignKind,
  MetaCampaignLabel,
  MetaCampaignTestDimension,
} from "@/lib/meta/campaign-label-types";
import type {
  CreativeInput,
  DecisionBadge,
  DecisionLabel,
  DecisionOutput,
} from "./types";
import { CREATIVE_CAMPAIGN_LABEL_CONFIDENCE_CAP } from "./config-values";

export const CREATIVE_CAMPAIGN_LABEL_GUARD_PREFIX =
  "[Unlabeled campaign - label to enable action]";
export const CAMPAIGN_CONTEXT_UNRESOLVED_GUARD_PREFIX =
  "[Campaign context unresolved - review before hard action]";
export const CAMPAIGN_CONTEXT_LOW_CONFIDENCE_GUARD_PREFIX =
  "[Campaign context low confidence - hard action restricted]";
export { CREATIVE_CAMPAIGN_LABEL_CONFIDENCE_CAP } from "./config-values";

/**
 * Trust class of a campaign context entry (D033).
 *
 * Absent trust (legacy meta_campaign_labels rows) and "override"/"high" are
 * fully trusted: current labeled behavior. "medium" restricts kind semantics
 * (no kind-aware calibration or Test transforms; hard scale/refresh demote;
 * mature cut stays visible with a low-confidence badge). "low"/"unknown"
 * behave like today's unlabeled guard with automatic-context badges.
 * "conflict" is unresolved with conflict evidence.
 */
export type CreativeCampaignContextTrust =
  | "override"
  | "high"
  | "medium"
  | "low"
  | "unknown"
  | "conflict";

export interface CreativeCampaignContextEntry
  extends Pick<MetaCampaignLabel, "testDimension"> {
  kind: MetaCampaignKind | null;
  contextTrust?: CreativeCampaignContextTrust;
}

export type CreativeCampaignLabelMap = ReadonlyMap<
  string,
  CreativeCampaignContextEntry
>;

interface CreativeCampaignLabelGuardInput {
  decision: DecisionOutput;
  input: Pick<CreativeInput, "campaignId">;
  campaignLabelsById: CreativeCampaignLabelMap | null | undefined;
}

const HARD_DECISION_LABELS = new Set<DecisionLabel>([
  "scale",
  "cut",
  "refresh",
]);

function isHardDecision(label: DecisionLabel) {
  return HARD_DECISION_LABELS.has(label);
}

function hasUnlabeledBadge(badges: readonly DecisionBadge[]) {
  return badges.some((badge) => badge.type === "unlabeled_campaign_context");
}

function withUnlabeledBadge(badges: readonly DecisionBadge[]): DecisionBadge[] {
  if (hasUnlabeledBadge(badges)) return [...badges];
  return [
    ...badges,
    {
      type: "unlabeled_campaign_context",
      label: "Campaign label missing - Main/Test/Mixed required before hard action",
      severity: "warning",
    },
  ];
}

function withStopLossReviewBadge(badges: readonly DecisionBadge[]): DecisionBadge[] {
  if (badges.some((badge) => badge.type === "stop_loss_review")) {
    return [...badges];
  }
  return [
    ...badges,
    {
      type: "stop_loss_review",
      label: "Stop-loss review - campaign label required before action",
      severity: "warning",
    },
  ];
}

function withCampaignContext(
  decision: DecisionOutput,
  context: {
    status: DecisionOutput["campaignLabelStatus"];
    kind?: MetaCampaignKind | null;
    testDimension?: MetaCampaignTestDimension | null;
    blockedActionType?: DecisionLabel | null;
    badges?: DecisionBadge[];
  },
): DecisionOutput {
  return {
    ...decision,
    campaignLabelStatus: context.status,
    campaignKind: context.kind ?? null,
    campaignTestDimension: context.testDimension ?? null,
    blockedActionType:
      context.blockedActionType === undefined
        ? (decision.blockedActionType ?? null)
        : context.blockedActionType,
    badges: context.badges ?? decision.badges,
  };
}

function isAlreadyGuarded(decision: DecisionOutput) {
  return (
    (decision.campaignLabelStatus === "unlabeled" ||
      decision.campaignLabelStatus === "no_campaign") &&
    decision.label === "diagnose" &&
    (decision.blockedActionType != null ||
      decision.reason.startsWith(CREATIVE_CAMPAIGN_LABEL_GUARD_PREFIX))
  );
}

type ContextGuardBadgeType =
  | "campaign_context_unresolved"
  | "campaign_context_low_confidence"
  | "campaign_context_conflict";

const CONTEXT_BADGE_LABELS: Record<ContextGuardBadgeType, string> = {
  campaign_context_unresolved:
    "Campaign context unresolved - automatic role could not be determined; review structure before hard action",
  campaign_context_low_confidence:
    "Campaign context low confidence - kind-specific semantics disabled",
  campaign_context_conflict:
    "Campaign context conflict - signals disagree; review structure before hard action",
};

function withContextBadge(
  badges: readonly DecisionBadge[],
  type: ContextGuardBadgeType,
): DecisionBadge[] {
  if (badges.some((badge) => badge.type === type)) return [...badges];
  return [
    ...badges,
    { type, label: CONTEXT_BADGE_LABELS[type], severity: "warning" },
  ];
}

function guardHardDecisionWithContext(
  decision: DecisionOutput,
  options: {
    status: DecisionOutput["campaignLabelStatus"];
    badgeType: ContextGuardBadgeType;
    prefix: string;
  },
): DecisionOutput {
  const originalLabel = decision.label;
  const badges = withContextBadge(decision.badges, options.badgeType);
  const guardedBadges =
    originalLabel === "cut" ? withStopLossReviewBadge(badges) : badges;

  return withCampaignContext(
    {
      ...decision,
      // Automatic context uncertainty must not erase the mathematical verdict.
      // Keep the explicit label and carry the blockedActionType/badge so every
      // serving surface can present it as review-only without inventing a new
      // decision client-side.
      label: originalLabel,
      confidence: Math.min(
        decision.confidence,
        CREATIVE_CAMPAIGN_LABEL_CONFIDENCE_CAP,
      ),
      reason: `${options.prefix} ${decision.reason}`,
      badges: guardedBadges,
    },
    {
      status: options.status,
      kind: null,
      testDimension: null,
      blockedActionType: originalLabel,
      badges: guardedBadges,
    },
  );
}

function guardHardDecisionWithoutCampaignLabel(
  decision: DecisionOutput,
  status: DecisionOutput["campaignLabelStatus"],
): DecisionOutput {
  const originalLabel = decision.label;
  const badges = withUnlabeledBadge(decision.badges);
  const guardedBadges =
    originalLabel === "cut" ? withStopLossReviewBadge(badges) : badges;
  const guardPrefix =
    originalLabel === "cut"
      ? "[Stop-loss review - label campaign before cut]"
      : CREATIVE_CAMPAIGN_LABEL_GUARD_PREFIX;

  return withCampaignContext(
    {
      ...decision,
      label: "diagnose",
      confidence: Math.min(
        decision.confidence,
        CREATIVE_CAMPAIGN_LABEL_CONFIDENCE_CAP,
      ),
      reason: `${guardPrefix} ${decision.reason}`,
      badges: guardedBadges,
    },
    {
      status,
      kind: null,
      testDimension: null,
      blockedActionType: originalLabel,
      badges: guardedBadges,
    },
  );
}

export function buildCreativeCampaignLabelMap(
  labels: Array<Pick<MetaCampaignLabel, "campaignId" | "kind" | "testDimension">>,
): CreativeCampaignLabelMap {
  return new Map(
    labels.map((label) => [
      label.campaignId,
      {
        kind: label.kind,
        testDimension: label.testDimension,
      },
    ]),
  );
}

function isTrustedForKindSemantics(
  entry: CreativeCampaignContextEntry | null | undefined,
): entry is CreativeCampaignContextEntry & { kind: MetaCampaignKind } {
  if (!entry) return false;
  if (entry.kind === null) return false;
  const trust = entry.contextTrust;
  return trust === undefined || trust === "override" || trust === "high";
}

export function withCreativeCampaignLabelContext<T extends Pick<CreativeInput, "campaignId">>(
  input: T,
  campaignLabelsById: CreativeCampaignLabelMap | null | undefined,
): T & Pick<CreativeInput, "campaignKind"> {
  const campaignId = input.campaignId?.trim() || null;
  const entry = campaignId ? (campaignLabelsById?.get(campaignId) ?? null) : null;
  return {
    ...input,
    // Kind semantics (kind-aware calibration, Test transforms) require full
    // trust; medium/low/unknown/conflict automatic context stays canonical.
    campaignKind: isTrustedForKindSemantics(entry) ? entry!.kind : null,
  };
}

export function applyCreativeCampaignLabelGuard({
  decision,
  input,
  campaignLabelsById,
}: CreativeCampaignLabelGuardInput): DecisionOutput {
  const campaignId = input.campaignId?.trim() || null;
  if (!campaignId) {
    if (isAlreadyGuarded(decision)) {
      return withCampaignContext(decision, {
        status: "no_campaign",
        kind: null,
        testDimension: null,
        badges: withUnlabeledBadge(decision.badges),
      });
    }

    if (isHardDecision(decision.label)) {
      return guardHardDecisionWithoutCampaignLabel(decision, "no_campaign");
    }

    return withCampaignContext(decision, {
      status: "no_campaign",
      kind: null,
      testDimension: null,
      blockedActionType: null,
    });
  }

  const label = campaignLabelsById?.get(campaignId) ?? null;
  if (label && isTrustedForKindSemantics(label)) {
    return withCampaignContext(decision, {
      status: "labeled",
      kind: label.kind,
      testDimension: label.testDimension,
      blockedActionType: null,
    });
  }

  if (label?.contextTrust === "medium") {
    // Medium-confidence automatic context: canonical baselines, no kind
    // semantics. Mature stop-loss cut stays visible with a low-confidence
    // badge (user-approved medium-cut policy); hard scale/refresh demote.
    if (decision.label === "cut") {
      return withCampaignContext(decision, {
        status: "labeled",
        kind: null,
        testDimension: null,
        blockedActionType: null,
        badges: withContextBadge(decision.badges, "campaign_context_low_confidence"),
      });
    }
    if (isHardDecision(decision.label)) {
      return guardHardDecisionWithContext(decision, {
        status: "labeled",
        badgeType: "campaign_context_low_confidence",
        prefix: CAMPAIGN_CONTEXT_LOW_CONFIDENCE_GUARD_PREFIX,
      });
    }
    return withCampaignContext(decision, {
      status: "labeled",
      kind: null,
      testDimension: null,
      blockedActionType: null,
      badges: decision.badges.slice(),
    });
  }

  if (
    label?.contextTrust === "low" ||
    label?.contextTrust === "unknown" ||
    label?.contextTrust === "conflict"
  ) {
    const badgeType =
      label.contextTrust === "conflict"
        ? "campaign_context_conflict"
        : "campaign_context_unresolved";
    const badges = withContextBadge(decision.badges, badgeType);
    if (isAlreadyGuarded(decision)) {
      return withCampaignContext(decision, {
        status: "unlabeled",
        kind: null,
        testDimension: null,
        badges,
      });
    }
    if (!isHardDecision(decision.label)) {
      return withCampaignContext(decision, {
        status: "unlabeled",
        kind: null,
        testDimension: null,
        blockedActionType: null,
        badges,
      });
    }
    return guardHardDecisionWithContext(decision, {
      status: "unlabeled",
      badgeType,
      prefix: CAMPAIGN_CONTEXT_UNRESOLVED_GUARD_PREFIX,
    });
  }

  const badges = withUnlabeledBadge(decision.badges);
  if (isAlreadyGuarded(decision)) {
    return withCampaignContext(decision, {
      status: "unlabeled",
      kind: null,
      testDimension: null,
      badges,
    });
  }

  if (!isHardDecision(decision.label)) {
    return withCampaignContext(decision, {
      status: "unlabeled",
      kind: null,
      testDimension: null,
      blockedActionType: null,
      badges,
    });
  }

  return guardHardDecisionWithoutCampaignLabel(decision, "unlabeled");
}
