/**
 * Pure mapping from the five GA4 analytics endpoints to the Insights →
 * Analytics view model. No React, no fetching.
 *
 * Formatting mirrors the design's own script literally: `(v*100).toFixed(1)`
 * for engagement/retention/funnel rates, `.toFixed(2)` for purchase CVR,
 * grouped integers inside tables, compact `K`/`M` on the stat cards, and the
 * heat ramp `rgba(14,159,110, 0.05 + 0.3·min(1, v/max))` (script line 3904).
 * Any fact the provider does not supply renders as the em-dash.
 */
import { formatCurrencySmart, MISSING_VALUE } from "@/lib/metric-format";
import type {
  AnalyticsCalloutModel,
  AnalyticsChannelRowModel,
  AnalyticsCohortMonthModel,
  AnalyticsCohortWeekModel,
  AnalyticsDemoChipModel,
  AnalyticsDemoRowModel,
  AnalyticsKpiModel,
  AnalyticsLandingRowModel,
  AnalyticsOpportunityModel,
  AnalyticsProductRowModel,
  AnalyticsSegmentCardModel,
  AnalyticsSignalModel,
  AnalyticsSubTabModel,
  AnalyticsTabId,
  InsightsAnalyticsExactModel,
} from "@/components/analytics/insights-analytics-exact-model";

/** Script line 3905 — order and captions verbatim. */
export const ANALYTICS_TABS: ReadonlyArray<{ id: AnalyticsTabId; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "products", label: "Products" },
  { id: "landing", label: "Landing pages" },
  { id: "audience", label: "Audience" },
  { id: "demo", label: "Demographics" },
  { id: "cohorts", label: "Cohorts" },
  { id: "opps", label: "Opportunities" },
];

/** GA4 dimension ids the demographics endpoint accepts, in the design's order. */
export const ANALYTICS_DEMO_DIMENSIONS = [
  "country",
  "region",
  "city",
  "language",
  "userAgeBracket",
  "userGender",
  "brandingInterest",
] as const;

export type AnalyticsDemoDimension = (typeof ANALYTICS_DEMO_DIMENSIONS)[number];

/** Chip captions (script line 3955) — sentence case, "Age group" not "Age Group". */
const DEMO_CHIP_LABEL: Record<AnalyticsDemoDimension, string> = {
  country: "Country",
  region: "Region",
  city: "City",
  language: "Language",
  userAgeBracket: "Age group",
  userGender: "Gender",
  brandingInterest: "Interests",
};

/** Table header captions (`DEMO[dim].col`) — "Interest", singular. */
const DEMO_COLUMN_LABEL: Record<AnalyticsDemoDimension, string> = {
  country: "Country",
  region: "Region",
  city: "City",
  language: "Language",
  userAgeBracket: "Age group",
  userGender: "Gender",
  brandingInterest: "Interest",
};

export const ANALYTICS_MAX_ROWS = 50;

export const ANALYTICS_PRODUCTS_NOTE_SUFFIX =
  "GA4 item-scoped events · higher rates are better, weak cells are where users leave.";
export const ANALYTICS_LANDING_NOTE_SUFFIX =
  "sorted by sessions · page fixes route to Launchpad as lander drafts.";

/* ── design heat ramp ─────────────────────────────────────────────── */

/**
 * `heat` from script line 3904. The ceilings are the design's own absolute
 * benchmarks, not a per-window maximum, so a shaded cell means the same thing
 * on every account.
 */
export function analyticsHeat(value: number | null | undefined, max: number): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "";
  const alpha = 0.05 + 0.3 * Math.min(1, Math.max(0, value) / max);
  return `rgba(14,159,110,${alpha.toFixed(3)})`;
}

export const HEAT_CEILING = {
  atcRate: 0.12,
  checkoutRate: 0.56,
  purchaseRate: 0.046,
  engagementRate: 0.8,
  purchaseCvr: 0.038,
} as const;

/** `retPill` from script line 3957 — four steps, background then foreground. */
export function retentionPill(rate: number | null | undefined): [string, string] {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) {
    return ["#f1f4f9", "#7a869e"];
  }
  if (rate >= 0.4) return ["#0E9F6E", "#ffffff"];
  if (rate >= 0.25) return ["#BFE5D6", "#065F46"];
  if (rate >= 0.15) return ["#F5E1B0", "#92400E"];
  return ["#F6C6D2", "#9F1239"];
}

