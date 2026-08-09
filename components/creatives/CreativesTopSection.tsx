"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Trophy, ChevronDown, ChevronRight, X, Search, Plus, SlidersHorizontal, Check, Copy, FileDown, Link2 } from "lucide-react";
import { createPortal } from "react-dom";
import { MetaCreativeRow } from "@/components/creatives/metricConfig";
import { CreativeRenderSurface } from "@/components/creatives/CreativeRenderSurface";
import { CreativeDecisionLabelBadge } from "@/components/creatives/CreativeDecisionLabelBadge";
import {
  calculateCreativeAverageOrderValue,
  calculateCreativeClickToAddToCartRate,
  calculateCreativeClickToPurchaseRate,
  calculateCreativeCpcAll,
  calculateCreativeLinkCtr,
  calculateCreativePurchaseValueShare,
  calculateCreativePurchasesPer1000Impressions,
  calculateCreativeRevenuePer1000Impressions,
  calculateCreativeSpendShare,
} from "@/components/creatives/creative-truth";
import { resolveCreativeCurrency } from "@/components/creatives/money";
import { getCreativeFormatSummaryLabel } from "@/lib/meta/creative-taxonomy";
import { getCreativeStaticPreviewSources, getCreativeStaticPreviewState } from "@/lib/meta/creatives-preview";
import {
  applyCreativeFilters,
  buildMonthGrid,
  creativeDateRangeToStandard,
  DEFAULT_COPY_TOP_METRIC_IDS,
  DEFAULT_CREATIVE_DATE_RANGE,
  DEFAULT_TOP_METRIC_IDS,
  fmtCurrency,
  fmtInteger,
  fmtPercent,
  formatDate,
  formatCreativeDateLabel,
  mapCreativeGroupByToApi,
  moveMonth,
  nextMonth,
  normalizeRange,
  prettyFieldLabel,
  prettyOperatorLabel,
  resolveCreativeDateRange,
  selectCalendarDate,
  standardDateRangeToCreative,
} from "@/components/creatives/creatives-top-section-support";
import { toHeatCellStyle } from "@/components/creatives/creatives-table-support";
import {
  buildCreativeTableHeatBenchmark,
  evaluateCreativeMetricPreviewHeat,
} from "@/components/creatives/CreativesTableSection";
import { DateRangePicker } from "@/components/date-range/DateRangePicker";
import { cn } from "@/lib/utils";
import { useDropdownBehavior } from "@/hooks/use-dropdown-behavior";
import type {
  DecisionLabel,
  DecisionOutput,
  EngineV3Flags,
} from "@/lib/creative-decision-engine";
import type { ReactNode } from "react";

export type CreativeGroupBy = "adName" | "creative" | "copy" | "headline" | "landingPage" | "campaign" | "adSet";

export type CreativeDatePreset =
  | "today"
  | "yesterday"
  | "thisWeek"
  | "thisMonth"
  | "lastWeek"
  | "lastMonth"
  | "last7Days"
  | "last14Days"
  | "last30Days"
  | "last365Days"
  | "custom"
  | "last"
  | "since";

export interface CreativeDateRangeValue {
  preset: CreativeDatePreset;
  customStart: string;
  customEnd: string;
  lastDays: number;
  sinceDate: string;
}

export interface CreativeFilterRule {
  id: string;
  field: CreativeFilterField;
  operator?: CreativeFilterOperator;
  query: string;
}

export type CreativeFilterOperator = "contains" | "equals" | "not_equals" | "starts_with" | "before" | "after";

export type CreativeFilterField =
  | "campaignName"
  | "adSetName"
  | "adName"
  | "adSetup"
  | "landingPage"
  | "launchDate"
  | "performanceMetrics"
  | "creativePrimaryLabel"
  | "creativeSecondaryLabel"
  | "creativeVisualFormat"
  | "creativeDeliveryType"
  | "taxonomySource"
  | "isCatalog"
  | "namingConvention"
  | "customTags"
  | "assetType"
  | "visualFormat"
  | "intendedAudience"
  | "messagingAngle"
  | "seasonality"
  | "offerType"
  | "hookTactic"
  | "headlineTactic";

type GoodDirection = "high" | "low" | "neutral";

export interface CreativeMetricDefinition {
  id: string;
  label: string;
  direction: GoodDirection;
  format: (n: number, rowCurrency?: string | null, defaultCurrency?: string | null) => string;
  getValue: (row: MetaCreativeRow, context: CreativeMetricContext) => number;
}

interface CreativeMetricContext {
  totalSpend: number;
  totalPurchaseValue: number;
}

interface CreativesTopSectionProps {
  businessId?: string;
  showHeader?: boolean;
  showGroupByControl?: boolean;
  dateRange: CreativeDateRangeValue;
  onDateRangeChange: (next: CreativeDateRangeValue) => void;
  groupBy: CreativeGroupBy;
  onGroupByChange: (next: CreativeGroupBy) => void;
  filters: CreativeFilterRule[];
  onFiltersChange: (next: CreativeFilterRule[]) => void;
  selectedMetricIds: string[];
  onSelectedMetricIdsChange: (next: string[]) => void;
  selectedRows: MetaCreativeRow[];
  allRowsForHeatmap: MetaCreativeRow[];
  benchmarkRows?: MetaCreativeRow[];
  defaultCurrency: string | null;
  onOpenRow: (rowId: string) => void;
  onShareExport: () => void;
  onCsvExport: () => void;
  title?: string;
  description?: string;
  groupByOptions?: Array<{ value: CreativeGroupBy; label: string }>;
  previewMode?: "media" | "copy";
  getPreviewCopyText?: (row: MetaCreativeRow) => string;
  shareExportLoading?: boolean;
  csvExportLoading?: boolean;
  shareUrl?: string | null;
  shareError?: string | null;
  csvError?: string | null;
  previewStripState?: "data_loading" | "ready" | "missing";
  previewStripSummary?: {
    total: number;
    ready: number;
    pending: number;
    missing: number;
    minimumReady: number;
  };
  v3Decisions?: DecisionOutput[] | null;
  v3Flags?: EngineV3Flags | null;
  filterBarSlot?: ReactNode;
  actionsPrefix?: ReactNode;
  belowToolbar?: ReactNode;
}

