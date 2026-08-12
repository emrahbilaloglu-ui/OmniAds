import { isDemoBusiness } from "@/lib/business-mode.server";
import { getDemoAnalyticsOverview } from "@/lib/demo-business";
import {
  GA4AuthError,
  generateInsights,
  getGA4TokenAndProperty,
  runGA4Report,
} from "@/lib/google-analytics-reporting";

export interface AnalyticsOverviewResponse {
  propertyName?: string;
  kpis?: {
    sessions?: number;
    engagedSessions?: number;
    engagementRate?: number;
    purchases?: number;
    purchaseCvr?: number;
    revenue?: number;
    avgSessionDuration?: number;
    averageOrderValue?: number;
    totalUsers?: number;
    newUsers?: number;
    totalPurchasers?: number;
    firstTimePurchasers?: number;
  };
  newVsReturning?: {
    new: {
      sessions: number;
      purchases: number;
      purchaseCvr: number;
    };
    returning: {
      sessions: number;
      purchases: number;
      purchaseCvr: number;
    };
  };
  trafficSources?: Array<{
    name: string;
    sessions: number;
  }>;
  insights?: Array<{ type: string; text: string }>;
}

function isGa4InvalidArgumentError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.message.includes("GA4 Reporting API error 400") &&
    error.message.includes("INVALID_ARGUMENT")
  );
}

async function runOverviewSummaryReport(params: {
  propertyId: string;
  accessToken: string;
  dateRanges: Array<{ startDate: string; endDate: string }>;
}) {
  const metricSets = [
    [
      "totalUsers",
      "newUsers",
      "sessions",
      "engagedSessions",
      "engagementRate",
      "ecommercePurchases",
      "purchaseRevenue",
      "averageSessionDuration",
      "totalPurchasers",
      "firstTimePurchasers",
      "averagePurchaseRevenuePerPayingUser",
    ],
    [
      "totalUsers",
      "newUsers",
      "sessions",
      "engagedSessions",
      "engagementRate",
      "ecommercePurchases",
      "purchaseRevenue",
      "averageSessionDuration",
      "totalPurchasers",
      "firstTimePurchasers",
    ],
    [
      "totalUsers",
      "newUsers",
      "sessions",
      "engagedSessions",
      "engagementRate",
      "ecommercePurchases",
      "purchaseRevenue",
      "averageSessionDuration",
    ],
  ] as const;

  for (const metricNames of metricSets) {
    try {
      return await runGA4Report({
        propertyId: params.propertyId,
        accessToken: params.accessToken,
        dateRanges: params.dateRanges,
        metrics: metricNames.map((name) => ({ name })),
      });
    } catch (error) {
      if (isGa4InvalidArgumentError(error)) {
        continue;
      }
      throw error;
    }
  }

  throw new Error("GA4 overview metrics are incompatible with the selected property.");
}

async function runNewVsReturningReport(params: {
  propertyId: string;
  accessToken: string;
  dateRanges: Array<{ startDate: string; endDate: string }>;
}) {
  try {
    return await runGA4Report({
      propertyId: params.propertyId,
      accessToken: params.accessToken,
      dateRanges: params.dateRanges,
      dimensions: [{ name: "newVsReturning" }],
      metrics: [
        { name: "sessions" },
        { name: "ecommercePurchases" },
        { name: "purchaseRevenue" },
        { name: "engagementRate" },
      ],
      limit: 5,
    });
  } catch (error) {
    if (isGa4InvalidArgumentError(error)) {
      return {
        dimensionHeaders: ["newVsReturning"],
        metricHeaders: [
          "sessions",
          "ecommercePurchases",
          "purchaseRevenue",
          "engagementRate",
        ],
        rows: [],
        rowCount: 0,
        totals: undefined,
      };
    }
    throw error;
  }
}

async function runTrafficSourcesReport(params: {
  propertyId: string;
  accessToken: string;
  dateRanges: Array<{ startDate: string; endDate: string }>;
}) {
  try {
    return await runGA4Report({
      propertyId: params.propertyId,
      accessToken: params.accessToken,
      dateRanges: params.dateRanges,
      dimensions: [{ name: "sessionDefaultChannelGroup" }],
      metrics: [{ name: "sessions" }],
      limit: 8,
    });
  } catch (error) {
    if (isGa4InvalidArgumentError(error)) {
      return {
        dimensionHeaders: ["sessionDefaultChannelGroup"],
        metricHeaders: ["sessions"],
        rows: [],
        rowCount: 0,
        totals: undefined,
      };
    }
    throw error;
  }
}

