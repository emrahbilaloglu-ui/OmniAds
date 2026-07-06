import {
  DEMO_BUSINESS_ID,
  DEMO_PRODUCTS,
  DEMO_DEMOGRAPHICS,
  getDemoBillingState,
  getDemoBusinessSummary,
  getDemoGa4Properties,
  getDemoIntegrations,
  getDemoIntegration,
  getDemoProviderDiscoveryPayload,
  getDemoProviderAccounts,
  getDemoSelectedGa4PropertyId,
} from "@/lib/demo-business-support";
import type { MetaAdSetData } from "@/lib/api/meta";

export {
  DEMO_BUSINESS_ID,
  DEMO_PRODUCTS,
  getDemoBillingState,
  getDemoBusinessSummary,
  getDemoGa4Properties,
  getDemoIntegrations,
  getDemoIntegration,
  getDemoProviderDiscoveryPayload,
  getDemoProviderAccounts,
  getDemoSelectedGa4PropertyId,
};

export function isDemoBusinessId(businessId: string | null | undefined): boolean {
  return businessId === DEMO_BUSINESS_ID;
}


export function getDemoOverview() {
  return {
    businessId: DEMO_BUSINESS_ID,
    dateRange: { startDate: "2026-02-10", endDate: "2026-03-11" },
    kpis: { spend: 38240, revenue: 124860, roas: 3.27, purchases: 1420, cpa: 26.93, aov: 87.93 },
    kpiSources: {
      spend: { source: "ad_platforms", label: "Ad platforms" },
      revenue: { source: "shopify_ledger", label: "Shopify Ledger" },
      roas: { source: "shopify_ledger", label: "Shopify Ledger" },
      purchases: { source: "shopify_ledger", label: "Shopify Ledger" },
      cpa: { source: "ad_platforms", label: "Ad platforms" },
      aov: { source: "shopify_ledger", label: "Shopify Ledger" },
    },
    totals: {
      impressions: 2361800,
      clicks: 81220,
      purchases: 1420,
      spend: 38240,
      conversions: 1710,
      revenue: 124860,
      ctr: 3.44,
      cpm: 16.19,
      cpc: 0.47,
      cpa: 26.93,
      roas: 3.27,
    },
    platformEfficiency: [
      { platform: "Meta", spend: 21420, revenue: 72890, roas: 3.4, purchases: 816, cpa: 26.25 },
      { platform: "Google", spend: 14540, revenue: 46580, roas: 3.2, purchases: 521, cpa: 27.91 },
      { platform: "Organic", spend: 0, revenue: 5390, roas: 0, purchases: 83, cpa: 0 },
    ],
    trends: {
      "7d": [
        { label: "Mar 05", spend: 1450, revenue: 4630, purchases: 53 },
        { label: "Mar 06", spend: 1490, revenue: 4720, purchases: 54 },
        { label: "Mar 07", spend: 1500, revenue: 4760, purchases: 54 },
        { label: "Mar 08", spend: 1510, revenue: 4790, purchases: 55 },
        { label: "Mar 09", spend: 1530, revenue: 4840, purchases: 55 },
        { label: "Mar 10", spend: 1540, revenue: 4860, purchases: 56 },
        { label: "Mar 11", spend: 1560, revenue: 4890, purchases: 56 },
      ],
      "14d": [
        { label: "Feb 26", spend: 1340, revenue: 4310, purchases: 49 },
        { label: "Feb 27", spend: 1360, revenue: 4380, purchases: 50 },
        { label: "Feb 28", spend: 1380, revenue: 4420, purchases: 50 },
        { label: "Mar 01", spend: 1410, revenue: 4510, purchases: 51 },
        { label: "Mar 02", spend: 1420, revenue: 4540, purchases: 52 },
        { label: "Mar 03", spend: 1440, revenue: 4600, purchases: 52 },
        { label: "Mar 04", spend: 1460, revenue: 4650, purchases: 53 },
        { label: "Mar 05", spend: 1450, revenue: 4630, purchases: 53 },
        { label: "Mar 06", spend: 1490, revenue: 4720, purchases: 54 },
        { label: "Mar 07", spend: 1500, revenue: 4760, purchases: 54 },
        { label: "Mar 08", spend: 1510, revenue: 4790, purchases: 55 },
        { label: "Mar 09", spend: 1530, revenue: 4840, purchases: 55 },
        { label: "Mar 10", spend: 1540, revenue: 4860, purchases: 56 },
        { label: "Mar 11", spend: 1560, revenue: 4890, purchases: 56 },
      ],
      "30d": [
        { label: "Feb 10", spend: 980, revenue: 3140, purchases: 36 },
        { label: "Feb 15", spend: 1230, revenue: 3780, purchases: 44 },
        { label: "Feb 20", spend: 1270, revenue: 4010, purchases: 45 },
        { label: "Feb 25", spend: 1320, revenue: 4250, purchases: 48 },
        { label: "Mar 01", spend: 1410, revenue: 4510, purchases: 51 },
        { label: "Mar 06", spend: 1490, revenue: 4720, purchases: 54 },
        { label: "Mar 11", spend: 1560, revenue: 4890, purchases: 56 },
      ],
      custom: [
        { label: "Feb 10", spend: 980, revenue: 3140, purchases: 36 },
        { label: "Feb 11", spend: 1050, revenue: 3320, purchases: 38 },
        { label: "Feb 12", spend: 1090, revenue: 3480, purchases: 40 },
        { label: "Feb 13", spend: 1140, revenue: 3620, purchases: 42 },
        { label: "Feb 14", spend: 1200, revenue: 3850, purchases: 44 },
        { label: "Feb 15", spend: 1230, revenue: 3780, purchases: 44 },
        { label: "Feb 16", spend: 1180, revenue: 3700, purchases: 43 },
        { label: "Feb 17", spend: 1220, revenue: 3910, purchases: 45 },
        { label: "Feb 18", spend: 1260, revenue: 3980, purchases: 46 },
        { label: "Feb 19", spend: 1240, revenue: 3950, purchases: 45 },
        { label: "Feb 20", spend: 1270, revenue: 4010, purchases: 45 },
        { label: "Feb 21", spend: 1290, revenue: 4070, purchases: 46 },
        { label: "Feb 22", spend: 1310, revenue: 4150, purchases: 47 },
        { label: "Feb 23", spend: 1300, revenue: 4100, purchases: 47 },
        { label: "Feb 24", spend: 1280, revenue: 4080, purchases: 46 },
        { label: "Feb 25", spend: 1320, revenue: 4250, purchases: 48 },
        { label: "Feb 26", spend: 1340, revenue: 4310, purchases: 49 },
        { label: "Feb 27", spend: 1360, revenue: 4380, purchases: 50 },
        { label: "Feb 28", spend: 1380, revenue: 4420, purchases: 50 },
        { label: "Mar 01", spend: 1410, revenue: 4510, purchases: 51 },
        { label: "Mar 02", spend: 1420, revenue: 4540, purchases: 52 },
        { label: "Mar 03", spend: 1440, revenue: 4600, purchases: 52 },
        { label: "Mar 04", spend: 1460, revenue: 4650, purchases: 53 },
        { label: "Mar 05", spend: 1450, revenue: 4630, purchases: 53 },
        { label: "Mar 06", spend: 1490, revenue: 4720, purchases: 54 },
        { label: "Mar 07", spend: 1500, revenue: 4760, purchases: 54 },
        { label: "Mar 08", spend: 1510, revenue: 4790, purchases: 55 },
        { label: "Mar 09", spend: 1530, revenue: 4840, purchases: 55 },
        { label: "Mar 10", spend: 1540, revenue: 4860, purchases: 56 },
        { label: "Mar 11", spend: 1560, revenue: 4890, purchases: 56 },
      ],
    },
  };
}

export function getDemoSparklines() {
  const days: Array<{ date: string; spend: number; revenue: number; purchases: number }> = [
    { date: "2026-02-10", spend: 980, revenue: 3140, purchases: 36 },
    { date: "2026-02-11", spend: 1050, revenue: 3320, purchases: 38 },
    { date: "2026-02-12", spend: 1090, revenue: 3480, purchases: 40 },
    { date: "2026-02-13", spend: 1140, revenue: 3620, purchases: 42 },
    { date: "2026-02-14", spend: 1200, revenue: 3850, purchases: 44 },
    { date: "2026-02-15", spend: 1230, revenue: 3780, purchases: 44 },
    { date: "2026-02-16", spend: 1180, revenue: 3700, purchases: 43 },
    { date: "2026-02-17", spend: 1220, revenue: 3910, purchases: 45 },
    { date: "2026-02-18", spend: 1260, revenue: 3980, purchases: 46 },
    { date: "2026-02-19", spend: 1240, revenue: 3950, purchases: 45 },
    { date: "2026-02-20", spend: 1270, revenue: 4010, purchases: 45 },
    { date: "2026-02-21", spend: 1290, revenue: 4070, purchases: 46 },
    { date: "2026-02-22", spend: 1310, revenue: 4150, purchases: 47 },
    { date: "2026-02-23", spend: 1300, revenue: 4100, purchases: 47 },
    { date: "2026-02-24", spend: 1280, revenue: 4080, purchases: 46 },
    { date: "2026-02-25", spend: 1320, revenue: 4250, purchases: 48 },
    { date: "2026-02-26", spend: 1340, revenue: 4310, purchases: 49 },
    { date: "2026-02-27", spend: 1360, revenue: 4380, purchases: 50 },
    { date: "2026-02-28", spend: 1380, revenue: 4420, purchases: 50 },
    { date: "2026-03-01", spend: 1410, revenue: 4510, purchases: 51 },
    { date: "2026-03-02", spend: 1420, revenue: 4540, purchases: 52 },
    { date: "2026-03-03", spend: 1440, revenue: 4600, purchases: 52 },
    { date: "2026-03-04", spend: 1460, revenue: 4650, purchases: 53 },
    { date: "2026-03-05", spend: 1450, revenue: 4630, purchases: 53 },
    { date: "2026-03-06", spend: 1490, revenue: 4720, purchases: 54 },
    { date: "2026-03-07", spend: 1500, revenue: 4760, purchases: 54 },
    { date: "2026-03-08", spend: 1510, revenue: 4790, purchases: 55 },
    { date: "2026-03-09", spend: 1530, revenue: 4840, purchases: 55 },
    { date: "2026-03-10", spend: 1540, revenue: 4860, purchases: 56 },
    { date: "2026-03-11", spend: 1560, revenue: 4890, purchases: 56 },
  ];
  const metaDays = days.map((d) => ({ ...d, spend: Math.round(d.spend * 0.56), revenue: Math.round(d.revenue * 0.58) }));
  const googleDays = days.map((d) => ({ ...d, spend: Math.round(d.spend * 0.38), revenue: Math.round(d.revenue * 0.37) }));
  const ga4Daily = days.map((d) => ({
    date: d.date,
    sessions: Math.round(d.purchases * 28.5),
    purchases: d.purchases,
    revenue: d.revenue,
    engagementRate: 0.56,
    avgSessionDuration: 112,
    totalPurchasers: Math.round(d.purchases * 0.92),
    firstTimePurchasers: Math.round(d.purchases * 0.51),
  }));
  return {
    combined: days,
    providerTrends: { meta: metaDays, google: googleDays },
    ga4Daily,
  };
}

export function getDemoAnalyticsOverview() {
  return {
    propertyName: "UrbanTrail Store GA4",
    kpis: {
      sessions: 48210,
      engagedSessions: 27110,
      engagementRate: 0.562,
      purchases: 1184,
      purchaseCvr: 0.0246,
      revenue: 96420,
      avgSessionDuration: 112.4,
    },
    newVsReturning: {
      new: { sessions: 29840, purchases: 592, purchaseCvr: 0.0198 },
      returning: { sessions: 18370, purchases: 592, purchaseCvr: 0.0322 },
    },
    insights: [
      { type: "positive", text: "Returning users convert 1.6x above new users." },
      { type: "opportunity", text: "Top 3 landing pages drive 58% of sessions but only 42% of purchases." },
    ],
  };
}

export function getDemoAnalyticsProducts() {
  const rows = DEMO_PRODUCTS.map((p, i) => {
    const views = 4800 - i * 260;
    const addToCart = Math.round(views * (0.11 + ((i % 4) * 0.02)));
    const checkouts = Math.round(addToCart * (0.62 - ((i % 3) * 0.05)));
    const purchases = Math.round(checkouts * (0.54 - ((i % 5) * 0.04)));
    const revenue = Number((p.price * purchases).toFixed(2));
    return {
      product: p.title,
      views,
      addToCart,
      checkouts,
      purchases,
      revenue,
      addToCartRate: views > 0 ? addToCart / views : 0,
      checkoutRate: addToCart > 0 ? checkouts / addToCart : 0,
      purchaseRate: checkouts > 0 ? purchases / checkouts : 0,
    };
  });
  return { rows, products: rows, meta: { empty: false, has_ecommerce_data: true, reason: null } };
}

export function getDemoAnalyticsLandingPages() {
  return {
    pages: [
      { path: "/products/explorer-backpack", sessions: 8200, engagedSessions: 5220, engagementRate: 0.637, avgEngagementTime: 78, purchases: 302, purchaseCvr: 0.0368, bounceRate: 0.24 },
      { path: "/products/travel-duffel", sessions: 6120, engagedSessions: 3370, engagementRate: 0.551, avgEngagementTime: 63, purchases: 166, purchaseCvr: 0.0271, bounceRate: 0.31 },
      { path: "/products/daypack-lite", sessions: 4750, engagedSessions: 2450, engagementRate: 0.516, avgEngagementTime: 51, purchases: 91, purchaseCvr: 0.0191, bounceRate: 0.37 },
      { path: "/collections/backpacks", sessions: 7210, engagedSessions: 3940, engagementRate: 0.546, avgEngagementTime: 57, purchases: 129, purchaseCvr: 0.0179, bounceRate: 0.34 },
      { path: "/collections/travel-bags", sessions: 5040, engagedSessions: 2680, engagementRate: 0.532, avgEngagementTime: 54, purchases: 101, purchaseCvr: 0.02, bounceRate: 0.36 },
      { path: "/blog/how-to-pack-for-hiking", sessions: 3920, engagedSessions: 2480, engagementRate: 0.633, avgEngagementTime: 111, purchases: 34, purchaseCvr: 0.0087, bounceRate: 0.21 },
      { path: "/blog/best-travel-backpacks", sessions: 4510, engagedSessions: 2920, engagementRate: 0.647, avgEngagementTime: 124, purchases: 57, purchaseCvr: 0.0126, bounceRate: 0.18 },
      { path: "/blog/carry-on-bag-checklist", sessions: 2870, engagedSessions: 1680, engagementRate: 0.585, avgEngagementTime: 96, purchases: 19, purchaseCvr: 0.0066, bounceRate: 0.25 },
    ],
  };
}

export function getDemoAnalyticsAudience() {
  return {
    segments: {
      new: { sessions: 29840, engagedSessions: 15610, engagementRate: 0.523, purchases: 592, revenue: 45280, purchaseCvr: 0.0198 },
      returning: { sessions: 18370, engagedSessions: 11500, engagementRate: 0.626, purchases: 592, revenue: 51140, purchaseCvr: 0.0322 },
    },
    channels: [
      { sourceMedium: "google / cpc", sessions: 12980, engagedSessions: 7240, engagementRate: 0.558, purchases: 332, revenue: 28620, purchaseCvr: 0.0256 },
      { sourceMedium: "facebook / paid_social", sessions: 17110, engagedSessions: 9540, engagementRate: 0.557, purchases: 402, revenue: 32120, purchaseCvr: 0.0235 },
      { sourceMedium: "google / organic", sessions: 8430, engagedSessions: 5390, engagementRate: 0.639, purchases: 216, revenue: 17900, purchaseCvr: 0.0256 },
      { sourceMedium: "(direct) / (none)", sessions: 6420, engagedSessions: 3780, engagementRate: 0.589, purchases: 154, revenue: 13910, purchaseCvr: 0.024 },
    ],
  };
}

