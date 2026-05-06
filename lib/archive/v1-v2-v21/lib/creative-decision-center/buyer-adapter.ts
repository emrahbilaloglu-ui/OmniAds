import {
  type BuyerActionMappingRule,
  type CreativeDecisionCenterBuyerAction,
  type CreativeDecisionOsV21Output,
} from "@/lib/creative-decision-center/contracts";

export interface CreativeDecisionCenterBuyerAdapterContext {
  availableData?: readonly string[];
}

export interface CreativeDecisionCenterBuyerAdapterResult {
  buyerAction: CreativeDecisionCenterBuyerAction;
  buyerLabel: string;
  uiBucket: CreativeDecisionCenterBuyerAction;
  nextStep: string;
  ruleId: string;
  missingData: string[];
}

export const CREATIVE_DECISION_CENTER_BUYER_ACTION_RULES = [
  {
    id: "diagnose-delivery-active-no-spend",
    when: {
      primaryDecision: "Diagnose",
      problemClass: "delivery",
      reasonTagsAny: ["active_no_spend_24h"],
      actionability: "diagnose",
      requiredData: [
        "adStatus",
        "campaignStatus",
        "adsetStatus",
        "spend24h",
        "impressions24h",
      ],
    },
    output: {
      buyerAction: "fix_delivery",
      buyerLabel: "Fix delivery",
      uiBucket: "fix_delivery",
      nextStepTemplate:
        "Check ad, adset, campaign, audience, budget, and learning state.",
    },
  },
  {
    id: "diagnose-policy-disapproved-or-limited",
    when: {
      primaryDecision: "Diagnose",
      problemClass: "policy",
      reasonTagsAny: ["disapproved_or_limited"],
      actionability: "diagnose",
      requiredData: ["reviewStatus", "effectiveStatus", "policyReason"],
    },
    output: {
      buyerAction: "fix_policy",
      buyerLabel: "Fix policy",
      uiBucket: "fix_policy",
      nextStepTemplate: "Review rejection/limited reason and revise creative.",
    },
  },
  {
    id: "test-more-launch-monitoring",
    when: {
      primaryDecision: "Test More",
      problemClass: "launch_monitoring",
      requiredData: ["firstSeenAt", "firstSpendAt"],
    },
    output: {
      buyerAction: "watch_launch",
      buyerLabel: "Watch launch",
      uiBucket: "watch_launch",
      nextStepTemplate:
        "Check again after the launch window or maturity threshold.",
    },
  },
  {
    id: "scale-performance-review",
    when: {
      primaryDecision: "Scale",
      problemClass: "performance",
      requiredData: ["targetSource", "benchmarkReliability", "dataFreshness"],
    },
    output: {
      buyerAction: "scale",
      buyerLabel: "Scale review",
      uiBucket: "scale",
      nextStepTemplate: "Review budget/context before scaling.",
    },
  },
  {
    id: "cut-performance-review",
    when: {
      primaryDecision: "Cut",
      problemClass: "performance",
      requiredData: ["targetSource", "benchmarkReliability", "dataFreshness"],
    },
    output: {
      buyerAction: "cut",
      buyerLabel: "Cut review",
      uiBucket: "cut",
      nextStepTemplate:
        "Confirm no tracking or delivery blocker, then pause or replace.",
    },
  },
  {
    id: "refresh-fatigue-or-creative",
    when: {
      primaryDecision: "Refresh",
      reasonTagsAny: ["fatigue_composite", "stable_winner"],
    },
    output: {
      buyerAction: "refresh",
      buyerLabel: "Refresh",
      uiBucket: "refresh",
      nextStepTemplate: "Brief a new variant or rotate the angle.",
    },
  },
  {
    id: "protect-performance",
    when: {
      primaryDecision: "Protect",
      problemClass: "performance",
    },
    output: {
      buyerAction: "protect",
      buyerLabel: "Protect",
      uiBucket: "protect",
      nextStepTemplate: "Keep live; avoid unnecessary edits.",
    },
  },
  {
    id: "test-more-insufficient-signal",
    when: {
      primaryDecision: "Test More",
      problemClass: "insufficient_signal",
    },
    output: {
      buyerAction: "test_more",
      buyerLabel: "Test more",
      uiBucket: "test_more",
      nextStepTemplate: "Let the test collect the required sample.",
    },
  },
  {
    id: "diagnose-data-quality",
    when: {
      primaryDecision: "Diagnose",
      problemClass: "data_quality",
    },
    output: {
      buyerAction: "diagnose_data",
      buyerLabel: "Diagnose data",
      uiBucket: "diagnose_data",
      nextStepTemplate: "Resolve missing decision data before acting.",
    },
  },
  {
    id: "diagnose-campaign-context",
    when: {
      primaryDecision: "Diagnose",
      problemClass: "campaign_context",
    },
    output: {
      buyerAction: "diagnose_data",
      buyerLabel: "Diagnose data",
      uiBucket: "diagnose_data",
      nextStepTemplate: "Resolve campaign or ad set context before acting.",
    },
  },
  {
    id: "diagnose-performance-context",
    when: {
      primaryDecision: "Diagnose",
      problemClass: "performance",
    },
    output: {
      buyerAction: "diagnose_data",
      buyerLabel: "Diagnose data",
      uiBucket: "diagnose_data",
      nextStepTemplate: "Resolve performance context before acting.",
    },
  },
] as const satisfies readonly BuyerActionMappingRule[];

