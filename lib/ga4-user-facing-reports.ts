import type { LandingPagePerformanceResponse } from "@/src/types/landing-pages";
import { getAnalyticsOverviewData } from "@/lib/analytics-overview";
import {
  getGA4TokenAndProperty,
  isGa4InvalidArgumentError,
  runGA4Report,
} from "@/lib/google-analytics-reporting";
import {
  buildLandingPageRow,
  LANDING_PAGE_EVENT_NAMES,
  normalizeLandingPagePath,
  summarizeLandingPageRows,
} from "@/lib/landing-pages/performance";

export const GA4_DEMOGRAPHICS_DIMENSIONS = [
  "country",
  "region",
  "city",
  "language",
  "userAgeBracket",
  "userGender",
  "brandingInterest",
] as const;

export type Ga4DemographicsDimension = (typeof GA4_DEMOGRAPHICS_DIMENSIONS)[number];

export const GA4_USER_FACING_ROUTE_REPORT_TYPES = [
  "ga4_analytics_overview",
  "ga4_detailed_audience",
  "ga4_detailed_cohorts",
  "ga4_detailed_demographics",
  "ga4_landing_page_performance_v1",
  "ga4_detailed_landing_pages",
  "ga4_detailed_products",
] as const;

export type Ga4UserFacingRouteReportType = (typeof GA4_USER_FACING_ROUTE_REPORT_TYPES)[number];

const PRODUCT_DIMENSION = { name: "itemName" } as const;
const PRODUCT_LIMIT = 100;
const LANDING_PAGE_DIMENSION = { name: "landingPage" } as const;
const TOP_PAGES_LIMIT = 250;
const EVENT_ROWS_LIMIT = 5000;

type ProductMetricKey =
  | "views"
  | "addToCarts"
  | "checkouts"
  | "purchases"
  | "revenue";

const PRODUCT_METRIC_CANDIDATES: Record<ProductMetricKey, string[]> = {
  views: ["itemsViewed", "itemViews", "itemViewEvents"],
  addToCarts: ["itemsAddedToCart", "addToCarts"],
  checkouts: ["itemsCheckedOut", "checkouts"],
  purchases: ["itemsPurchased", "ecommercePurchases"],
  revenue: ["itemRevenue"],
};

function buildLandingPageEventNameFilter() {
  return {
    filter: {
      fieldName: "eventName",
      inListFilter: {
        values: [...LANDING_PAGE_EVENT_NAMES],
      },
    },
  };
}

function normalizeDemographicsDimension(
  value: string | null | undefined,
): Ga4DemographicsDimension {
  if (GA4_DEMOGRAPHICS_DIMENSIONS.includes(value as Ga4DemographicsDimension)) {
    return value as Ga4DemographicsDimension;
  }
  return "country";
}

async function resolveGa4Access(businessId: string) {
  return getGA4TokenAndProperty(businessId);
}

async function fetchGa4ProductMetricSeries(params: {
  propertyId: string;
  accessToken: string;
  startDate: string;
  endDate: string;
  metricKey: ProductMetricKey;
}): Promise<{
  rowsByProduct: Map<string, number>;
  metricName: string | null;
  unavailable: boolean;
  unavailableReason: string | null;
}> {
  const metricCandidates = PRODUCT_METRIC_CANDIDATES[params.metricKey];

  for (const metricName of metricCandidates) {
    try {
      const report = await runGA4Report({
        propertyId: params.propertyId,
        accessToken: params.accessToken,
        dateRanges: [{ startDate: params.startDate, endDate: params.endDate }],
        dimensions: [PRODUCT_DIMENSION],
        metrics: [{ name: metricName }],
        orderBys: [{ metric: { metricName }, desc: true }],
        limit: PRODUCT_LIMIT,
      });

      const rowsByProduct = new Map<string, number>();
      for (const row of report.rows) {
        const productName = (row.dimensions[0] ?? "").trim() || "(unknown)";
        const rawValue = Number.parseFloat(row.metrics[0] ?? "0");
        if (!Number.isFinite(rawValue)) continue;
        rowsByProduct.set(productName, (rowsByProduct.get(productName) ?? 0) + rawValue);
      }

      return {
        rowsByProduct,
        metricName,
        unavailable: false,
        unavailableReason: null,
      };
    } catch (error) {
      if (isGa4InvalidArgumentError(error)) {
        continue;
      }
      throw error;
    }
  }

  return {
    rowsByProduct: new Map<string, number>(),
    metricName: null,
    unavailable: true,
    unavailableReason: "metric_incompatible_or_unavailable",
  };
}