/* ── formatters ───────────────────────────────────────────────────── */

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
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

export function formatMoney(value: unknown): string {
  const parsed = num(value);
  if (parsed === null) return MISSING_VALUE;
  return formatCurrencySmart(parsed, "$");
}

/* ── endpoint payload shapes (only what this screen reads) ─────────── */

export interface AnalyticsOverviewInput {
  kpis?: {
    sessions?: number;
    engagedSessions?: number;
    engagementRate?: number;
    purchases?: number;
    purchaseCvr?: number;
    revenue?: number;
  } | null;
  previousKpis?: {
    sessions?: number;
    engagedSessions?: number;
    engagementRate?: number;
    purchases?: number;
    purchaseCvr?: number;
    revenue?: number;
  } | null;
  newVsReturning?: {
    new?: { sessions?: number; purchaseCvr?: number; engagementRate?: number };
    returning?: { sessions?: number; purchaseCvr?: number; engagementRate?: number };
  } | null;
  insights?: Array<{ type?: string; text?: string }> | null;
}

export interface AnalyticsSegmentInput {
  sessions?: number;
  engagementRate?: number;
  purchaseCvr?: number;
}

export interface AnalyticsAudienceInput {
  segments?: Record<string, AnalyticsSegmentInput> | null;
  channels?: Array<{
    sourceMedium?: string;
    sessions?: number;
    engagementRate?: number;
    purchases?: number;
    purchaseCvr?: number;
    revenue?: number;
  }> | null;
}

export interface AnalyticsProductInput {
  name?: string;
  views?: number;
  addToCarts?: number;
  checkouts?: number;
  purchases?: number;
  revenue?: number;
  atcRate?: number;
  checkoutRate?: number;
  purchaseRate?: number;
}

export interface AnalyticsLandingInput {
  path?: string;
  sessions?: number;
  engagementRate?: number;
  purchases?: number;
  purchaseCvr?: number;
}

export interface AnalyticsDemographicsInput {
  rows?: Array<{
    value?: string;
    sessions?: number;
    engagementRate?: number;
    purchases?: number;
    purchaseCvr?: number;
    revenue?: number;
  }> | null;
  summary?: {
    topValue?: string;
    topValuePurchaseCvr?: number;
    avgPurchaseCvr?: number;
  } | null;
}

export interface AnalyticsCohortsInput {
  cohortWeeks?: Array<{
    week?: string;
    newSessions?: number;
    returningSessions?: number;
    newPurchases?: number;
    returningPurchases?: number;
    retentionRate?: number;
  }> | null;
  monthlyData?: Array<{
    month?: string;
    newUsers?: number;
    activeUsers?: number;
    sessions?: number;
    purchases?: number;
    revenue?: number;
    purchaseCvr?: number;
  }> | null;
}

export interface InsightsAnalyticsAdapterInput {
  activeTab: AnalyticsTabId;
  demoDimension: AnalyticsDemoDimension;
  /** Length of the selected window in days — the "vs prev Nd" suffix. */
  windowDays?: number | null;
  overview?: AnalyticsOverviewInput | null;
  audience?: AnalyticsAudienceInput | null;
  products?: AnalyticsProductInput[] | null;
  landingPages?: AnalyticsLandingInput[] | null;
  demographics?: AnalyticsDemographicsInput | null;
  cohorts?: AnalyticsCohortsInput | null;
}

/* ── KPI deltas ───────────────────────────────────────────────────── */

const MINUS = "−";

function ratioDelta(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null || previous === 0) return null;
  return ((current - previous) / previous) * 100;
}

function signed(value: number, digits: number, unit: string): string {
  const sign = value >= 0 ? "+" : MINUS;
  return `${sign}${Math.abs(value).toFixed(digits)}${unit}`;
}

