import { NextRequest } from "next/server";
import { getMetricLabelForKey } from "@/lib/report-metric-catalog";
import {
  type CustomReportDocument,
  type CustomReportBreakdown,
  type CustomReportRecord,
  type CustomReportWidgetDefinition,
  type RenderedReportPayload,
  type RenderedReportWidget,
} from "@/lib/custom-reports";
import { resolveMetaCredentials, getCampaignTimeBreakdown } from "@/lib/api/meta";

/**
 * Format money in the report's own currency.
 *
 * There is no fallback currency. A report whose currency we cannot establish
 * renders amounts as unavailable rather than labelling another account's money
 * as dollars, which is what a client would otherwise receive (MR-D064-01).
 */
function toCurrency(value: number | null | undefined, currency: string | null) {
  if (value == null || !Number.isFinite(value)) return "-";
  if (!currency) return "-";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    maximumFractionDigits: value >= 100 ? 0 : 2,
  }).format(value);
}

/** Normalize a stored currency to an ISO 4217 code, or null when unusable. */
export function normalizeReportCurrency(value: string | null | undefined): string | null {
  const code = value?.trim().toUpperCase();
  return code && /^[A-Z]{3}$/.test(code) ? code : null;
}

function toCompactNumber(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "-";
  return new Intl.NumberFormat("en-US", {
    notation: Math.abs(value) >= 1000 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(value);
}

function toRatio(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "-";
  return `${value.toFixed(2)}x`;
}

function parseNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function formatMetricValue(metricKey: string, value: number | null, currency: string | null) {
  if (metricKey.includes("roas")) return toRatio(value);
  if (metricKey.includes("ctr") || metricKey.includes("rate")) {
    return value == null || !Number.isFinite(value) ? "-" : `${value.toFixed(2)}%`;
  }
  if (
    metricKey.includes("spend") ||
    metricKey.includes("revenue") ||
    metricKey.includes("cpa") ||
    metricKey.includes("cpm") ||
    metricKey.includes("cpc")
  ) {
    return toCurrency(value, currency);
  }
  return toCompactNumber(value);
}

function formatCellValue(metricKey: string, value: unknown, currency: string | null) {
  if (metricKey === "name" || metricKey === "status" || metricKey === "channel" || metricKey === "currency") {
    return String(value ?? "-");
  }
  return formatMetricValue(metricKey, parseNumber(value), currency);
}

function getMetricSeriesColor(index: number) {
  return ["#2563eb", "#10b981", "#f59e0b", "#8b5cf6", "#ef4444"][index % 5];
}

function formatSeriesMetricLabel(metricKey: string) {
  return getMetricLabelForKey(metricKey);
}

function getMetricContainerKey(metricKey: string) {
  const [prefix, suffix] = metricKey.includes(".") ? metricKey.split(".", 2) : ["all", metricKey];
  return {
    provider: prefix === "meta" || prefix === "google" || prefix === "combined" ? prefix : "combined",
    metric: suffix,
  };
}

function enumerateDays(startDate: string, endDate: string) {
  const start = new Date(`${startDate}T00:00:00.000Z`);
  const end = new Date(`${endDate}T00:00:00.000Z`);
  const dates: string[] = [];
  const cursor = new Date(start);
  while (cursor <= end) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function getBreakdownBucket(input: { label: string; breakdown: CustomReportBreakdown }) {
  const date = new Date(`${input.label}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return input.label;
  if (input.breakdown === "day") return input.label;
  if (input.breakdown === "month") {
    return date.toLocaleDateString("en-US", { month: "short", year: "2-digit", timeZone: "UTC" });
  }
  const start = new Date(date);
  const day = start.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  start.setUTCDate(start.getUTCDate() + diff);
  return start.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function aggregateSeriesPoints(
  points: Array<{ label: string; value: number }>,
  breakdown: CustomReportBreakdown
) {
  if (breakdown === "day") return points;
  const buckets = new Map<string, number>();
  for (const point of points) {
    const bucket = getBreakdownBucket({ label: point.label, breakdown });
    buckets.set(bucket, Number((buckets.get(bucket) ?? 0) + point.value));
  }
  return Array.from(buckets.entries()).map(([label, value]) => ({ label, value }));
}

export function resolveDateRangePreset(preset: CustomReportDocument["dateRangePreset"]) {
  const end = new Date();
  end.setUTCDate(end.getUTCDate() - 1);
  const endDate = end.toISOString().slice(0, 10);

  // "This month" is a calendar window, not a trailing one: it starts on the
  // first of the month that yesterday falls in. A trailing 30 days would
  // silently answer a different question from the one the operator picked.
  if (preset === "this_month") {
    const start = new Date(end);
    start.setUTCDate(1);
    return {
      startDate: start.toISOString().slice(0, 10),
      endDate,
      label: "This month",
    };
  }

  const start = new Date(end);
  const days = preset === "7" ? 6 : preset === "28" ? 27 : preset === "90" ? 89 : 29;
  start.setUTCDate(start.getUTCDate() - days);
  return {
    startDate: start.toISOString().slice(0, 10),
    endDate,
    label: `Last ${preset} Days`,
  };
}

/**
 * Report data sources, resolved in-process rather than over HTTP.
 *
 * Every widget in a report used to reach its own API route by fetching this
 * service's public origin. In a container that self-call can fail outright —
 * one unreachable origin fails every widget at once, which is how a whole
 * report renders as "Widget failed to load". Calling the route handler
 * directly removes the hop, the extra auth round-trip, and the fan-out.
 */
const IN_PROCESS_REPORT_SOURCES: Record<
  string,
  () => Promise<{ GET: (request: NextRequest) => Promise<Response> }>
> = {
  "/api/overview-summary": () => import("@/app/api/overview-summary/route"),
  "/api/overview-sparklines": () => import("@/app/api/overview-sparklines/route"),
  "/api/reports/breakdown": () => import("@/app/api/reports/breakdown/route"),
  "/api/reports/time-breakdown": () => import("@/app/api/reports/time-breakdown/route"),
  "/api/meta/campaigns": () => import("@/app/api/meta/campaigns/route"),
  "/api/google-ads/campaigns": () => import("@/app/api/google-ads/campaigns/route"),
};

/** Tests drive the HTTP path so route mocks stay meaningful. */
function useInProcessReportSources() {
  const override = process.env.REPORT_RENDER_TRANSPORT?.trim().toLowerCase();
  if (override === "http") return false;
  if (override === "in_process") return true;
  return process.env.VITEST !== "true" && process.env.NODE_ENV !== "test";
}

export function resolveReportSourceTransport(pathname: string): "in_process" | "http" {
  return useInProcessReportSources() && IN_PROCESS_REPORT_SOURCES[pathname]
    ? "in_process"
    : "http";
}

async function requestInternal(request: NextRequest, url: URL): Promise<Response> {
  const headers = {
    Accept: "application/json",
    cookie: request.headers.get("cookie") ?? "",
  };
  if (resolveReportSourceTransport(url.pathname) === "in_process") {
    const { GET } = await IN_PROCESS_REPORT_SOURCES[url.pathname]!();
    return GET(new NextRequest(url, { headers }));
  }
  return fetch(url.toString(), { headers, cache: "no-store" });
}

async function fetchInternalJson<T>(request: NextRequest, path: string) {
  const url = new URL(path, request.nextUrl.origin);
  const response = await requestInternal(request, url);
  const payload = (await response.json().catch(() => null)) as T | null;
  if (!response.ok) {
    throw new Error(
      (payload as { message?: string; error?: string } | null)?.message ??
        `Failed to fetch ${path}`
    );
  }
  return payload as T;
}

async function fetchInternalJsonWithParams<T>(
  request: NextRequest,
  pathname: string,
  params: Record<string, string>
) {
  const url = new URL(pathname, request.nextUrl.origin);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return fetchInternalJson<T>(request, `${url.pathname}${url.search}`);
}

function getWidgetColumns(widget: CustomReportWidgetDefinition, fallback: string[]) {
  return widget.columns?.length ? widget.columns : fallback;
}

function sumMetric(
  rows: Array<Record<string, unknown>>,
  metricKey: string,
  nestedKey?: string
) {
  return rows.reduce((sum, row) => {
    const container =
      nestedKey && typeof row[nestedKey] === "object" && row[nestedKey] !== null
        ? (row[nestedKey] as Record<string, unknown>)
        : row;
    return sum + Number(parseNumber(container[metricKey]) ?? 0);
  }, 0);
}

function mapDynamicColumnsToRow(
  source: Record<string, unknown>,
  columns: string[],
  currency: string | null,
  nestedKey?: string
) {
  const container =
    nestedKey && typeof source[nestedKey] === "object" && source[nestedKey] !== null
      ? (source[nestedKey] as Record<string, unknown>)
      : source;
  return Object.fromEntries(
    columns.map((column) => [column, formatCellValue(column, container[column], currency)])
  );
}

function aggregateMetricFromRows(
  rows: Array<Record<string, unknown>>,
  metricKey: string,
  nestedKey?: string
) {
  return rows.reduce((sum, row) => {
    const container =
      nestedKey && typeof row[nestedKey] === "object" && row[nestedKey] !== null
        ? (row[nestedKey] as Record<string, unknown>)
        : row;
    return sum + Number(parseNumber(container[metricKey]) ?? 0);
  }, 0);
}

// Ratio metrics must be derived from their components, never summed across rows.
// Maps metric key → [numerator, denominator, multiplier]
const RATIO_METRICS: Record<string, [string, string, number]> = {
  roas:             ["revenue",     "spend",       1],
  ctr:              ["clicks",      "impressions", 100],
  outboundCtr:      ["outboundClicks", "impressions", 100],
  uniqueCtr:        ["uniqueClicks", "impressions", 100],
  cpc:              ["spend",       "clicks",      1],
  cpm:              ["spend",       "impressions", 1000],
  cpp:              ["spend",       "reach",       1],
  frequency:        ["impressions", "reach",       1],
  cpa:              ["spend",       "purchases",   1],
  costPerLead:      ["spend",       "leads",       1],
  costPerAddToCart: ["spend",       "addToCart",   1],
  costPerCheckoutInitiated: ["spend", "initiateCheckout", 1],
  costPerContentView: ["spend",     "contentViews", 1],
  costPerLandingPageView: ["spend", "landingPageViews", 1],
  costPerRegistrationCompleted: ["spend", "registrationsCompleted", 1],
  conversionRate:   ["conversions", "clicks",      100],
  valuePerConversion: ["revenue",   "conversions", 1],
  costPerConversion: ["spend",      "conversions", 1],
  videoViewRate:    ["videoViews",  "impressions", 100],
  engagementRate:   ["engagements", "impressions", 100],
  interactionRate:  ["interactions","impressions", 100],
};

function computeDerivedMetric(
  rows: Array<Record<string, unknown>>,
  metric: string,
  nestedKey?: string
): number {
  const ratio = RATIO_METRICS[metric];
  if (!ratio) return aggregateMetricFromRows(rows, metric, nestedKey);
  const [num, den, mult] = ratio;
  const totalNum = aggregateMetricFromRows(rows, num, nestedKey);
  const totalDen = aggregateMetricFromRows(rows, den, nestedKey);
  return totalDen > 0 ? (totalNum / totalDen) * mult : 0;
}

async function buildProviderSeries(input: {
  request: NextRequest;
  businessId: string;
  provider: "meta" | "google";
  metricKey: string;
  accountId?: string | null;
  startDate: string;
  endDate: string;
  breakdown: CustomReportBreakdown;
}) {
  const dates = enumerateDays(input.startDate, input.endDate);
  const metric = input.metricKey.split(".").pop() ?? input.metricKey;
  const dailyPoints = await Promise.all(
    dates.map(async (date) => {
      if (input.provider === "meta") {
        const payload = await fetchInternalJsonWithParams<{ rows?: Array<Record<string, unknown>> }>(
          input.request,
          "/api/meta/campaigns",
          {
            businessId: input.businessId,
            startDate: date,
            endDate: date,
            ...(input.accountId ? { accountId: input.accountId } : {}),
          }
        ).catch(() => null);
        return {
          label: date,
          value: computeDerivedMetric(payload?.rows ?? [], metric),
        };
      }

      const payload = await fetchInternalJsonWithParams<{ rows?: Array<Record<string, unknown>> }>(
        input.request,
        "/api/google-ads/campaigns",
        {
          businessId: input.businessId,
          dateRange: "custom",
          customStart: date,
          customEnd: date,
          compareMode: "none",
          ...(input.accountId ? { accountId: input.accountId } : {}),
        }
      ).catch(() => null);
      return {
        label: date,
        value: computeDerivedMetric(payload?.rows ?? [], metric, "metrics"),
      };
    })
  );

  return aggregateSeriesPoints(dailyPoints, input.breakdown).map((point) => ({
    label: input.breakdown === "day" ? point.label.slice(5) : point.label,
    value: point.value,
  }));
}

function toCsvValue(value: string | number | null | undefined) {
  if (value == null) return "";
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function renderWidgetCsv(widget: RenderedReportWidget) {
  const columns = widget.columns ?? [];
  const rows = widget.rows ?? [];
  const header = columns.join(",");
  const body = rows
    .map((row) => columns.map((column) => toCsvValue(row[column])).join(","))
    .join("\n");
  return [header, body].filter(Boolean).join("\n");
}

export async function renderCustomReport(params: {
  request: NextRequest;
  businessId: string;
  name: string;
  description?: string | null;
  reportId?: string;
  definition: CustomReportDocument;
  startDateOverride?: string;
  endDateOverride?: string;
  /** ISO 4217 code the report's money is denominated in. Never defaulted. */
  currency?: string | null;
}): Promise<RenderedReportPayload> {
  const { request, businessId, name, description, reportId, definition, startDateOverride, endDateOverride } = params;
  const currency = normalizeReportCurrency(params.currency);
  const baseRange = resolveDateRangePreset(definition.dateRangePreset);
  const range = startDateOverride && endDateOverride
    ? { startDate: startDateOverride, endDate: endDateOverride, label: `${startDateOverride} – ${endDateOverride}` }
    : baseRange;

  let overviewSummary:
    | {
        pins?: Array<{ id?: string; title?: string; value?: number | null; changePct?: number | null }>;
        attribution?: Array<Record<string, unknown>>;
      }
    | null = null;
  let sparklines:
    | {
        sparklines?: {
          combined?: Array<{ date: string; spend: number; revenue: number; purchases: number }>;
          providerTrends?: Partial<
            Record<"meta" | "google", Array<{ date: string; spend: number; revenue: number; purchases: number }>>
          >;
        };
      }
    | null = null;
  const metaCampaignCache = new Map<
    string,
    { rows?: Array<Record<string, unknown>>; status?: string; message?: string; meta?: Record<string, unknown> }
  >();
  const googleCampaignCache = new Map<
    string,
    { data?: Array<Record<string, unknown>>; meta?: Record<string, unknown> }
  >();

  async function getOverviewSummaryData() {
    if (overviewSummary) return overviewSummary;
    overviewSummary = await fetchInternalJson(request, `/api/overview-summary?businessId=${encodeURIComponent(businessId)}&startDate=${range.startDate}&endDate=${range.endDate}&compareMode=${definition.compareMode}`);
    return overviewSummary;
  }

  async function getSparklineData() {
    if (sparklines) return sparklines;
    sparklines = await fetchInternalJson(request, `/api/overview-sparklines?businessId=${encodeURIComponent(businessId)}&startDate=${range.startDate}&endDate=${range.endDate}`);
    return sparklines;
  }

  async function getMetaCampaignData(accountId?: string) {
    const cacheKey = accountId ?? "__all__";
    const cached = metaCampaignCache.get(cacheKey);
    if (cached) return cached;
    const params = new URLSearchParams({
      businessId,
      startDate: range.startDate,
      endDate: range.endDate,
    });
    if (accountId) params.set("accountId", accountId);
    const payload = await fetchInternalJson<
      { rows?: Array<Record<string, unknown>>; status?: string; message?: string; meta?: Record<string, unknown> }
    >(request, `/api/meta/campaigns?${params.toString()}`);
    metaCampaignCache.set(cacheKey, payload);
    return payload;
  }

  async function fetchBreakdownTable(input: {
    platform: "meta" | "google";
    dimension: string;
    metricKeys: string[];
    accountId?: string;
  }): Promise<{ columns: string[]; rows: Array<Record<string, string>> }> {
    const { platform, dimension, metricKeys, accountId } = input;
    if (metricKeys.length === 0) return { columns: [dimension], rows: [] };

    const params: Record<string, string> = {
      businessId,
      platform,
      breakdown: dimension,
      startDate: range.startDate,
      endDate: range.endDate,
    };
    if (accountId) params.accountId = accountId;

    // Fetch each metric in parallel from the breakdown route
    const metricData = await Promise.all(
      metricKeys.map(async (metricKey) => {
        const data = await fetchInternalJsonWithParams<{
          status: string;
          rows: Array<{ key: string; label: string; value: number }>;
        }>(request, "/api/reports/breakdown", { ...params, metricKey }).catch(() => null);
        return { metricKey, rows: data?.rows ?? [] };
      })
    );

    // Merge by dimension key
    const merged = new Map<string, Record<string, string>>();
    for (const { metricKey, rows } of metricData) {
      for (const row of rows) {
        const existing = merged.get(row.key) ?? { [dimension]: row.label };
        existing[metricKey] = formatMetricValue(metricKey, row.value, currency);
        merged.set(row.key, existing);
      }
    }

    const columns = [dimension, ...metricKeys];
    const rows = Array.from(merged.values());
    return { columns, rows };
  }

  async function fetchTimeBreakdownTable(input: {
    provider: "meta" | "google";
    dimension: "day" | "week" | "month";
    metricKeys: string[];
    accountId?: string;
  }): Promise<{ columns: string[]; rows: Array<Record<string, string>> }> {
    const { provider, dimension, metricKeys, accountId } = input;
    if (metricKeys.length === 0) return { columns: ["date"], rows: [] };

    if (provider === "meta") {
      // Use lib/api/meta.ts directly — same logic as the Meta page, no HTTP hop
      const credentials = await resolveMetaCredentials(businessId).catch(() => null);
      const apiRows = credentials
        ? await getCampaignTimeBreakdown(credentials, range.startDate, range.endDate, dimension).catch(() => [])
        : [];

      const rows: Array<Record<string, string>> = apiRows.map((r) => {
        const label = dimension === "month" ? r.date.slice(0, 7) : r.date.slice(5);
        const row: Record<string, string> = { date: label };
        for (const k of metricKeys) {
          row[k] = formatMetricValue(k, (r as unknown as Record<string, number>)[k] ?? 0, currency);
        }
        return row;
      });

      return { columns: ["date", ...metricKeys], rows };
    }

    // Google: per-day calls (grouped into periods)
    const dates = enumerateDays(range.startDate, range.endDate);
    const fetchKeys = Array.from(new Set([
      ...metricKeys,
      ...metricKeys.flatMap((k) => {
        const ratio = (RATIO_METRICS as Record<string, [string, string, number] | undefined>)[k];
        return ratio ? [ratio[0], ratio[1]] : [];
      }),
    ]));

    const dailyData = await Promise.all(
      dates.map(async (date) => {
        const payload = await fetchInternalJsonWithParams<{ data?: Array<Record<string, unknown>> }>(
          request,
          "/api/google-ads/campaigns",
          {
            businessId,
            dateRange: "custom",
            customStart: date,
            customEnd: date,
            compareMode: "none",
            ...(accountId ? { accountId } : {}),
          }
        ).catch(() => null);
        const rows = (payload?.data ?? []) as Array<Record<string, unknown>>;
        return {
          date,
          metrics: Object.fromEntries(fetchKeys.map((k) => [k, computeDerivedMetric(rows, k, "metrics")])),
        };
      })
    );

    const periodMap = new Map<string, Record<string, number>>();
    for (const { date, metrics } of dailyData) {
      const label = dimension === "day" ? date.slice(5) : dimension === "week" ? date.slice(5) : date.slice(0, 7);
      const existing = periodMap.get(label) ?? {};
      for (const [k, v] of Object.entries(metrics)) {
        existing[k] = (existing[k] ?? 0) + v;
      }
      periodMap.set(label, existing);
    }

    const rows: Array<Record<string, string>> = [];
    for (const [label, sums] of periodMap) {
      const row: Record<string, string> = { date: label };
      for (const k of metricKeys) {
        const ratio = (RATIO_METRICS as Record<string, [string, string, number] | undefined>)[k];
        if (ratio) {
          const [num, den, mult] = ratio;
          const val = (sums[den] ?? 0) > 0 ? ((sums[num] ?? 0) / (sums[den] ?? 1)) * mult : (sums[k] ?? 0);
          row[k] = formatMetricValue(k, val, currency);
        } else {
          row[k] = formatMetricValue(k, sums[k] ?? 0, currency);
        }
      }
      rows.push(row);
    }

    return { columns: ["date", ...metricKeys], rows };
  }

  async function getGoogleCampaignData(accountId?: string) {
    const cacheKey = accountId ?? "__all__";
    const cached = googleCampaignCache.get(cacheKey);
    if (cached) return cached;
    const params = new URLSearchParams({
      businessId,
      dateRange: definition.dateRangePreset,
    });
    if (accountId) params.set("accountId", accountId);
    const payload = await fetchInternalJson<{ data?: Array<Record<string, unknown>>; meta?: Record<string, unknown> }>(
      request,
      `/api/google-ads/campaigns?${params.toString()}`
    );
    googleCampaignCache.set(cacheKey, payload);
    return payload;
  }

  const renderedWidgets = await Promise.all(
    definition.widgets
      .slice()
      .sort((a, b) => a.slot - b.slot)
      .map(async (widget): Promise<RenderedReportWidget> => {
        if (widget.type === "section") {
          return {
            id: widget.id,
            slot: widget.slot,
            colSpan: widget.colSpan,
            rowSpan: widget.rowSpan,
            type: widget.type,
            title: widget.title,
            subtitle: widget.subtitle,
            text: widget.text ?? "",
          };
        }

        if (widget.type === "text") {
          return {
            id: widget.id,
            slot: widget.slot,
            colSpan: widget.colSpan,
            rowSpan: widget.rowSpan,
            type: widget.type,
            title: widget.title,
            subtitle: widget.subtitle,
            text: widget.text ?? "",
          };
        }

        const blockShell = {
          id: widget.id,
          slot: widget.slot,
          colSpan: widget.colSpan,
          rowSpan: widget.rowSpan,
          type: widget.type,
          title: widget.title,
          subtitle: widget.subtitle,
        };

        try {
          // A KPI row is one block carrying four figures. It reads the same
          // blended summary a single KPI tile reads, so a strip and the tiles
          // beside it can never disagree about the same period.
          if (widget.type === "kpirow") {
            const summary = await getOverviewSummaryData();
            const pins = summary?.pins ?? [];
            const wanted = (
              widget.yMetrics?.length ? widget.yMetrics : ["spend", "revenue", "roas", "purchases"]
            ).slice(0, 4);
            const metrics = wanted.map((metricKey) => {
              const pin = pins.find((item) => item.id === metricKey);
              const value = parseNumber(pin?.value);
              return {
                key: metricKey,
                label: pin?.title ?? formatSeriesMetricLabel(metricKey),
                // An unmeasured figure stays unmeasured. A KPI strip that
                // prints 0 for "we have no number" is the failure this avoids.
                value: value == null ? "—" : formatMetricValue(metricKey, value, currency),
              };
            });
            return {
              ...blockShell,
              metrics,
              emptyMessage:
                metrics.every((metric) => metric.value === "—")
                  ? "No blended figures for this period yet."
                  : undefined,
            };
          }

          // A share donut is the attribution table expressed as proportions.
          // Shares come from the same rows the attribution table prints, so a
          // report cannot show one split in the chart and another in the table.
          if (widget.type === "donut") {
            const summary = await getOverviewSummaryData();
            const metricKey = widget.metricKey === "spend" ? "spend" : "revenue";
            const measured = (summary?.attribution ?? [])
              .map((row) => ({
                label: String(row.channel ?? "-"),
                amount: parseNumber(row[metricKey]) ?? 0,
              }))
              .filter((row) => row.amount > 0)
              .sort((left, right) => right.amount - left.amount);
            const total = measured.reduce((sum, row) => sum + row.amount, 0);
            const slices =
              total > 0
                ? measured.slice(0, 4).map((row) => ({
                    label: row.label,
                    value: formatMetricValue(metricKey, row.amount, currency),
                    sharePct: (row.amount / total) * 100,
                  }))
                : [];
            return {
              ...blockShell,
              slices,
              emptyMessage: slices.length === 0 ? "No channel split for this period yet." : undefined,
            };
          }

          if (widget.dataSource === "overview_summary") {
            const summary = await getOverviewSummaryData();
            const pins = summary?.pins ?? [];
            const platformSections = (summary as { platforms?: Array<{ id?: string; metrics?: Array<{ id?: string; value?: number | null }> }> } | null)?.platforms ?? [];

            const directMatch = pins.find((pin) => pin.id === widget.metricKey);
            let value = parseNumber(directMatch?.value);
            let delta = parseNumber(directMatch?.changePct);

            if (value == null && widget.metricKey?.includes("-")) {
              const [providerKey, metricKey] = widget.metricKey.split("-", 2);
              const providerSection = platformSections.find((section) => section.id === providerKey);
              const providerMetric = providerSection?.metrics?.find((metric) => metric.id === metricKey);
              value = parseNumber(providerMetric?.value);
            }

            return {
              id: widget.id,
              slot: widget.slot,
              colSpan: widget.colSpan,
              rowSpan: widget.rowSpan,
              type: widget.type,
              title: widget.title,
              subtitle: widget.subtitle,
              value: formatMetricValue(widget.metricKey ?? "", value, currency),
              deltaLabel:
                delta == null ? null : `${delta > 0 ? "+" : ""}${delta.toFixed(1)}% vs previous`,
              emptyMessage: value == null ? "Metric unavailable for this business." : undefined,
            };
          }

          if (widget.dataSource === "overview_trend") {
            const breakdown = widget.breakdown ?? "day";
            const isDimensionBreakdown =
              breakdown === "age" ||
              breakdown === "gender" ||
              breakdown === "country" ||
              breakdown === "region";

            // Dimension breakdown: call the breakdown API, return as bar chart points
            if (isDimensionBreakdown) {
              const yMetrics = widget.yMetrics?.length
                ? widget.yMetrics
                : widget.metricKey
                  ? [widget.metricKey]
                  : ["meta.spend"];
              const firstMetric = yMetrics[0] ?? "meta.spend";
              const { provider } = getMetricContainerKey(firstMetric);
              const platform = provider === "meta" || provider === "google" ? provider : "meta";
              const breakdownPayload = await fetchInternalJsonWithParams<{
                status: string;
                rows: Array<{ key: string; label: string; value: number }>;
              }>(request, "/api/reports/breakdown", {
                businessId,
                platform,
                breakdown,
                metricKey: firstMetric,
                startDate: range.startDate,
                endDate: range.endDate,
              }).catch(() => null);

              const dimPoints = (breakdownPayload?.rows ?? []).map((row) => ({
                label: row.label,
                value: row.value,
              }));
              const series = [{
                key: firstMetric,
                label: formatSeriesMetricLabel(firstMetric),
                color: getMetricSeriesColor(0),
                points: dimPoints,
              }];
              return {
                id: widget.id,
                slot: widget.slot,
                colSpan: widget.colSpan,
                rowSpan: widget.rowSpan,
                type: widget.type,
                title: widget.title,
                subtitle: widget.subtitle,
                points: dimPoints,
                series,
                axisMode: widget.type === "bar" ? "zero_based" : widget.axisMode ?? "adaptive",
                emptyMessage: dimPoints.length === 0 ? "No breakdown data yet." : undefined,
              };
            }

            // Time-series breakdown
            const data = await getSparklineData();
            const yMetrics = widget.yMetrics?.length
              ? widget.yMetrics
              : widget.metricKey
                ? [widget.metricKey]
                : ["combined.spend"];
            const series = await Promise.all(
              yMetrics.map(async (metricKey, index) => {
                const { provider, metric } = getMetricContainerKey(metricKey);
                let points: Array<{ label: string; value: number }> = [];

                if (provider === "meta" || provider === "google") {
                  points = await buildProviderSeries({
                    request,
                    businessId,
                    provider,
                    metricKey,
                    accountId: widget.accountId ?? null,
                    startDate: range.startDate,
                    endDate: range.endDate,
                    breakdown,
                  });
                } else {
                  const trendSet = data?.sparklines?.combined ?? [];
                  const rawPoints = trendSet.map((point) => ({
                    label: point.date,
                    value: (() => {
                      if (metric === "roas") {
                        const spend = Number(point.spend ?? 0);
                        return spend > 0 ? Number(point.revenue ?? 0) / spend : 0;
                      }
                      if (metric === "spend" || metric === "revenue" || metric === "purchases") {
                        return Number(point[metric] ?? 0);
                      }
                      return 0;
                    })(),
                  }));
                  points = aggregateSeriesPoints(rawPoints, breakdown).map((point) => ({
                    label: breakdown === "day" ? point.label.slice(5) : point.label,
                    value: point.value,
                  }));
                }

                return {
                  key: metricKey,
                  label: formatSeriesMetricLabel(metricKey),
                  color: getMetricSeriesColor(index),
                  points,
                };
              })
            );
            const chartPoints = series[0]?.points ?? [];
            return {
              id: widget.id,
              slot: widget.slot,
              colSpan: widget.colSpan,
              rowSpan: widget.rowSpan,
              type: widget.type,
              title: widget.title,
              subtitle: widget.subtitle,
              points: chartPoints,
              series,
              axisMode: widget.type === "bar" ? "zero_based" : widget.axisMode ?? "adaptive",
              emptyMessage: chartPoints.length === 0 ? "No trend data yet." : undefined,
            };
          }

          if (widget.dataSource === "channel_attribution") {
            const summary = await getOverviewSummaryData();
            const attribution = (summary?.attribution ?? []).slice(0, widget.limit ?? 8);
            const columns = getWidgetColumns(widget, [
              "channel",
              "spend",
              "revenue",
              "roas",
              "conversions",
            ]);
            const rows = attribution.map((row) => ({
              channel: String(row.channel ?? "-"),
              spend: toCurrency(parseNumber(row.spend), currency),
              revenue: toCurrency(parseNumber(row.revenue), currency),
              roas: toRatio(parseNumber(row.roas)),
              conversions: toCompactNumber(parseNumber(row.conversions)),
              clicks: toCompactNumber(parseNumber(row.clicks)),
              ctr: parseNumber(row.ctr) == null ? "-" : `${Number(row.ctr).toFixed(2)}%`,
              cpa: toCurrency(parseNumber(row.cpa), currency),
            }));
            return {
              id: widget.id,
              slot: widget.slot,
              colSpan: widget.colSpan,
              rowSpan: widget.rowSpan,
              type: widget.type,
              title: widget.title,
              subtitle: widget.subtitle,
              columns,
              rows,
              emptyMessage: rows.length === 0 ? "No channel attribution rows yet." : undefined,
            };
          }

          if (widget.dataSource === "meta_campaigns") {
            const payload = await getMetaCampaignData(widget.accountId);
            const scopedRows =
              widget.accountId != null
                ? (payload?.rows ?? []).filter((row) => String(row.accountId ?? "") === widget.accountId)
                : (payload?.rows ?? []);
            const sourceRows = scopedRows.slice(0, widget.limit ?? 8);
            if (widget.type === "metric") {
              const metricKey = widget.metricKey ?? "spend";
              const totalValue = sumMetric(scopedRows, metricKey);
              return {
                id: widget.id,
                slot: widget.slot,
                colSpan: widget.colSpan,
                rowSpan: widget.rowSpan,
                type: widget.type,
                title: widget.title,
                subtitle: widget.subtitle,
                value: formatMetricValue(metricKey, totalValue, currency),
                emptyMessage:
                  scopedRows.length === 0 ? "No Meta campaign metrics for this selection." : undefined,
              };
            }
            // Table with tableDimension support
            const dim = widget.tableDimension;
            const metricCols = (widget.columns ?? []).filter(
              (c) => c !== "name" && c !== "status" && c !== "channel" && c !== "currency"
            );
            if (dim && dim !== "campaign") {
              if (dim === "age" || dim === "gender" || dim === "country" || dim === "region") {
                const { columns, rows } = await fetchBreakdownTable({
                  platform: "meta",
                  dimension: dim,
                  metricKeys: metricCols,
                  accountId: widget.accountId,
                });
                return {
                  id: widget.id, slot: widget.slot, colSpan: widget.colSpan, rowSpan: widget.rowSpan,
                  type: widget.type, title: widget.title, subtitle: widget.subtitle,
                  columns, rows,
                  emptyMessage: rows.length === 0 ? "No breakdown data for this selection." : undefined,
                };
              }
              if (dim === "day" || dim === "week" || dim === "month") {
                const { columns, rows } = await fetchTimeBreakdownTable({
                  provider: "meta", dimension: dim, metricKeys: metricCols, accountId: widget.accountId,
                });
                return {
                  id: widget.id, slot: widget.slot, colSpan: widget.colSpan, rowSpan: widget.rowSpan,
                  type: widget.type, title: widget.title, subtitle: widget.subtitle,
                  columns, rows,
                  emptyMessage: rows.length === 0 ? "No time breakdown data for this selection." : undefined,
                };
              }
            }
            // Campaign dimension: new-style (metric columns only) or legacy
            if (dim === "campaign" && metricCols.length > 0) {
              const columns = ["name", ...metricCols];
              const rows = sourceRows.map((row) => ({
                name: String(row.name ?? "-"),
                ...Object.fromEntries(metricCols.map((col) => [col, formatCellValue(col, row[col], currency)])),
              }));
              return {
                id: widget.id, slot: widget.slot, colSpan: widget.colSpan, rowSpan: widget.rowSpan,
                type: widget.type, title: widget.title, subtitle: widget.subtitle,
                columns, rows,
                emptyMessage: rows.length === 0 ? "No Meta campaign rows for this selection." : undefined,
              };
            }
            // Legacy fallback
            const columns = getWidgetColumns(widget, [
              "name", "status", "spend", "revenue", "purchases", "roas",
            ]);
            const rows = sourceRows.map((row) => mapDynamicColumnsToRow(row, columns, currency));
            return {
              id: widget.id,
              slot: widget.slot,
              colSpan: widget.colSpan,
              rowSpan: widget.rowSpan,
              type: widget.type,
              title: widget.title,
              subtitle: widget.subtitle,
              columns,
              rows,
              emptyMessage: rows.length === 0 ? "No Meta campaign rows for this selection." : undefined,
            };
          }

          if (widget.dataSource === "google_campaigns") {
            const payload = await getGoogleCampaignData(widget.accountId);
            const scopedRows =
              widget.accountId != null
                ? (payload?.data ?? []).filter((row) => String(row.customerId ?? row.customer_id ?? "") === widget.accountId)
                : (payload?.data ?? []);
            const sourceRows = scopedRows.slice(0, widget.limit ?? 8);
            if (widget.type === "metric") {
              const metricKey = widget.metricKey ?? "spend";
              const totalValue = sumMetric(scopedRows, metricKey, "metrics");
              return {
                id: widget.id,
                slot: widget.slot,
                colSpan: widget.colSpan,
                rowSpan: widget.rowSpan,
                type: widget.type,
                title: widget.title,
                subtitle: widget.subtitle,
                value: formatMetricValue(metricKey, totalValue, currency),
                warning: hasPermissionWarning(payload?.meta)
                  ? "Google Ads returned a permission warning for this business."
                  : null,
                emptyMessage:
                  scopedRows.length === 0 ? "No Google campaign metrics for this selection." : undefined,
              };
            }
            const googleWarning = hasPermissionWarning(payload?.meta)
              ? "Google Ads returned a permission warning for this business."
              : null;

            // Table with tableDimension support
            const googleDim = widget.tableDimension;
            const googleMetricCols = (widget.columns ?? []).filter(
              (c) => c !== "name" && c !== "status" && c !== "channel" && c !== "currency"
            );
            if (googleDim && googleDim !== "campaign") {
              if (googleDim === "day" || googleDim === "week" || googleDim === "month") {
                const { columns, rows } = await fetchTimeBreakdownTable({
                  provider: "google", dimension: googleDim, metricKeys: googleMetricCols, accountId: widget.accountId,
                });
                return {
                  id: widget.id, slot: widget.slot, colSpan: widget.colSpan, rowSpan: widget.rowSpan,
                  type: widget.type, title: widget.title, subtitle: widget.subtitle,
                  columns, rows, warning: googleWarning,
                  emptyMessage: rows.length === 0 ? "No time breakdown data for this selection." : undefined,
                };
              }
            }
            if (googleDim === "campaign" && googleMetricCols.length > 0) {
              const columns = ["name", ...googleMetricCols];
              const rows = sourceRows.map((row) => ({
                name: String(row.name ?? "-"),
                ...Object.fromEntries(
                  googleMetricCols.map((col) => [col, formatCellValue(col, ((row.metrics as Record<string, unknown>) ?? row)[col], currency)])
                ),
              }));
              return {
                id: widget.id, slot: widget.slot, colSpan: widget.colSpan, rowSpan: widget.rowSpan,
                type: widget.type, title: widget.title, subtitle: widget.subtitle,
                columns, rows, warning: googleWarning,
                emptyMessage: rows.length === 0 ? "No Google campaign rows for this selection." : undefined,
              };
            }
            // Legacy fallback
            const columns = getWidgetColumns(widget, [
              "name", "status", "spend", "revenue", "conversions", "roas",
            ]);
            const rows = sourceRows.map((row) => ({
              ...mapDynamicColumnsToRow(row, columns.filter((column) => column === "name" || column === "status"), currency),
              ...mapDynamicColumnsToRow(
                row,
                columns.filter((column) => column !== "name" && column !== "status"),
                currency,
                "metrics"
              ),
            }));
            return {
              id: widget.id,
              slot: widget.slot,
              colSpan: widget.colSpan,
              rowSpan: widget.rowSpan,
              type: widget.type,
              title: widget.title,
              subtitle: widget.subtitle,
              columns,
              rows,
              warning: googleWarning,
              emptyMessage: rows.length === 0 ? "No Google campaign rows for this selection." : undefined,
            };
          }

          const comingSoonSources = ["search_console_data", "ga4_data", "klaviyo_data", "shopify_data"];
          const isComingSoon = comingSoonSources.includes(widget.dataSource ?? "");
          return {
            id: widget.id,
            slot: widget.slot,
            colSpan: widget.colSpan,
            rowSpan: widget.rowSpan,
            type: widget.type,
            title: widget.title,
            subtitle: widget.subtitle,
            emptyMessage: isComingSoon ? "Data integration coming soon." : "Unsupported widget source.",
          };
        } catch (error) {
          return {
            id: widget.id,
            slot: widget.slot,
            colSpan: widget.colSpan,
            rowSpan: widget.rowSpan,
            type: widget.type,
            title: widget.title,
            subtitle: widget.subtitle,
            // A build failure is reported as a failure. It must not travel
            // through emptyMessage, where the reader would take it for a period
            // that genuinely had no data.
            errorMessage:
              error instanceof Error ? error.message : "This widget could not be loaded.",
            retryable: true,
            warning: error instanceof Error ? error.message : "This widget could not be loaded.",
          };
        }
      })
  );

  return {
    businessId,
    reportId,
    name,
    description,
    dateRangeLabel: `${range.label} (${range.startDate} to ${range.endDate})`,
    // The window actually rendered, recorded so a share or print of this payload
    // reproduces this period instead of recomputing a trailing preset later.
    startDate: range.startDate,
    endDate: range.endDate,
    currency,
    compareMode: definition.compareMode ?? null,
    generatedAt: new Date().toISOString(),
    widgets: renderedWidgets,
  };
}

function hasPermissionWarning(meta: unknown) {
  if (!meta || typeof meta !== "object") return false;
  const warnings = (meta as { warnings?: unknown }).warnings;
  return Array.isArray(warnings)
    ? warnings.some(
        (warning) =>
          typeof warning === "string" &&
          warning.toUpperCase().includes("PERMISSION")
      )
    : false;
}

export async function renderCustomReportRecord(
  request: NextRequest,
  report: CustomReportRecord,
  options: {
    startDateOverride?: string;
    endDateOverride?: string;
    currency?: string | null;
  } = {}
) {
  return renderCustomReport({
    request,
    businessId: report.businessId,
    reportId: report.id,
    name: report.name,
    description: report.description,
    definition: report.definition,
    startDateOverride: options.startDateOverride,
    endDateOverride: options.endDateOverride,
    currency: options.currency ?? null,
  });
}
