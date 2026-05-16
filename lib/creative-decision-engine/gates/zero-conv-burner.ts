import { finalizeDecision, type GateContext, type GateResult } from "./types";
import { commercialMaturitySpendThreshold } from "./maturity";

export const ZERO_CONV_MIN_AGE_DAYS = 7;

function formatSpend(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

export function zeroConvBurnerGate(ctx: GateContext): GateResult {
  const purchases = ctx.input.purchases ?? 0;
  const ageDays = ctx.input.ageDays ?? 0;
  const zeroConvThreshold = ctx.profile.thresholds.zeroConvBurnerSpend;
  const spendThreshold =
    zeroConvThreshold === null
      ? commercialMaturitySpendThreshold(ctx)
      : Math.max(zeroConvThreshold, commercialMaturitySpendThreshold(ctx));

  if (
    purchases === 0 &&
    ctx.input.spend >= spendThreshold &&
    ageDays >= ZERO_CONV_MIN_AGE_DAYS
  ) {
    const nextCtx: GateContext = {
      ...ctx,
      confidenceDeltas: [...ctx.confidenceDeltas, 5],
    };

    return {
      kind: "terminal",
      output: finalizeDecision(
        nextCtx,
        "cut",
        `0 purchases on $${formatSpend(
          ctx.input.spend,
        )} spend (28d cumulative, age ${ageDays}d) — sustained zero-conversion burn past CPA-anchored maturity threshold $${formatSpend(
          spendThreshold,
        )}.`,
      ),
    };
  }

  return { kind: "advance", context: ctx };
}