function kpiDelta(
  current: number | null,
  previous: number | null,
  kind: "ratio" | "point",
  suffix: string,
): { delta: string; deltaTone: AnalyticsKpiModel["deltaTone"] } {
  if (current === null || previous === null) {
    return { delta: MISSING_VALUE, deltaTone: "neutral" };
  }
  if (kind === "point") {
    // A zero compare window has no baseline to move away from. The ratio
    // branch already refuses it; the point branch used to print a full-value
    // delta against nothing, so an all-zero previous period showed Engagement
    // rate and Purchase CVR "improving" by their entire current value.
    if (previous === 0) {
      return { delta: MISSING_VALUE, deltaTone: "neutral" };
    }
    const points = (current - previous) * 100;
    const rounded = Number(points.toFixed(2));
    return {
      delta: `${signed(points, Math.abs(points) < 1 ? 2 : 1, " pt")}${suffix}`,
      deltaTone: rounded > 0 ? "positive" : rounded < 0 ? "warning" : "neutral",
    };
  }
  const change = ratioDelta(current, previous);
  if (change === null) return { delta: MISSING_VALUE, deltaTone: "neutral" };
  const rounded = Number(change.toFixed(1));
  return {
    delta: `${signed(change, 1, "%")}${suffix}`,
    deltaTone: rounded > 0 ? "positive" : rounded < 0 ? "warning" : "neutral",
  };
}

function buildKpis(
  overview: AnalyticsOverviewInput | null | undefined,
  windowDays: number | null | undefined,
): AnalyticsKpiModel[] {
  const now = overview?.kpis ?? null;
  const prev = overview?.previousKpis ?? null;
  const prevSuffix =
    windowDays && Number.isFinite(windowDays) ? ` vs prev ${Math.round(windowDays)}d` : "";

  const definitions: Array<{
    key: string;
    label: string;
    value: string;
    current: number | null;
    previous: number | null;
    kind: "ratio" | "point";
    /** Only the first card carries the "vs prev Nd" tail (design line 3907). */
    withWindow?: boolean;
  }> = [
    {
      key: "sessions",
      label: "Sessions",
      value: formatCompact(now?.sessions),
      current: num(now?.sessions),
      previous: num(prev?.sessions),
      kind: "ratio",
      withWindow: true,
    },
    {
      key: "engagedSessions",
      label: "Engaged sessions",
      value: formatCompact(now?.engagedSessions),
      current: num(now?.engagedSessions),
      previous: num(prev?.engagedSessions),
      kind: "ratio",
    },
    {
      key: "engagementRate",
      label: "Engagement rate",
      value: formatRate(now?.engagementRate, 1),
      current: num(now?.engagementRate),
      previous: num(prev?.engagementRate),
      kind: "point",
    },
    {
      key: "purchases",
      label: "Purchases",
      value: formatCount(now?.purchases),
      current: num(now?.purchases),
      previous: num(prev?.purchases),
      kind: "ratio",
    },
    {
      key: "purchaseCvr",
      label: "Purchase CVR",
      value: formatRate(now?.purchaseCvr, 2),
      current: num(now?.purchaseCvr),
      previous: num(prev?.purchaseCvr),
      kind: "point",
    },
    {
      key: "revenue",
      label: "Revenue",
      value: formatMoney(now?.revenue),
      current: num(now?.revenue),
      previous: num(prev?.revenue),
      kind: "ratio",
    },
  ];

  return definitions.map((definition) => ({
    key: definition.key,
    label: definition.label,
    value: definition.value,
    ...kpiDelta(
      definition.current,
      definition.previous,
      definition.kind,
      definition.withWindow ? prevSuffix : "",
    ),
  }));
}

/* ── new vs returning ─────────────────────────────────────────────── */

/** The threshold the shipped surface already used for the "× better" pill. */
const BETTER_CVR_MULTIPLIER = 1.5;

