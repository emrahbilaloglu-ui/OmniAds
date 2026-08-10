"use client";

import { memo, useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import {
  CalendarDays,
  ChevronDown,
  Megaphone,
  MessageSquareQuote,
  ScanFace,
  GripVertical,
  Shapes,
  Plus,
  Search,
  Settings2,
  Tag,
  Target,
  X,
} from "lucide-react";
import { MetaAiTagKey, MetaCreativeRow } from "@/components/creatives/metricConfig";
import { CreativeRenderSurface } from "@/components/creatives/CreativeRenderSurface";
import { getAiTagPillStyles } from "@/components/creatives/aiTagPillStyles";
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
  hasCreativeVideoEvidence,
} from "@/components/creatives/creative-truth";
import { resolveCreativeCurrency } from "@/components/creatives/money";
import {
  buildDistribution,
  clamp,
  computeAggregateTotals,
  fmtCurrency,
  fmtInteger,
  fmtPercent,
  toHeatAccentColor,
  toHeatCellStyle,
} from "@/components/creatives/creatives-table-support";
import { cn } from "@/lib/utils";
import {
  isNarrowViewport,
  resolveCreativeColumnPriority,
} from "@/lib/creative-column-priority";
import { getCreativeStaticPreviewSources, getCreativeStaticPreviewState } from "@/lib/meta/creatives-preview";
import { useDropdownBehavior } from "@/hooks/use-dropdown-behavior";
import { createPortal } from "react-dom";
import { getCreativeVisualFormatLabel } from "@/lib/meta/creative-taxonomy";
import type { AiCreativeHistoricalWindows as CreativeHistoricalWindows } from "@/lib/meta/creative-scoring";
import type { DecisionLabel, DecisionOutput, EngineV3Flags } from "@/lib/creative-decision-engine";
import { LABEL_DISPLAY } from "@/components/creatives/decision-label-display";
import { DECISION_LABEL_PALETTE } from "@/components/common/briefing/decision-label-palette";

type GoodDirection = "high" | "low" | "neutral";
type ColorFormattingMode = "heatmap" | "none";
type TableColumnAlign = "left" | "right" | "center";

export type TableColumnKey =
  | "spend"
  | "purchaseValue"
  | "roas"
  | "cpa"
  | "cpcLink"
  | "cpm"
  | "cpcAll"
  | "averageOrderValue"
  | "clickToAtcRatio"
  | "atcToPurchaseRatio"
  | "purchases"
  | "firstFrameRetention"
  | "thumbstopRatio"
  | "ctrOutbound"
  | "clickToPurchaseRatio"
  | "ctrAll"
  | "video25Rate"
  | "video50Rate"
  | "video75Rate"
  | "video100Rate"
  | "holdRate"
  | "hookScore"
  | "ctaScore"
  | "offerScore"
  | "purchaseValueShare"
  | "watchScore"
  | "clickScore"
  | "convertScore"
  | "averageOrderValueWebsite"
  | "averageOrderValueShop"
  | "impressions"
  | "spendShare"
  | "linkCtr"
  | "websitePurchaseRoas"
  | "clickToWebsitePurchaseRatio"
  | "purchasesPer1000Imp"
  | "revenuePer1000Imp"
  | "clicksAll"
  | "linkClicks"
  | "leads"
  | "cpl"
  | "messages"
  | "cpMessage";

type TagKey = MetaAiTagKey;
const AI_TAG_COLUMN_KEYS: TagKey[] = [
  "assetType",
  "visualFormat",
  "intendedAudience",
  "messagingAngle",
  "seasonality",
  "offerType",
  "hookTactic",
  "headlineTactic",
];

interface TableColumnDefinition {
  key: TableColumnKey;
  label: string;
  description: string;
  direction: GoodDirection;
  minWidth: number;
  preferredWidth: number;
  align: TableColumnAlign;
  format: (n: number, rowCurrency?: string | null, defaultCurrency?: string | null) => string;
  getValue: (row: MetaCreativeRow, ctx: TableCalcContext) => number;
}

interface TableCalcContext {
  totalSpend: number;
  totalPurchaseValue: number;
  totalPurchases: number;
  totalImpressions: number;
  totalLinkClicks: number;
}

interface TablePreset {
  presetName: string;
  summary: string;
  selectedColumns: TableColumnKey[];
  selectedAiTagColumns: TagKey[];
  resultsPerPage: 20 | 50 | 100;
  colorFormatting: ColorFormattingMode;
  showActiveStatus: boolean;
  showLaunchDate: boolean;
  showAdLength: boolean;
  hiddenFromMenu?: boolean;
}

interface CreativesTableSectionProps {
  rows: MetaCreativeRow[];
  creativeHistoryById?: Map<string, CreativeHistoricalWindows>;
  defaultCurrency: string | null;
  initialPresetName?: string;
  selectedMetricIds: string[];
  onSelectedMetricIdsChange: (next: string[]) => void;
  selectedRowIds: string[];
  highlightedRowId?: string | null;
  onToggleRow: (rowId: string) => void;
  onToggleAll: () => void;
  onOpenRow: (rowId: string) => void;
  onOpenBreakdownRow?: (rowId: string) => void;
  onSortedRowsChange?: (rows: MetaCreativeRow[]) => void;
  /** Server-truth creative decisions (Engine v3) + flags. Used only to render the
   *  optional DECISION column when buyerDecisionLanguage is on. Never derived here. */
  v3Decisions?: DecisionOutput[] | null;
  v3Flags?: EngineV3Flags | null;
  /** When true, appends a right-aligned DECISION column showing the server decision
   *  label per creative ("—" when the engine has none). Off by default: Creative Studio
   *  stays "analysis only", and this is a buyer-language overlay, not execution. */
  buyerDecisionLanguage?: boolean;
}

const DECISION_COLUMN_WIDTH = 116;

interface MetricTooltipState {
  key: TableColumnKey;
  rect: DOMRect;
}

interface TableSortState {
  key: TableColumnKey | "name" | "launchDate" | `aiTag:${TagKey}` | null;
  direction: "asc" | "desc" | null;
}

type MetricDirectionMode = "higher_better" | "lower_better" | "neutral";
type MetricColorMode = "semantic" | "quantile" | "none";
type FooterAggregationMode = "sum" | "weighted" | "avg" | "none";
type HeatTone = "strong_negative" | "negative" | "neutral" | "positive" | "strong_positive";
type HeatStrength = "strong" | "medium" | "soft";
type CreativeFormat = MetaCreativeRow["format"];

interface MetricConfidenceThreshold {
  minSpend?: number;
  minImpressions?: number;
  minEstimatedViews?: number;
}

interface TableMetricConfig {
  direction: MetricDirectionMode;
  colorMode: MetricColorMode;
  spendSensitive: boolean;
  footerAggregation: FooterAggregationMode;
  heatStrength: HeatStrength;
  applicableFormats: CreativeFormat[];
  minConfidenceThreshold?: MetricConfidenceThreshold;
}

interface MetricDistribution {
  min: number;
  max: number;
  avg: number;
  median: number;
  q1: number;
  q3: number;
  p20: number;
  p40: number;
  p60: number;
  p80: number;
  sorted: number[];
}

export interface HeatEvaluation {
  tone: HeatTone;
  intensity: number;
  reason: string;
  applicable?: boolean;
}

interface CreativeTableRowProps {
  row: MetaCreativeRow;
  isSelected: boolean;
  highlighted: boolean;
  defaultCurrency: string | null;
  tablePreset: TablePreset;
  selectedAiTagColumns: TagKey[];
  selectedColumns: TableColumnDefinition[];
  ctx: TableCalcContext;
  metricDistributions: Partial<Record<TableColumnKey, MetricDistribution>>;
  metricSpendDistributions: Partial<Record<TableColumnKey, MetricDistribution>>;
  heatmapBaselineLabel: string;
  buyerDecisionLanguage: boolean;
  decisionLabel: DecisionLabel | null;
  onToggleRow: (rowId: string) => void;
  onOpenRow: (rowId: string) => void;
  onOpenBreakdownRow?: (rowId: string) => void;
}


const TABLE_LAYOUT_STORAGE_KEY = "creativesTableLayout";
const AI_TAG_COLUMN_SPECS: Record<TagKey, { minWidth: number; preferredWidth: number }> = {
  assetType: { minWidth: 128, preferredWidth: 140 },
  visualFormat: { minWidth: 152, preferredWidth: 172 },
  intendedAudience: { minWidth: 150, preferredWidth: 170 },
  messagingAngle: { minWidth: 158, preferredWidth: 178 },
  seasonality: { minWidth: 130, preferredWidth: 145 },
  offerType: { minWidth: 132, preferredWidth: 148 },
  hookTactic: { minWidth: 138, preferredWidth: 156 },
  headlineTactic: { minWidth: 148, preferredWidth: 166 },
};
const AI_TAG_HEADER_ICONS: Record<TagKey, ComponentType<{ className?: string }>> = {
  assetType: Shapes,
  visualFormat: ScanFace,
  intendedAudience: Target,
  messagingAngle: MessageSquareQuote,
  seasonality: CalendarDays,
  offerType: Megaphone,
  hookTactic: Tag,
  headlineTactic: MessageSquareQuote,
};

function buildPlacementTooltip(row: MetaCreativeRow): string | undefined {
  const parts: string[] = [];
  if (row.campaignName) parts.push(`Campaign: ${row.campaignName}`);
  else if (row.campaignId) parts.push(`Campaign id: ${row.campaignId}`);
  if (row.adSetName) parts.push(`Ad set: ${row.adSetName}`);
  else if (row.adSetId) parts.push(`Ad set id: ${row.adSetId}`);
  if (parts.length === 0) return undefined;
  return parts.join("\n");
}

function logPerf(label: string, startMs: number, rowCount: number) {
  if (process.env.NODE_ENV === "production") return;
  const duration = Date.now() - startMs;
  if (duration < 8) return;
  console.log("[creatives-perf]", { label, duration_ms: duration, row_count: rowCount });
}
const STATIC_COLUMN_SPECS = {
  creativeName: { minWidth: 220, preferredWidth: 240 },
  launchDate: { minWidth: 120, preferredWidth: 120 },
  activeStatus: { minWidth: 100, preferredWidth: 110 },
  adLength: { minWidth: 90, preferredWidth: 110 },
} as const;