const GROUP_BY_OPTIONS: Array<{ value: CreativeGroupBy; label: string }> = [
  { value: "adName", label: "Ad Name" },
  { value: "creative", label: "Creative" },
  { value: "copy", label: "Copy" },
  { value: "headline", label: "Headline" },
  { value: "campaign", label: "Campaign" },
  { value: "adSet", label: "Ad Set" },
  { value: "landingPage", label: "Landing Page" },
];

function PreviewStripMediaSurface({
  row,
  assetState,
  assetFallbacks,
  assetUpgradeSources,
  shouldUnlockPreview,
  onAdvance,
}: {
  row: MetaCreativeRow;
  assetState: "ready" | "pending" | "missing";
  assetFallbacks: Array<string | null>;
  assetUpgradeSources: Array<string | null>;
  shouldUnlockPreview: boolean;
  onAdvance: () => void;
}) {
  return shouldUnlockPreview ? (
    <CreativeRenderSurface
      id={row.id}
      name={row.name}
      preview={row.preview}
      size="card"
      mode="asset"
      assetState={assetState}
      assetFallbacks={assetFallbacks}
      assetUpgradeSources={assetUpgradeSources}
      pendingLabel="Waiting for Meta"
      className="aspect-square w-full"
      onAssetSettled={onAdvance}
    />
  ) : (
    <div className="h-full w-full animate-pulse bg-neutral-100" />
  );
}

const FILTER_TREE: Array<{ label: string; children: Array<{ label: string; value: CreativeFilterField }> }> = [
  {
    label: "Names",
    children: [
      { label: "Campaign name", value: "campaignName" },
      { label: "Ad set name", value: "adSetName" },
      { label: "Ad name", value: "adName" },
    ],
  },
  {
    label: "Setup",
    children: [
      { label: "Ad setup", value: "adSetup" },
      { label: "Landing page", value: "landingPage" },
      { label: "Launch date", value: "launchDate" },
    ],
  },
  {
    label: "Taxonomy",
    children: [
      { label: "Primary label", value: "creativePrimaryLabel" },
      { label: "Secondary label", value: "creativeSecondaryLabel" },
      { label: "Visual format", value: "creativeVisualFormat" },
      { label: "Delivery type", value: "creativeDeliveryType" },
      { label: "Taxonomy source", value: "taxonomySource" },
      { label: "Is catalog", value: "isCatalog" },
    ],
  },
  {
    label: "AI tags",
    children: [
      { label: "Asset type", value: "assetType" },
      { label: "Visual format", value: "visualFormat" },
      { label: "Intended audience", value: "intendedAudience" },
      { label: "Messaging angle", value: "messagingAngle" },
      { label: "Seasonality", value: "seasonality" },
      { label: "Offer type", value: "offerType" },
      { label: "Hook tactic", value: "hookTactic" },
      { label: "Headline tactic", value: "headlineTactic" },
    ],
  },
  {
    label: "Performance",
    children: [{ label: "Performance metrics", value: "performanceMetrics" }],
  },
  {
    label: "Other",
    children: [
      { label: "Naming convention", value: "namingConvention" },
      { label: "Custom tags", value: "customTags" },
    ],
  },
];

const PRESET_OPTIONS: Array<{ value: CreativeDatePreset; label: string }> = [
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "thisWeek", label: "This week" },
  { value: "thisMonth", label: "This month" },
  { value: "lastWeek", label: "Last week" },
  { value: "lastMonth", label: "Last month" },
  { value: "last7Days", label: "Last 7 days" },
  { value: "last14Days", label: "Last 14 days" },
  { value: "last30Days", label: "Last 30 days" },
  { value: "last365Days", label: "Last 365 days" },
  { value: "custom", label: "Custom" },
  { value: "last", label: "Last..." },
  { value: "since", label: "Since..." },
];

// Reference Creative Studio (02 Creative Studio.dc.html) is monochrome — the
// selected-metric chips are differentiated by their index number + name, not by
// categorical colour. Neutralized to a single neutral token (the creatives page
// remaps these neutrals to the --adc reference palette in its scoped style).
const METRIC_COLOR_TOKENS = ["bg-neutral-100 text-neutral-700"];

