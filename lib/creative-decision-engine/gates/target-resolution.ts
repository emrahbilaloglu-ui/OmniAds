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
    case "commercial_truth_stale":
      return {
        type: "truth_commercial_stale",
        label: "Target stale - reduced authority",
        severity: "warning",
      };
    case "global_default":
      return {
        type: "truth_global_default",
        label: "No profit target: quality-only assessment",
        severity: "warning",
      };
  }
}

function staleRelativeBaseline(
  profile: GateContext["profile"],
  staleTargetRoas: number,
): {
  target: number;
  truthSource: "account_baseline" | "account_baseline_thin";
} | null {
  if (profile.scope.type !== "account" || profile.scope.id === "*") {
    return null;
  }
  const calibration = profile.accountBaselines;
  if (calibration.matureCreativeCount >= 30) {
    return isFinitePositive(calibration.roasP75) &&
      calibration.roasP75 < staleTargetRoas
      ? { target: calibration.roasP75, truthSource: "account_baseline" }
      : null;
  }
  if (calibration.matureCreativeCount >= 10) {
    return isFinitePositive(calibration.roasP60) &&
      calibration.roasP60 < staleTargetRoas
      ? { target: calibration.roasP60, truthSource: "account_baseline_thin" }
      : null;
  }
  return null;
}

export function targetResolutionGate(ctx: GateContext): GateResult {
  const calibration = ctx.profile.accountBaselines;
  let effectiveTargetRoas: number;
  let truthSource: TruthSource;
  let badges: DecisionBadge[] = [];
  let confidenceDelta: number | null = null;

  if (isFinitePositive(ctx.input.targetRoas)) {
    const relativeBaseline = staleRelativeBaseline(
      ctx.profile,
      ctx.input.targetRoas,
    );
    if (ctx.input.commercialTargetFreshness === "fresh") {
      effectiveTargetRoas = ctx.input.targetRoas;
      truthSource = "commercial_truth";
    } else if (relativeBaseline !== null) {
      effectiveTargetRoas = relativeBaseline.target;
      truthSource = relativeBaseline.truthSource;
      badges = [truthBadge("commercial_truth_stale"), truthBadge(truthSource)];
      confidenceDelta = -15;
    } else {
      effectiveTargetRoas = ctx.input.targetRoas;
      truthSource = "commercial_truth_stale";
      badges = [truthBadge(truthSource)];
      confidenceDelta = -15;
    }
  } else if (
    calibration.matureCreativeCount >= 30 &&
    isFinitePositive(calibration.roasP75)
  ) {
    effectiveTargetRoas = calibration.roasP75;
    truthSource = "account_baseline";
    badges = [truthBadge(truthSource)];
    confidenceDelta = -5;
  } else if (
    calibration.matureCreativeCount >= 10 &&
    isFinitePositive(calibration.roasP60)
  ) {
    effectiveTargetRoas = calibration.roasP60;
    truthSource = "account_baseline_thin";
    badges = [truthBadge(truthSource)];
    confidenceDelta = -15;
  } else {
    effectiveTargetRoas = 0;
    truthSource = "global_default";
    badges = [truthBadge(truthSource)];
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
      badges: [...ctx.badges, ...badges],
      confidenceDeltas:
        confidenceDelta === null
          ? ctx.confidenceDeltas
          : [...ctx.confidenceDeltas, confidenceDelta],
    },
  };
}