/** Current viewport width, or null until the browser reports one. */
function useViewportWidth(): number | null {
  const [width, setWidth] = useState<number | null>(
    typeof window === "undefined" ? null : window.innerWidth,
  );
  useEffect(() => {
    if (typeof window === "undefined") return;
    const update = () => setWidth(window.innerWidth);
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return width;
}

function getDefaultColumnWidths(): Record<string, number> {
  const metricWidths = TABLE_COLUMNS.reduce<Record<string, number>>((acc, column) => {
    acc[column.key] = column.preferredWidth;
    return acc;
  }, {});
  return {
    creativeName: STATIC_COLUMN_SPECS.creativeName.preferredWidth,
    launchDate: STATIC_COLUMN_SPECS.launchDate.preferredWidth,
    activeStatus: STATIC_COLUMN_SPECS.activeStatus.preferredWidth,
    adLength: STATIC_COLUMN_SPECS.adLength.preferredWidth,
    ...AI_TAG_COLUMN_KEYS.reduce<Record<string, number>>((acc, key) => {
      acc[`aiTag:${key}`] = AI_TAG_COLUMN_SPECS[key].preferredWidth;
      return acc;
    }, {}),
    ...metricWidths,
  };
}

function parseLaunchDate(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function safeTableText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function safeTableStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(safeTableText).filter(Boolean);
  const text = safeTableText(value);
  return text ? [text] : [];
}

function safeTablePreview(value: unknown, isCatalog: unknown): MetaCreativeRow["preview"] {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const source = value as Partial<MetaCreativeRow["preview"]>;
    const renderMode = source.render_mode === "video" || source.render_mode === "image"
      ? source.render_mode
      : "unavailable";
    return {
      render_mode: renderMode,
      image_url: safeTableText(source.image_url) || null,
      video_url: safeTableText(source.video_url) || null,
      poster_url: safeTableText(source.poster_url) || null,
      source: source.source ?? null,
      is_catalog: typeof source.is_catalog === "boolean" ? source.is_catalog : Boolean(isCatalog),
    };
  }
  return {
    render_mode: "unavailable",
    image_url: null,
    video_url: null,
    poster_url: null,
    source: null,
    is_catalog: Boolean(isCatalog),
  };
}

function scaleMetricToScore(value: number, target: number): number {
  if (!Number.isFinite(value) || target <= 0) return 0;
  return clamp((value / target) * 100, 0, 100);
}

function hasAiTagValue(row: MetaCreativeRow, key: TagKey, value?: string): boolean {
  const values = safeTableStringArray(row.aiTags?.[key]);
  if (!value) return values.length > 0;
  return values.some((entry) => entry.toLowerCase() === value.toLowerCase());
}

function calculateCreativeHookScore(row: MetaCreativeRow): number {
  const videoFirstStop = scaleMetricToScore(row.thumbstop, 28);
  const videoEarlyHold = scaleMetricToScore(row.video25, 32);
  const imageClickPull = scaleMetricToScore(row.ctrAll, 2.8);
  // No see-more metric exists in the warehouse; the former 0.35-weight term
  // was a phantom input (always 0 outside demo mode). The weight is NOT
  // renormalized so published scores stay identical to pre-removal values.
  const base = hasVideoEvidence(row)
    ? videoFirstStop * 0.7 + videoEarlyHold * 0.3
    : imageClickPull * 0.65;
  const hookSignalBoost = hasAiTagValue(row, "hookTactic") ? 6 : 0;
  const headlineSignalBoost =
    hasAiTagValue(row, "headlineTactic", "Question Headline") ||
    hasAiTagValue(row, "headlineTactic", "Number Headline")
      ? 4
      : 0;
  return clamp(base + hookSignalBoost + headlineSignalBoost, 0, 100);
}

function calculateCreativeWatchScore(row: MetaCreativeRow): number {
  if (!hasVideoEvidence(row)) return 0;
  const hookCarry = scaleMetricToScore(row.thumbstop, 28);
  const midWatch = scaleMetricToScore(row.video50, 18);
  const fullWatch = scaleMetricToScore(row.video100, 8);
  return clamp(hookCarry * 0.2 + midWatch * 0.5 + fullWatch * 0.3, 0, 100);
}

function calculateCreativeClickScore(row: MetaCreativeRow): number {
  const ctrAllScore = scaleMetricToScore(row.ctrAll, 2.8);
  const linkCtrScore = scaleMetricToScore(calculateCreativeLinkCtr(row), 2.2);
  // Former 0.15-weight see-more term removed (phantom input, always 0);
  // weights intentionally not renormalized to preserve published scores.
  return clamp(ctrAllScore * 0.45 + linkCtrScore * 0.4, 0, 100);
}

function calculateCreativeCtaScore(row: MetaCreativeRow): number {
  const linkCtrScore = scaleMetricToScore(calculateCreativeLinkCtr(row), 2.2);
  const clickToAtcScore = scaleMetricToScore(calculateCreativeClickToAddToCartRate(row), 18);
  const clickToPurchaseScore = scaleMetricToScore(calculateCreativeClickToPurchaseRate(row), 5.5);
  const ctaSignalBoost = hasAiTagValue(row, "headlineTactic", "CTA Headline") ? 8 : 0;
  return clamp(
    linkCtrScore * 0.35 + clickToAtcScore * 0.4 + clickToPurchaseScore * 0.25 + ctaSignalBoost,
    0,
    100
  );
}

function calculateCreativeOfferScore(row: MetaCreativeRow): number {
  const roasScore = scaleMetricToScore(row.roas, 4);
  const clickToAtcScore = scaleMetricToScore(calculateCreativeClickToAddToCartRate(row), 18);
  const atcToPurchaseScore = scaleMetricToScore(row.atcToPurchaseRatio, 42);
  const explicitOfferBoost =
    hasAiTagValue(row, "offerType") && !hasAiTagValue(row, "offerType", "No Explicit Offer") ? 10 : 0;
  return clamp(
    roasScore * 0.35 + clickToAtcScore * 0.25 + atcToPurchaseScore * 0.4 + explicitOfferBoost,
    0,
    100
  );
}

function calculateCreativeConvertScore(row: MetaCreativeRow): number {
  const roasScore = scaleMetricToScore(row.roas, 4);
  const clickToPurchaseScore = scaleMetricToScore(calculateCreativeClickToPurchaseRate(row), 5.5);
  const atcToPurchaseScore = scaleMetricToScore(row.atcToPurchaseRatio, 42);
  return clamp(roasScore * 0.45 + clickToPurchaseScore * 0.3 + atcToPurchaseScore * 0.25, 0, 100);
}

const FACEBOOK_ECOMMERCE_COLUMNS: TableColumnKey[] = [
  "spend",
  "purchaseValue",
  "roas",
  "cpa",
  "revenuePer1000Imp",
  "clickToAtcRatio",
  "atcToPurchaseRatio",
  "clickToPurchaseRatio",
  "averageOrderValue",
  "linkCtr",
  "purchaseValueShare",
  "ctaScore",
  "offerScore",
];

const META_COPY_PERFORMANCE_COLUMNS: TableColumnKey[] = [
  "spend",
  "purchaseValue",
  "roas",
  "cpa",
  "cpcLink",
  "purchases",
  "linkCtr",
  "clickToAtcRatio",
  "atcToPurchaseRatio",
  "clickToPurchaseRatio",
  "linkClicks",
  "purchaseValueShare",
];

const PRESETS: TablePreset[] = [
  {
    presetName: "Facebook Ecommerce",
    summary: "Built for purchase ads. Prioritizes unit economics, post-click flow, and revenue density over vanity engagement.",
    selectedColumns: FACEBOOK_ECOMMERCE_COLUMNS,
    selectedAiTagColumns: ["offerType", "messagingAngle", "hookTactic"],
    resultsPerPage: 20,
    colorFormatting: "heatmap",
    showActiveStatus: false,
    showLaunchDate: true,
    showAdLength: false,
  },
  {
    presetName: "Facebook Video",
    summary: "Built for video creative review. Prioritizes hook strength, watch-through quality, and click carry from motion assets.",
    selectedColumns: [
      "spend",
      "thumbstopRatio",
      "video25Rate",
      "video50Rate",
      "video100Rate",
      "hookScore",
      "watchScore",
      "clickScore",
      "linkCtr",
    ],
    selectedAiTagColumns: ["visualFormat", "hookTactic", "headlineTactic"],
    resultsPerPage: 20,
    colorFormatting: "heatmap",
    showActiveStatus: false,
    showLaunchDate: true,
    showAdLength: true,
  },
  {
    presetName: "Meta Copy Performance",
    summary: "Copy-specific preset kept for the dedicated copies workflow.",
    selectedColumns: META_COPY_PERFORMANCE_COLUMNS,
    selectedAiTagColumns: [],
    resultsPerPage: 20,
    colorFormatting: "heatmap",
    showActiveStatus: false,
    showLaunchDate: true,
    showAdLength: false,
    hiddenFromMenu: true,
  },
  {
    presetName: "Creative teams",
    summary: "Creative-friendly score view. Replaces raw buyer metrics with 0-100 reads on hook, CTA, offer, and conversion fit.",
    selectedColumns: ["hookScore", "ctaScore", "offerScore", "clickScore", "convertScore"],
    selectedAiTagColumns: ["visualFormat", "messagingAngle", "hookTactic", "offerType"],
    resultsPerPage: 20,
    colorFormatting: "heatmap",
    showActiveStatus: false,
    showLaunchDate: true,
    showAdLength: false,
  },
  {
    presetName: "Facebook SaaS",
    summary: "Built for lead-gen and demo funnels. Prioritizes lead efficiency, CTA pull, and demand capture over purchase math.",
    selectedColumns: ["spend", "impressions", "leads", "cpl", "ctrAll", "cpcLink", "linkClicks", "messages", "cpMessage", "ctaScore"],
    selectedAiTagColumns: ["intendedAudience", "messagingAngle", "headlineTactic"],
    resultsPerPage: 20,
    colorFormatting: "heatmap",
    showActiveStatus: false,
    showLaunchDate: true,
    showAdLength: true,
  },
  {
    presetName: "Customize columns",
    summary: "Start from a light baseline and assemble your own working view.",
    selectedColumns: ["spend", "purchaseValue", "roas", "purchases"],
    selectedAiTagColumns: [],
    resultsPerPage: 20,
    colorFormatting: "heatmap",
    showActiveStatus: false,
    showLaunchDate: true,
    showAdLength: false,
  },
];

const TABLE_COLUMNS: TableColumnDefinition[] = [
  { key: "spend", label: "Spend", description: "Amount spent.", direction: "neutral", minWidth: 120, preferredWidth: 130, align: "right", format: fmtCurrency, getValue: (r) => r.spend },
  { key: "purchaseValue", label: "Purchase value", description: "Revenue from purchases.", direction: "high", minWidth: 128, preferredWidth: 140, align: "right", format: fmtCurrency, getValue: (r) => r.purchaseValue },
  { key: "roas", label: "ROAS (return on ad spend)", description: "Revenue / spend.", direction: "high", minWidth: 88, preferredWidth: 92, align: "right", format: (n) => n.toFixed(2), getValue: (r) => r.roas },
  { key: "cpa", label: "Cost per purchase", description: "Spend per purchase.", direction: "low", minWidth: 106, preferredWidth: 112, align: "right", format: fmtCurrency, getValue: (r) => r.cpa },
  { key: "cpcLink", label: "Cost per link click", description: "Spend per link click.", direction: "low", minWidth: 106, preferredWidth: 112, align: "right", format: fmtCurrency, getValue: (r) => r.cpcLink },
  { key: "cpm", label: "Cost per mille", description: "Spend per 1000 impressions.", direction: "low", minWidth: 106, preferredWidth: 112, align: "right", format: fmtCurrency, getValue: (r) => r.cpm },
  { key: "cpcAll", label: "Cost per click (all)", description: "Spend per all clicks.", direction: "low", minWidth: 106, preferredWidth: 112, align: "right", format: fmtCurrency, getValue: (r) => calculateCreativeCpcAll(r) },
  { key: "averageOrderValue", label: "Average order value", description: "Purchase value / purchases.", direction: "high", minWidth: 122, preferredWidth: 132, align: "right", format: fmtCurrency, getValue: (r) => calculateCreativeAverageOrderValue(r) },
  { key: "clickToAtcRatio", label: "Click to add-to-cart ratio", description: "Link clicks that reached add to cart.", direction: "high", minWidth: 150, preferredWidth: 170, align: "right", format: fmtPercent, getValue: (r) => calculateCreativeClickToAddToCartRate(r) },
  { key: "atcToPurchaseRatio", label: "Add-to-cart to purchase ratio", description: "ATC to purchase conversion.", direction: "high", minWidth: 155, preferredWidth: 180, align: "right", format: fmtPercent, getValue: (r) => r.atcToPurchaseRatio },
  { key: "purchases", label: "Purchases", description: "Purchase count.", direction: "high", minWidth: 76, preferredWidth: 84, align: "right", format: fmtInteger, getValue: (r) => r.purchases },
  { key: "firstFrameRetention", label: "First-impression proxy (thumbstop)", description: "Compatibility proxy that reuses thumbstop ratio.", direction: "high", minWidth: 195, preferredWidth: 215, align: "right", format: fmtPercent, getValue: (r) => r.thumbstop },
  { key: "thumbstopRatio", label: "Thumbstop ratio", description: "Thumbstop performance ratio.", direction: "high", minWidth: 120, preferredWidth: 140, align: "right", format: fmtPercent, getValue: (r) => r.thumbstop },
  { key: "ctrOutbound", label: "Link CTR (compat)", description: "Compatibility column that uses link clicks / impressions.", direction: "high", minWidth: 140, preferredWidth: 160, align: "right", format: fmtPercent, getValue: (r) => calculateCreativeLinkCtr(r) },
  { key: "clickToPurchaseRatio", label: "Click to purchase ratio", description: "Link clicks that became purchases.", direction: "high", minWidth: 145, preferredWidth: 165, align: "right", format: fmtPercent, getValue: (r) => calculateCreativeClickToPurchaseRate(r) },
  { key: "ctrAll", label: "Click through rate (all)", description: "All-click CTR.", direction: "high", minWidth: 135, preferredWidth: 150, align: "right", format: fmtPercent, getValue: (r) => r.ctrAll },
  { key: "video25Rate", label: "25% video plays (rate)", description: "25% play rate.", direction: "high", minWidth: 145, preferredWidth: 165, align: "right", format: fmtPercent, getValue: (r) => r.video25 },
  { key: "video50Rate", label: "50% video plays (rate)", description: "50% play rate.", direction: "high", minWidth: 145, preferredWidth: 165, align: "right", format: fmtPercent, getValue: (r) => r.video50 },
  { key: "video75Rate", label: "75% video plays (rate)", description: "75% play rate.", direction: "high", minWidth: 145, preferredWidth: 165, align: "right", format: fmtPercent, getValue: (r) => r.video75 },
  { key: "video100Rate", label: "100% video plays (rate)", description: "100% play rate.", direction: "high", minWidth: 150, preferredWidth: 170, align: "right", format: fmtPercent, getValue: (r) => r.video100 },
  { key: "holdRate", label: "Completion proxy (100% plays)", description: "Compatibility proxy that reuses 100% video plays.", direction: "high", minWidth: 190, preferredWidth: 210, align: "right", format: fmtPercent, getValue: (r) => r.video100 },
  { key: "hookScore", label: "Hook score", description: "0-100 read on first-stop strength using early attention and hook signals.", direction: "high", minWidth: 118, preferredWidth: 132, align: "right", format: (n) => n.toFixed(0), getValue: (r) => calculateCreativeHookScore(r) },
  { key: "ctaScore", label: "CTA score", description: "0-100 read on how clearly the ad pulls qualified clicks toward action.", direction: "high", minWidth: 110, preferredWidth: 124, align: "right", format: (n) => n.toFixed(0), getValue: (r) => calculateCreativeCtaScore(r) },
  { key: "offerScore", label: "Offer score", description: "0-100 read on commercial pull using offer presence plus cart and purchase behavior.", direction: "high", minWidth: 118, preferredWidth: 132, align: "right", format: (n) => n.toFixed(0), getValue: (r) => calculateCreativeOfferScore(r) },
  { key: "purchaseValueShare", label: "% purchase value", description: "Share of purchase value.", direction: "high", minWidth: 130, preferredWidth: 145, align: "right", format: fmtPercent, getValue: (r, c) => calculateCreativePurchaseValueShare(r, c.totalPurchaseValue) },
  { key: "watchScore", label: "Watch score", description: "0-100 read on mid-watch and completion quality for video creatives.", direction: "high", minWidth: 118, preferredWidth: 132, align: "right", format: (n) => n.toFixed(0), getValue: (r) => calculateCreativeWatchScore(r) },
  { key: "clickScore", label: "Click score", description: "0-100 read on click quality using CTR, link CTR, and expansion intent.", direction: "high", minWidth: 118, preferredWidth: 132, align: "right", format: (n) => n.toFixed(0), getValue: (r) => calculateCreativeClickScore(r) },
  { key: "convertScore", label: "Conversion fit score", description: "0-100 read on commercial efficiency using ROAS and post-click conversion.", direction: "high", minWidth: 150, preferredWidth: 170, align: "right", format: (n) => n.toFixed(0), getValue: (r) => calculateCreativeConvertScore(r) },
  { key: "averageOrderValueWebsite", label: "Average order value (website)", description: "Website AOV.", direction: "high", minWidth: 175, preferredWidth: 195, align: "right", format: fmtCurrency, getValue: (r) => calculateCreativeAverageOrderValue(r) },
  { key: "averageOrderValueShop", label: "Average order value (Shop)", description: "Shop AOV.", direction: "high", minWidth: 165, preferredWidth: 185, align: "right", format: fmtCurrency, getValue: (r) => calculateCreativeAverageOrderValue(r) },
  { key: "impressions", label: "Impressions", description: "Impression count.", direction: "high", minWidth: 120, preferredWidth: 140, align: "right", format: fmtInteger, getValue: (r) => r.impressions },
  { key: "spendShare", label: "% spend", description: "Share of spend.", direction: "neutral", minWidth: 100, preferredWidth: 120, align: "right", format: fmtPercent, getValue: (r, c) => calculateCreativeSpendShare(r, c.totalSpend) },
  { key: "linkCtr", label: "Link CTR", description: "Link clicks / impressions.", direction: "high", minWidth: 110, preferredWidth: 125, align: "right", format: fmtPercent, getValue: (r) => calculateCreativeLinkCtr(r) },
  { key: "websitePurchaseRoas", label: "Website purchase ROAS", description: "Website purchase ROAS.", direction: "high", minWidth: 145, preferredWidth: 165, align: "right", format: (n) => n.toFixed(2), getValue: (r) => r.roas },
  { key: "clickToWebsitePurchaseRatio", label: "Click to website purchase ratio", description: "Click-to-website purchase conversion.", direction: "high", minWidth: 185, preferredWidth: 210, align: "right", format: fmtPercent, getValue: (r) => calculateCreativeClickToPurchaseRate(r) },
  { key: "purchasesPer1000Imp", label: "Purchases per 1,000 impressions", description: "Purchases normalized by 1,000 impressions.", direction: "high", minWidth: 200, preferredWidth: 230, align: "right", format: (n) => n.toFixed(2), getValue: (r) => calculateCreativePurchasesPer1000Impressions(r) },
  { key: "revenuePer1000Imp", label: "Revenue per 1,000 impressions", description: "Revenue normalized by 1,000 impressions.", direction: "high", minWidth: 190, preferredWidth: 220, align: "right", format: fmtCurrency, getValue: (r) => calculateCreativeRevenuePer1000Impressions(r) },
  { key: "clicksAll", label: "Clicks (all)", description: "All clicks.", direction: "high", minWidth: 110, preferredWidth: 130, align: "right", format: fmtInteger, getValue: (r) => r.clicks },
  { key: "linkClicks", label: "Link clicks", description: "Link click count.", direction: "high", minWidth: 110, preferredWidth: 130, align: "right", format: fmtInteger, getValue: (r) => r.linkClicks },
  { key: "leads", label: "Leads", description: "Lead count.", direction: "high", minWidth: 76, preferredWidth: 84, align: "right", format: fmtInteger, getValue: (r) => r.leads },
  { key: "cpl", label: "Cost per lead", description: "Spend per lead.", direction: "low", minWidth: 106, preferredWidth: 112, align: "right", format: fmtCurrency, getValue: (r) => r.leads > 0 ? r.spend / r.leads : 0 },
  { key: "messages", label: "Messages", description: "Messaging conversations started.", direction: "high", minWidth: 96, preferredWidth: 110, align: "right", format: fmtInteger, getValue: (r) => r.messages },
  { key: "cpMessage", label: "Cost per message", description: "Spend per messaging conversation started.", direction: "low", minWidth: 130, preferredWidth: 145, align: "right", format: fmtCurrency, getValue: (r) => r.messages > 0 ? r.spend / r.messages : 0 },
];

const TABLE_COLUMN_MAP: Record<TableColumnKey, TableColumnDefinition> = TABLE_COLUMNS.reduce(
  (acc, column) => {
    acc[column.key] = column;
    return acc;
  },
  {} as Record<TableColumnKey, TableColumnDefinition>
);

function isTableColumnKey(value: unknown): value is TableColumnKey {
  return typeof value === "string" && value in TABLE_COLUMN_MAP;
}

export function buildCreativeTableHeatBenchmark(rows: MetaCreativeRow[]) {
  const ctx: TableCalcContext = {
    totalSpend: rows.reduce((sum, row) => sum + row.spend, 0),
    totalPurchaseValue: rows.reduce((sum, row) => sum + row.purchaseValue, 0),
    totalPurchases: rows.reduce((sum, row) => sum + row.purchases, 0),
    totalImpressions: rows.reduce((sum, row) => sum + row.impressions, 0),
    totalLinkClicks: rows.reduce((sum, row) => sum + row.linkClicks, 0),
  };

  return {
    ctx,
    metricDistributions: TABLE_COLUMNS.reduce<Partial<Record<TableColumnKey, MetricDistribution>>>(
      (acc, column) => {
        const values = rows
          .filter((row) => isMetricApplicable(column.key, row))
          .map((row) => column.getValue(row, ctx))
          .filter((n) => Number.isFinite(n));
        acc[column.key] = buildDistribution(values);
        return acc;
      },
      {}
    ),
    metricSpendDistributions: TABLE_COLUMNS.reduce<Partial<Record<TableColumnKey, MetricDistribution>>>(
      (acc, column) => {
        const values = rows
          .filter((row) => isMetricApplicable(column.key, row))
          .map((row) => row.spend)
          .filter((n) => Number.isFinite(n));
        acc[column.key] = buildDistribution(values);
        return acc;
      },
      {}
    ),
  };
}

export function evaluateCreativeMetricPreviewHeat(input: {
  metricId: string;
  row: MetaCreativeRow;
  benchmark: ReturnType<typeof buildCreativeTableHeatBenchmark>;
  baselineLabel?: string;
}): HeatEvaluation | null {
  const { metricId, row, benchmark, baselineLabel = "current table baseline" } = input;
  const tableKey = TOP_TO_TABLE_METRIC_ID[metricId];
  if (!tableKey) return null;
  const column = TABLE_COLUMN_MAP[tableKey];
  if (!column) return null;
  const value = column.getValue(row, benchmark.ctx);

  return evaluateMetricCell({
    key: tableKey,
    value,
    row,
    ctx: benchmark.ctx,
    distribution: benchmark.metricDistributions[tableKey] ?? buildDistribution([value]),
    roasDistribution: benchmark.metricDistributions.roas,
    spendDistribution: benchmark.metricSpendDistributions[tableKey] ?? buildDistribution([row.spend]),
    baselineLabel,
  });
}

const AI_TAG_GROUPS: Array<{ label: string; items: Array<{ label: string; value: TagKey }> }> = [
  { label: "Visual", items: [{ label: "Asset Type", value: "assetType" }, { label: "Visual Format", value: "visualFormat" }] },
  { label: "Persona", items: [{ label: "Intended Audience", value: "intendedAudience" }] },
  { label: "Messaging", items: [{ label: "Messaging Angle", value: "messagingAngle" }, { label: "Seasonality", value: "seasonality" }, { label: "Offer Type", value: "offerType" }] },
  { label: "Hook", items: [{ label: "Hook Tactic", value: "hookTactic" }, { label: "Headline Tactic", value: "headlineTactic" }] },
];

function isAiTagKey(value: unknown): value is TagKey {
  return typeof value === "string" && (AI_TAG_COLUMN_KEYS as readonly string[]).includes(value);
}

function sanitizeTableSortKey(value: unknown): TableSortState["key"] {
  if (value === "name" || value === "launchDate") return value;
  if (isTableColumnKey(value)) return value;
  if (typeof value === "string" && value.startsWith("aiTag:")) {
    const tagKey = value.slice("aiTag:".length);
    return isAiTagKey(tagKey) ? (`aiTag:${tagKey}` as const) : null;
  }
  return null;
}

export function sanitizeCreativeTableSortState(value: unknown): TableSortState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as { key?: unknown; direction?: unknown };
  const key = sanitizeTableSortKey(source.key);
  const direction =
    source.direction === "asc" || source.direction === "desc" ? source.direction : null;
  return key && direction ? { key, direction } : null;
}

