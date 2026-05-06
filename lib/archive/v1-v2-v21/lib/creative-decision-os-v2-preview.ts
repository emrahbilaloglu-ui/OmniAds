import type {
  CreativeDecisionOsCreative,
  CreativeDecisionOsV1Response,
} from "@/lib/creative-decision-os";
import {
  resolveCreativeDecisionOsV2,
  type CreativeDecisionOsV2Actionability,
  type CreativeDecisionOsV2Input,
  type CreativeDecisionOsV2Output,
  type CreativeDecisionOsV2PrimaryDecision,
  type CreativeDecisionOsV2ProblemClass,
  type CreativeDecisionOsV2RiskLevel,
} from "@/lib/creative-decision-os-v2";
import type {
  CreativeDecisionOsSnapshotScope,
  CreativeDecisionOsSnapshotStatus,
} from "@/lib/creative-decision-os-snapshots";

export const CREATIVE_DECISION_OS_V2_PREVIEW_CONTRACT_VERSION =
  "creative-decision-os-v2-preview.v0.1.1";

export const CREATIVE_DECISION_OS_V2_PREVIEW_QUERY_PARAM = "creativeDecisionOsV2Preview";

export const CREATIVE_DECISION_OS_V2_PREVIEW_FORBIDDEN_BUTTON_TEXT = [
  /Apply/i,
  /Apply now/i,
  /Auto apply/i,
  /Auto-/i,
  /\bQueue\b/i,
  /Queue now/i,
  /Push live/i,
  /Push to review queue/i,
  /Scale now/i,
  /Cut now/i,
  /\bLaunch\b/i,
  /Budget increase/i,
  /Approve/i,
  /Accepted/i,
  /\bDirect\s+scale\b/i,
  /Product-ready/i,
] as const;

export const CREATIVE_DECISION_OS_V2_PREVIEW_FORBIDDEN_INTERNAL_TEXT = [
  /gold/i,
  /fixture/i,
  /\bPR\b/,
  /ChatGPT/i,
  /Claude/i,
  /Codex/i,
  /WIP/i,
  /internal evaluation/i,
] as const;

export type CreativeDecisionOsV2PreviewUrgencyBucketId =
  | "today_priority"
  | "ready_for_buyer_confirmation"
  | "buyer_review"
  | "diagnose_first"
  | "inactive_review";

export type CreativeDecisionOsV2PreviewReviewGroupId =
  | "scale_review_required"
  | "cut_review_required"
  | "refresh_review"
  | "protect_hold_review"
  | "test_more_review";

export interface CreativeDecisionOsV2PreviewMetrics {
  spend: number | null;
  purchases: number | null;
  impressions: number | null;
  roas: number | null;
  cpa: number | null;
  recentRoas: number | null;
  recentPurchases: number | null;
  longWindowRoas: number | null;
  activeBenchmarkRoas: number | null;
  activeBenchmarkCpa: number | null;
  peerMedianSpend: number | null;
}

export interface CreativeDecisionOsV2PreviewRow {
  rowId: string;
  creativeId: string;
  campaignId: string | null;
  adSetId: string | null;
  currentDecision: string | null;
  primaryDecision: CreativeDecisionOsV2PrimaryDecision;
  actionability: CreativeDecisionOsV2Actionability;
  confidence: number;
  reasonTags: string[];
  evidenceSummary: string;
  riskLevel: CreativeDecisionOsV2RiskLevel;
  problemClass: CreativeDecisionOsV2ProblemClass;
  queueEligible: boolean;
  applyEligible: boolean;
  blockerReasons: string[];
  secondarySuggestion: CreativeDecisionOsV2PrimaryDecision | null;
  buyerActionLabel: string;
  actionabilityLabel: string;
  metrics: CreativeDecisionOsV2PreviewMetrics;
  activeStatus: boolean | null;
  campaignStatus: string | null;
  adSetStatus: string | null;
  trustFlags: string[];
  campaignContextFlags: string[];
  changedFromCurrent: boolean;
  priorityScore: number;
}