export function getDemoAnalyticsDemographics(dimension: string) {
  const rows = DEMO_DEMOGRAPHICS[dimension] ?? DEMO_DEMOGRAPHICS.country;
  const sorted = [...rows].sort((a, b) => b.purchaseCvr - a.purchaseCvr);
  const avgPurchaseCvr = rows.reduce((sum, row) => sum + row.purchaseCvr, 0) / rows.length;
  return {
    dimension,
    rows,
    summary: {
      topValue: sorted[0].value,
      topValuePurchaseCvr: sorted[0].purchaseCvr,
      avgPurchaseCvr,
    },
  };
}

export function getDemoAnalyticsCohorts() {
  return {
    cohortWeeks: [
      { week: "2026-W05", newSessions: 3820, returningSessions: 910, newPurchases: 79, returningPurchases: 34, retentionRate: 0.192 },
      { week: "2026-W06", newSessions: 4010, returningSessions: 1012, newPurchases: 82, returningPurchases: 36, retentionRate: 0.201 },
      { week: "2026-W07", newSessions: 4190, returningSessions: 1125, newPurchases: 88, returningPurchases: 39, retentionRate: 0.212 },
      { week: "2026-W08", newSessions: 4310, returningSessions: 1260, newPurchases: 92, returningPurchases: 44, retentionRate: 0.226 },
    ],
    monthlyData: [
      { month: "2025-12", newUsers: 10220, activeUsers: 13850, sessions: 17200, purchases: 372, revenue: 29180, purchaseCvr: 0.0216 },
      { month: "2026-01", newUsers: 11140, activeUsers: 15230, sessions: 18760, purchases: 430, revenue: 34710, purchaseCvr: 0.0229 },
      { month: "2026-02", newUsers: 12980, activeUsers: 17120, sessions: 21140, purchases: 512, revenue: 41880, purchaseCvr: 0.0242 },
      { month: "2026-03", newUsers: 9820, activeUsers: 12750, sessions: 15390, purchases: 354, revenue: 29840, purchaseCvr: 0.023 },
    ],
  };
}

export function getDemoGoogleAdsOverview() {
  return {
    kpis: {
      spend: 14540,
      conversions: 521,
      revenue: 46580,
      roas: 3.2,
      cpa: 27.91,
      ctr: 3.9,
      cpc: 0.74,
      impressions: 789200,
      clicks: 30780,
      convRate: 0.0169,
    },
    kpiDeltas: {
      spend: 8.4,
      revenue: 13.2,
      roas: 4.5,
      conversions: 9.8,
      cpa: -1.2,
    },
    topCampaigns: [
      { name: "Backpack Search Campaign", spend: 4620, roas: 3.84, conversions: 171, channel: "Search", revenueChange: 16.4, roasChange: 5.2, spendChange: 11.8 },
      { name: "Travel Gear Performance Max", spend: 3930, roas: 3.35, conversions: 146, channel: "Performance Max", revenueChange: 8.1, roasChange: 2.9, spendChange: 7.3 },
      { name: "Brand Campaign", spend: 1880, roas: 5.02, conversions: 112, channel: "Search", revenueChange: 5.2, roasChange: 1.1, spendChange: 3.8 },
    ],
    insights: [
      { id: "gads-ins-1", severity: "warning", title: "Summer Hiking Campaign is budget-limited", description: "Lost impression share due to budget is above 24%." },
      { id: "gads-ins-2", severity: "positive", title: "Brand Campaign efficiency is strong", description: "ROAS 5.0x with low CPA and stable CTR." },
    ],
    period: { startDate: "2026-02-09", endDate: "2026-03-11" },
  };
}

export function getDemoGoogleAdsCampaigns() {
  const data = [
    { id: "g-1", name: "Backpack Search Campaign", status: "active", channel: "Search", spend: 4620, conversions: 171, revenue: 17740, roas: 3.84, cpa: 27.02, ctr: 4.8, cpc: 0.92, impressions: 214100, clicks: 10210, impressionShare: 0.63, lostIsBudget: 0.14, lostIsRank: 0.09, badges: ["strong_performer"], performanceLabel: "leader", actionState: "scale", spendShare: 31.8, revenueShare: 38.1, spendChange: 11.8, revenueChange: 16.4, roasChange: 5.2, conversionsChange: 12.6, ctrChange: 4.3 },
    { id: "g-2", name: "Travel Gear Performance Max", status: "active", channel: "Performance Max", spend: 3930, conversions: 146, revenue: 13160, roas: 3.35, cpa: 26.92, ctr: 2.9, cpc: 0.67, impressions: 318200, clicks: 9240, impressionShare: 0.54, lostIsBudget: 0.08, lostIsRank: 0.13, badges: ["strong_performer"], performanceLabel: "stable", actionState: "optimize", spendShare: 27, revenueShare: 28.3, spendChange: 7.3, revenueChange: 8.1, roasChange: 2.9, conversionsChange: 6.4, ctrChange: 1.8 },
    { id: "g-3", name: "Brand Campaign", status: "active", channel: "Search", spend: 1880, conversions: 112, revenue: 9440, roas: 5.02, cpa: 16.79, ctr: 7.5, cpc: 0.41, impressions: 64200, clicks: 4810, impressionShare: 0.86, lostIsBudget: 0.03, lostIsRank: 0.04, badges: ["strong_performer"], performanceLabel: "leader", actionState: "scale", spendShare: 12.9, revenueShare: 20.3, spendChange: 3.8, revenueChange: 5.2, roasChange: 1.1, conversionsChange: 4.2, ctrChange: 0.5 },
    { id: "g-4", name: "Summer Hiking Campaign", status: "active", channel: "Search", spend: 2410, conversions: 58, revenue: 6020, roas: 2.5, cpa: 41.55, ctr: 3.4, cpc: 0.96, impressions: 102800, clicks: 3650, impressionShare: 0.41, lostIsBudget: 0.26, lostIsRank: 0.17, badges: ["budget_limited", "high_cpa"], performanceLabel: "watch", actionState: "optimize", spendShare: 16.6, revenueShare: 12.9, spendChange: 9.5, revenueChange: -4.2, roasChange: -12.6, conversionsChange: -6.4, ctrChange: -3.7 },
    { id: "g-5", name: "Remarketing Display", status: "paused", channel: "Display", spend: 1700, conversions: 34, revenue: 4220, roas: 2.48, cpa: 50, ctr: 1.2, cpc: 0.58, impressions: 90000, clicks: 2870, impressionShare: 0.38, lostIsBudget: 0.19, lostIsRank: 0.21, badges: ["high_cpa", "wasted_spend"], performanceLabel: "at-risk", actionState: "reduce", spendShare: 11.7, revenueShare: 9.1, spendChange: 6.4, revenueChange: -8.8, roasChange: -14.1, conversionsChange: -11.5, ctrChange: -9.3 },
  ];
  return { rows: data, data, count: data.length, summary: { accountAvgRoas: 3.2, accountAvgCpa: 27.91 }, accountAvgRoas: 3.2, accountAvgCpa: 27.91, meta: { empty: false } };
}

export function getDemoGoogleAdsSearchTerms() {
  const data = [
    { searchTerm: "best travel backpack", status: "ADDED", campaign: "Backpack Search Campaign", adGroup: "Travel Core", spend: 820, conversions: 31, revenue: 3340, roas: 4.07, cpa: 26.45, ctr: 5.4, impressions: 12240, clicks: 661, intent: "commercial", isKeyword: true },
    { searchTerm: "waterproof hiking backpack", status: "NONE", campaign: "Summer Hiking Campaign", adGroup: "Hiking", spend: 710, conversions: 12, revenue: 1080, roas: 1.52, cpa: 59.17, ctr: 3.1, impressions: 15300, clicks: 474, intent: "transactional", isKeyword: false },
    { searchTerm: "carry on backpack for travel", status: "ADDED", campaign: "Backpack Search Campaign", adGroup: "Carry On", spend: 540, conversions: 24, revenue: 2560, roas: 4.74, cpa: 22.5, ctr: 4.6, impressions: 9800, clicks: 451, intent: "transactional", isKeyword: true },
    { searchTerm: "cheap camping backpack", status: "NONE", campaign: "Summer Hiking Campaign", adGroup: "Generic", spend: 450, conversions: 3, revenue: 190, roas: 0.42, cpa: 150, ctr: 2.1, impressions: 12020, clicks: 256, intent: "commercial", isKeyword: false },
  ];
  return {
    data,
    count: data.length,
    summary: {
      wastefulCount: 2,
      negativeKeywordCandidates: 1,
      highPerformingCount: 2,
      keywordOpportunities: 1,
      wastefulSpend: 1160,
    },
  };
}

export function getDemoGoogleAdsKeywords() {
  return {
    data: [
      { keyword: "travel backpack", matchType: "broad", campaign: "Backpack Search Campaign", adGroup: "Travel Core", status: "active", spend: 1030, conversions: 39, revenue: 3620, roas: 3.51, cpa: 26.41, ctr: 4.7, cpc: 0.89, qualityScore: 8 },
      { keyword: "waterproof backpack", matchType: "phrase", campaign: "Summer Hiking Campaign", adGroup: "Hiking", status: "active", spend: 760, conversions: 17, revenue: 1420, roas: 1.87, cpa: 44.71, ctr: 3.2, cpc: 1.02, qualityScore: 6 },
      { keyword: "urbantrail backpack", matchType: "exact", campaign: "Brand Campaign", adGroup: "Brand", status: "active", spend: 390, conversions: 31, revenue: 2810, roas: 7.21, cpa: 12.58, ctr: 8.4, cpc: 0.33, qualityScore: 9 },
    ],
    count: 3,
    insights: {
      highCtrLowConvCount: 1,
      highConvLowBudgetCount: 1,
      deserveOwnAdGroupCount: 1,
    },
  };
}

export function getDemoGoogleAdsSearchIntelligence() {
  const rows = [
    { key: "g-1:carry on backpack for travel", searchTerm: "carry on backpack for travel", campaign: "Backpack Search Campaign", adGroup: "Carry On", matchSource: "SEARCH", source: "search_term_view", impressions: 9800, clicks: 451, spend: 540, conversions: 24, revenue: 2560, roas: 4.74, cpa: 22.5, ctr: 4.6, conversionRate: 5.32, intent: "transactional", isKeyword: true, recommendation: "Promote in headlines", classification: "top_driver", clusterKey: "carry backpack travel" },
    { key: "g-4:waterproof hiking backpack", searchTerm: "waterproof hiking backpack", campaign: "Summer Hiking Campaign", adGroup: "Hiking", matchSource: "SEARCH", source: "search_term_view", impressions: 15300, clicks: 474, spend: 710, conversions: 12, revenue: 1080, roas: 1.52, cpa: 59.17, ctr: 3.1, conversionRate: 2.53, intent: "transactional", isKeyword: false, recommendation: "Add as exact keyword", classification: "keyword_opportunity", clusterKey: "waterproof hiking backpack" },
    { key: "g-4:cheap camping backpack", searchTerm: "cheap camping backpack", campaign: "Summer Hiking Campaign", adGroup: "Generic", matchSource: "SEARCH", source: "search_term_view", impressions: 12020, clicks: 256, spend: 450, conversions: 3, revenue: 190, roas: 0.42, cpa: 150, ctr: 2.1, conversionRate: 1.17, intent: "commercial", isKeyword: false, recommendation: "Add as negative keyword", classification: "waste", clusterKey: "cheap camping backpack" },
    { key: "g-2:travel weekender bag:campaign_scope", searchTerm: "travel weekender bag", campaign: "Travel Gear Performance Max", adGroup: "Campaign scope", matchSource: "PERFORMANCE_MAX", source: "campaign_search_term_view", impressions: 8600, clicks: 332, spend: 298, conversions: 11, revenue: 1280, roas: 4.3, cpa: 27.09, ctr: 3.9, conversionRate: 3.31, intent: "commercial", isKeyword: false, recommendation: "Add as exact keyword", classification: "keyword_opportunity", clusterKey: "travel weekender bag" },
  ];

  return {
    rows,
    data: rows,
    summary: {
      wastefulSpend: 450,
      keywordOpportunityCount: 2,
      negativeKeywordCount: 1,
      promotionSuggestionCount: 1,
      clusterCount: 4,
    },
    insights: {
      keywordCandidates: rows.filter((row) => row.recommendation === "Add as exact keyword"),
      negativeCandidates: rows.filter((row) => row.recommendation === "Add as negative keyword"),
      promotionCandidates: rows.filter((row) => row.recommendation === "Promote in headlines"),
      clusters: [
        { cluster: "carry backpack travel", intent: "transactional", campaigns: ["Backpack Search Campaign"], spend: 540, clicks: 451, conversions: 24, revenue: 2560, roas: 4.74, coverage: "covered", examples: ["carry on backpack for travel"], state: "Top driver", recommendation: "Reflect this language in assets" },
        { cluster: "waterproof hiking backpack", intent: "transactional", campaigns: ["Summer Hiking Campaign"], spend: 710, clicks: 474, conversions: 12, revenue: 1080, roas: 1.52, coverage: "open", examples: ["waterproof hiking backpack"], state: "Promising", recommendation: "Build exact-match coverage" },
        { cluster: "cheap camping backpack", intent: "commercial", campaigns: ["Summer Hiking Campaign"], spend: 450, clicks: 256, conversions: 3, revenue: 190, roas: 0.42, coverage: "open", examples: ["cheap camping backpack"], state: "Waste", recommendation: "Add negatives or tighten intent" },
      ],
    },
    meta: { empty: false },
  };
}

export function getDemoGoogleAdsAds() {
  const data = [
    {
      id: "ad-1",
      headline: "Carry-On Backpack Built for Weekend Trips",
      description: "Free shipping over $59. Built for airport-to-trail travel.",
      type: "responsive_search_ad",
      status: "active",
      adGroup: "Carry On",
      campaign: "Backpack Search Campaign",
      spend: 970,
      conversions: 44,
      revenue: 4380,
      roas: 4.52,
      cpa: 22.05,
      ctr: 5.3,
      convRate: 6.8,
      impressions: 18420,
      clicks: 972,
    },
    {
      id: "ad-2",
      headline: "Waterproof Hiking Backpack | UrbanTrail",
      description: "Rainproof shell, ergonomic frame, and hydration-ready design.",
      type: "responsive_search_ad",
      status: "active",
      adGroup: "Hiking",
      campaign: "Summer Hiking Campaign",
      spend: 860,
      conversions: 14,
      revenue: 1290,
      roas: 1.5,
      cpa: 61.43,
      ctr: 3.1,
      convRate: 2.6,
      impressions: 15080,
      clicks: 534,
    },
    {
      id: "ad-3",
      headline: "UrbanTrail Official Site - Free Shipping",
      description: "Shop backpacks and travel gear with 30-day returns.",
      type: "expanded_text_ad",
      status: "active",
      adGroup: "Brand",
      campaign: "Brand Campaign",
      spend: 420,
      conversions: 35,
      revenue: 3170,
      roas: 7.55,
      cpa: 12,
      ctr: 9.1,
      convRate: 11.1,
      impressions: 7420,
      clicks: 316,
    },
  ];
  return {
    data,
    count: data.length,
    insights: {
      topPerformerCtr: 9.1,
      bottomPerformerCtr: 3.1,
      bestAd: data[2],
      worstAd: data[1],
    },
  };
}

