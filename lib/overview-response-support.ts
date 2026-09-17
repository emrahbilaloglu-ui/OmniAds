import { round2 } from "@/lib/overview-service-support";
import type { OverviewResponse } from "@/lib/overview-service";

interface PlatformEfficiencyRow {
  platform: string;
  spend: number;
  revenue: number;
  roas: number;
  purchases: number;
  cpa: number;
  impressions?: number;
  clicks?: number;
}

interface Ga4EcommerceFallback {
  revenue: number;
  purchases: number;
  averageOrderValue: number | null;
}

interface ShopifyEcommerceAggregate {
  revenue: number;
  purchases: number;
  averageOrderValue: number | null;
}

type ShopifyKpiSourceKey =
  | "shopify_ledger"
  | "shopify_warehouse"
  | "shopify_live_fallback";

function resolveShopifySourceDescriptor(
  source: ShopifyKpiSourceKey | null | undefined
): { source: ShopifyKpiSourceKey; label: string } {
  switch (source) {
    case "shopify_ledger":
      return { source, label: "Shopify Ledger" };
    case "shopify_warehouse":
      return { source, label: "Shopify Warehouse" };
    case "shopify_live_fallback":
    default:
      return { source: "shopify_live_fallback", label: "Shopify Live Fallback" };
  }
}

export function buildEmptyOverview(
  businessId: string,
  startDate: string,
  endDate: string,
  status?: string
): OverviewResponse {
  const kpis = { spend: 0, revenue: 0, roas: 0, purchases: 0, cpa: 0, aov: 0 };
  return {
    businessId,
    dateRange: { startDate, endDate },
    ...(status ? { status } : {}),
    kpis,
    kpiSources: {
      spend: { source: "ad_platforms", label: "Ad platforms" },
      revenue: { source: "unavailable", label: "Unavailable" },
      roas: { source: "unavailable", label: "Unavailable" },
      purchases: { source: "unavailable", label: "Unavailable" },
      cpa: { source: "ad_platforms", label: "Ad platforms" },
      aov: { source: "unavailable", label: "Unavailable" },
    },
    totals: {
      impressions: 0,
      clicks: 0,
      purchases: 0,
      spend: 0,
      conversions: 0,
      revenue: 0,
      ctr: 0,
      cpm: 0,
      cpc: 0,
      cpa: 0,
      roas: 0,
    },
    platformEfficiency: [],
    trends: { "7d": [], "14d": [], "30d": [], custom: [] },
  };
}

export function applyEcommerceSourcePriority(
  overview: OverviewResponse,
  input: {
    shopify: (ShopifyEcommerceAggregate & { source: ShopifyKpiSourceKey }) | null;
    ga4Fallback: Ga4EcommerceFallback | null;
  }
) {
  if (input.shopify) {
    const revenue = round2(input.shopify.revenue);
    const purchases = Math.round(input.shopify.purchases);
    const aov =
      input.shopify.averageOrderValue !== null
        ? round2(input.shopify.averageOrderValue)
        : purchases > 0
          ? round2(input.shopify.revenue / input.shopify.purchases)
          : 0;
    const roas = overview.kpis.spend > 0 ? round2(input.shopify.revenue / overview.kpis.spend) : 0;

    overview.kpis.revenue = revenue;
    overview.kpis.purchases = purchases;
    overview.kpis.aov = aov;
    overview.kpis.roas = roas;

    // `totals` remains the paid-platform aggregate built before commerce
    // resolution. Replacing it with Shopify would erase Blended ROAS and make
    // it structurally identical to MER. Store truth lives in `kpis`.

    const shopifySource = resolveShopifySourceDescriptor(input.shopify.source);
    overview.kpiSources.revenue = shopifySource;
    overview.kpiSources.purchases = shopifySource;
    overview.kpiSources.aov = shopifySource;
    overview.kpiSources.roas = shopifySource;
    return;
  }

  const ga4Fallback = input.ga4Fallback;
  if (ga4Fallback) {
    const revenue = round2(ga4Fallback.revenue);
    const purchases = Math.round(ga4Fallback.purchases);
    const aov =
      ga4Fallback.averageOrderValue !== null
        ? round2(ga4Fallback.averageOrderValue)
        : purchases > 0
          ? round2(ga4Fallback.revenue / ga4Fallback.purchases)
          : 0;
    const roas = overview.kpis.spend > 0 ? round2(ga4Fallback.revenue / overview.kpis.spend) : 0;

    overview.kpis.revenue = revenue;
    overview.kpis.purchases = purchases;
    overview.kpis.aov = aov;
    overview.kpis.roas = roas;

    // Keep paid-platform totals intact. GA4 is an explicit commerce fallback
    // for `kpis`; it is not platform-attributed conversion value.

    overview.kpiSources.revenue = { source: "ga4_fallback", label: "GA4" };
    overview.kpiSources.purchases = { source: "ga4_fallback", label: "GA4" };
    overview.kpiSources.aov = { source: "ga4_fallback", label: "GA4" };
    overview.kpiSources.roas = { source: "ga4_fallback", label: "GA4" };
    return;
  }

  overview.kpiSources.revenue = { source: "unavailable", label: "Unavailable" };
  overview.kpiSources.purchases = { source: "unavailable", label: "Unavailable" };
  overview.kpiSources.aov = { source: "unavailable", label: "Unavailable" };
  overview.kpiSources.roas = { source: "unavailable", label: "Unavailable" };
}