function buildSegments(
  overview: AnalyticsOverviewInput | null | undefined,
  audience: AnalyticsAudienceInput | null | undefined,
): AnalyticsSegmentCardModel[] {
  // The audience endpoint carries engagement rate per segment; the overview
  // endpoint carries the same three facts for tabs that do not fetch it.
  const fromAudience = audience?.segments ?? null;
  const newSeg: AnalyticsSegmentInput | null =
    fromAudience?.new ?? overview?.newVsReturning?.new ?? null;
  const returningSeg: AnalyticsSegmentInput | null =
    fromAudience?.returning ?? overview?.newVsReturning?.returning ?? null;
  if (!newSeg && !returningSeg) return [];

  const newCvr = num(newSeg?.purchaseCvr);
  const returningCvr = num(returningSeg?.purchaseCvr);
  const multiplier =
    newCvr !== null && newCvr > 0 && returningCvr !== null ? returningCvr / newCvr : null;
  const better = multiplier !== null && multiplier >= BETTER_CVR_MULTIPLIER;

  return [
    {
      id: "new" as const,
      label: "New visitors",
      badge: null,
      sessions: formatCompact(newSeg?.sessions),
      engagement: formatRate(newSeg?.engagementRate, 1),
      cvr: formatRate(newSeg?.purchaseCvr, 2),
      cvrHighlighted: false,
    },
    {
      id: "returning" as const,
      label: "Returning visitors",
      badge: better ? `${multiplier!.toFixed(1)}× better CVR` : null,
      sessions: formatCompact(returningSeg?.sessions),
      engagement: formatRate(returningSeg?.engagementRate, 1),
      cvr: formatRate(returningSeg?.purchaseCvr, 2),
      cvrHighlighted: better,
    },
  ];
}

/* ── callouts ─────────────────────────────────────────────────────── */

function buildCallouts(
  overview: AnalyticsOverviewInput | null | undefined,
): AnalyticsCalloutModel[] {
  const insights = overview?.insights ?? [];
  return insights
    .filter((insight): insight is { type?: string; text: string } =>
      typeof insight?.text === "string" && insight.text.length > 0,
    )
    .map((insight, index) => {
      const tone =
        insight.type === "positive"
          ? ("positive" as const)
          : insight.type === "warning"
            ? ("warning" as const)
            : ("neutral" as const);
      const kind = tone === "positive" ? "Positive" : tone === "warning" ? "Warning" : "Info";
      return { id: `callout-${index}`, kind, tone, text: insight.text };
    });
}

/* ── tables ───────────────────────────────────────────────────────── */

function buildProducts(rows: AnalyticsProductInput[] | null | undefined): AnalyticsProductRowModel[] {
  return (rows ?? []).slice(0, ANALYTICS_MAX_ROWS).map((row, index) => ({
    id: `${row.name ?? "product"}-${index}`,
    name: row.name?.trim() || MISSING_VALUE,
    views: formatCount(row.views),
    addToCart: formatCount(row.addToCarts),
    checkout: formatCount(row.checkouts),
    purchases: formatCount(row.purchases),
    atcRate: formatRate(row.atcRate, 1),
    atcHeat: analyticsHeat(row.atcRate, HEAT_CEILING.atcRate),
    checkoutRate: formatRate(row.checkoutRate, 1),
    checkoutHeat: analyticsHeat(row.checkoutRate, HEAT_CEILING.checkoutRate),
    purchaseRate: formatRate(row.purchaseRate, 1),
    purchaseHeat: analyticsHeat(row.purchaseRate, HEAT_CEILING.purchaseRate),
    revenue: formatMoney(row.revenue),
  }));
}

/**
 * The design's Signal column, in the design's three words.
 *
 * Reproduces the design's own rows: engagement under 40 % or traffic with no
 * purchase reads "Leaking"; strong engagement *and* a converting rate reads
 * "Healthy"; everything else is "Watch".
 */
export function landingSignal(row: AnalyticsLandingInput): AnalyticsSignalModel | null {
  const sessions = num(row.sessions);
  if (sessions === null) return null;
  const purchases = num(row.purchases);
  const engagementRate = num(row.engagementRate);
  const purchaseCvr = num(row.purchaseCvr);

  if (sessions >= 50 && purchases === 0) {
    return { label: "Leaking", tone: "negative" };
  }
  if (engagementRate !== null && engagementRate > 0 && engagementRate < 0.4) {
    return { label: "Leaking", tone: "negative" };
  }
  if (
    purchaseCvr !== null &&
    purchaseCvr >= 0.02 &&
    engagementRate !== null &&
    engagementRate >= 0.6
  ) {
    return { label: "Healthy", tone: "positive" };
  }
  return { label: "Watch", tone: "warning" };
}

