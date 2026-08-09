import type {
  AccountDecisionProfile,
  CreativeInput,
  DecisionBadge,
  DecisionLabel,
  DecisionPredicateBlocker,
  FunnelStage,
} from "../types";
import {
  AT_TARGET_MAX_RATIO,
  REFRESH_RATIO_FALLBACK,
  MIN_ACCOUNT_SCALE_CALIBRATION_SAMPLE,
  SCALE_RATIO_BY_PRESET,
  STALE_SOURCE_UPDATED_AT_HOURS,
  TARGET_BAND_MIN_RATIO,
  UNCALIBRATED_CUT_RATIO_FALLBACK,
  WEAK_TARGET_MAX_RATIO,
} from "../config-values";
import { computeFunnelDiagnosis, hasUpperFunnelStrength } from "../funnel";
import {
  finalizeDecision,
  type DecisionAuthorityHold,
  type GateContext,
  type GateResult,
} from "./types";
import {
  commercialMaturitySpendThreshold,
  commercialStopLossThresholds,
} from "./maturity";
import {
  hasCanonicalRecentRecovery,
  resolveCanonicalCutZone,
  resolveCanonicalCutZoneGeometry,
  resolveRatioZoneCutMatch,
  resolveRatioZoneCutMaturityMatch,
  resolveCutBoundary,
  resolveExpandedEconomicRecentEvidence,
  hasExplicitBreakEven,
  isBelowExplicitBreakEven,
  type RatioZoneCutMatch,
} from "./cut-policy";
import { comparisonLabel, formatReasonNumber } from "./reason-format";

export { resolveCutBoundary, type CutBoundaryResolution } from "./cut-policy";

const FATIGUE_WATCH_BADGE: DecisionBadge = {
  type: "fatigue_watch",
  label: "Fatigue watch",
  severity: "warning",
};

const FATIGUE_FATIGUED_BADGE: DecisionBadge = {
  type: "fatigue_fatigued",
  label: "Fatigued",
  severity: "warning",
};

const WEAK_PERFORMANCE_BADGE: DecisionBadge = {
  type: "weak_performance",
  label: "Below target",
  severity: "warning",
};

const BELOW_BREAKEVEN_BADGE: DecisionBadge = {
  type: "below_breakeven",
  label: "Below breakeven",
  severity: "warning",
};

const SCALE_READINESS_BLOCKED_BADGE: DecisionBadge = {
  type: "scale_readiness_blocked",
  label: "Scale readiness blocked",
  severity: "info",
};

const SCALE_CALIBRATION_THIN_BADGE: DecisionBadge = {
  type: "scale_calibration_thin",
  label: "Scale calibration thin",
  severity: "warning",
};

