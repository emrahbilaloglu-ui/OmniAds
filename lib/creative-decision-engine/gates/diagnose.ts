import {
  finalizeDecision,
  type GateContext,
  type GateResult,
} from "./types";
import type { CampaignObjective } from "../types";

const TRACKING_ANOMALY_MIN_SPEND = 50;
const TRACKING_ANOMALY_MIN_IMPRESSIONS = 1000;
const TRACKING_ANOMALY_EXCLUDED_OBJECTIVES: ReadonlySet<CampaignObjective> =
  new Set<CampaignObjective>(["OUTCOME_AWARENESS"]);

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
  const impressions = ctx.input.impressions;

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

  if (
    spend >= TRACKING_ANOMALY_MIN_SPEND &&
    impressions !== null &&
    impressions >= TRACKING_ANOMALY_MIN_IMPRESSIONS &&
    (ctx.input.linkClicks ?? 0) === 0 &&
    (ctx.input.purchases ?? 0) === 0 &&
    (ctx.input.objective === null ||
      !TRACKING_ANOMALY_EXCLUDED_OBJECTIVES.has(ctx.input.objective))
  ) {
    return terminal(
      ctx,
      `Spend $${spend.toFixed(0)} on ${Math.round(
        impressions,
      )} impressions in last 28 days, but 0 clicks and 0 purchases — possible tracking anomaly (pixel/CAPI). Verify event firing before acting.`,
      55,
    );
  }

  return { kind: "advance", context: ctx };
}
