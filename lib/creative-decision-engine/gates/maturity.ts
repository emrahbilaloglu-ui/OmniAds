import { finalizeDecision, type GateContext, type GateResult } from "./types";

function formatSpend(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

export function maturityGate(ctx: GateContext): GateResult {
  const purchases = ctx.input.purchases ?? 0;
  const ageDays = ctx.input.ageDays;
  const ageDaysSuffix = ageDays !== null ? `, age ${ageDays}d` : "";

  if (
    ctx.input.spend < ctx.businessConfig.maturitySpendThreshold ||
    purchases < ctx.businessConfig.maturityPurchasesThreshold
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
