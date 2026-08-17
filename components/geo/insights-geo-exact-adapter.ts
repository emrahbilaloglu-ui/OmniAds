/**
 * Pure mapping from the six `/api/geo/**` endpoints to the Insights → AI
 * Visibility view model. No React, no fetching.
 *
 * Formatting mirrors the design's own script: `(v*100).toFixed(1)` for
 * engagement, `.toFixed(2)` for purchase CVR, the heat ramp
 * `rgba(14,159,110, 0.05 + 0.3·min(1, v/max))` (script line 3904) and the
 * `scorePill` thresholds 60 / 35 (script line 4062). Every fact a provider does
 * not supply renders as the em-dash — the design's seeds (3,840 AI sessions,
 * the fake engine table, the 220-query dataset) are never emitted.
 */
import { AI_SOURCE_DOMAINS } from "@/lib/geo-intelligence";
import { formatCurrencySmart, MISSING_VALUE } from "@/lib/metric-format";
import type {
  GeoCalloutModel,
  GeoHighlightModel,
  GeoIntentBandModel,
  GeoKpiModel,
  GeoMethodologyParagraphModel,
  GeoPageRowModel,
  GeoPlayModel,
  GeoPriorityModel,
  GeoQueryFilterModel,
  GeoQueryRowModel,
  GeoScoreBarModel,
  GeoSourceRowModel,
  GeoSubTabModel,
  GeoTabId,
  GeoTone,
  GeoTopicModel,
  InsightsGeoExactModel,
} from "@/components/geo/insights-geo-exact-model";

/** Script line 4028 — order and captions verbatim. */
export const GEO_TABS: ReadonlyArray<{ id: GeoTabId; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "sources", label: "AI Sources" },
  { id: "pages", label: "Pages" },
  { id: "queries", label: "Query Intelligence" },
  { id: "topics", label: "Topic Authority" },
  { id: "plays", label: "Playbook" },
];

/** Script line 4074 — "AI intent" leads, "All queries" is second. */
export const GEO_QUERY_FILTERS = ["ai", "all", "hi", "weak", "rising"] as const;
export type GeoQueryFilterId = (typeof GEO_QUERY_FILTERS)[number];

const GEO_FILTER_LABEL: Record<GeoQueryFilterId, string> = {
  ai: "AI intent",
  all: "All queries",
  hi: "High impressions",
  weak: "Weak CTR",
  rising: "Rising ↑",
};

const MINUS = "−";

/* ── formatters ───────────────────────────────────────────────────── */

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function formatCount(value: unknown): string {
  const parsed = num(value);
  if (parsed === null) return MISSING_VALUE;
  return Math.round(parsed).toLocaleString("en-US");
}

export function formatCompact(value: unknown): string {
  const parsed = num(value);
  if (parsed === null) return MISSING_VALUE;
  const abs = Math.abs(parsed);
  if (abs >= 1_000_000) return `${(parsed / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(parsed / 1_000).toFixed(1)}K`;
  return Math.round(parsed).toLocaleString("en-US");
}

export function formatRate(value: unknown, digits: 0 | 1 | 2): string {
  const parsed = num(value);
  if (parsed === null) return MISSING_VALUE;
  return `${(parsed * 100).toFixed(digits)}%`;
}

/** Script line 3904 — the design's own heat ramp, verbatim. */
export function heat(value: unknown, max: number): string {
  const parsed = num(value);
  if (parsed === null || parsed <= 0) return "";
  const alpha = 0.05 + 0.3 * Math.min(1, parsed / max);
  return `rgba(14,159,110,${alpha.toFixed(3)})`;
}

/** Script line 4062 — `scorePill`: ≥60 positive, ≥35 warning, else neutral. */
export function scoreTone(value: unknown): GeoTone {
  const parsed = num(value);
  if (parsed === null) return "neutral";
  if (parsed >= 60) return "positive";
  if (parsed >= 35) return "warning";
  return "neutral";
}

const ENGINE_TONE: Record<string, GeoTone> = {
  ChatGPT: "positive",
  Perplexity: "violet",
  Gemini: "info",
  Copilot: "info",
  Claude: "warning",
};

