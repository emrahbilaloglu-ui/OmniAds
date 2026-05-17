"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import { CreativeRenderSurface } from "@/components/creatives/CreativeRenderSurface";
import type { MetaCreativeRow } from "@/components/creatives/metricConfig";
import type { DecisionLabel } from "@/components/common/briefing/types";
import type { ShareLinkConfig } from "@/components/creatives/shareCreativeTypes";
import { getCreativeFormatPresentation } from "@/components/creatives/briefing/creative-format";
import type { AiCreativeHistoricalWindows as CreativeHistoricalWindows } from "@/lib/meta/creative-scoring";
import {
  CustomizeKpisModal,
  DateRangePicker,
  KpiSummaryTiles,
  PresetBar,
  ShareViewModal,
  computeRangeFromPreset,
  type AssetLibraryPreset,
  type DateRangeValue,
  type KpiCatalogEntry,
  type KpiSummaryTile,
  type ShareViewState,
} from "@/components/common/briefing";

type AssetLibraryStatusFilter = "all" | "active" | "closed_30d";
type AssetLibraryFormatFilter = "image" | "video" | "catalog" | "carousel";
type AssetLibraryBadgeFilter = "below_breakeven" | "fatigue";
type AssetLibrarySort = "spend_desc" | "roas_desc" | "roas_asc" | "name_asc" | "launch_desc";
type AssetLibraryActionStatus = "idle" | "csv" | "share" | "copied" | "error";
type AssetLibraryCampaignLabelFilter = "all" | "main" | "test" | "mixed";
type ShareAudience = NonNullable<ShareLinkConfig["audience"]>;
type AssetMetricGroup =
  | "commerce"
  | "efficiency"
  | "traffic"
  | "funnel"
  | "video"
  | "lead"
  | "ai_tags";
type MetricSummaryMode = "sum" | "avg" | "weighted_roas";

type AssetMetricColumn = {
  id: string;
  label: string;
  shortLabel?: string;
  group: AssetMetricGroup;
  description: string;
  source: string;
  summaryMode: MetricSummaryMode;
  className?: string;
  value: (row: MetaCreativeRow) => string;
  rawValue: (row: MetaCreativeRow) => number;
  format: (value: number) => string;
  shareKey?: ShareLinkConfig["metrics"][number];
};

type BackendDependentMetric = {
  id: string;
  label: string;
  group: "creative_scores" | "ai_tags";
  reason: string;
  description: string;
};

type AssetLibraryRow = MetaCreativeRow & {
  engineLabel?: DecisionLabel | string | null;
  decisionLabel?: DecisionLabel | string | null;
  briefingLabel?: DecisionLabel | string | null;
  engineBadges?: string[] | null;
  badges?: string[] | null;
};

interface AssetLibraryFilters {
  status: AssetLibraryStatusFilter;
  formats: AssetLibraryFormatFilter[];
  labels: DecisionLabel[];
  badges: AssetLibraryBadgeFilter[];
  campaignLabel?: AssetLibraryCampaignLabelFilter;
  search: string;
  sort: AssetLibrarySort;
}

interface AssetLibrarySectionProps {
  rows: MetaCreativeRow[];
  emptyMessage?: string | null;
  creativeHistoryById?: Map<string, CreativeHistoricalWindows>;
  defaultCurrency: string | null;
  selectedMetricIds: string[];
  onSelectedMetricIdsChange: (next: string[]) => void;
  selectedRowIds: string[];
  highlightedRowId?: string | null;
  onToggleRow: (rowId: string) => void;
  onToggleAll: () => void;
  onOpenRow: (rowId: string) => void;
  onSortedRowsChange?: (rows: MetaCreativeRow[]) => void;
  onCompareRows?: (rows: MetaCreativeRow[]) => void;
  onShareRows?: (rows: MetaCreativeRow[], metricIds: string[], config: ShareLinkConfig) => Promise<{ url: string }>;
  dateRangeLabel?: string;
  dateRangeDetail?: string;
  onDateRangeClick?: () => void;
  onPresetChange?: (presetId: string) => void;
}

const LABEL_FILTERS: ReadonlyArray<{ key: LabelFilterKey; label: string }> = [
  { key: "all", label: "All" },
  { key: "active", label: "Active" },
  { key: "closed_30d", label: "Closed 30d" },
];

const DEFAULT_FILTERS: AssetLibraryFilters = {
  status: "all",
  formats: [],
  labels: [],
  badges: [],
  campaignLabel: "all",
  search: "",
  sort: "spend_desc",
};

const PRESETS: ReadonlyArray<AssetLibraryPreset & { metrics: string[] }> = [
  {
    key: "facebook_ecom",
    label: "Facebook Ecommerce",
    description:
      "Buyer view — spend, ROAS, CPA, frequency. Works on existing endpoints today.",
    metricsCount: 6,
    metricChips: ["Spend", "ROAS", "CPA", "Freq", "CTR", "Purch"],
    metrics: ["spend", "roas", "cpa", "frequency", "ctr", "purchases"],
  },
  {
    key: "video",
    label: "Video",
    description: "Buyer + video efficiency framing.",
    metricsCount: 6,
    metricChips: ["Spend", "ROAS", "Thumbstop", "Hold", "VTR", "CPM"],
    metrics: ["spend", "roas", "thumbstop", "videoHold", "vtr", "cpm"],
  },
  {
    key: "saas",
    label: "SaaS",
    description: "Lead/sub efficiency framing for SaaS accounts.",
    metricsCount: 5,
    metricChips: ["Spend", "CTR", "Leads", "CPL", "CPM"],
    metrics: ["spend", "ctr", "leads", "cpl", "cpm"],
  },
  {
    key: "creative_teams",
    label: "Creative teams",
    description: "0–100 scores per concept · Hook / CTA / Offer / Click / Watch.",
    metricsCount: 6,
    metricChips: ["Hook", "CTA", "Offer", "Click", "Watch", "Gap"],
    metrics: ["hookScore", "ctaScore", "offerScore", "clickScore", "watchScore", "gap"],
    unavailable: true,
    unavailableReason:
      "Backend-dependent — Creative scoring pipeline ships separately.",
  },
];