function buildLanding(rows: AnalyticsLandingInput[] | null | undefined): AnalyticsLandingRowModel[] {
  return (rows ?? []).slice(0, ANALYTICS_MAX_ROWS).map((row, index) => ({
    id: `${row.path ?? "page"}-${index}`,
    page: row.path?.trim() || MISSING_VALUE,
    sessions: formatCount(row.sessions),
    engagement: formatRate(row.engagementRate, 0),
    purchases: formatCount(row.purchases),
    cvr: formatRate(row.purchaseCvr, 2),
    signal: landingSignal(row),
  }));
}

function buildChannels(
  audience: AnalyticsAudienceInput | null | undefined,
): AnalyticsChannelRowModel[] {
  return (audience?.channels ?? []).map((row, index) => ({
    id: `${row.sourceMedium ?? "channel"}-${index}`,
    sourceMedium: row.sourceMedium?.trim() || MISSING_VALUE,
    sessions: formatCount(row.sessions),
    engagementRate: formatRate(row.engagementRate, 1),
    engagementHeat: analyticsHeat(row.engagementRate, HEAT_CEILING.engagementRate),
    purchases: formatCount(row.purchases),
    cvr: formatRate(row.purchaseCvr, 2),
    cvrHeat: analyticsHeat(row.purchaseCvr, HEAT_CEILING.purchaseCvr),
    revenue: formatMoney(row.revenue),
  }));
}

function buildDemoChips(active: AnalyticsDemoDimension): AnalyticsDemoChipModel[] {
  return ANALYTICS_DEMO_DIMENSIONS.map((dimension) => ({
    id: dimension,
    label: DEMO_CHIP_LABEL[dimension],
    active: dimension === active,
  }));
}

function buildDemoSummary(
  dimension: AnalyticsDemoDimension,
  demographics: AnalyticsDemographicsInput | null | undefined,
): string | null {
  const summary = demographics?.summary;
  if (!summary) return null;
  const topValue = summary.topValue?.trim();
  const topCvr = num(summary.topValuePurchaseCvr);
  if (!topValue || topCvr === null || topCvr <= 0) return null;
  const avg = num(summary.avgPurchaseCvr);
  const avgClause = avg !== null && avg > 0 ? ` (site avg ${formatRate(avg, 2)})` : "";
  return `${DEMO_COLUMN_LABEL[dimension]} “${topValue}” has the highest purchase rate at ${formatRate(topCvr, 2)}${avgClause}.`;
}

function buildDemoRows(
  demographics: AnalyticsDemographicsInput | null | undefined,
): AnalyticsDemoRowModel[] {
  return (demographics?.rows ?? []).map((row, index) => ({
    id: `${row.value ?? "row"}-${index}`,
    value: row.value?.trim() || MISSING_VALUE,
    sessions: formatCount(row.sessions),
    engagementRate: formatRate(row.engagementRate, 1),
    engagementHeat: analyticsHeat(row.engagementRate, HEAT_CEILING.engagementRate),
    purchases: formatCount(row.purchases),
    cvr: formatRate(row.purchaseCvr, 2),
    cvrHeat: analyticsHeat(row.purchaseCvr, HEAT_CEILING.purchaseCvr),
    revenue: formatMoney(row.revenue),
  }));
}

const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

export function formatCohortWeek(week: string | undefined): string {
  if (!week) return MISSING_VALUE;
  if (week.length === 6) return `W${week.slice(4)} '${week.slice(2, 4)}`;
  return week;
}

export function formatCohortMonth(month: string | undefined): string {
  if (!month) return MISSING_VALUE;
  if (month.length === 6) {
    const index = Number.parseInt(month.slice(4), 10);
    const name = MONTH_NAMES[index - 1] ?? month.slice(4);
    return `${name} '${month.slice(2, 4)}`;
  }
  return month;
}

const COHORT_WEEK_LIMIT = 12;

