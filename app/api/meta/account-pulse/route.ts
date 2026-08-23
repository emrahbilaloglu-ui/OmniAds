import { NextRequest, NextResponse } from "next/server";
import { resolveCampaignContextMode } from "@/lib/creative-decision-engine/campaign-context/source";
import { requireBusinessAccess } from "@/lib/access";
import { getDb } from "@/lib/db";
import { getMetaCampaignsForRange } from "@/lib/meta/campaigns-source";
import {
  classifyMetaOperatingMode,
  classifyMetaSeasonalRegime,
} from "@/lib/meta/operating-mode";
import { getMetaCanonicalOverviewTrends } from "@/lib/meta/canonical-overview";
import { isInBriefing, parseBriefingStatusFilter } from "@/lib/meta/briefing-filter";
import { META_RECOMMENDATION_ENGINE_VERSION } from "@/lib/meta/recommendations";
import { getCachedValue } from "@/lib/server-cache";
import { readMetaCampaignLabels } from "@/lib/meta/campaign-labels";
import { resolveBusinessTargetPackFreshness } from "@/lib/business-commercial";
import type {
  MetaLabelCoverage,
  MetaSnapshotHealth,
  MetaTargetAnchor,
} from "@/components/meta/redesign/types";

export const dynamic = "force-dynamic";

type PulseWindow = "7d" | "14d" | "28d" | "90d" | "custom";
type RoasTargetSource =
  | "commercial_truth"
  | "commercial_truth_stale"
  | "account_median"
  | "none";

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
    SELECT target_roas, updated_at
    FROM business_target_packs
    WHERE business_id = ${businessId}
    LIMIT 1
  `) as Array<{
    target_roas: number | string | null;
    updated_at: string | Date | null;
  }>;
  return {
    target: positiveNumberOrNull(row?.target_roas),
    freshness: resolveBusinessTargetPackFreshness(row?.updated_at),
    updatedAt:
      row?.updated_at instanceof Date
        ? row.updated_at.toISOString()
        : row?.updated_at ?? null,
  };
}

async function readCommercialTruthTargetAnchor(businessId: string): Promise<MetaTargetAnchor> {
  const sql = getDb();
  const [row] = (await sql`
    SELECT
      target_roas,
      break_even_roas,
      target_cpa,
      break_even_cpa,
      updated_at
    FROM business_target_packs
    WHERE business_id = ${businessId}
    LIMIT 1
  `) as Array<{
    target_roas: number | string | null;
    break_even_roas: number | string | null;
    target_cpa: number | string | null;
    break_even_cpa: number | string | null;
    updated_at: string | Date | null;
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
    freshness: resolveBusinessTargetPackFreshness(row?.updated_at),
    updatedAt:
      row?.updated_at instanceof Date
        ? row.updated_at.toISOString()
        : row?.updated_at ?? null,
  };
}

async function readAccountMedianRoas(
  businessId: string,
  providerAccountId: string | null,
) {
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
        AND (${providerAccountId}::text IS NULL OR scope_id = ${providerAccountId})
      ORDER BY scope_id, snapshot_date DESC
    )
    SELECT p50
    FROM latest_account_rows
  `) as Array<{ p50: number | string | null }>;
  return median(rows.map((row) => Number(row.p50)));
}

