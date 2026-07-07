"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BusinessEmptyState } from "@/components/business/BusinessEmptyState";
import {
  DateRangePicker,
  getPresetDates,
} from "@/components/date-range/DateRangePicker";
import { IntegrationEmptyState } from "@/components/states/IntegrationEmptyState";
import { ErrorState } from "@/components/states/error-state";
import { LoadingSkeleton } from "@/components/states/loading-skeleton";
import { usePersistentDateRange } from "@/hooks/use-persistent-date-range";
import { useAppStore } from "@/store/app-store";
import { useIntegrationsStore } from "@/store/integrations-store";
import { buildDefaultProviderDomains, deriveProviderViewState } from "@/store/integrations-support";
import { cn } from "@/lib/utils";
import { useBusinessIntegrationsBootstrap } from "@/hooks/use-business-integrations-bootstrap";
import {
  ConfirmedExcludedPagesList,
  EntityTable,
  FindingsSummaryCards,
  SectionIntro,
  SeoMonthlyAiActionsPanel,
  SeoMonthlyAiPanel,
  SeoKpiCard,
  TechnicalFindingsList,
  type SeoFindingsResponse,
  type SeoMonthlyAiAnalysisResponse,
  type SeoOverviewResponse,
  SEO_TABS,
  type SeoTab,
} from "@/app/(dashboard)/insights/seo/seo-intelligence-support";

async function fetchSeoOverview(params: {
  businessId: string;
  startDate: string;
  endDate: string;
}): Promise<SeoOverviewResponse> {
  const qs = new URLSearchParams(params).toString();
  const response = await fetch(`/api/seo/overview?${qs}`);
  const payload = (await response.json().catch(() => null)) as
    | { message?: string }
    | null;

  if (!response.ok) {
    throw new Error(payload?.message ?? "Failed to load SEO Intelligence.");
  }

  return payload as SeoOverviewResponse;
}

async function fetchSeoFindings(params: {
  businessId: string;
  startDate: string;
  endDate: string;
}): Promise<SeoFindingsResponse> {
  const qs = new URLSearchParams(params).toString();
  const response = await fetch(`/api/seo/findings?${qs}`);
  const payload = (await response.json().catch(() => null)) as
    | { message?: string }
    | null;

  if (!response.ok) {
    throw new Error(payload?.message ?? "Failed to load SEO technical findings.");
  }

  return payload as SeoFindingsResponse;
}

async function fetchSeoMonthlyAiAnalysis(params: {
  businessId: string;
  startDate: string;
  endDate: string;
}): Promise<SeoMonthlyAiAnalysisResponse> {
  const qs = new URLSearchParams(params).toString();
  const response = await fetch(`/api/seo/ai-analysis?${qs}`);
  const payload = (await response.json().catch(() => null)) as
    | { message?: string; unavailableReason?: string }
    | null;

  if (!response.ok) {
    throw new Error(
      payload?.message ??
        payload?.unavailableReason ??
        "Failed to load monthly SEO AI analysis.",
    );
  }

  return payload as SeoMonthlyAiAnalysisResponse;
}