export async function getGa4DetailedAudienceData(params: {
  businessId: string;
  startDate: string;
  endDate: string;
}) {
  const { accessToken, propertyId, currencyCode } = await resolveGa4Access(
    params.businessId,
  );
  const dateRanges = [{ startDate: params.startDate, endDate: params.endDate }];

  const [newVsReturning, channelReport] = await Promise.all([
    (async () => {
      try {
        return await runGA4Report({
          propertyId,
          accessToken,
          dateRanges,
          dimensions: [{ name: "newVsReturning" }],
          metrics: [
            { name: "sessions" },
            { name: "engagedSessions" },
            { name: "engagementRate" },
            { name: "ecommercePurchases" },
            { name: "purchaseRevenue" },
          ],
        });
      } catch (error) {
        if (!isGa4InvalidArgumentError(error)) throw error;
        return {
          dimensionHeaders: ["newVsReturning"],
          metricHeaders: [
            "sessions",
            "engagedSessions",
            "engagementRate",
            "ecommercePurchases",
            "purchaseRevenue",
          ],
          rows: [],
          rowCount: 0,
          totals: undefined,
        };
      }
    })(),
    runGA4Report({
      propertyId,
      accessToken,
      dateRanges,
      dimensions: [{ name: "sessionSourceMedium" }],
      metrics: [
        { name: "sessions" },
        { name: "engagedSessions" },
        { name: "engagementRate" },
        { name: "ecommercePurchases" },
        { name: "purchaseRevenue" },
      ],
      orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
      limit: 20,
    }),
  ]);

  const segments: Record<
    string,
    {
      sessions: number;
      engagedSessions: number;
      engagementRate: number;
      purchases: number;
      revenue: number;
      purchaseCvr: number;
    }
  > = {};
  for (const row of newVsReturning.rows) {
    const type = row.dimensions[0];
    const sessions = parseFloat(row.metrics[0] ?? "0");
    const engagedSessions = parseFloat(row.metrics[1] ?? "0");
    const engagementRate = parseFloat(row.metrics[2] ?? "0");
    const purchases = parseFloat(row.metrics[3] ?? "0");
    const revenue = parseFloat(row.metrics[4] ?? "0");
    segments[type] = {
      sessions,
      engagedSessions,
      engagementRate,
      purchases,
      revenue,
      purchaseCvr: sessions > 0 ? purchases / sessions : 0,
    };
  }

  const channels = channelReport.rows.map((row) => {
    const sourceMedium = row.dimensions[0] ?? "(direct) / (none)";
    const sessions = parseFloat(row.metrics[0] ?? "0");
    const engagedSessions = parseFloat(row.metrics[1] ?? "0");
    const engagementRate = parseFloat(row.metrics[2] ?? "0");
    const purchases = parseFloat(row.metrics[3] ?? "0");
    const revenue = parseFloat(row.metrics[4] ?? "0");
    return {
      sourceMedium,
      sessions,
      engagedSessions,
      engagementRate,
      purchases,
      revenue,
      purchaseCvr: sessions > 0 ? purchases / sessions : 0,
    };
  });

  // The unit `revenue` above is quoted in; `null` when the property record
  // never carried one. Never substituted.
  return { segments, channels, currency: currencyCode };
}