export function getDemoGoogleAdsAssets() {
  const rows = [
    { id: "ag-1:asset-1", assetId: "asset-1", assetGroupId: "ag-1", assetGroup: "Travel Gear Prospecting", campaignId: "g-2", campaign: "Travel Gear Performance Max", fieldType: "HEADLINE", type: "Headline", assetType: "TEXT", name: "Carry-on ready headline", text: "Carry-On Travel Backpack Built for Weekend Trips", preview: "Carry-On Travel Backpack Built for Weekend Trips", videoId: null, performanceLabel: "top", impressions: 44200, clicks: 2140, interactions: 2140, interactionRate: 4.84, spend: 640, conversions: 31, revenue: 2980, roas: 4.66, ctr: 4.84, conversionRate: 1.45, valuePerConversion: 96.13, hint: "High-value asset to reuse in new variants" },
    { id: "ag-1:asset-2", assetId: "asset-2", assetGroupId: "ag-1", assetGroup: "Travel Gear Prospecting", campaignId: "g-2", campaign: "Travel Gear Performance Max", fieldType: "DESCRIPTION", type: "Description", assetType: "TEXT", name: "Benefit-led description", text: "Built for airport-to-trail travel with free shipping over $59.", preview: "Built for airport-to-trail travel with free shipping over $59.", videoId: null, performanceLabel: "average", impressions: 39800, clicks: 1410, interactions: 1410, interactionRate: 3.54, spend: 410, conversions: 19, revenue: 1460, roas: 3.56, ctr: 3.54, conversionRate: 1.35, valuePerConversion: 76.84, hint: "" },
    { id: "ag-2:asset-3", assetId: "asset-3", assetGroupId: "ag-2", assetGroup: "Remarketing Gear Push", campaignId: "g-5", campaign: "Remarketing Display", fieldType: "MARKETING_IMAGE", type: "Image", assetType: "IMAGE", name: "Static studio shot", text: null, preview: "Static studio shot", videoId: null, performanceLabel: "underperforming", impressions: 52200, clicks: 602, interactions: 602, interactionRate: 1.15, spend: 290, conversions: 4, revenue: 180, roas: 0.62, ctr: 1.15, conversionRate: 0.66, valuePerConversion: 45, hint: "Low interaction rate versus account average" },
    { id: "ag-2:asset-4", assetId: "asset-4", assetGroupId: "ag-2", assetGroup: "Remarketing Gear Push", campaignId: "g-5", campaign: "Remarketing Display", fieldType: "VIDEO", type: "Video", assetType: "YOUTUBE_VIDEO", name: "Weekend packing reel", text: null, preview: "Weekend packing reel", videoId: "yt-123", performanceLabel: "average", impressions: 38200, clicks: 980, interactions: 980, interactionRate: 2.57, spend: 260, conversions: 9, revenue: 650, roas: 2.5, ctr: 2.57, conversionRate: 0.92, valuePerConversion: 72.22, hint: "Clicks are coming through but message or landing page may be misaligned" },
  ];

  return {
    rows,
    data: rows,
    summary: {
      topPerformingCount: 1,
      underperformingCount: 1,
      lowCtrCount: 1,
      typeBreakdown: [
        { type: "Headline", count: 1 },
        { type: "Description", count: 1 },
        { type: "Image", count: 1 },
        { type: "Video", count: 1 },
      ],
    },
    meta: { empty: false },
  };
}

export function getDemoGoogleAdsCreatives() {
  return {
    data: [
      { id: "gcr-1", name: "UGC Weekend Packing Reel", type: "Performance Max", status: "active", adStrength: "Best", campaign: "Travel Gear Performance Max", spend: 1320, conversions: 52, revenue: 4870, roas: 3.69, cpa: 25.38, ctr: 2.9, impressions: 64000, clicks: 1856 },
      { id: "gcr-2", name: "Explorer Backpack Lifestyle Carousel", type: "Performance Max", status: "active", adStrength: "Low", campaign: "Remarketing Display", spend: 740, conversions: 12, revenue: 980, roas: 1.32, cpa: 61.67, ctr: 1.1, impressions: 50200, clicks: 552 },
      { id: "gcr-3", name: "Carry-On Checklist Static", type: "Performance Max", status: "active", adStrength: "Good", campaign: "Backpack Search Campaign", spend: 510, conversions: 21, revenue: 1830, roas: 3.59, cpa: 24.29, ctr: 2.6, impressions: 28400, clicks: 738 },
    ],
    count: 3,
    insights: ["Display creative fatigue detected in Remarketing asset group; rotate new variants."],
  };
}

export function getDemoGoogleAdsAssetGroups() {
  const rows = [
    { id: "ag-1", name: "Travel Gear Prospecting", status: "active", campaignId: "g-2", campaign: "Travel Gear Performance Max", impressions: 120400, clicks: 4420, interactions: 4420, spend: 1320, conversions: 52, revenue: 4870, roas: 3.69, cpa: 25.38, conversionRate: 1.18, spendShare: 28.4, revenueShare: 33.1, coverageScore: 80, assetCount: 9, assetMix: { HEADLINE: 4, DESCRIPTION: 3, MARKETING_IMAGE: 1, LOGO: 1, BUSINESS_NAME: 1 }, state: "strong", adStrength: null, audienceSignalsSummary: null, searchThemes: [{ text: "carry on travel backpack", approvalStatus: "APPROVED", alignedMessaging: true }, { text: "weekender backpack", approvalStatus: "APPROVED", alignedMessaging: true }], searchThemeSummary: "carry on travel backpack, weekender backpack", searchThemeCount: 2, searchThemeAlignedCount: 2, missingAssetFields: [] },
    { id: "ag-2", name: "Remarketing Gear Push", status: "active", campaignId: "g-5", campaign: "Remarketing Display", impressions: 81200, clicks: 2150, interactions: 2150, spend: 740, conversions: 12, revenue: 980, roas: 1.32, cpa: 61.67, conversionRate: 0.56, spendShare: 15.9, revenueShare: 6.7, coverageScore: 40, assetCount: 5, assetMix: { HEADLINE: 2, DESCRIPTION: 1, MARKETING_IMAGE: 1, LOGO: 1 }, state: "weak", adStrength: null, audienceSignalsSummary: null, searchThemes: [{ text: "travel bag sale", approvalStatus: "APPROVED", alignedMessaging: false }, { text: "weekend luggage deal", approvalStatus: "PENDING", alignedMessaging: false }], searchThemeSummary: "travel bag sale, weekend luggage deal", searchThemeCount: 2, searchThemeAlignedCount: 0, missingAssetFields: ["BUSINESS_NAME", "DESCRIPTION"] },
  ];

  return {
    rows,
    data: rows,
    summary: {
      strongCount: 1,
      weakCount: 1,
      coverageGaps: 1,
      searchThemeCount: 4,
    },
    insights: {
      scaleCandidates: [rows[0]],
      reduceCandidates: [rows[1]],
    },
    meta: { empty: false },
  };
}

export function getDemoGoogleAdsProducts() {
  const rows = [
    { itemId: "sku-100", title: "UrbanTrail Carry-On Backpack", brand: "UrbanTrail", feedPrice: 89, impressions: 44200, clicks: 1920, spend: 880, conversions: 36, revenue: 3680, roas: 4.18, cpa: 24.44, ctr: 4.34, avgOrderValue: 102.22, spendPerOrder: 24.44, valuePerClick: 1.92, contributionProxy: 2800, contributionState: "positive", statusLabel: "scale" },
    { itemId: "sku-101", title: "Waterproof Hiking Pack", brand: "UrbanTrail", feedPrice: 109, impressions: 35100, clicks: 1180, spend: 760, conversions: 17, revenue: 1420, roas: 1.87, cpa: 44.71, ctr: 3.36, avgOrderValue: 83.53, spendPerOrder: 44.71, valuePerClick: 1.2, contributionProxy: 660, contributionState: "positive", statusLabel: "stable" },
    { itemId: "sku-102", title: "Travel Gear Cube Set", brand: "UrbanTrail", feedPrice: 42, impressions: 28400, clicks: 930, spend: 610, conversions: 9, revenue: 520, roas: 0.85, cpa: 67.78, ctr: 3.27, avgOrderValue: 57.78, spendPerOrder: 67.78, valuePerClick: 0.56, contributionProxy: -90, contributionState: "negative", statusLabel: "reduce" },
  ];

  return {
    rows,
    data: rows,
    summary: {
      totalSpend: 2250,
      totalRevenue: 5620,
      scaleCandidates: 1,
      reduceCandidates: 1,
      spendConcentrationTop3: 1,
    },
    insights: {
      topRevenueProducts: [rows[0], rows[1]],
      lowRoasProducts: [rows[2]],
      spendWithoutReturn: [],
    },
    meta: { empty: false },
  };
}

export function getDemoGoogleAdsAudiences() {
  const data = [
    { criterionId: "aud-1", type: "In-Market", adGroup: "Travel Core", campaign: "Backpack Search Campaign", spend: 2830, conversions: 103, revenue: 8920, roas: 3.15, cpa: 27.48, ctr: 3.8, impressions: 184000, clicks: 6992 },
    { criterionId: "aud-2", type: "Remarketing", adGroup: "Site Visitors 30d", campaign: "Remarketing Display", spend: 2190, conversions: 76, revenue: 6540, roas: 2.99, cpa: 28.82, ctr: 4.1, impressions: 122400, clicks: 5018 },
    { criterionId: "aud-3", type: "Affinity", adGroup: "Outdoor Interest", campaign: "Summer Hiking Campaign", spend: 1740, conversions: 47, revenue: 3210, roas: 1.84, cpa: 37.02, ctr: 2.7, impressions: 111800, clicks: 3019 },
  ];
  return {
    rows: data,
    data,
    summary: [
      { type: "In-Market", conversions: 103, spend: 2830, roas: 3.15 },
      { type: "Remarketing", conversions: 76, spend: 2190, roas: 2.99 },
      { type: "Affinity", conversions: 47, spend: 1740, roas: 1.84 },
    ],
    insights: ["Affinity segment is over-spending relative to conversion quality; tighten targeting."],
    meta: { empty: false },
  };
}

export function getDemoGoogleAdsGeo() {
  const data = [
    { country: "California", criterionId: 21137, impressions: 165000, clicks: 6930, spend: 3120, conversions: 122, revenue: 11040, roas: 3.54, cpa: 25.57, ctr: 4.2, convRate: 1.76, vsAvgCpa: -8 },
    { country: "Texas", criterionId: 21176, impressions: 123000, clicks: 4551, spend: 2120, conversions: 69, revenue: 5240, roas: 2.47, cpa: 30.72, ctr: 3.7, convRate: 1.52, vsAvgCpa: 9 },
    { country: "New York", criterionId: 21167, impressions: 102000, clicks: 4182, spend: 1980, conversions: 73, revenue: 6760, roas: 3.41, cpa: 27.12, ctr: 4.1, convRate: 1.75, vsAvgCpa: -2 },
  ];
  return {
    rows: data,
    data,
    insights: ["Texas ROAS trails other top states; shift 10-15% budget to CA/NY test pools."],
    meta: { empty: false },
  };
}

export function getDemoGoogleAdsDevices() {
  const data = [
    { device: "Mobile", impressions: 452000, clicks: 16272, spend: 8420, conversions: 251, revenue: 19420, roas: 2.31, cpa: 33.55, ctr: 3.6, convRate: 1.54 },
    { device: "Desktop", impressions: 211000, clicks: 10128, spend: 4970, conversions: 226, revenue: 22840, roas: 4.6, cpa: 21.99, ctr: 4.8, convRate: 2.23 },
    { device: "Tablet", impressions: 46100, clicks: 1429, spend: 1150, conversions: 44, revenue: 4320, roas: 3.76, cpa: 26.14, ctr: 3.1, convRate: 3.08 },
  ];
  return {
    rows: data,
    data,
    insights: ["Mobile traffic is strong but conversion rate trails desktop; review mobile checkout friction."],
    meta: { empty: false },
  };
}

export function getDemoGoogleAdsBudget() {
  return {
    data: [
      { id: "g-4", name: "Summer Hiking Campaign", dailyBudget: 110, spend: 2410, conversions: 58, revenue: 6020, roas: 2.5, cpa: 41.55, impressions: 102800, clicks: 3650, impressionShare: 0.41, lostIsBudget: 0.26, recommendation: "Increase budget by 18% and tighten keywords." },
      { id: "g-5", name: "Remarketing Display", dailyBudget: 70, spend: 1700, conversions: 34, revenue: 4220, roas: 2.48, cpa: 50, impressions: 90000, clicks: 2870, impressionShare: 0.38, lostIsBudget: 0.19, recommendation: "Shift 20% budget to high-intent search campaigns." },
    ],
    recommendations: [
      { campaign: "Summer Hiking Campaign", currentSpend: 2410, suggestedBudgetChange: 430, direction: "increase", reason: "Budget-limited with healthy conversion depth." },
      { campaign: "Remarketing Display", currentSpend: 1700, suggestedBudgetChange: -300, direction: "decrease", reason: "Below-target ROAS versus search campaigns." },
    ],
    totalSpend: 14540,
    accountAvgRoas: 3.2,
  };
}

export function getDemoGoogleAdsOpportunities() {
  const data = [
    { id: "opp-1", type: "budget_shift", title: "Move budget to Backpack Search", whyItMatters: "Search campaign delivers 1.5x better ROAS than Display.", evidence: "$1.7k spend at 2.48x ROAS in Display.", expectedImpact: "+$2.1k revenue / 30d", impact: "Revenue growth", confidence: "high", effort: "low", priority: "high", recommendedAction: "Shift 10-15% of low-efficiency display budget into Backpack Search and monitor impression share." },
    { id: "opp-2", type: "negative_keyword", title: "Add negatives for low-intent generic terms", whyItMatters: "Generic queries waste spend with weak conversion.", evidence: "\"cheap camping backpack\" spent $450 with 0.42x ROAS.", expectedImpact: "-8% wasted spend", impact: "Waste reduction", confidence: "high", effort: "low", priority: "high", recommendedAction: "Add the generic low-intent terms as shared negatives across non-brand search." },
    { id: "opp-3", type: "ad_copy", title: "Scale high-CTR carry-on message", whyItMatters: "Carry-on angle has strongest CTR + CVR combo.", evidence: "5.3% CTR and 4.52x ROAS on top ad.", expectedImpact: "+12-18% conversions", impact: "Creative lift", confidence: "medium", effort: "medium", priority: "medium", recommendedAction: "Rebuild weaker headlines around the carry-on angle and push the message into PMax headlines." },
    { id: "opp-4", type: "product_reduce", title: "Reduce spend on Travel Gear Cube Set", whyItMatters: "The product is consuming spend without efficient return.", evidence: "$610 spent at 0.85x ROAS.", expectedImpact: "Free budget for stronger SKUs", impact: "Waste reduction", confidence: "medium", effort: "low", priority: "high", recommendedAction: "Lower bids on the weak SKU and reallocate budget into the best performing backpack lines." },
    { id: "opp-5", type: "search_theme_alignment", title: "Align PMax search themes with asset messaging", whyItMatters: "Configured search themes are broader than the asset copy in Remarketing Gear Push.", evidence: "0 of 2 configured themes appear in current asset messaging.", expectedImpact: "Improve PMax relevance and click quality", impact: "Relevance lift", confidence: "low", effort: "medium", priority: "medium", recommendedAction: "Rewrite headlines and descriptions so the approved search themes show up directly in message copy." },
  ];
  return { data, count: data.length };
}

