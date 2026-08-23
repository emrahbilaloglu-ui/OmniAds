/**
 * Pure mapping from real report records and rendered widget payloads onto the
 * v2 Reports view model.
 *
 * Two rules run through the whole file. A figure the provider did not supply
 * renders as an em dash, never as zero and never as a design seed value; and a
 * block kind no renderer can build yet reports itself unavailable rather than
 * drawing a decorative body that would read as data.
 */
import {
  CUSTOM_REPORT_TEMPLATES,
  resolveWidgetSize,
  type CustomReportDocument,
  type CustomReportRecord,
  type CustomReportTemplate,
  type CustomReportWidgetDefinition,
  type CustomReportWidgetType,
  type RenderedReportWidget,
} from "@/lib/custom-reports";
import type {
  BuilderBlockBodyModel,
  BuilderBlockKind,
  BuilderBlockModel,
  BuilderBlockSize,
  BuilderPaletteGroupModel,
  BuilderPaletteItemModel,
  BuilderSelectOptionModel,
  BuilderSizeOptionModel,
  ReportTemplateModel,
  ReportsTabId,
  ReportsTabModel,
  SavedReportModel,
} from "@/components/reports/reports-exact-model";

export const DASH = "—";

const TONE = {
  pos: ["#E7F6F0", "#0b7954"] as const,
  warn: ["#FBF3E1", "#B45309"] as const,
  info: ["#EAF0FF", "#2a5fe2"] as const,
  auto: ["#F1EBFB", "#6C41BE"] as const,
  neutral: ["#F1F4F9", "#555d6d"] as const,
};

/** Design vocabulary for a stored widget type. `section` predates v2. */
export function toBuilderKind(type: CustomReportWidgetType): BuilderBlockKind {
  switch (type) {
    case "metric":
      return "kpi";
    case "trend":
      return "line";
    case "kpirow":
    case "bar":
    case "donut":
    case "funnel":
    case "table":
    case "heat":
    case "ai":
    case "brief":
      return type;
    default:
      // `section` and anything unrecognised fall back to the design's own
      // fallback block, exactly as the reference prototype does.
      return "text";
  }
}

export function toWidgetType(kind: BuilderBlockKind): CustomReportWidgetType {
  if (kind === "kpi") return "metric";
  if (kind === "line") return "trend";
  return kind;
}

export const BUILDER_KIND_NAMES: Record<BuilderBlockKind, string> = {
  kpi: "KPI tile",
  kpirow: "KPI row",
  line: "Trend line",
  bar: "Bar compare",
  donut: "Share donut",
  funnel: "Funnel",
  table: "Table",
  heat: "Heat table",
  ai: "AI summary",
  text: "Text block",
  brief: "Creative brief",
};

export interface PaletteEntry {
  key: string;
  group: string;
  kind: BuilderBlockKind;
  label: string;
  source: string;
  icon: string;
  size: BuilderBlockSize;
  dataSource: CustomReportWidgetDefinition["dataSource"];
  metricKey?: string;
  columns?: string[];
}

const GROUP_ICON_BG: Record<string, string> = {
  KPIs: "#2a5fe2",
  Charts: "#0b7954",
  Tables: "#B45309",
  Content: "#6C41BE",
};

/**
 * The palette, in the design's order. `dataSource` is what the block reads
 * from the moment it lands on the page, so a dropped block is never an empty
 * shell waiting to be configured.
 */
