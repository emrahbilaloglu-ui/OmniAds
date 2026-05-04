import { SUPPORTED_OBJECTIVES } from "../config";
import {
  finalizeDecision,
  type GateContext,
  type GateResult,
} from "./types";

export function scopeGate(ctx: GateContext): GateResult {
  const objective = ctx.input.objective;

  if (objective === null || !SUPPORTED_OBJECTIVES.has(objective)) {
    const nextCtx: GateContext = {
      ...ctx,
      effectiveTargetRoas: ctx.businessConfig.globalDefaultTargetRoas,
      truthSource: "global_default",
      ratioToTarget: null,
      badges: [],
      confidenceBase: 60,
      confidenceDeltas: [],
    };

    return {
      kind: "terminal",
      output: finalizeDecision(
        nextCtx,
        "out_of_scope",
        `Engine currently supports OUTCOME_SALES only; this creative is ${
          objective ?? "unknown"
        }.`,
      ),
    };
  }

  return { kind: "advance", context: ctx };
}