export interface CreativeDecisionOsV2PreviewBucket {
  id: CreativeDecisionOsV2PreviewUrgencyBucketId;
  label: string;
  summary: string;
  collapsedByDefault: boolean;
  rowIds: string[];
}

export interface CreativeDecisionOsV2PreviewReviewGroup {
  id: CreativeDecisionOsV2PreviewReviewGroupId;
  decision: CreativeDecisionOsV2PrimaryDecision;
  label: string;
  rowIds: string[];
}

export interface CreativeDecisionOsV2PreviewDiagnoseGroup {
  key: string;
  label: string;
  rowIds: string[];
}

export interface CreativeDecisionOsV2PreviewSurfaceModel {
  rows: CreativeDecisionOsV2PreviewRow[];
  buckets: CreativeDecisionOsV2PreviewBucket[];
  reviewGroups: CreativeDecisionOsV2PreviewReviewGroup[];
  diagnoseGroups: CreativeDecisionOsV2PreviewDiagnoseGroup[];
  decisionDistribution: Record<CreativeDecisionOsV2PrimaryDecision, number>;
  actionabilityDistribution: Record<CreativeDecisionOsV2Actionability, number>;
  aboveTheFold: {
    bleedingSpendCount: number;
    scaleWorthyCount: number;
    fatigueOnBudgetCount: number;
    protectCount: number;
    diagnoseCount: number;
  };
}

export interface CreativeDecisionOsV2PreviewPayload {
  contractVersion: typeof CREATIVE_DECISION_OS_V2_PREVIEW_CONTRACT_VERSION;
  generatedAt: string;
  sourceDecisionOsGeneratedAt: string | null;
  businessId: string;
  rowCount: number;
  surface: CreativeDecisionOsV2PreviewSurfaceModel;
}

export interface CreativeDecisionOsV2PreviewApiResponse {
  contractVersion: typeof CREATIVE_DECISION_OS_V2_PREVIEW_CONTRACT_VERSION;
  enabled: boolean;
  status: CreativeDecisionOsSnapshotStatus;
  scope: CreativeDecisionOsSnapshotScope;
  generatedAt: string;
  decisionOsV2Preview: CreativeDecisionOsV2PreviewPayload | null;
  error: {
    code: string;
    message: string;
  } | null;
}

export interface CreativeDecisionOsV2PreviewSourceRow {
  rowId: string;
  creativeId?: string | null;
  campaignId?: string | null;
  adSetId?: string | null;
  currentDecision?: string | null;
  currentOperatorDecision?: string | null;
  v2Output?: CreativeDecisionOsV2Output | null;
  v2PrimaryDecision?: CreativeDecisionOsV2PrimaryDecision | null;
  v2Actionability?: CreativeDecisionOsV2Actionability | null;
  v2Confidence?: number | null;
  v2ReasonTags?: string[] | null;
  v2EvidenceSummary?: string | null;
  v2RiskLevel?: CreativeDecisionOsV2RiskLevel | null;
  v2ProblemClass?: CreativeDecisionOsV2ProblemClass | null;
  v2QueueEligible?: boolean | null;
  v2ApplyEligible?: boolean | null;
  v2BlockerReasons?: string[] | null;
  spend?: number | null;
  purchases?: number | null;
  impressions?: number | null;
  roas?: number | null;
  cpa?: number | null;
  recentRoas?: number | null;
  recentPurchases?: number | null;
  longWindowRoas?: number | null;
  activeBenchmarkRoas?: number | null;
  activeBenchmarkCpa?: number | null;
  peerMedianSpend?: number | null;
  activeStatus?: boolean | null;
  campaignStatus?: string | null;
  adSetStatus?: string | null;
  campaignAdsetBlockerFlags?: string[] | null;
  trustSourceProvenanceFlags?: string[] | null;
  changedFromCurrent?: boolean | null;
}

