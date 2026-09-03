import {
  type AccountDecisionProfile,
  type CreativeInput,
  type DecisionBadge,
  type DecisionLabel,
  type DecisionOutput,
} from "@/lib/creative-decision-engine";
import type { DecisionBacktestSummary } from "@/lib/creative-decision-engine/backtest";
import { creativeAutomationReadiness } from "@/lib/creative-decision-engine/automation-readiness";
import {
  isCampaignRoleUnresolved,
  resolveCampaignRoleStatus,
} from "@/lib/creative-decision-engine/campaign-label-guard";
import {
  BRIEFING_PRIORITY_SCORE_ACTION_WEIGHTS,
  BRIEFING_PRIORITY_SCORE_BANDS,
  BRIEFING_PRIORITY_SCORE_SEVERITY_WEIGHTS,
  BRIEFING_PRIORITY_SPEND_EXPOSURE_FLOOR_RATIO,
  BRIEFING_NEAR_MISS_MAX_COUNT,
  CALIBRATION_REFIT_INTERVAL_DAYS,
} from "@/lib/creative-decision-engine/config-values";
import type { MetaCreativeApiRow } from "@/lib/meta/creatives-types";
import type {
  BriefingCreativeCard,
  BriefingDecisionExplainability,
  BriefingPriorityScore,
  BriefingWatchingSubBucket,
} from "@/components/creatives/briefing/types";
import { formatMoney } from "@/components/creatives/money";
import { classifyMetaCreativeAssessment } from "@/lib/meta/creative-assessment";

type DecisionCenterRowForCard = NonNullable<
  BriefingCreativeCard["decisionCenterRow"]
>;

function badgeLabels(badges: DecisionBadge[]) {
  return badges.flatMap((badge) => {
    if (badge.type === "below_breakeven") return ["below_breakeven"];
    if (badge.type === "fatigue_watch" || badge.type === "fatigue_fatigued")
      return ["fatigue"];
    if (
      badge.type === "campaign_context_unresolved" ||
      badge.type === "unlabeled_campaign_context"
    )
      return ["campaign_context_unresolved"];
    if (badge.type === "scale_readiness_blocked")
      return ["scale_readiness_blocked"];
    if (badge.type === "scale_calibration_thin")
      return ["scale_calibration_thin"];
    if (badge.type === "stop_loss_review") return ["stop_loss_review"];
    if (badge.type === "stale_evidence") return ["stale_evidence"];
    if (badge.type === "delivery_no_spend_24h")
      return ["delivery_no_spend_24h"];
    if (badge.type === "policy_blocked") return ["policy_blocked"];
    if (badge.type === "launch_monitoring") return ["launch_monitoring"];
    if (badge.type === "pending_transition") return ["pending_transition"];
    if (badge.type === "resume_candidate") return ["resume_candidate"];
    if (badge.type === "confirm_kill") return ["confirm_kill"];
    return [];
  });
}

function primaryActionForDecision(decision: DecisionOutput): {
  kind: string;
  label: string;
} {
  if (
    decision.label === "diagnose" &&
    decision.blockedActionType === "cut" &&
    isCampaignRoleUnresolved(decision)
  ) {
    return { kind: "review", label: "Cut review" };
  }
  if (decision.label === "cut") return { kind: "cut", label: "Cut" };
  if (decision.label === "scale") {
    // D074b correction: kind-conditional CTAs require the canonical resolved
    // automatic-role status, not just a campaignKind value. A kind carried by
    // a legacy or contradictory payload has no automatic-role provenance.
    const roleResolved = resolveCampaignRoleStatus(decision) === "resolved";
    if (roleResolved && decision.campaignKind === "test") {
      return { kind: "promote", label: "Promote to main" };
    }
    if (roleResolved && decision.campaignKind === "main") {
      return { kind: "scale_budget", label: "Scale budget" };
    }
    if (roleResolved && decision.campaignKind === "mixed") {
      return { kind: "controlled_scale", label: "Review structure & scale" };
    }
    // D074b: never ask for a label. The role is inferred automatically; the
    // honest ask is fresher evidence for the resolver.
    return { kind: "review", label: "Resolve campaign role before scaling" };
  }
  if (decision.label === "refresh")
    return { kind: "fresh_test", label: "Launch fresh test" };
  if (decision.label === "test_more")
    return { kind: "fresh_test", label: "Launch new test" };
  if (decision.label === "diagnose")
    return { kind: "review", label: "Open evidence" };
  return { kind: "review", label: "Review" };
}

