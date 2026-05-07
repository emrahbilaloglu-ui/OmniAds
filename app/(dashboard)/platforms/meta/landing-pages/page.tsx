"use client";

import { useDeferredValue, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { useAppStore } from "@/store/app-store";
import { usePreferencesStore } from "@/store/preferences-store";
import { useIntegrationsStore } from "@/store/integrations-store";
import { buildDefaultProviderDomains, deriveProviderViewState } from "@/store/integrations-support";
import { isDemoBusinessSelected } from "@/lib/business-mode";
import { useBusinessIntegrationsBootstrap } from "@/hooks/use-business-integrations-bootstrap";
import { usePersistentDateRange } from "@/hooks/use-persistent-date-range";
import { BusinessEmptyState } from "@/components/business/BusinessEmptyState";
import { DateRangePicker, getPresetDates } from "@/components/date-range/DateRangePicker";
import { AnalyticsKpiCard } from "@/components/analytics/AnalyticsKpiCard";
import { IntegrationEmptyState } from "@/components/states/IntegrationEmptyState";
import { ErrorState } from "@/components/states/error-state";
import { LoadingSkeleton } from "@/components/states/loading-skeleton";
import { EmptyState } from "@/components/states/empty-state";
import { PlanGate } from "@/components/pricing/PlanGate";
import { getLandingPagePerformance } from "@/src/services";
import type { LandingPagePerformanceRow } from "@/src/types/landing-pages";
import { LandingPagesTableSection } from "@/components/landing-pages/LandingPagesTableSection";
import { LandingPageDetailDrawer } from "@/components/landing-pages/LandingPageDetailDrawer";
import {
  buildSummaryCards,
  filterLandingPageRows,
  resolveLandingPageSiteBaseUrl,
  sortLandingPageRows,
  type LandingPageSortState,
} from "@/components/landing-pages/support";

interface AnalyticsApiErrorPayload {
  error?: string;
  message?: string;
  action?: "connect_ga4" | "select_property" | "reconnect_ga4" | "retry_later";
  reconnectRequired?: boolean;
}

function buildAnalyticsRequestError(
  payload: AnalyticsApiErrorPayload,
  fallbackMessage: string
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

function formatAnalyticsErrorMessage(error: unknown, fallback: string): string {
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

export default function LandingPagesPage() {
  const language = usePreferencesStore((state) => state.language);
  const businesses = useAppStore((state) => state.businesses);
  const selectedBusinessId = useAppStore((state) => state.selectedBusinessId);
  const businessId = selectedBusinessId ?? "";
  const selectedBusinessCurrency =
    businesses.find((business) => business.id === selectedBusinessId)?.currency ?? null;
  const domains = useIntegrationsStore((state) =>
    selectedBusinessId ? state.domainsByBusinessId[selectedBusinessId] : undefined
  );
  const { isBootstrapping, bootstrapStatus } = useBusinessIntegrationsBootstrap(
    selectedBusinessId ?? null
  );
  const isDemoBusiness = isDemoBusinessSelected(selectedBusinessId, businesses);
  const ga4View = deriveProviderViewState(
    "ga4",
    domains?.ga4 ?? buildDefaultProviderDomains().ga4
  );
  const ga4Connected = ga4View.isConnected || isDemoBusiness;
  const landingPageSiteBaseUrl = resolveLandingPageSiteBaseUrl(
    domains?.search_console?.connection.providerAccountId ??
      domains?.search_console?.connection.providerAccountName ??
      null
  );
  const showBootstrapGuard =
    !isDemoBusiness &&
    (isBootstrapping ||
      ga4View.status === "loading_data" ||
      (bootstrapStatus !== "ready" && !ga4View.isConnected));

  const [dateRange, setDateRange] = usePersistentDateRange();
  const [searchTerm, setSearchTerm] = useState("");
  const deferredSearchTerm = useDeferredValue(searchTerm);
  const [sort, setSort] = useState<LandingPageSortState>({
    key: "sessions",
    direction: "desc",
  });
  const [selectedRow, setSelectedRow] = useState<LandingPagePerformanceRow | null>(null);

  const { start: startDate, end: endDate } = getPresetDates(
    dateRange.rangePreset,
    dateRange.customStart,
    dateRange.customEnd
  );

  const query = useQuery({
    queryKey: ["landing-page-performance", businessId, startDate, endDate],
    enabled: ga4Connected && Boolean(businessId),
    retry: false,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      try {
        return await getLandingPagePerformance(businessId, startDate, endDate);
      } catch (error) {
        const responseError = error as Error & { payload?: AnalyticsApiErrorPayload };
        throw buildAnalyticsRequestError(
          responseError.payload ?? {},
          responseError.message || "Failed to load landing page performance."
        );
      }
    },
  });

  const visibleRows = useMemo(() => {
    const filtered = filterLandingPageRows(query.data?.rows ?? [], deferredSearchTerm);
    return sortLandingPageRows(filtered, sort);
  }, [deferredSearchTerm, query.data?.rows, sort]);

  const summaryCards = useMemo(
    () => (query.data ? buildSummaryCards(query.data.summary, selectedBusinessCurrency, language) : []),
    [language, query.data, selectedBusinessCurrency]
  );

  if (!selectedBusinessId) return <BusinessEmptyState />;

  if (showBootstrapGuard) {
    return (
      <div className="space-y-6">
        <LandingPageHeader propertyName={undefined} />
        <LoadingSkeleton rows={5} />
      </div>
    );
  }

  if (!ga4Connected) {
    return (
      <div className="space-y-6">
        <LandingPageHeader propertyName={undefined} />
        <IntegrationEmptyState
          providerLabel="GA4"
          status={ga4View.status === "action_required" ? "error" : "disconnected"}
          title={language === "tr" ? "Landing page funnel analizini açmak için GA4 bağlayın" : "Connect GA4 to unlock landing page funnel analysis"}
          description={language === "tr" ? "Landing page performansı GA4 property'nizle çalışır. Sayfa bazında purchase funnel incelemek için GA4 bağlayın ve bir property seçin." : "Landing page performance is powered by your GA4 property. Connect GA4 and select a property to inspect your purchase funnel by page."}
        />
      </div>
    );
  }

  return (
    <PlanGate requiredPlan="growth">
      <div className="space-y-5">
        <LandingPageHeader propertyName={query.data?.meta.propertyName} />

        <section className="rounded-[28px] border border-slate-200 bg-[radial-gradient(circle_at_top_left,_#ffffff_0%,_#f6fbff_48%,_#edf5ff_100%)] p-5 shadow-[0_18px_50px_rgba(15,23,42,0.08)]">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="max-w-2xl">
              <p className="text-xs font-semibold uppercase tracking-[0.26em] text-sky-700">
                {language === "tr" ? "Landing Page Performance" : "Landing Page Performance"}
              </p>
              <h2 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">
                {language === "tr" ? "GA4 funnel diagnostigi: oturum girişinden tamamlanan purchase'a" : "GA4 funnel diagnostics from session entry to completed purchase"}
              </h2>
              <p className="mt-2 text-sm leading-6 text-slate-600">
                {language === "tr" ? "Creatives sayfa yapısı üzerine yeniden kuruldu: özet kartları, sıralanabilir funnel tablo ve her landing page için AI analizli detay drawer." : "Rebuilt on top of the creatives page structure: summary cards, sortable funnel table, and a detailed drawer with AI analysis for each landing page."}
              </p>
            </div>

            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <DateRangePicker value={dateRange} onChange={setDateRange} />
              <label className="relative block min-w-[260px]">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input
                  value={searchTerm}
                  onChange={(event) => setSearchTerm(event.target.value)}
                  placeholder={language === "tr" ? "Sayfa yolunda ara" : "Search page path"}
                  className="h-10 w-full rounded-xl border border-slate-200 bg-white pl-9 pr-3 text-sm text-slate-900 shadow-sm outline-none transition focus:border-sky-300"
                />
              </label>
            </div>
          </div>
        </section>

        {query.isLoading ? (
          <LoadingSkeleton rows={6} />
        ) : query.isError ? (
          <ErrorState
            description={formatAnalyticsErrorMessage(
              query.error,
              language === "tr" ? "Landing page performansı yüklenemedi." : "Failed to load landing page performance."
            )}
            onRetry={() => query.refetch()}
          />
        ) : query.data ? (
          <>
            <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {summaryCards.map((card) => (
                <AnalyticsKpiCard
                  key={card.label}
                  label={card.label}
                  value={card.value}
                  sub={card.sub}
                />
              ))}
            </section>

            {visibleRows.length === 0 ? (
              <EmptyState
                title="No landing pages found"
                description="Try adjüsting the date range or clearing the page search."
              />
            ) : (
              <LandingPagesTableSection
                rows={visibleRows}
                currency={selectedBusinessCurrency}
                sort={sort}
                onSortChange={setSort}
                onRowClick={(row) => setSelectedRow(row)}
                selectedPath={selectedRow?.path ?? null}
              />
            )}
          </>
        ) : null}

        <LandingPageDetailDrawer
          businessId={businessId}
          row={selectedRow}
          open={Boolean(selectedRow)}
          currency={selectedBusinessCurrency}
          siteBaseUrl={landingPageSiteBaseUrl}
          onOpenChange={(open) => {
            if (!open) setSelectedRow(null);
          }}
        />
      </div>
    </PlanGate>
  );
}

function LandingPageHeader({ propertyName }: { propertyName?: string }) {
  return (
    <div className="space-y-1">
      <h1 className="text-2xl font-semibold tracking-tight">Landing Pages</h1>
      <p className="text-sm text-muted-foreground">
        Page-level funnel analysis powered by GA4.
        {propertyName ? ` Property: ${propertyName}.` : ""}
      </p>
    </div>
  );
}
