import {
  ENGINE_VERSION,
  type AccountDecisionProfile,
  type CreativeInput,
  type DataHealth,
  type DecisionAuthorityBlocker,
  type DecisionBadge,
  type DecisionLabel,
  type DecisionLabelTransform,
  type DecisionOutput,
  type DecisionPredicateBlocker,
  type TruthSource,
} from "../types";
import { computeFunnelDiagnosis } from "../funnel";
import { applyTestCohortRefreshOverride } from "../test-cohort-semantic";
import {
  HARD_ACTION_HOLD_CONFIDENCE_CAP,
  STALE_CONFIDENCE_CAP,
  STALE_SOURCE_UPDATED_AT_HOURS,
} from "../config-values";

export interface GateContext {
  input: CreativeInput;
  profile: AccountDecisionProfile;
  dataHealth?: DataHealth;
  effectiveTargetRoas: number;
  truthSource: TruthSource;
  ratioToTarget: number | null;
  badges: DecisionBadge[];
  confidenceBase: number;
  confidenceDeltas: number[];
  blockers: DecisionPredicateBlocker[];
  generatedAt: string;
}

export type GateResult =
  | { kind: "terminal"; output: DecisionOutput }
  | { kind: "advance"; context: GateContext };

interface BuildDecisionOutputInput {
  label: DecisionLabel;
  reason: string;
  confidence: number;
  truthSource?: TruthSource;
  effectiveTargetRoas?: number;
  ratioToTarget?: number | null;
  badges?: DecisionBadge[];
  blockers?: DecisionPredicateBlocker[];
  preAuthorityLabel?: DecisionLabel;
  authorityBlocker?: DecisionAuthorityBlocker | null;
  blockedActionType?: DecisionLabel | null;
  labelTransform?: DecisionLabelTransform | null;
}

export interface DecisionAuthorityHold {
  authorityBlocker: DecisionAuthorityBlocker;
  blockedActionType: DecisionLabel;
  label: DecisionLabel;
  reasonPrefix: string;
}

const SCALE_READINESS_BLOCKED_BADGE: DecisionBadge = {
  type: "scale_readiness_blocked",
  label: "Scale readiness blocked",
  severity: "info",
};

export function clampConfidence(
  confidenceBase: number,
  confidenceDeltas: readonly number[],
): number {
  const adjustedConfidence = confidenceDeltas.reduce(
    (confidence, delta) => confidence + delta,
    confidenceBase,
  );
  return Math.max(40, Math.min(95, adjustedConfidence));
}

function hasDecisionBadge(
  badges: readonly DecisionBadge[],
  type: DecisionBadge["type"],
): boolean {
  return badges.some((badge) => badge.type === type);
}

export function formatAccountCurrencySpend(
  spend: number,
  accountCurrency: string | null | undefined,
) {
  const currency =
    typeof accountCurrency === "string" &&
    /^[A-Za-z]{3}$/.test(accountCurrency.trim())
      ? accountCurrency.trim().toUpperCase()
      : null;
  const amount = spend.toFixed(0);
  return currency ? `${currency} ${amount}` : `${amount} account-currency`;
}

function confidenceCapForDecision(
  badges: readonly DecisionBadge[],
  holds: {
    requestedHardAction: boolean;
    profileHardAction: boolean;
  },
): number | null {
  const caps = [
    hasDecisionBadge(badges, "stale_evidence") ||
    hasDecisionBadge(badges, "unknown_freshness")
      ? STALE_CONFIDENCE_CAP
      : null,
    holds.profileHardAction || holds.requestedHardAction
      ? HARD_ACTION_HOLD_CONFIDENCE_CAP
      : null,
  ].filter((cap): cap is number => cap !== null);
  return caps.length === 0 ? null : Math.min(...caps);
}

function capConfidence(confidence: number, cap: number | null): number {
  return cap === null ? confidence : Math.min(confidence, cap);
}

function appendDecisionBadgeOnce(
  badges: readonly DecisionBadge[],
  badge: DecisionBadge,
): DecisionBadge[] {
  return hasDecisionBadge(badges, badge.type)
    ? [...badges]
    : [...badges, badge];
}