/** Script line 4052 — `VAL`. */
const VALUE_TONE: Record<string, GeoTone> = {
  elite: "violet",
  strong: "positive",
  promising: "warning",
  weak: "neutral",
};

/** Script line 4053 — `MOM`. */
const MOMENTUM_TONE: Record<string, GeoTone> = {
  breakout: "violet",
  rising: "positive",
  stable: "neutral",
  declining: "negative",
};

const PRIORITY_TONE: Record<string, GeoTone> = {
  high: "negative",
  medium: "warning",
  low: "neutral",
};

/** Script line 4077 — `covC`. */
const COVERAGE_TONE: Record<string, GeoTone> = {
  Strong: "positive",
  Moderate: "warning",
  Weak: "negative",
};

/**
 * The design's compact momentum caption ("Rising · +38%", "Stable") built from
 * the real status and growth rate rather than the long service-side sentence.
 */
export function momentumCaption(
  status: string | null | undefined,
  growthRate: number | null | undefined,
): string {
  const label = text(status);
  if (!label) return MISSING_VALUE;
  const word = label.charAt(0).toUpperCase() + label.slice(1);
  const rate = num(growthRate);
  if (word === "Stable" || rate === null || rate === 0) return word;
  const sign = rate > 0 ? "+" : MINUS;
  return `${word} · ${sign}${Math.abs(rate * 100).toFixed(0)}%`;
}

/* ── endpoint payload shapes (only what this screen reads) ─────────── */

export interface GeoOverviewInput {
  kpis?: {
    aiSessions?: number;
    previousAiSessions?: number | null;
    aiSessionsDelta?: number | null;
    aiEngagementRate?: number;
    aiPurchaseCvr?: number;
    geoScore?: number;
    aiPageCount?: number;
    topAiSource?: string | null;
    topAiSourceSessions?: number | null;
    topAiSourceShare?: number | null;
    siteAvgEngagementRate?: number;
    siteAvgPurchaseCvr?: number;
    aiStyleQueryCount?: number;
    totalQueryCount?: number;
  } | null;
  insights?: Array<{ type?: string; text?: string }>;
  top3Priorities?: Array<{
    title?: string;
    description?: string;
    priority?: string;
    effort?: string;
    impact?: string;
  }>;
  highlights?: {
    strongestGeoQuery?: { query?: string; geoScore?: number; impressions?: number } | null;
    strongestGeoTopic?: {
      topic?: string;
      geoScore?: number;
      impressions?: number;
      coverageStrength?: string;
    } | null;
    highestAiValueSource?: { engine?: string; label?: string; score?: number } | null;
  } | null;
}

export interface GeoSourceInput {
  engine?: string;
  sessions?: number;
  engagementRate?: number;
  purchases?: number;
  revenue?: number;
  purchaseCvr?: number;
  aiTrafficValueScore?: number;
  aiTrafficValueLabel?: string;
  momentum?: { status?: string; growthRate?: number } | null;
  recommendation?: string | null;
}

export interface GeoPageInput {
  path?: string;
  aiSessions?: number;
  engagementRate?: number;
  purchaseCvr?: number;
  geoScore?: number;
  /** Engines that referred this page — added for the design's 6th column. */
  sourcedBy?: string[];
}

export interface GeoQueryInput {
  query?: string;
  impressions?: number;
  ctr?: number;
  position?: number;
  isAiStyle?: boolean;
  classification?: { intentLabel?: string; formatLabel?: string } | null;
  geoScore?: number;
  geoScoreBreakdown?: Record<string, number> | null;
  momentum?: { status?: string; growthRate?: number } | null;
  priority?: string;
  recommendation?: string | null;
}

export interface GeoTopicInput {
  topic?: string;
  queryCount?: number;
  impressions?: number;
  clicks?: number;
  avgPosition?: number;
  geoScore?: number;
  coverageStrength?: string;
  authorityStrength?: string;
  coverageGap?: string | null;
  priority?: string;
  queries?: string[];
  momentum?: { status?: string; growthRate?: number } | null;
  recommendation?: {
    title?: string;
    effort?: string;
    impact?: string;
    expectedOutcome?: string;
  } | null;
}

export interface GeoOpportunityInput {
  title?: string;
  evidence?: string;
  recommendation?: string;
  effort?: string;
  impact?: string;
  priority?: string;
}

