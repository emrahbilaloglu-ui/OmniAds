"use client";

import { measuredAsOf } from "@/lib/tier-zero-as-of";
import { useTierZeroFreshness } from "@/components/states/useTierZeroFreshness";
import { useDeferredValue, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
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
import { buildMetaScopedHref } from "@/lib/meta/meta-route-scope";

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
  const searchParams = useSearchParams();
  const language = usePreferencesStore((state) => state.language);
  const businesses = useAppStore((state) => state.businesses);
  const selectedBusinessId = useAppStore((state) => state.selectedBusinessId);
  const businessId = selectedBusinessId ?? "";
  const selectedBusinessCurrency =
    businesses.find((business) => business.id === selectedBusinessId)?.currency ?? null;
  const providerAccountId =
    searchParams?.get("providerAccountId")?.trim() ?? "";
  const routeScope = { businessId, providerAccountId };
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

  // One freshness contract across every Tier-0 surface. Derived from the
  // query state this surface already has, so it cannot drift from what is
  // actually on screen.
  useTierZeroFreshness({
    surface: "creative_studio",
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    error: query.error,
    // When GA4 was actually read. This route caches, so the stamp is taken at
    // the live retrieval and carried by the cache -- a response served an hour
    // later reports the retrieval, not the hand-over.
    asOf: measuredAsOf(query.data?.meta?.retrievedAt ?? null),
    businessId,
    onRetry: () => void query.refetch(),
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
      <div
        className="ad-final px-4 py-4"
        data-testid="landing-pages-studio-page"
        data-landing-state="loading"
      >
        <div className="mx-auto flex w-full max-w-[1480px] flex-col gap-4">
        <LandingPageHeader propertyName={undefined} routeScope={routeScope} />
        <LoadingSkeleton rows={5} />
        </div>
      </div>
    );
  }

  if (!ga4Connected) {
    return (
      <div
        className="ad-final px-4 py-4"
        data-testid="landing-pages-studio-page"
        data-landing-state="integration_required"
      >
        <div className="mx-auto flex w-full max-w-[1480px] flex-col gap-4">
        <LandingPageHeader propertyName={undefined} routeScope={routeScope} />
        <IntegrationEmptyState
          providerLabel="GA4"
          status={ga4View.status === "action_required" ? "error" : "disconnected"}
          title={language === "tr" ? "Landing page funnel analizini açmak için GA4 bağlayın" : "Connect GA4 to unlock landing page funnel analysis"}
          description={language === "tr" ? "Landing page performansı GA4 property'nizle çalışır. Sayfa bazında purchase funnel incelemek için GA4 bağlayın ve bir property seçin." : "Landing page performance is powered by your GA4 property. Connect GA4 and select a property to inspect your purchase funnel by page."}
        />
        </div>
      </div>
    );
  }

  return (
    <PlanGate requiredPlan="growth">
      <div
        className="ad-final px-4 py-4"
        data-testid="landing-pages-studio-page"
        data-landing-state={query.isLoading ? "loading" : query.isError ? "error" : "ready"}
      >
      <div className="mx-auto flex w-full max-w-[1480px] flex-col gap-4">
        <LandingPageHeader
          propertyName={query.data?.meta.propertyName}
          routeScope={routeScope}
        />

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-end">
          <DateRangePicker value={dateRange} onChange={setDateRange} />
          <label className="relative block min-w-[260px]">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--adc-ink3,#7d838c)]" />
            <input
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
              placeholder={language === "tr" ? "Sayfa yolunda ara" : "Search page path"}
              className="h-10 w-full rounded-md border border-[var(--adc-b1,#e4e4e0)] bg-[var(--adc-s2,#ffffff)] pl-9 pr-3 text-sm text-[var(--adc-ink,#1a1c1f)] outline-none transition focus:border-[var(--adc-focus,#1e62d0)]"
            />
          </label>
        </div>

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
                description="Try adjusting the date range or clearing the page search."
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
      </div>
    </PlanGate>
  );
}

function LandingPageHeader({
  propertyName,
  routeScope,
}: {
  propertyName?: string;
  routeScope: { businessId: string; providerAccountId: string };
}) {
  return (
    <header className="overflow-hidden rounded-[var(--r-lg)] border border-[var(--border)] bg-[var(--surface)]">
      <div className="flex flex-col gap-3 border-b border-[var(--border)] px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <div className="crumbs">Platforms · <b>Meta</b> · Creative Studio</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-2">
            <h1 className="page-title">Landing Pages</h1>
            <span className="chip chip--info">
              Analysis only - decisions live in <Link href={buildMetaScopedHref("/platforms/meta", routeScope)}>Decisions</Link>
            </span>
          </div>
          <p className="mt-1 max-w-3xl text-[13px] text-[var(--muted)]">
            Page-level funnel analysis powered by GA4.
            {propertyName ? ` Property: ${propertyName}.` : ""}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link className="btn btn--sm" href={buildMetaScopedHref("/platforms/meta/creatives", routeScope)}>Assets</Link>
          <Link className="btn btn--sm" href={buildMetaScopedHref("/platforms/meta/copies", routeScope)}>Copy</Link>
          <span className="btn btn--sm btn--primary" aria-current="page">Landing pages</span>
          <Link className="btn btn--sm" href={buildMetaScopedHref("/platforms/meta/creative-inbox", routeScope)}>Inbox</Link>
          <Link className="btn btn--sm" href={buildMetaScopedHref("/platforms/meta/audiences", routeScope)}>Audiences</Link>
        </div>
      </div>
    </header>
  );
}
