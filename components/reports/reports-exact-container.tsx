"use client";

/**
 * Everything the v2 Reports screen needs from the server, and nothing it
 * draws.
 *
 * The three tabs, the builder's palette/canvas/inspector and every caption
 * live in `ReportsExact`. This module fetches the business's saved reports,
 * renders the working document through the report render API so canvas blocks
 * carry measured figures rather than seed values, autosaves edits, and hands
 * the results to the adapter.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { BusinessEmptyState } from "@/components/business/BusinessEmptyState";
import { PlanGate } from "@/components/pricing/PlanGate";
import { ReportsExact } from "@/components/reports/ReportsExact";
import {
  BUILDER_DATE_RANGE_OPTIONS,
  BUILDER_DROP_HINT,
  BUILDER_PALETTE_EYEBROW,
  REPORTS_EXPORT_NOTE,
  REPORTS_MINE_FOOTNOTE,
  REPORTS_TEMPLATES_FOOTNOTE,
  buildBlockInspector,
  buildBlocks,
  buildCounterLabel,
  buildPageMeta,
  buildPaletteGroups,
  buildReportInspector,
  buildSavedReports,
  buildTabs,
  buildTemplateCards,
  findPaletteEntry,
  rangeLabelForPreset,
  toWidgetType,
} from "@/components/reports/reports-exact-adapter";
import type {
  BuilderBlockSize,
  ReportsExactHandlers,
  ReportsExactModel,
  ReportsTabId,
} from "@/components/reports/reports-exact-model";
import { useTierZeroFreshness } from "@/components/states/useTierZeroFreshness";
import { measuredAsOf } from "@/lib/tier-zero-as-of";
import {
  CUSTOM_REPORT_TEMPLATES,
  cloneReportDefinition,
  createBlankReportDefinition,
  createCustomReportId,
  getDefaultWidgetSpan,
  resolveWidgetSize,
  widgetSizeToColSpan,
  type CustomReportDocument,
  type CustomReportRecord,
  type CustomReportDateRangePreset,
  type CustomReportWidgetDefinition,
  type RenderedReportPayload,
} from "@/lib/custom-reports";
import { useAppStore } from "@/store/app-store";

const AUTOSAVE_DELAY_MS = 1200;
const RENDER_DEBOUNCE_MS = 400;

async function fetchReports(businessId: string) {
  const response = await fetch(`/api/reports?businessId=${encodeURIComponent(businessId)}`, {
    cache: "no-store",
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error((payload as { message?: string } | null)?.message ?? "Failed to load reports.");
  }
  const body = payload as { reports: CustomReportRecord[]; generatedAt?: string | null };
  // The read's own time travels with the rows so the surface dates itself from
  // when it read, not from when someone last edited a report.
  return { reports: body.reports, generatedAt: body.generatedAt ?? null };
}

async function renderDefinition(input: {
  businessId: string;
  name: string;
  definition: CustomReportDocument;
}) {
  const response = await fetch("/api/reports/render", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error((payload as { message?: string } | null)?.message ?? "Failed to render report.");
  }
  return (payload as { report: RenderedReportPayload }).report;
}

interface BuilderState {
  reportId: string | null;
  templateId: string | null;
  name: string;
  definition: CustomReportDocument;
  selectedUid: string | null;
}

type DragPayload = { type: "new"; key: string } | { type: "move"; uid: string } | null;

function blankBuilderState(): BuilderState {
  return {
    reportId: null,
    templateId: null,
    name: "Untitled report",
    definition: createBlankReportDefinition(),
    selectedUid: null,
  };
}

function builderStateFromRecord(record: CustomReportRecord): BuilderState {
  return {
    reportId: record.id,
    templateId: record.templateId,
    name: record.name,
    definition: cloneReportDefinition(record.definition),
    selectedUid: null,
  };
}

function builderStateFromTemplate(templateId: string): BuilderState | null {
  const template = CUSTOM_REPORT_TEMPLATES.find((item) => item.id === templateId);
  if (!template) return null;
  const definition = cloneReportDefinition(template.definition);
  // Fresh ids: a template is a starting point, not a shared document, and two
  // reports seeded from one template must not collide on widget identity.
  definition.widgets = definition.widgets.map((widget, index) => ({
    ...widget,
    id: createCustomReportId(),
    slot: index,
    size: resolveWidgetSize(widget),
  }));
  return {
    reportId: null,
    templateId: template.id,
    name: template.name,
    definition,
    selectedUid: null,
  };
}

/** Only the parts of a document that change what the renderer produces. */
function renderSignature(definition: CustomReportDocument): string {
  return JSON.stringify({
    range: definition.dateRangePreset,
    compare: definition.compareMode,
    widgets: definition.widgets.map((widget) => ({
      id: widget.id,
      type: widget.type,
      dataSource: widget.dataSource,
      metricKey: widget.metricKey,
      columns: widget.columns,
      limit: widget.limit,
    })),
  });
}

