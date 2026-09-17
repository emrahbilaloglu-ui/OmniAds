import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import { isDemoBusiness } from "@/lib/business-mode.server";
import {
  getDemoOverviewMetricTrendData,
  getOverviewMetricTrendCommerceScope,
  getOverviewMetricTrendProviderScope,
  getOverviewMetricTrendValue,
  type OverviewMetricTrendConnectionScope,
} from "@/lib/overview-metric-trend";
import {
  getIntegrationsByBusiness,
  type IntegrationProviderType,
} from "@/lib/integrations";
import { getOverviewData, type OverviewResponse } from "@/lib/overview-service";

type OverviewPayload = OverviewResponse;

interface GoogleOverviewPayload {
  kpis?: {
    spend?: number;
    revenue?: number;
    conversions?: number;
    roas?: number;
    cpa?: number;
    clicks?: number;
    impressions?: number;
    ctr?: number;
  };
}

interface AnalyticsOverviewPayload {
  kpis?: {
    sessions?: number;
    purchaseCvr?: number;
  };
}

function parseDate(value: string) {
  return new Date(`${value}T00:00:00.000Z`);
}

function toIsoDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function enumerateDays(startDate: string, endDate: string) {
  const start = parseDate(startDate);
  const end = parseDate(endDate);
  const dates: string[] = [];
  const cursor = new Date(start);
  while (cursor <= end) {
    dates.push(toIsoDate(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

async function fetchInternal<T>(
  request: NextRequest,
  pathname: string,
  params: Record<string, string>
): Promise<T | null> {
  try {
    const url = new URL(pathname, request.nextUrl.origin);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    const response = await fetch(url.toString(), {
      headers: {
        Accept: "application/json",
        cookie: request.headers.get("cookie") ?? "",
      },
      cache: "no-store",
    });
    if (!response.ok) return null;
    return (await response.json().catch(() => null)) as T | null;
  } catch {
    return null;
  }
}

async function readOverviewWithoutTrends(
  businessId: string,
  startDate: string,
  endDate: string,
): Promise<OverviewPayload | null> {
  try {
    return await getOverviewData({
      businessId,
      startDate,
      endDate,
      includeTrends: false,
    });
  } catch {
    return null;
  }
}

function metricNeedsAnalytics(metric: string) {
  return metric === "conversion_rate";
}

function metricNeedsGoogle(metric: string) {
  return metric === "clicks" || metric === "impressions" || metric === "ctr";
}

function metricNeedsPaidProviderScope(metric: string) {
  return (
    metric === "spend" ||
    metric === "mer" ||
    metric === "blended_roas" ||
    metric === "cpa" ||
    metric === "cost_per_purchase"
  );
}

function metricNeedsCommerceRevenue(metric: string) {
  return metric === "revenue" || metric === "mer" || metric === "aov";
}

function metricNeedsCommercePurchases(metric: string) {
  return (
    metric === "orders" ||
    metric === "purchases" ||
    metric === "aov" ||
    metric === "cpa" ||
    metric === "cost_per_purchase"
  );
}

async function readConnectionScope(
  businessId: string,
): Promise<OverviewMetricTrendConnectionScope> {
  try {
    const integrations = await getIntegrationsByBusiness(businessId);
    const state = (
      provider: Extract<IntegrationProviderType, "meta" | "google" | "shopify" | "ga4">,
    ) => {
      const matching = integrations.filter((integration) => integration.provider === provider);
      if (matching.length === 0) return "disconnected" as const;
      if (matching.every((integration) => integration.status === "disconnected")) {
        return "disconnected" as const;
      }
      if (matching.every((integration) => integration.status === "connected")) {
        return "connected" as const;
      }
      return "unknown" as const;
    };
    return {
      meta: state("meta"),
      google: state("google"),
      shopify: state("shopify"),
      ga4: state("ga4"),
    };
  } catch {
    return {
      meta: "unknown",
      google: "unknown",
      shopify: "unknown",
      ga4: "unknown",
    };
  }
}

export async function GET(request: NextRequest) {
  const businessId = request.nextUrl.searchParams.get("businessId");
  const metric = request.nextUrl.searchParams.get("metric");
  const startDate = request.nextUrl.searchParams.get("startDate");
  const endDate = request.nextUrl.searchParams.get("endDate");

  if (!businessId || !metric || !startDate || !endDate) {
    return NextResponse.json(
      { error: "missing_params", message: "businessId, metric, startDate, and endDate are required." },
      { status: 400 }
    );
  }

  const access = await requireBusinessAccess({
    request,
    businessId,
    minRole: "guest",
  });
  if ("error" in access) return access.error;

  const dates = enumerateDays(startDate, endDate);
  if (await isDemoBusiness(businessId)) {
    return NextResponse.json({
      metric,
      data: getDemoOverviewMetricTrendData(metric, dates),
    });
  }
  const includeAnalytics = metricNeedsAnalytics(metric);
  const includeGoogle = metricNeedsGoogle(metric) || metric.startsWith("google-");
  const needsProviderScope = metricNeedsPaidProviderScope(metric);
  const needsCommerceRevenue = metricNeedsCommerceRevenue(metric);
  const needsCommercePurchases = metricNeedsCommercePurchases(metric);
  const needsFullWindowScope =
    needsProviderScope || needsCommerceRevenue || needsCommercePurchases;
  const [fullWindowOverview, connectionScope] = needsFullWindowScope
    ? await Promise.all([
        readOverviewWithoutTrends(businessId, startDate, endDate),
        readConnectionScope(businessId),
      ])
    : [null, null];
  const providerScope = needsProviderScope
    ? getOverviewMetricTrendProviderScope(fullWindowOverview, {
        connections: connectionScope ?? undefined,
        requestedRange: { startDate, endDate },
      })
    : undefined;
  const commerceScope = needsCommerceRevenue || needsCommercePurchases
    ? getOverviewMetricTrendCommerceScope(fullWindowOverview, connectionScope ?? undefined)
    : undefined;

  // These values cannot be reconstructed safely unless the full-window read
  // freezes both provider membership and commerce authority before daily work.
  if (
    (needsProviderScope && !providerScope) ||
    (needsCommerceRevenue && !commerceScope?.revenue) ||
    (needsCommercePurchases && !commerceScope?.purchases)
  ) {
    return NextResponse.json({ metric, data: [] });
  }

  const data = (
    await Promise.all(
    dates.map(async (date) => {
      const [overview, google, analytics] = await Promise.all([
        readOverviewWithoutTrends(businessId, date, date),
        includeGoogle
          ? fetchInternal<GoogleOverviewPayload>(request, "/api/google-ads/overview", {
              businessId,
              dateRange: "custom",
              customStart: date,
              customEnd: date,
              compareMode: "none",
            })
          : Promise.resolve(null),
        includeAnalytics
          ? fetchInternal<AnalyticsOverviewPayload>(request, "/api/analytics/overview", {
              businessId,
              startDate: date,
              endDate: date,
            })
          : Promise.resolve(null),
      ]);

      const value = getOverviewMetricTrendValue(metric, {
        overview,
        google,
        analytics,
        providerScope,
        commerceScope,
      });
      return typeof value === "number" && Number.isFinite(value) ? { date, value } : null;
    })
    )
  ).filter((point): point is { date: string; value: number } => point !== null);

  return NextResponse.json({
    metric,
    data,
  });
}