export function buildOverviewResponse(params: {
  businessId: string;
  startDate: string;
  endDate: string;
  totalSpend: number;
  totalRevenue: number;
  totalPurchases: number;
  totalClicks: number;
  totalImpressions: number;
  roas: number;
  cpa: number;
  aov: number;
  platformEfficiency: PlatformEfficiencyRow[];
}): OverviewResponse {
  const {
    businessId,
    startDate,
    endDate,
    totalSpend,
    totalRevenue,
    totalPurchases,
    totalClicks,
    totalImpressions,
    roas,
    cpa,
    aov,
    platformEfficiency,
  } = params;

  return {
    businessId,
    dateRange: { startDate, endDate },
    ...(platformEfficiency.length === 0 ? { status: "no_data" } : {}),
    kpis: {
      spend: round2(totalSpend),
      revenue: round2(totalRevenue),
      roas: round2(roas),
      purchases: Math.round(totalPurchases),
      cpa: round2(cpa),
      aov: round2(aov),
    },
    kpiSources: {
      spend: { source: "ad_platforms", label: "Ad platforms" },
      revenue: { source: "unavailable", label: "Unavailable" },
      roas: { source: "unavailable", label: "Unavailable" },
      purchases: { source: "unavailable", label: "Unavailable" },
      cpa: { source: "ad_platforms", label: "Ad platforms" },
      aov: { source: "unavailable", label: "Unavailable" },
    },
    totals: {
      impressions: Math.round(totalImpressions),
      clicks: Math.round(totalClicks),
      purchases: Math.round(totalPurchases),
      spend: round2(totalSpend),
      conversions: Math.round(totalPurchases),
      revenue: round2(totalRevenue),
      ctr: totalImpressions > 0 ? round2((totalClicks / totalImpressions) * 100) : 0,
      cpm: totalImpressions > 0 ? round2((totalSpend / totalImpressions) * 1000) : 0,
      cpc: totalClicks > 0 ? round2(totalSpend / totalClicks) : 0,
      cpa: round2(cpa),
      roas: round2(roas),
    },
    platformEfficiency: platformEfficiency.map((row) => ({
      ...row,
      spend: round2(row.spend),
      revenue: round2(row.revenue),
      roas: round2(row.roas),
      // Two decimals, not an integer: Google conversions are fractional, and
      // rounding them per row distorted conversions, cost/conv. and conv. rate.
      purchases: round2(row.purchases),
      cpa: round2(row.cpa),
    })),
    providerTrends: {},
    trends: { "7d": [], "14d": [], "30d": [], custom: [] },
  };
}
