/**
 * Pure mapping from the Search Console endpoints to the Insights → SEO
 * Intelligence view model. No React, no fetching.
 *
 * `/api/seo/overview` supplies the KPI band, the movers and the two leader
 * tables; `/api/seo/ai-analysis` supplies the Monthly AI card and the Actions
 * groups; `/api/seo/findings` supplies the Technical findings tab. Any fact a
 * provider does not supply renders as the em-dash — the design's seed numbers
 * (48.2K clicks, 1.94M impressions, the fake query list) are never emitted.
 */
import { MISSING_VALUE } from "@/lib/metric-format";
import type {
  InsightsSeoExactModel,
  SeoActionGroupModel,
  SeoActionItemModel,
  SeoExcludedRowModel,
  SeoFindingModel,
  SeoKpiModel,
  SeoMonthlyModel,
  SeoMoverCardModel,
  SeoMoverRowModel,
  SeoNumberedItemModel,
  SeoPageRowModel,
  SeoQueryRowModel,
  SeoSubTabModel,
  SeoTabId,
  SeoTechCardModel,
  SeoTechnicalModel,
  SeoTone,
} from "@/components/seo/insights-seo-exact-model";

/** Script line 3968 — order and captions verbatim. */
export const SEO_TABS: ReadonlyArray<{ id: SeoTabId; label: string }> = [
  { id: "ai", label: "Monthly AI" },
  { id: "traffic", label: "Traffic changes" },
  { id: "queries", label: "Queries" },
  { id: "pages", label: "Pages" },
  { id: "actions", label: "Actions" },
  { id: "technical", label: "Technical findings" },
];

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

/** The design's KPI values are compact (`48.2K`, `1.94M`) — script L3970-3971. */
export function formatCompact(value: unknown): string {
  const parsed = num(value);
  if (parsed === null) return MISSING_VALUE;
  const abs = Math.abs(parsed);
  if (abs >= 1_000_000) return `${(parsed / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(parsed / 1_000).toFixed(1)}K`;
  return Math.round(parsed).toLocaleString("en-US");
}

export function formatRate(value: unknown, digits: 1 | 2): string {
  const parsed = num(value);
  if (parsed === null) return MISSING_VALUE;
  return `${(parsed * 100).toFixed(digits)}%`;
}

export function formatPosition(value: unknown): string {
  const parsed = num(value);
  if (parsed === null) return MISSING_VALUE;
  return parsed.toFixed(1);
}

function signedPercent(value: number): string {
  const sign = value >= 0 ? "+" : MINUS;
  return `${sign}${Math.abs(value * 100).toFixed(1)}%`;
}

function signedCount(value: number): string {
  const sign = value >= 0 ? "+" : MINUS;
  return `${sign}${Math.abs(Math.round(value)).toLocaleString("en-US")}`;
}

/* ── endpoint payload shapes (only what this screen reads) ─────────── */

export interface SeoMetricSummaryInput {
  current?: number;
  previous?: number;
  delta?: number;
  deltaPercent?: number | null;
}

export interface SeoEntityChangeInput {
  key?: string;
  label?: string;
  clicks?: number;
  clicksDelta?: number;
  impressions?: number;
  ctr?: number;
  position?: number;
  /** `position - previousPosition`: a POSITIVE value means the row got worse. */
  positionDelta?: number;
}

export interface SeoOverviewInput {
  summary?: {
    clicks?: SeoMetricSummaryInput;
    impressions?: SeoMetricSummaryInput;
    ctr?: SeoMetricSummaryInput;
    position?: SeoMetricSummaryInput;
  } | null;
  leaders?: {
    queries?: SeoEntityChangeInput[];
    pages?: SeoEntityChangeInput[];
  } | null;
  movers?: {
    decliningQueries?: SeoEntityChangeInput[];
    decliningPages?: SeoEntityChangeInput[];
    improvingQueries?: SeoEntityChangeInput[];
    improvingPages?: SeoEntityChangeInput[];
  } | null;
}

export interface SeoMonthlyInput {
  monthLabel?: string;
  monthKey?: string;
  generatedAt?: string | null;
  periodStart?: string | null;
  periodEnd?: string | null;
  status?: "available" | "not_generated" | "failed";
  overviewData?: {
    dataLayers?: Array<{ title?: string }>;
  } | null;
  analysis?: {
    summary?: string;
    rootCauses?: Array<{ title?: string; detail?: string }>;
    priorities?: Array<{
      title?: string;
      detail?: string;
      impact?: "high" | "medium" | "low";
      effort?: "low" | "medium" | "high";
      owner?: string;
    }>;
    actionPlan?: Array<{ window?: string; focus?: string; tasks?: string[] }>;
    structured?: {
      executiveSummary?: { topFindings?: string[] } | null;
    } | null;
  } | null;
}

