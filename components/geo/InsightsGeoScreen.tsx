"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { InsightsGeoExact } from "@/components/geo/InsightsGeoExact";
import {
  buildInsightsGeoExactModel,
  type GeoOpportunityInput,
  type GeoOverviewInput,
  type GeoPageInput,
  type GeoQueryFilterId,
  type GeoQueryInput,
  type GeoSourceInput,
  type GeoTopicInput,
} from "@/components/geo/insights-geo-exact-adapter";
import type { GeoTabId } from "@/components/geo/insights-geo-exact-model";
import { BusinessEmptyState } from "@/components/business/BusinessEmptyState";
import { getPresetDates } from "@/components/date-range/DateRangePicker";
import { IntegrationEmptyState } from "@/components/states/IntegrationEmptyState";
import { ErrorState } from "@/components/states/error-state";
import {
  formatGa4ErrorMessage,
  resolveGa4SetupState,
  type Ga4ActionableError,
  type Ga4ErrorAction,
} from "@/components/states/ga4-setup-state";
import { LoadingSkeleton } from "@/components/states/loading-skeleton";
import { usePersistentDateRange } from "@/hooks/use-persistent-date-range";
import { useBusinessIntegrationsBootstrap } from "@/hooks/use-business-integrations-bootstrap";
import { isDemoBusinessSelected } from "@/lib/business-mode";
import { useAppStore } from "@/store/app-store";
import { useIntegrationsStore } from "@/store/integrations-store";
import {
  buildDefaultProviderDomains,
  deriveProviderViewState,
} from "@/store/integrations-support";

const geoQueryOptions = { retry: false, refetchOnWindowFocus: false } as const;

/** Inclusive day count, so a 28-day window reads "28d" as the design does. */
function windowDaysBetween(start: string, end: string): number | null {
  if (!start || !end) return null;
  const startMs = Date.parse(`${start}T00:00:00.000Z`);
  const endMs = Date.parse(`${end}T00:00:00.000Z`);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  return Math.max(1, Math.round((endMs - startMs) / 86_400_000) + 1);
}

async function readGeo<T>(url: string, fallbackMessage: string): Promise<T> {
  const response = await fetch(url);
  const payload = (await response.json().catch(() => null)) as
    | { message?: string; error?: string; action?: Ga4ErrorAction }
    | null;
  if (!response.ok) {
    // The code and the action were both dropped here, so a workspace with GA4
    // connected and no property selected got "Something went wrong" and a Retry
    // that could never resolve it. They ride along now; the screen decides.
    const error = new Error(payload?.message ?? fallbackMessage) as Ga4ActionableError;
    error.code = payload?.error;
    error.action = payload?.action;
    throw error;
  }
  return payload as T;
}

/**
 * The Insights → AI Visibility data boundary.
 *
 * Reads the six `/api/geo/**` endpoints, hands them to the pure adapter and
 * renders the exact component. Every route family that reaches this screen —
 * the preserved `/insights/ai-visibility` and the canonical
 * `/c/{businessId}/analytics/geo` twins — mounts this one component.
 */