async function resolveBusinessTargetRoas(
  businessId: string,
  providerAccountId: string | null,
): Promise<{
  target: number | null;
  median: number | null;
  target_source: RoasTargetSource;
  targetFreshness: "fresh" | "stale" | "unknown";
  targetUpdatedAt: string | null;
}> {
  const [commercialTarget, accountMedian] = await Promise.all([
    readCommercialTruthTargetRoas(businessId).catch(() => ({
      target: null,
      freshness: "unknown" as const,
      updatedAt: null,
    })),
    readAccountMedianRoas(businessId, providerAccountId).catch(() => null),
  ]);

  if (commercialTarget.target != null) {
    return {
      target: commercialTarget.target,
      median: accountMedian,
      target_source:
        commercialTarget.freshness === "fresh"
          ? "commercial_truth"
          : "commercial_truth_stale",
      targetFreshness: commercialTarget.freshness,
      targetUpdatedAt: commercialTarget.updatedAt,
    };
  }
  if (accountMedian != null) {
    return {
      target: null,
      median: accountMedian,
      target_source: "account_median",
      targetFreshness: commercialTarget.freshness,
      targetUpdatedAt: commercialTarget.updatedAt,
    };
  }
  return {
    target: null,
    median: null,
    target_source: "none",
    targetFreshness: commercialTarget.freshness,
    targetUpdatedAt: commercialTarget.updatedAt,
  };
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

async function readTrackingHealth(
  businessId: string,
  providerAccountId: string | null,
) {
  const sql = getDb();
  const [row] = (await sql`
    SELECT
      COUNT(*)::int AS row_count,
      MAX(tracking_anomaly_score)::double precision AS tracking_anomaly_score
    FROM engine_v3_creative_lifecycle_daily
    WHERE business_id = ${businessId}
      AND (${providerAccountId}::text IS NULL OR provider_account_id = ${providerAccountId})
      AND as_of_date >= CURRENT_DATE - INTERVAL '6 days'
  `) as Array<{ row_count: number | string | null; tracking_anomaly_score: number | string | null }>;
  const rowCount = toNumber(row?.row_count);
  if (rowCount <= 0) {
    return { status: "unknown" as const, detail: "Recent creative lifecycle tracking data is unavailable." };
  }
  const score = toNumber(row?.tracking_anomaly_score);
  if (score >= 0.7) {
    return { status: "blocked" as const, detail: "Tracking anomaly score is elevated." };
  }
  if (score >= 0.35) {
    return { status: "degraded" as const, detail: "Tracking signal is watchlisted." };
  }
  return { status: "healthy" as const, detail: "Tracking signal is stable." };
}

async function readRoasHistory(input: {
  businessId: string;
  startDate: string;
  endDate: string;
  providerAccountId: string | null;
}) {
  const trends = await getMetaCanonicalOverviewTrends(input);
  return trends.points
    .map((point) => point.roas)
    .filter((value) => Number.isFinite(value));
}

type PulseDailyRollup = {
  date: string;
  spend: number;
  revenue: number;
  purchases: number;
};

type PulseCampaignRow = {
  id: string;
  status: string | null;
  bidStrategyType: string | null;
  bidStrategyLabel: string | null;
  currency: string | null;
  spend: number;
  revenue: number;
  purchases: number;
};

async function readDecisionWorkspaceWarehousePulse(input: {
  businessId: string;
  providerAccountId: string;
  selectedStart: string;
  selectedEnd: string;
  earliestStart: string;
}) {
  const sql = getDb();
  const [dailyRows, campaignRows, syncRows] = await Promise.all([
    sql.query<{
      date: string;
      spend: number | string | null;
      revenue: number | string | null;
      purchases: number | string | null;
    }>(
      `
        SELECT
          date::text AS date,
          SUM(spend)::double precision AS spend,
          SUM(revenue)::double precision AS revenue,
          SUM(conversions)::double precision AS purchases
        FROM meta_campaign_daily
        WHERE business_id = $1
          AND provider_account_id = $2
          AND date BETWEEN $3::date AND $4::date
        GROUP BY date
        ORDER BY date ASC
      `,
      [input.businessId, input.providerAccountId, input.earliestStart, input.selectedEnd],
    ),
    sql.query<{
      id: string;
      status: string | null;
      bid_strategy_type: string | null;
      account_currency: string | null;
      spend: number | string | null;
      revenue: number | string | null;
      purchases: number | string | null;
    }>(
      `
        WITH selected AS (
          SELECT *
          FROM meta_campaign_daily
          WHERE business_id = $1
            AND provider_account_id = $2
            AND date BETWEEN $3::date AND $4::date
        ), latest AS (
          SELECT DISTINCT ON (campaign_id)
            campaign_id,
            campaign_status,
            bid_strategy_type,
            account_currency
          FROM selected
          ORDER BY campaign_id, date DESC
        )
        SELECT
          selected.campaign_id AS id,
          latest.campaign_status AS status,
          latest.bid_strategy_type,
          latest.account_currency,
          SUM(selected.spend)::double precision AS spend,
          SUM(selected.revenue)::double precision AS revenue,
          SUM(selected.conversions)::double precision AS purchases
        FROM selected
        JOIN latest USING (campaign_id)
        GROUP BY selected.campaign_id, latest.campaign_status, latest.bid_strategy_type, latest.account_currency
        ORDER BY SUM(selected.spend) DESC
      `,
      [input.businessId, input.providerAccountId, input.selectedStart, input.selectedEnd],
    ),
    sql.query<{ last_sync_at: string | null }>(
      `
        SELECT updated_at::text AS last_sync_at
        FROM meta_campaign_daily
        WHERE business_id = $1
          AND provider_account_id = $2
        ORDER BY date DESC, updated_at DESC
        LIMIT 1
      `,
      [input.businessId, input.providerAccountId],
    ),
  ]);
  return {
    daily: dailyRows.map<PulseDailyRollup>((row) => ({
      date: row.date,
      spend: toNumber(row.spend),
      revenue: toNumber(row.revenue),
      purchases: toNumber(row.purchases),
    })),
    campaigns: campaignRows.map<PulseCampaignRow>((row) => ({
      id: row.id,
      status: row.status,
      bidStrategyType: row.bid_strategy_type,
      bidStrategyLabel: null,
      currency: row.account_currency,
      spend: toNumber(row.spend),
      revenue: toNumber(row.revenue),
      purchases: toNumber(row.purchases),
    })),
    lastSyncAt: syncRows[0]?.last_sync_at ?? null,
  };
}

async function readDecisionWorkspacePulseStatus(input: {
  businessId: string;
  providerAccountId: string;
}) {
  const rows = await getDb().query<{
    account_currency: string | null;
    last_sync_at: string | null;
  }>(
    `
      SELECT account_currency, updated_at::text AS last_sync_at
      FROM meta_campaign_daily
      WHERE business_id = $1
        AND provider_account_id = $2
      ORDER BY date DESC, updated_at DESC
      LIMIT 1
    `,
    [input.businessId, input.providerAccountId],
  );
  return rows[0] ?? null;
}

function pulseRollupTotals(rows: PulseDailyRollup[], startDate: string, endDate: string) {
  return totals(rows.filter((row) => row.date >= startDate && row.date <= endDate));
}

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const businessId = searchParams.get("businessId")?.trim() ?? "";
  const providerAccountId =
    searchParams.get("providerAccountId")?.trim() || null;
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

  const monthStart = `${endDate.slice(0, 8)}01`;
  const decisionWorkspaceFastPath =
    searchParams.get("decision_workspace") === "1" &&
    statusFilter === "all" &&
    Boolean(providerAccountId);
  const compactOsWorkspace =
    decisionWorkspaceFastPath &&
    searchParams.get("workspace_surface") === "os";
  if (compactOsWorkspace) {
    const loadStatus = async () => {
      const [engineMetadata, trackingHealth, latest] = await Promise.all([
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
        readTrackingHealth(businessId, providerAccountId).catch(() => ({
          status: "unknown" as const,
          detail: "Tracking health is unavailable.",
        })),
        readDecisionWorkspacePulseStatus({
          businessId,
          providerAccountId: providerAccountId!,
        }).catch(() => null),
      ]);
      return { engineMetadata, trackingHealth, latest };
    };
    const { engineMetadata, trackingHealth, latest } =
      process.env.VITEST === "true" || process.env.NODE_ENV === "test"
        ? await loadStatus()
        : (
            await getCachedValue({
              key: `meta-pulse-os-status-v1:${businessId}:${providerAccountId}`,
              ttlMs: 30_000,
              staleWhileRevalidateMs: 120_000,
              loader: loadStatus,
            })
          ).value;
    return NextResponse.json(
      {
        businessId,
        window,
        statusFilter,
        startDate,
        endDate,
        engineLastRun: engineMetadata.engineLastRun,
        engineVersion: engineMetadata.engineVersion,
        snapshotHealth: engineMetadata.snapshotHealth,
        trackingHealth,
        trackingAnomalyActive:
          trackingHealth.status === "blocked" ||
          trackingHealth.status === "degraded",
        lastSyncAt: latest?.last_sync_at ?? null,
        currency: latest?.account_currency ?? null,
        dataReadiness: {
          status: "ok",
          isPartial: latest === null,
          notReadyReason: latest
            ? null
            : "Campaign warehouse data is unavailable for this Meta account.",
          evidenceSource: latest ? "warehouse" : "unknown",
        },
      },
      { headers: { "Cache-Control": "private, max-age=0" } },
    );
  }
  const earliestRollupStart = [
    previousStart,
    monthStart,
    addDaysToISO(endDate, -27),
  ].sort()[0]!;
  const loadFastWarehouse = () =>
    readDecisionWorkspaceWarehousePulse({
      businessId,
      providerAccountId: providerAccountId!,
      selectedStart: startDate,
      selectedEnd: endDate,
      earliestStart: earliestRollupStart,
    });
  const fastWarehousePromise = decisionWorkspaceFastPath
    ? process.env.VITEST === "true" || process.env.NODE_ENV === "test"
      ? loadFastWarehouse()
      : getCachedValue({
          key: `meta-pulse-fast-v2:${businessId}:${providerAccountId}:${startDate}:${endDate}:${earliestRollupStart}`,
          ttlMs: 60_000,
          staleWhileRevalidateMs: 180_000,
          loader: loadFastWarehouse,
        }).then((result) => result.value)
    : Promise.resolve(null);
  const [current, previous, today, d7, d14, d28, engineMetadata, trackingHealth, roasBenchmark, targetAnchor, roasHistory, monthToDate, warehouseLastSyncAt] =
    await Promise.all([
      decisionWorkspaceFastPath
        ? fastWarehousePromise.then((warehouse) => ({
            status: "ok" as const,
            rows: warehouse?.campaigns ?? [],
            isPartial: (warehouse?.campaigns.length ?? 0) === 0,
            notReadyReason: warehouse?.campaigns.length ? null : "Campaign warehouse data is unavailable for the decision snapshot range.",
            evidenceSource: "warehouse" as const,
          }))
        : getMetaCampaignsForRange({
            businessId,
            accountId: providerAccountId,
            startDate,
            endDate,
          }),
      decisionWorkspaceFastPath ? Promise.resolve({ rows: [] }) : getMetaCampaignsForRange({
        businessId,
        accountId: providerAccountId,
        startDate: previousStart,
        endDate: previousEnd,
      }),
      decisionWorkspaceFastPath ? Promise.resolve({ rows: [] }) : getMetaCampaignsForRange({
        businessId,
        accountId: providerAccountId,
        startDate: endDate,
        endDate,
      }),
      decisionWorkspaceFastPath ? Promise.resolve({ rows: [] }) : getMetaCampaignsForRange({
        businessId,
        accountId: providerAccountId,
        startDate: addDaysToISO(endDate, -6),
        endDate,
      }),
      decisionWorkspaceFastPath ? Promise.resolve({ rows: [] }) : getMetaCampaignsForRange({
        businessId,
        accountId: providerAccountId,
        startDate: addDaysToISO(endDate, -13),
        endDate,
      }),
      decisionWorkspaceFastPath ? Promise.resolve({ rows: [] }) : getMetaCampaignsForRange({
        businessId,
        accountId: providerAccountId,
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
      readTrackingHealth(businessId, providerAccountId).catch(() => ({
        status: "unknown" as const,
        detail: "Tracking health is unavailable.",
      })),
      resolveBusinessTargetRoas(businessId, providerAccountId),
      readCommercialTruthTargetAnchor(businessId).catch(() => ({
        configured: false,
        source: "none" as const,
        targetRoas: null,
        breakEvenRoas: null,
        targetCpa: null,
        breakEvenCpa: null,
        freshness: "unknown" as const,
        updatedAt: null,
      })),
      decisionWorkspaceFastPath
        ? fastWarehousePromise.then((warehouse) =>
            (warehouse?.daily ?? [])
              .filter((row) => row.date >= startDate && row.date <= endDate)
              .map((row) => (row.spend > 0 ? row.revenue / row.spend : 0)),
          )
        : readRoasHistory({
            businessId,
            providerAccountId,
            startDate,
            endDate,
          }).catch(() => []),
      decisionWorkspaceFastPath ? Promise.resolve({ rows: [] }) : getMetaCampaignsForRange({
        businessId,
        accountId: providerAccountId,
        startDate: monthStart,
        endDate,
      }),
      // Real ingest freshness: the newest warehouse write for this business.
      // Never fabricate "now" - unknown is unknown.
      decisionWorkspaceFastPath
        ? fastWarehousePromise.then((warehouse) => warehouse?.lastSyncAt ?? null)
        : Promise.resolve()
        .then(() =>
          getDb().query<{ last_sync_at: string | null }>(
            `SELECT MAX(updated_at)::text AS last_sync_at
             FROM meta_campaign_daily
             WHERE (business_ref_id::text = $1 OR business_id = $1)
               AND ($2::text IS NULL OR provider_account_id = $2)`,
            [businessId, providerAccountId],
          ),
        )
        .then((rows) => rows[0]?.last_sync_at ?? null)
        .catch(() => null),
    ]);

  const currentRows = (current.rows ?? []).filter((row) => isInBriefing(row, statusFilter));
  const previousRows = (previous.rows ?? []).filter((row) => isInBriefing(row, statusFilter));
  const todayRows = (today.rows ?? []).filter((row) => isInBriefing(row, statusFilter));
  const d7Rows = (d7.rows ?? []).filter((row) => isInBriefing(row, statusFilter));
  const d14Rows = (d14.rows ?? []).filter((row) => isInBriefing(row, statusFilter));
  const d28Rows = (d28.rows ?? []).filter((row) => isInBriefing(row, statusFilter));
  const labelCoverage = compactOsWorkspace
    ? null
    : await readCampaignLabelCoverage({
        businessId,
        rows: currentRows as Array<{
          id: string;
          status?: unknown;
          effective_status?: unknown;
          effectiveStatus?: unknown;
        }>,
      }).catch(() => ({
        activeCampaigns: 0,
        labeledCampaigns: 0,
        unlabeledCampaigns: 0,
        latestUpdatedAt: null,
      }));

  const fastWarehouse = await fastWarehousePromise;
  const currentTotals = fastWarehouse
    ? pulseRollupTotals(fastWarehouse.daily, startDate, endDate)
    : totals(currentRows);
  const previousTotals = fastWarehouse
    ? pulseRollupTotals(fastWarehouse.daily, previousStart, previousEnd)
    : totals(previousRows);
  const currentDayOfMonth = Math.max(1, new Date(`${endDate}T00:00:00.000Z`).getUTCDate());
  // True month-to-date (month start .. endDate), not the selected window
  // relabeled: the previous implementation extrapolated the selected-window
  // spend and called it MTD, which was wrong for every non-28d window.
  const mtdTotals = fastWarehouse
    ? pulseRollupTotals(fastWarehouse.daily, monthStart, endDate)
    : totals((monthToDate.rows ?? []).filter((row) => isInBriefing(row, statusFilter)));
  const mtdTarget = Math.max(mtdTotals.spend, (mtdTotals.spend / currentDayOfMonth) * 30);
  const matureCampaigns = currentRows.filter(
    (row) => toNumber(row.spend) >= 250 || toNumber(row.purchases) >= 5,
  ).length;
  const learningCampaigns = Math.max(0, currentRows.length - matureCampaigns);
  const d7Totals = fastWarehouse ? pulseRollupTotals(fastWarehouse.daily, addDaysToISO(endDate, -6), endDate) : totals(d7Rows);
  const d14Totals = fastWarehouse ? pulseRollupTotals(fastWarehouse.daily, addDaysToISO(endDate, -13), endDate) : totals(d14Rows);
  const d28Totals = fastWarehouse ? pulseRollupTotals(fastWarehouse.daily, addDaysToISO(endDate, -27), endDate) : totals(d28Rows);
  const todayTotals = fastWarehouse ? pulseRollupTotals(fastWarehouse.daily, endDate, endDate) : totals(todayRows);

  /*
   * D8: a sum over no rows is not a measurement.
   *
   * `totals()` reduces an empty row set to `spend: 0, purchases: 0`, and the
   * Decision Center's "Spend · today" tile printed that as `₺0 — 0 conversions
   * · 7d avg 0` on an account with no warehouse data at all — on the same
   * screen that said "Campaign warehouse data is still being prepared for the
   * requested range". Zero is a claim about the world; "we have not observed
   * this day yet" is not the same claim, and an operator reading ₺0 concludes
   * delivery has stopped.
   *
   * Counted rather than inferred from the sum, because a genuine zero-spend day
   * that WAS observed must still read as ₺0. The client already renders null as
   * an em-dash — `formatMoney(null)` and the `finite(...) === null` branch in
   * the KPI detail — so only the server was substituting.
   */
  const observedDays = (from: string, to: string): number =>
    fastWarehouse
      ? fastWarehouse.daily.filter((row) => row.date >= from && row.date <= to).length
      : -1;
  const todayObservedRows = fastWarehouse ? observedDays(endDate, endDate) : todayRows.length;
  const d7ObservedRows = fastWarehouse
    ? observedDays(addDaysToISO(endDate, -6), endDate)
    : d7Rows.length;
  const spendToday = todayObservedRows > 0 ? todayTotals.spend : null;
  const conversionsToday = todayObservedRows > 0 ? todayTotals.purchases : null;
  const avg7dSpend = d7ObservedRows > 0 ? d7Totals.spend / 7 : null;
  const avg7dConversions = d7ObservedRows > 0 ? d7Totals.purchases / 7 : null;
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
      providerAccountId,
      window,
      statusFilter,
      startDate,
      endDate,
      pacing: {
        mtdSpend: mtdTotals.spend,
        mtdTarget,
        dayPace: mtdTarget > 0 ? mtdTotals.spend / mtdTarget : 0,
        windowSpend: currentTotals.spend,
        spendToday,
        dailyTarget: mtdTarget / 30,
        avg7dSpend,
        conversionsToday,
        avg7dConversions,
      },
      roas: {
        selected: currentTotals.roas,
        d7: d7Totals.roas,
        d14: d14Totals.roas,
        d28: d28Totals.roas,
        target: roasBenchmark.target,
        median: roasBenchmark.median,
        target_source: roasBenchmark.target_source,
        targetFreshness: roasBenchmark.targetFreshness,
        targetUpdatedAt: roasBenchmark.targetUpdatedAt,
      },
      roasHistory,
      spend: { current: currentTotals.spend, prev: previousTotals.spend },
      revenue: { current: currentTotals.revenue, prev: previousTotals.revenue },
      cpa: { current: currentTotals.cpa, prev: previousTotals.cpa },
      matureCampaigns,
      learningCampaigns,
      operatingMode,
      seasonalRegime,
      engineLastRun: engineMetadata.engineLastRun,
      engineVersion: engineMetadata.engineVersion,
      campaignContextMode: resolveCampaignContextMode(),
      snapshotHealth: engineMetadata.snapshotHealth,
      labelCoverage,
      targetAnchor,
      trackingHealth,
      lastSyncAt: warehouseLastSyncAt,
      currency: currentRows.find((row) => row.currency)?.currency ?? null,
      dataReadiness: {
        status: current.status ?? "ok",
        isPartial: current.isPartial ?? false,
        notReadyReason: current.notReadyReason ?? null,
        evidenceSource: current.evidenceSource,
      },
      trackingAnomalyActive:
        trackingHealth.status === "blocked" || trackingHealth.status === "degraded",
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