function hardActionAuthorityBlocked(decision: DecisionOutput) {
  return (
    decision.authorityBlocker !== null ||
    decision.truthSource === "commercial_truth_stale" ||
    decision.badges.some(
      (badge) =>
        badge.type === "stale_evidence" ||
        badge.type === "pending_transition",
    )
  );
}

function blockedHardActionReview(decision: DecisionOutput) {
  if (decision.badges.some((badge) => badge.type === "pending_transition")) {
    return { kind: "review", label: "Review pending signal" };
  }
  if (
    decision.authorityBlocker === "recent_recovery_unverifiable"
  ) {
    return decision.badges.some(
      (badge) => badge.type === "missing_recent_data",
    )
      ? { kind: "review", label: "Refresh recent evidence" }
      : { kind: "review", label: "Await recent evidence" };
  }
  if (
    decision.authorityBlocker === "source_freshness" ||
    decision.truthSource === "commercial_truth_stale" ||
    decision.badges.some((badge) => badge.type === "stale_evidence")
  ) {
    return { kind: "review", label: "Refresh evidence" };
  }
  return { kind: "review", label: "Open evidence" };
}

/**
 * D074b acceptance corrections 2+3: a Decision Center compatibility row is
 * PROVENANCE, not authority — and a resolved role only says what KIND of
 * campaign this is; it does not prove the row is the current decision.
 * The row's scale execution action may shape the current card primary only
 * when ALL of the following hold:
 *  - the current decision itself is an unblocked Scale verdict (no held
 *    action, no authority blocker);
 *  - the canonical automatic role is resolved and the action agrees with
 *    the kind (test -> promote_to_main, main -> scale_budget, mixed ->
 *    controlled_scale);
 *  - the decision-derived current primary maps to the EXACT same CTA.
 * Any disagreement — a current keep/diagnose/cut/refresh/test_more, a
 * held or blocked state, a missing/legacy/contradictory role, a
 * kind-mismatched action — leaves the current decision's own primary
 * standing and the row as inert provenance.
 */
function primaryActionForDecisionCenterRow(
  row: DecisionCenterRowForCard | null | undefined,
  decision: DecisionOutput,
): {
  kind: string;
  label: string;
} | null {
  if (row?.buyerAction !== "scale") return null;
  if (decision.label !== "scale") return null;
  if (decision.blockedActionType != null) return null;
  if (decision.authorityBlocker != null) return null;
  if (resolveCampaignRoleStatus(decision) !== "resolved") return null;
  const kind = decision.campaignKind ?? null;
  const rowMapped =
    row.executionAction === "promote_to_main" && kind === "test"
      ? { kind: "promote", label: "Promote to main" }
      : row.executionAction === "scale_budget" && kind === "main"
        ? { kind: "scale_budget", label: "Scale budget" }
        : row.executionAction === "controlled_scale" && kind === "mixed"
          ? { kind: "controlled_scale", label: "Review structure & scale" }
          : null;
  if (!rowMapped) return null;
  // Current-decision agreement: the row may only CONFIRM the current
  // server-derived primary, never replace it.
  const current = primaryActionForDecision(decision);
  return current.kind === rowMapped.kind ? rowMapped : null;
}