function isHardActionLabel(
  label: DecisionLabel,
): label is "scale" | "cut" | "refresh" {
  return label === "scale" || label === "cut" || label === "refresh";
}

function isEconomicallyEligibleForCutAdvisory(ctx: GateContext): boolean {
  const breakEvenRoas = ctx.profile.spendUnitEvidence.breakEvenRoas;
  if (
    typeof breakEvenRoas !== "number" ||
    !Number.isFinite(breakEvenRoas) ||
    breakEvenRoas <= 0
  ) {
    return true;
  }

  return (
    typeof ctx.input.roas === "number" &&
    Number.isFinite(ctx.input.roas) &&
    ctx.input.roas < breakEvenRoas
  );
}

export function applyPostProcess(
  ctx: GateContext,
  label: DecisionLabel,
): { badges: DecisionBadge[]; confidenceDeltas: number[] } {
  const badges: DecisionBadge[] = [...ctx.badges];
  const confidenceDeltas: number[] = [...ctx.confidenceDeltas];

  // Paused-delivery advisory semantics: a hard action on a paused creative is
  // advice about a non-delivering object ("resume this winner" / "confirm the
  // kill"), not a live-delivery intervention. Label is unchanged; the badge
  // makes the semantics explicit. CAMPAIGN_PAUSED/ADSET_PAUSED normalize to
  // "PAUSED" in data-source toEffectiveStatus, so hierarchy pauses get the
  // same advisory badges.
  if (ctx.input.effectiveStatus === "PAUSED") {
    if (label === "scale") {
      badges.push({
        type: "resume_candidate",
        label: "Creative is paused - scale verdict means resume candidate",
        severity: "info",
      });
    } else if (label === "cut") {
      badges.push({
        type: "confirm_kill",
        label: "Creative is paused - cut verdict means confirm kill / do not resume",
        severity: "info",
      });
    }
  }

  if (ctx.dataHealth) {
    if (ctx.dataHealth.calibration.staleTier === "warning") {
      badges.push({
        type: "stale_calibration",
        label: "Calibration data stale",
        severity: "warning",
      });
    } else if (ctx.dataHealth.calibration.staleTier === "disabled") {
      badges.push({
        type: "stale_calibration",
        label: "Calibration data too stale",
        severity: "warning",
      });
      confidenceDeltas.push(-10);
    }

    if (ctx.dataHealth.lifecycle.staleTier === "warning") {
      badges.push({
        type: "stale_lifecycle",
        label: "Lifecycle data stale",
        severity: "warning",
      });
    } else if (ctx.dataHealth.lifecycle.staleTier === "disabled") {
      badges.push({
        type: "stale_lifecycle",
        label: "Lifecycle data too stale",
        severity: "warning",
      });
      confidenceDeltas.push(-15);
    }

    if (ctx.dataHealth.decisions.staleTier === "warning") {
      badges.push({
        type: "stale_decision_context",
        label: "Decision context stale",
        severity: "info",
      });
    } else if (ctx.dataHealth.decisions.staleTier === "disabled") {
      badges.push({
        type: "stale_decision_context",
        label: "Decision context too stale",
        severity: "warning",
      });
      confidenceDeltas.push(-25);
    }
  }

  const ctrThreshold = ctx.profile.accountBaselines.lowCtrP10 ?? 1.0;
  // Cut-candidate is advisory on rows that remain non-Cut, so it must stay on
  // the canonical threshold. The account-AOV repair is allowed to affect only
  // rows whose final action is an actual Cut.
  const cutCandidateSpend = ctx.profile.thresholds.cutCandidateSpend;
  if (
    typeof ctx.input.ctr === "number" &&
    ctrThreshold > 0 &&
    ctx.input.ctr < ctrThreshold
  ) {
    badges.push({
      type: "low_ctr",
      label: `Low CTR (${ctx.input.ctr.toFixed(
        2,
      )}% vs account P10 ${ctrThreshold.toFixed(2)}%)`,
      severity: "info",
    });
    // No confidence delta: low CTR corroborates creative weakness on a
    // cut/refresh decision, so the previous -10 pointed the wrong way
    // (math review 2026-07-02 sign error). Weak-sample concerns are already
    // handled by the funnel denominator-confidence path; per the agreed
    // remedy the delta is zeroed rather than flipped until an outcome loop
    // can size it.
  }

  if (label === "cut" || label === "refresh") {
    const funnelDiagnosis = computeFunnelDiagnosis({
      creative: ctx.input,
      funnelCalibration: ctx.profile.funnelCalibration,
      profile: ctx.profile,
    });
    if (funnelDiagnosis.primaryWeakStage === "upper_funnel") {
      badges.push({
        type: "creative_quality_weak",
        label: "Creative quality weak",
        severity: "warning",
      });
    }
  }

  const isMissingRecent =
    ctx.input.recent7dRoas == null || ctx.input.recent7dSpend == null;
  if (
    isMissingRecent &&
    label !== "test_more" &&
    label !== "out_of_scope" &&
    label !== "diagnose"
  ) {
    badges.push({
      type: "missing_recent_data",
      label: "Recent 7d data missing",
      severity: "warning",
    });
    confidenceDeltas.push(-10);
  }

  if (
    ctx.ratioToTarget != null &&
    ctx.ratioToTarget <
      Math.min(0.6, ctx.profile.thresholds.bottomQuartileRatio ?? 0.6) &&
    cutCandidateSpend !== null &&
    ctx.input.spend >= cutCandidateSpend &&
    isEconomicallyEligibleForCutAdvisory(ctx) &&
    (label === "test_more" || label === "keep") &&
    !hasDecisionBadge(badges, "cut_candidate")
  ) {
    badges.push({
      type: "cut_candidate",
      label: `Cut candidate — ROAS ${(ctx.ratioToTarget * 100).toFixed(
        0,
      )}% of target on ${formatAccountCurrencySpend(
        ctx.input.spend,
        ctx.input.accountCurrency,
      )} spend; consider manual cut or wait for hard threshold`,
      severity: "warning",
    });
  }

  const lifecyclePosition = ctx.input.lifecyclePosition;
  const peakAgeSuffix =
    ctx.input.daysSincePeak != null
      ? ` (peak ${ctx.input.daysSincePeak}d ago)`
      : "";

  if (lifecyclePosition === "rising") {
    if (label === "scale") {
      confidenceDeltas.push(5);
    } else if (label === "keep") {
      confidenceDeltas.push(3);
    }

    if (label === "scale" || label === "keep") {
      badges.push({
        type: "opportunity_window_open",
        label: `Opportunity window — peak now${peakAgeSuffix}`,
        severity: "info",
      });
    }
  } else if (lifecyclePosition === "plateau") {
    if (label === "scale" || label === "keep") {
      confidenceDeltas.push(2);
      badges.push({
        type: "opportunity_window_open",
        label: `Plateau — window still open${peakAgeSuffix}`,
        severity: "info",
      });
    }
  } else if (lifecyclePosition === "closing") {
    if (label === "scale" || label === "keep") {
      badges.push({
        type: "opportunity_window_closing",
        label: "Opportunity window closing",
        severity: "warning",
      });
    }
  } else if (
    lifecyclePosition === "past_peak_unclear" ||
    lifecyclePosition === "past_peak_inaction"
  ) {
    if (label === "keep" || label === "refresh" || label === "cut") {
      badges.push({
        type: "past_peak_unclear_signal",
        label:
          "Past peak — operator review recommended (cannot distinguish missed opportunity vs natural saturation)",
        severity: "warning",
      });
      if (label === "refresh" || label === "cut") {
        confidenceDeltas.push(-3);
      }
    }
  } else if (lifecyclePosition === "volatile") {
    confidenceDeltas.push(-5);
    badges.push({
      type: "volatile_trend",
      label: "Volatile spend/ROAS trend — signal noisy",
      severity: "warning",
    });
  } else if (
    lifecyclePosition == null ||
    lifecyclePosition === "insufficient_history"
  ) {
    if (
      (label === "scale" || label === "cut" || label === "refresh") &&
      !badges.some((badge) => badge.type === "lifecycle_unavailable")
    ) {
      badges.push({
        type: "lifecycle_unavailable",
        label:
          lifecyclePosition === "insufficient_history"
            ? "Insufficient history for lifecycle analysis"
            : "Lifecycle data unavailable",
        severity: "info",
      });
    }
  }

  return { badges, confidenceDeltas };
}

