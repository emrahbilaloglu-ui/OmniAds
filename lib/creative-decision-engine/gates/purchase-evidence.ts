import { qualityOnlyGate } from "./quality-only";
import { finalizeDecision, type GateContext, type GateResult } from "./types";

/** Keep independent quality observations available without authorizing purchase actions. */
export function purchaseEvidenceGate(ctx: GateContext): GateResult {
  if (ctx.input.purchaseEvidenceStatus !== "unverified") {
    return { kind: "advance", context: ctx };
  }

  const independentSignals = [
    ctx.input.ctr !== null && Number.isFinite(ctx.input.ctr)
      ? `CTR ${ctx.input.ctr.toFixed(2)}%` : null,
    ctx.input.cpm !== null && Number.isFinite(ctx.input.cpm)
      ? `CPM ${ctx.input.cpm.toFixed(2)}` : null,
  ].filter((value): value is string => value !== null);
  const reason = `purchase_evidence_unverified: at least one delivered creative day lacks source-verified purchase count; purchase actions require source-backed repair.${
    independentSignals.length > 0
      ? ` Independent delivery signals: ${independentSignals.join(", ")}.`
      : ""
  }`;
  const blocker = {
    predicate: "purchase_evidence_unverified",
    observed: null,
    threshold: "complete_source_backed_purchase_window",
    status: "missing" as const,
    severity: "warning" as const,
    reason,
  };
  const withBlocker: GateContext = {
    ...ctx,
    ratioToTarget: null,
    blockers: [...ctx.blockers, blocker],
  };

  // When no profit comparison exists, the existing quality-only gate can
  // still classify CTR/CPM and independently observed upstream funnel stages.
  // It never proposes a purchase-dependent hard action.
  const quality = qualityOnlyGate(withBlocker);
  if (quality.kind === "terminal") {
    return {
      kind: "terminal",
      output: {
        ...quality.output,
        reason: `${quality.output.reason} ${reason}`,
      },
    };
  }

  return {
    kind: "terminal",
    output: finalizeDecision(
      { ...withBlocker, confidenceBase: 40 },
      "diagnose",
      reason,
    ),
  };
}
