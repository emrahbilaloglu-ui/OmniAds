"use client";

import React, { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { BarChart3, LayoutPanelTop, Table2, TextCursorInput, ChevronDown, Download, Share2, Hash, LineChart, AlignLeft, Minus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  clampWidgetSpan,
  cloneReportDefinition,
  createCustomReportId,
  createBlankReportDefinition,
  CUSTOM_REPORT_TEMPLATES,
  ensureReportDefinition,
  getDefaultWidgetSpan,
  REPORT_SHARE_EXPIRY_OPTIONS,
  type CustomReportDocument,
  type CustomReportPlatform,
  type CustomReportRecord,
  type CustomReportTemplate,
  type CustomReportWidgetDefinition,
  type CustomReportWidgetType,
  type RenderedReportPayload,
  REPORT_GRID_COLUMNS,
  REPORT_GRID_SLOT_COUNT,
  type RenderedReportWidget,
} from "@/lib/custom-reports";
import {
  getBreakdownOptionsForPlatform,
  getDataSourceForPlatform,
  getDefaultMetricForPlatform,
  getMetricOptionsForPlatform,
  getReportPlatformLogo,
  getSupportedPlatformsForWidget,
  REPORT_PLATFORM_CATALOG,
  resolveWidgetPlatform,
  getTableDimensionsForPlatform,
  getTableMetricOptionsForPlatform,
} from "@/lib/report-metric-catalog";
import { ReportWidgetCard } from "@/components/reports/report-canvas";
import { TemplateMiniPreview } from "@/components/reports/template-mini-preview";
import { usePreferencesStore } from "@/store/preferences-store";

const WIDGET_LIBRARY: Array<{
  type: CustomReportWidgetType;
  label: string;
  eyebrow: string;
  detail: string;
}> = [
  { type: "metric", label: "Metric", eyebrow: "KPI", detail: "Single number with context" },
  { type: "trend", label: "Line Chart", eyebrow: "Trend", detail: "Show movement over time" },
  { type: "bar", label: "Bar Chart", eyebrow: "Compare", detail: "Highlight ranked values" },
  { type: "table", label: "Table", eyebrow: "Rows", detail: "Detailed campaign breakdown" },
  { type: "text", label: "Text", eyebrow: "Notes", detail: "Narrative and commentary" },
  { type: "section", label: "Section", eyebrow: "Structure", detail: "Create a visual chapter" },
];

const WIDGET_ICONS: Record<CustomReportWidgetType, React.ReactNode> = {
  metric: <Hash className="h-5 w-5" />,
  trend: <LineChart className="h-5 w-5" />,
  bar: <BarChart3 className="h-5 w-5" />,
  table: <Table2 className="h-5 w-5" />,
  text: <AlignLeft className="h-5 w-5" />,
  section: <Minus className="h-5 w-5" />,
};



function WidgetLibraryPreview({ type }: { type: CustomReportWidgetType }) {
  if (type === "metric") {
    return (
      <div className="rounded-xl border border-neutral-200 bg-white px-3 py-3">
        <div className="text-[12px] font-semibold uppercase tracking-[0.18em] text-neutral-400">KPI</div>
        <div className="mt-2 text-lg font-semibold leading-none text-neutral-950">$12.4K</div>
        <div className="mt-2 inline-flex rounded-full bg-emerald-50 px-2 py-1 text-[12px] font-medium text-emerald-700">
          +12.4%
        </div>
      </div>
    );
  }

  if (type === "trend") {
    return (
      <div className="rounded-xl border border-neutral-200 bg-white px-3 py-3">
        <div className="flex h-12 items-end gap-1">
          {[20, 28, 24, 36, 30, 41].map((point, index) => (
            <div key={index} className="relative flex-1">
              {index > 0 ? (
                <div
                  className="absolute -left-1/2 top-1/2 h-[2px] w-full -translate-y-1/2 rounded-full bg-blue-500"
                  style={{ transform: `translateY(${18 - point / 3}px) rotate(${index % 2 === 0 ? "-8deg" : "8deg"})` }}
                />
              ) : null}
              <div
                className="mx-auto h-1.5 w-1.5 rounded-full bg-blue-600"
                style={{ marginTop: `${44 - point}px` }}
              />
            </div>
          ))}
        </div>
        <div className="mt-3 flex justify-between text-[12px] text-neutral-400">
          <span>Mar</span>
          <span>Apr</span>
          <span>May</span>
        </div>
      </div>
    );
  }

  if (type === "bar") {
    return (
      <div className="rounded-xl border border-neutral-200 bg-white px-3 py-3">
        <div className="flex h-12 items-end gap-2">
          {[38, 26, 44, 31].map((height, index) => (
            <div key={index} className="flex-1 rounded-t-xl bg-[linear-gradient(180deg,#60a5fa,#2563eb)]" style={{ height }} />
          ))}
        </div>
        <div className="mt-3 flex items-center gap-2 text-[12px] text-neutral-400">
          <BarChart3 className="h-3.5 w-3.5" />
          <span>Ranked comparison</span>
        </div>
      </div>
    );
  }

  if (type === "table") {
    return (
      <div className="rounded-xl border border-neutral-200 bg-white px-3 py-3">
        <div className="grid grid-cols-3 gap-1">
          {Array.from({ length: 9 }).map((_, index) => (
            <div
              key={index}
              className={`h-3 rounded-md ${index < 3 ? "bg-neutral-200" : "bg-neutral-100"}`}
            />
          ))}
        </div>
        <div className="mt-3 flex items-center gap-2 text-[12px] text-neutral-400">
          <Table2 className="h-3.5 w-3.5" />
          <span>Detailed rows</span>
        </div>
      </div>
    );
  }

  if (type === "text") {
    return (
      <div className="rounded-xl border border-neutral-200 bg-white px-3 py-3">
        <div className="space-y-2">
          <div className="h-2 rounded-full bg-neutral-200" />
          <div className="h-2 w-5/6 rounded-full bg-neutral-200" />
          <div className="h-2 w-2/3 rounded-full bg-neutral-100" />
        </div>
        <div className="mt-3 flex items-center gap-2 text-[12px] text-neutral-400">
          <TextCursorInput className="h-3.5 w-3.5" />
          <span>Narrative block</span>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-neutral-200 bg-white px-3 py-3">
      <div className="rounded-xl border border-dashed border-neutral-300 bg-neutral-50 px-3 py-4 text-center">
        <LayoutPanelTop className="mx-auto h-5 w-5 text-neutral-500" />
        <div className="mt-2 text-[12px] font-medium text-neutral-500">Section divider</div>
      </div>
    </div>
  );
}

function PlatformLogoStack({ channels }: { channels: Array<CustomReportPlatform> }) {
  return (
    <span className="flex items-center">
      {channels.map((channel, index) => {
        const logo = getReportPlatformLogo(channel);
        if (!logo) return null;
        return (
          <span
            key={channel}
            className={`inline-flex h-5 w-5 items-center justify-center overflow-hidden ${
              index > 0 ? "-ml-1.5" : ""
            }`}
          >
            <Image
              src={logo}
              alt={channel}
              width={12}
              height={12}
              className="h-4 w-4 object-contain"
            />
          </span>
        );
      })}
    </span>
  );
}

function getMetricOptionsForWidget(widget: CustomReportWidgetDefinition | null) {
  if (!widget) return [];
  return getMetricOptionsForPlatform(resolveWidgetPlatform(widget), widget.type);
}

const REPORT_GRID_ROWS = Math.ceil(REPORT_GRID_SLOT_COUNT / REPORT_GRID_COLUMNS);

function getWidgetPlacement(widget: Pick<CustomReportWidgetDefinition, "slot" | "colSpan" | "rowSpan">) {
  const colStart = widget.slot % REPORT_GRID_COLUMNS;
  const rowStart = Math.floor(widget.slot / REPORT_GRID_COLUMNS);
  return {
    colStart,
    colEnd: colStart + widget.colSpan - 1,
    rowStart,
    rowEnd: rowStart + widget.rowSpan - 1,
  };
}

function widgetFitsGrid(widget: Pick<CustomReportWidgetDefinition, "slot" | "colSpan" | "rowSpan">) {
  const placement = getWidgetPlacement(widget);
  return placement.colEnd < REPORT_GRID_COLUMNS;
}

function widgetsOverlap(
  left: Pick<CustomReportWidgetDefinition, "slot" | "colSpan" | "rowSpan">,
  right: Pick<CustomReportWidgetDefinition, "slot" | "colSpan" | "rowSpan">
) {
  const a = getWidgetPlacement(left);
  const b = getWidgetPlacement(right);
  return !(a.colEnd < b.colStart || b.colEnd < a.colStart || a.rowEnd < b.rowStart || b.rowEnd < a.rowStart);
}

function getCoveredSlots(widget: Pick<CustomReportWidgetDefinition, "slot" | "colSpan" | "rowSpan">) {
  const placement = getWidgetPlacement(widget);
  const slots: number[] = [];
  for (let row = placement.rowStart; row <= placement.rowEnd; row += 1) {
    for (let col = placement.colStart; col <= placement.colEnd; col += 1) {
      slots.push(row * REPORT_GRID_COLUMNS + col);
    }
  }
  return slots;
}

function canPlaceWidget(
  widgets: CustomReportWidgetDefinition[],
  candidate: CustomReportWidgetDefinition,
  ignoreWidgetId?: string
) {
  if (!widgetFitsGrid(candidate)) return false;
  return widgets.every((widget) => {
    if (widget.id === ignoreWidgetId) return true;
    return !widgetsOverlap(widget, candidate);
  });
}

function toPlacementCandidate(
  widget: Pick<
    CustomReportWidgetDefinition,
    | "colSpan"
    | "rowSpan"
    | "type"
    | "title"
  | "subtitle"
  | "dataSource"
  | "accountId"
  | "metricKey"
  | "yMetrics"
  | "breakdown"
    | "text"
    | "platform"
    | "limit"
    | "columns"
  >
): Omit<CustomReportWidgetDefinition, "id" | "slot"> {
  return {
    colSpan: widget.colSpan,
    rowSpan: widget.rowSpan,
    type: widget.type,
    title: widget.title,
    subtitle: widget.subtitle,
    dataSource: widget.dataSource,
    accountId: widget.accountId,
    metricKey: widget.metricKey,
    yMetrics: widget.yMetrics,
    breakdown: widget.breakdown,
    text: widget.text,
    platform: widget.platform,
    limit: widget.limit,
    columns: widget.columns,
  };
}

function findAvailableSlot(
  widgets: CustomReportWidgetDefinition[],
  candidate: Omit<CustomReportWidgetDefinition, "id" | "slot">,
  preferredSlot: number
) {
  const orderedSlots = Array.from({ length: REPORT_GRID_SLOT_COUNT }, (_, slot) => slot).sort((left, right) => {
    const leftDistance = Math.abs(left - preferredSlot);
    const rightDistance = Math.abs(right - preferredSlot);
    if (leftDistance !== rightDistance) return leftDistance - rightDistance;
    return left - right;
  });
  for (const slot of orderedSlots) {
    const nextWidget = { id: "__candidate__", slot, ...candidate };
    if (canPlaceWidget(widgets, nextWidget)) return slot;
  }
  return null;
}

function createWidgetForType(type: CustomReportWidgetType, slot: number): CustomReportWidgetDefinition {
  const span = getDefaultWidgetSpan(type);
  const defaultPlatform: CustomReportPlatform = "all";
  return {
    id: createCustomReportId(),
    slot,
    colSpan: span.colSpan,
    rowSpan: span.rowSpan,
    type,
    title:
      type === "metric"
        ? "New Metric"
        : type === "trend"
          ? "Trend Widget"
            : type === "bar"
              ? "Comparison Widget"
            : type === "table"
              ? "Table Widget"
              : type === "section"
                ? "Section Title"
                : "Commentary",
    dataSource:
      type === "text" || type === "section"
        ? undefined
        : getDataSourceForPlatform(defaultPlatform, type),
    accountId: undefined,
    metricKey:
      type === "table" || type === "text" || type === "section"
        ? undefined
        : getDefaultMetricForPlatform(defaultPlatform, type),
    yMetrics:
      type === "trend" || type === "bar"
        ? ["combined.spend"]
        : undefined,
    breakdown:
      type === "trend" || type === "bar"
        ? "day"
        : undefined,
    columns:
      type === "table"
        ? []
        : undefined,
    tableDimension:
      type === "table"
        ? "campaign"
        : undefined,
    text:
      type === "text"
        ? "Write a short narrative, insight, or next step."
        : type === "section"
          ? ""
          : undefined,
    limit: type === "table" ? 8 : undefined,
  };
}

function getWidgetPreviewSummary(widget: RenderedReportWidget | undefined) {
  if (!widget) return null;
  if (widget.type === "metric") {
    return {
      primary: widget.value ?? "-",
      secondary: widget.deltaLabel ?? widget.emptyMessage ?? null,
    };
  }
  if (widget.type === "trend" || widget.type === "bar") {
    return {
      primary: widget.series?.length ? `${widget.series.length} metrics` : widget.points?.length ? `${widget.points.length} points` : "No points yet",
      secondary:
        widget.points && widget.points.length > 0
          ? `${widget.points[0]?.label} to ${widget.points[widget.points.length - 1]?.label}`
          : widget.emptyMessage ?? null,
    };
  }
  if (widget.type === "table") {
    return {
      primary: widget.rows?.length ? `${widget.rows.length} rows` : "No rows yet",
      secondary: widget.columns?.length ? widget.columns.slice(0, 3).join(" • ") : widget.emptyMessage ?? null,
    };
  }
  if (widget.type === "text" || widget.type === "section") {
    return {
      primary: widget.text?.trim() ? widget.text.trim().slice(0, 72) : "No content yet",
      secondary: null,
    };
  }
  return null;
}

export function ReportBuilder({
  businessId,
  initialRecord,
  initialTemplateId,
}: {
  businessId: string;
  initialRecord?: CustomReportRecord | null;
  initialTemplateId?: string | null;
}) {
  const language = usePreferencesStore((state) => state.language);
  const tr = (english: string, turkish: string) => (language === "tr" ? turkish : english);
  const router = useRouter();
  const initialTemplate = CUSTOM_REPORT_TEMPLATES.find((item) => item.id === initialTemplateId) ?? null;
  const isBlankBuilder = !initialRecord && !initialTemplate;
  const startingDefinition = initialRecord?.definition
    ? ensureReportDefinition(initialRecord.definition)
    : initialTemplate
      ? cloneReportDefinition(initialTemplate.definition)
      : createBlankReportDefinition();

  const [name, setName] = useState(initialRecord?.name ?? initialTemplate?.name ?? tr("Untitled Report", "Adsiz Rapor"));
  const [description, setDescription] = useState(initialRecord?.description ?? initialTemplate?.description ?? "");
  const [templateId, setTemplateId] = useState<string | null>(initialRecord?.templateId ?? initialTemplate?.id ?? null);
  const [definition, setDefinition] = useState<CustomReportDocument>(startingDefinition);
  const [selectedSlot, setSelectedSlot] = useState<number | null>(startingDefinition.widgets[0]?.slot ?? null);
  const [selectedWidgetId, setSelectedWidgetId] = useState<string | null>(
    startingDefinition.widgets[0]?.id ?? null
  );
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [savedReportId, setSavedReportId] = useState<string | null>(initialRecord?.id ?? null);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [toolbarMessage, setToolbarMessage] = useState<string | null>(null);
  const [draggedWidgetId, setDraggedWidgetId] = useState<string | null>(null);
  const [draggedWidgetType, setDraggedWidgetType] = useState<CustomReportWidgetType | null>(null);
  const [hoveredSlot, setHoveredSlot] = useState<number | null>(null);
  const [templateFilter, setTemplateFilter] = useState<string>("All");
  const [shareExpiryDays, setShareExpiryDays] = useState<number>(7);
  const [actionsMenuOpen, setActionsMenuOpen] = useState(false);
  const actionsMenuRef = useRef<HTMLDivElement | null>(null);
  const [metricSearch, setMetricSearch] = useState("");
  const [metricMenuOpen, setMetricMenuOpen] = useState(false);
  const [openMetricRowIndex, setOpenMetricRowIndex] = useState<number | null>(null);
  const [breakdownMenuOpen, setBreakdownMenuOpen] = useState(false);
  const [breakdownSearch, setBreakdownSearch] = useState("");
  const [columnSearch, setColumnSearch] = useState("");
  const [columnMenuOpen, setColumnMenuOpen] = useState(false);
  const [activeResize, setActiveResize] = useState<{
    widgetId: string;
    mode: "col" | "row" | "both";
    startX: number;
    startY: number;
    originColSpan: number;
    originRowSpan: number;
  } | null>(null);
  const canvasOverlayRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const nextTemplate = CUSTOM_REPORT_TEMPLATES.find((item) => item.id === initialTemplateId) ?? null;
    const nextDefinition = initialRecord?.definition
      ? ensureReportDefinition(initialRecord.definition)
      : nextTemplate
        ? cloneReportDefinition(nextTemplate.definition)
        : createBlankReportDefinition();
    setName(initialRecord?.name ?? nextTemplate?.name ?? tr("Untitled Report", "Adsiz Rapor"));
    setDescription(initialRecord?.description ?? nextTemplate?.description ?? "");
    setTemplateId(initialRecord?.templateId ?? nextTemplate?.id ?? null);
    setDefinition(nextDefinition);
    setSelectedWidgetId(nextDefinition.widgets[0]?.id ?? null);
    setSelectedSlot(nextDefinition.widgets[0]?.slot ?? null);
    setMetricSearch("");
    setColumnSearch("");
    setMetricMenuOpen(false);
    setColumnMenuOpen(false);
    setDraggedWidgetType(null);
  }, [initialRecord, initialTemplateId]);

  useEffect(() => {
    setMetricMenuOpen(false);
    setMetricSearch("");
    setColumnMenuOpen(false);
    setColumnSearch("");
  }, [selectedWidgetId]);


  useEffect(() => {
    if (!actionsMenuOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (actionsMenuRef.current && !actionsMenuRef.current.contains(e.target as Node)) {
        setActionsMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [actionsMenuOpen]);

  const deferredDefinition = useDeferredValue(definition);
  const deferredName = useDeferredValue(name);
  const deferredDescription = useDeferredValue(description);
  const shouldRenderPreview = Boolean(businessId) && deferredDefinition.widgets.length > 0;
  const previewKey = JSON.stringify({
    businessId,
    definition: deferredDefinition,
    name: deferredName,
    description: deferredDescription,
  });
  const previewQuery = useQuery({
    queryKey: ["custom-report-preview", businessId, previewKey],
    enabled: shouldRenderPreview,
    queryFn: async () => {
      const response = await fetch("/api/reports/render", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId,
          name: deferredName,
          description: deferredDescription,
          definition: deferredDefinition,
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error((payload as { message?: string } | null)?.message ?? tr("Preview failed.", "Onizleme başarısız oldu."));
      }
      return (payload as { report: RenderedReportPayload }).report;
    },
  });

  const selectedWidget = useMemo(
    () => definition.widgets.find((widget) => widget.id === selectedWidgetId) ?? null,
    [definition.widgets, selectedWidgetId]
  );
  const selectedWidgetChannel: CustomReportPlatform = selectedWidget ? resolveWidgetPlatform(selectedWidget) : "all";
  const selectedMetricOptions = useMemo(() => {
    const query = metricSearch.trim().toLowerCase();
    const options = getMetricOptionsForWidget(selectedWidget);
    if (!query) return options;
    return options.filter(
      (metric) =>
        metric.label.toLowerCase().includes(query) ||
        metric.value.toLowerCase().includes(query)
    );
  }, [metricSearch, selectedWidget]);
  const tableWidgets = useMemo(
    () => (previewQuery.data?.widgets ?? []).filter((widget) => widget.type === "table"),
    [previewQuery.data]
  );
  const renderedWidgetsById = useMemo(() => {
    return new Map((previewQuery.data?.widgets ?? []).map((widget) => [widget.id, widget]));
  }, [previewQuery.data]);
  const occupiedSlots = useMemo(() => {
    const covered = new Set<number>();
    for (const widget of definition.widgets) {
      for (const slot of getCoveredSlots(widget)) {
        covered.add(slot);
      }
    }
    return covered;
  }, [definition.widgets]);
  const templateCategories = useMemo(
    () => ["All", ...Array.from(new Set(CUSTOM_REPORT_TEMPLATES.map((template) => template.category)))],
    []
  );
  const filteredTemplates = useMemo(
    () =>
      templateFilter === "All"
        ? CUSTOM_REPORT_TEMPLATES
        : CUSTOM_REPORT_TEMPLATES.filter((template) => template.category === templateFilter),
    [templateFilter]
  );

  const addWidget = (type: CustomReportWidgetType, preferredSlot = selectedSlot ?? 0) => {
    const draftWidget = createWidgetForType(type, preferredSlot);
    const nextSlot = findAvailableSlot(definition.widgets, toPlacementCandidate(draftWidget), preferredSlot);
    if (nextSlot === null) {
      setToolbarMessage("No space left for this widget size. Resize or remove another widget first.");
      return;
    }
    const widget = { ...draftWidget, slot: nextSlot };
    setDefinition((current) => ({
      ...current,
      widgets: [...current.widgets, widget].sort((a, b) => a.slot - b.slot),
    }));
    setSelectedWidgetId(widget.id);
    setSelectedSlot(nextSlot);
    setToolbarMessage(`${widget.title} added to the canvas.`);
  };

  const duplicateWidget = (widgetId: string) => {
    const currentWidget = definition.widgets.find((widget) => widget.id === widgetId);
    if (!currentWidget) return;
    const nextSlot = findAvailableSlot(
      definition.widgets,
      toPlacementCandidate(currentWidget),
      Math.min(currentWidget.slot + 1, REPORT_GRID_SLOT_COUNT - 1)
    );
    if (nextSlot === null) {
      setToolbarMessage("No room to duplicate this widget with its current size.");
      return;
    }
    const duplicate: CustomReportWidgetDefinition = {
      ...currentWidget,
      id: createCustomReportId(),
      slot: nextSlot,
      title: `${currentWidget.title} Copy`,
    };
    setDefinition((current) => ({
      ...current,
      widgets: [...current.widgets, duplicate].sort((a, b) => a.slot - b.slot),
    }));
    setSelectedWidgetId(duplicate.id);
    setSelectedSlot(duplicate.slot);
    setToolbarMessage("Widget duplicated.");
  };

  const updateWidget = (widgetId: string, patch: Partial<CustomReportWidgetDefinition>) => {
    const currentWidget = definition.widgets.find((widget) => widget.id === widgetId);
    if (!currentWidget) return;
    const nextType = patch.type ?? currentWidget.type;
    const nextSpan =
      patch.colSpan || patch.rowSpan || patch.type
        ? clampWidgetSpan({
            type: nextType,
            colSpan: patch.colSpan ?? currentWidget.colSpan,
            rowSpan: patch.rowSpan ?? currentWidget.rowSpan,
          })
        : { colSpan: currentWidget.colSpan, rowSpan: currentWidget.rowSpan };
    const candidate: CustomReportWidgetDefinition = {
      ...currentWidget,
      ...patch,
      type: nextType,
      colSpan: nextSpan.colSpan,
      rowSpan: nextSpan.rowSpan,
    };
    if (!canPlaceWidget(definition.widgets, candidate, widgetId)) {
      const remainingWidgets = definition.widgets.filter((widget) => widget.id !== widgetId);
      const fallbackSlot = findAvailableSlot(remainingWidgets, toPlacementCandidate(candidate), candidate.slot);
      if (fallbackSlot === null) {
        setToolbarMessage("That resize would overlap another widget or exceed the canvas.");
        return;
      }
      candidate.slot = fallbackSlot;
      setToolbarMessage("Widget resized and snapped to the nearest available slot.");
    } else {
      setToolbarMessage(null);
    }
    setDefinition((current) => ({
      ...current,
      widgets: current.widgets.map((widget) => (widget.id === widgetId ? candidate : widget)),
    }));
    setSelectedSlot(candidate.slot);
  };

  useEffect(() => {
    if (!activeResize) return;

    const handlePointerMove = (event: MouseEvent) => {
      const currentWidget = definition.widgets.find((widget) => widget.id === activeResize.widgetId);
      const canvas = canvasOverlayRef.current;
      if (!currentWidget || !canvas) return;
      const rect = canvas.getBoundingClientRect();
      const styles = window.getComputedStyle(canvas);
      const columnGap = Number.parseFloat(styles.columnGap || "12") || 12;
      const rowGap = Number.parseFloat(styles.rowGap || styles.gap || "12") || 12;
      const columnWidth = (rect.width - columnGap * (REPORT_GRID_COLUMNS - 1)) / REPORT_GRID_COLUMNS;
      const rowHeight = 140;
      const colDelta =
        activeResize.mode === "row"
          ? 0
          : Math.round((event.clientX - activeResize.startX) / Math.max(columnWidth + columnGap, 1));
      const rowDelta =
        activeResize.mode === "col"
          ? 0
          : Math.round((event.clientY - activeResize.startY) / Math.max(rowHeight + rowGap, 1));

      const nextColSpan = Math.max(1, Math.min(REPORT_GRID_COLUMNS, activeResize.originColSpan + colDelta));
      const nextRowSpan = Math.max(1, activeResize.originRowSpan + rowDelta);

      if (nextColSpan === currentWidget.colSpan && nextRowSpan === currentWidget.rowSpan) return;
      updateWidget(activeResize.widgetId, {
        colSpan: nextColSpan,
        rowSpan: nextRowSpan,
      });
    };

    const handlePointerUp = () => setActiveResize(null);

    window.addEventListener("mousemove", handlePointerMove);
    window.addEventListener("mouseup", handlePointerUp);
    return () => {
      window.removeEventListener("mousemove", handlePointerMove);
      window.removeEventListener("mouseup", handlePointerUp);
    };
  }, [activeResize, definition.widgets]);

  const removeWidget = (widgetId: string) => {
    const removedWidget = definition.widgets.find((widget) => widget.id === widgetId);
    setDefinition((current) => ({
      ...current,
      widgets: current.widgets.filter((widget) => widget.id !== widgetId),
    }));
    setSelectedWidgetId(null);
    setSelectedSlot(removedWidget?.slot ?? selectedSlot);
  };

  const applyTemplate = (template: CustomReportTemplate) => {
    setTemplateId(template.id);
    setName(template.name);
    setDescription(template.description);
    setDefinition(cloneReportDefinition(template.definition));
    setSelectedWidgetId(template.definition.widgets[0]?.id ?? null);
    setSelectedSlot(template.definition.widgets[0]?.slot ?? null);
  };

  const moveWidgetToSlot = (widgetId: string, nextSlot: number) => {
    const currentWidget = definition.widgets.find((widget) => widget.id === widgetId);
    if (!currentWidget) return;
    const candidate = { ...currentWidget, slot: nextSlot };
    if (!canPlaceWidget(definition.widgets, candidate, widgetId)) {
      const remainingWidgets = definition.widgets.filter((widget) => widget.id !== widgetId);
      const fallbackSlot = findAvailableSlot(remainingWidgets, toPlacementCandidate(candidate), nextSlot);
      if (fallbackSlot === null) {
        setToolbarMessage("That slot is already occupied by another widget's layout.");
        return;
      }
      candidate.slot = fallbackSlot;
      setToolbarMessage("Widget snapped to the nearest available slot.");
    } else {
      setToolbarMessage(null);
    }
    setDefinition((current) => ({
      ...current,
      widgets: current.widgets.map((widget) => (widget.id === widgetId ? candidate : widget)),
    }));
    setSelectedSlot(candidate.slot);
    setSelectedWidgetId(widgetId);
  };

  const canvasWidgets = useMemo(
    () => [...definition.widgets].sort((a, b) => a.slot - b.slot),
    [definition.widgets]
  );
  const dragPreview = useMemo(() => {
    if (hoveredSlot === null) return null;

    if (draggedWidgetType) {
      const previewWidget = createWidgetForType(draggedWidgetType, hoveredSlot);
      const resolvedSlot = findAvailableSlot(
        definition.widgets,
        toPlacementCandidate(previewWidget),
        hoveredSlot
      );
      if (resolvedSlot === null) return null;
      return {
        ...previewWidget,
        slot: resolvedSlot,
        requestedSlot: hoveredSlot,
        snapped: resolvedSlot !== hoveredSlot,
        mode: "create" as const,
      };
    }

    if (!draggedWidgetId) return null;
    const draggedWidget = definition.widgets.find((widget) => widget.id === draggedWidgetId);
    if (!draggedWidget) return null;
    const remainingWidgets = definition.widgets.filter((widget) => widget.id !== draggedWidgetId);
    const resolvedSlot = findAvailableSlot(remainingWidgets, toPlacementCandidate(draggedWidget), hoveredSlot);
    if (resolvedSlot === null) return null;
    return {
      ...draggedWidget,
      slot: resolvedSlot,
      requestedSlot: hoveredSlot,
      snapped: resolvedSlot !== hoveredSlot,
      mode: "move" as const,
    };
  }, [definition.widgets, draggedWidgetId, draggedWidgetType, hoveredSlot]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!selectedWidget) {
        if (event.key === "Escape") {
          setSelectedSlot(null);
        }
        return;
      }

      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable)
      ) {
        return;
      }

      if (event.key === "Backspace" || event.key === "Delete") {
        event.preventDefault();
        removeWidget(selectedWidget.id);
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "d") {
        event.preventDefault();
        duplicateWidget(selectedWidget.id);
      } else if (event.shiftKey && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
        event.preventDefault();
        const col = selectedWidget.slot % REPORT_GRID_COLUMNS;
        const row = Math.floor(selectedWidget.slot / REPORT_GRID_COLUMNS);
        const nextSlot =
          event.key === "ArrowLeft"
            ? col > 0
              ? selectedWidget.slot - 1
              : selectedWidget.slot
            : event.key === "ArrowRight"
              ? col < REPORT_GRID_COLUMNS - 1
                ? selectedWidget.slot + 1
                : selectedWidget.slot
              : event.key === "ArrowUp"
                ? row > 0
                  ? selectedWidget.slot - REPORT_GRID_COLUMNS
                  : selectedWidget.slot
                : row < REPORT_GRID_ROWS - 1
                  ? selectedWidget.slot + REPORT_GRID_COLUMNS
                  : selectedWidget.slot;
        if (nextSlot !== selectedWidget.slot) {
          moveWidgetToSlot(selectedWidget.id, nextSlot);
        }
      } else if (event.key === "Escape") {
        event.preventDefault();
        setSelectedWidgetId(null);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedWidget, selectedSlot, definition.widgets]);

  const getCanvasWidgetStyle = (widget: CustomReportWidgetDefinition) => {
    const colStart = (widget.slot % REPORT_GRID_COLUMNS) + 1;
    const rowStart = Math.floor(widget.slot / REPORT_GRID_COLUMNS) + 1;
    return {
      gridColumn: `${colStart} / span ${Math.min(widget.colSpan, REPORT_GRID_COLUMNS - colStart + 1)}`,
      gridRow: `${rowStart} / span ${widget.rowSpan}`,
    };
  };

  const handleSave = async () => {
    if (saveState === "saving") return;
    setSaveState("saving");
    setToolbarMessage(null);
    const response = await fetch(savedReportId ? `/api/reports/${savedReportId}` : "/api/reports", {
      method: savedReportId ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        businessId,
        name,
        description,
        templateId,
        definition,
      }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      setSaveState("error");
      setToolbarMessage((payload as { message?: string } | null)?.message ?? "Save failed.");
      return;
    }
    const report = (payload as { report: CustomReportRecord }).report;
    setSavedReportId(report.id);
    setSaveState("saved");
    setToolbarMessage("Report saved.");
    if (!savedReportId) {
      router.replace(`/reports/${report.id}/edit`);
    }
  };

  const handleShare = async () => {
    if (!initialRecord) {
      setToolbarMessage("Save the report first to create a share link.");
      return;
    }
    const response = await fetch(`/api/reports/${initialRecord.id}/share`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expiryDays: shareExpiryDays }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      setToolbarMessage((payload as { message?: string } | null)?.message ?? "Share failed.");
      return;
    }
    const nextUrl = new URL((payload as { url: string }).url, window.location.origin).toString();
    setShareUrl(nextUrl);
    await navigator.clipboard.writeText(nextUrl).catch(() => undefined);
    setToolbarMessage("Share link copied.");
  };

  const handleExport = async (widgetId?: string) => {
    if (!initialRecord) {
      setToolbarMessage("Save the report first to export CSV.");
      return;
    }
    const targetWidgetId = widgetId ?? tableWidgets[0]?.id;
    if (!targetWidgetId) {
      setToolbarMessage("Add a table widget to export CSV.");
      return;
    }
    const response = await fetch(`/api/reports/${initialRecord.id}/export?widgetId=${encodeURIComponent(targetWidgetId)}`);
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      setToolbarMessage((payload as { message?: string } | null)?.message ?? "CSV export failed.");
      return;
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${name.replace(/[^a-z0-9-_]+/gi, "-").toLowerCase()}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const handlePrint = () => {
    if (!initialRecord) {
      setToolbarMessage("Save the report first to export PDF.");
      return;
    }
    window.open(`/reports/${initialRecord.id}/print`, "_blank", "noopener,noreferrer");
  };

  return (
    <div className="min-h-screen bg-[#f6f7fb]">
      <div className="border-b bg-white px-6 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Button variant="outline" onClick={() => router.push(savedReportId ? `/reports/${savedReportId}` : "/reports")}>
              Back
            </Button>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="min-w-[280px] rounded-xl border px-4 py-2 text-lg font-semibold"
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={definition.dateRangePreset}
              onChange={(event) =>
                setDefinition((current) => ({
                  ...current,
                  dateRangePreset: event.target.value as CustomReportDocument["dateRangePreset"],
                }))
              }
              className="rounded-xl border px-3 py-2 text-sm"
            >
              <option value="7">Last 7 Days</option>
              <option value="30">Last 30 Days</option>
              <option value="90">Last 90 Days</option>
            </select>
            <select
              value={definition.compareMode}
              onChange={(event) =>
                setDefinition((current) => ({
                  ...current,
                  compareMode: event.target.value as CustomReportDocument["compareMode"],
                }))
              }
              className="rounded-xl border px-3 py-2 text-sm"
            >
              <option value="none">No Comparison</option>
              <option value="previous_period">Previous Period</option>
            </select>
            {/* Actions dropdown */}
            <div className="relative" ref={actionsMenuRef}>
              <Button
                variant="outline"
                onClick={() => setActionsMenuOpen((v) => !v)}
                className="flex items-center gap-1.5"
              >
                Actions
                <ChevronDown className="h-3.5 w-3.5" />
              </Button>
              {actionsMenuOpen ? (
                <div className="absolute right-0 top-full z-30 mt-1.5 w-52 rounded-xl border border-neutral-200 bg-white py-1.5 shadow-[0_8px_24px_-12px_rgba(16,21,28,0.18)]">
                  <button
                    type="button"
                    onClick={() => { handleExport(); setActionsMenuOpen(false); }}
                    className="flex w-full items-center gap-2.5 px-4 py-2.5 text-sm text-neutral-700 hover:bg-neutral-50"
                  >
                    <Download className="h-4 w-4 text-neutral-400" />
                    Export CSV
                  </button>
                  <button
                    type="button"
                    onClick={() => { handlePrint(); setActionsMenuOpen(false); }}
                    className="flex w-full items-center gap-2.5 px-4 py-2.5 text-sm text-neutral-700 hover:bg-neutral-50"
                  >
                    <Download className="h-4 w-4 text-neutral-400" />
                    Export PDF
                  </button>
                  <div className="my-1 border-t" />
                  <div className="px-4 py-2">
                    <div className="mb-1.5 text-[12px] font-semibold uppercase tracking-widest text-neutral-400">Share expiry</div>
                    <select
                      value={String(shareExpiryDays)}
                      onChange={(event) => setShareExpiryDays(Number(event.target.value))}
                      className="w-full rounded-xl border px-3 py-2 text-sm"
                    >
                      {REPORT_SHARE_EXPIRY_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                      ))}
                    </select>
                  </div>
                  <button
                    type="button"
                    onClick={() => { void handleShare(); setActionsMenuOpen(false); }}
                    className="flex w-full items-center gap-2.5 px-4 py-2.5 text-sm text-neutral-700 hover:bg-neutral-50"
                  >
                    <Share2 className="h-4 w-4 text-neutral-400" />
                    Copy share link
                  </button>
                </div>
              ) : null}
            </div>
            <Button onClick={() => void handleSave()}>
              {saveState === "saving" ? "Saving..." : saveState === "saved" ? "Saved ✓" : "Save"}
            </Button>
          </div>
        </div>
        {toolbarMessage ? (
          <div className="mt-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-700">
            {toolbarMessage}
          </div>
        ) : null}
        {shareUrl ? (
          <div className="mt-2">
            <a href={shareUrl} target="_blank" rel="noreferrer" className="text-sm text-blue-600 underline">
              Open shared report
            </a>
          </div>
        ) : null}
      </div>


      <div className="grid gap-6 px-6 py-6 lg:grid-cols-[320px_minmax(0,1fr)]">
        <aside className="space-y-5 lg:sticky lg:top-6 lg:self-start">

          {/* Widgets — always visible, compact icon grid */}
          {!selectedWidget ? (
            <section className="rounded-xl border border-neutral-200 bg-white p-4">
              <h2 className="text-sm font-semibold text-neutral-900">Widgets</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Drag and drop onto the canvas.
              </p>
              <div className="mt-3 grid grid-cols-3 gap-2">
                {WIDGET_LIBRARY.map((widget) => (
                  <div
                    key={widget.type}
                    role="button"
                    tabIndex={0}
                    draggable
                    onDragStart={(event) => {
                      setDraggedWidgetType(widget.type);
                      event.dataTransfer.setData("text/report-widget-type", widget.type);
                      event.dataTransfer.effectAllowed = "copy";
                    }}
                    onDragEnd={() => {
                      setDraggedWidgetType(null);
                      setHoveredSlot(null);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        addWidget(widget.type, selectedSlot ?? 0);
                      }
                    }}
                    className="group relative flex flex-col items-center gap-1.5 rounded-xl border border-neutral-200 bg-neutral-50 px-2 py-3 text-neutral-600 transition hover:border-neutral-400 hover:bg-white cursor-grab active:cursor-grabbing"
                  >
                    {WIDGET_ICONS[widget.type]}
                    <span className="text-[12px] font-medium text-neutral-500">{widget.label}</span>
                    {/* Tooltip */}
                    <div className="pointer-events-none absolute bottom-full left-1/2 z-30 mb-2 hidden w-36 -translate-x-1/2 rounded-xl border border-neutral-200 bg-white px-3 py-2 text-center shadow-[0_8px_24px_-12px_rgba(16,21,28,0.18)] group-hover:block">
                      <div className="text-xs font-semibold text-neutral-900">{widget.label}</div>
                      <div className="mt-0.5 text-[12px] leading-4 text-neutral-500">{widget.detail}</div>
                      <div className="absolute bottom-0 left-1/2 h-2.5 w-2.5 -translate-x-1/2 translate-y-1/2 rotate-45 border-b border-r border-neutral-200 bg-white" />
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          {/* Transparent overlay — closes open dropdowns when clicking outside */}
          {(openMetricRowIndex !== null || breakdownMenuOpen || columnMenuOpen) ? (
            <div
              className="fixed inset-0 z-10"
              onClick={() => {
                setOpenMetricRowIndex(null);
                setMetricSearch("");
                setBreakdownMenuOpen(false);
                setBreakdownSearch("");
                setColumnMenuOpen(false);
                setColumnSearch("");
              }}
            />
          ) : null}

          {selectedWidget ? (
            <section className="rounded-xl border border-neutral-200 bg-white overflow-hidden" style={{ position: "relative", zIndex: 11 }}>
              {/* Header */}
              <div className="flex items-center gap-2 border-b px-4 py-3">
                <button
                  type="button"
                  onClick={() => {
                    setSelectedWidgetId(null);
                    setMetricMenuOpen(false);
                    setMetricSearch("");
                    setColumnMenuOpen(false);
                    setColumnSearch("");
                    setOpenMetricRowIndex(null);
                    setBreakdownMenuOpen(false);
                  }}
                  className="shrink-0 text-xs font-medium text-neutral-500 hover:text-neutral-900"
                >
                  ← Back
                </button>
                <span className="min-w-0 flex-1 truncate text-sm font-semibold text-neutral-900">
                  {selectedWidget.title}
                </span>
              </div>

              {/* Quick-add strip */}
              <div className="flex flex-wrap gap-1.5 border-b px-4 py-2.5">
                {WIDGET_LIBRARY.map((w) => (
                  <button
                    key={w.type}
                    type="button"
                    onClick={() => addWidget(w.type, selectedSlot ?? 0)}
                    className="rounded-xl border border-neutral-200 bg-neutral-50 px-2.5 py-1 text-[11px] font-medium text-neutral-600 hover:border-neutral-300 hover:bg-white transition"
                  >
                    + {w.label}
                  </button>
                ))}
              </div>

              <div className="divide-y">

                {/* ── Metrics section (metric / trend / bar widgets) ── */}
                {(selectedWidget.type === "metric" || selectedWidget.type === "trend" || selectedWidget.type === "bar") ? (() => {
                  const metricKeys: string[] =
                    selectedWidget.type === "metric"
                      ? [selectedWidget.metricKey ?? ""]
                      : (selectedWidget.yMetrics?.length
                          ? selectedWidget.yMetrics
                          : selectedWidget.metricKey ? [selectedWidget.metricKey] : [""]);
                  const allMetricOptions = getMetricOptionsForWidget(selectedWidget);
                  const canAddMore = selectedWidget.type !== "metric";

                  const supportedChannels = getSupportedPlatformsForWidget(selectedWidget.type);

                  return (
                    <div className="px-4 py-3">
                      <div className="mb-3 flex items-center justify-between">
                        <p className="font-semibold text-neutral-900">Metrics</p>
                      </div>

                      {/* Channel logo strip */}
                      <div className="mb-3 flex items-center gap-1">
                        {supportedChannels.map((ch) => {
                          const logo = getReportPlatformLogo(ch.id);
                          const isActive = selectedWidgetChannel === ch.id;
                          return (
                            <button
                              key={ch.id}
                              type="button"
                              title={ch.label}
                              onClick={() => {
                                const nextMetric =
                                  getDefaultMetricForPlatform(ch.id, selectedWidget.type) ??
                                  selectedWidget.metricKey ?? "spend";
                                updateWidget(selectedWidget.id, {
                                  platform: ch.id,
                                  accountId: undefined,
                                  dataSource: getDataSourceForPlatform(ch.id, selectedWidget.type),
                                  metricKey: nextMetric,
                                  yMetrics: selectedWidget.type === "trend" || selectedWidget.type === "bar"
                                    ? [nextMetric]
                                    : selectedWidget.yMetrics,
                                  breakdown: "day",
                                });
                              }}
                              className={`flex h-8 w-8 items-center justify-center rounded-lg border transition ${
                                isActive
                                  ? "border-blue-400 bg-blue-50 ring-1 ring-blue-300"
                                  : "border-neutral-200 bg-white hover:border-neutral-300 hover:bg-neutral-50"
                              }`}
                            >
                              {ch.id === "all" ? (
                                <span className="relative flex h-4 w-4 items-center justify-center">
                                  {(["meta", "google"] as CustomReportPlatform[]).map((pid, pi) => {
                                    const plogo = getReportPlatformLogo(pid);
                                    return plogo ? (
                                      <Image
                                        key={pid}
                                        src={plogo}
                                        alt={pid}
                                        width={10}
                                        height={10}
                                        className="absolute h-2.5 w-2.5 rounded-full object-contain ring-1 ring-white"
                                        style={{ left: pi * 5, top: pi * 5 }}
                                      />
                                    ) : null;
                                  })}
                                </span>
                              ) : logo ? (
                                <Image src={logo} alt={ch.label} width={16} height={16} className="h-4 w-4 object-contain" />
                              ) : (
                                <span className="text-[12px] font-bold text-neutral-500">{ch.label.slice(0, 2)}</span>
                              )}
                            </button>
                          );
                        })}
                      </div>


                      {/* Metric rows */}
                      <div className="space-y-1.5">
                        {metricKeys.map((metricKey, rowIndex) => {
                          const metricLabel = allMetricOptions.find((m) => m.value === metricKey)?.label ?? metricKey;
                          const rowOpen = openMetricRowIndex === rowIndex;
                          const filteredOptions = rowOpen
                            ? allMetricOptions.filter((m) =>
                                !metricSearch ||
                                m.label.toLowerCase().includes(metricSearch.toLowerCase()) ||
                                m.value.toLowerCase().includes(metricSearch.toLowerCase())
                              )
                            : [];

                          return (
                            <div key={rowIndex} className="rounded-xl border border-neutral-200 bg-white overflow-hidden">
                              <div className="flex items-center">
                                <button
                                  type="button"
                                  onClick={() => {
                                    setOpenMetricRowIndex(rowOpen ? null : rowIndex);
                                    setMetricSearch("");
                                  }}
                                  className="flex min-w-0 flex-1 items-center justify-between px-3 py-2.5 text-left text-sm hover:bg-neutral-50 transition"
                                >
                                  <span className="truncate text-neutral-900">{metricLabel || tr("Select metric", "Metrik sec")}</span>
                                  <ChevronDown className={`ml-2 h-3.5 w-3.5 shrink-0 text-neutral-400 transition-transform ${rowOpen ? "rotate-180" : ""}`} />
                                </button>
                                {canAddMore && metricKeys.length > 1 ? (
                                  <button
                                    type="button"
                                    onClick={() => {
                                      const updated = metricKeys.filter((_, i) => i !== rowIndex);
                                      updateWidget(selectedWidget.id, {
                                        yMetrics: updated,
                                        metricKey: updated[0],
                                      });
                                      setOpenMetricRowIndex(null);
                                    }}
                                    className="flex h-full items-center border-l border-neutral-100 px-2.5 text-neutral-300 hover:text-red-400 transition"
                                    title={tr("Remove metric", "Metrigi kaldir")}
                                  >
                                    <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>
                                  </button>
                                ) : null}
                              </div>

                              {/* Metric dropdown */}
                              {rowOpen ? (
                                <div className="border-t border-neutral-100">
                                  <div className="flex items-center gap-2 border-b border-neutral-100 px-3 py-2">
                                    <svg className="h-3.5 w-3.5 shrink-0 text-neutral-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
                                    <input
                                      autoFocus
                                      value={metricSearch}
                                      onChange={(e) => setMetricSearch(e.target.value)}
                                      placeholder={tr("Search", "Ara")}
                                      className="w-full bg-transparent text-sm outline-none text-neutral-900 placeholder:text-neutral-400"
                                    />
                                  </div>
                                  <div className="max-h-52 overflow-y-auto">
                                    {filteredOptions.map((metric) => (
                                      <button
                                        key={metric.value}
                                        type="button"
                                        onClick={() => {
                                          if (selectedWidget.type === "metric") {
                                            updateWidget(selectedWidget.id, { metricKey: metric.value });
                                          } else {
                                            const updated = [...metricKeys];
                                            updated[rowIndex] = metric.value;
                                            updateWidget(selectedWidget.id, {
                                              yMetrics: updated,
                                              metricKey: updated[0],
                                            });
                                          }
                                          setOpenMetricRowIndex(null);
                                          setMetricSearch("");
                                        }}
                                        className={`flex w-full items-center px-3 py-2.5 text-left text-sm transition ${
                                          metric.value === metricKey
                                            ? "bg-blue-50 text-blue-700 font-medium"
                                            : "text-neutral-800 hover:bg-neutral-50"
                                        }`}
                                      >
                                        {metric.label}
                                      </button>
                                    ))}
                                  </div>
                                </div>
                              ) : null}
                            </div>
                          );
                        })}
                      </div>

                      {canAddMore ? (
                        <button
                          type="button"
                          onClick={() => {
                            const first = allMetricOptions[0]?.value ?? "spend";
                            const updated = [...metricKeys, first];
                            updateWidget(selectedWidget.id, {
                              yMetrics: updated,
                              metricKey: updated[0],
                            });
                          }}
                          className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-neutral-300 py-2.5 text-sm font-medium text-neutral-500 hover:border-neutral-400 hover:text-neutral-700 transition"
                        >
                          {tr("+ Metric", "+ Metrik")}
                        </button>
                      ) : null}
                    </div>
                  );
                })() : null}

                {/* ── Table widget panel ── */}
                {selectedWidget.type === "table" ? (() => {
                  const tableSupportedChannels = getSupportedPlatformsForWidget(selectedWidget.type);
                  // metric-only columns (exclude old-style dimension cols)
                  const activeMetrics = (selectedWidget.columns ?? []).filter(
                    (c) => c !== "name" && c !== "status" && c !== "channel" && c !== "currency"
                  );
                  const tableDimension = selectedWidget.tableDimension ?? "campaign";
                  const dimensionOptions = getTableDimensionsForPlatform(selectedWidgetChannel);
                  const tableMetricOptions = getTableMetricOptionsForPlatform(selectedWidgetChannel);
                  const filteredTableMetrics = columnMenuOpen
                    ? tableMetricOptions.filter((m) =>
                        !columnSearch ||
                        m.label.toLowerCase().includes(columnSearch.toLowerCase()) ||
                        m.value.toLowerCase().includes(columnSearch.toLowerCase())
                      )
                    : [];

                  return (
                    <div className="px-4 py-3 space-y-3">
                      {/* Channel logo strip */}
                      <div className="flex items-center gap-1">
                        {tableSupportedChannels.map((ch) => {
                          const logo = getReportPlatformLogo(ch.id);
                          const isActive = selectedWidgetChannel === ch.id;
                          return (
                            <button
                              key={ch.id}
                              type="button"
                              title={ch.label}
                              onClick={() => {
                                updateWidget(selectedWidget.id, {
                                  platform: ch.id,
                                  accountId: undefined,
                                  dataSource: getDataSourceForPlatform(ch.id, selectedWidget.type),
                                  columns: [],
                                  tableDimension: "campaign",
                                });
                                setColumnMenuOpen(false);
                                setColumnSearch("");
                              }}
                              className={`flex h-8 w-8 items-center justify-center rounded-lg border transition ${
                                isActive
                                  ? "border-blue-400 bg-blue-50 ring-1 ring-blue-300"
                                  : "border-neutral-200 bg-white hover:border-neutral-300 hover:bg-neutral-50"
                              }`}
                            >
                              {ch.id === "all" ? (
                                <span className="relative flex h-4 w-4 items-center justify-center">
                                  {(["meta", "google"] as CustomReportPlatform[]).map((pid, pi) => {
                                    const plogo = getReportPlatformLogo(pid);
                                    return plogo ? (
                                      <Image
                                        key={pid}
                                        src={plogo}
                                        alt={pid}
                                        width={10}
                                        height={10}
                                        className="absolute h-2.5 w-2.5 rounded-full object-contain ring-1 ring-white"
                                        style={{ left: pi * 5, top: pi * 5 }}
                                      />
                                    ) : null;
                                  })}
                                </span>
                              ) : logo ? (
                                <Image src={logo} alt={ch.label} width={16} height={16} className="h-4 w-4 object-contain" />
                              ) : (
                                <span className="text-[12px] font-bold text-neutral-500">{ch.label.slice(0, 2)}</span>
                              )}
                            </button>
                          );
                        })}
                      </div>

                      {/* Dimension picker */}
                      {dimensionOptions.length > 0 && (
                        <div>
                          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">{tr("Dimension", "Boyut")}</p>
                          <select
                            value={tableDimension}
                            onChange={(e) => updateWidget(selectedWidget.id, { tableDimension: e.target.value, columns: [] })}
                            className="w-full rounded-xl border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-800 focus:outline-none focus:ring-2 focus:ring-blue-300"
                          >
                            {(() => {
                              const groups = Array.from(new Set(dimensionOptions.map((d) => d.group ?? "")));
                              return groups.map((group) => {
                                const opts = dimensionOptions.filter((d) => (d.group ?? "") === group);
                                return (
                                  <optgroup key={group} label={group}>
                                    {opts.map((d) => (
                                      <option key={d.value} value={d.value}>{d.label}</option>
                                    ))}
                                  </optgroup>
                                );
                              });
                            })()}
                          </select>
                        </div>
                      )}

                      {/* Metrics section */}
                      <div>
                        <div className="mb-2 flex items-center justify-between">
                          <p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400">{tr("Metrics", "Metrikler")}</p>
                          <select
                            value={selectedWidget.limit ?? 8}
                            onChange={(e) => updateWidget(selectedWidget.id, { limit: Number(e.target.value) })}
                            className="rounded-lg border border-neutral-200 bg-white px-2 py-1 text-xs text-neutral-700"
                          >
                            <option value="5">5 rows</option>
                            <option value="8">8 rows</option>
                            <option value="10">10 rows</option>
                            <option value="15">15 rows</option>
                            <option value="20">20 rows</option>
                          </select>
                        </div>

                        {/* Active metric chips */}
                        {activeMetrics.length > 0 && (
                          <div className="mb-2 flex flex-wrap gap-1">
                            {activeMetrics.map((col) => {
                              const label = tableMetricOptions.find((m) => m.value === col)?.label ?? col;
                              return (
                                <span
                                  key={col}
                                  className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-medium text-blue-700"
                                >
                                  {label}
                                  <button
                                    type="button"
                                    onClick={() => {
                                      const next = activeMetrics.filter((c) => c !== col);
                                      updateWidget(selectedWidget.id, { columns: next });
                                    }}
                                    className="ml-0.5 text-blue-400 hover:text-blue-700"
                                  >
                                    ×
                                  </button>
                                </span>
                              );
                            })}
                          </div>
                        )}

                        {/* Add metric dropdown */}
                        <div className="rounded-xl border border-neutral-200 bg-white overflow-hidden">
                          <button
                            type="button"
                            onClick={() => {
                              setColumnMenuOpen((o) => !o);
                              setColumnSearch("");
                            }}
                            className="flex w-full items-center justify-between px-3 py-2.5 text-left text-sm hover:bg-neutral-50 transition"
                          >
                            <span className="text-neutral-500">{tr("+ Add metric", "+ Metrik ekle")}</span>
                            <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-neutral-400 transition-transform ${columnMenuOpen ? "rotate-180" : ""}`} />
                          </button>
                          {columnMenuOpen && (
                            <div className="border-t border-neutral-100">
                              <div className="flex items-center gap-2 border-b border-neutral-100 px-3 py-2">
                                <svg className="h-3.5 w-3.5 shrink-0 text-neutral-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
                                <input
                                  autoFocus
                                  value={columnSearch}
                                  onChange={(e) => setColumnSearch(e.target.value)}
                                  placeholder={tr("Search metrics", "Metrik ara")}
                                  className="w-full bg-transparent text-sm outline-none text-neutral-900 placeholder:text-neutral-400"
                                />
                              </div>
                              <div className="max-h-52 overflow-y-auto">
                                {filteredTableMetrics.map((metric) => {
                                  const active = activeMetrics.includes(metric.value);
                                  return (
                                    <button
                                      key={metric.value}
                                      type="button"
                                      onClick={() => {
                                        const next = active
                                          ? activeMetrics.filter((c) => c !== metric.value)
                                          : [...activeMetrics, metric.value];
                                        updateWidget(selectedWidget.id, { columns: next });
                                      }}
                                      className={`flex w-full items-center justify-between px-3 py-2.5 text-left text-sm transition ${
                                        active ? "bg-blue-50 text-blue-700 font-medium" : "text-neutral-800 hover:bg-neutral-50"
                                      }`}
                                    >
                                      <span>{metric.label}</span>
                                      {active && <span className="h-4 w-4 rounded-full bg-blue-500 text-white text-[12px] flex items-center justify-center">✓</span>}
                                    </button>
                                  );
                                })}
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })() : null}

                {/* ── Breakdown section (trend / bar) ── */}
                {(selectedWidget.type === "trend" || selectedWidget.type === "bar") ? (
                  <div className="px-4 py-3">
                    <div className="mb-3 flex items-center justify-between">
                      <p className="font-semibold text-neutral-900">{tr("Breakdown", "Kirilim")}</p>
                    </div>
                    {(() => {
                      const breakdownOptions = getBreakdownOptionsForPlatform(selectedWidgetChannel, selectedWidget.type);
                      const currentBreakdown = selectedWidget.breakdown ?? "day";
                      const currentLabel = breakdownOptions.find((o) => o.value === currentBreakdown)?.label ?? currentBreakdown;
                      const filteredBreakdowns = breakdownMenuOpen
                        ? breakdownOptions.filter((o) =>
                            !breakdownSearch ||
                            o.label.toLowerCase().includes(breakdownSearch.toLowerCase())
                          )
                        : [];
                      return (
                        <div className="rounded-xl border border-neutral-200 bg-white overflow-hidden">
                          <button
                            type="button"
                            onClick={() => {
                              setBreakdownMenuOpen((o) => !o);
                              setBreakdownSearch("");
                            }}
                            className="flex w-full items-center justify-between px-3 py-2.5 text-left text-sm hover:bg-neutral-50 transition"
                          >
                            <span className="text-neutral-900">{currentLabel}</span>
                            <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-neutral-400 transition-transform ${breakdownMenuOpen ? "rotate-180" : ""}`} />
                          </button>
                          {breakdownMenuOpen ? (
                            <div className="border-t border-neutral-100">
                              <div className="flex items-center gap-2 border-b border-neutral-100 px-3 py-2">
                                <svg className="h-3.5 w-3.5 shrink-0 text-neutral-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
                                <input
                                  autoFocus
                                  value={breakdownSearch}
                                  onChange={(e) => setBreakdownSearch(e.target.value)}
                                  placeholder={tr("Search", "Ara")}
                                  className="w-full bg-transparent text-sm outline-none text-neutral-900 placeholder:text-neutral-400"
                                />
                              </div>
                              <div className="max-h-48 overflow-y-auto">
                                {(() => {
                                  const groups: string[] = [];
                                  filteredBreakdowns.forEach((o) => {
                                    if (o.group && !groups.includes(o.group)) groups.push(o.group);
                                  });
                                  const hasGroups = groups.length > 1;
                                  return filteredBreakdowns.map((opt, idx) => {
                                    const showGroupHeader = hasGroups && opt.group &&
                                      (idx === 0 || filteredBreakdowns[idx - 1]?.group !== opt.group);
                                    return (
                                      <div key={opt.value}>
                                        {showGroupHeader && (
                                          <p className="px-3 pt-2 pb-0.5 text-[12px] font-semibold uppercase tracking-wider text-neutral-400">
                                            {opt.group}
                                          </p>
                                        )}
                                        <button
                                          type="button"
                                          onClick={() => {
                                            updateWidget(selectedWidget.id, { breakdown: opt.value as CustomReportWidgetDefinition["breakdown"] });
                                            setBreakdownMenuOpen(false);
                                            setBreakdownSearch("");
                                          }}
                                          className={`flex w-full items-center px-3 py-2.5 text-left text-sm transition ${
                                            opt.value === currentBreakdown
                                              ? "bg-blue-50 text-blue-700 font-medium"
                                              : "text-neutral-800 hover:bg-neutral-50"
                                          }`}
                                        >
                                          {opt.label}
                                        </button>
                                      </div>
                                    );
                                  });
                                })()}
                              </div>
                            </div>
                          ) : null}
                        </div>
                      );
                    })()}
                  </div>
                ) : null}

                {/* Body (text / section) */}
                {(selectedWidget.type === "text" || selectedWidget.type === "section") ? (
                  <div className="px-4 py-3 space-y-2">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-neutral-400">{tr("Body", "İçerik")}</p>
                    <textarea
                      value={selectedWidget.text ?? ""}
                      onChange={(e) => updateWidget(selectedWidget.id, { text: e.target.value })}
                      rows={5}
                      className="w-full rounded-xl border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-900"
                    />
                  </div>
                ) : null}

                {/* Copy */}
                <div className="px-4 py-3 space-y-2">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-neutral-400">{tr("Copy", "Metin")}</p>
                  <input
                    value={selectedWidget.title}
                    onChange={(e) => updateWidget(selectedWidget.id, { title: e.target.value })}
                    placeholder={tr("Title", "Başlık")}
                    className="w-full rounded-xl border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-900"
                  />
                  <input
                    value={selectedWidget.subtitle ?? ""}
                    onChange={(e) => updateWidget(selectedWidget.id, { subtitle: e.target.value || undefined })}
                    placeholder={tr("Subtitle (optional)", "Alt başlık (opsiyonel)")}
                    className="w-full rounded-xl border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-900"
                  />
                </div>

              </div>
            </section>
          ) : null}

          {true ? (
            <section className="rounded-xl border border-neutral-200 bg-white p-4">
              <h2 className="text-sm font-semibold uppercase tracking-[0.2em] text-muted-foreground">
                {tr("Templates", "Template'ler")}
              </h2>
              <div className="mt-3 flex flex-wrap gap-2">
                {templateCategories.map((category) => (
                  <button
                    key={category}
                    type="button"
                    onClick={() => setTemplateFilter(category)}
                    className={`rounded-full px-3 py-1.5 text-xs font-medium transition ${
                      templateFilter === category
                        ? "bg-neutral-900 text-white"
                        : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200"
                    }`}
                  >
                    {category}
                  </button>
                ))}
              </div>
              <div className="mt-3 space-y-2">
                {filteredTemplates.map((template) => (
                  <button
                    key={template.id}
                    type="button"
                    onClick={() => applyTemplate(template)}
                    className="w-full rounded-xl border border-neutral-200 bg-white px-3 py-3 text-left transition hover:border-neutral-300 hover:bg-neutral-50"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="text-sm font-semibold">{template.name}</div>
                      <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-[12px] font-medium uppercase tracking-[0.08em] text-neutral-500">
                        {template.category}
                      </span>
                    </div>
                    <TemplateMiniPreview definition={template.definition} className="mt-3" />
                    <div className="mt-2 text-xs text-muted-foreground">{template.description}</div>
                  </button>
                ))}
              </div>
            </section>
          ) : null}
        </aside>

        <section className="space-y-5">
          <div className="rounded-xl border border-neutral-200 bg-white p-4">
            <div className="mb-4 flex items-start justify-between gap-4">
              <div className="flex-1">
                <h2 className="text-lg font-semibold">{tr("Canvas", "Tuval")}</h2>
                <textarea
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  rows={1}
                  className="mt-1 w-full resize-none rounded-xl border-0 bg-transparent px-0 text-sm text-muted-foreground placeholder:text-neutral-400 focus:outline-none focus:ring-0"
                  placeholder={tr("Add a description for this report...", "Bu rapor için bir açıklama ekleyin...")}
                />
              </div>
              {templateId ? (
                <span className="shrink-0 rounded-full bg-neutral-100 px-3 py-1 text-xs font-medium text-neutral-600">
                  Template: {templateId}
                </span>
              ) : null}
            </div>
            {canvasWidgets.length === 0 ? (
              <div className="mb-4 rounded-xl border border-dashed border-blue-200 bg-blue-50 px-5 py-5">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <div className="text-sm font-semibold text-neutral-950">{tr("Start with your first widget", "İlk widget'inizle başlayın")}</div>
                    <p className="mt-1 max-w-2xl text-sm text-neutral-600">
                      Drag a metric, chart, table, or section from the left palette into the canvas. Once it lands,
                      click the widget to configure its source, account, and content.
                    </p>
                  </div>
                    <div className="rounded-xl border border-neutral-200 bg-white px-4 py-3 text-xs font-medium text-neutral-700">
                      {tr("Drag from left", "Soldan sürükleyin")}
                    </div>
                </div>
                <div className="mt-3 text-xs text-neutral-500">
                  Tip: select a widget and use <span className="font-semibold text-neutral-700">Delete</span> to remove
                  , <span className="font-semibold text-neutral-700">Cmd/Ctrl + D</span> to duplicate it, or{" "}
                  <span className="font-semibold text-neutral-700">Shift + Arrow</span> to move it around the grid.
                </div>
              </div>
            ) : null}
            <div className="relative">
              <div
                className="grid gap-3"
                style={{ gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gridAutoRows: "140px" }}
              >
                {Array.from({ length: REPORT_GRID_SLOT_COUNT }).map((_, slot) => {
                  const widget = definition.widgets.find((item) => item.slot === slot) ?? null;
                  const slotCovered = occupiedSlots.has(slot);
                  const selected = selectedSlot === slot || selectedWidgetId === widget?.id;
                  return (
                    <div
                      key={slot}
                      onDragOver={(event) => {
                        event.preventDefault();
                        const incomingType =
                          event.dataTransfer.getData("text/report-widget-type") || draggedWidgetType;
                        event.dataTransfer.dropEffect = incomingType ? "copy" : "move";
                        setHoveredSlot(slot);
                      }}
                      onDragLeave={() => {
                        setHoveredSlot((current) => (current === slot ? null : current));
                      }}
                      onDrop={(event) => {
                        event.preventDefault();
                        const widgetType = (
                          event.dataTransfer.getData("text/report-widget-type") || draggedWidgetType || ""
                        ) as CustomReportWidgetType | "";
                        if (widgetType) {
                          addWidget(widgetType, slot);
                          setDraggedWidgetType(null);
                          setHoveredSlot(null);
                          return;
                        }
                        const movingId =
                          event.dataTransfer.getData("text/report-widget-id") || draggedWidgetId;
                        if (!movingId) return;
                        moveWidgetToSlot(movingId, slot);
                        setDraggedWidgetId(null);
                        setDraggedWidgetType(null);
                        setHoveredSlot(null);
                      }}
                      className={`relative rounded-xl p-4 text-left transition ${
                        slotCovered
                          ? "border border-transparent bg-transparent"
                          : hoveredSlot === slot
                            ? "border-2 border-emerald-400 border-dashed bg-emerald-50/70 shadow-[0_0_0_4px_rgba(16,185,129,0.08)]"
                            : (draggedWidgetType || draggedWidgetId)
                              ? "border-2 border-dashed border-neutral-200 bg-neutral-50/40"
                              : selected
                                ? "border-2 border-blue-400 border-dashed bg-blue-50/40"
                                : "border border-transparent bg-transparent"
                      }`}
                    >
                      {!slotCovered ? (
                        <>
                          <button
                            type="button"
                            onClick={() => {
                              setSelectedSlot(slot);
                              setSelectedWidgetId(widget?.id ?? null);
                            }}
                            className="absolute inset-0 rounded-xl"
                            aria-label={`Target slot ${slot + 1}`}
                          />
                          {hoveredSlot === slot ? (
                            <div className="relative z-10 flex h-full min-h-[64px] flex-col items-center justify-center">
                              <div className="text-sm font-semibold text-emerald-700">
                                {draggedWidgetType ? tr("Drop to create", "Oluşturmak için bırak") : tr("Drop here", "Buraya birak")}
                              </div>
                            </div>
                          ) : null}
                        </>
                      ) : null}
                    </div>
                  );
                })}
              </div>
              <div
                ref={canvasOverlayRef}
                className="pointer-events-none absolute inset-0 grid gap-3"
                style={{
                  gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
                  gridAutoRows: "140px",
                }}
              >
                {canvasWidgets.map((widget) => (
                  (() => {
                    const renderedWidget = renderedWidgetsById.get(widget.id);
                    const previewSummary = getWidgetPreviewSummary(renderedWidget);
                    const widgetChannel = resolveWidgetPlatform(widget);
                    const widgetMetricLabel =
                      widget.type === "metric" || widget.type === "trend" || widget.type === "bar"
                        ? getMetricOptionsForPlatform(widgetChannel, widget.type).find((metric) => metric.value === widget.metricKey)?.label ?? null
                        : null;
                    return (
                      <div
                        key={widget.id}
                        draggable
                        onDragStart={(event) => {
                          setDraggedWidgetId(widget.id);
                          setDraggedWidgetType(null);
                          event.dataTransfer.setData("text/report-widget-id", widget.id);
                          event.dataTransfer.effectAllowed = "move";
                        }}
                        onDragEnd={() => {
                          setDraggedWidgetId(null);
                          setHoveredSlot(null);
                        }}
                        onClick={() => {
                          setSelectedWidgetId(widget.id);
                          setSelectedSlot(widget.slot);
                        }}
                        style={getCanvasWidgetStyle(widget)}
                        className={`pointer-events-auto group relative ${widget.type === "table" ? "overflow-auto" : "overflow-hidden"} rounded-xl border-2 border-neutral-200 bg-white text-left transition ${
                          selectedWidgetId === widget.id
                            ? "border-blue-500 shadow-blue-100"
                            : "border-neutral-200 hover:border-neutral-300"
                        }`}
                      >
                        {/* Rendered widget content fills the card */}
                        <div className="h-full w-full">
                          {renderedWidget ? (
                            <ReportWidgetCard widget={renderedWidget} embedded />
                          ) : (
                            <div className="flex h-full items-center justify-center p-4">
                              <div className="text-center">
                                <div className="text-xs font-semibold uppercase tracking-[0.18em] text-neutral-400">{widget.type}</div>
                                <div className="mt-2 text-sm font-medium text-neutral-600">{widget.title}</div>
                                <div className="mt-2 h-1 w-16 animate-pulse rounded-full bg-neutral-200 mx-auto" />
                              </div>
                            </div>
                          )}
                        </div>
                        <div
                          className={`absolute right-3 top-3 flex items-center gap-1 rounded-full border border-neutral-200 bg-white/95 px-1.5 py-1 transition ${
                            selectedWidgetId === widget.id
                              ? "opacity-100"
                              : "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100"
                          }`}
                        >
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              setSelectedWidgetId(widget.id);
                              setSelectedSlot(widget.slot);
                        }}
                            className="rounded-full px-2 py-1 text-[12px] font-semibold text-neutral-600 hover:bg-neutral-100"
                            title={tr("Edit widget", "Widget'i düzenle")}
                          >
                            {tr("Edit", "Düzenle")}
                          </button>
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              duplicateWidget(widget.id);
                            }}
                            className="rounded-full px-2 py-1 text-[12px] font-semibold text-neutral-600 hover:bg-neutral-100"
                            title={tr("Duplicate widget", "Widget'i kopyala")}
                          >
                            {tr("Copy", "Kopyala")}
                          </button>
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              removeWidget(widget.id);
                            }}
                            className="rounded-full px-2 py-1 text-[12px] font-semibold text-red-600 hover:bg-red-50"
                            title={tr("Remove widget", "Widget'i kaldir")}
                          >
                            Del
                          </button>
                        </div>
                        {/* Right-edge resize handle */}
                        <button
                          type="button"
                          onMouseDown={(event) => {
                            event.stopPropagation();
                            event.preventDefault();
                            setActiveResize({
                              widgetId: widget.id,
                              mode: "col",
                              startX: event.clientX,
                              startY: event.clientY,
                              originColSpan: widget.colSpan,
                              originRowSpan: widget.rowSpan,
                            });
                          }}
                          className="absolute bottom-8 right-0 top-8 w-2 cursor-ew-resize opacity-0 transition-opacity group-hover:opacity-100"
                          title={tr("Drag to resize width", "Genişliği yeniden boyutlandırmak için sürükleyin")}
                        >
                          <span className="block h-full w-1 mx-auto rounded-full bg-blue-400/60 hover:bg-blue-500" />
                        </button>
                        {/* Bottom-edge resize handle */}
                        <button
                          type="button"
                          onMouseDown={(event) => {
                            event.stopPropagation();
                            event.preventDefault();
                            setActiveResize({
                              widgetId: widget.id,
                              mode: "row",
                              startX: event.clientX,
                              startY: event.clientY,
                              originColSpan: widget.colSpan,
                              originRowSpan: widget.rowSpan,
                            });
                          }}
                          className="absolute bottom-0 left-8 right-8 h-2 cursor-ns-resize opacity-0 transition-opacity group-hover:opacity-100"
                          title={tr("Drag to resize height", "Yüksekliği yeniden boyutlandırmak için sürükleyin")}
                        >
                          <span className="block h-1 w-full my-auto rounded-full bg-blue-400/60 hover:bg-blue-500" />
                        </button>
                        {/* Bottom-right corner resize handle */}
                        <button
                          type="button"
                          onMouseDown={(event) => {
                            event.stopPropagation();
                            event.preventDefault();
                            setActiveResize({
                              widgetId: widget.id,
                              mode: "both",
                              startX: event.clientX,
                              startY: event.clientY,
                              originColSpan: widget.colSpan,
                              originRowSpan: widget.rowSpan,
                            });
                          }}
                          className="absolute bottom-0 right-0 h-5 w-5 cursor-se-resize opacity-0 transition-opacity group-hover:opacity-100 flex items-end justify-end p-1"
                          title={tr("Drag to resize", "Yeniden boyutlandırmak için sürükleyin")}
                        >
                          <span className="block h-3 w-3 rounded-br-lg border-b-2 border-r-2 border-blue-400/80" />
                        </button>
                      </div>
                    );
                  })()
                ))}
                {dragPreview ? (
                  <div
                    style={getCanvasWidgetStyle(dragPreview)}
                    className="rounded-xl border-2 border-dashed border-emerald-500 bg-emerald-100/70 p-4"
                  >
                    <div className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-700">
                      {dragPreview.mode === "create"
                        ? dragPreview.snapped
                          ? tr("Create Preview", "Oluşturma Önizlemesi")
                          : "Drop to Create"
                        : dragPreview.snapped
                          ? "Snap Preview"
                          : tr("Drop Preview", "Birakma Onizlemesi")}
                    </div>
                    <div className="mt-2 text-sm font-semibold text-emerald-900">
                      {dragPreview.title}
                    </div>
                    <div className="mt-2 text-xs text-emerald-700">
                      {dragPreview.snapped
                        ? `Nearest open slot: ${dragPreview.slot + 1}`
                        : `${dragPreview.mode === "create" ? "Create" : "Drop"} into slot ${dragPreview.slot + 1}`}
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          </div>

          {previewQuery.error ? (
            <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
              {previewQuery.error instanceof Error ? previewQuery.error.message : tr("Preview failed.", "Onizleme başarısız oldu.")}
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}
