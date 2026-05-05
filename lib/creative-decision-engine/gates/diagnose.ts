import {
  finalizeDecision,
  type GateContext,
  type GateResult,
} from "./types";
import { computeFunnelDiagnosis } from "../funnel";

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
    return terminal(
      ctx,
      `Active creative — 0 spend in last 7d, 28d total $${spend.toFixed(
        0,
      )} — check delivery (ad set status, budget, audience size, frequency caps).`,
      65,
    );
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
