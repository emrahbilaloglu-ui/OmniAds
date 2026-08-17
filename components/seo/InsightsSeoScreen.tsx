"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { InsightsSeoExact } from "@/components/seo/InsightsSeoExact";
import {
  buildInsightsSeoExactModel,
  type SeoFindingsInput,
  type SeoMonthlyInput,
  type SeoOverviewInput,
} from "@/components/seo/insights-seo-exact-adapter";
import type { SeoTabId } from "@/components/seo/insights-seo-exact-model";
import { BusinessEmptyState } from "@/components/business/BusinessEmptyState";
import { getPresetDates } from "@/components/date-range/DateRangePicker";
import { IntegrationEmptyState } from "@/components/states/IntegrationEmptyState";
import { ErrorState } from "@/components/states/error-state";
import { LoadingSkeleton } from "@/components/states/loading-skeleton";
import { StateBanner } from "@/components/ui/product-surface";
import { usePersistentDateRange } from "@/hooks/use-persistent-date-range";
import { useBusinessIntegrationsBootstrap } from "@/hooks/use-business-integrations-bootstrap";
import { useAppStore } from "@/store/app-store";
import { useIntegrationsStore } from "@/store/integrations-store";
import {
  buildDefaultProviderDomains,
  deriveProviderViewState,
} from "@/store/integrations-support";

/** Errors thrown from the SEO fetchers carry the server's own error code. */
type SeoRequestError = Error & { code?: string };

function isSearchConsoleReconnect(error: unknown) {
  return (
    error instanceof Error &&
    (error as SeoRequestError).code === "search_console_reconnect_required"
  );
}

/**
 * The analysis cooldown is a temporary, self-clearing suppression — not a
 * failure. It gets a caution banner, never a red error card.
 */
function isAnalysisCooldown(error: unknown) {
  if (!(error instanceof Error)) return false;
  return ((error as SeoRequestError).code ?? "").endsWith("_cooldown");
}

const seoQueryOptions = { retry: false, refetchOnWindowFocus: false } as const;

async function readSeo<T>(url: string, fallbackMessage: string): Promise<T> {
  const response = await fetch(url);
  const payload = (await response.json().catch(() => null)) as
    | { message?: string; error?: string; unavailableReason?: string }
    | null;
  if (!response.ok) {
    const error = new Error(
      payload?.message ?? payload?.unavailableReason ?? fallbackMessage,
    ) as SeoRequestError;
    if (payload?.error) error.code = payload.error;
    throw error;
  }
  return payload as T;
}

/**
 * The only caller of `POST /api/seo/ai-analysis` in the product.
 *
 * Nothing else generates a monthly analysis — no cron, no worker — so the
 * Monthly AI and Actions tabs are unfillable without this call. It runs behind
 * the route's own `collaborator` guard; the guard is untouched here.
 */
