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
  if (widget.type === "section") return "bg-[var(--adc-s3)]";
  if (widget.type === "metric") return "bg-[var(--adc-s2)]";
  if (widget.type === "trend") return "bg-[var(--adc-info-bg,#ebf1fb)]";
  if (widget.type === "bar") return "bg-[var(--adc-s2)]";
  if (widget.type === "table") return "bg-[var(--adc-s2)]";
  return "bg-[var(--adc-s3)]";
}

function renderWidgetGlyph(widget: CustomReportWidgetDefinition) {
  if (widget.type === "metric") {
    return (
      <div className="space-y-1">
        <div className="h-2 w-8 rounded-full bg-[var(--adc-b1,#e4e4e0)]" />
        <div className="h-4 w-10 rounded-full bg-[var(--adc-b2,#cdcdc7)]" />
      </div>
    );
  }
  if (widget.type === "section") {
    return (
      <div className="space-y-1.5">
        <div className="h-2 w-10 rounded-full bg-[var(--adc-b2,#cdcdc7)]" />
        <div className="h-2 w-24 rounded-full bg-[var(--adc-b1,#e4e4e0)]" />
      </div>
    );
  }
  if (widget.type === "trend") {
    return (
      <svg viewBox="0 0 100 36" className="h-full w-full text-[var(--adc-ink3,#7d838c)]">
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
            className="flex-1 rounded-t-md bg-[var(--adc-b2,#cdcdc7)]"
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
            <div key={index} className="h-2 rounded-full bg-[var(--adc-b2,#cdcdc7)]" />
          ))}
        </div>
        {Array.from({ length: 3 }).map((_, rowIndex) => (
          <div key={rowIndex} className="grid grid-cols-4 gap-1">
            {Array.from({ length: 4 }).map((_, index) => (
              <div key={index} className="h-2 rounded-full bg-[var(--adc-b1,#e4e4e0)]" />
            ))}
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="space-y-1.5">
      <div className="h-2 w-16 rounded-full bg-[var(--adc-b2,#cdcdc7)]" />
      <div className="h-2 w-12 rounded-full bg-[var(--adc-b1,#e4e4e0)]" />
      <div className="h-2 w-20 rounded-full bg-[var(--adc-b1,#e4e4e0)]" />
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
          className={`overflow-hidden rounded-xl border border-[var(--adc-b1)] p-2 ${getWidgetTone(widget)}`}
        >
          {renderWidgetGlyph(widget)}
        </div>
      ))}
    </div>
  );
}

export function TemplateProviders({ template }: { template: CustomReportTemplate }) {
  return <span className="text-xs text-[var(--adc-ink3)]">{template.providers.join(" • ")}</span>;
}
