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
  /**
   * The mathematical verdict the engine reached before any authority hold, so
   * a consumer can show "Scale · Held" without parsing the compatibility
   * label. Null when no hard verdict was held. It is evidence, never an
   * authorization: a non-null value always accompanies
   * `decisionState: "blocked"` and `buyerAction: null`.
   */
  heldAction: "scale" | "cut" | "refresh" | null;
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

/**
 * Names the held verdict inside operator copy.
 *
 * Every held-verdict resolution used to read the same way whichever action was
 * held, so an account whose Scale was withheld only by a thin calibration
 * sample and an account whose Cut was withheld by a missing anchor were told
 * the identical sentence. The held action is already known here; saying it
 * costs nothing and is the difference between a specific held reason and a
 * generic "resolve the inputs".
 *
 * The parameter is non-nullable on purpose: `resolutionForAuthorityBlocker` is
 * reached only inside the `if (heldAction)` branch below, so a "hard action"
 * fallback would be a sentence no row can ever be shown.
 */
function heldActionNoun(heldAction: "scale" | "cut" | "refresh"): string {
  if (heldAction === "scale") return "Scale";
  if (heldAction === "cut") return "Cut";
  return "Refresh";
}

/**
 * One engine predicate blocker, narrowed to the fields this projection reads.
 *
 * Structurally compatible with `DecisionPredicateBlocker` in
 * lib/creative-decision-engine/types.ts; declared locally so this module keeps
 * no import edge into the engine.
 */
export interface MetaDecisionPredicateEvidence {
  predicate: string;
  observed: string | number | null;
  threshold: string | number | null;
}

/**
 * True for the ONE benchmark blocker that reports a sample count against a
 * floor.
 *
 * `scaleBenchmarkBlockers` in lib/creative-decision-engine/gates/ratio-zones.ts
 * emits `scale_account_benchmark_ready` twice under one predicate name (the
 * name is load-bearing for the near-miss copy in
 * app/api/creatives/briefing/card-serialization.ts): once for a thin mature-ad
 * sample, with numeric `observed`/`threshold`, and once for a missing account
 * winner purchase P50, with `observed: null`. GOLDEN_CASES.md keeps those
 * apart as GC-051 and GC-052, and the badge does not: `scaleReadinessBadges`
 * stamps `scale_calibration_thin` for either. Only the numbers separate them.
 */
function hasThinScaleSampleEvidence(
  predicateBlockers: readonly MetaDecisionPredicateEvidence[],
): boolean {
  const benchmarkBlockers = predicateBlockers.filter(
    (blocker) => blocker.predicate === "scale_account_benchmark_ready",
  );
  return (
    benchmarkBlockers.length > 0 &&
    benchmarkBlockers.every(
      (blocker) =>
        typeof blocker.observed === "number" &&
        typeof blocker.threshold === "number",
    )
  );
}

function hasMissingScaleWinnerBenchmark(
  predicateBlockers: readonly MetaDecisionPredicateEvidence[],
): boolean {
  return predicateBlockers.some(
    (blocker) =>
      blocker.predicate === "scale_account_benchmark_ready" &&
      blocker.observed === null,
  );
}

