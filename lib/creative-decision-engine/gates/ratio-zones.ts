import type {
  AccountCalibration,
  BusinessConfig,
  CreativeInput,
  DecisionBadge,
  DecisionLabel,
} from "../types";
import { finalizeDecision, type GateContext, type GateResult } from "./types";

const TARGET_BAND_MIN_RATIO = 0.85;
const WEAK_TARGET_MAX_RATIO = 0.95;
const AT_TARGET_MAX_RATIO = 1.15;
const WORKING_ZONE_MIN_RATIO = 0.7;
const SUSTAINED_LOSER_MIN_SPEND = 500;
const SUSTAINED_LOSER_MAX_RATIO = 0.4;
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
  spendThreshold: number;
  purchases: number;
  purchasesThreshold: number;
  recent7dRoas: number | null;
  targetRoas: number;
}): string[] {
  const blockers: string[] = [];

  if (
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

  return blockers;
}

function scaleMinSpend(businessConfig: BusinessConfig): number {
  return Math.max(500, businessConfig.maturitySpendThreshold * 2);
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
  const peakAge =
    daysSincePeak != null ? ` (peak ${daysSincePeak}d ago)` : "";

  if (
    label === "scale" &&
    (position === "rising" || position === "plateau")
  ) {
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

export function shouldRefreshOnFatigue(
  input: CreativeInput,
  calibration: AccountCalibration,
  businessConfig: BusinessConfig,
): boolean {
  if (input.fatigueStatus !== "fatigued") {
    return false;
  }

  if (input.recent7dRoas === null || input.roas === null || input.roas <= 0) {
    return false;
  }

  if (
    input.recent7dSpend === null ||
    input.recent7dSpend < businessConfig.recentSampleMinSpend
  ) {
    return false;
  }

  const threshold = calibration.refreshRatioP10 ?? REFRESH_RATIO_FALLBACK;
  return input.recent7dRoas / input.roas < threshold;
}

function terminal(
  ctx: GateContext,
  label: DecisionLabel,
  reason: string,
  badges: readonly DecisionBadge[] = [],
): GateResult {
  return {
    kind: "terminal",
    output: finalizeDecision(
      {
        ...ctx,
        badges: [...ctx.badges, ...badges],
      },
      label,
      withLifecycleHint(reason, ctx, label),
    ),
  };
}

export function ratioZonesGate(ctx: GateContext): GateResult {
  const { input, businessConfig, calibration } = ctx;
  const ratio = ctx.ratioToTarget;
  const roas = input.roas;
  const purchases = input.purchases ?? 0;

  if (ratio === null || roas === null) {
    return terminal(
      ctx,
      "test_more",
      "ROAS unavailable (28d) — cannot evaluate against target.",
    );
  }

  if (ratio >= businessConfig.scaleRatioThreshold) {
    const scaleSpendThreshold = scaleMinSpend(businessConfig);
    const scalePurchasesThreshold =
      businessConfig.maturityPurchasesThreshold * 2;
    const recent7dRoas = input.recent7dRoas;
    const hasScaleSpendDepth = input.spend >= scaleSpendThreshold;
    const hasScalePurchaseDepth = purchases >= scalePurchasesThreshold;
    const fatigueBadges =
      input.fatigueStatus === "fatigued" ? [FATIGUE_FATIGUED_BADGE] : [];

    if (
      hasScaleSpendDepth &&
      hasScalePurchaseDepth &&
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
    });

    return terminal(
      ctx,
      "keep",
      `[near scale] ROAS ${formatRoas(roas)} (28d) above target (${formatRatioPercent(
        ratio,
      )}%) — ${blockers.join("; ")}; observe.`,
      fatigueBadges,
    );
  }

  if (ratio >= TARGET_BAND_MIN_RATIO) {
    const scaleSpendThreshold = scaleMinSpend(businessConfig);
    const scalePurchasesThreshold =
      businessConfig.maturityPurchasesThreshold * 2;
    const recentRatio = recentToTotalRoasRatio(input);

    if (
      shouldRefreshOnFatigue(input, calibration, businessConfig) &&
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
            )}%) — needs $${formatSpend(
              scaleSpendThreshold,
            )}+ spend or ${scalePurchasesThreshold}+ purchases for full scale`;

    return terminal(
      ctx,
      "keep",
      `${targetBandReason}${fatigueWatchSuffix}.`,
      fatigueBadges,
    );
  }

  if (ratio < WORKING_ZONE_MIN_RATIO) {
    if (input.spend >= businessConfig.cutMaturitySpendThreshold) {
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
      input.spend >= SUSTAINED_LOSER_MIN_SPEND &&
      ratio < SUSTAINED_LOSER_MAX_RATIO
    ) {
      return terminal(
        ctx,
        "cut",
        `ROAS ${formatRoas(roas)} (28d) = ${formatRatioPercent(
          ratio,
        )}% of target after $${formatSpend(input.spend)} spend (28d) — sustained loser.`,
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
  if (
    shouldRefreshOnFatigue(input, calibration, businessConfig) &&
    recent7dRoas !== null
  ) {
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

  return terminal(
    ctx,
    "keep",
    `[weak zone] ROAS ${formatRoas(roas)} (28d) = ${formatRatioPercent(
      ratio,
    )}% of target — below target but in working zone, no aggressive action; revisit if ROAS drifts further.`,
    [WEAK_PERFORMANCE_BADGE, ...fatigueBadges],
  );
}
