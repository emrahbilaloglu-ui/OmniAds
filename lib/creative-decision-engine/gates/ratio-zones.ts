import type {
  AccountDecisionProfile,
  CreativeInput,
  DecisionBadge,
  DecisionLabel,
  DecisionPredicateBlocker,
  FunnelStage,
} from "../types";
import {
  AT_TARGET_MAX_RATIO,
  REFRESH_RATIO_FALLBACK,
  MIN_ACCOUNT_SCALE_CALIBRATION_SAMPLE,
  SCALE_RATIO_BY_PRESET,
  STALE_SOURCE_UPDATED_AT_HOURS,
  TARGET_BAND_MIN_RATIO,
  UNCALIBRATED_CUT_RATIO_FALLBACK,
  WEAK_TARGET_MAX_RATIO,
} from "../config-values";
import { computeFunnelDiagnosis, hasUpperFunnelStrength } from "../funnel";
import {
  finalizeDecision,
  type DecisionAuthorityHold,
  type GateContext,
  type GateResult,
} from "./types";
import {
  commercialMaturitySpendThreshold,
  commercialStopLossThresholds,
} from "./maturity";
import {
  hasCanonicalRecentRecovery,
  recentSampleMinSpendFloor,
  resolveCanonicalCutZone,
  resolveCanonicalCutZoneGeometry,
  resolveRatioZoneCutMatch,
  resolveRatioZoneCutMaturityMatch,
  resolveCutBoundary,
  resolveExpandedEconomicRecentEvidence,
  hasExplicitBreakEven,
  isBelowExplicitBreakEven,
  type RatioZoneCutMatch,
} from "./cut-policy";
import { comparisonLabel, formatReasonNumber } from "./reason-format";

export { resolveCutBoundary, type CutBoundaryResolution } from "./cut-policy";

const FATIGUE_WATCH_BADGE: DecisionBadge = {
  type: "fatigue_watch",
  label: "Fatigue watch",
  severity: "warning",
};

const FATIGUE_FATIGUED_BADGE: DecisionBadge = {
  type: "fatigue_fatigued",
  label: "Fatigued",
  severity: "warning",
};

const WEAK_PERFORMANCE_BADGE: DecisionBadge = {
  type: "weak_performance",
  label: "Below target",
  severity: "warning",
};

const BELOW_BREAKEVEN_BADGE: DecisionBadge = {
  type: "below_breakeven",
  label: "Below breakeven",
  severity: "warning",
};

const SCALE_READINESS_BLOCKED_BADGE: DecisionBadge = {
  type: "scale_readiness_blocked",
  label: "Scale readiness blocked",
  severity: "info",
};

const SCALE_CALIBRATION_THIN_BADGE: DecisionBadge = {
  type: "scale_calibration_thin",
  label: "Scale calibration thin",
  severity: "warning",
};