async function generateSeoMonthlyAiAnalysis(params: {
  businessId: string;
  startDate: string;
  endDate: string;
}): Promise<SeoMonthlyAiAnalysisResponse> {
  const response = await fetch("/api/seo/ai-analysis", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  const payload = (await response.json().catch(() => null)) as
    | { message?: string; unavailableReason?: string }
    | null;

  if (!response.ok) {
    throw new Error(
      payload?.message ??
        payload?.unavailableReason ??
        "Failed to generate monthly SEO AI analysis.",
    );
  }

  return payload as SeoMonthlyAiAnalysisResponse;
}

export default function SeoIntelligencePage() {
  const selectedBusinessId = useAppStore((state) => state.selectedBusinessId);
  const businessId = selectedBusinessId ?? "";
  const queryClient = useQueryClient();
  const domains = useIntegrationsStore((state) =>
    selectedBusinessId ? state.domainsByBusinessId[selectedBusinessId] : undefined
  );
  const { isBootstrapping, bootstrapStatus } = useBusinessIntegrationsBootstrap(
    selectedBusinessId ?? null
  );

  const [activeTab, setActiveTab] = useState<SeoTab>("overview");
  const [dateRange, setDateRange] = usePersistentDateRange();

  const { start: startDate, end: endDate } = getPresetDates(
    dateRange.rangePreset,
    dateRange.customStart,
    dateRange.customEnd,
  );

  const searchConsoleView = deriveProviderViewState(
    "search_console",
    domains?.search_console ?? buildDefaultProviderDomains().search_console
  );
  const searchConsoleConnected = searchConsoleView.isConnected;
  const showBootstrapGuard =
    isBootstrapping ||
    searchConsoleView.status === "loading_data" ||
    (bootstrapStatus !== "ready" && !searchConsoleView.isConnected);

  const overviewQuery = useQuery({
    queryKey: ["seo-overview", businessId, startDate, endDate],
    enabled: searchConsoleConnected && Boolean(businessId),
    queryFn: () => fetchSeoOverview({ businessId, startDate, endDate }),
    retry: false,
    refetchOnWindowFocus: false,
  });

  const findingsQuery = useQuery({
    queryKey: ["seo-findings", businessId, startDate, endDate],
    enabled: searchConsoleConnected && Boolean(businessId) && activeTab === "technical",
    queryFn: () => fetchSeoFindings({ businessId, startDate, endDate }),
    retry: false,
    refetchOnWindowFocus: false,
  });

  const monthlyAiQuery = useQuery({
    queryKey: ["seo-monthly-ai-analysis", businessId, startDate, endDate],
    enabled:
      searchConsoleConnected &&
      Boolean(businessId) &&
      (activeTab === "overview" || activeTab === "actions"),
    queryFn: () => fetchSeoMonthlyAiAnalysis({ businessId, startDate, endDate }),
    retry: false,
    refetchOnWindowFocus: false,
  });

  const monthlyAiMutation = useMutation({
    mutationFn: () => generateSeoMonthlyAiAnalysis({ businessId, startDate, endDate }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ["seo-monthly-ai-analysis", businessId, startDate, endDate],
      });
    },
  });

  if (!selectedBusinessId) return <BusinessEmptyState />;

  if (showBootstrapGuard) {
    return (
      <div className="space-y-5">
        <header className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-neutral-500">
              Insights
            </p>
            <h1 className="text-[24px] font-semibold tracking-tight text-neutral-950">SEO Intelligence</h1>
            <p className="max-w-2xl text-sm leading-5 text-neutral-500">
              Monitor organic search volatility, isolate likely causes, and prioritize technical or
              content fixes using Search Console-backed intelligence.
            </p>
          </div>
        </header>
        <LoadingSkeleton rows={4} />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <header className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-neutral-500">
            Insights
          </p>
          <h1 className="text-[24px] font-semibold tracking-tight text-neutral-950">SEO Intelligence</h1>
          <p className="max-w-2xl text-sm leading-5 text-neutral-500">
            Monitor organic search volatility, isolate likely causes, and prioritize technical or
            content fixes using Search Console-backed intelligence.
          </p>
        </div>
      </header>

      {!searchConsoleConnected && (
        <IntegrationEmptyState
          providerLabel="Search Console"
          status={searchConsoleView.status === "action_required" ? "error" : "disconnected"}
          title="Connect Search Console to unlock SEO Intelligence"
          description="Track organic trend shifts, query volatility, page-level losses, and action recommendations once Search Console is connected and a site is selected."
        />
      )}

      {searchConsoleConnected && (
        <>
          <section className="rounded-xl border border-neutral-200 bg-white p-3">
            <div className="flex flex-wrap items-center gap-3">
              <DateRangePicker value={dateRange} onChange={setDateRange} />
            </div>
          </section>

          {overviewQuery.isLoading && <LoadingSkeleton rows={4} />}

          {overviewQuery.error && (
            <ErrorState
              description={
                overviewQuery.error instanceof Error
                  ? overviewQuery.error.message
                  : "Failed to load SEO Intelligence."
              }
              onRetry={() => overviewQuery.refetch()}
            />
          )}

          {overviewQuery.data && (
            <>
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                <SeoKpiCard
                  label="Organic Clicks"
                  current={overviewQuery.data.summary.clicks.current}
                  previous={overviewQuery.data.summary.clicks.previous}
                  deltaPercent={overviewQuery.data.summary.clicks.deltaPercent}
                  mode="number"
                />
                <SeoKpiCard
                  label="Impressions"
                  current={overviewQuery.data.summary.impressions.current}
                  previous={overviewQuery.data.summary.impressions.previous}
                  deltaPercent={overviewQuery.data.summary.impressions.deltaPercent}
                  mode="number"
                />
                <SeoKpiCard
                  label="CTR"
                  current={overviewQuery.data.summary.ctr.current}
                  previous={overviewQuery.data.summary.ctr.previous}
                  deltaPercent={overviewQuery.data.summary.ctr.deltaPercent}
                  mode="percent"
                />
                <SeoKpiCard
                  label="Average Position"
                  current={overviewQuery.data.summary.position.current}
                  previous={overviewQuery.data.summary.position.previous}
                  deltaPercent={overviewQuery.data.summary.position.deltaPercent}
                  mode="position"
                  invertDelta
                />
              </div>

              <div className="flex gap-1 overflow-x-auto border-b border-neutral-200">
                {SEO_TABS.map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setActiveTab(tab.id)}
                    className={cn(
                      "-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-[13px] font-medium transition-colors",
                      activeTab === tab.id
                        ? "border-neutral-950 text-neutral-950"
                        : "border-transparent text-neutral-500 hover:text-neutral-900",
                    )}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              <section className="space-y-4 rounded-xl border border-neutral-200 bg-white p-5">
                {activeTab === "overview" && (
                  <>
                    <SectionIntro
                      title="Monthly AI overview"
                      description="Generate one strategic ecommerce SEO analysis per month, then use the saved output as the team's planning artifact."
                    />
                    {monthlyAiQuery.isLoading && <LoadingSkeleton rows={4} />}
                    {monthlyAiQuery.error && (
                      <ErrorState
                        description={
                          monthlyAiQuery.error instanceof Error
                            ? monthlyAiQuery.error.message
                            : "Failed to load monthly SEO AI analysis."
                        }
                        onRetry={() => monthlyAiQuery.refetch()}
                      />
                    )}
                    {monthlyAiQuery.data && (
                      <SeoMonthlyAiPanel
                        monthly={monthlyAiQuery.data}
                        isGenerating={monthlyAiMutation.isPending}
                        onGenerate={() => monthlyAiMutation.mutate()}
                      />
                    )}
                    {monthlyAiMutation.error && (
                      <ErrorState
                        description={
                          monthlyAiMutation.error instanceof Error
                            ? monthlyAiMutation.error.message
                            : "Failed to generate monthly SEO AI analysis."
                        }
                        onRetry={() => monthlyAiMutation.mutate()}
                      />
                    )}
                  </>
                )}

                {activeTab === "traffic" && (
                  <>
                    <SectionIntro
                      title="Traffic changes"
                      description="Focus first on the biggest losing queries and pages, then protect the strongest improving clusters."
                    />
                    <div className="grid gap-4 xl:grid-cols-2">
                      <EntityTable
                        title="Biggest declining queries"
                        rows={overviewQuery.data.movers.decliningQueries}
                        emptyLabel="No declining queries in this period."
                        scrollHeightClass="max-h-64"
                      />
                      <EntityTable
                        title="Biggest declining pages"
                        rows={overviewQuery.data.movers.decliningPages}
                        emptyLabel="No declining pages in this period."
                        scrollHeightClass="max-h-64"
                      />
                      <EntityTable
                        title="Improving queries"
                        rows={overviewQuery.data.movers.improvingQueries}
                        emptyLabel="No improving queries in this period."
                        scrollHeightClass="max-h-64"
                      />
                      <EntityTable
                        title="Improving pages"
                        rows={overviewQuery.data.movers.improvingPages}
                        emptyLabel="No improving pages in this period."
                        scrollHeightClass="max-h-64"
                      />
                    </div>
                  </>
                )}

                {activeTab === "queries" && (
                  <>
                    <SectionIntro
                      title="Query leaders"
                      description="These queries currently anchor your organic search visibility and should be monitored first when performance shifts."
                    />
                    <EntityTable
                      title="Top queries by clicks"
                      rows={overviewQuery.data.leaders.queries}
                      emptyLabel="No query data available for this period."
                    />
                  </>
                )}

                {activeTab === "pages" && (
                  <>
                    <SectionIntro
                      title="Page leaders"
                      description="These landing pages carry the most organic search value and are the best starting point for technical or snippet-level analysis."
                    />
                    <EntityTable
                      title="Top pages by clicks"
                      rows={overviewQuery.data.leaders.pages}
                      emptyLabel="No page data available for this period."
                    />
                  </>
                )}

                {activeTab === "actions" && (
                  <>
                    <SectionIntro
                      title="AI priorities"
                      description="Turn the monthly model output into a practical execution queue for what to fix first, what to sequence, and what to defer."
                    />
                    {monthlyAiQuery.isLoading && <LoadingSkeleton rows={4} />}
                    {monthlyAiQuery.error && (
                      <ErrorState
                        description={
                          monthlyAiQuery.error instanceof Error
                            ? monthlyAiQuery.error.message
                            : "Failed to load monthly SEO AI analysis."
                        }
                        onRetry={() => monthlyAiQuery.refetch()}
                      />
                    )}
                    {monthlyAiQuery.data && (
                      <SeoMonthlyAiActionsPanel
                        monthly={monthlyAiQuery.data}
                        isGenerating={monthlyAiMutation.isPending}
                        onGenerate={() => monthlyAiMutation.mutate()}
                      />
                    )}
                    {monthlyAiMutation.error && (
                      <ErrorState
                        description={
                          monthlyAiMutation.error instanceof Error
                            ? monthlyAiMutation.error.message
                            : "Failed to generate monthly SEO AI analysis."
                        }
                        onRetry={() => monthlyAiMutation.mutate()}
                      />
                    )}
                  </>
                )}

                {activeTab === "technical" && (
                  <>
                    <SectionIntro
                      title="Technical findings"
                      description="Targeted audits on Search Console-backed or inspection-confirmed pages to surface crawl, indexation, metadata, canonical, and structured-data risks."
                    />
                    <div className="rounded-xl border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm leading-5 text-neutral-500">
                      Pages can still appear here even when current impressions are `0`.
                      That usually means the URL was previously visible in Search Console, is now losing discovery,
                      or was directly confirmed as excluded/not indexed via URL Inspection. Querystring URLs and feed/service paths are excluded from this view.
                    </div>
                    {findingsQuery.isLoading && <LoadingSkeleton rows={3} />}
                    {findingsQuery.error && (
                      <ErrorState
                        description={
                          findingsQuery.error instanceof Error
                            ? findingsQuery.error.message
                            : "Failed to load technical findings."
                        }
                        onRetry={() => findingsQuery.refetch()}
                      />
                    )}
                    {findingsQuery.data && (
                      <>
                        <ConfirmedExcludedPagesList pages={findingsQuery.data.confirmedExcludedPages} />
                        <FindingsSummaryCards {...findingsQuery.data.summary} />
                        <TechnicalFindingsList findings={findingsQuery.data.findings} />
                      </>
                    )}
                  </>
                )}
              </section>
            </>
          )}
        </>
      )}
    </div>
  );
}