const KPI_CATALOG: ReadonlyArray<KpiCatalogEntry> = [
  { key: "spend", label: "Spend", group: "Performance", description: "Total spend for the selected window." },
  { key: "roas", label: "ROAS", group: "Performance", description: "Return on ad spend. Compared against account anchor." },
  { key: "cpa", label: "CPA", group: "Performance", description: "Cost per acquisition." },
  { key: "purchases", label: "Purchases", group: "Performance", description: "Total purchases in the window." },
  { key: "frequency", label: "Frequency", group: "Delivery", description: "Average impressions per reached user." },
  { key: "ctr", label: "CTR", group: "Engagement", description: "Click-through rate." },
  { key: "cpm", label: "CPM", group: "Delivery", description: "Cost per thousand impressions." },
  { key: "leads", label: "Leads", group: "Performance", description: "Lead conversions for SaaS accounts." },
  { key: "cpl", label: "CPL", group: "Performance", description: "Cost per lead." },
  { key: "thumbstop", label: "Thumbstop", group: "Video", description: "3s view rate — does the creative stop the scroll?" },
  { key: "videoHold", label: "Video hold", group: "Video", description: "% of viewers who watch past 15s." },
  { key: "vtr", label: "VTR", group: "Video", description: "View-through rate." },
  {
    key: "hookScore",
    label: "Hook score",
    group: "Creative scores",
    description: "0–100 score derived from thumbstop + retention vs account baseline.",
    unavailable: true,
    unavailableReason: "Requires the creative scoring pipeline.",
  },
  {
    key: "ctaScore",
    label: "CTA score",
    group: "Creative scores",
    description: "0–100 score for call-to-action clarity.",
    unavailable: true,
    unavailableReason: "Requires the creative scoring pipeline.",
  },
  {
    key: "offerScore",
    label: "Offer score",
    group: "Creative scores",
    description: "0–100 score for offer relevance.",
    unavailable: true,
    unavailableReason: "Requires the creative scoring pipeline.",
  },
  {
    key: "clickScore",
    label: "Click score",
    group: "Creative scores",
    description: "0–100 score for click momentum.",
    unavailable: true,
    unavailableReason: "Requires the creative scoring pipeline.",
  },
  {
    key: "watchScore",
    label: "Watch score",
    group: "Creative scores",
    description: "0–100 score for video watch behavior.",
    unavailable: true,
    unavailableReason: "Requires the creative scoring pipeline.",
  },
  {
    key: "aiTag_hook",
    label: "AI tag · hook style",
    group: "AI tags",
    description: "Tagged hook style: UGC / Demo / Promise.",
    unavailable: true,
    unavailableReason: "Requires AI tag generation backend.",
  },
];

export const ASSET_LIBRARY_VIEW_STORAGE_KEY = "creatives-briefing-asset-library-view";

const ASSET_METRIC_COLUMNS: AssetMetricColumn[] = [
  metric("spend", "Spend", "commerce", "Total media spend for the selected window.", "Meta insights · spend", "sum", (row) => safeNumber(row.spend), formatMoney0, "spend"),
  metric("purchaseValue", "Purchase value", "commerce", "Revenue attributed to this creative in the selected window.", "Meta insights · purchase_value", "sum", (row) => safeNumber(row.purchaseValue), formatMoney0, "purchaseValue"),
  metric("roas", "ROAS", "commerce", "Return on ad spend. Summary is purchase value divided by spend.", "Meta insights · purchase_roas", "weighted_roas", (row) => safeNumber(row.roas), formatDecimal2, "roas"),
  metric("purchases", "Purchases", "commerce", "Purchase count attributed to this creative.", "Meta insights · purchases", "sum", (row) => safeNumber(row.purchases), formatInteger, "purchases"),
  metric("cpa", "CPA", "efficiency", "Cost per purchase. Lower is better when purchase tracking is healthy.", "Meta insights · cost_per_purchase", "avg", (row) => safeNumber(row.cpa), formatMoney2, "cpa"),
  metric("cpcLink", "CPC link", "efficiency", "Cost per outbound/link click.", "Meta insights · cost_per_link_click", "avg", (row) => safeNumber(row.cpcLink), formatMoney2, "cpcLink"),
  metric("cpm", "CPM", "efficiency", "Cost per 1,000 impressions.", "Meta insights · cpm", "avg", (row) => safeNumber(row.cpm), formatMoney2, "cpm"),
  metric("aov", "AOV", "efficiency", "Average order value from attributed purchase value and purchases.", "Derived · purchase value / purchases", "avg", (row) => safeNumber(row.purchases) > 0 ? safeNumber(row.purchaseValue) / safeNumber(row.purchases) : 0, formatMoney2),
  metric("ctrAll", "CTR", "traffic", "Click-through rate across all clicks.", "Meta insights · ctr", "avg", (row) => safeNumber(row.ctrAll), formatPercent2, "ctrAll"),
  metric("linkCtr", "Link CTR", "traffic", "Link click rate against impressions.", "Derived · link clicks / impressions", "avg", (row) => safeNumber(row.linkCtr), formatPercent2, "linkCtr"),
  metric("impressions", "Impressions", "traffic", "Total impressions in the selected window.", "Meta insights · impressions", "sum", (row) => safeNumber(row.impressions), formatInteger, "impressions"),
  metric("clicks", "Clicks", "traffic", "All clicks reported by Meta.", "Meta insights · clicks", "sum", (row) => safeNumber(row.clicks), formatInteger, "clicks"),
  metric("linkClicks", "Link clicks", "traffic", "Outbound/link clicks reported by Meta.", "Meta insights · link_clicks", "sum", (row) => safeNumber(row.linkClicks), formatInteger, "linkClicks"),
  metric("landingPageViews", "Landing page views", "funnel", "Landing page view actions attributed to this creative.", "Meta insights · landing_page_view", "sum", (row) => safeNumber(row.landingPageViews), formatInteger),
  metric("addToCart", "Add to cart", "funnel", "Add-to-cart actions attributed to this creative.", "Meta insights · add_to_cart", "sum", (row) => safeNumber(row.addToCart), formatInteger, "addToCart"),
  metric("initiateCheckout", "Initiate checkout", "funnel", "Checkout starts attributed to this creative.", "Meta insights · initiate_checkout", "sum", (row) => safeNumber(row.initiateCheckout), formatInteger),
  metric("clickToAddToCart", "Click to ATC", "funnel", "Share of link clicks that became add-to-cart actions.", "Derived · add to cart / link clicks", "avg", (row) => safeNumber(row.clickToAddToCart), formatPercent2, "clickToAddToCart"),
  metric("atcToPurchaseRatio", "ATC to purchase", "funnel", "Share of add-to-cart actions that converted to purchases.", "Derived · purchases / add to cart", "avg", (row) => safeNumber(row.atcToPurchaseRatio), formatPercent2, "atcToPurchaseRatio"),
  metric("clickToPurchase", "Click to purchase", "funnel", "Share of link clicks that became purchases.", "Derived · purchases / link clicks", "avg", (row) => safeNumber(row.clickToPurchase), formatPercent2, "clickToPurchase"),
  metric("frequency", "Frequency", "video", "Average delivery frequency for the creative.", "Meta insights · frequency", "avg", (row) => safeNumber(row.frequency), formatDecimal2),
  metric("thumbstop", "Thumbstop", "video", "Hook proxy based on early video retention when video evidence exists.", "Meta video insights · thumbstop", "avg", (row) => safeNumber(row.thumbstop), formatPercent2, "thumbstop"),
  metric("video25", "25% views", "video", "Video plays reaching 25%.", "Meta video insights · 25% plays", "avg", (row) => safeNumber(row.video25), formatPercent2, "video25"),
  metric("video50", "50% views", "video", "Video plays reaching 50%.", "Meta video insights · 50% plays", "avg", (row) => safeNumber(row.video50), formatPercent2, "video50"),
  metric("video75", "75% views", "video", "Video plays reaching 75%.", "Meta video insights · 75% plays", "avg", (row) => safeNumber(row.video75), formatPercent2, "video75"),
  metric("video100", "100% views", "video", "Video plays reaching completion.", "Meta video insights · 100% plays", "avg", (row) => safeNumber(row.video100), formatPercent2, "video100"),
  metric("leads", "Leads", "lead", "Lead actions attributed to this creative.", "Meta insights · leads", "sum", (row) => safeNumber(row.leads), formatInteger),
  metric("messages", "Messages", "lead", "Messaging conversation starts or message actions attributed to this creative.", "Meta insights · messaging actions", "sum", (row) => safeNumber(row.messages), formatInteger),
];

