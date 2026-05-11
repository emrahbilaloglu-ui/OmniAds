import { SUPPORTED_OBJECTIVES } from "../config";
import {
  finalizeDecision,
  type GateContext,
  type GateResult,
} from "./types";

export function scopeGate(ctx: GateContext): GateResult {
  const objective = ctx.input.objective;
  const ctxWithDefaults: GateContext = {
    ...ctx,
    effectiveTargetRoas: 2.0,
    truthSource: "global_default",
    ratioToTarget: null,
    badges: [],
    confidenceBase: 60,
    confidenceDeltas: [],
  };

  if (objective === null || !SUPPORTED_OBJECTIVES.has(objective)) {
    return {
      kind: "terminal",
      output: finalizeDecision(
        ctxWithDefaults,
        "out_of_scope",
        `Engine currently supports OUTCOME_SALES only; this creative is ${
          objective ?? "unknown"
        }.`,
      ),
    };
  }

  if (
    ctx.input.effectiveCohort != null &&
    ctx.input.effectiveCohort !== "purchase"
  ) {
    return {
      kind: "terminal",
      output: finalizeDecision(
        ctxWithDefaults,
        "out_of_scope",
        `Creative runs in ${ctx.input.effectiveCohort} adsets; purchase decision engine does not evaluate it.`,
      ),
    };
  }

  return { kind: "advance", context: ctx };
}
