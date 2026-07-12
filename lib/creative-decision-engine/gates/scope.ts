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
    effectiveTargetRoas: 0,
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

  const contextGrain = ctx.input.contextGrain;
  if (contextGrain !== undefined) {
    const requiredCounts = [
      contextGrain.providerAccountCount,
      contextGrain.campaignCount,
      contextGrain.adsetCount,
      contextGrain.optimizationContextCount,
      contextGrain.objectiveCount,
    ];
    const identityUnavailable =
      contextGrain.contextIdentityUnknown ||
      requiredCounts.some(
        (count) => !Number.isInteger(count) || count <= 0,
      );

    if (identityUnavailable) {
      return {
        kind: "terminal",
        output: finalizeDecision(
          ctxWithDefaults,
          "out_of_scope",
          "decision context identity unavailable; evaluate at ad grain",
        ),
      };
    }

    if (requiredCounts.some((count) => count > 1)) {
      return {
        kind: "terminal",
        output: finalizeDecision(
          ctxWithDefaults,
          "out_of_scope",
          "mixed decision context; evaluate at ad grain",
        ),
      };
    }
  }

  if (
    ctx.input.effectiveCohort === "unknown" ||
    (contextGrain !== undefined &&
      (ctx.input.effectiveCohort === null ||
        ctx.input.effectiveCohort === undefined))
  ) {
    return {
      kind: "terminal",
      output: finalizeDecision(
        ctxWithDefaults,
        "out_of_scope",
        "mixed/unresolved optimization cohort; purchase decision engine does not evaluate it.",
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
