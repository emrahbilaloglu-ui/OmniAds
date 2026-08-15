"use client";

/**
 * Account-scoped, read-only Creative Studio analysis. This view stays inside
 * the existing application shell and its collapsible sidebar; it owns no
 * navigation rail or provider-write flow. At narrow widths the same truthful
 * analysis surface reflows instead of switching to a simulated device UI.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { CreativeRenderSurface } from "@/components/creatives/CreativeRenderSurface";
import { buildMetaAdsManagerUrl } from "@/components/creatives/CreativeAdBreakdownDrawer";
import type { MetaCreativeRow } from "@/components/creatives/metricConfig";
import type { BriefingCreativeCard } from "@/components/creatives/briefing/types";
import type { MetaCreativeBrief } from "@/lib/meta/creative-brief-contract";
import type {
  CreativeShareLedgerCapability,
  CreativeShareLedgerEntry,
} from "@/components/creatives/shareCreativeTypes";
import type {
  CreativeGroupBy,
  CreativeDateRangeValue,
  CreativeMetricDefinition,
} from "@/components/creatives/CreativesTopSection";
import { getCreativeMetricDefinition } from "@/components/creatives/CreativesTopSection";
import {
  buildCurrentWinnerEvidence,
  buildHistoricalWinnerEraState,
  findCreativeStudioCard,
  indexCreativeStudioBriefingCards,
} from "@/app/(dashboard)/platforms/meta/creatives/studio-truth";
import { formatMoney, resolveCreativeCurrency } from "@/components/creatives/money";
import { hasCreativeVideoEvidence } from "@/components/creatives/creative-truth";
import { buildMetaScopedHref } from "@/lib/meta/meta-route-scope";
import {
  DateRangePicker,
  type DateRangeValue,
} from "@/components/date-range/DateRangePicker";

/* --------------------------------------------------- scoped tokens (verbatim) */

const STUDIO_CSS = `
/* Dashboard v2: the studio keeps its own local alias names so the 3.7k lines of
   markup below stay untouched, but every alias now resolves to a v2 token. */
.studio-os{
  --s1:var(--adv-canvas); --s2:var(--adv-surface); --s3:var(--adv-fill); --s4:var(--adv-fill-2);
  --ink:var(--adv-ink); --ink2:var(--adv-ink-2); --ink3:var(--adv-ink-3); --ink4:var(--adv-ink-4);
  --b1:var(--adv-border); --b2:#d5dce8; --b3:var(--adv-scroll-thumb);
  --focus:var(--adv-accent);
  --danger-fg:var(--adc-danger-fg); --danger-bg:var(--adc-danger-bg); --danger-bd:var(--adc-danger-bd);
  --caution-fg:var(--adc-caution-fg); --caution-bg:var(--adc-caution-bg); --caution-bd:var(--adc-caution-bd);
  --pos-fg:var(--adc-pos-fg); --pos-bg:var(--adc-pos-bg); --pos-bd:var(--adc-pos-bd);
  --info-fg:var(--adc-info-fg); --info-bg:var(--adc-info-bg); --info-bd:var(--adc-info-bd);
  --neutral-fg:var(--adv-ink-3); --neutral-bg:var(--adv-fill-2); --neutral-bd:var(--adv-border);
  --sel:var(--adv-accent-bg); --sel-bd:var(--adv-accent-bd);
  --ovl:rgba(14,21,38,.34);
  --shadow-pop:0 16px 40px rgba(14,21,38,.16),0 1px 2px rgba(14,21,38,.05);
  --nav-w:56px; --insp-w:404px;
  background:var(--s1);
  color:var(--ink);
  font-family:var(--adv-font-body);
  font-size:13px;
  line-height:1.45;
  -webkit-font-smoothing:antialiased;
  text-rendering:optimizeLegibility;
  display:flex;
  flex-direction:column;
  height:100%;
  min-height:0;
  overflow:hidden;
}
.studio-os.studio-dark{
  --s1:#141518; --s2:#1c1e22; --s3:#24262b; --s4:#2b2e34;
  --ink:#f1f1ee; --ink2:#c3c6cb; --ink3:#8a9099; --ink4:#636972;
  --b1:#31343a; --b2:#3d4149; --b3:#4a4f58;
  --focus:#5b9dff;
  --danger-fg:#f1859f; --danger-bg:#341c24; --danger-bd:#552b38;
  --caution-fg:#e3b25c; --caution-bg:#332812; --caution-bd:#544120;
  --pos-fg:#57c79a; --pos-bg:#122e28; --pos-bd:#22463d;
  --info-fg:#7fb0f4; --info-bg:#152337; --info-bd:#284264;
  --neutral-fg:#8a9099; --neutral-bg:#24262b; --neutral-bd:#31343a;
  --sel:#1a2740; --sel-bd:#2c4472;
  --ovl:rgba(0,0,0,.5);
  --shadow-pop:0 8px 30px -6px rgba(0,0,0,.55),0 2px 8px -2px rgba(0,0,0,.4);
}
.studio-os *{box-sizing:border-box}
.studio-os .mono{font-family:var(--adv-font-mono);font-variant-numeric:tabular-nums}
.studio-os h1,.studio-os h2,.studio-os h3{font-family:var(--adv-font-display);letter-spacing:-0.01em}
.studio-os .tnum,.studio-os .studio-num{font-family:var(--adv-font-display);font-variant-numeric:tabular-nums}
.studio-os .tnum{font-variant-numeric:tabular-nums}
.studio-os button{font-family:inherit;font-size:inherit;cursor:pointer}
.studio-os a{color:var(--info-fg);text-decoration:none}
.studio-os a:hover{text-decoration:underline}
.studio-os ::selection{background:color-mix(in oklab,var(--focus) 26%,transparent)}
.studio-os ::-webkit-scrollbar{width:10px;height:10px}
.studio-os ::-webkit-scrollbar-thumb{background:var(--b2);border-radius:6px;border:2px solid transparent;background-clip:content-box}
.studio-os ::-webkit-scrollbar-track{background:transparent}
.studio-os *:focus-visible{outline:2px solid var(--focus);outline-offset:1px;border-radius:3px}
.studio-os-shell,.studio-os-content,.studio-assets,.studio-workspace-scroll,.studio-table-section,.studio-table-frame{min-height:0}
.studio-os-shell{display:flex;flex:1;flex-direction:column;overflow:hidden}
.studio-os-content{display:flex;flex:1;flex-direction:column;overflow:hidden}
.studio-assets{display:flex;flex:1;flex-direction:column;overflow:hidden;position:relative}
.studio-workspace-scroll{display:flex;flex:1;flex-direction:column;overflow:hidden}
.studio-table-section{display:flex;flex:1;flex-direction:column}
.studio-table-frame{display:flex;flex:1;flex-direction:column;overflow:hidden}
.studio-table-scroll{flex:1;min-height:0;overflow:auto}
.studio-grid-media-frame{position:relative;aspect-ratio:16/10;overflow:hidden;background:var(--s3)}
.studio-grid-media,.studio-table-media{width:100%!important;height:100%!important;max-width:none!important;aspect-ratio:auto!important;border-radius:0!important}
.studio-table-media-wrap{width:36px;height:46px;flex:none;border-radius:4px;border:1px solid var(--b1);overflow:hidden;background:var(--s3)}
.studio-split-pane{display:flex;flex:1;min-height:0;gap:14px;overflow:hidden}
@media (max-width:767px){
  .studio-os{height:auto;min-height:100%;overflow:visible}
  .studio-os-shell,.studio-os-content,.studio-assets,.studio-workspace-scroll{overflow:visible}
  /* The header is the v2 page head below 768: title first at full width, then
     the account/status cluster on its own wrapped row. */
  .studio-header{height:auto!important;flex-wrap:wrap;padding:14px 12px 12px!important}
  .studio-header-title{width:100%}
  .studio-header-actions{width:100%;margin-left:0!important;row-gap:8px}
  .studio-header-account{min-width:0;flex:1 1 180px}
  .studio-subnav-row,.studio-action-toolbar{overflow-x:auto;scrollbar-width:none}
  .studio-analysis-meta,.studio-context-row,.studio-action-toolbar,.studio-compare-toolbar,.studio-table-footer{flex-wrap:wrap}
  .studio-analysis-meta{padding:9px 12px 7px!important}
  .studio-context-row,.studio-action-toolbar{padding-left:12px!important;padding-right:12px!important}
  .studio-search{width:100%!important;flex:none}
  .studio-context-spacer,.studio-action-spacer{display:none}
  .studio-table-section{padding-left:10px!important;padding-right:10px!important;min-height:0!important}
  .studio-table-frame{overflow:hidden}
  .studio-table-scroll{overflow-x:auto;overflow-y:visible}
  .studio-compare-grid{grid-template-columns:repeat(2,minmax(0,1fr))!important}
  .studio-compare-section{max-height:none!important;overflow:visible!important;padding-left:10px!important;padding-right:10px!important}
  .studio-split-pane{flex-direction:column;overflow:visible;padding-left:10px!important;padding-right:10px!important}
  .studio-split-list{width:100%!important;max-height:280px}
  .studio-brief-columns{grid-template-columns:1fr!important}
  .studio-usage-overlay{position:fixed!important}
  .studio-usage-drawer{position:fixed!important;left:0!important;top:0!important;right:0!important;bottom:0!important;width:100%!important;max-width:none!important}
  .studio-usage-row{flex-wrap:wrap}
  .studio-usage-metrics{width:100%;grid-template-columns:repeat(3,minmax(0,1fr))!important;text-align:left!important}
}
@media (max-width:479px){
  .studio-compare-grid{grid-template-columns:1fr!important}
  .studio-header-status{width:100%;justify-content:center!important}
}
@keyframes spin{to{transform:rotate(360deg)}}
`;

/* ---------------------------------------------------- pure data / format helpers */

type Tone = "pos" | "caution" | "danger" | "info" | "neutral";
type StudioColorMode = "hybrid" | "target" | "cohort" | "off";

function tonePalette(tone: Tone): { fg: string; bg: string; bd: string } {
  switch (tone) {
    case "pos":
      return { fg: "var(--pos-fg)", bg: "var(--pos-bg)", bd: "var(--pos-bd)" };
    case "caution":
      return { fg: "var(--caution-fg)", bg: "var(--caution-bg)", bd: "var(--caution-bd)" };
    case "danger":
      return { fg: "var(--danger-fg)", bg: "var(--danger-bg)", bd: "var(--danger-bd)" };
    case "info":
      return { fg: "var(--info-fg)", bg: "var(--info-bg)", bd: "var(--info-bd)" };
    default:
      return { fg: "var(--ink3)", bg: "var(--s3)", bd: "var(--b1)" };
  }
}

/**
 * Semantic pill kind for a real decision-center buyer action, mirroring the
 * design's `actKind` map but over the live `CREATIVE_DECISION_CENTER_BUYER_ACTIONS`
 * vocabulary. Returns one of pos/caution/danger/info/auto/neutral so every pill
 * can use the design's exact `var(--${kind}-fg|bg|bd)` triplet verbatim.
 */
type DecisionKind = "pos" | "caution" | "danger" | "info" | "neutral";
function decisionKind(action?: string | null): DecisionKind {
  switch (action) {
    case "scale":
    case "protect":
      return "pos";
    case "cut":
      return "danger";
    case "refresh":
    case "fix_delivery":
    case "fix_policy":
    case "diagnose_data":
      return "caution";
    case "test_more":
      return "info";
    case "watch_launch":
    default:
      return "neutral";
  }
}

function finite(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatRoas(value: number | null | undefined): string {
  const numeric = finite(value);
  return numeric === null ? "—" : `${numeric.toFixed(2)}x`;
}

function formatUsageCount(row: MetaCreativeRow, noun: "usage" | "ad" = "usage"): string {
  if (row.associatedAdsCountAvailable === false) return `— ${noun}s`;
  return `${row.associatedAdsCount} ${row.associatedAdsCount === 1 ? noun : `${noun}s`}`;
}

function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? "")
      .join("") || "?"
  );
}

