import {
  type AccountCalibration,
  type BusinessConfig,
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
import { finalizeDecision, type GateContext } from "./gates/types";

function initialContext(
  input: CreativeInput,
  businessConfig: BusinessConfig,
  calibration: AccountCalibration,
  dataHealth?: DataHealth,
): GateContext {
  return {
    input,
    businessConfig,
    calibration,
    dataHealth,
    effectiveTargetRoas: businessConfig.globalDefaultTargetRoas,
    truthSource: "global_default",
    ratioToTarget: null,
    badges: [],
    confidenceBase: 75,
    confidenceDeltas: [],
    generatedAt: new Date().toISOString(),
  };
}

export function decideCreative(
  input: CreativeInput,
  businessConfig: BusinessConfig,
  calibration: AccountCalibration,
  dataHealth?: DataHealth,
): DecisionOutput {
  let result = scopeGate(
    initialContext(input, businessConfig, calibration, dataHealth),
  );
  if (result.kind === "terminal") {
    return result.output;
  }

  result = targetResolutionGate(result.context);
  if (result.kind === "terminal") {
    return result.output;
  }

  result = diagnoseGate(result.context);
  if (result.kind === "terminal") {
    return result.output;
  }

  result = zeroConvBurnerGate(result.context);
  if (result.kind === "terminal") {
    return result.output;
  }

  result = maturityGate(result.context);
  if (result.kind === "terminal") {
    return result.output;
  }

  result = ratioZonesGate(result.context);
  if (result.kind === "terminal") {
    return result.output;
  }

  return finalizeDecision(
    result.context,
    "test_more",
    "Pipeline reached end without decision.",
  );
}
