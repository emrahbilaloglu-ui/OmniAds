import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import { getDb } from "@/lib/db";
import { getMetaCampaignsForRange } from "@/lib/meta/campaigns-source";
import {
  classifyMetaOperatingMode,
  classifyMetaSeasonalRegime,
} from "@/lib/meta/operating-mode";
import { isInBriefing, parseBriefingStatusFilter } from "@/lib/meta/briefing-filter";
import { META_RECOMMENDATION_ENGINE_VERSION } from "@/lib/meta/recommendations";
import { readMetaCampaignLabels } from "@/lib/meta/campaign-labels";
import type {
  MetaLabelCoverage,
  MetaSnapshotHealth,
  MetaTargetAnchor,
} from "@/components/meta/redesign/types";

export const dynamic = "force-dynamic";

type PulseWindow = "7d" | "14d" | "28d" | "90d" | "custom";
type RoasTargetSource = "commercial_truth" | "account_median" | "none";

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

function addDaysToISO(value: string, days: number) {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function toNumber(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function totals(rows: Array<{ spend?: number | null; revenue?: number | null; purchases?: number | null }>) {
  const spend = rows.reduce((sum, row) => sum + toNumber(row.spend), 0);
  const revenue = rows.reduce((sum, row) => sum + toNumber(row.revenue), 0);
  const purchases = rows.reduce((sum, row) => sum + toNumber(row.purchases), 0);
  return {
    spend,
    revenue,
    purchases,
    roas: spend > 0 ? revenue / spend : 0,
    cpa: purchases > 0 ? spend / purchases : null,
  };
}

function positiveNumberOrNull(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function median(values: number[]) {
  const sorted = values
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  return sorted[Math.floor(sorted.length / 2)] ?? null;
}

async function readCommercialTruthTargetRoas(businessId: string) {
  const sql = getDb();
  const [row] = (await sql`
    SELECT target_roas
    FROM business_target_packs
    WHERE business_id = ${businessId}
    LIMIT 1
  `) as Array<{ target_roas: number | string | null }>;
  return positiveNumberOrNull(row?.target_roas);
}

async function readCommercialTruthTargetAnchor(businessId: string): Promise<MetaTargetAnchor> {
  const sql = getDb();
  const [row] = (await sql`
    SELECT
      target_roas,
      break_even_roas,
      target_cpa,
      break_even_cpa
    FROM business_target_packs
    WHERE business_id = ${businessId}
    LIMIT 1
  `) as Array<{
    target_roas: number | string | null;
    break_even_roas: number | string | null;
    target_cpa: number | string | null;
    break_even_cpa: number | string | null;
  }>;
  const targetRoas = positiveNumberOrNull(row?.target_roas);
  const breakEvenRoas = positiveNumberOrNull(row?.break_even_roas);
  const targetCpa = positiveNumberOrNull(row?.target_cpa);
  const breakEvenCpa = positiveNumberOrNull(row?.break_even_cpa);
  const configured = Boolean(targetRoas || breakEvenRoas || targetCpa || breakEvenCpa);
  return {
    configured,
    source: configured ? "configured_targets" : "none",
    targetRoas,
    breakEvenRoas,
    targetCpa,
    breakEvenCpa,
  };
}

async function readAccountMedianRoas(businessId: string) {
  const sql = getDb();
  const rows = (await sql`
    WITH latest_account_rows AS (
      SELECT DISTINCT ON (scope_id)
        scope_id,
        p50
      FROM meta_decision_calibration_daily
      WHERE business_id = ${businessId}
        AND scope_type = 'account'
        AND metric_name = 'roas_28d'
      ORDER BY scope_id, snapshot_date DESC
    )
    SELECT p50
    FROM latest_account_rows
  `) as Array<{ p50: number | string | null }>;
  return median(rows.map((row) => Number(row.p50)));
}

async function resolveBusinessTargetRoas(businessId: string): Promise<{
  target: number | null;
  median: number | null;
  target_source: RoasTargetSource;
}> {
  const [target, accountMedian] = await Promise.all([
    readCommercialTruthTargetRoas(businessId).catch(() => null),
    readAccountMedianRoas(businessId).catch(() => null),
  ]);

  if (target != null) {
    return { target, median: accountMedian, target_source: "commercial_truth" };
  }
  if (accountMedian != null) {
    return { target: null, median: accountMedian, target_source: "account_median" };
  }
  return { target: null, median: null, target_source: "none" };
}

async function readEngineMetadata(businessId: string) {
  const sql = getDb();
  const [latest] = (await sql`
    SELECT
      snapshot_date::text AS latest_snapshot_date,
      created_at::text AS engine_last_run,
      engine_version
    FROM meta_decision_snapshots_daily
    WHERE business_id = ${businessId}
      AND kind = 'recommendation'
    ORDER BY created_at DESC
    LIMIT 1
  `) as Array<{ engine_last_run: string | null; engine_version: string | null }>;
  const engineLastRun = latest?.engine_last_run ?? null;
  const engineVersion = latest?.engine_version ?? META_RECOMMENDATION_ENGINE_VERSION;
  return {
    latestSnapshotDate: (latest as { latest_snapshot_date?: string | null } | undefined)?.latest_snapshot_date ?? null,
    engineLastRun,
    snapshotHealth: buildSnapshotHealth({
      latestSnapshotDate: (latest as { latest_snapshot_date?: string | null } | undefined)?.latest_snapshot_date ?? null,
      lastRunAt: engineLastRun,
      engineVersion,
    }),
    engineVersion,
  };
}

function buildSnapshotHealth(input: {
  latestSnapshotDate: string | null;
  lastRunAt: string | null;
  engineVersion: string | null;
}): MetaSnapshotHealth {
  const parsed = input.lastRunAt ? Date.parse(input.lastRunAt) : NaN;
  const ageHours = Number.isFinite(parsed) ? Math.max(0, (Date.now() - parsed) / 3_600_000) : null;
  const isCurrentEngineVersion = input.engineVersion === META_RECOMMENDATION_ENGINE_VERSION;
  let status: MetaSnapshotHealth["status"] = "fresh";
  let staleReason: string | null = null;
  if (!input.lastRunAt) {
    status = "missing";
    staleReason = "No persisted recommendation snapshot exists for this business.";
  } else if (!isCurrentEngineVersion) {
    status = "engine_version_mismatch";
    staleReason = "Latest snapshot was produced by an older recommendation engine version.";
  } else if (ageHours == null || ageHours > 26) {
    status = "stale";
    staleReason = "Latest recommendation snapshot is older than the 26 hour SLA.";
  }
  return {
    latestSnapshotDate: input.latestSnapshotDate,
    lastRunAt: input.lastRunAt,
    engineVersion: input.engineVersion,
    currentEngineVersion: META_RECOMMENDATION_ENGINE_VERSION,
    isCurrentEngineVersion,
    ageHours,
    status,
    staleReason,
  };
}

function latestTimestamp(values: Array<string | null | undefined>) {
  const latest = values
    .map((value) => (value ? Date.parse(value) : NaN))
    .filter(Number.isFinite)
    .sort((left, right) => right - left)[0];
  return latest == null ? null : new Date(latest).toISOString();
}

function isActiveCampaign(row: { status?: unknown; effective_status?: unknown; effectiveStatus?: unknown }) {
  const status = String(row.status ?? row.effective_status ?? row.effectiveStatus ?? "").toUpperCase();
  return status === "ACTIVE";
}

async function readCampaignLabelCoverage(input: {
  businessId: string;
  rows: Array<{ id: string; status?: unknown; effective_status?: unknown; effectiveStatus?: unknown }>;
}): Promise<MetaLabelCoverage> {
  const activeIds = Array.from(
    new Set(
      input.rows
        .filter(isActiveCampaign)
        .map((row) => row.id)
        .filter(Boolean),
    ),
  );
  if (activeIds.length === 0) {
    return {
      activeCampaigns: 0,
      labeledCampaigns: 0,
      unlabeledCampaigns: 0,
      latestUpdatedAt: null,
    };
  }
  const labels = await readMetaCampaignLabels({
    businessId: input.businessId,
    campaignIds: activeIds,
  });
  const activeSet = new Set(activeIds);
  const labeledIds = new Set(labels.filter((label) => activeSet.has(label.campaignId)).map((label) => label.campaignId));
  return {
    activeCampaigns: activeIds.length,
    labeledCampaigns: labeledIds.size,
    unlabeledCampaigns: Math.max(0, activeIds.length - labeledIds.size),
    latestUpdatedAt: latestTimestamp(labels.map((label) => label.updatedAt)),
  };
}

async function readTrackingHealth(businessId: string) {
  const sql = getDb();
  const [row] = (await sql`
    SELECT MAX(tracking_anomaly_score)::double precision AS tracking_anomaly_score
    FROM creative_lifecycle_daily
    WHERE business_id = ${businessId}
      AND day >= CURRENT_DATE - INTERVAL '6 days'
  `) as Array<{ tracking_anomaly_score: number | string | null }>;
  const score = toNumber(row?.tracking_anomaly_score);
  if (score >= 0.7) {
    return { status: "blocked" as const, detail: "Tracking anomaly score is elevated." };
  }
  if (score >= 0.35) {
    return { status: "degraded" as const, detail: "Tracking signal is watchlisted." };
  }
  return { status: "healthy" as const, detail: "Tracking signal is stable." };
}

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const businessId = searchParams.get("businessId")?.trim() ?? "";
  const window = parseWindow(searchParams.get("window"));
  const statusFilter = parseBriefingStatusFilter(searchParams.get("status_filter"));
  const endDate = searchParams.get("endDate")?.trim() || todayISO();
  const startDate =
    searchParams.get("startDate")?.trim() ||
    addDaysToISO(endDate, -(windowDays(window) - 1));
  const previousEnd = addDaysToISO(startDate, -1);
  const previousStart = addDaysToISO(previousEnd, -(windowDays(window) - 1));

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

  const [current, previous, d7, d14, d28, engineMetadata, trackingHealth, roasBenchmark, targetAnchor] =
    await Promise.all([
      getMetaCampaignsForRange({ businessId, startDate, endDate }),
      getMetaCampaignsForRange({
        businessId,
        startDate: previousStart,
        endDate: previousEnd,
      }),
      getMetaCampaignsForRange({
        businessId,
        startDate: addDaysToISO(endDate, -6),
        endDate,
      }),
      getMetaCampaignsForRange({
        businessId,
        startDate: addDaysToISO(endDate, -13),
        endDate,
      }),
      getMetaCampaignsForRange({
        businessId,
        startDate: addDaysToISO(endDate, -27),
        endDate,
      }),
      readEngineMetadata(businessId).catch(() => ({
        engineLastRun: null,
        engineVersion: META_RECOMMENDATION_ENGINE_VERSION,
        latestSnapshotDate: null,
        snapshotHealth: buildSnapshotHealth({
          latestSnapshotDate: null,
          lastRunAt: null,
          engineVersion: META_RECOMMENDATION_ENGINE_VERSION,
        }),
      })),
      readTrackingHealth(businessId).catch(() => ({
        status: "unknown" as const,
        detail: "Tracking health is unavailable.",
      })),
      resolveBusinessTargetRoas(businessId),
      readCommercialTruthTargetAnchor(businessId).catch(() => ({
        configured: false,
        source: "none" as const,
        targetRoas: null,
        breakEvenRoas: null,
        targetCpa: null,
        breakEvenCpa: null,
      })),
    ]);

  const currentRows = (current.rows ?? []).filter((row) => isInBriefing(row, statusFilter));
  const previousRows = (previous.rows ?? []).filter((row) => isInBriefing(row, statusFilter));
  const d7Rows = (d7.rows ?? []).filter((row) => isInBriefing(row, statusFilter));
  const d14Rows = (d14.rows ?? []).filter((row) => isInBriefing(row, statusFilter));
  const d28Rows = (d28.rows ?? []).filter((row) => isInBriefing(row, statusFilter));
  const labelCoverage = await readCampaignLabelCoverage({
    businessId,
    rows: currentRows as Array<{ id: string; status?: unknown; effective_status?: unknown; effectiveStatus?: unknown }>,
  }).catch(() => ({
    activeCampaigns: 0,
    labeledCampaigns: 0,
    unlabeledCampaigns: 0,
    latestUpdatedAt: null,
  }));

  const currentTotals = totals(currentRows);
  const previousTotals = totals(previousRows);
  const currentDayOfMonth = Math.max(1, new Date(`${endDate}T00:00:00.000Z`).getUTCDate());
  const mtdTarget = Math.max(currentTotals.spend, (currentTotals.spend / currentDayOfMonth) * 30);
  const matureCampaigns = currentRows.filter(
    (row) => toNumber(row.spend) >= 250 || toNumber(row.purchases) >= 5,
  ).length;
  const learningCampaigns = Math.max(0, currentRows.length - matureCampaigns);
  const d7Totals = totals(d7Rows);
  const d14Totals = totals(d14Rows);
  const d28Totals = totals(d28Rows);
  const targetForMode = roasBenchmark.target ?? roasBenchmark.median ?? currentTotals.roas ?? 1;
  const constrainedBidShare =
    currentRows.length > 0
      ? currentRows.filter((row) => {
        const strategy = String(row.bidStrategyType ?? row.bidStrategyLabel ?? "").toLowerCase();
        return strategy.includes("cost_cap") || strategy.includes("bid_cap") || strategy.includes("roas");
      }).length / currentRows.length
      : 0;
  const operatingMode = classifyMetaOperatingMode({
    current: currentTotals,
    previous: previousTotals,
    targetRoas: targetForMode,
    constrainedBidShare,
  });
  const seasonalRegime = classifyMetaSeasonalRegime({
    d7Roas: d7Totals.roas,
    d14Roas: d14Totals.roas,
    d28Roas: d28Totals.roas,
    currentSpend: currentTotals.spend,
    previousSpend: previousTotals.spend,
  });

  return NextResponse.json(
    {
      businessId,
      window,
      statusFilter,
      startDate,
      endDate,
      pacing: {
        mtdSpend: currentTotals.spend,
        mtdTarget,
        dayPace: mtdTarget > 0 ? currentTotals.spend / mtdTarget : 0,
      },
      roas: {
        d7: d7Totals.roas,
        d14: d14Totals.roas,
        d28: d28Totals.roas,
        target: roasBenchmark.target,
        median: roasBenchmark.median,
        target_source: roasBenchmark.target_source,
      },
      spend: { current: currentTotals.spend, prev: previousTotals.spend },
      revenue: { current: currentTotals.revenue, prev: previousTotals.revenue },
      cpa: { current: currentTotals.cpa, prev: previousTotals.cpa },
      matureCampaigns,
      learningCampaigns,
      operatingMode,
      seasonalRegime,
      engineLastRun: engineMetadata.engineLastRun,
      engineVersion: engineMetadata.engineVersion,
      snapshotHealth: engineMetadata.snapshotHealth,
      labelCoverage,
      targetAnchor,
      trackingHealth,
      lastSyncAt: new Date().toISOString(),
      trackingAnomalyActive:
        trackingHealth.status === "blocked" || trackingHealth.status === "degraded",
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
