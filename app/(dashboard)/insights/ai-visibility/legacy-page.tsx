"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAppStore } from "@/store/app-store";
import { useIntegrationsStore } from "@/store/integrations-store";
import { buildDefaultProviderDomains, deriveProviderViewState } from "@/store/integrations-support";
import { isDemoBusinessSelected } from "@/lib/business-mode";
import { BusinessEmptyState } from "@/components/business/BusinessEmptyState";
import { ErrorState } from "@/components/states/error-state";
import { LoadingSkeleton } from "@/components/states/loading-skeleton";
import {
  DateRangePicker,
  DateRangeValue,
  getPresetDates,
} from "@/components/date-range/DateRangePicker";
import { usePersistentDateRange } from "@/hooks/use-persistent-date-range";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { GeoOverviewSection } from "@/components/geo/GeoOverviewSection";
import { AiTrafficSourcesSection } from "@/components/geo/AiTrafficSourcesSection";
import { GeoPagesSection } from "@/components/geo/GeoPagesSection";
import { GeoQueriesSection } from "@/components/geo/GeoQueriesSection";
import { GeoTopicsSection } from "@/components/geo/GeoTopicsSection";
import { GeoOpportunitiesSection } from "@/components/geo/GeoOpportunitiesSection";
import { useBusinessIntegrationsBootstrap } from "@/hooks/use-business-integrations-bootstrap";

// ── Tabs ────────────────────────────────────────────────────────────

type Tab =
  | "overview"
  | "ai-sources"
  | "pages"
  | "queries"
  | "topics"
  | "opportunities";

const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "ai-sources", label: "AI Sources" },
  { id: "pages", label: "Pages" },
  { id: "queries", label: "Query Intelligence" },
  { id: "topics", label: "Topic Authority" },
  { id: "opportunities", label: "Opportunities" },
];

const geoQueryOptions = {
  retry: false,
  refetchOnWindowFocus: false,
} as const;

// ── Fetch helpers ───────────────────────────────────────────────────