function positiveFinite(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function formatRoas(value: number): string {
  return value.toFixed(2);
}

function formatRatioPercent(value: number): string {
  return (value * 100).toFixed(0);
}

interface NearScaleReadiness {
  reasons: string[];
  blockers: DecisionPredicateBlocker[];
}

function blocker(input: {
  predicate: string;
  observed: string | number | null;
  threshold: string | number | null;
  status?: DecisionPredicateBlocker["status"];
  reason: string;
}): DecisionPredicateBlocker {
  return {
    predicate: input.predicate,
    observed: input.observed,
    threshold: input.threshold,
    status: input.status ?? "failed",
    severity: "warning",
    reason: input.reason,
  };
}

/**
 * One account-readiness floor, with the numbers that decide it.
 *
 * These used to be bare sentences, so the predicate blocker they became
 * carried `observed: "<the same sentence>"` and `threshold: "ready"`. An
 * operator looking at Grandmix's held Scale could read that the calibration
 * was "thin" but not that it was 19 mature ads against a floor of 30, and no
 * consumer could compare the two numbers without parsing prose.
 */
interface ScaleBenchmarkBlocker {
  predicate: string;
  observed: string | number | null;
  threshold: string | number | null;
  reason: string;
}

function buildNearScaleReadiness(input: {
  spend: number;
  spendThreshold: number | null;
  purchases: number;
  purchasesThreshold: number;
  recent7dRoas: number | null;
  targetRoas: number;
  comparisonLabel: string;
  scaleBenchmarkBlockers?: readonly ScaleBenchmarkBlocker[];
  scaleFreshnessBlockers?: readonly string[];
}): NearScaleReadiness {
  const reasons: string[] = [];
  const blockers: DecisionPredicateBlocker[] = [];

  if (input.spendThreshold === null) {
    const reason = "scale spend floor unavailable";
    reasons.push(reason);
    blockers.push(
      blocker({
        predicate: "scale_spend_floor_available",
        observed: null,
        threshold: null,
        status: "missing",
        reason,
      }),
    );
  } else if (
    input.spend < input.spendThreshold ||
    input.purchases < input.purchasesThreshold
  ) {
    const reason = `spend ${formatReasonNumber(input.spend)} / purchases ${input.purchases} below scale floor (need spend ≥${formatReasonNumber(
      input.spendThreshold,
    )}, ≥${input.purchasesThreshold})`;
    reasons.push(reason);
    if (input.spend < input.spendThreshold) {
      blockers.push(
        blocker({
          predicate: "scale_spend_depth",
          observed: input.spend,
          threshold: input.spendThreshold,
          reason,
        }),
      );
    }
    if (input.purchases < input.purchasesThreshold) {
      blockers.push(
        blocker({
          predicate: "scale_purchase_depth",
          observed: input.purchases,
          threshold: input.purchasesThreshold,
          reason,
        }),
      );
    }
  }

  if (input.recent7dRoas === null) {
    const reason = "recent 7d ROAS missing";
    reasons.push(reason);
    blockers.push(
      blocker({
        predicate: "scale_recent_hold_available",
        observed: null,
        threshold: input.targetRoas,
        status: "missing",
        reason,
      }),
    );
  } else if (input.recent7dRoas < input.targetRoas) {
    const reason = `recent 7d ROAS ${formatRoas(input.recent7dRoas)} below ${input.comparisonLabel} ${formatRoas(
      input.targetRoas,
    )}`;
    reasons.push(reason);
    blockers.push(
      blocker({
        predicate: "scale_recent_hold",
        observed: input.recent7dRoas,
        threshold: input.targetRoas,
        reason,
      }),
    );
  }

  for (const benchmark of input.scaleBenchmarkBlockers ?? []) {
    reasons.push(benchmark.reason);
    blockers.push(
      blocker({
        predicate: benchmark.predicate,
        observed: benchmark.observed,
        threshold: benchmark.threshold,
        status: "missing",
        reason: benchmark.reason,
      }),
    );
  }

  for (const reason of input.scaleFreshnessBlockers ?? []) {
    reasons.push(reason);
    blockers.push(
      blocker({
        predicate: "scale_recent_freshness",
        observed: reason,
        threshold: "fresh",
        status: "missing",
        reason,
      }),
    );
  }

  return { reasons, blockers };
}

function scaleRatioThreshold(profile: AccountDecisionProfile): number {
  return SCALE_RATIO_BY_PRESET[profile.preset];
}

function scaleBenchmarkBlockers(
  profile: AccountDecisionProfile,
): ScaleBenchmarkBlocker[] {
  const blockers: ScaleBenchmarkBlocker[] = [];
  const matureCount = profile.accountBaselines.matureCreativeCount;

  if (!profile.quality.calibrationReady) {
    blockers.push({
      // Kept as the existing predicate name because
      // `app/api/creatives/briefing/card-serialization.ts` keys its near-miss
      // copy off it; only the observed/threshold pair becomes numeric.
      predicate: "scale_account_benchmark_ready",
      observed: matureCount,
      threshold: MIN_ACCOUNT_SCALE_CALIBRATION_SAMPLE,
      reason: `account scale calibration thin (${matureCount} mature creatives; need ${MIN_ACCOUNT_SCALE_CALIBRATION_SAMPLE}+)`,
    });
  }

  if (!positiveFinite(profile.accountBaselines.winnerPurchaseP50)) {
    blockers.push({
      predicate: "scale_account_benchmark_ready",
      observed: null,
      threshold: "positive winner purchase P50",
      reason: "winner purchase benchmark unavailable",
    });
  }

  return blockers;
}

function scaleReadinessBadges(
  benchmarkBlockers: readonly ScaleBenchmarkBlocker[],
): DecisionBadge[] {
  if (benchmarkBlockers.length === 0) {
    return [SCALE_READINESS_BLOCKED_BADGE];
  }

  return [SCALE_READINESS_BLOCKED_BADGE, SCALE_CALIBRATION_THIN_BADGE];
}

function hasStaleEvidence(ctx: GateContext): boolean {
  return (
    ctx.badges.some((badge) => badge.type === "stale_evidence") ||
    (ctx.input.dataFreshnessHours !== null &&
      ctx.input.dataFreshnessHours > STALE_SOURCE_UPDATED_AT_HOURS)
  );
}

function hasUnknownFreshness(ctx: GateContext): boolean {
  return (
    ctx.badges.some((badge) => badge.type === "unknown_freshness") ||
    ctx.input.dataFreshnessHours === null
  );
}

function scaleFreshnessBlockers(ctx: GateContext): string[] {
  if (hasUnknownFreshness(ctx)) {
    return [
      "source evidence freshness is unknown; scale requires fresh recent performance proof",
    ];
  }

  if (hasStaleEvidence(ctx)) {
    return [
      `source evidence is stale (${Math.round(
        ctx.input.dataFreshnessHours ?? 0,
      )}h); scale requires fresh recent performance proof`,
    ];
  }

  return [];
}

function recentToTotalRoasRatio(input: CreativeInput): number | null {
  if (input.recent7dRoas === null || input.roas === null || input.roas <= 0) {
    return null;
  }

  return input.recent7dRoas / input.roas;
}

function appendReasonSuffix(reason: string, suffix: string): string {
  const stem = reason.endsWith(".") ? reason.slice(0, -1) : reason;
  return `${stem}${suffix}`;
}

function withLifecycleHint(
  reason: string,
  ctx: GateContext,
  label: DecisionLabel,
): string {
  const position = ctx.input.lifecyclePosition;
  const daysSincePeak = ctx.input.daysSincePeak;
  const peakAge = daysSincePeak != null ? ` (peak ${daysSincePeak}d ago)` : "";

  if (label === "scale" && (position === "rising" || position === "plateau")) {
    return appendReasonSuffix(reason, `; momentum: ${position}${peakAge}`);
  }

  if (
    label === "keep" &&
    position === "past_peak_unclear" &&
    reason.startsWith("[at target]")
  ) {
    return appendReasonSuffix(
      reason,
      "; lifecycle: past_peak_unclear — operator review recommended",
    );
  }

  if (
    label === "refresh" &&
    (position === "past_peak_unclear" || position === "past_peak_natural")
  ) {
    return appendReasonSuffix(reason, `; lifecycle: ${position}`);
  }

  return reason;
}

function hasUsableFunnelCalibration(ctx: GateContext): boolean {
  const format = ctx.input.creativeFormat ?? "overall";
  const specific = ctx.profile.funnelCalibration.byFormat[format];
  const overall = ctx.profile.funnelCalibration.byFormat.overall;
  return Boolean(
    (specific && specific.qualityStatus !== "insufficient") ||
    (overall && overall.qualityStatus !== "insufficient"),
  );
}

function appendBadgeOnce(
  badges: readonly DecisionBadge[],
  badge: DecisionBadge,
): DecisionBadge[] {
  return badges.some((existing) => existing.type === badge.type)
    ? [...badges]
    : [...badges, badge];
}

function issueBadge(stage: Extract<FunnelStage, "landing_page" | "checkout">) {
  return stage === "landing_page"
    ? ({
        type: "landing_page_issue",
        label: "Landing page issue",
        severity: "warning",
      } satisfies DecisionBadge)
    : ({
        type: "checkout_breakdown",
        label: "Checkout breakdown",
        severity: "warning",
      } satisfies DecisionBadge);
}

function funnelAdjustedDecision(input: {
  ctx: GateContext;
  label: DecisionLabel;
  reason: string;
  badges: readonly DecisionBadge[];
}): {
  label: DecisionLabel;
  reason: string;
  badges: DecisionBadge[];
} {
  if (input.label !== "cut" && input.label !== "refresh") {
    return {
      label: input.label,
      reason: input.reason,
      badges: [...input.badges],
    };
  }

  if (!hasUsableFunnelCalibration(input.ctx)) {
    return {
      label: input.label,
      reason: input.reason,
      badges: appendBadgeOnce(input.badges, {
        type: "lifecycle_unavailable",
        label: "Funnel calibration unavailable",
        severity: "info",
      }),
    };
  }

  const diagnosis = computeFunnelDiagnosis({
    creative: input.ctx.input,
    funnelCalibration: input.ctx.profile.funnelCalibration,
    profile: input.ctx.profile,
  });

  if (
    diagnosis.confidence < 0.5 ||
    diagnosis.creativeResponsible ||
    (diagnosis.primaryWeakStage !== "landing_page" &&
      diagnosis.primaryWeakStage !== "checkout")
  ) {
    return {
      label: input.label,
      reason: input.reason,
      badges: [...input.badges],
    };
  }

  const stage = diagnosis.primaryWeakStage;
  let badges = appendBadgeOnce(input.badges, issueBadge(stage));
  if (
    hasUpperFunnelStrength({
      creative: input.ctx.input,
      funnelCalibration: input.ctx.profile.funnelCalibration,
    })
  ) {
    badges = appendBadgeOnce(badges, {
      type: "upper_funnel_strong_site_weak",
      label: "Upper funnel strong, site weak",
      severity: "info",
    });
  }

  if (input.label === "cut") {
    return {
      label: input.label,
      reason: `${input.reason} Secondary diagnosis: funnel evidence indicates a ${stage} issue, not only creative weakness; verify site/checkout before executing the cut recommendation.`,
      badges,
    };
  }

  return {
    label: "keep",
    reason: `${input.reason} Funnel evidence indicates a ${stage} issue; do not refresh creative until site/checkout cause is reviewed.`,
    badges,
  };
}

/**
 * The economic half of the Refresh predicate: a sufficiently sampled recent
 * window whose ROAS has decayed past the account's own refresh ratio floor.
 *
 * Split out of `shouldRefreshOnFatigue` so the two halves can disagree. When
 * the decay is real but no lifecycle/fatigue verdict exists for this entity,
 * the Refresh candidate is held rather than deleted — see the
 * `refreshLifecycleEvidenceUnavailable` branch in `ratioZonesGate`.
 */
export function hasRefreshDecayEvidence(
  input: CreativeInput,
  profile: AccountDecisionProfile,
  /**
   * The recent-sample floor to judge against when the profile's own is absent.
   *
   * `thresholds.recentSampleMinSpend` is derived from the spend unit, so it is
   * null on an account with no authoritative one — and this function then
   * answered `false`, which DELETED the Refresh verdict rather than holding
   * it. D091 keeps the mathematical verdict and its held reason visible; an
   * absent floor is a reason to withhold execution, not to stop computing the
   * verdict. The repaired commercial stop-loss family supplies the floor when
   * it has one, which is the same family the surrounding branch decides from.
   */
  recentSampleMinSpendOverride?: number | null,
): boolean {
  if (input.recent7dRoas === null || input.roas === null || input.roas <= 0) {
    return false;
  }

  const recentSampleMinSpend =
    recentSampleMinSpendOverride ?? recentSampleMinSpendFloor(profile);
  if (
    input.recent7dSpend === null ||
    recentSampleMinSpend === null ||
    input.recent7dSpend < recentSampleMinSpend
  ) {
    return false;
  }

  const threshold =
    profile.accountBaselines.refreshRatioP10 ?? REFRESH_RATIO_FALLBACK;
  return input.recent7dRoas / input.roas < threshold;
}

/**
 * True when this entity has no fatigue verdict at all — not "not fatigued",
 * but "nobody computed one". Native Meta Ads sat here permanently before the
 * ad-level lifecycle contract existed, which made every Refresh unreachable
 * and invisible at the same time.
 *
 * They sit here again, now for a stated reason rather than an omission.
 * `NATIVE_AD_LIFECYCLE_EVIDENCE_CONTRACT` in `jobs/ad-decisions-job.ts` grants
 * `fatigued` only on equal, disjoint, cutoff-bound 14/14 windows carrying a
 * CTR and click-to-purchase composite. Those windows are materialized by the
 * `ad_bands` CTE in `lib/creative-decision-engine/data-source.ts`, so an ad
 * arriving here is missing a specific piece of `meta_ad_daily` — today, a
 * positive `link_clicks` denominator — rather than a producer. Which piece is
 * named on the row's `refresh_ad_lifecycle_evidence_contract` blocker. The
 * difference from before is that the row is HELD and names what it lacks,
 * instead of serving as an ordinary Keep.
 */
export function refreshLifecycleEvidenceUnavailable(
  input: CreativeInput,
): boolean {
  return input.fatigueStatus === null || input.fatigueStatus === "unknown";
}

export function shouldRefreshOnFatigue(
  input: CreativeInput,
  profile: AccountDecisionProfile,
  recentSampleMinSpendOverride?: number | null,
): boolean {
  // One decay predicate, shared with the held-candidate branch, so a confirmed
  // Refresh and a held Refresh can never disagree about the economics.
  return (
    input.fatigueStatus === "fatigued" &&
    hasRefreshDecayEvidence(input, profile, recentSampleMinSpendOverride)
  );
}

function terminal(
  ctx: GateContext,
  label: DecisionLabel,
  reason: string,
  badges: readonly DecisionBadge[] = [],
  blockers: readonly DecisionPredicateBlocker[] = [],
  authorityHold?: DecisionAuthorityHold,
): GateResult {
  const adjusted = funnelAdjustedDecision({
    ctx,
    label,
    reason,
    badges: [...ctx.badges, ...badges],
  });

  return {
    kind: "terminal",
    output: finalizeDecision(
      {
        ...ctx,
        badges: adjusted.badges,
        blockers: [...ctx.blockers, ...blockers],
      },
      adjusted.label,
      withLifecycleHint(adjusted.reason, ctx, adjusted.label),
      authorityHold,
    ),
  };
}

function expandedEconomicCutReason(
  ctx: GateContext,
  cutMatch: RatioZoneCutMatch,
  comparison: string,
): string {
  const ratio = ctx.ratioToTarget ?? 0;
  const roas = ctx.input.roas ?? 0;
  const prefix = `[economic stop-loss] ROAS ${formatRoas(
    roas,
  )} (28d) = ${formatRatioPercent(ratio)}% of ${comparison}, below explicit break-even, after ${formatReasonNumber(
    ctx.input.spend,
  )} spend (28d)`;

  if (cutMatch.kind === "hard_cut") {
    return `${prefix} — clear loser at scale.`;
  }
  if (cutMatch.kind === "sustained_loser") {
    return `${prefix} — sustained loser.`;
  }
  return `${prefix} — loss-budget maturity reached at ${formatReasonNumber(
    cutMatch.commercialMaturitySpend,
  )}; cut underperforming creative.`;
}

function authorityDeniedExpandedCutReview(
  ctx: GateContext,
  comparison: string,
): GateResult | null {
  if (
    resolveCanonicalCutZoneGeometry(ctx) !== "expanded_economic_loss" ||
    resolveCanonicalCutZone(ctx) !== null
  ) {
    return null;
  }

  const profileCutDenied = !ctx.profile.hardActionEligibility.cut;
  const authorityReason = profileCutDenied
    ? (ctx.profile.hardActionEligibility.reasons?.cut ??
      ctx.profile.hardActionEligibility.reason ??
      "hard Cut profile eligibility unavailable")
    : (ctx.profile.expandedEconomicCutAuthority?.reason ??
      "expanded economic stop-loss authority unavailable");
  const authorityPredicate = profileCutDenied
    ? "hard_action_eligibility.cut"
    : "expanded_economic_cut_authority";
  const authorityThreshold = profileCutDenied ? "true" : "eligible";
  const reviewReason =
    `ROAS ${formatRoas(ctx.input.roas ?? 0)} (28d) is below explicit break-even ${formatRoas(
      ctx.profile.spendUnitEvidence.breakEvenRoas ?? 0,
    )} (${formatRatioPercent(
      ctx.ratioToTarget ?? 0,
    )}% of ${comparison}), but automatic expanded-zone Cut authority is unavailable`;
  const fatigueBadges =
    ctx.input.fatigueStatus === "watch"
      ? [FATIGUE_WATCH_BADGE]
      : ctx.input.fatigueStatus === "fatigued"
        ? [FATIGUE_FATIGUED_BADGE]
        : [];
  const fatigueWatchSuffix =
    ctx.input.fatigueStatus === "watch"
      ? "; fatigue watch — monitor for refresh signal"
      : "";

  return terminal(
    ctx,
    "keep",
    `[below break-even - stop-loss review] ${reviewReason}; keep fail-closed and review the stop-loss authority before action${fatigueWatchSuffix}.`,
    [
      BELOW_BREAKEVEN_BADGE,
      WEAK_PERFORMANCE_BADGE,
      {
        type: "stop_loss_review",
        label: "Below break-even - automatic Cut authority unavailable",
        severity: "warning",
      },
      ...fatigueBadges,
    ],
    [
      blocker({
        predicate: authorityPredicate,
        observed: authorityReason,
        threshold: authorityThreshold,
        status: "missing",
        reason: reviewReason,
      }),
    ],
  );
}

export function ratioZonesGate(ctx: GateContext): GateResult {
  const { input, profile } = ctx;
  const ratio = ctx.ratioToTarget;
  const roas = input.roas;
  const purchases = input.purchases ?? 0;
  const cutBoundary = resolveCutBoundary(ctx);
  const workingZoneMinRatio = cutBoundary.ratio;
  const canonicalCutZone = resolveCanonicalCutZone(ctx);
  const comparison = comparisonLabel(ctx.truthSource);

  if (ratio === null || roas === null) {
    return terminal(
      ctx,
      "test_more",
      "ROAS unavailable (28d) — cannot evaluate against target.",
    );
  }

  if (ratio >= scaleRatioThreshold(profile)) {
    const scaleSpendThreshold = commercialMaturitySpendThreshold(ctx);
    const scalePurchasesThreshold = profile.thresholds.scaleMinPurchases;
    const recent7dRoas = input.recent7dRoas;
    const benchmarkBlockers = scaleBenchmarkBlockers(profile);
    const freshnessBlockers = scaleFreshnessBlockers(ctx);
    const hasScaleSpendDepth =
      scaleSpendThreshold !== null && input.spend >= scaleSpendThreshold;
    const hasScalePurchaseDepth = purchases >= scalePurchasesThreshold;
    const fatigueBadges =
      input.fatigueStatus === "fatigued" ? [FATIGUE_FATIGUED_BADGE] : [];

    if (
      hasScaleSpendDepth &&
      hasScalePurchaseDepth &&
      benchmarkBlockers.length === 0 &&
      freshnessBlockers.length === 0 &&
      recent7dRoas !== null &&
      recent7dRoas >= ctx.effectiveTargetRoas
    ) {
      return terminal(
        ctx,
        "scale",
        `ROAS ${formatRoas(roas)} (28d) = ${formatRatioPercent(
          ratio,
        )}% of ${comparison} ${formatRoas(
          ctx.effectiveTargetRoas,
        )} with ${purchases} purchases (28d) and recent 7d holding at ${formatRoas(
          recent7dRoas,
        )} — scale the ad set budget.`,
        fatigueBadges,
      );
    }

    const readiness = buildNearScaleReadiness({
      spend: input.spend,
      spendThreshold: scaleSpendThreshold,
      purchases,
      purchasesThreshold: scalePurchasesThreshold,
      recent7dRoas,
      targetRoas: ctx.effectiveTargetRoas,
      comparisonLabel: comparison,
      scaleBenchmarkBlockers: benchmarkBlockers,
      scaleFreshnessBlockers: freshnessBlockers,
    });

    /*
      An account-readiness floor closes EXECUTION; it does not delete the
      verdict.

      Grandmix's purchase cell reports `scale ready=false
      scale_calibration_sample_low observed=19 required=30`, and this ad's own
      economics (spend depth, purchase depth, recent 7d hold, fresh evidence)
      were all satisfied. The row still terminated as a plain `keep` whose
      `preAuthorityLabel` was `keep`, so nothing downstream ever learned that
      the mathematics said Scale: no `blockedActionType`, no held-verdict lane,
      no way to tell this ad apart from one that simply is not a scale
      candidate.

      Emitting the Scale verdict here and letting the authority layer withhold
      it is the existing contract for every other hold: when the profile denies
      Scale, `applySoftOnlyLabel` rewrites the label to `keep` and
      `finalizeDecision` stamps `authorityBlocker:
      profile_hard_action_ineligible` from `profileBlocksHardAuthority`. The
      explicit hold below covers the one readiness failure the profile does not
      encode (a missing winner purchase benchmark). Either way the served label
      stays `keep` and no provider action is authorized.
    */
    const readinessIsTheOnlyBlocker =
      benchmarkBlockers.length > 0 &&
      freshnessBlockers.length === 0 &&
      hasScaleSpendDepth &&
      hasScalePurchaseDepth &&
      recent7dRoas !== null &&
      recent7dRoas >= ctx.effectiveTargetRoas;

    if (readinessIsTheOnlyBlocker) {
      return terminal(
        ctx,
        "scale",
        `ROAS ${formatRoas(roas)} (28d) = ${formatRatioPercent(
          ratio,
        )}% of ${comparison} ${formatRoas(
          ctx.effectiveTargetRoas,
        )} with ${purchases} purchases (28d) and recent 7d holding at ${formatRoas(
          recent7dRoas,
        )} — scale the ad set budget; execution withheld: ${benchmarkBlockers
          .map((benchmark) => benchmark.reason)
          .join("; ")}.`,
        [...fatigueBadges, ...scaleReadinessBadges(benchmarkBlockers)],
        readiness.blockers,
        {
          /*
            Not `profile_hard_action_ineligible`.

            `finalizeDecision` (gates/types.ts) honours a requested hold only
            when `profileBlocksHardAuthority` is false, i.e. only when the
            profile's `hardActionEligibility.scale` is TRUE. And
            `resolveHardActionEligibility` in account-decision-profile.ts makes
            `scaleEligible` require `input.calibrationReady`, so a profile that
            reaches this hold has a ready calibration and the residual
            benchmark blocker is the missing account winner-purchase P50 —
            a benchmark metric that was not computed, not a profile denial.
            A thin calibration sample never reaches here: it denies the profile
            first, and `applySoftOnlyLabel` stamps the honest
            `profile_hard_action_ineligible` on that path instead.
          */
          authorityBlocker: "native_metrics_unavailable",
          blockedActionType: "scale",
          label: "keep",
          reasonPrefix: "[scale verdict held - account readiness incomplete]",
        },
      );
    }

    return terminal(
      ctx,
      "keep",
      `[near scale] ROAS ${formatRoas(roas)} (28d) above ${comparison} (${formatRatioPercent(
        ratio,
      )}%) — ${readiness.reasons.join("; ")}; observe.`,
      [...fatigueBadges, ...scaleReadinessBadges(benchmarkBlockers)],
      readiness.blockers,
    );
  }

  if (ratio >= TARGET_BAND_MIN_RATIO) {
    const scaleSpendThreshold = commercialMaturitySpendThreshold(ctx);
    const scalePurchasesThreshold = profile.thresholds.scaleMinPurchases;
    const recentRatio = recentToTotalRoasRatio(input);

    if (
      shouldRefreshOnFatigue(input, profile) &&
      input.recent7dRoas !== null &&
      recentRatio !== null
    ) {
      return terminal(
        ctx,
        "refresh",
        `Fatigued + recent 7d ROAS ${formatRoas(
          input.recent7dRoas,
        )} dropped to ${formatRatioPercent(
          recentRatio,
        )}% of ROAS ${formatRoas(roas)} (28d) — replace creative with new iteration.`,
      );
    }

    // D063's economic strip may extend above the generic 0.85 target band
    // when explicit break-even is closer to the target. Refresh keeps its
    // precedence, but the generic Keep must not make that Cut zone unreachable.
    if (canonicalCutZone !== "expanded_economic_loss") {
      const fatigueBadges =
        input.fatigueStatus === "watch"
          ? [FATIGUE_WATCH_BADGE]
          : input.fatigueStatus === "fatigued"
            ? [FATIGUE_FATIGUED_BADGE]
            : [];
      const fatigueWatchSuffix =
        input.fatigueStatus === "watch"
          ? "; fatigue watch — monitor for refresh signal"
          : "";

      const authorityDeniedReview = authorityDeniedExpandedCutReview(
        ctx,
        comparison,
      );
      if (authorityDeniedReview !== null) {
        return authorityDeniedReview;
      }

      /*
        A Refresh candidate with no lifecycle evidence is HELD, not erased —
        but only on rows the economic Cut branch has already declined.

        `shouldRefreshOnFatigue` requires `fatigueStatus === "fatigued"`. Before
        the ad-level lifecycle contract existed, native Meta Ads always arrived
        with `fatigueStatus: null`, so an ad whose recent 7d ROAS had decayed
        past the account's own `refreshRatioP10` produced no Refresh candidate
        at all — the operator saw a healthy-looking Keep. Holding it keeps the
        recommendation visible and still authorizes nothing: the served label is
        `keep` and `blockedActionType` is `refresh`.

        Position is load-bearing. INVARIANTS.md: "The bounded P25-to-break-even
        economic strip may cross the generic `0.85` target-band boundary.
        Refresh keeps precedence, but target-band Keep must not terminate a
        below-break-even row before the economic Cut/recovery/evidence branch
        runs." The `shouldRefreshOnFatigue` branch above is exempt because it
        publishes a HARD `refresh`; this branch publishes `keep`, so if it ran
        before the `canonicalCutZone` test it would terminate a below-break-even
        row and record `refresh` in `blocked_action_type`, leaving the economic
        Cut unreachable and unrecoverable downstream. Inside this block the
        canonical Cut zone is by construction not `expanded_economic_loss`, and
        `authorityDeniedExpandedCutReview` above has already claimed the
        authority-denied stop-loss rows.

        Reachability is not theoretical, and it is not a thin-account edge case
        either. `computeNativeAdLifecycleEvidence` in jobs/ad-decisions-job.ts
        fails closed to `fatigueStatus: "unknown"` whenever the equal, disjoint
        14/14 windows or the account-relative frequency percentile are missing.
        The windows themselves are hydrated now, but on the current decision
        window `meta_ad_daily.link_clicks` holds no positive value anywhere, so
        the click-to-purchase denominator is absent in both bands and every
        decayed native ad still arrives here — which is the point: the
        candidate stays visible and authorizes nothing until the evidence
        exists.
      */
      if (
        hasRefreshDecayEvidence(input, profile) &&
        refreshLifecycleEvidenceUnavailable(input) &&
        input.recent7dRoas !== null &&
        recentRatio !== null
      ) {
        /*
          Freshness is named, not skipped.

          `finalizeDecision` (gates/types.ts) applies its stale/unknown-freshness
          path only when the FINAL label is a hard action. This branch serves
          `keep`, so `hardLabel` is null there and that path never runs. A
          confirmed Refresh on stale evidence is held with `source_freshness`;
          without this, an identical held Refresh would report only the missing
          lifecycle verdict and say nothing about the window it was measured on.
          The decay itself is measured on that same window, so freshness is the
          first effective blocker when it fails, and the lifecycle gap is the
          blocker when it does not.
        */
        const refreshFreshnessUnknown = hasUnknownFreshness(ctx);
        const refreshFreshnessStale = hasStaleEvidence(ctx);
        const refreshEvidenceUnfresh =
          refreshFreshnessUnknown || refreshFreshnessStale;
        return terminal(
          ctx,
          "refresh",
          `Recent 7d ROAS ${formatRoas(
            input.recent7dRoas,
          )} dropped to ${formatRatioPercent(
            recentRatio,
          )}% of ROAS ${formatRoas(
            roas,
          )} (28d) — refresh candidate; no ad-level fatigue verdict is available to confirm creative wear.`,
          [
            {
              type: "lifecycle_unavailable",
              label: "Ad-level fatigue evidence unavailable",
              severity: "info",
            },
            ...(refreshFreshnessUnknown
              ? [
                  {
                    type: "unknown_freshness" as const,
                    label:
                      "Unknown freshness: refresh the decision data before applying.",
                    severity: "warning" as const,
                  },
                ]
              : refreshFreshnessStale
                ? [
                    {
                      type: "stale_evidence" as const,
                      label: `Stale evidence: last sync ${Math.round(
                        input.dataFreshnessHours ?? 0,
                      )}h ago - refresh before applying.`,
                      severity: "warning" as const,
                    },
                  ]
                : []),
          ],
          [
            blocker({
              predicate: "refresh_ad_lifecycle_evidence",
              observed: input.fatigueStatus ?? "unavailable",
              threshold: "fatigued",
              status: "missing",
              reason:
                "no ad-level fatigue verdict exists for this entity, so creative wear cannot be confirmed",
            }),
          ],
          {
            /*
              Not `profile_hard_action_ineligible`.

              `finalizeDecision` honours a requested hold only when
              `profileBlocksHardAuthority` is false — that is, only when the
              profile's `hardActionEligibility` ALLOWS the action. Stamping
              profile ineligibility here therefore describes the one state that
              cannot be true when the stamp is written, and
              `resolutionForAuthorityBlocker` in lib/meta/decision-semantics.ts
              routes that code to the commercial-target / hard-action-evidence
              copy. What is actually missing is this ad's own fatigue verdict,
              which is ad-grain evidence: `native_metrics_unavailable`.
            */
            authorityBlocker: refreshEvidenceUnfresh
              ? "source_freshness"
              : "native_metrics_unavailable",
            blockedActionType: "refresh",
            label: "keep",
            reasonPrefix: refreshEvidenceUnfresh
              ? "[refresh verdict held - fresh data required]"
              : "[refresh verdict held - ad-level fatigue evidence required]",
          },
        );
      }

      const targetBandReason =
        ratio < WEAK_TARGET_MAX_RATIO
          ? `[weak target] ROAS ${formatRoas(
              roas,
            )} (28d) just above breakeven (${formatRatioPercent(
              ratio,
            )}% of ${comparison}) — keep observing; consider tightening if recent 7d weakens`
          : ratio < AT_TARGET_MAX_RATIO
            ? `[at target] ROAS ${formatRoas(
                roas,
              )} (28d) at/around ${comparison} ${formatRoas(
                ctx.effectiveTargetRoas,
              )} (${formatRatioPercent(ratio)}%) — stable, let it run`
            : `[near scale] ROAS ${formatRoas(
                roas,
              )} (28d) approaching scale threshold (${formatRatioPercent(
                ratio,
              )}% of ${comparison}) — performance ratio remains below the ${formatRatioPercent(
                scaleRatioThreshold(profile),
              )}% scale zone; keep running`;

      return terminal(
        ctx,
        "keep",
        `${targetBandReason}${fatigueWatchSuffix}.`,
        fatigueBadges,
      );
    }
  }

  if (
    ratio < workingZoneMinRatio &&
    (!hasExplicitBreakEven(ctx) || isBelowExplicitBreakEven(ctx))
  ) {
    const stopLossThresholds = commercialStopLossThresholds(ctx);

    /*
      AN UNVERIFIABLE RECOVERY IS NOT A REFUTED ONE.

      `hasCanonicalRecentRecovery` judges the recent window against
      `thresholds.recentSampleMinSpend`, which is derived from the spend unit
      and is therefore `null` on an account with no authoritative one. The
      predicate then answered `false` — "recovery is NOT holding" — and the cut
      branch below proceeded. That inverts the hold: withholding the unit must
      not REMOVE a protective guard.

      The cut branch below is already deciding from
      `commercialStopLossThresholds`, the repaired account/currency family, so
      recovery is weighed against the SAME family's recent floor rather than
      against one that does not exist. When neither family has a floor the
      predicate still answers false and the cut matches below cannot fire
      either — `resolveRatioZoneCutMatch` reads the same thresholds — so the
      row falls through to `test_more`, which is the honest hold.
    */
    if (hasCanonicalRecentRecovery(ctx)) {
      return terminal(
        ctx,
        "keep",
        `[recovery hold] ROAS ${formatRoas(roas)} (28d) = ${formatRatioPercent(
          ratio,
        )}% of ${comparison}, but recent 7d ROAS ${formatRoas(
          input.recent7dRoas ?? 0,
        )} is above ${comparison} on ${formatReasonNumber(
          input.recent7dSpend ?? 0,
        )} recent spend — do not hard cut while recovery is holding.`,
        [WEAK_PERFORMANCE_BADGE],
      );
    }

    const cutMatch = resolveRatioZoneCutMatch(ctx, stopLossThresholds);
    if (cutMatch?.kind === "hard_cut") {
      return terminal(
        ctx,
        "cut",
        `ROAS ${formatRoas(roas)} (28d) = ${formatRatioPercent(
          ratio,
        )}% of ${comparison} after ${formatReasonNumber(
          input.spend,
        )} spend (28d) — clear loser at scale.`,
      );
    }

    if (cutMatch?.kind === "sustained_loser") {
      return terminal(
        ctx,
        "cut",
        `ROAS ${formatRoas(roas)} (28d) = ${formatRatioPercent(
          ratio,
        )}% of ${comparison} after ${formatReasonNumber(input.spend)} spend (28d) — sustained loser.`,
      );
    }

    if (cutMatch?.kind === "loss_budget_maturity") {
      return terminal(
        ctx,
        "cut",
        `ROAS ${formatRoas(roas)} (28d) = ${formatRatioPercent(
          ratio,
        )}% of ${comparison} after ${formatReasonNumber(
          input.spend,
        )} spend (28d) — loss-budget maturity reached at ${formatReasonNumber(
          cutMatch.commercialMaturitySpend,
        )}; cut underperforming creative.`,
      );
    }

    if (input.fatigueStatus === "fatigued") {
      return terminal(
        ctx,
        "refresh",
        `ROAS ${formatRoas(roas)} (28d) = ${formatRatioPercent(
          ratio,
        )}% of ${comparison} and fatigued — replace with fresh iteration.`,
      );
    }

    return terminal(
      ctx,
      "test_more",
      `ROAS ${formatRoas(roas)} (28d) = ${formatRatioPercent(
        ratio,
      )}% of ${comparison} after ${formatReasonNumber(
        input.spend,
      )} spend (28d) — underperforming but spend not yet mature for hard cut, observe or pause manually.`,
    );
  }

  const recent7dRoas = input.recent7dRoas;
  if (
    shouldRefreshOnFatigue(input, profile) && recent7dRoas !== null) {
    return terminal(
      ctx,
      "refresh",
      `ROAS ${formatRoas(roas)} (28d) = ${formatRatioPercent(
        ratio,
      )}% of ${comparison} and fatigued with recent 7d ROAS ${formatRoas(
        recent7dRoas,
      )} decaying — iterate.`,
    );
  }

  // D063's authority presentation is independent of the generic 0.85 target
  // band. Refresh retains precedence, while an authority-denied economic loss
  // remains visible as a truthful, non-executable stop-loss review.
  const authorityDeniedReview = authorityDeniedExpandedCutReview(
    ctx,
    comparison,
  );
  if (authorityDeniedReview !== null) {
    return authorityDeniedReview;
  }

  if (canonicalCutZone === "expanded_economic_loss") {
    const cutMatch = resolveRatioZoneCutMaturityMatch(
      ctx,
      commercialStopLossThresholds(ctx),
    );

    if (cutMatch !== null) {
      const recentEvidence = resolveExpandedEconomicRecentEvidence(ctx);
      if (recentEvidence.status === "recovery") {
        return terminal(
          ctx,
          "keep",
          `[economic recovery hold] ROAS ${formatRoas(
            roas,
          )} (28d) remains below break-even, but sufficiently sampled recent 7d ROAS ${formatRoas(
            recentEvidence.recentRoas,
          )} is at or above break-even ${formatRoas(
            recentEvidence.breakEvenRoas,
          )} on ${formatReasonNumber(
            recentEvidence.recentSpend,
          )} recent spend — do not cut while economic recovery is holding.`,
          [BELOW_BREAKEVEN_BADGE, WEAK_PERFORMANCE_BADGE],
        );
      }

      const reason = expandedEconomicCutReason(ctx, cutMatch, comparison);
      if (
        recentEvidence.status === "unverifiable" ||
        recentEvidence.status === "thin"
      ) {
        const evidenceReason =
          recentEvidence.status === "thin"
            ? `recent spend ${formatReasonNumber(
                recentEvidence.recentSpend ?? 0,
              )} is below the canonical evidence floor ${formatReasonNumber(
                recentEvidence.recentSpendThreshold ?? 0,
              )}`
            : "recent ROAS, spend, canonical sample floor, or break-even evidence is unavailable";
        return terminal(
          ctx,
          "cut",
          `${reason} Recent recovery cannot be ruled out because ${evidenceReason}.`,
          [
            BELOW_BREAKEVEN_BADGE,
            WEAK_PERFORMANCE_BADGE,
            ...(recentEvidence.status === "unverifiable" &&
            recentEvidence.missingRecentData
              ? [
                  {
                    type: "missing_recent_data" as const,
                    label: "Recent break-even evidence unavailable",
                    severity: "warning" as const,
                  },
                ]
              : []),
          ],
          [
            blocker({
              predicate: "expanded_cut_recent_recovery_evidence",
              observed: recentEvidence.recentSpend,
              threshold: recentEvidence.recentSpendThreshold,
              status:
                recentEvidence.status === "unverifiable" ? "missing" : "failed",
              reason: evidenceReason,
            }),
          ],
          {
            authorityBlocker: "recent_recovery_unverifiable",
            blockedActionType: "cut",
            label: "test_more",
            reasonPrefix:
              "[cut verdict held - sufficient recent break-even evidence required]",
          },
        );
      }

      if (recentEvidence.status === "confirmed_loss") {
        return terminal(
          ctx,
          "cut",
          `${reason} Recent 7d ROAS ${formatRoas(
            recentEvidence.recentRoas,
          )} remains below break-even ${formatRoas(
            recentEvidence.breakEvenRoas,
          )} on ${formatReasonNumber(
            recentEvidence.recentSpend,
          )} recent spend.`,
          [BELOW_BREAKEVEN_BADGE, WEAK_PERFORMANCE_BADGE],
        );
      }
    }
  }

  const fatigueBadges =
    input.fatigueStatus === "fatigued" ? [FATIGUE_FATIGUED_BADGE] : [];

  const breakevenRoas = profile.spendUnitEvidence.breakEvenRoas;
  const breakevenRatio =
    breakevenRoas !== null && ctx.effectiveTargetRoas > 0
      ? breakevenRoas / ctx.effectiveTargetRoas
      : null;
  const hardCutSpend = profile.thresholds.hardCutSpend;
  const matureSpend = hardCutSpend !== null && input.spend >= hardCutSpend;

  if (breakevenRatio !== null && ratio < breakevenRatio && matureSpend) {
    const boundaryExplanation =
      cutBoundary.mode === "breakeven_ceiling"
        ? `economic cut ceiling (${formatRatioPercent(
            cutBoundary.ratio,
          )}%; minimum of account P25 ${formatRatioPercent(
            cutBoundary.accountP25 ?? cutBoundary.ratio,
          )}% and breakeven ${formatRatioPercent(
            cutBoundary.breakevenRatio ?? breakevenRatio,
          )}%)`
        : cutBoundary.mode === "uncalibrated_commercial_stop_loss"
          ? `uncalibrated commercial stop-loss (${formatRatioPercent(
              cutBoundary.ratio,
            )}%; minimum of the canonical cold-start boundary ${formatRatioPercent(
              UNCALIBRATED_CUT_RATIO_FALLBACK,
            )}% and breakeven ${formatRatioPercent(
              cutBoundary.breakevenRatio ?? breakevenRatio,
            )}%)`
          : `account bottom quartile (${formatRatioPercent(cutBoundary.ratio)}%)`;
    return terminal(
      ctx,
      "keep",
      `[demote candidate] ROAS ${formatRoas(roas)} (28d) = ${formatRatioPercent(
        ratio,
      )}% of ${comparison} — above ${boundaryExplanation} but below breakeven (${formatRoas(
        breakevenRoas ?? 0,
      )} = ${formatRatioPercent(breakevenRatio)}% of ${comparison}) at ${formatReasonNumber(
        input.spend,
      )} mature spend — consider demote to test placement or refresh creative concept.`,
      [BELOW_BREAKEVEN_BADGE, WEAK_PERFORMANCE_BADGE, ...fatigueBadges],
    );
  }

  return terminal(
    ctx,
    "keep",
    `[weak zone] ROAS ${formatRoas(roas)} (28d) = ${formatRatioPercent(
      ratio,
    )}% of ${comparison} — below the comparison benchmark but in the working zone; no aggressive action, revisit if ROAS drifts further.`,
    [WEAK_PERFORMANCE_BADGE, ...fatigueBadges],
  );
}
