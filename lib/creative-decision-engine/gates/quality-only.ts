import type { DecisionBadge, DecisionLabel } from "../types";
import { assessQualityOnly } from "../funnel";
import { finalizeDecision, type GateContext, type GateResult } from "./types";

function formatScore(value: number | null): string {
  return value === null ? "n/a" : `${value.toFixed(2)}x`;
}

function qualityBadge(): DecisionBadge {
  return {
    type: "quality_only_assessment",
    label: "Quality-only assessment; no profit target or account ROAS benchmark",
    severity: "info",
  };
}

function weakQualityBadge(): DecisionBadge {
  return {
    type: "creative_quality_weak",
    label: "Creative quality weak",
    severity: "warning",
  };
}

function issueBadge(
  stage: "landing_page" | "checkout",
): DecisionBadge {
  return stage === "landing_page"
    ? {
        type: "landing_page_issue",
        label: "Landing page issue",
        severity: "warning",
      }
    : {
        type: "checkout_breakdown",
        label: "Checkout breakdown",
        severity: "warning",
      };
}

function terminal(input: {
  ctx: GateContext;
  label: DecisionLabel;
  reason: string;
  badges?: DecisionBadge[];
  confidenceBase?: number;
}): GateResult {
  return {
    kind: "terminal",
    output: finalizeDecision(
      {
        ...input.ctx,
        badges: [...input.ctx.badges, qualityBadge(), ...(input.badges ?? [])],
        confidenceBase: input.confidenceBase ?? input.ctx.confidenceBase,
      },
      input.label,
      input.reason,
    ),
  };
}

export function qualityOnlyGate(ctx: GateContext): GateResult {
  if (ctx.truthSource !== "global_default" || ctx.ratioToTarget !== null) {
    return { kind: "advance", context: ctx };
  }

  const assessment = assessQualityOnly({
    creative: ctx.input,
    funnelCalibration: ctx.profile.funnelCalibration,
    profile: ctx.profile,
  });
  const score = formatScore(assessment.score);
  const evidence = assessment.evidence.slice(0, 4).join("; ");

  if (
    (assessment.diagnosis.primaryWeakStage === "landing_page" ||
      assessment.diagnosis.primaryWeakStage === "checkout") &&
    assessment.diagnosis.confidence >= 0.65
  ) {
    const stage = assessment.diagnosis.primaryWeakStage;
    return terminal({
      ctx,
      label: "diagnose",
      reason: `[quality-only] ${stage} bottleneck detected before profit evaluation: ${assessment.diagnosis.evidence.join(
        "; ",
      )}. Do not judge the creative as a sales loser until this step is checked.`,
      badges: [issueBadge(stage)],
      confidenceBase: 70,
    });
  }

  if (assessment.status === "insufficient") {
    return terminal({
      ctx,
      label: "test_more",
      reason: `[quality-only] No target ROAS and no reliable account ROAS benchmark; funnel sample is insufficient (${assessment.evidence.join(
        "; ",
      )}). Keep collecting upper/mid-funnel signal before a profit action.`,
      confidenceBase: 55,
    });
  }

  if (
    assessment.status === "strong" ||
    assessment.status === "above_average"
  ) {
    return terminal({
      ctx,
      label: "keep",
      reason: `[quality-only ${assessment.status}] Upper/mid-funnel score ${score} vs account baseline (${evidence}). Keep testing; no profit-scale action without target ROAS or account ROAS benchmark.`,
      confidenceBase: Math.round(assessment.confidence * 100),
    });
  }

  if (assessment.status === "neutral") {
    return terminal({
      ctx,
      label: "test_more",
      reason: `[quality-only neutral] Upper/mid-funnel score ${score} vs account baseline (${evidence}). No hard action until profit target or stronger funnel separation exists.`,
      confidenceBase: Math.round(assessment.confidence * 100),
    });
  }

  return terminal({
    ctx,
    label: "test_more",
    reason: `[quality-only ${assessment.status}] Upper/mid-funnel score ${score} vs account baseline (${evidence}). Deprioritize this creative before adding budget; no hard cut without profit target or mature sales evidence.`,
    badges: [weakQualityBadge()],
    confidenceBase: Math.round(assessment.confidence * 100),
  });
}
