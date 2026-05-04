import type { DecisionBadge, TruthSource } from "../types";
import type { GateContext, GateResult } from "./types";

function isFinitePositive(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value > 0;
}

function truthBadge(
  truthSource: Exclude<TruthSource, "commercial_truth">,
): DecisionBadge {
  switch (truthSource) {
    case "account_baseline":
      return {
        type: "truth_account_baseline",
        label: "Truth: account baseline (P75)",
        severity: "info",
      };
    case "account_baseline_thin":
      return {
        type: "truth_account_baseline_thin",
        label: "Truth: thin account baseline (P60)",
        severity: "warning",
      };
    case "global_default":
      return {
        type: "truth_global_default",
        label: "Truth: global default (operator review)",
        severity: "warning",
      };
  }
}

export function targetResolutionGate(ctx: GateContext): GateResult {
  let effectiveTargetRoas: number;
  let truthSource: TruthSource;
  let badge: DecisionBadge | null = null;
  let confidenceDelta: number | null = null;

  if (isFinitePositive(ctx.input.targetRoas)) {
    effectiveTargetRoas = ctx.input.targetRoas;
    truthSource = "commercial_truth";
  } else if (
    ctx.calibration.matureCreativeCount >= 30 &&
    isFinitePositive(ctx.calibration.roasP75)
  ) {
    effectiveTargetRoas = ctx.calibration.roasP75;
    truthSource = "account_baseline";
    badge = truthBadge(truthSource);
    confidenceDelta = -5;
  } else if (
    ctx.calibration.matureCreativeCount >= 10 &&
    isFinitePositive(ctx.calibration.roasP60)
  ) {
    effectiveTargetRoas = ctx.calibration.roasP60;
    truthSource = "account_baseline_thin";
    badge = truthBadge(truthSource);
    confidenceDelta = -15;
  } else {
    effectiveTargetRoas = ctx.businessConfig.globalDefaultTargetRoas;
    truthSource = "global_default";
    badge = truthBadge(truthSource);
    confidenceDelta = -25;
  }

  const ratioToTarget =
    ctx.input.roas !== null && effectiveTargetRoas > 0
      ? ctx.input.roas / effectiveTargetRoas
      : null;

  return {
    kind: "advance",
    context: {
      ...ctx,
      effectiveTargetRoas,
      truthSource,
      ratioToTarget,
      badges: badge === null ? ctx.badges : [...ctx.badges, badge],
      confidenceDeltas:
        confidenceDelta === null
          ? ctx.confidenceDeltas
          : [...ctx.confidenceDeltas, confidenceDelta],
    },
  };
}
