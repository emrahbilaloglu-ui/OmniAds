"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAppStore } from "@/store/app-store";
import { useIntegrationsStore } from "@/store/integrations-store";
import { buildDefaultProviderDomains, deriveProviderViewState } from "@/store/integrations-support";
import { isDemoBusinessSelected } from "@/lib/business-mode";
import { BusinessEmptyState } from "@/components/business/BusinessEmptyState";
import { IntegrationEmptyState } from "@/components/states/IntegrationEmptyState";
import { ErrorState } from "@/components/states/error-state";
import { LoadingSkeleton } from "@/components/states/loading-skeleton";
import {
  DateRangePicker,
  DateRangeValue,
  getPresetDates,
} from "@/components/date-range/DateRangePicker";
import { usePersistentDateRange } from "@/hooks/use-persistent-date-range";
import { Badge } from "@/components/ui/badge";
import { OverviewSection } from "@/components/analytics/OverviewSection";
import { ProductFunnelSection } from "@/components/analytics/ProductFunnelSection";
import { LandingPageSection } from "@/components/analytics/LandingPageSection";
import { AudienceSection } from "@/components/analytics/AudienceSection";
import { DemographicSection } from "@/components/analytics/DemographicSection";
import { CohortSection } from "@/components/analytics/CohortSection";
import { OpportunityFlags } from "@/components/analytics/OpportunityFlags";
import { cn } from "@/lib/utils";
import { useBusinessIntegrationsBootstrap } from "@/hooks/use-business-integrations-bootstrap";

type Tab =
  | "overview"
  | "products"
  | "landing-pages"
  | "audience"
  | "demographics"
  | "cohorts"
  | "opportunities";

const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "products", label: "Products" },
  { id: "landing-pages", label: "Landing Pages" },
  { id: "audience", label: "Audience" },
  { id: "demographics", label: "Demographics" },
  { id: "cohorts", label: "Cohorts" },
  { id: "opportunities", label: "Opportunities" },
];

type DemoDimension =
  | "country"
  | "region"
  | "city"
  | "language"
  | "userAgeBracket"
  | "userGender"
  | "brandingInterest";

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

const analyticsQueryOptions = {
  retry: false,
  refetchOnWindowFocus: false,
} as const;

// ── API Fetch Helpers ───────────────────────────────────────────────

async function fetchOverview(
  businessId: string,
  startDate: string,
  endDate: string
) {
  const res = await fetch(
    `/api/analytics/overview?businessId=${businessId}&startDate=${startDate}&endDate=${endDate}`
  );
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as AnalyticsApiErrorPayload;
    throw buildAnalyticsRequestError(err, "Failed to load analytics overview.");
  }
  return res.json();
}

async function fetchProducts(
  businessId: string,
  startDate: string,
  endDate: string
) {
  const res = await fetch(
    `/api/analytics/products?businessId=${businessId}&startDate=${startDate}&endDate=${endDate}`
  );
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as AnalyticsApiErrorPayload;
    throw buildAnalyticsRequestError(err, "Failed to load product funnel data.");
  }
  return res.json();
}

async function fetchLandingPages(
  businessId: string,
  startDate: string,
  endDate: string
) {
  const res = await fetch(
    `/api/analytics/landing-pages?businessId=${businessId}&startDate=${startDate}&endDate=${endDate}`
  );
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as AnalyticsApiErrorPayload;
    throw buildAnalyticsRequestError(err, "Failed to load landing page data.");
  }
  return res.json();
}

async function fetchAudience(
  businessId: string,
  startDate: string,
  endDate: string
) {
  const res = await fetch(
    `/api/analytics/audience?businessId=${businessId}&startDate=${startDate}&endDate=${endDate}`
  );
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as AnalyticsApiErrorPayload;
    throw buildAnalyticsRequestError(err, "Failed to load audience data.");
  }
  return res.json();
}

async function fetchDemographics(
  businessId: string,
  startDate: string,
  endDate: string,
  dimension: string
) {
  const res = await fetch(
    `/api/analytics/demographics?businessId=${businessId}&startDate=${startDate}&endDate=${endDate}&dimension=${dimension}`
  );
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as AnalyticsApiErrorPayload;
    throw buildAnalyticsRequestError(err, "Failed to load demographic data.");
  }
  return res.json();
}

async function fetchCohorts(
  businessId: string,
  startDate: string,
  endDate: string
) {
  const res = await fetch(
    `/api/analytics/cohorts?businessId=${businessId}&startDate=${startDate}&endDate=${endDate}`
  );
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as AnalyticsApiErrorPayload;
    throw buildAnalyticsRequestError(err, "Failed to load cohort data.");
  }
  return res.json();
}

// ── Page ────────────────────────────────────────────────────────────

