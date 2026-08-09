import { finalizeDecision, type GateContext, type GateResult } from "./types";
import { LAUNCH_MONITOR_WINDOW_DAYS } from "../config-values";
import { comparisonLabel, formatReasonNumber } from "./reason-format";
import {
  effectiveCommercialStopLossThresholds,
  hasExplicitBreakEven,
  isBelowExplicitBreakEven,
  maturitySpendThresholdFor,
  resolveCanonicalCutZoneGeometry,
  resolveSevereMaturityCutMatch,
} from "./cut-policy";

export { isBelowExplicitBreakEven } from "./cut-policy";

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

export function commercialStopLossThresholds(ctx: GateContext) {
  return effectiveCommercialStopLossThresholds(ctx);
}

export function commercialMaturitySpendThreshold(
  ctx: GateContext,
  mode: "default" | "commercial_stop_loss" = "default",
): number {
  const thresholds =
    mode === "commercial_stop_loss"
      ? effectiveCommercialStopLossThresholds(ctx)
      : ctx.profile.thresholds;
  return maturitySpendThresholdFor(ctx, thresholds);
}

export function maturityGate(ctx: GateContext): GateResult {
  const purchases = ctx.input.purchases ?? 0;
  const ageDays = ctx.input.ageDays;
  const ageDaysSuffix = ageDays !== null ? `, age ${ageDays}d` : "";
  const commercialStopLossThresholdView =
    effectiveCommercialStopLossThresholds(ctx);
  const commercialStopLossMode =
    commercialStopLossThresholdView !== ctx.profile.thresholds;
  const spendThreshold = commercialMaturitySpendThreshold(
    ctx,
    commercialStopLossMode ? "commercial_stop_loss" : "default",
  );
  const comparison = comparisonLabel(ctx.truthSource);

  if (ctx.input.spend < spendThreshold) {
    const ratio = ctx.ratioToTarget;
    const severeCut = resolveSevereMaturityCutMatch(
      ctx,
      commercialStopLossThresholdView,
    );

    if (severeCut !== null && ratio !== null && ctx.input.roas !== null) {
      const cutZone = resolveCanonicalCutZoneGeometry(ctx);
      // D063's bounded economic strip owns its own recent-evidence tri-state
      // and must observe working-zone Refresh precedence. Do not let this
      // earlier severe-loss gate bypass that ordered branch.
      if (cutZone === "expanded_economic_loss") {
        return { kind: "advance", context: ctx };
      }

      // A severe target-relative ratio is not economic-loss authority above
      // an explicit break-even. If no explicit break-even exists, retain the
      // prior severe-loss safety path byte-for-byte.
      if (
        !hasExplicitBreakEven(ctx) ||
        isBelowExplicitBreakEven(ctx)
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
              severeCut.hardCutSpend,
            )} and ratio is below severe-loser zone (${(
              severeCut.severeLoserRatio * 100
            ).toFixed(0)}%); decisive cut despite young age / thin sample.`,
          ),
        };
      }
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