function applySoftOnlyLabel(input: {
  label: DecisionLabel;
  reason: string;
  badges: DecisionBadge[];
  profile: AccountDecisionProfile;
}): { label: DecisionLabel; reason: string; badges: DecisionBadge[] } {
  const reason =
    (isHardActionLabel(input.label)
      ? input.profile.hardActionEligibility.reasons?.[input.label]
      : null) ??
    input.profile.hardActionEligibility.reason;

  if (input.label === "scale" && !input.profile.hardActionEligibility.scale) {
    return {
      label: "keep",
      reason: `[near scale, soft-only] ${input.reason} (Reason for soft mode: ${reason})`,
      badges: appendDecisionBadgeOnce(
        input.badges,
        SCALE_READINESS_BLOCKED_BADGE,
      ),
    };
  }

  if (input.label === "cut" && !input.profile.hardActionEligibility.cut) {
    return {
      label: "test_more",
      reason: `[soft-only - cut blocked] ${input.reason} (${reason})`,
      badges: appendDecisionBadgeOnce(input.badges, {
        type: "cut_candidate",
        label: "Soft-cut candidate",
        severity: "warning",
      }),
    };
  }

  if (
    input.label === "refresh" &&
    !input.profile.hardActionEligibility.refresh
  ) {
    return {
      label: "keep",
      reason: `[soft-only - refresh blocked] ${input.reason} (${reason})`,
      badges: input.badges,
    };
  }

  return input;
}