function finite(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function nullableNumber(value: number | null | undefined) {
  return finite(value) ? value : null;
}

function safeArray(value: string[] | null | undefined) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim())
    : [];
}

function increment<T extends string>(map: Record<T, number>, key: T) {
  map[key] = (map[key] ?? 0) + 1;
}

function statusText(value: string | null | undefined) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readRecentMetric(
  creative: CreativeDecisionOsCreative,
  key: "recentRoas" | "recentPurchases",
) {
  const reportMetrics = (
    creative.report as {
      supportingMetrics?: {
        recentRoas?: number | null;
        recentPurchases?: number | null;
      };
    }
  ).supportingMetrics;
  return nullableNumber(reportMetrics?.[key]);
}

function mapV1PrimaryDecision(creative: CreativeDecisionOsCreative) {
  if (creative.operatorPolicy?.actionClass === "scale") return "Scale";
  if (creative.operatorPolicy?.actionClass === "kill") return "Cut";
  if (creative.operatorPolicy?.actionClass === "refresh") return "Refresh";
  if (creative.operatorPolicy?.actionClass === "protect") return "Protect";
  if (creative.operatorPolicy?.actionClass === "test") return "Test More";
  if (creative.operatorPolicy?.actionClass === "contextual") return "Diagnose";
  if (creative.primaryAction === "promote_to_scaling") return "Scale";
  if (creative.primaryAction === "block_deploy") return "Cut";
  if (creative.primaryAction === "refresh_replace") return "Refresh";
  if (creative.primaryAction === "hold_no_touch") return "Protect";
  if (creative.primaryAction === "keep_in_test") return "Test More";
  if (creative.lifecycleState === "blocked") return "Diagnose";
  return null;
}

function trustFlagsFromCreative(creative: CreativeDecisionOsCreative) {
  const flags = [
    `truth_${creative.trust?.truthState ?? "unknown"}`,
    `evidence_${creative.evidenceSource ?? "unknown"}`,
    `baseline_${creative.benchmarkReliability ?? "unknown"}`,
    `preview_${creative.previewStatus?.liveDecisionWindow ?? "unknown"}`,
    `deployment_${creative.deployment?.compatibility?.status ?? "unknown"}`,
  ];
  if (creative.operatorPolicy?.pushReadiness) {
    flags.push(`review_${creative.operatorPolicy.pushReadiness}`);
  }
  return flags;
}

function campaignFlagsFromCreative(creative: CreativeDecisionOsCreative) {
  const flags: string[] = [];
  if (creative.deliveryContext?.activeDelivery === false) flags.push("inactive_creative");
  if (
    creative.deliveryContext?.campaignStatus &&
    creative.deliveryContext.campaignStatus !== "ACTIVE"
  ) {
    flags.push(`campaign_status_${creative.deliveryContext.campaignStatus.toLowerCase()}`);
  }
  if (creative.deliveryContext?.adSetStatus && creative.deliveryContext.adSetStatus !== "ACTIVE") {
    flags.push(`adset_status_${creative.deliveryContext.adSetStatus.toLowerCase()}`);
  }
  if (creative.deployment?.compatibility?.status === "blocked") flags.push("deployment_blocked");
  return flags;
}

