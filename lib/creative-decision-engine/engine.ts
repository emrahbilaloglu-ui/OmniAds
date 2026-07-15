import {
  type AccountDecisionProfile,
  type CreativeInput,
  type DataHealth,
  type DecisionKindSource,
  type DecisionOutput,
} from "./types";
import { diagnoseGate } from "./gates/diagnose";
import { maturityGate } from "./gates/maturity";
import { qualityOnlyGate } from "./gates/quality-only";
import { ratioZonesGate } from "./gates/ratio-zones";
import { scopeGate } from "./gates/scope";
import { targetResolutionGate } from "./gates/target-resolution";
import { zeroConvBurnerGate } from "./gates/zero-conv-burner";
import { selectKindAwareDecisionProfile } from "./kind-aware-profile";
import {
  enforceHardActionEligibility,
  finalizeDecision,
  type GateContext,
} from "./gates/types";

export function initialConfidenceDeltas(
  profile: AccountDecisionProfile,
): number[] {
  const untrustedCommercialThreshold =
    profile.quality.commercialTruthFreshness === "unknown" &&
    profile.spendUnitEvidence.warnings.some(
      (warning) => warning === "commercial_target_freshness_unknown",
    );
  const confidenceForIndependentPenalty = untrustedCommercialThreshold
    ? profile.spendUnitEvidence.confidenceBeforeFreshness ??
      profile.spendUnitConfidence
    : profile.spendUnitConfidence;
  return confidenceForIndependentPenalty === "insufficient"
    ? [-20]
    : confidenceForIndependentPenalty === "low"
      ? [-10]
      : [];
}

function initialContext(
  input: CreativeInput,
  profile: AccountDecisionProfile,
  dataHealth?: DataHealth,
): GateContext {
  const confidenceDeltas = initialConfidenceDeltas(profile);

  return {
    input,
    profile,
    dataHealth,
    effectiveTargetRoas: 0,
    truthSource: "global_default",
    ratioToTarget: null,
    badges: [],
    confidenceBase: 75,
    confidenceDeltas,
    blockers: [],
    generatedAt: new Date().toISOString(),
  };
}

export function decideCreative(
  input: CreativeInput,
  profile: AccountDecisionProfile,
  dataHealth?: DataHealth,
): DecisionOutput {
  const {
    profile: decisionProfile,
    decisionKindSource,
  } = selectKindAwareDecisionProfile(input, profile);
  const finalizeOutput = (output: DecisionOutput) =>
    withDecisionKindSource(
      enforceHardActionEligibility(output, decisionProfile),
      decisionKindSource,
    );
  let result = scopeGate(
    initialContext(input, decisionProfile, dataHealth),
  );
  if (result.kind === "terminal") {
    return finalizeOutput(result.output);
  }

  result = targetResolutionGate(result.context);
  if (result.kind === "terminal") {
    return finalizeOutput(result.output);
  }

  result = diagnoseGate(result.context);
  if (result.kind === "terminal") {
    return finalizeOutput(result.output);
  }

  result = qualityOnlyGate(result.context);
  if (result.kind === "terminal") {
    return finalizeOutput(result.output);
  }

  result = zeroConvBurnerGate(result.context);
  if (result.kind === "terminal") {
    return finalizeOutput(result.output);
  }

  result = maturityGate(result.context);
  if (result.kind === "terminal") {
    return finalizeOutput(result.output);
  }

  result = ratioZonesGate(result.context);
  if (result.kind === "terminal") {
    return finalizeOutput(result.output);
  }

  return finalizeOutput(
    finalizeDecision(
      result.context,
      "test_more",
      "Pipeline reached end without decision.",
    ),
  );
}

function withDecisionKindSource(
  decision: DecisionOutput,
  decisionKindSource: DecisionKindSource,
): DecisionOutput {
  return {
    ...decision,
    decisionKindSource,
  };
}