const METRIC_DEFS: CreativeMetricDefinition[] = [
  { id: "spend", label: "Spend", direction: "neutral", format: fmtCurrency, getValue: (r) => r.spend },
  { id: "roas", label: "ROAS", direction: "high", format: (n) => n.toFixed(2), getValue: (r) => r.roas },
  { id: "hookScore", label: "Hook proxy (thumbstop)", direction: "high", format: fmtPercent, getValue: (r) => r.thumbstop },
  {
    id: "purchaseValueShare",
    label: "% purchase value",
    direction: "high",
    format: fmtPercent,
    getValue: (r, c) => calculateCreativePurchaseValueShare(r, c.totalPurchaseValue),
  },
  { id: "purchases", label: "Purchases", direction: "high", format: fmtInteger, getValue: (r) => r.purchases },
  { id: "purchaseValue", label: "Purchase value", direction: "high", format: fmtCurrency, getValue: (r) => r.purchaseValue },
  { id: "costPerPurchase", label: "Cost per purchase", direction: "low", format: fmtCurrency, getValue: (r) => r.cpa },
  { id: "costPerLinkClick", label: "Cost per link click", direction: "low", format: fmtCurrency, getValue: (r) => r.cpcLink },
  { id: "costPerMille", label: "Cost per mille", direction: "low", format: fmtCurrency, getValue: (r) => r.cpm },
  { id: "costPerClickAll", label: "Cost per click (all)", direction: "low", format: fmtCurrency, getValue: (r) => calculateCreativeCpcAll(r) },
  {
    id: "averageOrderValue",
    label: "Average order value",
    direction: "high",
    format: fmtCurrency,
    getValue: (r) => calculateCreativeAverageOrderValue(r),
  },
  { id: "clickToAtcRatio", label: "Click to add-to-cart ratio", direction: "high", format: fmtPercent, getValue: (r) => calculateCreativeClickToAddToCartRate(r) },
  { id: "atcToPurchaseRatio", label: "Add-to-cart to purchase ratio", direction: "high", format: fmtPercent, getValue: (r) => r.atcToPurchaseRatio },
  { id: "firstFrameRetention", label: "First-impression proxy (thumbstop)", direction: "high", format: fmtPercent, getValue: (r) => r.thumbstop },
  { id: "thumbstopRatio", label: "Thumbstop ratio", direction: "high", format: fmtPercent, getValue: (r) => r.thumbstop },
  { id: "ctrOutbound", label: "Link CTR (compat)", direction: "high", format: fmtPercent, getValue: (r) => calculateCreativeLinkCtr(r) },
  { id: "clickToPurchaseRatio", label: "Click to purchase ratio", direction: "high", format: fmtPercent, getValue: (r) => calculateCreativeClickToPurchaseRate(r) },
  { id: "ctrAll", label: "Click through rate (all)", direction: "high", format: fmtPercent, getValue: (r) => r.ctrAll },
  { id: "video25Rate", label: "25% video plays (rate)", direction: "high", format: fmtPercent, getValue: (r) => r.video25 },
  { id: "video50Rate", label: "50% video plays (rate)", direction: "high", format: fmtPercent, getValue: (r) => r.video50 },
  { id: "video75Rate", label: "75% video plays (rate)", direction: "high", format: fmtPercent, getValue: (r) => r.video75 },
  { id: "video100Rate", label: "100% video plays (rate)", direction: "high", format: fmtPercent, getValue: (r) => r.video100 },
  { id: "holdRate", label: "Completion proxy (100% plays)", direction: "high", format: fmtPercent, getValue: (r) => r.video100 },
  { id: "watchScore", label: "Watch proxy (50% plays)", direction: "high", format: fmtPercent, getValue: (r) => r.video50 },
  { id: "clickScore", label: "Click proxy (CTR all x10)", direction: "high", format: (n) => n.toFixed(2), getValue: (r) => r.ctrAll * 10 },
  { id: "convertScore", label: "Conversion proxy (ROAS x10)", direction: "high", format: (n) => n.toFixed(2), getValue: (r) => r.roas * 10 },
  {
    id: "averageOrderValueWebsite",
    label: "Average order value (website)",
    direction: "high",
    format: fmtCurrency,
    getValue: (r) => calculateCreativeAverageOrderValue(r),
  },
  {
    id: "impressions",
    label: "Impressions",
    direction: "high",
    format: fmtInteger,
    getValue: (r) => r.impressions,
  },
  {
    id: "spendShare",
    label: "% spend",
    direction: "neutral",
    format: fmtPercent,
    getValue: (r, c) => calculateCreativeSpendShare(r, c.totalSpend),
  },
  {
    id: "linkCtr",
    label: "Link CTR",
    direction: "high",
    format: fmtPercent,
    getValue: (r) => calculateCreativeLinkCtr(r),
  },
  { id: "websitePurchaseRoas", label: "Website purchase ROAS", direction: "high", format: (n) => n.toFixed(2), getValue: (r) => r.roas },
  { id: "clickToWebsitePurchaseRatio", label: "Click to website purchase ratio", direction: "high", format: fmtPercent, getValue: (r) => calculateCreativeClickToPurchaseRate(r) },
  {
    id: "purchasesPer1000Imp",
    label: "Purchases per 1,000 impressions",
    direction: "high",
    format: (n) => n.toFixed(2),
    getValue: (r) => calculateCreativePurchasesPer1000Impressions(r),
  },
  {
    id: "revenuePer1000Imp",
    label: "Revenue per 1,000 impressions",
    direction: "high",
    format: fmtCurrency,
    getValue: (r) => calculateCreativeRevenuePer1000Impressions(r),
  },
  {
    id: "clicksAll",
    label: "Clicks (all)",
    direction: "high",
    format: fmtInteger,
    getValue: (r) => r.clicks,
  },
  {
    id: "linkClicks",
    label: "Link clicks",
    direction: "high",
    format: fmtInteger,
    getValue: (r) => r.linkClicks,
  },
];

const CREATIVE_METRIC_MAP: Record<string, CreativeMetricDefinition> = METRIC_DEFS.reduce(
  (acc, metric) => {
    acc[metric.id] = metric;
    return acc;
  },
  {} as Record<string, CreativeMetricDefinition>
);

export function getCreativeMetricDefinition(id: string): CreativeMetricDefinition | undefined {
  return CREATIVE_METRIC_MAP[id];
}