export function getDemoGoogleAdsAdvisor() {
  const toStringArray = (value: unknown) =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

  const recommendations = [
    {
      id: "demo-google-non-brand",
      level: "account",
      type: "non_brand_expansion",
      strategyLayer: "Non-Brand Expansion",
      decisionState: "act",
      priority: "high",
      confidence: "high",
      comparisonCohort: "Brand Search + PMax",
      title: "Non-brand demand is being found, but not captured cleanly",
      summary:
        "PMax and broad query capture are surfacing real commercial demand that deserves its own controlled Search lane.",
      why:
        "Without a non-brand buildout, the account has weak query governance and no clean way to scale demand beyond brand.",
      recommendedAction:
        "Launch exact on proven query winners, support adjacent variants with phrase, and keep broad discovery tightly guarded by shared negatives.",
      potentialContribution: {
        label: "Incremental revenue capture",
        impact: "high",
        summary: "A cleaner non-brand lane should unlock more new customer demand.",
        estimatedRevenueLiftRange: "$1,200-$2,800",
      },
      evidence: [
        { label: "Recurring converting query clusters", value: "4" },
        { label: "Best query ROAS", value: "4.7x" },
        { label: "Expected launch mix", value: "4 exact / 3 phrase / 2 broad themes" },
      ],
      timeframeContext: {
        coreVerdict:
          "Recurring commercial search demand exists beyond brand and should not stay hidden inside PMax alone.",
        selectedRangeNote:
          "The selected range confirms which query winners are hottest now, but the launch call is supported by repeat demand across longer windows.",
        historicalSupport: "5/6 weighted windows show non-brand converting demand.",
      },
      seedQueriesExact: [
        "carry on backpack for travel",
        "travel weekender bag",
        "waterproof hiking backpack",
        "weekend carry on backpack",
      ],
      seedQueriesPhrase: [
        "travel backpack for flights",
        "carry on bag backpack",
        "weekender backpack for women",
      ],
      seedThemesBroad: ["carry backpack travel", "weekender backpack", "hiking backpack waterproof"],
      negativeGuardrails: ["cheap", "free", "pattern", "used", "repair"],
    },
    {
      id: "demo-google-shopping",
      level: "account",
      type: "shopping_launch_or_split",
      strategyLayer: "Shopping & Products",
      decisionState: "act",
      priority: "medium",
      confidence: "medium",
      title: "Shopping should be used as a control layer, not left entirely to PMax",
      summary:
        "The catalog has enough winner concentration that a Shopping lane would add product control instead of just duplicating PMax.",
      why:
        "Hero products and hidden winners deserve their own visibility and budget steering.",
      recommendedAction:
        "Launch a hero-SKU Shopping campaign first, then split into category-led clusters if the winners keep holding share.",
      potentialContribution: {
        label: "Control gain",
        impact: "medium",
        summary: "Better SKU visibility and budget precision.",
        estimatedRevenueLiftRange: "$900-$1,900",
      },
      evidence: [
        { label: "Hidden winners", value: "2" },
        { label: "Top product revenue share", value: "54%" },
        { label: "Launch mode", value: "hero_sku_shopping" },
      ],
      timeframeContext: {
        coreVerdict: "Shopping adds product-level control that PMax alone cannot provide.",
        selectedRangeNote: "Recent SKU concentration confirms which products should anchor the first Shopping launch.",
        historicalSupport: "4/6 weighted windows show the same hero products dominating revenue.",
      },
      launchMode: "hero_sku_shopping",
      startingSkuClusters: ["UrbanTrail Carry-On Backpack", "Waterproof Hiking Pack"],
    },
    {
      id: "demo-google-query",
      level: "account",
      type: "query_governance",
      strategyLayer: "Search Governance",
      decisionState: "act",
      priority: "high",
      confidence: "high",
      title: "Low-intent query waste is still making it through",
      summary: "Some search clusters are spending enough to deserve shared negatives now.",
      why: "Wasteful queries drag efficiency and muddy what a clean non-brand buildout should look like.",
      recommendedAction:
        "Add the worst generic clusters to shared negatives before expanding broad or phrase coverage.",
      potentialContribution: {
        label: "Waste recovery",
        impact: "high",
        summary: "Should improve signal quality quickly.",
        estimatedWasteRecoveryRange: "$300-$640",
      },
      evidence: [
        { label: "Waste clusters", value: "3" },
        { label: "Waste spend", value: "$450" },
        { label: "Top waste query", value: "cheap camping backpack" },
      ],
      timeframeContext: {
        coreVerdict: "Waste is recurring enough that one-off exclusions are no longer enough.",
        selectedRangeNote: "Recent waste confirms the same low-intent queries are still active.",
        historicalSupport: "4/6 weighted windows show repeat waste clusters.",
      },
      negativeClusters: ["cheap camping backpack", "free backpack patterns"],
      negativeQueries: ["cheap camping backpack", "free backpack patterns pdf"],
    },
    {
      id: "demo-google-assets",
      level: "account",
      type: "creative_asset_deployment",
      strategyLayer: "Assets & Testing",
      decisionState: "act",
      priority: "medium",
      confidence: "medium",
      title: "Asset rotation should separate scaling winners from replacement work",
      summary:
        "The account already has clear asset winners, so scaling lanes should stop carrying creative discovery.",
      why:
        "Weak assets slow down PMax learning and make it harder to know whether performance is a demand issue or a message issue.",
      recommendedAction:
        "Keep winner assets in scaling rotation, move average assets into TEST, and replace the weak assets with search-led messaging angles.",
      potentialContribution: {
        label: "Signal gain",
        impact: "medium",
        summary: "Cleaner asset deployment improves both scale quality and testing speed.",
      },
      evidence: [
        { label: "Scale-ready assets", value: "2" },
        { label: "Replace now", value: "1" },
        { label: "Test-only assets", value: "2" },
      ],
      timeframeContext: {
        coreVerdict: "Asset decisions should follow winner states, not just current spend.",
        selectedRangeNote: "Recent asset behavior confirms the same gap between winners and laggards.",
        historicalSupport: "Asset winners line up with the same top search themes across longer windows.",
      },
      scaleReadyAssets: ["Carry-on ready headline", "Weekend packing reel"],
      testOnlyAssets: ["Benefit-led description", "Explorer Backpack Lifestyle Carousel"],
      replaceAssets: ["Static studio shot"],
      replacementAngles: [
        'Lead with "carry on backpack" intent in the first line',
        "Use UrbanTrail Carry-On Backpack as the visual proof point",
      ],
    },
    {
      id: "demo-google-pmax",
      level: "account",
      type: "pmax_scaling_fit",
      strategyLayer: "PMax Scaling",
      decisionState: "watch",
      priority: "medium",
      confidence: "medium",
      title: "PMax can scale, but only after feed and query governance get cleaner",
      summary:
        "PMax is productive enough to matter, but not clean enough yet to be treated as a budget dump.",
      why:
        "The current setup still has product and query noise that would likely scale with it.",
      recommendedAction:
        "Clean query waste, launch Shopping control, refresh weak assets, then revisit whether PMax deserves another 10-15% budget step-up.",
      potentialContribution: {
        label: "Incremental revenue capture",
        impact: "medium",
        summary: "PMax scale should come after cleanup, not before it.",
      },
      evidence: [
        { label: "Selected PMax ROAS", value: "3.7x" },
        { label: "Weak asset groups", value: "1" },
        { label: "Hidden winner products", value: "2" },
      ],
      timeframeContext: {
        coreVerdict: "PMax is a viable scaling lane, but only if the surrounding control layers are healthier.",
        selectedRangeNote: "Recent performance is encouraging but not clean enough to override the broader structural issues.",
        historicalSupport: "PMax remains productive in 5/6 weighted windows.",
      },
    },
    {
      id: "demo-google-brand-control",
      level: "account",
      type: "brand_capture_control",
      strategyLayer: "Operating Model",
      decisionState: "act",
      priority: "medium",
      confidence: "high",
      title: "Brand should stay isolated so it does not hide growth weakness",
      summary:
        "Brand efficiency is good, but it should not be the benchmark used to justify non-brand or PMax scaling.",
      why:
        "Brand demand can make the whole account look healthier than the growth engine really is.",
      recommendedAction:
        "Keep Brand Search as a support lane and judge budget expansion on non-brand and PMax cohorts separately.",
      potentialContribution: {
        label: "Control gain",
        impact: "medium",
        summary: "Protects decision quality and avoids false-positive scale calls.",
      },
      evidence: [
        { label: "Brand revenue share", value: "32%" },
        { label: "Brand ROAS", value: "7.6x" },
        { label: "Best growth-lane ROAS", value: "4.7x" },
      ],
      timeframeContext: {
        coreVerdict: "Brand is a support lane, not the right growth benchmark.",
        selectedRangeNote: "Recent brand efficiency remains strong but does not change the operating-model recommendation.",
        historicalSupport: "Brand outperforms growth lanes in 6/6 weighted windows.",
      },
    },
  ];

  const sections = [
    "Operating Model",
    "Search Governance",
    "Non-Brand Expansion",
    "Shopping & Products",
    "PMax Scaling",
    "Assets & Testing",
  ].map((title) => ({
    id: title.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    title,
    recommendations: recommendations.filter((recommendation) => recommendation.strategyLayer === title),
  })).filter((section) => section.recommendations.length > 0);

  const enrichedRecommendations = recommendations.map((recommendation, index) => ({
    ...recommendation,
    decisionFamily:
      recommendation.type === "query_governance" || recommendation.type === "brand_capture_control"
        ? "waste_control"
        : recommendation.type === "non_brand_expansion" || recommendation.type === "shopping_launch_or_split"
          ? "growth_unlock"
          : recommendation.type === "diagnostic_guardrail"
            ? "commercial_constraint"
            : "structure_repair",
    doBucket:
      index < 2 ? "do_now" : recommendation.decisionState === "watch" ? "do_later" : "do_next",
    dataTrust: recommendation.confidence === "high" ? "high" : "medium",
    whyNow: recommendation.timeframeContext.selectedRangeNote,
    whatChanged: index < 2 ? "The selected range is still confirming the same priority shift." : null,
    reasonCodes: [recommendation.type.toUpperCase(), `DECISION_${recommendation.decisionState.toUpperCase()}`],
    confidenceExplanation:
      recommendation.confidence === "high"
        ? "Weighted windows and the current selected range agree on this decision."
        : "The direction is supported, but the recommendation should still be validated in the next review window.",
    confidenceDegradationReasons:
      recommendation.confidence === "high" ? [] : ["This recommendation still depends on follow-through validation."],
    impactBand: recommendation.potentialContribution.impact,
    effortScore:
      recommendation.type === "query_governance" ? "low" : recommendation.type === "shopping_launch_or_split" ? "high" : "medium",
    rollbackGuidance:
      recommendation.type === "query_governance"
        ? "Remove the new negatives if protected conversion volume falls below baseline after the first review."
        : null,
    validationChecklist: [
      ...toStringArray("prerequisites" in recommendation ? recommendation.prerequisites : []).slice(0, 2),
      ...toStringArray("playbookSteps" in recommendation ? recommendation.playbookSteps : []).slice(0, 2),
    ],
    blockers: [],
    aiCommentary: null,
  }));

  const enrichedSections = sections.map((section) => ({
    ...section,
    recommendations: enrichedRecommendations.filter((recommendation) => recommendation.strategyLayer === section.title),
  }));

  return {
    summary: {
      headline: "Brand + PMax mix is hiding a non-brand growth gap",
      operatorNote:
        "6 actionable Google recommendations are live. Highest priority: launch a controlled non-brand Search buildout.",
      accountOperatingMode: "Unlock growth",
      topConstraint: "Brand and PMax are still masking non-brand demand clarity.",
      topGrowthLever: "Launch a controlled non-brand Search buildout from recurring winners.",
      recommendedFocusToday:
        "Launch a non-brand Search buildout from the proven query clusters, then fund it with a controlled budget carve-out.",
      demandMap: "Brand Search 18.4% spend • PMax 46.2% spend • Shopping 22.1% spend • Non-Brand Search 13.3% spend",
      topPriority:
        "Launch a non-brand Search buildout from the proven query clusters, then fund it with a small budget carve-out instead of scaling PMax blindly.",
      totalRecommendations: 6,
      actRecommendationCount: 4,
      watchouts: [
        "PMax still carries too much unchecked catalog demand.",
        "Brand efficiency remains strong enough to hide growth weakness.",
      ],
      dataTrustSummary:
        "Demo recommendations are shown with stable weighted-window support and no external commerce constraints connected.",
      campaignRoles: [
        {
          campaignId: "g-brand",
          campaignName: "Brand Campaign",
          family: "brand_search",
          familyLabel: "Brand Search",
          role: "Support",
          roleLabel: "Support",
          recommendationCount: 2,
          topActionHint: "Keep brand isolated and judge scale on non-brand cohorts.",
        },
        {
          campaignId: "g-pmax",
          campaignName: "Travel Gear Performance Max",
          family: "pmax_scaling",
          familyLabel: "PMax",
          role: "Scaling",
          roleLabel: "Scaling",
          recommendationCount: 4,
          topActionHint: "Clean product and query waste before pushing more budget through PMax.",
        },
      ],
    },
    recommendations: enrichedRecommendations,
    sections: enrichedSections,
  };
}

export function getDemoGoogleAdsDiagnostics() {
  const rows = [
    { label: "Overview", partial: false, warningCount: 0, failureCount: 0, unavailableMetricCount: 0, rows: 1, meta: { partial: false, warnings: [], failed_queries: [], unavailable_metrics: [] } },
    { label: "Campaigns", partial: false, warningCount: 0, failureCount: 0, unavailableMetricCount: 0, rows: 5, meta: { partial: false, warnings: [], failed_queries: [], unavailable_metrics: [] } },
    { label: "Search Intelligence", partial: false, warningCount: 1, failureCount: 0, unavailableMetricCount: 0, rows: 4, meta: { partial: false, warnings: ["Campaign-scope search terms are included where available to broaden Search Intelligence beyond standard search_term_view coverage."], failed_queries: [], unavailable_metrics: [] } },
    { label: "Asset Groups", partial: true, warningCount: 1, failureCount: 0, unavailableMetricCount: 1, rows: 2, meta: { partial: true, warnings: ["Search themes are shown as configured asset-group signals. Performance metrics at the theme level remain limited."], failed_queries: [], unavailable_metrics: ["asset_group_level_search_theme_performance_metrics"] } },
  ];

  return {
    rows,
    data: rows,
    summary: {
      loadedSections: rows.length,
      healthySections: 2,
      totalWarnings: 2,
      totalFailures: 0,
      generatedAt: "2026-03-13T08:00:00.000Z",
    },
    insights: {
      limitations: [
        "Asset-group-level search theme performance metrics are not consistently exposed by Google Ads API.",
        "Product contribution is a value-minus-spend proxy, not a true margin model.",
      ],
    },
    meta: { empty: false },
  };
}