function buildCohortWeeks(
  cohorts: AnalyticsCohortsInput | null | undefined,
): AnalyticsCohortWeekModel[] {
  return (cohorts?.cohortWeeks ?? []).slice(-COHORT_WEEK_LIMIT).map((row, index) => {
    const [bg, fg] = retentionPill(row.retentionRate);
    return {
      id: `${row.week ?? "week"}-${index}`,
      week: formatCohortWeek(row.week),
      newSessions: formatCount(row.newSessions),
      returningSessions: formatCount(row.returningSessions),
      retention: formatRate(row.retentionRate, 1),
      retentionBg: bg,
      retentionFg: fg,
      newPurchases: formatCount(row.newPurchases),
      returningPurchases: formatCount(row.returningPurchases),
    };
  });
}

function buildCohortMonths(
  cohorts: AnalyticsCohortsInput | null | undefined,
): AnalyticsCohortMonthModel[] {
  return (cohorts?.monthlyData ?? []).map((row, index) => ({
    id: `${row.month ?? "month"}-${index}`,
    month: formatCohortMonth(row.month),
    newUsers: formatCompact(row.newUsers),
    activeUsers: formatCompact(row.activeUsers),
    sessions: formatCompact(row.sessions),
    purchases: formatCount(row.purchases),
    cvr: formatRate(row.purchaseCvr, 2),
    revenue: formatMoney(row.revenue),
  }));
}

/* ── opportunities ────────────────────────────────────────────────── */

const OPPORTUNITY_LIMIT = 6;

/**
 * Threshold reads over this window's own numbers — no opinion, no model call.
 * Ported unchanged from the shipped `deriveOpportunities`; only the presented
 * chip vocabulary is the design's.
 */
export function buildOpportunities(input: {
  products?: AnalyticsProductInput[] | null;
  landingPages?: AnalyticsLandingInput[] | null;
  audience?: AnalyticsAudienceInput | null;
  overview?: AnalyticsOverviewInput | null;
}): AnalyticsOpportunityModel[] {
  const out: AnalyticsOpportunityModel[] = [];

  const segments = input.audience?.segments ?? null;
  const newSeg = segments?.new ?? input.overview?.newVsReturning?.new ?? null;
  const returningSeg = segments?.returning ?? input.overview?.newVsReturning?.returning ?? null;
  const newCvr = num(newSeg?.purchaseCvr);
  const returningCvr = num(returningSeg?.purchaseCvr);
  if (newCvr !== null && newCvr > 0 && returningCvr !== null && returningCvr > 0) {
    const multiplier = returningCvr / newCvr;
    if (multiplier >= 2) {
      out.push({
        id: "returning-under-targeted",
        kind: "Opportunity",
        tone: "info",
        title: "Returning visitors are under-targeted",
        description: `Returning users convert ${multiplier.toFixed(1)}× better (${formatRate(returningCvr, 2)} vs ${formatRate(newCvr, 2)}). Shift budget toward retargeting and win-back flows.`,
      });
    }
  }

  const pages = input.landingPages ?? [];
  const highTrafficWeak = pages
    .filter((page) => (num(page.sessions) ?? 0) > 200 && (num(page.engagementRate) ?? 1) < 0.3)
    .sort((left, right) => (num(right.sessions) ?? 0) - (num(left.sessions) ?? 0))[0];
  if (highTrafficWeak) {
    out.push({
      id: `weak-engagement-${highTrafficWeak.path}`,
      kind: "Warning",
      tone: "warning",
      title: `High traffic, weak engagement: ${highTrafficWeak.path}`,
      description: `${formatCount(highTrafficWeak.sessions)} sessions but only ${formatRate(highTrafficWeak.engagementRate, 0)} engagement. Review ad targeting and landing page relevance before adding spend.`,
    });
  }

  const strongPage = [...pages]
    .filter((page) => (num(page.sessions) ?? 0) > 30 && (num(page.purchaseCvr) ?? 0) > 0.03)
    .sort((left, right) => (num(right.purchaseCvr) ?? 0) - (num(left.purchaseCvr) ?? 0))[0];
  if (strongPage) {
    out.push({
      id: `strong-page-${strongPage.path}`,
      kind: "Strong",
      tone: "positive",
      title: `Top converter deserves more budget: ${strongPage.path}`,
      description: `${formatRate(strongPage.purchaseCvr, 2)} purchase CVR on ${formatCount(strongPage.sessions)} sessions — allocate more paid traffic to this page.`,
    });
  }

  const products = input.products ?? [];
  const highViewsLowAtc = products
    .filter((product) => (num(product.views) ?? 0) > 100 && (num(product.atcRate) ?? 1) < 0.03)
    .sort((left, right) => (num(right.views) ?? 0) - (num(left.views) ?? 0))[0];
  if (highViewsLowAtc) {
    out.push({
      id: `atc-dropoff-${highViewsLowAtc.name}`,
      kind: "Warning",
      tone: "warning",
      title: `Funnel drop-off at add-to-cart: “${highViewsLowAtc.name}”`,
      description: `${formatCount(highViewsLowAtc.views)} views but a ${formatRate(highViewsLowAtc.atcRate, 1)} add-to-cart rate. Improve the PDP CTA and pricing clarity, or merchandise it as a bundle.`,
    });
  }

  const checkoutDropOff = products
    .filter(
      (product) => (num(product.addToCarts) ?? 0) > 20 && (num(product.checkoutRate) ?? 1) < 0.15,
    )
    .sort((left, right) => (num(right.addToCarts) ?? 0) - (num(left.addToCarts) ?? 0))[0];
  if (checkoutDropOff) {
    out.push({
      id: `checkout-dropoff-${checkoutDropOff.name}`,
      kind: "Warning",
      tone: "warning",
      title: `Cart-to-checkout drop-off: “${checkoutDropOff.name}”`,
      description: `${formatCount(checkoutDropOff.addToCarts)} carts but a ${formatRate(checkoutDropOff.checkoutRate, 0)} checkout rate. Cart abandonment points at shipping-cost surprise — surface it earlier.`,
    });
  }

  const lowIntent = (input.audience?.channels ?? [])
    .filter(
      (channel) =>
        (num(channel.sessions) ?? 0) > 100 &&
        (num(channel.engagementRate) ?? 1) < 0.25 &&
        num(channel.purchaseCvr) === 0,
    )
    .sort((left, right) => (num(right.sessions) ?? 0) - (num(left.sessions) ?? 0))[0];
  if (lowIntent) {
    out.push({
      id: `low-intent-${lowIntent.sourceMedium}`,
      kind: "Warning",
      tone: "warning",
      title: `Low-intent traffic source: ${lowIntent.sourceMedium}`,
      description: `${formatCount(lowIntent.sessions)} sessions with ${formatRate(lowIntent.engagementRate, 0)} engagement and zero purchases. Pause or rebuild this traffic source.`,
    });
  }

  return out.slice(0, OPPORTUNITY_LIMIT);
}