function positiveFinite(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function formatRoas(value: number): string {
  return value.toFixed(2);
}

function formatRatioPercent(value: number): string {
  return (value * 100).toFixed(0);
}

interface NearScaleReadiness {
  reasons: string[];
  blockers: DecisionPredicateBlocker[];
}

function blocker(input: {
  predicate: string;
  observed: string | number | null;
  threshold: string | number | null;
  status?: DecisionPredicateBlocker["status"];
  reason: string;
}): DecisionPredicateBlocker {
  return {
    predicate: input.predicate,
    observed: input.observed,
    threshold: input.threshold,
    status: input.status ?? "failed",
    severity: "warning",
    reason: input.reason,
  };
}

function buildNearScaleReadiness(input: {
  spend: number;
  spendThreshold: number | null;
  purchases: number;
  purchasesThreshold: number;
  recent7dRoas: number | null;
  targetRoas: number;
  comparisonLabel: string;
  scaleBenchmarkBlockers?: readonly string[];
  scaleFreshnessBlockers?: readonly string[];
}): NearScaleReadiness {
  const reasons: string[] = [];
  const blockers: DecisionPredicateBlocker[] = [];

  if (input.spendThreshold === null) {
    const reason = "scale spend floor unavailable";
    reasons.push(reason);
    blockers.push(
      blocker({
        predicate: "scale_spend_floor_available",
        observed: null,
        threshold: null,
        status: "missing",
        reason,
      }),
    );
  } else if (
    input.spend < input.spendThreshold ||
    input.purchases < input.purchasesThreshold
  ) {
    const reason = `spend ${formatReasonNumber(input.spend)} / purchases ${input.purchases} below scale floor (need spend ≥${formatReasonNumber(
      input.spendThreshold,
    )}, ≥${input.purchasesThreshold})`;
    reasons.push(reason);
    if (input.spend < input.spendThreshold) {
      blockers.push(
        blocker({
          predicate: "scale_spend_depth",
          observed: input.spend,
          threshold: input.spendThreshold,
          reason,
        }),
      );
    }
    if (input.purchases < input.purchasesThreshold) {
      blockers.push(
        blocker({
          predicate: "scale_purchase_depth",
          observed: input.purchases,
          threshold: input.purchasesThreshold,
          reason,
        }),
      );
    }
  }

  if (input.recent7dRoas === null) {
    const reason = "recent 7d ROAS missing";
    reasons.push(reason);
    blockers.push(
      blocker({
        predicate: "scale_recent_hold_available",
        observed: null,
        threshold: input.targetRoas,
        status: "missing",
        reason,
      }),
    );
  } else if (input.recent7dRoas < input.targetRoas) {
    const reason = `recent 7d ROAS ${formatRoas(input.recent7dRoas)} below ${input.comparisonLabel} ${formatRoas(
      input.targetRoas,
    )}`;
    reasons.push(reason);
    blockers.push(
      blocker({
        predicate: "scale_recent_hold",
        observed: input.recent7dRoas,
        threshold: input.targetRoas,
        reason,
      }),
    );
  }

  for (const reason of input.scaleBenchmarkBlockers ?? []) {
    reasons.push(reason);
    blockers.push(
      blocker({
        predicate: "scale_account_benchmark_ready",
        observed: reason,
        threshold: "ready",
        status: "missing",
        reason,
      }),
    );
  }

  for (const reason of input.scaleFreshnessBlockers ?? []) {
    reasons.push(reason);
    blockers.push(
      blocker({
        predicate: "scale_recent_freshness",
        observed: reason,
        threshold: "fresh",
        status: "missing",
        reason,
      }),
    );
  }

  return { reasons, blockers };
}

function scaleRatioThreshold(profile: AccountDecisionProfile): number {
  return SCALE_RATIO_BY_PRESET[profile.preset];
}

function scaleBenchmarkBlockers(profile: AccountDecisionProfile): string[] {
  const blockers: string[] = [];
  const matureCount = profile.accountBaselines.matureCreativeCount;

  if (!profile.quality.calibrationReady) {
    blockers.push(
      `account scale calibration thin (${matureCount} mature creatives; need ${MIN_ACCOUNT_SCALE_CALIBRATION_SAMPLE}+)`,
    );
  }

  if (!positiveFinite(profile.accountBaselines.winnerPurchaseP50)) {
    blockers.push("winner purchase benchmark unavailable");
  }

  return blockers;
}

function scaleReadinessBadges(
  benchmarkBlockers: readonly string[],
): DecisionBadge[] {
  if (benchmarkBlockers.length === 0) {
    return [SCALE_READINESS_BLOCKED_BADGE];
  }

  return [SCALE_READINESS_BLOCKED_BADGE, SCALE_CALIBRATION_THIN_BADGE];
}

function hasStaleEvidence(ctx: GateContext): boolean {
  return (
    ctx.badges.some((badge) => badge.type === "stale_evidence") ||
    (ctx.input.dataFreshnessHours !== null &&
      ctx.input.dataFreshnessHours > STALE_SOURCE_UPDATED_AT_HOURS)
  );
}

function hasUnknownFreshness(ctx: GateContext): boolean {
  return (
    ctx.badges.some((badge) => badge.type === "unknown_freshness") ||
    ctx.input.dataFreshnessHours === null
  );
}

function scaleFreshnessBlockers(ctx: GateContext): string[] {
  if (hasUnknownFreshness(ctx)) {
    return [
      "source evidence freshness is unknown; scale requires fresh recent performance proof",
    ];
  }

  if (hasStaleEvidence(ctx)) {
    return [
      `source evidence is stale (${Math.round(
        ctx.input.dataFreshnessHours ?? 0,
      )}h); scale requires fresh recent performance proof`,
    ];
  }

  return [];
}

function recentToTotalRoasRatio(input: CreativeInput): number | null {
  if (input.recent7dRoas === null || input.roas === null || input.roas <= 0) {
    return null;
  }

  return input.recent7dRoas / input.roas;
}

function appendReasonSuffix(reason: string, suffix: string): string {
  const stem = reason.endsWith(".") ? reason.slice(0, -1) : reason;
  return `${stem}${suffix}`;
}

function withLifecycleHint(
  reason: string,
  ctx: GateContext,
  label: DecisionLabel,
): string {
  const position = ctx.input.lifecyclePosition;
  const daysSincePeak = ctx.input.daysSincePeak;
  const peakAge = daysSincePeak != null ? ` (peak ${daysSincePeak}d ago)` : "";

  if (label === "scale" && (position === "rising" || position === "plateau")) {
    return appendReasonSuffix(reason, `; momentum: ${position}${peakAge}`);
  }

  if (
    label === "keep" &&
    position === "past_peak_unclear" &&
    reason.startsWith("[at target]")
  ) {
    return appendReasonSuffix(
      reason,
      "; lifecycle: past_peak_unclear — operator review recommended",
    );
  }

  if (
    label === "refresh" &&
    (position === "past_peak_unclear" || position === "past_peak_natural")
  ) {
    return appendReasonSuffix(reason, `; lifecycle: ${position}`);
  }

  return reason;
}

function hasUsableFunnelCalibration(ctx: GateContext): boolean {
  const format = ctx.input.creativeFormat ?? "overall";
  const specific = ctx.profile.funnelCalibration.byFormat[format];
  const overall = ctx.profile.funnelCalibration.byFormat.overall;
  return Boolean(
    (specific && specific.qualityStatus !== "insufficient") ||
    (overall && overall.qualityStatus !== "insufficient"),
  );
}

function appendBadgeOnce(
  badges: readonly DecisionBadge[],
  badge: DecisionBadge,
): DecisionBadge[] {
  return badges.some((existing) => existing.type === badge.type)
    ? [...badges]
    : [...badges, badge];
}

function issueBadge(stage: Extract<FunnelStage, "landing_page" | "checkout">) {
  return stage === "landing_page"
    ? ({
        type: "landing_page_issue",
        label: "Landing page issue",
        severity: "warning",
      } satisfies DecisionBadge)
    : ({
        type: "checkout_breakdown",
        label: "Checkout breakdown",
        severity: "warning",
      } satisfies DecisionBadge);
}

function funnelAdjustedDecision(input: {
  ctx: GateContext;
  label: DecisionLabel;
  reason: string;
  badges: readonly DecisionBadge[];
}): {
  label: DecisionLabel;
  reason: string;
  badges: DecisionBadge[];
} {
  if (input.label !== "cut" && input.label !== "refresh") {
    return {
      label: input.label,
      reason: input.reason,
      badges: [...input.badges],
    };
  }

  if (!hasUsableFunnelCalibration(input.ctx)) {
    return {
      label: input.label,
      reason: input.reason,
      badges: appendBadgeOnce(input.badges, {
        type: "lifecycle_unavailable",
        label: "Funnel calibration unavailable",
        severity: "info",
      }),
    };
  }

  const diagnosis = computeFunnelDiagnosis({
    creative: input.ctx.input,
    funnelCalibration: input.ctx.profile.funnelCalibration,
    profile: input.ctx.profile,
  });

  if (
    diagnosis.confidence < 0.5 ||
    diagnosis.creativeResponsible ||
    (diagnosis.primaryWeakStage !== "landing_page" &&
      diagnosis.primaryWeakStage !== "checkout")
  ) {
    return {
      label: input.label,
      reason: input.reason,
      badges: [...input.badges],
    };
  }

  const stage = diagnosis.primaryWeakStage;
  let badges = appendBadgeOnce(input.badges, issueBadge(stage));
  if (
    hasUpperFunnelStrength({
      creative: input.ctx.input,
      funnelCalibration: input.ctx.profile.funnelCalibration,
    })
  ) {
    badges = appendBadgeOnce(badges, {
      type: "upper_funnel_strong_site_weak",
      label: "Upper funnel strong, site weak",
      severity: "info",
    });
  }

  if (input.label === "cut") {
    return {
      label: input.label,
      reason: `${input.reason} Secondary diagnosis: funnel evidence indicates a ${stage} issue, not only creative weakness; verify site/checkout before executing the cut recommendation.`,
      badges,
    };
  }

  return {
    label: "keep",
    reason: `${input.reason} Funnel evidence indicates a ${stage} issue; do not refresh creative until site/checkout cause is reviewed.`,
    badges,
  };
}

export function shouldRefreshOnFatigue(
  input: CreativeInput,
  profile: AccountDecisionProfile,
): boolean {
  if (input.fatigueStatus !== "fatigued") {
    return false;
  }

  if (input.recent7dRoas === null || input.roas === null || input.roas <= 0) {
    return false;
  }

  if (
    input.recent7dSpend === null ||
    profile.thresholds.recentSampleMinSpend === null ||
    input.recent7dSpend < profile.thresholds.recentSampleMinSpend
  ) {
    return false;
  }

  const threshold =
    profile.accountBaselines.refreshRatioP10 ?? REFRESH_RATIO_FALLBACK;
  return input.recent7dRoas / input.roas < threshold;
}

function terminal(
  ctx: GateContext,
  label: DecisionLabel,
  reason: string,
  badges: readonly DecisionBadge[] = [],
  blockers: readonly DecisionPredicateBlocker[] = [],
  authorityHold?: DecisionAuthorityHold,
): GateResult {
  const adjusted = funnelAdjustedDecision({
    ctx,
    label,
    reason,
    badges: [...ctx.badges, ...badges],
  });

  return {
    kind: "terminal",
    output: finalizeDecision(
      {
        ...ctx,
        badges: adjusted.badges,
        blockers: [...ctx.blockers, ...blockers],
      },
      adjusted.label,
      withLifecycleHint(adjusted.reason, ctx, adjusted.label),
      authorityHold,
    ),
  };
}

function expandedEconomicCutReason(
  ctx: GateContext,
  cutMatch: RatioZoneCutMatch,
  comparison: string,
): string {
  const ratio = ctx.ratioToTarget ?? 0;
  const roas = ctx.input.roas ?? 0;
  const prefix = `[economic stop-loss] ROAS ${formatRoas(
    roas,
  )} (28d) = ${formatRatioPercent(ratio)}% of ${comparison}, below explicit break-even, after ${formatReasonNumber(
    ctx.input.spend,
  )} spend (28d)`;

  if (cutMatch.kind === "hard_cut") {
    return `${prefix} — clear loser at scale.`;
  }
  if (cutMatch.kind === "sustained_loser") {
    return `${prefix} — sustained loser.`;
  }
  return `${prefix} — loss-budget maturity reached at ${formatReasonNumber(
    cutMatch.commercialMaturitySpend,
  )}; cut underperforming creative.`;
}

function authorityDeniedExpandedCutReview(
  ctx: GateContext,
  comparison: string,
): GateResult | null {
  if (
    resolveCanonicalCutZoneGeometry(ctx) !== "expanded_economic_loss" ||
    resolveCanonicalCutZone(ctx) !== null
  ) {
    return null;
  }

  const profileCutDenied = !ctx.profile.hardActionEligibility.cut;
  const authorityReason = profileCutDenied
    ? (ctx.profile.hardActionEligibility.reasons?.cut ??
      ctx.profile.hardActionEligibility.reason ??
      "hard Cut profile eligibility unavailable")
    : (ctx.profile.expandedEconomicCutAuthority?.reason ??
      "expanded economic stop-loss authority unavailable");
  const authorityPredicate = profileCutDenied
    ? "hard_action_eligibility.cut"
    : "expanded_economic_cut_authority";
  const authorityThreshold = profileCutDenied ? "true" : "eligible";
  const reviewReason =
    `ROAS ${formatRoas(ctx.input.roas ?? 0)} (28d) is below explicit break-even ${formatRoas(
      ctx.profile.spendUnitEvidence.breakEvenRoas ?? 0,
    )} (${formatRatioPercent(
      ctx.ratioToTarget ?? 0,
    )}% of ${comparison}), but automatic expanded-zone Cut authority is unavailable`;
  const fatigueBadges =
    ctx.input.fatigueStatus === "watch"
      ? [FATIGUE_WATCH_BADGE]
      : ctx.input.fatigueStatus === "fatigued"
        ? [FATIGUE_FATIGUED_BADGE]
        : [];
  const fatigueWatchSuffix =
    ctx.input.fatigueStatus === "watch"
      ? "; fatigue watch — monitor for refresh signal"
      : "";

  return terminal(
    ctx,
    "keep",
    `[below break-even - stop-loss review] ${reviewReason}; keep fail-closed and review the stop-loss authority before action${fatigueWatchSuffix}.`,
    [
      BELOW_BREAKEVEN_BADGE,
      WEAK_PERFORMANCE_BADGE,
      {
        type: "stop_loss_review",
        label: "Below break-even - automatic Cut authority unavailable",
        severity: "warning",
      },
      ...fatigueBadges,
    ],
    [
      blocker({
        predicate: authorityPredicate,
        observed: authorityReason,
        threshold: authorityThreshold,
        status: "missing",
        reason: reviewReason,
      }),
    ],
  );
}

export function ratioZonesGate(ctx: GateContext): GateResult {
  const { input, profile } = ctx;
  const ratio = ctx.ratioToTarget;
  const roas = input.roas;
  const purchases = input.purchases ?? 0;
  const cutBoundary = resolveCutBoundary(ctx);
  const workingZoneMinRatio = cutBoundary.ratio;
  const canonicalCutZone = resolveCanonicalCutZone(ctx);
  const comparison = comparisonLabel(ctx.truthSource);

  if (ratio === null || roas === null) {
    return terminal(
      ctx,
      "test_more",
      "ROAS unavailable (28d) — cannot evaluate against target.",
    );
  }

  if (ratio >= scaleRatioThreshold(profile)) {
    const scaleSpendThreshold = commercialMaturitySpendThreshold(ctx);
    const scalePurchasesThreshold = profile.thresholds.scaleMinPurchases;
    const recent7dRoas = input.recent7dRoas;
    const benchmarkBlockers = scaleBenchmarkBlockers(profile);
    const freshnessBlockers = scaleFreshnessBlockers(ctx);
    const hasScaleSpendDepth =
      scaleSpendThreshold !== null && input.spend >= scaleSpendThreshold;
    const hasScalePurchaseDepth = purchases >= scalePurchasesThreshold;
    const fatigueBadges =
      input.fatigueStatus === "fatigued" ? [FATIGUE_FATIGUED_BADGE] : [];

    if (
      hasScaleSpendDepth &&
      hasScalePurchaseDepth &&
      benchmarkBlockers.length === 0 &&
      freshnessBlockers.length === 0 &&
      recent7dRoas !== null &&
      recent7dRoas >= ctx.effectiveTargetRoas
    ) {
      return terminal(
        ctx,
        "scale",
        `ROAS ${formatRoas(roas)} (28d) = ${formatRatioPercent(
          ratio,
        )}% of ${comparison} ${formatRoas(
          ctx.effectiveTargetRoas,
        )} with ${purchases} purchases (28d) and recent 7d holding at ${formatRoas(
          recent7dRoas,
        )} — scale the ad set budget.`,
        fatigueBadges,
      );
    }

    const readiness = buildNearScaleReadiness({
      spend: input.spend,
      spendThreshold: scaleSpendThreshold,
      purchases,
      purchasesThreshold: scalePurchasesThreshold,
      recent7dRoas,
      targetRoas: ctx.effectiveTargetRoas,
      comparisonLabel: comparison,
      scaleBenchmarkBlockers: benchmarkBlockers,
      scaleFreshnessBlockers: freshnessBlockers,
    });

    return terminal(
      ctx,
      "keep",
      `[near scale] ROAS ${formatRoas(roas)} (28d) above ${comparison} (${formatRatioPercent(
        ratio,
      )}%) — ${readiness.reasons.join("; ")}; observe.`,
      [...fatigueBadges, ...scaleReadinessBadges(benchmarkBlockers)],
      readiness.blockers,
    );
  }

  if (ratio >= TARGET_BAND_MIN_RATIO) {
    const scaleSpendThreshold = commercialMaturitySpendThreshold(ctx);
    const scalePurchasesThreshold = profile.thresholds.scaleMinPurchases;
    const recentRatio = recentToTotalRoasRatio(input);

    if (
      shouldRefreshOnFatigue(input, profile) &&
      input.recent7dRoas !== null &&
      recentRatio !== null
    ) {
      return terminal(
        ctx,
        "refresh",
        `Fatigued + recent 7d ROAS ${formatRoas(
          input.recent7dRoas,
        )} dropped to ${formatRatioPercent(
          recentRatio,
        )}% of ROAS ${formatRoas(roas)} (28d) — replace creative with new iteration.`,
      );
    }

    // D063's economic strip may extend above the generic 0.85 target band
    // when explicit break-even is closer to the target. Refresh keeps its
    // precedence, but the generic Keep must not make that Cut zone unreachable.
    if (canonicalCutZone !== "expanded_economic_loss") {
      const fatigueBadges =
        input.fatigueStatus === "watch"
          ? [FATIGUE_WATCH_BADGE]
          : input.fatigueStatus === "fatigued"
            ? [FATIGUE_FATIGUED_BADGE]
            : [];
      const fatigueWatchSuffix =
        input.fatigueStatus === "watch"
          ? "; fatigue watch — monitor for refresh signal"
          : "";

      const authorityDeniedReview = authorityDeniedExpandedCutReview(
        ctx,
        comparison,
      );
      if (authorityDeniedReview !== null) {
        return authorityDeniedReview;
      }

      const targetBandReason =
        ratio < WEAK_TARGET_MAX_RATIO
          ? `[weak target] ROAS ${formatRoas(
              roas,
            )} (28d) just above breakeven (${formatRatioPercent(
              ratio,
            )}% of ${comparison}) — keep observing; consider tightening if recent 7d weakens`
          : ratio < AT_TARGET_MAX_RATIO
            ? `[at target] ROAS ${formatRoas(
                roas,
              )} (28d) at/around ${comparison} ${formatRoas(
                ctx.effectiveTargetRoas,
              )} (${formatRatioPercent(ratio)}%) — stable, let it run`
            : `[near scale] ROAS ${formatRoas(
                roas,
              )} (28d) approaching scale threshold (${formatRatioPercent(
                ratio,
              )}% of ${comparison}) — performance ratio remains below the ${formatRatioPercent(
                scaleRatioThreshold(profile),
              )}% scale zone; keep running`;

      return terminal(
        ctx,
        "keep",
        `${targetBandReason}${fatigueWatchSuffix}.`,
        fatigueBadges,
      );
    }
  }

  if (
    ratio < workingZoneMinRatio &&
    (!hasExplicitBreakEven(ctx) || isBelowExplicitBreakEven(ctx))
  ) {
    const stopLossThresholds = commercialStopLossThresholds(ctx);

    if (hasCanonicalRecentRecovery(ctx)) {
      return terminal(
        ctx,
        "keep",
        `[recovery hold] ROAS ${formatRoas(roas)} (28d) = ${formatRatioPercent(
          ratio,
        )}% of ${comparison}, but recent 7d ROAS ${formatRoas(
          input.recent7dRoas ?? 0,
        )} is above ${comparison} on ${formatReasonNumber(
          input.recent7dSpend ?? 0,
        )} recent spend — do not hard cut while recovery is holding.`,
        [WEAK_PERFORMANCE_BADGE],
      );
    }

    const cutMatch = resolveRatioZoneCutMatch(ctx, stopLossThresholds);
    if (cutMatch?.kind === "hard_cut") {
      return terminal(
        ctx,
        "cut",
        `ROAS ${formatRoas(roas)} (28d) = ${formatRatioPercent(
          ratio,
        )}% of ${comparison} after ${formatReasonNumber(
          input.spend,
        )} spend (28d) — clear loser at scale.`,
      );
    }

    if (cutMatch?.kind === "sustained_loser") {
      return terminal(
        ctx,
        "cut",
        `ROAS ${formatRoas(roas)} (28d) = ${formatRatioPercent(
          ratio,
        )}% of ${comparison} after ${formatReasonNumber(input.spend)} spend (28d) — sustained loser.`,
      );
    }

    if (cutMatch?.kind === "loss_budget_maturity") {
      return terminal(
        ctx,
        "cut",
        `ROAS ${formatRoas(roas)} (28d) = ${formatRatioPercent(
          ratio,
        )}% of ${comparison} after ${formatReasonNumber(
          input.spend,
        )} spend (28d) — loss-budget maturity reached at ${formatReasonNumber(
          cutMatch.commercialMaturitySpend,
        )}; cut underperforming creative.`,
      );
    }

    if (input.fatigueStatus === "fatigued") {
      return terminal(
        ctx,
        "refresh",
        `ROAS ${formatRoas(roas)} (28d) = ${formatRatioPercent(
          ratio,
        )}% of ${comparison} and fatigued — replace with fresh iteration.`,
      );
    }

    return terminal(
      ctx,
      "test_more",
      `ROAS ${formatRoas(roas)} (28d) = ${formatRatioPercent(
        ratio,
      )}% of ${comparison} after ${formatReasonNumber(
        input.spend,
      )} spend (28d) — underperforming but spend not yet mature for hard cut, observe or pause manually.`,
    );
  }

  const recent7dRoas = input.recent7dRoas;
  if (shouldRefreshOnFatigue(input, profile) && recent7dRoas !== null) {
    return terminal(
      ctx,
      "refresh",
      `ROAS ${formatRoas(roas)} (28d) = ${formatRatioPercent(
        ratio,
      )}% of ${comparison} and fatigued with recent 7d ROAS ${formatRoas(
        recent7dRoas,
      )} decaying — iterate.`,
    );
  }

  // D063's authority presentation is independent of the generic 0.85 target
  // band. Refresh retains precedence, while an authority-denied economic loss
  // remains visible as a truthful, non-executable stop-loss review.
  const authorityDeniedReview = authorityDeniedExpandedCutReview(
    ctx,
    comparison,
  );
  if (authorityDeniedReview !== null) {
    return authorityDeniedReview;
  }

  if (canonicalCutZone === "expanded_economic_loss") {
    const cutMatch = resolveRatioZoneCutMaturityMatch(
      ctx,
      commercialStopLossThresholds(ctx),
    );

    if (cutMatch !== null) {
      const recentEvidence = resolveExpandedEconomicRecentEvidence(ctx);
      if (recentEvidence.status === "recovery") {
        return terminal(
          ctx,
          "keep",
          `[economic recovery hold] ROAS ${formatRoas(
            roas,
          )} (28d) remains below break-even, but sufficiently sampled recent 7d ROAS ${formatRoas(
            recentEvidence.recentRoas,
          )} is at or above break-even ${formatRoas(
            recentEvidence.breakEvenRoas,
          )} on ${formatReasonNumber(
            recentEvidence.recentSpend,
          )} recent spend — do not cut while economic recovery is holding.`,
          [BELOW_BREAKEVEN_BADGE, WEAK_PERFORMANCE_BADGE],
        );
      }

      const reason = expandedEconomicCutReason(ctx, cutMatch, comparison);
      if (
        recentEvidence.status === "unverifiable" ||
        recentEvidence.status === "thin"
      ) {
        const evidenceReason =
          recentEvidence.status === "thin"
            ? `recent spend ${formatReasonNumber(
                recentEvidence.recentSpend ?? 0,
              )} is below the canonical evidence floor ${formatReasonNumber(
                recentEvidence.recentSpendThreshold ?? 0,
              )}`
            : "recent ROAS, spend, canonical sample floor, or break-even evidence is unavailable";
        return terminal(
          ctx,
          "cut",
          `${reason} Recent recovery cannot be ruled out because ${evidenceReason}.`,
          [
            BELOW_BREAKEVEN_BADGE,
            WEAK_PERFORMANCE_BADGE,
            ...(recentEvidence.status === "unverifiable" &&
            recentEvidence.missingRecentData
              ? [
                  {
                    type: "missing_recent_data" as const,
                    label: "Recent break-even evidence unavailable",
                    severity: "warning" as const,
                  },
                ]
              : []),
          ],
          [
            blocker({
              predicate: "expanded_cut_recent_recovery_evidence",
              observed: recentEvidence.recentSpend,
              threshold: recentEvidence.recentSpendThreshold,
              status:
                recentEvidence.status === "unverifiable" ? "missing" : "failed",
              reason: evidenceReason,
            }),
          ],
          {
            authorityBlocker: "recent_recovery_unverifiable",
            blockedActionType: "cut",
            label: "test_more",
            reasonPrefix:
              "[cut verdict held - sufficient recent break-even evidence required]",
          },
        );
      }

      if (recentEvidence.status === "confirmed_loss") {
        return terminal(
          ctx,
          "cut",
          `${reason} Recent 7d ROAS ${formatRoas(
            recentEvidence.recentRoas,
          )} remains below break-even ${formatRoas(
            recentEvidence.breakEvenRoas,
          )} on ${formatReasonNumber(
            recentEvidence.recentSpend,
          )} recent spend.`,
          [BELOW_BREAKEVEN_BADGE, WEAK_PERFORMANCE_BADGE],
        );
      }
    }
  }

  const fatigueBadges =
    input.fatigueStatus === "fatigued" ? [FATIGUE_FATIGUED_BADGE] : [];

  const breakevenRoas = profile.spendUnitEvidence.breakEvenRoas;
  const breakevenRatio =
    breakevenRoas !== null && ctx.effectiveTargetRoas > 0
      ? breakevenRoas / ctx.effectiveTargetRoas
      : null;
  const hardCutSpend = profile.thresholds.hardCutSpend;
  const matureSpend = hardCutSpend !== null && input.spend >= hardCutSpend;

  if (breakevenRatio !== null && ratio < breakevenRatio && matureSpend) {
    const boundaryExplanation =
      cutBoundary.mode === "breakeven_ceiling"
        ? `economic cut ceiling (${formatRatioPercent(
            cutBoundary.ratio,
          )}%; minimum of account P25 ${formatRatioPercent(
            cutBoundary.accountP25 ?? cutBoundary.ratio,
          )}% and breakeven ${formatRatioPercent(
            cutBoundary.breakevenRatio ?? breakevenRatio,
          )}%)`
        : cutBoundary.mode === "uncalibrated_commercial_stop_loss"
          ? `uncalibrated commercial stop-loss (${formatRatioPercent(
              cutBoundary.ratio,
            )}%; minimum of the canonical cold-start boundary ${formatRatioPercent(
              UNCALIBRATED_CUT_RATIO_FALLBACK,
            )}% and breakeven ${formatRatioPercent(
              cutBoundary.breakevenRatio ?? breakevenRatio,
            )}%)`
          : `account bottom quartile (${formatRatioPercent(cutBoundary.ratio)}%)`;
    return terminal(
      ctx,
      "keep",
      `[demote candidate] ROAS ${formatRoas(roas)} (28d) = ${formatRatioPercent(
        ratio,
      )}% of ${comparison} — above ${boundaryExplanation} but below breakeven (${formatRoas(
        breakevenRoas ?? 0,
      )} = ${formatRatioPercent(breakevenRatio)}% of ${comparison}) at ${formatReasonNumber(
        input.spend,
      )} mature spend — consider demote to test placement or refresh creative concept.`,
      [BELOW_BREAKEVEN_BADGE, WEAK_PERFORMANCE_BADGE, ...fatigueBadges],
    );
  }

  return terminal(
    ctx,
    "keep",
    `[weak zone] ROAS ${formatRoas(roas)} (28d) = ${formatRatioPercent(
      ratio,
    )}% of ${comparison} — below the comparison benchmark but in the working zone; no aggressive action, revisit if ROAS drifts further.`,
    [WEAK_PERFORMANCE_BADGE, ...fatigueBadges],
  );
}
