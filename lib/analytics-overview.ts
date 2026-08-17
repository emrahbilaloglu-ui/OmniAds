import { isDemoBusiness } from "@/lib/business-mode.server";
import { getDemoAnalyticsOverview } from "@/lib/demo-business";
import {
  GA4AuthError,
  generateInsights,
  getGA4TokenAndProperty,
  runGA4Report,
} from "@/lib/google-analytics-reporting";

export interface AnalyticsOverviewKpis {
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
}

export interface AnalyticsOverviewResponse {
  propertyName?: string;
  kpis?: AnalyticsOverviewKpis;
  /**
   * The same summary over the comparison window, present only when the caller
   * asked for one. The design's KPI cards carry a third "vs prev Nd" line, and
   * without this there is nothing that could truthfully fill it.
   */
  previousKpis?: AnalyticsOverviewKpis;
  newVsReturning?: {
    new: {
      sessions: number;
      purchases: number;
      purchaseCvr: number;
      /**
       * Already requested from GA4; it was read and discarded until now.
       * Absent — never zero — when the property refuses the metric.
       */
      engagementRate?: number;
    };
    returning: {
      sessions: number;
      purchases: number;
      purchaseCvr: number;
      engagementRate?: number;
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

function summarizeOverviewReport(
  report: Parameters<typeof readMetric>[0],
): AnalyticsOverviewKpis {
  const sessions = readMetric(report, "sessions");
  const purchases = readMetric(report, "ecommercePurchases");
  const revenue = readMetric(report, "purchaseRevenue");
  const averageOrderValueRaw = readMetric(
    report,
    "averagePurchaseRevenuePerPayingUser"
  );
  return {
    sessions,
    engagedSessions: readMetric(report, "engagedSessions"),
    engagementRate: readMetric(report, "engagementRate"),
    purchases,
    purchaseCvr: sessions > 0 ? purchases / sessions : 0,
    revenue,
    avgSessionDuration: readMetric(report, "averageSessionDuration"),
    averageOrderValue:
      averageOrderValueRaw > 0
        ? averageOrderValueRaw
        : purchases > 0
          ? revenue / purchases
          : 0,
    totalUsers: readMetric(report, "totalUsers"),
    newUsers: readMetric(report, "newUsers"),
    totalPurchasers: readMetric(report, "totalPurchasers"),
    firstTimePurchasers: readMetric(report, "firstTimePurchasers"),
  };
}

export async function getAnalyticsOverviewData(params: {
  businessId: string;
  startDate?: string | null;
  endDate?: string | null;
  /**
   * Optional comparison window. Both bounds are required; supplying them costs
   * exactly one extra summary report and nothing else.
   */
  compareStartDate?: string | null;
  compareEndDate?: string | null;
}): Promise<AnalyticsOverviewResponse> {
  const { businessId } = params;
  const startDate = params.startDate ?? "30daysAgo";
  const endDate = params.endDate ?? "yesterday";
  const compareStartDate = params.compareStartDate ?? null;
  const compareEndDate = params.compareEndDate ?? null;

  if (await isDemoBusiness(businessId)) {
    return getDemoAnalyticsOverview();
  }

  let accessToken: string;
  let propertyId: string;
  let propertyName: string;
  ({ accessToken, propertyId, propertyName } =
    await getGA4TokenAndProperty(businessId));

  const dateRanges = [{ startDate, endDate }];

  const [overviewReport, newVsReturningReport, trafficSourcesReport, previousReport] =
    await Promise.all([
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
      compareStartDate && compareEndDate
        ? runOverviewSummaryReport({
            propertyId,
            accessToken,
            dateRanges: [{ startDate: compareStartDate, endDate: compareEndDate }],
          })
        : Promise.resolve(null),
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
  let newEngagementRate: number | undefined;
  let returningSessions = 0;
  let returningPurchases = 0;
  let returningEngagementRate: number | undefined;
  const engagementRateIndex = newVsReturningReport.metricHeaders.findIndex(
    (name) => name === "engagementRate"
  );
  for (const row of newVsReturningReport.rows) {
    const type = row.dimensions[0];
    const s = parseFloat(row.metrics[0] ?? "0");
    const p = parseFloat(row.metrics[1] ?? "0");
    const rawEngagement =
      engagementRateIndex === -1 ? null : row.metrics[engagementRateIndex];
    const engagement =
      rawEngagement === undefined || rawEngagement === null
        ? undefined
        : Number.parseFloat(rawEngagement);
    if (type === "new") {
      newSessions = s;
      newPurchases = p;
      newEngagementRate = Number.isFinite(engagement) ? engagement : undefined;
    } else if (type === "returning") {
      returningSessions = s;
      returningPurchases = p;
      returningEngagementRate = Number.isFinite(engagement) ? engagement : undefined;
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
    ...(previousReport
      ? { previousKpis: summarizeOverviewReport(previousReport) }
      : {}),
    newVsReturning: {
      new: {
        sessions: newSessions,
        purchases: newPurchases,
        purchaseCvr: newSessions > 0 ? newPurchases / newSessions : 0,
        engagementRate: newEngagementRate,
      },
      returning: {
        sessions: returningSessions,
        purchases: returningPurchases,
        purchaseCvr:
          returningSessions > 0 ? returningPurchases / returningSessions : 0,
        engagementRate: returningEngagementRate,
      },
    },
    trafficSources,
    insights,
  };
}

export { GA4AuthError };
