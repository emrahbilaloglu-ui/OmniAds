"use client";

import {
  REPORT_GRID_COLUMNS,
  type CustomReportDocument,
  type CustomReportTemplate,
  type CustomReportWidgetDefinition,
} from "@/lib/custom-reports";

function getWidgetStyle(widget: Pick<CustomReportWidgetDefinition, "slot" | "colSpan" | "rowSpan">) {
  const colStart = (widget.slot % REPORT_GRID_COLUMNS) + 1;
  const rowStart = Math.floor(widget.slot / REPORT_GRID_COLUMNS) + 1;
  return {
    gridColumn: `${colStart} / span ${Math.min(widget.colSpan, REPORT_GRID_COLUMNS - colStart + 1)}`,
    gridRow: `${rowStart} / span ${widget.rowSpan}`,
  };
}

function getWidgetTone(widget: CustomReportWidgetDefinition) {
  if (widget.type === "section") return "bg-neutral-900/8";
  if (widget.type === "metric") return "bg-white/90";
  if (widget.type === "trend") return "bg-sky-100/90";
  if (widget.type === "bar") return "bg-blue-100/90";
  if (widget.type === "table") return "bg-white/80";
  return "bg-emerald-100/90";
}

function renderWidgetGlyph(widget: CustomReportWidgetDefinition) {
  if (widget.type === "metric") {
    return (
      <div className="space-y-1">
        <div className="h-2 w-8 rounded-full bg-neutral-900/10" />
        <div className="h-4 w-10 rounded-full bg-neutral-900/15" />
      </div>
    );
  }
  if (widget.type === "section") {
    return (
      <div className="space-y-1.5">
        <div className="h-2 w-10 rounded-full bg-neutral-900/15" />
        <div className="h-2 w-24 rounded-full bg-neutral-900/12" />
      </div>
    );
  }
  if (widget.type === "trend") {
    return (
      <svg viewBox="0 0 100 36" className="h-full w-full text-sky-500/75">
        <path
          d="M 0 24 C 16 8, 28 8, 40 20 S 64 30, 76 12 S 92 10, 100 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  if (widget.type === "bar") {
    return (
      <div className="flex h-full items-end gap-1">
        {[28, 48, 36, 54, 30].map((height, index) => (
          <div
            key={index}
            className="flex-1 rounded-t-md bg-blue-500/55"
            style={{ height: `${height}%` }}
          />
        ))}
      </div>
    );
  }
  if (widget.type === "table") {
    return (
      <div className="space-y-1.5">
        <div className="grid grid-cols-4 gap-1">
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="h-2 rounded-full bg-neutral-900/12" />
          ))}
        </div>
        {Array.from({ length: 3 }).map((_, rowIndex) => (
          <div key={rowIndex} className="grid grid-cols-4 gap-1">
            {Array.from({ length: 4 }).map((_, index) => (
              <div key={index} className="h-2 rounded-full bg-neutral-900/8" />
            ))}
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="space-y-1.5">
      <div className="h-2 w-16 rounded-full bg-neutral-900/12" />
      <div className="h-2 w-12 rounded-full bg-neutral-900/8" />
      <div className="h-2 w-20 rounded-full bg-neutral-900/8" />
    </div>
  );
}

export function TemplateMiniPreview({
  definition,
  className = "",
}: {
  definition: CustomReportDocument;
  className?: string;
}) {
  const widgets = Array.isArray(definition?.widgets) ? definition.widgets : [];
  return (
    <div
      className={`grid gap-1.5 ${className}`.trim()}
      style={{ gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gridAutoRows: "24px" }}
    >
      {widgets.map((widget) => (
        <div
          key={widget.id}
          style={getWidgetStyle(widget)}
          className={`overflow-hidden rounded-xl border border-white/70 p-2 ${getWidgetTone(widget)}`}
        >
          {renderWidgetGlyph(widget)}
        </div>
      ))}
    </div>
  );
}

export function TemplateProviders({ template }: { template: CustomReportTemplate }) {
  return <span className="text-xs text-neutral-500">{template.providers.join(" • ")}</span>;
}
