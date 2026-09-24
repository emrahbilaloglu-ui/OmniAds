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

  if (ctx.input.sourceCoverageStatus === "incomplete" || ctx.input.sourceCoverageStatus === "after_cutoff") {
    const afterCutoff = ctx.input.sourceCoverageStatus === "after_cutoff";
    const predicate = afterCutoff
      ? "creative_source_knowledge_after_cutoff"
      : "creative_source_coverage_incomplete";
    const reason = afterCutoff
      ? "creative_source_knowledge_after_cutoff: at least one creative-day record was written after this historical evaluation cutoff, so it cannot authorize a past decision; other source gaps may also remain. Review the individual ads using their verified decision evidence."
      : "creative_source_coverage_incomplete: one or more source ad days lack a complete, verified creative membership and metrics record; review the individual ads using their verified decision evidence.";
    return {
      kind: "terminal",
      output: finalizeDecision(
        {
          ...ctxWithDefaults,
          confidenceBase: 40,
          blockers: [
            ...ctx.blockers,
            {
              predicate,
              observed: null,
              threshold: afterCutoff ? "source_knowledge_before_evaluation_cutoff" : "complete_published_ad_day_coverage",
              status: "missing",
              severity: "warning",
              reason,
            },
          ],
        },
        "diagnose",
        reason,
      ),
    };
  }

  if (ctx.input.configProvenanceStatus === "unverified") {
    const reason =
      "config_provenance_unverified: campaign objective and ad set optimization settings lack verified records for these dates; review the individual ads using their verified decision evidence.";
    return {
      kind: "terminal",
      output: finalizeDecision(
        {
          ...ctxWithDefaults,
          confidenceBase: 40,
          blockers: [
            ...ctx.blockers,
            {
              predicate: "config_provenance_unverified",
              observed: null,
              threshold: "provider_receipt_day_bracketed",
              status: "missing",
              severity: "warning",
              reason,
            },
          ],
        },
        "diagnose",
        reason,
      ),
    };
  }

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