const DIAGNOSE_DATA_RESULT = {
  buyerAction: "diagnose_data",
  buyerLabel: "Diagnose data",
  uiBucket: "diagnose_data",
  nextStep: "Resolve missing decision data before acting.",
} as const;

function matchesRule(
  engine: CreativeDecisionOsV21Output,
  rule: BuyerActionMappingRule,
) {
  const when = rule.when;
  if (when.primaryDecision && engine.primaryDecision !== when.primaryDecision) {
    return false;
  }
  if (when.problemClass && engine.problemClass !== when.problemClass) {
    return false;
  }
  if (when.actionability && engine.actionability !== when.actionability) {
    return false;
  }
  if (
    when.reasonTagsAny &&
    !when.reasonTagsAny.some((tag) => engine.reasonTags.includes(tag))
  ) {
    return false;
  }
  if (
    when.blockersAbsent &&
    when.blockersAbsent.some((blocker) => engine.blockerReasons.includes(blocker))
  ) {
    return false;
  }
  return true;
}

function missingRequiredData(
  engine: CreativeDecisionOsV21Output,
  rule: BuyerActionMappingRule,
  context: CreativeDecisionCenterBuyerAdapterContext,
) {
  const requiredData = rule.when.requiredData ?? [];
  const availableData = new Set(context.availableData ?? []);
  const explicitMissingData = new Set(engine.missingData);

  return requiredData.filter(
    (field) => explicitMissingData.has(field) || !availableData.has(field),
  );
}

export function adaptCreativeDecisionCenterBuyerAction(
  engine: CreativeDecisionOsV21Output,
  context: CreativeDecisionCenterBuyerAdapterContext = {},
): CreativeDecisionCenterBuyerAdapterResult {
  for (const rule of CREATIVE_DECISION_CENTER_BUYER_ACTION_RULES) {
    if (!matchesRule(engine, rule)) continue;

    const missingData = missingRequiredData(engine, rule, context);
    if (missingData.length > 0) {
      return {
        ...DIAGNOSE_DATA_RESULT,
        ruleId: `${rule.id}.missing_required_data`,
        missingData: Array.from(new Set([...engine.missingData, ...missingData])),
      };
    }

    return {
      buyerAction: rule.output.buyerAction,
      buyerLabel: rule.output.buyerLabel,
      uiBucket: rule.output.uiBucket,
      nextStep: rule.output.nextStepTemplate,
      ruleId: rule.id,
      missingData: engine.missingData,
    };
  }

  return {
    ...DIAGNOSE_DATA_RESULT,
    ruleId: "default-diagnose-data",
    missingData: engine.missingData,
  };
}

export function confidenceBand(
  confidence: number,
): "high" | "medium" | "low" {
  if (confidence >= 78) return "high";
  if (confidence >= 62) return "medium";
  return "low";
}
