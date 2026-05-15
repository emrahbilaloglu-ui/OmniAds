import {
  finalizeDecision,
  type GateContext,
  type GateResult,
} from "./types";
import { computeFunnelDiagnosis } from "../funnel";
import type { DecisionBadge } from "../types";

function terminal(ctx: GateContext, reason: string, confidenceBase: number) {
  return {
    kind: "terminal" as const,
    output: finalizeDecision(
      {
        ...ctx,
        confidenceBase,
      },
      "diagnose",
      reason,
    ),
  };
}

export function diagnoseGate(ctx: GateContext): GateResult {
  const spend = ctx.input.spend;

  if (
    ctx.input.effectiveStatus === "ACTIVE" &&
    (ctx.input.recent7dSpend ?? 0) === 0 &&
    spend > 0
  ) {
    return {
      kind: "advance",
      context: {
        ...ctx,
        badges: [
          ...ctx.badges,
          {
            type: "delivery_limited",
            label: `Active creative has 0 spend in last 7d after $${spend.toFixed(
              0,
            )} 28d spend; treat as low-delivery warning, not creative failure`,
            severity: "info",
          },
        ],
        confidenceDeltas: [...ctx.confidenceDeltas, -5],
      },
    };
  }

  const policyReason = ctx.input.policyReason?.trim() ?? "";

  if (ctx.input.effectiveStatus === "REJECTED" || policyReason.length > 0) {
    return terminal(
      ctx,
      policyReason.length > 0
        ? `Policy reject: ${policyReason}`
        : "Policy rejection detected — review and resubmit.",
      75,
    );
  }

  if (
    ctx.input.dataFreshnessHours !== null &&
    ctx.input.dataFreshnessHours > 48
  ) {
    return terminal(
      ctx,
      `Stale data: last sync ${Math.round(
        ctx.input.dataFreshnessHours,
      )}h ago — refresh ad insights pipeline.`,
      60,
    );
  }

  const funnelDiagnosis = computeFunnelDiagnosis({
    creative: ctx.input,
    funnelCalibration: ctx.profile.funnelCalibration,
    profile: ctx.profile,
  });

  if (
    (funnelDiagnosis.primaryWeakStage === "landing_page" ||
      funnelDiagnosis.primaryWeakStage === "checkout") &&
    funnelDiagnosis.confidence >= 0.65
  ) {
    const badge: DecisionBadge =
      funnelDiagnosis.primaryWeakStage === "landing_page"
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

    return terminal(
      {
        ...ctx,
        badges: [...ctx.badges, badge],
      },
      `${badge.label}: ${funnelDiagnosis.evidence.join(
        "; ",
      )}. This is a funnel-step diagnosis, not proof that the creative itself is the problem.`,
      70,
    );
  }

  if (funnelDiagnosis.primaryWeakStage === "tracking") {
    return terminal(
      {
        ...ctx,
        badges: [
          ...ctx.badges,
          {
            type: "tracking_anomaly",
            label: "Tracking anomaly",
            severity: "warning",
          },
        ],
      },
      `Tracking anomaly: ${funnelDiagnosis.evidence.join(
        "; ",
      )}. Verify pixel/CAPI purchase event firing before acting.`,
      85,
    );
  }

  return { kind: "advance", context: ctx };
}
