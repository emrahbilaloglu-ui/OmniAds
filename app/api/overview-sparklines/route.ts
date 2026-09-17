import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import {
  resolveGa4AnalyticsContext,
  runGA4Report,
} from "@/lib/google-analytics-reporting";
import { getOverviewTrendBundle } from "@/lib/overview-service";
import { runWithGoogleRequestAuditContext } from "@/lib/google-request-audit";

interface Ga4DailyTrendPoint {
  date: string;
  sessions: number;
  purchases: number;
  revenue: number;
  engagementRate: number;
  avgSessionDuration: number;
  totalPurchasers: number;
  firstTimePurchasers: number;
}

function normalizeGa4Date(value: string) {
  if (/^\d{8}$/.test(value)) {
    return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  }
  return value;
}

async function fetchGa4DailyTrends(params: {
  businessId: string;
  startDate: string;
  endDate: string;
}): Promise<Ga4DailyTrendPoint[]> {
  try {
    const report = await runWithGoogleRequestAuditContext(
      {
        provider: "ga4",
        businessId: params.businessId,
        requestSource: "live_report",
        requestPath: "/api/overview-sparklines",
        requestType: "ga4_daily_trends",
      },
      async () => {
        const context = await resolveGa4AnalyticsContext(params.businessId, {
          requireProperty: true,
        });
        if (!context.propertyId) return null;

        return runGA4Report({
          propertyId: context.propertyId,
          accessToken: context.accessToken,
          dateRanges: [{ startDate: params.startDate, endDate: params.endDate }],
          dimensions: [{ name: "date" }],
          metrics: [
            { name: "sessions" },
            { name: "ecommercePurchases" },
            { name: "purchaseRevenue" },
            { name: "engagementRate" },
            { name: "averageSessionDuration" },
            { name: "totalPurchasers" },
            { name: "firstTimePurchasers" },
          ],
          orderBys: [{ dimension: { dimensionName: "date" } }],
          limit: 400,
        });
      },
    );
    if (!report) return [];

    return report.rows.map((row) => ({
      date: normalizeGa4Date(row.dimensions[0] ?? ""),
      sessions: parseFloat(row.metrics[0] ?? "0") || 0,
      purchases: parseFloat(row.metrics[1] ?? "0") || 0,
      revenue: parseFloat(row.metrics[2] ?? "0") || 0,
      engagementRate: parseFloat(row.metrics[3] ?? "0") || 0,
      avgSessionDuration: parseFloat(row.metrics[4] ?? "0") || 0,
      totalPurchasers: parseFloat(row.metrics[5] ?? "0") || 0,
      firstTimePurchasers: parseFloat(row.metrics[6] ?? "0") || 0,
    }));
  } catch (error) {
    console.warn("[overview-sparklines] ga4_daily_trends_unavailable", {
      businessId: params.businessId,
      message: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const businessId = searchParams.get("businessId");
  const startDate = searchParams.get("startDate");
  const endDate = searchParams.get("endDate");

  if (!businessId || !startDate || !endDate) {
    return NextResponse.json(
      { error: "missing_params", message: "businessId, startDate and endDate are required." },
      { status: 400 }
    );
  }

  const access = await requireBusinessAccess({
    request,
    businessId,
    minRole: "guest",
  });
  if ("error" in access) return access.error;

  const analyticsAccess = await requireBusinessAccess({
    request,
    businessId,
    minRole: "collaborator",
  });
  const canReadAnalytics = !("error" in analyticsAccess);

  const [trendBundle, ga4Daily] = await Promise.all([
    getOverviewTrendBundle({ businessId, startDate, endDate }),
    canReadAnalytics
      ? fetchGa4DailyTrends({ businessId, startDate, endDate })
      : Promise.resolve([] as Ga4DailyTrendPoint[]),
  ]);

  return NextResponse.json({
    sparklines: {
      combined: trendBundle.combined,
      providerTrends: trendBundle.providerTrends,
      // Explicit per-provider trend sources; absent means unknown, which the
      // client treats as incompatible with every scalar source.
      providerTrendSources: {
        meta: trendBundle.providerTrendSources?.meta ?? null,
        google: trendBundle.providerTrendSources?.google ?? null,
      },
      shopifyDaily: trendBundle.shopifyDaily ?? [],
      shopifyCommerceAvailable: trendBundle.shopifyCommerceAvailable === true,
      shopifyConnectionState: trendBundle.shopifyConnectionState ?? "unknown",
      ga4Daily,
    },
  });
}