export const BUILDER_PALETTE: PaletteEntry[] = [
  { key: "kpi", group: "KPIs", kind: "kpi", label: "KPI tile", source: "any", icon: "M12 20V10 M18 20V4 M6 20v-4", size: "S", dataSource: "overview_summary", metricKey: "spend" },
  { key: "kpirow", group: "KPIs", kind: "kpirow", label: "KPI row · 4 up", source: "any", icon: "M3 9h4v6H3z M10 9h4v6h-4z M17 9h4v6h-4z", size: "L", dataSource: "overview_summary" },
  { key: "line", group: "Charts", kind: "line", label: "Trend line", source: "any", icon: "M3 17l6-6 4 4 8-8", size: "M", dataSource: "overview_trend", metricKey: "combined.spend" },
  { key: "bar", group: "Charts", kind: "bar", label: "Bar compare", source: "any", icon: "M6 20V10 M12 20V4 M18 20v-8", size: "M", dataSource: "overview_trend", metricKey: "combined.revenue" },
  { key: "donut", group: "Charts", kind: "donut", label: "Share donut", source: "any", icon: "M12 21a9 9 0 1 0-9-9", size: "S", dataSource: "channel_attribution", metricKey: "revenue" },
  { key: "funnel", group: "Charts", kind: "funnel", label: "Funnel", source: "GA4", icon: "M4 4h16l-6 8v6l-4 2v-8z", size: "S", dataSource: "ga4_data" },
  { key: "table-campaigns", group: "Tables", kind: "table", label: "Campaign table", source: "Meta·G", icon: "M3 5h18v14H3z M3 10h18 M9 5v14", size: "L", dataSource: "meta_campaigns", columns: ["name", "status", "spend", "revenue", "purchases", "roas"] },
  { key: "heat", group: "Tables", kind: "heat", label: "Creative heat table", source: "Meta", icon: "M4 4h6v6H4z M14 4h6v6h-6z M4 14h6v6H4z M14 14h6v6h-6z", size: "L", dataSource: "meta_campaigns" },
  { key: "table-queries", group: "Tables", kind: "table", label: "Query table", source: "GSC", icon: "M3 5h18v14H3z M3 10h18 M9 5v14", size: "L", dataSource: "search_console_data", columns: ["query", "clicks", "impressions", "ctr", "position"] },
  { key: "ai", group: "Content", kind: "ai", label: "AI summary", source: "engine", icon: "M12 3l1.9 5.8L19 12l-5.1 3.2L12 21l-1.9-5.8L5 12l5.1-3.2z", size: "M", dataSource: undefined },
  { key: "text", group: "Content", kind: "text", label: "Text block", source: DASH, icon: "M4 7h16 M4 12h16 M4 17h10", size: "M", dataSource: undefined },
  { key: "table-decisions", group: "Content", kind: "table", label: "Decision log", source: "Meta", icon: "M3 5h18v14H3z M3 10h18 M9 5v14", size: "M", dataSource: "meta_campaigns", columns: ["name", "status", "spend", "revenue"] },
  { key: "brief", group: "Content", kind: "brief", label: "Creative brief", source: "Meta", icon: "M9 3h6v4H9z M5 5h14v16H5z M9 12h6 M9 16h4", size: "L", dataSource: undefined },
];

export function findPaletteEntry(key: string): PaletteEntry | null {
  return BUILDER_PALETTE.find((entry) => entry.key === key) ?? null;
}

export function buildPaletteGroups(): BuilderPaletteGroupModel[] {
  const order = ["KPIs", "Charts", "Tables", "Content"];
  return order.map((name) => ({
    name,
    items: BUILDER_PALETTE.filter((entry) => entry.group === name).map(
      (entry): BuilderPaletteItemModel => ({
        key: entry.key,
        kind: entry.kind,
        label: entry.label,
        source: entry.source,
        icon: entry.icon,
        iconBg: GROUP_ICON_BG[name] ?? "#2a5fe2",
      }),
    ),
  }));
}

export function buildTabs(input: {
  active: ReportsTabId;
  savedCount: number;
  templateCount: number;
  blockCount: number;
}): ReportsTabModel[] {
  return [
    { id: "mine" as const, label: "My reports", count: input.savedCount },
    { id: "templates" as const, label: "Templates", count: input.templateCount },
    { id: "builder" as const, label: "Builder", count: input.blockCount },
  ].map((tab) => ({ ...tab, active: tab.id === input.active }));
}

const CATEGORY_TONE: Record<string, readonly [string, string]> = {
  Executive: TONE.info,
  Meta: TONE.info,
  Creative: TONE.auto,
  Economics: TONE.pos,
  Channels: TONE.warn,
  Growth: TONE.pos,
};

const THUMB_TONE: Record<string, string> = {
  Executive: "#2a5fe2",
  Meta: "#2a5fe2",
  Creative: "#6C41BE",
  Economics: "#0b7954",
  Channels: "#B45309",
  Growth: "#0b7954",
};