export function ReportsExactContainer({
  initialTab = "mine",
  initialReportId = null,
  initialTemplateId = null,
}: {
  initialTab?: ReportsTabId;
  initialReportId?: string | null;
  initialTemplateId?: string | null;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const businesses = useAppStore((state) => state.businesses);
  const selectedBusinessId = useAppStore((state) => state.selectedBusinessId);
  const businessId = selectedBusinessId ?? "";
  const business = businesses.find((item) => item.id === selectedBusinessId) ?? null;

  const [tab, setTab] = useState<ReportsTabId>(initialTab);
  const [builder, setBuilder] = useState<BuilderState>(
    () => (initialTemplateId ? builderStateFromTemplate(initialTemplateId) : null) ?? blankBuilderState(),
  );
  const [busyReportId, setBusyReportId] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [renderSignatureKey, setRenderSignatureKey] = useState(() => renderSignature(builder.definition));
  const dragRef = useRef<DragPayload>(null);
  const dirtyRef = useRef(false);
  const hydratedReportRef = useRef<string | null>(null);

  const reportsQuery = useQuery({
    queryKey: ["custom-reports", businessId],
    enabled: Boolean(selectedBusinessId),
    queryFn: () => fetchReports(businessId),
  });

  // One freshness contract across every Tier-0 surface, derived from the query
  // state this surface already has so it cannot drift from what is on screen.
  useTierZeroFreshness({
    surface: "reports",
    isLoading: reportsQuery.isLoading,
    isFetching: reportsQuery.isFetching,
    error: reportsQuery.error,
    asOf: measuredAsOf(reportsQuery.data?.generatedAt ?? null),
    businessId: selectedBusinessId,
    onRetry: () => void reportsQuery.refetch(),
  });

  const reports = useMemo(() => reportsQuery.data?.reports ?? [], [reportsQuery.data?.reports]);

  // A deep link to one report opens the builder on it once its record arrives.
  useEffect(() => {
    if (!initialReportId || hydratedReportRef.current === initialReportId) return;
    const record = reports.find((item) => item.id === initialReportId);
    if (!record) return;
    hydratedReportRef.current = initialReportId;
    setBuilder(builderStateFromRecord(record));
    setTab("builder");
  }, [initialReportId, reports]);

  // The render call is debounced on the parts of the document that change what
  // the renderer produces, so retitling a block does not refetch every figure.
  useEffect(() => {
    const next = renderSignature(builder.definition);
    if (next === renderSignatureKey) return;
    const timer = setTimeout(() => setRenderSignatureKey(next), RENDER_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [builder.definition, renderSignatureKey]);

  const renderQuery = useQuery({
    queryKey: ["custom-report-preview", businessId, renderSignatureKey],
    enabled:
      Boolean(selectedBusinessId) && tab === "builder" && builder.definition.widgets.length > 0,
    queryFn: () =>
      renderDefinition({
        businessId,
        name: builder.name || "Untitled report",
        definition: builder.definition,
      }),
  });

  // Returns the id the document is stored under, so a caller that needs to
  // navigate to the saved report can wait for the write instead of guessing.
  const persist = useCallback(
    async (state: BuilderState): Promise<string | null> => {
      if (!businessId) return null;
      setSaveState("saving");
      try {
        const body = JSON.stringify({
          businessId,
          name: state.name.trim() || "Untitled report",
          description: null,
          templateId: state.templateId,
          definition: state.definition,
        });
        const response = state.reportId
          ? await fetch(`/api/reports/${state.reportId}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body,
            })
          : await fetch("/api/reports", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body,
            });
        if (!response.ok) {
          setSaveState("error");
          return null;
        }
        const payload = (await response.json().catch(() => null)) as {
          report?: CustomReportRecord;
        } | null;
        if (!state.reportId && payload?.report?.id) {
          const createdId = payload.report.id;
          setBuilder((current) => (current.reportId ? current : { ...current, reportId: createdId }));
        }
        setSaveState("saved");
        await queryClient.invalidateQueries({ queryKey: ["custom-reports", businessId] });
        return state.reportId ?? payload?.report?.id ?? null;
      } catch {
        setSaveState("error");
        return null;
      }
    },
    [businessId, queryClient],
  );

  // Autosave. It fires only after a real edit — mounting the builder, or
  // opening a saved report to look at it, must never write.
  useEffect(() => {
    if (!dirtyRef.current) return;
    const snapshot = builder;
    const timer = setTimeout(() => {
      dirtyRef.current = false;
      void persist(snapshot);
    }, AUTOSAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [builder, persist]);

  const mutate = useCallback((next: (current: BuilderState) => BuilderState) => {
    dirtyRef.current = true;
    setBuilder(next);
  }, []);

  const updateWidgets = useCallback(
    (
      next: (widgets: CustomReportWidgetDefinition[]) => CustomReportWidgetDefinition[],
      selectedUid?: string | null,
    ) => {
      mutate((current) => {
        const widgets = next(current.definition.widgets).map((widget, index) => ({
          ...widget,
          slot: index,
        }));
        return {
          ...current,
          definition: { ...current.definition, widgets },
          selectedUid: selectedUid === undefined ? current.selectedUid : selectedUid,
        };
      });
    },
    [mutate],
  );

  const makeWidget = useCallback((key: string): CustomReportWidgetDefinition | null => {
    const entry = findPaletteEntry(key);
    if (!entry) return null;
    const type = toWidgetType(entry.kind);
    const span = getDefaultWidgetSpan(type);
    return {
      id: createCustomReportId(),
      type,
      slot: 0,
      colSpan: widgetSizeToColSpan(entry.size),
      rowSpan: span.rowSpan,
      size: entry.size,
      title: entry.label,
      dataSource: entry.dataSource,
      metricKey: entry.metricKey,
      columns: entry.columns,
    };
  }, []);

  const insertAt = useCallback(
    (beforeUid: string | null) => {
      const drag = dragRef.current;
      dragRef.current = null;
      if (!drag) return;
      if (drag.type === "new") {
        const widget = makeWidget(drag.key);
        if (!widget) return;
        updateWidgets((widgets) => {
          const index = beforeUid ? widgets.findIndex((item) => item.id === beforeUid) : -1;
          const next = widgets.slice();
          if (index < 0) next.push(widget);
          else next.splice(index, 0, widget);
          return next;
        }, widget.id);
        return;
      }
      if (drag.uid === beforeUid) return;
      updateWidgets((widgets) => {
        const item = widgets.find((widget) => widget.id === drag.uid);
        if (!item) return widgets;
        const rest = widgets.filter((widget) => widget.id !== drag.uid);
        const index = beforeUid ? rest.findIndex((widget) => widget.id === beforeUid) : -1;
        if (index < 0) rest.push(item);
        else rest.splice(index, 0, item);
        return rest;
      }, drag.uid);
    },
    [makeWidget, updateWidgets],
  );

  const setSize = useCallback(
    (uid: string, size: BuilderBlockSize) => {
      updateWidgets((widgets) =>
        widgets.map((widget) =>
          widget.id === uid ? { ...widget, size, colSpan: widgetSizeToColSpan(size) } : widget,
        ),
      );
    },
    [updateWidgets],
  );

  const selectedWidget =
    builder.definition.widgets.find((widget) => widget.id === builder.selectedUid) ?? null;

  const handlers: ReportsExactHandlers = useMemo(
    () => ({
      onSelectTab: (next) => setTab(next),
      onNewReport: () => {
        dirtyRef.current = false;
        setSaveState("idle");
        setBuilder(blankBuilderState());
        setTab("builder");
      },
      onOpenReport: (reportId) => {
        const record = reports.find((item) => item.id === reportId);
        if (!record) return;
        dirtyRef.current = false;
        setSaveState("idle");
        setBuilder(builderStateFromRecord(record));
        setTab("builder");
      },
      onDuplicateReport: (reportId) => {
        const record = reports.find((item) => item.id === reportId);
        if (!record) return;
        setBusyReportId(reportId);
        void (async () => {
          await fetch("/api/reports", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              businessId,
              name: `${record.name} Copy`,
              description: record.description,
              templateId: record.templateId,
              definition: record.definition,
            }),
          }).catch(() => null);
          await queryClient.invalidateQueries({ queryKey: ["custom-reports", businessId] });
          setBusyReportId(null);
        })();
      },
      onShareReport: (reportId) => {
        setBusyReportId(reportId);
        void (async () => {
          try {
            const response = await fetch(`/api/reports/${reportId}/share`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ expiryDays: 7 }),
            });
            const payload = (await response.json().catch(() => null)) as { url?: string } | null;
            if (response.ok && payload?.url && typeof navigator !== "undefined") {
              await navigator.clipboard?.writeText(`${window.location.origin}${payload.url}`).catch(
                () => null,
              );
            }
          } finally {
            setBusyReportId(null);
          }
        })();
      },
      onExportReportPdf: (reportId) => {
        // The print surface is what produces the PDF; the browser's own print
        // dialog is the export. No second renderer, no second set of figures.
        if (typeof window !== "undefined") window.open(`/reports/${reportId}/print`, "_blank");
      },
      onPreviewTemplate: (templateId) => {
        const next = builderStateFromTemplate(templateId);
        if (!next) return;
        // Preview loads the structure without marking it dirty, so looking at a
        // template never creates a report.
        dirtyRef.current = false;
        setSaveState("idle");
        setBuilder(next);
        setTab("builder");
      },
      onUseTemplate: (templateId) => {
        const next = builderStateFromTemplate(templateId);
        if (!next) return;
        setSaveState("idle");
        mutate(() => next);
        setTab("builder");
      },
      onRenameReport: (name) => mutate((current) => ({ ...current, name })),
      onChangeDateRange: (value) => {
        if (!["7", "28", "this_month"].includes(value)) return;
        mutate((current) => ({
          ...current,
          definition: {
            ...current.definition,
            dateRangePreset: value as CustomReportDateRangePreset,
          },
        }));
      },
      // The reference's Preview is always live, so a report that has never been
      // written is written on the way through rather than the control being
      // disabled. Nothing is navigated to until the id actually exists.
      onPreview: () => {
        if (builder.reportId) {
          router.push(`/reports/${builder.reportId}`);
          return;
        }
        dirtyRef.current = false;
        void (async () => {
          const reportId = await persist(builder);
          if (reportId) router.push(`/reports/${reportId}`);
        })();
      },
      onSave: () => {
        dirtyRef.current = false;
        void persist(builder);
      },
      onPaletteAdd: (key) => {
        const widget = makeWidget(key);
        if (!widget) return;
        updateWidgets((widgets) => widgets.concat(widget), widget.id);
      },
      onPaletteDragStart: (key) => {
        dragRef.current = { type: "new", key };
      },
      onBlockSelect: (uid) =>
        setBuilder((current) => ({
          ...current,
          selectedUid: current.selectedUid === uid ? null : uid,
        })),
      onBlockRemove: (uid) =>
        updateWidgets(
          (widgets) => widgets.filter((widget) => widget.id !== uid),
          builder.selectedUid === uid ? null : builder.selectedUid,
        ),
      onBlockCycleSize: (uid) => {
        const widget = builder.definition.widgets.find((item) => item.id === uid);
        if (!widget) return;
        const current = resolveWidgetSize(widget);
        setSize(uid, current === "S" ? "M" : current === "M" ? "L" : "S");
      },
      onBlockDragStart: (uid) => {
        dragRef.current = { type: "move", uid };
      },
      onBlockDropOn: (uid) => insertAt(uid),
      onDropEnd: () => insertAt(null),
      onInspectorTitleChange: (value) =>
        updateWidgets((widgets) =>
          widgets.map((widget) =>
            widget.id === builder.selectedUid ? { ...widget, title: value } : widget,
          ),
        ),
      onInspectorMetricChange: (value) =>
        updateWidgets((widgets) =>
          widgets.map((widget) =>
            widget.id === builder.selectedUid ? { ...widget, metricKey: value } : widget,
          ),
        ),
      onInspectorSourceChange: (value) =>
        updateWidgets((widgets) =>
          widgets.map((widget) =>
            widget.id === builder.selectedUid
              ? { ...widget, dataSource: value as CustomReportWidgetDefinition["dataSource"] }
              : widget,
          ),
        ),
      onInspectorSizeChange: (size) => {
        if (!builder.selectedUid) return;
        setSize(builder.selectedUid, size);
      },
      onToggleCompare: () =>
        mutate((current) => ({
          ...current,
          definition: {
            ...current.definition,
            compareMode:
              current.definition.compareMode === "previous_period" ? "none" : "previous_period",
          },
        })),
      onRemoveSelected: () =>
        updateWidgets((widgets) => widgets.filter((widget) => widget.id !== builder.selectedUid), null),
    }),
    [
      builder,
      businessId,
      insertAt,
      makeWidget,
      mutate,
      persist,
      queryClient,
      reports,
      router,
      setSize,
      updateWidgets,
    ],
  );

  const rangeLabel = rangeLabelForPreset(builder.definition.dateRangePreset);
  const compareOn = builder.definition.compareMode === "previous_period";

  const model: ReportsExactModel = useMemo(
    () => ({
      eyebrow: "Growth · Client-ready output",
      title: "Reports",
      newReportLabel: "+ New report",
      tabs: buildTabs({
        active: tab,
        savedCount: reports.length,
        templateCount: CUSTOM_REPORT_TEMPLATES.length,
        blockCount: builder.definition.widgets.length,
      }),
      exportNote: REPORTS_EXPORT_NOTE,
      activeTab: tab,
      mine: {
        reports: buildSavedReports({ reports, busyReportId }),
        footnote: REPORTS_MINE_FOOTNOTE,
      },
      templates: {
        cards: buildTemplateCards(),
        footnote: REPORTS_TEMPLATES_FOOTNOTE,
      },
      builder: {
        name: builder.name,
        dateRange: builder.definition.dateRangePreset,
        dateRangeOptions: BUILDER_DATE_RANGE_OPTIONS,
        comparePillLabel: "vs previous period",
        counterLabel: buildCounterLabel(builder.definition.widgets.length, saveState),
        pageMeta: buildPageMeta({
          clientName: business?.name ?? null,
          rangeLabel:
            renderQuery.data?.startDate && renderQuery.data.endDate
              ? `${renderQuery.data.startDate} – ${renderQuery.data.endDate}`
              : rangeLabel,
        }),
        blocks: buildBlocks({
          definition: builder.definition,
          rendered: renderQuery.data?.widgets ?? null,
          selectedUid: builder.selectedUid,
          compareOn,
          rangeLabel: rangeLabel.toLowerCase(),
        }),
        palette: buildPaletteGroups(),
        paletteEyebrow: BUILDER_PALETTE_EYEBROW,
        dropHint: BUILDER_DROP_HINT,
        inspector: selectedWidget
          ? buildBlockInspector({ widget: selectedWidget, compareOn })
          : buildReportInspector({
              clientName: business?.name ?? null,
              clientOptions: businesses.map((item) => ({ id: item.id, name: item.name })),
            }),
        saveEnabled: saveState !== "saving",
        saveLabel: "Save & schedule",
      },
    }),
    [
      builder,
      business,
      businesses,
      busyReportId,
      compareOn,
      rangeLabel,
      renderQuery.data,
      reports,
      reportsQuery.error,
      reportsQuery.isLoading,
      saveState,
      selectedWidget,
      tab,
    ],
  );

  if (!selectedBusinessId) return <BusinessEmptyState />;

  return (
    <PlanGate requiredPlan="pro">
      <ReportsExact model={model} handlers={handlers} />
    </PlanGate>
  );
}

export default ReportsExactContainer;