export function safeNumber(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function safeString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function previewForRow(row: MetaCreativeApiRow | null | undefined) {
  const source =
    row?.preview &&
    typeof row.preview === "object" &&
    !Array.isArray(row.preview)
      ? (row.preview as unknown as Record<string, unknown>)
      : null;
  const image =
    safeString(source?.image_url) ??
    safeString(source?.poster_url) ??
    safeString(row?.card_preview_url) ??
    safeString(row?.image_url) ??
    safeString(row?.preview_url) ??
    safeString(row?.cached_thumbnail_url) ??
    safeString(row?.thumbnail_url) ??
    safeString(row?.table_thumbnail_url);
  const video = safeString(source?.video_url);
  return {
    render_mode: video
      ? ("video" as const)
      : image
        ? ("image" as const)
        : ("unavailable" as const),
    image_url: image,
    video_url: video,
    poster_url:
      safeString(source?.poster_url) ??
      safeString(row?.table_thumbnail_url) ??
      safeString(row?.cached_thumbnail_url) ??
      safeString(row?.thumbnail_url) ??
      image,
    source: safeString(source?.source) ?? (image ? "briefing_row" : null),
    is_catalog: Boolean(row?.is_catalog ?? source?.is_catalog),
  };
}

function confidenceFactor(decision: DecisionOutput) {
  return Math.max(0, Math.min(1, safeNumber(decision.confidence) / 100));
}

function actionWeight(label: DecisionLabel) {
  return BRIEFING_PRIORITY_SCORE_ACTION_WEIGHTS[label];
}

function severityWeight(decision: DecisionOutput) {
  if (
    decision.badges.some(
      (badge) =>
        badge.type === "stale_evidence" ||
        badge.type === "stop_loss_review" ||
        badge.type === "policy_blocked" ||
        badge.type === "delivery_no_spend_24h",
    )
  ) {
    return BRIEFING_PRIORITY_SCORE_SEVERITY_WEIGHTS.stopLossOrDeliveryBlocker;
  }
  if (
    decision.badges.some(
      (badge) =>
        badge.type === "below_breakeven" ||
        badge.type === "weak_performance" ||
        badge.type === "scale_readiness_blocked",
    )
  ) {
    return BRIEFING_PRIORITY_SCORE_SEVERITY_WEIGHTS.weakPerformanceOrScaleBlocker;
  }
  if (decision.badges.some((badge) => badge.type === "launch_monitoring")) {
    return BRIEFING_PRIORITY_SCORE_SEVERITY_WEIGHTS.launchMonitoring;
  }
  return BRIEFING_PRIORITY_SCORE_SEVERITY_WEIGHTS.default;
}

function priorityBand(score: number): BriefingPriorityScore["band"] {
  return (
    BRIEFING_PRIORITY_SCORE_BANDS.find((band) => score >= band.minScore)
      ?.band ?? "low"
  );
}

function priorityReason(label: DecisionLabel, score: number) {
  const band = priorityBand(score);
  if (label === "cut") {
    return `${band} priority from spend at risk, confidence, and loss severity.`;
  }
  if (label === "scale") {
    return `${band} priority from above-target opportunity, confidence, and spend maturity.`;
  }
  if (label === "refresh") {
    return `${band} priority from fatigue/refresh pressure weighted by spend and confidence.`;
  }
  if (label === "diagnose") {
    return `${band} priority diagnostic from blocker severity, spend, and confidence.`;
  }
  return `${band} priority from current signal strength and spend exposure.`;
}

export function deriveWatchingSubBucket(
  decision: DecisionOutput,
): BriefingWatchingSubBucket | null {
  const badgeTypes = new Set(decision.badges.map((badge) => badge.type));
  if (isCampaignRoleUnresolved(decision) && decision.blockedActionType) {
    return "waiting_on_role_resolution";
  }
  if (
    decision.label === "diagnose" ||
    badgeTypes.has("tracking_anomaly") ||
    badgeTypes.has("delivery_no_spend_24h") ||
    badgeTypes.has("policy_blocked") ||
    badgeTypes.has("landing_page_issue") ||
    badgeTypes.has("checkout_breakdown")
  ) {
    return "diagnostic";
  }
  if (
    decision.label === "keep" &&
    (badgeTypes.has("scale_readiness_blocked") ||
      badgeTypes.has("below_breakeven") ||
      badgeTypes.has("weak_performance"))
  ) {
    return "near_action";
  }
  if (decision.label === "test_more" && !badgeTypes.has("launch_monitoring")) {
    return "test_maturing";
  }
  return null;
}

function numericDelta(
  threshold: string | number | null,
  observed: string | number | null,
) {
  const thresholdNumber = Number(threshold);
  const observedNumber = Number(observed);
  if (!Number.isFinite(thresholdNumber) || !Number.isFinite(observedNumber)) {
    return null;
  }
  return Math.max(0, thresholdNumber - observedNumber);
}

function formatNearMissNumber(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function formatNearMissCurrency(
  value: number,
  currency: string | null | undefined,
) {
  return formatMoney(Math.round(value), currency, null);
}

function nearMissFromBlocker(
  blocker: NonNullable<DecisionOutput["blockers"]>[number],
  currency: string | null | undefined,
) {
  if (blocker.predicate === "scale_purchase_depth") {
    const remaining = numericDelta(blocker.threshold, blocker.observed);
    return remaining === null
      ? "Purchase depth gate is still missing enough proof."
      : `Needs ${formatNearMissNumber(remaining)} more purchases.`;
  }
  if (
    blocker.predicate === "scale_spend_depth" ||
    blocker.predicate === "scale_spend_maturity"
  ) {
    const remaining = numericDelta(blocker.threshold, blocker.observed);
    return remaining === null
      ? "Spend maturity gate is still missing enough proof."
      : `Needs ${formatNearMissCurrency(
          remaining,
          currency,
        )} more spend at current ROAS.`;
  }
  if (blocker.predicate === "scale_recent_hold") {
    return `Recent 7d ROAS ${blocker.observed ?? "missing"} below target ${blocker.threshold ?? "missing"}.`;
  }
  if (blocker.predicate === "scale_account_benchmark_ready") {
    return "Account scale calibration is still thin.";
  }
  return null;
}

function deriveNearMisses(
  decision: DecisionOutput,
  currency: string | null | undefined,
) {
  if (
    decision.label !== "keep" ||
    decision.blockedActionType !== "scale" ||
    !decision.blockers?.length
  ) {
    return [];
  }
  return decision.blockers
    .map((blocker) => nearMissFromBlocker(blocker, currency))
    .filter((item): item is string => Boolean(item))
    .slice(0, BRIEFING_NEAR_MISS_MAX_COUNT);
}

function addDaysToIso(value: string | null | undefined, days: number) {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

function thresholdProvenanceSource(
  decision: DecisionOutput,
): NonNullable<
  BriefingDecisionExplainability["thresholdProvenance"]
>["source"] {
  switch (decision.truthSource) {
    case "commercial_truth":
      return "operator_target";
    case "commercial_truth_stale":
      return "operator_target_stale";
    case "account_baseline":
      return "account_baseline";
    case "account_baseline_thin":
      return "account_baseline_thin";
    case "global_default":
      return "global_default";
    default: {
      return assertNever(decision.truthSource);
    }
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled threshold provenance source: ${String(value)}`);
}

export function buildBriefingPriorityScore(
  decision: DecisionOutput,
): BriefingPriorityScore {
  const label = decision.label as DecisionLabel;
  const spend = safeNumber(decision.metrics.spend);
  const ratioToTarget =
    typeof decision.ratioToTarget === "number" &&
    Number.isFinite(decision.ratioToTarget)
      ? decision.ratioToTarget
      : null;
  const spendAtRisk =
    ratioToTarget === null
      ? label === "cut"
        ? spend
        : 0
      : label === "cut" || decision.blockedActionType === "cut"
        ? spend * Math.max(0, 1 - ratioToTarget)
        : 0;
  const opportunityValue =
    ratioToTarget === null
      ? 0
      : label === "scale" || decision.blockedActionType === "scale"
        ? spend * Math.max(0, ratioToTarget - 1)
        : label === "refresh"
          ? spend * Math.max(0.1, Math.min(0.5, 1 - Math.min(ratioToTarget, 1)))
          : 0;
  const conf = confidenceFactor(decision);
  const severity = severityWeight(decision);
  const action = actionWeight(label);
  const score = Number(
    (
      (spendAtRisk +
        opportunityValue +
        spend * BRIEFING_PRIORITY_SPEND_EXPOSURE_FLOOR_RATIO) *
      conf *
      severity *
      action
    ).toFixed(2),
  );

  return {
    score,
    band: priorityBand(score),
    reason: priorityReason(label, score),
    inputs: {
      spend,
      ratioToTarget,
      confidenceFactor: Number(conf.toFixed(4)),
      spendAtRisk: Number(spendAtRisk.toFixed(2)),
      opportunityValue: Number(opportunityValue.toFixed(2)),
      severityWeight: severity,
      actionWeight: action,
    },
  };
}

function buildBriefingDecisionExplainability(input: {
  decision: DecisionOutput;
  currency?: string | null;
  accountProfile?: AccountDecisionProfile | null;
  backtestSummary?: DecisionBacktestSummary | null;
}): BriefingDecisionExplainability {
  const blockers = input.decision.blockers ?? [];
  const missingEvidence: string[] = [];
  const backtest = input.backtestSummary ?? null;
  const calibrationComputedAt =
    input.accountProfile?.accountBaselines.computedAt ?? null;
  if (!backtest) missingEvidence.push("current_version_outcome_window");
  if (!input.accountProfile?.quality.commercialTruthReady) {
    missingEvidence.push("commercial_truth_readiness");
  }
  if (!input.accountProfile?.quality.calibrationReady) {
    missingEvidence.push("account_calibration_readiness");
  }
  if (blockers.length === 0) {
    missingEvidence.push("predicate_blocker_trace_if_no_blockers");
  }

  return {
    targetRoas: Number.isFinite(input.decision.effectiveTargetRoas)
      ? input.decision.effectiveTargetRoas
      : null,
    ratioToTarget: input.decision.ratioToTarget ?? null,
    thresholdSource:
      input.decision.truthSource === "commercial_truth"
        ? "commercial_truth"
        : input.decision.truthSource,
    thresholdQuality: input.accountProfile?.quality.thresholdQuality ?? null,
    calibrationComputedAt,
    thresholdProvenance: {
      calibrationComputedAt,
      refitDueAt: addDaysToIso(
        calibrationComputedAt,
        CALIBRATION_REFIT_INTERVAL_DAYS,
      ),
      source: thresholdProvenanceSource(input.decision),
    },
    spendUnit: input.accountProfile?.spendUnit ?? null,
    commercialMaturitySpend:
      input.accountProfile?.thresholds.commercialMaturitySpend ?? null,
    hardCutSpend: input.accountProfile?.thresholds.hardCutSpend ?? null,
    scaleMinPurchases:
      input.accountProfile?.thresholds.scaleMinPurchases ?? null,
    blockerCount: blockers.length,
    blockerSummary: blockers.map(
      (blocker) =>
        `${blocker.predicate}: observed ${blocker.observed ?? "missing"} vs threshold ${blocker.threshold ?? "missing"} (${blocker.status})`,
    ),
    nearMisses: deriveNearMisses(input.decision, input.currency),
    historicalPrecision: backtest?.hardActionPrecision ?? null,
    historicalRecall: backtest?.hardActionRecall ?? null,
    expectedCalibrationError: backtest?.expectedCalibrationError ?? null,
    // Hard rows with known outcomes: the basis of ECE/precision, so the
    // calibration-honesty copy gates on the metric's real sample, not the
    // total row count (which includes soft labels and unknown outcomes).
    empiricalSampleSize: backtest?.hardActionKnownSampleSize ?? null,
    // The decision's own confidence decade, answered empirically: how often
    // hard decisions at this confidence were realized positive.
    bucketObservedRate: (() => {
      const decade = Math.min(
        9,
        Math.floor(Math.max(0, input.decision.confidence) / 10),
      );
      const bucket = `${decade * 10}_${decade * 10 + 9}`;
      const cell = backtest?.hardConfidenceBuckets.find(
        (item) => item.bucket === bucket,
      );
      return cell ? cell.observedRate : null;
    })(),
    bucketObservedSampleSize: (() => {
      const decade = Math.min(
        9,
        Math.floor(Math.max(0, input.decision.confidence) / 10),
      );
      const bucket = `${decade * 10}_${decade * 10 + 9}`;
      const cell = backtest?.hardConfidenceBuckets.find(
        (item) => item.bucket === bucket,
      );
      return cell ? cell.known : null;
    })(),
    missingEvidence,
  };
}

export function cardForDecision(input: {
  decision: DecisionOutput;
  creativeInput?: CreativeInput;
  row?: MetaCreativeApiRow | null;
  sourceAsOf?: string | null;
  sourceDataSource?: string | null;
  profileScope?: string | null;
  accountProfile?: AccountDecisionProfile | null;
  backtestSummary?: DecisionBacktestSummary | null;
  decisionCenterRow?: DecisionCenterRowForCard | null;
  hysteresis?: { rawLabel: DecisionLabel; suppressed: boolean } | null;
  decisionHistory?: BriefingCreativeCard["decisionHistory"];
  currency?: string | null;
}): BriefingCreativeCard {
  const { decision, creativeInput, row } = input;
  const label = decision.label as DecisionLabel;
  const name =
    row?.name ||
    decision.creativeName ||
    creativeInput?.creativeName ||
    decision.creativeId;
  const spend = safeNumber(row?.spend ?? decision.metrics.spend);
  const purchases = safeNumber(row?.purchases ?? decision.metrics.purchases);
  const roas = row?.roas ?? decision.metrics.roas ?? 0;
  const ctr = row?.ctr_all ?? creativeInput?.ctr ?? null;
  const recentRoas = decision.metrics.recent7dRoas ?? roas;
  const explainability = buildBriefingDecisionExplainability({
    decision,
    currency: input.currency,
    accountProfile: input.accountProfile,
    backtestSummary: input.backtestSummary,
  });
  const priorityScore = buildBriefingPriorityScore(decision);

  const decisionCenterRow = input.decisionCenterRow ?? null;
  const assessment = classifyMetaCreativeAssessment({
    label: decision.label,
    truthSource: decision.truthSource,
    badgeCodes: badgeLabels(decision.badges),
    heldAction: decision.blockedActionType ?? null,
  });
  return {
    id: row?.id || decision.creativeId,
    creativeId: decision.creativeId,
    adId: row?.real_ad_id ?? row?.id ?? null,
    realAdId: row?.real_ad_id ?? null,
    accountId: row?.account_id ?? null,
    providerAccountId: row?.account_id ?? null,
    campaign:
      row?.campaign_name ??
      row?.campaign_id ??
      creativeInput?.campaignId ??
      null,
    campaignName: row?.campaign_name ?? null,
    adset: row?.adset_name ?? row?.adset_id ?? null,
    adsetName: row?.adset_name ?? null,
    name,
    creativeName: name,
    brand: row?.account_name ?? "Meta",
    label,
    watchingSubBucket: deriveWatchingSubBucket(decision),
    truthSource: decision.truthSource,
    preAuthorityLabel: decision.preAuthorityLabel,
    authorityBlocker: decision.authorityBlocker,
    // Hysteresis surface: rawLabel is today's engine signal; when it differs
    // from the published label the decision is a held pending transition.
    rawLabel: input.hysteresis?.rawLabel ?? null,
    pendingTransition: input.hysteresis?.suppressed ?? false,
    decisionHistory: input.decisionHistory ?? null,
    currency: input.currency ?? null,
    spendUnitSource: input.accountProfile?.spendUnitSource ?? null,
    spendUnitConfidence: input.accountProfile?.spendUnitConfidence ?? null,
    metaAovQuality: input.accountProfile?.quality.metaAovQuality ?? null,
    thresholdQuality: input.accountProfile?.quality.thresholdQuality ?? null,
    badges: badgeLabels(decision.badges),
    blockers: decision.blockers ?? null,
    confidence: decision.confidence,
    reason: decision.reason,
    predictive: null,
    explainability,
    priorityScore,
    targetRoas: decision.effectiveTargetRoas,
    ratioToTarget: decision.ratioToTarget,
    spend,
    roas,
    ctr,
    cpa: row?.cpa ?? creativeInput?.cpa ?? null,
    purchases,
    impressions: safeNumber(row?.impressions ?? creativeInput?.impressions),
    linkClicks: safeNumber(row?.link_clicks ?? creativeInput?.linkClicks),
    addToCart: safeNumber(row?.add_to_cart ?? creativeInput?.addToCart),
    frequency: row?.frequency ?? creativeInput?.frequency ?? null,
    fatigue: decision.badges.some((badge) => badge.type === "fatigue_fatigued"),
    sparkline: [safeNumber(recentRoas), safeNumber(roas)],
    ctrFunnel: {
      value: ctr,
      p50: null,
    },
    primary: hardActionAuthorityBlocked(decision)
      ? blockedHardActionReview(decision)
      : primaryActionForDecisionCenterRow(decisionCenterRow, decision) ??
        primaryActionForDecision(decision),
    automationReadiness: creativeAutomationReadiness({
      decision,
      backtestSummary: input.backtestSummary ?? null,
    }),
    // The row is retained verbatim as provenance/evidence (drawer, dual-write
    // continuity). Its current-action fields carry NO authority: every active
    // consumer recomputes against the resolved-role gate above.
    ...(decisionCenterRow ? { decisionCenterRow } : {}),
    assessment,
    status: creativeInput?.effectiveStatus ?? row?.effective_status ?? null,
    ageDays: creativeInput?.ageDays ?? null,
    firstSeenAt: creativeInput?.firstSeenAt ?? null,
    firstSpendAt: creativeInput?.firstSpendAt ?? null,
    spend24h: creativeInput?.spend24h ?? null,
    impressions24h: creativeInput?.impressions24h ?? null,
    reviewStatus: creativeInput?.reviewStatus ?? null,
    disapprovalReason: creativeInput?.disapprovalReason ?? null,
    limitedReason: creativeInput?.limitedReason ?? null,
    // D074b correction: a kind is served only under canonical resolved
    // status; anything weaker serializes as role-unresolved with no kind.
    campaignKind:
      resolveCampaignRoleStatus(decision) === "resolved"
        ? (decision.campaignKind ?? null)
        : null,
    campaignTestDimension:
      resolveCampaignRoleStatus(decision) === "resolved"
        ? (decision.campaignTestDimension ?? null)
        : null,
    campaignRoleStatus: resolveCampaignRoleStatus(decision),
    blockedActionType: decision.blockedActionType ?? null,
    labelTransform: decision.labelTransform ?? null,
    engineVersion: decision.engineVersion ?? null,
    sourceAsOf: input.sourceAsOf ?? null,
    sourceDataSource: input.sourceDataSource ?? null,
    profileScope: input.profileScope ?? null,
    mediaPreviewUrl:
      row?.card_preview_url ??
      row?.image_url ??
      row?.preview_url ??
      row?.cached_thumbnail_url ??
      row?.thumbnail_url ??
      row?.table_thumbnail_url ??
      null,
    thumbnailUrl: row?.thumbnail_url ?? null,
    tableThumbnailUrl: row?.table_thumbnail_url ?? row?.thumbnail_url ?? null,
    cardPreviewUrl:
      row?.card_preview_url ??
      row?.image_url ??
      row?.cached_thumbnail_url ??
      row?.thumbnail_url ??
      row?.preview_url ??
      null,
    previewUrl: row?.preview_url ?? null,
    imageUrl: row?.image_url ?? null,
    cachedThumbnailUrl: row?.cached_thumbnail_url ?? null,
    preview: previewForRow(row),
    previewState:
      row?.preview_state === "preview" || row?.preview_state === "catalog"
        ? row.preview_state
        : row?.card_preview_url ||
            row?.preview_url ||
            row?.thumbnail_url ||
            row?.image_url ||
            row?.cached_thumbnail_url ||
            row?.table_thumbnail_url
          ? "preview"
          : "unavailable",
    isCatalog: row?.is_catalog ?? false,
    format: row?.format ?? null,
    creativeDeliveryType: row?.creative_delivery_type ?? null,
    creativeVisualFormat: row?.creative_visual_format ?? null,
    creativePrimaryType: row?.creative_primary_type ?? null,
    creativePrimaryLabel: row?.creative_primary_label ?? null,
    creativeSecondaryType: row?.creative_secondary_type ?? null,
    creativeSecondaryLabel: row?.creative_secondary_label ?? null,
    taxonomySource: row?.taxonomy_source ?? null,
    taxonomyReconciledByVideoEvidence:
      row?.taxonomy_reconciled_by_video_evidence ?? null,
  };
}
