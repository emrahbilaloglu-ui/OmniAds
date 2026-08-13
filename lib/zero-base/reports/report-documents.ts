/**
 * Real report request and response contracts.
 *
 * A transition audit found three boundaries that could not work:
 *
 * - duplicate POSTed `{businessId, duplicateOf}`, but `POST /api/reports`
 *   requires `businessId` **and `name`** and accepts `description`,
 *   `templateId`, `definition`. `duplicateOf` is not in the contract, so every
 *   duplicate was a 400.
 * - save sent `{businessId, layout}` with no name, and `PATCH` also requires a
 *   name. A `GridState` is not a `CustomReportDocument`.
 * - the viewer read `GET /api/reports/[id]` and expected top-level `widgets`,
 *   but that route returns `{report: CustomReportRecord}` — a record, not a
 *   render. The rendered widgets come from `/render`, which returns
 *   `{report: RenderedReportPayload}`.
 *
 * The one happy accident worth stating: the catalog source ids are exactly the
 * `CustomReportDataSource` union, so source-to-dataSource is identity rather
 * than a mapping table that could drift.
 */
import type {
  CustomReportDocument,
  CustomReportWidgetDefinition,
  RenderedReportPayload,
  RenderedReportWidget,
} from "@/lib/custom-reports";
import { REPORT_GRID_COLUMNS, getDefaultWidgetSpan } from "@/lib/custom-reports";
import type { Widget } from "@/lib/zero-base/reports/builder-model";

/**
 * A complete, renderable widget definition per catalog source.
 *
 * Type alone is not enough. `overview_summary` with no `metricKey` renders as
 * "Metric unavailable for this business."; a table with no `columns` renders
 * nothing useful. These configurations are lifted from the shipped
 * `CUSTOM_REPORT_TEMPLATES`, so they are known to render rather than guessed.
 */
const SOURCE_DEFAULTS: Record<
  string,
  Omit<CustomReportWidgetDefinition, "id" | "slot" | "colSpan" | "rowSpan">
> = {
  overview_summary: { type: "metric", title: "Spend", dataSource: "overview_summary", metricKey: "spend" },
  overview_trend: {
    type: "trend",
    title: "Blended Spend Trend",
    dataSource: "overview_trend",
    metricKey: "combined.spend",
  },
  channel_attribution: {
    type: "table",
    title: "Channel Attribution",
    dataSource: "channel_attribution",
    columns: ["channel", "spend", "revenue", "roas", "conversions"],
    limit: 8,
  },
  meta_campaigns: {
    type: "table",
    title: "Top Meta Campaigns",
    dataSource: "meta_campaigns",
    columns: ["name", "status", "spend", "revenue", "purchases", "roas"],
    limit: 8,
  },
  google_campaigns: {
    type: "table",
    title: "Top Google Campaigns",
    dataSource: "google_campaigns",
    columns: ["name", "status", "spend", "revenue", "conversions", "roas"],
    limit: 8,
  },
};

/**
 * Build a renderable definition for a source the operator just added.
 *
 * Adding a source used to produce `{id, dataSource, type, slot, spans, title}`
 * and nothing else, so a freshly added metric widget rendered "Metric
 * unavailable" purely because the builder omitted its configuration.
 */
export function newWidgetDefinition(input: {
  id: string;
  sourceId: string;
  slot: number;
  colSpan?: number;
  rowSpan?: number;
}): CustomReportWidgetDefinition | null {
  const defaults = SOURCE_DEFAULTS[input.sourceId];
  if (!defaults) return null;
  const span = getDefaultWidgetSpan(defaults.type);
  return {
    id: input.id,
    slot: input.slot,
    colSpan: input.colSpan ?? span.colSpan,
    rowSpan: input.rowSpan ?? span.rowSpan,
    ...defaults,
  };
}

/**
 * Turn the builder grid into the document the routes accept.
 *
 * `slot` is derived from the grid position, because the stored document is
 * slot-based while the builder is x/y — sending x/y would produce a report
 * whose widgets all land in slot `undefined`.
 */