export function buildDecisionOutput(
  ctx: GateContext,
  output: BuildDecisionOutputInput,
): DecisionOutput {
  const blockers = output.blockers ?? ctx.blockers;
  return {
    creativeId: ctx.input.creativeId,
    creativeName: ctx.input.creativeName,
    label: output.label,
    reason: output.reason,
    confidence: output.confidence,
    truthSource: output.truthSource ?? ctx.truthSource,
    effectiveTargetRoas: output.effectiveTargetRoas ?? ctx.effectiveTargetRoas,
    ratioToTarget:
      output.ratioToTarget === undefined
        ? ctx.ratioToTarget
        : output.ratioToTarget,
    badges: output.badges ?? ctx.badges,
    ...(blockers.length > 0 ? { blockers } : {}),
    metrics: {
      spend: ctx.input.spend,
      purchases: ctx.input.purchases,
      roas: ctx.input.roas,
      recent7dRoas: ctx.input.recent7dRoas,
    },
    preAuthorityLabel: output.preAuthorityLabel ?? output.label,
    authorityBlocker: output.authorityBlocker ?? null,
    labelTransform: output.labelTransform ?? null,
    blockedActionType: output.blockedActionType ?? null,
    engineVersion: ENGINE_VERSION,
    generatedAt: ctx.generatedAt,
  };
}

