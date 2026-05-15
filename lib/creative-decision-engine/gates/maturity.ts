import { finalizeDecision, type GateContext, type GateResult } from "./types";

function formatSpend(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

function positiveFinite(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function maturitySpendThreshold(ctx: GateContext): number {
  const minSpendFloor = ctx.profile.thresholds.recentSampleMinSpend ?? 50;
  const accountCpaP50 =
    ctx.profile.accountBaselines.accountCpaP50 ??
    ctx.profile.spendUnitEvidence.accountCpaP50;

  if (positiveFinite(accountCpaP50)) {
    return Math.max(minSpendFloor, accountCpaP50 * ctx.profile.multipliers.hardCut);
  }

  if (positiveFinite(ctx.profile.thresholds.hardCutSpend)) {
    return Math.max(minSpendFloor, ctx.profile.thresholds.hardCutSpend);
  }

  return (
    ctx.profile.accountBaselines.matureSpendP50 ??
    ctx.profile.thresholds.recentSampleMinSpend ??
    300
  );
}

function maturityPurchasesThreshold(ctx: GateContext): number {
  const winnerPurchaseP50 = ctx.profile.accountBaselines.winnerPurchaseP50;
  if (
    typeof winnerPurchaseP50 === "number" &&
    Number.isFinite(winnerPurchaseP50) &&
    winnerPurchaseP50 > 0
  ) {
    return Math.max(
      3,
      Math.ceil(winnerPurchaseP50 * ctx.profile.multipliers.recentSample),
    );
  }
  return Math.max(
    3,
    Math.ceil(
      ctx.profile.thresholds.scaleMinPurchases *
        ctx.profile.multipliers.recentSample,
    ),
  );
}

export function maturityGate(ctx: GateContext): GateResult {
  const purchases = ctx.input.purchases ?? 0;
  const ageDays = ctx.input.ageDays;
  const ageDaysSuffix = ageDays !== null ? `, age ${ageDays}d` : "";
  const spendThreshold = maturitySpendThreshold(ctx);
  const purchasesThreshold = maturityPurchasesThreshold(ctx);

  if (
    ctx.input.spend < spendThreshold ||
    purchases < purchasesThreshold
  ) {
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
          ).toFixed(0)}% of target on $${formatSpend(
            ctx.input.spend,
          )} (28d) — spend exceeded hard-cut threshold $${formatSpend(
            hardCutSpend,
          )} and ratio is below severe-loser zone (${(
            severeLoserRatio * 100
          ).toFixed(0)}%); decisive cut despite young age / thin sample.`,
        ),
      };
    }

    return {
      kind: "terminal",
      output: finalizeDecision(
        ctx,
        "test_more",
        `Thin data (28d spend $${formatSpend(
          ctx.input.spend,
        )}, ${purchases} purchases${ageDaysSuffix}) — let the creative accumulate signal.`,
      ),
    };
  }

  return { kind: "advance", context: ctx };
}