export function getDemoMetaCampaigns() {
  return {
    rows: [
      { id: "m-c1", accountId: "demo-meta-1", name: "Backpack Video Ads", status: "ACTIVE", spend: 7140, purchases: 281, revenue: 25840, roas: 3.62, cpa: 25.41, ctr: 2.41, cpm: 16.2, cpc: 0.34, cpp: 0.42, impressions: 881000, reach: 754000, frequency: 1.17, clicks: 21240, uniqueClicks: 17010, uniqueCtr: 2.11, inlineLinkClickCtr: 1.84, outboundClicks: 15420, outboundCtr: 1.75, uniqueOutboundClicks: 13200, uniqueOutboundCtr: 1.5, landingPageViews: 11880, costPerLandingPageView: 0.6, addToCart: 910, addToCartValue: 32410, costPerAddToCart: 7.85, initiateCheckout: 602, initiateCheckoutValue: 21240, costPerCheckoutInitiated: 11.86, leads: 0, leadsValue: 0, costPerLead: 0, registrationsCompleted: 0, registrationsCompletedValue: 0, costPerRegistrationCompleted: 0, searches: 0, searchesValue: 0, costPerSearch: 0, addPaymentInfo: 428, addPaymentInfoValue: 15020, costPerAddPaymentInfo: 16.68, pageLikes: 0, costPerPageLike: 0, postEngagement: 3820, costPerEngagement: 1.87, postReactions: 1540, costPerReaction: 4.64, postComments: 182, costPerPostComment: 39.23, postShares: 134, costPerPostShare: 53.28, messagingConversationsStarted: 0, costPerMessagingConversationStarted: 0, appInstalls: 0, costPerAppInstall: 0, contentViews: 1420, contentViewsValue: 41200, costPerContentView: 5.03, videoViews3s: 244000, videoViews15s: 181000, videoViews25: 181000, videoViews50: 127000, videoViews75: 88400, videoViews95: 52200, videoViews100: 52200, costPerVideoView: 0.03, currency: "USD", optimizationGoal: "Purchase", bidStrategyType: "cost_cap", bidStrategyLabel: "Cost Cap", manualBidAmount: null, previousManualBidAmount: null, bidValue: 2600, bidValueFormat: "currency", previousBidValue: 2400, dailyBudget: 3000, lifetimeBudget: null, isBudgetMixed: false, isConfigMixed: false, isOptimizationGoalMixed: false, isBidStrategyMixed: false, isBidValueMixed: false },
      { id: "m-c2", accountId: "demo-meta-1", name: "UGC Travel Creatives", status: "ACTIVE", spend: 5240, purchases: 216, revenue: 19920, roas: 3.8, cpa: 24.26, ctr: 2.86, cpm: 15.1, cpc: 0.29, cpp: 0.38, impressions: 624000, reach: 541000, frequency: 1.15, clicks: 17840, uniqueClicks: 13980, uniqueCtr: 2.24, inlineLinkClickCtr: 1.96, outboundClicks: 12950, outboundCtr: 2.08, uniqueOutboundClicks: 11030, uniqueOutboundCtr: 1.77, landingPageViews: 9850, costPerLandingPageView: 0.53, addToCart: 740, addToCartValue: 24810, costPerAddToCart: 7.08, initiateCheckout: 504, initiateCheckoutValue: 16140, costPerCheckoutInitiated: 10.4, leads: 0, leadsValue: 0, costPerLead: 0, registrationsCompleted: 0, registrationsCompletedValue: 0, costPerRegistrationCompleted: 0, searches: 0, searchesValue: 0, costPerSearch: 0, addPaymentInfo: 388, addPaymentInfoValue: 12840, costPerAddPaymentInfo: 13.51, pageLikes: 0, costPerPageLike: 0, postEngagement: 2910, costPerEngagement: 1.8, postReactions: 1220, costPerReaction: 4.3, postComments: 144, costPerPostComment: 36.39, postShares: 119, costPerPostShare: 44.03, messagingConversationsStarted: 0, costPerMessagingConversationStarted: 0, appInstalls: 0, costPerAppInstall: 0, contentViews: 1160, contentViewsValue: 30120, costPerContentView: 4.52, videoViews3s: 188000, videoViews15s: 132000, videoViews25: 132000, videoViews50: 91800, videoViews75: 62100, videoViews95: 34800, videoViews100: 34800, costPerVideoView: 0.03, currency: "USD", optimizationGoal: null, bidStrategyType: "bid_cap", bidStrategyLabel: "Bid Cap", manualBidAmount: null, previousManualBidAmount: null, bidValue: null, bidValueFormat: null, previousBidValue: null, dailyBudget: null, lifetimeBudget: null, isBudgetMixed: true, isConfigMixed: true, isOptimizationGoalMixed: true, isBidStrategyMixed: false, isBidValueMixed: true },
      { id: "m-c3", accountId: "demo-meta-1", name: "Remarketing Campaign", status: "ACTIVE", spend: 4260, purchases: 203, revenue: 16780, roas: 3.94, cpa: 20.99, ctr: 3.18, cpm: 17.4, cpc: 0.3, cpp: 0.41, impressions: 441000, reach: 292000, frequency: 1.51, clicks: 14010, uniqueClicks: 10340, uniqueCtr: 2.34, inlineLinkClickCtr: 2.11, outboundClicks: 10840, outboundCtr: 2.46, uniqueOutboundClicks: 8520, uniqueOutboundCtr: 1.93, landingPageViews: 8730, costPerLandingPageView: 0.49, addToCart: 692, addToCartValue: 20140, costPerAddToCart: 6.16, initiateCheckout: 463, initiateCheckoutValue: 12920, costPerCheckoutInitiated: 9.2, leads: 0, leadsValue: 0, costPerLead: 0, registrationsCompleted: 0, registrationsCompletedValue: 0, costPerRegistrationCompleted: 0, searches: 0, searchesValue: 0, costPerSearch: 0, addPaymentInfo: 350, addPaymentInfoValue: 10120, costPerAddPaymentInfo: 12.17, pageLikes: 0, costPerPageLike: 0, postEngagement: 1880, costPerEngagement: 2.27, postReactions: 860, costPerReaction: 4.95, postComments: 96, costPerPostComment: 44.38, postShares: 88, costPerPostShare: 48.41, messagingConversationsStarted: 0, costPerMessagingConversationStarted: 0, appInstalls: 0, costPerAppInstall: 0, contentViews: 1040, contentViewsValue: 24120, costPerContentView: 4.1, videoViews3s: 0, videoViews15s: 0, videoViews25: 0, videoViews50: 0, videoViews75: 0, videoViews95: 0, videoViews100: 0, costPerVideoView: 0, currency: "USD", optimizationGoal: "Purchase", bidStrategyType: "manual_bid", bidStrategyLabel: "Manual Bid", manualBidAmount: 2800, previousManualBidAmount: 2400, bidValue: 2800, bidValueFormat: "currency", previousBidValue: 2400, dailyBudget: 1800, lifetimeBudget: null, isBudgetMixed: false, isConfigMixed: false, isOptimizationGoalMixed: false, isBidStrategyMixed: false, isBidValueMixed: false },
      { id: "m-c4", accountId: "demo-meta-1", name: "Adventure Lifestyle Campaign", status: "PAUSED", spend: 3180, purchases: 71, revenue: 5290, roas: 1.66, cpa: 44.79, ctr: 1.67, cpm: 14.3, cpc: 0.5, cpp: 0.61, impressions: 381000, reach: 314000, frequency: 1.21, clicks: 6360, uniqueClicks: 5240, uniqueCtr: 1.37, inlineLinkClickCtr: 1.11, outboundClicks: 4110, outboundCtr: 1.08, uniqueOutboundClicks: 3620, uniqueOutboundCtr: 0.95, landingPageViews: 2810, costPerLandingPageView: 1.13, addToCart: 240, addToCartValue: 7820, costPerAddToCart: 13.25, initiateCheckout: 121, initiateCheckoutValue: 3280, costPerCheckoutInitiated: 26.28, leads: 34, leadsValue: 0, costPerLead: 93.53, registrationsCompleted: 0, registrationsCompletedValue: 0, costPerRegistrationCompleted: 0, searches: 0, searchesValue: 0, costPerSearch: 0, addPaymentInfo: 88, addPaymentInfoValue: 1820, costPerAddPaymentInfo: 36.14, pageLikes: 42, costPerPageLike: 75.71, postEngagement: 2440, costPerEngagement: 1.3, postReactions: 1090, costPerReaction: 2.92, postComments: 124, costPerPostComment: 25.65, postShares: 96, costPerPostShare: 33.13, messagingConversationsStarted: 18, costPerMessagingConversationStarted: 176.67, appInstalls: 0, costPerAppInstall: 0, contentViews: 440, contentViewsValue: 9210, costPerContentView: 7.23, videoViews3s: 91000, videoViews15s: 66200, videoViews25: 66200, videoViews50: 40100, videoViews75: 20300, videoViews95: 9440, videoViews100: 9440, costPerVideoView: 0.03, currency: "USD", optimizationGoal: "Lead", bidStrategyType: "lowest_cost", bidStrategyLabel: "Lowest Cost", manualBidAmount: null, previousManualBidAmount: null, bidValue: null, bidValueFormat: null, previousBidValue: null, dailyBudget: 1200, lifetimeBudget: null, isBudgetMixed: false, isConfigMixed: false, isOptimizationGoalMixed: false, isBidStrategyMixed: false, isBidValueMixed: false },
      { id: "m-c5", accountId: "demo-meta-1", name: "Summer Gear Promotion", status: "ACTIVE", spend: 1600, purchases: 45, revenue: 4060, roas: 2.54, cpa: 35.56, ctr: 1.93, cpm: 13.8, cpc: 0.36, cpp: 0.44, impressions: 232000, reach: 201000, frequency: 1.15, clicks: 4470, uniqueClicks: 3310, uniqueCtr: 1.43, inlineLinkClickCtr: 1.22, outboundClicks: 3110, outboundCtr: 1.34, uniqueOutboundClicks: 2580, uniqueOutboundCtr: 1.11, landingPageViews: 2210, costPerLandingPageView: 0.72, addToCart: 172, addToCartValue: 5310, costPerAddToCart: 9.3, initiateCheckout: 94, initiateCheckoutValue: 2680, costPerCheckoutInitiated: 17.02, leads: 0, leadsValue: 0, costPerLead: 0, registrationsCompleted: 0, registrationsCompletedValue: 0, costPerRegistrationCompleted: 0, searches: 0, searchesValue: 0, costPerSearch: 0, addPaymentInfo: 69, addPaymentInfoValue: 1560, costPerAddPaymentInfo: 23.19, pageLikes: 0, costPerPageLike: 0, postEngagement: 860, costPerEngagement: 1.86, postReactions: 420, costPerReaction: 3.81, postComments: 38, costPerPostComment: 42.11, postShares: 31, costPerPostShare: 51.61, messagingConversationsStarted: 0, costPerMessagingConversationStarted: 0, appInstalls: 0, costPerAppInstall: 0, contentViews: 320, contentViewsValue: 6120, costPerContentView: 5, videoViews3s: 0, videoViews15s: 0, videoViews25: 0, videoViews50: 0, videoViews75: 0, videoViews95: 0, videoViews100: 0, costPerVideoView: 0, currency: "USD", optimizationGoal: "Add To Cart", bidStrategyType: "target_roas", bidStrategyLabel: "Target ROAS", manualBidAmount: null, previousManualBidAmount: null, bidValue: 3.5, bidValueFormat: "roas", previousBidValue: 3.1, dailyBudget: 700, lifetimeBudget: null, isBudgetMixed: false, isConfigMixed: false, isOptimizationGoalMixed: false, isBidStrategyMixed: false, isBidValueMixed: false },
    ],
  };
}

export function getDemoMetaAdSets(campaignId?: string | null): MetaAdSetData[] {
  const rows: MetaAdSetData[] = [
    {
      id: "m-as-1",
      accountId: "demo-meta-1",
      name: "Prospecting Wide US",
      campaignId: "m-c1",
      status: "ACTIVE",
      budgetLevel: "adset",
      dailyBudget: 1500,
      lifetimeBudget: null,
      optimizationGoal: "Purchase",
      bidStrategyType: "cost_cap",
      bidStrategyLabel: "Cost Cap",
      manualBidAmount: null,
      previousManualBidAmount: null,
      bidValue: 2400,
      bidValueFormat: "currency",
      previousBidValue: 2200,
      previousBidValueFormat: "currency",
      previousBidValueCapturedAt: "2026-03-22T12:00:00.000Z",
      previousDailyBudget: 1300,
      previousLifetimeBudget: null,
      previousBudgetCapturedAt: "2026-03-22T12:00:00.000Z",
      isBudgetMixed: false,
      isConfigMixed: false,
      isOptimizationGoalMixed: false,
      isBidStrategyMixed: false,
      isBidValueMixed: false,
      spend: 2240,
      purchases: 82,
      revenue: 8512,
      roas: 3.8,
      cpa: 27.32,
      ctr: 1.92,
      cpm: 13.2,
      impressions: 168500,
      clicks: 3240,
      inlineLinkClickCtr: 1.72,
    },
    {
      id: "m-as-2",
      accountId: "demo-meta-1",
      name: "Prospecting Hook Tests",
      campaignId: "m-c1",
      status: "ACTIVE",
      budgetLevel: "adset",
      dailyBudget: 900,
      lifetimeBudget: null,
      optimizationGoal: "Purchase",
      bidStrategyType: "cost_cap",
      bidStrategyLabel: "Cost Cap",
      manualBidAmount: null,
      previousManualBidAmount: null,
      bidValue: 2500,
      bidValueFormat: "currency",
      previousBidValue: 2500,
      previousBidValueFormat: "currency",
      previousBidValueCapturedAt: "2026-04-09T08:00:00.000Z",
      previousDailyBudget: 900,
      previousLifetimeBudget: null,
      previousBudgetCapturedAt: "2026-04-09T08:00:00.000Z",
      isBudgetMixed: false,
      isConfigMixed: false,
      isOptimizationGoalMixed: false,
      isBidStrategyMixed: false,
      isBidValueMixed: false,
      spend: 1180,
      purchases: 28,
      revenue: 2780,
      roas: 2.36,
      cpa: 42.14,
      ctr: 1.18,
      cpm: 14.7,
      impressions: 80210,
      clicks: 946,
      inlineLinkClickCtr: 1.02,
    },
    {
      id: "m-as-3",
      accountId: "demo-meta-1",
      name: "UGC Broad Mixed",
      campaignId: "m-c2",
      status: "ACTIVE",
      budgetLevel: "adset",
      dailyBudget: null,
      lifetimeBudget: null,
      optimizationGoal: null,
      bidStrategyType: "bid_cap",
      bidStrategyLabel: "Bid Cap",
      manualBidAmount: null,
      previousManualBidAmount: null,
      bidValue: null,
      bidValueFormat: null,
      previousBidValue: null,
      previousBidValueFormat: null,
      previousBidValueCapturedAt: null,
      previousDailyBudget: null,
      previousLifetimeBudget: null,
      previousBudgetCapturedAt: null,
      isBudgetMixed: true,
      isConfigMixed: true,
      isOptimizationGoalMixed: true,
      isBidStrategyMixed: false,
      isBidValueMixed: true,
      spend: 1680,
      purchases: 54,
      revenue: 6010,
      roas: 3.58,
      cpa: 31.11,
      ctr: 1.66,
      cpm: 15.1,
      impressions: 104000,
      clicks: 1724,
      inlineLinkClickCtr: 1.49,
    },
    {
      id: "m-as-4",
      accountId: "demo-meta-1",
      name: "UGC Catalog Visitors",
      campaignId: "m-c2",
      status: "ACTIVE",
      budgetLevel: "adset",
      dailyBudget: 700,
      lifetimeBudget: null,
      optimizationGoal: "Add To Cart",
      bidStrategyType: "bid_cap",
      bidStrategyLabel: "Bid Cap",
      manualBidAmount: 2100,
      previousManualBidAmount: 1800,
      bidValue: 2100,
      bidValueFormat: "currency",
      previousBidValue: 1800,
      previousBidValueFormat: "currency",
      previousBidValueCapturedAt: "2026-04-06T10:00:00.000Z",
      previousDailyBudget: 600,
      previousLifetimeBudget: null,
      previousBudgetCapturedAt: "2026-04-06T10:00:00.000Z",
      isBudgetMixed: false,
      isConfigMixed: false,
      isOptimizationGoalMixed: false,
      isBidStrategyMixed: false,
      isBidValueMixed: false,
      spend: 940,
      purchases: 18,
      revenue: 1210,
      roas: 1.29,
      cpa: 52.22,
      ctr: 0.98,
      cpm: 16.3,
      impressions: 71400,
      clicks: 700,
      inlineLinkClickCtr: 0.84,
    },
    {
      id: "m-as-5",
      accountId: "demo-meta-1",
      name: "Retargeting 30d Visitors",
      campaignId: "m-c3",
      status: "ACTIVE",
      budgetLevel: "adset",
      dailyBudget: 1100,
      lifetimeBudget: null,
      optimizationGoal: "Purchase",
      bidStrategyType: "manual_bid",
      bidStrategyLabel: "Manual Bid",
      manualBidAmount: 2600,
      previousManualBidAmount: 2400,
      bidValue: 2600,
      bidValueFormat: "currency",
      previousBidValue: 2400,
      previousBidValueFormat: "currency",
      previousBidValueCapturedAt: "2026-03-28T10:00:00.000Z",
      previousDailyBudget: 950,
      previousLifetimeBudget: null,
      previousBudgetCapturedAt: "2026-03-28T10:00:00.000Z",
      isBudgetMixed: false,
      isConfigMixed: false,
      isOptimizationGoalMixed: false,
      isBidStrategyMixed: false,
      isBidValueMixed: false,
      spend: 1420,
      purchases: 92,
      revenue: 6710,
      roas: 4.73,
      cpa: 15.43,
      ctr: 2.94,
      cpm: 12.1,
      impressions: 98200,
      clicks: 2880,
      inlineLinkClickCtr: 2.61,
    },
    {
      id: "m-as-6",
      accountId: "demo-meta-1",
      name: "Winback Past Buyers",
      campaignId: "m-c3",
      status: "PAUSED",
      budgetLevel: "adset",
      dailyBudget: 500,
      lifetimeBudget: null,
      optimizationGoal: "Purchase",
      bidStrategyType: "manual_bid",
      bidStrategyLabel: "Manual Bid",
      manualBidAmount: 2200,
      previousManualBidAmount: 2200,
      bidValue: 2200,
      bidValueFormat: "currency",
      previousBidValue: 2200,
      previousBidValueFormat: "currency",
      previousBidValueCapturedAt: "2026-03-26T10:00:00.000Z",
      previousDailyBudget: 500,
      previousLifetimeBudget: null,
      previousBudgetCapturedAt: "2026-03-26T10:00:00.000Z",
      isBudgetMixed: false,
      isConfigMixed: false,
      isOptimizationGoalMixed: false,
      isBidStrategyMixed: false,
      isBidValueMixed: false,
      spend: 620,
      purchases: 31,
      revenue: 2540,
      roas: 4.1,
      cpa: 20,
      ctr: 2.22,
      cpm: 11.2,
      impressions: 45110,
      clicks: 1002,
      inlineLinkClickCtr: 1.94,
    },
    {
      id: "m-as-7",
      accountId: "demo-meta-1",
      name: "Lifestyle Lead Capture",
      campaignId: "m-c4",
      status: "PAUSED",
      budgetLevel: "adset",
      dailyBudget: 400,
      lifetimeBudget: null,
      optimizationGoal: "Lead",
      bidStrategyType: "lowest_cost",
      bidStrategyLabel: "Lowest Cost",
      manualBidAmount: null,
      previousManualBidAmount: null,
      bidValue: null,
      bidValueFormat: null,
      previousBidValue: null,
      previousBidValueFormat: null,
      previousBidValueCapturedAt: null,
      previousDailyBudget: 400,
      previousLifetimeBudget: null,
      previousBudgetCapturedAt: "2026-03-20T10:00:00.000Z",
      isBudgetMixed: false,
      isConfigMixed: false,
      isOptimizationGoalMixed: false,
      isBidStrategyMixed: false,
      isBidValueMixed: false,
      spend: 780,
      purchases: 6,
      revenue: 720,
      roas: 0.92,
      cpa: 130,
      ctr: 0.74,
      cpm: 14.4,
      impressions: 54100,
      clicks: 400,
      inlineLinkClickCtr: 0.68,
    },
    {
      id: "m-as-8",
      accountId: "demo-meta-1",
      name: "Summer Promo Core",
      campaignId: "m-c5",
      status: "ACTIVE",
      budgetLevel: "adset",
      dailyBudget: 650,
      lifetimeBudget: null,
      optimizationGoal: "Purchase",
      bidStrategyType: "target_roas",
      bidStrategyLabel: "Target ROAS",
      manualBidAmount: null,
      previousManualBidAmount: null,
      bidValue: 3.5,
      bidValueFormat: "roas",
      previousBidValue: 3.1,
      previousBidValueFormat: "roas",
      previousBidValueCapturedAt: "2026-04-02T10:00:00.000Z",
      previousDailyBudget: 550,
      previousLifetimeBudget: null,
      previousBudgetCapturedAt: "2026-04-02T10:00:00.000Z",
      isBudgetMixed: false,
      isConfigMixed: false,
      isOptimizationGoalMixed: false,
      isBidStrategyMixed: false,
      isBidValueMixed: false,
      spend: 860,
      purchases: 24,
      revenue: 2370,
      roas: 2.76,
      cpa: 35.83,
      ctr: 1.34,
      cpm: 13.4,
      impressions: 62300,
      clicks: 835,
      inlineLinkClickCtr: 1.16,
    },
  ];

  if (!campaignId) return rows;
  return rows.filter((row) => row.campaignId === campaignId);
}

