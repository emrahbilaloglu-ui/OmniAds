import {
  BusinessCostModelData,
  DateRange,
  OverviewData,
  OverviewSummaryData,
} from "@/src/types";
import {
  buildApiUrl,
  getApiErrorMessage,
  readJsonResponse,
} from "@/src/services/data-service-support";

/**
 * One reported provider day; dates without a provider row are absent, not
 * zero. `impressions`/`clicks` are null (or absent in older payloads) when the
 * row did not report them, and rate series must skip that day.
 */
export interface ProviderSparklinePoint {
  date: string;
  spend: number;
  revenue: number;
  purchases: number;
  impressions?: number | null;
  clicks?: number | null;
}

export interface SparklineBundle {
  combined: Array<{ date: string; spend: number; revenue: number; purchases: number }>;
  shopifyDaily?: Array<{
    date: string;
    revenue: number;
    purchases: number;
    grossRevenue?: number | null;
    conversionRate: number | null;
    newCustomers: number | null;
    returningCustomers: number | null;
  }>;
  shopifyCommerceAvailable?: boolean;
  shopifyConnectionState?: "connected" | "disconnected" | "unknown";
  providerTrends: {
    meta?: ProviderSparklinePoint[];
    google?: ProviderSparklinePoint[];
  };
  /** The read behind each provider trend. Absent or null is unknown and never patches a card. */
  providerTrendSources?: {
    meta?: string | null;
    google?: string | null;
  };
  ga4Daily: Array<{
    date: string;
    sessions: number;
    purchases: number;
    revenue: number;
    engagementRate: number;
    avgSessionDuration: number;
    totalPurchasers: number;
    firstTimePurchasers: number;
  }>;
}

export async function getOverview(
  businessId: string,
  dateRange: DateRange
): Promise<OverviewData> {
  const url = buildApiUrl(process.env.NEXT_PUBLIC_OVERVIEW_API_URL || "/api/overview");
  url.searchParams.set("businessId", businessId);
  url.searchParams.set("startDate", dateRange.startDate);
  url.searchParams.set("endDate", dateRange.endDate);

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: { Accept: "application/json" },
  });

  const payload = await readJsonResponse(response);

  if (!response.ok) {
    throw new Error(
      getApiErrorMessage(payload, `Overview API request failed with status ${response.status}`)
    );
  }

  const data = payload?.overview ?? payload;
  if (!data || typeof data !== "object") {
    throw new Error("Overview API returned an invalid payload.");
  }

  return data as OverviewData;
}

export async function getOverviewSparklines(
  businessId: string,
  params: { startDate: string; endDate: string }
): Promise<SparklineBundle> {
  const url = buildApiUrl("/api/overview-sparklines");
  url.searchParams.set("businessId", businessId);
  url.searchParams.set("startDate", params.startDate);
  url.searchParams.set("endDate", params.endDate);

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: { Accept: "application/json" },
  });

  const payload = await readJsonResponse(response);

  if (!response.ok) {
    throw new Error(
      getApiErrorMessage(
        payload,
        `Overview sparklines request failed with status ${response.status}`
      )
    );
  }

  return (payload?.sparklines ?? payload) as SparklineBundle;
}

export async function getOverviewSummary(
  businessId: string,
  params: DateRange & { compareMode?: "none" | "previous_period" }
): Promise<OverviewSummaryData> {
  const url = buildApiUrl("/api/overview-summary");
  url.searchParams.set("businessId", businessId);
  url.searchParams.set("startDate", params.startDate);
  url.searchParams.set("endDate", params.endDate);
  if (params.compareMode) {
    url.searchParams.set("compareMode", params.compareMode);
  }

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: { Accept: "application/json" },
  });

  const payload = await readJsonResponse(response);

  if (!response.ok) {
    throw new Error(
      getApiErrorMessage(
        payload,
        `Overview Summary API request failed with status ${response.status}`
      )
    );
  }

  const data = payload?.summary ?? payload;
  if (!data || typeof data !== "object") {
    throw new Error("Overview Summary API returned an invalid payload.");
  }

  return data as OverviewSummaryData;
}

export async function getMetricTrend(
  businessId: string,
  params: DateRange & { metric: string }
): Promise<{ metric: string; data: Array<{ date: string; value: number }> }> {
  const url = buildApiUrl("/api/metrics/trend");
  url.searchParams.set("businessId", businessId);
  url.searchParams.set("metric", params.metric);
  url.searchParams.set("startDate", params.startDate);
  url.searchParams.set("endDate", params.endDate);

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: { Accept: "application/json" },
  });

  const payload = await readJsonResponse(response);

  if (!response.ok) {
    throw new Error(
      getApiErrorMessage(payload, `Metric Trend API request failed with status ${response.status}`)
    );
  }

  if (!payload || typeof payload !== "object" || !Array.isArray(payload.data)) {
    throw new Error("Metric Trend API returned an invalid payload.");
  }

  return payload as { metric: string; data: Array<{ date: string; value: number }> };
}

export async function getBusinessCostModel(
  businessId: string
): Promise<BusinessCostModelData | null> {
  const url = buildApiUrl("/api/business-cost-model");
  url.searchParams.set("businessId", businessId);

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  const payload = await readJsonResponse(response);

  if (!response.ok) {
    throw new Error(
      getApiErrorMessage(payload, `Business Cost Model request failed with status ${response.status}`)
    );
  }

  return (payload?.costModel ?? null) as BusinessCostModelData | null;
}

export async function upsertBusinessCostModel(input: {
  businessId: string;
  cogsPercent: number;
  shippingPercent: number;
  feePercent: number;
  fixedCost: number;
}): Promise<BusinessCostModelData> {
  const response = await fetch("/api/business-cost-model", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(input),
  });
  const payload = await readJsonResponse(response);
  if (!response.ok) {
    throw new Error(
      getApiErrorMessage(payload, `Business Cost Model update failed with status ${response.status}`)
    );
  }
  return payload.costModel as BusinessCostModelData;
}