export function CreativesTopSection({
  businessId,
  showHeader = true,
  showGroupByControl = true,
  dateRange,
  onDateRangeChange,
  groupBy,
  onGroupByChange,
  filters,
  onFiltersChange,
  selectedMetricIds,
  onSelectedMetricIdsChange,
  selectedRows,
  allRowsForHeatmap,
  benchmarkRows,
  defaultCurrency,
  onOpenRow,
  onShareExport,
  onCsvExport,
  title = "Top creatives",
  description = "This report shows your top performing creatives. Use this to quickly identify where you are spending money vs making money.",
  groupByOptions = GROUP_BY_OPTIONS,
  previewMode = "media",
  getPreviewCopyText,
  shareExportLoading = false,
  csvExportLoading = false,
  shareUrl = null,
  shareError = null,
  csvError = null,
  previewStripState = "ready",
  previewStripSummary,
  v3Decisions = null,
  v3Flags = null,
  filterBarSlot,
  actionsPrefix,
  belowToolbar,
}: CreativesTopSectionProps) {
  const metricDefs = useMemo(
    () => selectedMetricIds.map((id) => CREATIVE_METRIC_MAP[id]).filter(Boolean) as CreativeMetricDefinition[],
    [selectedMetricIds]
  );
  const topRows = useMemo(() => selectedRows, [selectedRows]);

  return (
    <section>
      {/* A — Header */}
      {showHeader && (
        <div className="space-y-1">
          <h2 className="flex items-center gap-2 text-xl font-semibold">
            <Trophy className="h-5 w-5 text-amber-500" />
            {title}
          </h2>
          <p className="max-w-3xl text-sm text-muted-foreground">
            {description}
          </p>
        </div>
      )}

      {/* B — Filters */}
      <div className={cn(showHeader ? "mt-6" : "mt-0", "rounded-xl border border-neutral-200 bg-white px-3 py-2")}>
        <div className="flex flex-wrap items-center gap-2">
          <CreativeDateRangePicker value={dateRange} onChange={onDateRangeChange} />

          {showGroupByControl ? (
            <div className="inline-flex items-center gap-2 rounded-full border bg-background px-3 py-2 text-xs">
              <span className="text-muted-foreground">Group by</span>
              <select
                value={groupBy}
                onChange={(event) => onGroupByChange(event.target.value as CreativeGroupBy)}
                className="border-0 bg-transparent pr-6 text-xs outline-none"
              >
                {groupByOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

	          <AddFilterDropdown
	            filters={filters}
	            rows={allRowsForHeatmap}
	            onChange={onFiltersChange}
	          />

          {filterBarSlot}

	          <div className="ml-auto flex items-center gap-2">
            {actionsPrefix}
            <TopExportDropdown
              onShareExport={onShareExport}
              onCsvExport={onCsvExport}
              shareLoading={shareExportLoading}
              csvLoading={csvExportLoading}
              shareUrl={shareUrl}
              shareError={shareError}
              csvError={csvError}
            />
          </div>
        </div>
      </div>

	      {belowToolbar ? <div className="mt-4">{belowToolbar}</div> : null}

	      {/* D — Selected creatives workspace */}
      <div className="mt-4 rounded-xl border border-neutral-200 bg-white p-3">
        <div className="relative z-20 mb-3 flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <MetricSelectorBar selectedMetricIds={selectedMetricIds} onChange={onSelectedMetricIdsChange} />
          </div>
        </div>

        <PreviewStrip
          businessId={businessId}
          rows={topRows}
          metrics={metricDefs}
          allRowsForHeatmap={allRowsForHeatmap}
          benchmarkRows={benchmarkRows}
          defaultCurrency={defaultCurrency}
          onOpenRow={onOpenRow}
	          previewMode={previewMode}
          getPreviewCopyText={getPreviewCopyText}
          previewStripState={previewStripState}
          previewStripSummary={previewStripSummary}
          v3Decisions={v3Decisions}
          v3Flags={v3Flags}
	        />
      </div>
    </section>
  );
}

function CreativeDateRangePicker({ value, onChange }: { value: CreativeDateRangeValue; onChange: (next: CreativeDateRangeValue) => void }) {
  return (
    <DateRangePicker
      value={creativeDateRangeToStandard(value)}
      onChange={(next) => onChange(standardDateRangeToCreative(next))}
      showComparisonTrigger={false}
      rangePresets={["today", "yesterday", "7d", "14d", "30d", "365d", "lastMonth", "custom"]}
    />
  );
}

function AddFilterDropdown({
  filters,
  rows,
  onChange,
}: {
  filters: CreativeFilterRule[];
  rows: MetaCreativeRow[];
  onChange: (next: CreativeFilterRule[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [field, setField] = useState<CreativeFilterField>("campaignName");
  const [operator, setOperator] = useState<CreativeFilterOperator>("contains");
  const [query, setQuery] = useState("");
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const queryRef = useRef<HTMLInputElement>(null);

  useDropdownBehavior({
    id: "top-add-filter",
    open,
    setOpen,
    containerRef: wrapRef,
    triggerRef,
    focusRef: queryRef,
  });

  const filterOptions = useMemo(
    () =>
      FILTER_TREE.flatMap((group) =>
        group.children.map((child) => ({
          ...child,
          groupLabel: group.label,
        })),
      ),
    [],
  );

  const operatorOptions = useMemo(() => {
    if (field === "launchDate") {
      return [
        { value: "contains" as CreativeFilterOperator, label: "contains" },
        { value: "equals" as CreativeFilterOperator, label: "is" },
        { value: "before" as CreativeFilterOperator, label: "before" },
        { value: "after" as CreativeFilterOperator, label: "after" },
      ];
    }
    return [
      { value: "contains" as CreativeFilterOperator, label: "contains" },
      { value: "equals" as CreativeFilterOperator, label: "is" },
      { value: "not_equals" as CreativeFilterOperator, label: "is not" },
      { value: "starts_with" as CreativeFilterOperator, label: "starts with" },
    ];
  }, [field]);

  const fieldSuggestions = useMemo(() => {
    const collect = (values: Array<string | null | undefined>) =>
      Array.from(
        new Set(
          values
            .map((value) => (value ?? "").trim())
            .filter(Boolean)
        )
      ).slice(0, 80);

    switch (field) {
      case "campaignName":
        return collect(rows.map((row) => row.campaignName));
      case "adSetName":
        return collect(rows.map((row) => row.adSetName));
      case "adName":
      case "namingConvention":
        return collect(rows.map((row) => row.name));
      case "launchDate":
        return collect(rows.map((row) => row.launchDate)).sort((a, b) => a.localeCompare(b));
      case "creativePrimaryLabel":
        return collect(rows.map((row) => row.creativePrimaryLabel));
      case "creativeSecondaryLabel":
        return collect(rows.map((row) => row.creativeSecondaryLabel));
      case "creativeVisualFormat":
        return collect(rows.map((row) => row.creativeVisualFormat));
      case "creativeDeliveryType":
        return collect(rows.map((row) => row.creativeDeliveryType));
      case "taxonomySource":
        return collect(rows.map((row) => row.taxonomySource ?? null));
      case "isCatalog":
        return ["true", "false"];
      case "assetType":
      case "visualFormat":
      case "intendedAudience":
      case "messagingAngle":
      case "seasonality":
      case "offerType":
      case "hookTactic":
      case "headlineTactic":
        return collect(rows.flatMap((row) => row.aiTags?.[field] ?? []));
      default:
        return collect(rows.flatMap((row) => row.tags ?? []));
    }
  }, [field, rows]);

  const filteredSuggestions = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return fieldSuggestions.slice(0, 8);
    return fieldSuggestions.filter((value) => value.toLowerCase().includes(normalizedQuery)).slice(0, 8);
  }, [fieldSuggestions, query]);

  const addRuleWith = (nextField: CreativeFilterField, nextOperator: CreativeFilterOperator, nextQuery: string) => {
    const cleanQuery = nextQuery.trim();
    if (!cleanQuery) return;

    onChange([
      ...filters,
      {
        id: `rule_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        field: nextField,
        operator: nextOperator,
        query: cleanQuery,
      },
    ]);
    setQuery("");
    setField(nextField);
    setOperator(nextOperator);
    setOpen(false);
  };

  const addRule = () => {
    const cleanQuery = query.trim();
    if (!cleanQuery) return;
    addRuleWith(field, operator, cleanQuery);
  };

  const removeRule = (ruleId: string) => onChange(filters.filter((rule) => rule.id !== ruleId));

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div ref={wrapRef} className="relative">
        <button
          ref={triggerRef}
          type="button"
          onClick={() => {
            setOpen((prev) => {
              const next = !prev;
              if (next) {
                setField("campaignName");
                setOperator("equals");
                setQuery("");
              }
              return next;
            });
          }}
            className="inline-flex items-center gap-2 rounded-lg border border-neutral-200 bg-white px-3 py-2 text-xs text-neutral-700 hover:bg-neutral-50"
        >
          <SlidersHorizontal className="h-3.5 w-3.5" />
          Add filter
        </button>

        {open && (
          <div className="animate-in fade-in-0 slide-in-from-top-1 absolute left-0 top-11 z-50 w-[min(520px,calc(100vw-32px))] max-w-[calc(100vw-32px)] rounded-xl border border-neutral-200 bg-white p-3 shadow-[0_8px_24px_-12px_rgba(16,21,28,0.18)] duration-150">
            <div className="grid gap-2 md:grid-cols-[1.15fr_0.9fr_1.15fr_auto]">
              <label className="space-y-1">
                <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                  Field
                </span>
                <select
                  value={field}
                  onChange={(event) => {
                    const nextField = event.target.value as CreativeFilterField;
                    setField(nextField);
                    setOperator(nextField === "launchDate" ? "equals" : "contains");
                    setQuery("");
                  }}
                  className="h-10 w-full rounded-lg border border-neutral-200 bg-white px-3 text-sm outline-none focus:border-neutral-400"
                >
                  {FILTER_TREE.map((group) => (
                    <optgroup key={group.label} label={group.label}>
                      {group.children.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </label>

              <label className="space-y-1">
                <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                  Operator
                </span>
                <select
                  value={operator}
                  onChange={(event) => setOperator(event.target.value as CreativeFilterOperator)}
                  className="h-10 w-full rounded-lg border border-neutral-200 bg-white px-3 text-sm outline-none focus:border-neutral-400"
                >
                  {operatorOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="space-y-1">
                <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                  Query
                </span>
                <div className="flex items-center gap-2 rounded-lg border border-neutral-200 px-3 py-2">
                  <Search className="h-4 w-4 text-muted-foreground" />
                  <input
                    ref={queryRef}
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={`Filter by ${prettyFieldLabel(field).toLowerCase()}`}
                    className="w-full bg-transparent text-sm outline-none"
                  />
                </div>
              </label>

              <div className="flex items-end">
                <button
                  type="button"
                  onClick={addRule}
                  className="inline-flex h-10 items-center justify-center rounded-lg border border-[var(--adc-ink,#1a1c1f)] bg-[var(--adc-ink,#1a1c1f)] px-4 text-sm font-medium text-[var(--adc-s2,#fff)] hover:bg-[var(--adc-ink2,#4a4f56)] disabled:opacity-60"
                  disabled={!query.trim()}
                >
                  Add
                </button>
              </div>
            </div>

            {filteredSuggestions.length > 0 ? (
              <div className="mt-2 rounded-lg border border-neutral-200 bg-neutral-50 p-2">
                <p className="px-2 pb-1 text-[12px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                  Suggestions
                </p>
                <div className="flex flex-wrap gap-2">
                  {filteredSuggestions.map((suggestion) => (
                    <button
                      key={`${field}-${suggestion}`}
                      type="button"
                      onClick={() => addRuleWith(field, operator, suggestion)}
                      className="rounded-full border border-neutral-200 bg-white px-3 py-1.5 text-xs text-neutral-700 hover:bg-neutral-50"
                    >
                      {suggestion}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="mt-2 rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2 text-[11px] text-neutral-600">
	              AI tag filters use tag values only and do not rewrite taxonomy.
	            </div>
          </div>
        )}
      </div>

      {filters.map((rule) => (
        <span key={rule.id} className="inline-flex items-center gap-1 rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2 text-xs text-neutral-700">
          {prettyFieldLabel(rule.field)} {prettyOperatorLabel(rule.operator ?? "contains")} {rule.query}
          <button type="button" onClick={() => removeRule(rule.id)}>
            <X className="h-3.5 w-3.5" />
          </button>
        </span>
      ))}
    </div>
  );
}

function TopExportDropdown({
  onShareExport,
  onCsvExport,
  shareLoading,
  csvLoading,
  shareUrl,
  shareError,
  csvError,
}: {
  onShareExport: () => void;
  onCsvExport: () => void;
  shareLoading: boolean;
  csvLoading: boolean;
  shareUrl: string | null;
  shareError: string | null;
  csvError: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useDropdownBehavior({
    id: "top-export",
    open,
    setOpen,
    containerRef: wrapRef,
    triggerRef,
  });

  const copyShareUrl = async () => {
    if (!shareUrl || typeof window === "undefined") return;
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${shareUrl}`);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div ref={wrapRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="inline-flex items-center gap-2 rounded-lg border border-neutral-200 bg-white px-3 py-2 text-xs text-neutral-700 hover:bg-neutral-50"
      >
        Export
        <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
      </button>

      {open && (
        <div className="animate-in fade-in-0 slide-in-from-top-1 absolute right-0 top-11 z-50 w-[290px] rounded-xl border border-neutral-200 bg-white p-3 shadow-[0_8px_24px_-12px_rgba(16,21,28,0.18)] duration-150">
          <button
            type="button"
            onClick={onShareExport}
            disabled={shareLoading}
            className="flex w-full items-center justify-between rounded-md border px-2.5 py-2 text-xs hover:bg-accent/60 disabled:opacity-60"
          >
            <span className="inline-flex items-center gap-2">
              <Link2 className="h-3.5 w-3.5" />
              {shareLoading ? "Generating link..." : "Share link"}
            </span>
          </button>

          <button
            type="button"
            onClick={onCsvExport}
            disabled={csvLoading}
            className="mt-2 flex w-full items-center justify-between rounded-md border px-2.5 py-2 text-xs hover:bg-accent/60 disabled:opacity-60"
          >
            <span className="inline-flex items-center gap-2">
              <FileDown className="h-3.5 w-3.5" />
              {csvLoading ? "Exporting CSV..." : "Export CSV"}
            </span>
          </button>

          {shareUrl && (
            <div className="mt-2 space-y-1 rounded-md border bg-muted/30 p-2">
              <p className="text-[11px] text-muted-foreground">Share link ready</p>
              <div className="flex items-center gap-1.5">
                <input
                  readOnly
                  value={`${typeof window !== "undefined" ? window.location.origin : ""}${shareUrl}`}
                  className="h-7 flex-1 rounded border bg-background px-2 text-[11px] text-muted-foreground"
                />
                <button
                  type="button"
                  onClick={copyShareUrl}
                  className="inline-flex h-7 items-center gap-1 rounded border px-2 text-[11px]"
                >
                  <Copy className="h-3 w-3" />
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
            </div>
          )}

          {shareError ? <p className="mt-2 text-[11px] text-[var(--adc-danger-fg,#a6224a)]">{shareError}</p> : null}
          {csvError ? <p className="mt-1 text-[11px] text-[var(--adc-danger-fg,#a6224a)]">{csvError}</p> : null}
        </div>
      )}
    </div>
  );
}

function MetricSelectorBar({ selectedMetricIds, onChange }: { selectedMetricIds: string[]; onChange: (next: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [panelPosition, setPanelPosition] = useState({ top: 0, left: 0 });
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const insideRefs = useMemo(() => [popoverRef], []);

  useDropdownBehavior({
    id: "top-add-metric",
    open,
    setOpen,
    containerRef: wrapRef,
    triggerRef,
    focusRef: searchRef,
    insideRefs,
    closeOnScroll: false,
  });

  const selectedDefs = selectedMetricIds
    .map((id) => getCreativeMetricDefinition(id))
    .filter(Boolean) as CreativeMetricDefinition[];

  const selectedMetricIdSet = useMemo(() => new Set(selectedMetricIds), [selectedMetricIds]);

  const filtered = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return METRIC_DEFS;
    return METRIC_DEFS.filter((metric) => metric.label.toLowerCase().includes(normalizedQuery));
  }, [query]);

  const toggleMetric = (metricId: string) => {
    const exists = selectedMetricIdSet.has(metricId);
    onChange(exists ? selectedMetricIds.filter((id) => id !== metricId) : [...selectedMetricIds, metricId]);
  };

  useEffect(() => {
    if (!open) return;
    const updatePosition = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const panelWidth = 290;
      const viewportPadding = 8;
      const rawLeft = rect.left;
      const clampedLeft = Math.min(
        window.innerWidth - panelWidth - viewportPadding,
        Math.max(viewportPadding, rawLeft)
      );
      const nextTop = rect.bottom + 8;
      const panelHeight = popoverRef.current?.offsetHeight ?? 0;
      const overflowsBottom = nextTop + panelHeight > window.innerHeight - viewportPadding;
      const top = overflowsBottom ? Math.max(viewportPadding, rect.top - panelHeight - 8) : nextTop;
      setPanelPosition({ top, left: clampedLeft });
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open, query, filtered.length]);

  return (
    <div className="min-w-0 overflow-visible">
      <div className="flex min-w-0 items-center gap-2 overflow-x-auto whitespace-nowrap pb-1">
        <button type="button" className="shrink-0 rounded-full border bg-muted/25 px-3 py-1 text-xs">
          + AI tags
        </button>

        <div ref={wrapRef} className="relative shrink-0">
          <button
            ref={triggerRef}
            type="button"
            onClick={() => setOpen((prev) => !prev)}
            className="rounded-full border bg-background px-3 py-1 text-xs"
          >
            + Add metric
          </button>

          {open && typeof document !== "undefined" && createPortal(
            <div
              ref={popoverRef}
              className="animate-in fade-in-0 slide-in-from-top-1 fixed z-[180] w-[290px] rounded-lg border border-neutral-200 bg-white p-2.5 shadow-[0_8px_24px_-12px_rgba(16,21,28,0.18)] duration-150"
              style={{ top: panelPosition.top, left: panelPosition.left }}
            >
              <div className="mb-2 flex items-center gap-2 rounded-md border px-2 py-1.5">
                <Search className="h-3.5 w-3.5 text-muted-foreground" />
                <input
                  ref={searchRef}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search metrics"
                  className="w-full bg-transparent text-xs outline-none"
                />
              </div>

              <div className="max-h-64 space-y-1 overflow-auto pr-1">
                {filtered.map((metric) => {
                  const isSelected = selectedMetricIdSet.has(metric.id);
                  return (
                  <button
                    key={metric.id}
                    type="button"
                    onClick={() => toggleMetric(metric.id)}
                    className={cn(
                      "flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs",
                      isSelected ? "bg-accent/70" : "hover:bg-accent/60"
                    )}
                  >
                    <span className="truncate pr-2">{metric.label}</span>
                    <span
                      className={cn(
                        "inline-flex h-4 w-4 items-center justify-center rounded-sm border",
                        isSelected ? "border-[var(--adc-pos-bd,#bfdfd1)] bg-[var(--adc-pos-bg,#e9f4ef)] text-[var(--adc-pos-fg,#0b6b4f)]" : "border-muted-foreground/40 text-transparent"
                      )}
                    >
                      <Check className="h-3 w-3" />
                    </span>
                  </button>
                  );
                })}
                {filtered.length === 0 && (
                  <p className="px-2 py-1.5 text-xs text-muted-foreground">No metrics found.</p>
                )}
              </div>
            </div>,
            document.body
          )}
        </div>

        {selectedDefs.map((metric, index) => (
          <span
            key={metric.id}
            className={cn(
              "inline-flex shrink-0 items-center gap-2 rounded-full px-3 py-1 text-xs font-medium",
              METRIC_COLOR_TOKENS[index % METRIC_COLOR_TOKENS.length]
            )}
          >
            {index + 1} {metric.label}
            <button
              type="button"
              onClick={() => onChange(selectedMetricIds.filter((item) => item !== metric.id))}
              className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-black/10"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
      </div>
    </div>
  );
}

function PreviewStrip({
  businessId,
  rows,
  metrics,
  allRowsForHeatmap,
  benchmarkRows,
  defaultCurrency,
  onOpenRow,
  previewMode = "media",
  getPreviewCopyText,
  previewStripState = "ready",
  previewStripSummary,
  v3Decisions = null,
  v3Flags = null,
}: {
  businessId?: string;
  rows: MetaCreativeRow[];
  metrics: CreativeMetricDefinition[];
  allRowsForHeatmap: MetaCreativeRow[];
  benchmarkRows?: MetaCreativeRow[];
  defaultCurrency: string | null;
  onOpenRow: (rowId: string) => void;
  previewMode?: "media" | "copy";
  getPreviewCopyText?: (row: MetaCreativeRow) => string;
  previewStripState?: "data_loading" | "ready" | "missing";
  previewStripSummary?: {
    total: number;
    ready: number;
    pending: number;
    missing: number;
    minimumReady: number;
  };
  v3Decisions?: DecisionOutput[] | null;
  v3Flags?: EngineV3Flags | null;
}) {
  const context = useMemo<CreativeMetricContext>(
    () => ({
      totalSpend: (allRowsForHeatmap.length > 0 ? allRowsForHeatmap : rows).reduce((sum, row) => sum + row.spend, 0),
      totalPurchaseValue: (allRowsForHeatmap.length > 0 ? allRowsForHeatmap : rows).reduce(
        (sum, row) => sum + row.purchaseValue,
        0
      ),
    }),
    [allRowsForHeatmap, rows]
  );

  const heatBenchmarkRows =
    benchmarkRows && benchmarkRows.length > 0
      ? benchmarkRows
      : allRowsForHeatmap.length > 0
        ? allRowsForHeatmap
        : rows;
  const heatBenchmark = useMemo(
    () => buildCreativeTableHeatBenchmark(heatBenchmarkRows),
    [heatBenchmarkRows]
  );

  const rowSignature = useMemo(() => rows.map((row) => row.id).join("|"), [rows]);
  const [unlockedPreviewCount, setUnlockedPreviewCount] = useState(
    previewMode === "media" && rows.length > 0 ? 1 : rows.length
  );
  const v3SurfaceVisible = Boolean(v3Flags?.enabled && v3Flags.surfaceVisible);
  const decisionLabelByCreativeId = useMemo(() => {
    if (!v3Decisions) return new Map<string, DecisionLabel>();
    return new Map(
      v3Decisions.map((decision) => [decision.creativeId, decision.label]),
    );
  }, [v3Decisions]);
  const previewGridRef = useRef<HTMLDivElement | null>(null);
  const previewCardMinWidth = previewMode === "copy" ? 280 : 190;
  const previewGridGap = 12;
  const previewRowBatchSize = 2;
  const [previewColumnCount, setPreviewColumnCount] = useState(1);
  const [visiblePreviewRowCount, setVisiblePreviewRowCount] = useState(previewRowBatchSize);

  useEffect(() => {
    setUnlockedPreviewCount(previewMode === "media" && rows.length > 0 ? 1 : rows.length);
  }, [previewMode, rowSignature, rows.length]);

  useEffect(() => {
    setVisiblePreviewRowCount(previewRowBatchSize);
  }, [previewMode, rowSignature]);

  useEffect(() => {
    const element = previewGridRef.current;
    if (!element) return;

    const updateColumnCount = () => {
      const width = element.clientWidth;
      if (width <= 0) return;

      const nextColumnCount = Math.max(
        1,
        Math.floor((width + previewGridGap) / (previewCardMinWidth + previewGridGap))
      );
      setPreviewColumnCount((prev) => (prev === nextColumnCount ? prev : nextColumnCount));
    };

    updateColumnCount();

    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => updateColumnCount());
    observer.observe(element);
    return () => observer.disconnect();
  }, [previewCardMinWidth, previewStripState, rows.length]);

  useEffect(() => {
    if (previewMode !== "media") return;
    if (rows.length === 0) return;
    if (previewStripState === "data_loading" || previewStripState === "missing") return;
    if (unlockedPreviewCount >= rows.length) return;

    const settleTimer = window.setTimeout(() => {
      setUnlockedPreviewCount((prev) =>
        prev >= rows.length ? prev : Math.min(rows.length, prev + 1)
      );
    }, 400);

    return () => window.clearTimeout(settleTimer);
  }, [previewMode, previewStripState, rows.length, unlockedPreviewCount]);

  const visiblePreviewCardCount = previewColumnCount * visiblePreviewRowCount;
  const visibleRows = rows.slice(0, visiblePreviewCardCount);
  const hasMoreRows = rows.length > visiblePreviewCardCount;
  if (previewStripState === "data_loading") {
    return (
      <div
        className="grid gap-3"
        style={{
          gridTemplateColumns: `repeat(auto-fit, minmax(min(100%, ${previewCardMinWidth}px), 1fr))`,
        }}
      >
          {Array.from({ length: 4 }).map((_, index) => (
            <div
              key={`creative-preview-skeleton-${index}`}
              className="overflow-hidden rounded-xl border bg-background"
            >
              <div className="aspect-square w-full animate-pulse bg-neutral-100" />
              <div className="space-y-2 px-3 pb-3 pt-2.5">
                <div className="h-4 w-3/4 animate-pulse rounded bg-neutral-100" />
                <div className="h-3 w-1/2 animate-pulse rounded bg-neutral-100" />
                <div className="h-3 w-2/3 animate-pulse rounded bg-neutral-100" />
              </div>
            </div>
          ))}
      </div>
    );
  }

  if (previewStripState === "missing") {
    return (
      <div className="rounded-xl border border-dashed bg-muted/10 px-4 py-5">
        <p className="text-sm font-medium text-foreground">Previews unavailable for this selection</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {previewStripSummary?.total === 0
              ? "No creatives are available for the selected range yet, so preview cards cannot be prepared."
              : previewStripSummary?.missing
                ? `${previewStripSummary.missing} selected creatives do not have a usable preview from Meta right now.`
                : "Meta did not return usable preview media for the current top creatives."}
        </p>
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="rounded-xl border border-dashed p-6 text-sm text-muted-foreground">
        Select creatives in the table to populate this strip.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div
        ref={previewGridRef}
        className="grid gap-3"
        style={{ gridTemplateColumns: `repeat(${previewColumnCount}, minmax(0, 1fr))` }}
      >
        {visibleRows.map((row, index) => {
          const assetFallbacks = getCreativeStaticPreviewSources(row, "grid");
          const assetUpgradeSources = assetFallbacks;
          const assetState = getCreativeStaticPreviewState(row, "grid");
          const resolvedRowCurrency = resolveCreativeCurrency(row.currency, defaultCurrency);
          const shouldUnlockPreview = previewMode !== "media" || index < unlockedPreviewCount;
          // Row ids can be grouped UI ids; v3 decisions are keyed by Meta creative id.
          const decisionLabel = v3SurfaceVisible
            ? decisionLabelByCreativeId.get(row.creativeId) ?? null
            : null;
          const creativeTypeLabel = getCreativeFormatSummaryLabel({
            creative_delivery_type: row.creativeDeliveryType,
            creative_visual_format: row.creativeVisualFormat,
            creative_primary_type: row.creativePrimaryType,
            creative_primary_label: row.creativePrimaryLabel,
            creative_secondary_type: row.creativeSecondaryType,
            creative_secondary_label: row.creativeSecondaryLabel,
            taxonomy_source: row.taxonomySource ?? null,
          });
          return (
            <button
              key={row.id}
              type="button"
              onClick={() => onOpenRow(row.id)}
              className={cn(
                "group min-w-0 overflow-hidden rounded-xl border bg-background text-left transition-shadow hover:shadow-md hover:ring-1 hover:ring-border"
              )}
            >
              {previewMode === "copy" ? (
                <div className="h-[164px] w-full border-b bg-muted/15 px-3 py-3">
                  <p className="line-clamp-6 text-[12px] leading-5 text-foreground/95">
                    {getPreviewCopyText?.(row) ?? row.name}
                  </p>
                </div>
              ) : (
                <div className="relative aspect-square w-full overflow-hidden bg-muted/20">
                  <PreviewStripMediaSurface
                    row={row}
                    assetState={assetState}
                    assetFallbacks={assetFallbacks}
                    assetUpgradeSources={assetUpgradeSources}
                    shouldUnlockPreview={shouldUnlockPreview}
                    onAdvance={() =>
                      setUnlockedPreviewCount((prev) =>
                        prev >= rows.length ? prev : Math.max(prev, index + 2)
                      )
                    }
                  />
                  {creativeTypeLabel ? (
                    <span className="pointer-events-none absolute bottom-2 left-2 rounded-full bg-black/65 px-2 py-0.5 text-[12px] font-medium text-white backdrop-blur-sm">
                      {creativeTypeLabel}
                    </span>
                  ) : null}
                  {decisionLabel ? (
                    <CreativeDecisionLabelBadge
                      label={decisionLabel}
                      className="absolute right-1.5 top-1.5 z-10"
                    />
                  ) : null}
	                </div>
	              )}

	              <div className="px-3 pb-3 pt-2.5">
	                <p className="line-clamp-2 text-[12px] font-semibold leading-4">{row.name}</p>
	                <div className="mt-2 space-y-0.5">
                  {metrics.map((metric) => {
                    const value = metric.getValue(row, context);
                    const evaluation = evaluateCreativeMetricPreviewHeat({
                      metricId: metric.id,
                      row,
                      benchmark: heatBenchmark,
                    });
                    const heatStyle = evaluation ? toHeatCellStyle(evaluation.tone, evaluation.intensity) : undefined;

                    return (
                      <div key={metric.id} className="flex items-center justify-between gap-2 text-[11px]">
                        <p className="truncate text-muted-foreground">{metric.label}</p>
                        <span
                          className="rounded-full px-1.5 py-0.5 font-semibold tabular-nums"
                          style={heatStyle}
                          title={evaluation?.reason}
                        >
                          {metric.format(value, resolvedRowCurrency, defaultCurrency)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </button>
          );
        })}
      </div>
      {hasMoreRows ? (
        <div className="flex justify-center">
          <button
            type="button"
            onClick={() => setVisiblePreviewRowCount((prev) => prev + previewRowBatchSize)}
            className="inline-flex items-center justify-center rounded-full border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted"
          >
            Show more
          </button>
        </div>
      ) : null}
    </div>
  );
}

function MonthCalendar({
  year,
  month,
  start,
  end,
  onSelect,
  onPrevMonth,
  onNextMonth,
  showPrev,
  showNext,
}: {
  year: number;
  month: number;
  start: string;
  end: string;
  onSelect: (iso: string) => void;
  onPrevMonth: () => void;
  onNextMonth: () => void;
  showPrev: boolean;
  showNext: boolean;
}) {
  const cells = buildMonthGrid(year, month);

  return (
    <div className="w-[238px]">
      <div className="mb-2 flex items-center justify-between text-xs font-medium">
        <button
          type="button"
          onClick={onPrevMonth}
          className={cn("h-6 w-6 rounded hover:bg-accent", !showPrev && "invisible")}
        >
          {"<"}
        </button>
        <span>{new Date(year, month, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" })}</span>
        <button
          type="button"
          onClick={onNextMonth}
          className={cn("h-6 w-6 rounded hover:bg-accent", !showNext && "invisible")}
        >
          {">"}
        </button>
      </div>

      <div className="grid grid-cols-7 text-center text-[12px] text-muted-foreground">
        {["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((day) => (
          <div key={day} className="py-1">{day}</div>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-y-0.5">
        {cells.map((cell, index) => {
          if (!cell) return <div key={`empty_${index}`} className="h-8 w-8" />;

          const inRange = start && end && cell >= start && cell <= end;
          const isEdge = cell === start || cell === end;
          return (
            <button
              key={cell}
              type="button"
              onClick={() => onSelect(cell)}
              className={cn(
                "mx-auto h-8 w-8 rounded-full text-xs",
                isEdge && "bg-foreground text-background",
                !isEdge && inRange && "bg-accent",
                !inRange && "hover:bg-accent/60"
              )}
            >
              {Number.parseInt(cell.slice(8), 10)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export {
  applyCreativeFilters,
  DEFAULT_COPY_TOP_METRIC_IDS,
  DEFAULT_CREATIVE_DATE_RANGE,
  DEFAULT_TOP_METRIC_IDS,
  formatCreativeDateLabel,
  mapCreativeGroupByToApi,
  resolveCreativeDateRange,
};