export const DEFAULT_VISIBLE_METRIC_IDS = ["spend", "purchaseValue", "roas", "purchases", "cpa", "ctrAll"];

const BACKEND_DEPENDENT_METRICS: BackendDependentMetric[] = [
  { id: "ai.assetType", label: "Asset Type", group: "ai_tags", reason: "needs tagger", description: "Server-side AI tag for the creative asset category." },
  { id: "ai.visualFormat", label: "Visual Format", group: "ai_tags", reason: "needs tagger", description: "Server-side AI tag for the visual structure." },
  { id: "ai.messagingAngle", label: "Messaging Angle", group: "ai_tags", reason: "needs tagger", description: "Server-side AI tag for the core message angle." },
  { id: "ai.hookTactic", label: "Hook Tactic", group: "ai_tags", reason: "needs tagger", description: "Server-side AI tag for the opening hook tactic." },
  { id: "ai.headlineTactic", label: "Headline Tactic", group: "ai_tags", reason: "needs tagger", description: "Server-side AI tag for headline structure." },
  { id: "score.hook", label: "Hook score", group: "creative_scores", reason: "needs scoring", description: "0-100 account-relative hook score. Hidden until scoring pipeline fields exist." },
  { id: "score.cta", label: "CTA score", group: "creative_scores", reason: "needs scoring", description: "0-100 account-relative call-to-action score. Hidden until scoring pipeline fields exist." },
  { id: "score.offer", label: "Offer score", group: "creative_scores", reason: "needs scoring", description: "0-100 account-relative offer score. Hidden until scoring pipeline fields exist." },
  { id: "score.click", label: "Click score", group: "creative_scores", reason: "needs scoring", description: "0-100 account-relative click quality score. Hidden until scoring pipeline fields exist." },
  { id: "score.watch", label: "Watch score", group: "creative_scores", reason: "needs scoring", description: "0-100 account-relative watch quality score. Hidden until scoring pipeline fields exist." },
];

export const ASSET_PRESETS: Array<{
  id: string;
  title: string;
  detail: string;
  metricIds: string[];
  sort: AssetLibrarySort;
  chips: string[];
  unavailable?: boolean;
}> = [
  {
    id: "ecommerce",
    title: "Facebook Ecommerce",
    detail: "Purchase ads: unit economics, post-click flow, and revenue density.",
    metricIds: ["spend", "purchaseValue", "roas", "purchases", "cpa", "ctrAll"],
    sort: "spend_desc",
    chips: ["Spend", "ROAS", "Purchases", "CPA", "CTR"],
  },
  {
    id: "video",
    title: "Facebook Video",
    detail: "Video review: hook strength, watch-through quality, and click carry-through.",
    metricIds: ["spend", "thumbstop", "video25", "video50", "video100", "ctrAll"],
    sort: "launch_desc",
    chips: ["Hook", "25% views", "50% views", "100% views", "CTR"],
  },
  {
    id: "saas",
    title: "Facebook SaaS",
    detail: "Lead-flow accounts: lead capture, message intent, and click efficiency.",
    metricIds: ["spend", "leads", "messages", "cpa", "cpcLink", "linkCtr"],
    sort: "spend_desc",
    chips: ["Spend", "Leads", "Messages", "CPC", "Link CTR"],
  },
  {
    id: "creative_teams",
    title: "Creative teams",
    detail: "Requires creative score pipeline. No buyer decision language in this preset.",
    metricIds: ["score.hook", "score.cta", "score.offer", "score.click", "score.watch"],
    sort: "spend_desc",
    chips: ["Hook score", "CTA score", "Offer score", "Click score", "Watch score"],
    unavailable: true,
  },
];

const CUSTOM_PRESET = {
  id: "custom",
  title: "Customize columns",
  detail: "Custom KPI list",
  metricIds: DEFAULT_VISIBLE_METRIC_IDS,
  sort: "spend_desc" as AssetLibrarySort,
  chips: [],
};

const METRIC_GROUP_LABELS: Record<AssetMetricGroup, string> = {
  commerce: "Commerce metrics",
  efficiency: "Efficiency metrics",
  traffic: "Traffic metrics",
  funnel: "Post-click funnel",
  video: "Video and fatigue",
  lead: "Lead and messaging",
  ai_tags: "AI tags",
};

export function toggleArrayFilter<T extends string>(current: T[], value: T) {
  return current.includes(value)
    ? current.filter((item) => item !== value)
    : [...current, value];
}

export function isAssetLibraryFilterActive(filters: AssetLibraryFilters) {
  return (
    filters.status !== "all" ||
    filters.formats.length > 0 ||
    filters.labels.length > 0 ||
    filters.badges.length > 0 ||
    filters.campaignLabel !== "all" ||
    filters.search.trim().length > 0
  );
}

export function assetLibraryCountSummary(filteredCount: number, originalCount: number) {
  return `Showing ${filteredCount} of ${originalCount}`;
}

function metric(
  id: string,
  label: string,
  group: AssetMetricGroup,
  description: string,
  source: string,
  summaryMode: MetricSummaryMode,
  rawValue: (row: MetaCreativeRow) => number,
  formatter: (value: number) => string,
  shareKey?: ShareLinkConfig["metrics"][number],
): AssetMetricColumn {
  return {
    id,
    label,
    group,
    description,
    source,
    summaryMode,
    className: "num",
    rawValue,
    format: formatter,
    value: (row) => formatter(rawValue(row)),
    shareKey,
  };
}

