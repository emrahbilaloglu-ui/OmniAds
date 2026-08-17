"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { InsightsAnalyticsExact } from "@/components/analytics/InsightsAnalyticsExact";
import {
  buildInsightsAnalyticsExactModel,
  type AnalyticsAudienceInput,
  type AnalyticsCohortsInput,
  type AnalyticsDemoDimension,
  type AnalyticsDemographicsInput,
  type AnalyticsLandingInput,
  type AnalyticsOverviewInput,
  type AnalyticsProductInput,
} from "@/components/analytics/insights-analytics-exact-adapter";
import type { AnalyticsTabId } from "@/components/analytics/insights-analytics-exact-model";
import { BusinessEmptyState } from "@/components/business/BusinessEmptyState";
import { IntegrationEmptyState } from "@/components/states/IntegrationEmptyState";
import { ErrorState } from "@/components/states/error-state";
import { LoadingSkeleton } from "@/components/states/loading-skeleton";
import { getPresetDates } from "@/components/date-range/DateRangePicker";
import { usePersistentDateRange } from "@/hooks/use-persistent-date-range";
import { useBusinessIntegrationsBootstrap } from "@/hooks/use-business-integrations-bootstrap";
import { isDemoBusinessSelected } from "@/lib/business-mode";
import { getComparisonWindow } from "@/lib/google-ads/reporting-support";
import { useAppStore } from "@/store/app-store";
import { useIntegrationsStore } from "@/store/integrations-store";
import {
  buildDefaultProviderDomains,
  deriveProviderViewState,
} from "@/store/integrations-support";

interface AnalyticsApiErrorPayload {
  error?: string;
  message?: string;
  action?: "connect_ga4" | "select_property" | "reconnect_ga4" | "retry_later";
  reconnectRequired?: boolean;
}

function buildAnalyticsRequestError(
  payload: AnalyticsApiErrorPayload,
  fallbackMessage: string,
) {
  const message = payload.message ?? fallbackMessage;
  const error = new Error(message) as Error & {
    code?: string;
    action?: AnalyticsApiErrorPayload["action"];
    reconnectRequired?: boolean;
  };
  error.code = payload.error;
  error.action = payload.action;
  error.reconnectRequired = payload.reconnectRequired;
  return error;
}

export function formatAnalyticsErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  const typed = error as Error & { action?: AnalyticsApiErrorPayload["action"] };
  if (typed.action === "connect_ga4") {
    return `${typed.message} Connect GA4 in Integrations to continue.`;
  }
  if (typed.action === "select_property") {
    return `${typed.message} Select a GA4 property in Integrations to continue.`;
  }
  if (typed.action === "reconnect_ga4") {
    return `${typed.message} Reconnect GA4 in Integrations.`;
  }
  if (typed.action === "retry_later") {
    return `${typed.message} The page stopped retrying automatically to avoid consuming more GA4 quota.`;
  }
  return typed.message || fallback;
}

const analyticsQueryOptions = {
  retry: false,
  refetchOnWindowFocus: false,
} as const;

async function readAnalytics<T>(url: string, fallbackMessage: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as AnalyticsApiErrorPayload;
    throw buildAnalyticsRequestError(body, fallbackMessage);
  }
  return (await response.json()) as T;
}

function windowDaysBetween(start: string, end: string): number | null {
  if (!start || !end) return null;
  const startMs = Date.parse(`${start}T00:00:00.000Z`);
  const endMs = Date.parse(`${end}T00:00:00.000Z`);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  return Math.max(1, Math.round((endMs - startMs) / 86_400_000) + 1);
}

/**
 * The Insights → Analytics data boundary.
 *
 * Reads the five GA4 endpoints the design's facts come from, hands them to the
 * pure adapter, and renders the exact component. Every route family that
 * reaches this screen — the preserved `/insights/analytics` and the canonical
 * `/c/{businessId}/analytics/**` twins — mounts this one component.
 */