export async function getGa4DetailedCohortsData(params: {
  businessId: string;
  startDate: string;
  endDate: string;
}) {
  const { accessToken, propertyId, currencyCode } = await resolveGa4Access(
    params.businessId,
  );

  const [weeklyReport, monthlyTrend] = await Promise.all([
    (async () => {
      try {
        return await runGA4Report({
          propertyId,
          accessToken,
          dateRanges: [{ startDate: params.startDate, endDate: params.endDate }],
          dimensions: [{ name: "week" }, { name: "newVsReturning" }],
          metrics: [
            { name: "sessions" },
            { name: "ecommercePurchases" },
            { name: "engagementRate" },
          ],
          orderBys: [{ dimension: { dimensionName: "week" }, desc: false }],
          limit: 200,
        });
      } catch (error) {
        if (!isGa4InvalidArgumentError(error)) throw error;
        return {
          dimensionHeaders: ["week", "newVsReturning"],
          metricHeaders: ["sessions", "ecommercePurchases", "engagementRate"],
          rows: [],
          rowCount: 0,
          totals: undefined,
        };
      }
    })(),
    runGA4Report({
      propertyId,
      accessToken,
      dateRanges: [{ startDate: params.startDate, endDate: params.endDate }],
      dimensions: [{ name: "month" }],
      metrics: [
        { name: "newUsers" },
        { name: "activeUsers" },
        { name: "sessions" },
        { name: "ecommercePurchases" },
        { name: "purchaseRevenue" },
      ],
      orderBys: [{ dimension: { dimensionName: "month" }, desc: false }],
      limit: 12,
    }),
  ]);

  const weekMap: Record<
    string,
    {
      week: string;
      new: { sessions: number; purchases: number };
      returning: { sessions: number; purchases: number };
    }
  > = {};

  for (const row of weeklyReport.rows) {
    const week = row.dimensions[0];
    const type = row.dimensions[1];
    const sessions = parseFloat(row.metrics[0] ?? "0");
    const purchases = parseFloat(row.metrics[1] ?? "0");

    if (!weekMap[week]) {
      weekMap[week] = {
        week,
        new: { sessions: 0, purchases: 0 },
        returning: { sessions: 0, purchases: 0 },
      };
    }
    if (type === "new") {
      weekMap[week].new.sessions += sessions;
      weekMap[week].new.purchases += purchases;
    } else {
      weekMap[week].returning.sessions += sessions;
      weekMap[week].returning.purchases += purchases;
    }
  }

  const cohortWeeks = Object.values(weekMap).map((week) => ({
    week: week.week,
    newSessions: week.new.sessions,
    returningSessions: week.returning.sessions,
    newPurchases: week.new.purchases,
    returningPurchases: week.returning.purchases,
    retentionRate:
      week.new.sessions > 0
        ? week.returning.sessions / (week.new.sessions + week.returning.sessions)
        : 0,
  }));

  const monthlyData = monthlyTrend.rows.map((row) => {
    const month = row.dimensions[0];
    const newUsers = parseFloat(row.metrics[0] ?? "0");
    const activeUsers = parseFloat(row.metrics[1] ?? "0");
    const sessions = parseFloat(row.metrics[2] ?? "0");
    const purchases = parseFloat(row.metrics[3] ?? "0");
    const revenue = parseFloat(row.metrics[4] ?? "0");
    return {
      month,
      newUsers,
      activeUsers,
      sessions,
      purchases,
      revenue,
      purchaseCvr: sessions > 0 ? purchases / sessions : 0,
    };
  });

  return { cohortWeeks, monthlyData, currency: currencyCode };
}

