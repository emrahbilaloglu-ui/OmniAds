import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import { resolveMetaCredentials } from "@/lib/api/meta";
import { getDb } from "@/lib/db";
import { getMetaAdSetsForRange } from "@/lib/meta/adsets-source";
import { getMetaCampaignsForRange } from "@/lib/meta/campaigns-source";
import {
  annotateMetaRecPresentation,
  type MetaRecEntityMetricsSource,
  type MetaRecRowPresentationSource,
} from "@/lib/meta/rec-presentation";
import {
  readMetaDecisionSnapshotForRange as readLatestMetaDecisionSnapshot,
} from "@/lib/meta/snapshot";
import {
  META_RECOMMENDATION_ENGINE_VERSION,
  type MetaRecommendation,
} from "@/lib/meta/recommendations";
import type {
  MetaLanePayload,
  MetaStructureInventoryEntity,
  MetaWatchingSegmentKey,
} from "@/components/meta/redesign/types";
import { buildMetaWatchingSegments } from "@/lib/meta/watching-segments";
import { resolveMetaFunnelCohort, type MetaFunnelCohort } from "@/lib/meta/funnel-cohort";
import {
  briefingStatusForEntity,
  briefingStatusLabel,
  isInBriefing,
  isWithIssuesEntity,
  parseBriefingStatusFilter,
  type BriefingStatusFilter,
} from "@/lib/meta/briefing-filter";
import {
  readPreviousDifferentMetaAdSetConfigHistoryDiffs,
  readPreviousDifferentMetaCampaignConfigHistoryDiffs,
} from "@/lib/meta/request-model-store";
import { readCampaignContextMap } from "@/lib/creative-decision-engine/campaign-context/source";
import type { MetaCampaignKind } from "@/lib/meta/campaign-label-types";
import { getCachedValue } from "@/lib/server-cache";

export const dynamic = "force-dynamic";

const META_LIVE_STATUS_PROBE_TIMEOUT_MS = 5_000;

type PulseWindow = "7d" | "14d" | "28d" | "90d" | "custom";
type CampaignRow = Awaited<ReturnType<typeof getMetaCampaignsForRange>>["rows"][number];
type AdsetRow = Awaited<ReturnType<typeof getMetaAdSetsForRange>>["rows"][number];
type OperatorResponseState = NonNullable<MetaRecommendation["operatorResponseState"]>;

interface OperatorRecState {
  state: OperatorResponseState;
  subtype: string | null;
  occurredAt: string | null;
  /** Deferral expiry (deferred rows only). Null = indefinite (legacy rows). */
  reappearAt: string | null;
}

interface LiveMetaEntityStatus {
  id: string;
  status: string | null;
  effectiveStatus: string | null;
  deliveryStatus: string | null;
  configuredStatus: string | null;
  updatedAt: string | null;
  fetchedAt: string;
}

interface HealthyMetaRow {
  id: string;
  level: "campaign" | "adset";
  name: string;
  campaignId?: string | null;
  campaignName?: string | null;
  campaignKind?: MetaCampaignKind | null;
  spend: number;
  roas: number;
  cpa: number | null;
  status: string | null;
  optimizationGoal?: string | null;
  customEventType?: string | null;
  bidStrategyType?: string | null;
  bidStrategyLabel?: string | null;
  manualBidAmount?: number | null;
  previousManualBidAmount?: number | null;
  bidValue?: number | null;
  bidValueFormat?: "currency" | "roas" | null;
  previousBidValue?: number | null;
  previousBidValueFormat?: "currency" | "roas" | null;
  previousBidValueCapturedAt?: string | null;
  isOptimizationGoalMixed?: boolean;
  isCustomEventTypeMixed?: boolean;
  isBidStrategyMixed?: boolean;
  isBidValueMixed?: boolean;
}

interface ArchivedMetaRow {
  id: string;
  level: "campaign" | "adset";
  name: string;
  campaignId?: string | null;
  campaignName?: string | null;
  campaignKind?: MetaCampaignKind | null;
  status: string;
  statusLabel: string;
  spend: number;
  roas: number;
  cpa: number | null;
  purchases: number;
  lastKnownWindow: string;
  diagnosticNote: string | null;
  advisory?: {
    decisionLabel: string | null;
    primaryActionLabel: string;
    why: string;
    confidence: "high" | "medium" | "low";
  } | null;
}

function parseWindow(value: string | null): PulseWindow {
  if (value === "7d" || value === "14d" || value === "90d" || value === "custom") {
    return value;
  }
  return "28d";
}