export function finalizeDecision(
  ctx: GateContext,
  label: DecisionLabel,
  reason: string,
  authorityHold?: DecisionAuthorityHold,
): DecisionOutput {
  const transformed = applyTestCohortRefreshOverride({
    campaignKind: ctx.input.campaignKind,
    label,
    reason,
  });
  const softOnly = applySoftOnlyLabel({
    label: transformed.label,
    reason: transformed.reason,
    badges: ctx.badges,
    profile: ctx.profile,
  });
  const preAuthorityLabel = transformed.label;
  const profileBlocksHardAuthority =
    isHardActionLabel(preAuthorityLabel) &&
    softOnly.label !== preAuthorityLabel;
  /*
   * A LABEL TRANSFORM MUST NOT SILENTLY DROP A REQUESTED HOLD.
   *
   * The gate below matched `authorityHold.blockedActionType` against the label
   * AFTER `applyTestCohortRefreshOverride` had already rewritten it. On a Test
   * campaign that transform turns `refresh` into `cut`, so a caller that asked
   * to WITHHOLD a Refresh — `{blockedActionType: "refresh", label: "keep"}` —
   * found `"cut" === "refresh"` false, and the hold was discarded in silence.
   *
   * The consequence was not cosmetic. Isolating campaign kind on otherwise
   * identical input:
   *
   *   main  ->  label keep, preAuthority refresh, blocker native_metrics_unavailable
   *   test  ->  label CUT,  preAuthority cut,     blocker null
   *
   * So an ad with NO ad-level fatigue verdict — one the economic Cut branch had
   * just declined, still carrying the `refresh_ad_lifecycle_evidence` blocker
   * and the `lifecycle_unavailable` badge — was published at
   * `decisionState: "act"` as an authorized Cut. Missing evidence manufactured
   * an action, which is the mirror of the rule that missing evidence must not
   * erase one.
   *
   * The match is therefore made against the PRE-transform label, and the hold
   * travels through the same rewrite the label did: on a Test campaign a
   * withheld Refresh is a withheld Cut, and it stays withheld. Only `refresh`
   * is ever rewritten, so the Scale and Cut holds are unaffected either way.
   */
  const transformedHold =
    authorityHold === undefined
      ? null
      : transformed.labelTransform === null
        ? authorityHold
        : {
            ...authorityHold,
            blockedActionType: applyTestCohortRefreshOverride({
              campaignKind: ctx.input.campaignKind,
              label: authorityHold.blockedActionType,
              reason,
            }).label,
          };
  const requestedAuthorityHold =
    transformedHold !== null &&
    !profileBlocksHardAuthority &&
    label === authorityHold?.blockedActionType
      ? transformedHold
      : null;
  const authorityLabel = requestedAuthorityHold?.label ?? softOnly.label;
  const hardLabel = isHardActionLabel(authorityLabel)
    ? authorityLabel
    : null;
  const freshnessUnknown =
    ctx.input.dataFreshnessHours === null ||
    hasDecisionBadge(softOnly.badges, "unknown_freshness");
  const freshnessStale =
    hasDecisionBadge(softOnly.badges, "stale_evidence") ||
    (typeof ctx.input.dataFreshnessHours === "number" &&
      ctx.input.dataFreshnessHours > STALE_SOURCE_UPDATED_AT_HOURS);
  const freshnessBlocksHardAuthority =
    hardLabel !== null && (freshnessUnknown || freshnessStale);
  const hardLabelNeedsFreshEvidence =
    hardLabel === "scale" || hardLabel === "refresh";
  const finalLabel: DecisionLabel =
    freshnessBlocksHardAuthority && hardLabelNeedsFreshEvidence
      ? "keep"
      : authorityLabel;
  const finalReason = requestedAuthorityHold
    ? `${requestedAuthorityHold.reasonPrefix} ${softOnly.reason}`
    : freshnessBlocksHardAuthority
      ? hardLabelNeedsFreshEvidence
        ? `[${hardLabel} verdict held - fresh data required] ${softOnly.reason}`
        : `[stop-loss verdict visible - fresh data required before action] ${softOnly.reason}`
      : softOnly.reason;

  let authorityBadges = [...softOnly.badges];
  if (freshnessBlocksHardAuthority) {
    authorityBadges = appendDecisionBadgeOnce(
      authorityBadges,
      freshnessUnknown
        ? {
            type: "unknown_freshness",
            label:
              "Unknown freshness: refresh the decision data before applying.",
            severity: "warning",
          }
        : {
            type: "stale_evidence",
            label: `Stale evidence: last sync ${Math.round(
              ctx.input.dataFreshnessHours ?? 0,
            )}h ago - refresh before applying.`,
            severity: "warning",
          },
    );
  }
  if (freshnessBlocksHardAuthority && hardLabel === "scale") {
    authorityBadges = appendDecisionBadgeOnce(
      authorityBadges,
      SCALE_READINESS_BLOCKED_BADGE,
    );
  }

  const nextCtx = { ...ctx, badges: authorityBadges };
  const { badges, confidenceDeltas } = applyPostProcess(nextCtx, finalLabel);
  const finalBadges = freshnessBlocksHardAuthority
    ? [
        ...badges,
        {
          type: "stale_hard_ceiling_advisory" as const,
          label: `${hardLabel} verdict is review-only until decision data is fresh`,
          severity: "warning" as const,
        },
      ]
    : badges;

  return buildDecisionOutput(nextCtx, {
    label: finalLabel,
    reason: finalReason,
    confidence: capConfidence(
      clampConfidence(ctx.confidenceBase, confidenceDeltas),
      confidenceCapForDecision(finalBadges, {
        requestedHardAction:
          requestedAuthorityHold !== null &&
          isHardActionLabel(requestedAuthorityHold.blockedActionType),
        profileHardAction: profileBlocksHardAuthority,
      }),
    ),
    badges: finalBadges,
    preAuthorityLabel,
    authorityBlocker: profileBlocksHardAuthority
      ? "profile_hard_action_ineligible"
      : requestedAuthorityHold?.authorityBlocker ??
        (freshnessBlocksHardAuthority ? "source_freshness" : null),
    blockedActionType: profileBlocksHardAuthority
      ? preAuthorityLabel
      : requestedAuthorityHold?.blockedActionType ??
        (freshnessBlocksHardAuthority ? hardLabel : null),
    labelTransform: transformed.labelTransform,
  });
}

