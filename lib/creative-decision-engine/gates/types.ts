import {
  ENGINE_VERSION,
  type AccountDecisionProfile,
  type CreativeInput,
  type DataHealth,
  type DecisionBadge,
  type DecisionLabel,
  type DecisionOutput,
  type TruthSource,
} from "../types";

export interface GateContext {
  input: CreativeInput;
  profile: AccountDecisionProfile;
  dataHealth?: DataHealth;
  effectiveTargetRoas: number;
  truthSource: TruthSource;
  ratioToTarget: number | null;
  badges: DecisionBadge[];
  confidenceBase: number;
  confidenceDeltas: number[];
  generatedAt: string;
}

export type GateResult =
  | { kind: "terminal"; output: DecisionOutput }
  | { kind: "advance"; context: GateContext };

interface BuildDecisionOutputInput {
  label: DecisionLabel;
  reason: string;
  confidence: number;
  truthSource?: TruthSource;
  effectiveTargetRoas?: number;
  ratioToTarget?: number | null;
  badges?: DecisionBadge[];
}

export function clampConfidence(
  confidenceBase: number,
  confidenceDeltas: readonly number[],
): number {
  const adjustedConfidence = confidenceDeltas.reduce(
    (confidence, delta) => confidence + delta,
    confidenceBase,
  );
  return Math.max(40, Math.min(95, adjustedConfidence));
}

export function applyPostProcess(
  ctx: GateContext,
  label: DecisionLabel,
): { badges: DecisionBadge[]; confidenceDeltas: number[] } {
  const badges: DecisionBadge[] = [...ctx.badges];
  const confidenceDeltas: number[] = [...ctx.confidenceDeltas];

  if (ctx.dataHealth) {
    if (ctx.dataHealth.calibration.staleTier === "warning") {
      badges.push({
        type: "stale_calibration",
        label: "Calibration data stale",
        severity: "warning",
      });
    } else if (ctx.dataHealth.calibration.staleTier === "disabled") {
      badges.push({
        type: "stale_calibration",
        label: "Calibration data too stale",
        severity: "warning",
      });
      confidenceDeltas.push(-10);
    }

    if (ctx.dataHealth.lifecycle.staleTier === "warning") {
      badges.push({
        type: "stale_lifecycle",
        label: "Lifecycle data stale",
        severity: "warning",
      });
    } else if (ctx.dataHealth.lifecycle.staleTier === "disabled") {
      badges.push({
        type: "stale_lifecycle",
        label: "Lifecycle data too stale",
        severity: "warning",
      });
      confidenceDeltas.push(-15);
    }

    if (ctx.dataHealth.decisions.staleTier === "warning") {
      badges.push({
        type: "stale_decision_context",
        label: "Decision context stale",
        severity: "info",
      });
    }
  }

  const ctrThreshold = ctx.profile.accountBaselines.lowCtrP10 ?? 1.0;
  if (
    typeof ctx.input.ctr === "number" &&
    ctrThreshold > 0 &&
    ctx.input.ctr < ctrThreshold
  ) {
    badges.push({
      type: "low_ctr",
      label: `Low CTR (${ctx.input.ctr.toFixed(
        2,
      )}% vs account P10 ${ctrThreshold.toFixed(2)}%)`,
      severity: "info",
    });

    if (label === "cut" || label === "refresh") {
      confidenceDeltas.push(-10);
    }
  }

  const isMissingRecent =
    ctx.input.recent7dRoas == null || ctx.input.recent7dSpend == null;
  if (
    isMissingRecent &&
    label !== "test_more" &&
    label !== "out_of_scope" &&
    label !== "diagnose"
  ) {
    badges.push({
      type: "missing_recent_data",
      label: "Recent 7d data missing",
      severity: "warning",
    });
    confidenceDeltas.push(-10);
  }

  if (
    ctx.ratioToTarget != null &&
    ctx.ratioToTarget <
      Math.min(0.6, ctx.profile.thresholds.bottomQuartileRatio ?? 0.6) &&
    ctx.profile.thresholds.cutCandidateSpend !== null &&
    ctx.input.spend >= ctx.profile.thresholds.cutCandidateSpend &&
    (label === "test_more" || label === "keep")
  ) {
    badges.push({
      type: "cut_candidate",
      label: `Cut candidate — ROAS ${(
        ctx.ratioToTarget * 100
      ).toFixed(0)}% of target on $${ctx.input.spend.toFixed(
        0,
      )} spend; consider manual cut or wait for hard threshold`,
      severity: "warning",
    });
  }

  const lifecyclePosition = ctx.input.lifecyclePosition;
  const peakAgeSuffix =
    ctx.input.daysSincePeak != null
      ? ` (peak ${ctx.input.daysSincePeak}d ago)`
      : "";

  if (lifecyclePosition === "rising") {
    if (label === "scale") {
      confidenceDeltas.push(5);
    } else if (label === "keep") {
      confidenceDeltas.push(3);
    }

    if (label === "scale" || label === "keep") {
      badges.push({
        type: "opportunity_window_open",
        label: `Opportunity window — peak now${peakAgeSuffix}`,
        severity: "info",
      });
    }
  } else if (lifecyclePosition === "plateau") {
    if (label === "scale" || label === "keep") {
      confidenceDeltas.push(2);
      badges.push({
        type: "opportunity_window_open",
        label: `Plateau — window still open${peakAgeSuffix}`,
        severity: "info",
      });
    }
  } else if (lifecyclePosition === "closing") {
    if (label === "scale" || label === "keep") {
      badges.push({
        type: "opportunity_window_closing",
        label: "Opportunity window closing",
        severity: "warning",
      });
    }
  } else if (
    lifecyclePosition === "past_peak_unclear" ||
    lifecyclePosition === "past_peak_inaction"
  ) {
    if (label === "keep" || label === "refresh" || label === "cut") {
      badges.push({
        type: "past_peak_unclear_signal",
        label:
          "Past peak — operator review recommended (cannot distinguish missed opportunity vs natural saturation)",
        severity: "warning",
      });
      if (label === "refresh" || label === "cut") {
        confidenceDeltas.push(-3);
      }
    }
  } else if (lifecyclePosition === "volatile") {
    confidenceDeltas.push(-5);
    badges.push({
      type: "volatile_trend",
      label: "Volatile spend/ROAS trend — signal noisy",
      severity: "warning",
    });
  } else if (
    lifecyclePosition == null ||
    lifecyclePosition === "insufficient_history"
  ) {
    if (label === "scale" || label === "cut" || label === "refresh") {
      badges.push({
        type: "lifecycle_unavailable",
        label:
          lifecyclePosition === "insufficient_history"
            ? "Insufficient history for lifecycle analysis"
            : "Lifecycle data unavailable",
        severity: "info",
      });
    }
  }

  return { badges, confidenceDeltas };
}

