import {
  ENGINE_VERSION,
  type AccountCalibration,
  type BusinessConfig,
  type CreativeInput,
  type DataHealth,
  type DecisionBadge,
  type DecisionLabel,
  type DecisionOutput,
  type TruthSource,
} from "../types";

export interface GateContext {
  input: CreativeInput;
  businessConfig: BusinessConfig;
  calibration: AccountCalibration;
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

  const ctrThreshold =
    ctx.calibration.lowCtrP10 ?? ctx.businessConfig.lowCtrThresholdFallback;
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
  const { badges, confidenceDeltas } = applyPostProcess(ctx, label);

  return buildDecisionOutput(ctx, {
    label,
    reason,
    confidence: clampConfidence(ctx.confidenceBase, confidenceDeltas),
    badges,
  });
}