export function mapCreativeDecisionOsV1CreativeToV2Input(
  creative: CreativeDecisionOsCreative,
): CreativeDecisionOsV2Input {
  return {
    rowId: creative.creativeId,
    activeStatus: creative.deliveryContext?.activeDelivery ?? null,
    campaignStatus: creative.deliveryContext?.campaignStatus ?? null,
    adsetStatus: creative.deliveryContext?.adSetStatus ?? null,
    spend: creative.spend,
    purchases: creative.purchases,
    impressions: creative.impressions,
    roas: creative.roas,
    cpa: creative.cpa,
    recentRoas: readRecentMetric(creative, "recentRoas"),
    recentPurchases: readRecentMetric(creative, "recentPurchases"),
    long90Roas: null,
    activeBenchmarkRoas:
      nullableNumber(creative.relativeBaseline?.medianRoas) ??
      nullableNumber(creative.benchmark?.metrics?.roas?.benchmark),
    activeBenchmarkCpa:
      nullableNumber(creative.relativeBaseline?.medianCpa) ??
      nullableNumber(creative.benchmark?.metrics?.cpa?.benchmark),
    peerMedianSpend:
      nullableNumber(creative.relativeBaseline?.medianSpend) ??
      nullableNumber(creative.report?.accountContext?.spendMedian),
    trustState: creative.trust?.truthState ?? null,
    baselineReliability: creative.benchmarkReliability ?? null,
    sourceTrustFlags: trustFlagsFromCreative(creative),
    campaignContextBlockerFlags: campaignFlagsFromCreative(creative),
    existingQueueEligible: creative.operatorPolicy?.queueEligible ?? false,
    existingApplyEligible: creative.operatorPolicy?.canApply ?? false,
  };
}

function buyerActionLabel(decision: CreativeDecisionOsV2PrimaryDecision) {
  if (decision === "Scale") return "Review scale case";
  if (decision === "Cut") return "Review cut case";
  if (decision === "Refresh") return "Plan creative refresh";
  if (decision === "Protect") return "Hold steady";
  if (decision === "Test More") return "Keep testing";
  return "Investigate blockers";
}

function actionabilityLabel(actionability: CreativeDecisionOsV2Actionability) {
  if (actionability === "direct") return "Ready for buyer confirmation";
  if (actionability === "review_only") return "Review required";
  if (actionability === "blocked") return "Blocked";
  return "Diagnose first";
}

function normalizeSourceRow(
  row: CreativeDecisionOsV2PreviewSourceRow,
): CreativeDecisionOsV2PreviewRow | null {
  const output = row.v2Output;
  const primaryDecision = output?.primaryDecision ?? row.v2PrimaryDecision ?? null;
  const actionability = output?.actionability ?? row.v2Actionability ?? null;
  const riskLevel = output?.riskLevel ?? row.v2RiskLevel ?? null;
  const problemClass = output?.problemClass ?? row.v2ProblemClass ?? null;
  if (!primaryDecision || !actionability || !riskLevel || !problemClass) return null;

  const currentDecision = row.currentDecision ?? row.currentOperatorDecision ?? null;
  const metrics = {
    spend: nullableNumber(row.spend),
    purchases: nullableNumber(row.purchases),
    impressions: nullableNumber(row.impressions),
    roas: nullableNumber(row.roas),
    cpa: nullableNumber(row.cpa),
    recentRoas: nullableNumber(row.recentRoas),
    recentPurchases: nullableNumber(row.recentPurchases),
    longWindowRoas: nullableNumber(row.longWindowRoas),
    activeBenchmarkRoas: nullableNumber(row.activeBenchmarkRoas),
    activeBenchmarkCpa: nullableNumber(row.activeBenchmarkCpa),
    peerMedianSpend: nullableNumber(row.peerMedianSpend),
  };

  const normalized: CreativeDecisionOsV2PreviewRow = {
    rowId: row.rowId,
    creativeId: row.creativeId ?? row.rowId,
    campaignId: row.campaignId ?? null,
    adSetId: row.adSetId ?? null,
    currentDecision,
    primaryDecision,
    actionability,
    confidence: output?.confidence ?? Math.round(row.v2Confidence ?? 0),
    reasonTags: safeArray(output?.reasonTags ?? row.v2ReasonTags),
    evidenceSummary: output?.evidenceSummary ?? row.v2EvidenceSummary ?? "",
    riskLevel,
    problemClass,
    queueEligible: output?.queueEligible ?? Boolean(row.v2QueueEligible),
    applyEligible: output?.applyEligible ?? Boolean(row.v2ApplyEligible),
    blockerReasons: safeArray(output?.blockerReasons ?? row.v2BlockerReasons),
    secondarySuggestion: output?.secondarySuggestion ?? null,
    buyerActionLabel: buyerActionLabel(primaryDecision),
    actionabilityLabel: actionabilityLabel(actionability),
    metrics,
    activeStatus: row.activeStatus ?? null,
    campaignStatus: statusText(row.campaignStatus),
    adSetStatus: statusText(row.adSetStatus),
    trustFlags: safeArray(row.trustSourceProvenanceFlags),
    campaignContextFlags: safeArray(row.campaignAdsetBlockerFlags),
    changedFromCurrent:
      row.changedFromCurrent ??
      (currentDecision ? currentDecision.toLowerCase() !== primaryDecision.toLowerCase() : false),
    priorityScore: 0,
  };
  normalized.priorityScore = priorityScore(normalized);
  return normalized;
}

