import {
  type AccountDecisionProfile,
  type CreativeInput,
  type DataHealth,
  type DecisionOutput,
} from "./types";
import { diagnoseGate } from "./gates/diagnose";
import { maturityGate } from "./gates/maturity";
import { ratioZonesGate } from "./gates/ratio-zones";
import { scopeGate } from "./gates/scope";
import { targetResolutionGate } from "./gates/target-resolution";
import { zeroConvBurnerGate } from "./gates/zero-conv-burner";
import {
  enforceHardActionEligibility,
  finalizeDecision,
  type GateContext,
} from "./gates/types";

function initialContext(
  input: CreativeInput,
  profile: AccountDecisionProfile,
  dataHealth?: DataHealth,
): GateContext {
  const confidenceDeltas =
    profile.spendUnitConfidence === "insufficient"
      ? [-20]
      : profile.spendUnitConfidence === "low"
        ? [-10]
        : [];

  return {
    input,
    profile,
    dataHealth,
    effectiveTargetRoas: 2.0,
    truthSource: "global_default",
    ratioToTarget: null,
    badges: [],
    confidenceBase: 75,
    confidenceDeltas,
    generatedAt: new Date().toISOString(),
  };
}

export function decideCreative(
  input: CreativeInput,
  profile: AccountDecisionProfile,
  dataHealth?: DataHealth,
): DecisionOutput {
  let result = scopeGate(
    initialContext(input, profile, dataHealth),
  );
  if (result.kind === "terminal") {
    return enforceHardActionEligibility(result.output, profile);
  }

  result = targetResolutionGate(result.context);
  if (result.kind === "terminal") {
    return enforceHardActionEligibility(result.output, profile);
  }

  result = diagnoseGate(result.context);
  if (result.kind === "terminal") {
    return enforceHardActionEligibility(result.output, profile);
  }

  result = zeroConvBurnerGate(result.context);
  if (result.kind === "terminal") {
    return enforceHardActionEligibility(result.output, profile);
  }

  result = maturityGate(result.context);
  if (result.kind === "terminal") {
    return enforceHardActionEligibility(result.output, profile);
  }

  result = ratioZonesGate(result.context);
  if (result.kind === "terminal") {
    return enforceHardActionEligibility(result.output, profile);
  }

  return enforceHardActionEligibility(
    finalizeDecision(
      result.context,
      "test_more",
      "Pipeline reached end without decision.",
    ),
    profile,
  );
}
