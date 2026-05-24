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
export { CREATIVE_CAMPAIGN_LABEL_CONFIDENCE_CAP } from "./config-values";

export type CreativeCampaignLabelMap = ReadonlyMap<
  string,
  Pick<MetaCampaignLabel, "kind" | "testDimension">
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
    decision.campaignLabelStatus === "unlabeled" &&
    decision.label === "diagnose" &&
    (decision.blockedActionType != null ||
      decision.reason.startsWith(CREATIVE_CAMPAIGN_LABEL_GUARD_PREFIX))
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

export function withCreativeCampaignLabelContext<T extends Pick<CreativeInput, "campaignId">>(
  input: T,
  campaignLabelsById: CreativeCampaignLabelMap | null | undefined,
): T & Pick<CreativeInput, "campaignKind"> {
  const campaignId = input.campaignId?.trim() || null;
  return {
    ...input,
    campaignKind: campaignId
      ? (campaignLabelsById?.get(campaignId)?.kind ?? null)
      : null,
  };
}

export function applyCreativeCampaignLabelGuard({
  decision,
  input,
  campaignLabelsById,
}: CreativeCampaignLabelGuardInput): DecisionOutput {
  const campaignId = input.campaignId?.trim() || null;
  if (!campaignId) {
    return withCampaignContext(decision, {
      status: "no_campaign",
      kind: null,
      testDimension: null,
      blockedActionType: null,
    });
  }

  const label = campaignLabelsById?.get(campaignId) ?? null;
  if (label) {
    return withCampaignContext(decision, {
      status: "labeled",
      kind: label.kind,
      testDimension: label.testDimension,
      blockedActionType: null,
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

  const originalLabel = decision.label;
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
      status: "unlabeled",
      kind: null,
      testDimension: null,
      blockedActionType: originalLabel,
      badges: guardedBadges,
    },
  );
}
