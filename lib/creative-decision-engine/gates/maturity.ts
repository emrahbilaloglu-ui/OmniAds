import { finalizeDecision, type GateContext, type GateResult } from "./types";
import { LAUNCH_MONITOR_WINDOW_DAYS } from "../config-values";
import { comparisonLabel, formatReasonNumber } from "./reason-format";

function positiveFinite(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function dateOnlyMs(value: string | null | undefined) {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return Date.UTC(
    parsed.getUTCFullYear(),
    parsed.getUTCMonth(),
    parsed.getUTCDate(),
  );
}

function launchAgeDays(ctx: GateContext) {
  const launchAt = dateOnlyMs(ctx.input.firstSpendAt ?? ctx.input.firstSeenAt);
  const generatedAt = dateOnlyMs(ctx.generatedAt);
  if (launchAt === null || generatedAt === null) return null;
  return Math.floor((generatedAt - launchAt) / 86_400_000);
}

export function commercialMaturitySpendThreshold(ctx: GateContext): number {
  const minSpendFloor = ctx.profile.thresholds.recentSampleMinSpend ?? 50;
  const configuredThreshold = ctx.profile.thresholds.commercialMaturitySpend;
  if (positiveFinite(configuredThreshold)) {
    return Math.max(minSpendFloor, configuredThreshold);
  }

  const accountCpaP50 =
    ctx.profile.accountBaselines.accountCpaP50 ??
    ctx.profile.spendUnitEvidence.accountCpaP50;

  if (positiveFinite(accountCpaP50)) {
    return Math.max(minSpendFloor, accountCpaP50 * ctx.profile.multipliers.lossBudget);
  }

  if (positiveFinite(ctx.profile.thresholds.sustainedLoserSpend)) {
    return Math.max(minSpendFloor, ctx.profile.thresholds.sustainedLoserSpend);
  }

  return (
    ctx.profile.accountBaselines.matureSpendP50 ??
    ctx.profile.thresholds.recentSampleMinSpend ??
    300
  );
}

export function maturityGate(ctx: GateContext): GateResult {
  const purchases = ctx.input.purchases ?? 0;
  const ageDays = ctx.input.ageDays;
  const ageDaysSuffix = ageDays !== null ? `, age ${ageDays}d` : "";
  const spendThreshold = commercialMaturitySpendThreshold(ctx);
  const comparison = comparisonLabel(ctx.truthSource);

  if (ctx.input.spend < spendThreshold) {
    const ratio = ctx.ratioToTarget;
    const hardCutSpend = ctx.profile.thresholds.hardCutSpend;
    const severeLoserRatio = ctx.profile.thresholds.severeLoserRatio;

    if (
      ratio !== null &&
      ctx.input.roas !== null &&
      hardCutSpend !== null &&
      severeLoserRatio !== null &&
      ctx.input.spend >= hardCutSpend &&
      ratio < severeLoserRatio
    ) {
      return {
        kind: "terminal",
        output: finalizeDecision(
          ctx,
          "cut",
          `Severe loser at scale: ROAS ${ctx.input.roas.toFixed(2)} = ${(
            ratio * 100
          ).toFixed(0)}% of ${comparison} on ${formatReasonNumber(
            ctx.input.spend,
          )} spend (28d) — spend exceeded hard-cut threshold ${formatReasonNumber(
            hardCutSpend,
          )} and ratio is below severe-loser zone (${(
            severeLoserRatio * 100
          ).toFixed(0)}%); decisive cut despite young age / thin sample.`,
        ),
      };
    }

    const explicitLaunchAgeDays = launchAgeDays(ctx);
    const launchBadges =
      explicitLaunchAgeDays !== null &&
      explicitLaunchAgeDays >= 0 &&
      explicitLaunchAgeDays <= LAUNCH_MONITOR_WINDOW_DAYS
        ? [
            {
              type: "launch_monitoring" as const,
              label: `Inside ${LAUNCH_MONITOR_WINDOW_DAYS}d launch window (explicit first-spend/first-seen basis, age ${explicitLaunchAgeDays}d)`,
              severity: "info" as const,
            },
          ]
        : [];

    return {
      kind: "terminal",
      output: finalizeDecision(
        {
          ...ctx,
          badges: [...ctx.badges, ...launchBadges],
        },
        "test_more",
        `Below commercial maturity (28d spend ${formatReasonNumber(
          ctx.input.spend,
        )} < ${formatReasonNumber(
          spendThreshold,
        )} loss-budget floor, ${purchases} purchases${ageDaysSuffix}) — let the creative accumulate signal.`,
      ),
    };
  }

  return { kind: "advance", context: ctx };
}