export function sanitizeCreativeTableColumnWidths(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.entries(value as Record<string, unknown>).reduce<Record<string, number>>(
    (acc, [key, width]) => {
      const parsed = Number(width);
      if (!Number.isFinite(parsed) || parsed <= 0) return acc;
      acc[key] = parsed;
      return acc;
    },
    {},
  );
}

const PRESET_NOTES = "Preset controls only this table. Top creative cards keep their own metric model.";
const VIRTUAL_ROW_HEIGHT = 58;
const VIRTUAL_OVERSCAN = 6;

const TABLE_TO_TOP_METRIC_ID: Partial<Record<TableColumnKey, string>> = {
  spend: "spend",
  purchaseValue: "purchaseValue",
  roas: "roas",
  cpa: "costPerPurchase",
  cpcLink: "costPerLinkClick",
  cpm: "costPerMille",
  cpcAll: "costPerClickAll",
  averageOrderValue: "averageOrderValue",
  clickToAtcRatio: "clickToAtcRatio",
  atcToPurchaseRatio: "atcToPurchaseRatio",
  purchases: "purchases",
  firstFrameRetention: "firstFrameRetention",
  thumbstopRatio: "thumbstopRatio",
  ctrOutbound: "ctrOutbound",
  clickToPurchaseRatio: "clickToPurchaseRatio",
  ctrAll: "ctrAll",
  video25Rate: "video25Rate",
  video50Rate: "video50Rate",
  video75Rate: "video75Rate",
  video100Rate: "video100Rate",
  holdRate: "holdRate",
  hookScore: "hookScore",
  ctaScore: "ctaScore",
  offerScore: "offerScore",
  purchaseValueShare: "purchaseValueShare",
  watchScore: "watchScore",
  clickScore: "clickScore",
  convertScore: "convertScore",
  averageOrderValueWebsite: "averageOrderValueWebsite",
  impressions: "impressions",
  spendShare: "spendShare",
  linkCtr: "linkCtr",
  websitePurchaseRoas: "websitePurchaseRoas",
  clickToWebsitePurchaseRatio: "clickToWebsitePurchaseRatio",
  purchasesPer1000Imp: "purchasesPer1000Imp",
  revenuePer1000Imp: "revenuePer1000Imp",
  clicksAll: "clicksAll",
  linkClicks: "linkClicks",
  leads: "leads",
  cpl: "cpl",
  messages: "messages",
  cpMessage: "cpMessage",
};

const TOP_TO_TABLE_METRIC_ID: Partial<Record<string, TableColumnKey>> = Object.entries(TABLE_TO_TOP_METRIC_ID).reduce(
  (acc, [tableKey, topMetricId]) => {
    if (topMetricId) {
      acc[topMetricId] = tableKey as TableColumnKey;
    }
    return acc;
  },
  {} as Partial<Record<string, TableColumnKey>>
);

const DEFAULT_TABLE_METRIC_CONFIG: TableMetricConfig = {
  direction: "neutral",
  colorMode: "none",
  spendSensitive: false,
  footerAggregation: "avg",
  heatStrength: "soft",
  applicableFormats: ["image", "video"],
};

const TABLE_METRIC_CONFIG: Partial<Record<TableColumnKey, TableMetricConfig>> = {
  spend: { direction: "neutral", colorMode: "none", spendSensitive: false, footerAggregation: "sum", heatStrength: "soft", applicableFormats: ["image", "video"] },
  purchaseValue: { direction: "higher_better", colorMode: "quantile", spendSensitive: true, footerAggregation: "sum", heatStrength: "soft", applicableFormats: ["image", "video"] },
  roas: { direction: "higher_better", colorMode: "semantic", spendSensitive: true, footerAggregation: "weighted", heatStrength: "strong", applicableFormats: ["image", "video"] },
  cpa: { direction: "lower_better", colorMode: "semantic", spendSensitive: true, footerAggregation: "weighted", heatStrength: "strong", applicableFormats: ["image", "video"] },
  cpcLink: { direction: "lower_better", colorMode: "semantic", spendSensitive: true, footerAggregation: "weighted", heatStrength: "medium", applicableFormats: ["image", "video"] },
  cpm: { direction: "lower_better", colorMode: "semantic", spendSensitive: true, footerAggregation: "weighted", heatStrength: "medium", applicableFormats: ["image", "video"] },
  cpcAll: { direction: "lower_better", colorMode: "semantic", spendSensitive: true, footerAggregation: "weighted", heatStrength: "medium", applicableFormats: ["image", "video"] },
  averageOrderValue: { direction: "higher_better", colorMode: "quantile", spendSensitive: false, footerAggregation: "weighted", heatStrength: "soft", applicableFormats: ["image", "video"] },
  clickToAtcRatio: { direction: "higher_better", colorMode: "quantile", spendSensitive: false, footerAggregation: "weighted", heatStrength: "soft", applicableFormats: ["image", "video"] },
  atcToPurchaseRatio: { direction: "higher_better", colorMode: "quantile", spendSensitive: false, footerAggregation: "weighted", heatStrength: "soft", applicableFormats: ["image", "video"] },
  purchases: { direction: "higher_better", colorMode: "quantile", spendSensitive: true, footerAggregation: "sum", heatStrength: "soft", applicableFormats: ["image", "video"] },
  firstFrameRetention: { direction: "higher_better", colorMode: "quantile", spendSensitive: false, footerAggregation: "weighted", heatStrength: "soft", applicableFormats: ["video"], minConfidenceThreshold: { minSpend: 50, minImpressions: 1000, minEstimatedViews: 200 } },
  thumbstopRatio: { direction: "higher_better", colorMode: "quantile", spendSensitive: false, footerAggregation: "weighted", heatStrength: "soft", applicableFormats: ["video"], minConfidenceThreshold: { minSpend: 50, minImpressions: 1000, minEstimatedViews: 200 } },
  ctrOutbound: { direction: "higher_better", colorMode: "quantile", spendSensitive: false, footerAggregation: "weighted", heatStrength: "soft", applicableFormats: ["image", "video"] },
  clickToPurchaseRatio: { direction: "higher_better", colorMode: "quantile", spendSensitive: false, footerAggregation: "weighted", heatStrength: "soft", applicableFormats: ["image", "video"] },
  ctrAll: { direction: "higher_better", colorMode: "quantile", spendSensitive: false, footerAggregation: "weighted", heatStrength: "soft", applicableFormats: ["image", "video"] },
  video25Rate: { direction: "higher_better", colorMode: "quantile", spendSensitive: false, footerAggregation: "weighted", heatStrength: "soft", applicableFormats: ["video"], minConfidenceThreshold: { minSpend: 50, minImpressions: 1000, minEstimatedViews: 200 } },
  video50Rate: { direction: "higher_better", colorMode: "quantile", spendSensitive: false, footerAggregation: "weighted", heatStrength: "soft", applicableFormats: ["video"], minConfidenceThreshold: { minSpend: 50, minImpressions: 1000, minEstimatedViews: 200 } },
  video75Rate: { direction: "higher_better", colorMode: "quantile", spendSensitive: false, footerAggregation: "weighted", heatStrength: "soft", applicableFormats: ["video"], minConfidenceThreshold: { minSpend: 50, minImpressions: 1000, minEstimatedViews: 200 } },
  video100Rate: { direction: "higher_better", colorMode: "quantile", spendSensitive: false, footerAggregation: "weighted", heatStrength: "soft", applicableFormats: ["video"], minConfidenceThreshold: { minSpend: 50, minImpressions: 1000, minEstimatedViews: 200 } },
  holdRate: { direction: "higher_better", colorMode: "quantile", spendSensitive: false, footerAggregation: "weighted", heatStrength: "soft", applicableFormats: ["video"], minConfidenceThreshold: { minSpend: 50, minImpressions: 1000, minEstimatedViews: 200 } },
  hookScore: { direction: "higher_better", colorMode: "quantile", spendSensitive: false, footerAggregation: "avg", heatStrength: "soft", applicableFormats: ["image", "video"] },
  ctaScore: { direction: "higher_better", colorMode: "quantile", spendSensitive: false, footerAggregation: "avg", heatStrength: "soft", applicableFormats: ["image", "video"] },
  offerScore: { direction: "higher_better", colorMode: "quantile", spendSensitive: false, footerAggregation: "avg", heatStrength: "soft", applicableFormats: ["image", "video"] },
  purchaseValueShare: { direction: "higher_better", colorMode: "quantile", spendSensitive: false, footerAggregation: "weighted", heatStrength: "soft", applicableFormats: ["image", "video"] },
  watchScore: { direction: "higher_better", colorMode: "quantile", spendSensitive: false, footerAggregation: "avg", heatStrength: "soft", applicableFormats: ["video"], minConfidenceThreshold: { minSpend: 50, minImpressions: 1000, minEstimatedViews: 200 } },
  clickScore: { direction: "higher_better", colorMode: "quantile", spendSensitive: false, footerAggregation: "avg", heatStrength: "soft", applicableFormats: ["image", "video"] },
  convertScore: { direction: "higher_better", colorMode: "quantile", spendSensitive: false, footerAggregation: "avg", heatStrength: "soft", applicableFormats: ["image", "video"] },
  averageOrderValueWebsite: { direction: "higher_better", colorMode: "quantile", spendSensitive: false, footerAggregation: "weighted", heatStrength: "soft", applicableFormats: ["image", "video"] },
  averageOrderValueShop: { direction: "higher_better", colorMode: "quantile", spendSensitive: false, footerAggregation: "weighted", heatStrength: "soft", applicableFormats: ["image", "video"] },
  impressions: { direction: "neutral", colorMode: "none", spendSensitive: false, footerAggregation: "sum", heatStrength: "soft", applicableFormats: ["image", "video"] },
  spendShare: { direction: "neutral", colorMode: "none", spendSensitive: false, footerAggregation: "weighted", heatStrength: "soft", applicableFormats: ["image", "video"] },
  linkCtr: { direction: "higher_better", colorMode: "quantile", spendSensitive: false, footerAggregation: "weighted", heatStrength: "soft", applicableFormats: ["image", "video"] },
  websitePurchaseRoas: { direction: "higher_better", colorMode: "semantic", spendSensitive: true, footerAggregation: "weighted", heatStrength: "strong", applicableFormats: ["image", "video"] },
  clickToWebsitePurchaseRatio: { direction: "higher_better", colorMode: "quantile", spendSensitive: false, footerAggregation: "weighted", heatStrength: "soft", applicableFormats: ["image", "video"] },
  purchasesPer1000Imp: { direction: "higher_better", colorMode: "quantile", spendSensitive: false, footerAggregation: "weighted", heatStrength: "soft", applicableFormats: ["image", "video"] },
  revenuePer1000Imp: { direction: "higher_better", colorMode: "quantile", spendSensitive: false, footerAggregation: "weighted", heatStrength: "soft", applicableFormats: ["image", "video"] },
  clicksAll: { direction: "neutral", colorMode: "none", spendSensitive: false, footerAggregation: "sum", heatStrength: "soft", applicableFormats: ["image", "video"] },
  linkClicks: { direction: "neutral", colorMode: "none", spendSensitive: false, footerAggregation: "sum", heatStrength: "soft", applicableFormats: ["image", "video"] },
  leads: { direction: "higher_better", colorMode: "quantile", spendSensitive: true, footerAggregation: "sum", heatStrength: "soft", applicableFormats: ["image", "video"] },
  cpl: { direction: "lower_better", colorMode: "semantic", spendSensitive: true, footerAggregation: "weighted", heatStrength: "medium", applicableFormats: ["image", "video"] },
  messages: { direction: "higher_better", colorMode: "quantile", spendSensitive: true, footerAggregation: "sum", heatStrength: "soft", applicableFormats: ["image", "video"] },
  cpMessage: { direction: "lower_better", colorMode: "semantic", spendSensitive: true, footerAggregation: "weighted", heatStrength: "medium", applicableFormats: ["image", "video"] },
};