export function getDemoMetaCreatives() {
  const base = DEMO_PRODUCTS.slice(0, 8);
  const scenarios = [
    {
      campaignId: "m-c1",
      campaignName: "Backpack Video Ads",
      adSetName: "Backpack Prospecting",
      launchDate: "2026-02-15",
      storyId: "story_backpack_scale",
      postId: "post_backpack_scale",
      copy: "Built for real trips. Pack once, organize everything, move faster.",
      headline: "Pack Once | Free Shipping",
      tags: ["winner", "scale-ready"],
      angle: "utility",
      hook: "travel_pack",
      format: "video",
      spend: 840,
      purchaseValue: 3360,
      roas: 4,
      cpa: 17.87,
      cpcLink: 0.66,
      cpm: 14.2,
      ctrAll: 2.88,
      purchases: 47,
      impressions: 41800,
      linkClicks: 1205,
      addToCart: 286,
      thumbstop: 33,
      video25: 68,
      video50: 47,
      video75: 34,
      video100: 18,
    },
    {
      campaignId: "m-c1",
      campaignName: "Backpack Video Ads",
      adSetName: "Backpack Prospecting",
      launchDate: "2026-02-17",
      storyId: "story_backpack_scale",
      postId: "post_backpack_scale",
      copy: "Built for real trips. Pack once, organize everything, move faster.",
      headline: "Pack Once | Free Shipping",
      tags: ["winner", "stable"],
      angle: "utility",
      hook: "travel_pack",
      format: "image",
      spend: 610,
      purchaseValue: 2196,
      roas: 3.6,
      cpa: 20.33,
      cpcLink: 0.7,
      cpm: 13.9,
      ctrAll: 2.36,
      purchases: 30,
      impressions: 38900,
      linkClicks: 918,
      addToCart: 228,
      thumbstop: 24,
      video25: 0,
      video50: 0,
      video75: 0,
      video100: 0,
    },
    {
      campaignId: "m-c2",
      campaignName: "UGC Travel Creatives",
      adSetName: "UGC Broad",
      launchDate: "2026-04-05",
      storyId: "story_ugc_test",
      postId: "post_ugc_test",
      copy: "Real carry test. See how the bag performs on a four-day trip.",
      headline: "UGC Carry Test",
      tags: ["test-only", "learning"],
      angle: "proof",
      hook: "ugc_carry_test",
      format: "video",
      spend: 92,
      purchaseValue: 214,
      roas: 2.33,
      cpa: 46,
      cpcLink: 0.84,
      cpm: 15.2,
      ctrAll: 1.41,
      purchases: 2,
      impressions: 6540,
      linkClicks: 109,
      addToCart: 19,
      thumbstop: 27,
      video25: 61,
      video50: 43,
      video75: 28,
      video100: 15,
    },
    {
      campaignId: "m-c2",
      campaignName: "UGC Travel Creatives",
      adSetName: "UGC Broad",
      launchDate: "2026-03-14",
      storyId: "story_ugc_test",
      postId: "post_ugc_test",
      copy: "Real carry test. See how the bag performs on a four-day trip.",
      headline: "UGC Carry Test",
      tags: ["blocked"],
      angle: "proof",
      hook: "ugc_carry_test",
      format: "image",
      spend: 462,
      purchaseValue: 286,
      roas: 0.62,
      cpa: 154,
      cpcLink: 1.38,
      cpm: 16.1,
      ctrAll: 0.74,
      purchases: 3,
      impressions: 37200,
      linkClicks: 274,
      addToCart: 21,
      thumbstop: 10,
      video25: 0,
      video50: 0,
      video75: 0,
      video100: 0,
    },
    {
      campaignId: "m-c2",
      campaignName: "UGC Travel Creatives",
      adSetName: "UGC Broad",
      launchDate: "2026-02-11",
      storyId: "story_refresh_needed",
      postId: "post_refresh_needed",
      copy: "Adventure layout. More gear, less clutter, faster airport moves.",
      headline: "Adventure Layout",
      tags: ["fatigue", "refresh"],
      angle: "adventure",
      hook: "gear_layout",
      format: "video",
      spend: 704,
      purchaseValue: 1548,
      roas: 2.2,
      cpa: 44,
      cpcLink: 0.89,
      cpm: 14.8,
      ctrAll: 1.12,
      purchases: 16,
      impressions: 55100,
      linkClicks: 887,
      addToCart: 144,
      thumbstop: 18,
      video25: 52,
      video50: 33,
      video75: 20,
      video100: 11,
    },
    {
      campaignId: "m-c1",
      campaignName: "Backpack Video Ads",
      adSetName: "Backpack Prospecting",
      launchDate: "2026-01-20",
      storyId: "story_refresh_needed",
      postId: "post_refresh_needed",
      copy: "Adventure layout. More gear, less clutter, faster airport moves.",
      headline: "Adventure Layout",
      tags: ["comeback", "paused"],
      angle: "adventure",
      hook: "gear_layout",
      format: "image",
      spend: 4,
      purchaseValue: 0,
      roas: 0,
      cpa: 0,
      cpcLink: 0.48,
      cpm: 8.1,
      ctrAll: 0.41,
      purchases: 0,
      impressions: 180,
      linkClicks: 12,
      addToCart: 1,
      thumbstop: 6,
      video25: 0,
      video50: 0,
      video75: 0,
      video100: 0,
    },
    {
      campaignId: "m-c4",
      campaignName: "Adventure Lifestyle Campaign",
      adSetName: "Lifestyle Broad",
      launchDate: "2026-02-28",
      storyId: "story_lifestyle_hold",
      postId: "post_lifestyle_hold",
      copy: "City to trail in one carry. Lightweight enough for daily use.",
      headline: "City To Trail",
      tags: ["blocked"],
      angle: "lifestyle",
      hook: "city_trail",
      format: "video",
      spend: 182,
      purchaseValue: 146,
      roas: 0.8,
      cpa: 91,
      cpcLink: 1.12,
      cpm: 15.8,
      ctrAll: 0.93,
      purchases: 2,
      impressions: 16200,
      linkClicks: 151,
      addToCart: 9,
      thumbstop: 14,
      video25: 47,
      video50: 30,
      video75: 18,
      video100: 9,
    },
    {
      campaignId: "m-c5",
      campaignName: "Summer Promo Core",
      adSetName: "Promo Broad",
      launchDate: "2026-03-30",
      storyId: "story_promo_validate",
      postId: "post_promo_validate",
      copy: "Summer promo carry kit. Faster checkout, lighter pack, same capacity.",
      headline: "Summer Promo Carry",
      tags: ["validating"],
      angle: "promo",
      hook: "promo_carry",
      format: "image",
      spend: 244,
      purchaseValue: 574,
      roas: 2.35,
      cpa: 30.5,
      cpcLink: 0.74,
      cpm: 13.6,
      ctrAll: 1.96,
      purchases: 8,
      impressions: 18200,
      linkClicks: 358,
      addToCart: 62,
      thumbstop: 19,
      video25: 0,
      video50: 0,
      video75: 0,
      video100: 0,
    },
  ] as const;

  const rows = base.map((p, i) => {
    const scenario = scenarios[i]!;
    const isVideo = scenario.format === "video";
    return {
      id: `m-ad-${i + 1}`,
      creative_id: `m-cr-${i + 1}`,
      account_id: "act_210009998877",
      account_name: "UrbanTrail DTC",
      campaign_id: scenario.campaignId,
      campaign_name: scenario.campaignName,
      adset_id: `m-as-${i + 1}`,
      adset_name: scenario.adSetName,
      currency: "USD",
      name: `${p.title} Creative ${i + 1}`,
      object_story_id: scenario.storyId,
      effective_object_story_id: scenario.storyId,
      post_id: scenario.postId,
      copy_text: scenario.copy,
      copy_variants: [scenario.copy],
      headline_variants: [scenario.headline],
      description_variants: ["Try 30 days risk-free."],
      copy_source: "primary_text",
      preview_url: p.image_url,
      preview_source: "image_url",
      thumbnail_url: p.image_url,
      image_url: p.image_url,
      table_thumbnail_url: p.image_url,
      card_preview_url: p.image_url,
      is_catalog: false,
      preview_state: "preview",
      preview: { render_mode: "image", image_url: p.image_url, video_url: null, poster_url: p.image_url, source: "image_url", is_catalog: false },
      launch_date: scenario.launchDate,
      tags: scenario.tags,
      ai_tags: {
        assetType: [isVideo ? "video_style" : "static_image"],
        visualFormat: [isVideo ? "lifestyle" : "product_focus"],
        messagingAngle: [scenario.angle],
        hookTactic: [scenario.hook],
        offerType: [scenario.angle === "promo" ? "limited_offer" : "none"],
      },
      format: scenario.format,
      creative_type: isVideo ? "video" : "feed",
      creative_type_label: isVideo ? "Video" : "Feed",
      creative_delivery_type: "standard",
      creative_visual_format: isVideo ? "video" : "image",
      creative_primary_type: isVideo ? "video" : "standard",
      creative_primary_label: isVideo ? "Video" : "Standard",
      creative_secondary_type: null,
      creative_secondary_label: null,
      classification_signals: null,
      spend: scenario.spend,
      purchase_value: scenario.purchaseValue,
      roas: scenario.roas,
      cpa: scenario.cpa,
      cpc_link: scenario.cpcLink,
      cpm: scenario.cpm,
      ctr_all: scenario.ctrAll,
      purchases: scenario.purchases,
      impressions: scenario.impressions,
      link_clicks: scenario.linkClicks,
      add_to_cart: scenario.addToCart,
      thumbstop: scenario.thumbstop,
      click_to_atc: scenario.linkClicks > 0 ? scenario.addToCart / scenario.linkClicks : 0,
      atc_to_purchase: scenario.addToCart > 0 ? scenario.purchases / scenario.addToCart : 0,
      video25: scenario.video25,
      video50: scenario.video50,
      video75: scenario.video75,
      video100: scenario.video100,
    };
  });
  return { status: "ok", rows };
}

export function getDemoMetaCopies() {
  const creativeRows = getDemoMetaCreatives().rows;
  const rows = creativeRows.map((r: any) => ({
    id: `copy_${r.id}`,
    ad_id: r.id,
    creative_id: r.creative_id,
    post_id: null,
    name: r.name,
    campaign_id: r.campaign_id,
    campaign_name: r.campaign_name,
    adset_id: r.adset_id,
    adset_name: r.adset_name,
    account_id: r.account_id,
    account_name: r.account_name,
    currency: "USD",
    launch_date: r.launch_date,
    primary_text: r.copy_text,
    headline: r.headline_variants[0],
    description: r.description_variants[0],
    copy_text: r.copy_text,
    copy_variants: r.copy_variants,
    headline_variants: r.headline_variants,
    description_variants: r.description_variants,
    normalized_copy_key: String(r.copy_text).toLowerCase(),
    copy_source: "primary_text",
    copy_asset_type: "bundle",
    copy_debug_sources: ["demo_seed"],
    unresolved_reason: null,
    preview_url: r.preview_url,
    thumbnail_url: r.thumbnail_url,
    image_url: r.image_url,
    table_thumbnail_url: r.table_thumbnail_url,
    card_preview_url: r.card_preview_url,
    is_catalog: false,
    preview_state: r.preview_state,
    preview: r.preview,
    spend: r.spend,
    purchase_value: r.purchase_value,
    roas: r.roas,
    cpa: r.cpa,
    cpc_link: r.cpc_link,
    cpm: r.cpm,
    ctr_all: r.ctr_all,
    purchases: r.purchases,
    impressions: r.impressions,
    link_clicks: r.link_clicks,
    add_to_cart: r.add_to_cart,
    click_to_purchase: r.link_clicks > 0 ? (r.purchases / r.link_clicks) * 100 : 0,
    thumbstop: r.thumbstop,
    first_frame_retention: r.thumbstop,
    aov: r.purchases > 0 ? r.purchase_value / r.purchases : null,
    click_to_atc_ratio: r.link_clicks > 0 ? (r.add_to_cart / r.link_clicks) * 100 : null,
    atc_to_purchase_ratio: r.add_to_cart > 0 ? (r.purchases / r.add_to_cart) * 100 : null,
  }));
  return {
    status: "ok",
    rows,
    media_hydrated: true,
    snapshot_level: "full",
    snapshot_source: "live",
    freshness_state: "fresh",
    preview_coverage: {
      totalCreatives: rows.length,
      previewReadyCount: rows.length,
      previewMissingCount: 0,
      previewCoverage: 1,
    },
    meta: {
      group_by: "copy",
      sort: "spend",
      unresolved_filtered_count: 0,
      source_rows_count: rows.length,
      returned_rows_count: rows.length,
    },
  };
}

