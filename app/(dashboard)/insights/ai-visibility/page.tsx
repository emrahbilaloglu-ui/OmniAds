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
            <h1 className="text-3xl font-semibold tracking-tight">AI Visibility</h1>
            <p className="text-sm text-muted-foreground max-w-xl">
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
          <h1 className="text-3xl font-semibold tracking-tight">AI Visibility</h1>
          <p className="text-sm text-muted-foreground max-w-xl">
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
      <div className="rounded-xl border bg-gradient-to-r from-violet-50 to-blue-50 px-5 py-3.5 dark:from-violet-950/30 dark:to-blue-950/30 dark:border-violet-900/40">
        <p className="text-sm">
          <span className="font-semibold text-violet-700 dark:text-violet-300">What is AI Visibility?</span>
          <span className="text-muted-foreground ml-2">
            Understand how AI-driven surfaces like
            ChatGPT, Perplexity, Gemini, and Copilot expose your brand and content, and what to
            improve next to win more AI-sourced discovery.
          </span>
        </p>
      </div>

      {/* No connections state */}
      {!anyConnected && (
        <div className="rounded-xl border border-dashed p-12 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
            <span className="text-2xl">🧠</span>
          </div>
          <h3 className="text-base font-semibold">Unlock AI Visibility</h3>
          <p className="mt-2 max-w-sm text-sm text-muted-foreground mx-auto">
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
        <section className="rounded-2xl border bg-card p-4 shadow-sm">
          <div className="flex flex-wrap items-center gap-3">
            <DateRangePicker value={dateRange} onChange={setDateRange} />
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
      )}

      {/* Tab content */}
      {anyConnected && (
        <section className="rounded-2xl border bg-card p-5 shadow-sm">
          {activeTab === "overview" && (
            <>
              <SectionHeader
                title="Executive Overview"
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
                title="AI Traffic Sources"
                description="Sessions, engagement, and commercial performance broken down by AI discovery engine."
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
                title="AI Visibility Content Winners"
                description="Pages receiving AI-sourced traffic, ranked by AI Visibility Score. These are your strongest AI-discovery assets."
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
                title="Query Intelligence"
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
                title="Topic Authority"
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
                title="Opportunities & Playbook"
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
        <details className="rounded-xl border bg-card px-4 py-3 shadow-sm">
          <summary className="cursor-pointer text-xs font-medium text-muted-foreground select-none">
            Methodology & data assumptions
          </summary>
          <div className="mt-3 space-y-2 text-xs text-muted-foreground">
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
    <div className="inline-flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs">
      <span className="font-medium">{label}</span>
      <Badge variant={connected ? "default" : "secondary"}>
        {connected ? "connected" : "not connected"}
      </Badge>
    </div>
  );
}

function SectionHeader({ title, description }: { title: string; description: string }) {
  return (
    <div className="mb-5">
      <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
      <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
    </div>
  );
}

function PartialDataNotice({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-2.5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 dark:border-amber-900/40 dark:bg-amber-950/20">
      <span className="text-amber-600 text-sm shrink-0">⚠</span>
      <p className="text-xs text-amber-700 dark:text-amber-300">{text}</p>
    </div>
  );
}

function RequiresIntegration({ name, reason }: { name: string; reason: string }) {
  return (
    <div className="rounded-xl border border-dashed py-8 text-center">
      <p className="text-sm font-medium">Requires {name}</p>
      <p className="mt-1 text-xs text-muted-foreground">
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
