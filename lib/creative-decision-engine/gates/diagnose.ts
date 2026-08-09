import {
  finalizeDecision,
  formatAccountCurrencySpend,
  type GateContext,
  type GateResult,
} from "./types";
import { computeFunnelDiagnosis } from "../funnel";
import {
  STALE_SOURCE_UPDATED_AT_HOURS,
  STALE_TIER_NONE_MAX_HOURS,
  TARGET_BAND_MIN_RATIO,
} from "../config-values";
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
    ctx.input.dataFreshnessHours > STALE_SOURCE_UPDATED_AT_HOURS
  );
}

function isUnknownFreshness(ctx: GateContext) {
  return ctx.input.dataFreshnessHours === null;
}

function hasFreshDeliveryEvidence(ctx: GateContext) {
  return (
    ctx.input.dataFreshnessHours !== null &&
    ctx.input.dataFreshnessHours <= STALE_TIER_NONE_MAX_HOURS
  );
}

function finiteNonNegative(value: number | null | undefined): value is number {
  return (
    typeof value === "number" && Number.isFinite(value) && value >= 0
  );
}

/**
 * Purchase decisions must not infer economics from internally contradictory
 * conversion facts. Production hydration can legitimately surface a row while
 * one aggregate is missing or disagrees with the others, so this belongs in
 * the canonical diagnose gate rather than in one downstream Cut matcher.
 */
function purchaseTruthAnomaly(ctx: GateContext): string | null {
  if (ctx.input.effectiveCohort !== "purchase") return null;

  const { purchases, purchaseValue, roas, spend } = ctx.input;
  if (!finiteNonNegative(purchases)) {
    return "purchase count is missing, negative, or non-finite";
  }
  if (!finiteNonNegative(purchaseValue)) {
    return "purchase value is missing, negative, or non-finite";
  }
  if (!finiteNonNegative(roas)) {
    return "purchase ROAS is missing, negative, or non-finite";
  }

  if (purchases <= 0 && (purchaseValue > 0 || roas > 0)) {
    return `0 purchases conflicts with purchase value ${purchaseValue} and ROAS ${roas}`;
  }
  if (purchases > 0 && (purchaseValue <= 0 || (spend > 0 && roas <= 0))) {
    return `${purchases} purchases conflicts with purchase value ${purchaseValue} and ROAS ${roas}`;
  }
  if (
    spend > 0 &&
    ((purchaseValue <= 0 && roas > 0) ||
      (purchaseValue > 0 && roas <= 0))
  ) {
    return `purchase value ${purchaseValue} conflicts with ROAS ${roas}`;
  }

  const {
    recent7dSpend,
    recent7dPurchases,
    recent7dRoas,
  } = ctx.input;
  if (
    finiteNonNegative(recent7dSpend) &&
    recent7dSpend > 0 &&
    finiteNonNegative(recent7dPurchases) &&
    finiteNonNegative(recent7dRoas) &&
    ((recent7dPurchases <= 0 && recent7dRoas > 0) ||
      (recent7dPurchases > 0 && recent7dRoas <= 0))
  ) {
    return `recent purchase count ${recent7dPurchases} conflicts with recent ROAS ${recent7dRoas}`;
  }

  return null;
}

function withFreshnessEvidence(ctx: GateContext): GateContext {
  if (isUnknownFreshness(ctx)) {
    if (ctx.badges.some((badge) => badge.type === "unknown_freshness")) {
      return ctx;
    }
    return {
      ...ctx,
      badges: [
        ...ctx.badges,
        {
          type: "unknown_freshness",
          label: "Unknown freshness: source sync age is unavailable - refresh pipeline before applying.",
          severity: "warning",
        },
      ],
    };
  }

  if (!isStaleData(ctx)) return ctx;
  const hours = Math.round(ctx.input.dataFreshnessHours ?? 0);
  if (ctx.badges.some((badge) => badge.type === "stale_evidence")) {
    return ctx;
  }
  return {
    ...ctx,
    badges: [
      ...ctx.badges,
      {
        type: "stale_evidence",
        label: `Stale evidence: last sync ${hours}h ago - refresh pipeline before applying.`,
        severity: "warning",
      },
    ],
  };
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
    hasFreshDeliveryEvidence(ctx) &&
    ctx.input.spend24h <= 0 &&
    ctx.input.impressions24h <= 0
  );
}

export function diagnoseGate(ctx: GateContext): GateResult {
  ctx = withFreshnessEvidence(ctx);
  const spend = ctx.input.spend;
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

  // Explicit policy proof is stronger than a missing delivery-status join.
  // Keep the actionable resolution instead of masking it as generic unknown.
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

  if (!normalizedStatus(ctx.input.effectiveStatus)) {
    return terminal(
      {
        ...ctx,
        badges: [
          ...ctx.badges,
          {
            type: "delivery_status_unknown",
            label: "Delivery status unavailable",
            severity: "warning",
          },
        ],
      },
      "Delivery status is unavailable; resolve the current ad, ad set, and campaign state before applying a performance action.",
      55,
    );
  }

  const purchaseTruthIssue = purchaseTruthAnomaly(ctx);
  if (purchaseTruthIssue !== null) {
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
      `Tracking anomaly: contradictory purchase truth (${purchaseTruthIssue}). Verify pixel/CAPI purchase count, value, and ROAS aggregation before acting.`,
      85,
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
    hasFreshDeliveryEvidence(ctx) &&
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
            label: `Active creative has 0 spend in last 7d after ${formatAccountCurrencySpend(
              spend,
              ctx.input.accountCurrency,
            )} 28d spend; treat as low-delivery warning, not creative failure`,
            severity: "info",
          },
        ],
        confidenceDeltas: [...ctx.confidenceDeltas, -5],
      },
    };
  }

  const funnelDiagnosis = computeFunnelDiagnosis({
    creative: ctx.input,
    funnelCalibration: ctx.profile.funnelCalibration,
    profile: ctx.profile,
  });

  if (
    hasFreshDeliveryEvidence(ctx) &&
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

    const contextWithFunnelEvidence = {
      ...ctx,
      badges: [...ctx.badges, badge],
    };
    if (
      ctx.ratioToTarget !== null &&
      ctx.ratioToTarget >= TARGET_BAND_MIN_RATIO
    ) {
      return { kind: "advance", context: contextWithFunnelEvidence };
    }

    return terminal(
      contextWithFunnelEvidence,
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