export function getDemoGeoOverview() {
  return {
    kpis: {
      aiSessions: 1720,
      aiEngagementRate: 0.684,
      aiPurchaseCvr: 0.032,
      geoScore: 74,
      aiPageCount: 23,
      topAiSource: "ChatGPT",
      siteAvgEngagementRate: 0.562,
      siteAvgPurchaseCvr: 0.0246,
      aiStyleQueryCount: 142,
      totalQueryCount: 308,
    },
    top3Priorities: [
      {
        title: "Improve CTR on near-page-1 commercial queries",
        description: "High impressions but weak snippet CTR on high-intent terms.",
        priority: "high",
        effort: "medium",
        impact: "+20-35% organic clicks",
      },
      {
        title: "Expand carry-on backpack topic cluster",
        description: "Coverage is moderate while demand is rising quickly.",
        priority: "medium",
        effort: "medium",
        impact: "+12-20% AI visibility",
      },
      {
        title: "Scale high-value ChatGPT referral pages",
        description: "Best AI source has strong CVR but limited page coverage.",
        priority: "medium",
        effort: "low",
        impact: "+$2.8k assisted revenue",
      },
    ],
    highlights: {
      strongestGeoQuery: {
        query: "best travel backpack",
        geoScore: 84,
        impressions: 12240,
      },
      strongestGeoTopic: {
        topic: "travel backpack buying guides",
        geoScore: 83,
        impressions: 21240,
        coverageStrength: "Moderate",
      },
      highestAiValueSource: {
        engine: "ChatGPT",
        label: "strong",
        score: 84,
      },
    },
    insights: [
      { severity: "positive", title: "AI traffic quality is strong", description: "AI sessions convert above site average with deeper engagement." },
      { severity: "opportunity", title: "Near-page-1 cluster opportunity", description: "Commercial query cluster is ranking 7-11 with substantial impressions." },
    ],
  };
}

export function getDemoGeoTrafficSources() {
  return {
    sources: [
      { engine: "ChatGPT", sessions: 760, engagedSessions: 548, engagementRate: 0.721, purchases: 29, revenue: 2620, purchaseCvr: 0.038, aiTrafficValueScore: 84, aiTrafficValueLabel: "strong", momentum: { status: "rising", label: "Rising", score: 68, growthRate: 0.23 }, recommendation: "Scale FAQ-rich landing pages for ChatGPT query patterns." },
      { engine: "Perplexity", sessions: 350, engagedSessions: 232, engagementRate: 0.663, purchases: 10, revenue: 910, purchaseCvr: 0.029, aiTrafficValueScore: 72, aiTrafficValueLabel: "promising", momentum: { status: "stable", label: "Stable", score: 48, growthRate: 0.04 }, recommendation: "Improve citation-targeted headings and source clarity." },
      { engine: "Gemini", sessions: 280, engagedSessions: 190, engagementRate: 0.679, purchases: 8, revenue: 710, purchaseCvr: 0.029, aiTrafficValueScore: 70, aiTrafficValueLabel: "promising", momentum: { status: "rising", label: "Rising", score: 61, growthRate: 0.17 }, recommendation: "Publish comparison-style pages for product intent queries." },
      { engine: "Claude", sessions: 190, engagedSessions: 129, engagementRate: 0.679, purchases: 6, revenue: 520, purchaseCvr: 0.032, aiTrafficValueScore: 68, aiTrafficValueLabel: "promising", momentum: { status: "stable", label: "Stable", score: 46, growthRate: 0.03 }, recommendation: "Expand long-form guides with concrete examples." },
      { engine: "Copilot", sessions: 140, engagedSessions: 89, engagementRate: 0.636, purchases: 3, revenue: 260, purchaseCvr: 0.021, aiTrafficValueScore: 52, aiTrafficValueLabel: "weak", momentum: { status: "stable", label: "Stable", score: 41, growthRate: 0.02 }, recommendation: "Test intent-matching snippets on high-impression pages." },
    ],
  };
}

export function getDemoGeoPages() {
  return {
    pages: [
      { path: "/blog/best-travel-backpacks", aiSessions: 312, engagedSessions: 232, engagementRate: 0.744, purchases: 9, revenue: 780, purchaseCvr: 0.0288, totalSessions: 4510, geoScore: 82, momentum: { status: "breakout", label: "Breakout", score: 88, growthRate: 0.42 }, priority: "high", effort: "medium", confidence: "high", strongestSignal: "Breakout growth", recommendation: "Add commercial comparison table and top-pick CTA." },
      { path: "/products/explorer-backpack", aiSessions: 278, engagedSessions: 174, engagementRate: 0.626, purchases: 14, revenue: 1246, purchaseCvr: 0.0504, totalSessions: 8200, geoScore: 79, momentum: { status: "rising", label: "Rising", score: 66, growthRate: 0.22 }, priority: "high", effort: "low", confidence: "high", strongestSignal: "Strong AI CVR", recommendation: "Scale with engine-specific FAQ and buying intent copy blocks." },
      { path: "/blog/how-to-pack-for-hiking", aiSessions: 224, engagedSessions: 161, engagementRate: 0.719, purchases: 4, revenue: 260, purchaseCvr: 0.0179, totalSessions: 3920, geoScore: 71, momentum: { status: "stable", label: "Stable", score: 49, growthRate: 0.05 }, priority: "medium", effort: "medium", confidence: "medium", strongestSignal: "High engagement", recommendation: "Introduce product module midway to lift informational-to-commercial conversion." },
    ],
  };
}

export function getDemoGeoQueries() {
  const queries = [
    { query: "best travel backpack", clicks: 682, impressions: 12240, ctr: 0.0557, position: 5.9, intent: "Commercial", isAiStyle: true, opportunityLabel: "near_page_one", geoScore: 84, priority: "high", confidence: "high", recommendation: "Push this query into top 3 with refreshed title and comparison schema.", momentum: { status: "rising", label: "Rising", score: 71, growthRate: 0.21 }, classification: { intent: "commercial", intentLabel: "Commercial", format: "comparison", formatLabel: "Comparison", confidence: "high", signals: ["best", "vs"] } },
    { query: "waterproof hiking backpack", clicks: 428, impressions: 9830, ctr: 0.0435, position: 7.1, intent: "Transactional", isAiStyle: true, opportunityLabel: "ctr_opportunity", geoScore: 79, priority: "high", confidence: "high", recommendation: "Add durability proof and use-case snippets to improve CTR.", momentum: { status: "stable", label: "Stable", score: 47, growthRate: 0.03 }, classification: { intent: "transactional", intentLabel: "Transactional", format: "buying_guide", formatLabel: "Buying Guide", confidence: "high", signals: ["waterproof"] } },
    { query: "carry on backpack for travel", clicks: 319, impressions: 7310, ctr: 0.0436, position: 8.2, intent: "Commercial", isAiStyle: true, opportunityLabel: "near_page_one", geoScore: 75, priority: "medium", confidence: "medium", recommendation: "Near page 1; enrich FAQ and feature summary blocks.", momentum: { status: "rising", label: "Rising", score: 64, growthRate: 0.18 }, classification: { intent: "commercial", intentLabel: "Commercial", format: "how_to", formatLabel: "How-to", confidence: "medium", signals: ["carry on"] } },
    { query: "travel backpack vs duffel", clicks: 206, impressions: 5640, ctr: 0.0365, position: 9.4, intent: "Informational", isAiStyle: true, opportunityLabel: "comparison_content", geoScore: 72, priority: "medium", confidence: "medium", recommendation: "Comparison-intent query: publish dedicated comparison page section.", momentum: { status: "stable", label: "Stable", score: 44, growthRate: 0.02 }, classification: { intent: "informational", intentLabel: "Informational", format: "comparison", formatLabel: "Comparison", confidence: "medium", signals: ["vs"] } },
  ];
  return { queries, total: queries.length };
}

export function getDemoGeoTopics() {
  return {
    topics: [
      {
        topic: "travel backpack buying guides",
        impressions: 21240,
        clicks: 1231,
        avgPosition: 6.8,
        queryCount: 18,
        coverageStrength: "Moderate",
        queries: ["best travel backpack", "travel backpack vs duffel", "carry on backpack for travel"],
        geoScore: 83,
        priority: "high",
        confidence: "high",
        informationalDensity: 0.72,
        coverageGap: "medium",
        authorityStrength: "Moderate",
        momentum: { status: "rising", label: "Rising", score: 69, growthRate: 0.2 },
        recommendation: { title: "Build cluster support pages", effort: "medium", impact: "high", expectedOutcome: "Higher AI citation frequency + CTR lift" },
      },
      {
        topic: "carry-on travel packing",
        impressions: 11310,
        clicks: 620,
        avgPosition: 8.1,
        queryCount: 11,
        coverageStrength: "Weak",
        queries: ["carry on bag checklist", "carry on backpack for travel", "weekend trip packing list"],
        geoScore: 74,
        priority: "high",
        confidence: "medium",
        informationalDensity: 0.68,
        coverageGap: "high",
        authorityStrength: "Weak",
        momentum: { status: "breakout", label: "Breakout", score: 87, growthRate: 0.39 },
        recommendation: { title: "Expand guide depth and FAQs", effort: "medium", impact: "high", expectedOutcome: "Top-5 query coverage for commercial intent terms" },
      },
      {
        topic: "hiking pack organization",
        impressions: 6420,
        clicks: 442,
        avgPosition: 5.3,
        queryCount: 9,
        coverageStrength: "Strong",
        queries: ["how to pack a hiking backpack", "hiking backpack organization tips", "backpacking gear layout"],
        geoScore: 69,
        priority: "medium",
        confidence: "medium",
        informationalDensity: 0.79,
        coverageGap: "low",
        authorityStrength: "Strong",
        momentum: { status: "stable", label: "Stable", score: 51, growthRate: 0.05 },
        recommendation: { title: "Add advanced FAQ snippets", effort: "low", impact: "medium", expectedOutcome: "Defend ranking and improve long-tail discovery" },
      },
    ],
    total: 3,
  };
}

export function getDemoGeoOpportunities() {
  const opportunities = [
    { type: "content", priority: "high", effort: "medium", confidence: "high", impact: "+20-35% CTR", title: "High-impression near-page-1 queries need better titles", target: "best travel backpack cluster", evidence: "12k+ impressions at avg position 5.9 with CTR under expected benchmark.", recommendation: "Rewrite titles + meta descriptions for stronger value proposition and specificity.", whyItMatters: "Improving CTR on existing visibility is the fastest growth lever." },
    { type: "conversion", priority: "high", effort: "low", confidence: "high", impact: "+$2.8k AI-assisted revenue", title: "Top AI page has room for conversion lift", target: "/blog/best-travel-backpacks", evidence: "High AI sessions and engagement, but informational traffic under-monetized.", recommendation: "Add sticky product recommendation module and comparison CTA.", whyItMatters: "Captures purchase intent from high-quality AI traffic." },
    { type: "traffic", priority: "medium", effort: "medium", confidence: "medium", impact: "+15% AI traffic share", title: "Scale ChatGPT citation footprint", target: "ChatGPT source", evidence: "Strong value score and rising sessions concentrated on 3 pages.", recommendation: "Publish adjacent answer-first content for related travel queries.", whyItMatters: "Expands share of AI discovery beyond current winners." },
  ];
  return { opportunities, total: opportunities.length };
}

export function getDemoSearchConsoleAnalytics() {
  const rows = [
    { query: "best travel backpack", page: "/blog/best-travel-backpacks", clicks: 682, impressions: 12240, ctr: 0.0557, position: 5.9 },
    { query: "waterproof hiking backpack", page: "/products/waterproof-backpack", clicks: 428, impressions: 9830, ctr: 0.0435, position: 7.1 },
    { query: "carry on backpack for travel", page: "/products/carry-on-backpack", clicks: 319, impressions: 7310, ctr: 0.0436, position: 8.2 },
    { query: "backpack with laptop compartment", page: "/products/laptop-travel-bag", clicks: 287, impressions: 6120, ctr: 0.0469, position: 6.4 },
    { query: "lightweight travel bag", page: "/products/daypack-lite", clicks: 196, impressions: 5400, ctr: 0.0363, position: 9.7 },
    { query: "best backpack for weekend trips", page: "/blog/best-travel-backpacks", clicks: 175, impressions: 3890, ctr: 0.045, position: 8.8 },
    { query: "how to pack a hiking backpack", page: "/blog/how-to-pack-for-hiking", clicks: 261, impressions: 7140, ctr: 0.0366, position: 5.1 },
    { query: "travel backpack vs duffel", page: "/blog/travel-backpack-vs-duffel", clicks: 206, impressions: 5640, ctr: 0.0365, position: 9.4 },
  ];
  return { rows };
}

export function getDemoMetaBreakdowns() {
  return {
    status: "ok" as const,
    age: [
      { key: "25-34", label: "25–34", spend: 8620, purchases: 342, revenue: 28940, clicks: 14820, impressions: 612000 },
      { key: "18-24", label: "18–24", spend: 5140, purchases: 184, revenue: 14280, clicks: 9630, impressions: 448000 },
      { key: "35-44", label: "35–44", spend: 4980, purchases: 221, revenue: 19120, clicks: 11240, impressions: 389000 },
      { key: "45-54", label: "45–54", spend: 2690, purchases: 98, revenue: 7860, clicks: 5820, impressions: 241000 },
      { key: "55+", label: "55+", spend: 990, purchases: 31, revenue: 2240, clicks: 1840, impressions: 91000 },
    ],
    location: [
      { key: "US", label: "United States", spend: 16480, purchases: 634, revenue: 54280, clicks: 29420, impressions: 1182000 },
      { key: "CA", label: "Canada", spend: 3260, purchases: 117, revenue: 9740, clicks: 5610, impressions: 228000 },
      { key: "GB", label: "United Kingdom", spend: 1980, purchases: 68, revenue: 5820, clicks: 3430, impressions: 138000 },
      { key: "AU", label: "Australia", spend: 700, purchases: 24, revenue: 1820, clicks: 1180, impressions: 49000 },
    ],
    placement: [
      { key: "facebook_feed", label: "Facebook Feed", spend: 10240, purchases: 418, revenue: 35840, clicks: 18620, impressions: 742000 },
      { key: "instagram_feed", label: "Instagram Feed", spend: 6420, purchases: 242, revenue: 20480, clicks: 11440, impressions: 461000 },
      { key: "instagram_stories", label: "Instagram Stories", spend: 3420, purchases: 118, revenue: 9640, clicks: 6480, impressions: 382000 },
      { key: "facebook_marketplace", label: "Facebook Marketplace", spend: 1340, purchases: 45, revenue: 3020, clicks: 2380, impressions: 105000 },
      { key: "audience_network", label: "Audience Network", spend: 1000, purchases: 33, revenue: 2660, clicks: 1980, impressions: 91000 },
    ],
    budget: {
      campaign: [
        { key: "m-c1", label: "Backpack Video Ads", spend: 7140 },
        { key: "m-c2", label: "UGC Travel Creatives", spend: 5240 },
        { key: "m-c3", label: "Remarketing Campaign", spend: 4260 },
        { key: "m-c4", label: "Adventure Lifestyle Campaign", spend: 3180 },
        { key: "m-c5", label: "Summer Gear Promotion", spend: 1600 },
      ],
      adset: [
        { key: "m-as-1", label: "Backpack Prospecting", spend: 4820 },
        { key: "m-as-2", label: "UGC Broad", spend: 3640 },
        { key: "m-as-3", label: "Retargeting 7D", spend: 3180 },
        { key: "m-as-4", label: "Lookalike 1%", spend: 2910 },
        { key: "m-as-5", label: "Summer Hiking Interest", spend: 2470 },
        { key: "m-as-6", label: "Lifestyle Broad", spend: 1400 },
      ],
    },
    audience: { available: true },
    products: { available: true },
  };
}