export function InsightsGeoScreen({
  businessId: scopedBusinessId,
  initialTab = "overview",
}: {
  /** Server-authorized on the canonical routes; absent on the legacy route. */
  businessId?: string;
  initialTab?: GeoTabId;
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

  const defaults = buildDefaultProviderDomains();
  const ga4View = deriveProviderViewState("ga4", domains?.ga4 ?? defaults.ga4);
  const scView = deriveProviderViewState(
    "search_console",
    domains?.search_console ?? defaults.search_console,
  );
  const ga4Connected = ga4View.isConnected || isDemoBusiness;
  const scConnected = scView.isConnected || isDemoBusiness;
  const anyConnected = ga4Connected || scConnected;
  const showBootstrapGuard =
    !isDemoBusiness &&
    (isBootstrapping ||
      ((ga4View.status === "loading_data" || scView.status === "loading_data") &&
        !anyConnected) ||
      (bootstrapStatus !== "ready" && !anyConnected));

  const [activeTab, setActiveTab] = useState<GeoTabId>(initialTab);
  const [queryFilter, setQueryFilter] = useState<GeoQueryFilterId>("ai");
  const [dateRange] = usePersistentDateRange();
  const { start: startDate, end: endDate } = getPresetDates(
    dateRange.rangePreset,
    dateRange.customStart,
    dateRange.customEnd,
  );
  const range = `businessId=${businessId}&startDate=${startDate}&endDate=${endDate}`;
  const windowDays = windowDaysBetween(startDate, endDate);

  const overviewQuery = useQuery({
    queryKey: ["insights-geo-overview", businessId, startDate, endDate],
    enabled: anyConnected && businessId.length > 0,
    queryFn: () =>
      readGeo<GeoOverviewInput>(
        `/api/geo/overview?${range}`,
        "Failed to load AI Visibility overview.",
      ),
    ...geoQueryOptions,
  });

  const sourcesQuery = useQuery({
    queryKey: ["insights-geo-sources", businessId, startDate, endDate],
    enabled: ga4Connected && businessId.length > 0 && activeTab === "sources",
    queryFn: () =>
      readGeo<{ sources?: GeoSourceInput[]; currency?: string | null }>(
        `/api/geo/traffic-sources?${range}`,
        "Failed to load AI traffic sources.",
      ),
    ...geoQueryOptions,
  });

  const pagesQuery = useQuery({
    queryKey: ["insights-geo-pages", businessId, startDate, endDate],
    enabled: ga4Connected && businessId.length > 0 && activeTab === "pages",
    queryFn: () =>
      readGeo<{ pages?: GeoPageInput[] }>(
        `/api/geo/pages?${range}`,
        "Failed to load AI content winners.",
      ),
    ...geoQueryOptions,
  });

  const queriesQuery = useQuery({
    queryKey: ["insights-geo-queries", businessId, startDate, endDate],
    enabled: scConnected && businessId.length > 0 && activeTab === "queries",
    queryFn: () =>
      readGeo<{ queries?: GeoQueryInput[] }>(
        `/api/geo/queries?${range}`,
        "Failed to load query intelligence.",
      ),
    ...geoQueryOptions,
  });

  const topicsQuery = useQuery({
    queryKey: ["insights-geo-topics", businessId, startDate, endDate],
    enabled: scConnected && businessId.length > 0 && activeTab === "topics",
    queryFn: () =>
      readGeo<{ topics?: GeoTopicInput[] }>(
        `/api/geo/topics?${range}`,
        "Failed to load topic authority.",
      ),
    ...geoQueryOptions,
  });

  const opportunitiesQuery = useQuery({
    queryKey: ["insights-geo-opportunities", businessId, startDate, endDate],
    enabled: anyConnected && businessId.length > 0 && activeTab === "plays",
    queryFn: () =>
      readGeo<{ opportunities?: GeoOpportunityInput[] }>(
        `/api/geo/opportunities?${range}`,
        "Failed to load the AI Visibility playbook.",
      ),
    ...geoQueryOptions,
  });

  if (!resolvedBusinessId) return <BusinessEmptyState />;
  if (showBootstrapGuard) return <LoadingSkeleton rows={4} />;
  if (!anyConnected) {
    return (
      <IntegrationEmptyState
        providerLabel="GA4"
        status={ga4View.status === "action_required" ? "error" : "disconnected"}
        title="Connect GA4 or Search Console to unlock AI Visibility"
        description="GA4 detects AI-source traffic and measures its commercial impact; Search Console supplies the query and topic authority signals."
      />
    );
  }

  const activeError =
    activeTab === "sources"
      ? sourcesQuery.error
      : activeTab === "pages"
        ? pagesQuery.error
        : activeTab === "queries"
          ? queriesQuery.error
          : activeTab === "topics"
            ? topicsQuery.error
            : activeTab === "plays"
              ? opportunitiesQuery.error
              : overviewQuery.error;

  const model = buildInsightsGeoExactModel({
    activeTab,
    queryFilter,
    windowDays,
    overview: overviewQuery.data ?? null,
    sources: sourcesQuery.data?.sources ?? null,
    sourcesCurrency: sourcesQuery.data?.currency ?? null,
    pages: pagesQuery.data?.pages ?? null,
    queries: queriesQuery.data?.queries ?? null,
    topics: topicsQuery.data?.topics ?? null,
    opportunities: opportunitiesQuery.data?.opportunities ?? null,
  });

  const setupState = resolveGa4SetupState(activeError, {
    surfaceLabel: "AI Visibility",
    fallbackMessage: "Failed to load AI Visibility data.",
  });

  return (
    <>
      {setupState ? (
        <IntegrationEmptyState
          providerLabel="GA4"
          status={setupState.status}
          title={setupState.title}
          description={setupState.description}
        />
      ) : activeError ? (
        <ErrorState
          description={formatGa4ErrorMessage(
            activeError,
            "Failed to load AI Visibility data.",
          )}
          onRetry={() => {
            void overviewQuery.refetch();
            if (activeTab === "sources") void sourcesQuery.refetch();
            if (activeTab === "pages") void pagesQuery.refetch();
            if (activeTab === "queries") void queriesQuery.refetch();
            if (activeTab === "topics") void topicsQuery.refetch();
            if (activeTab === "plays") void opportunitiesQuery.refetch();
          }}
        />
      ) : null}
      <InsightsGeoExact
        model={model}
        onSelectTab={setActiveTab}
        onSelectFilter={setQueryFilter}
      />
    </>
  );
}