export default function AnalyticsPage() {
  const businesses = useAppStore((s) => s.businesses);
  const selectedBusinessId = useAppStore((s) => s.selectedBusinessId);
  const businessId = selectedBusinessId ?? "";
  const domains = useIntegrationsStore((s) =>
    selectedBusinessId ? s.domainsByBusinessId[selectedBusinessId] : undefined
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
  const showBootstrapGuard =
    !isDemoBusiness &&
    (isBootstrapping ||
      ga4View.status === "loading_data" ||
      (bootstrapStatus !== "ready" && !ga4View.isConnected));

  const [activeTab, setActiveTab] = useState<Tab>("overview");
  const [dateRange, setDateRange] = usePersistentDateRange();
  const [demoDimension, setDemoDimension] = useState<DemoDimension>("country");

  const { start: startDate, end: endDate } = getPresetDates(
    dateRange.rangePreset,
    dateRange.customStart,
    dateRange.customEnd
  );

  // Fetch all data (gated on GA4 connection)
  const overviewQuery = useQuery({
    queryKey: ["analytics-overview", businessId, startDate, endDate],
    enabled: ga4Connected,
    queryFn: () => fetchOverview(businessId, startDate, endDate),
    ...analyticsQueryOptions,
  });

  const productsQuery = useQuery({
    queryKey: ["analytics-products", businessId, startDate, endDate],
    enabled: ga4Connected && (activeTab === "products" || activeTab === "opportunities"),
    queryFn: () => fetchProducts(businessId, startDate, endDate),
    ...analyticsQueryOptions,
  });

  const landingPagesQuery = useQuery({
    queryKey: ["analytics-landing-pages", businessId, startDate, endDate],
    enabled: ga4Connected && (activeTab === "landing-pages" || activeTab === "opportunities"),
    queryFn: () => fetchLandingPages(businessId, startDate, endDate),
    ...analyticsQueryOptions,
  });

  const audienceQuery = useQuery({
    queryKey: ["analytics-audience", businessId, startDate, endDate],
    enabled: ga4Connected && (activeTab === "audience" || activeTab === "opportunities"),
    queryFn: () => fetchAudience(businessId, startDate, endDate),
    ...analyticsQueryOptions,
  });

  const demographicsQuery = useQuery({
    queryKey: ["analytics-demographics", businessId, startDate, endDate, demoDimension],
    enabled: ga4Connected && activeTab === "demographics",
    queryFn: () => fetchDemographics(businessId, startDate, endDate, demoDimension),
    ...analyticsQueryOptions,
  });

  const cohortsQuery = useQuery({
    queryKey: ["analytics-cohorts", businessId, startDate, endDate],
    enabled: ga4Connected && activeTab === "cohorts",
    queryFn: () => fetchCohorts(businessId, startDate, endDate),
    ...analyticsQueryOptions,
  });

  if (!selectedBusinessId) return <BusinessEmptyState />;

  if (showBootstrapGuard) {
    return (
      <div className="space-y-6">
        <AnalyticsHeader ga4Connected={false} />
        <LoadingSkeleton rows={4} />
      </div>
    );
  }

  if (!ga4Connected) {
    return (
      <div className="space-y-6">
        <AnalyticsHeader ga4Connected={false} />
        <IntegrationEmptyState
          providerLabel="GA4"
          status={ga4View.status === "action_required" ? "error" : "disconnected"}
          title="Connect GA4 to unlock Analytics"
          description="Analytics insights are powered by your Google Analytics 4 property. Connect GA4 and select a property to get started."
        />
      </div>
    );
  }

  const overviewError = overviewQuery.error;

  return (
    <div className="space-y-5">
      <AnalyticsHeader
        ga4Connected={ga4Connected}
        propertyName={overviewQuery.data?.propertyName}
      />

      {/* Controls bar */}
      <section className="rounded-2xl border bg-card p-4 shadow-sm">
        <div className="flex flex-wrap items-center gap-3">
          <DateRangePicker value={dateRange} onChange={setDateRange} />
        </div>
      </section>

      {/* Error state for overview */}
      {overviewError && (
        <ErrorState
          description={formatAnalyticsErrorMessage(
            overviewError,
            "Failed to load analytics data."
          )}
          onRetry={() => overviewQuery.refetch()}
        />
      )}

      {/* Tab bar */}
      <div className="flex gap-1 overflow-x-auto rounded-xl border bg-card p-1 shadow-sm">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={cn(
              "rounded-lg px-3.5 py-1.5 text-sm font-medium transition-colors whitespace-nowrap",
              activeTab === tab.id
                ? "bg-foreground text-background"
                : "text-muted-foreground hover:bg-muted hover:text-foreground"
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <section className="rounded-2xl border bg-card p-5 shadow-sm">
        {activeTab === "overview" && (
          <>
            <SectionHeader
              title="Executive Overview"
              description="Top-line site performance and key behavioral insights."
            />
            <OverviewSection
              kpis={overviewQuery.data?.kpis}
              newVsReturning={overviewQuery.data?.newVsReturning}
              insights={overviewQuery.data?.insights}
              isLoading={overviewQuery.isLoading}
            />
          </>
        )}

        {activeTab === "products" && (
          <>
            <SectionHeader
              title="Product Funnel"
              description="Where products lose users across the view → cart → checkout → purchase funnel."
            />
            {productsQuery.error ? (
              <ErrorState
                description={formatAnalyticsErrorMessage(
                  productsQuery.error,
                  "Failed to load product data."
                )}
                onRetry={() => productsQuery.refetch()}
              />
            ) : (
              <ProductFunnelSection
                products={productsQuery.data?.products}
                isLoading={productsQuery.isLoading}
              />
            )}
          </>
        )}

        {activeTab === "landing-pages" && (
          <>
            <SectionHeader
              title="Landing Page Performance"
              description="Identify pages that attract traffic but fail to engage or convert."
            />
            {landingPagesQuery.error ? (
              <ErrorState
                description={formatAnalyticsErrorMessage(
                  landingPagesQuery.error,
                  "Failed to load landing page data."
                )}
                onRetry={() => landingPagesQuery.refetch()}
              />
            ) : (
              <LandingPageSection
                pages={landingPagesQuery.data?.pages}
                isLoading={landingPagesQuery.isLoading}
              />
            )}
          </>
        )}

        {activeTab === "audience" && (
          <>
            <SectionHeader
              title="Audience Insights"
              description="New vs returning visitors and traffic source quality breakdown."
            />
            {audienceQuery.error ? (
              <ErrorState
                description={formatAnalyticsErrorMessage(
                  audienceQuery.error,
                  "Failed to load audience data."
                )}
                onRetry={() => audienceQuery.refetch()}
              />
            ) : (
              <AudienceSection
                segments={audienceQuery.data?.segments}
                channels={audienceQuery.data?.channels}
                isLoading={audienceQuery.isLoading}
              />
            )}
          </>
        )}

        {activeTab === "demographics" && (
          <>
            <SectionHeader
              title="Demographic Insights"
              description="Discover which audience segments drive the strongest engagement and purchase rates."
            />
            {demographicsQuery.error ? (
              <ErrorState
                description={formatAnalyticsErrorMessage(
                  demographicsQuery.error,
                  "Failed to load demographic data."
                )}
                onRetry={() => demographicsQuery.refetch()}
              />
            ) : (
              <DemographicSection
                dimension={demoDimension}
                onDimensionChange={setDemoDimension}
                rows={demographicsQuery.data?.rows}
                summary={demographicsQuery.data?.summary}
                isLoading={demographicsQuery.isLoading}
              />
            )}
          </>
        )}

        {activeTab === "cohorts" && (
          <>
            <SectionHeader
              title="Cohort Analysis"
              description="Understand whether acquired users return and repurchase over time."
            />
            {cohortsQuery.error ? (
              <ErrorState
                description={formatAnalyticsErrorMessage(
                  cohortsQuery.error,
                  "Failed to load cohort data."
                )}
                onRetry={() => cohortsQuery.refetch()}
              />
            ) : (
              <CohortSection
                cohortWeeks={cohortsQuery.data?.cohortWeeks}
                monthlyData={cohortsQuery.data?.monthlyData}
                isLoading={cohortsQuery.isLoading}
              />
            )}
          </>
        )}

        {activeTab === "opportunities" && (
          <>
            <SectionHeader
              title="Opportunities & Warnings"
              description="Data-driven flags surfaced from your site behavior — actionable, not generic."
            />
            <OpportunityFlags
              products={productsQuery.data?.products}
              pages={landingPagesQuery.data?.pages}
              channels={audienceQuery.data?.channels}
              newVsReturning={overviewQuery.data?.newVsReturning}
              isLoading={
                productsQuery.isLoading ||
                landingPagesQuery.isLoading ||
                audienceQuery.isLoading
              }
            />
          </>
        )}
      </section>
    </div>
  );
}

// ── Sub-components ──────────────────────────────────────────────────

function AnalyticsHeader({
  ga4Connected,
  propertyName,
}: {
  ga4Connected: boolean;
  propertyName?: string;
}) {
  return (
    <header className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
      <div className="space-y-1">
        <h1 className="text-3xl font-semibold tracking-tight">Analytics</h1>
        <p className="text-sm text-muted-foreground max-w-xl">
          Understand product funnels, audience quality, landing page performance,
          and customer behavior from your site analytics data.
        </p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <div className="inline-flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs">
          <span className="font-medium">GA4</span>
          <Badge variant={ga4Connected ? "default" : "secondary"}>
            {ga4Connected ? "connected" : "not connected"}
          </Badge>
          {propertyName && (
            <span className="text-muted-foreground max-w-[140px] truncate">
              {propertyName}
            </span>
          )}
        </div>
      </div>
    </header>
  );
}

function SectionHeader({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="mb-5">
      <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
      <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
    </div>
  );
}