export function toReportDocument(input: {
  widgets: readonly Widget[];
  /**
   * The stored document this edit started from.
   *
   * Everything the builder does not model — `metricKey`, `yMetrics`,
   * `breakdown`, `accountId`, `limit`, `columns`, `tableDimension`, `axisMode`,
   * `text`, `subtitle`, and the document's own `dateRangePreset`,
   * `compareMode`, `reportPlatforms` — is carried through from here untouched.
   * Rebuilding the document from the grid alone silently destroyed all of it on
   * every save.
   */
  base?: CustomReportDocument | null;
  dateRangePreset?: CustomReportDocument["dateRangePreset"];
  compareMode?: CustomReportDocument["compareMode"];
}): CustomReportDocument {
  const stored = new Map(
    (input.base?.widgets ?? []).map((widget) => [widget.id, widget] as const),
  );

  const widgets = input.widgets.flatMap((widget) => {
    const slot = widget.y * REPORT_GRID_COLUMNS + Math.min(widget.x, REPORT_GRID_COLUMNS - 1);
    const geometry = {
      slot,
      colSpan: Math.max(1, Math.min(widget.w, REPORT_GRID_COLUMNS)),
      rowSpan: Math.max(1, widget.h),
    };
    const existing = stored.get(widget.id);
    // Only geometry is mutated. Every other stored field survives verbatim.
    if (existing) return [{ ...existing, ...geometry }];
    const created = newWidgetDefinition({ id: widget.id, sourceId: widget.sourceId, slot });
    if (!created) return [];
    return [{ ...created, ...geometry }];
  });

  return {
    version: 1,
    dateRangePreset: input.dateRangePreset ?? input.base?.dateRangePreset ?? "30",
    compareMode: input.compareMode ?? input.base?.compareMode ?? "none",
    // Preserved rather than dropped: an absent key and an empty list differ.
    ...(input.base?.reportPlatforms ? { reportPlatforms: input.base.reportPlatforms } : {}),
    widgets,
  };
}

/** Read a stored definition back, keeping the whole document for round-trip. */
export function baseDocument(document: unknown): CustomReportDocument | null {
  if (!document || typeof document !== "object") return null;
  const candidate = document as CustomReportDocument;
  return Array.isArray(candidate.widgets) ? candidate : null;
}

/** Read a stored document back into builder widgets, for edit. */
export function fromReportDocument(document: unknown): Widget[] {
  if (!document || typeof document !== "object") return [];
  const widgets = (document as { widgets?: unknown }).widgets;
  if (!Array.isArray(widgets)) return [];
  return widgets
    .filter((widget): widget is CustomReportWidgetDefinition => Boolean(widget && typeof widget === "object"))
    .map((widget) => ({
      id: widget.id,
      sourceId: String(widget.dataSource ?? ""),
      label: widget.title,
      x: (widget.slot ?? 0) % REPORT_GRID_COLUMNS,
      y: Math.floor((widget.slot ?? 0) / REPORT_GRID_COLUMNS),
      w: widget.colSpan ?? 1,
      h: widget.rowSpan ?? 1,
    }));
  // No filter: `text` and `section` widgets legitimately carry no dataSource,
  // and excluding them here deleted them from the document on the next save.
}

/** The exact body `POST /api/reports` accepts. */
export interface CreateReportBody {
  businessId: string;
  name: string;
  description?: string | null;
  templateId?: string | null;
  definition?: CustomReportDocument;
}

export function buildCreateBody(input: {
  businessId: string;
  name: string;
  description?: string | null;
  templateId?: string | null;
  document?: CustomReportDocument;
}): CreateReportBody {
  return {
    businessId: input.businessId,
    // Required by the route. Sending none was a guaranteed 400.
    name: input.name.trim(),
    description: input.description ?? null,
    templateId: input.templateId ?? null,
    ...(input.document ? { definition: input.document } : {}),
  };
}

/**
 * Duplicate is a create from the source record.
 *
 * There is no `duplicateOf` in the contract, so the caller must read the record
 * and send its definition under a new name.
 */
export function buildDuplicateBody(input: {
  businessId: string;
  source: { name?: string; description?: string | null; definition?: unknown } | null;
}): CreateReportBody | { error: string } {
  if (!input.source) {
    return { error: "The report to duplicate could not be read, so nothing was copied." };
  }
  const name = (input.source.name ?? "Report").trim();
  return {
    businessId: input.businessId,
    name: `${name} (copy)`,
    description: input.source.description ?? null,
    templateId: null,
    ...(input.source.definition
      ? { definition: input.source.definition as CustomReportDocument }
      : {}),
  };
}