export interface InsightsGeoAdapterInput {
  activeTab: GeoTabId;
  queryFilter: GeoQueryFilterId;
  /** Length of the selected window in days — the design's "vs prev Nd" suffix. */
  windowDays?: number | null;
  overview?: GeoOverviewInput | null;
  sources?: GeoSourceInput[] | null;
  pages?: GeoPageInput[] | null;
  queries?: GeoQueryInput[] | null;
  topics?: GeoTopicInput[] | null;
  opportunities?: GeoOpportunityInput[] | null;
}

/* ── Overview (L2128-2173) ────────────────────────────────────────── */

export function buildGeoKpis(
  overview: GeoOverviewInput | null | undefined,
  windowDays?: number | null,
): GeoKpiModel[] {
  const kpis = overview?.kpis ?? null;
  const delta = num(kpis?.aiSessionsDelta);
  const share = num(kpis?.topAiSourceShare);
  const topSessions = num(kpis?.topAiSourceSessions);

  const topSourceParts = [
    topSessions === null ? null : `${formatCount(topSessions)} sessions`,
    share === null ? null : `${(share * 100).toFixed(0)}% of AI traffic`,
  ].filter((part): part is string => part !== null);

  return [
    {
      key: "sessions",
      label: "AI-source sessions",
      value: formatCount(kpis?.aiSessions),
      sub:
        delta === null
          ? MISSING_VALUE
          : `${delta >= 0 ? "+" : MINUS}${Math.abs(delta * 100).toFixed(0)}% vs prev ${
              windowDays && Number.isFinite(windowDays)
                ? `${Math.round(windowDays)}d`
                : "period"
            }`,
      subTone: delta === null ? "neutral" : delta >= 0 ? "positive" : "negative",
      highlighted: false,
    },
    {
      key: "engagement",
      label: "AI engagement rate",
      value: formatRate(kpis?.aiEngagementRate, 1),
      sub: `site avg ${formatRate(kpis?.siteAvgEngagementRate, 1)}`,
      subTone: "neutral",
      highlighted: false,
    },
    {
      key: "cvr",
      label: "AI purchase CVR",
      value: formatRate(kpis?.aiPurchaseCvr, 2),
      sub: `site avg ${formatRate(kpis?.siteAvgPurchaseCvr, 2)}`,
      subTone: "neutral",
      highlighted: false,
    },
    {
      key: "score",
      label: "GEO opportunity score",
      value: num(kpis?.geoScore) === null ? MISSING_VALUE : `${Math.round(kpis!.geoScore!)} / 100`,
      sub: "composite · deterministic",
      subTone: "neutral",
      highlighted: true,
    },
    {
      key: "pages",
      label: "Pages with GEO signals",
      value: formatCount(kpis?.aiPageCount),
      sub: "proxy · capped at 50",
      subTone: "neutral",
      highlighted: false,
    },
    {
      key: "topSource",
      label: "Top AI source",
      value: text(kpis?.topAiSource) ?? MISSING_VALUE,
      sub: topSourceParts.length > 0 ? topSourceParts.join(" · ") : MISSING_VALUE,
      subTone: "neutral",
      highlighted: false,
    },
  ];
}

export function buildGeoIntentBand(
  overview: GeoOverviewInput | null | undefined,
): GeoIntentBandModel {
  const ai = num(overview?.kpis?.aiStyleQueryCount);
  const total = num(overview?.kpis?.totalQueryCount);
  const ratio = ai !== null && total !== null && total > 0 ? ai / total : null;
  return {
    aiQueries: ai === null ? MISSING_VALUE : formatCount(ai),
    totalQueries: total === null ? MISSING_VALUE : formatCount(total),
    barWidth: ratio === null ? "0%" : `${(ratio * 100).toFixed(1)}%`,
  };
}