export interface SeoFindingsInput {
  meta?: {
    auditedPageCount?: number;
    urlInspection?: {
      attempted?: number;
      succeeded?: number;
    } | null;
  } | null;
  summary?: { critical?: number; warning?: number; opportunity?: number } | null;
  confirmedExcludedPages?: Array<{
    path?: string;
    url?: string;
    coverageState?: string | null;
    indexingState?: string | null;
    robotsTxtState?: string | null;
    inspectionVerdict?: string | null;
  }>;
  findings?: Array<{
    id?: string;
    severity?: "critical" | "warning" | "opportunity";
    title?: string;
    description?: string;
    affectedPages?: Array<{ path?: string }>;
  }>;
}

export interface InsightsSeoAdapterInput {
  activeTab: SeoTabId;
  overview?: SeoOverviewInput | null;
  monthly?: SeoMonthlyInput | null;
  findings?: SeoFindingsInput | null;
}

/* ── KPI band (L1952-1963) ────────────────────────────────────────── */

function ratioDeltaPill(summary: SeoMetricSummaryInput | undefined): {
  delta: string;
  deltaTone: SeoTone;
} {
  const percent = summary?.deltaPercent;
  if (percent === null || percent === undefined || !Number.isFinite(percent)) {
    return { delta: MISSING_VALUE, deltaTone: "neutral" };
  }
  const rounded = Number((percent * 100).toFixed(1));
  return {
    delta: signedPercent(percent),
    deltaTone: rounded > 0 ? "positive" : rounded < 0 ? "negative" : "neutral",
  };
}

/**
 * Average position is inverted: a smaller number is a better rank, and the
 * design prints the improvement ("↑ 1.1 better"), not the raw delta.
 */
function positionDeltaPill(summary: SeoMetricSummaryInput | undefined): {
  delta: string;
  deltaTone: SeoTone;
} {
  const current = num(summary?.current);
  const previous = num(summary?.previous);
  if (current === null || previous === null || previous === 0) {
    return { delta: MISSING_VALUE, deltaTone: "neutral" };
  }
  const improvement = Number((previous - current).toFixed(1));
  if (improvement === 0) return { delta: "= held", deltaTone: "neutral" };
  return {
    delta:
      improvement > 0
        ? `↑ ${improvement.toFixed(1)} better`
        : `↓ ${Math.abs(improvement).toFixed(1)} worse`,
    deltaTone: improvement > 0 ? "positive" : "negative",
  };
}

function previousLine(value: string): string {
  return value === MISSING_VALUE ? MISSING_VALUE : `prev ${value}`;
}

export function buildSeoKpis(overview: SeoOverviewInput | null | undefined): SeoKpiModel[] {
  const summary = overview?.summary ?? null;
  const clicks = summary?.clicks;
  const impressions = summary?.impressions;
  const ctr = summary?.ctr;
  const position = summary?.position;

  return [
    {
      key: "clicks",
      label: "Organic clicks",
      value: formatCompact(clicks?.current),
      ...ratioDeltaPill(clicks),
      previous: previousLine(formatCompact(clicks?.previous)),
    },
    {
      key: "impressions",
      label: "Impressions",
      value: formatCompact(impressions?.current),
      ...ratioDeltaPill(impressions),
      previous: previousLine(formatCompact(impressions?.previous)),
    },
    {
      key: "ctr",
      label: "CTR",
      value: formatRate(ctr?.current, 2),
      ...ratioDeltaPill(ctr),
      previous: previousLine(formatRate(ctr?.previous, 2)),
    },
    {
      key: "position",
      label: "Avg position",
      value: formatPosition(position?.current),
      ...positionDeltaPill(position),
      previous: previousLine(formatPosition(position?.previous)),
    },
  ];
}

/* ── Monthly AI (L1969-2009) ──────────────────────────────────────── */

const MONTHLY_STATUS: Record<string, { label: string; tone: SeoTone }> = {
  available: { label: "available", tone: "positive" },
  not_generated: { label: "not generated", tone: "neutral" },
  failed: { label: "failed", tone: "negative" },
};