/** The exact body `PATCH /api/reports/[id]` accepts. It also requires a name. */
export function buildPatchBody(input: {
  name: string;
  description?: string | null;
  document: CustomReportDocument;
}): { name: string; description: string | null; definition: CustomReportDocument } {
  return {
    name: input.name.trim(),
    description: input.description ?? null,
    definition: input.document,
  };
}

/* --------------------------------------------------------------- render */

/**
 * The rendered report, exactly as the renderer produces it.
 *
 * `widgets` is `RenderedReportWidget[]` — the real type — rather than a
 * reshaped copy. An earlier version invented a `dataSource` field on this type
 * and a fixture that supplied one; the renderer reads `dataSource` off the
 * *definition* and never emits it, so in production every widget resolved to
 * `""`: identical React keys for every card, and metric/trend/text content
 * dropped because it was all forced through a rows-only table.
 */
export interface AdaptedRenderedReport {
  name: string;
  dateRangeLabel: string | null;
  currency: string | null;
  generatedAt: string | null;
  /** Carried so a CSV export covers the window the viewer is showing. */
  startDate: string | null;
  endDate: string | null;
  widgets: RenderedReportWidget[];
}

/**
 * The exact URL `GET /api/reports/[reportId]/export` expects.
 *
 * The route resolves the widget by `widgetId`, and **falls back to the first
 * table widget when it cannot find one** — so omitting the id would silently
 * export a different widget than the operator clicked. The date parameters are
 * passed through so the file matches the window on screen; the route only
 * honours a `dateRangePreset` of 7, 30 or 90, so anything else is left out
 * rather than sent and ignored.
 */
export function exportWidgetCsvUrl(input: {
  reportId: string;
  widgetId: string;
  startDate?: string | null;
  endDate?: string | null;
  dateRangePreset?: string | null;
}): string {
  const params = new URLSearchParams({ widgetId: input.widgetId });
  if (input.startDate) params.set("startDate", input.startDate);
  if (input.endDate) params.set("endDate", input.endDate);
  if (input.dateRangePreset === "7" || input.dateRangePreset === "30" || input.dateRangePreset === "90") {
    params.set("dateRangePreset", input.dateRangePreset);
  }
  return `/api/reports/${encodeURIComponent(input.reportId)}/export?${params.toString()}`;
}

/**
 * Would the export route accept this widget?
 *
 * It answers 400 `table_widget_required` unless the widget is a table **with
 * rows**. Offering an enabled control that can only 400 is the same dead
 * affordance in a different place.
 */
export function widgetIsExportable(widget: RenderedReportWidget): { ok: true } | { ok: false; reason: string } {
  if (widget.type !== "table") {
    return { ok: false, reason: "Only table widgets can be exported; this one is not a table." };
  }
  if (!widget.rows?.length) {
    return { ok: false, reason: "This table served no rows, so there is nothing to export." };
  }
  return { ok: true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/**
 * Adapt `GET /api/reports/[id]/render`, which returns
 * `{report: RenderedReportPayload}`.
 *
 * A body without that nesting is refused rather than rendered as an empty
 * report — silently showing nothing is how a failed render looked like a report
 * with no widgets.
 */
export function adaptRenderedReport(raw: unknown): { ok: true; value: AdaptedRenderedReport } | { ok: false; reason: string } {
  if (!isRecord(raw) || !isRecord(raw.report)) {
    return {
      ok: false,
      reason: "The render response did not carry a report payload, so nothing can be shown for it.",
    };
  }
  const report = raw.report as unknown as RenderedReportPayload;
  if (!Array.isArray(report.widgets)) {
    return { ok: false, reason: "The rendered report carried no widgets array." };
  }
  return {
    ok: true,
    value: {
      name: report.name ?? "Report",
      dateRangeLabel: report.dateRangeLabel ?? null,
      currency: report.currency ?? null,
      generatedAt: report.generatedAt ?? null,
      startDate: report.startDate ?? null,
      endDate: report.endDate ?? null,
      // Passed through whole. Every field the renderer emits — value,
      // deltaLabel, points, series, rows, columns, text, emptyMessage, warning,
      // errorMessage, retryable, axisMode — reaches the view, because the view
      // is what decides which of them this widget type needs.
      widgets: report.widgets,
    },
  };
}
