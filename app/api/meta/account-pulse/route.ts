import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import { getDb } from "@/lib/db";
import { getMetaCampaignsForRange } from "@/lib/meta/campaigns-source";
import { META_RECOMMENDATION_ENGINE_VERSION } from "@/lib/meta/recommendations";

export const dynamic = "force-dynamic";

type PulseWindow = "7d" | "14d" | "28d" | "90d" | "custom";

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

function targetRoas(rows: Array<{ roas?: number | null }>) {
  const values = rows
    .map((row) => toNumber(row.roas))
    .filter((value) => value > 0)
    .sort((left, right) => left - right);
  if (values.length === 0) return 2;
  return values[Math.floor(values.length / 2)] ?? 2;
}

async function readEngineMetadata(businessId: string) {
  const sql = getDb();
  const [latest] = (await sql`
    SELECT
      MAX(created_at)::text AS engine_last_run,
      (ARRAY_AGG(engine_version ORDER BY created_at DESC))[1] AS engine_version
    FROM meta_decision_snapshots_daily
    WHERE business_id = ${businessId}
      AND kind = 'recommendation'
  `) as Array<{ engine_last_run: string | null; engine_version: string | null }>;
  return {
    engineLastRun: latest?.engine_last_run ?? null,
    engineVersion: latest?.engine_version ?? META_RECOMMENDATION_ENGINE_VERSION,
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

  const [current, previous, d7, d14, d28, engineMetadata, trackingHealth] =
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
      })),
      readTrackingHealth(businessId).catch(() => ({
        status: "unknown" as const,
        detail: "Tracking health is unavailable.",
      })),
    ]);

  const currentTotals = totals(current.rows ?? []);
  const previousTotals = totals(previous.rows ?? []);
  const currentDayOfMonth = Math.max(1, new Date(`${endDate}T00:00:00.000Z`).getUTCDate());
  const mtdTarget = Math.max(currentTotals.spend, (currentTotals.spend / currentDayOfMonth) * 30);
  const matureCampaigns = (current.rows ?? []).filter(
    (row) => toNumber(row.spend) >= 250 || toNumber(row.purchases) >= 5,
  ).length;
  const learningCampaigns = Math.max(0, (current.rows ?? []).length - matureCampaigns);

  return NextResponse.json(
    {
      businessId,
      window,
      startDate,
      endDate,
      pacing: {
        mtdSpend: currentTotals.spend,
        mtdTarget,
        dayPace: mtdTarget > 0 ? currentTotals.spend / mtdTarget : 0,
      },
      roas: {
        d7: totals(d7.rows ?? []).roas,
        d14: totals(d14.rows ?? []).roas,
        d28: totals(d28.rows ?? []).roas,
        target: targetRoas(current.rows ?? []),
      },
      spend: { current: currentTotals.spend, prev: previousTotals.spend },
      revenue: { current: currentTotals.revenue, prev: previousTotals.revenue },
      cpa: { current: currentTotals.cpa, prev: previousTotals.cpa },
      matureCampaigns,
      learningCampaigns,
      operatingMode: currentTotals.roas >= targetRoas(current.rows ?? []) ? "Exploit" : "Stabilize",
      seasonalRegime: "normalized",
      engineLastRun: engineMetadata.engineLastRun,
      engineVersion: engineMetadata.engineVersion,
      trackingHealth,
      lastSyncAt: new Date().toISOString(),
      trackingAnomalyActive:
        trackingHealth.status === "blocked" || trackingHealth.status === "degraded",
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
