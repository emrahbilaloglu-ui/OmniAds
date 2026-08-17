import { getIntegration } from "@/lib/integrations";
import { fetchWithTimeout } from "@/lib/http-fetch-with-timeout";
import {
  normalizeCurrencyCode,
  refreshGA4AccessToken,
} from "@/lib/google-analytics-accounts";
import { backfillGa4PropertyCurrency } from "@/lib/google-analytics-property-currency";
import { connectionGenerationTokenFromIntegration } from "@/lib/provider-property-selection";
import {
  buildGoogleRequestSignature,
  getGoogleRequestAuditContext,
} from "@/lib/google-request-audit";
import { runProviderRequestWithGovernance } from "@/lib/provider-request-governance";

const REPORTING_API_BASE = "https://analyticsdata.googleapis.com/v1beta";
// 60 sn → 5 dk: quota hatasında daha uzun bekleme
const QUOTA_COOLDOWN_MS = 5 * 60_000;
// GA4 runReport is called from the sync worker loop; bound it so a stalled
// socket cannot park the worker.
const GA4_FETCH_TIMEOUT_MS = 30_000;
let quotaCooldownUntil = 0;

// GA4 token quota: property başına günlük 200k token limit.
// quotaTokensRemaining header'ı gönderildiğinde takip edilir.
function getQuotaUsageStore() {
  const g = globalThis as typeof globalThis & {
    __omniadsGa4QuotaUsage?: Map<string, { remaining: number; checkedAt: number }>;
  };
  if (!g.__omniadsGa4QuotaUsage) g.__omniadsGa4QuotaUsage = new Map();
  return g.__omniadsGa4QuotaUsage;
}

function updateQuotaFromHeaders(propertyId: string, headers: Headers): void {
  const remaining = headers.get("X-RateLimit-Remaining") ?? headers.get("x-ratelimit-remaining");
  if (remaining === null) return;
  const value = parseInt(remaining, 10);
  if (!Number.isFinite(value)) return;
  getQuotaUsageStore().set(propertyId, { remaining: value, checkedAt: Date.now() });
  if (value < 2000) {
    console.warn("[ga4-quota] low_quota", { propertyId, remaining: value });
  }
}

export function isGa4InvalidArgumentError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.message.includes("GA4 Reporting API error 400") &&
    error.message.includes("INVALID_ARGUMENT")
  );
}

// ── Types ──────────────────────────────────────────────────────────

export interface GA4DateRange {
  startDate: string; // "YYYY-MM-DD"
  endDate: string;
}

interface RunReportParams {
  propertyId: string;
  accessToken: string;
  businessId?: string;
  requestType?: string;
  requestSource?: "cron_sync" | "background_refresh" | "live_report" | "discovery" | "unknown";
  requestPath?: string | null;
  dateRanges: GA4DateRange[];
  dimensions?: Array<{ name: string }>;
  metrics: Array<{ name: string }>;
  dimensionFilter?: object;
  orderBys?: object[];
  limit?: number;
  keepEmptyRows?: boolean;
}

export interface GA4ReportRow {
  dimensions: string[];
  metrics: string[];
}

export interface GA4ReportResult {
  dimensionHeaders: string[];
  metricHeaders: string[];
  rows: GA4ReportRow[];
  rowCount: number;
  totals?: GA4ReportRow[];
}

export interface GA4ResolvedAnalyticsContext {
  businessId: string;
  integrationId: string;
  accessToken: string;
  refreshToken: string | null;
  propertyId: string | null;
  propertyName: string | null;
  propertyResourceName: string | null;
  /**
   * ISO 4217 code of the property, from the Admin API's `Property.currencyCode`.
   * Every GA4 money metric is quoted in it.
   *
   * Written at selection, and — for the properties selected before that write
   * existed — filled in on the first read that needs it and persisted, so the
   * fetch happens once rather than once per request. `null` only when the Admin
   * read itself could not establish one; callers serve that null through
   * untouched and the surfaces render the missing value rather than dollars.
   */
  propertyCurrency: string | null;
}

interface ResolveGa4AnalyticsContextOptions {
  requireProperty?: boolean;
}

// ── Core Report Runner ─────────────────────────────────────────────