export function buildGeoPriorities(
  overview: GeoOverviewInput | null | undefined,
): GeoPriorityModel[] {
  return (overview?.top3Priorities ?? []).map((priority, index) => {
    const level = text(priority?.priority)?.toLowerCase() ?? "";
    return {
      id: `priority-${index}`,
      priorityLabel: level ? level.charAt(0).toUpperCase() + level.slice(1) : MISSING_VALUE,
      tone: PRIORITY_TONE[level] ?? "neutral",
      title: text(priority?.title) ?? MISSING_VALUE,
      detail: text(priority?.description) ?? MISSING_VALUE,
      impact: text(priority?.impact) ?? MISSING_VALUE,
      effort: text(priority?.effort)
        ? `${priority!.effort!.toLowerCase()} effort`
        : MISSING_VALUE,
    };
  });
}

export function buildGeoHighlights(
  overview: GeoOverviewInput | null | undefined,
): GeoHighlightModel[] {
  const highlights = overview?.highlights ?? null;
  const rows: GeoHighlightModel[] = [];

  const query = highlights?.strongestGeoQuery ?? null;
  rows.push({
    id: "query",
    label: "Strongest GEO query",
    tone: "violet",
    main: text(query?.query) ? `“${query!.query!.trim()}”` : MISSING_VALUE,
    pill: num(query?.geoScore) === null ? MISSING_VALUE : `GEO ${Math.round(query!.geoScore!)}`,
    sub:
      num(query?.impressions) === null
        ? MISSING_VALUE
        : `${formatCount(query!.impressions)} impressions`,
  });

  const topic = highlights?.strongestGeoTopic ?? null;
  const coverage = text(topic?.coverageStrength);
  rows.push({
    id: "topic",
    label: "Strongest GEO topic",
    tone: "positive",
    main: text(topic?.topic) ?? MISSING_VALUE,
    pill: num(topic?.geoScore) === null ? MISSING_VALUE : `GEO ${Math.round(topic!.geoScore!)}`,
    sub:
      num(topic?.impressions) === null
        ? MISSING_VALUE
        : [`${formatCompact(topic!.impressions)} impressions`, coverage ? `${coverage} coverage` : null]
            .filter((part): part is string => part !== null)
            .join(" · "),
  });

  const source = highlights?.highestAiValueSource ?? null;
  rows.push({
    id: "source",
    label: "Highest AI-value source",
    tone: "info",
    main: text(source?.engine) ?? MISSING_VALUE,
    pill:
      num(source?.score) === null ? MISSING_VALUE : `value ${Math.round(source!.score!)}/100`,
    sub: text(source?.label) ? `${source!.label} tier` : MISSING_VALUE,
  });

  return rows;
}

const CALLOUT_KIND: Record<string, { kind: string; tone: GeoTone }> = {
  positive: { kind: "Positive", tone: "positive" },
  warning: { kind: "Warning", tone: "warning" },
  neutral: { kind: "Info", tone: "neutral" },
};

export function buildGeoCallouts(
  overview: GeoOverviewInput | null | undefined,
): GeoCalloutModel[] {
  return (overview?.insights ?? [])
    .map((insight, index) => {
      const body = text(insight?.text);
      if (!body) return null;
      const kind = CALLOUT_KIND[insight?.type ?? ""] ?? CALLOUT_KIND.neutral;
      return { id: `callout-${index}`, kind: kind.kind, tone: kind.tone, text: body };
    })
    .filter((row): row is GeoCalloutModel => row !== null);
}

/* ── AI Sources (L2174-2196) ──────────────────────────────────────── */

export function buildGeoSources(sources: GeoSourceInput[] | null | undefined): GeoSourceRowModel[] {
  return (sources ?? []).map((source, index) => {
    const engine = text(source?.engine) ?? MISSING_VALUE;
    const valueLabel = text(source?.aiTrafficValueLabel);
    const valueScore = num(source?.aiTrafficValueScore);
    return {
      id: `source-${engine}-${index}`,
      engine,
      engineTone: ENGINE_TONE[engine] ?? "neutral",
      value:
        valueLabel && valueScore !== null
          ? `${valueLabel} · ${Math.round(valueScore)}`
          : (valueLabel ?? MISSING_VALUE),
      valueTone: VALUE_TONE[valueLabel ?? ""] ?? "neutral",
      momentum: momentumCaption(source?.momentum?.status, source?.momentum?.growthRate),
      momentumTone: MOMENTUM_TONE[source?.momentum?.status ?? ""] ?? "neutral",
      sessions: formatCount(source?.sessions),
      engagement: formatRate(source?.engagementRate, 1),
      engagementHeat: heat(source?.engagementRate, 0.8),
      purchases: formatCount(source?.purchases),
      cvr: formatRate(source?.purchaseCvr, 2),
      cvrHeat: heat(source?.purchaseCvr, 0.035),
      revenue:
        num(source?.revenue) === null
          ? MISSING_VALUE
          : formatCurrencySmart(source!.revenue!, "$"),
      recommendation: text(source?.recommendation) ?? MISSING_VALUE,
    };
  });
}