export async function getGa4DetailedDemographicsData(params: {
  businessId: string;
  startDate: string;
  endDate: string;
  dimension?: string | null;
}) {
  const dimension = normalizeDemographicsDimension(params.dimension);
  const { accessToken, propertyId, currencyCode } = await resolveGa4Access(
    params.businessId,
  );
  const report = await runGA4Report({
    propertyId,
    accessToken,
    dateRanges: [{ startDate: params.startDate, endDate: params.endDate }],
    dimensions: [{ name: dimension }],
    metrics: [
      { name: "sessions" },
      { name: "engagedSessions" },
      { name: "engagementRate" },
      { name: "ecommercePurchases" },
      { name: "purchaseRevenue" },
    ],
    orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
    limit: 50,
  });

  const rows = report.rows.map((row) => {
    const value = row.dimensions[0] ?? "(unknown)";
    const sessions = parseFloat(row.metrics[0] ?? "0");
    const engagedSessions = parseFloat(row.metrics[1] ?? "0");
    const engagementRate = parseFloat(row.metrics[2] ?? "0");
    const purchases = parseFloat(row.metrics[3] ?? "0");
    const revenue = parseFloat(row.metrics[4] ?? "0");
    return {
      value,
      sessions,
      engagedSessions,
      engagementRate,
      purchases,
      revenue,
      purchaseCvr: sessions > 0 ? purchases / sessions : 0,
    };
  });

  const withPurchases = [...rows].filter((row) => row.purchases > 0);
  const topByPurchaseCvr = withPurchases.sort((left, right) => right.purchaseCvr - left.purchaseCvr)[0];
  const avgPurchaseCvr =
    rows.length > 0
      ? rows.reduce((sum, row) => sum + row.purchaseCvr, 0) / rows.length
      : 0;

  return {
    dimension,
    rows,
    currency: currencyCode,
    summary: topByPurchaseCvr
      ? {
          topValue: topByPurchaseCvr.value,
          topValuePurchaseCvr: topByPurchaseCvr.purchaseCvr,
          avgPurchaseCvr,
        }
      : null,
  };
}

export async function getGa4LandingPagePerformanceData(params: {
  businessId: string;
  startDate: string;
  endDate: string;
}): Promise<LandingPagePerformanceResponse> {
  const { accessToken, propertyId, propertyName } = await resolveGa4Access(params.businessId);

  const [baseReport, eventReport] = await Promise.all([
    runGA4Report({
      propertyId,
      accessToken,
      businessId: params.businessId,
      dateRanges: [{ startDate: params.startDate, endDate: params.endDate }],
      dimensions: [LANDING_PAGE_DIMENSION],
      metrics: [
        { name: "sessions" },
        { name: "engagementRate" },
        { name: "purchaseRevenue" },
      ],
      orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
      limit: TOP_PAGES_LIMIT,
    }),
    runGA4Report({
      propertyId,
      accessToken,
      businessId: params.businessId,
      dateRanges: [{ startDate: params.startDate, endDate: params.endDate }],
      dimensions: [LANDING_PAGE_DIMENSION, { name: "eventName" }],
      metrics: [{ name: "eventCount" }],
      dimensionFilter: buildLandingPageEventNameFilter(),
      orderBys: [{ metric: { metricName: "eventCount" }, desc: true }],
      limit: EVENT_ROWS_LIMIT,
    }),
  ]);

  const baseRows = new Map<
    string,
    { sessions: number; engagementRate: number; totalRevenue: number }
  >();
  for (const row of baseReport.rows) {
    const path = normalizeLandingPagePath(row.dimensions[0]);
    baseRows.set(path, {
      sessions: Number.parseFloat(row.metrics[0] ?? "0") || 0,
      engagementRate: Number.parseFloat(row.metrics[1] ?? "0") || 0,
      totalRevenue: Number.parseFloat(row.metrics[2] ?? "0") || 0,
    });
  }

  const eventCountsByPath = new Map<string, Record<string, number>>();
  for (const row of eventReport.rows) {
    const path = normalizeLandingPagePath(row.dimensions[0]);
    const eventName = row.dimensions[1] ?? "";
    const eventCount = Number.parseFloat(row.metrics[0] ?? "0") || 0;
    if (!eventName) continue;
    const current = eventCountsByPath.get(path) ?? {};
    current[eventName] = (current[eventName] ?? 0) + eventCount;
    eventCountsByPath.set(path, current);
  }

  const allPaths = new Set<string>([...baseRows.keys(), ...eventCountsByPath.keys()]);
  const rows = [...allPaths]
    .map((path) => {
      const base = baseRows.get(path);
      const events = eventCountsByPath.get(path) ?? {};
      return buildLandingPageRow({
        path,
        sessions: base?.sessions ?? 0,
        engagementRate: base?.engagementRate ?? 0,
        scrollEvents: events.scroll ?? 0,
        viewItem: events.view_item ?? 0,
        addToCarts: events.add_to_cart ?? 0,
        checkouts: events.begin_checkout ?? 0,
        addShippingInfo: events.add_shipping_info ?? 0,
        addPaymentInfo: events.add_payment_info ?? 0,
        purchases: events.purchase ?? 0,
        totalRevenue: base?.totalRevenue ?? 0,
      });
    })
    .filter((row) => row.sessions > 0 || row.viewItem > 0 || row.purchases > 0 || row.totalRevenue > 0)
    .sort((left, right) => right.sessions - left.sessions)
    .slice(0, TOP_PAGES_LIMIT);

  return {
    rows,
    summary: summarizeLandingPageRows(rows),
    meta: {
      empty: rows.length === 0,
      hasEcommerceData: rows.some(
        (row) => row.viewItem > 0 || row.purchases > 0 || row.totalRevenue > 0,
      ),
      unavailableMetrics: [],
      propertyName,
    },
  };
}