export async function runGA4Report(
  params: RunReportParams
): Promise<GA4ReportResult> {
  const body: Record<string, unknown> = {
    dateRanges: params.dateRanges,
    metrics: params.metrics,
  };
  if (params.dimensions) body.dimensions = params.dimensions;
  if (params.dimensionFilter) body.dimensionFilter = params.dimensionFilter;
  if (params.orderBys) body.orderBys = params.orderBys;
  if (params.limit) body.limit = params.limit;
  if (params.keepEmptyRows !== undefined)
    body.keepEmptyRows = params.keepEmptyRows;

  const execute = async () => {
    if (Date.now() < quotaCooldownUntil) {
      throw new GA4AuthError(
        "ga4_quota_exceeded",
        "GA4 request quota is temporarily exhausted. Please try again in a few minutes.",
        429,
        "retry_later"
      );
    }

    // Strip "properties/" prefix if present to get numeric ID
    const numericId = params.propertyId.replace(/^properties\//, "");
    const url = `${REPORTING_API_BASE}/properties/${numericId}:runReport`;

    const res = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${params.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
      { timeoutMs: GA4_FETCH_TIMEOUT_MS, label: "GA4 runReport" },
    );

    // Quota bilgisini response header'larından oku
    updateQuotaFromHeaders(params.propertyId, res.headers);

    if (!res.ok) {
      const errorText = await res.text();
      const normalizedError = errorText.toUpperCase();

      if (
        res.status === 429 ||
        normalizedError.includes("RESOURCE_EXHAUSTED") ||
        normalizedError.includes("QUOTA") ||
        normalizedError.includes("RATE LIMIT") ||
        normalizedError.includes("TOO MANY REQUESTS")
      ) {
        quotaCooldownUntil = Date.now() + QUOTA_COOLDOWN_MS;
        throw new GA4AuthError(
          "ga4_quota_exceeded",
          "GA4 request quota is temporarily exhausted. Please try again in a few minutes.",
          429,
          "retry_later"
        );
      }

      if (res.status === 401) {
        throw new GA4AuthError(
          "ga4_unauthenticated",
          "GA4 credentials were rejected by Google. Please reconnect GA4.",
          401,
          "reconnect_ga4"
        );
      }

      if (
        res.status === 403 &&
        (normalizedError.includes("PERMISSION") ||
          normalizedError.includes("ACCESS") ||
          normalizedError.includes("SCOPE"))
      ) {
        throw new GA4AuthError(
          "ga4_permission_denied",
          "GA4 access was denied for the selected property. Check permissions or reconnect GA4.",
          403,
          "reconnect_ga4"
        );
      }

      throw new Error(`GA4 Reporting API error ${res.status}: ${errorText}`);
    }

    const data = await res.json();

    const dimensionHeaders: string[] =
      (data.dimensionHeaders ?? []).map((h: { name: string }) => h.name);
    const metricHeaders: string[] =
      (data.metricHeaders ?? []).map((h: { name: string }) => h.name);

    const rows: GA4ReportRow[] = (data.rows ?? []).map(
      (row: {
        dimensionValues?: Array<{ value: string }>;
        metricValues?: Array<{ value: string }>;
      }) => ({
        dimensions: (row.dimensionValues ?? []).map((d) => d.value ?? ""),
        metrics: (row.metricValues ?? []).map((m) => m.value ?? "0"),
      })
    );

    const totals: GA4ReportRow[] | undefined = data.totals
      ? (data.totals as Array<{
          dimensionValues?: Array<{ value: string }>;
          metricValues?: Array<{ value: string }>;
        }>).map((row) => ({
          dimensions: (row.dimensionValues ?? []).map((d) => d.value ?? ""),
          metrics: (row.metricValues ?? []).map((m) => m.value ?? "0"),
        }))
      : undefined;

    return {
      dimensionHeaders,
      metricHeaders,
      rows,
      rowCount: data.rowCount ?? rows.length,
      totals,
    };
  };

  const requestContext = getGoogleRequestAuditContext("ga4");
  const governedBusinessId = params.businessId ?? requestContext?.businessId ?? null;
  if (!governedBusinessId) {
    return execute();
  }

  const requestTypeBase = params.requestType ?? requestContext?.requestType ?? "ga4_report";
  const requestSource = params.requestSource ?? requestContext?.requestSource;
  const requestPath = params.requestPath ?? requestContext?.requestPath;
  const requestSignature = buildGoogleRequestSignature({
    propertyId: params.propertyId,
    body,
  });

  return runProviderRequestWithGovernance({
    provider: "ga4",
    businessId: governedBusinessId,
    requestType: `${requestTypeBase}:${requestSignature}`,
    requestSource,
    requestPath,
    tripGlobalBreakerFor: ["quota", "auth", "permission"],
    execute,
  });
}

// ── Token Helper ───────────────────────────────────────────────────

function normalizePropertyResource(propertyId: string): string {
  const trimmed = propertyId.trim();
  if (!trimmed) {
    throw new GA4AuthError(
      "integration_malformed",
      "GA4 integration is missing a valid selected property.",
      500,
      "reconnect_ga4"
    );
  }
  if (/^\d+$/.test(trimmed)) {
    return `properties/${trimmed}`;
  }
  if (/^properties\/\d+$/.test(trimmed)) {
    return trimmed;
  }
  throw new GA4AuthError(
    "integration_malformed",
    "GA4 selected property format is invalid. Please reselect the GA4 property.",
    500,
    "select_property"
  );
}

export async function resolveGa4AnalyticsContext(
  businessId: string,
  options: ResolveGa4AnalyticsContextOptions = {}
): Promise<GA4ResolvedAnalyticsContext> {
  const requireProperty = options.requireProperty ?? true;
  const integration = await getIntegration(businessId, "ga4");

  if (!integration || integration.status !== "connected") {
    throw new GA4AuthError(
      "ga4_not_connected",
      "GA4 is not connected for this business.",
      404,
      "connect_ga4"
    );
  }

  const metadata =
    integration.metadata && typeof integration.metadata === "object"
      ? (integration.metadata as Record<string, unknown>)
      : {};
  const propertyId =
    typeof metadata.ga4PropertyId === "string" ? metadata.ga4PropertyId : null;
  const propertyName =
    typeof metadata.ga4PropertyName === "string"
      ? metadata.ga4PropertyName
      : "";
  const storedPropertyCurrency = normalizeCurrencyCode(metadata.ga4PropertyCurrency);

  // Captured from the row that also produced the credential below, strictly
  // before that credential is resolved — the ordering the selection route
  // documents, and the reason a reconnect landing inside the Admin round trip
  // is a refusal rather than a silent overwrite.
  const connectionGeneration = connectionGenerationTokenFromIntegration(integration);

  if (requireProperty && !propertyId) {
    throw new GA4AuthError(
      "no_property_selected",
      "GA4 is connected but no property is selected for this business.",
      422,
      "select_property"
    );
  }

  const propertyResourceName = propertyId
    ? normalizePropertyResource(propertyId)
    : null;
  const normalizedPropertyId = propertyResourceName
    ? propertyResourceName.replace(/^properties\//, "")
    : null;

  let accessToken = integration.access_token;
  const refreshToken = integration.refresh_token;
  const now = Date.now();
  const expiresAtMs = integration.token_expires_at
    ? new Date(integration.token_expires_at).getTime()
    : null;
  const isExpired = typeof expiresAtMs === "number" && expiresAtMs <= now;

  const shouldRefresh = Boolean(refreshToken) && (isExpired || !accessToken);
  if (shouldRefresh && refreshToken) {
    try {
      const refreshed = await refreshGA4AccessToken(refreshToken);
      accessToken = refreshed.accessToken;
    } catch {
      throw new GA4AuthError(
        "token_refresh_failed",
        "GA4 access token could not be refreshed. Please reconnect GA4.",
        401,
        "reconnect_ga4"
      );
    }
  }

  if (isExpired && !refreshToken) {
    throw new GA4AuthError(
      "token_expired",
      "GA4 access token has expired and no refresh token is available. Please reconnect GA4.",
      401,
      "reconnect_ga4"
    );
  }

  if (!accessToken) {
    throw new GA4AuthError(
      "missing_access_token",
      "GA4 access token is missing. Please reconnect GA4.",
      401,
      "reconnect_ga4"
    );
  }

  // The currency is stored at selection, so every property selected before that
  // write existed has none — and a selection is not an act users repeat, which
  // made "unknown" permanent and every GA4 revenue figure a dash. Fill it from
  // the same Admin read the selection uses, once, and persist it.
  //
  // Only on a read that needs the property: `requireProperty: false` is the
  // selection route resolving a credential in order to CHOOSE a property, and it
  // does its own metadata read immediately afterwards.
  let propertyCurrency = storedPropertyCurrency;
  if (requireProperty && propertyResourceName && !propertyCurrency) {
    propertyCurrency = await backfillGa4PropertyCurrency({
      businessId,
      propertyResourceName,
      accessToken,
      expectedConnectionGeneration: connectionGeneration,
    });
  }

  return {
    businessId,
    integrationId: integration.id,
    accessToken,
    refreshToken,
    propertyId: normalizedPropertyId,
    propertyName: propertyName || null,
    propertyResourceName,
    propertyCurrency,
  };
}

/**
 * Backward-compatible helper used by analytics routes.
 */
export async function getGA4TokenAndProperty(
  businessId: string
): Promise<{
  accessToken: string;
  propertyId: string;
  propertyName: string;
  /**
   * The property's ISO 4217 code, or `null` when the Admin API could not
   * establish one. Callers that serve money must pass it through untouched:
   * `null` means the unit is unknown, which renders as the missing value, not
   * as dollars.
   */
  currencyCode: string | null;
}> {
  const context = await resolveGa4AnalyticsContext(businessId);
  if (!context.propertyId) {
    throw new GA4AuthError(
      "no_property_selected",
      "GA4 is connected but no property is selected for this business.",
      422,
      "select_property"
    );
  }
  return {
    accessToken: context.accessToken,
    propertyId: context.propertyId,
    propertyName: context.propertyName ?? "",
    currencyCode: context.propertyCurrency,
  };
}

export class GA4AuthError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number = 401,
    public readonly action:
      | "connect_ga4"
      | "select_property"
      | "reconnect_ga4"
      | "retry_later" = "retry_later"
  ) {
    super(message);
    this.name = "GA4AuthError";
  }
}