function windowDays(window: PulseWindow) {
  if (window === "7d") return 7;
  if (window === "14d") return 14;
  if (window === "90d") return 90;
  return 28;
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function addDaysToISO(value: string, days: number) {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function toNumber(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function inclusiveRangeDays(startDate: string, endDate: string) {
  const start = Date.parse(`${startDate}T00:00:00.000Z`);
  const end = Date.parse(`${endDate}T00:00:00.000Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return null;
  }
  return Math.floor((end - start) / 86_400_000) + 1;
}

function rowBudgetUtilization(
  row: CampaignRow | AdsetRow,
  rangeDays: number | null,
) {
  if (
    rangeDays == null ||
    rangeDays <= 0 ||
    row.dailyBudget == null ||
    !Number.isFinite(row.dailyBudget) ||
    row.dailyBudget <= 0
  ) {
    return null;
  }
  const spend = Number(row.spend);
  if (!Number.isFinite(spend) || spend < 0) return null;
  return spend / ((row.dailyBudget / 100) * rangeDays);
}

type MetaCampaignRoleMap = ReadonlyMap<string, MetaCampaignKind>;

async function readAutomaticCampaignRoles(input: {
  businessId: string;
  providerAccountId: string | null;
  asOf: string;
  campaignIds: Array<string | null | undefined>;
}): Promise<MetaCampaignRoleMap> {
  const campaignIds = Array.from(
    new Set(input.campaignIds.filter((id): id is string => Boolean(id))),
  );
  if (campaignIds.length === 0) return new Map();
  const contexts = await readCampaignContextMap({
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
    campaignIds,
    asOf: input.asOf,
  }).catch((error) => {
    console.warn("[meta-lane-classify] campaign_role_read_failed", {
      businessId: input.businessId,
      campaignCount: campaignIds.length,
      message: error instanceof Error ? error.message : String(error),
    });
    return new Map();
  });
  const roles = new Map<string, MetaCampaignKind>();
  for (const [campaignId, entry] of contexts) {
    if (
      entry.kind === "main" ||
      entry.kind === "test" ||
      entry.kind === "mixed"
    ) {
      roles.set(campaignId, entry.kind);
    }
  }
  return roles;
}

function campaignKindForId(
  campaignId: string | null | undefined,
  campaignLabelsById: MetaCampaignRoleMap,
) {
  return campaignId ? campaignLabelsById.get(campaignId) ?? null : null;
}

function campaignKindForRecommendation(input: {
  rec: MetaRecommendation;
  campaignLabelsById: MetaCampaignRoleMap;
  activeCampaignIds: string[];
}): MetaCampaignKind | null {
  const campaignIds =
    input.rec.level === "campaign" || input.rec.level === "adset"
      ? input.rec.campaignId
        ? [input.rec.campaignId]
        : []
      : input.activeCampaignIds;
  if (campaignIds.length === 0) return null;
  const kinds = new Set<MetaCampaignKind>();
  let missingLabel = false;
  for (const campaignId of campaignIds) {
    const kind = input.campaignLabelsById.get(campaignId);
    if (kind) {
      kinds.add(kind);
    } else {
      missingLabel = true;
    }
  }
  if (missingLabel) return null;
  if (kinds.size > 1) return "mixed";
  return kinds.values().next().value ?? null;
}

function attachCampaignKindToRecommendation(input: {
  rec: MetaRecommendation;
  campaignLabelsById: MetaCampaignRoleMap;
  activeCampaignIds: string[];
}): MetaRecommendation {
  const campaignKind =
    input.rec.campaignKind ??
    campaignKindForRecommendation({
      rec: input.rec,
      campaignLabelsById: input.campaignLabelsById,
      activeCampaignIds: input.activeCampaignIds,
    });
  return campaignKind ? { ...input.rec, campaignKind } : input.rec;
}

function controlOwnerForEntity(input: {
  level: "campaign" | "adset";
  budgetLevel: "campaign" | "adset" | null | undefined;
  bidStrategyType: string | null | undefined;
}) {
  if (input.level === "adset") return "adset" as const;
  const strategy = input.bidStrategyType?.trim().toLowerCase() ?? "";
  if (/(cost[_ -]?cap|bid[_ -]?cap|min[_ -]?roas|target[_ -]?roas)/.test(strategy)) {
    return "adset" as const;
  }
  return input.budgetLevel ?? "unknown";
}

function attachEntityConfiguration(input: {
  rec: MetaRecommendation;
  campaignsById: Map<string, CampaignRow>;
  adsetsById: Map<string, AdsetRow>;
  rangeDays: number | null;
}): MetaRecommendation {
  const row =
    input.rec.level === "adset"
      ? input.rec.adsetId
        ? input.adsetsById.get(input.rec.adsetId)
        : null
      : input.rec.level === "campaign"
        ? input.rec.campaignId
          ? input.campaignsById.get(input.rec.campaignId)
          : null
        : null;
  if (!row || (input.rec.level !== "campaign" && input.rec.level !== "adset")) {
    return input.rec;
  }
  return {
    ...input.rec,
    entityConfiguration: entityConfigurationForRow({
      level: input.rec.level,
      row,
      rangeDays: input.rangeDays,
    }),
  };
}

function entityConfigurationForRow(input: {
  level: "campaign" | "adset";
  row: CampaignRow | AdsetRow;
  rangeDays: number | null;
}): NonNullable<MetaRecommendation["entityConfiguration"]> {
  const row = input.row;
  const budgetOwner = row.isBudgetMixed
    ? ("mixed" as const)
    : (row.budgetLevel ?? "unknown");
  const budgetMode =
    budgetOwner === "campaign"
      ? ("campaign_budget" as const)
      : budgetOwner === "adset"
        ? ("adset_budget" as const)
        : budgetOwner === "mixed"
          ? ("mixed" as const)
          : ("unknown" as const);
  return {
    source:
      input.level === "campaign"
        ? "account_scoped_campaign_row"
        : "account_scoped_adset_row",
    budgetOwner,
    budgetMode,
    controlOwner: controlOwnerForEntity({
      level: input.level,
      budgetLevel: row.budgetLevel,
      bidStrategyType: row.bidStrategyType,
    }),
    status: row.status ?? null,
    optimizationGoal: row.optimizationGoal ?? null,
    bidStrategyType: row.bidStrategyType ?? null,
    bidStrategyLabel: row.bidStrategyLabel ?? null,
    bidValue: row.bidValue ?? row.manualBidAmount ?? null,
    bidValueFormat: row.bidValueFormat ?? null,
    previousBidValue:
      row.previousBidValue ?? row.previousManualBidAmount ?? null,
    previousBidValueFormat: row.previousBidValueFormat ?? null,
    previousBidValueCapturedAt: row.previousBidValueCapturedAt ?? null,
    dailyBudget: row.dailyBudget ?? null,
    lifetimeBudget: row.lifetimeBudget ?? null,
    budgetUtilization: rowBudgetUtilization(row, input.rangeDays),
  };
}

function structureInventoryForRows(input: {
  campaignRows: CampaignRow[];
  adsetRows: AdsetRow[];
  campaignLabelsById: MetaCampaignRoleMap;
  rangeDays: number | null;
}): MetaStructureInventoryEntity[] {
  const campaignNamesById = new Map(
    input.campaignRows.map((row) => [row.id, row.name]),
  );
  const metrics = (row: CampaignRow | AdsetRow) => ({
    spend: nullableNumber(row.spend),
    purchases: nullableNumber(row.purchases),
    roas: nullableNumber(row.roas),
    cpa: nullableNumber(row.cpa),
    ctr: nullableNumber(row.ctr),
    frequency: nullableNumber(row.frequency),
  });
  return [
    ...input.campaignRows.map((row) => ({
      id: row.id,
      level: "campaign" as const,
      name: row.name,
      campaignId: row.id,
      campaignName: row.name,
      campaignKind: campaignKindForId(row.id, input.campaignLabelsById),
      status: row.status ?? null,
      statusLabel: briefingStatusLabel(row),
      metrics: metrics(row),
      entityConfiguration: entityConfigurationForRow({
        level: "campaign",
        row,
        rangeDays: input.rangeDays,
      }),
    })),
    ...input.adsetRows.map((row) => ({
      id: row.id,
      level: "adset" as const,
      name: row.name,
      campaignId: row.campaignId || null,
      campaignName: row.campaignId
        ? (campaignNamesById.get(row.campaignId) ?? null)
        : null,
      campaignKind: campaignKindForId(
        row.campaignId,
        input.campaignLabelsById,
      ),
      status: row.status ?? null,
      statusLabel: briefingStatusLabel(row),
      metrics: metrics(row),
      entityConfiguration: entityConfigurationForRow({
        level: "adset",
        row,
        rangeDays: input.rangeDays,
      }),
    })),
  ];
}

function cohortForCampaignRow(row: CampaignRow) {
  return resolveMetaFunnelCohort({
    optimizationGoal: row.optimizationGoal,
    customEventType: row.customEventType,
  });
}

function cohortForAdsetRow(row: AdsetRow) {
  return resolveMetaFunnelCohort({
    optimizationGoal: row.optimizationGoal,
    customEventType: row.customEventType,
  });
}

function isPurchaseScopedCohort(cohort: MetaFunnelCohort | null | undefined) {
  return !cohort || cohort === "purchase" || cohort === "unknown";
}

function isNonSalesCohort(cohort: MetaFunnelCohort | null | undefined) {
  return Boolean(cohort && cohort !== "purchase" && cohort !== "unknown");
}

function isVisibleForStatusLane(
  row: CampaignRow | AdsetRow,
  statusFilter: BriefingStatusFilter,
) {
  // The lanes offer actions, so they answer a stricter question than the money
  // rollups do. `isInBriefing` admits an uncaptured status because a spending
  // entity must still be counted; here an unverifiable status is grounds to
  // withhold, since we will not put a pause button on something we cannot
  // confirm is running. Such a row lands in Archive carrying the
  // "Status truth is incomplete" note rather than disappearing.
  if (statusFilter !== "all" && briefingStatusForEntity(row) === "UNKNOWN") {
    return false;
  }
  return isInBriefing(row, statusFilter);
}

function formatCohort(cohort: MetaFunnelCohort) {
  return cohort.replace(/_/g, " ");
}

function formatRoasValue(value: unknown) {
  return `${toNumber(value).toFixed(2)}x`;
}

function nullableNumber(value: unknown) {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function upperFunnelMetricsFromRow(
  row: CampaignRow | AdsetRow | null | undefined,
  costPerThruplayP50: number | null,
  cpmAccountP50: number | null = null,
) {
  return {
    spend: nullableNumber(row?.spend),
    impressions: nullableNumber(row?.impressions),
    reach: nullableNumber((row as { reach?: unknown } | null | undefined)?.reach),
    frequency: nullableNumber((row as { frequency?: unknown } | null | undefined)?.frequency),
    cpm: nullableNumber(row?.cpm),
    thruplayActions: nullableNumber((row as { thruplayActions?: unknown } | null | undefined)?.thruplayActions),
    videoViews3s: nullableNumber((row as { videoViews3s?: unknown } | null | undefined)?.videoViews3s),
    costPerThruplayP50,
    cpmAccountP50,
  };
}

function upperFunnelStateMetricsFromRow(
  row: CampaignRow | AdsetRow | null | undefined,
  costPerThruplayP50: number | null,
  cpmAccountP50: number | null = null,
) {
  const metrics = upperFunnelMetricsFromRow(row, costPerThruplayP50, cpmAccountP50);
  return {
    impressions: metrics.impressions,
    reach: metrics.reach,
    frequency: metrics.frequency,
    cpm: metrics.cpm,
    thruplayActions: metrics.thruplayActions,
    videoViews3s: metrics.videoViews3s,
    costPerThruplayP50: metrics.costPerThruplayP50,
    cpmAccountP50: metrics.cpmAccountP50,
  };
}

function targetValueRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

function enrichUpperFunnelRecommendation(input: {
  rec: MetaRecommendation;
  campaignsById: Map<string, CampaignRow>;
  adsetsById: Map<string, AdsetRow>;
  costPerThruplayP50: number | null;
  cpmAccountP50: number | null;
}): MetaRecommendation {
  if (input.rec.cohort !== "upper_funnel") return input.rec;
  const row =
    input.rec.level === "adset" && input.rec.adsetId
      ? input.adsetsById.get(input.rec.adsetId)
      : input.rec.campaignId
        ? input.campaignsById.get(input.rec.campaignId)
        : null;
  return {
    ...input.rec,
    targetValue: {
      ...targetValueRecord(input.rec.targetValue),
      ...upperFunnelMetricsFromRow(
        row,
        input.costPerThruplayP50,
        input.cpmAccountP50,
      ),
    },
  };
}

/**
 * One account-scope calibration percentile, or null when it is not trustworthy.
 *
 * Same gate for every metric: a p50 only counts once the calibration run had at
 * least eight entities behind it, so a two-campaign account never gets told it
 * is above or below "the account median".
 */
async function readAccountCalibrationP50(input: {
  businessId: string;
  metricName: string;
  cohort: string;
}) {
  const sql = getDb();
  const [row] = (await sql`
    SELECT p50, sample_size
    FROM meta_decision_calibration_daily
    WHERE business_id = ${input.businessId}
      AND scope_type = 'account'
      AND metric_name = ${input.metricName}
      AND cohort = ${input.cohort}
    ORDER BY snapshot_date DESC
    LIMIT 1
  `) as Array<{ p50: number | string | null; sample_size: number | string | null }>;
  const sampleSize = toNumber(row?.sample_size);
  const p50 = nullableNumber(row?.p50);
  return p50 != null && p50 > 0 && sampleSize >= 8 ? p50 : null;
}

async function readUpperFunnelCostPerThruplayP50(businessId: string) {
  return readAccountCalibrationP50({
    businessId,
    metricName: "cost_per_thruplay_28d",
    cohort: "upper_funnel",
  });
}

/**
 * The account CPM median the Non-sales card compares each entity against.
 *
 * The card's third tile is "CPM · acct p50" and had no source at all, so it
 * rendered a dash on every account while the calibration run had already
 * computed `cpm_14d` at account scope.
 */
async function readUpperFunnelCpmP50(businessId: string) {
  return readAccountCalibrationP50({
    businessId,
    metricName: "cpm_14d",
    cohort: "upper_funnel",
  });
}

function nonSalesStateRecommendation(input: {
  id: string;
  level: "campaign" | "adset";
  name: string;
  campaignId?: string | null;
  campaignName?: string | null;
  campaignKind?: MetaCampaignKind | null;
  spend: number;
  roas: number;
  cpa: number | null;
  purchases: number;
  status: string | null;
  statusLabel: string;
  cohort: MetaFunnelCohort;
  impressions?: number | null;
  reach?: number | null;
  frequency?: number | null;
  cpm?: number | null;
  thruplayActions?: number | null;
  videoViews3s?: number | null;
  costPerThruplayP50?: number | null;
  cpmAccountP50?: number | null;
}): MetaRecommendation {
  const levelLabel = input.level === "campaign" ? "Campaign" : "Adset";
  const cohortLabel = formatCohort(input.cohort);
  const statusLabel = input.statusLabel || input.status || "Unknown";

  return {
    id: `entity_state-${input.level}-${input.id}`,
    level: input.level,
    campaignId: input.level === "campaign" ? input.id : input.campaignId ?? undefined,
    campaignName: input.level === "campaign" ? input.name : input.campaignName ?? undefined,
    campaignKind: input.campaignKind ?? undefined,
    adsetId: input.level === "adset" ? input.id : undefined,
    adsetName: input.level === "adset" ? input.name : undefined,
    type: input.level === "campaign" ? "campaign_state" : "adset_state",
    kind: "state",
    decisionLabel: "out_of_scope",
    stateReason: `${levelLabel} is configured for ${cohortLabel} delivery and is separated from purchase decisions.`,
    lens: "structure",
    priority: "low",
    confidence: "low",
    confidenceScore: 0.35,
    confidenceReason: null,
    decisionState: "watch",
    decision: "non_sales_eligible",
    title: `${input.name}: out of sales scope`,
    why: `${levelLabel} resolves to the ${cohortLabel} cohort, so it should not compete with purchase-scoped action lanes.`,
    summary: `${input.name} is shown separately from purchase decisions while preserving spend visibility.`,
    recommendedAction: "Keep out of the sales decision queue.",
    expectedImpact: "Keeps the daily purchase briefing clean without hiding non-purchase activity.",
    evidence: [
      { label: "Cohort", value: input.cohort, tone: "neutral" },
      { label: "Status", value: statusLabel, tone: "neutral" },
      { label: "Spend", value: String(input.spend), tone: "neutral" },
      { label: "ROAS", value: formatRoasValue(input.roas), tone: "neutral" },
      { label: "Purchases", value: String(input.purchases), tone: "neutral" },
    ],
    timeframeContext: {
      coreVerdict: `${levelLabel} is outside the purchase cohort.`,
      selectedRangeOverlay: "Non-purchase cohorts are routed here instead of Action Now or Watching.",
      historicalSupport: "Cohort is derived from Meta optimization goal and custom event fields.",
      seasonalityFlag: "none",
      note: input.cpa == null ? null : `CPA in selected window: ${input.cpa}.`,
    },
    targetValue: {
      entityState: "non_sales_eligible",
      actionDensityEligible: false,
      status: input.status,
      cpa: input.cpa,
      spend: input.spend,
      impressions: input.impressions ?? null,
      reach: input.reach ?? null,
      frequency: input.frequency ?? null,
      cpm: input.cpm ?? null,
      thruplayActions: input.thruplayActions ?? null,
      videoViews3s: input.videoViews3s ?? null,
      costPerThruplayP50: input.costPerThruplayP50 ?? null,
      cpmAccountP50: input.cpmAccountP50 ?? null,
    },
    engineVersion: META_RECOMMENDATION_ENGINE_VERSION,
    signalQuality: { quality_status: "out_of_sales_scope", confidence_cap: "low" },
    calibrationScope: {},
    cohort: input.cohort,
  };
}

function latestRecentChangeAt(rec: MetaRecommendation) {
  const changes = rec.evidenceTrail?.recent_changes;
  if (!Array.isArray(changes)) return null;
  const timestamps = changes
    .map((change) => Date.parse(String((change as { applied_at?: unknown }).applied_at ?? "")))
    .filter(Number.isFinite);
  if (timestamps.length === 0) return null;
  return Math.max(...timestamps);
}

function isRecentlyChanged(rec: MetaRecommendation, now = Date.now()) {
  const latest = latestRecentChangeAt(rec);
  return latest != null && now - latest < 48 * 60 * 60 * 1000;
}

function isInLearning(rec: MetaRecommendation) {
  const reason = rec.confidenceReason ?? "";
  return (
    rec.type === "adset_watch_learning" ||
    reason === "thin_data_watching" ||
    /learning|cook|thin|insufficient/i.test(`${rec.title} ${rec.summary}`)
  );
}

function isInsufficientSignal(rec: MetaRecommendation) {
  return (rec.confidenceScore ?? 0) < 0.55 || rec.decisionState === "watch";
}

// The [0.55, 0.7) confidence band with an act/test decision state used to fall
// through every lane predicate and silently disappear (Codex cross-review
// STOP_AND_FIX). It now routes into Watching as its own segment so the
// operator can see signal that is forming but below the Action Now bar.
function isMidConfidence(rec: MetaRecommendation) {
  const score = rec.confidenceScore ?? 0;
  return score >= 0.55 && score < 0.7 && !isInsufficientSignal(rec);
}

function recScopeEntity(input: {
  rec: MetaRecommendation;
  campaignsById: Map<string, CampaignRow>;
  adsetsById: Map<string, AdsetRow>;
}) {
  if (input.rec.level === "account") return null;
  if (input.rec.adsetId) return input.adsetsById.get(input.rec.adsetId) ?? null;
  if (input.rec.campaignId) return input.campaignsById.get(input.rec.campaignId) ?? null;
  return null;
}

function isRecommendationInScope(input: {
  rec: MetaRecommendation;
  statusFilter: BriefingStatusFilter;
  campaignsById: Map<string, CampaignRow>;
  adsetsById: Map<string, AdsetRow>;
}) {
  if (input.rec.level === "account") return true;
  const entity = recScopeEntity(input);
  if (!entity) return input.statusFilter === "all";
  const entityVisible = isVisibleForStatusLane(entity, input.statusFilter);
  if (!entityVisible) return false;
  if (input.rec.level !== "adset" || input.statusFilter !== "active") {
    return true;
  }
  const campaignId =
    input.rec.campaignId ??
    (input.rec.adsetId
      ? input.adsetsById.get(input.rec.adsetId)?.campaignId
      : null);
  const campaign = campaignId
    ? input.campaignsById.get(campaignId)
    : null;
  return Boolean(campaign && isVisibleForStatusLane(campaign, "active"));
}

function isWithIssuesRec(input: {
  rec: MetaRecommendation;
  campaignsById: Map<string, CampaignRow>;
  adsetsById: Map<string, AdsetRow>;
}) {
  const entity = recScopeEntity(input);
  return entity ? isWithIssuesEntity(entity) : false;
}

function hasAutomationBlocker(rec: MetaRecommendation, blocker: string) {
  const blockers = rec.automationReadiness?.blockers;
  return Array.isArray(blockers) && blockers.includes(blocker as never);
}

function hasSignalQualityValue(rec: MetaRecommendation, key: string, value: string) {
  const signalQuality = rec.signalQuality;
  if (!signalQuality || typeof signalQuality !== "object") return false;
  return String(signalQuality[key] ?? "") === value;
}

function watchSegmentForRec(input: {
  rec: MetaRecommendation;
  deferredIds: Set<string>;
  campaignsById: Map<string, CampaignRow>;
  adsetsById: Map<string, AdsetRow>;
}): MetaWatchingSegmentKey {
  if (input.deferredIds.has(input.rec.id)) return "deferred";
  if (
    hasAutomationBlocker(input.rec, "campaign_context_unresolved") ||
    input.rec.confidenceReason === "automatic_campaign_context_review_only" ||
    input.rec.confidenceReason ===
      "automatic_campaign_context_resolver_unvalidated" ||
    hasSignalQualityValue(
      input.rec,
      "campaign_context_action_authority",
      "review_only",
    ) ||
    // Pre-D074b aliases: recognition-only for older persisted payloads.
    hasAutomationBlocker(input.rec, "missing_campaign_label") ||
    input.rec.confidenceReason === "unlabeled_campaign_soft_only" ||
    hasSignalQualityValue(input.rec, "label_status", "unlabeled")
  ) {
    return "role_unresolved";
  }
  if (hasAutomationBlocker(input.rec, "missing_commercial_anchor")) return "missing_target";
  if (isWithIssuesRec(input)) return "issues";
  if (isInLearning(input.rec)) return "learning";
  if (isRecentlyChanged(input.rec)) return "recently_changed";
  if (isInsufficientSignal(input.rec)) return "insufficient_signal";
  if (isMidConfidence(input.rec)) return "mid_confidence";
  return "other";
}

// A deferral is active only while reappear_at is null (indefinite, the legacy
// contract) or still in the future. Once reappear_at passes, the deferral has
// expired: the rec returns to its naturally classified lane and must not count
// as deferred anywhere (deferredIds, deferred watching segment, annotations).
function isExpiredDeferral(
  action: string,
  reappearAt: string | null | undefined,
  now = Date.now(),
) {
  if (action !== "deferred" || reappearAt == null) return false;
  const reappearAtMs = parseTimestampMs(reappearAt);
  return reappearAtMs != null && reappearAtMs <= now;
}

async function readOperatorRecStates(businessId: string) {
  const sql = getDb();
  const rows = (await sql`
    WITH events AS (
      SELECT
        rec_id,
        action,
        action_subtype,
        timestamp AS occurred_at,
        reappear_at
      FROM meta_decision_responses
      WHERE business_id = ${businessId}
        AND action IN ('acted', 'deferred', 'undeferred', 'ignored')

      UNION ALL

      SELECT
        rec_id_origin AS rec_id,
        'acted'::text AS action,
        action::text AS action_subtype,
        COALESCE(verified_at, updated_at, requested_at, created_at) AS occurred_at,
        NULL::timestamptz AS reappear_at
      FROM meta_ads_action_log
      WHERE business_id = ${businessId}
        AND status = 'success'
        AND rec_id_origin IS NOT NULL
        AND btrim(rec_id_origin) <> ''
    ),
    ranked AS (
      SELECT
        rec_id,
        action,
        action_subtype,
        occurred_at,
        reappear_at,
        ROW_NUMBER() OVER (PARTITION BY rec_id ORDER BY occurred_at DESC NULLS LAST) AS row_number
      FROM events
    )
    SELECT
      rec_id,
      action,
      action_subtype,
      occurred_at::text AS occurred_at,
      reappear_at::text AS reappear_at
    FROM ranked
    WHERE row_number = 1
  `) as Array<{
    rec_id: string;
    action: "acted" | "deferred" | "undeferred" | "ignored";
    action_subtype: string | null;
    occurred_at: string | null;
    reappear_at: string | null;
  }>;
  const states = new Map<string, OperatorRecState>();
  for (const row of rows) {
    if (!row.rec_id || row.action === "undeferred") continue;
    if (isExpiredDeferral(row.action, row.reappear_at)) continue;
    states.set(row.rec_id, {
      state: row.action,
      subtype: row.action_subtype ?? null,
      occurredAt: row.occurred_at ?? null,
      reappearAt: row.reappear_at ?? null,
    });
  }
  return states;
}

function annotateOperatorState(
  rec: MetaRecommendation,
  operatorStates: Map<string, OperatorRecState>,
  context: {
    campaignsById: Map<string, CampaignRow>;
    adsetsById: Map<string, AdsetRow>;
    liveStatusesById: Map<string, LiveMetaEntityStatus>;
  },
): MetaRecommendation {
  const state = operatorStates.get(rec.id);
  if (!state) return rec;
  if (isStaleOperatorActedState({ rec, state, ...context })) return rec;
  return {
    ...rec,
    operatorResponseState: state.state,
    operatorResponseSubtype: state.subtype,
    operatorResponseAt: state.occurredAt,
  };
}

function isPauseActedState(rec: MetaRecommendation, state: OperatorRecState) {
  if (state.state !== "acted") return false;
  const subtype = (state.subtype ?? "").toLowerCase();
  if (subtype.includes("resume")) return false;
  return subtype ? subtype.includes("pause") : rec.type === "adset_cut_spend";
}

function isResumeActedState(state: OperatorRecState) {
  if (state.state !== "acted") return false;
  const subtype = (state.subtype ?? "").toLowerCase();
  return subtype.includes("resume");
}

function recEntityId(rec: MetaRecommendation) {
  return rec.adsetId ?? rec.campaignId ?? null;
}

function normalizeStatus(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim().toUpperCase() : "";
}

function parseTimestampMs(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function entityStatusUpdatedAt(entity: unknown) {
  if (!entity || typeof entity !== "object") return null;
  const row = entity as {
    statusUpdatedAt?: unknown;
    sourceUpdatedAt?: unknown;
    updatedAt?: unknown;
    status_updated_at?: unknown;
    source_updated_at?: unknown;
    updated_at?: unknown;
  };
  return (
    row.statusUpdatedAt ??
    row.sourceUpdatedAt ??
    row.updatedAt ??
    row.status_updated_at ??
    row.source_updated_at ??
    row.updated_at ??
    null
  );
}

function isStatusNewerThanOperatorState(entity: unknown, state: OperatorRecState) {
  const statusAt = parseTimestampMs(entityStatusUpdatedAt(entity));
  if (statusAt == null) return false;
  const actionAt = parseTimestampMs(state.occurredAt);
  if (actionAt == null) return true;
  return statusAt > actionAt;
}

function liveStatusReversesOperatorState(status: LiveMetaEntityStatus, rec: MetaRecommendation, state: OperatorRecState) {
  const liveStatusAt = parseTimestampMs(status.updatedAt);
  const actionAt = parseTimestampMs(state.occurredAt);
  if (liveStatusAt != null && actionAt != null && liveStatusAt <= actionAt) {
    return false;
  }
  const configuredStatus = normalizeStatus(status.configuredStatus);
  const deliveryStatus = normalizeStatus(status.deliveryStatus);
  if (isPauseActedState(rec, state)) {
    return configuredStatus === "ACTIVE" || (!configuredStatus && deliveryStatus === "ACTIVE");
  }
  if (isResumeActedState(state)) {
    return configuredStatus === "PAUSED" || (!configuredStatus && deliveryStatus === "PAUSED");
  }
  return false;
}

function isStaleOperatorActedState(input: {
  rec: MetaRecommendation;
  state: OperatorRecState;
  campaignsById: Map<string, CampaignRow>;
  adsetsById: Map<string, AdsetRow>;
  liveStatusesById: Map<string, LiveMetaEntityStatus>;
}) {
  const liveStatus = input.liveStatusesById.get(recEntityId(input.rec) ?? "");
  if (liveStatus && liveStatusReversesOperatorState(liveStatus, input.rec, input.state)) {
    return true;
  }
  const entity = recScopeEntity(input);
  const status = normalizeStatus(entity?.status);
  if (isPauseActedState(input.rec, input.state) && status === "ACTIVE") {
    return isStatusNewerThanOperatorState(entity, input.state);
  }
  return isResumeActedState(input.state) && status === "PAUSED"
    ? isStatusNewerThanOperatorState(entity, input.state)
    : false;
}

function collectLiveStatusProbeIds(
  recommendations: MetaRecommendation[],
  operatorStates: Map<string, OperatorRecState>,
) {
  const ids = new Set<string>();
  for (const rec of recommendations) {
    const state = operatorStates.get(rec.id);
    if (!state || (!isPauseActedState(rec, state) && !isResumeActedState(state))) continue;
    const entityId = recEntityId(rec);
    if (entityId) ids.add(entityId);
  }
  return [...ids];
}

function collectStructureStatusProbeIds(input: {
  recommendations: MetaRecommendation[];
  campaigns: CampaignRow[];
  adsets: AdsetRow[];
}) {
  const ids = new Set<string>();
  const adsetsById = new Map(input.adsets.map((row) => [row.id, row]));
  for (const rec of input.recommendations) {
    if (rec.level === "campaign" && rec.campaignId) {
      ids.add(rec.campaignId);
    }
    if (rec.level === "adset") {
      if (rec.adsetId) ids.add(rec.adsetId);
      const campaignId =
        rec.campaignId ??
        (rec.adsetId ? adsetsById.get(rec.adsetId)?.campaignId : null);
      if (campaignId) ids.add(campaignId);
    }
  }
  for (const row of input.campaigns) {
    if (isNonSalesCohort(cohortForCampaignRow(row))) ids.add(row.id);
  }
  for (const row of input.adsets) {
    if (!isNonSalesCohort(cohortForAdsetRow(row))) continue;
    ids.add(row.id);
    if (row.campaignId) ids.add(row.campaignId);
  }
  return ids;
}

function chunkIds(ids: string[], size: number) {
  const chunks: string[][] = [];
  for (let index = 0; index < ids.length; index += size) {
    chunks.push(ids.slice(index, index + size));
  }
  return chunks;
}

async function loadLiveMetaEntityStatuses(businessId: string, entityIds: string[]) {
  const uniqueIds = [...new Set(entityIds.filter(Boolean))];
  const statuses = new Map<string, LiveMetaEntityStatus>();
  if (uniqueIds.length === 0) return statuses;
  let credentials: Awaited<ReturnType<typeof resolveMetaCredentials>> | null = null;
  try {
    credentials = await resolveMetaCredentials(businessId);
  } catch (error) {
    console.warn("[meta-lane-classify] live status probe credential lookup failed", {
      businessId,
      error: error instanceof Error ? error.message : String(error),
    });
    return statuses;
  }
  const accessToken = credentials?.accessToken;
  if (!accessToken) return statuses;

  const fetchedAt = new Date().toISOString();
  await Promise.all(
    chunkIds(uniqueIds, 50).map(async (ids) => {
      const url = new URL("https://graph.facebook.com/v25.0/");
      url.searchParams.set("ids", ids.join(","));
      url.searchParams.set("fields", "id,name,effective_status,status,updated_time");
      url.searchParams.set("access_token", accessToken);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), META_LIVE_STATUS_PROBE_TIMEOUT_MS);
      try {
        const response = await fetch(url.toString(), { cache: "no-store", signal: controller.signal });
        if (!response.ok) {
          console.warn("[meta-lane-classify] live status probe returned non-OK response", {
            businessId,
            status: response.status,
            entityCount: ids.length,
          });
          return;
        }
        const payload = (await response.json()) as Record<
          string,
          {
            id?: string;
            effective_status?: string | null;
            status?: string | null;
            updated_time?: string | null;
            error?: unknown;
          }
        >;
        for (const requestedId of ids) {
          const row = payload[requestedId];
          if (!row) continue;
          if (row.error) {
            console.warn("[meta-lane-classify] live status probe returned an entity error", {
              businessId,
              entityId: requestedId,
            });
            continue;
          }
          const status = row.status ?? null;
          const effectiveStatus = row.effective_status ?? null;
          statuses.set(requestedId, {
            id: row.id ?? requestedId,
            status,
            effectiveStatus,
            deliveryStatus: effectiveStatus ?? status,
            configuredStatus: status ?? effectiveStatus,
            updatedAt: row.updated_time ?? null,
            fetchedAt,
          });
        }
      } catch (error) {
        // Historical candidates fail closed later when current truth is unavailable.
        console.warn("[meta-lane-classify] live status probe request failed", {
          businessId,
          entityCount: ids.length,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        clearTimeout(timeout);
      }
    }),
  );
  return statuses;
}

async function readLiveMetaEntityStatuses(
  businessId: string,
  entityIds: string[],
) {
  const uniqueIds = [...new Set(entityIds.filter(Boolean))].sort();
  if (process.env.VITEST === "true" || process.env.NODE_ENV === "test") {
    return loadLiveMetaEntityStatuses(businessId, uniqueIds);
  }
  /**
   * Key the cache on a digest of the id set, not on the ids themselves.
   *
   * The key used to be the joined id list, and anything over 200 ids skipped
   * the cache entirely — which is exactly backwards: the big probes are the
   * expensive ones. This probe is a Meta Graph round trip in 50-id batches,
   * and it sits on the strictly serial stage between base evidence and label
   * kinds, so an account just over the line (73 campaigns + 141 ad sets = 214)
   * paid the full provider latency on every single request while a 90-id
   * account paid it once every 45 seconds.
   *
   * The digest keeps the scope exactly as tight as before: a different
   * business, or one id added, removed or changed, is a different key and a
   * different read. Only the key's length changed.
   */
  const scopeDigest = createHash("sha256")
    .update(uniqueIds.join(","), "utf8")
    .digest("hex");
  return (
    await getCachedValue({
      key: `meta-live-structure-status-v2:${businessId}:${uniqueIds.length}:${scopeDigest}`,
      ttlMs: 45_000,
      staleWhileRevalidateMs: 120_000,
      loader: () => loadLiveMetaEntityStatuses(businessId, uniqueIds),
    })
  ).value;
}

function applyLiveStatusesToRows<
  Row extends {
    id: string;
    status?: string | null;
    statusUpdatedAt?: string | null;
  },
>(
  rows: Row[],
  liveStatusesById: Map<string, LiveMetaEntityStatus>,
  options: {
    requiredCurrentStatusIds: Set<string>;
    sourceHasCurrentStatus: boolean;
  },
) {
  return rows.map((row) => {
    const liveStatus = liveStatusesById.get(row.id);
    if (!liveStatus) {
      if (
        options.requiredCurrentStatusIds.has(row.id) &&
        !options.sourceHasCurrentStatus
      ) {
        return { ...row, status: "UNKNOWN", statusUpdatedAt: null };
      }
      return row;
    }
    return {
      ...row,
      status: liveStatus.deliveryStatus ?? row.status ?? null,
      statusUpdatedAt: liveStatus.updatedAt ?? liveStatus.fetchedAt,
    };
  });
}

function deferredIdsFromOperatorStates(operatorStates: Map<string, OperatorRecState>) {
  const ids = new Set<string>();
  for (const [recId, response] of operatorStates.entries()) {
    if (response.state === "deferred") ids.add(recId);
  }
  return ids;
}

function healthyCampaignRows(input: {
  rows: Awaited<ReturnType<typeof getMetaCampaignsForRange>>["rows"];
  recommendedScopeIds: Set<string>;
  statusFilter: BriefingStatusFilter;
  campaignLabelsById: MetaCampaignRoleMap;
}): HealthyMetaRow[] {
  return input.rows
    .filter((row) => isPurchaseScopedCohort(cohortForCampaignRow(row)))
    .filter((row) => !input.recommendedScopeIds.has(row.id))
    .filter((row) => isInBriefing(row, input.statusFilter))
    .filter((row) => toNumber(row.spend) >= 100 || toNumber(row.purchases) >= 3)
    .slice(0, 12)
    .map((row) => ({
      id: row.id,
      level: "campaign" as const,
      name: row.name,
      campaignKind: campaignKindForId(row.id, input.campaignLabelsById),
      spend: toNumber(row.spend),
      roas: toNumber(row.roas),
      cpa: row.cpa == null ? null : toNumber(row.cpa),
      status: row.status,
      optimizationGoal: row.optimizationGoal,
      customEventType: row.customEventType,
      bidStrategyType: row.bidStrategyType,
      bidStrategyLabel: row.bidStrategyLabel,
      manualBidAmount: row.manualBidAmount,
      previousManualBidAmount: row.previousManualBidAmount,
      bidValue: row.bidValue,
      bidValueFormat: row.bidValueFormat,
      previousBidValue: row.previousBidValue,
      previousBidValueFormat: row.previousBidValueFormat,
      previousBidValueCapturedAt: row.previousBidValueCapturedAt,
      isOptimizationGoalMixed: row.isOptimizationGoalMixed,
      isCustomEventTypeMixed: row.isCustomEventTypeMixed,
      isBidStrategyMixed: row.isBidStrategyMixed,
      isBidValueMixed: row.isBidValueMixed,
    }));
}

function healthyAdsetRows(input: {
  rows: Awaited<ReturnType<typeof getMetaAdSetsForRange>>["rows"];
  recommendedScopeIds: Set<string>;
  campaignNamesById?: Map<string, string>;
  campaignsById: Map<string, CampaignRow>;
  statusFilter: BriefingStatusFilter;
  campaignLabelsById: MetaCampaignRoleMap;
}): HealthyMetaRow[] {
  return input.rows
    .filter((row) => isPurchaseScopedCohort(cohortForAdsetRow(row)))
    .filter((row) => !input.recommendedScopeIds.has(row.id))
    .filter((row) => isInBriefing(row, input.statusFilter))
    .filter((row) => {
      const campaign = input.campaignsById.get(row.campaignId);
      return Boolean(
        campaign && isVisibleForStatusLane(campaign, input.statusFilter),
      );
    })
    .filter((row) => toNumber(row.spend) >= 75 || toNumber(row.purchases) >= 3)
    .slice(0, 12)
    .map((row) => ({
      id: row.id,
      level: "adset" as const,
      name: row.name,
      campaignId: row.campaignId,
      campaignName: row.campaignId ? (input.campaignNamesById?.get(row.campaignId) ?? null) : null,
      campaignKind: campaignKindForId(row.campaignId, input.campaignLabelsById),
      spend: toNumber(row.spend),
      roas: toNumber(row.roas),
      cpa: row.cpa == null ? null : toNumber(row.cpa),
      status: row.status,
      optimizationGoal: row.optimizationGoal,
      customEventType: row.customEventType,
      bidStrategyType: row.bidStrategyType,
      bidStrategyLabel: row.bidStrategyLabel,
      manualBidAmount: row.manualBidAmount,
      previousManualBidAmount: row.previousManualBidAmount,
      bidValue: row.bidValue,
      bidValueFormat: row.bidValueFormat,
      previousBidValue: row.previousBidValue,
      previousBidValueFormat: row.previousBidValueFormat,
      previousBidValueCapturedAt: row.previousBidValueCapturedAt,
      isOptimizationGoalMixed: row.isOptimizationGoalMixed,
      isCustomEventTypeMixed: row.isCustomEventTypeMixed,
      isBidStrategyMixed: row.isBidStrategyMixed,
      isBidValueMixed: row.isBidValueMixed,
    }));
}

async function attachPreviousBidDiffsToHealthyRows(
  businessId: string,
  rows: HealthyMetaRow[],
): Promise<HealthyMetaRow[]> {
  const rowsNeedingPrevious = rows.filter((row) =>
    row.manualBidAmount != null ||
    row.bidValue != null ||
    row.bidValueFormat != null
  );
  const campaignIds = rowsNeedingPrevious
    .filter((row) => row.level === "campaign")
    .map((row) => row.id);
  const adsetIds = rowsNeedingPrevious
    .filter((row) => row.level === "adset")
    .map((row) => row.id);
  if (campaignIds.length === 0 && adsetIds.length === 0) return rows;

  const [campaignDiffs, adsetDiffs] = await Promise.all([
    campaignIds.length > 0
      ? readPreviousDifferentMetaCampaignConfigHistoryDiffs({
          businessId,
          campaignIds,
          includeBudget: false,
        }).catch((error) => {
          console.warn("[meta-lane-classify] campaign_previous_bid_unavailable", {
            businessId,
            entityCount: campaignIds.length,
            message: error instanceof Error ? error.message : String(error),
          });
          return new Map();
        })
      : Promise.resolve(new Map()),
    adsetIds.length > 0
      ? readPreviousDifferentMetaAdSetConfigHistoryDiffs({
          businessId,
          adsetIds,
          includeBudget: false,
        }).catch((error) => {
          console.warn("[meta-lane-classify] adset_previous_bid_unavailable", {
            businessId,
            entityCount: adsetIds.length,
            message: error instanceof Error ? error.message : String(error),
          });
          return new Map();
        })
      : Promise.resolve(new Map()),
  ]);

  return rows.map((row) => {
    const diff = row.level === "campaign" ? campaignDiffs.get(row.id) : adsetDiffs.get(row.id);
    if (!diff) return row;
    return {
      ...row,
      previousManualBidAmount: diff.previousManualBidAmount ?? row.previousManualBidAmount,
      previousBidValue: diff.previousBidValue ?? row.previousBidValue,
      previousBidValueFormat: diff.previousBidValueFormat ?? row.previousBidValueFormat,
      previousBidValueCapturedAt: diff.previousBidCapturedAt ?? row.previousBidValueCapturedAt,
    };
  });
}

function archiveCampaignRows(input: {
  rows: CampaignRow[];
  statusFilter: BriefingStatusFilter;
  window: PulseWindow;
  campaignLabelsById: MetaCampaignRoleMap;
}): ArchivedMetaRow[] {
  return input.rows
    .filter((row) => !isVisibleForStatusLane(row, input.statusFilter))
    .map((row) => ({
      id: row.id,
      level: "campaign" as const,
      name: row.name,
      campaignKind: campaignKindForId(row.id, input.campaignLabelsById),
      status: briefingStatusForEntity(row),
      statusLabel: briefingStatusLabel(row),
      spend: toNumber(row.spend),
      roas: toNumber(row.roas),
      cpa: row.cpa == null ? null : toNumber(row.cpa),
      purchases: toNumber(row.purchases),
      lastKnownWindow: input.window,
      diagnosticNote:
        briefingStatusForEntity(row) === "UNKNOWN"
          ? "Status truth is incomplete; engine recommendations are suppressed."
          : null,
    }));
}

function archiveAdsetRows(input: {
  rows: AdsetRow[];
  statusFilter: BriefingStatusFilter;
  window: PulseWindow;
  campaignNamesById?: Map<string, string>;
  campaignsById: Map<string, CampaignRow>;
  campaignLabelsById: MetaCampaignRoleMap;
}): ArchivedMetaRow[] {
  return input.rows
    .map((row) => {
      const parent = input.campaignsById.get(row.campaignId);
      const parentLive = Boolean(
        parent && isVisibleForStatusLane(parent, input.statusFilter),
      );
      return { row, parent, parentLive };
    })
    .filter(
      ({ row, parentLive }) =>
        !parentLive || !isVisibleForStatusLane(row, input.statusFilter),
    )
    .map(({ row, parent, parentLive }) => ({
      id: row.id,
      level: "adset" as const,
      name: row.name,
      campaignId: row.campaignId,
      campaignName: input.campaignNamesById?.get(row.campaignId) ?? null,
      campaignKind: campaignKindForId(row.campaignId, input.campaignLabelsById),
      status: parentLive
        ? briefingStatusForEntity(row)
        : `CAMPAIGN_${briefingStatusForEntity(parent ?? {})}`,
      statusLabel: parentLive
        ? briefingStatusLabel(row)
        : `Campaign ${briefingStatusLabel(parent ?? {}).toLowerCase()}`,
      spend: toNumber(row.spend),
      roas: toNumber(row.roas),
      cpa: row.cpa == null ? null : toNumber(row.cpa),
      purchases: toNumber(row.purchases),
      lastKnownWindow: input.window,
      diagnosticNote: !parentLive
        ? "Parent campaign is not active; this ad-set recommendation is advisory-only."
        : briefingStatusForEntity(row) === "UNKNOWN"
          ? "Status truth is incomplete; engine recommendations are suppressed."
          : null,
    }));
}

function nonSalesCampaignRows(input: {
  rows: CampaignRow[];
  recommendedScopeIds: Set<string>;
  statusFilter: BriefingStatusFilter;
  costPerThruplayP50: number | null;
  cpmAccountP50: number | null;
  campaignLabelsById: MetaCampaignRoleMap;
}): MetaRecommendation[] {
  return input.rows
    .map((row) => ({ row, cohort: cohortForCampaignRow(row) }))
    .filter(({ cohort }) => isNonSalesCohort(cohort))
    .filter(({ row }) => !input.recommendedScopeIds.has(row.id))
    .filter(({ row }) => isVisibleForStatusLane(row, input.statusFilter))
    .map(({ row, cohort }) =>
      nonSalesStateRecommendation({
        id: row.id,
        level: "campaign",
        name: row.name,
        campaignKind: campaignKindForId(row.id, input.campaignLabelsById),
        spend: toNumber(row.spend),
        roas: toNumber(row.roas),
        cpa: row.cpa == null ? null : toNumber(row.cpa),
        purchases: toNumber(row.purchases),
        status: briefingStatusForEntity(row),
        statusLabel: briefingStatusLabel(row),
        cohort,
        ...upperFunnelStateMetricsFromRow(
          row,
          input.costPerThruplayP50,
          input.cpmAccountP50,
        ),
      }),
    );
}

function nonSalesAdsetRows(input: {
  rows: AdsetRow[];
  recommendedScopeIds: Set<string>;
  campaignNamesById?: Map<string, string>;
  campaignsById: Map<string, CampaignRow>;
  statusFilter: BriefingStatusFilter;
  costPerThruplayP50: number | null;
  cpmAccountP50: number | null;
  campaignLabelsById: MetaCampaignRoleMap;
}): MetaRecommendation[] {
  return input.rows
    .map((row) => ({ row, cohort: cohortForAdsetRow(row) }))
    .filter(({ cohort }) => isNonSalesCohort(cohort))
    .filter(({ row }) => !input.recommendedScopeIds.has(row.id))
    .filter(({ row }) => isVisibleForStatusLane(row, input.statusFilter))
    .filter(({ row }) => {
      const campaign = input.campaignsById.get(row.campaignId);
      return Boolean(
        campaign && isVisibleForStatusLane(campaign, input.statusFilter),
      );
    })
    .map(({ row, cohort }) =>
      nonSalesStateRecommendation({
        id: row.id,
        level: "adset",
        name: row.name,
        campaignId: row.campaignId,
        campaignName: input.campaignNamesById?.get(row.campaignId) ?? null,
        campaignKind: campaignKindForId(row.campaignId, input.campaignLabelsById),
        spend: toNumber(row.spend),
        roas: toNumber(row.roas),
        cpa: row.cpa == null ? null : toNumber(row.cpa),
        purchases: toNumber(row.purchases),
        status: briefingStatusForEntity(row),
        statusLabel: briefingStatusLabel(row),
        cohort,
        ...upperFunnelStateMetricsFromRow(
          row,
          input.costPerThruplayP50,
          input.cpmAccountP50,
        ),
      }),
    );
}

export async function GET(request: NextRequest) {
  const requestStartedAt = performance.now();
  const { searchParams } = request.nextUrl;
  const businessId = searchParams.get("businessId")?.trim() ?? "";
  const providerAccountId =
    searchParams.get("providerAccountId")?.trim() || null;
  const window = parseWindow(searchParams.get("window"));
  const statusFilter = parseBriefingStatusFilter(searchParams.get("status_filter"));
  const compactWorkspace = searchParams.get("workspace_surface") === "os";
  const endDate = searchParams.get("endDate")?.trim() || todayISO();
  const startDate =
    searchParams.get("startDate")?.trim() ||
    addDaysToISO(endDate, -(windowDays(window) - 1));
  const rangeDays = inclusiveRangeDays(startDate, endDate);

  const access = await requireBusinessAccess({
    request,
    businessId,
    minRole: "guest",
  });
  if ("error" in access) return access.error;
  const accessCompletedAt = performance.now();
  if (!businessId) {
    return NextResponse.json(
      { error: "missing_business_id", message: "businessId is required." },
      { status: 400 },
    );
  }

  const baseStageDurations: Record<string, number> = {};
  const timedBaseRead = async <T,>(
    name: string,
    loader: () => Promise<T>,
  ): Promise<T> => {
    const startedAt = performance.now();
    try {
      return await loader();
    } finally {
      baseStageDurations[name] = performance.now() - startedAt;
    }
  };
  const loadBaseEvidence = () =>
    Promise.all([
      timedBaseRead("snapshot", () =>
        /*
          The account travels with the read, because the read uses it for the
          CAMPAIGN ROLE.

          `readLatestMetaDecisionSnapshot` resolves the campaign-context guard
          through `readCampaignContextGuardState` →
          `readCampaignContextLabelMap`, and that map refuses to answer without
          a physical account: campaign role is an account fact, so an unproven
          scope returns an EMPTY map rather than a business-wide guess
          (`lib/creative-decision-engine/campaign-context/source.ts:248-254`).
          Passing null therefore made every campaign read as unlabeled, and
          `applyMetaCampaignLabelGuard` demoted every hard action to
          `decisionState: "watch"`, `confidence: "low"`,
          `campaign_context_action_authority: "review_only"` with
          `campaign_context_unresolved` on the blockers — measured on a campaign
          that HAS a published, high-confidence, system-inferred role from the
          approved resolver identity.

          Scoping the ROWS is the same argument's other half and is safe here
          for two reasons that are already true of this route: the snapshot
          recommendations are re-filtered below against `campaignIdsInScope` /
          `adsetIdsInScope`, which are themselves read with
          `accountId: providerAccountId`, so an out-of-account row could never
          be served anyway; and this route already reads its own roles
          account-scoped through `readAutomaticCampaignRoles` below. A null
          account (the business-wide caller) keeps the previous behaviour
          exactly, including the empty context map, which for that caller is the
          honest answer rather than a defect.
        */
        readLatestMetaDecisionSnapshot({
          businessId,
          startDate,
          endDate,
          providerAccountId,
        }),
      ),
      timedBaseRead("operator", () =>
        readOperatorRecStates(businessId).catch(
          () => new Map<string, OperatorRecState>(),
        ),
      ),
      timedBaseRead("campaigns", () =>
        getMetaCampaignsForRange({
          businessId,
          accountId: providerAccountId,
          startDate,
          endDate,
          includePrev: !compactWorkspace,
          includePrevBudget: !compactWorkspace,
        }),
      ),
      timedBaseRead("adsets", () =>
        getMetaAdSetsForRange({
          businessId,
          accountId: providerAccountId,
          startDate,
          endDate,
          includePrev: !compactWorkspace,
          includePrevBudget: !compactWorkspace,
        }),
      ),
      timedBaseRead("upper_funnel", () =>
        readUpperFunnelCostPerThruplayP50(businessId).catch(() => null),
      ),
      timedBaseRead("upper_funnel_cpm", () =>
        readUpperFunnelCpmP50(businessId).catch(() => null),
      ),
    ] as const);
  const baseEvidence =
    process.env.VITEST === "true" || process.env.NODE_ENV === "test"
      ? await loadBaseEvidence()
      : (
          await getCachedValue({
            key: [
              "meta-lane-base-v2",
              businessId,
              providerAccountId ?? "all",
              startDate,
              endDate,
              compactWorkspace ? "compact" : "full",
            ].join(":"),
            ttlMs: 30_000,
            staleWhileRevalidateMs: 120_000,
            loader: loadBaseEvidence,
          })
        ).value;
  const [
    snapshot,
    operatorStates,
    campaigns,
    adsets,
    upperFunnelCostPerThruplayP50,
    upperFunnelCpmP50,
  ] = baseEvidence;
  const baseEvidenceCompletedAt = performance.now();

  const campaignIdsInScope = new Set(
    (campaigns.rows ?? []).map((row) => row.id).filter(Boolean),
  );
  const adsetIdsInScope = new Set(
    (adsets.rows ?? []).map((row) => row.id).filter(Boolean),
  );
  const snapshotRecommendations = (snapshot?.recommendations ?? []).filter(
    (rec) => {
      if (!providerAccountId) return true;
      if (rec.level === "campaign") {
        return Boolean(rec.campaignId && campaignIdsInScope.has(rec.campaignId));
      }
      if (rec.level === "adset") {
        return Boolean(
          rec.adsetId &&
            adsetIdsInScope.has(rec.adsetId) &&
            (!rec.campaignId || campaignIdsInScope.has(rec.campaignId)),
        );
      }
      // Legacy account-level snapshots have no provider-account identity and
      // therefore cannot be served safely on an explicit account surface.
      return false;
    },
  );
  const requiredCurrentStatusIds = collectStructureStatusProbeIds({
    recommendations: snapshotRecommendations,
    campaigns: compactWorkspace
      ? (campaigns.rows ?? []).filter((row) =>
          isVisibleForStatusLane(row, "active"),
        )
      : (campaigns.rows ?? []),
    adsets: compactWorkspace
      ? (adsets.rows ?? []).filter((row) =>
          isVisibleForStatusLane(row, "active"),
        )
      : (adsets.rows ?? []),
  });
  const liveStatusesById = await readLiveMetaEntityStatuses(
    businessId,
    [
      ...requiredCurrentStatusIds,
      ...collectLiveStatusProbeIds(snapshotRecommendations, operatorStates),
    ],
  );
  const liveStatusesCompletedAt = performance.now();
  const campaignRows = applyLiveStatusesToRows(
    campaigns.rows ?? [],
    liveStatusesById,
    {
      requiredCurrentStatusIds,
      sourceHasCurrentStatus:
        campaigns.evidenceSource === "live" ||
        campaigns.evidenceSource === "demo",
    },
  );
  const adsetRows = applyLiveStatusesToRows(
    adsets.rows ?? [],
    liveStatusesById,
    {
      requiredCurrentStatusIds,
      sourceHasCurrentStatus:
        adsets.evidenceSource === "live" || adsets.evidenceSource === "demo",
    },
  );
  const campaignLabelsById = await readAutomaticCampaignRoles({
    businessId,
    providerAccountId,
    asOf: endDate,
    campaignIds: [
      ...campaignRows
        .filter(
          (row) =>
            !compactWorkspace || isVisibleForStatusLane(row, "active"),
        )
        .map((row) => row.id),
      ...adsetRows
        .filter(
          (row) =>
            !compactWorkspace || isVisibleForStatusLane(row, "active"),
        )
        .map((row) => row.campaignId),
    ],
  });
  const campaignLabelsCompletedAt = performance.now();
  const activeCampaignIds = campaignRows
    .filter((row) => isVisibleForStatusLane(row, "active"))
    .map((row) => row.id);
  const deferredIds = deferredIdsFromOperatorStates(operatorStates);
  const campaignsById = new Map(campaignRows.map((row) => [row.id, row]));
  const adsetsById = new Map(adsetRows.map((row) => [row.id, row]));
  const structureInventory = structureInventoryForRows({
    campaignRows,
    adsetRows,
    campaignLabelsById,
    rangeDays,
  });
  const recommendationStatusFilter = compactWorkspace
    ? ("active" as const)
    : statusFilter;
  const recommendations = snapshotRecommendations
    .filter((rec) =>
      isRecommendationInScope({
        rec,
        statusFilter: recommendationStatusFilter,
        campaignsById,
        adsetsById,
      }),
    )
    .map((rec) => annotateOperatorState(rec, operatorStates, { campaignsById, adsetsById, liveStatusesById }))
    .map((rec) =>
      attachCampaignKindToRecommendation({
        rec,
        campaignLabelsById,
        activeCampaignIds,
      }),
    )
    .map((rec) =>
      attachEntityConfiguration({
        rec,
        campaignsById,
        adsetsById,
        rangeDays,
      }),
    );
  const inactiveRecommendations = (compactWorkspace
    ? []
    : snapshotRecommendations)
    .filter((rec) => {
      if (rec.level === "account") return false;
      const entity = recScopeEntity({ rec, campaignsById, adsetsById });
      if (!entity) return false;
      return !isRecommendationInScope({
        rec,
        statusFilter: "active",
        campaignsById,
        adsetsById,
      });
    })
    .map((rec) =>
      attachEntityConfiguration({
        rec: attachCampaignKindToRecommendation({
          rec,
          campaignLabelsById,
          activeCampaignIds,
        }),
        campaignsById,
        adsetsById,
        rangeDays,
      }),
    );
  const purchaseScopedRecs = recommendations.filter((rec) => isPurchaseScopedCohort(rec.cohort));
  const nonSalesRecs = recommendations
    .filter((rec) => isNonSalesCohort(rec.cohort))
    .map((rec) =>
      enrichUpperFunnelRecommendation({
        rec,
        campaignsById,
        adsetsById,
        costPerThruplayP50: upperFunnelCostPerThruplayP50,
        cpmAccountP50: upperFunnelCpmP50,
      }),
    );
  const actionNow = purchaseScopedRecs.filter(
    (rec) =>
      rec.decisionState === "act" &&
      (rec.confidenceScore ?? 0) >= 0.7 &&
      !isInLearning(rec) &&
      !isWithIssuesRec({ rec, campaignsById, adsetsById }) &&
      !deferredIds.has(rec.id),
  );
  const watching = purchaseScopedRecs
    .filter(
      (rec) =>
        !actionNow.includes(rec) &&
        (isWithIssuesRec({ rec, campaignsById, adsetsById }) ||
          isInLearning(rec) ||
          isRecentlyChanged(rec) ||
          isInsufficientSignal(rec) ||
          isMidConfidence(rec) ||
          deferredIds.has(rec.id)),
    )
    .map((rec) => ({
      ...rec,
      watchSegment: watchSegmentForRec({ rec, deferredIds, campaignsById, adsetsById }),
    }));
  // Partition accounting (defense in depth): every purchase-scoped rec must
  // land in exactly one lane. Anything the predicates above still miss is
  // parked in Watching under the "other" segment instead of being dropped.
  const classifiedRecIds = new Set([...actionNow, ...watching].map((rec) => rec.id));
  const unclassifiedRecs = purchaseScopedRecs.filter((rec) => !classifiedRecIds.has(rec.id));
  if (unclassifiedRecs.length > 0) {
    console.warn("[meta-lane-classify] lane_partition_fallback", {
      businessId,
      recIds: unclassifiedRecs.map((rec) => rec.id),
    });
    watching.push(
      ...unclassifiedRecs.map((rec) => ({ ...rec, watchSegment: "other" as const })),
    );
  }
  const recommendedScopeIds = new Set(
    recommendations.flatMap((rec) => [rec.campaignId, rec.adsetId]).filter(Boolean) as string[],
  );
  const campaignNamesById = new Map(campaignRows.map((row) => [row.id, row.name]));
  const healthyBase = compactWorkspace
    ? []
    : [
        ...healthyCampaignRows({
          rows: campaignRows,
          recommendedScopeIds,
          statusFilter,
          campaignLabelsById,
        }),
        ...healthyAdsetRows({
          rows: adsetRows,
          recommendedScopeIds,
          campaignNamesById,
          campaignsById,
          statusFilter,
          campaignLabelsById,
        }),
      ].slice(0, 18);
  const healthy = compactWorkspace
    ? []
    : await attachPreviousBidDiffsToHealthyRows(businessId, healthyBase);
  const nonSales = [
    ...nonSalesRecs,
    ...nonSalesCampaignRows({
      rows: campaignRows,
      recommendedScopeIds,
      statusFilter,
      costPerThruplayP50: upperFunnelCostPerThruplayP50,
      cpmAccountP50: upperFunnelCpmP50,
      campaignLabelsById,
    }),
    ...nonSalesAdsetRows({
      rows: adsetRows,
      recommendedScopeIds,
      campaignNamesById,
      campaignsById,
      statusFilter,
      costPerThruplayP50: upperFunnelCostPerThruplayP50,
      cpmAccountP50: upperFunnelCpmP50,
      campaignLabelsById,
    }),
  ]
    .map((rec) =>
      attachEntityConfiguration({
        rec,
        campaignsById,
        adsetsById,
        rangeDays,
      }),
    )
    .slice(0, 30);
  const archiveBase = [
    ...archiveCampaignRows({ rows: campaignRows, statusFilter, window, campaignLabelsById }),
    ...archiveAdsetRows({
      rows: adsetRows,
      statusFilter,
      window,
      campaignNamesById,
      campaignsById,
      campaignLabelsById,
    }),
  ].sort((left, right) => right.spend - left.spend);

  // Server-owned action presentation + structured numeric metrics: every
  // recommendation leaves this route with decisionLabel / actionKind /
  // primaryActionLabel and metrics attached, so the UI renders semantics it
  // never computes and compare/bulk math never parses display strings.
  // Old persisted snapshots are covered because annotation happens at read
  // time.
  const metricsByEntityId = new Map<string, MetaRecEntityMetricsSource>();
  const rowPresentationByEntityId = new Map<string, MetaRecRowPresentationSource>();
  for (const row of campaignRows) {
    metricsByEntityId.set(row.id, {
      spend: row.spend ?? null,
      roas: row.roas ?? null,
      cpa: row.cpa ?? null,
      ctr: row.ctr ?? null,
      purchases: row.purchases ?? null,
      frequency: row.frequency ?? null,
    });
    rowPresentationByEntityId.set(row.id, {
      accountId: row.accountId ?? null,
      thumbLabel: null,
    });
  }
  for (const row of adsetRows) {
    metricsByEntityId.set(row.id, {
      spend: row.spend ?? null,
      roas: row.roas ?? null,
      cpa: row.cpa ?? null,
      ctr: row.ctr ?? null,
      purchases: row.purchases ?? null,
      frequency: row.frequency ?? null,
    });
    rowPresentationByEntityId.set(row.id, {
      accountId: row.accountId ?? null,
      thumbLabel: null,
    });
  }
  const annotatedActionNow = annotateMetaRecPresentation(actionNow, metricsByEntityId, rowPresentationByEntityId);
  const annotatedWatching = annotateMetaRecPresentation(watching, metricsByEntityId, rowPresentationByEntityId);
  const annotatedNonSales = annotateMetaRecPresentation(nonSales, metricsByEntityId, rowPresentationByEntityId);
  const annotatedInactiveRecommendations = annotateMetaRecPresentation(
    inactiveRecommendations,
    metricsByEntityId,
    rowPresentationByEntityId,
  );
  const inactiveRecommendationByEntityId = new Map(
    annotatedInactiveRecommendations.map((rec) => [
      rec.level === "adset" ? rec.adsetId : rec.campaignId,
      rec,
    ]),
  );
  const archive = archiveBase.map((row) => {
    const rec = inactiveRecommendationByEntityId.get(row.id);
    return {
      ...row,
      advisory: rec
        ? {
            decisionLabel: rec.decisionLabel ?? null,
            primaryActionLabel:
              rec.primaryActionLabel ?? rec.recommendedAction ?? "Review evidence",
            why: rec.why || rec.summary,
            confidence: rec.confidence,
          }
        : null,
    };
  });

  // Typed against the shared client contract so response drift fails typecheck.
  const payload = {
    businessId,
    statusFilter,
    startDate,
    endDate,
    sourceModel: snapshot?.sourceModel ?? "snapshot_persistent",
    // True served snapshot_date - NOT the requested endDate. On historical
    // ranges the newest in-range snapshot can be older than the range end;
    // echoing endDate here overstated freshness (and mis-scoped deferrals).
    snapshotDate: snapshot?.snapshotDate ?? null,
    snapshotCreatedAt: snapshot?.snapshotCreatedAt ?? null,
    actionNow: annotatedActionNow,
    watching: annotatedWatching,
    healthy,
    nonSales: annotatedNonSales,
    archive,
    structureInventory,
    deferredIds: [...deferredIds],
    watchingSegments: buildMetaWatchingSegments(annotatedWatching),
    counts: {
      actionNow: actionNow.length,
      watching: watching.length,
      healthy: healthy.length,
      nonSales: nonSales.length,
      archive: archive.length,
    },
  } satisfies MetaLanePayload;

  const payloadCompletedAt = performance.now();
  return NextResponse.json(payload, {
    headers: {
      "Cache-Control": "no-store",
      ...(compactWorkspace
        ? {
            "Server-Timing": [
              `access;dur=${(accessCompletedAt - requestStartedAt).toFixed(1)}`,
              `base_evidence;dur=${(baseEvidenceCompletedAt - accessCompletedAt).toFixed(1)}`,
              `snapshot;dur=${(baseStageDurations.snapshot ?? 0).toFixed(1)}`,
              `operator;dur=${(baseStageDurations.operator ?? 0).toFixed(1)}`,
              `campaigns;dur=${(baseStageDurations.campaigns ?? 0).toFixed(1)}`,
              `adsets;dur=${(baseStageDurations.adsets ?? 0).toFixed(1)}`,
              `upper_funnel;dur=${(baseStageDurations.upper_funnel ?? 0).toFixed(1)}`,
              `live_status;dur=${(liveStatusesCompletedAt - baseEvidenceCompletedAt).toFixed(1)}`,
              `campaign_roles;dur=${(campaignLabelsCompletedAt - liveStatusesCompletedAt).toFixed(1)}`,
              `presentation;dur=${(payloadCompletedAt - campaignLabelsCompletedAt).toFixed(1)}`,
              `total;dur=${(payloadCompletedAt - requestStartedAt).toFixed(1)}`,
            ].join(", "),
          }
        : {}),
    },
  });
}