export async function getGa4DetailedLandingPagesData(params: {
  businessId: string;
  startDate: string;
  endDate: string;
}) {
  const { accessToken, propertyId } = await resolveGa4Access(params.businessId);
  const report = await runGA4Report({
    propertyId,
    accessToken,
    dateRanges: [{ startDate: params.startDate, endDate: params.endDate }],
    dimensions: [{ name: "landingPage" }],
    metrics: [
      { name: "sessions" },
      { name: "engagedSessions" },
      { name: "engagementRate" },
      { name: "averageSessionDuration" },
      { name: "ecommercePurchases" },
      { name: "bounceRate" },
    ],
    orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
    limit: 100,
  });

  const pages = report.rows.map((row) => {
    const path = row.dimensions[0] ?? "/";
    const sessions = parseFloat(row.metrics[0] ?? "0");
    const engagedSessions = parseFloat(row.metrics[1] ?? "0");
    const engagementRate = parseFloat(row.metrics[2] ?? "0");
    const avgEngagementTime = parseFloat(row.metrics[3] ?? "0");
    const purchases = parseFloat(row.metrics[4] ?? "0");
    const bounceRate = parseFloat(row.metrics[5] ?? "0");

    return {
      path,
      sessions,
      engagedSessions,
      engagementRate,
      avgEngagementTime,
      purchases,
      purchaseCvr: sessions > 0 ? purchases / sessions : 0,
      bounceRate,
    };
  });

  return { pages };
}

