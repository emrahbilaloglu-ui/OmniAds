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
import { REPORT_GRID_COLUMNS } from "@/lib/custom-reports";
import type { Widget } from "@/lib/zero-base/reports/builder-model";
import { sourceById } from "@/lib/zero-base/reports/report-catalog";

/** Widget type per catalog source, from the catalog's own widget grammar. */
const WIDGET_TYPE: Record<string, CustomReportWidgetDefinition["type"]> = {
  overview_summary: "metric",
  overview_trend: "trend",
  channel_attribution: "table",
  meta_campaigns: "table",
  google_campaigns: "table",
};

/**
 * Turn the builder grid into the document the routes accept.
 *
 * `slot` is derived from the grid position, because the stored document is
 * slot-based while the builder is x/y — sending x/y would produce a report
 * whose widgets all land in slot `undefined`.
 */
export function toReportDocument(input: {
  widgets: readonly Widget[];
  dateRangePreset?: CustomReportDocument["dateRangePreset"];
  compareMode?: CustomReportDocument["compareMode"];
}): CustomReportDocument {
  return {
    version: 1,
    dateRangePreset: input.dateRangePreset ?? "30",
    compareMode: input.compareMode ?? "none",
    widgets: input.widgets.map((widget) => ({
      id: widget.id,
      // Identity: the catalog ids ARE the CustomReportDataSource union.
      dataSource: widget.sourceId as CustomReportWidgetDefinition["dataSource"],
      type: WIDGET_TYPE[widget.sourceId] ?? "table",
      slot: widget.y * REPORT_GRID_COLUMNS + Math.min(widget.x, REPORT_GRID_COLUMNS - 1),
      colSpan: Math.max(1, Math.min(widget.w, REPORT_GRID_COLUMNS)),
      rowSpan: Math.max(1, widget.h),
      title: sourceById(widget.sourceId)?.label ?? widget.sourceId,
    })),
  };
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
      x: (widget.slot ?? 0) % REPORT_GRID_COLUMNS,
      y: Math.floor((widget.slot ?? 0) / REPORT_GRID_COLUMNS),
      w: widget.colSpan ?? 1,
      h: widget.rowSpan ?? 1,
    }))
    .filter((widget) => widget.sourceId);
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
  document?: CustomReportDocument;
}): CreateReportBody {
  return {
    businessId: input.businessId,
    // Required by the route. Sending none was a guaranteed 400.
    name: input.name.trim(),
    description: input.description ?? null,
    templateId: null,
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

export interface AdaptedRenderedReport {
  name: string;
  dateRangeLabel: string | null;
  currency: string | null;
  generatedAt: string | null;
  widgets: Array<{
    id: string;
    dataSource: string;
    title: string;
    type: string;
    rows: Array<Record<string, string>>;
    errorMessage: string | null;
    retryable: boolean;
  }>;
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
      widgets: report.widgets.map((widget: RenderedReportWidget & { dataSource?: string; rows?: unknown }) => ({
        id: widget.id,
        dataSource: String(widget.dataSource ?? ""),
        title: widget.title,
        type: widget.type,
        rows: Array.isArray(widget.rows) ? (widget.rows as Array<Record<string, string>>) : [],
        // Per-widget failure travels with the widget, so one failed source
        // cannot blank the page.
        errorMessage: widget.errorMessage ?? null,
        retryable: widget.retryable === true,
      })),
    },
  };
}