function riskWeight(riskLevel: CreativeDecisionOsV2RiskLevel) {
  if (riskLevel === "critical") return 4;
  if (riskLevel === "high") return 3;
  if (riskLevel === "medium") return 2;
  return 1;
}

function isHighSpend(row: CreativeDecisionOsV2PreviewRow) {
  const spend = row.metrics.spend ?? 0;
  const peerSpend = row.metrics.peerMedianSpend ?? 0;
  return spend >= Math.max(500, peerSpend > 0 ? peerSpend * 1.5 : 1_000);
}

function hasSevereOrFatigueSignal(row: CreativeDecisionOsV2PreviewRow) {
  const tags = row.reasonTags.join(" ");
  return (
    tags.includes("severe") ||
    tags.includes("fatigue") ||
    tags.includes("recent_stop") ||
    tags.includes("recent_decay") ||
    tags.includes("strong_history_recent_stop")
  );
}

function belongsInTodayPriority(row: CreativeDecisionOsV2PreviewRow) {
  if (row.primaryDecision === "Scale") return true;
  if (row.primaryDecision === "Cut" && (isHighSpend(row) || riskWeight(row.riskLevel) >= 3))
    return true;
  if (
    row.primaryDecision === "Refresh" &&
    row.activeStatus !== false &&
    (isHighSpend(row) || hasSevereOrFatigueSignal(row))
  ) {
    return true;
  }
  if (row.changedFromCurrent && riskWeight(row.riskLevel) >= 3) return true;
  if (row.activeStatus !== false && hasSevereOrFatigueSignal(row) && isHighSpend(row)) return true;
  return false;
}

function priorityScore(row: CreativeDecisionOsV2PreviewRow) {
  const spend = row.metrics.spend ?? 0;
  const spendScore = Math.min(30, Math.log10(Math.max(10, spend)) * 7);
  let score = spendScore + riskWeight(row.riskLevel) * 10;
  if (row.primaryDecision === "Scale") score += 70;
  if (row.primaryDecision === "Cut" && isHighSpend(row)) score += 60;
  if (row.primaryDecision === "Refresh" && row.activeStatus !== false && isHighSpend(row))
    score += 45;
  if (row.changedFromCurrent) score += 12;
  if (row.actionability === "direct") score += 2;
  if (row.activeStatus === false) score -= 25;
  return Math.round(score * 100) / 100;
}

function sortRows(rows: CreativeDecisionOsV2PreviewRow[]) {
  return [...rows].sort((a, b) => {
    if (b.priorityScore !== a.priorityScore) return b.priorityScore - a.priorityScore;
    return (b.metrics.spend ?? 0) - (a.metrics.spend ?? 0);
  });
}

function rowIds(rows: CreativeDecisionOsV2PreviewRow[]) {
  return rows.map((row) => row.rowId);
}

