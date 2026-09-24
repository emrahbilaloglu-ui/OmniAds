import { finalizeDecision, type GateContext, type GateResult } from "./types";
import {
  commercialStopLossThresholds,
} from "./maturity";
import { resolveZeroConversionCutMatch } from "./cut-policy";
import { cumulativePeriodLabel, formatReasonNumber } from "./reason-format";

export { ZERO_CONV_MIN_AGE_DAYS } from "../config-values";

export function zeroConvBurnerGate(ctx: GateContext): GateResult {
  const ageDays = ctx.input.ageDays ?? 0;
  const thresholds = commercialStopLossThresholds(ctx);
  const match = resolveZeroConversionCutMatch(ctx, thresholds);

  if (match !== null) {
    const nextCtx: GateContext = {
      ...ctx,
      confidenceDeltas: [...ctx.confidenceDeltas, 5],
    };

    return {
      kind: "terminal",
      output: finalizeDecision(
        nextCtx,
        "cut",
        `0 purchases on ${formatReasonNumber(
          ctx.input.spend,
        )} spend (${cumulativePeriodLabel(ctx.input)} cumulative, age ${ageDays}d) — sustained zero-conversion burn past CPA-anchored maturity threshold ${formatReasonNumber(
          match.spendThreshold,
        )}.`,
      ),
    };
  }

  return { kind: "advance", context: ctx };
}