export function InsightsAnalyticsScreen({
  businessId: scopedBusinessId,
  initialTab = "overview",
}: {
  /** Server-authorized on the canonical routes; absent on the legacy route. */
  businessId?: string;
  initialTab?: AnalyticsTabId;
}) {
  const businesses = useAppStore((state) => state.businesses);
  const selectedBusinessId = useAppStore((state) => state.selectedBusinessId);
  const resolvedBusinessId = scopedBusinessId ?? selectedBusinessId ?? null;
  const businessId = resolvedBusinessId ?? "";

  const domains = useIntegrationsStore((state) =>
    resolvedBusinessId ? state.domainsByBusinessId[resolvedBusinessId] : undefined,
  );
  const { isBootstrapping, bootstrapStatus } =
    useBusinessIntegrationsBootstrap(resolvedBusinessId);

  const isDemoBusiness = isDemoBusinessSelected(resolvedBusinessId, businesses);
  const ga4View = deriveProviderViewState(
    "ga4",
    domains?.ga4 ?? buildDefaultProviderDomains().ga4,
  );
  const ga4Connected = ga4View.isConnected || isDemoBusiness;
  const showBootstrapGuard =
    !isDemoBusiness &&
    (isBootstrapping ||
      ga4View.status === "loading_data" ||
      (bootstrapStatus !== "ready" && !ga4View.isConnected));

  const [activeTab, setActiveTab] = useState<AnalyticsTabId>(initialTab);
  const [demoDimension, setDemoDimension] = useState<AnalyticsDemoDimension>("country");
  const [dateRange] = usePersistentDateRange();

  const { start: startDate, end: endDate } = getPresetDates(
    dateRange.rangePreset,
    dateRange.customStart,
    dateRange.customEnd,
  );
  const comparison = getComparisonWindow({
    compareMode: "previous_period",
    startDate,
    endDate,
  });
  const compareQuery = comparison
    ? `&compareStartDate=${comparison.startDate}&compareEndDate=${comparison.endDate}`
    : "";
  const range = `businessId=${businessId}&startDate=${startDate}&endDate=${endDate}`;

  const overviewQuery = useQuery({
    queryKey: ["insights-analytics-overview", businessId, startDate, endDate, compareQuery],
    enabled: ga4Connected && businessId.length > 0,
    queryFn: () =>
      readAnalytics<AnalyticsOverviewInput>(
        `/api/analytics/overview?${range}${compareQuery}`,
        "Failed to load analytics overview.",
      ),
    ...analyticsQueryOptions,
  });

  const productsQuery = useQuery({
    queryKey: ["insights-analytics-products", businessId, startDate, endDate],
    enabled:
      ga4Connected &&
      businessId.length > 0 &&
      (activeTab === "products" || activeTab === "opps"),
    queryFn: () =>
      readAnalytics<{ products?: AnalyticsProductInput[] }>(
        `/api/analytics/products?${range}`,
        "Failed to load product funnel data.",
      ),
    ...analyticsQueryOptions,
  });

  const landingPagesQuery = useQuery({
    queryKey: ["insights-analytics-landing-pages", businessId, startDate, endDate],
    enabled:
      ga4Connected &&
      businessId.length > 0 &&
      (activeTab === "landing" || activeTab === "opps"),
    queryFn: () =>
      readAnalytics<{ pages?: AnalyticsLandingInput[] }>(
        `/api/analytics/landing-pages?${range}`,
        "Failed to load landing page data.",
      ),
    ...analyticsQueryOptions,
  });

  const audienceQuery = useQuery({
    queryKey: ["insights-analytics-audience", businessId, startDate, endDate],
    enabled:
      ga4Connected &&
      businessId.length > 0 &&
      (activeTab === "audience" || activeTab === "opps"),
    queryFn: () =>
      readAnalytics<AnalyticsAudienceInput>(
        `/api/analytics/audience?${range}`,
        "Failed to load audience data.",
      ),
    ...analyticsQueryOptions,
  });

  const demographicsQuery = useQuery({
    queryKey: [
      "insights-analytics-demographics",
      businessId,
      startDate,
      endDate,
      demoDimension,
    ],
    enabled: ga4Connected && businessId.length > 0 && activeTab === "demo",
    queryFn: () =>
      readAnalytics<AnalyticsDemographicsInput>(
        `/api/analytics/demographics?${range}&dimension=${demoDimension}`,
        "Failed to load demographic data.",
      ),
    ...analyticsQueryOptions,
  });

  const cohortsQuery = useQuery({
    queryKey: ["insights-analytics-cohorts", businessId, startDate, endDate],
    enabled: ga4Connected && businessId.length > 0 && activeTab === "cohorts",
    queryFn: () =>
      readAnalytics<AnalyticsCohortsInput>(
        `/api/analytics/cohorts?${range}`,
        "Failed to load cohort data.",
      ),
    ...analyticsQueryOptions,
  });

  if (!resolvedBusinessId) return <BusinessEmptyState />;
  if (showBootstrapGuard) return <LoadingSkeleton rows={4} />;
  if (!ga4Connected) {
    return (
      <IntegrationEmptyState
        providerLabel="GA4"
        status={ga4View.status === "action_required" ? "error" : "disconnected"}
        title="Connect GA4 to unlock Analytics"
        description="Analytics insights are powered by your Google Analytics 4 property. Connect GA4 and select a property to get started."
      />
    );
  }

  const activeError =
    activeTab === "products"
      ? productsQuery.error
      : activeTab === "landing"
        ? landingPagesQuery.error
        : activeTab === "audience"
          ? audienceQuery.error
          : activeTab === "demo"
            ? demographicsQuery.error
            : activeTab === "cohorts"
              ? cohortsQuery.error
              : (overviewQuery.error ??
                productsQuery.error ??
                landingPagesQuery.error ??
                audienceQuery.error);

  const model = buildInsightsAnalyticsExactModel({
    activeTab,
    demoDimension,
    windowDays: windowDaysBetween(startDate, endDate),
    overview: overviewQuery.data ?? null,
    audience: audienceQuery.data ?? null,
    products: productsQuery.data?.products ?? null,
    landingPages: landingPagesQuery.data?.pages ?? null,
    demographics: demographicsQuery.data ?? null,
    cohorts: cohortsQuery.data ?? null,
  });

  return (
    <>
      {activeError ? (
        <ErrorState
          description={formatAnalyticsErrorMessage(
            activeError,
            "Failed to load analytics data.",
          )}
          onRetry={() => {
            void overviewQuery.refetch();
            if (activeTab === "products" || activeTab === "opps") {
              void productsQuery.refetch();
            }
            if (activeTab === "landing" || activeTab === "opps") {
              void landingPagesQuery.refetch();
            }
            if (activeTab === "audience" || activeTab === "opps") {
              void audienceQuery.refetch();
            }
            if (activeTab === "demo") void demographicsQuery.refetch();
            if (activeTab === "cohorts") void cohortsQuery.refetch();
          }}
        />
      ) : null}
      <InsightsAnalyticsExact
        model={model}
        onSelectTab={setActiveTab}
        onSelectDemoDimension={(dimension) =>
          setDemoDimension(dimension as AnalyticsDemoDimension)
        }
      />
    </>
  );
}