export async function getGa4DetailedProductsData(params: {
  businessId: string;
  startDate: string;
  endDate: string;
}) {
  const { accessToken, propertyId, currencyCode } = await resolveGa4Access(
    params.businessId,
  );
  const [viewsSeries, addToCartSeries, checkoutSeries, purchasesSeries, revenueSeries] =
    await Promise.all([
      fetchGa4ProductMetricSeries({
        propertyId,
        accessToken,
        startDate: params.startDate,
        endDate: params.endDate,
        metricKey: "views",
      }),
      fetchGa4ProductMetricSeries({
        propertyId,
        accessToken,
        startDate: params.startDate,
        endDate: params.endDate,
        metricKey: "addToCarts",
      }),
      fetchGa4ProductMetricSeries({
        propertyId,
        accessToken,
        startDate: params.startDate,
        endDate: params.endDate,
        metricKey: "checkouts",
      }),
      fetchGa4ProductMetricSeries({
        propertyId,
        accessToken,
        startDate: params.startDate,
        endDate: params.endDate,
        metricKey: "purchases",
      }),
      fetchGa4ProductMetricSeries({
        propertyId,
        accessToken,
        startDate: params.startDate,
        endDate: params.endDate,
        metricKey: "revenue",
      }),
    ]);

  const allNames = new Set<string>();
  for (const series of [
    viewsSeries.rowsByProduct,
    addToCartSeries.rowsByProduct,
    checkoutSeries.rowsByProduct,
    purchasesSeries.rowsByProduct,
    revenueSeries.rowsByProduct,
  ]) {
    for (const name of series.keys()) {
      allNames.add(name);
    }
  }

  const products = [...allNames]
    .map((name) => {
      const views = viewsSeries.rowsByProduct.get(name) ?? 0;
      const addToCarts = addToCartSeries.rowsByProduct.get(name) ?? 0;
      const checkouts = checkoutSeries.rowsByProduct.get(name) ?? 0;
      const purchases = purchasesSeries.rowsByProduct.get(name) ?? 0;
      const revenue = revenueSeries.rowsByProduct.get(name) ?? 0;

      return {
        name,
        views,
        addToCarts,
        checkouts,
        purchases,
        revenue,
        atcRate: views > 0 ? addToCarts / views : 0,
        checkoutRate: addToCarts > 0 ? checkouts / addToCarts : 0,
        purchaseRate: checkouts > 0 ? purchases / checkouts : 0,
      };
    })
    .sort((left, right) => right.views - left.views)
    .slice(0, PRODUCT_LIMIT);

  const hasEcommerceData = products.some(
    (row) =>
      row.views > 0 ||
      row.addToCarts > 0 ||
      row.checkouts > 0 ||
      row.purchases > 0 ||
      row.revenue > 0,
  );

  const unavailableMetrics = (
    [
      ["views", viewsSeries] as const,
      ["addToCarts", addToCartSeries] as const,
      ["checkouts", checkoutSeries] as const,
      ["purchases", purchasesSeries] as const,
      ["revenue", revenueSeries] as const,
    ] satisfies ReadonlyArray<
      readonly [ProductMetricKey, { unavailable: boolean; unavailableReason: string | null }]
    >
  )
    .filter(([, result]) => result.unavailable)
    .map(([metricKey, result]) => ({
      metric: metricKey,
      reason: result.unavailableReason,
    }));

  const meta = {
    empty: products.length === 0,
    has_ecommerce_data: hasEcommerceData,
    reason: hasEcommerceData ? null : "no_product_events",
    metric_resolution: {
      views: viewsSeries.metricName,
      addToCarts: addToCartSeries.metricName,
      checkouts: checkoutSeries.metricName,
      purchases: purchasesSeries.metricName,
      revenue: revenueSeries.metricName,
    },
    unavailable_metrics: unavailableMetrics,
  };

  return {
    rows: products.map((row) => ({
      product: row.name,
      views: row.views,
      addToCart: row.addToCarts,
      checkouts: row.checkouts,
      purchases: row.purchases,
      revenue: row.revenue,
      addToCartRate: row.atcRate,
      checkoutRate: row.checkoutRate,
      purchaseRate: row.purchaseRate,
    })),
    products,
    currency: currencyCode,
    meta,
  };
}

export async function getGa4UserFacingRoutePayload(input: {
  businessId: string;
  reportType: Ga4UserFacingRouteReportType;
  startDate: string;
  endDate: string;
  dimension?: string | null;
}) {
  switch (input.reportType) {
    case "ga4_analytics_overview":
      return getAnalyticsOverviewData({
        businessId: input.businessId,
        startDate: input.startDate,
        endDate: input.endDate,
      });
    case "ga4_detailed_audience":
      return getGa4DetailedAudienceData(input);
    case "ga4_detailed_cohorts":
      return getGa4DetailedCohortsData(input);
    case "ga4_detailed_demographics":
      return getGa4DetailedDemographicsData(input);
    case "ga4_landing_page_performance_v1":
      return getGa4LandingPagePerformanceData(input);
    case "ga4_detailed_landing_pages":
      return getGa4DetailedLandingPagesData(input);
    case "ga4_detailed_products":
      return getGa4DetailedProductsData(input);
    default: {
      const exhaustive: never = input.reportType;
      throw new Error(`Unsupported GA4 user-facing report type: ${exhaustive}`);
    }
  }
}