export function getDemoMetaSummary() {
  const now = new Date().toISOString();
  return {
    freshness: { state: "ready", updatedAt: now, lastSyncedAt: now },
    historicalSync: {
      progressPercent: 100,
      completedDays: 90,
      totalDays: 90,
      readyThroughDate: "2026-03-27",
      state: "ready",
    },
    isPartial: false,
    totals: {
      spend: 21420,
      revenue: 72890,
      conversions: 816,
      roas: 3.4,
      cpa: 26.25,
      ctr: 2.81,
      cpc: 0.44,
      impressions: 1321400,
      clicks: 48620,
      reach: 910000,
    },
    accounts: [
      {
        providerAccountId: "act_210009998877",
        accountName: "UrbanTrail DTC",
        currency: "USD",
        timezone: "America/Los_Angeles",
        spend: 21420,
        revenue: 72890,
        conversions: 816,
        roas: 3.4,
      },
    ],
  };
}

export function getDemoMetaTrends() {
  const now = new Date().toISOString();
  const points = [
    { date: "2026-02-10", spend: 549, revenue: 1821, conversions: 20, roas: 3.32, cpa: 27.45, ctr: 2.74, cpc: 0.43, impressions: 74100, clicks: 1276 },
    { date: "2026-02-11", spend: 588, revenue: 1926, conversions: 22, roas: 3.27, cpa: 26.73, ctr: 2.79, cpc: 0.44, impressions: 76400, clicks: 1336 },
    { date: "2026-02-12", spend: 611, revenue: 2019, conversions: 23, roas: 3.31, cpa: 26.57, ctr: 2.81, cpc: 0.44, impressions: 78200, clicks: 1387 },
    { date: "2026-02-13", spend: 638, revenue: 2100, conversions: 24, roas: 3.29, cpa: 26.58, ctr: 2.83, cpc: 0.45, impressions: 79800, clicks: 1418 },
    { date: "2026-02-14", spend: 672, revenue: 2233, conversions: 25, roas: 3.32, cpa: 26.88, ctr: 2.84, cpc: 0.45, impressions: 81300, clicks: 1493 },
    { date: "2026-02-15", spend: 689, revenue: 2193, conversions: 25, roas: 3.18, cpa: 27.56, ctr: 2.79, cpc: 0.44, impressions: 82100, clicks: 1566 },
    { date: "2026-02-16", spend: 661, revenue: 2146, conversions: 24, roas: 3.25, cpa: 27.54, ctr: 2.77, cpc: 0.44, impressions: 80900, clicks: 1503 },
    { date: "2026-02-17", spend: 683, revenue: 2268, conversions: 26, roas: 3.32, cpa: 26.27, ctr: 2.81, cpc: 0.44, impressions: 81800, clicks: 1552 },
    { date: "2026-02-18", spend: 706, revenue: 2309, conversions: 27, roas: 3.27, cpa: 26.15, ctr: 2.83, cpc: 0.45, impressions: 83200, clicks: 1570 },
    { date: "2026-02-19", spend: 694, revenue: 2291, conversions: 26, roas: 3.3, cpa: 26.69, ctr: 2.82, cpc: 0.45, impressions: 82500, clicks: 1543 },
    { date: "2026-02-20", spend: 711, revenue: 2326, conversions: 26, roas: 3.27, cpa: 27.35, ctr: 2.84, cpc: 0.45, impressions: 83700, clicks: 1580 },
    { date: "2026-02-21", spend: 722, revenue: 2361, conversions: 27, roas: 3.27, cpa: 26.74, ctr: 2.85, cpc: 0.45, impressions: 84200, clicks: 1604 },
    { date: "2026-02-22", spend: 734, revenue: 2407, conversions: 27, roas: 3.28, cpa: 27.19, ctr: 2.86, cpc: 0.45, impressions: 85000, clicks: 1631 },
    { date: "2026-02-23", spend: 728, revenue: 2378, conversions: 27, roas: 3.27, cpa: 26.96, ctr: 2.85, cpc: 0.45, impressions: 84600, clicks: 1613 },
    { date: "2026-02-24", spend: 717, revenue: 2366, conversions: 27, roas: 3.3, cpa: 26.56, ctr: 2.84, cpc: 0.45, impressions: 83900, clicks: 1595 },
    { date: "2026-02-25", spend: 739, revenue: 2465, conversions: 28, roas: 3.33, cpa: 26.39, ctr: 2.86, cpc: 0.45, impressions: 85300, clicks: 1643 },
    { date: "2026-02-26", spend: 750, revenue: 2499, conversions: 28, roas: 3.33, cpa: 26.79, ctr: 2.87, cpc: 0.45, impressions: 85900, clicks: 1667 },
    { date: "2026-02-27", spend: 762, revenue: 2540, conversions: 29, roas: 3.33, cpa: 26.28, ctr: 2.88, cpc: 0.46, impressions: 86700, clicks: 1657 },
    { date: "2026-02-28", spend: 773, revenue: 2564, conversions: 29, roas: 3.32, cpa: 26.66, ctr: 2.89, cpc: 0.46, impressions: 87200, clicks: 1680 },
    { date: "2026-03-01", spend: 790, revenue: 2616, conversions: 30, roas: 3.31, cpa: 26.33, ctr: 2.9, cpc: 0.46, impressions: 88100, clicks: 1717 },
    { date: "2026-03-02", spend: 795, revenue: 2634, conversions: 30, roas: 3.31, cpa: 26.5, ctr: 2.9, cpc: 0.46, impressions: 88400, clicks: 1728 },
    { date: "2026-03-03", spend: 806, revenue: 2668, conversions: 30, roas: 3.31, cpa: 26.87, ctr: 2.91, cpc: 0.46, impressions: 89000, clicks: 1751 },
    { date: "2026-03-04", spend: 818, revenue: 2699, conversions: 31, roas: 3.3, cpa: 26.39, ctr: 2.92, cpc: 0.46, impressions: 89700, clicks: 1769 },
    { date: "2026-03-05", spend: 812, revenue: 2685, conversions: 31, roas: 3.31, cpa: 26.19, ctr: 2.91, cpc: 0.46, impressions: 89300, clicks: 1757 },
    { date: "2026-03-06", spend: 834, revenue: 2738, conversions: 30, roas: 3.28, cpa: 27.8, ctr: 2.93, cpc: 0.46, impressions: 90200, clicks: 1807 },
    { date: "2026-03-07", spend: 840, revenue: 2763, conversions: 31, roas: 3.29, cpa: 27.1, ctr: 2.93, cpc: 0.46, impressions: 90600, clicks: 1813 },
    { date: "2026-03-08", spend: 846, revenue: 2781, conversions: 32, roas: 3.29, cpa: 26.44, ctr: 2.94, cpc: 0.46, impressions: 91000, clicks: 1826 },
    { date: "2026-03-09", spend: 857, revenue: 2808, conversions: 32, roas: 3.28, cpa: 26.78, ctr: 2.95, cpc: 0.46, impressions: 91700, clicks: 1845 },
    { date: "2026-03-10", spend: 862, revenue: 2821, conversions: 32, roas: 3.27, cpa: 26.94, ctr: 2.95, cpc: 0.46, impressions: 92100, clicks: 1874 },
    { date: "2026-03-11", spend: 874, revenue: 2838, conversions: 33, roas: 3.25, cpa: 26.48, ctr: 2.96, cpc: 0.46, impressions: 92800, clicks: 1882 },
  ];
  return {
    freshness: { state: "ready", updatedAt: now, lastSyncedAt: now },
    isPartial: false,
    points,
  };
}

export function getDemoMetaStatus() {
  const now = new Date().toISOString();
  const totalDays = 90;
  return {
    state: "ready",
    readinessLevel: "ready",
    surfaces: {
      required: ["account_daily", "campaign_daily", "adset_daily", "ad_daily", "breakdowns", "creatives"],
      available: ["account_daily", "campaign_daily", "adset_daily", "ad_daily", "breakdowns", "creatives"],
      missing: [],
      usable: ["account_daily", "campaign_daily", "adset_daily", "ad_daily", "breakdowns", "creatives"],
    },
    checkpointHealth: null,
    domainReadiness: {
      coreSurfacesReady: ["account_daily", "campaign_daily"],
      deepSurfacesPending: [],
      blockingSurfaces: [],
      summary: "Meta core and deep reporting surfaces are ready.",
    },
    connected: true,
    assignedAccountIds: ["act_210009998877"],
    primaryAccountTimezone: "America/Los_Angeles",
    currentDateInTimezone: "2026-03-28",
    needsBootstrap: false,
    warehouse: {
      rowCount: 2700,
      firstDate: "2026-01-01",
      lastDate: "2026-03-27",
      coverage: {
        historical: { completedDays: totalDays, totalDays, readyThroughDate: "2026-03-27" },
        selectedRange: null,
        scopes: [
          { scope: "account_daily", completedDays: totalDays, totalDays, readyThroughDate: "2026-03-27", latestBackgroundActivityAt: now, deadLetterCount: 0 },
          { scope: "adset_daily", completedDays: totalDays, totalDays, readyThroughDate: "2026-03-27", latestBackgroundActivityAt: now, deadLetterCount: 0 },
          { scope: "creative_daily", completedDays: totalDays, totalDays, readyThroughDate: "2026-03-27", latestBackgroundActivityAt: now, deadLetterCount: 0 },
          { scope: "ad_daily", completedDays: totalDays, totalDays, readyThroughDate: "2026-03-27", latestBackgroundActivityAt: now, deadLetterCount: 0 },
        ],
        accountDaily: { completedDays: totalDays, totalDays, readyThroughDate: "2026-03-27" },
        campaignDaily: { completedDays: totalDays, totalDays, readyThroughDate: "2026-03-27" },
        adsetDaily: { completedDays: totalDays, totalDays, readyThroughDate: "2026-03-27" },
        breakdowns: { completedDays: 30, totalDays: 30, readyThroughDate: "2026-03-27" },
        creatives: { completedDays: totalDays, totalDays, readyThroughDate: "2026-03-27", previewReadyRows: 38, totalRows: 38, previewReadyPercent: 100 },
        pendingSurfaces: [],
      },
    },
    jobHealth: {
      runningJobs: 0,
      staleRunningJobs: 0,
      queueDepth: 0,
      leasedPartitions: 0,
      retryableFailedPartitions: 0,
      deadLetterPartitions: 0,
      oldestQueuedPartition: null,
      latestCoreActivityAt: now,
      latestExtendedActivityAt: now,
      latestMaintenanceActivityAt: now,
    },
    priorityWindow: null,
    pageReadiness: {
      state: "ready",
      usable: true,
      complete: true,
      selectedRangeMode: "historical_warehouse",
      reason: null,
      missingRequiredSurfaces: [],
      requiredSurfaces: {
        summary: {
          state: "ready",
          blocking: false,
          countsForPageCompleteness: true,
          truthClass: "historical_warehouse",
          reason: null,
        },
        campaigns: {
          state: "ready",
          blocking: false,
          countsForPageCompleteness: true,
          truthClass: "historical_warehouse",
          reason: null,
        },
        "breakdowns.age": {
          state: "ready",
          blocking: false,
          countsForPageCompleteness: true,
          truthClass: "historical_warehouse",
          reason: null,
        },
        "breakdowns.location": {
          state: "ready",
          blocking: false,
          countsForPageCompleteness: true,
          truthClass: "historical_warehouse",
          reason: null,
        },
        "breakdowns.placement": {
          state: "ready",
          blocking: false,
          countsForPageCompleteness: true,
          truthClass: "historical_warehouse",
          reason: null,
        },
      },
      optionalSurfaces: {
        adsets: {
          state: "ready",
          blocking: false,
          countsForPageCompleteness: false,
          truthClass: "conditional_drilldown",
          reason: null,
        },
        recommendations: {
          state: "ready",
          blocking: false,
          countsForPageCompleteness: false,
          truthClass: "deterministic_decision_engine",
          reason: null,
        },
        operating_mode: {
          state: "ready",
          blocking: false,
          countsForPageCompleteness: false,
          truthClass: "deterministic_decision_engine",
          reason: null,
        },
        decision_os: {
          state: "ready",
          blocking: false,
          countsForPageCompleteness: false,
          truthClass: "deterministic_decision_engine",
          reason: null,
        },
      },
    },
    latestSync: {
      progressPercent: 100,
      completedDays: totalDays,
      totalDays,
      readyThroughDate: "2026-03-27",
      phaseLabel: null,
    },
  };
}

export function getDemoAiInsight() {
  return {
    insight_date: "2026-03-28",
    summary: "UrbanTrail is performing above benchmark across Meta and Google Ads. Blended ROAS sits at 3.27x on $38.2K spend, with purchase volume up 8% week-over-week. Creative fatigue is emerging on two top Meta ad sets — rotation recommended within 5 days. Google Shopping campaigns continue to outperform Search in CPA efficiency.",
    risks: [
      "Top Meta creative (Explorer Backpack lifestyle video) showing CTR decline of 18% over last 7 days — risk of fatigue within the week.",
      "Google Ads broad match keywords driving 34% of spend with below-average ROAS (2.1x) — budget allocation risk.",
    ],
    opportunities: [
      "Lookalike 1% audience on Meta has lowest CPA ($22.10) with room to scale — budget increase recommended.",
      "California and Texas regions driving 58% of revenue but only receiving 41% of ad budget — geo bid adjustment opportunity.",
      "UrbanTrail Hiking Backpack Pro has 4.8★ rating and strong add-to-cart rate but limited ad exposure — consider dedicated campaign.",
    ],
    recommendations: [
      "Rotate or refresh the Explorer Backpack lifestyle creative on Meta DTC ad set within 5 days.",
      "Reduce broad match keyword spend by 20% and reallocate to exact match and Shopping campaigns.",
      "Increase Lookalike 1% daily budget cap from $180 to $280.",
      "Create a geo-targeted campaign for California with +15% bid adjustment.",
    ],
    created_at: new Date().toISOString(),
  };
}

export function getDemoAiCreativeDecisions(creatives: Array<{ creativeId: string }>) {
  const labels = ["Scale", "Maintain", "Watch", "Refresh"];
  const reasons = [
    "Strong ROAS and CTR above account average — allocate more budget.",
    "Stable performance within benchmark range. Monitor weekly.",
    "CTR declining over last 7 days. Consider creative refresh soon.",
    "Below-average ROAS and high CPC. Recommend refreshing creative assets.",
  ];
  return creatives.map((c, i) => ({
    creativeId: c.creativeId,
    label: labels[i % labels.length],
    reason: reasons[i % reasons.length],
    score: Math.round(90 - (i % 4) * 18),
    confidence: "high" as const,
  }));
}

export function getDemoAiCreativeCommentary() {
  return {
    headline: "Strong creative mix with one fatigue risk",
    summary: "Your top creatives are driving solid ROAS across Meta placements. The Explorer Backpack lifestyle video leads in spend efficiency, but shows early signs of audience fatigue. The product-focused static ads are punching above their weight in conversion rate.",
    opportunities: [
      "Lookalike audiences respond well to the travel-context creative format — expand to Prospecting ad set.",
      "UGC-style creatives have 22% higher CTR than branded studio content in your account.",
    ],
    risks: [
      "Explorer Backpack lifestyle video CTR has declined 18% in 7 days — rotate before fatigue accelerates.",
      "Carousel format underperforming on Mobile Feed placements vs. single image.",
    ],
    nextActions: [
      "Introduce a new hero creative for the Explorer Backpack within 5 days.",
      "Test a UGC-style video for the Hiking Pro on Reels placement.",
      "Pause the underperforming carousel variant on Mobile Feed.",
    ],
  };
}