function applySoftOnlyLabel(input: {
  label: DecisionLabel;
  reason: string;
  badges: DecisionBadge[];
  profile: AccountDecisionProfile;
}): { label: DecisionLabel; reason: string; badges: DecisionBadge[] } {
  const reason = input.profile.hardActionEligibility.reason;

  if (input.label === "scale" && !input.profile.hardActionEligibility.scale) {
    return {
      label: "keep",
      reason: `[near scale, soft-only] ${input.reason} (Reason for soft mode: ${reason})`,
      badges: input.badges,
    };
  }

  if (input.label === "cut" && !input.profile.hardActionEligibility.cut) {
    return {
      label: "test_more",
      reason: `[soft-only - cut blocked] ${input.reason} (${reason})`,
      badges: [
        ...input.badges,
        {
          type: "cut_candidate",
          label: "Soft-cut candidate",
          severity: "warning",
        },
      ],
    };
  }

  if (
    input.label === "refresh" &&
    !input.profile.hardActionEligibility.refresh
  ) {
    return {
      label: "keep",
      reason: `[soft-only - refresh blocked] ${input.reason} (${reason})`,
      badges: input.badges,
    };
  }

  return input;
}

export function buildDecisionOutput(
  ctx: GateContext,
  output: BuildDecisionOutputInput,
): DecisionOutput {
  return {
    creativeId: ctx.input.creativeId,
    creativeName: ctx.input.creativeName,
    label: output.label,
    reason: output.reason,
    confidence: output.confidence,
    truthSource: output.truthSource ?? ctx.truthSource,
    effectiveTargetRoas: output.effectiveTargetRoas ?? ctx.effectiveTargetRoas,
    ratioToTarget:
      output.ratioToTarget === undefined
        ? ctx.ratioToTarget
        : output.ratioToTarget,
    badges: output.badges ?? ctx.badges,
    metrics: {
      spend: ctx.input.spend,
      purchases: ctx.input.purchases,
      roas: ctx.input.roas,
      recent7dRoas: ctx.input.recent7dRoas,
    },
    engineVersion: ENGINE_VERSION,
    generatedAt: ctx.generatedAt,
  };
}

export function finalizeDecision(
  ctx: GateContext,
  label: DecisionLabel,
  reason: string,
): DecisionOutput {
  const softOnly = applySoftOnlyLabel({
    label,
    reason,
    badges: ctx.badges,
    profile: ctx.profile,
  });
  const nextCtx = { ...ctx, badges: softOnly.badges };
  const { badges, confidenceDeltas } = applyPostProcess(
    nextCtx,
    softOnly.label,
  );

  return buildDecisionOutput(nextCtx, {
    label: softOnly.label,
    reason: softOnly.reason,
    confidence: clampConfidence(ctx.confidenceBase, confidenceDeltas),
    badges,
  });
}

export function enforceHardActionEligibility(
  decision: DecisionOutput,
  profile: AccountDecisionProfile,
): DecisionOutput {
  if (decision.label === "scale" && !profile.hardActionEligibility.scale) {
    return {
      ...decision,
      label: "keep",
      reason: `[near scale, soft-only] ${decision.reason} (Reason for soft mode: ${profile.hardActionEligibility.reason})`,
    };
  }
  if (decision.label === "cut" && !profile.hardActionEligibility.cut) {
    return {
      ...decision,
      label: "test_more",
      reason: `[soft-only - cut blocked] ${decision.reason} (${profile.hardActionEligibility.reason})`,
      badges: [
        ...decision.badges,
        {
          type: "cut_candidate",
          label: "Soft-cut candidate",
          severity: "warning",
        },
      ],
    };
  }
  if (decision.label === "refresh" && !profile.hardActionEligibility.refresh) {
    return {
      ...decision,
      label: "keep",
      reason: `[soft-only - refresh blocked] ${decision.reason} (${profile.hardActionEligibility.reason})`,
    };
  }
  return decision;
}
