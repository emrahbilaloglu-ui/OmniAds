import {
  finalizeDecision,
  type GateContext,
  type GateResult,
} from "./types";
import { computeFunnelDiagnosis } from "../funnel";
import { STALE_TIER_NONE_MAX_HOURS } from "../config-values";
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

function hasText(value: string | null | undefined) {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizedStatus(value: string | null | undefined) {
  if (typeof value !== "string") return "";
  return value.trim().toUpperCase().replace(/[\s-]+/g, "_");
}

const POLICY_BLOCKED_REVIEW_STATUSES = new Set([
  "REJECTED",
  "DISAPPROVED",
  "DISAPPROVED_OR_LIMITED",
  "LIMITED",
]);

function reviewStatusIsPolicyBlocked(value: string | null | undefined) {
  return POLICY_BLOCKED_REVIEW_STATUSES.has(normalizedStatus(value));
}

function isStaleData(ctx: GateContext) {
  return (
    ctx.input.dataFreshnessHours !== null &&
    ctx.input.dataFreshnessHours > 48
  );
}

function isVerifiedNoDelivery24h(ctx: GateContext) {
  return (
    ctx.input.effectiveStatus === "ACTIVE" &&
    ctx.input.spend24h !== null &&
    ctx.input.spend24h !== undefined &&
    ctx.input.impressions24h !== null &&
    ctx.input.impressions24h !== undefined &&
    // Keep this stricter than the stale-data terminal: a no-delivery claim
    // needs a fresh latest-day proof window, while 36-48h rows fall through.
    ctx.input.dataFreshnessHours !== null &&
    ctx.input.dataFreshnessHours <= STALE_TIER_NONE_MAX_HOURS &&
    ctx.input.spend24h <= 0 &&
    ctx.input.impressions24h <= 0
  );
}

export function diagnoseGate(ctx: GateContext): GateResult {
  const spend = ctx.input.spend;

  if (isStaleData(ctx)) {
    return terminal(
      ctx,
      `Stale data: last sync ${Math.round(
        ctx.input.dataFreshnessHours ?? 0,
      )}h ago — refresh ad insights pipeline.`,
      60,
    );
  }

  if (isVerifiedNoDelivery24h(ctx)) {
    return terminal(
      {
        ...ctx,
        badges: [
          ...ctx.badges,
          {
            type: "delivery_no_spend_24h",
            label:
              "Active creative has verified 0 spend and 0 impressions in the latest daily delivery window.",
            severity: "warning",
          },
        ],
      },
      "Delivery issue: active creative has verified 0 spend and 0 impressions in the latest daily delivery window; inspect ad, ad set, campaign, budget, audience, and learning constraints before judging creative performance.",
      75,
    );
  }

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

  const policyReason =
    ctx.input.disapprovalReason?.trim() ||
    ctx.input.limitedReason?.trim() ||
    ctx.input.policyReason?.trim() ||
    "";
  const reviewStatus = ctx.input.reviewStatus?.trim() ?? "";
  const hasPolicyProof =
    ctx.input.effectiveStatus === "REJECTED" ||
    hasText(policyReason) ||
    reviewStatusIsPolicyBlocked(reviewStatus);

  if (hasPolicyProof) {
    return terminal(
      {
        ...ctx,
        badges: [
          ...ctx.badges,
          {
            type: "policy_blocked",
            label:
              policyReason.length > 0
                ? `Policy/review block: ${policyReason}`
                : "Policy/review block detected",
            severity: "warning",
          },
        ],
      },
      policyReason.length > 0
        ? `Policy reject: ${policyReason}`
        : "Policy rejection detected — review and resubmit.",
      75,
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
