import type {
  AccountDecisionProfile,
  CreativeInput,
  DecisionBadge,
  DecisionLabel,
  FunnelStage,
} from "../types";
import {
  MIN_ACCOUNT_SCALE_CALIBRATION_SAMPLE,
  SCALE_RATIO_BY_PRESET,
} from "../config";
import { computeFunnelDiagnosis, hasUpperFunnelStrength } from "../funnel";
import { finalizeDecision, type GateContext, type GateResult } from "./types";
import { commercialMaturitySpendThreshold } from "./maturity";

const TARGET_BAND_MIN_RATIO = 0.85;
const WEAK_TARGET_MAX_RATIO = 0.95;
const AT_TARGET_MAX_RATIO = 1.15;
const REFRESH_RATIO_FALLBACK = 0.75;

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

function formatSpend(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

function formatRatioPercent(value: number): string {
  return (value * 100).toFixed(0);
}

function buildNearScaleBlockers(input: {
  spend: number;
  spendThreshold: number | null;
  purchases: number;
  purchasesThreshold: number;
  recent7dRoas: number | null;
  targetRoas: number;
  scaleBenchmarkBlockers?: readonly string[];
}): string[] {
  const blockers: string[] = [];

  if (input.spendThreshold === null) {
    blockers.push("scale spend floor unavailable");
  } else if (
    input.spend < input.spendThreshold ||
    input.purchases < input.purchasesThreshold
  ) {
    blockers.push(
      `spend $${formatSpend(input.spend)} / purchases ${input.purchases} below scale floor (need ≥$${formatSpend(
        input.spendThreshold,
      )}, ≥${input.purchasesThreshold})`,
    );
  }

  if (input.recent7dRoas === null) {
    blockers.push("recent 7d ROAS missing");
  } else if (input.recent7dRoas < input.targetRoas) {
    blockers.push(
      `recent 7d ROAS ${formatRoas(input.recent7dRoas)} below target ${formatRoas(
        input.targetRoas,
      )}`,
    );
  }

  blockers.push(...(input.scaleBenchmarkBlockers ?? []));

  return blockers;
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

function formatScaleSpendNeed(value: number | null): string {
  return value === null ? "account-relative" : `$${formatSpend(value)}+`;
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

  return {
    label: "keep",
    reason: `Performance below threshold but funnel diagnosis indicates ${stage} issue, not creative; operator review recommended. Original signal: ${input.reason}`,
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
      },
      adjusted.label,
      withLifecycleHint(adjusted.reason, ctx, adjusted.label),
    ),
  };
}

