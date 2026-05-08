import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import { getDb } from "@/lib/db";
import { getMetaAdSetsForRange } from "@/lib/meta/adsets-source";
import { getMetaCampaignsForRange } from "@/lib/meta/campaigns-source";
import { readMetaDecisionSnapshotForRange } from "@/lib/meta/snapshot";
import type { MetaRecommendation } from "@/lib/meta/recommendations";

export const dynamic = "force-dynamic";

type PulseWindow = "7d" | "14d" | "28d" | "90d" | "custom";

interface HealthyMetaRow {
  id: string;
  level: "campaign" | "adset";
  name: string;
  campaignId?: string | null;
  campaignName?: string | null;
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

async function readDeferredRecIds(businessId: string) {
  const sql = getDb();
  const rows = (await sql`
    WITH ranked AS (
      SELECT
        rec_id,
        action,
        ROW_NUMBER() OVER (PARTITION BY rec_id ORDER BY timestamp DESC) AS row_number
      FROM meta_decision_responses
      WHERE business_id = ${businessId}
        AND action IN ('deferred', 'undeferred')
    )
    SELECT rec_id
    FROM ranked
    WHERE row_number = 1
      AND action = 'deferred'
  `) as Array<{ rec_id: string }>;
  return new Set(rows.map((row) => row.rec_id));
}

function healthyCampaignRows(input: {
  rows: Awaited<ReturnType<typeof getMetaCampaignsForRange>>["rows"];
  recommendedScopeIds: Set<string>;
}): HealthyMetaRow[] {
  return input.rows
    .filter((row) => !input.recommendedScopeIds.has(row.id))
    .filter((row) => String(row.status ?? "").toUpperCase() === "ACTIVE")
    .filter((row) => toNumber(row.spend) >= 100 || toNumber(row.purchases) >= 3)
    .slice(0, 12)
    .map((row) => ({
      id: row.id,
      level: "campaign" as const,
      name: row.name,
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
}): HealthyMetaRow[] {
  return input.rows
    .filter((row) => !input.recommendedScopeIds.has(row.id))
    .filter((row) => String(row.status ?? "").toUpperCase() === "ACTIVE")
    .filter((row) => toNumber(row.spend) >= 75 || toNumber(row.purchases) >= 3)
    .slice(0, 12)
    .map((row) => ({
      id: row.id,
      level: "adset" as const,
      name: row.name,
      campaignId: row.campaignId,
      campaignName: row.campaignId ? (input.campaignNamesById?.get(row.campaignId) ?? null) : null,
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

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const businessId = searchParams.get("businessId")?.trim() ?? "";
  const window = parseWindow(searchParams.get("window"));
  const endDate = searchParams.get("endDate")?.trim() || todayISO();
  const startDate =
    searchParams.get("startDate")?.trim() ||
    addDaysToISO(endDate, -(windowDays(window) - 1));

  const access = await requireBusinessAccess({
    request,
    businessId,
    minRole: "guest",
  });
  if ("error" in access) return access.error;
  if (!businessId) {
    return NextResponse.json(
      { error: "missing_business_id", message: "businessId is required." },
      { status: 400 },
    );
  }

  const [snapshot, deferredIds, campaigns, adsets] = await Promise.all([
    readMetaDecisionSnapshotForRange({ businessId, startDate, endDate }),
    readDeferredRecIds(businessId).catch(() => new Set<string>()),
    getMetaCampaignsForRange({
      businessId,
      startDate,
      endDate,
      includePrev: true,
      includePrevBudget: false,
    }),
    getMetaAdSetsForRange({
      businessId,
      startDate,
      endDate,
      includePrev: true,
      includePrevBudget: false,
    }),
  ]);

  const recommendations = snapshot?.recommendations ?? [];
  const actionNow = recommendations.filter(
    (rec) =>
      (rec.confidenceScore ?? 0) >= 0.7 &&
      !isInLearning(rec) &&
      !deferredIds.has(rec.id),
  );
  const watching = recommendations.filter(
    (rec) =>
      !actionNow.includes(rec) &&
      (isInLearning(rec) || isRecentlyChanged(rec) || isInsufficientSignal(rec) || deferredIds.has(rec.id)),
  );
  const recommendedScopeIds = new Set(
    recommendations.flatMap((rec) => [rec.campaignId, rec.adsetId]).filter(Boolean) as string[],
  );
  const campaignNamesById = new Map((campaigns.rows ?? []).map((row) => [row.id, row.name]));
  const healthy = [
    ...healthyCampaignRows({ rows: campaigns.rows ?? [], recommendedScopeIds }),
    ...healthyAdsetRows({ rows: adsets.rows ?? [], recommendedScopeIds, campaignNamesById }),
  ].slice(0, 18);

  return NextResponse.json(
    {
      businessId,
      startDate,
      endDate,
      sourceModel: snapshot?.sourceModel ?? "snapshot_persistent",
      snapshotDate: snapshot?.endDate ?? null,
      actionNow,
      watching,
      healthy,
      deferredIds: [...deferredIds],
      counts: {
        actionNow: actionNow.length,
        watching: watching.length,
        healthy: healthy.length,
      },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