// ── Insight Generator ──────────────────────────────────────────────

export interface AnalyticsInsight {
  type: "positive" | "warning" | "neutral";
  text: string;
}

export function generateInsights(data: {
  overview?: { sessions: number; engagedSessions: number; purchases: number; revenue: number };
  products?: Array<{ name: string; views: number; atcRate: number; purchaseRate: number }>;
  landingPages?: Array<{ path: string; sessions: number; engagementRate: number; purchaseCvr: number }>;
  audience?: { newSessions: number; newPurchases: number; returningSessions: number; returningPurchases: number };
  demographics?: { dimension: string; topValue: string; topValuePurchaseCvr: number; avgPurchaseCvr: number };
}): AnalyticsInsight[] {
  const insights: AnalyticsInsight[] = [];

  // Returning vs new users
  if (data.audience) {
    const { newSessions, newPurchases, returningSessions, returningPurchases } =
      data.audience;
    const newCvr = newSessions > 0 ? newPurchases / newSessions : 0;
    const returningCvr =
      returningSessions > 0 ? returningPurchases / returningSessions : 0;
    if (returningCvr > 0 && newCvr > 0) {
      const multiplier = returningCvr / newCvr;
      if (multiplier >= 1.5) {
        insights.push({
          type: "positive",
          text: `Returning users convert ${multiplier.toFixed(1)}× better than new visitors.`,
        });
      }
    }
  }

  // Top converting product
  if (data.products && data.products.length > 0) {
    const sorted = [...data.products].sort((a, b) => b.atcRate - a.atcRate);
    const best = sorted[0];
    if (best.atcRate > 0.1) {
      insights.push({
        type: "positive",
        text: `"${best.name}" has the highest add-to-cart rate at ${(best.atcRate * 100).toFixed(1)}%.`,
      });
    }
    // Worst performer with decent traffic
    const highTrafficLowConvert = data.products
      .filter((p) => p.views > 50 && p.purchaseRate < 0.01)
      .sort((a, b) => b.views - a.views)[0];
    if (highTrafficLowConvert) {
      insights.push({
        type: "warning",
        text: `"${highTrafficLowConvert.name}" gets traffic but has a very low purchase rate — check the product page.`,
      });
    }
  }

  // Landing page with high traffic but low engagement
  if (data.landingPages && data.landingPages.length > 0) {
    const highTrafficLowEngage = data.landingPages
      .filter(
        (p) => p.sessions > 100 && p.engagementRate < 0.3
      )
      .sort((a, b) => b.sessions - a.sessions)[0];
    if (highTrafficLowEngage) {
      insights.push({
        type: "warning",
        text: `${highTrafficLowEngage.path} gets high traffic but low engagement (${(highTrafficLowEngage.engagementRate * 100).toFixed(0)}%) — review content relevance.`,
      });
    }

    // Best converting landing page
    const bestPage = [...data.landingPages]
      .filter((p) => p.sessions > 30)
      .sort((a, b) => b.purchaseCvr - a.purchaseCvr)[0];
    if (bestPage && bestPage.purchaseCvr > 0.02) {
      insights.push({
        type: "positive",
        text: `${bestPage.path} is your top-converting landing page at ${(bestPage.purchaseCvr * 100).toFixed(1)}% purchase CVR.`,
      });
    }
  }

  // Overall engagement health
  if (data.overview) {
    const engagementRate =
      data.overview.sessions > 0
        ? data.overview.engagedSessions / data.overview.sessions
        : 0;
    if (engagementRate < 0.4 && data.overview.sessions > 200) {
      insights.push({
        type: "warning",
        text: `Overall engagement rate is low at ${(engagementRate * 100).toFixed(0)}% — check traffic quality and landing page relevance.`,
      });
    }
  }

  // Top demographic
  if (data.demographics && data.demographics.topValuePurchaseCvr > 0) {
    const lift =
      data.demographics.avgPurchaseCvr > 0
        ? data.demographics.topValuePurchaseCvr /
          data.demographics.avgPurchaseCvr
        : 0;
    if (lift >= 1.5) {
      insights.push({
        type: "positive",
        text: `${data.demographics.dimension} "${data.demographics.topValue}" converts ${lift.toFixed(1)}× above average.`,
      });
    }
  }

  return insights.slice(0, 5);
}
