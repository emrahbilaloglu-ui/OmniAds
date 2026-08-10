"use client";

import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import { CreativeRenderSurface } from "@/components/creatives/CreativeRenderSurface";
import type { MetaCreativeRow } from "@/components/creatives/metricConfig";
import type { DecisionLabel } from "@/components/common/briefing/types";
import type { BriefingCreativeCard } from "@/components/creatives/briefing/types";
import type { ShareLinkConfig } from "@/components/creatives/shareCreativeTypes";
import { getCreativeFormatPresentation } from "@/components/creatives/briefing/creative-format";
import type { AiCreativeHistoricalWindows as CreativeHistoricalWindows } from "@/lib/meta/creative-scoring";
import {
  CustomizeKpisModal,
  DateRangePicker,
  KpiSummaryTiles,
  PresetBar,
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
type AssetLibraryActionStatus = "idle" | "csv" | "share" | "saved" | "copied" | "error";
type AssetLibraryCampaignLabelFilter = "all" | "main" | "test" | "mixed";
type ShareAudience = NonNullable<ShareLinkConfig["audience"]>;
type AssetMetricGroup =
  | "commerce"
  | "efficiency"
  | "traffic"
  | "funnel"
  | "video"
  | "lead"
  | "creative_scores"
  | "ai_tags";
type MetricSummaryMode = "sum" | "avg" | "weighted_roas";
type CreativeScoreKey = "hook" | "cta" | "offer" | "click" | "watch";
type DecisionCenterRowForAssetLabel = NonNullable<
  BriefingCreativeCard["decisionCenterRow"]
>;
type DecisionCenterBuyerActionForAssetLabel =
  DecisionCenterRowForAssetLabel["buyerAction"];
type AssetLibraryLabelSource = "creative_team" | "decision_center" | "legacy";

type AssetMetricColumn = {
  id: string;
  label: string;
  shortLabel?: string;
  group: AssetMetricGroup;
  description: string;
  source: string;
  summaryMode: MetricSummaryMode;
  className?: string;
  value: (row: MetaCreativeRow) => ReactNode;
  csvValue?: (row: MetaCreativeRow) => string;
  rawValue: (row: MetaCreativeRow) => number;
  format: (value: number) => string;
  shareKey?: ShareLinkConfig["metrics"][number];
};

type CreativeTeamGapState = {
  label: string;
  severity: "none" | "watch" | "action" | "missing";
};

type ShareAudiencePreset = {
  id: string;
  title: string;
  metricIds: string[];
};

type BackendDependentMetric = {
  id: string;
  label: string;
  group: "creative_scores" | "ai_tags";
  reason: string;
  description: string;
};

export type AssetLibraryRow = MetaCreativeRow & {
  engineLabel?: DecisionLabel | string | null;
  decisionLabel?: DecisionLabel | string | null;
  briefingLabel?: DecisionLabel | string | null;
  engineBadges?: string[] | null;
  badges?: string[] | null;
  decisionCenterRow?: DecisionCenterRowForAssetLabel | null;
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
  decisionCenterUiEnabled?: boolean;
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

const STATUS_FILTERS: ReadonlyArray<{ key: AssetLibraryStatusFilter; label: string }> = [
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

const BUYER_ACTION_DISPLAY: Record<DecisionCenterBuyerActionForAssetLabel, string> = {
  scale: "Scale",
  cut: "Cut",
  refresh: "Refresh",
  protect: "Protect",
  test_more: "Test more",
  watch_launch: "Watch launch",
  fix_delivery: "Fix delivery",
  fix_policy: "Fix policy",
  diagnose_data: "Diagnose data",
};

const _buyerActionDisplayCoverage: Record<
  DecisionCenterBuyerActionForAssetLabel,
  string
> = BUYER_ACTION_DISPLAY;
void _buyerActionDisplayCoverage;

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
    description: "0-100 scores per concept · Hook / CTA / Offer / Click / Watch.",
    metricsCount: 6,
    metricChips: ["Spend", "Hook", "CTA", "Offer", "Click", "Watch"],
    metrics: ["spend", "score.hook", "score.cta", "score.offer", "score.click", "score.watch"],
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
    key: "score.hook",
    label: "Hook score",
    group: "Creative scores",
    description: "0–100 score derived from thumbstop + retention vs account baseline.",
  },
  {
    key: "score.cta",
    label: "CTA score",
    group: "Creative scores",
    description: "0–100 score for call-to-action clarity.",
  },
  {
    key: "score.offer",
    label: "Offer score",
    group: "Creative scores",
    description: "0–100 score for offer relevance.",
  },
  {
    key: "score.click",
    label: "Click score",
    group: "Creative scores",
    description: "0–100 score for click momentum.",
  },
  {
    key: "score.watch",
    label: "Watch score",
    group: "Creative scores",
    description: "0–100 score for video watch behavior.",
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
  scoreMetric("score.hook", "Hook", "0-100 account-relative hook read from the creative scoring pipeline.", "Creative scoring · hook", "hook", "hookScore"),
  scoreMetric("score.cta", "CTA", "0-100 account-relative call-to-action read from the creative scoring pipeline.", "Creative scoring · cta", "cta", "ctaScore"),
  scoreMetric("score.offer", "Offer", "0-100 account-relative offer read from the creative scoring pipeline.", "Creative scoring · offer", "offer", "offerScore"),
  scoreMetric("score.click", "Click", "0-100 account-relative click quality read from the creative scoring pipeline.", "Creative scoring · click", "click", "clickScore"),
  scoreMetric("score.watch", "Watch", "0-100 account-relative watch quality read from the creative scoring pipeline.", "Creative scoring · watch", "watch", "watchScore"),
];

export const DEFAULT_VISIBLE_METRIC_IDS = ["spend", "purchaseValue", "roas", "purchases", "cpa", "ctrAll"];

const BACKEND_DEPENDENT_METRICS: BackendDependentMetric[] = [
  { id: "ai.assetType", label: "Asset Type", group: "ai_tags", reason: "needs tagger", description: "Server-side AI tag for the creative asset category." },
  { id: "ai.visualFormat", label: "Visual Format", group: "ai_tags", reason: "needs tagger", description: "Server-side AI tag for the visual structure." },
  { id: "ai.messagingAngle", label: "Messaging Angle", group: "ai_tags", reason: "needs tagger", description: "Server-side AI tag for the core message angle." },
  { id: "ai.hookTactic", label: "Hook Tactic", group: "ai_tags", reason: "needs tagger", description: "Server-side AI tag for the opening hook tactic." },
  { id: "ai.headlineTactic", label: "Headline Tactic", group: "ai_tags", reason: "needs tagger", description: "Server-side AI tag for headline structure." },
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
    detail: "Creative feedback view. No buyer decision language in this preset.",
    metricIds: ["spend", "score.hook", "score.cta", "score.offer", "score.click", "score.watch"],
    sort: "spend_desc",
    chips: ["Spend", "Hook", "CTA", "Offer", "Click", "Watch"],
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

const EXTERNAL_SHARE_PRESET: ShareAudiencePreset = {
  id: "external_public",
  title: "External party",
  metricIds: ["spend", "roas", "purchases", "ctrAll"],
};

const METRIC_GROUP_LABELS: Record<AssetMetricGroup, string> = {
  commerce: "Commerce metrics",
  efficiency: "Efficiency metrics",
  traffic: "Traffic metrics",
  funnel: "Post-click funnel",
  video: "Video and fatigue",
  lead: "Lead and messaging",
  creative_scores: "Creative scores",
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
    csvValue: (row) => formatter(rawValue(row)),
    shareKey,
  };
}

function scoreMetric(
  id: string,
  label: string,
  description: string,
  source: string,
  scoreKey: CreativeScoreKey,
  shareKey: ShareLinkConfig["metrics"][number],
): AssetMetricColumn {
  return {
    id,
    label,
    group: "creative_scores",
    description,
    source,
    summaryMode: "avg",
    className: "num",
    rawValue: (row) => readCreativeScore(row, scoreKey) ?? Number.NaN,
    format: formatScoreValue,
    value: (row) => <CreativeScoreCell score={readCreativeScore(row, scoreKey)} label={label} />,
    csvValue: (row) => {
      const score = readCreativeScore(row, scoreKey);
      return score == null ? "unavailable" : formatScoreValue(score);
    },
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

function sharePresetForAudience(
  audience: ShareAudience,
  activePreset: ShareAudiencePreset,
): ShareAudiencePreset {
  if (audience === "creative_team") {
    return ASSET_PRESETS.find((preset) => preset.id === "creative_teams") ?? activePreset;
  }
  if (audience === "external") return EXTERNAL_SHARE_PRESET;
  return ASSET_PRESETS.find((preset) => preset.id === "ecommerce") ?? activePreset;
}

function shareDefaultsForAudience(audience: ShareAudience) {
  return {
    includeCampaignNames: audience === "buyer",
    includeDecisionLanguage: audience === "buyer",
    allowCsv: false,
  };
}

function shareMetricKeysFromColumns(columns: AssetMetricColumn[]): ShareLinkConfig["metrics"] {
  const keys = columns
    .map((column) => column.shareKey)
    .filter((key): key is ShareLinkConfig["metrics"][number] => Boolean(key));
  return keys.length > 0 ? keys : ["spend", "roas", "cpa", "ctrAll"];
}

function formatShareSnapshotTime(value: Date) {
  return value.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
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
    "creative_scores",
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
  const effectiveCount = column.group === "creative_scores" ? values.length : count;
  const value =
    column.summaryMode === "weighted_roas"
      ? weightedRoas(rows)
      : column.summaryMode === "avg"
        ? effectiveCount > 0
          ? total / effectiveCount
          : Number.NaN
        : total;
  const scoreMissing = column.group === "creative_scores" && values.length === 0;
  return {
    title: column.summaryMode === "sum" ? `Total ${column.label}` : `Avg ${column.label}`,
    scope: column.group === "creative_scores"
      ? values.length > 0
        ? `scope · ${values.length}`
        : "score unavailable"
      : count > 0
        ? `scope · ${count}`
        : "scope",
    value: column.format(value) || formatDecimal2(value),
    sub: column.group === "creative_scores"
      ? "/ 100"
      : column.id === "spend" || column.id === "purchaseValue" || column.id === "cpa" || column.id === "cpcLink" || column.id === "cpm" || column.id === "aov"
      ? currency ?? "USD"
      : column.summaryMode === "sum"
        ? "total"
        : "avg",
    micro:
      scoreMissing
        ? "scoring fields not emitted for this scope"
        : column.group === "creative_scores"
          ? "backend score average across scored creatives"
          : column.summaryMode === "weighted_roas"
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
  options?: { decisionCenterUiEnabled?: boolean },
) {
  const search = filters.search.trim().toLowerCase();
  const decisionCenterUiEnabled = options?.decisionCenterUiEnabled ?? false;
  return safeRows(rows).filter((row) => {
    const extended = row as AssetLibraryRow;
    if (filters.status === "active" && extended.effectiveStatus !== "ACTIVE") return false;
    if (filters.status === "closed_30d" && extended.effectiveStatus === "ACTIVE") return false;
    if (filters.formats.length > 0 && !filters.formats.some((format) => rowMatchesFormat(extended, format))) return false;
    if (
      filters.labels.length > 0 &&
      !filters.labels.includes(
        rowEffectiveDecisionLabel(extended, decisionCenterUiEnabled) as DecisionLabel,
      )
    ) return false;
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
  decisionCenterUiEnabled = false,
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
  const [shareCreatedAt, setShareCreatedAt] = useState<Date | null>(null);
  const [actionStatus, setActionStatus] = useState<AssetLibraryActionStatus>("idle");

  const filteredRows = useMemo(
    () =>
      sortAssetLibraryRows(
        filterAssetLibraryRows(rows, filters, { decisionCenterUiEnabled }),
        filters.sort,
      ),
    [decisionCenterUiEnabled, filters, rows],
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
  const visibleMetricIds = useMemo(
    () => visibleMetricColumns.map((column) => column.id),
    [visibleMetricColumns],
  );
  const isCreativeTeamPreset = visibleMetricIds.some((metricId) => metricId.startsWith("score."));
  const draftMetricColumns = useMemo(
    () => columnsForMetricIds(draftMetricIds),
    [draftMetricIds],
  );
  const actionRowsLabel = selectedRows.length > 0 ? "selected" : "visible";
  const activePreset = ASSET_PRESETS.find((preset) =>
    !preset.unavailable &&
    preset.metricIds.join("|") === visibleMetricIds.join("|"),
  ) ?? CUSTOM_PRESET;
  const sharePreset = useMemo(
    () => sharePresetForAudience(shareAudience, activePreset),
    [activePreset, shareAudience],
  );
  const shareMetricColumns = useMemo(
    () => columnsForMetricIds(sharePreset.metricIds),
    [sharePreset.metricIds],
  );
  const shareMetricKeys = useMemo(
    () => shareMetricKeysFromColumns(shareMetricColumns),
    [shareMetricColumns],
  );
  const shareSnapshotLabel = shareCreatedAt
    ? `frozen at ${formatShareSnapshotTime(shareCreatedAt)}`
    : "freezes when link is created";
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
    const csv = buildAssetLibraryCsv(actionRows, visibleMetricColumns, { decisionCenterUiEnabled });
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

  const resetGeneratedShareLink = () => {
    setGeneratedShareUrl(null);
    setShareCreatedAt(null);
  };

  const openShareModal = () => {
    const inferredAudience: ShareAudience = activePreset.id === "creative_teams" ? "creative_team" : "buyer";
    const defaults = shareDefaultsForAudience(inferredAudience);
    setShareAudience(inferredAudience);
    setIncludeCampaignNames(defaults.includeCampaignNames);
    setIncludeDecisionLanguage(defaults.includeDecisionLanguage);
    setAllowCsv(defaults.allowCsv);
    setActionStatus("idle");
    resetGeneratedShareLink();
    setShareOpen(true);
  };

  const updateShareAudience = (audience: ShareAudience) => {
    const defaults = shareDefaultsForAudience(audience);
    setShareAudience(audience);
    setIncludeCampaignNames(defaults.includeCampaignNames);
    setIncludeDecisionLanguage(defaults.includeDecisionLanguage);
    setAllowCsv(defaults.allowCsv);
    resetGeneratedShareLink();
  };

  const copyShareUrl = async (url: string) => {
    await navigator.clipboard?.writeText(url).catch(() => null);
  };

  const shareRows = async ({
    copy,
    closeAfter = false,
  }: {
    copy: boolean;
    closeAfter?: boolean;
  }) => {
    if (!onShareRows || actionRows.length === 0) return;
    if (generatedShareUrl) {
      if (copy) {
        await copyShareUrl(generatedShareUrl);
        setActionStatus("copied");
      } else {
        setActionStatus("saved");
      }
      if (closeAfter) setShareOpen(false);
      window.setTimeout(() => setActionStatus("idle"), 1800);
      return;
    }
    setActionStatus("share");
    try {
      const result = await onShareRows(actionRows, sharePreset.metricIds, {
        title: "Asset Library view",
        expiration: "7",
        metrics: shareMetricKeys,
        includeNotes: false,
        audience: shareAudience,
        presetId: sharePreset.id,
        presetLabel: sharePreset.title,
        includeCampaignNames,
        includeDecisionLanguage: shareAudience === "buyer" && includeDecisionLanguage,
        allowCsv,
        snapshotOnly: true,
      });
      setGeneratedShareUrl(result.url);
      setShareCreatedAt(new Date());
      if (copy) await copyShareUrl(result.url);
      setActionStatus(copy ? "copied" : "saved");
      if (closeAfter) setShareOpen(false);
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
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400 inline-block shrink-0" size={14} aria-hidden="true" />
          <input
            type="search"
            value={filters.search}
            onChange={(event) => setFilters((current) => ({ ...current, search: event.currentTarget.value }))}
            placeholder="creative / campaign / ad set"
            className="w-full rounded-md border border-neutral-200 bg-white py-1.5 pl-9 pr-3 text-[12.5px] text-neutral-900 placeholder:text-neutral-400 focus:outline-none"
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
          onClick={openShareModal}
        >
          {actionStatus === "share" ? "Sharing..." : actionStatus === "copied" ? "Copied link" : actionStatus === "saved" ? "Link created" : actionStatus === "error" ? "Share failed" : "↗ Share view…"}
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
        <table className={`asset-table ${isCreativeTeamPreset ? "asset-table--creative-team" : ""}`}>
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
                const resolvedLabel = resolveAssetLibraryRowLabel(
                  row as AssetLibraryRow,
                  {
                    creativeTeamPreset: isCreativeTeamPreset,
                    decisionCenterUiEnabled,
                  },
                );
                const label = resolvedLabel.label;
                const format = getCreativeFormatPresentation(row);
                const gap = isCreativeTeamPreset
                  ? creativeTeamGap(row)
                  : buyerGap(row as AssetLibraryRow);
                const rowMeta = [formatLaunchAge(row.launchDate), format.detailLabel].filter(Boolean).join(" · ");
                const labelClass = creativeLabelChipClass(label);
                const gapClass = typeof gap === "string"
                  ? buyerGapChipClass(gap)
                  : creativeGapChipClass(gap);
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
                        <span className="name-text"><b>{row.name}</b><span>{rowMeta || "—"}</span></span>
                      </span>
                    </td>
                    <td>
                      <span
                        className={labelClass}
                        data-testid="asset-library-row-label"
                        data-row-id={row.id}
                        data-decision-center-label={
                          resolvedLabel.source === "decision_center"
                            ? "true"
                            : undefined
                        }
                      >
                        <span className="dot" />{safeText(label) || "Main"}
                      </span>
                    </td>
                    {visibleMetricColumns.map((column) => (
                      <td key={column.id} className={column.className}>{column.value(row)}</td>
                    ))}
                    <td><span className={gapClass} style={{ fontSize: 12 }}>{typeof gap === "string" ? gap : gap.label}</span></td>
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
          presetTitle={sharePreset.title}
          rowScopeLabel={actionRowsLabel}
          dateRangeLabel={dateRangeLabel}
          dateRangeDetail={dateRangeDetail}
          snapshotLabel={shareSnapshotLabel}
          actionStatus={actionStatus}
          rowCount={actionRows.length}
          onAudienceChange={updateShareAudience}
          onToggleCampaignNames={() => {
            setIncludeCampaignNames((value) => !value);
            resetGeneratedShareLink();
          }}
          onToggleDecisionLanguage={() => {
            if (shareAudience !== "buyer") return;
            setIncludeDecisionLanguage((value) => !value);
            resetGeneratedShareLink();
          }}
          onToggleCsv={() => {
            setAllowCsv((value) => !value);
            resetGeneratedShareLink();
          }}
          onSaveLink={() => void shareRows({ copy: false })}
          onCopyLink={() => void shareRows({ copy: true })}
          onCopyAndClose={() => void shareRows({ copy: true, closeAfter: true })}
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

export function ShareViewModal({
  audience,
  includeCampaignNames,
  includeDecisionLanguage,
  allowCsv,
  generatedShareUrl,
  presetTitle,
  rowScopeLabel,
  dateRangeLabel,
  dateRangeDetail,
  snapshotLabel,
  actionStatus,
  rowCount,
  onAudienceChange,
  onToggleCampaignNames,
  onToggleDecisionLanguage,
  onToggleCsv,
  onSaveLink,
  onCopyLink,
  onCopyAndClose,
  onClose,
}: {
  audience: ShareAudience;
  includeCampaignNames: boolean;
  includeDecisionLanguage: boolean;
  allowCsv: boolean;
  generatedShareUrl: string | null;
  presetTitle: string;
  rowScopeLabel: string;
  dateRangeLabel: string;
  dateRangeDetail?: string;
  snapshotLabel: string;
  actionStatus: AssetLibraryActionStatus;
  rowCount: number;
  onAudienceChange: (audience: ShareAudience) => void;
  onToggleCampaignNames: () => void;
  onToggleDecisionLanguage: () => void;
  onToggleCsv: () => void;
  onSaveLink: () => void;
  onCopyLink: () => void;
  onCopyAndClose: () => void;
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
        <p className="share-modal__sub">
          {rowCount} {rowScopeLabel} creatives · preset = {presetTitle} · window = {dateRangeLabel}
        </p>
        {dateRangeDetail ? <p className="share-modal__hint">{dateRangeDetail}</p> : null}
        <div className="share-modal__section-label">Who is this for?</div>
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
        <p className="share-modal__hint">Preset auto-switches to match audience. Buyer = Ecommerce. Creative = Creative teams. External = no labels, no campaign IDs.</p>
        <div className="share-modal__section-label">What gets shared</div>
        <div className="check-row">
          <span className="cb on" /> {rowCount} {rowScopeLabel} creatives (thumbs · scores · gaps)
        </div>
        <div className="check-row">
          <span className="cb on" /> KPI summary (account benchmark only · no goal numbers)
        </div>
        <button type="button" className="check-row" onClick={onToggleCampaignNames}>
          <span className={`cb ${includeCampaignNames ? "on" : ""}`} /> Show campaign names
        </button>
        <button type="button" className="check-row" onClick={onToggleCsv}>
          <span className={`cb ${allowCsv ? "on" : ""}`} /> Allow recipient to download CSV
        </button>
        {audience === "buyer" ? (
          <button type="button" className="check-row" onClick={onToggleDecisionLanguage}>
            <span className={`cb ${!includeDecisionLanguage ? "on" : ""}`} /> Hide all decision language (Cut / Scale / Promote)
          </button>
        ) : (
          <div className="check-row check-row--disabled check-row--locked">
            <span className="cb on" /> Hide all decision language (Cut / Scale / Promote)
          </div>
        )}
        <div className="share-modal__section-label share-modal__section-label--link">Link</div>
        <div className="url-field">
          <input readOnly value={generatedShareUrl ?? "Link will be created after Save link"} aria-label="Generated share URL" />
          <button type="button" className="copy" onClick={onCopyLink} disabled={actionStatus === "share"}>
            {actionStatus === "share" ? "Creating..." : actionStatus === "copied" ? "Copied!" : generatedShareUrl ? "Copy" : "Create & copy"}
          </button>
        </div>
        <div className="share-modal__meta">
          <span>Expires · <b>7 days</b></span>
          <span>Snapshot · <b>{snapshotLabel}</b></span>
          <span>Open count · <b>0</b></span>
        </div>
        {actionStatus === "error" ? <p className="mt-2 text-[12px] text-rose-700">Share link could not be created.</p> : null}
        <div className="share-modal__footer">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <div className="share-modal__footer-actions">
            <button type="button" className="btn" onClick={onSaveLink} disabled={actionStatus === "share"}>
              {generatedShareUrl || actionStatus === "saved" ? "Saved" : "Save link"}
            </button>
            <button type="button" className="btn btn--primary" onClick={onCopyAndClose} disabled={actionStatus === "share"}>
              {actionStatus === "share" ? "Creating..." : "Copy & close"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function buildAssetLibraryCsv(
  rows: MetaCreativeRow[],
  metricColumns: AssetMetricColumn[],
  options?: { decisionCenterUiEnabled?: boolean },
) {
  const headers = ["Creative", "Campaign", "Ad set", "Label", ...metricColumns.map((column) => column.label), "Gap"];
  const isCreativeTeamCsv = metricColumns.some((column) => column.id.startsWith("score."));
  const body = rows.map((row) => {
    // Same resolution as the rendered table cell, so an exported CSV never
    // disagrees with what the operator saw on screen.
    const label =
      resolveAssetLibraryRowLabel(row as AssetLibraryRow, {
        creativeTeamPreset: isCreativeTeamCsv,
        decisionCenterUiEnabled: options?.decisionCenterUiEnabled ?? false,
      }).label ?? "";
    const gap = isCreativeTeamCsv
      ? creativeTeamGap(row)
      : buyerGap(row as AssetLibraryRow);
    return [
      row.name,
      row.campaignName ?? "",
      row.adSetName ?? "",
      label,
      ...metricColumns.map((column) => column.csvValue?.(row) ?? column.value(row)),
      typeof gap === "string" ? gap : gap.label,
    ].map(csvEscape).join(",");
  });
  return [headers.map(csvEscape).join(","), ...body].join("\n");
}

function csvEscape(value: unknown) {
  const text = safeText(value);
  if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function CreativeScoreCell({
  score,
  label,
}: {
  score: number | null;
  label: string;
}) {
  if (score == null) {
    return (
      <span className="score missing" aria-label={`${label} score unavailable`}>
        <span className="gauge" aria-hidden="true"><i style={{ width: "0%" }} /></span>
        —
      </span>
    );
  }
  const normalized = clamp(score, 0, 100);
  const tone = normalized < 40 ? "lo" : normalized < 65 ? "mid" : "hi";
  return (
    <span className={`score ${tone}`} aria-label={`${label} score ${Math.round(normalized)} of 100`}>
      <span className="gauge" aria-hidden="true"><i style={{ width: `${normalized}%` }} /></span>
      {Math.round(normalized)}
    </span>
  );
}

function buyerActionDisplay(value: unknown) {
  if (typeof value !== "string") return null;
  return Object.prototype.hasOwnProperty.call(BUYER_ACTION_DISPLAY, value)
    ? BUYER_ACTION_DISPLAY[value as DecisionCenterBuyerActionForAssetLabel]
    : null;
}

export function resolveAssetLibraryRowLabel(
  row: AssetLibraryRow,
  input: {
    creativeTeamPreset: boolean;
    decisionCenterUiEnabled: boolean;
  },
): { label: string | null; source: AssetLibraryLabelSource } {
  if (input.creativeTeamPreset) {
    return { label: creativeTeamLabel(row), source: "creative_team" };
  }
  if (input.decisionCenterUiEnabled && row.decisionCenterRow) {
    const buyerLabel = safeText(row.decisionCenterRow.buyerLabel).trim();
    return {
      label:
        buyerLabel ||
        buyerActionDisplay(row.decisionCenterRow.buyerAction) ||
        "Decision Center",
      source: "decision_center",
    };
  }
  return { label: rowEngineLabel(row), source: "legacy" };
}

function rowEngineLabel(row: AssetLibraryRow) {
  return row.engineLabel ?? row.decisionLabel ?? row.briefingLabel ?? null;
}

// DecisionLabel-space projection of the decision-center buyer action so the
// label filter compares against the same decision the row displays.
const BUYER_ACTION_TO_DECISION_LABEL: Record<
  DecisionCenterBuyerActionForAssetLabel,
  DecisionLabel
> = {
  scale: "scale",
  cut: "cut",
  refresh: "refresh",
  protect: "keep",
  test_more: "test_more",
  watch_launch: "test_more",
  fix_delivery: "diagnose",
  fix_policy: "diagnose",
  diagnose_data: "diagnose",
};

export function rowEffectiveDecisionLabel(
  row: AssetLibraryRow,
  decisionCenterUiEnabled: boolean,
) {
  if (decisionCenterUiEnabled && row.decisionCenterRow) {
    return BUYER_ACTION_TO_DECISION_LABEL[row.decisionCenterRow.buyerAction] ?? null;
  }
  return rowEngineLabel(row);
}

function creativeTeamLabel(row: AssetLibraryRow) {
  const label = rowCampaignLabel(row);
  if (label === "main") return "Main";
  if (label === "test") return "Test";
  if (label === "mixed") return "Mixed";
  return "Unlabeled";
}

function creativeLabelChipClass(label: string | null) {
  const normalized = safeText(label).toLowerCase();
  if (normalized === "test" || normalized === "test_more") return "chip chip--info";
  if (normalized === "mixed") return "chip chip--warn";
  if (normalized === "cut" || normalized === "below_breakeven") return "chip chip--action";
  if (normalized === "unlabeled") return "chip chip--ghost";
  return "chip";
}

function rowCampaignLabel(row: AssetLibraryRow): AssetLibraryCampaignLabelFilter {
  const value = String((row as { campaignKind?: string | null }).campaignKind ?? "").toLowerCase();
  if (value === "main") return "main";
  if (value === "test") return "test";
  if (value === "mixed") return "mixed";
  return "all";
}

function buyerGap(row: AssetLibraryRow) {
  return rowMatchesBadge(row, "below_breakeven")
    ? "Below breakeven"
    : rowMatchesBadge(row, "fatigue")
      ? "Fatigue"
      : "no gap";
}

function creativeTeamGap(row: MetaCreativeRow): CreativeTeamGapState {
  const serverGap = readCreativeScoreGap(row);
  if (serverGap) return serverGap;
  const hasScores = (["hook", "cta", "offer", "click", "watch"] as CreativeScoreKey[])
    .some((scoreKey) => readCreativeScore(row, scoreKey) != null);
  return hasScores
    ? { label: "gap pending", severity: "missing" }
    : { label: "score unavailable", severity: "missing" };
}

function buyerGapChipClass(gap: string) {
  if (gap === "no gap") return "chip chip--ghost";
  if (gap === "Fatigue") return "chip chip--watch";
  return "chip chip--action";
}

function creativeGapChipClass(gap: CreativeTeamGapState) {
  if (gap.severity === "action") return "chip chip--action";
  if (gap.severity === "watch") return "chip chip--watch";
  return "chip chip--ghost";
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

function safeScoreNumber(value: unknown): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(parsed)) return null;
  return clamp(parsed, 0, 100);
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function formatScoreValue(value: number) {
  return Number.isFinite(value) ? String(Math.round(clamp(value, 0, 100))) : "—";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readNestedScore(source: Record<string, unknown>, key: CreativeScoreKey): number | null {
  const nestedContainers = [
    "creativeScores",
    "creative_scores",
    "scores",
    "score",
    "aiScores",
    "ai_scores",
    "creativeScore",
    "creative_score",
  ];
  const nestedKeys: Record<CreativeScoreKey, string[]> = {
    hook: ["hook", "hookScore", "hook_score"],
    cta: ["cta", "ctaScore", "cta_score"],
    offer: ["offer", "offerScore", "offer_score"],
    click: ["click", "clickScore", "click_score"],
    watch: ["watch", "watchScore", "watch_score"],
  };
  for (const containerKey of nestedContainers) {
    const container = asRecord(source[containerKey]);
    if (!container) continue;
    for (const nestedKey of nestedKeys[key]) {
      const parsed = safeScoreNumber(container[nestedKey]);
      if (parsed != null) return parsed;
    }
  }
  return null;
}

function normalizeCreativeGapSeverity(value: unknown): CreativeTeamGapState["severity"] {
  const text = safeText(value).toLowerCase();
  if (text === "action" || text === "critical" || text === "gap") return "action";
  if (text === "watch" || text === "soft" || text === "warning") return "watch";
  if (text === "none" || text === "ok") return "none";
  return "missing";
}

function readCreativeScoreGap(row: MetaCreativeRow): CreativeTeamGapState | null {
  const source = row as MetaCreativeRow & Record<string, unknown>;
  const objectCandidates = [
    source.creativeScoreGap,
    source.creative_score_gap,
    source.scoreGap,
    source.score_gap,
    source.gap,
  ];
  for (const candidate of objectCandidates) {
    const gap = asRecord(candidate);
    if (!gap) continue;
    const label = safeText(gap.label ?? gap.name ?? gap.value).trim();
    if (!label) continue;
    return {
      label,
      severity: normalizeCreativeGapSeverity(gap.severity ?? gap.tone ?? gap.kind),
    };
  }
  const directLabel = [
    source.creativeScoreGapLabel,
    source.creative_score_gap_label,
    source.scoreGapLabel,
    source.score_gap_label,
    source.gapLabel,
    source.gap_label,
  ]
    .map((value) => safeText(value).trim())
    .find(Boolean);
  if (!directLabel) return null;
  return {
    label: directLabel,
    severity: normalizeCreativeGapSeverity(source.creativeScoreGapSeverity ?? source.scoreGapSeverity ?? source.gapSeverity),
  };
}

function readCreativeScore(row: MetaCreativeRow, key: CreativeScoreKey): number | null {
  const source = row as MetaCreativeRow & Record<string, unknown>;
  const directKeys: Record<CreativeScoreKey, string[]> = {
    hook: ["hookScore", "hook_score", "scoreHook", "score_hook", "creativeHookScore", "creative_hook_score"],
    cta: ["ctaScore", "cta_score", "scoreCta", "score_cta", "creativeCtaScore", "creative_cta_score"],
    offer: ["offerScore", "offer_score", "scoreOffer", "score_offer", "creativeOfferScore", "creative_offer_score"],
    click: ["clickScore", "click_score", "scoreClick", "score_click", "creativeClickScore", "creative_click_score"],
    watch: ["watchScore", "watch_score", "scoreWatch", "score_watch", "creativeWatchScore", "creative_watch_score"],
  };
  for (const directKey of directKeys[key]) {
    const parsed = safeScoreNumber(source[directKey]);
    if (parsed != null) return parsed;
  }
  return readNestedScore(source, key);
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

function formatLaunchAge(value: unknown) {
  const time = safeTime(value);
  if (!time) return "";
  const days = Math.max(0, Math.floor((Date.now() - time) / 86_400_000));
  if (days < 1) return "today";
  if (days <= 90) return `${days}d`;
  return safeText(value).slice(0, 10);
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