function reviewGroupId(
  decision: CreativeDecisionOsV2PrimaryDecision,
): CreativeDecisionOsV2PreviewReviewGroupId | null {
  if (decision === "Scale") return "scale_review_required";
  if (decision === "Cut") return "cut_review_required";
  if (decision === "Refresh") return "refresh_review";
  if (decision === "Protect") return "protect_hold_review";
  if (decision === "Test More") return "test_more_review";
  return null;
}

function reviewGroupLabel(decision: CreativeDecisionOsV2PrimaryDecision) {
  if (decision === "Scale") return "Scale Buyer Review";
  if (decision === "Cut") return "Cut Review Required";
  if (decision === "Refresh") return "Refresh Review";
  if (decision === "Protect") return "Protect Hold Review";
  return "Test More Review";
}

function diagnoseGroupKey(row: CreativeDecisionOsV2PreviewRow) {
  return row.blockerReasons[0] ?? row.campaignContextFlags[0] ?? row.problemClass;
}

function humanizeKey(value: string) {
  return value
    .replace(/^review_/, "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

export function buildCreativeDecisionOsV2PreviewSurfaceModel(
  rows: CreativeDecisionOsV2PreviewSourceRow[],
): CreativeDecisionOsV2PreviewSurfaceModel {
  const normalizedRows = sortRows(
    rows
      .map(normalizeSourceRow)
      .filter((row): row is CreativeDecisionOsV2PreviewRow => Boolean(row)),
  );
  const todayPriorityRows = normalizedRows.filter(belongsInTodayPriority);
  const readyRows = normalizedRows.filter((row) => row.actionability === "direct");
  const buyerReviewRows = normalizedRows.filter((row) => row.actionability === "review_only");
  const diagnoseRows = normalizedRows.filter(
    (row) => row.primaryDecision === "Diagnose" || row.actionability === "diagnose",
  );
  const inactiveRows = normalizedRows.filter((row) => row.activeStatus === false);

  const decisionDistribution = {
    Scale: 0,
    Cut: 0,
    Refresh: 0,
    Protect: 0,
    "Test More": 0,
    Diagnose: 0,
  } satisfies Record<CreativeDecisionOsV2PrimaryDecision, number>;
  const actionabilityDistribution = {
    direct: 0,
    review_only: 0,
    blocked: 0,
    diagnose: 0,
  } satisfies Record<CreativeDecisionOsV2Actionability, number>;

  for (const row of normalizedRows) {
    increment(decisionDistribution, row.primaryDecision);
    increment(actionabilityDistribution, row.actionability);
  }

  const reviewGroups: CreativeDecisionOsV2PreviewReviewGroup[] = [];
  for (const decision of ["Scale", "Cut", "Refresh", "Protect", "Test More"] as const) {
    const id = reviewGroupId(decision);
    if (!id) continue;
    reviewGroups.push({
      id,
      decision,
      label: reviewGroupLabel(decision),
      rowIds: rowIds(sortRows(buyerReviewRows.filter((row) => row.primaryDecision === decision))),
    });
  }

  const diagnoseGroupMap = new Map<string, CreativeDecisionOsV2PreviewRow[]>();
  for (const row of diagnoseRows) {
    const key = diagnoseGroupKey(row);
    diagnoseGroupMap.set(key, [...(diagnoseGroupMap.get(key) ?? []), row]);
  }
  const diagnoseGroups = [...diagnoseGroupMap.entries()]
    .map(([key, groupRows]) => ({
      key,
      label: humanizeKey(key),
      rowIds: rowIds(sortRows(groupRows)),
    }))
    .sort((a, b) => b.rowIds.length - a.rowIds.length);

  return {
    rows: normalizedRows,
    buckets: [
      {
        id: "today_priority",
        label: "Today Priority / Buyer Command Strip",
        summary:
          "Scale cases, high-spend cuts, active refresh candidates, and highest-risk changes.",
        collapsedByDefault: false,
        rowIds: rowIds(todayPriorityRows),
      },
      {
        id: "ready_for_buyer_confirmation",
        label: "Ready for Buyer Confirmation",
        summary: "Confidence signal only. These rows are not automatically top urgency.",
        collapsedByDefault: false,
        rowIds: rowIds(readyRows),
      },
      {
        id: "buyer_review",
        label: "Buyer Review",
        summary: "Review required rows split by buyer decision.",
        collapsedByDefault: false,
        rowIds: rowIds(buyerReviewRows),
      },
      {
        id: "diagnose_first",
        label: "Diagnose First",
        summary: "Collapsed by default and grouped by blocker or problem class.",
        collapsedByDefault: true,
        rowIds: rowIds(diagnoseRows),
      },
      {
        id: "inactive_review",
        label: "Inactive Review",
        summary: "Inactive rows stay separated unless spend or risk makes them urgent.",
        collapsedByDefault: true,
        rowIds: rowIds(inactiveRows),
      },
    ],
    reviewGroups,
    diagnoseGroups,
    decisionDistribution,
    actionabilityDistribution,
    aboveTheFold: {
      bleedingSpendCount: todayPriorityRows.filter((row) => row.primaryDecision === "Cut").length,
      scaleWorthyCount: normalizedRows.filter((row) => row.primaryDecision === "Scale").length,
      fatigueOnBudgetCount: todayPriorityRows.filter((row) => row.primaryDecision === "Refresh")
        .length,
      protectCount: normalizedRows.filter((row) => row.primaryDecision === "Protect").length,
      diagnoseCount: diagnoseRows.length,
    },
  };
}

export function buildCreativeDecisionOsV2PreviewPayloadFromDecisionOs(
  decisionOs: CreativeDecisionOsV1Response,
  generatedAt = new Date().toISOString(),
): CreativeDecisionOsV2PreviewPayload {
  const rows = decisionOs.creatives.map((creative): CreativeDecisionOsV2PreviewSourceRow => {
    const input = mapCreativeDecisionOsV1CreativeToV2Input(creative);
    const output = resolveCreativeDecisionOsV2(input);
    const currentDecision = mapV1PrimaryDecision(creative);
    return {
      rowId: creative.creativeId,
      creativeId: creative.creativeId,
      campaignId: null,
      adSetId: null,
      currentDecision,
      v2Output: output,
      spend: creative.spend,
      purchases: creative.purchases,
      impressions: creative.impressions,
      roas: creative.roas,
      cpa: creative.cpa,
      recentRoas: input.recentRoas,
      recentPurchases: input.recentPurchases,
      longWindowRoas: input.long90Roas,
      activeBenchmarkRoas: input.activeBenchmarkRoas,
      activeBenchmarkCpa: input.activeBenchmarkCpa,
      peerMedianSpend: input.peerMedianSpend,
      activeStatus: input.activeStatus,
      campaignStatus: input.campaignStatus,
      adSetStatus: input.adsetStatus,
      campaignAdsetBlockerFlags: input.campaignContextBlockerFlags,
      trustSourceProvenanceFlags: input.sourceTrustFlags,
      changedFromCurrent: currentDecision ? currentDecision !== output.primaryDecision : false,
    };
  });

  const surface = buildCreativeDecisionOsV2PreviewSurfaceModel(rows);
  return {
    contractVersion: CREATIVE_DECISION_OS_V2_PREVIEW_CONTRACT_VERSION,
    generatedAt,
    sourceDecisionOsGeneratedAt: decisionOs.generatedAt ?? null,
    businessId: decisionOs.businessId,
    rowCount: surface.rows.length,
    surface,
  };
}

export function isCreativeDecisionOsV2PreviewEnabledForSearchParams(searchParams: URLSearchParams) {
  const value =
    searchParams.get(CREATIVE_DECISION_OS_V2_PREVIEW_QUERY_PARAM) ??
    searchParams.get("v2Preview") ??
    "";
  return value === "1" || value.toLowerCase() === "true";
}