export function ratioZonesGate(ctx: GateContext): GateResult {
  const { input, profile } = ctx;
  const ratio = ctx.ratioToTarget;
  const roas = input.roas;
  const purchases = input.purchases ?? 0;
  const workingZoneMinRatio = profile.thresholds.bottomQuartileRatio ?? 0.7;

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
    const hasScaleSpendDepth =
      scaleSpendThreshold !== null && input.spend >= scaleSpendThreshold;
    const hasScalePurchaseDepth = purchases >= scalePurchasesThreshold;
    const fatigueBadges =
      input.fatigueStatus === "fatigued" ? [FATIGUE_FATIGUED_BADGE] : [];

    if (
      hasScaleSpendDepth &&
      hasScalePurchaseDepth &&
      benchmarkBlockers.length === 0 &&
      recent7dRoas !== null &&
      recent7dRoas >= ctx.effectiveTargetRoas
    ) {
      return terminal(
        ctx,
        "scale",
        `ROAS ${formatRoas(roas)} (28d) = ${formatRatioPercent(
          ratio,
        )}% of target ${formatRoas(
          ctx.effectiveTargetRoas,
        )} with ${purchases} purchases (28d) and recent 7d holding at ${formatRoas(
          recent7dRoas,
        )} — scale the ad set budget.`,
        fatigueBadges,
      );
    }

    const blockers = buildNearScaleBlockers({
      spend: input.spend,
      spendThreshold: scaleSpendThreshold,
      purchases,
      purchasesThreshold: scalePurchasesThreshold,
      recent7dRoas,
      targetRoas: ctx.effectiveTargetRoas,
      scaleBenchmarkBlockers: benchmarkBlockers,
    });

    return terminal(
      ctx,
      "keep",
      `[near scale] ROAS ${formatRoas(roas)} (28d) above target (${formatRatioPercent(
        ratio,
      )}%) — ${blockers.join("; ")}; observe.`,
      [...fatigueBadges, ...scaleReadinessBadges(benchmarkBlockers)],
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
    const targetBandReason =
      ratio < WEAK_TARGET_MAX_RATIO
        ? `[weak target] ROAS ${formatRoas(
            roas,
          )} (28d) just above breakeven (${formatRatioPercent(
            ratio,
          )}% of target) — keep observing; consider tightening if recent 7d weakens`
        : ratio < AT_TARGET_MAX_RATIO
          ? `[at target] ROAS ${formatRoas(
              roas,
            )} (28d) at/around target ${formatRoas(
              ctx.effectiveTargetRoas,
            )} (${formatRatioPercent(ratio)}%) — stable, let it run`
          : `[near scale] ROAS ${formatRoas(
              roas,
            )} (28d) approaching scale threshold (${formatRatioPercent(
              ratio,
            )}%) — needs ${formatScaleSpendNeed(
              scaleSpendThreshold,
            )} spend or ${scalePurchasesThreshold}+ purchases for full scale`;

    return terminal(
      ctx,
      "keep",
      `${targetBandReason}${fatigueWatchSuffix}.`,
      fatigueBadges,
    );
  }

  if (ratio < workingZoneMinRatio) {
    const commercialMaturitySpend = commercialMaturitySpendThreshold(ctx);
    const hardCutSpend = profile.thresholds.hardCutSpend;
    const sustainedLoserSpend = profile.thresholds.sustainedLoserSpend;
    const severeLoserRatio = profile.thresholds.severeLoserRatio;

    if (hardCutSpend !== null && input.spend >= hardCutSpend) {
      return terminal(
        ctx,
        "cut",
        `ROAS ${formatRoas(roas)} (28d) = ${formatRatioPercent(
          ratio,
        )}% of target after $${formatSpend(
          input.spend,
        )} spend (28d) — clear loser at scale.`,
      );
    }

    if (
      sustainedLoserSpend !== null &&
      severeLoserRatio !== null &&
      input.spend >= sustainedLoserSpend &&
      ratio < severeLoserRatio
    ) {
      return terminal(
        ctx,
        "cut",
        `ROAS ${formatRoas(roas)} (28d) = ${formatRatioPercent(
          ratio,
        )}% of target after $${formatSpend(input.spend)} spend (28d) — sustained loser.`,
      );
    }

    if (input.spend >= commercialMaturitySpend) {
      return terminal(
        ctx,
        "cut",
        `ROAS ${formatRoas(roas)} (28d) = ${formatRatioPercent(
          ratio,
        )}% of target after $${formatSpend(
          input.spend,
        )} spend (28d) — loss-budget maturity reached at $${formatSpend(
          commercialMaturitySpend,
        )}; cut underperforming creative.`,
      );
    }

    if (input.fatigueStatus === "fatigued") {
      return terminal(
        ctx,
        "refresh",
        `ROAS ${formatRoas(roas)} (28d) = ${formatRatioPercent(
          ratio,
        )}% of target and fatigued — replace with fresh iteration.`,
      );
    }

    return terminal(
      ctx,
      "test_more",
      `ROAS ${formatRoas(roas)} (28d) = ${formatRatioPercent(
        ratio,
      )}% of target after $${formatSpend(
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
      )}% of target and fatigued with recent 7d ROAS ${formatRoas(
        recent7dRoas,
      )} decaying — iterate.`,
    );
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
    return terminal(
      ctx,
      "keep",
      `[demote candidate] ROAS ${formatRoas(roas)} (28d) = ${formatRatioPercent(
        ratio,
      )}% of target — above account bottom quartile (${formatRatioPercent(
        profile.thresholds.bottomQuartileRatio ?? 0.7,
      )}%) but below breakeven (${formatRoas(
        breakevenRoas ?? 0,
      )} = ${formatRatioPercent(breakevenRatio)}% of target) at $${formatSpend(
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
    )}% of target — below target but in working zone, no aggressive action; revisit if ROAS drifts further.`,
    [WEAK_PERFORMANCE_BADGE, ...fatigueBadges],
  );
}