function readMetric(
  report: { metricHeaders: string[]; totals?: Array<{ metrics: string[] }>; rows: Array<{ metrics: string[] }> },
  metricName: string
) {
  const index = report.metricHeaders.findIndex((name) => name === metricName);
  if (index === -1) return 0;
  const row = report.totals?.[0] ?? report.rows[0];
  return parseFloat(row?.metrics[index] ?? "0");
}

export async function getAnalyticsOverviewData(params: {
  businessId: string;
  startDate?: string | null;
  endDate?: string | null;
}): Promise<AnalyticsOverviewResponse> {
  const { businessId } = params;
  const startDate = params.startDate ?? "30daysAgo";
  const endDate = params.endDate ?? "yesterday";

  if (await isDemoBusiness(businessId)) {
    return getDemoAnalyticsOverview();
  }

  let accessToken: string;
  let propertyId: string;
  let propertyName: string;
  ({ accessToken, propertyId, propertyName } =
    await getGA4TokenAndProperty(businessId));

  const dateRanges = [{ startDate, endDate }];

  const [overviewReport, newVsReturningReport, trafficSourcesReport] = await Promise.all([
    runOverviewSummaryReport({
      propertyId,
      accessToken,
      dateRanges,
    }),
    runNewVsReturningReport({
      propertyId,
      accessToken,
      dateRanges,
    }),
    runTrafficSourcesReport({
      propertyId,
      accessToken,
      dateRanges,
    }),
  ]);

  const totalUsers = readMetric(overviewReport, "totalUsers");
  const newUsers = readMetric(overviewReport, "newUsers");
  const sessions = readMetric(overviewReport, "sessions");
  const engagedSessions = readMetric(overviewReport, "engagedSessions");
  const engagementRate = readMetric(overviewReport, "engagementRate");
  const purchases = readMetric(overviewReport, "ecommercePurchases");
  const revenue = readMetric(overviewReport, "purchaseRevenue");
  const avgSessionDuration = readMetric(overviewReport, "averageSessionDuration");
  const totalPurchasers = readMetric(overviewReport, "totalPurchasers");
  const firstTimePurchasers = readMetric(overviewReport, "firstTimePurchasers");
  const averageOrderValueRaw = readMetric(
    overviewReport,
    "averagePurchaseRevenuePerPayingUser"
  );
  const averageOrderValue =
    averageOrderValueRaw > 0
      ? averageOrderValueRaw
      : purchases > 0
        ? revenue / purchases
        : 0;
  const purchaseCvr = sessions > 0 ? purchases / sessions : 0;

  let newSessions = 0;
  let newPurchases = 0;
  let returningSessions = 0;
  let returningPurchases = 0;
  for (const row of newVsReturningReport.rows) {
    const type = row.dimensions[0];
    const s = parseFloat(row.metrics[0] ?? "0");
    const p = parseFloat(row.metrics[1] ?? "0");
    if (type === "new") {
      newSessions = s;
      newPurchases = p;
    } else if (type === "returning") {
      returningSessions = s;
      returningPurchases = p;
    }
  }

  const insights = generateInsights({
    overview: { sessions, engagedSessions, purchases, revenue },
    audience: { newSessions, newPurchases, returningSessions, returningPurchases },
  });
  const trafficSources = trafficSourcesReport.rows
    .map((row) => ({
      name: row.dimensions[0]?.trim() || "Unassigned",
      sessions: parseFloat(row.metrics[0] ?? "0"),
    }))
    .filter((row) => Number.isFinite(row.sessions))
    .sort((a, b) => b.sessions - a.sessions);

  return {
    propertyName,
    kpis: {
      sessions,
      engagedSessions,
      engagementRate,
      purchases,
      purchaseCvr,
      revenue,
      avgSessionDuration,
      averageOrderValue,
      totalUsers,
      newUsers,
      totalPurchasers,
      firstTimePurchasers,
    },
    newVsReturning: {
      new: {
        sessions: newSessions,
        purchases: newPurchases,
        purchaseCvr: newSessions > 0 ? newPurchases / newSessions : 0,
      },
      returning: {
        sessions: returningSessions,
        purchases: returningPurchases,
        purchaseCvr:
          returningSessions > 0 ? returningPurchases / returningSessions : 0,
      },
    },
    trafficSources,
    insights,
  };
}

export { GA4AuthError };