/** Mini-preview band geometry, per block kind, exactly as the design draws it. */
const TEMPLATE_BLOCK_TONE: Record<BuilderBlockKind, readonly [string, number, string]> = {
  kpirow: ["12px", 4, "#2a5fe2"],
  kpi: ["12px", 1, "#DCE4F2"],
  line: ["22px", 2, "#DCE4F2"],
  bar: ["22px", 2, "#C9D6EE"],
  donut: ["22px", 2, "#BFE5D6"],
  funnel: ["22px", 1, "#EDF0F6"],
  table: ["18px", 4, "#EDF0F6"],
  heat: ["18px", 4, "#F6E3C9"],
  ai: ["14px", 2, "#E9DFF7"],
  text: ["12px", 2, "#EDF0F6"],
  brief: ["16px", 4, "#E3D6F5"],
};

const SOURCE_PROVIDER: Record<string, string> = {
  overview_summary: "Blended",
  overview_trend: "Blended",
  channel_attribution: "Blended",
  meta_campaigns: "Meta",
  google_campaigns: "Google",
  search_console_data: "Search Console",
  ga4_data: "GA4",
  klaviyo_data: "Klaviyo",
  shopify_data: "Shopify",
};

/**
 * Which providers a document actually reads, derived from its blocks rather
 * than declared alongside them — a stored provider list drifts the moment a
 * block is swapped, and the reader has no way to notice.
 */
export function deriveProviders(definition: CustomReportDocument): string[] {
  const seen: string[] = [];
  for (const widget of definition.widgets) {
    const provider = SOURCE_PROVIDER[widget.dataSource ?? ""];
    if (provider && !seen.includes(provider)) seen.push(provider);
  }
  return seen;
}

function countedBlocks(definition: CustomReportDocument): number {
  return definition.widgets.length;
}

export function buildSavedReports(input: {
  reports: CustomReportRecord[];
  busyReportId: string | null;
  now?: Date;
}): SavedReportModel[] {
  return input.reports.map((report) => {
    const template = CUSTOM_REPORT_TEMPLATES.find((item) => item.id === report.templateId) ?? null;
    const providers = deriveProviders(report.definition);
    const blocks = countedBlocks(report.definition);
    const updated = formatDay(report.updatedAt);
    const meta = [
      updated === DASH ? DASH : `updated ${updated}`,
      `${blocks} ${blocks === 1 ? "block" : "blocks"}`,
      providers.length > 0 ? providers.join(" + ") : DASH,
    ].join(" · ");
    return {
      id: report.id,
      name: report.name,
      // No send state is stored against a report, so none is claimed.
      status: DASH,
      statusBg: TONE.neutral[0],
      statusFg: TONE.neutral[1],
      thumbTone: THUMB_TONE[template?.category ?? ""] ?? "#2a5fe2",
      description: report.description?.trim() ? report.description.trim() : DASH,
      meta,
      busy: input.busyReportId === report.id,
    };
  });
}