export function CreativesTableSection({
  rows,
  creativeHistoryById,
  defaultCurrency,
  initialPresetName = "Facebook Ecommerce",
  selectedMetricIds,
  onSelectedMetricIdsChange,
  selectedRowIds,
  highlightedRowId = null,
  onToggleRow,
  onToggleAll,
  onOpenRow,
  onOpenBreakdownRow,
  onSortedRowsChange,
  v3Decisions = null,
  v3Flags = null,
  buyerDecisionLanguage = false,
}: CreativesTableSectionProps) {
  const defaultPreset = PRESETS.find((p) => p.presetName === initialPresetName) ?? PRESETS[0];
  const [tablePreset, setTablePreset] = useState<TablePreset>(defaultPreset);
  const [presetSearch, setPresetSearch] = useState("");
  const [showPresetMenu, setShowPresetMenu] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showTagsMenu, setShowTagsMenu] = useState(false);
  const [tagsSearch, setTagsSearch] = useState("");
  const [showMetricModal, setShowMetricModal] = useState(false);
  const [modalSearch, setModalSearch] = useState("");
  const [hoverMetric, setHoverMetric] = useState<TableColumnKey | null>(null);
  const [modalColumns, setModalColumns] = useState<TableColumnKey[]>(tablePreset.selectedColumns);
  const [page, setPage] = useState(1);
  const [tooltip, setTooltip] = useState<MetricTooltipState | null>(null);
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>(() => getDefaultColumnWidths());
  const [isResizing, setIsResizing] = useState(false);
  const [sortState, setSortState] = useState<TableSortState>({ key: "spend", direction: "desc" });
  const presetWrapRef = useRef<HTMLDivElement>(null);
  const presetTriggerRef = useRef<HTMLButtonElement>(null);
  const presetSearchRef = useRef<HTMLInputElement>(null);
  const settingsWrapRef = useRef<HTMLDivElement>(null);
  const settingsTriggerRef = useRef<HTMLButtonElement>(null);
  const tagsWrapRef = useRef<HTMLDivElement>(null);
  const tagsTriggerRef = useRef<HTMLButtonElement>(null);
  const tagsSearchRef = useRef<HTMLInputElement>(null);
  const resizeStateRef = useRef<{
    key: string;
    startX: number;
    startWidth: number;
    minWidth: number;
  } | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);

  useDropdownBehavior({
    id: "table-preset-menu",
    open: showPresetMenu,
    setOpen: setShowPresetMenu,
    containerRef: presetWrapRef,
    triggerRef: presetTriggerRef,
    focusRef: presetSearchRef,
  });

  useDropdownBehavior({
    id: "table-settings-menu",
    open: showSettings,
    setOpen: setShowSettings,
    containerRef: settingsWrapRef,
    triggerRef: settingsTriggerRef,
  });

  useDropdownBehavior({
    id: "table-ai-tags-menu",
    open: showTagsMenu,
    setOpen: setShowTagsMenu,
    containerRef: tagsWrapRef,
    triggerRef: tagsTriggerRef,
    focusRef: tagsSearchRef,
  });

  const visiblePresets = PRESETS.filter(
    (preset) => !preset.hiddenFromMenu || preset.presetName === tablePreset.presetName
  );
  const filteredPresets = visiblePresets.filter((preset) => {
    const query = presetSearch.toLowerCase();
    return (
      preset.presetName.toLowerCase().includes(query) ||
      preset.summary.toLowerCase().includes(query)
    );
  });
  const filteredAiTagGroups = useMemo(() => {
    const query = tagsSearch.trim().toLowerCase();
    if (!query) return AI_TAG_GROUPS;
    return AI_TAG_GROUPS.map((group) => ({
      ...group,
      items: group.items.filter((item) => item.label.toLowerCase().includes(query)),
    })).filter((group) => group.items.length > 0);
  }, [tagsSearch]);

  const selectedRowIdSet = useMemo(() => new Set(selectedRowIds), [selectedRowIds]);

  const ctx: TableCalcContext = useMemo(
    () => ({
      totalSpend: rows.reduce((sum, row) => sum + row.spend, 0),
      totalPurchaseValue: rows.reduce((sum, row) => sum + row.purchaseValue, 0),
      totalPurchases: rows.reduce((sum, row) => sum + row.purchases, 0),
      totalImpressions: rows.reduce((sum, row) => sum + row.impressions, 0),
      totalLinkClicks: rows.reduce((sum, row) => sum + row.linkClicks, 0),
    }),
    [rows]
  );

  const viewportWidth = useViewportWidth();

  const presetColumns = useMemo(
    () => tablePreset.selectedColumns.map((key) => TABLE_COLUMN_MAP[key]).filter(Boolean),
    [tablePreset.selectedColumns]
  );

  // On a phone the preset's full width becomes a horizontal scroller that hides
  // spend and ROAS behind an affordance most people never find. Narrow screens
  // get the columns that fit, economics first, rather than a shrunken desktop
  // table.
  const columnPriority = useMemo(() => {
    if (!viewportWidth || !isNarrowViewport(viewportWidth)) return null;
    return resolveCreativeColumnPriority({
      viewportWidth,
      identityWidth: STATIC_COLUMN_SPECS.creativeName.minWidth,
      chromeWidth: 32,
      columns: presetColumns.map((column) => ({
        key: column.key,
        preferredWidth: column.preferredWidth,
        minWidth: column.minWidth,
      })),
    });
  }, [presetColumns, viewportWidth]);

  const selectedColumns = useMemo(() => {
    if (!columnPriority) return presetColumns;
    const visible = new Set(columnPriority.visibleKeys);
    return presetColumns.filter((column) => visible.has(column.key));
  }, [columnPriority, presetColumns]);
  const selectedAiTagColumns = tablePreset.selectedAiTagColumns;
  const presetTagSummary = useMemo(
    () => selectedAiTagColumns.map((tagKey) => prettyTagLabel(tagKey)).join(", "),
    [selectedAiTagColumns]
  );
  const heatmapBaselineLabel = "current table baseline";
  const heatmapGuideTitle =
    "Heatmap compares each metric against the current table selection. Best-performing cells trend greener, weakest cells trend redder, and stronger tint means a larger performance gap. Efficiency metrics use a baseline average, engagement metrics use peer bands, and lower-cost metrics still read as better when lower.";

  const sortedRows = useMemo(() => {
    const t = Date.now();
    if (!sortState.key || !sortState.direction) return rows;
    const next = [...rows];
    const directionFactor = sortState.direction === "asc" ? 1 : -1;
    next.sort((a, b) => {
      const activeSortKey = sortState.key;
      if (!activeSortKey) return 0;
      if (activeSortKey === "name") {
        return safeTableText(a.name).localeCompare(safeTableText(b.name), undefined, { sensitivity: "base", numeric: true }) * directionFactor;
      }
      if (activeSortKey === "launchDate") {
        return (parseLaunchDate(a.launchDate) - parseLaunchDate(b.launchDate)) * directionFactor;
      }
      if (typeof activeSortKey === "string" && activeSortKey.startsWith("aiTag:")) {
        const aiTagKey = activeSortKey.replace("aiTag:", "") as TagKey;
        const aValue = safeTableStringArray(a.aiTags?.[aiTagKey]).join(", ");
        const bValue = safeTableStringArray(b.aiTags?.[aiTagKey]).join(", ");
        return aValue.localeCompare(bValue, undefined, { sensitivity: "base", numeric: true }) * directionFactor;
      }
      const column = TABLE_COLUMN_MAP[activeSortKey as TableColumnKey];
      if (!column) return 0;
      const aValue = column.getValue(a, ctx);
      const bValue = column.getValue(b, ctx);
      return (aValue - bValue) * directionFactor;
    });
    logPerf("table.sortRows", t, rows.length);
    return next;
  }, [ctx, rows, sortState.direction, sortState.key]);

  useEffect(() => {
    onSortedRowsChange?.(sortedRows);
  }, [onSortedRowsChange, sortedRows]);
  const allSelected = sortedRows.length > 0 && sortedRows.every((row) => selectedRowIdSet.has(safeTableText(row.id)));

  const totalResults = sortedRows.length;
  const pageCount = Math.max(1, Math.ceil(totalResults / tablePreset.resultsPerPage));
  const safePage = Math.min(page, pageCount);
  const startIndex = (safePage - 1) * tablePreset.resultsPerPage;
  const endIndex = Math.min(totalResults, startIndex + tablePreset.resultsPerPage);
  const pagedRows = useMemo(() => sortedRows.slice(startIndex, endIndex), [sortedRows, startIndex, endIndex]);
  const virtualizationEnabled = false;
  const visibleRowCount = virtualizationEnabled
    ? Math.max(8, Math.ceil(620 / VIRTUAL_ROW_HEIGHT) + VIRTUAL_OVERSCAN * 2)
    : pagedRows.length;
  const virtualWindowStart = virtualizationEnabled
    ? Math.max(0, Math.floor(scrollTop / VIRTUAL_ROW_HEIGHT) - VIRTUAL_OVERSCAN)
    : 0;
  const virtualWindowEnd = virtualizationEnabled
    ? Math.min(pagedRows.length, virtualWindowStart + visibleRowCount)
    : pagedRows.length;
  const visiblePagedRows = useMemo(
    () => pagedRows.slice(virtualWindowStart, virtualWindowEnd),
    [pagedRows, virtualWindowEnd, virtualWindowStart]
  );
  const topSpacerHeight = virtualizationEnabled ? virtualWindowStart * VIRTUAL_ROW_HEIGHT : 0;
  const bottomSpacerHeight = virtualizationEnabled
    ? Math.max(0, (pagedRows.length - virtualWindowEnd) * VIRTUAL_ROW_HEIGHT)
    : 0;


  const { metricDistributions, metricSpendDistributions } = useMemo(() => {
    const t = Date.now();
    const metricValuesByKey: Partial<Record<TableColumnKey, number[]>> = {};
    const spendValuesByKey: Partial<Record<TableColumnKey, number[]>> = {};

    for (const column of selectedColumns) {
      metricValuesByKey[column.key] = [];
      spendValuesByKey[column.key] = [];
    }

    for (const row of rows) {
      for (const column of selectedColumns) {
        if (!isMetricApplicable(column.key, row)) continue;
        const metricValue = column.getValue(row, ctx);
        if (Number.isFinite(metricValue)) {
          metricValuesByKey[column.key]?.push(metricValue);
        }
        if (Number.isFinite(row.spend)) {
          spendValuesByKey[column.key]?.push(row.spend);
        }
      }
    }

    const metricDistributionsNext: Partial<Record<TableColumnKey, MetricDistribution>> = {};
    const metricSpendDistributionsNext: Partial<Record<TableColumnKey, MetricDistribution>> = {};

    for (const column of selectedColumns) {
      metricDistributionsNext[column.key] = buildDistribution(metricValuesByKey[column.key] ?? []);
      metricSpendDistributionsNext[column.key] = buildDistribution(spendValuesByKey[column.key] ?? []);
    }

    logPerf("table.metricDistributions", t, rows.length);
    return {
      metricDistributions: metricDistributionsNext,
      metricSpendDistributions: metricSpendDistributionsNext,
    };
  }, [ctx, rows, selectedColumns]);

  // Server-truth decision labels for the optional DECISION column. Presence of the
  // column is driven ONLY by the buyer-language toggle (so width/colSpan/cell counts
  // stay in sync); the label VALUE is additionally gated by engine surface visibility
  // and renders "—" when the engine has no decision for a creative.
  const v3SurfaceVisible = Boolean(v3Flags?.enabled && v3Flags.surfaceVisible);
  const decisionLabelByCreativeId = useMemo(
    () =>
      v3Decisions
        ? new Map(v3Decisions.map((decision) => [decision.creativeId, decision.label]))
        : new Map<string, DecisionLabel>(),
    [v3Decisions],
  );
  const showDecisionColumn = buyerDecisionLanguage;

  const totalTableWidth = useMemo(() => {
    const cw = (key: string, min: number, pref: number) => Math.max(min, columnWidths[key] ?? pref);
    let w = cw("creativeName", STATIC_COLUMN_SPECS.creativeName.minWidth, STATIC_COLUMN_SPECS.creativeName.preferredWidth);
    if (tablePreset.showLaunchDate) w += cw("launchDate", STATIC_COLUMN_SPECS.launchDate.minWidth, STATIC_COLUMN_SPECS.launchDate.preferredWidth);
    if (tablePreset.showActiveStatus) w += cw("activeStatus", STATIC_COLUMN_SPECS.activeStatus.minWidth, STATIC_COLUMN_SPECS.activeStatus.preferredWidth);
    if (tablePreset.showAdLength) w += cw("adLength", STATIC_COLUMN_SPECS.adLength.minWidth, STATIC_COLUMN_SPECS.adLength.preferredWidth);
    for (const tagKey of selectedAiTagColumns) {
      const spec = AI_TAG_COLUMN_SPECS[tagKey];
      w += cw(`aiTag:${tagKey}`, spec.minWidth, spec.preferredWidth);
    }
    for (const col of selectedColumns) {
      w += cw(col.key, col.minWidth, col.preferredWidth);
    }
    if (showDecisionColumn) w += DECISION_COLUMN_WIDTH;
    return w;
  }, [columnWidths, tablePreset, selectedAiTagColumns, selectedColumns, showDecisionColumn]);
  const tableColumnCount =
    1 +
    selectedColumns.length +
    selectedAiTagColumns.length +
    Number(tablePreset.showLaunchDate) +
    Number(tablePreset.showActiveStatus) +
    Number(tablePreset.showAdLength) +
    Number(showDecisionColumn);

  const modalMetricGroups = useMemo(() => {
    const query = modalSearch.toLowerCase().trim();
    const aiTagMetrics = [
      "assetType",
      "visualFormat",
      "messagingAngle",
      "hookTactic",
      "headlineTactic",
      "intendedAudience",
      "seasonality",
      "offerType",
    ] as const;

    const motionMetrics: TableColumnKey[] = [
      "hookScore",
      "ctaScore",
      "offerScore",
      "watchScore",
      "clickScore",
      "convertScore",
    ];

    const performanceMetrics = TABLE_COLUMNS.map((column) => column.key).filter((key) => !motionMetrics.includes(key));

    const filterList = <T extends string>(items: T[]) =>
      items.filter((id) => {
        const label = resolveMetricLabel(id);
        return label.toLowerCase().includes(query);
      });

    return {
      aiTags: filterList([...aiTagMetrics]),
      motion: filterList(motionMetrics),
      performance: filterList(performanceMetrics),
    };
  }, [modalSearch]);

  const applyPreset = (preset: TablePreset) => {
    setTablePreset(preset);
    setModalColumns(preset.selectedColumns);
    setPage(1);
    setShowPresetMenu(false);
  };

  useEffect(() => {
    setScrollTop(0);
    scrollContainerRef.current?.scrollTo({ top: 0 });
  }, [page, rows, tablePreset.resultsPerPage]);

  const toggleTopMetricFromHeader = (columnKey: TableColumnKey) => {
    const topMetricId = TABLE_TO_TOP_METRIC_ID[columnKey];
    if (!topMetricId) return;
    const exists = selectedMetricIds.includes(topMetricId);
    onSelectedMetricIdsChange(
      exists
        ? selectedMetricIds.filter((id) => id !== topMetricId)
        : [...selectedMetricIds, topMetricId]
    );
  };

  const toggleAiTagColumn = (tag: TagKey) => {
    const next = selectedAiTagColumns.includes(tag)
      ? selectedAiTagColumns.filter((item) => item !== tag)
      : [...selectedAiTagColumns, tag];
    setTablePreset({ ...tablePreset, selectedAiTagColumns: next });
  };

  const removeColumn = (key: TableColumnKey) => {
    const next = tablePreset.selectedColumns.filter((item) => item !== key);
    setTablePreset({ ...tablePreset, selectedColumns: next.length > 0 ? next : tablePreset.selectedColumns });
  };

  const moveColumn = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= tablePreset.selectedColumns.length) return;
    const next = [...tablePreset.selectedColumns];
    const [item] = next.splice(index, 1);
    next.splice(target, 0, item);
    setTablePreset({ ...tablePreset, selectedColumns: next });
  };

  const openMetricModal = () => {
    setModalColumns(tablePreset.selectedColumns);
    setShowMetricModal(true);
  };

  const applyMetricModal = () => {
    setTablePreset({ ...tablePreset, selectedColumns: modalColumns });
    setShowMetricModal(false);
  };

  const getColumnWidth = (key: string, minWidth: number, preferredWidth: number) =>
    Math.max(minWidth, columnWidths[key] ?? preferredWidth);

  const cycleSort = (key: TableSortState["key"]) => {
    setSortState((prev) => {
      if (prev.key !== key) return { key, direction: "asc" };
      if (prev.direction === "asc") return { key, direction: "desc" };
      if (prev.direction === "desc") return { key: null, direction: null };
      return { key, direction: "asc" };
    });
    setPage(1);
  };

  const startColumnResize = (event: React.MouseEvent, key: string, minWidth: number, preferredWidth: number) => {
    event.preventDefault();
    event.stopPropagation();
    resizeStateRef.current = {
      key,
      startX: event.clientX,
      startWidth: getColumnWidth(key, minWidth, preferredWidth),
      minWidth,
    };
    setIsResizing(true);
  };

  const sortIndicator = (key: TableSortState["key"]) => {
    if (sortState.key !== key || !sortState.direction) return "↕";
    return sortState.direction === "asc" ? "↑" : "↓";
  };

  useEffect(() => {
    const handleMouseMove = (event: MouseEvent) => {
      const active = resizeStateRef.current;
      if (!active) return;
      const delta = event.clientX - active.startX;
      const nextWidth = Math.max(active.minWidth, active.startWidth + delta);
      setColumnWidths((prev) => ({ ...prev, [active.key]: nextWidth }));
    };

    const handleMouseUp = () => {
      resizeStateRef.current = null;
      setIsResizing(false);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, []);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(TABLE_LAYOUT_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as {
        columnWidths?: unknown;
        sort?: unknown;
      };
      const safeWidths = sanitizeCreativeTableColumnWidths(parsed.columnWidths);
      if (Object.keys(safeWidths).length > 0) {
        setColumnWidths((prev) => ({ ...prev, ...safeWidths }));
      }
      const safeSort = sanitizeCreativeTableSortState(parsed.sort);
      if (safeSort) {
        setSortState(safeSort);
      }
    } catch {
      // ignore invalid persisted table layout
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        TABLE_LAYOUT_STORAGE_KEY,
        JSON.stringify({
          columnWidths,
          sort: sortState,
        })
      );
    } catch {
      // ignore write errors
    }
  }, [columnWidths, sortState]);

  useEffect(() => {
    if (!tooltip) return;
    const onScroll = () => setTooltip(null);
    window.addEventListener("scroll", onScroll, true);
    return () => window.removeEventListener("scroll", onScroll, true);
  }, [tooltip]);

  return (
    <section className="space-y-2 rounded-xl border border-[var(--adc-b1,#e4e4e0)] bg-[var(--adc-s2,#ffffff)] p-3">
      {/* A) controls row */}
      <div className="flex flex-wrap items-center gap-2">
        <div ref={presetWrapRef} className="relative">
          <button
            ref={presetTriggerRef}
            type="button"
            onClick={() => setShowPresetMenu((prev) => !prev)}
            className="inline-flex items-center gap-2 rounded-lg border border-[var(--adc-b1,#e4e4e0)] bg-[var(--adc-s2,#ffffff)] px-3 py-1.5 text-xs text-[var(--adc-ink2,#4a4f56)] hover:bg-[var(--adc-s1,#f5f5f3)]"
          >
            {tablePreset.presetName}
            <ChevronDown className="h-3.5 w-3.5" />
          </button>

          {showPresetMenu && (
            <div className="animate-in fade-in-0 slide-in-from-top-1 absolute left-0 top-10 z-50 w-80 rounded-xl border border-[var(--adc-b1,#e4e4e0)] bg-[var(--adc-s2,#ffffff)] p-3 shadow-[var(--shadow-lg)] duration-150">
              <div className="mb-2 flex items-center gap-2 rounded-md border px-2 py-1.5">
                <Search className="h-3.5 w-3.5 text-muted-foreground" />
                <input
                  ref={presetSearchRef}
                  value={presetSearch}
                  onChange={(event) => setPresetSearch(event.target.value)}
                  placeholder="Search presets"
                  className="w-full bg-transparent text-xs outline-none"
                />
              </div>
              <div className="max-h-60 space-y-1 overflow-auto">
                {filteredPresets.map((preset) => (
                  <button
                    key={preset.presetName}
                    type="button"
                    onClick={() => applyPreset(preset)}
                    className={cn(
                      "w-full rounded-md px-2 py-2 text-left text-xs",
                      preset.presetName === tablePreset.presetName ? "bg-accent" : "hover:bg-accent/50"
                    )}
                  >
                    <p className="font-medium text-foreground">{preset.presetName}</p>
                    <p className="mt-1 line-clamp-2 text-[12px] leading-snug text-muted-foreground">
                      {preset.summary}
                    </p>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <div ref={settingsWrapRef} className="relative">
          <button
            ref={settingsTriggerRef}
            type="button"
            onClick={() => setShowSettings((prev) => !prev)}
            className="inline-flex items-center gap-2 rounded-lg border border-[var(--adc-b1,#e4e4e0)] bg-[var(--adc-s2,#ffffff)] px-3 py-1.5 text-xs text-[var(--adc-ink2,#4a4f56)] hover:bg-[var(--adc-s1,#f5f5f3)]"
          >
            <Settings2 className="h-3.5 w-3.5" />
            Table settings
            <ChevronDown className="h-3.5 w-3.5" />
          </button>

          {showSettings && (
            <div className="animate-in fade-in-0 slide-in-from-top-1 absolute left-0 top-10 z-50 w-[360px] rounded-xl border border-[var(--adc-b1,#e4e4e0)] bg-[var(--adc-s2,#ffffff)] p-3 shadow-[var(--shadow-lg)] duration-150">
              <div className="space-y-2 border-b pb-3">
                <label className="flex items-center justify-between text-xs">
                  <span>Color formatting</span>
                  <select
                    value={tablePreset.colorFormatting}
                    onChange={(event) =>
                      setTablePreset({
                        ...tablePreset,
                        colorFormatting: event.target.value as ColorFormattingMode,
                      })
                    }
                    className="h-7 rounded border bg-background px-2 text-xs"
                  >
                    <option value="heatmap">Heatmap</option>
                    <option value="none">None</option>
                  </select>
                </label>

                <label className="flex items-center justify-between text-xs">
                  <span>Results per page</span>
                  <select
                    value={tablePreset.resultsPerPage}
                    onChange={(event) =>
                      setTablePreset({
                        ...tablePreset,
                        resultsPerPage: Number(event.target.value) as 20 | 50 | 100,
                      })
                    }
                    className="h-7 rounded border bg-background px-2 text-xs"
                  >
                    <option value={20}>20</option>
                    <option value={50}>50</option>
                    <option value={100}>100</option>
                  </select>
                </label>

                {[
                  { key: "showActiveStatus", label: "Show active status" },
                  { key: "showLaunchDate", label: "Show launch date" },
                  { key: "showAdLength", label: "Show ad length" },
                ].map((toggle) => (
                  <label key={toggle.key} className="flex items-center justify-between text-xs">
                    <span>{toggle.label}</span>
                    <input
                      type="checkbox"
                      checked={tablePreset[toggle.key as keyof TablePreset] as boolean}
                      onChange={(event) =>
                        setTablePreset({ ...tablePreset, [toggle.key]: event.target.checked })
                      }
                    />
                  </label>
                ))}
              </div>

              <div className="mt-3">
                <p className="mb-2 text-[12px] font-medium uppercase tracking-wide text-muted-foreground">
                  Selected metrics
                </p>
                <div className="max-h-44 space-y-1 overflow-auto">
                  {tablePreset.selectedColumns.map((columnKey, index) => (
                    <div key={columnKey} className="flex items-center gap-2 rounded-md border px-2 py-1.5 text-xs">
                      <GripVertical className="h-3.5 w-3.5 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">{resolveMetricLabel(columnKey)}</span>
                      <button
                        type="button"
                        onClick={() => moveColumn(index, -1)}
                        className="rounded border px-1 text-[12px]"
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        onClick={() => moveColumn(index, 1)}
                        className="rounded border px-1 text-[12px]"
                      >
                        ↓
                      </button>
                      <button type="button" onClick={() => removeColumn(columnKey)}>
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                </div>

                <button
                  type="button"
                  onClick={openMetricModal}
                  className="mt-2 inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs"
                >
                  <Plus className="h-3.5 w-3.5" />
                  Add metric
                </button>
              </div>
            </div>
          )}
        </div>

        <div ref={tagsWrapRef} className="relative">
          <button
            ref={tagsTriggerRef}
            type="button"
            onClick={() => setShowTagsMenu((prev) => !prev)}
            className="inline-flex items-center gap-1 rounded-lg border border-[var(--adc-b1,#e4e4e0)] bg-[var(--adc-s2,#ffffff)] px-3 py-1.5 text-xs text-[var(--adc-ink2,#4a4f56)] hover:bg-[var(--adc-s1,#f5f5f3)]"
          >
            <Tag className="h-3.5 w-3.5" />
            + AI tags
          </button>

          {showTagsMenu && (
            <div className="animate-in fade-in-0 slide-in-from-top-1 absolute left-0 top-10 z-50 w-[300px] rounded-xl border border-[var(--adc-b1,#e4e4e0)] bg-[var(--adc-s2,#ffffff)] p-3 shadow-[var(--shadow-lg)] duration-150">
              <div className="mb-2 flex items-center gap-2 rounded-md border px-2 py-1.5">
                <Search className="h-3.5 w-3.5 text-muted-foreground" />
                <input
                  ref={tagsSearchRef}
                  value={tagsSearch}
                  onChange={(event) => setTagsSearch(event.target.value)}
                  placeholder="Search AI tags"
                  className="w-full bg-transparent text-xs outline-none"
                />
              </div>

              <div className="max-h-56 space-y-2 overflow-auto">
                {filteredAiTagGroups.map((group) => (
                  <div key={group.label} className="space-y-1">
                    <p className="text-[12px] font-medium uppercase tracking-wide text-muted-foreground">
                      {group.label}
                    </p>
                    {group.items.map((item) => (
                      <button
                        key={item.value}
                        type="button"
                        onClick={() => toggleAiTagColumn(item.value)}
                        className={cn(
                          "flex w-full items-center justify-between rounded-md px-2 py-1.5 text-xs transition-colors",
                          selectedAiTagColumns.includes(item.value) ? "bg-[var(--adc-pos-bg,#e9f4ef)] text-[var(--adc-pos-fg,#0b6b4f)]" : "hover:bg-accent/60"
                        )}
                      >
                        <span>{item.label}</span>
                        <span className="text-[12px]">
                          {selectedAiTagColumns.includes(item.value) ? "✓" : ""}
                        </span>
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={openMetricModal}
          className="rounded-lg border border-[var(--adc-b1,#e4e4e0)] bg-[var(--adc-s2,#ffffff)] px-3 py-1.5 text-xs text-[var(--adc-ink2,#4a4f56)] hover:bg-[var(--adc-s1,#f5f5f3)]"
        >
          + Add metric
        </button>

        {tablePreset.colorFormatting === "heatmap" ? (
          <div className="flex flex-wrap items-center gap-2">
            <div
              className="inline-flex flex-wrap items-center gap-3 rounded-lg border border-[var(--adc-b1,#e4e4e0)] bg-[var(--adc-s1,#f5f5f3)] px-3 py-1.5 text-[12px] text-[var(--adc-ink2,#4a4f56)]"
              title={heatmapGuideTitle}
            >
              <span className="inline-flex items-center gap-1.5">
                <span
                  className="h-2.5 w-2.5 rounded-full"
                  style={{ backgroundColor: toHeatAccentColor("positive") }}
                />
                Above baseline
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span
                  className="h-2.5 w-2.5 rounded-full"
                  style={{ backgroundColor: toHeatAccentColor("neutral") }}
                />
                Near baseline
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span
                  className="h-2.5 w-2.5 rounded-full"
                  style={{ backgroundColor: toHeatAccentColor("negative") }}
                />
                Below baseline
              </span>
              <span className="text-[var(--adc-ink3,#7d838c)]">Stronger tint = larger gap</span>
            </div>
          </div>
        ) : null}
      </div>

      {/* B) selection info */}
      <div className="flex flex-wrap items-center justify-between gap-2 text-[12px] text-muted-foreground">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-medium text-foreground/85">{tablePreset.summary}</span>
          {presetTagSummary ? <span>Focus tags: {presetTagSummary}</span> : null}
        </div>
        <span>{selectedRowIds.length} ad groups selected</span>
      </div>

      {/* C) table */}
      {isResizing && <div className="fixed inset-0 z-[9999] cursor-col-resize select-none" />}
      <div
        ref={scrollContainerRef}
        className="overflow-x-auto overflow-y-visible rounded-xl border"
        onScroll={(event) => {
          if (!virtualizationEnabled) return;
          setScrollTop(event.currentTarget.scrollTop);
        }}
      >
        <table className="table-fixed text-[12px]" style={{ width: totalTableWidth }}>
          <thead className="sticky top-0 z-20 bg-[var(--adc-s1,#f5f5f3)]">
            <tr className="border-b border-[var(--adc-b1,#e4e4e0)]">
              <th
                className="sticky left-0 z-30 border-r border-[var(--adc-b1,#e4e4e0)] bg-[var(--adc-s1,#f5f5f3)] px-2.5 py-1.5 text-left text-[12px] font-medium tracking-[0.01em] text-[var(--adc-ink3,#7d838c)]"
                style={{
                  minWidth: STATIC_COLUMN_SPECS.creativeName.minWidth,
                  width: getColumnWidth(
                    "creativeName",
                    STATIC_COLUMN_SPECS.creativeName.minWidth,
                    STATIC_COLUMN_SPECS.creativeName.preferredWidth
                  ),
                }}
              >
                <div className="group relative flex items-center pr-2">
                  <label className="inline-flex flex-1 items-center gap-2">
                    <input type="checkbox" checked={allSelected} onChange={onToggleAll} />
                    <button
                      type="button"
                      onClick={() => cycleSort("name")}
                      className="inline-flex items-center gap-1 text-left"
                    >
                      <span>Creative / Ad Name</span>
                      <span className="text-[12px] text-[var(--adc-ink3,#7d838c)]">{sortIndicator("name")}</span>
                    </button>
                  </label>
                  <button
                    type="button"
                    aria-label="Resize Creative / Ad Name column"
                    className="absolute right-0 top-0 h-full w-2 cursor-col-resize opacity-0 transition-opacity group-hover:opacity-100"
                    onMouseDown={(event) =>
                      startColumnResize(
                        event,
                        "creativeName",
                        STATIC_COLUMN_SPECS.creativeName.minWidth,
                        STATIC_COLUMN_SPECS.creativeName.preferredWidth
                      )
                    }
                  >
                    <span className="mx-auto block h-full w-px bg-[var(--adc-b2,#cdcdc7)]" />
                  </button>
                </div>
              </th>

              {tablePreset.showLaunchDate && (
                <th
                  className="group relative px-2.5 py-1.5 text-left text-[12px] font-medium tracking-[0.01em] text-[var(--adc-ink3,#7d838c)]"
                  style={{
                    minWidth: STATIC_COLUMN_SPECS.launchDate.minWidth,
                    width: getColumnWidth(
                      "launchDate",
                      STATIC_COLUMN_SPECS.launchDate.minWidth,
                      STATIC_COLUMN_SPECS.launchDate.preferredWidth
                    ),
                  }}
                >
                  <button type="button" className="inline-flex items-center gap-1" onClick={() => cycleSort("launchDate")}>
                    <span>Launch date</span>
                    <span className="text-[12px] text-[var(--adc-ink3,#7d838c)]">{sortIndicator("launchDate")}</span>
                  </button>
                  <button
                    type="button"
                    aria-label="Resize Launch date column"
                    className="absolute right-0 top-0 h-full w-2 cursor-col-resize opacity-0 transition-opacity group-hover:opacity-100"
                    onMouseDown={(event) =>
                      startColumnResize(
                        event,
                        "launchDate",
                        STATIC_COLUMN_SPECS.launchDate.minWidth,
                        STATIC_COLUMN_SPECS.launchDate.preferredWidth
                      )
                    }
                  >
                    <span className="mx-auto block h-full w-px bg-[var(--adc-b2,#cdcdc7)]" />
                  </button>
                </th>
              )}

              {tablePreset.showActiveStatus && (
                <th
                  className="group relative px-2.5 py-1.5 text-left text-[12px] font-medium tracking-[0.01em] text-[var(--adc-ink3,#7d838c)]"
                  style={{
                    minWidth: STATIC_COLUMN_SPECS.activeStatus.minWidth,
                    width: getColumnWidth(
                      "activeStatus",
                      STATIC_COLUMN_SPECS.activeStatus.minWidth,
                      STATIC_COLUMN_SPECS.activeStatus.preferredWidth
                    ),
                  }}
                >
                  Active status
                  <button
                    type="button"
                    aria-label="Resize Active status column"
                    className="absolute right-0 top-0 h-full w-2 cursor-col-resize opacity-0 transition-opacity group-hover:opacity-100"
                    onMouseDown={(event) =>
                      startColumnResize(
                        event,
                        "activeStatus",
                        STATIC_COLUMN_SPECS.activeStatus.minWidth,
                        STATIC_COLUMN_SPECS.activeStatus.preferredWidth
                      )
                    }
                  >
                    <span className="mx-auto block h-full w-px bg-[var(--adc-b2,#cdcdc7)]" />
                  </button>
                </th>
              )}

              {tablePreset.showAdLength && (
                <th
                  className="group relative px-2.5 py-1.5 text-left text-[12px] font-medium tracking-[0.01em] text-[var(--adc-ink3,#7d838c)]"
                  style={{
                    minWidth: STATIC_COLUMN_SPECS.adLength.minWidth,
                    width: getColumnWidth(
                      "adLength",
                      STATIC_COLUMN_SPECS.adLength.minWidth,
                      STATIC_COLUMN_SPECS.adLength.preferredWidth
                    ),
                  }}
                >
                  Ad length
                  <button
                    type="button"
                    aria-label="Resize Ad length column"
                    className="absolute right-0 top-0 h-full w-2 cursor-col-resize opacity-0 transition-opacity group-hover:opacity-100"
                    onMouseDown={(event) =>
                      startColumnResize(
                        event,
                        "adLength",
                        STATIC_COLUMN_SPECS.adLength.minWidth,
                        STATIC_COLUMN_SPECS.adLength.preferredWidth
                      )
                    }
                  >
                    <span className="mx-auto block h-full w-px bg-[var(--adc-b2,#cdcdc7)]" />
                  </button>
                </th>
              )}

              {selectedAiTagColumns.map((tagKey) => {
                const label = prettyTagLabel(tagKey);
                const sortKey = `aiTag:${tagKey}` as const;
                const Icon = AI_TAG_HEADER_ICONS[tagKey];
                const widthSpec = AI_TAG_COLUMN_SPECS[tagKey];
                return (
                  <th
                    key={`ai_tag_header_${tagKey}`}
                    className="group relative px-2.5 py-1.5 text-left text-[12px] font-medium leading-tight tracking-[0.01em] text-[var(--adc-ink3,#7d838c)]"
                    style={{
                      minWidth: widthSpec.minWidth,
                      width: getColumnWidth(
                        sortKey,
                        widthSpec.minWidth,
                        widthSpec.preferredWidth
                      ),
                    }}
                  >
                    <button
                      type="button"
                      className="inline-flex items-center gap-1.5 align-middle"
                      onClick={() => cycleSort(sortKey)}
                    >
                      <Icon className="h-3.5 w-3.5 text-[var(--adc-ink3,#7d838c)]" />
                      <span className="truncate">{label}</span>
                      <span className="text-[12px] text-[var(--adc-ink3,#7d838c)]">{sortIndicator(sortKey)}</span>
                    </button>
                    <button
                      type="button"
                      aria-label={`Resize ${label} column`}
                      className="absolute right-0 top-0 h-full w-2 cursor-col-resize opacity-0 transition-opacity group-hover:opacity-100"
                      onMouseDown={(event) =>
                        startColumnResize(
                          event,
                          sortKey,
                          widthSpec.minWidth,
                          widthSpec.preferredWidth
                        )
                      }
                    >
                      <span className="mx-auto block h-full w-px bg-[var(--adc-b2,#cdcdc7)]" />
                    </button>
                  </th>
                );
              })}

              {selectedColumns.map((column) => (
                <th
                  key={column.key}
                  className="group relative px-2.5 py-1 text-left text-[12px] font-medium leading-tight tracking-[0.01em] text-[var(--adc-ink3,#7d838c)]"
                  style={{
                    minWidth: column.minWidth,
                    width: getColumnWidth(column.key, column.minWidth, column.preferredWidth),
                  }}
                >
                  {(() => {
                    const topMetricId = TABLE_TO_TOP_METRIC_ID[column.key];
                    const isSelected = topMetricId ? selectedMetricIds.includes(topMetricId) : false;
                    return (
                      <div className="flex w-full items-start gap-1.5 pr-2">
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            toggleTopMetricFromHeader(column.key);
                          }}
                          className={cn(
                            "mt-[1px] inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[3px] border transition-colors",
                            isSelected
                              ? "border-[var(--adc-pos-bd,#bfdfd1)] bg-[var(--adc-pos-bg,#e9f4ef)]"
                              : "border-[var(--adc-b2,#cdcdc7)] bg-[var(--adc-s2,#ffffff)] hover:border-[var(--adc-b2,#cdcdc7)]",
                            topMetricId ? "cursor-pointer" : "cursor-default"
                          )}
                          disabled={!topMetricId}
                          aria-label={`${column.label} metric visibility`}
                        >
                          {isSelected && <span className="h-1.5 w-1.5 rounded-[2px] bg-[var(--adc-pos-fg,#0b6b4f)]" />}
                        </button>
                        <button
                          type="button"
                          onClick={() => cycleSort(column.key)}
                          onMouseEnter={(event) => {
                            setTooltip({ key: column.key, rect: event.currentTarget.getBoundingClientRect() });
                          }}
                          onMouseLeave={() => setTooltip(null)}
                          onFocus={(event) =>
                            setTooltip({ key: column.key, rect: event.currentTarget.getBoundingClientRect() })
                          }
                          onBlur={() => setTooltip(null)}
                          aria-describedby={`metric-tooltip-${column.key}`}
                          className="inline-flex min-w-0 items-start gap-1 text-left"
                        >
                          <span className="line-clamp-2">{column.label}</span>
                          <span className="mt-px text-[12px] text-[var(--adc-ink3,#7d838c)]">{sortIndicator(column.key)}</span>
                        </button>
                      </div>
                    );
                  })()}
                  <button
                    type="button"
                    aria-label={`Resize ${column.label} column`}
                    className="absolute right-0 top-0 h-full w-2 cursor-col-resize opacity-0 transition-opacity group-hover:opacity-100"
                    onMouseDown={(event) => startColumnResize(event, column.key, column.minWidth, column.preferredWidth)}
                  >
                    <span className="mx-auto block h-full w-px bg-[var(--adc-b2,#cdcdc7)]" />
                  </button>
                </th>
              ))}

              {showDecisionColumn ? (
                <th
                  className="px-2.5 py-1.5 text-right text-[12px] font-medium tracking-[0.01em] text-[var(--adc-ink3,#7d838c)]"
                  style={{ minWidth: DECISION_COLUMN_WIDTH, width: DECISION_COLUMN_WIDTH }}
                >
                  DECISION
                </th>
              ) : null}
            </tr>
          </thead>

          <tbody>
            {topSpacerHeight > 0 && (
              <tr aria-hidden="true">
                <td colSpan={tableColumnCount} style={{ height: topSpacerHeight }} />
              </tr>
            )}
            {visiblePagedRows.map((row) => {
              const rowId = safeTableText(row.id) || safeTableText(row.creativeId) || "creative";
              const decisionLabel = v3SurfaceVisible
                ? decisionLabelByCreativeId.get(row.creativeId) ?? null
                : null;
              return (
	              <CreativeTableRow
	                key={rowId}
	                row={row}
	                isSelected={selectedRowIdSet.has(rowId)}
                highlighted={highlightedRowId === rowId}
                defaultCurrency={defaultCurrency}
                tablePreset={tablePreset}
                selectedAiTagColumns={selectedAiTagColumns}
                selectedColumns={selectedColumns}
                ctx={ctx}
                metricDistributions={metricDistributions}
                metricSpendDistributions={metricSpendDistributions}
                heatmapBaselineLabel={heatmapBaselineLabel}
                buyerDecisionLanguage={showDecisionColumn}
                decisionLabel={decisionLabel}
                onToggleRow={onToggleRow}
                onOpenRow={onOpenRow}
                onOpenBreakdownRow={onOpenBreakdownRow}
              />
              );
            })}
            {bottomSpacerHeight > 0 && (
              <tr aria-hidden="true">
                <td colSpan={tableColumnCount} style={{ height: bottomSpacerHeight }} />
              </tr>
            )}
          </tbody>
          <tfoot className="sticky bottom-0 z-10 bg-[var(--adc-s1,#f5f5f3)]/95 backdrop-blur">
            <tr className="border-t border-[var(--adc-b1,#e4e4e0)]">
              <td
                className="sticky left-0 z-20 border-r bg-[var(--adc-s1,#f5f5f3)] px-2.5 py-1.5 text-[12px] font-semibold text-[var(--adc-ink3,#7d838c)]"
                style={{
                  minWidth: STATIC_COLUMN_SPECS.creativeName.minWidth,
                  width: getColumnWidth(
                    "creativeName",
                    STATIC_COLUMN_SPECS.creativeName.minWidth,
                    STATIC_COLUMN_SPECS.creativeName.preferredWidth
                  ),
                }}
              >
                Net Results
              </td>

	              {tablePreset.showLaunchDate && <td className="px-2.5 py-1.5 text-[12px] text-muted-foreground">-</td>}
              {tablePreset.showActiveStatus && <td className="px-2.5 py-1.5 text-[12px] text-muted-foreground">-</td>}
              {tablePreset.showAdLength && <td className="px-2.5 py-1.5 text-[12px] text-muted-foreground">-</td>}
              {selectedAiTagColumns.map((tagKey) => (
                <td key={`summary_ai_tag_${tagKey}`} className="px-2.5 py-1.5 text-[12px] text-muted-foreground">
                  -
                </td>
              ))}

              {selectedColumns.map((column) => {
                const { value: footerValue, label: footerLabel } = getFooterValue({
                  key: column.key,
                  rows,
                  ctx,
                });
                return (
                  <td
                    key={`summary_${column.key}`}
                    className={cn(
                      "px-2.5 py-1.5 text-[12px]",
                      column.align === "right"
                        ? "text-right"
                        : column.align === "center"
                        ? "text-center"
                        : "text-left"
                    )}
                  >
                    <div className="space-y-0.5">
                      <p className="font-semibold">
                        {footerLabel === "n/a"
                          ? "—"
                          : column.format(footerValue, defaultCurrency, defaultCurrency)}
                      </p>
                      <p className="text-muted-foreground">{footerLabel}</p>
                    </div>
                  </td>
                );
              })}
              {showDecisionColumn ? (
                <td className="px-2.5 py-1.5 text-right text-[12px] text-muted-foreground">—</td>
              ) : null}
            </tr>
          </tfoot>
        </table>
      </div>

      {/* D/E) pagination row */}
      <div className="flex flex-wrap items-center justify-between gap-2 text-[12px]">
        <div className="flex items-center gap-2">
          <label className="inline-flex items-center gap-1">
            <span className="text-muted-foreground">Results per page</span>
            <select
              value={tablePreset.resultsPerPage}
              onChange={(event) =>
                setTablePreset({
                  ...tablePreset,
                  resultsPerPage: Number(event.target.value) as 20 | 50 | 100,
                })
              }
              className="h-7 rounded border bg-background px-2 text-[12px]"
            >
              <option value={20}>20</option>
              <option value={50}>50</option>
              <option value={100}>100</option>
            </select>
          </label>
          <span className="text-muted-foreground">
            {totalResults === 0 ? "0" : `${startIndex + 1}-${endIndex}`} of {totalResults}
          </span>
        </div>

        <div className="flex items-center gap-1">
          {Array.from({ length: pageCount }).slice(0, 7).map((_, idx) => {
            const pageNo = idx + 1;
            return (
              <button
                key={`page_${pageNo}`}
                type="button"
                onClick={() => setPage(pageNo)}
                className={cn(
                  "h-7 min-w-7 rounded border px-2",
                  safePage === pageNo ? "bg-foreground text-background" : "bg-background"
                )}
              >
                {pageNo}
              </button>
            );
          })}
        </div>
      </div>

      {showMetricModal && (
        <MetricModal
          selectedColumns={modalColumns}
          onSelectedColumnsChange={setModalColumns}
          onClose={() => setShowMetricModal(false)}
          onApply={applyMetricModal}
          searchValue={modalSearch}
          onSearchChange={setModalSearch}
          metricGroups={modalMetricGroups}
          hoveredMetric={hoverMetric}
          onHoverMetric={setHoverMetric}
          presetName={tablePreset.presetName}
          presetSummary={tablePreset.summary}
          visiblePresets={visiblePresets}
        />
      )}

      <MetricHeaderTooltip tooltip={tooltip} />
    </section>
  );
}

const CreativeTableRow = memo(function CreativeTableRow({
  row,
  isSelected,
  highlighted,
  defaultCurrency,
  tablePreset,
  selectedAiTagColumns,
  selectedColumns,
  ctx,
  metricDistributions,
  metricSpendDistributions,
  heatmapBaselineLabel,
  buyerDecisionLanguage,
  decisionLabel,
  onToggleRow,
  onOpenRow,
  onOpenBreakdownRow,
}: CreativeTableRowProps) {
  const assetFallbacks = useMemo(
    () => getCreativeStaticPreviewSources(row, "table"),
    [row]
  );
  const assetState = getCreativeStaticPreviewState(row, "table");
  const resolvedRowCurrency = resolveCreativeCurrency(row.currency, defaultCurrency);
  const rowId = safeTableText(row.id) || safeTableText(row.creativeId) || "creative";
  const rowName = safeTableText(row.name) || "Untitled creative";
  const rowPreview = safeTablePreview(row.preview, row.isCatalog);

  return (
    <tr
      id={`creative-row-${rowId}`}
      data-testid={`creative-row-${rowId}`}
      onClick={() => onOpenRow(rowId)}
      className={cn("group cursor-pointer", highlighted && "bg-[var(--adc-pos-bg,#e9f4ef)]")}
    >
      <td className="sticky left-0 z-10 border-b border-r bg-background px-2.5 py-1.5">
        <div className="flex items-center gap-2.5">
          <input
            type="checkbox"
            checked={isSelected}
            onChange={() => onToggleRow(rowId)}
            onClick={(event) => event.stopPropagation()}
            className="shrink-0"
          />

          <CreativeRenderSurface
            id={rowId}
            name={rowName}
            preview={rowPreview}
            size="thumb"
            mode="asset"
            assetState={assetState}
            assetFallbacks={assetFallbacks}
            className="h-9 w-9 shrink-0 rounded-md"
          />

          <div className="min-w-0 flex-1" title={buildPlacementTooltip(row)}>
            <p className="truncate text-[12px] font-medium leading-tight">{rowName}</p>
            {row.campaignName ? (
              <p className="mt-0.5 truncate text-[12px] text-muted-foreground/80">
                {row.campaignName}
              </p>
            ) : null}
            <p className="mt-1 truncate text-[12px] text-muted-foreground">
              {row.associatedAdsCount > 1 ? <span className="opacity-60">{row.associatedAdsCount} ads</span> : null}
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  if (onOpenBreakdownRow) {
                    onOpenBreakdownRow(rowId);
                    return;
                  }
                  onOpenRow(rowId);
                }}
                className="ml-2 rounded px-1 py-0.5 opacity-0 underline-offset-2 transition-opacity hover:underline group-hover:opacity-70"
              >
                Ad breakdown
              </button>
            </p>
          </div>
        </div>
      </td>

      {tablePreset.showLaunchDate && (
        <td className="border-b px-2.5 py-1.5 text-[12px] font-medium">{row.launchDate}</td>
      )}

      {tablePreset.showActiveStatus && (
        <td className="border-b px-2.5 py-1.5 text-[12px] font-medium">Active</td>
      )}

      {tablePreset.showAdLength && (
        <td className="border-b px-2.5 py-1.5 text-[12px] font-medium">
          {row.creativeVisualFormat === "video" ? "15s" : getCreativeVisualFormatLabel(row.creativeVisualFormat)}
        </td>
      )}

      {selectedAiTagColumns.map((tagKey) => (
        <td key={`${rowId}_ai_tag_${tagKey}`} className="border-b px-2.5 py-1">
          <AiTagPills values={safeTableStringArray(row.aiTags?.[tagKey])} tagKey={tagKey} />
        </td>
      ))}

      {selectedColumns.map((column) => {
        const value = column.getValue(row, ctx);
        const evaluation = evaluateMetricCell({
          key: column.key,
          value,
          row,
          ctx,
          distribution: metricDistributions[column.key] ?? buildDistribution([value]),
          roasDistribution: metricDistributions.roas,
          spendDistribution: metricSpendDistributions[column.key] ?? buildDistribution([row.spend]),
          baselineLabel: heatmapBaselineLabel,
        });
        const heatStyle =
          tablePreset.colorFormatting === "heatmap"
            ? toHeatCellStyle(evaluation.tone, evaluation.intensity)
            : undefined;

        return (
          <td
            key={`${rowId}_${column.key}`}
            className={cn(
              "border-b px-2.5 py-1.5 text-[12px] font-medium",
              evaluation.applicable === false && "text-muted-foreground",
              column.align === "right" ? "text-right" : column.align === "center" ? "text-center" : "text-left"
            )}
            style={heatStyle}
            title={tablePreset.colorFormatting === "heatmap" ? evaluation.reason : undefined}
          >
            {evaluation.applicable !== false
              ? column.format(value, resolvedRowCurrency, defaultCurrency)
              : "—"}
            {column.key === "hookScore" && evaluation.applicable !== false ? (
              <span
                className="ml-1 inline-block rounded-[3px] border border-[var(--adc-auto-bd,#d9ccf1)] bg-[var(--adc-auto-bg,#f2edfb)] px-1 align-middle text-[12px] font-medium text-[var(--adc-auto-fg,#6c41be)]"
                title="Client-computed proxy from early-attention and thumbstop signals — not a provider-reported metric."
              >
                proxy
              </span>
            ) : null}
          </td>
        );
      })}
      {buyerDecisionLanguage ? (
        <td
          className="border-b px-2.5 py-1.5 text-right"
          style={{ width: DECISION_COLUMN_WIDTH, minWidth: DECISION_COLUMN_WIDTH }}
        >
          {decisionLabel ? (
            <span
              className={cn(
                "inline-flex rounded-full border px-2 py-0.5 text-[12px] font-semibold leading-none",
                DECISION_LABEL_PALETTE[decisionLabel].legacyClassName,
              )}
            >
              {LABEL_DISPLAY[decisionLabel].label}
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </td>
      ) : null}
    </tr>
  );
});

function MetricHeaderTooltip({ tooltip }: { tooltip: MetricTooltipState | null }) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    return () => setMounted(false);
  }, []);

  if (!mounted || !tooltip) return null;

  const content = METRIC_DESCRIPTIONS[tooltip.key];
  if (!content) return null;

  const width = 260;
  const viewportPadding = 8;
  const rawLeft = tooltip.rect.left + tooltip.rect.width / 2 - width / 2;
  const left = Math.max(
    viewportPadding,
    Math.min(window.innerWidth - width - viewportPadding, rawLeft)
  );
  const top = Math.max(8, tooltip.rect.top - 12);
  const caretLeft = Math.max(12, Math.min(width - 12, tooltip.rect.left + tooltip.rect.width / 2 - left));

  return createPortal(
    <div
      id={`metric-tooltip-${tooltip.key}`}
      role="tooltip"
      className="pointer-events-none fixed z-[90] w-[260px] -translate-y-full rounded-lg bg-[var(--adc-ink,#1a1c1f)] px-3 py-2 shadow-[0_8px_20px_-10px_rgba(0,0,0,0.45)]"
      style={{ left, top }}
    >
      <p className="text-[15px] font-semibold text-white">{content.label}</p>
      <p className="mt-1 text-[13px] leading-snug text-[var(--adc-b1,#e4e4e0)]">{content.description}</p>
      <span
        className="absolute -bottom-1.5 h-3 w-3 rotate-45 bg-[var(--adc-ink,#1a1c1f)]"
        style={{ left: `${caretLeft - 6}px` }}
        aria-hidden="true"
      />
    </div>,
    document.body
  );
}

function MetricModal({
  selectedColumns,
  onSelectedColumnsChange,
  onClose,
  onApply,
  searchValue,
  onSearchChange,
  metricGroups,
  hoveredMetric,
  onHoverMetric,
  presetName,
  presetSummary,
  visiblePresets,
}: {
  selectedColumns: TableColumnKey[];
  onSelectedColumnsChange: (next: TableColumnKey[]) => void;
  onClose: () => void;
  onApply: () => void;
  searchValue: string;
  onSearchChange: (next: string) => void;
  metricGroups: { aiTags: string[]; motion: TableColumnKey[]; performance: TableColumnKey[] };
  hoveredMetric: TableColumnKey | null;
  onHoverMetric: (next: TableColumnKey | null) => void;
  presetName: string;
  presetSummary: string;
  visiblePresets: TablePreset[];
}) {
  const [setAsDefault, setSetAsDefault] = useState(false);

  const addMetric = (key: TableColumnKey) => {
    if (selectedColumns.includes(key)) return;
    onSelectedColumnsChange([...selectedColumns, key]);
  };

  const removeMetric = (key: TableColumnKey) => {
    onSelectedColumnsChange(selectedColumns.filter((col) => col !== key));
  };

  const moveMetric = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= selectedColumns.length) return;
    const next = [...selectedColumns];
    const [metric] = next.splice(index, 1);
    next.splice(target, 0, metric);
    onSelectedColumnsChange(next);
  };

  const hoveredDef = hoveredMetric ? TABLE_COLUMN_MAP[hoveredMetric] : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(16,18,22,0.4)] p-4">
      <div className="flex h-[78vh] w-[min(1240px,96vw)] flex-col overflow-hidden rounded-xl border border-[var(--adc-b1,#e4e4e0)] bg-[var(--adc-s2,#ffffff)] shadow-[var(--shadow-lg)]">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <div className="flex items-center gap-2 rounded-md border px-2 py-1.5">
            <Search className="h-3.5 w-3.5 text-muted-foreground" />
            <input
              value={searchValue}
              onChange={(event) => onSearchChange(event.target.value)}
              placeholder="Search KPIs"
              className="w-72 bg-transparent text-xs outline-none"
            />
          </div>
          <button type="button" onClick={onClose} className="rounded-md border p-1.5">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-[280px_1fr_300px] gap-0">
          <div className="min-h-0 border-r p-3">
            <p className="mb-2 text-xs font-medium">Selected metrics</p>
            <div className="max-h-[52vh] space-y-1 overflow-auto">
              {selectedColumns.map((metric, index) => (
                <div key={metric} className="flex items-center gap-2 rounded-md border px-2 py-1.5 text-xs">
                  <GripVertical className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{resolveMetricLabel(metric)}</span>
                  <button type="button" onClick={() => moveMetric(index, -1)} className="rounded border px-1 text-[12px]">↑</button>
                  <button type="button" onClick={() => moveMetric(index, 1)} className="rounded border px-1 text-[12px]">↓</button>
                  <button type="button" onClick={() => removeMetric(metric)}>
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>

            <p className="mt-3 text-[12px] text-muted-foreground">Preset: {presetName}</p>
            <p className="mt-1 text-[12px] text-muted-foreground">{presetSummary}</p>
            <p className="mt-1 text-[12px] text-muted-foreground">{PRESET_NOTES}</p>

            <label className="mt-3 flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={setAsDefault}
                onChange={(event) => setSetAsDefault(event.target.checked)}
              />
              Set as default preset
            </label>

            <select className="mt-3 h-8 w-full rounded border bg-background px-2 text-xs" defaultValue={presetName}>
              {visiblePresets.map((preset) => (
                <option key={preset.presetName} value={preset.presetName}>
                  {preset.presetName}
                </option>
              ))}
            </select>
          </div>

          <div className="min-h-0 overflow-auto p-3">
            <MetricGroup
              title="AI tags"
              items={metricGroups.aiTags}
              onAdd={() => null}
              onHover={() => null}
              isAdded={() => false}
            />

            <MetricGroup
              title="Creative Scores"
              items={metricGroups.motion}
              onAdd={addMetric}
              onHover={onHoverMetric}
              isAdded={(key) => selectedColumns.includes(key as TableColumnKey)}
            />

            <MetricGroup
              title="Performance"
              items={metricGroups.performance}
              onAdd={addMetric}
              onHover={onHoverMetric}
              isAdded={(key) => selectedColumns.includes(key as TableColumnKey)}
            />
          </div>

          <div className="border-l p-3">
            <p className="mb-2 text-xs font-medium">Metric description</p>
            {hoveredDef ? (
              <div className="space-y-1 text-xs">
                <p className="font-medium">{hoveredDef.label}</p>
                <p className="text-muted-foreground">{hoveredDef.description}</p>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">Hover over a metric to see its description.</p>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 border-t px-4 py-3">
          <button type="button" onClick={onClose} className="rounded-md border px-3 py-1.5 text-xs">
            Cancel
          </button>
          <button type="button" className="rounded-md border px-3 py-1.5 text-xs">
            Update Preset
          </button>
          <button type="button" className="rounded-md border px-3 py-1.5 text-xs">
            Save As New Preset
          </button>
          <button type="button" onClick={onApply} className="rounded-md bg-foreground px-3 py-1.5 text-xs text-background">
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}

function MetricGroup({
  title,
  items,
  onAdd,
  onHover,
  isAdded,
}: {
  title: string;
  items: string[];
  onAdd: (key: TableColumnKey) => void;
  onHover: (key: TableColumnKey) => void;
  isAdded: (key: string) => boolean;
}) {
  if (items.length === 0) return null;

  return (
    <div className="mb-4">
      <p className="mb-2 text-[12px] font-medium uppercase tracking-wide text-muted-foreground">{title}</p>
      <div className="space-y-1">
        {items.map((key) => {
          const added = isAdded(key);
          return (
            <button
              key={key}
              type="button"
              onMouseEnter={() => onHover(key as TableColumnKey)}
              onFocus={() => onHover(key as TableColumnKey)}
              onClick={() => onAdd(key as TableColumnKey)}
              className={cn(
                "flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs",
                added ? "bg-[var(--adc-pos-bg,#e9f4ef)] text-[var(--adc-pos-fg,#0b6b4f)]" : "hover:bg-accent/60"
              )}
            >
              <span>{resolveMetricLabel(key)}</span>
              {added ? "Added" : "+"}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function resolveMetricLabel(key: string): string {
  const map: Record<string, string> = {
    assetType: "Asset Type",
    visualFormat: "Visual Format",
    messagingAngle: "Messaging Angle",
    hookTactic: "Hook Tactic",
    headlineTactic: "Headline Tactic",
    intendedAudience: "Intended Audience",
    seasonality: "Seasonality",
    offerType: "Offer Type",
  };

  if (map[key]) return map[key];

  return TABLE_COLUMNS.find((column) => column.key === key)?.label ?? key;
}

const METRIC_DESCRIPTIONS: Record<TableColumnKey, { label: string; description: string }> = Object.fromEntries(
  TABLE_COLUMNS.map((column) => [
    column.key,
    {
      label: column.label,
      description: column.description,
    },
  ])
) as Record<TableColumnKey, { label: string; description: string }>;

function prettyTagLabel(key: TagKey): string {
  return resolveMetricLabel(key);
}

function AiTagPills({ values, tagKey }: { values: string[]; tagKey: TagKey }) {
  const safeValues = safeTableStringArray(values);
  if (safeValues.length === 0) {
    return (
      <span className={cn("rounded-full border px-2 py-0.5 text-[12px] font-medium", getAiTagPillStyles(tagKey, "None").className)}>
        None
      </span>
    );
  }

  return (
    <div className="flex max-h-9 max-w-full flex-wrap items-start gap-1.5 overflow-hidden">
      {safeValues.slice(0, 3).map((value) => (
        <span
          key={value}
          className={cn(
            "max-w-[145px] truncate rounded-full border px-2 py-0.5 text-[12px] font-medium leading-4",
            getAiTagPillStyles(tagKey, value).className
          )}
          title={value}
        >
          {value}
        </span>
      ))}
      {safeValues.length > 3 ? <span className="text-[12px] text-muted-foreground">+{safeValues.length - 3}</span> : null}
    </div>
  );
}

function getMetricConfig(key: TableColumnKey): TableMetricConfig {
  return TABLE_METRIC_CONFIG[key] ?? DEFAULT_TABLE_METRIC_CONFIG;
}

function hasVideoEvidence(row: MetaCreativeRow): boolean {
  return hasCreativeVideoEvidence(row);
}

function isMetricApplicable(key: TableColumnKey, row: MetaCreativeRow): boolean {
  const cfg = getMetricConfig(key);
  if (cfg.applicableFormats.includes("video") && cfg.applicableFormats.length === 1) {
    return hasVideoEvidence(row);
  }
  if (row.format === "catalog") {
    return cfg.applicableFormats.includes("catalog") || cfg.applicableFormats.includes("image");
  }
  return cfg.applicableFormats.includes(row.format);
}

function resolveQuantilePosition(value: number, distribution: MetricDistribution): number {
  const values = distribution.sorted;
  if (values.length === 0) return 0.5;
  let count = 0;
  for (const entry of values) {
    if (entry <= value) count += 1;
  }
  return count / values.length;
}

function downgradeTone(tone: HeatTone): HeatTone {
  switch (tone) {
    case "strong_positive":
      return "positive";
    case "positive":
      return "neutral";
    case "neutral":
      return "negative";
    case "negative":
      return "strong_negative";
    default:
      return "strong_negative";
  }
}

function evaluateByAverage(input: {
  value: number;
  average: number;
  direction: MetricDirectionMode;
}): HeatEvaluation {
  const { value, average, direction } = input;

  if (direction === "neutral") {
    return {
      tone: "neutral",
      intensity: 0.12,
      reason: "Neutral metric: heatmap is informational only.",
    };
  }

  if (average <= 0) {
    return {
      tone: "neutral",
      intensity: 0.1,
      reason: "comparison baseline is too low for a stable read.",
    };
  }

  const rawDeltaRatio = (value - average) / average;
  const directionalDelta =
    direction === "lower_better" ? -rawDeltaRatio : rawDeltaRatio;
  const absDelta = Math.abs(directionalDelta);

  if (directionalDelta >= 0.28) {
    return {
      tone: "strong_positive",
      intensity: 0.9,
      reason: `Well above comparison baseline (${(directionalDelta * 100).toFixed(0)}%).`,
    };
  }
  if (directionalDelta >= 0.1) {
    return {
      tone: "positive",
      intensity: 0.6,
      reason: `Above comparison baseline (${(directionalDelta * 100).toFixed(0)}%).`,
    };
  }
  if (absDelta <= 0.08) {
    return {
      tone: "neutral",
      intensity: 0.14,
      reason: "In line with comparison baseline.",
    };
  }
  if (directionalDelta <= -0.28) {
    return {
      tone: "strong_negative",
      intensity: 0.9,
      reason: `Well below comparison baseline (${(Math.abs(directionalDelta) * 100).toFixed(0)}%).`,
    };
  }
  return {
    tone: "negative",
    intensity: 0.54,
    reason: `Below comparison baseline (${(Math.abs(directionalDelta) * 100).toFixed(0)}%).`,
  };
}

function evaluateByQuantile(input: {
  value: number;
  distribution: MetricDistribution;
  direction: MetricDirectionMode;
}): HeatEvaluation {
  const { value, distribution, direction } = input;

  if (direction === "neutral") {
    return {
      tone: "neutral",
      intensity: 0.12,
      reason: "Neutral metric: heatmap is informational only.",
    };
  }

  if (distribution.sorted.length < 5) {
    return evaluateByAverage({
      value,
      average: distribution.avg,
      direction,
    });
  }

  const quantile = resolveQuantilePosition(value, distribution);
  const effectiveQuantile =
    direction === "lower_better" ? 1 - quantile : quantile;

  if (effectiveQuantile >= 0.8) {
    return {
      tone: "strong_positive",
      intensity: 0.84,
      reason: "Top 20% of the current table selection.",
    };
  }
  if (effectiveQuantile >= 0.6) {
    return {
      tone: "positive",
      intensity: 0.58,
      reason: "Above the middle range of the current table selection.",
    };
  }
  if (effectiveQuantile >= 0.4) {
    return {
      tone: "neutral",
      intensity: 0.14,
      reason: "Inside the middle range of the current table selection.",
    };
  }
  if (effectiveQuantile >= 0.2) {
    return {
      tone: "negative",
      intensity: 0.5,
      reason: "Below the middle range of the current table selection.",
    };
  }
  return {
    tone: "strong_negative",
    intensity: 0.84,
    reason: "Bottom 20% of the current table selection.",
  };
}

function getComparisonAverageForMetric(input: {
  key: TableColumnKey;
  distribution: MetricDistribution;
  ctx: TableCalcContext;
}): number {
  const { key, distribution, ctx } = input;

  switch (key) {
    case "roas":
    case "websitePurchaseRoas":
      return ctx.totalSpend > 0 ? ctx.totalPurchaseValue / ctx.totalSpend : distribution.avg;
    case "cpa":
      return ctx.totalPurchases > 0 ? ctx.totalSpend / ctx.totalPurchases : distribution.avg;
    case "cpcLink":
    case "cpcAll":
      return ctx.totalLinkClicks > 0 ? ctx.totalSpend / ctx.totalLinkClicks : distribution.avg;
    case "cpm":
      return ctx.totalImpressions > 0 ? (ctx.totalSpend / ctx.totalImpressions) * 1000 : distribution.avg;
    default:
      return distribution.avg;
  }
}

function evaluateMetricCell(input: {
  key: TableColumnKey;
  value: number;
  row: MetaCreativeRow;
  ctx: TableCalcContext;
  distribution: MetricDistribution;
  roasDistribution?: MetricDistribution;
  spendDistribution: MetricDistribution;
  baselineLabel: string;
}): HeatEvaluation {
  const { key, value, row, ctx, distribution, roasDistribution, spendDistribution, baselineLabel } = input;
  const cfg = getMetricConfig(key);
  if (!isMetricApplicable(key, row)) {
    return {
      tone: "neutral",
      intensity: 0,
      reason: "Metric is not applicable for this creative format.",
      applicable: false,
    };
  }

  if (cfg.colorMode === "none") {
    return {
      tone: "neutral",
      intensity: 0.07,
      reason: "Neutral metric: no strong heatmap is applied.",
      applicable: true,
    };
  }

  const comparisonAverage = getComparisonAverageForMetric({ key, distribution, ctx });

  let evaluation =
    cfg.colorMode === "quantile"
      ? evaluateByQuantile({
          value,
          distribution,
          direction: cfg.direction,
        })
      : evaluateByAverage({
          value,
          average: comparisonAverage,
          direction: cfg.direction,
        });

  evaluation = {
    ...evaluation,
    reason: evaluation.reason
      .replaceAll("Comparison baseline", `${baselineLabel.charAt(0).toUpperCase()}${baselineLabel.slice(1)}`)
      .replaceAll("comparison baseline", baselineLabel),
  };

  // Volume metrics should not look "great" if efficiency is weak.
  if ((key === "purchaseValue" || key === "purchases") && roasDistribution) {
    const roasIsWeak = row.roas < roasDistribution.avg * 0.9;
    if (roasIsWeak && (evaluation.tone === "positive" || evaluation.tone === "strong_positive")) {
      evaluation = {
        tone: downgradeTone(evaluation.tone),
        intensity: evaluation.intensity * 0.72,
        reason: `${evaluation.reason} Softened because ROAS trails the current table baseline.`,
      };
    }
  }

  if (cfg.spendSensitive) {
    const spendRef = Math.max(spendDistribution.q3, spendDistribution.median, 1);
    const spendRatio = clamp(row.spend / spendRef, 0, 1.4);
    const confidence = clamp(0.3 + spendRatio * 0.6, 0.22, 1);
    evaluation = {
      ...evaluation,
      intensity: evaluation.intensity * confidence,
      reason: `${evaluation.reason} Spend confidence ${(confidence * 100).toFixed(0)}%.`,
    };
  }

  const strengthMultiplier: Record<HeatStrength, number> = {
    strong: 0.88,
    medium: 0.74,
    soft: 0.58,
  };

  if (cfg.minConfidenceThreshold) {
    const estimatedViews = row.impressions > 0 ? (row.thumbstop / 100) * row.impressions : 0;
    const spendConfidence = cfg.minConfidenceThreshold.minSpend
      ? clamp(row.spend / cfg.minConfidenceThreshold.minSpend, 0, 1)
      : 1;
    const impressionsConfidence = cfg.minConfidenceThreshold.minImpressions
      ? clamp(row.impressions / cfg.minConfidenceThreshold.minImpressions, 0, 1)
      : 1;
    const viewsConfidence = cfg.minConfidenceThreshold.minEstimatedViews
      ? clamp(estimatedViews / cfg.minConfidenceThreshold.minEstimatedViews, 0, 1)
      : 1;
    const confidence = Math.min(spendConfidence, impressionsConfidence, viewsConfidence);
    if (confidence < 0.35) {
      return {
        tone: "neutral",
        intensity: 0.08,
        reason: `${evaluation.reason} Low-confidence sample for this video metric.`,
        applicable: true,
      };
    }
    evaluation = {
      ...evaluation,
      intensity: evaluation.intensity * clamp(0.4 + confidence * 0.6, 0.3, 1),
      reason: `${evaluation.reason} Data confidence ${(confidence * 100).toFixed(0)}%.`,
    };
  }

  return {
    ...evaluation,
    intensity: clamp(evaluation.intensity * strengthMultiplier[cfg.heatStrength], 0.04, 0.82),
    applicable: true,
  };
}

function getFooterValue(input: {
  key: TableColumnKey;
  rows: MetaCreativeRow[];
  ctx: TableCalcContext;
}): { value: number; label: string } {
  const { key, rows, ctx } = input;
  const column = TABLE_COLUMNS.find((item) => item.key === key);
  const cfg = getMetricConfig(key);
  if (!column) return { value: 0, label: "-" };
  const applicableRows = rows.filter((row) => isMetricApplicable(key, row));
  if (applicableRows.length === 0) return { value: 0, label: "n/a" };
  const totals = computeAggregateTotals(applicableRows);

  if (cfg.footerAggregation === "none") return { value: 0, label: "-" };
  if (cfg.footerAggregation === "sum") {
    return {
      value: applicableRows.reduce((sum, row) => sum + column.getValue(row, ctx), 0),
      label: "SUM",
    };
  }

  if (cfg.footerAggregation === "avg") {
    const values = applicableRows.map((row) => column.getValue(row, ctx));
    return {
      value: values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0,
      label: "avg",
    };
  }

  switch (key) {
    case "roas":
    case "websitePurchaseRoas":
      return {
        value: totals.totalSpend > 0 ? totals.totalPurchaseValue / totals.totalSpend : 0,
        label: "weighted",
      };
    case "cpa":
      return {
        value: totals.totalPurchases > 0 ? totals.totalSpend / totals.totalPurchases : 0,
        label: "weighted",
      };
    case "cpcLink":
    case "cpcAll":
      return {
        value: totals.totalLinkClicks > 0 ? totals.totalSpend / totals.totalLinkClicks : 0,
        label: "weighted",
      };
    case "cpm":
      return {
        value: totals.totalImpressions > 0 ? (totals.totalSpend / totals.totalImpressions) * 1000 : 0,
        label: "weighted",
      };
    case "ctrAll":
    case "ctrOutbound":
    case "linkCtr":
      return {
        value: totals.totalImpressions > 0 ? (totals.totalLinkClicks / totals.totalImpressions) * 100 : 0,
        label: "weighted",
      };
    case "thumbstopRatio":
      return {
        value: totals.totalImpressions > 0 ? (totals.totalThumbstopViews / totals.totalImpressions) * 100 : 0,
        label: "weighted",
      };
    case "firstFrameRetention":
      return {
        value: totals.totalImpressions > 0 ? (totals.totalVideo25Views / totals.totalImpressions) * 100 : 0,
        label: "weighted",
      };
    case "video25Rate":
      return {
        value: totals.totalImpressions > 0 ? (totals.totalVideo25Views / totals.totalImpressions) * 100 : 0,
        label: "weighted",
      };
    case "video50Rate":
      return {
        value: totals.totalImpressions > 0 ? (totals.totalVideo50Views / totals.totalImpressions) * 100 : 0,
        label: "weighted",
      };
    case "video75Rate":
      return {
        value: totals.totalImpressions > 0 ? (totals.totalVideo75Views / totals.totalImpressions) * 100 : 0,
        label: "weighted",
      };
    case "video100Rate":
    case "holdRate":
      return {
        value: totals.totalImpressions > 0 ? (totals.totalVideo100Views / totals.totalImpressions) * 100 : 0,
        label: "weighted",
      };
    case "clickToAtcRatio":
      return {
        value: totals.totalLinkClicks > 0 ? (totals.totalAddToCart / totals.totalLinkClicks) * 100 : 0,
        label: "weighted",
      };
    case "clickToPurchaseRatio":
    case "clickToWebsitePurchaseRatio":
      return {
        value: totals.totalLinkClicks > 0 ? (totals.totalPurchases / totals.totalLinkClicks) * 100 : 0,
        label: "weighted",
      };
    case "atcToPurchaseRatio":
      return {
        value: totals.totalAddToCart > 0 ? (totals.totalPurchases / totals.totalAddToCart) * 100 : 0,
        label: "weighted",
      };
    case "averageOrderValue":
    case "averageOrderValueWebsite":
    case "averageOrderValueShop":
      return {
        value: totals.totalPurchases > 0 ? totals.totalPurchaseValue / totals.totalPurchases : 0,
        label: "weighted",
      };
    case "purchaseValueShare":
      return {
        value: totals.totalPurchaseValue > 0 ? 100 : 0,
        label: "weighted",
      };
    case "spendShare":
      return {
        value: totals.totalSpend > 0 ? 100 : 0,
        label: "weighted",
      };
    case "purchasesPer1000Imp":
      return {
        value: totals.totalImpressions > 0 ? (totals.totalPurchases / totals.totalImpressions) * 1000 : 0,
        label: "weighted",
      };
    case "revenuePer1000Imp":
      return {
        value: totals.totalImpressions > 0 ? (totals.totalPurchaseValue / totals.totalImpressions) * 1000 : 0,
        label: "weighted",
      };
    default: {
      const values = applicableRows.map((row) => column.getValue(row, ctx));
      return {
        value: values.length > 0 ? values.reduce((sum, v) => sum + v, 0) / values.length : 0,
        label: "avg",
      };
    }
  }
}