/* ── Pages (L2197-2216) ───────────────────────────────────────────── */

export function buildGeoPages(pages: GeoPageInput[] | null | undefined): GeoPageRowModel[] {
  return (pages ?? []).map((page, index) => {
    const score = num(page?.geoScore);
    const sourcedBy = (page?.sourcedBy ?? [])
      .map((engine) => text(engine))
      .filter((engine): engine is string => engine !== null);
    return {
      id: `page-${text(page?.path) ?? index}`,
      page: text(page?.path) ?? MISSING_VALUE,
      aiSessions: formatCount(page?.aiSessions),
      engagement: formatRate(page?.engagementRate, 0),
      cvr: formatRate(page?.purchaseCvr, 1),
      score: score === null ? MISSING_VALUE : `AIV ${Math.round(score)}`,
      scoreTone: scoreTone(score),
      sourcedBy: sourcedBy.length > 0 ? sourcedBy.join(" · ") : MISSING_VALUE,
    };
  });
}

/* ── Query Intelligence (L2217-2250) ──────────────────────────────── */

/** Deterministic membership, mirroring the design's `f` tags (script L4064-4073). */
export function geoQueryFilterTags(query: GeoQueryInput): GeoQueryFilterId[] {
  const tags: GeoQueryFilterId[] = ["all"];
  if (query?.isAiStyle) tags.push("ai");
  const impressions = num(query?.impressions);
  if (impressions !== null && impressions >= 1000) tags.push("hi");
  const ctr = num(query?.ctr);
  if (ctr !== null && ctr < 0.02) tags.push("weak");
  const status = query?.momentum?.status;
  if (status === "rising" || status === "breakout") tags.push("rising");
  return tags;
}

/** The component captions, from the real `scoreQueryGeo` keys and their maxima. */
const QUERY_SCORE_COMPONENTS: ReadonlyArray<{ key: string; label: string; max: number }> = [
  { key: "impressions", label: "Impressions", max: 30 },
  { key: "positionQuality", label: "Position", max: 25 },
  { key: "ctrGap", label: "CTR gap", max: 25 },
  { key: "intent", label: "Intent", max: 20 },
];

function scoreBars(breakdown: Record<string, number> | null | undefined): GeoScoreBarModel[] {
  if (!breakdown) return [];
  return QUERY_SCORE_COMPONENTS.filter((component) => component.key in breakdown).map(
    (component) => {
      const value = num(breakdown[component.key]) ?? 0;
      return {
        key: component.key,
        label: component.label,
        value: String(Math.round(value)),
        width: `${Math.max(0, Math.min(100, (value / component.max) * 100)).toFixed(0)}%`,
      };
    },
  );
}