function columnsForMetricIds(metricIds: string[]) {
  const ids = metricIds.length > 0 ? metricIds : DEFAULT_VISIBLE_METRIC_IDS;
  const seen = new Set<string>();
  const columns = ids
    .filter((id) => {
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .map((metricId) => ASSET_METRIC_COLUMNS.find((column) => column.id === metricId))
    .filter((column): column is AssetMetricColumn => Boolean(column));
  return columns.length > 0
    ? columns
    : DEFAULT_VISIBLE_METRIC_IDS
        .map((metricId) => ASSET_METRIC_COLUMNS.find((column) => column.id === metricId))
        .filter((column): column is AssetMetricColumn => Boolean(column));
}

function metricMatchesSearch(metric: AssetMetricColumn, search: string) {
  if (!search) return true;
  return [
    metric.id,
    metric.label,
    metric.shortLabel,
    metric.description,
    metric.source,
    METRIC_GROUP_LABELS[metric.group],
  ].some((value) => safeText(value).toLowerCase().includes(search));
}

function groupMetrics(metrics: AssetMetricColumn[]) {
  const groupOrder: AssetMetricGroup[] = [
    "commerce",
    "efficiency",
    "traffic",
    "funnel",
    "video",
    "lead",
    "ai_tags",
  ];
  return groupOrder
    .map((group) => [group, metrics.filter((metric) => metric.group === group)] as const)
    .filter(([, items]) => items.length > 0);
}

function groupBackendDependentMetrics(metrics: BackendDependentMetric[]) {
  return (["ai_tags", "creative_scores"] as const)
    .map((group) => [group, metrics.filter((metric) => metric.group === group)] as const)
    .filter(([, items]) => items.length > 0);
}

function buildKpiSummaryCells(input: {
  columns: AssetMetricColumn[];
  rows: MetaCreativeRow[];
  totalRows: number;
  selectedCount: number;
  filtersActive: boolean;
  currency: string | null;
}) {
  const baseColumns = input.columns.length > 0 ? input.columns.slice(0, 4) : columnsForMetricIds(DEFAULT_VISIBLE_METRIC_IDS).slice(0, 4);
  const cells = baseColumns.map((column) => summarizeMetric(column, input.rows, input.currency));
  while (cells.length < 4) {
    cells.push({
      title: cells.length === 2 ? "Selected" : "Scope",
      scope: cells.length === 2 ? "handoff" : "library",
      value: cells.length === 2 ? String(input.selectedCount) : String(input.rows.length),
      sub: cells.length === 2 ? "assets" : "rows",
      micro: input.filtersActive
        ? assetLibraryCountSummary(input.rows.length, input.totalRows)
        : `${input.totalRows} total assets`,
    });
  }
  return cells.slice(0, 4);
}

function summarizeMetric(column: AssetMetricColumn, rows: MetaCreativeRow[], currency: string | null) {
  const count = rows.length;
  const values = rows.map((row) => column.rawValue(row)).filter((value) => Number.isFinite(value));
  const total = values.reduce((sum, value) => sum + value, 0);
  const value =
    column.summaryMode === "weighted_roas"
      ? weightedRoas(rows)
      : column.summaryMode === "avg"
        ? count > 0
          ? total / count
          : 0
        : total;
  return {
    title: column.summaryMode === "sum" ? `Total ${column.label}` : `Avg ${column.label}`,
    scope: count > 0 ? `scope · ${count}` : "scope",
    value: column.format(value) || formatDecimal2(value),
    sub: column.id === "spend" || column.id === "purchaseValue" || column.id === "cpa" || column.id === "cpcLink" || column.id === "cpm" || column.id === "aov"
      ? currency ?? "USD"
      : column.summaryMode === "sum"
        ? "total"
        : "avg",
    micro:
      column.summaryMode === "weighted_roas"
        ? "purchase value divided by spend"
        : column.summaryMode === "sum"
          ? `${count} creatives in current scope`
          : "arithmetic mean across visible creatives",
  };
}

function weightedRoas(rows: MetaCreativeRow[]) {
  const spend = rows.reduce((sum, row) => sum + safeNumber(row.spend), 0);
  const purchaseValue = rows.reduce((sum, row) => sum + safeNumber(row.purchaseValue), 0);
  return spend > 0 ? purchaseValue / spend : 0;
}

export function filterAssetLibraryRows(
  rows: MetaCreativeRow[],
  filters: AssetLibraryFilters,
) {
  const search = filters.search.trim().toLowerCase();
  return safeRows(rows).filter((row) => {
    const extended = row as AssetLibraryRow;
    if (filters.status === "active" && extended.effectiveStatus !== "ACTIVE") return false;
    if (filters.status === "closed_30d" && extended.effectiveStatus === "ACTIVE") return false;
    if (filters.formats.length > 0 && !filters.formats.some((format) => rowMatchesFormat(extended, format))) return false;
    if (filters.labels.length > 0 && !filters.labels.includes(rowEngineLabel(extended) as DecisionLabel)) return false;
    if (filters.badges.length > 0 && !filters.badges.every((badge) => rowMatchesBadge(extended, badge))) return false;
    const campaignLabel = filters.campaignLabel ?? "all";
    if (campaignLabel !== "all" && !rowMatchesCampaignLabel(extended, campaignLabel)) return false;
    if (search && !rowMatchesSearch(extended, search)) return false;
    return true;
  });
}

export function sortAssetLibraryRows(
  rows: MetaCreativeRow[],
  sort: AssetLibrarySort,
) {
  const sorted = [...safeRows(rows)];
  sorted.sort((a, b) => {
    if (sort === "roas_desc") return safeNumber(b.roas) - safeNumber(a.roas);
    if (sort === "roas_asc") return safeNumber(a.roas) - safeNumber(b.roas);
    if (sort === "name_asc") return safeText(a.name).localeCompare(safeText(b.name));
    if (sort === "launch_desc") return safeTime(b.launchDate) - safeTime(a.launchDate);
    return safeNumber(b.spend) - safeNumber(a.spend);
  });
  return sorted;
}

export function AssetLibrarySection({
  rows,
  emptyMessage,
  defaultCurrency,
  selectedMetricIds,
  onSelectedMetricIdsChange,
  selectedRowIds,
  highlightedRowId = null,
  onToggleRow,
  onToggleAll,
  onOpenRow,
  onSortedRowsChange,
  onCompareRows,
  onShareRows,
  dateRangeLabel = "Last 30d",
  dateRangeDetail,
  onDateRangeClick,
  onPresetChange,
}: AssetLibrarySectionProps) {
  const [filters, setFilters] = useState<AssetLibraryFilters>(DEFAULT_FILTERS);
  const [presetOpen, setPresetOpen] = useState(false);
  const [kpiOpen, setKpiOpen] = useState(false);
  const presetWrapRef = useRef<HTMLDivElement | null>(null);
  const [metricSearch, setMetricSearch] = useState("");
  const [activeMetricId, setActiveMetricId] = useState(DEFAULT_VISIBLE_METRIC_IDS[0]);
  const [draftMetricIds, setDraftMetricIds] = useState<string[]>(DEFAULT_VISIBLE_METRIC_IDS);
  const [shareOpen, setShareOpen] = useState(false);
  const [shareAudience, setShareAudience] = useState<ShareAudience>("buyer");
  const [includeCampaignNames, setIncludeCampaignNames] = useState(true);
  const [includeDecisionLanguage, setIncludeDecisionLanguage] = useState(true);
  const [allowCsv, setAllowCsv] = useState(false);
  const [generatedShareUrl, setGeneratedShareUrl] = useState<string | null>(null);
  const [actionStatus, setActionStatus] = useState<AssetLibraryActionStatus>("idle");

  const filteredRows = useMemo(
    () => sortAssetLibraryRows(filterAssetLibraryRows(rows, filters), filters.sort),
    [filters, rows],
  );
  useEffect(() => {
    onSortedRowsChange?.(filteredRows);
  }, [filteredRows, onSortedRowsChange]);
  const filtersActive = isAssetLibraryFilterActive(filters);
  const selectedCount = selectedRowIds.length;
  const selectedRowIdSet = useMemo(() => new Set(selectedRowIds), [selectedRowIds]);
  const selectedRows = useMemo(
    () => filteredRows.filter((row) => selectedRowIdSet.has(row.id)),
    [filteredRows, selectedRowIdSet],
  );
  const actionRows = selectedRows.length > 0 ? selectedRows : filteredRows;
  const visibleMetricColumns = useMemo(
    () => columnsForMetricIds(selectedMetricIds),
    [selectedMetricIds],
  );
  const draftMetricColumns = useMemo(
    () => columnsForMetricIds(draftMetricIds),
    [draftMetricIds],
  );
  const actionRowsLabel = selectedRows.length > 0 ? "selected" : "visible";
  const activePreset = ASSET_PRESETS.find((preset) =>
    !preset.unavailable &&
    preset.metricIds.join("|") === visibleMetricColumns.map((column) => column.id).join("|"),
  ) ?? CUSTOM_PRESET;
  const metricSearchText = metricSearch.trim().toLowerCase();
  const metricCatalog = ASSET_METRIC_COLUMNS.filter((metric) =>
    metricMatchesSearch(metric, metricSearchText),
  );
  const backendDependentCatalog = BACKEND_DEPENDENT_METRICS.filter((metric) =>
    !metricSearchText ||
    metric.label.toLowerCase().includes(metricSearchText) ||
    metric.id.toLowerCase().includes(metricSearchText) ||
    metric.description.toLowerCase().includes(metricSearchText),
  );
  useEffect(() => {
    if (!presetOpen) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (presetWrapRef.current?.contains(event.target as Node)) return;
      setPresetOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPresetOpen(false);
    };
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [presetOpen]);

  const openKpiModal = () => {
    const currentIds = visibleMetricColumns.map((column) => column.id);
    setDraftMetricIds(currentIds);
    setActiveMetricId(currentIds[0] ?? DEFAULT_VISIBLE_METRIC_IDS[0]);
    setMetricSearch("");
    setKpiOpen(true);
  };

  const updateMetricSelection = (metricId: string) => {
    const exists = draftMetricIds.includes(metricId);
    const next = exists
      ? draftMetricIds.filter((id) => id !== metricId)
      : [...draftMetricIds, metricId];
    setDraftMetricIds(next.length > 0 ? next : DEFAULT_VISIBLE_METRIC_IDS);
  };

  const moveMetricSelection = (metricId: string, direction: -1 | 1) => {
    setDraftMetricIds((current) => {
      const index = current.indexOf(metricId);
      const nextIndex = index + direction;
      if (index < 0 || nextIndex < 0 || nextIndex >= current.length) return current;
      const next = [...current];
      [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
      return next;
    });
  };

  const applyPreset = (preset: (typeof ASSET_PRESETS)[number]) => {
    if (preset.unavailable) return;
    onSelectedMetricIdsChange(preset.metricIds.filter((metricId) => ASSET_METRIC_COLUMNS.some((metric) => metric.id === metricId)));
    onPresetChange?.(preset.id);
    setFilters((current) => ({ ...current, sort: preset.sort }));
    setPresetOpen(false);
  };

  const exportCsv = () => {
    if (actionRows.length === 0) return;
    const csv = buildAssetLibraryCsv(actionRows, visibleMetricColumns);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `adsecute-asset-library-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    setActionStatus("csv");
    window.setTimeout(() => setActionStatus("idle"), 1800);
  };

  const shareRows = async () => {
    if (!onShareRows || actionRows.length === 0) return;
    setActionStatus("share");
    const shareMetrics = visibleMetricColumns
      .map((column) => column.shareKey)
      .filter((id): id is ShareLinkConfig["metrics"][number] => Boolean(id));
    try {
      const result = await onShareRows(actionRows, visibleMetricColumns.map((column) => column.id), {
        title: "Asset Library view",
        expiration: "7",
        metrics: shareMetrics.length > 0 ? shareMetrics : ["spend", "roas", "cpa", "ctrAll"],
        includeNotes: false,
        passwordProtection: false,
        audience: shareAudience,
        includeCampaignNames,
        includeDecisionLanguage: shareAudience === "buyer" && includeDecisionLanguage,
        allowCsv,
        snapshotOnly: true,
      });
      setGeneratedShareUrl(result.url);
      await navigator.clipboard?.writeText(result.url).catch(() => null);
      setActionStatus("copied");
    } catch {
      setActionStatus("error");
    } finally {
      window.setTimeout(() => setActionStatus("idle"), 2400);
    }
  };
  return (
    <section data-asset-library>
      <div className="preset-bar">
        <div ref={presetWrapRef} className="popover-wrap">
        <button
          type="button"
          className="preset-chip"
          aria-expanded={presetOpen}
          aria-haspopup="menu"
          data-asset-library-preset-chip
          onClick={() => setPresetOpen((open) => !open)}
        >
          <span>{activePreset.title}</span>
          <span className="preset-meta">· {visibleMetricColumns.length} KPIs</span>
          <span className="chev">▾</span>
        </button>
        {presetOpen ? (
          <div className="popover preset-list" role="menu" data-asset-preset-popover>
            {ASSET_PRESETS.map((preset) =>
              preset.unavailable ? (
                <div key={preset.id} className="preset-item preset-item--disabled">
                  <b>{preset.title}</b>
                  <span>{preset.detail}</span>
                  <span className="preset-cols">{preset.chips.join(" · ")}</span>
                </div>
              ) : (
                <button
                  key={preset.id}
                  type="button"
                  role="menuitem"
                  className={`preset-item ${activePreset.id === preset.id ? "on" : ""}`}
                  onClick={() => applyPreset(preset)}
                >
                  <b>{preset.title}</b>
                  <span>{preset.detail}</span>
                  <span className="preset-cols">{preset.chips.join(" · ")}</span>
                </button>
              ),
            )}
          </div>
        ) : null}
        </div>
        <button type="button" className="btn" aria-haspopup="dialog" aria-expanded={kpiOpen} onClick={openKpiModal}>⚙ KPIs</button>
        <button type="button" className="date-chip" onClick={onDateRangeClick} aria-haspopup="dialog">
          <span className="ico">◷</span>
          <span>{dateRangeLabel}</span>
          {dateRangeDetail ? <span className="range">{dateRangeDetail}</span> : null}
          <span className="chev">▾</span>
        </button>
        <label className="relative min-w-[260px] flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 inline-block shrink-0" size={14} aria-hidden="true" />
          <input
            type="search"
            value={filters.search}
            onChange={(event) => setFilters((current) => ({ ...current, search: event.currentTarget.value }))}
            placeholder="creative / campaign / ad set"
            className="w-full rounded-md border border-slate-200 bg-white py-1.5 pl-9 pr-3 text-[12.5px] text-slate-900 placeholder:text-slate-400 focus:outline-none"
          />
        </label>
        <div className="seg">
          {(["all", "main", "test", "mixed"] as AssetLibraryCampaignLabelFilter[]).map((filter) => (
            <button key={filter} type="button" className={filters.campaignLabel === filter ? "on" : ""} onClick={() => setFilters((current) => ({ ...current, campaignLabel: filter }))}>
              {filter === "all" ? "All" : filter[0].toUpperCase() + filter.slice(1)}
            </button>
          ))}
        </div>
        <select
          value={filters.status}
          aria-label="Asset Library status"
          className="btn"
          onChange={(event) => setFilters((current) => ({ ...current, status: event.currentTarget.value as AssetLibraryStatusFilter }))}
        >
          {STATUS_FILTERS.map((filter) => (
            <option key={filter.key} value={filter.key}>{filter.label}</option>
          ))}
        </select>
        <select
          value={filters.sort}
          aria-label="Asset Library sort preset"
          className="btn"
          onChange={(event) => setFilters((current) => ({ ...current, sort: event.currentTarget.value as AssetLibrarySort }))}
        >
          <option value="spend_desc">Spend</option>
          <option value="roas_desc">ROAS high</option>
          <option value="roas_asc">ROAS low</option>
          <option value="name_asc">Name</option>
          <option value="launch_desc">Newest</option>
        </select>
        <div className="spacer" />
        <span className="meta-count">{filteredRows.length} · {selectedCount} sel</span>
        <button
          type="button"
          className="btn"
          disabled={actionRows.length < 2 || !onCompareRows}
          title={actionRows.length < 2 ? "Select or filter at least 2 assets to compare." : `Compare ${actionRows.length} ${actionRowsLabel} assets.`}
          onClick={() => onCompareRows?.(actionRows.slice(0, 4))}
        >
          Compare
        </button>
        <button
          type="button"
          className="btn"
          disabled={actionRows.length === 0}
          title={`Export ${actionRows.length} ${actionRowsLabel} assets as CSV.`}
          onClick={exportCsv}
        >
          {actionStatus === "csv" ? "CSV exported" : "⇧ CSV"}
        </button>
        <button
          type="button"
          className="btn btn--primary"
          disabled={actionRows.length === 0 || !onShareRows || actionStatus === "share"}
          title={`Create and copy a share link for ${actionRows.length} ${actionRowsLabel} assets.`}
          onClick={() => setShareOpen(true)}
        >
          {actionStatus === "share" ? "Sharing..." : actionStatus === "copied" ? "Copied link" : actionStatus === "error" ? "Share failed" : "↗ Share view…"}
        </button>
      </div>

      {kpiOpen ? (
        <KpiCustomizeModal
          metrics={ASSET_METRIC_COLUMNS}
          selectedMetricColumns={draftMetricColumns}
          metricCatalog={metricCatalog}
          backendDependentCatalog={backendDependentCatalog}
          metricSearch={metricSearch}
          activeMetricId={activeMetricId}
          onMetricSearchChange={setMetricSearch}
          onActiveMetricChange={setActiveMetricId}
          onToggleMetric={updateMetricSelection}
          onMoveMetric={moveMetricSelection}
          onReset={() => {
            setDraftMetricIds(DEFAULT_VISIBLE_METRIC_IDS);
            setActiveMetricId(DEFAULT_VISIBLE_METRIC_IDS[0]);
          }}
          onClose={() => setKpiOpen(false)}
          onApply={() => {
            onSelectedMetricIdsChange(draftMetricIds.filter((metricId) => ASSET_METRIC_COLUMNS.some((metric) => metric.id === metricId)));
            setKpiOpen(false);
          }}
        />
      ) : null}

      <div className="dashboard-kpis">
        {buildKpiSummaryCells({
          columns: visibleMetricColumns,
          rows: filteredRows,
          totalRows: rows.length,
          selectedCount,
          filtersActive,
          currency: defaultCurrency,
        }).map((cell, index) => (
          <div key={`${cell.title}-${index}`} className={`kpi-cell ${index % 2 === 1 ? "bench" : ""}`}>
            <div className="k"><span>{cell.title}</span><span>{cell.scope}</span></div>
            <div className="v">{cell.value} <span className="sub">{cell.sub}</span></div>
            <div className="micro">{cell.micro}</div>
          </div>
        ))}
      </div>

      <div style={{ overflowX: "auto" }}>
        <table className="asset-table">
          <thead>
            <tr>
              <th style={{ width: 24 }}>
                <button type="button" className="row-check" aria-label="Select all creative rows" onClick={onToggleAll} />
              </th>
              <th>Creative <span style={{ color: "var(--ink)" }}>↓</span></th>
              <th>Label</th>
              {visibleMetricColumns.map((column) => (
                <th key={column.id} className={column.className}>{column.label}</th>
              ))}
              <th>Gap</th>
              <th style={{ width: 24 }} />
            </tr>
          </thead>
          <tbody>
            {filteredRows.length === 0 ? (
              <tr>
                <td colSpan={visibleMetricColumns.length + 5}>{rows.length === 0 ? emptyMessage ?? "No Meta creative rows were found for the selected window." : "No creatives match the current Asset Library filters."}</td>
              </tr>
            ) : (
              filteredRows.map((row) => {
                const selected = selectedRowIds.includes(row.id);
                const label = rowEngineLabel(row as AssetLibraryRow);
                const format = getCreativeFormatPresentation(row);
                const gap = rowMatchesBadge(row as AssetLibraryRow, "below_breakeven")
                  ? "Below breakeven"
                  : rowMatchesBadge(row as AssetLibraryRow, "fatigue")
                    ? "Fatigue"
                    : "no gap";
                return (
                  <tr key={row.id} className={selected || highlightedRowId === row.id ? "sel" : ""} onClick={() => onOpenRow(row.id)}>
                    <td>
                      <button
                        type="button"
                        className={`row-check ${selected ? "on" : ""}`}
                        aria-label={`Select ${row.name}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          onToggleRow(row.id);
                        }}
                      />
                    </td>
                    <td>
                      <span className="row-name">
                        <span className="row-thumb row-thumb--media">
                          <CreativeRenderSurface
                            id={row.id}
                            name={row.name}
                            preview={rowPreviewPayload(row)}
                            mode="asset"
                            size="thumb"
                            assetFallbacks={rowMediaFallbacks(row, "thumb")}
                            className="h-full w-full rounded-[var(--r-xs)]"
                          />
                          <span className="micro-fmt">{format.tag}</span>
                        </span>
                        <span className="name-text"><b>{row.name}</b><span>{row.launchDate || "—"} · {format.detailLabel}</span></span>
                      </span>
                    </td>
                    <td><span className={label === "test_more" ? "chip chip--info" : label === "cut" || label === "below_breakeven" ? "chip chip--action" : "chip"}><span className="dot" />{safeText(label) || "Main"}</span></td>
                    {visibleMetricColumns.map((column) => (
                      <td key={column.id} className={column.className}>{column.value(row)}</td>
                    ))}
                    <td><span className={`chip ${gap === "no gap" ? "chip--ghost" : gap === "Fatigue" ? "chip--watch" : "chip--action"}`} style={{ fontSize: 9.5 }}>{gap}</span></td>
                    <td style={{ textAlign: "right" }}>
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        title="Open row context"
                        onClick={(event) => {
                          event.stopPropagation();
                          onOpenRow(row.id);
                        }}
                      >
                        ⋯
                      </button>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      {shareOpen ? (
        <ShareViewModal
          audience={shareAudience}
          includeCampaignNames={includeCampaignNames}
          includeDecisionLanguage={includeDecisionLanguage}
          allowCsv={allowCsv}
          generatedShareUrl={generatedShareUrl}
          actionStatus={actionStatus}
          rowCount={actionRows.length}
          onAudienceChange={(audience) => {
            setShareAudience(audience);
            if (audience !== "buyer") setIncludeDecisionLanguage(false);
          }}
          onToggleCampaignNames={() => setIncludeCampaignNames((value) => !value)}
          onToggleDecisionLanguage={() => setIncludeDecisionLanguage((value) => !value)}
          onToggleCsv={() => setAllowCsv((value) => !value)}
          onGenerate={() => void shareRows()}
          onClose={() => setShareOpen(false)}
        />
      ) : null}
    </section>
  );
}

function KpiCustomizeModal({
  metrics,
  selectedMetricColumns,
  metricCatalog,
  backendDependentCatalog,
  metricSearch,
  activeMetricId,
  onMetricSearchChange,
  onActiveMetricChange,
  onToggleMetric,
  onMoveMetric,
  onReset,
  onClose,
  onApply,
}: {
  metrics: AssetMetricColumn[];
  selectedMetricColumns: AssetMetricColumn[];
  metricCatalog: AssetMetricColumn[];
  backendDependentCatalog: BackendDependentMetric[];
  metricSearch: string;
  activeMetricId: string;
  onMetricSearchChange: (value: string) => void;
  onActiveMetricChange: (value: string) => void;
  onToggleMetric: (metricId: string) => void;
  onMoveMetric: (metricId: string, direction: -1 | 1) => void;
  onReset: () => void;
  onClose: () => void;
  onApply: () => void;
}) {
  const selectedIds = new Set(selectedMetricColumns.map((metric) => metric.id));
  const activeMetric =
    metrics.find((metric) => metric.id === activeMetricId) ??
    selectedMetricColumns[0] ??
    metrics[0];
  const groupedMetrics = groupMetrics(metricCatalog);
  const groupedBackendMetrics = groupBackendDependentMetrics(backendDependentCatalog);
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);
  return (
    <div
      className="modal-backdrop"
      role="presentation"
      data-kpi-modal
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="cc-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Customize KPIs"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="cc-search">
          <label className="search-field">
            <Search size={14} aria-hidden="true" />
            <input
              type="search"
              value={metricSearch}
              onChange={(event) => onMetricSearchChange(event.currentTarget.value)}
              placeholder="Search metrics"
            />
          </label>
          <button type="button" className="btn btn--ghost btn--sm" onClick={onClose}>×</button>
        </div>
        <div className="cc-body">
          <div className="cc-left">
            <h4>Selected metrics</h4>
            {selectedMetricColumns.map((metric, index) => (
              <div key={metric.id} className="selected-metric" onClick={() => onActiveMetricChange(metric.id)}>
                <span className="handle">⋮</span>
                <span className="name">{metric.label}</span>
                <button
                  type="button"
                  className="icon-btn"
                  disabled={index === 0}
                  aria-label={`Move ${metric.label} up`}
                  onClick={(event) => {
                    event.stopPropagation();
                    onMoveMetric(metric.id, -1);
                  }}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  disabled={index === selectedMetricColumns.length - 1}
                  aria-label={`Move ${metric.label} down`}
                  onClick={(event) => {
                    event.stopPropagation();
                    onMoveMetric(metric.id, 1);
                  }}
                >
                  ↓
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`Remove ${metric.label}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    onToggleMetric(metric.id);
                  }}
                >
                  ×
                </button>
              </div>
            ))}
            <div className="cc-note">
              <b>Preset · Customize columns</b>
              <span>Preset controls only this table, export CSV, and share snapshot metrics. Server decision lanes stay unchanged.</span>
            </div>
          </div>
          <div className="cc-mid">
            {groupedMetrics.map(([group, groupMetrics]) => (
              <div key={group}>
                <div className="group-h">{METRIC_GROUP_LABELS[group]}</div>
                {groupMetrics.map((metric) => (
                  <button
                    key={metric.id}
                    type="button"
                    className={`metric-row ${selectedIds.has(metric.id) ? "in" : ""}`}
                    onClick={() => {
                      onActiveMetricChange(metric.id);
                      onToggleMetric(metric.id);
                    }}
                  >
                    <span>{metric.label}</span>
                    <span className="plus">{selectedIds.has(metric.id) ? "✓" : "+"}</span>
                  </button>
                ))}
              </div>
            ))}
            {groupedBackendMetrics.map(([group, items]) => (
              <div key={group}>
                <div className="group-h">
                  {group === "ai_tags" ? "AI tags · backend dependent" : "Creative scores · backend dependent"}
                </div>
                {items.map((metric) => (
                  <button
                    key={metric.id}
                    type="button"
                    className="metric-row metric-row--disabled"
                    disabled
                    title={metric.description}
                  >
                    <span>{metric.label}</span>
                    <span>{metric.reason}</span>
                  </button>
                ))}
              </div>
            ))}
          </div>
          <div className="cc-right">
            <h4>{activeMetric?.label ?? "Metric"}</h4>
            <div className="desc-body">
              <p>{activeMetric?.description ?? "Controls the visible Asset Library table columns and share export metrics."}</p>
              <p>
                <b>Source</b> · {activeMetric?.source ?? "Asset Library row"}
              </p>
              <p>
                <b>Scope</b> · current Asset Library date range and filters. This does not change server decision lanes.
              </p>
            </div>
          </div>
        </div>
        <div className="cc-foot">
          <span className="cc-foot-note">Editing preset · {selectedMetricColumns.length} metrics selected</span>
          <div className="right-buttons">
            <button type="button" className="btn btn--ghost" onClick={onReset}>Reset</button>
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
            <button type="button" className="btn btn--primary" onClick={onApply}>Apply</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ShareViewModal({
  audience,
  includeCampaignNames,
  includeDecisionLanguage,
  allowCsv,
  generatedShareUrl,
  actionStatus,
  rowCount,
  onAudienceChange,
  onToggleCampaignNames,
  onToggleDecisionLanguage,
  onToggleCsv,
  onGenerate,
  onClose,
}: {
  audience: ShareAudience;
  includeCampaignNames: boolean;
  includeDecisionLanguage: boolean;
  allowCsv: boolean;
  generatedShareUrl: string | null;
  actionStatus: AssetLibraryActionStatus;
  rowCount: number;
  onAudienceChange: (audience: ShareAudience) => void;
  onToggleCampaignNames: () => void;
  onToggleDecisionLanguage: () => void;
  onToggleCsv: () => void;
  onGenerate: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      data-share-modal
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="share-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Share Asset Library view"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h3>Share Asset Library view</h3>
        <p className="text-[12px] text-slate-500">{rowCount} creatives · snapshot link</p>
        <div className="seg" role="tablist" aria-label="Share audience">
          {([
            ["buyer", "Buyer / client"],
            ["creative_team", "Creative team"],
            ["external", "External party"],
          ] as Array<[ShareAudience, string]>).map(([value, label]) => (
            <button key={value} type="button" className={audience === value ? "on" : ""} onClick={() => onAudienceChange(value)}>
              {label}
            </button>
          ))}
        </div>
        <button type="button" className="check-row" onClick={onToggleCampaignNames}>
          <span className={`cb ${includeCampaignNames ? "on" : ""}`} /> Include campaign/ad set names
        </button>
        {audience === "buyer" ? (
          <button type="button" className="check-row" onClick={onToggleDecisionLanguage}>
            <span className={`cb ${includeDecisionLanguage ? "on" : ""}`} /> Include buyer decision language
          </button>
        ) : (
          <div className="check-row check-row--disabled">
            <span className="cb" /> Buyer decision language hidden for this audience
          </div>
        )}
        <button type="button" className="check-row" onClick={onToggleCsv}>
          <span className={`cb ${allowCsv ? "on" : ""}`} /> Allow CSV download
        </button>
        <div className="url-field">
          <input readOnly value={generatedShareUrl ?? "Generate a link to copy"} aria-label="Generated share URL" />
          <button type="button" className="copy" onClick={onGenerate}>
            {actionStatus === "share" ? "Creating..." : actionStatus === "copied" ? "Copied!" : "Copy"}
          </button>
        </div>
        {actionStatus === "error" ? <p className="mt-2 text-[12px] text-rose-700">Share link could not be created.</p> : null}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn--primary" onClick={generatedShareUrl ? onClose : onGenerate}>
            {generatedShareUrl ? "Done" : "Save link"}
          </button>
        </div>
      </div>
    </div>
  );
}

function buildAssetLibraryCsv(rows: MetaCreativeRow[], metricColumns: AssetMetricColumn[]) {
  const headers = ["Creative", "Campaign", "Ad set", "Label", ...metricColumns.map((column) => column.label), "Gap"];
  const body = rows.map((row) => {
    const label = rowEngineLabel(row as AssetLibraryRow) ?? "";
    const gap = rowMatchesBadge(row as AssetLibraryRow, "below_breakeven")
      ? "Below breakeven"
      : rowMatchesBadge(row as AssetLibraryRow, "fatigue")
        ? "Fatigue"
        : "no gap";
    return [
      row.name,
      row.campaignName ?? "",
      row.adSetName ?? "",
      label,
      ...metricColumns.map((column) => column.value(row)),
      gap,
    ].map(csvEscape).join(",");
  });
  return [headers.map(csvEscape).join(","), ...body].join("\n");
}

function csvEscape(value: unknown) {
  const text = safeText(value);
  if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function rowEngineLabel(row: AssetLibraryRow) {
  return row.engineLabel ?? row.decisionLabel ?? row.briefingLabel ?? null;
}

function rowCampaignLabel(row: AssetLibraryRow): LabelFilterKey {
  const value = String((row as { campaignKind?: string | null }).campaignKind ?? "").toLowerCase();
  if (value === "main") return "main";
  if (value === "test") return "test";
  if (value === "mixed") return "mixed";
  return "all";
}

function safeRows(rows: unknown): MetaCreativeRow[] {
  return Array.isArray(rows)
    ? rows.filter((row): row is MetaCreativeRow => Boolean(row && typeof row === "object"))
    : [];
}

function safeText(value: unknown) {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function safeNumber(value: unknown) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function formatMoney0(value: number) {
  return `$${Math.round(value).toLocaleString()}`;
}

function formatMoney2(value: number) {
  return `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatInteger(value: number) {
  return Math.round(value).toLocaleString();
}

function formatPercent2(value: number) {
  return `${value.toFixed(2)}%`;
}

function formatDecimal2(value: number) {
  return value.toFixed(2);
}

function safeTime(value: unknown) {
  const parsed = Date.parse(safeText(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function safeStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(safeText).filter(Boolean);
  const text = safeText(value);
  return text ? [text] : [];
}

function rowMatchesFormat(row: AssetLibraryRow, format: AssetLibraryFormatFilter) {
  const presentation = getCreativeFormatPresentation(row);
  if (format === "catalog") return presentation.isCatalog;
  if (format === "carousel") return presentation.isCarousel;
  if (format === "video") return presentation.isVideo;
  return !presentation.isVideo && !presentation.isCarousel && !presentation.isCatalog;
}

function rowMatchesCampaignLabel(row: AssetLibraryRow, filter: AssetLibraryCampaignLabelFilter) {
  if (filter === "all") return true;
  const source = [
    (row as AssetLibraryRow & { campaignKind?: string | null }).campaignKind,
    row.campaignName,
    ...safeStringArray(row.tags),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return source.includes(filter);
}

function rowPreviewPayload(row: MetaCreativeRow) {
  return row.preview ?? {
    render_mode: row.cardPreviewUrl || row.imageUrl || row.previewUrl || row.thumbnailUrl ? "image" as const : "unavailable" as const,
    image_url: row.cardPreviewUrl ?? row.imageUrl ?? row.previewUrl ?? row.thumbnailUrl ?? null,
    video_url: null,
    poster_url: row.tableThumbnailUrl ?? row.cachedThumbnailUrl ?? row.thumbnailUrl ?? null,
    source: "asset_library",
    is_catalog: row.isCatalog,
  };
}

function rowMediaFallbacks(row: MetaCreativeRow, mode: "card" | "thumb" = "card") {
  const candidates =
    mode === "thumb"
      ? [
          row.tableThumbnailUrl,
          row.cachedThumbnailUrl,
          row.thumbnailUrl,
          row.cardPreviewUrl,
          row.imageUrl,
          row.previewUrl,
          row.preview?.poster_url,
          row.preview?.image_url,
        ]
      : [
          row.cardPreviewUrl,
          row.imageUrl,
          row.previewUrl,
          row.preview?.image_url,
          row.preview?.poster_url,
          row.cachedThumbnailUrl,
          row.thumbnailUrl,
          row.tableThumbnailUrl,
        ];
  return candidates.map((value) => safeText(value).trim()).filter(Boolean);
}

function rowMatchesBadge(row: AssetLibraryRow, badge: AssetLibraryBadgeFilter) {
  const badges = [
    ...safeStringArray(row.engineBadges),
    ...safeStringArray(row.badges),
    ...safeStringArray(row.tags),
  ].map((item) => item.toLowerCase().replace(/\s+/g, "_"));
  return badges.includes(badge);
}

function rowMatchesSearch(row: AssetLibraryRow, search: string) {
  return [
    row.name,
    row.campaignName,
    row.adSetName,
    row.accountName,
    ...safeStringArray(row.tags),
  ].some((value) => safeText(value).toLowerCase().includes(search));
}

function formatCurrency(value: number, currency: string | null): string {
  if (!Number.isFinite(value) || value <= 0) return "—";
  const isoCurrency = (currency ?? "USD").toUpperCase();
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: isoCurrency,
      maximumFractionDigits: 0,
    }).format(value);
  } catch {
    return `$${Math.round(value).toLocaleString()}`;
  }
}