function humanizeToken(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function isCarouselRow(row: MetaCreativeRow): boolean {
  return /carousel/i.test(`${row.format ?? ""} ${row.creativeVisualFormat ?? ""}`);
}

const VIDEO_METRIC_IDS = new Set([
  "thumbstopRatio",
  "firstFrameRetention",
  "video25Rate",
  "video50Rate",
  "video75Rate",
  "video100Rate",
  "holdRate",
  "watchScore",
  "thruplays",
]);

/**
 * The design's Studio tab row: five surfaces — assets, copies, landers, inbox,
 * audiences. The first is rendered in place; the rest are their own routes and
 * carry the same tab row with their own pill lit.
 */
export const STUDIO_TABS = [
  { key: "assets", label: "Assets", href: "/platforms/meta/creatives" },
  { key: "copies", label: "Copy", href: "/platforms/meta/copies" },
  { key: "landers", label: "Landing Pages", href: "/platforms/meta/landing-pages" },
  { key: "inbox", label: "Inbox", href: "/platforms/meta/creative-inbox" },
  { key: "audiences", label: "Audiences", href: "/platforms/meta/audiences" },
] as const;

/* Analysis views that keep their home in Studio but sit outside the design's
   five-tab row. */
export const STUDIO_MORE_LINKS = [
  { label: "Winners", desc: "Creatives clearing the win bar", href: "/platforms/meta/creatives", tab: "winners" },
  { label: "Briefs", desc: "Production briefs from decisions", href: "/platforms/meta/creatives", tab: "briefs" },
  { label: "Shares", desc: "Client-shared creative reads", href: "/platforms/meta/creatives", tab: "shares" },
] as const;

export type StudioOsTab = "assets" | "winners" | "briefs" | "shares";

export const STUDIO_KPI_PRESETS: Array<{ key: string; label: string; desc: string; cols: string[] }> = [
  {
    key: "ecommerce",
    label: "Ecommerce",
    desc: "Purchase economics",
    cols: ["spend", "purchases", "purchaseValue", "costPerPurchase", "roas", "linkCtr", "lpvToPurchaseRate", "frequency"],
  },
  {
    key: "lead",
    label: "Lead Gen",
    desc: "Website leads & total messaging",
    cols: ["spend", "leads", "messages", "costPerLead", "costPerMessage", "linkCtr", "landingPageViews", "frequency"],
  },
  {
    key: "creative",
    label: "Creative",
    desc: "Format and delivery diagnostics",
    cols: ["spend", "impressions", "costPerMille", "linkCtr", "costPerLinkClick", "landingPageViewRate", "clickToPurchaseRate", "frequency", "thumbstopRatio", "holdRate", "thruplays"],
  },
];

export const STUDIO_ROW_PAGE_SIZES = [20, 50, 100] as const;

const STUDIO_COLOR_MODES: Array<{
  key: StudioColorMode;
  label: string;
  desc: string;
}> = [
  {
    key: "hybrid",
    label: "Hybrid",
    desc: "Economics vs target · diagnostics vs filtered cohort",
  },
  {
    key: "target",
    label: "Target",
    desc: "Economic KPIs use the server target; unsupported cells stay neutral",
  },
  {
    key: "cohort",
    label: "Cohort",
    desc: "Eligible rate and cost KPIs vs the current filtered cohort",
  },
  {
    key: "off",
    label: "Off",
    desc: "No performance tint · volume bars remain",
  },
];

const STUDIO_METRIC_DEFINITIONS: Record<string, CreativeMetricDefinition> = {
  roas: { id: "roas", label: "ROAS", direction: "high", format: (value) => `${value.toFixed(2)}x`, getValue: (row) => row.roas },
  purchaseValue: { id: "purchaseValue", label: "Revenue", direction: "high", format: (value, rowCurrency, defaultCurrency) => formatMoney(value, rowCurrency, defaultCurrency), getValue: (row) => row.purchaseValue },
  costPerPurchase: { id: "costPerPurchase", label: "CPA", direction: "low", format: (value, rowCurrency, defaultCurrency) => formatMoney(value, rowCurrency, defaultCurrency), getValue: (row) => row.cpa },
  leads: { id: "leads", label: "Website leads", direction: "high", format: (value) => Math.round(value).toLocaleString(), getValue: (row) => row.leads },
  messages: { id: "messages", label: "Messages (total)", direction: "high", format: (value) => Math.round(value).toLocaleString(), getValue: (row) => row.messages },
  costPerLead: { id: "costPerLead", label: "CPL", direction: "low", format: (value, rowCurrency, defaultCurrency) => formatMoney(value, rowCurrency, defaultCurrency), getValue: (row) => (row.leads > 0 ? row.spend / row.leads : Number.NaN) },
  costPerMessage: { id: "costPerMessage", label: "Cost / message", direction: "low", format: (value, rowCurrency, defaultCurrency) => formatMoney(value, rowCurrency, defaultCurrency), getValue: (row) => (row.messages > 0 ? row.spend / row.messages : Number.NaN) },
  landingPageViews: { id: "landingPageViews", label: "Landing views", direction: "high", format: (value) => Math.round(value).toLocaleString(), getValue: (row) => row.landingPageViews },
  landingPageViewRate: { id: "landingPageViewRate", label: "LPV rate", direction: "high", format: (value) => `${value.toFixed(1)}%`, getValue: (row) => (row.linkClicks > 0 ? (row.landingPageViews / row.linkClicks) * 100 : Number.NaN) },
  clickToPurchaseRate: { id: "clickToPurchaseRate", label: "Click → purchase", direction: "high", format: (value) => `${value.toFixed(1)}%`, getValue: (row) => (row.linkClicks > 0 ? (row.purchases / row.linkClicks) * 100 : Number.NaN) },
  lpvToPurchaseRate: { id: "lpvToPurchaseRate", label: "CVR LPV to purchase", direction: "high", format: (value) => `${value.toFixed(1)}%`, getValue: (row) => (row.landingPageViews > 0 ? (row.purchases / row.landingPageViews) * 100 : Number.NaN) },
  frequency: { id: "frequency", label: "Frequency", direction: "low", format: (value) => value.toFixed(1), getValue: (row) => row.frequency ?? Number.NaN },
  thruplays: { id: "thruplays", label: "ThruPlays", direction: "high", format: (value) => Math.round(value).toLocaleString(), getValue: (row) => row.thruplayActions ?? Number.NaN },
};

function studioMetricDefinition(id: string): CreativeMetricDefinition | undefined {
  return STUDIO_METRIC_DEFINITIONS[id] ?? getCreativeMetricDefinition(id);
}

const CANONICAL_COLUMNS = Array.from(new Set(STUDIO_KPI_PRESETS.flatMap((preset) => preset.cols)));
const DEFAULT_COLUMNS = [...STUDIO_KPI_PRESETS[0]!.cols];
const VOLUME_COLUMNS = new Set(["spend", "purchases", "impressions", "leads", "messages", "landingPageViews", "thruplays"]);
const TARGET_ECONOMIC_COLUMNS = new Set([
  "roas",
  "costPerPurchase",
  "purchaseValue",
]);
const ATTR_COLUMNS: Record<string, string> = { roas: "Meta-attr.", purchaseValue: "Meta-attr." };
const COLUMN_GROUPS: Array<{ key: string; label: string; cols: string[] }> = [
  { key: "delivery", label: "Delivery", cols: ["spend", "impressions", "costPerMille", "frequency"] },
  { key: "click", label: "Click", cols: ["linkCtr", "costPerLinkClick"] },
  { key: "funnel", label: "Funnel", cols: ["landingPageViews", "landingPageViewRate", "clickToPurchaseRate", "lpvToPurchaseRate"] },
  { key: "outcome", label: "Outcome", cols: ["purchases", "purchaseValue", "costPerPurchase", "roas", "leads", "messages", "costPerLead", "costPerMessage"] },
  { key: "video", label: "Video", cols: ["thumbstopRatio", "holdRate", "thruplays"] },
];
const GRID_KPI_OPTIONS = ["spend", "roas", "costPerPurchase", "purchases", "purchaseValue", "linkCtr", "frequency", "thumbstopRatio"];

function metricLabel(id: string): string {
  return studioMetricDefinition(id)?.label ?? id;
}

export interface StudioSelectedRow {
  row: MetaCreativeRow;
  outsideCurrentFilter: boolean;
}

export function resolveStudioSelectedRows(
  allRows: MetaCreativeRow[],
  selectedRowIds: string[],
  filteredRows: MetaCreativeRow[],
): StudioSelectedRow[] {
  const byId = new Map(allRows.map((row) => [row.id, row]));
  const filteredIds = new Set(filteredRows.map((row) => row.id));
  return selectedRowIds.flatMap((rowId) => {
    const row = byId.get(rowId);
    return row ? [{ row, outsideCurrentFilter: !filteredIds.has(rowId) }] : [];
  });
}

export function filterStudioUsageRows(
  rows: MetaCreativeRow[],
  creativeId: string,
  providerAccountId: string,
): MetaCreativeRow[] {
  return rows.filter(
    (row) =>
      row.creativeId === creativeId &&
      row.accountId === providerAccountId &&
      Boolean(row.realAdId?.trim()),
  );
}

interface StudioAssessment {
  label: string;
  tone: Tone;
  blockerCode: string | null;
}

function readServerAssessment(
  card: BriefingCreativeCard | null,
): StudioAssessment | null {
  if (!card) return null;
  const source = card as BriefingCreativeCard & {
    assessment?: unknown;
    assessmentLabel?: unknown;
    creativeAssessment?: unknown;
  };
  if (
    source.assessment &&
    typeof source.assessment === "object" &&
    !Array.isArray(source.assessment)
  ) {
    const assessment = source.assessment as {
      label?: unknown;
      tone?: unknown;
      blockerCode?: unknown;
    };
    const label =
      typeof assessment.label === "string" ? assessment.label.trim() : "";
    const tone = assessment.tone;
    if (label) {
      return {
        label,
        tone:
          tone === "pos" ||
          tone === "info" ||
          tone === "caution" ||
          tone === "danger"
            ? tone
            : "neutral",
        blockerCode:
          typeof assessment.blockerCode === "string" &&
          assessment.blockerCode.trim()
            ? assessment.blockerCode.trim()
            : null,
      };
    }
  }
  for (const candidate of [
    source.assessmentLabel,
    source.assessment,
    source.creativeAssessment,
  ]) {
    if (typeof candidate === "string" && candidate.trim()) {
      return { label: candidate.trim(), tone: "neutral", blockerCode: null };
    }
  }
  return null;
}

function previewAssetState(row: MetaCreativeRow): "ready" | "pending" | "missing" {
  if (row.previewStatus === "pending") return "pending";
  if (row.previewState === "preview" || row.previewStatus === "ready") return "ready";
  return "missing";
}

/** Lightweight read-only authority contract from `/api/meta/automation?summary=1`. */
export interface StudioOsDecisionsData {
  system: {
    killSwitchEngaged: boolean | null;
    writeEndpointsBlocked?: boolean;
    blockReason?: string | null;
    snapshotHealth?: { status: string } | null;
  };
}

/* ------------------------------------------------------------------------ props */

export interface StudioOsDatePreset {
  key: string;
  label: string;
  value: CreativeDateRangeValue;
}

export interface StudioOsViewProps {
  businessId?: string;
  /** Resolved, account-scoped rows (already limited to the selected account). */
  allRows: MetaCreativeRow[];
  briefingCards: BriefingCreativeCard[];
  creativeBriefs: MetaCreativeBrief[];
  creativeBriefsState: "loading" | "error" | "migration_required" | "ready";
  shareGrants?: CreativeShareLedgerEntry[];
  shareGrantsState?: "loading" | "error" | "ready";
  shareGrantsCapability?: CreativeShareLedgerCapability | null;
  shareMutationToken?: string | null;
  shareMutationError?: string | null;
  defaultCurrency: string | null;

  account: { name: string; id: string; currency: string | null } | null;
  providerAccounts: Array<{ id: string; name: string | null; currency: string | null }>;
  providerAccountId: string;
  accountsLoading: boolean;
  onSelectAccount: (id: string) => void;

  dateRangeLabel: string;
  dateStart: string;
  dateEnd: string;
  windowLabel: string;
  freshnessLabel: string;
  engineVersion: string | null;
  dataSource: string | null;

  groupBy: CreativeGroupBy;
  onGroupByChange: (value: CreativeGroupBy) => void;
  datePresets: StudioOsDatePreset[];
  currentDatePresetKey: string;
  onDatePreset: (value: CreativeDateRangeValue) => void;
  dateRangePickerValue?: DateRangeValue;
  onDateRangePickerChange?: (value: DateRangeValue) => void;
  dateReferenceDate?: string;
  dateTimeZoneLabel?: string;
  activeTab: StudioOsTab;

  selectedRowIds: string[];
  onToggleRow: (rowId: string) => void;
  onClearSelection: () => void;
  loadUsageRows: (creativeId: string) => Promise<MetaCreativeRow[]>;

  rowsState: "loading" | "error" | "ready";
  rowsError: string | null;
  briefingState: "loading" | "error" | "ready";
  briefingError: string | null;

  decisionsHref: string;
  launchpadHref: string;
  automationHref: string;

  onEditBrief: (brief: MetaCreativeBrief) => void;
  onNewBrief: (() => void) | null;
  onOpenGrant: () => void;
  onRevokeShare?: (token: string) => Promise<void>;
  onRotateShare?: (token: string) => Promise<string | null>;

  /** Read-only automation authority status supplied by the existing page contract. */
  decisions: StudioOsDecisionsData | null;
  decisionsState: "loading" | "error" | "ready";
}

/* ------------------------------------------------------------------------- view */

export function StudioOsView(props: StudioOsViewProps) {
  const {
    businessId = "",
    allRows,
    briefingCards,
    creativeBriefs,
    creativeBriefsState,
    shareGrants = [],
    shareGrantsState = "ready",
    shareGrantsCapability = null,
    shareMutationToken = null,
    shareMutationError = null,
    defaultCurrency,
    account,
    providerAccounts,
    providerAccountId,
    accountsLoading,
    onSelectAccount,
    dateRangeLabel,
    dateStart,
    dateEnd,
    freshnessLabel,
    engineVersion,
    dataSource,
    datePresets,
    currentDatePresetKey,
    onDatePreset,
    dateRangePickerValue,
    onDateRangePickerChange,
    dateReferenceDate,
    dateTimeZoneLabel,
    activeTab,
    selectedRowIds,
    onToggleRow,
    onClearSelection,
    loadUsageRows,
    rowsState,
    rowsError,
    briefingState,
    briefingError,
    launchpadHref,
    automationHref,
    onEditBrief,
    onNewBrief,
    onOpenGrant,
    onRevokeShare,
    onRotateShare,
    decisions,
    decisionsState,
  } = props;

  const [acctMenu, setAcctMenu] = useState(false);
  const [statusPopover, setStatusPopover] = useState(false);
  const [studioMoreOpen, setStudioMoreOpen] = useState(false);
  const subTab = activeTab;

  const [search, setSearch] = useState("");
  const [openContext, setOpenContext] = useState<string | null>(null);
  const [presetOpen, setPresetOpen] = useState(false);
  const [actMoreOpen, setActMoreOpen] = useState(false);
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [displayOpen, setDisplayOpen] = useState(false);
  const [pageSizeOpen, setPageSizeOpen] = useState(false);
  const [gridKpiOpen, setGridKpiOpen] = useState(false);
  const [selectedShareToken, setSelectedShareToken] = useState<string | null>(null);

  const [actionFilter, setActionFilter] = useState<string>("all");
  const [visibleCols, setVisibleCols] = useState<string[]>(DEFAULT_COLUMNS);
  const [sortId, setSortId] = useState<string>("spend");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [pageSize, setPageSize] = useState<number>(20);
  const [tablePages, setTablePages] = useState<number>(1);
  const [gridKpiIds, setGridKpiIds] = useState<string[]>(["spend", "roas"]);
  const [gridExpanded, setGridExpanded] = useState(false);
  const [gridCollapsedLimit, setGridCollapsedLimit] = useState(9);
  const [formatFilter, setFormatFilter] = useState<string>("all");
  const [optimizationFilter, setOptimizationFilter] = useState<string>("all");
  const [roleFilter, setRoleFilter] = useState<string>("all");
  const [colorMode, setColorMode] = useState<StudioColorMode>("hybrid");
  const [usageRow, setUsageRow] = useState<MetaCreativeRow | null>(null);
  const [usageRows, setUsageRows] = useState<MetaCreativeRow[]>([]);
  const [usageRowsState, setUsageRowsState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [usageRowsError, setUsageRowsError] = useState<string | null>(null);
  const usageRequestId = useRef(0);
  const [drawerTrends, setDrawerTrends] = useState(false);
  const [selectedBriefId, setSelectedBriefId] = useState<string | null>(null);

  useEffect(() => {
    const updateGridLimit = () => {
      const width = window.innerWidth;
      setGridCollapsedLimit(width < 480 ? 3 : width < 768 ? 6 : 9);
    };
    updateGridLimit();
    window.addEventListener("resize", updateGridLimit);
    return () => window.removeEventListener("resize", updateGridLimit);
  }, []);

  const studioHref = (href: string, tab?: StudioOsTab) => {
    return buildMetaScopedHref(
      href,
      { businessId, providerAccountId },
      {
        start: dateStart,
        end: dateEnd,
        tab: tab && tab !== "assets" ? tab : null,
      },
    );
  };

  useEffect(() => {
    setActionFilter("all");
    setOptimizationFilter("all");
    setRoleFilter("all");
    setFormatFilter("all");
    setTablePages(1);
    setUsageRow(null);
    setUsageRows([]);
    setUsageRowsState("idle");
    setUsageRowsError(null);
  }, [providerAccountId]);

  const cardIndex = useMemo(() => indexCreativeStudioBriefingCards(briefingCards), [briefingCards]);
  const rowCard = (row: MetaCreativeRow): BriefingCreativeCard | null => findCreativeStudioCard(row, cardIndex);
  const rowIndex = useMemo(() => {
    const index = new Map<string, MetaCreativeRow>();
    for (const row of allRows) {
      if (row.id) index.set(row.id, row);
      if (row.creativeId) index.set(row.creativeId, row);
      if (row.realAdId) index.set(row.realAdId, row);
    }
    return index;
  }, [allRows]);
  const findRow = (...ids: Array<string | null | undefined>): MetaCreativeRow | null => {
    for (const id of ids) {
      if (!id) continue;
      const row = rowIndex.get(id);
      if (row) return row;
    }
    return null;
  };

  /* ---- search + action + format filter ---- */
  const searchedRows = useMemo(() => {
    const query = search.trim().toLowerCase();
    return allRows.filter((row) => {
      if (actionFilter !== "all") {
        const action = rowCard(row)?.decisionCenterRow?.buyerAction ?? null;
        if (action !== actionFilter) return false;
      }
      if (formatFilter !== "all") {
        // Real evidence-backed format predicate (design values: video/static/carousel).
        const isVideo = hasCreativeVideoEvidence(row);
        const isCarousel = isCarouselRow(row);
        const matches =
          formatFilter === "video" ? isVideo : formatFilter === "carousel" ? isCarousel : !isVideo && !isCarousel;
        if (!matches) return false;
      }
      if (
        optimizationFilter !== "all" &&
        (row.optimizationGoal?.trim() || "unavailable") !== optimizationFilter
      ) {
        return false;
      }
      if (roleFilter !== "all") {
        const role = rowCard(row)?.campaignKind ?? "unavailable";
        if (role !== roleFilter) return false;
      }
      if (!query) return true;
      return [row.name, row.campaignName, row.adSetName, row.copyText, row.creativePrimaryLabel].some((value) =>
        (value ?? "").toLowerCase().includes(query),
      );
    });
  }, [
    allRows,
    actionFilter,
    formatFilter,
    optimizationFilter,
    roleFilter,
    search,
    cardIndex,
  ]);

  const optimizationOptions = useMemo(
    () =>
      Array.from(
        new Set(
          allRows
            .map((row) => row.optimizationGoal?.trim())
            .filter((value): value is string => Boolean(value)),
        ),
      ).sort((left, right) => left.localeCompare(right)),
    [allRows],
  );
  const roleOptions = useMemo(
    () =>
      Array.from(
        new Set(
          allRows
            .map((row) => rowCard(row)?.campaignKind ?? null)
            .filter((value): value is NonNullable<BriefingCreativeCard["campaignKind"]> => Boolean(value)),
        ),
      ).sort((left, right) => left.localeCompare(right)),
    [allRows, cardIndex],
  );

  const context = useMemo(() => {
    const metricRows = searchedRows.filter(
      (row) => row.metricsAvailability !== "unavailable",
    );
    return {
      totalSpend: metricRows.reduce((sum, row) => sum + row.spend, 0),
      totalPurchaseValue: metricRows.reduce(
        (sum, row) => sum + row.purchaseValue,
        0,
      ),
    };
  }, [searchedRows]);

  const sortedRows = useMemo(() => {
    const def = studioMetricDefinition(sortId);
    const copy = [...searchedRows];
    if (!def) return copy;
    copy.sort((a, b) => {
      const va =
        a.metricsAvailability === "unavailable"
          ? null
          : finite(def.getValue(a, context));
      const vb =
        b.metricsAvailability === "unavailable"
          ? null
          : finite(def.getValue(b, context));
      const na = va ?? Number.NEGATIVE_INFINITY;
      const nb = vb ?? Number.NEGATIVE_INFINITY;
      const diff = sortDir === "desc" ? nb - na : na - nb;
      return diff !== 0 ? diff : a.name.localeCompare(b.name);
    });
    return copy;
  }, [searchedRows, sortId, sortDir, context]);

  const rowLimit = pageSize * tablePages;
  const visibleRows = sortedRows.slice(0, rowLimit);

  const selectedSet = new Set(selectedRowIds);
  const selectedEntries = useMemo(
    () => resolveStudioSelectedRows(allRows, selectedRowIds, sortedRows),
    [allRows, selectedRowIds, sortedRows],
  );
  const selectedRows = useMemo(() => selectedEntries.map((entry) => entry.row), [selectedEntries]);

  /* ---- action filter chips ---- */
  const actionCounts = useMemo(() => {
    const counts = new Map<string, { label: string; count: number }>();
    for (const row of allRows) {
      const decision = rowCard(row)?.decisionCenterRow;
      const action = decision?.buyerAction;
      if (!action) continue;
      const existing = counts.get(action) ?? { label: decision?.buyerLabel ?? action, count: 0 };
      existing.count += 1;
      counts.set(action, existing);
    }
    return Array.from(counts, ([key, value]) => ({ key, label: value.label, count: value.count })).sort(
      (a, b) => b.count - a.count,
    );
  }, [allRows, cardIndex]);

  const primaryActionChips = actionCounts.slice(0, 6);
  const overflowActionChips = actionCounts.slice(6);

  /* ---- columns ---- */
  const orderedCols = CANONICAL_COLUMNS.filter((id) => visibleCols.includes(id));
  const toggleGroup = (cols: string[]) => {
    const allOn = cols.every((id) => visibleCols.includes(id));
    setVisibleCols((prev) => (allOn ? prev.filter((id) => !cols.includes(id)) : Array.from(new Set([...prev, ...cols]))));
  };
  const activePreset = useMemo(() => {
    return STUDIO_KPI_PRESETS.find(
      (preset) => preset.cols.length === visibleCols.length && preset.cols.every((id) => visibleCols.includes(id)),
    );
  }, [visibleCols]);
  const presetLabel = activePreset?.label ?? "Custom";
  const availableColumnIds = new Set(activePreset?.cols ?? CANONICAL_COLUMNS);

  const cohortGrades = useMemo(() => {
    const grades = new Map<string, number>();
    for (const metricId of CANONICAL_COLUMNS) {
      if (VOLUME_COLUMNS.has(metricId)) continue;
      const definition = studioMetricDefinition(metricId);
      if (!definition) continue;
      const values = searchedRows
        .flatMap((row) => {
          if (
            row.metricsAvailability === "unavailable" ||
            (VIDEO_METRIC_IDS.has(metricId) && !hasCreativeVideoEvidence(row))
          ) {
            return [];
          }
          const value = finite(definition.getValue(row, context));
          return value === null ? [] : [{ rowId: row.id, value }];
        })
        .sort((left, right) => left.value - right.value);
      if (values.length < 3) continue;
      const denominator = Math.max(1, values.length - 1);
      for (let start = 0; start < values.length; ) {
        let end = start;
        while (
          end + 1 < values.length &&
          values[end + 1]!.value === values[start]!.value
        ) {
          end += 1;
        }
        const percentile = ((start + end) / 2) / denominator;
        const grade =
          definition.direction === "low" ? 1 - percentile : percentile;
        for (let index = start; index <= end; index += 1) {
          grades.set(`${values[index]!.rowId}:${metricId}`, grade);
        }
        start = end + 1;
      }
    }
    return grades;
  }, [searchedRows, context]);

  const targetGradeForRow = (row: MetaCreativeRow): number | null => {
    const ratio = finite(rowCard(row)?.ratioToTarget);
    if (ratio === null) return null;
    if (ratio >= 1.25) return 0.86;
    if (ratio >= 1.05) return 0.7;
    if (ratio >= 0.9) return 0.52;
    if (ratio >= 0.75) return 0.38;
    return 0.2;
  };

  const cellTint = (row: MetaCreativeRow, metricId: string): string | undefined => {
    if (colorMode === "off" || VOLUME_COLUMNS.has(metricId)) return undefined;
    const targetGrade = TARGET_ECONOMIC_COLUMNS.has(metricId)
      ? targetGradeForRow(row)
      : null;
    const cohortGrade = cohortGrades.get(`${row.id}:${metricId}`) ?? null;
    const grade =
      colorMode === "target"
        ? targetGrade
        : colorMode === "cohort"
          ? cohortGrade
          : targetGrade ?? cohortGrade;
    if (grade === null) return undefined;
    if (grade >= 0.6) {
      return `color-mix(in oklab,var(--pos-fg) ${grade >= 0.74 ? 15 : 9}%,var(--s2))`;
    }
    if (grade >= 0.46) {
      return "color-mix(in oklab,var(--caution-fg) 9%,var(--s2))";
    }
    return `color-mix(in oklab,var(--danger-fg) ${grade < 0.32 ? 15 : 9}%,var(--s2))`;
  };

  const closeMenus = () => {
    setAcctMenu(false);
    setStatusPopover(false);
    setStudioMoreOpen(false);
    setOpenContext(null);
    setPresetOpen(false);
    setActMoreOpen(false);
    setColumnsOpen(false);
    setDisplayOpen(false);
    setPageSizeOpen(false);
    setGridKpiOpen(false);
  };

  const closeUsageDrawer = () => {
    usageRequestId.current += 1;
    setUsageRow(null);
    setUsageRows([]);
    setUsageRowsState("idle");
    setUsageRowsError(null);
  };

  const openUsageDrawer = async (row: MetaCreativeRow) => {
    const requestId = usageRequestId.current + 1;
    usageRequestId.current = requestId;
    setUsageRow(row);
    setUsageRows([]);
    setUsageRowsState("loading");
    setUsageRowsError(null);
    setDrawerTrends(false);
    try {
      const rows = await loadUsageRows(row.creativeId);
      if (usageRequestId.current !== requestId) return;
      const exactRows = filterStudioUsageRows(rows, row.creativeId, providerAccountId);
      setUsageRows(exactRows);
      setUsageRowsState("ready");
    } catch (error) {
      if (usageRequestId.current !== requestId) return;
      setUsageRows([]);
      setUsageRowsState("error");
      setUsageRowsError(
        error instanceof Error ? error.message : "Usage rows could not load.",
      );
    }
  };

  /* ---- menu dismissal: click-outside + Escape (FIX 1) ----
     A document-level dismiss handler (not a fixed backdrop): the Studio now
     renders inside the app frame, so a full-viewport backdrop would cover the
     app's left sidebar. This closes any open popover when the pointer goes down
     outside a `[data-studio-pop]` region, or on Escape — every popover dismisses
     by clicking anywhere outside it or pressing Escape. */
  const anyMenuOpen =
    acctMenu ||
    statusPopover ||
    studioMoreOpen ||
    openContext !== null ||
    presetOpen ||
    actMoreOpen ||
    columnsOpen ||
    displayOpen ||
    pageSizeOpen ||
    gridKpiOpen;
  useEffect(() => {
    if (!anyMenuOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMenus();
    };
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && target.closest("[data-studio-pop]")) return;
      closeMenus();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onPointerDown, true);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onPointerDown, true);
    };
  }, [anyMenuOpen]);

  const killSwitchEngaged = decisionsState === "ready" ? decisions?.system?.killSwitchEngaged ?? null : null;

  /* ---- cell rendering ---- */
  const cellDisplay = (row: MetaCreativeRow, metricId: string): string => {
    if (row.metricsAvailability === "unavailable") return "—";
    const def = studioMetricDefinition(metricId);
    if (!def) return "—";
    if (VIDEO_METRIC_IDS.has(metricId) && !hasCreativeVideoEvidence(row)) return "—";
    const value = finite(def.getValue(row, context));
    if (value === null) return "—";
    const currency = resolveCreativeCurrency(row.currency ?? null, defaultCurrency);
    return def.format(value, currency, defaultCurrency);
  };

  const cellRaw = (row: MetaCreativeRow, metricId: string): number | null => {
    if (row.metricsAvailability === "unavailable") return null;
    const def = studioMetricDefinition(metricId);
    return def ? finite(def.getValue(row, context)) : null;
  };

  // Per-column max for the neutral volume bar (design `colMax`), over shown rows.
  const volumeColMax = useMemo(() => {
    const out: Record<string, number> = {};
    for (const id of orderedCols) {
      if (!VOLUME_COLUMNS.has(id)) continue;
      const def = studioMetricDefinition(id);
      let mx = 0;
      for (const row of visibleRows) {
        if (row.metricsAvailability === "unavailable") continue;
        const v = def ? finite(def.getValue(row, context)) : null;
        if (v != null) mx = Math.max(mx, v);
      }
      out[id] = mx || 1;
    }
    return out;
  }, [orderedCols, visibleRows, context]);

  const accountMark = account ? initials(account.name) : "—";
  const hasAccount = Boolean(providerAccountId);

  /* ==================================================================== render */

  return (
    <div
      className="studio-os"
      data-testid="creative-studio-os"
      data-responsive-studio="true"
      data-provider-writes="none"
      style={{ background: "var(--s1)", color: "var(--ink)" }}
    >
      <style>{STUDIO_CSS}</style>

        <div className="studio-os-shell" style={{ minWidth: 0 }}>
          {/* header */}
          <header
            className="studio-header"
            style={{
              flex: "none",
              background: "transparent",
              display: "flex",
              alignItems: "flex-end",
              gap: 16,
              flexWrap: "wrap",
              padding: "0 0 14px",
              zIndex: 20,
              position: "relative",
            }}
          >
            <div className="studio-header-title" style={{ minWidth: 0 }}>
              <p
                className="mono"
                style={{
                  margin: 0,
                  fontSize: 11,
                  letterSpacing: "0.12em",
                  textTransform: "uppercase",
                  color: "var(--ink3)",
                }}
              >
                Meta · Analysis-first — writes stay in Launchpad
              </p>
              <h1
                style={{
                  margin: "4px 0 0",
                  fontSize: 26,
                  fontWeight: 700,
                  letterSpacing: "-0.02em",
                  color: "var(--ink)",
                  lineHeight: 1.1,
                }}
              >
                Creative Studio
              </h1>
            </div>

            <div className="studio-header-actions" style={{ display: "flex", alignItems: "center", gap: 8, marginLeft: "auto", flexWrap: "wrap" }}>
            <div className="studio-header-account" data-studio-pop style={{ position: "relative" }}>
              <button
                type="button"
                onClick={() => {
                  closeMenus();
                  setAcctMenu((prev) => !prev);
                }}
                aria-haspopup="listbox"
                aria-expanded={acctMenu}
                aria-label="Meta ad account for Creative Studio"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  background: "var(--s1)",
                  border: "1px solid var(--b2)",
                  borderRadius: 8,
                  padding: "4px 9px 4px 7px",
                  color: "var(--ink)",
                  maxWidth: 280,
                }}
              >
                <span
                  style={{
                    width: 20,
                    height: 20,
                    borderRadius: 5,
                    background: "var(--ink)",
                    color: "var(--s2)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 10,
                    fontWeight: 700,
                    flex: "none",
                  }}
                >
                  {accountMark}
                </span>
                <span
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "flex-start",
                    lineHeight: 1.15,
                    minWidth: 0,
                  }}
                >
                  <span
                    style={{
                      fontWeight: 600,
                      fontSize: 12,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      maxWidth: 180,
                    }}
                  >
                    {account ? account.name : accountsLoading ? "Loading accounts" : "Select account"}
                  </span>
                  <span className="mono" style={{ fontSize: "9.5px", color: "var(--ink3)", whiteSpace: "nowrap" }}>
                    {account ? `${account.id} · ${account.currency ?? "—"}` : "no account scope"}
                  </span>
                </span>
                <span className="mono" aria-hidden style={{ color: "var(--ink3)", fontSize: 10, marginLeft: 2 }}>
                  ▾
                </span>
              </button>
              {acctMenu ? (
                <div
                  role="listbox"
                  aria-label="Assigned Meta ad accounts"
                  style={{
                    position: "absolute",
                    top: 44,
                    left: 0,
                    width: 280,
                    background: "var(--s2)",
                    border: "1px solid var(--b2)",
                    borderRadius: 10,
                    boxShadow: "var(--shadow-pop)",
                    zIndex: 50,
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      padding: "8px 11px",
                      borderBottom: "1px solid var(--b1)",
                      fontSize: 10,
                      textTransform: "uppercase",
                      letterSpacing: ".04em",
                      color: "var(--ink3)",
                      fontWeight: 600,
                    }}
                  >
                    Assigned accounts · no cross-account totals
                  </div>
                  {providerAccounts.length === 0 ? (
                    <div style={{ padding: "10px 11px", fontSize: "11.5px", color: "var(--ink3)" }}>
                      No assigned Meta ad account.
                    </div>
                  ) : (
                    providerAccounts.map((entry) => {
                      const active = entry.id === providerAccountId;
                      return (
                        <button
                          key={entry.id}
                          type="button"
                          role="option"
                          aria-selected={active}
                          onClick={() => {
                            onSelectAccount(entry.id);
                            setAcctMenu(false);
                          }}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 9,
                            width: "100%",
                            textAlign: "left",
                            padding: "9px 11px",
                            border: "none",
                            borderBottom: "1px solid var(--b1)",
                            background: active ? "var(--sel)" : "transparent",
                            color: "var(--ink)",
                          }}
                        >
                          <span
                            style={{
                              width: 22,
                              height: 22,
                              borderRadius: 5,
                              background: "var(--s4)",
                              border: "1px solid var(--b2)",
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                              fontSize: 9,
                              fontWeight: 700,
                              color: "var(--ink2)",
                              flex: "none",
                            }}
                          >
                            {initials(entry.name ?? entry.id)}
                          </span>
                          <span style={{ flex: 1, minWidth: 0 }}>
                            <span
                              style={{
                                display: "block",
                                fontSize: 12,
                                fontWeight: 600,
                                whiteSpace: "nowrap",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                              }}
                            >
                              {entry.name ?? entry.id}
                            </span>
                            <span className="mono" style={{ display: "block", fontSize: "9.5px", color: "var(--ink3)" }}>
                              {entry.id}
                              {entry.currency ? ` · ${entry.currency}` : ""}
                            </span>
                          </span>
                        </button>
                      );
                    })
                  )}
                </div>
              ) : null}
            </div>

            <span className="mono" style={{ fontSize: "10px", color: "var(--ink3)", whiteSpace: "nowrap" }}>
              Decision context {freshnessLabel}
            </span>

            <div data-studio-pop style={{ position: "relative" }}>
              <button
                type="button"
                onClick={() => {
                  closeMenus();
                  setStatusPopover((prev) => !prev);
                }}
                title="System status"
                aria-label="System status"
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 8,
                  border: "1px solid var(--b2)",
                  background: "var(--s1)",
                  color: "var(--ink3)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 13,
                }}
              >
                ⓘ
              </button>
              {statusPopover ? (
                <div
                  style={{
                    position: "absolute",
                    top: 40,
                    right: 0,
                    width: 280,
                    background: "var(--s2)",
                    border: "1px solid var(--b2)",
                    borderRadius: 10,
                    boxShadow: "var(--shadow-pop)",
                    zIndex: 50,
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      padding: "8px 11px",
                      borderBottom: "1px solid var(--b1)",
                      fontSize: 10,
                      textTransform: "uppercase",
                      letterSpacing: ".04em",
                      color: "var(--ink3)",
                      fontWeight: 600,
                    }}
                  >
                    System status
                  </div>
                  <div
                    style={{
                      padding: "10px 11px",
                      display: "grid",
                      gridTemplateColumns: "auto 1fr",
                      gap: "6px 12px",
                      fontSize: 11,
                    }}
                  >
                    {[
                      { l: "Engine", v: engineVersion ?? "—" },
                      { l: "Decision as of", v: freshnessLabel },
                      { l: "Decision source", v: dataSource ?? "—" },
                      { l: "Currency", v: account?.currency ?? "—" },
                      { l: "Window", v: dateRangeLabel },
                      { l: "Account", v: account?.id ?? "—" },
                    ].map((fact) => (
                      <span key={fact.l} style={{ display: "contents" }}>
                        <span style={{ color: "var(--ink3)" }}>{fact.l}</span>
                        <span className="mono" style={{ color: "var(--ink)", textAlign: "right" }}>
                          {fact.v}
                        </span>
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>

            <Link
              href={automationHref}
              className="studio-header-status"
              data-testid="studio-automation-status"
              data-readonly="true"
              title="Open Automation controls"
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 6,
                height: 32,
                padding: "0 11px",
                borderRadius: 8,
                fontSize: "11.5px",
                fontWeight: 600,
                border: `1px solid ${killSwitchEngaged === true ? "var(--danger-bd)" : "var(--b2)"}`,
                background: killSwitchEngaged === true ? "var(--danger-bg)" : "var(--s1)",
                color: killSwitchEngaged === true ? "var(--danger-fg)" : "var(--ink2)",
                textDecoration: "none",
              }}
            >
              <span aria-hidden>◼</span>{" "}
              {killSwitchEngaged === true
                ? "Business STOP engaged"
                : killSwitchEngaged === false
                  ? "Business STOP off"
                  : "Business STOP unavailable"}
            </Link>
            </div>
          </header>

          {killSwitchEngaged === true ? (
            <div
              style={{
                flex: "none",
                display: "flex",
                alignItems: "center",
                gap: 10,
                background: "var(--danger-bg)",
                borderBottom: "1px solid var(--danger-bd)",
                padding: "7px 16px",
              }}
            >
              <span style={{ color: "var(--danger-fg)", fontSize: 12 }}>◼</span>
              <span style={{ fontSize: "11.5px", color: "var(--danger-fg)", fontWeight: 600 }}>Business STOP engaged</span>
              <span style={{ fontSize: 11, color: "var(--ink2)" }}>
                New mutations are blocked. A request already accepted may still complete.
              </span>
              <div style={{ flex: 1 }} />
              <Link
                href={automationHref}
                style={{
                  background: "var(--s2)",
                  border: "1px solid var(--b2)",
                  borderRadius: 6,
                  padding: "3px 9px",
                  fontSize: 11,
                  fontWeight: 600,
                  color: "var(--ink3)",
                  textDecoration: "none",
                }}
              >
                Review in Automation →
              </Link>
            </div>
          ) : null}

          {briefingState === "error" ? (
            <div
              data-testid="studio-decision-context-error"
              role="status"
              style={{
                flex: "none",
                display: "flex",
                alignItems: "center",
                gap: 8,
                borderBottom: "1px solid var(--caution-bd)",
                background: "var(--caution-bg)",
                padding: "7px 16px",
                color: "var(--caution-fg)",
                fontSize: 11,
              }}
            >
              <span aria-hidden>!</span>
              <span>
                {briefingError ??
                  "Server decision context is unavailable. Performance remains visible, but assessments and action filters are withheld."}
              </span>
            </div>
          ) : null}

          {/* studio content */}
          <div className="studio-os-content">
            {/* subnav */}
            <div style={{ flex: "none" }}>
              <div
                role="tablist"
                aria-label="Creative Studio views"
                className="studio-subnav-row"
                style={{ display: "flex", alignItems: "center", gap: 8, paddingBottom: 14, flexWrap: "wrap" }}
              >
                {STUDIO_TABS.map((tab) => {
                  const active = tab.key === "assets" && subTab === "assets";
                  return (
                    <Link
                      key={tab.key}
                      role="tab"
                      aria-selected={active}
                      href={studioHref(tab.href)}
                      style={{
                        height: 32,
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 7,
                        padding: "0 13px",
                        borderRadius: 9999,
                        border: `1px solid ${active ? "var(--adv-accent-bd)" : "var(--b1)"}`,
                        background: active ? "var(--adv-accent-bg)" : "var(--s2)",
                        color: active ? "var(--adv-accent)" : "var(--ink2)",
                        fontWeight: 600,
                        fontSize: "12.5px",
                        textDecoration: "none",
                      }}
                    >
                      {tab.label}
                    </Link>
                  );
                })}
                <div style={{ flex: 1 }} />
                <div data-studio-pop style={{ position: "relative" }}>
                  <button
                    type="button"
                    onClick={() => {
                      closeMenus();
                      setStudioMoreOpen((prev) => !prev);
                    }}
                    aria-haspopup="menu"
                    style={{
                      height: 32,
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      padding: "0 13px",
                      borderRadius: 9999,
                      border: "1px solid var(--b1)",
                      background: "var(--s2)",
                      color: "var(--ink2)",
                      fontWeight: 600,
                      fontSize: "12.5px",
                    }}
                  >
                    More
                    <span className="mono" style={{ fontSize: 9 }}>
                      ▾
                    </span>
                  </button>
                  {studioMoreOpen ? (
                    <div
                      style={{
                        position: "absolute",
                        top: 36,
                        right: 0,
                        zIndex: 50,
                        width: 236,
                        background: "var(--s2)",
                        border: "1px solid var(--b2)",
                        borderRadius: 10,
                        boxShadow: "var(--shadow-pop)",
                        overflow: "hidden",
                      }}
                    >
                      <div
                        style={{
                          padding: "7px 11px",
                          borderBottom: "1px solid var(--b1)",
                          fontSize: "9.5px",
                          textTransform: "uppercase",
                          letterSpacing: ".04em",
                          color: "var(--ink3)",
                          fontWeight: 600,
                        }}
                      >
                        Also in Studio
                      </div>
                      {STUDIO_MORE_LINKS.map((item) => (
                        <Link
                          key={item.label}
                          href={studioHref(item.href, item.tab as StudioOsTab)}
                          onClick={() => setStudioMoreOpen(false)}
                          style={{
                            display: "flex",
                            flexDirection: "column",
                            alignItems: "flex-start",
                            gap: 1,
                            width: "100%",
                            textAlign: "left",
                            padding: "8px 11px",
                            border: "none",
                            borderBottom: "1px solid var(--b1)",
                            background: "transparent",
                            color: "var(--ink)",
                            textDecoration: "none",
                          }}
                        >
                          <span style={{ fontSize: 12, fontWeight: 600 }}>{item.label}</span>
                          <span style={{ fontSize: 10, color: "var(--ink3)" }}>{item.desc}</span>
                        </Link>
                      ))}
                    </div>
                  ) : null}
                </div>
              </div>
            </div>

            {subTab === "assets"
              ? renderAssets()
              : subTab === "winners"
                ? renderWinners()
                : subTab === "briefs"
                  ? renderBriefs()
                  : renderShares()}
          </div>
        </div>
    </div>
  );

  /* ================================================================ assets */

  function renderAssets() {
    if (!hasAccount) return renderAccountRequired();

    return (
      <div className="studio-assets">
        {/* 1 · compact studio header */}
        <div className="studio-analysis-meta" style={{ flex: "none", display: "flex", alignItems: "center", gap: 9, padding: "9px 16px 7px 16px" }}>
          <span style={{ fontSize: 11, color: "var(--ink3)" }}>Analyzing</span>
          <span style={{ fontSize: "12.5px", fontWeight: 600, color: "var(--ink)" }}>{account?.name ?? "—"}</span>
          <span className="mono" style={{ fontSize: 10, color: "var(--ink4)" }}>
            {account?.id ?? "—"}
          </span>
          <span style={{ width: 1, height: 13, background: "var(--b1)" }} />
          <span className="mono" style={{ fontSize: "10.5px", color: "var(--ink2)" }}>
            {account?.currency ?? "—"}
          </span>
          <span style={{ width: 1, height: 13, background: "var(--b1)" }} />
          <span style={{ fontSize: 11, color: "var(--ink3)" }}>{dateRangeLabel}</span>
          <div style={{ flex: 1 }} />
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: "10.5px", color: "var(--ink3)" }}>
            Account-scoped metrics · missing shown as —
          </span>
        </div>

        {/* 2 · context row */}
        <div className="studio-context-row" style={{ flex: "none", display: "flex", alignItems: "center", gap: 7, padding: "0 0 9px" }}>
          <div
            className="studio-search"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 7,
              background: "var(--s2)",
              border: "1px solid var(--b2)",
              borderRadius: 8,
              padding: "0 9px",
              height: 30,
              width: 210,
            }}
          >
            <span aria-hidden style={{ color: "var(--ink4)", fontSize: 12 }}>
              ⌕
            </span>
            <input
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setTablePages(1);
              }}
              placeholder="Search creatives"
              style={{
                flex: 1,
                border: "none",
                background: "transparent",
                outline: "none",
                color: "var(--ink)",
                fontSize: 12,
                fontFamily: "inherit",
                minWidth: 0,
              }}
            />
          </div>

          {/* Only evidence-backed controls are rendered. */}
          {dateRangePickerValue && onDateRangePickerChange ? (
            <DateRangePicker
              value={dateRangePickerValue}
              onChange={onDateRangePickerChange}
              className="studio-date-range"
              label="Creative date range"
              testId="creative-studio-date-range-picker"
              showComparisonTrigger={false}
              rangePresets={[
                "today",
                "yesterday",
                "7d",
                "14d",
                "28d",
                "30d",
                "90d",
                "365d",
                "thisMonth",
                "lastMonth",
                "custom",
              ]}
              referenceDate={dateReferenceDate}
              timeZoneLabel={dateTimeZoneLabel}
              align="start"
            />
          ) : (
            renderContextControl(
              "date",
              "Date",
              datePresets.find((preset) => preset.key === currentDatePresetKey)?.label ?? "Custom",
              datePresets.map((preset) => ({
                label: preset.label,
                on: preset.key === currentDatePresetKey,
                go: () => onDatePreset(preset.value),
              })),
              false,
            )
          )}
          {renderContextControl(
            "opt",
            "Optimization",
            optimizationFilter === "all"
              ? "All goals"
              : optimizationFilter === "unavailable"
                ? "Unspecified / mixed"
                : humanizeToken(optimizationFilter),
            [
              {
                label: "All goals",
                on: optimizationFilter === "all",
                go: () => {
                  setOptimizationFilter("all");
                  setTablePages(1);
                },
              },
              ...optimizationOptions.map((value) => ({
                label: humanizeToken(value),
                on: optimizationFilter === value,
                go: () => {
                  setOptimizationFilter(value);
                  setTablePages(1);
                },
              })),
              ...(allRows.some((row) => !row.optimizationGoal?.trim())
                ? [
                    {
                      label: "Unspecified / mixed",
                      on: optimizationFilter === "unavailable",
                      go: () => {
                        setOptimizationFilter("unavailable");
                        setTablePages(1);
                      },
                    },
                  ]
                : []),
            ],
            optimizationFilter !== "all",
          )}
          {renderContextControl(
            "role",
            "Lifecycle role",
            roleFilter === "all"
              ? "All roles"
              : roleFilter === "unavailable"
                ? "Role unavailable"
                : humanizeToken(roleFilter),
            [
              {
                label: "All roles",
                on: roleFilter === "all",
                go: () => {
                  setRoleFilter("all");
                  setTablePages(1);
                },
              },
              ...roleOptions.map((value) => ({
                label: humanizeToken(value),
                on: roleFilter === value,
                go: () => {
                  setRoleFilter(value);
                  setTablePages(1);
                },
              })),
              ...(allRows.some((row) => !rowCard(row)?.campaignKind)
                ? [
                    {
                      label: "Role unavailable",
                      on: roleFilter === "unavailable",
                      go: () => {
                        setRoleFilter("unavailable");
                        setTablePages(1);
                      },
                    },
                  ]
                : []),
            ],
            roleFilter !== "all",
          )}
          {renderContextControl(
            "fmt",
            "Format",
            formatFilter === "all"
              ? "All formats"
              : formatFilter === "video"
                ? "Video"
                : formatFilter === "carousel"
                  ? "Carousel"
                  : "Static",
            [
              { label: "All formats", on: formatFilter === "all", go: () => { setFormatFilter("all"); setTablePages(1); } },
              { label: "Video", on: formatFilter === "video", go: () => { setFormatFilter("video"); setTablePages(1); } },
              { label: "Static", on: formatFilter === "static", go: () => { setFormatFilter("static"); setTablePages(1); } },
              { label: "Carousel", on: formatFilter === "carousel", go: () => { setFormatFilter("carousel"); setTablePages(1); } },
            ],
            formatFilter !== "all",
          )}

          <div className="studio-context-spacer" style={{ flex: 1 }} />
          <button
            type="button"
            data-studio-pop
            onClick={() => {
              closeMenus();
              setPresetOpen((prev) => !prev);
            }}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              height: 30,
              padding: "0 11px",
              borderRadius: 8,
              border: "1px solid var(--b2)",
              background: "var(--s2)",
              fontSize: "11.5px",
              fontWeight: 600,
              color: "var(--ink)",
              whiteSpace: "nowrap",
            }}
          >
            <span style={{ color: "var(--ink3)", fontWeight: 500 }}>KPIs</span>
            {presetLabel}
            <span className="mono" style={{ color: "var(--ink4)", fontSize: 9 }}>
              ▾
            </span>
          </button>
        </div>

        {/* 3 · server-action filter strip + view controls */}
        <div
          className="studio-action-toolbar"
          style={{
            flex: "none",
            display: "flex",
            alignItems: "center",
            gap: 5,
            padding: "0 0 9px",
            borderBottom: "1px solid var(--b1)",
          }}
        >
          {renderActionChip("all", "All", null)}
          {primaryActionChips.map((chip) => renderActionChip(chip.key, chip.label, chip.count))}
          {overflowActionChips.length > 0 ? (
            <div data-studio-pop style={{ position: "relative" }}>
              <button
                type="button"
                onClick={() => {
                  closeMenus();
                  setActMoreOpen((prev) => !prev);
                }}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 5,
                  padding: "5px 10px",
                  borderRadius: 8,
                  border: "1px solid transparent",
                  background: "transparent",
                  color: "var(--ink3)",
                  fontWeight: 600,
                  fontSize: "11.5px",
                }}
              >
                More
                <span className="mono" style={{ fontSize: 9 }}>
                  ▾
                </span>
              </button>
              {actMoreOpen ? (
                <div
                  style={{
                    position: "absolute",
                    top: 34,
                    left: 0,
                    zIndex: 45,
                    minWidth: 180,
                    background: "var(--s2)",
                    border: "1px solid var(--b2)",
                    borderRadius: 9,
                    boxShadow: "var(--shadow-pop)",
                    overflow: "hidden",
                    padding: 4,
                  }}
                >
                  {overflowActionChips.map((chip) => (
                    <button
                      key={chip.key}
                      type="button"
                      onClick={() => {
                        setActionFilter(chip.key);
                        setTablePages(1);
                        setActMoreOpen(false);
                      }}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 8,
                        width: "100%",
                        textAlign: "left",
                        padding: "6px 8px",
                        border: "none",
                        background: actionFilter === chip.key ? "var(--sel)" : "transparent",
                        color: "var(--ink)",
                        borderRadius: 6,
                        fontSize: "11.5px",
                      }}
                    >
                      <span>{chip.label}</span>
                      <span style={{ fontSize: "9.5px", color: "var(--ink4)", fontVariantNumeric: "tabular-nums" }}>
                        {chip.count}
                      </span>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="studio-action-spacer" style={{ flex: 1 }} />

          {/* Columns */}
          <div data-studio-pop style={{ position: "relative" }}>
            <button
              type="button"
              onClick={() => {
                closeMenus();
                setColumnsOpen((prev) => !prev);
              }}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                height: 28,
                padding: "0 10px",
                borderRadius: 8,
                border: "1px solid var(--b2)",
                background: "var(--s2)",
                fontSize: 11,
                fontWeight: 600,
                color: "var(--ink2)",
              }}
            >
              <span aria-hidden style={{ fontSize: 11 }}>
                ▥
              </span>
              Columns
            </button>
            {columnsOpen ? (
              <div
                className="studio-table-footer"
                style={{
                  position: "absolute",
                  top: 32,
                  right: 0,
                  zIndex: 46,
                  width: 250,
                  background: "var(--s2)",
                  border: "1px solid var(--b2)",
                  borderRadius: 10,
                  boxShadow: "var(--shadow-pop)",
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    padding: "8px 11px",
                    fontSize: "9.5px",
                    textTransform: "uppercase",
                    letterSpacing: ".04em",
                    color: "var(--ink3)",
                    fontWeight: 600,
                    borderBottom: "1px solid var(--b1)",
                  }}
                >
                  Column groups
                </div>
                {COLUMN_GROUPS.filter((group) => group.cols.some((id) => availableColumnIds.has(id))).map((group) => {
                  const supportedCols = group.cols.filter((id) => availableColumnIds.has(id));
                  const allOn = supportedCols.every((id) => visibleCols.includes(id));
                  return (
                    <button
                      key={group.key}
                      type="button"
                      onClick={() => toggleGroup(supportedCols)}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 9,
                        width: "100%",
                        textAlign: "left",
                        padding: "8px 11px",
                        border: "none",
                        borderBottom: "1px solid var(--b1)",
                        background: "transparent",
                        color: "var(--ink)",
                      }}
                    >
                      <span
                        style={{
                          width: 16,
                          height: 16,
                          flex: "none",
                          borderRadius: 4,
                          border: `1px solid ${allOn ? "var(--focus)" : "var(--b2)"}`,
                          background: allOn ? "var(--focus)" : "var(--s2)",
                          color: "var(--s2)",
                          fontSize: 10,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        {allOn ? "✓" : ""}
                      </span>
                      <span style={{ minWidth: 0 }}>
                        <span style={{ display: "block", fontSize: 12, fontWeight: 600 }}>{group.label}</span>
                        <span
                          style={{
                            display: "block",
                            fontSize: "9.5px",
                            color: "var(--ink3)",
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                          }}
                        >
                          {supportedCols.map(metricLabel).join(", ")}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : null}
          </div>

          <div data-studio-pop style={{ position: "relative" }}>
            <button
              type="button"
              onClick={() => {
                closeMenus();
                setDisplayOpen((prev) => !prev);
              }}
              aria-haspopup="menu"
              aria-expanded={displayOpen}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                height: 28,
                padding: "0 10px",
                borderRadius: 8,
                border: "1px solid var(--b2)",
                background: "var(--s2)",
                fontSize: 11,
                fontWeight: 600,
                color: "var(--ink2)",
              }}
            >
              <span
                aria-hidden
                style={{
                  width: 9,
                  height: 9,
                  borderRadius: 2,
                  background:
                    colorMode === "off" ? "var(--b3)" : "var(--pos-fg)",
                }}
              />
              {STUDIO_COLOR_MODES.find((mode) => mode.key === colorMode)?.label ?? "Hybrid"}
            </button>
            {displayOpen ? (
              <div
                role="menu"
                aria-label="Performance color map"
                style={{
                  position: "absolute",
                  top: 32,
                  right: 0,
                  zIndex: 46,
                  width: 276,
                  background: "var(--s2)",
                  border: "1px solid var(--b2)",
                  borderRadius: 10,
                  boxShadow: "var(--shadow-pop)",
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    padding: "8px 11px",
                    fontSize: "9.5px",
                    textTransform: "uppercase",
                    letterSpacing: ".04em",
                    color: "var(--ink3)",
                    fontWeight: 600,
                    borderBottom: "1px solid var(--b1)",
                  }}
                >
                  Color map
                </div>
                {STUDIO_COLOR_MODES.map((mode) => (
                  <button
                    key={mode.key}
                    type="button"
                    role="menuitemradio"
                    aria-checked={colorMode === mode.key}
                    onClick={() => {
                      setColorMode(mode.key);
                      setDisplayOpen(false);
                    }}
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "flex-start",
                      gap: 1,
                      width: "100%",
                      textAlign: "left",
                      padding: "8px 11px",
                      border: "none",
                      borderBottom: "1px solid var(--b1)",
                      background:
                        colorMode === mode.key ? "var(--sel)" : "transparent",
                      color: "var(--ink)",
                    }}
                  >
                    <span style={{ fontSize: 12, fontWeight: 600 }}>
                      {mode.label}
                    </span>
                    <span style={{ fontSize: 10, color: "var(--ink3)" }}>
                      {mode.desc}
                    </span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>

        </div>

        {/* KPI preset menu (anchored under header) */}
        {presetOpen ? (
          <div
            data-studio-pop
            style={{
              position: "absolute",
              top: 74,
              right: 16,
              zIndex: 48,
              width: 230,
              background: "var(--s2)",
              border: "1px solid var(--b2)",
              borderRadius: 10,
              boxShadow: "var(--shadow-pop)",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                padding: "8px 11px",
                fontSize: "9.5px",
                textTransform: "uppercase",
                letterSpacing: ".04em",
                color: "var(--ink3)",
                fontWeight: 600,
                borderBottom: "1px solid var(--b1)",
              }}
            >
              KPI preset
            </div>
            {STUDIO_KPI_PRESETS.map((preset) => (
              <button
                key={preset.key}
                type="button"
                onClick={() => {
                  setVisibleCols(preset.cols);
                  setSortId(preset.cols[0] ?? "spend");
                  setTablePages(1);
                  setPresetOpen(false);
                }}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "flex-start",
                  gap: 1,
                  width: "100%",
                  textAlign: "left",
                  padding: "8px 11px",
                  border: "none",
                  borderBottom: "1px solid var(--b1)",
                  background: "transparent",
                  color: "var(--ink)",
                }}
              >
                <span style={{ fontSize: "12.5px", fontWeight: 600 }}>{preset.label}</span>
                <span style={{ fontSize: 10, color: "var(--ink3)" }}>{preset.desc}</span>
              </button>
            ))}
          </div>
        ) : null}

        <div className="studio-workspace-scroll">
          {/* 4 · selected comparison grid */}
          {selectedRows.length === 0 ? (
            <div
              style={{
                flex: "none",
                display: "flex",
                flexDirection: "column",
                gap: 12,
                padding: "4px 16px 2px 16px",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: "var(--ink)" }}>
                  Comparison board
                </h2>
                <span className="mono" style={{ fontSize: "10.5px", color: "var(--ink4)" }}>
                  0 pinned · your working set, never auto-fills
                </span>
              </div>
              <div
                style={{
                  border: "1.5px dashed var(--b2)",
                  borderRadius: 16,
                  background: "rgba(255,255,255,0.55)",
                  minHeight: 150,
                  display: "grid",
                  placeItems: "center",
                  padding: 22,
                }}
              >
                <div style={{ textAlign: "center", maxWidth: 380 }}>
                  <p style={{ margin: 0, fontSize: "13.5px", fontWeight: 600, color: "var(--ink2)" }}>
                    Board is empty
                  </p>
                  <p style={{ margin: "6px 0 0", fontSize: "12.5px", lineHeight: 1.55, color: "var(--ink3)" }}>
                    Tick creatives in the table below to pin them here as cards for side-by-side review.
                  </p>
                </div>
              </div>
            </div>
          ) : (
            renderComparisonGrid()
          )}

          {/* 5 · always-present table — natural height, stacks under the grid (FIX 2) */}
          <div
            className="studio-table-section"
            style={{
              padding: "8px 16px 14px 16px",
            }}
          >
            <div
              style={{
                flex: "none",
                display: "flex",
                alignItems: "baseline",
                gap: 9,
                flexWrap: "wrap",
                marginBottom: 8,
              }}
            >
              <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: "var(--ink)" }}>All creatives</h2>
              <span className="mono" style={{ fontSize: "10.5px", color: "var(--ink4)" }}>
                {sortedRows.length} synced · Meta · one row per creative · usages aggregated
              </span>
              <div style={{ flex: 1 }} />
              <span style={{ fontSize: 10, color: "var(--ink3)" }}>KPI preset · {presetLabel} · Revenue and ROAS are Meta-attributed</span>
            </div>
            {colorMode === "off" ? null : (
              <div
                style={{
                  flex: "none",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  flexWrap: "wrap",
                  padding: "0 0 10px",
                }}
              >
                <span className="mono" style={{ fontSize: 10, color: "var(--ink3)" }}>
                  cell color = rank across these creatives on that metric
                </span>
                <span
                  aria-hidden
                  style={{
                    width: 88,
                    height: 8,
                    borderRadius: 9999,
                    background:
                      "linear-gradient(90deg,#FBDEE6,#F9EDD6,#F1F4F9,#DDF1E8,#BFE5D6)",
                  }}
                />
                <span className="mono" style={{ fontSize: 10, color: "var(--ink3)" }}>
                  lags → leads · ↓ = lower is better · volume columns stay neutral
                </span>
              </div>
            )}
            <div
              className="studio-table-frame"
              style={{
                background: "var(--s2)",
                border: "1px solid var(--b1)",
                borderRadius: 9,
                boxShadow: "0 1px 3px rgba(26,28,31,.05)",
                display: "flex",
                flexDirection: "column",
                overflow: "hidden",
              }}
            >
              <div className="studio-table-scroll">
                <table data-performance-tint={colorMode} style={{ borderCollapse: "separate", borderSpacing: 0, width: "100%", minWidth: 920 }}>
                  <thead>
                    <tr>
                      <th
                        style={{
                          position: "sticky",
                          left: 0,
                          top: 0,
                          zIndex: 4,
                          background: "var(--s2)",
                          textAlign: "left",
                          padding: "8px 12px",
                          borderBottom: "1px solid var(--b1)",
                          borderRight: "1px solid var(--b1)",
                          fontFamily: "var(--adv-font-mono)",
                          fontSize: "10px",
                          textTransform: "uppercase",
                          letterSpacing: ".1em",
                          color: "var(--ink3)",
                          fontWeight: 500,
                          minWidth: 300,
                        }}
                      >
                        Creative
                      </th>
                      {orderedCols.map((id) => {
                        const activeSort = sortId === id;
                        const attr = ATTR_COLUMNS[id] ?? null;
                        return (
                          <th
                            key={id}
                            style={{
                              position: "sticky",
                              top: 0,
                              zIndex: 2,
                              background: activeSort ? "var(--s3)" : "var(--s2)",
                              textAlign: "right",
                              padding: "7px 12px",
                              borderBottom: "1px solid var(--b1)",
                              whiteSpace: "nowrap",
                              verticalAlign: "bottom",
                            }}
                          >
                            <button
                              type="button"
                              onClick={() => {
                                if (activeSort) setSortDir((prev) => (prev === "desc" ? "asc" : "desc"));
                                else {
                                  setSortId(id);
                                  setSortDir("desc");
                                }
                              }}
                              style={{
                                display: "inline-flex",
                                flexDirection: "column",
                                alignItems: "flex-end",
                                gap: 1,
                                border: "none",
                                background: "transparent",
                                color: activeSort ? "var(--ink)" : "var(--ink3)",
                                fontFamily: "var(--adv-font-mono)",
                                fontWeight: activeSort ? 600 : 500,
                                fontSize: "10px",
                                textTransform: "uppercase",
                                letterSpacing: ".1em",
                                cursor: "pointer",
                                lineHeight: 1.15,
                              }}
                            >
                              {attr ? (
                                <span
                                  style={{
                                    fontSize: "7.5px",
                                    color: "var(--ink4)",
                                    fontWeight: 500,
                                    textTransform: "none",
                                    letterSpacing: 0,
                                  }}
                                >
                                  {attr}
                                </span>
                              ) : null}
                              <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
                                {metricLabel(id)}
                                <span className="mono" style={{ fontSize: 8, color: "var(--focus)" }}>
                                  {activeSort ? (sortDir === "desc" ? "▾" : "▴") : ""}
                                </span>
                              </span>
                            </button>
                          </th>
                        );
                      })}
                    </tr>
                  </thead>
                  <tbody>
                    {visibleRows.length === 0 ? (
                      <tr>
                        <td
                          colSpan={1 + orderedCols.length}
                          style={{ padding: "26px 16px", textAlign: "center", fontSize: 12, color: "var(--ink3)" }}
                        >
                          {rowsState === "loading"
                            ? "Loading creatives…"
                            : rowsState === "error"
                              ? rowsError ?? "Creative performance could not load."
                              : "No creatives for this scope. Missing data is never shown as zero rows."}
                        </td>
                      </tr>
                    ) : null}
                    {visibleRows.map((row) => {
                      const card = rowCard(row);
                      const assessment = readServerAssessment(card);
                      const selected = selectedSet.has(row.id);
                      return (
                        <tr key={row.id}>
                          <td
                            style={{
                              position: "sticky",
                              left: 0,
                              zIndex: 2,
                              background: selected ? "var(--sel)" : "var(--s2)",
                              padding: "8px 12px",
                              borderBottom: "1px solid var(--b1)",
                              borderRight: "1px solid var(--b1)",
                              minWidth: 300,
                            }}
                          >
                            <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                              <button
                                type="button"
                                onClick={() => onToggleRow(row.id)}
                                aria-label="Select creative"
                                aria-pressed={selected}
                                style={{
                                  width: 16,
                                  height: 16,
                                  flex: "none",
                                  borderRadius: 4,
                                  border: `1px solid ${selected ? "var(--focus)" : "var(--b2)"}`,
                                  background: selected ? "var(--focus)" : "var(--s2)",
                                  color: "var(--s2)",
                                  fontSize: 10,
                                  lineHeight: "14px",
                                  display: "flex",
                                  alignItems: "center",
                                  justifyContent: "center",
                                }}
                              >
                                {selected ? "✓" : ""}
                              </button>
                              <div className="studio-table-media-wrap">
                                <CreativeRenderSurface
                                  id={row.id}
                                  name={row.name}
                                  preview={row.preview}
                                  mode="asset"
                                  size="thumb"
                                  className="studio-table-media"
                                  assetState={previewAssetState(row)}
                                  assetFallbacks={[row.tableThumbnailUrl, row.cachedThumbnailUrl, row.thumbnailUrl, row.imageUrl, row.previewUrl]}
                                />
                              </div>
                              <div style={{ minWidth: 0, flex: 1 }}>
                                <div
                                  style={{
                                    fontSize: 12,
                                    fontWeight: 600,
                                    whiteSpace: "nowrap",
                                    overflow: "hidden",
                                    textOverflow: "ellipsis",
                                    maxWidth: 186,
                                  }}
                                >
                                  {row.name}
                                </div>
                                <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 2 }}>
                                  <span className="mono" style={{ fontSize: 9, color: "var(--ink4)" }}>
                                    {(row.format || "—").toUpperCase()}
                                  </span>
                                  <button
                                    type="button"
                                    onClick={() => void openUsageDrawer(row)}
                                    title="Open exact ad usage performance"
                                    style={{
                                      display: "inline-flex",
                                      alignItems: "center",
                                      gap: 3,
                                      border: "none",
                                      background: "transparent",
                                      color: "var(--ink3)",
                                      fontSize: "9.5px",
                                      cursor: "pointer",
                                      padding: 0,
                                    }}
                                  >
                                    <span aria-hidden style={{ fontSize: 10 }}>
                                      ▤
                                    </span>
                                    {formatUsageCount(row)}
                                  </button>
                                </div>
                              </div>
                              {assessment ? (
                                <span
                                  data-studio-assessment={assessment.label}
                                  title={
                                    assessment.blockerCode
                                      ? humanizeToken(assessment.blockerCode)
                                      : assessment.label
                                  }
                                  style={{
                                    display: "inline-flex",
                                    alignItems: "center",
                                    gap: 4,
                                    fontSize: "9.5px",
                                    fontWeight: 600,
                                    borderRadius: 5,
                                    padding: "1px 6px",
                                    whiteSpace: "nowrap",
                                    flex: "none",
                                    color: tonePalette(assessment.tone).fg,
                                    background: tonePalette(assessment.tone).bg,
                                    border: `1px solid ${tonePalette(assessment.tone).bd}`,
                                  }}
                                >
                                  {assessment.label}
                                </span>
                              ) : (
                                <span
                                  data-studio-assessment="unavailable"
                                  style={{
                                    display: "inline-flex",
                                    alignItems: "center",
                                    gap: 4,
                                    fontSize: "9.5px",
                                    fontWeight: 600,
                                    borderRadius: 5,
                                    padding: "1px 6px",
                                    whiteSpace: "nowrap",
                                    flex: "none",
                                    color: "var(--ink3)",
                                    background: "var(--s3)",
                                    border: "1px solid var(--b1)",
                                  }}
                                >
                                  Assessment unavailable
                                </span>
                              )}
                            </div>
                          </td>
                          {orderedCols.map((id) => {
                            const display = cellDisplay(row, id);
                            const isVol = VOLUME_COLUMNS.has(id);
                            const present = display !== "—";
                            const raw = isVol && present ? cellRaw(row, id) : null;
                            const barW = raw != null ? Math.max(6, Math.round((raw / (volumeColMax[id] || raw)) * 54)) : 0;
                            const tint = present ? cellTint(row, id) : undefined;
                            return (
                              <td key={id} style={{ padding: "5px 4px", borderBottom: "1px solid var(--b1)" }}>
                                {/* The design carries the heat tint on a rounded chip inside the
                                    cell rather than on the cell itself, so gaps separate ranks. */}
                                <span
                                  className="studio-num"
                                  style={{
                                    display: "block",
                                    padding: "7px 9px",
                                    borderRadius: 8,
                                    textAlign: "right",
                                    whiteSpace: "nowrap",
                                    fontSize: "12.5px",
                                    fontWeight: 600,
                                    color: present ? "var(--ink)" : "var(--ink4)",
                                    background: tint,
                                  }}
                                >
                                  {display}
                                  {raw != null ? (
                                    <span
                                      style={{
                                        display: "block",
                                        height: 3,
                                        borderRadius: 2,
                                        marginLeft: "auto",
                                        marginTop: 3,
                                        width: barW,
                                        background: "var(--b3)",
                                      }}
                                    />
                                  ) : null}
                                </span>
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div
                style={{
                  flex: "none",
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  padding: "8px 13px",
                  borderTop: "1px solid var(--b1)",
                  background: "var(--s2)",
                }}
              >
                <span className="tnum" style={{ fontSize: 11, color: "var(--ink2)", fontWeight: 600 }}>
                  Showing {sortedRows.length === 0 ? 0 : 1}–{Math.min(rowLimit, sortedRows.length)} of {sortedRows.length}
                </span>
                {rowLimit < sortedRows.length ? (
                  <button
                    type="button"
                    onClick={() => setTablePages((prev) => prev + 1)}
                    style={{
                      height: 26,
                      padding: "0 12px",
                      borderRadius: 7,
                      border: "1px solid var(--b2)",
                      background: "var(--s2)",
                      fontSize: 11,
                      fontWeight: 600,
                      color: "var(--ink2)",
                    }}
                  >
                    Show more
                  </button>
                ) : null}
                <span style={{ fontSize: 10, color: "var(--ink4)" }}>
                  {selectedRows.length} selected · missing metrics render “—”
                </span>
                <div style={{ flex: 1 }} />
                <div data-studio-pop style={{ position: "relative" }}>
                  <button
                    type="button"
                    onClick={() => {
                      closeMenus();
                      setPageSizeOpen((prev) => !prev);
                    }}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                      height: 26,
                      padding: "0 10px",
                      borderRadius: 7,
                      border: "1px solid var(--b2)",
                      background: "var(--s2)",
                      fontSize: 11,
                      fontWeight: 600,
                      color: "var(--ink2)",
                    }}
                  >
                    <span style={{ color: "var(--ink3)", fontWeight: 500 }}>Rows</span>
                    {pageSize}
                    <span className="mono" style={{ fontSize: 9, color: "var(--ink4)" }}>
                      ▾
                    </span>
                  </button>
                  {pageSizeOpen ? (
                    <div
                      style={{
                        position: "absolute",
                        bottom: 31,
                        right: 0,
                        zIndex: 47,
                        width: 110,
                        background: "var(--s2)",
                        border: "1px solid var(--b2)",
                        borderRadius: 9,
                        boxShadow: "var(--shadow-pop)",
                        padding: 4,
                      }}
                    >
                      {STUDIO_ROW_PAGE_SIZES.map((size) => (
                        <button
                          key={size}
                          type="button"
                          onClick={() => {
                            setPageSize(size);
                            setTablePages(1);
                            setPageSizeOpen(false);
                          }}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            gap: 8,
                            width: "100%",
                            textAlign: "left",
                            padding: "6px 8px",
                            border: "none",
                            background: pageSize === size ? "var(--sel)" : "transparent",
                            color: "var(--ink)",
                            borderRadius: 6,
                            fontSize: "11.5px",
                          }}
                        >
                          <span>{size}</span>
                          {pageSize === size ? <span style={{ color: "var(--focus)" }}>✓</span> : null}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          </div>
        </div>

        {usageRow ? renderUsageDrawer(usageRow) : null}
      </div>
    );
  }

  /* ----------------------------------------------- context control (dynamic) */
  function renderContextControl(
    key: string,
    label: string,
    value: string,
    options: Array<{ label: string; on: boolean; go: () => void }>,
    active = false,
  ) {
    const open = openContext === key;
    return (
      <div data-studio-pop style={{ position: "relative" }}>
        <button
          type="button"
          onClick={() => {
            closeMenus();
            setOpenContext(open ? null : key);
          }}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            height: 30,
            padding: "0 10px",
            borderRadius: 8,
            border: `1px solid ${active ? "var(--b3)" : "var(--b2)"}`,
            background: "var(--s2)",
            fontSize: "11.5px",
            whiteSpace: "nowrap",
          }}
        >
          <span style={{ color: "var(--ink3)", fontWeight: 500 }}>{label}</span>
          <span style={{ color: "var(--ink)", fontWeight: 600 }}>{value}</span>
          <span className="mono" style={{ color: "var(--ink4)", fontSize: 9 }}>
            ▾
          </span>
        </button>
        {open ? (
          <div
            style={{
              position: "absolute",
              top: 34,
              left: 0,
              zIndex: 45,
              minWidth: 200,
              background: "var(--s2)",
              border: "1px solid var(--b2)",
              borderRadius: 9,
              boxShadow: "var(--shadow-pop)",
              overflow: "hidden",
              padding: 4,
            }}
          >
            {options.map((option) => (
              <button
                key={option.label}
                type="button"
                onClick={() => {
                  option.go();
                  setOpenContext(null);
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                  width: "100%",
                  textAlign: "left",
                  padding: "6px 8px",
                  border: "none",
                  background: option.on ? "var(--sel)" : "transparent",
                  color: "var(--ink)",
                  borderRadius: 6,
                  fontSize: "11.5px",
                }}
              >
                <span>{option.label}</span>
                {option.on ? <span style={{ color: "var(--focus)" }}>✓</span> : null}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  // Design's exact neutral action chip (`actChip` + `countStyle`). The "All"
  // chip carries no count badge, matching `count:x.key==='all'?null:c`.
  function renderActionChip(key: string, label: string, count: number | null) {
    const active = actionFilter === key;
    return (
      <button
        key={key}
        type="button"
        onClick={() => {
          setActionFilter(key);
          setTablePages(1);
        }}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          padding: "5px 11px",
          borderRadius: 8,
          border: `1px solid ${active ? "var(--b2)" : "transparent"}`,
          background: active ? "var(--s2)" : "transparent",
          color: active ? "var(--ink)" : "var(--ink3)",
          fontWeight: 600,
          fontSize: "11.5px",
          cursor: "pointer",
        }}
      >
        {label}
        {count !== null ? (
          <span
            style={{
              fontSize: "9.5px",
              color: active ? "var(--ink2)" : "var(--ink4)",
              background: active ? "var(--s3)" : "transparent",
              borderRadius: 5,
              padding: "0 5px",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {count}
          </span>
        ) : null}
      </button>
    );
  }

  /* ----------------------------------------------- comparison grid (dynamic) */
  function renderComparisonGrid() {
    const shownCount = gridExpanded
      ? selectedEntries.length
      : Math.min(selectedEntries.length, gridCollapsedLimit);
    const cards = selectedEntries.slice(0, shownCount);
    const gridKpis = gridKpiIds.slice(0, 4);
    return (
      <div className="studio-compare-section" style={{ flex: "none", maxHeight: "46vh", overflowY: "auto", padding: "11px 16px 6px 16px" }}>
        <div className="studio-compare-toolbar" style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 9 }}>
          <span style={{ fontSize: "12.5px", fontWeight: 600 }}>Comparing {selectedEntries.length} creatives</span>
          <span style={{ fontSize: 10, color: "var(--ink4)" }}>grid metrics independent from the table</span>
          <div style={{ flex: 1 }} />
          <div data-studio-pop style={{ position: "relative" }}>
            <button
              type="button"
              onClick={() => {
                closeMenus();
                setGridKpiOpen((prev) => !prev);
              }}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                height: 27,
                padding: "0 10px",
                borderRadius: 7,
                border: "1px solid var(--b2)",
                background: "var(--s2)",
                fontSize: 11,
                fontWeight: 600,
                color: "var(--ink2)",
              }}
            >
              <span style={{ color: "var(--ink3)", fontWeight: 500 }}>Grid KPIs</span>
              {gridKpis.length}
              <span className="mono" style={{ fontSize: 9, color: "var(--ink4)" }}>
                ▾
              </span>
            </button>
            {gridKpiOpen ? (
              <div
                style={{
                  position: "absolute",
                  top: 31,
                  right: 0,
                  zIndex: 47,
                  width: 210,
                  background: "var(--s2)",
                  border: "1px solid var(--b2)",
                  borderRadius: 9,
                  boxShadow: "var(--shadow-pop)",
                  padding: 4,
                }}
              >
                <div style={{ padding: "6px 8px 4px 8px", fontSize: "9.5px", color: "var(--ink4)" }}>Remember 2–4 KPIs</div>
                {GRID_KPI_OPTIONS.map((id) => {
                  const on = gridKpiIds.includes(id);
                  return (
                    <button
                      key={id}
                      type="button"
                      onClick={() =>
                        setGridKpiIds((prev) => {
                          if (prev.includes(id)) return prev.length > 2 ? prev.filter((entry) => entry !== id) : prev;
                          if (prev.length >= 4) return prev;
                          return [...prev, id];
                        })
                      }
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        width: "100%",
                        textAlign: "left",
                        padding: "6px 8px",
                        border: "none",
                        background: "transparent",
                        color: "var(--ink)",
                        borderRadius: 6,
                        fontSize: "11.5px",
                      }}
                    >
                      <span
                        style={{
                          width: 16,
                          height: 16,
                          flex: "none",
                          borderRadius: 4,
                          border: `1px solid ${on ? "var(--focus)" : "var(--b2)"}`,
                          background: on ? "var(--focus)" : "var(--s2)",
                          color: "var(--s2)",
                          fontSize: 10,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        {on ? "✓" : ""}
                      </span>
                      <span style={{ flex: 1 }}>{metricLabel(id)}</span>
                    </button>
                  );
                })}
              </div>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClearSelection}
            style={{
              height: 27,
              padding: "0 11px",
              borderRadius: 7,
              border: "1px solid var(--b2)",
              background: "var(--s2)",
              fontSize: 11,
              fontWeight: 600,
              color: "var(--ink3)",
            }}
          >
            Clear
          </button>
        </div>
        <div className="studio-compare-grid" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(208px,1fr))", gap: 11 }}>
          {cards.map(({ row, outsideCurrentFilter }) => {
            const card = rowCard(row);
            const action = card?.decisionCenterRow?.buyerAction ?? null;
            const label = card?.decisionCenterRow?.buyerLabel ?? null;
            const assessment = readServerAssessment(card);
            const kind = decisionKind(action);
            return (
              <div key={row.id} style={{ border: "1px solid var(--b1)", borderRadius: 10, background: "var(--s2)", overflow: "hidden" }}>
                <div className="studio-grid-media-frame">
                  <CreativeRenderSurface
                    id={row.id}
                    name={row.name}
                    preview={row.preview}
                    mode="asset"
                    size="card"
                    className="studio-grid-media"
                    assetState={previewAssetState(row)}
                    assetFallbacks={[row.cardPreviewUrl, row.imageUrl, row.thumbnailUrl, row.cachedThumbnailUrl, row.previewUrl]}
                  />
                  <span
                    className="mono"
                    style={{
                      position: "absolute",
                      top: 7,
                      left: 8,
                      fontSize: "8.5px",
                      color: "var(--ink4)",
                      background: "var(--s2)",
                      border: "1px solid var(--b1)",
                      borderRadius: 4,
                      padding: "0 4px",
                    }}
                  >
                    {(row.format || "—").toUpperCase()}
                  </span>
                  <button
                    type="button"
                    onClick={() => onToggleRow(row.id)}
                    aria-label="Remove from comparison"
                    style={{
                      position: "absolute",
                      top: 6,
                      right: 6,
                      width: 20,
                      height: 20,
                      borderRadius: 6,
                      border: "1px solid var(--b2)",
                      background: "var(--s2)",
                      color: "var(--ink3)",
                      fontSize: 10,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    ✕
                  </button>
                  {label ? (
                    <span
                      style={{
                        position: "absolute",
                        bottom: 6,
                        left: 8,
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 4,
                        fontSize: "9.5px",
                        fontWeight: 600,
                        borderRadius: 5,
                        padding: "1px 6px",
                        whiteSpace: "nowrap",
                        color: `var(--${kind}-fg)`,
                        background: `var(--${kind}-bg)`,
                        border: `1px solid var(--${kind}-bd)`,
                      }}
                    >
                      {label}
                    </span>
                  ) : null}
                </div>
                <div style={{ padding: "8px 10px 10px 10px" }}>
                  <div
                    style={{
                      fontSize: "11.5px",
                      fontWeight: 600,
                      lineHeight: 1.25,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {row.name}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4, flexWrap: "wrap" }}>
                    {assessment ? (
                      <span
                        data-studio-assessment={assessment.label}
                        title={
                          assessment.blockerCode
                            ? humanizeToken(assessment.blockerCode)
                            : assessment.label
                        }
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 4,
                          fontSize: "9.5px",
                          fontWeight: 600,
                          borderRadius: 5,
                          padding: "1px 6px",
                          whiteSpace: "nowrap",
                          color: tonePalette(assessment.tone).fg,
                          background: tonePalette(assessment.tone).bg,
                          border: `1px solid ${tonePalette(assessment.tone).bd}`,
                        }}
                      >
                        {assessment.label}
                      </span>
                    ) : (
                      <span
                        data-studio-assessment="unavailable"
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 4,
                          fontSize: "9.5px",
                          fontWeight: 600,
                          borderRadius: 5,
                          padding: "1px 6px",
                          whiteSpace: "nowrap",
                          color: "var(--ink3)",
                          background: "var(--s3)",
                          border: "1px solid var(--b1)",
                        }}
                      >
                        Assessment unavailable
                      </span>
                    )}
                    <span style={{ fontSize: "9.5px", color: "var(--ink3)" }}>{row.creativePrimaryLabel ?? "—"}</span>
                  </div>
                  <div className="mono" style={{ fontSize: 9, color: "var(--ink4)", marginTop: 4 }}>
                    {formatUsageCount(row)} · {row.campaignName ?? "—"}
                  </div>
                  {outsideCurrentFilter ? (
                    <div
                      data-testid={`studio-outside-filter-${row.id}`}
                      style={{ marginTop: 5, fontSize: 9, color: "var(--caution-fg)", background: "var(--caution-bg)", border: "1px solid var(--caution-bd)", borderRadius: 5, padding: "2px 6px", display: "inline-block" }}
                    >
                      Outside current filter
                    </div>
                  ) : null}
                  <div style={{ display: "flex", gap: 14, marginTop: 8, paddingTop: 8, borderTop: "1px solid var(--b1)" }}>
                    {gridKpis.map((id) => (
                      <div key={id}>
                        <div style={{ fontSize: "8.5px", color: "var(--ink3)", textTransform: "uppercase", letterSpacing: ".02em" }}>
                          {metricLabel(id)}
                        </div>
                        <div className="tnum" style={{ fontSize: 13, fontWeight: 600, marginTop: 1 }}>
                          {cellDisplay(row, id)}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "9px 0 2px 0" }}>
          {!gridExpanded && selectedEntries.length > gridCollapsedLimit ? (
            <button
              type="button"
              onClick={() => setGridExpanded(true)}
              style={{
                height: 26,
                padding: "0 12px",
                borderRadius: 7,
                border: "1px solid var(--b2)",
                background: "var(--s2)",
                fontSize: 11,
                fontWeight: 600,
                color: "var(--ink2)",
              }}
            >
              Show {selectedEntries.length - gridCollapsedLimit} more
            </button>
          ) : null}
          {gridExpanded && selectedEntries.length > gridCollapsedLimit ? (
            <button
              type="button"
              onClick={() => setGridExpanded(false)}
              style={{
                height: 26,
                padding: "0 12px",
                borderRadius: 7,
                border: "1px solid transparent",
                background: "transparent",
                fontSize: 11,
                fontWeight: 600,
                color: "var(--ink3)",
              }}
            >
              Show less
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  /* ----------------------------------------------------- usage drawer (dynamic) */
  function renderUsageDrawer(row: MetaCreativeRow) {
    const card = rowCard(row);
    const action = card?.decisionCenterRow?.buyerAction ?? null;
    const label = card?.decisionCenterRow?.buyerLabel ?? null;
    const decision = card?.decisionCenterRow ?? null;
    const kind = decisionKind(action);
    const drawerCurrency = resolveCreativeCurrency(row.currency ?? null, defaultCurrency);
    const adsManagerUrl = buildMetaAdsManagerUrl(row);
    const measured = row.metricsAvailability !== "unavailable";
    // The design's funnel: every step is a served Meta action count, so a step
    // the account does not report drops out rather than showing a zero.
    const funnelSteps = measured
      ? ([
          { k: "Impressions", v: row.impressions },
          { k: "Link clicks", v: row.linkClicks },
          { k: "Add to cart", v: row.addToCart },
          { k: "Checkout", v: row.initiateCheckout },
          { k: "Purchases", v: row.purchases },
        ] as Array<{ k: string; v: number }>).filter((step) => Number.isFinite(step.v))
      : [];
    const funnelTop = funnelSteps.length > 0 ? Math.max(...funnelSteps.map((step) => step.v)) : 0;
    const evidencePairs = measured
      ? ([
          { k: "CPM", v: formatMoney(row.cpm, drawerCurrency, defaultCurrency) },
          { k: "CPC · link", v: formatMoney(row.cpcLink, drawerCurrency, defaultCurrency) },
          { k: "CTR · link", v: `${row.linkCtr.toFixed(2)}%` },
          { k: "CPA", v: formatMoney(row.cpa, drawerCurrency, defaultCurrency) },
          {
            k: "Frequency",
            v: typeof row.frequency === "number" ? row.frequency.toFixed(2) : "—",
          },
          { k: "Thumbstop", v: `${row.thumbstop.toFixed(2)}%` },
        ] as Array<{ k: string; v: string }>)
      : [];
    const measuredRows = usageRows.filter(
      (usage) => usage.metricsAvailability !== "unavailable",
    );
    const usageSpend =
      usageRowsState === "ready" && measuredRows.length > 0
        ? measuredRows.reduce((sum, usage) => sum + usage.spend, 0)
        : null;
    const usageRevenue =
      usageRowsState === "ready" && measuredRows.length > 0
        ? measuredRows.reduce((sum, usage) => sum + usage.purchaseValue, 0)
        : null;
    const usageRoas =
      usageSpend !== null && usageSpend > 0 && usageRevenue !== null
        ? usageRevenue / usageSpend
        : null;
    const usageCountLabel =
      usageRowsState === "ready"
        ? `${usageRows.length} in window`
        : usageRowsState === "loading"
          ? "Loading"
          : "—";
    return (
      <>
        <div
          className="studio-usage-overlay"
          style={{ position: "absolute", inset: 0, zIndex: 60, background: "var(--ovl)" }}
          onClick={closeUsageDrawer}
        />
        <aside
          aria-label="Creative ad usage performance"
          className="studio-usage-drawer"
          style={{
            position: "absolute",
            top: 0,
            right: 0,
            bottom: 0,
            zIndex: 61,
            // The design's evidence window: 560px over the canvas colour, lifted
            // by a long left shadow rather than a border.
            width: 560,
            maxWidth: "94vw",
            background: "var(--s1)",
            boxShadow: "-28px 0 70px rgba(11,16,32,0.35)",
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
          }}
        >
          {/* The design's evidence window opens on a navy band: source eyebrow,
              creative name, the decision chip, then the close control. */}
          <div style={{ flex: "none", padding: "14px 18px", background: "#0B1020", display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <p style={{ margin: 0, fontSize: "9.5px", textTransform: "uppercase", letterSpacing: ".1em", color: "#8B93A7" }}>
                Creative evidence · Meta
              </p>
              <p
                style={{ margin: "3px 0 0", fontSize: 16, fontWeight: 600, color: "#ffffff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                title={row.name}
              >
                {row.name}
              </p>
            </div>
            {label ? (
              <span
                style={{
                  display: "inline-flex",
                  borderRadius: 7,
                  padding: "4px 11px",
                  fontSize: 12,
                  fontWeight: 700,
                  background: `var(--${kind}-bg)`,
                  color: `var(--${kind}-fg)`,
                }}
              >
                {label}
              </span>
            ) : null}
            <button
              type="button"
              onClick={closeUsageDrawer}
              aria-label="Close"
              style={{
                flex: "none",
                width: 28,
                height: 28,
                display: "grid",
                placeItems: "center",
                borderRadius: 8,
                border: "1px solid rgba(255,255,255,0.14)",
                background: "transparent",
                color: "#8B93A7",
                fontSize: 13,
                lineHeight: 1,
              }}
            >
              ✕
            </button>
          </div>

          <div style={{ flex: "none", display: "flex", gap: 12, alignItems: "flex-start", padding: "14px 18px 0" }}>
            <div className="studio-table-media-wrap" style={{ width: 48, height: 58, borderRadius: 6 }}>
              <CreativeRenderSurface
                id={row.id}
                name={row.name}
                preview={row.preview}
                mode="asset"
                size="thumb"
                className="studio-table-media"
                assetState={previewAssetState(row)}
                assetFallbacks={[row.cardPreviewUrl, row.imageUrl, row.thumbnailUrl, row.cachedThumbnailUrl, row.previewUrl]}
              />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="mono" style={{ fontSize: "10.5px", color: "var(--ink3)" }}>
                {(row.format || "—").toUpperCase()} · {row.creativeId}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 8, flexWrap: "wrap" }}>
                <div>
                  <div style={{ fontSize: "8.5px", color: "var(--ink3)", textTransform: "uppercase", letterSpacing: ".02em" }}>Usage</div>
                  <div style={{ fontSize: 12, fontWeight: 600 }}>{usageCountLabel}</div>
                </div>
                <div>
                  <div style={{ fontSize: "8.5px", color: "var(--ink3)", textTransform: "uppercase", letterSpacing: ".02em" }}>Ad-grain spend</div>
                  <div className="tnum" style={{ fontSize: 12, fontWeight: 600 }}>
                    {usageSpend === null
                      ? "—"
                      : formatMoney(
                          usageSpend,
                          resolveCreativeCurrency(row.currency ?? null, defaultCurrency),
                          defaultCurrency,
                        )}
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: "8.5px", color: "var(--ink3)", textTransform: "uppercase", letterSpacing: ".02em" }}>Weighted ROAS</div>
                  <div className="tnum" style={{ fontSize: 12, fontWeight: 600 }}>{formatRoas(usageRoas)}</div>
                </div>
              </div>
            </div>
          </div>

          <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "12px 18px 0", display: "flex", flexDirection: "column", gap: 12 }}>
            {/* Decision contract — the server's own verdict line and the money
                it is about. Nothing here is recomputed in the client. */}
            {decision ? (
              <div style={{ borderRadius: 12, background: "var(--s2)", border: "1px solid var(--b1)", padding: "12px 14px" }}>
                <p style={{ margin: 0, fontSize: 9, textTransform: "uppercase", letterSpacing: ".1em", color: "var(--ink3)" }}>Decision contract</p>
                <p style={{ margin: "6px 0 0", fontSize: 13, lineHeight: 1.55, color: "var(--ink)" }}>
                  <b>{decision.buyerLabel}</b>
                  {decision.oneLine ? ` — ${decision.oneLine}` : ""}
                </p>
                <p style={{ margin: "8px 0 0", fontSize: 17, fontWeight: 700, color: "var(--ink)" }}>
                  {measured
                    ? formatMoney(row.spend, drawerCurrency, defaultCurrency)
                    : "—"}
                  <span style={{ fontSize: "11.5px", fontWeight: 500, color: "var(--ink3)", marginLeft: 6 }}>
                    {measured
                      ? `spend · ${formatRoas(row.roas)} ROAS · ${dateRangeLabel}`
                      : "no measured spend in this window"}
                  </span>
                </p>
                {decision.nextStep ? (
                  <p style={{ margin: "8px 0 0", fontSize: "11.5px", color: "var(--ink3)" }}>
                    Next step: {decision.nextStep}
                  </p>
                ) : null}
              </div>
            ) : null}

            {decision && decision.reasons.length > 0 ? (
              <div style={{ borderRadius: 12, background: "var(--s2)", border: "1px solid var(--b1)", padding: "12px 14px" }}>
                <p style={{ margin: "0 0 7px", fontSize: 9, textTransform: "uppercase", letterSpacing: ".1em", color: "var(--ink3)" }}>
                  Engine reasoning
                </p>
                {decision.reasons.map((reason, index) => (
                  <p
                    key={`${decision.creativeId}-reason-${index}`}
                    style={{ margin: "0 0 5px", display: "flex", gap: 8, fontSize: "12.5px", lineHeight: 1.5, color: "var(--ink2)" }}
                  >
                    <span style={{ marginTop: 7, flex: "none", width: 4, height: 4, borderRadius: 9999, background: `var(--${kind}-fg)` }} />
                    <span>{reason}</span>
                  </p>
                ))}
              </div>
            ) : null}

            {funnelSteps.length > 0 && funnelTop > 0 ? (
              <div style={{ borderRadius: 12, background: "var(--s2)", border: "1px solid var(--b1)", padding: "12px 14px" }}>
                <p style={{ margin: "0 0 9px", fontSize: 9, textTransform: "uppercase", letterSpacing: ".1em", color: "var(--ink3)" }}>
                  Click-to-purchase funnel · {dateRangeLabel}
                </p>
                <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                  {funnelSteps.map((step, index) => {
                    const previous = index === 0 ? null : funnelSteps[index - 1].v;
                    return (
                      <div key={step.k} style={{ display: "flex", alignItems: "center", gap: 9 }}>
                        <span style={{ width: 84, fontSize: "11.5px", fontWeight: 600, color: "var(--ink2)" }}>{step.k}</span>
                        <span style={{ flex: 1, height: 14, borderRadius: 5, background: "var(--s4)", overflow: "hidden" }}>
                          <span
                            style={{
                              display: "block",
                              height: "100%",
                              width: `${Math.max((step.v / funnelTop) * 100, step.v > 0 ? 2 : 0)}%`,
                              borderRadius: 5,
                              background: `var(--${kind}-fg)`,
                            }}
                          />
                        </span>
                        <span className="tnum" style={{ width: 62, textAlign: "right", fontSize: 12, fontWeight: 600, color: "var(--ink)" }}>
                          {Math.round(step.v).toLocaleString()}
                        </span>
                        <span className="tnum" style={{ width: 66, textAlign: "right", fontSize: "9.5px", color: "var(--ink4)" }}>
                          {previous === null || previous === 0 ? "—" : `${((step.v / previous) * 100).toFixed(1)}%`}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}

            {evidencePairs.length > 0 ? (
              <div style={{ borderRadius: 12, background: "var(--s2)", border: "1px solid var(--b1)", padding: "4px 14px", display: "grid", gridTemplateColumns: "1fr 1fr", columnGap: 14 }}>
                {evidencePairs.map((pair) => (
                  <div
                    key={pair.k}
                    style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, borderBottom: "1px solid var(--s1)", padding: "8px 0" }}
                  >
                    <span style={{ fontSize: "11.5px", color: "var(--ink3)" }}>{pair.k}</span>
                    <span className="tnum" style={{ fontSize: 11, fontWeight: 500, color: "var(--ink2)" }}>{pair.v}</span>
                  </div>
                ))}
              </div>
            ) : null}

          <div style={{ flex: "none", display: "flex", alignItems: "center", gap: 5, padding: "12px 16px 8px 16px", flexWrap: "wrap" }}>
            <span style={{ color: "var(--info-fg)", fontSize: 11, fontWeight: 600 }}>
              {account?.name ?? "Account"}
            </span>
            <span style={{ color: "var(--ink4)", fontSize: 10 }}>›</span>
            <span style={{ fontSize: 11, color: "var(--ink3)", fontWeight: 600 }}>Exact ad usages</span>
            <span className="mono" style={{ marginLeft: "auto", fontSize: 9.5, color: "var(--ink4)" }}>{dateRangeLabel}</span>
          </div>

          <div style={{ flex: "none", margin: "0 0 8px", padding: "8px 10px", border: "1px solid var(--b1)", borderRadius: 8, background: "var(--s3)", fontSize: 10, color: "var(--ink3)", lineHeight: 1.45 }}>
            Rows below are provider ad-grain performance for this account and window. The badge above remains the server&apos;s
            creative-level decision; Studio does not copy that action onto every ad usage.
          </div>

            {usageRowsState === "loading" ? (
              <div style={{ padding: "24px 16px", color: "var(--ink3)", fontSize: 11.5 }}>Loading exact ad usages…</div>
            ) : usageRowsState === "error" ? (
              <div style={{ margin: "4px 16px 12px", padding: 12, border: "1px solid var(--danger-bd)", borderRadius: 8, background: "var(--danger-bg)", color: "var(--danger-fg)", fontSize: 11 }}>
                <strong style={{ display: "block", marginBottom: 3 }}>Usage performance unavailable</strong>
                <span>{usageRowsError ?? "The account-scoped usage query failed."}</span>
                <button type="button" onClick={() => void openUsageDrawer(row)} style={{ display: "block", marginTop: 8, border: "1px solid var(--danger-bd)", borderRadius: 6, background: "var(--s2)", color: "var(--danger-fg)", padding: "4px 8px", fontWeight: 600 }}>
                  Retry
                </button>
              </div>
            ) : usageRows.length === 0 ? (
              <div style={{ padding: "24px 16px", color: "var(--ink3)", fontSize: 11.5 }}>
                No exact ad usage has performance in this window. No representative row is substituted.
              </div>
            ) : (
              usageRows.map((usage) => (
                <div className="studio-usage-row" key={usage.realAdId ?? usage.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", borderBottom: "1px solid var(--b1)" }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
                      <strong style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12.5 }}>
                        {usage.campaignName ?? "Campaign unavailable"}
                      </strong>
                      {usage.effectiveStatus ? (
                        <span style={{ flex: "none", border: "1px solid var(--b1)", borderRadius: 5, padding: "1px 5px", color: "var(--ink3)", background: "var(--s3)", fontSize: 8.5, fontWeight: 600 }}>
                          {usage.effectiveStatus}
                        </span>
                      ) : null}
                    </div>
                    <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--ink3)", fontSize: 10, marginTop: 2 }}>
                      {usage.adSetName ?? "Ad set unavailable"} › {usage.name}
                    </div>
                    <div className="mono" style={{ display: "flex", gap: 8, flexWrap: "wrap", color: "var(--ink4)", fontSize: 8.5, marginTop: 3 }}>
                      <span>Ad {usage.realAdId ?? usage.id}</span>
                      {usage.optimizationGoal ? <span>{humanizeToken(usage.optimizationGoal)}</span> : null}
                      {usage.bidStrategy ? <span>{humanizeToken(usage.bidStrategy)}</span> : null}
                    </div>
                  </div>
                  <div className="studio-usage-metrics" style={{ display: "grid", gridTemplateColumns: "repeat(3,minmax(66px,auto))", gap: 14, flex: "none", textAlign: "right" }}>
                    {["spend", "roas", "purchases"].map((metricId) => (
                      <div key={metricId}>
                        <div style={{ fontSize: 8.5, color: "var(--ink3)", textTransform: "uppercase" }}>{metricLabel(metricId)}</div>
                        <div className="tnum" style={{ fontSize: 11.5, fontWeight: 600 }}>{cellDisplay(usage, metricId)}</div>
                      </div>
                    ))}
                  </div>
                </div>
              ))
            )}

            <div style={{ padding: "12px 16px" }}>
              <button
                type="button"
                onClick={() => setDrawerTrends((prev) => !prev)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 7,
                  width: "100%",
                  textAlign: "left",
                  border: "1px solid var(--b1)",
                  borderRadius: 8,
                  background: "var(--s2)",
                  padding: "9px 11px",
                  color: "var(--ink2)",
                  fontSize: "11.5px",
                  fontWeight: 600,
                }}
              >
                <span className="mono" style={{ fontSize: 10, color: "var(--ink4)" }}>{drawerTrends ? "▾" : "▸"}</span>
                Trends (7 / 28 / 90d)
                <span style={{ flex: 1 }} />
                <span style={{ fontSize: "9.5px", color: "var(--ink4)", fontWeight: 500 }}>collapsed by default</span>
              </button>
              {drawerTrends ? (
                <div style={{ marginTop: 8, padding: 11, border: "1px solid var(--b1)", borderRadius: 8, fontSize: 11, color: "var(--ink3)", lineHeight: 1.5 }}>
                  Exact per-ad 7 / 28 / 90-day trend series are not returned in one response. No interpolated trend is shown.
                </div>
              ) : null}
            </div>
          </div>

          {/* The design closes the window on an action bar: the decision's own
              primary action, the Studio comparison, and the provider link. */}
          <div style={{ flex: "none", display: "flex", gap: 8, padding: "12px 18px", borderTop: "1px solid var(--b1)", background: "var(--s2)" }}>
            <Link
              href={studioHref("/platforms/meta/decisions")}
              onClick={closeUsageDrawer}
              style={{
                flex: 1,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                height: 38,
                borderRadius: 9,
                background: label ? `var(--${kind}-fg)` : "var(--ink2)",
                color: "#ffffff",
                fontSize: 13,
                fontWeight: 700,
                textDecoration: "none",
              }}
            >
              {label ? `Take to Decisions · ${label}` : "Take to Decisions"}
            </Link>
            <Link
              href={studioHref("/platforms/meta/creatives", "winners")}
              onClick={closeUsageDrawer}
              style={{ display: "inline-flex", alignItems: "center", height: 38, padding: "0 13px", borderRadius: 9, border: "1px solid var(--b1)", background: "var(--s2)", fontSize: "12.5px", fontWeight: 600, color: "var(--ink)", textDecoration: "none" }}
            >
              Compare in Studio
            </Link>
            {adsManagerUrl ? (
              <a
                href={adsManagerUrl}
                target="_blank"
                rel="noreferrer"
                style={{ display: "inline-flex", alignItems: "center", height: 38, padding: "0 13px", borderRadius: 9, border: "1px solid var(--b1)", background: "var(--s2)", fontSize: "12.5px", fontWeight: 600, color: "var(--ink2)", textDecoration: "none" }}
              >
                Ads Manager ↗
              </a>
            ) : null}
          </div>
        </aside>
      </>
    );
  }

  /* ================================================================ winners */
  function renderWinners() {
    if (!hasAccount) return renderAccountRequired();
    const evidence = buildCurrentWinnerEvidence(briefingCards);
    const historical = buildHistoricalWinnerEraState(briefingCards);
    return (
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "12px 0 16px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
          <h2 style={{ margin: 0, fontSize: 12, fontWeight: 700, textTransform: "uppercase", color: "var(--ink2)" }}>Current winners</h2>
          <span style={{ fontSize: 10, color: "var(--ink3)" }}>truth-source qualified · 7d / 28d / 90d</span>
        </div>
        {evidence.qualified.length === 0 ? (
          <div style={{ border: "1px solid var(--b1)", borderRadius: 10, background: "var(--s2)", padding: 14, fontSize: "11.5px", color: "var(--ink3)", marginBottom: 22 }}>
            No creative is truth-source qualified as a current winner for this account and window. Winner language is withheld until server
            truth source, threshold quality, confidence and engine era are all present.
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(238px,1fr))", gap: 12, marginBottom: 22 }}>
            {evidence.qualified.map((winner) => {
              const mediaRow = findRow(winner.creativeId, winner.id, winner.realAdId, winner.metaAdId, winner.effectiveAdId);
              const winnerName = winner.creativeName ?? winner.name ?? winner.creativeId ?? "Creative";
              return (
                <div key={winner.id} style={{ display: "flex", gap: 10, background: "var(--s2)", border: "1px solid var(--b1)", borderRadius: 10, padding: 11 }}>
                  <div className="studio-table-media-wrap" style={{ width: 54, height: 54, borderRadius: 8 }}>
                    {mediaRow ? (
                      <CreativeRenderSurface
                        id={mediaRow.id}
                        name={mediaRow.name}
                        preview={mediaRow.preview}
                        mode="asset"
                        size="thumb"
                        className="studio-table-media"
                        assetState={previewAssetState(mediaRow)}
                        assetFallbacks={[mediaRow.tableThumbnailUrl, mediaRow.cachedThumbnailUrl, mediaRow.thumbnailUrl, mediaRow.imageUrl, mediaRow.previewUrl]}
                      />
                    ) : (
                      <span style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", padding: 4, textAlign: "center", fontSize: 8, color: "var(--ink4)" }}>
                        Media unavailable
                      </span>
                    )}
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: "11.5px", fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {winnerName}
                    </div>
                    <div style={{ display: "flex", alignItems: "baseline", gap: 5, marginTop: 2 }}>
                      <span className="tnum" style={{ fontSize: 18, fontWeight: 600 }}>{formatRoas(winner.roas)}</span>
                      <span style={{ fontSize: 9, color: "var(--pos-fg)", fontWeight: 600 }}>{winner.truthSource ?? "—"}</span>
                    </div>
                    <div className="mono" style={{ fontSize: 9, color: "var(--ink4)", marginTop: 2 }}>
                      {winner.decisionCenterRow?.buyerLabel ?? "—"} · {(winner.format ?? "—").toUpperCase()}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
          <h2 style={{ margin: 0, fontSize: 12, fontWeight: 700, textTransform: "uppercase", color: "var(--ink2)" }}>Historical winners</h2>
          <span style={{ fontSize: 10, color: "var(--ink3)" }}>separated by engine-version era</span>
        </div>
        {historical.status !== "available" ? (
          <div style={{ border: "1px solid var(--b1)", borderRadius: 10, background: "var(--s2)", padding: 14, fontSize: "11.5px", color: "var(--ink3)" }}>
            {historical.reason}
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {historical.eras.map((era) => (
              <div key={era.engineVersion}>
                <div className="mono" style={{ fontSize: 10, color: "var(--ink4)", marginBottom: 8 }}>engine {era.engineVersion}</div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(238px,1fr))", gap: 12 }}>
                  {era.entries.map((entry) => {
                    const mediaRow = findRow(entry.creativeId);
                    return (
                      <div
                        key={`${entry.creativeId}-${entry.entry.date}`}
                        style={{ display: "flex", gap: 10, background: "var(--s2)", border: "1px solid var(--b1)", borderRadius: 10, padding: 11, opacity: 0.92 }}
                      >
                        <div className="studio-table-media-wrap" style={{ width: 54, height: 54, borderRadius: 8 }}>
                          {mediaRow ? (
                            <CreativeRenderSurface
                              id={mediaRow.id}
                              name={mediaRow.name}
                              preview={mediaRow.preview}
                              mode="asset"
                              size="thumb"
                              className="studio-table-media"
                              assetState={previewAssetState(mediaRow)}
                              assetFallbacks={[mediaRow.tableThumbnailUrl, mediaRow.cachedThumbnailUrl, mediaRow.thumbnailUrl, mediaRow.imageUrl, mediaRow.previewUrl]}
                            />
                          ) : (
                            <span style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", padding: 4, textAlign: "center", fontSize: 8, color: "var(--ink4)" }}>
                              Media unavailable
                            </span>
                          )}
                        </div>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: "11.5px", fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                            {entry.creativeName}
                          </div>
                          <div className="mono" style={{ fontSize: 9, color: "var(--ink4)", marginTop: 4 }}>
                            {entry.entry.currentLabel} · {entry.entry.date}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  /* ================================================================ briefs */
  function renderBriefs() {
    if (!hasAccount) return renderAccountRequired();
    const active = creativeBriefs.find((brief) => brief.id === selectedBriefId) ?? creativeBriefs[0] ?? null;
    return (
      <div className="studio-split-pane" style={{ padding: "11px 16px 14px 16px" }}>
        <div className="studio-split-list" style={{ width: 320, flex: "none", display: "flex", flexDirection: "column", border: "1px solid var(--b1)", borderRadius: 11, background: "var(--s2)", overflow: "hidden" }}>
          <div style={{ padding: "9px 12px", borderBottom: "1px solid var(--b1)", display: "flex", alignItems: "center", gap: 7 }}>
            <span style={{ fontSize: 12, fontWeight: 600 }}>Creative Briefs</span>
            <span className="tnum" style={{ fontSize: 10, color: "var(--ink3)" }}>{creativeBriefs.length}</span>
            <div style={{ flex: 1 }} />
            <button
              type="button"
              onClick={() => onNewBrief?.()}
              disabled={!onNewBrief}
              title={onNewBrief ? "Start a brief from the top decision" : "No decision-linked creative available"}
              style={{
                background: onNewBrief ? "var(--ink)" : "var(--s3)",
                color: onNewBrief ? "var(--s2)" : "var(--ink4)",
                border: `1px solid ${onNewBrief ? "var(--ink)" : "var(--b2)"}`,
                borderRadius: 6,
                padding: "3px 9px",
                fontSize: "10.5px",
                fontWeight: 600,
                cursor: onNewBrief ? "pointer" : "not-allowed",
              }}
            >
              + New
            </button>
          </div>
          <div style={{ flex: 1, overflowY: "auto" }}>
            {creativeBriefsState !== "ready" ? (
              <div style={{ padding: 12, fontSize: "11.5px", color: "var(--ink3)" }}>
                {creativeBriefsState === "error"
                  ? "Creative briefs are unavailable."
                  : creativeBriefsState === "migration_required"
                    ? "Creative Brief storage requires the pending database migration. Read and write actions are disabled."
                    : "Loading account-scoped briefs…"}
              </div>
            ) : creativeBriefs.length === 0 ? (
              <div style={{ padding: 12, fontSize: "11.5px", color: "var(--ink3)" }}>
                No reviewed briefs yet. Briefs are created from a persisted decision snapshot.
              </div>
            ) : (
              creativeBriefs.map((brief) => {
                const selected = active?.id === brief.id;
                const p = tonePalette(brief.status === "reviewed" ? "pos" : "info");
                return (
                  <button
                    key={brief.id}
                    type="button"
                    onClick={() => setSelectedBriefId(brief.id)}
                    style={{
                      display: "flex",
                      width: "100%",
                      textAlign: "left",
                      padding: "10px 12px",
                      border: "none",
                      borderBottom: "1px solid var(--b1)",
                      background: selected ? "var(--sel)" : "transparent",
                      color: "var(--ink)",
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span className="mono" style={{ fontSize: 9, color: "var(--ink4)" }}>{brief.id.slice(0, 8)}</span>
                        <span
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 4,
                            fontSize: "9.5px",
                            fontWeight: 600,
                            borderRadius: 5,
                            padding: "1px 6px",
                            whiteSpace: "nowrap",
                            color: p.fg,
                            background: p.bg,
                            border: `1px solid ${p.bd}`,
                          }}
                        >
                          {brief.status}
                        </span>
                      </div>
                      <div style={{ fontSize: "11.5px", fontWeight: 500, marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {brief.sourceDecision.rawLabel} · {brief.sourceDecision.creativeId}
                      </div>
                      <div className="mono" style={{ fontSize: 9, color: "var(--ink4)", marginTop: 1 }}>
                        {new Date(brief.updatedAt).toISOString().slice(0, 10)} · {brief.createdBy}
                      </div>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>

        <div style={{ flex: 1, minWidth: 0, border: "1px solid var(--b1)", borderRadius: 11, background: "var(--s2)", overflowY: "auto" }}>
          {active ? (
            <>
              <div style={{ padding: "13px 15px", borderBottom: "1px solid var(--b1)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span className="mono" style={{ fontSize: 10, color: "var(--ink3)" }}>{active.id.slice(0, 8)}</span>
                  {(() => {
                    const p = tonePalette(active.status === "reviewed" ? "pos" : "info");
                    return (
                      <span
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 4,
                          fontSize: "9.5px",
                          fontWeight: 600,
                          borderRadius: 5,
                          padding: "1px 6px",
                          whiteSpace: "nowrap",
                          color: p.fg,
                          background: p.bg,
                          border: `1px solid ${p.bd}`,
                        }}
                      >
                        {active.status}
                      </span>
                    );
                  })()}
                </div>
                <div style={{ fontSize: 14, fontWeight: 600, marginTop: 6 }}>
                  {active.sourceDecision.rawLabel} · {active.sourceDecision.creativeId}
                </div>
                <div className="mono" style={{ fontSize: "9.5px", color: "var(--ink4)", marginTop: 3 }}>
                  updated {new Date(active.updatedAt).toISOString().slice(0, 16).replace("T", " ")} · {active.createdBy}
                </div>
              </div>
              <div style={{ padding: "12px 15px", borderBottom: "1px solid var(--b1)", display: "flex", alignItems: "center", gap: 8, background: "var(--s3)" }}>
                <span className="mono" style={{ fontSize: 9, color: "var(--ink4)" }}>lineage</span>
                <span className="mono" style={{ fontSize: "10.5px", color: "var(--ink2)" }}>
                  {active.sourceDecision.decisionId} · snapshot {active.sourceDecision.snapshotAsOf} · engine {active.sourceDecision.engineVersion} · frozen at creation
                </span>
              </div>
              <div className="studio-brief-columns" style={{ padding: "14px 15px", display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
                {[
                  { title: "Keep", tone: "var(--pos-fg)", text: active.content.keep },
                  { title: "Change", tone: "var(--caution-fg)", text: active.content.change },
                  { title: "Next", tone: "var(--info-fg)", text: active.content.next },
                ].map((column) => (
                  <div key={column.title}>
                    <div style={{ fontSize: "9.5px", textTransform: "uppercase", letterSpacing: ".04em", color: column.tone, fontWeight: 600, marginBottom: 5 }}>
                      {column.title}
                    </div>
                    <div style={{ fontSize: "11.5px", color: "var(--ink2)", lineHeight: 1.5, border: "1px solid var(--b1)", borderRadius: 8, padding: 9, minHeight: 92 }}>
                      {column.text?.trim() ? column.text : "—"}
                    </div>
                  </div>
                ))}
              </div>
              <div style={{ padding: "0 15px 15px 15px", display: "flex", gap: 7 }}>
                <button
                  type="button"
                  onClick={() => onEditBrief(active)}
                  style={{ background: "var(--s2)", border: "1px solid var(--b2)", borderRadius: 8, padding: "7px 12px", fontWeight: 600, fontSize: 12, color: "var(--ink2)" }}
                >
                  Edit brief
                </button>
                <div style={{ flex: 1 }} />
                <Link
                  href={buildMetaScopedHref(
                    launchpadHref,
                    {
                      businessId,
                      providerAccountId: active.providerAccountId,
                    },
                    {
                      creativeBriefId: active.id,
                      sourceDecisionSnapshotId: active.sourceDecision.snapshotId,
                    },
                  )}
                  style={{ background: "var(--info-fg)", border: "1px solid var(--info-fg)", borderRadius: 8, padding: "7px 14px", fontWeight: 600, fontSize: 12, color: "#fff", textDecoration: "none" }}
                >
                  Send to Launchpad →
                </Link>
              </div>
            </>
          ) : (
            <div style={{ padding: 16, fontSize: 12, color: "var(--ink3)" }}>Select a brief to review its Keep / Change / Next.</div>
          )}
        </div>
      </div>
    );
  }

  /* ================================================================ shares */
  function renderShares() {
    if (!hasAccount) return renderAccountRequired();
    const creatorGrants = shareGrants.filter((grant) => grant.audience !== "buyer");
    const activeGrant =
      creatorGrants.find((grant) => grant.token === selectedShareToken) ??
      creatorGrants[0] ??
      null;
    const statusTone: Record<CreativeShareLedgerEntry["status"], Tone> = {
      active: "pos",
      expired: "caution",
      revoked: "danger",
    };
    const audienceLabel = (audience: CreativeShareLedgerEntry["audience"]) =>
      audience === "creative_team" ? "Creative team" : audience === "external" ? "External creator" : "Buyer";
    const expiryLabel = (grant: CreativeShareLedgerEntry) => {
      if (grant.status === "revoked") {
        return grant.revokedAt ? `revoked ${grant.revokedAt.slice(0, 10)}` : "revoked";
      }
      if (grant.status === "expired") return `expired ${grant.expiresAt.slice(0, 10)}`;
      const days = Math.max(0, Math.ceil((new Date(grant.expiresAt).getTime() - Date.now()) / 86_400_000));
      return `expires in ${days}d`;
    };
    return (
      <div className="studio-split-pane" style={{ padding: "11px 16px 14px 16px" }}>
        <div className="studio-split-list" style={{ width: 340, flex: "none", display: "flex", flexDirection: "column", border: "1px solid var(--b1)", borderRadius: 11, background: "var(--s2)", overflow: "hidden" }}>
          <div style={{ padding: "9px 12px", borderBottom: "1px solid var(--b1)", display: "flex", alignItems: "center", gap: 7 }}>
            <span style={{ fontSize: 12, fontWeight: 600 }}>Creator Shares</span>
            <span className="tnum" style={{ fontSize: 10, color: "var(--ink3)" }}>{creatorGrants.length} grants</span>
            <div style={{ flex: 1 }} />
            <button
              type="button"
              onClick={onOpenGrant}
              disabled={shareGrantsCapability?.canWrite === false}
              title={shareGrantsCapability?.canWrite === false ? "Pending database migration" : "Mint a scoped creator link"}
              style={{ background: "var(--ink)", color: "var(--s2)", border: "1px solid var(--ink)", borderRadius: 6, padding: "3px 9px", fontSize: "10.5px", fontWeight: 600 }}
            >
              + Grant
            </button>
          </div>
          <div style={{ flex: 1, overflowY: "auto" }}>
            {shareGrantsCapability?.status === "migration_required" ? (
              <div style={{ padding: 12, fontSize: "11.5px", color: "var(--caution-fg)", lineHeight: 1.5 }}>
                Creator share ledger requires the pending database migration. Grant, rotate and revoke actions are disabled.
              </div>
            ) : shareGrantsState === "loading" ? (
              <div style={{ padding: 12, fontSize: "11.5px", color: "var(--ink3)" }}>Loading account-scoped grants…</div>
            ) : shareGrantsState === "error" ? (
              <div style={{ padding: 12, fontSize: "11.5px", color: "var(--danger-fg)" }}>Creator share ledger could not load.</div>
            ) : creatorGrants.length === 0 ? (
              <div style={{ padding: 12, fontSize: "11.5px", color: "var(--ink3)", lineHeight: 1.5 }}>
                No creator-share grants for this Meta account. Select creatives in Performance, then mint a scoped Tier-0 link.
              </div>
            ) : (
              creatorGrants.map((grant) => {
                const selected = activeGrant?.token === grant.token;
                const palette = tonePalette(statusTone[grant.status]);
                return (
                  <button
                    key={grant.token}
                    type="button"
                    onClick={() => setSelectedShareToken(grant.token)}
                    style={{
                      width: "100%",
                      padding: "10px 12px",
                      border: "none",
                      borderBottom: "1px solid var(--b1)",
                      borderLeft: selected ? "3px solid var(--focus)" : "3px solid transparent",
                      background: selected ? "var(--sel)" : "transparent",
                      color: "var(--ink)",
                      textAlign: "left",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ color: palette.fg, background: palette.bg, border: `1px solid ${palette.bd}`, borderRadius: 5, padding: "1px 6px", fontSize: 9, fontWeight: 600, textTransform: "capitalize" }}>
                        {grant.status}
                      </span>
                      <span className="mono" style={{ fontSize: 9, color: "var(--ink4)" }}>…{grant.token.slice(-6)}</span>
                    </div>
                    <div style={{ marginTop: 4, fontSize: "11.5px", fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {grant.title} · {audienceLabel(grant.audience)}
                    </div>
                    <div style={{ marginTop: 1, fontSize: 10, color: "var(--ink3)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {grant.firstCreativeName ?? `${grant.creativeCount} creatives`} · {expiryLabel(grant)}
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>
        <div style={{ flex: 1, minWidth: 0, border: "1px solid var(--b1)", borderRadius: 11, background: "var(--s2)", overflowY: "auto" }}>
          {activeGrant ? (
            <>
              <div style={{ padding: "13px 15px", borderBottom: "1px solid var(--b1)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                  <span style={{ fontSize: 9.5, fontWeight: 600, textTransform: "capitalize", color: tonePalette(statusTone[activeGrant.status]).fg }}>{activeGrant.status}</span>
                  <span className="mono" style={{ fontSize: 9.5, color: "var(--ink4)" }}>…{activeGrant.token.slice(-6)}</span>
                </div>
                <div style={{ fontSize: 14, fontWeight: 600, marginTop: 5 }}>{activeGrant.title}</div>
                <div style={{ fontSize: 11, color: "var(--ink3)", marginTop: 2 }}>
                  {activeGrant.firstCreativeName ?? `${activeGrant.creativeCount} creatives`} · Tier 0 · {expiryLabel(activeGrant)}
                </div>
              </div>
              <div style={{ padding: "12px 15px", borderBottom: "1px solid var(--b1)" }}>
                <div style={{ fontSize: "9.5px", textTransform: "uppercase", letterSpacing: ".04em", color: "var(--ink3)", fontWeight: 600, marginBottom: 6 }}>Access ledger</div>
                <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 10px", fontSize: 11 }}>
                  <span style={{ color: "var(--ink3)" }}>Permission tier</span><span>Tier 0 · creative signals only</span>
                  <span style={{ color: "var(--ink3)" }}>Audience</span><span>{audienceLabel(activeGrant.audience)}</span>
                  <span style={{ color: "var(--ink3)" }}>Token</span><span className="mono">…{activeGrant.token.slice(-6)}</span>
                  <span style={{ color: "var(--ink3)" }}>Opens</span><span className="tnum">{activeGrant.openCount}</span>
                  <span style={{ color: "var(--ink3)" }}>Creatives</span><span className="tnum">{activeGrant.creativeCount}</span>
                </div>
              </div>
              {shareMutationError ? <div style={{ padding: "9px 15px", color: "var(--danger-fg)", fontSize: 11 }}>{shareMutationError}</div> : null}
              {activeGrant.status === "active" ? (
                <div style={{ padding: "12px 15px", display: "flex", gap: 7 }}>
                  <button
                    type="button"
                    disabled={!onRotateShare || shareMutationToken === activeGrant.token}
                    onClick={() => {
                      void onRotateShare?.(activeGrant.token).then((nextToken) => {
                        if (nextToken) setSelectedShareToken(nextToken);
                      });
                    }}
                    style={{ background: "var(--s2)", border: "1px solid var(--b2)", borderRadius: 8, padding: "7px 12px", fontWeight: 600, fontSize: 12, color: "var(--ink2)" }}
                  >
                    {shareMutationToken === activeGrant.token ? "Updating…" : "Rotate token"}
                  </button>
                  <button type="button" disabled={!onRevokeShare || shareMutationToken === activeGrant.token} onClick={() => void onRevokeShare?.(activeGrant.token)} style={{ background: "var(--danger-bg)", border: "1px solid var(--danger-bd)", borderRadius: 8, padding: "7px 12px", fontWeight: 600, fontSize: 12, color: "var(--danger-fg)" }}>
                    Revoke access
                  </button>
                  <a href={`/share/creative/${activeGrant.token}`} target="_blank" rel="noreferrer" style={{ marginLeft: "auto", alignSelf: "center", fontSize: 11 }}>Open link ↗</a>
                </div>
              ) : null}
              <div style={{ padding: "0 15px 14px 15px", fontSize: 10, color: "var(--ink4)" }}>
                No spend, revenue, CPA, ROAS, audiences, or campaign names are serialized to a creator view.
              </div>
            </>
          ) : (
            <>
              <div style={{ padding: "13px 15px", borderBottom: "1px solid var(--b1)" }}>
                <div style={{ fontSize: 14, fontWeight: 600 }}>Creator share policy</div>
                <div style={{ fontSize: 11, color: "var(--ink3)", marginTop: 2 }}>Tier 0 · creative signals only</div>
              </div>
              <div style={{ padding: 15, fontSize: 11, color: "var(--ink3)" }}>No creator grant is selected.</div>
            </>
          )}
        </div>
      </div>
    );
  }

  /* ----------------------------------------------------- account-required */
  function renderAccountRequired() {
    return (
      <div style={{ flex: 1, minHeight: 0, display: "flex", alignItems: "flex-start", padding: 16 }}>
        <div
          data-testid="creative-studio-account-required"
          style={{
            width: "100%",
            border: "1px solid var(--caution-bd)",
            background: "var(--caution-bg)",
            borderRadius: 8,
            padding: "12px 14px",
            fontSize: 12,
            color: "var(--caution-fg)",
            lineHeight: 1.5,
          }}
        >
          Select one assigned Meta ad account. Creative performance, decisions, and currency remain withheld until the provider scope is
          explicit.
        </div>
      </div>
    );
  }

}