async function geoFetch(path: string, params: Record<string, string>) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`/api/geo/${path}?${qs}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { message?: string };
    throw new Error(err.message ?? `Failed to load AI Visibility ${path} data.`);
  }
  return res.json();
}

// ── Page ────────────────────────────────────────────────────────────

export default function AiVisibilityPage() {
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
  const scView = deriveProviderViewState(
    "search_console",
    domains?.search_console ?? buildDefaultProviderDomains().search_console
  );
  const ga4Connected = ga4View.isConnected || isDemoBusiness;
  const scConnected = scView.isConnected || isDemoBusiness;
  const anyConnected = ga4Connected || scConnected;
  const showBootstrapGuard =
    !isDemoBusiness &&
    (isBootstrapping ||
      ((ga4View.status === "loading_data" || scView.status === "loading_data") && !anyConnected) ||
      (bootstrapStatus !== "ready" && !anyConnected));

  const [activeTab, setActiveTab] = useState<Tab>("overview");
  const [dateRange, setDateRange] = usePersistentDateRange();

  const { start: startDate, end: endDate } = getPresetDates(
    dateRange.rangePreset,
    dateRange.customStart,
    dateRange.customEnd
  );

  const params = { businessId, startDate, endDate };

  const overviewQuery = useQuery({
    queryKey: ["geo-overview", businessId, startDate, endDate],
    enabled: anyConnected,
    queryFn: () => geoFetch("overview", params),
    ...geoQueryOptions,
  });

  const sourcesQuery = useQuery({
    queryKey: ["geo-sources", businessId, startDate, endDate],
    enabled: ga4Connected && activeTab === "ai-sources",
    queryFn: () => geoFetch("traffic-sources", params),
    ...geoQueryOptions,
  });

  const pagesQuery = useQuery({
    queryKey: ["geo-pages", businessId, startDate, endDate],
    enabled: ga4Connected && activeTab === "pages",
    queryFn: () => geoFetch("pages", params),
    ...geoQueryOptions,
  });

  const queriesQuery = useQuery({
    queryKey: ["geo-queries", businessId, startDate, endDate],
    enabled: scConnected && activeTab === "queries",
    queryFn: () => geoFetch("queries", params),
    ...geoQueryOptions,
  });

  const topicsQuery = useQuery({
    queryKey: ["geo-topics", businessId, startDate, endDate],
    enabled: scConnected && activeTab === "topics",
    queryFn: () => geoFetch("topics", params),
    ...geoQueryOptions,
  });

  const opportunitiesQuery = useQuery({
    queryKey: ["geo-opportunities", businessId, startDate, endDate],
    enabled: anyConnected && activeTab === "opportunities",
    queryFn: () => geoFetch("opportunities", params),
    ...geoQueryOptions,
  });

  if (!selectedBusinessId) return <BusinessEmptyState />;

  if (showBootstrapGuard) {
    return (
      <div className="space-y-5">
        <header className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <h2 className="font-[family-name:var(--adv-font-display)] text-[19px] font-semibold tracking-[-0.01em] text-[var(--adv-ink)]">
              AI Visibility
            </h2>
            <p className="max-w-xl text-sm leading-5 text-[var(--adv-ink-3)]">
              Generative Engine · how your brand surfaces in AI tools.
            </p>
          </div>
        </header>
        <LoadingSkeleton rows={4} />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Page header */}
      <header className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <h2 className="font-[family-name:var(--adv-font-display)] text-[19px] font-semibold tracking-[-0.01em] text-[var(--adv-ink)]">
            AI Visibility
          </h2>
          <p className="max-w-xl text-sm leading-5 text-[var(--adv-ink-3)]">
            Generative Engine · how your brand surfaces in AI tools.
          </p>
        </div>
        {/* Source status chips */}
        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <ConnectedChip label="GA4" connected={ga4Connected} />
          <ConnectedChip label="Search Console" connected={scConnected} />
        </div>
      </header>

      {/* AI Visibility explainer band */}
      <div className="rounded-xl border border-[var(--adv-border)] bg-white px-5 py-3.5">
        <p className="text-sm">
          <span className="font-semibold text-[var(--adv-ink)]">What is AI Visibility?</span>
          <span className="ml-2 text-[var(--adv-ink-3)]">
            Understand how AI-driven surfaces like
            ChatGPT, Perplexity, Gemini, and Copilot expose your brand and content, and what to
            improve next to win more AI-sourced discovery.
          </span>
        </p>
      </div>

      {/* No connections state */}
      {!anyConnected && (
        <div className="rounded-xl border border-dashed border-[var(--adv-scroll-thumb)] bg-white p-8 text-center">
          <h3 className="text-base font-semibold">Unlock AI Visibility</h3>
          <p className="mx-auto mt-2 max-w-sm text-sm leading-5 text-[var(--adv-ink-3)]">
            Connect <strong>GA4</strong> to detect AI-source traffic and measure commercial
            impact. Connect <strong>Search Console</strong> to surface query and topic
            authority signals.
          </p>
          <a
            href="/integrations"
            className="mt-5 inline-flex items-center rounded-lg bg-foreground px-4 py-2 text-sm font-medium text-background hover:opacity-90 transition"
          >
            Open Integrations
          </a>
        </div>
      )}

      {/* Controls */}
      {anyConnected && (
        <section className="rounded-xl border border-[var(--adv-border)] bg-white p-3">
          <div className="flex flex-wrap items-center gap-3">
            <DateRangePicker
            showComparisonTrigger={false} value={dateRange} onChange={setDateRange} />
          </div>
        </section>
      )}

      {/* Overview error */}
      {overviewQuery.error && (
        <ErrorState
          description={
            overviewQuery.error instanceof Error
              ? overviewQuery.error.message
              : "Failed to load AI Visibility overview."
          }
          onRetry={() => overviewQuery.refetch()}
        />
      )}

      {/* Partial data notices */}
      {anyConnected && !ga4Connected && (
        <PartialDataNotice
          text="AI traffic source data requires GA4. Connect GA4 to unlock AI-source session analysis."
        />
      )}
      {anyConnected && !scConnected && (
        <PartialDataNotice
          text="Query intelligence and topic authority require Search Console. Connect and select a site in Integrations."
        />
      )}

      {/* Tab bar */}
      {anyConnected && (
        <div className="flex gap-1 overflow-x-auto border-b border-[var(--adv-border)]">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={cn(
                "-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-[13px] font-medium transition-colors",
                activeTab === tab.id
                  ? "border-[var(--adv-ink)] text-[var(--adv-ink)]"
                  : "border-transparent text-[var(--adv-ink-3)] hover:text-[var(--adv-ink)]"
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>
      )}

      {/* Tab content */}
      {anyConnected && (
        <section className="rounded-xl border border-[var(--adv-border)] bg-white p-5">
          {activeTab === "overview" && (
            <>
              <SectionHeader
                title="Search intelligence"
                description="AI-source traffic KPIs, AI visibility opportunity score, and intelligence callouts."
              />
              <GeoOverviewSection
                kpis={overviewQuery.data?.kpis}
                insights={overviewQuery.data?.insights}
                top3Priorities={overviewQuery.data?.top3Priorities}
                highlights={overviewQuery.data?.highlights}
                isLoading={overviewQuery.isLoading}
              />
            </>
          )}

          {activeTab === "ai-sources" && (
            <>
              <SectionHeader
                title="AI traffic sources"
                description="sessions from known AI engines · value vs site average · momentum vs previous period"
              />
              {!ga4Connected ? (
                <RequiresIntegration name="GA4" reason="to detect AI referral traffic" />
              ) : sourcesQuery.error ? (
                <ErrorState
                  description={sourcesQuery.error instanceof Error ? sourcesQuery.error.message : "Failed to load."}
                  onRetry={() => sourcesQuery.refetch()}
                />
              ) : (
                <AiTrafficSourcesSection
                  sources={sourcesQuery.data?.sources}
                  isLoading={sourcesQuery.isLoading}
                />
              )}
            </>
          )}

          {activeTab === "pages" && (
            <>
              <SectionHeader
                title="AI content winners"
                description="pages receiving AI-sourced traffic, ranked by AI Visibility Score — your strongest AI-discovery assets"
              />
              {!ga4Connected ? (
                <RequiresIntegration name="GA4" reason="to show page-level AI traffic" />
              ) : pagesQuery.error ? (
                <ErrorState
                  description={pagesQuery.error instanceof Error ? pagesQuery.error.message : "Failed to load."}
                  onRetry={() => pagesQuery.refetch()}
                />
              ) : (
                <GeoPagesSection
                  pages={pagesQuery.data?.pages}
                  isLoading={pagesQuery.isLoading}
                />
              )}
            </>
          )}

          {activeTab === "queries" && (
            <>
              <SectionHeader
                title="Query intelligence"
                description="Ranking queries analyzed for AI/answer-engine intent. Violet = high AI visibility relevance."
              />
              {!scConnected ? (
                <RequiresIntegration name="Search Console" reason="to surface query intelligence" />
              ) : queriesQuery.error ? (
                <ErrorState
                  description={queriesQuery.error instanceof Error ? queriesQuery.error.message : "Failed to load."}
                  onRetry={() => queriesQuery.refetch()}
                />
              ) : (
                <GeoQueriesSection
                  queries={queriesQuery.data?.queries}
                  isLoading={queriesQuery.isLoading}
                />
              )}
            </>
          )}

          {activeTab === "topics" && (
            <>
              <SectionHeader
                title="Topic authority"
                description="Topic clusters derived from your ranking queries. Strong clusters = authoritative answer-engine presence."
              />
              {!scConnected ? (
                <RequiresIntegration name="Search Console" reason="to build topic clusters" />
              ) : topicsQuery.error ? (
                <ErrorState
                  description={topicsQuery.error instanceof Error ? topicsQuery.error.message : "Failed to load."}
                  onRetry={() => topicsQuery.refetch()}
                />
              ) : (
                <GeoTopicsSection
                  topics={topicsQuery.data?.topics}
                  isLoading={topicsQuery.isLoading}
                />
              )}
            </>
          )}

          {activeTab === "opportunities" && (
            <>
              <SectionHeader
                title="Opportunities and playbook"
                description="Evidence-based, consultant-grade recommendations to improve AI-era discoverability."
              />
              {opportunitiesQuery.error ? (
                <ErrorState
                  description={opportunitiesQuery.error instanceof Error ? opportunitiesQuery.error.message : "Failed to load."}
                  onRetry={() => opportunitiesQuery.refetch()}
                />
              ) : (
                <GeoOpportunitiesSection
                  opportunities={opportunitiesQuery.data?.opportunities}
                  isLoading={opportunitiesQuery.isLoading}
                />
              )}
            </>
          )}
        </section>
      )}

      {/* Methodology footnote */}
      {anyConnected && (
        <details className="rounded-xl border border-[var(--adv-border)] bg-white px-4 py-3">
          <summary className="cursor-pointer select-none text-xs font-medium text-[var(--adv-ink-3)]">
            Methodology & data assumptions
          </summary>
          <div className="mt-3 space-y-2 text-xs leading-5 text-[var(--adv-ink-3)]">
            <p>
              <strong>AI referral traffic</strong> is detected by matching GA4 session sources
              against known AI engine domains (chat.openai.com, perplexity.ai, gemini.google.com,
              copilot.microsoft.com, claude.ai, and others).
            </p>
            <p>
              <strong>AI Visibility Opportunity Score</strong> is a composite signal combining AI-source
              traffic share, AI visitor engagement quality, and informational query breadth.
              It is an internal estimate, not a metric reported by any AI engine.
            </p>
            <p>
              <strong>Query intent classification</strong> uses deterministic heuristic patterns
              (phrase prefixes, comparison signals, long-tail length) to detect answer-intent and
              AI-style queries from Search Console data.
            </p>
            <p>
              <strong>Topic clusters</strong> are generated by extracting 1–3 word noun phrases
              from queries — including plural normalisation, modifier stripping, and stopword
              removal — then aggregating related search demand. Clustering improves with more
              query data.
            </p>
            <p>
              <strong>AI Visibility scores per page, query, and topic</strong> are component-based 0–100
              scores composed of visibility, engagement, conversion, and intent signals. Priority
              (high/medium/low) is assigned from score + traffic magnitude + CVR delta. All scores
              are deterministic — the same signals always produce the same score.
            </p>
            <p>
              Direct AI engine citation visibility (e.g., whether ChatGPT cites your page) is not
              measurable from current public APIs. All AI Visibility insights here are inference-based.
            </p>
          </div>
        </details>
      )}
    </div>
  );
}

// ── Sub-components ──────────────────────────────────────────────────

function ConnectedChip({ label, connected }: { label: string; connected: boolean }) {
  return (
    <div className="inline-flex items-center gap-2 rounded-lg border border-[var(--adv-border)] bg-white px-2.5 py-1.5 text-xs">
      <span className="font-medium">{label}</span>
      <Badge
        variant="secondary"
        className={connected ? "border border-[var(--adc-pos-bd)] bg-[var(--adc-pos-bg)] text-[var(--adc-pos-fg)]" : "border border-[var(--adv-border)] bg-[var(--adv-fill-2)] text-[var(--adv-ink-2)]"}
      >
        {connected ? "connected" : "not connected"}
      </Badge>
    </div>
  );
}

function SectionHeader({ title, description }: { title: string; description: string }) {
  return (
    <div className="mb-5">
      <h2 className="text-[16px] font-semibold tracking-tight text-[var(--adv-ink)]">{title}</h2>
      <p className="mt-0.5 text-sm leading-5 text-[var(--adv-ink-3)]">{description}</p>
    </div>
  );
}

function PartialDataNotice({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-2.5 rounded-xl border border-[var(--adc-caution-bd)] bg-[var(--adc-caution-bg)] px-4 py-2.5">
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--adc-caution-fg)]" />
      <p className="text-xs text-[var(--adc-caution-fg)]">{text}</p>
    </div>
  );
}

function RequiresIntegration({ name, reason }: { name: string; reason: string }) {
  return (
    <div className="rounded-xl border border-dashed border-[var(--adv-scroll-thumb)] bg-white py-8 text-center">
      <p className="text-sm font-medium">Requires {name}</p>
      <p className="mt-1 text-xs text-[var(--adv-ink-3)]">
        Connect {name} {reason}.
      </p>
      <a
        href="/integrations"
        className="mt-4 inline-flex items-center rounded-lg border px-3 py-1.5 text-xs font-medium hover:bg-muted transition"
      >
        Open Integrations
      </a>
    </div>
  );
}