function formatDay(iso: string | null | undefined): string {
  if (!iso) return DASH;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return DASH;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function buildTemplateCards(
  templates: CustomReportTemplate[] = CUSTOM_REPORT_TEMPLATES,
): ReportTemplateModel[] {
  return templates.map((template) => {
    const tone = CATEGORY_TONE[template.category] ?? TONE.info;
    const widgets = template.definition.widgets;
    // The contents list is the template's own blocks, in order. Deriving it
    // means the list can never describe a structure the template stopped
    // containing.
    const contents = widgets
      .filter((widget) => widget.type !== "section")
      .slice(0, 5)
      .map((widget, index) => ({ n: `0${index + 1}`.slice(-2), t: widget.title }));
    return {
      id: template.id,
      category: template.category,
      categoryBg: tone[0],
      categoryFg: tone[1],
      cadence: template.cadence,
      name: template.name,
      description: template.description,
      blocks: widgets.map((widget) => {
        const [height, span, background] = TEMPLATE_BLOCK_TONE[toBuilderKind(widget.type)];
        return { height, span, background };
      }),
      contents,
      meta: `${widgets.length} ${widgets.length === 1 ? "block" : "blocks"} · ${
        template.providers.length > 0 ? template.providers.join(" + ") : DASH
      }`,
    };
  });
}

export const BUILDER_DATE_RANGE_OPTIONS: BuilderSelectOptionModel[] = [
  { value: "28", label: "Last 28 days" },
  { value: "7", label: "Last 7 days" },
  { value: "this_month", label: "This month" },
  // Drawn by the design; the report document has no custom window to store,
  // so it is offered but not selectable rather than silently doing nothing.
  { value: "custom", label: "Custom range…", disabled: true },
];

export const BUILDER_METRIC_OPTIONS: BuilderSelectOptionModel[] = [
  { value: "spend", label: "Spend" },
  { value: "revenue", label: "Revenue" },
  { value: "roas", label: "ROAS" },
  { value: "purchases", label: "Orders" },
  { value: "ctr", label: "CTR" },
  { value: "cvr", label: "CVR" },
  { value: "sessions", label: "Sessions" },
];

export const BUILDER_SOURCE_OPTIONS: BuilderSelectOptionModel[] = [
  { value: "overview_summary", label: "Blended · all providers" },
  { value: "meta_campaigns", label: "Meta Ads" },
  { value: "google_campaigns", label: "Google Ads" },
  { value: "ga4_data", label: "GA4" },
  { value: "shopify_data", label: "Shopify" },
  { value: "search_console_data", label: "Search Console" },
];

export const BUILDER_BLOCK_DATE_RANGE_OPTIONS: BuilderSelectOptionModel[] = [
  { value: "report", label: "Report range" },
  { value: "7", label: "Last 7 days" },
  { value: "28", label: "Last 28 days" },
];

export const BUILDER_SCHEDULE_OPTIONS: BuilderSelectOptionModel[] = [
  { value: "manual", label: "Manual — send when I say" },
  { value: "weekly", label: "Weekly · Monday 08:00" },
  { value: "monthly", label: "Monthly · 1st, 08:00" },
];

export function buildSizeOptions(active: BuilderBlockSize | null): BuilderSizeOptionModel[] {
  return (
    [
      { size: "S" as const, label: "⅓" },
      { size: "M" as const, label: "½" },
      { size: "L" as const, label: "Full" },
    ] satisfies Array<{ size: BuilderBlockSize; label: string }>
  ).map((option) => ({ ...option, active: option.size === active }));
}

export function widthCssForSize(size: BuilderBlockSize): string {
  if (size === "L") return "100%";
  if (size === "M") return "calc(50% - 5px)";
  return "calc(33.333% - 7px)";
}

/**
 * An SVG path across the design's 100×26 viewBox.
 *
 * Returns null when fewer than two points are measured: one point is not a
 * trend, and drawing a flat line through it would assert a shape nobody
 * measured.
 */
export function buildSparkPath(points: Array<{ value: number }>): { path: string; area: string } | null {
  const values = points
    .map((point) => point.value)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  const step = 100 / (values.length - 1);
  const path = values
    .map((value, index) => {
      const x = (index * step).toFixed(1);
      // A flat series sits on the middle of the band rather than collapsing to
      // the axis, so "unchanged" does not read as "zero".
      const ratio = span === 0 ? 0.5 : (value - min) / span;
      const y = (24 - ratio * 22).toFixed(1);
      return `${index === 0 ? "M" : "L"}${x} ${y}`;
    })
    .join(" ");
  return { path, area: `${path} L100 26 L0 26 Z` };
}

const DONUT_COLORS = ["#2a5fe2", "#0b7954", "#B45309", "#C9D2E0"];

/**
 * A measured channel split expressed as the reference's conic ring plus its
 * legend. Returns null when nothing was measured, so the caller draws the
 * unmeasured ring rather than a full circle of one colour.
 *
 * Shared with the export, print and share surfaces so the ring a client
 * receives is computed once, from the same shares.
 */
export function buildDonutGeometry(
  slices: Array<{ label: string; sharePct: number }> | undefined | null,
): { gradient: string; legend: Array<{ color: string; text: string }> } | null {
  if (!slices || slices.length === 0) return null;
  let cursor = 0;
  const stops: string[] = [];
  const legend = slices.map((slice, index) => {
    const color = DONUT_COLORS[index] ?? DONUT_COLORS[DONUT_COLORS.length - 1]!;
    const start = cursor;
    cursor += slice.sharePct;
    stops.push(`${color} ${start.toFixed(2)}% ${Math.min(cursor, 100).toFixed(2)}%`);
    return { color, text: `${slice.label} ${Math.round(slice.sharePct)}%` };
  });
  if (cursor < 100) stops.push(`#C9D2E0 ${cursor.toFixed(2)}% 100%`);
  return { gradient: `conic-gradient(${stops.join(", ")})`, legend };
}

function buildDonutBody(widget: RenderedReportWidget | null): BuilderBlockBodyModel {
  const donut = buildDonutGeometry(widget?.slices);
  if (!donut) return { kind: "unavailable" };
  return { kind: "donut", gradient: donut.gradient, legend: donut.legend };
}

function buildBarBody(widget: RenderedReportWidget | null): BuilderBlockBodyModel {
  const points = (widget?.points ?? []).slice(-7);
  const values = points
    .map((point) => point.value)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (values.length === 0) return { kind: "unavailable" };
  const max = Math.max(...values, 0);
  const peak = values.lastIndexOf(max);
  return {
    kind: "bar",
    bars: values.map((value, index) => ({
      height: max > 0 ? `${Math.max(6, Math.round((value / max) * 100))}%` : "6%",
      accent: index === peak,
    })),
  };
}

/**
 * Body for one canvas block.
 *
 * `rendered` is the widget the render API actually produced. When it is
 * missing, failed, or carries no measured figures, the block reports itself
 * unavailable and the component draws an em dash inside the design's own
 * block chrome.
 */
export function buildBlockBody(
  kind: BuilderBlockKind,
  rendered: RenderedReportWidget | null,
): BuilderBlockBodyModel {
  if (rendered?.errorMessage) return { kind: "unavailable" };
  switch (kind) {
    case "kpi": {
      const value = rendered?.value?.trim();
      if (!value || value === "-") return { kind: "unavailable" };
      const delta = rendered?.deltaLabel?.trim();
      const negative = Boolean(delta && (delta.startsWith("-") || delta.startsWith("−")));
      return {
        kind: "kpi",
        value,
        delta: delta && delta !== "-" ? delta : DASH,
        deltaTone: negative ? "#E11D48" : "#0b7954",
      };
    }
    case "kpirow": {
      const metrics = rendered?.metrics ?? [];
      if (metrics.length === 0) return { kind: "unavailable" };
      return { kind: "kpirow", minis: metrics.map((metric) => ({ k: metric.label, v: metric.value })) };
    }
    case "line": {
      const spark = buildSparkPath(rendered?.points ?? []);
      if (!spark) return { kind: "unavailable" };
      return { kind: "line", path: spark.path, area: spark.area };
    }
    case "bar":
      return buildBarBody(rendered);
    case "donut":
      return buildDonutBody(rendered);
    case "table": {
      const rows = rendered?.rows ?? [];
      if (rows.length === 0) return { kind: "unavailable" };
      // Row widths track the first numeric column so the schematic reflects the
      // shape of the real table rather than a fixed decorative pattern.
      const widths = rows.slice(0, 4).map((_, index) => `${88 - index * 6}%`);
      return { kind: "table", rows: widths };
    }
    case "text":
      return { kind: "text" };
    // No renderer measures these four yet (REPORTS-37). They keep their own
    // kind so the design's inner geometry is drawn with an em dash inside it,
    // rather than collapsing to a bare dash that drops the block's shape.
    case "ai":
      return { kind: "ai" };
    case "funnel":
      return { kind: "funnel" };
    case "heat":
      return { kind: "heat" };
    case "brief":
      return { kind: "brief" };
    default:
      return { kind: "unavailable" };
  }
}

export function buildBlocks(input: {
  definition: CustomReportDocument;
  rendered: RenderedReportWidget[] | null;
  selectedUid: string | null;
  compareOn: boolean;
  rangeLabel: string;
}): BuilderBlockModel[] {
  const renderedById = new Map((input.rendered ?? []).map((widget) => [widget.id, widget]));
  return input.definition.widgets.map((widget) => {
    const kind = toBuilderKind(widget.type);
    const size = resolveWidgetSize(widget);
    const selected = input.selectedUid === widget.id;
    const provider = SOURCE_PROVIDER[widget.dataSource ?? ""] ?? DASH;
    return {
      uid: widget.id,
      title: widget.title,
      size,
      sizeLabel: size,
      widthCss: widthCssForSize(size),
      borderColor: selected ? "#2a5fe2" : "#E4E8F0",
      selected,
      kind,
      body: buildBlockBody(kind, renderedById.get(widget.id) ?? null),
      sourceNote: `${provider.toLowerCase()} · ${input.rangeLabel} · ${
        input.compareOn ? "vs previous period" : "no comparison"
      }`,
    };
  });
}

export function buildBlockInspector(input: {
  widget: CustomReportWidgetDefinition;
  compareOn: boolean;
}) {
  const kind = toBuilderKind(input.widget.type);
  return {
    mode: "block" as const,
    kindLabel: BUILDER_KIND_NAMES[kind],
    title: input.widget.title,
    metric: BUILDER_METRIC_OPTIONS.some((option) => option.value === input.widget.metricKey)
      ? (input.widget.metricKey as string)
      : BUILDER_METRIC_OPTIONS[0].value,
    metricOptions: BUILDER_METRIC_OPTIONS,
    source: BUILDER_SOURCE_OPTIONS.some((option) => option.value === input.widget.dataSource)
      ? (input.widget.dataSource as string)
      : BUILDER_SOURCE_OPTIONS[0].value,
    sourceOptions: BUILDER_SOURCE_OPTIONS,
    dateRange: "report",
    dateRangeOptions: BUILDER_BLOCK_DATE_RANGE_OPTIONS,
    // Every block resolves on the report's window; no renderer honours a
    // per-block one yet, so the control does not offer to set one.
    dateRangeDisabled: true,
    sizeOptions: buildSizeOptions(resolveWidgetSize(input.widget)),
    compareOn: input.compareOn,
    footnote: "changes apply to the page live · provenance is stamped per block on send",
  };
}

export function buildReportInspector(input: {
  clientName: string | null;
  clientOptions: Array<{ id: string; name: string }>;
}) {
  return {
    mode: "report" as const,
    client: input.clientName ?? DASH,
    clientOptions:
      input.clientOptions.length > 0
        ? input.clientOptions.map((option) => ({ value: option.id, label: option.name }))
        : [{ value: DASH, label: DASH }],
    // A report belongs to the business it was created under; there is no
    // contract for moving one, so the control reports the client rather than
    // offering to change it.
    clientDisabled: true,
    schedule: "manual",
    scheduleOptions: BUILDER_SCHEDULE_OPTIONS,
    scheduleDisabled: true,
    recipients: [{ label: DASH, removable: false }],
    recipientsDisabled: true,
    liveShareOn: false,
    liveShareDisabled: true,
    liveShareRole: "viewer role",
    hint: "Select a block on the page to edit its title, metric, source and width — or drag new blocks in from the left.",
  };
}

export const REPORTS_MINE_FOOTNOTE =
  "Scheduled reports send from reports@adsecute.com with a live share link — recipients see data as of send time, with provenance stamped per widget.";
export const REPORTS_TEMPLATES_FOOTNOTE =
  "Using a template opens it in the builder pre-filled — every block stays editable, removable and reorderable before the first send.";
export const REPORTS_EXPORT_NOTE = "every report exports as PDF · share link · CSV per table";
export const BUILDER_DROP_HINT =
  "Drop a block here — drag any block to reorder, click to configure";
export const BUILDER_PALETTE_EYEBROW = "Blocks — drag to page, or click";

export function buildCounterLabel(
  blockCount: number,
  saveState: "idle" | "saving" | "saved" | "error",
): string {
  const blocks = `${blockCount} ${blockCount === 1 ? "block" : "blocks"}`;
  if (saveState === "saving") return `${blocks} · saving…`;
  if (saveState === "error") return `${blocks} · not saved`;
  if (saveState === "saved") return `${blocks} · autosaved`;
  return blocks;
}

export function buildPageMeta(input: {
  clientName: string | null;
  rangeLabel: string | null;
}): string {
  return `${input.clientName?.trim() || DASH} · ${input.rangeLabel?.trim() || DASH} · Page 1`;
}

export function rangeLabelForPreset(preset: string): string {
  const option = BUILDER_DATE_RANGE_OPTIONS.find((item) => item.value === preset);
  if (option) return option.label;
  if (preset === "30") return "Last 30 days";
  if (preset === "90") return "Last 90 days";
  return DASH;
}