export function buildGeoFilters(
  queries: GeoQueryInput[] | null | undefined,
  active: GeoQueryFilterId,
): GeoQueryFilterModel[] {
  const counts = new Map<GeoQueryFilterId, number>();
  for (const query of queries ?? []) {
    for (const tag of geoQueryFilterTags(query)) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return GEO_QUERY_FILTERS.map((id) => ({
    id,
    label: GEO_FILTER_LABEL[id],
    count: String(counts.get(id) ?? 0),
    active: id === active,
  }));
}

export function buildGeoQueries(
  queries: GeoQueryInput[] | null | undefined,
  filter: GeoQueryFilterId,
): GeoQueryRowModel[] {
  return (queries ?? [])
    .filter((query) => geoQueryFilterTags(query).includes(filter))
    .map((query, index) => {
      const position = num(query?.position);
      const intentLabel = text(query?.classification?.intentLabel);
      const formatLabel = text(query?.classification?.formatLabel);
      const intent =
        intentLabel && formatLabel
          ? `${intentLabel} · ${formatLabel}`
          : (intentLabel ?? formatLabel ?? MISSING_VALUE);
      const level = text(query?.priority)?.toLowerCase() ?? "";
      const score = num(query?.geoScore);
      return {
        id: `query-${text(query?.query) ?? index}`,
        priorityTone: PRIORITY_TONE[level] ?? "neutral",
        query: text(query?.query) ?? MISSING_VALUE,
        star: query?.isAiStyle ? "✦ " : "",
        intent,
        intentTone: query?.isAiStyle ? "violet" : "neutral",
        momentum: momentumCaption(query?.momentum?.status, query?.momentum?.growthRate),
        momentumTone: MOMENTUM_TONE[query?.momentum?.status ?? ""] ?? "neutral",
        score: score === null ? MISSING_VALUE : String(Math.round(score)),
        scoreTone: scoreTone(score),
        bars: scoreBars(query?.geoScoreBreakdown),
        impressions: formatCount(query?.impressions),
        ctr: formatRate(query?.ctr, 1),
        position: position === null ? MISSING_VALUE : position.toFixed(1),
        positionTone:
          position === null ? "neutral" : position <= 3 ? "positive" : position <= 10 ? "info" : "warning",
        recommendation: text(query?.recommendation) ?? MISSING_VALUE,
      };
    });
}

/* ── Topic Authority (L2251-2286) ─────────────────────────────────── */

const GAP_LABEL: Record<string, { label: string; tone: GeoTone }> = {
  high: { label: "↑ High gap", tone: "negative" },
  medium: { label: "↗ Gap opp", tone: "warning" },
  low: { label: "", tone: "neutral" },
  none: { label: "", tone: "neutral" },
};

export function buildGeoTopics(topics: GeoTopicInput[] | null | undefined): GeoTopicModel[] {
  const rows = topics ?? [];
  // The design's coverage bar is the cluster's share of the strongest
  // cluster's demand (script L4078-4083: 24.3K → 100%, 12.8K → 53%).
  const maxImpressions = rows.reduce(
    (max, topic) => Math.max(max, num(topic?.impressions) ?? 0),
    0,
  );

  return rows.map((topic, index) => {
    const impressions = num(topic?.impressions);
    const coverage = text(topic?.coverageStrength) ?? MISSING_VALUE;
    const level = text(topic?.priority)?.toLowerCase() ?? "";
    const gapKey = text(topic?.coverageGap)?.toLowerCase() ?? "none";
    const gap = GAP_LABEL[gapKey] ?? { label: "", tone: "neutral" as GeoTone };
    const authority = text(topic?.authorityStrength);
    const score = num(topic?.geoScore);
    const position = num(topic?.avgPosition);
    const recommendation = topic?.recommendation ?? null;
    const queryCount = num(topic?.queryCount);

    return {
      id: `topic-${text(topic?.topic) ?? index}`,
      topic: text(topic?.topic) ?? MISSING_VALUE,
      coverage,
      coverageTone: COVERAGE_TONE[coverage] ?? "neutral",
      momentum: momentumCaption(topic?.momentum?.status, topic?.momentum?.growthRate),
      momentumTone: MOMENTUM_TONE[topic?.momentum?.status ?? ""] ?? "neutral",
      priority: level ? `${level.charAt(0).toUpperCase()}${level.slice(1)} priority` : "",
      priorityTone: PRIORITY_TONE[level] ?? "neutral",
      gap: gap.label,
      gapTone: gap.tone,
      queryCount:
        queryCount === null
          ? MISSING_VALUE
          : `${Math.round(queryCount)} ${Math.round(queryCount) === 1 ? "query" : "queries"}`,
      barWidth:
        impressions === null || maxImpressions <= 0
          ? "0%"
          : `${((impressions / maxImpressions) * 100).toFixed(0)}%`,
      chips: (topic?.queries ?? [])
        .map((query) => text(query))
        .filter((query): query is string => query !== null)
        .slice(0, 3),
      recommendationTitle: text(recommendation?.title) ?? MISSING_VALUE,
      recommendationImpact: text(recommendation?.impact) ?? MISSING_VALUE,
      recommendationEffort: text(recommendation?.effort)
        ? `${recommendation!.effort!.toLowerCase()} effort`
        : MISSING_VALUE,
      score: score === null ? MISSING_VALUE : `GEO ${Math.round(score)}`,
      scoreTone: scoreTone(score),
      impressions: formatCompact(topic?.impressions),
      clicks: formatCount(topic?.clicks),
      position: position === null ? MISSING_VALUE : position.toFixed(1),
      authority: authority ? `${authority.toLowerCase()} authority` : MISSING_VALUE,
    };
  });
}

/* ── Playbook (L2287-2305) ────────────────────────────────────────── */

export function buildGeoPlays(
  opportunities: GeoOpportunityInput[] | null | undefined,
): GeoPlayModel[] {
  return (opportunities ?? []).map((opportunity, index) => {
    const effort = text(opportunity?.effort);
    const impact = text(opportunity?.impact);
    const level = text(opportunity?.priority)?.toLowerCase() ?? "";
    return {
      id: `play-${index}`,
      ordinal: String(index + 1).padStart(2, "0"),
      title: text(opportunity?.title) ?? MISSING_VALUE,
      why: text(opportunity?.evidence)
        ? `Evidence: ${opportunity!.evidence!.trim()}`
        : MISSING_VALUE,
      outcome: text(opportunity?.recommendation)
        ? `Expected: ${opportunity!.recommendation!.trim()}`
        : MISSING_VALUE,
      chips: [
        { label: effort ? `${effort.toLowerCase()} effort` : MISSING_VALUE, tone: "neutral" },
        {
          label: impact ?? MISSING_VALUE,
          tone: level === "high" ? "positive" : level === "medium" ? "warning" : "neutral",
        },
      ],
    };
  });
}

/* ── Methodology (L2306-2318) ─────────────────────────────────────── */

/**
 * The design's four paragraphs, with the engine list read from the shipped
 * `AI_SOURCE_MAP` rather than transcribed, so the copy cannot drift from the
 * filter the GA4 reports actually send.
 */
export function buildGeoMethodology(): GeoMethodologyParagraphModel[] {
  const domains = AI_SOURCE_DOMAINS.slice(0, 5).join(", ");
  return [
    {
      id: "traffic",
      lead: "AI referral traffic",
      rest: ` is detected by matching GA4 session sources against known AI engine domains (${domains} and others).`,
    },
    {
      id: "scores",
      lead: "GEO scores",
      rest: " are component-based 0–100 composites of visibility, engagement, conversion and intent signals — deterministic (same inputs, same score) and internal estimates, not metrics reported by any AI engine.",
    },
    {
      id: "intent",
      lead: "Query intent classification",
      rest: " uses deterministic heuristics (phrase prefixes, comparison signals, long-tail length) on Search Console data.",
    },
    {
      id: "citation",
      lead: "Direct citation visibility",
      rest: " (whether an engine cites your page) is not measurable from public APIs; everything here is inference from your own traffic and search data. “Pages with GEO signals” is a proxy counted from sampled rows and capped at 50.",
    },
  ];
}

/* ── model ────────────────────────────────────────────────────────── */

export function buildGeoSubTabs(activeTab: GeoTabId): GeoSubTabModel[] {
  return GEO_TABS.map((tab) => ({
    id: tab.id,
    label: tab.label,
    active: tab.id === activeTab,
  }));
}

export function buildInsightsGeoExactModel(
  input: InsightsGeoAdapterInput,
): InsightsGeoExactModel {
  return {
    tabs: buildGeoSubTabs(input.activeTab),
    activeTab: input.activeTab,
    kpis: buildGeoKpis(input.overview, input.windowDays),
    intentBand: buildGeoIntentBand(input.overview),
    priorities: buildGeoPriorities(input.overview),
    highlights: buildGeoHighlights(input.overview),
    callouts: buildGeoCallouts(input.overview),
    sources: buildGeoSources(input.sources),
    pages: buildGeoPages(input.pages),
    filters: buildGeoFilters(input.queries, input.queryFilter),
    queries: buildGeoQueries(input.queries, input.queryFilter),
    queryDatasetSize: String((input.queries ?? []).length),
    topics: buildGeoTopics(input.topics),
    plays: buildGeoPlays(input.opportunities),
    methodology: buildGeoMethodology(),
  };
}