async function generateSeoMonthlyAiAnalysis(params: {
  businessId: string;
  startDate: string;
  endDate: string;
}): Promise<SeoMonthlyInput> {
  const response = await fetch("/api/seo/ai-analysis", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  const payload = (await response.json().catch(() => null)) as
    | { message?: string; error?: string; unavailableReason?: string }
    | null;
  if (!response.ok) {
    const error = new Error(
      payload?.message ??
        payload?.unavailableReason ??
        "Failed to generate monthly SEO AI analysis.",
    ) as SeoRequestError;
    if (payload?.error) error.code = payload.error;
    throw error;
  }
  return payload as SeoMonthlyInput;
}

/**
 * The Insights → SEO Intelligence data boundary.
 *
 * Reads the three Search Console-backed endpoints the design's facts come
 * from, hands them to the pure adapter and renders the exact component. Every
 * route family that reaches this screen — the preserved `/insights/seo` and the
 * canonical `/c/{businessId}/analytics/seo` twins — mounts this one component.
 */
export function InsightsSeoScreen({
  businessId: scopedBusinessId,
  initialTab = "ai",
}: {
  /** Server-authorized on the canonical routes; absent on the legacy route. */
  businessId?: string;
  initialTab?: SeoTabId;
}) {
  const selectedBusinessId = useAppStore((state) => state.selectedBusinessId);
  const resolvedBusinessId = scopedBusinessId ?? selectedBusinessId ?? null;
  const businessId = resolvedBusinessId ?? "";
  const queryClient = useQueryClient();

  const domains = useIntegrationsStore((state) =>
    resolvedBusinessId ? state.domainsByBusinessId[resolvedBusinessId] : undefined,
  );
  const { isBootstrapping, bootstrapStatus } =
    useBusinessIntegrationsBootstrap(resolvedBusinessId);

  const searchConsoleView = deriveProviderViewState(
    "search_console",
    domains?.search_console ?? buildDefaultProviderDomains().search_console,
  );
  const searchConsoleConnected = searchConsoleView.isConnected;
  const showBootstrapGuard =
    isBootstrapping ||
    searchConsoleView.status === "loading_data" ||
    (bootstrapStatus !== "ready" && !searchConsoleConnected);

  const [activeTab, setActiveTab] = useState<SeoTabId>(initialTab);
  const [dateRange] = usePersistentDateRange();
  const { start: startDate, end: endDate } = getPresetDates(
    dateRange.rangePreset,
    dateRange.customStart,
    dateRange.customEnd,
  );
  const range = `businessId=${businessId}&startDate=${startDate}&endDate=${endDate}`;

  const overviewQuery = useQuery({
    queryKey: ["insights-seo-overview", businessId, startDate, endDate],
    enabled: searchConsoleConnected && businessId.length > 0,
    queryFn: () =>
      readSeo<SeoOverviewInput>(
        `/api/seo/overview?${range}`,
        "Failed to load SEO Intelligence.",
      ),
    ...seoQueryOptions,
  });

  const monthlyQuery = useQuery({
    queryKey: ["insights-seo-monthly", businessId, startDate, endDate],
    enabled:
      searchConsoleConnected &&
      businessId.length > 0 &&
      (activeTab === "ai" || activeTab === "actions"),
    queryFn: () =>
      readSeo<SeoMonthlyInput>(
        `/api/seo/ai-analysis?${range}`,
        "Failed to load monthly SEO AI analysis.",
      ),
    ...seoQueryOptions,
  });

  const findingsQuery = useQuery({
    queryKey: ["insights-seo-findings", businessId, startDate, endDate],
    enabled: searchConsoleConnected && businessId.length > 0 && activeTab === "technical",
    queryFn: () =>
      readSeo<SeoFindingsInput>(
        `/api/seo/findings?${range}`,
        "Failed to load SEO technical findings.",
      ),
    ...seoQueryOptions,
  });

  const monthlyGenerateMutation = useMutation({
    mutationFn: () =>
      generateSeoMonthlyAiAnalysis({ businessId, startDate, endDate }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ["insights-seo-monthly", businessId, startDate, endDate],
      });
    },
  });

  if (!resolvedBusinessId) return <BusinessEmptyState />;
  if (showBootstrapGuard) return <LoadingSkeleton rows={4} />;
  if (!searchConsoleConnected) {
    return (
      <IntegrationEmptyState
        providerLabel="Search Console"
        status={searchConsoleView.status === "action_required" ? "error" : "disconnected"}
        title="Connect Search Console to unlock SEO Intelligence"
        description="Track organic trend shifts, query volatility, page-level losses, and action recommendations once Search Console is connected and a site is selected."
      />
    );
  }

  const activeError =
    activeTab === "technical"
      ? (findingsQuery.error ?? overviewQuery.error)
      : activeTab === "ai" || activeTab === "actions"
        ? (monthlyGenerateMutation.error ?? monthlyQuery.error ?? overviewQuery.error)
        : overviewQuery.error;

  const model = buildInsightsSeoExactModel({
    activeTab,
    overview: overviewQuery.data ?? null,
    monthly: monthlyQuery.data ?? null,
    findings: findingsQuery.data ?? null,
  });

  return (
    <>
      {activeError ? (
        isAnalysisCooldown(activeError) ? (
          <StateBanner tone="warning" title="Search Console refresh paused by cooldown">
            {activeError instanceof Error
              ? activeError.message
              : "Search Console requests are temporarily suppressed."}
          </StateBanner>
        ) : isSearchConsoleReconnect(activeError) ? (
          <IntegrationEmptyState
            providerLabel="Search Console"
            status="error"
            title="Reconnect Search Console to unlock SEO Intelligence"
            description={
              activeError instanceof Error
                ? activeError.message
                : "Google integration is missing the Search Console scope."
            }
          />
        ) : (
          <ErrorState
            description={
              activeError instanceof Error
                ? activeError.message
                : "Failed to load SEO Intelligence."
            }
            onRetry={() => {
              void overviewQuery.refetch();
              if (activeTab === "ai" || activeTab === "actions") void monthlyQuery.refetch();
              if (activeTab === "technical") void findingsQuery.refetch();
            }}
          />
        )
      ) : null}
      <InsightsSeoExact
        model={model}
        onSelectTab={setActiveTab}
        onGenerateMonthly={() => monthlyGenerateMutation.mutate()}
        isGeneratingMonthly={monthlyGenerateMutation.isPending}
      />
    </>
  );
}
