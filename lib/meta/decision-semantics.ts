import type {
  MetaDecisionBuyerAction,
  MetaDecisionAuthorityBlocker,
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
  "stale_evidence",
  "unknown_freshness",
  "missing_recent_data",
]);

function isPerformanceAction(
  value: MetaDecisionBuyerAction,
): value is "scale" | "cut" | "refresh" {
  return value === "scale" || value === "cut" || value === "refresh";
}

function resolutionForAuthorityBlocker(
  authorityBlocker: MetaDecisionAuthorityBlocker,
  codes: ReadonlySet<string>,
): MetaDecisionResolution {
  if (authorityBlocker === "profile_hard_action_ineligible") {
    if (
      codes.has("commercial_truth_stale") ||
      codes.has("truth_commercial_stale")
    ) {
      return {
        code: "confirm_commercial_target",
        category: "commercial_truth",
        owner: "operator",
        label: "Confirm Commercial Target",
        nextStep:
          "Confirm the missing or invalid target timestamp and action-specific commercial anchor before restoring the held verdict's authority.",
      };
    }
    return {
      code: "complete_hard_action_evidence",
      category: "system",
      owner: "system",
      label: "Complete Hard-Action Evidence",
      nextStep:
        "Complete the action-specific target, threshold, or exact-cell calibration evidence reported missing by the engine. The held verdict remains visible, but no provider action is authorized.",
    };
  }
  if (authorityBlocker === "recent_recovery_unverifiable") {
    if (codes.has("missing_recent_data")) {
      return {
        code: "refresh_decision_data",
        category: "data",
        owner: "integration",
        label: "Refresh Decision Data",
        nextStep:
          "Restore the missing recent ROAS/spend evidence before applying the held Cut verdict.",
      };
    }
    return {
      code: "await_recent_evidence",
      category: "system",
      owner: "system",
      label: "Await Recent Economic Evidence",
      nextStep:
        "Wait for a sufficiently sampled recent window to confirm that ROAS remains below break-even. The held Cut is not authorized while recovery cannot be ruled out.",
    };
  }
  if (
    authorityBlocker === "source_freshness" ||
    authorityBlocker === "native_metrics_unavailable"
  ) {
    return {
      code: "refresh_decision_data",
      category: "data",
      owner: "integration",
      label: "Refresh Decision Data",
      nextStep:
        "Restore a fresh, complete evidence window before applying the held performance verdict.",
    };
  }
  if (authorityBlocker === "campaign_context") {
    return {
      code: "resolve_campaign_role",
      category: "campaign_context",
      owner: "system",
      label: "Automatic Classification Pending",
      nextStep:
        "The automatic resolver will keep evaluating this campaign. No label is required; save an explicit correction only when the provisional role is wrong.",
    };
  }
  return {
    code: "restore_native_profile",
    category: "system",
    owner: "system",
    label: "Restore Native Decision Profile",
    nextStep:
      "Restore the authoritative native decision profile before applying the held performance verdict.",
  };
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
    codes.has("unlabeled_campaign_context") ||
    codes.has("campaign_context")
  ) {
    return {
      code: "resolve_campaign_role",
      category: "campaign_context",
      owner: "system",
      label: "Automatic Classification Pending",
      nextStep:
        "The automatic resolver will keep evaluating this campaign. No label is required; save an explicit correction only when the provisional role is wrong.",
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
    codes.has("data_health") ||
    codes.has("source_freshness") ||
    codes.has("native_metrics_unavailable")
  ) {
    return {
      code: "refresh_decision_data",
      category: "data",
      owner: "integration",
      label: "Refresh Decision Data",
      nextStep: "Restore a fresh, complete evidence window before applying a performance action.",
    };
  }
  if (codes.has("pending_transition")) {
    return {
      code: "await_decision_confirmation",
      category: "system",
      owner: "system",
      label: "Hard Action Pending Confirmation",
      nextStep:
        "Wait for the required consecutive engine confirmation. The held Scale/Cut/Refresh verdict is visible, but no provider action is authorized yet.",
    };
  }
  if (codes.has("recent_recovery_unverifiable")) {
    return {
      code: "await_recent_evidence",
      category: "system",
      owner: "system",
      label: "Await Recent Economic Evidence",
      nextStep:
        "Wait for a sufficiently sampled recent window to confirm that ROAS remains below break-even. No Cut is authorized while recovery cannot be ruled out.",
    };
  }
  if (codes.has("profile_hard_action_ineligible")) {
    return {
      code: "complete_hard_action_evidence",
      category: "system",
      owner: "system",
      label: "Complete Hard-Action Evidence",
      nextStep:
        "Complete the action-specific target, threshold, or exact-cell calibration evidence reported missing by the engine. The held verdict remains visible, but no provider action is authorized.",
    };
  }
  if (codes.has("native_profile_unavailable")) {
    return {
      code: "restore_native_profile",
      category: "system",
      owner: "system",
      label: "Restore Native Decision Profile",
      nextStep:
        "Restore the authoritative native decision profile before applying the held performance verdict.",
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
  heldAction?: "scale" | "cut" | "refresh" | null;
  authorityBlocker?: MetaDecisionAuthorityBlocker | null;
}): MetaDecisionSemanticProjection {
  const evidenceCodes = new Set([
    ...input.badgeCodes,
    ...(input.blockerCodes ?? []),
  ]);

  if (input.heldAction) {
    return {
      decisionState: "blocked",
      legacyBuyerAction: input.legacyBuyerAction,
      buyerAction: null,
      resolution: input.authorityBlocker
        ? resolutionForAuthorityBlocker(input.authorityBlocker, evidenceCodes)
        : resolutionFor(evidenceCodes),
    };
  }

  if (input.sourceLabel === "out_of_scope") {
    return {
      decisionState: "not_applicable",
      legacyBuyerAction: input.legacyBuyerAction,
      buyerAction: null,
      resolution: null,
    };
  }

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