/* ── the adapter ──────────────────────────────────────────────────── */

export function buildInsightsAnalyticsExactModel(
  input: InsightsAnalyticsAdapterInput,
): InsightsAnalyticsExactModel {
  const tabs: AnalyticsSubTabModel[] = ANALYTICS_TABS.map((tab) => ({
    id: tab.id,
    label: tab.label,
    active: tab.id === input.activeTab,
  }));

  const products = buildProducts(input.products);
  const landing = buildLanding(input.landingPages);

  return {
    tabs,
    activeTab: input.activeTab,
    kpis: buildKpis(input.overview, input.windowDays),
    segments: buildSegments(input.overview, input.audience),
    callouts: buildCallouts(input.overview),
    products,
    productsNote: `Showing ${products.length} of up to ${ANALYTICS_MAX_ROWS} rows · ${ANALYTICS_PRODUCTS_NOTE_SUFFIX}`,
    landing,
    landingNote: `Showing ${landing.length} of up to ${ANALYTICS_MAX_ROWS} rows · ${ANALYTICS_LANDING_NOTE_SUFFIX}`,
    channels: buildChannels(input.audience),
    demoChips: buildDemoChips(input.demoDimension),
    demoColumn: DEMO_COLUMN_LABEL[input.demoDimension],
    demoSummary: buildDemoSummary(input.demoDimension, input.demographics),
    demoRows: buildDemoRows(input.demographics),
    cohortWeeks: buildCohortWeeks(input.cohorts),
    cohortMonths: buildCohortMonths(input.cohorts),
    opportunities: buildOpportunities({
      products: input.products,
      landingPages: input.landingPages,
      audience: input.audience,
      overview: input.overview,
    }),
  };
}