export function enforceHardActionEligibility(
  decision: DecisionOutput,
  profile: AccountDecisionProfile,
): DecisionOutput {
  if (decision.label === "scale" && !profile.hardActionEligibility.scale) {
    const reason =
      profile.hardActionEligibility.reasons?.scale ??
      profile.hardActionEligibility.reason;
    return {
      ...decision,
      label: "keep",
      reason: `[near scale, soft-only] ${decision.reason} (Reason for soft mode: ${reason})`,
      badges: appendDecisionBadgeOnce(
        decision.badges,
        SCALE_READINESS_BLOCKED_BADGE,
      ),
      authorityBlocker:
        decision.authorityBlocker ?? "profile_hard_action_ineligible",
      blockedActionType: decision.blockedActionType ?? "scale",
      confidence: capConfidence(
        decision.confidence,
        HARD_ACTION_HOLD_CONFIDENCE_CAP,
      ),
    };
  }
  if (decision.label === "cut" && !profile.hardActionEligibility.cut) {
    const reason =
      profile.hardActionEligibility.reasons?.cut ??
      profile.hardActionEligibility.reason;
    return {
      ...decision,
      label: "test_more",
      reason: `[soft-only - cut blocked] ${decision.reason} (${reason})`,
      badges: appendDecisionBadgeOnce(decision.badges, {
        type: "cut_candidate",
        label: "Soft-cut candidate",
        severity: "warning",
      }),
      authorityBlocker:
        decision.authorityBlocker ?? "profile_hard_action_ineligible",
      blockedActionType: decision.blockedActionType ?? "cut",
      confidence: capConfidence(
        decision.confidence,
        HARD_ACTION_HOLD_CONFIDENCE_CAP,
      ),
    };
  }
  if (decision.label === "refresh" && !profile.hardActionEligibility.refresh) {
    const reason =
      profile.hardActionEligibility.reasons?.refresh ??
      profile.hardActionEligibility.reason;
    return {
      ...decision,
      label: "keep",
      reason: `[soft-only - refresh blocked] ${decision.reason} (${reason})`,
      authorityBlocker:
        decision.authorityBlocker ?? "profile_hard_action_ineligible",
      blockedActionType: decision.blockedActionType ?? "refresh",
      confidence: capConfidence(
        decision.confidence,
        HARD_ACTION_HOLD_CONFIDENCE_CAP,
      ),
    };
  }
  return decision;
}