function resolutionForAuthorityBlocker(
  authorityBlocker: MetaDecisionAuthorityBlocker,
  codes: ReadonlySet<string>,
  heldAction: "scale" | "cut" | "refresh",
  predicateBlockers: readonly MetaDecisionPredicateEvidence[],
): MetaDecisionResolution {
  const held = heldActionNoun(heldAction);
  if (authorityBlocker === "profile_hard_action_ineligible") {
    if (
      codes.has("commercial_truth_stale") ||
      codes.has("truth_commercial_stale")
    ) {
      return {
        code: "confirm_commercial_target",
        category: "commercial_truth",
        owner: "operator",
        // The label stays byte-stable because persisted snapshots and
        // downstream copy maps key off the code/label pair; the specificity
        // this defect was missing goes into `nextStep`, which is free text.
        label: "Confirm Commercial Target",
        nextStep: `Confirm the missing or invalid target timestamp and the ${held} commercial anchor before restoring this verdict's authority. The ${held} verdict itself stands.`,
      };
    }
    /*
      Keyed on the numeric blocker, never on `scale_calibration_thin`.

      That badge is stamped for a missing winner purchase P50 too, so keying
      the sentence "only the account winner-calibration sample is below its
      floor" on the badge states something false on every GC-052 row. A caller
      that hands over no predicate blockers gets the generic resolution below,
      which is less specific but true.
    */
    if (heldAction === "scale" && hasThinScaleSampleEvidence(predicateBlockers)) {
      return {
        code: "complete_hard_action_evidence",
        category: "system",
        owner: "system",
        label: "Scale Held — Calibration Sample Thin",
        nextStep:
          "The Scale verdict stands on this ad's own economics; only the account winner-calibration sample is below its floor, so no provider action is authorized yet. The engine keeps re-evaluating as mature ads accumulate.",
      };
    }
    return {
      code: "complete_hard_action_evidence",
      category: "system",
      owner: "system",
      label: "Complete Hard-Action Evidence",
      nextStep: `Complete the ${held} target, threshold, or exact-cell calibration evidence reported missing by the engine. The held ${held} verdict remains visible, but no provider action is authorized.`,
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
  if (authorityBlocker === "native_metrics_unavailable") {
    /*
      Two engine holds arrive under this code, and neither is a stale feed.

      `ratioZonesGate` stamps it when a scale-zone row's only gap is the
      account winner purchase P50, and when a decayed row has no ad-level
      fatigue verdict. Sending either to "Refresh Decision Data" tells an
      integration owner to re-sync a feed that is already current; the evidence
      is missing because the account has not produced it yet, which is a system
      wait, not a data repair. The generic reading below stays for every other
      producer of this code.
    */
    if (heldAction === "scale" && hasMissingScaleWinnerBenchmark(predicateBlockers)) {
      return {
        code: "complete_hard_action_evidence",
        category: "system",
        owner: "system",
        label: "Scale Held — Winner Benchmark Missing",
        nextStep:
          "The Scale verdict stands on this ad's own economics; the account has no winner purchase benchmark to compare it against, so no provider action is authorized yet. The benchmark appears once enough winning ads are observed.",
      };
    }
    /*
      Keyed on the PREDICATE, never on `heldAction`.

      This used to require `heldAction === "refresh"`. But `heldAction` is
      `DecisionOutput.blockedActionType`
      (lib/meta/canonical-decision-presentation.ts), and `finalizeDecision` in
      lib/creative-decision-engine/gates/types.ts deliberately rewrites a held
      Refresh's `blockedActionType` to `"cut"` on a Test campaign — the same
      `applyTestCohortRefreshOverride` rewrite the label gets, applied to the
      hold so a transform cannot silently drop it. So on a Test cohort this
      branch was skipped for exactly the rows it exists for, and the held
      verdict fell through to `refresh_decision_data`: owner `integration`,
      "restore a fresh, complete evidence window", pointed at a feed that is
      already current, while the row's own blocker says the missing thing is
      this ad's fatigue verdict.

      `refresh_ad_lifecycle_evidence` is emitted at ONE terminal
      (`ratioZonesGate` in lib/creative-decision-engine/gates/ratio-zones.ts),
      whose hold is always the withheld Refresh, so the predicate identifies
      the case whatever the cohort rewrote the action label to. The held action
      is still named from `heldAction`, so the resolution matches the chip the
      operator sees: "Refresh Held" on a Main campaign, "Cut Held" on the Test
      cohort whose Refresh became a Cut.
    */
    if (
      predicateBlockers.some(
        (blocker) => blocker.predicate === "refresh_ad_lifecycle_evidence",
      )
    ) {
      return {
        code: "complete_hard_action_evidence",
        category: "system",
        owner: "system",
        label: `${held} Held — Ad Fatigue Evidence Missing`,
        nextStep:
          "The recent window decayed against this ad's own earlier period, but no ad-level fatigue verdict exists to confirm creative wear, so no provider action is authorized yet. The verdict resolves as sibling-ad exposure evidence accumulates.",
      };
    }
    return {
      code: "refresh_decision_data",
      category: "data",
      owner: "integration",
      label: "Refresh Decision Data",
      nextStep: `Restore a fresh, complete evidence window before applying the held ${held} verdict.`,
    };
  }
  if (authorityBlocker === "source_freshness") {
    return {
      code: "refresh_decision_data",
      category: "data",
      owner: "integration",
      label: "Refresh Decision Data",
      nextStep: `Restore a fresh, complete evidence window before applying the held ${held} verdict.`,
    };
  }
  if (authorityBlocker === "campaign_context") {
    return {
      code: "resolve_campaign_role",
      category: "campaign_context",
      owner: "system",
      label: "Automatic Classification Pending",
      nextStep:
        "The automatic resolver will keep evaluating this campaign as fresh account-scoped evidence syncs. No operator input is required; hard actions stay review-only until the role resolves.",
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
    codes.has("campaign_role_unresolved") ||
    codes.has("unlabeled_campaign_context") ||
    codes.has("campaign_context")
  ) {
    return {
      code: "resolve_campaign_role",
      category: "campaign_context",
      owner: "system",
      label: "Automatic Classification Pending",
      nextStep:
        "The automatic resolver will keep evaluating this campaign as fresh account-scoped evidence syncs. No operator input is required; hard actions stay review-only until the role resolves.",
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
  /**
   * The engine's `DecisionOutput.blockers`, when the caller has them.
   *
   * Held-verdict copy that names WHICH readiness floor failed cannot be
   * derived from badges: `scaleReadinessBadges` in
   * lib/creative-decision-engine/gates/ratio-zones.ts stamps
   * `scale_calibration_thin` for a thin mature-ad sample and for a missing
   * winner purchase P50 alike. Omitting this is safe and lossy: the projection
   * falls back to the generic held-verdict resolution.
   *
   * The served path supplies it: `projectCanonicalMetaDecisionPresentation` in
   * lib/meta/canonical-decision-presentation.ts passes
   * `input.decision.blockers`, which
   * lib/meta/decisions-workspace-read-model.ts reads from the evaluation's
   * persisted `decision_output_json -> 'blockers'`. It stays optional because
   * a snapshot whose evaluation row is absent legitimately has none.
   */
  predicateBlockers?: readonly MetaDecisionPredicateEvidence[];
}): MetaDecisionSemanticProjection {
  const evidenceCodes = new Set([
    ...input.badgeCodes,
    ...(input.blockerCodes ?? []),
  ]);

  const heldAction = input.heldAction ?? null;

  if (heldAction) {
    return {
      decisionState: "blocked",
      legacyBuyerAction: input.legacyBuyerAction,
      buyerAction: null,
      resolution: input.authorityBlocker
        ? resolutionForAuthorityBlocker(
            input.authorityBlocker,
            evidenceCodes,
            heldAction,
            input.predicateBlockers ?? [],
          )
        : resolutionFor(evidenceCodes),
      heldAction,
    };
  }

  if (input.sourceLabel === "out_of_scope") {
    return {
      decisionState: "not_applicable",
      legacyBuyerAction: input.legacyBuyerAction,
      buyerAction: null,
      resolution: null,
      heldAction: null,
    };
  }

  if (input.legacyBuyerAction === "diagnose_data") {
    return {
      decisionState: "blocked",
      legacyBuyerAction: input.legacyBuyerAction,
      buyerAction: null,
      resolution: resolutionFor(evidenceCodes),
      heldAction: null,
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
      heldAction: null,
    };
  }

  const buyerAction = input.legacyBuyerAction;
  /*
    A Main-campaign Scale is an Act, not a Monitor.

    This used to read `scale && (role === "test" || role === "mixed")`, so a
    Scale verdict on a Main campaign — the campaign type that carries most of
    an account's budget — was silently demoted to `monitor`, with no blocker,
    no reason, and no held verdict. The campaign role does not make the
    mathematics weaker; it only changes WHICH action label the briefing
    adapter offers ("Promote to main" for a test, a budget change for a main,
    structure review for a mixed campaign), and that split is already owned
    downstream.

    An unresolved role is different: it is untrustworthy context rather than a
    role, and the campaign-context invariant keeps hard actions review-only
    until the automatic resolver settles it. That case stays `monitor`.
  */
  const roleIsResolved =
    input.lifecycleRole === "test" ||
    input.lifecycleRole === "main" ||
    input.lifecycleRole === "mixed";
  const decisionState: MetaDecisionState =
    buyerAction === "cut" ||
    buyerAction === "refresh" ||
    buyerAction === "fix_delivery" ||
    buyerAction === "fix_policy" ||
    (buyerAction === "scale" && roleIsResolved)
      ? "act"
      : "monitor";

  return {
    decisionState,
    legacyBuyerAction: buyerAction,
    buyerAction,
    resolution: null,
    heldAction: null,
  };
}
