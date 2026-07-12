import type {
  MetaDecisionBuyerAction,
  MetaDecisionLifecycleRole,
  MetaDecisionResolution,
  MetaDecisionServedBuyerAction,
  MetaDecisionState,
} from "@/lib/meta/decisions-workspace-contract";

export interface MetaDecisionSemanticProjection {
  decisionState: MetaDecisionState;
  legacyBuyerAction: MetaDecisionBuyerAction;
  buyerAction: MetaDecisionServedBuyerAction | null;
  resolution: MetaDecisionResolution | null;
}

const FRESHNESS_AUTHORITY_BLOCKERS = new Set([
  "commercial_truth_stale",
  "truth_commercial_stale",
  "stale_evidence",
  "unknown_freshness",
  "missing_recent_data",
]);

function isPerformanceAction(
  value: MetaDecisionBuyerAction,
): value is "scale" | "cut" | "refresh" {
  return value === "scale" || value === "cut" || value === "refresh";
}

function resolutionFor(codes: ReadonlySet<string>): MetaDecisionResolution {
  if (codes.has("policy_blocked")) {
    return {
      code: "fix_policy",
      category: "policy",
      owner: "operator",
      label: "Fix Policy",
      nextStep: "Resolve the documented Meta policy or review restriction before judging performance.",
    };
  }
  if (codes.has("delivery_no_spend_24h") || codes.has("delivery_proof")) {
    return {
      code: "fix_delivery",
      category: "delivery",
      owner: "operator",
      label: "Fix Delivery",
      nextStep: "Restore delivery or confirm the hierarchy constraint before evaluating this ad.",
    };
  }
  if (codes.has("tracking_anomaly") || codes.has("tracking")) {
    return {
      code: "repair_tracking",
      category: "tracking",
      owner: "integration",
      label: "Repair Tracking",
      nextStep: "Verify Pixel and CAPI purchase events before trusting performance decisions.",
    };
  }
  if (codes.has("checkout_breakdown")) {
    return {
      code: "fix_checkout",
      category: "funnel",
      owner: "operator",
      label: "Fix Checkout",
      nextStep: "Review the checkout step before attributing the loss to this ad.",
    };
  }
  if (
    codes.has("landing_page_issue") ||
    codes.has("upper_funnel_strong_site_weak")
  ) {
    return {
      code: "fix_landing_page",
      category: "funnel",
      owner: "operator",
      label: "Fix Landing Page",
      nextStep: "Review landing-page continuity and conversion before judging this ad.",
    };
  }
  if (
    codes.has("campaign_context_conflict") ||
    codes.has("campaign_context_unresolved") ||
    codes.has("campaign_context_low_confidence") ||
    codes.has("campaign_label_missing") ||
    codes.has("unlabeled_campaign_context")
  ) {
    return {
      code: "resolve_campaign_role",
      category: "campaign_context",
      owner: "system",
      label: "Resolve Campaign Role",
      nextStep:
        "The automatic resolver must reach a trusted Main, Test, or Mixed role; use an explicit correction only when its classification is wrong.",
    };
  }
  if (
    codes.has("commercial_truth_stale") ||
    codes.has("truth_commercial_stale")
  ) {
    return {
      code: "confirm_commercial_target",
      category: "commercial_truth",
      owner: "operator",
      label: "Confirm Commercial Target",
      nextStep: "Confirm the business target before restoring target-derived decision authority.",
    };
  }
  if (
    codes.has("stale_evidence") ||
    codes.has("unknown_freshness") ||
    codes.has("missing_recent_data") ||
    codes.has("freshness") ||
    codes.has("data_health")
  ) {
    return {
      code: "refresh_decision_data",
      category: "data",
      owner: "integration",
      label: "Refresh Decision Data",
      nextStep: "Restore a fresh, complete evidence window before applying a performance action.",
    };
  }
  return {
    code: "resolve_evidence_gap",
    category: "system",
    owner: "system",
    label: "Resolve Evidence Gap",
    nextStep: "Complete the missing decision evidence before applying a buyer action.",
  };
}

export function projectMetaDecisionSemantics(input: {
  legacyBuyerAction: MetaDecisionBuyerAction;
  sourceLabel: string;
  lifecycleRole: MetaDecisionLifecycleRole;
  badgeCodes: readonly string[];
  blockerCodes?: readonly string[];
}): MetaDecisionSemanticProjection {
  if (input.sourceLabel === "out_of_scope") {
    return {
      decisionState: "not_applicable",
      legacyBuyerAction: input.legacyBuyerAction,
      buyerAction: null,
      resolution: null,
    };
  }

  const evidenceCodes = new Set([
    ...input.badgeCodes,
    ...(input.blockerCodes ?? []),
  ]);

  if (input.legacyBuyerAction === "diagnose_data") {
    return {
      decisionState: "blocked",
      legacyBuyerAction: input.legacyBuyerAction,
      buyerAction: null,
      resolution: resolutionFor(evidenceCodes),
    };
  }

  if (
    isPerformanceAction(input.legacyBuyerAction) &&
    [...FRESHNESS_AUTHORITY_BLOCKERS].some((code) => evidenceCodes.has(code))
  ) {
    return {
      decisionState: "blocked",
      legacyBuyerAction: input.legacyBuyerAction,
      buyerAction: null,
      resolution: resolutionFor(evidenceCodes),
    };
  }

  const buyerAction = input.legacyBuyerAction;
  const decisionState: MetaDecisionState =
    buyerAction === "cut" ||
    buyerAction === "refresh" ||
    buyerAction === "fix_delivery" ||
    buyerAction === "fix_policy" ||
    (buyerAction === "scale" &&
      (input.lifecycleRole === "test" || input.lifecycleRole === "mixed"))
      ? "act"
      : "monitor";

  return {
    decisionState,
    legacyBuyerAction: buyerAction,
    buyerAction,
    resolution: null,
  };
}
