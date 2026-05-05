import { finalizeDecision, type GateContext, type GateResult } from "./types";

function formatSpend(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

function maturitySpendThreshold(ctx: GateContext): number {
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
      1,
      Math.ceil(winnerPurchaseP50 * ctx.profile.multipliers.recentSample),
    );
  }
  return Math.max(
    1,
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