function formatStamp(value: string | null | undefined): string | null {
  const raw = text(value);
  if (!raw) return null;
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) return raw;
  return new Date(parsed).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function formatDay(value: string | null | undefined): string | null {
  const raw = text(value);
  if (!raw) return null;
  const parsed = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00Z` : raw);
  if (!Number.isFinite(parsed)) return raw;
  return new Date(parsed).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/**
 * The design's "next window Sep 1" is the first day of the month after the
 * analysis month — a deterministic read of `monthKey`, not a seeded date.
 */
function nextWindowLabel(monthKey: string | null): string | null {
  if (!monthKey || !/^\d{4}-\d{2}$/.test(monthKey)) return null;
  const year = Number(monthKey.slice(0, 4));
  const month = Number(monthKey.slice(5, 7));
  if (!Number.isFinite(year) || !Number.isFinite(month)) return null;
  const next = new Date(Date.UTC(month === 12 ? year + 1 : year, month % 12, 1));
  return next.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export function buildSeoMonthly(monthly: SeoMonthlyInput | null | undefined): SeoMonthlyModel {
  const status = MONTHLY_STATUS[monthly?.status ?? ""] ?? {
    label: MISSING_VALUE,
    tone: "neutral" as SeoTone,
  };
  const monthLabel = text(monthly?.monthLabel);
  const generated = formatStamp(monthly?.generatedAt);
  const windowStart = formatDay(monthly?.periodStart);
  const windowEnd = formatDay(monthly?.periodEnd);
  const metaParts = [
    generated ? `generated ${generated}` : null,
    windowStart && windowEnd ? `window ${windowStart} – ${windowEnd}` : null,
    "saved as the team’s planning artifact",
  ].filter((part): part is string => part !== null);

  const nextWindow = nextWindowLabel(text(monthly?.monthKey));

  const analysis = monthly?.analysis ?? null;
  const reads = (monthly?.overviewData?.dataLayers ?? [])
    .map((layer) => text(layer?.title))
    .filter((value): value is string => value !== null);

  const whatChanged = (analysis?.structured?.executiveSummary?.topFindings ?? [])
    .map((finding) => text(finding))
    .filter((value): value is string => value !== null);

  const likelyCauses = (analysis?.rootCauses ?? [])
    .map((cause) => {
      const title = text(cause?.title);
      const detail = text(cause?.detail);
      if (title && detail) return `${title} — ${detail}`;
      return title ?? detail;
    })
    .filter((value): value is string => value !== null);

  // The design's plan is a flat numbered list of single tasks with their week
  // in parentheses; the model returns tasks grouped under a window, so the
  // groups are flattened and each task keeps its own window.
  const plan: SeoNumberedItemModel[] = [];
  for (const step of analysis?.actionPlan ?? []) {
    const windowLabel = text(step?.window);
    const tasks = (step?.tasks ?? [])
      .map((task) => text(task))
      .filter((value): value is string => value !== null);
    const focus = text(step?.focus);
    const lines = tasks.length > 0 ? tasks : focus ? [focus] : [];
    for (const line of lines) {
      plan.push({
        id: `plan-${plan.length}`,
        ordinal: String(plan.length + 1).padStart(2, "0"),
        text: windowLabel ? `${line} (${windowLabel})` : line,
      });
    }
  }

  return {
    head: {
      title: monthLabel
        ? `Monthly AI analysis — ${monthLabel}`
        : `Monthly AI analysis — ${MISSING_VALUE}`,
      statusLabel: status.label,
      statusTone: status.tone,
      meta: metaParts.join(" · "),
      cadence: nextWindow
        ? `One analysis per month · next window ${nextWindow}`
        : "One analysis per month",
    },
    reads,
    summary: text(analysis?.summary) ?? MISSING_VALUE,
    whatChanged,
    likelyCauses,
    plan,
  };
}

/* ── Traffic changes (L2010-2026) ─────────────────────────────────── */

function moverRows(rows: SeoEntityChangeInput[] | undefined, prefix: string): SeoMoverRowModel[] {
  return (rows ?? []).map((row, index) => {
    const delta = num(row?.clicksDelta);
    const rounded = delta === null ? null : Math.round(delta);
    return {
      id: `${prefix}-${text(row?.key) ?? index}`,
      label: text(row?.label) ?? MISSING_VALUE,
      current: formatCount(row?.clicks),
      delta: rounded === null ? MISSING_VALUE : signedCount(rounded),
      deltaTone:
        rounded === null
          ? "neutral"
          : rounded > 0
            ? "positive"
            : rounded < 0
              ? "negative"
              : "neutral",
    };
  });
}

export function buildSeoMovers(
  overview: SeoOverviewInput | null | undefined,
): SeoMoverCardModel[] {
  const movers = overview?.movers ?? null;
  return [
    {
      id: "declining-queries",
      title: "Biggest declining queries",
      rows: moverRows(movers?.decliningQueries, "dq"),
    },
    {
      id: "declining-pages",
      title: "Biggest declining pages",
      rows: moverRows(movers?.decliningPages, "dp"),
    },
    {
      id: "improving-queries",
      title: "Improving queries",
      rows: moverRows(movers?.improvingQueries, "iq"),
    },
    {
      id: "improving-pages",
      title: "Improving pages",
      rows: moverRows(movers?.improvingPages, "ip"),
    },
  ];
}

/* ── Query / Page leaders (L2027-2065) ────────────────────────────── */

export function buildSeoQueries(
  overview: SeoOverviewInput | null | undefined,
): SeoQueryRowModel[] {
  return (overview?.leaders?.queries ?? []).map((row, index) => {
    // `positionDelta` is `position - previousPosition`, so a NEGATIVE value is
    // an improvement. The design's "Δ pos" chip prints the improvement.
    const raw = num(row?.positionDelta);
    const improvement = raw === null ? null : Number((-raw).toFixed(1));
    return {
      id: `q-${text(row?.key) ?? index}`,
      query: text(row?.label) ?? MISSING_VALUE,
      clicks: formatCount(row?.clicks),
      impressions: formatCount(row?.impressions),
      ctr: formatRate(row?.ctr, 1),
      position: formatPosition(row?.position),
      positionDelta:
        improvement === null
          ? MISSING_VALUE
          : improvement === 0
            ? "="
            : `${improvement > 0 ? "+" : MINUS}${Math.abs(improvement).toFixed(1)}`,
      positionDeltaTone:
        improvement === null || improvement === 0
          ? "neutral"
          : improvement > 0
            ? "positive"
            : "negative",
    };
  });
}

export function buildSeoPages(overview: SeoOverviewInput | null | undefined): SeoPageRowModel[] {
  return (overview?.leaders?.pages ?? []).map((row, index) => ({
    id: `p-${text(row?.key) ?? index}`,
    page: text(row?.label) ?? MISSING_VALUE,
    clicks: formatCount(row?.clicks),
    impressions: formatCount(row?.impressions),
    ctr: formatRate(row?.ctr, 1),
    position: formatPosition(row?.position),
  }));
}

/* ── Actions (L2066-2084) ─────────────────────────────────────────── */

/**
 * The design's three tone groups are a sequencing of the monthly model's
 * priorities: what to fix first, what to schedule, what to defer (L2087).
 * A priority is a quick win when it is cheap, strategic when it is expensive
 * but high impact, and supporting otherwise. Deterministic, no re-ranking.
 */
export function seoActionGroupFor(item: {
  impact?: string;
  effort?: string;
}): "quick" | "strategic" | "supporting" {
  if (item.effort === "low") return "quick";
  if (item.impact === "high") return "strategic";
  return "supporting";
}

const ACTION_GROUP_META: Array<{
  id: "quick" | "strategic" | "supporting";
  toneLabel: string;
  tone: SeoTone;
}> = [
  { id: "quick", toneLabel: "Quick wins", tone: "positive" },
  { id: "strategic", toneLabel: "Strategic", tone: "info" },
  { id: "supporting", toneLabel: "Supporting", tone: "neutral" },
];

export function buildSeoActionGroups(
  monthly: SeoMonthlyInput | null | undefined,
): SeoActionGroupModel[] {
  const priorities = monthly?.analysis?.priorities ?? [];
  const buckets = new Map<string, SeoActionItemModel[]>();
  priorities.forEach((priority, index) => {
    const bucket = seoActionGroupFor({
      impact: priority?.impact,
      effort: priority?.effort,
    });
    const items = buckets.get(bucket) ?? [];
    const effortParts = [
      priority?.effort ? `${priority.effort} effort` : null,
      text(priority?.owner),
    ].filter((part): part is string => part !== null);
    items.push({
      id: `action-${index}`,
      title: text(priority?.title) ?? MISSING_VALUE,
      why: text(priority?.detail) ?? MISSING_VALUE,
      impact: priority?.impact ? `${priority.impact} impact` : MISSING_VALUE,
      effort: effortParts.length > 0 ? effortParts.join(" · ") : MISSING_VALUE,
    });
    buckets.set(bucket, items);
  });

  return ACTION_GROUP_META.filter((meta) => (buckets.get(meta.id)?.length ?? 0) > 0).map(
    (meta) => ({
      id: meta.id,
      tone: meta.tone,
      toneLabel: meta.toneLabel,
      items: buckets.get(meta.id) ?? [],
    }),
  );
}

/* ── Technical findings (L2085-2118) ──────────────────────────────── */

const FINDING_SEVERITY: Record<string, { label: string; tone: SeoTone }> = {
  critical: { label: "Critical", tone: "negative" },
  warning: { label: "Warning", tone: "warning" },
  opportunity: { label: "Opportunity", tone: "positive" },
};

/**
 * "Passed" is the count of audited pages that carry no finding at all. The
 * design derives the same number (148 − 5 − 12 = 131); here it is derived from
 * the real distinct affected paths, because the severity counts are counts of
 * findings and not of pages.
 */
export function seoPassedPageCount(findings: SeoFindingsInput | null | undefined): number | null {
  const audited = num(findings?.meta?.auditedPageCount);
  if (audited === null) return null;
  const affected = new Set<string>();
  for (const finding of findings?.findings ?? []) {
    for (const page of finding?.affectedPages ?? []) {
      const path = text(page?.path);
      if (path) affected.add(path);
    }
  }
  return Math.max(0, Math.round(audited) - affected.size);
}

/** Blocked or noindexed reads harder than "crawled, not indexed". */
export function seoExclusionTone(reason: string): SeoTone {
  const lower = reason.toLowerCase();
  if (
    lower.includes("noindex") ||
    lower.includes("blocked") ||
    lower.includes("disallow") ||
    lower.includes("excluded by")
  ) {
    return "negative";
  }
  return "warning";
}

export function buildSeoTechnical(
  findings: SeoFindingsInput | null | undefined,
): SeoTechnicalModel {
  const summary = findings?.summary ?? null;
  const passed = seoPassedPageCount(findings);
  const cards: SeoTechCardModel[] = [
    {
      key: "audited",
      label: "Pages audited",
      value: formatCount(findings?.meta?.auditedPageCount),
      tone: "neutral",
    },
    {
      key: "critical",
      label: "Critical",
      value: formatCount(summary?.critical),
      tone: "negative",
    },
    {
      key: "warnings",
      label: "Warnings",
      value: formatCount(summary?.warning),
      tone: "warning",
    },
    {
      key: "passed",
      label: "Passed",
      value: passed === null ? MISSING_VALUE : formatCount(passed),
      tone: "positive",
    },
  ];

  const inspection = findings?.meta?.urlInspection ?? null;
  const succeeded = num(inspection?.succeeded);
  const attempted = num(inspection?.attempted);
  const inspectionHint =
    succeeded === null || attempted === null
      ? "URL Inspection · not requested"
      : `URL Inspection · ${Math.round(succeeded)} of ${Math.round(attempted)}`;

  const excluded: SeoExcludedRowModel[] = (findings?.confirmedExcludedPages ?? []).map(
    (page, index) => {
      const reason =
        text(page?.coverageState) ??
        text(page?.indexingState) ??
        text(page?.inspectionVerdict) ??
        MISSING_VALUE;
      return {
        id: `excluded-${text(page?.path) ?? index}`,
        url: text(page?.path) ?? text(page?.url) ?? MISSING_VALUE,
        reason,
        tone: reason === MISSING_VALUE ? "neutral" : seoExclusionTone(reason),
      };
    },
  );

  const findingRows: SeoFindingModel[] = (findings?.findings ?? []).map((finding, index) => {
    const severity = FINDING_SEVERITY[finding?.severity ?? ""] ?? {
      label: MISSING_VALUE,
      tone: "neutral" as SeoTone,
    };
    return {
      id: text(finding?.id) ?? `finding-${index}`,
      severity: severity.label,
      tone: severity.tone,
      title: text(finding?.title) ?? MISSING_VALUE,
      detail: text(finding?.description) ?? MISSING_VALUE,
    };
  });

  return { cards, inspectionHint, excluded, findings: findingRows };
}

/* ── model ────────────────────────────────────────────────────────── */

export function buildSeoSubTabs(activeTab: SeoTabId): SeoSubTabModel[] {
  return SEO_TABS.map((tab) => ({
    id: tab.id,
    label: tab.label,
    active: tab.id === activeTab,
  }));
}

export function buildInsightsSeoExactModel(
  input: InsightsSeoAdapterInput,
): InsightsSeoExactModel {
  return {
    tabs: buildSeoSubTabs(input.activeTab),
    activeTab: input.activeTab,
    kpis: buildSeoKpis(input.overview),
    monthly: buildSeoMonthly(input.monthly),
    movers: buildSeoMovers(input.overview),
    queries: buildSeoQueries(input.overview),
    pages: buildSeoPages(input.overview),
    actionGroups: buildSeoActionGroups(input.monthly),
    technical: buildSeoTechnical(input.findings),
  };
}
