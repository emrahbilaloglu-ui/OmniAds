"use client";

import { useState, useCallback } from "react";
import type { RenderedReportPayload, RenderedReportWidget } from "@/lib/custom-reports";
import {
  computeNiceAxisTicks,
  resolveChartDomain,
  type ChartDomainMode,
} from "@/lib/chart-domain";
import { getMetricLabelForKey } from "@/lib/report-metric-catalog";

const COLUMN_LABEL_MAP: Record<string, string> = {
  name: "Name",
  status: "Status",
  channel: "Channel",
  currency: "Currency",
  date: "Date",
  age: "Age",
  gender: "Gender",
  country: "Country",
  region: "Region",
  query: "Search Query",
  page: "Page",
  source: "Traffic Source",
  medium: "Medium",
  campaign: "Campaign",
  device: "Device",
  flow: "Flow",
  product: "Product",
  variant: "Variant",
  customer: "Customer",
};

function getColumnLabel(columnKey: string): string {
  return COLUMN_LABEL_MAP[columnKey] ?? getMetricLabelForKey(columnKey);
}

function slotStyle(slot: number, widget: RenderedReportWidget) {
  const colStart = (slot % 4) + 1;
  const rowStart = Math.floor(slot / 4) + 1;
  const colSpan = widget.colSpan;
  const rowSpan = widget.rowSpan;

  return {
    gridColumn: `${colStart} / span ${Math.min(colSpan, 5 - colStart)}`,
    gridRow: `${rowStart} / span ${rowSpan}`,
  };
}

function formatYLabel(value: number): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(abs % 1_000_000 === 0 ? 0 : 1)}M`;
  if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(abs % 1_000 === 0 ? 0 : 1)}k`;
  if (value === 0) return "0";
  if (value % 1 !== 0) return value.toFixed(value < 10 ? 2 : 1);
  return String(value);
}

function formatTooltipValue(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return value.toLocaleString("en-US", { maximumFractionDigits: 0 });
  return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function ChartTooltip({
  label,
  entries,
  pixelX,
  pixelY,
}: {
  label: string;
  entries: Array<{ color: string; name: string; value: number }>;
  pixelX: number;
  pixelY: number;
}) {
  // Decide left vs right side
  const flipX = pixelX > 260;
  return (
    <div
      className="pointer-events-none absolute z-20 rounded-xl border border-[var(--adv-border)] bg-white/95 px-3 py-2 text-xs shadow-[0_8px_24px_-12px_rgba(16,21,28,0.18)] backdrop-blur-sm"
      style={{
        left: flipX ? undefined : pixelX + 12,
        right: flipX ? `calc(100% - ${pixelX - 12}px)` : undefined,
        top: Math.max(0, pixelY - 24),
        minWidth: 160,
      }}
    >
      <p className="mb-1.5 font-semibold text-[var(--adv-ink-3)]">{label}</p>
      {entries.map((e, i) => (
        <div key={i} className="flex items-center justify-between gap-4">
          <span className="flex items-center gap-1.5 text-[var(--adv-ink-2)] truncate">
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: e.color }} />
            {e.name || "Value"}
          </span>
          <span className="font-semibold text-[var(--adv-ink)] tabular-nums">{formatTooltipValue(e.value)}</span>
        </div>
      ))}
    </div>
  );
}

function computeNiceTicks(rawMax: number, tickCount = 4): number[] {
  if (rawMax <= 0) return Array.from({ length: tickCount + 1 }, (_, i) => i);
  const roughStep = rawMax / tickCount;
  const magnitude = Math.pow(10, Math.floor(Math.log10(roughStep)));
  const normalized = roughStep / magnitude;
  let niceStep: number;
  if (normalized <= 1) niceStep = magnitude;
  else if (normalized <= 2) niceStep = 2 * magnitude;
  else if (normalized <= 2.5) niceStep = 2.5 * magnitude;
  else if (normalized <= 5) niceStep = 5 * magnitude;
  else niceStep = 10 * magnitude;
  const niceMax = Math.ceil(rawMax / niceStep) * niceStep;
  const count = Math.round(niceMax / niceStep);
  return Array.from({ length: count + 1 }, (_, i) => i * niceStep);
}

function MiniChart({
  points,
  series,
  tone,
  axisMode = "adaptive",
}: {
  points: Array<{ label: string; value: number }>;
  series?: Array<{
    key: string;
    label: string;
    color: string;
    points: Array<{ label: string; value: number }>;
  }>;
  tone: "line" | "bar";
  axisMode?: ChartDomainMode;
}) {
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const [tooltipPixel, setTooltipPixel] = useState<{ x: number; y: number } | null>(null);

  // With the other hooks: below the empty-series return this fires only on
  // some renders, which is a hook-order violation React tears the tree down for.
  const handleMouseLeave = useCallback(() => {
    setHoveredIdx(null);
    setTooltipPixel(null);
  }, []);


  const activeSeries = series?.length ? series : [{ key: "default", label: "", color: "#2563eb", points }];
  if (!activeSeries.some((item) => item.points.length > 0)) {
    return <div className="text-xs text-muted-foreground">No chart data yet.</div>;
  }
  const flattened = activeSeries.flatMap((item) => item.points.map((point) => point.value));
  const rawMax = Math.max(...flattened, 1);

  // SVG coordinate space
  const VB_W = 500;
  const VB_H = 160;
  const PAD_LEFT = 42;
  const PAD_RIGHT = 8;
  const PAD_TOP = 16;
  const PAD_BOTTOM = 28;
  const chartW = VB_W - PAD_LEFT - PAD_RIGHT;
  const chartH = VB_H - PAD_TOP - PAD_BOTTOM;

  const niceTicks = computeNiceTicks(rawMax);
  const niceMax = niceTicks[niceTicks.length - 1] ?? rawMax;
  const yTicks = niceTicks.map((val) => ({
    val,
    y: PAD_TOP + chartH - (val / niceMax) * chartH,
  }));

  if (tone === "bar") {
    const labels = activeSeries[0]?.points.map((p) => p.label) ?? [];
    const numSeries = activeSeries.length;
    const groupW = chartW / Math.max(labels.length, 1);
    const barW = (groupW * 0.75) / Math.max(numSeries, 1);
    const groupPad = groupW * 0.125;
    // Each series is scaled independently so small metrics (e.g. ROAS) remain visible
    const seriesMaxMap = new Map(
      activeSeries.map((s) => [s.key, Math.max(...s.points.map((p) => p.value), 1)])
    );
    // Y-axis ticks are based on the largest series only (for reference)
    return (
      <div className="relative w-full h-full flex flex-col">
        <svg
          viewBox={`0 0 ${VB_W} ${VB_H}`}
          className="w-full flex-1 min-h-0"
          preserveAspectRatio="none"
          onMouseMove={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const pxX = e.clientX - rect.left;
            const vbX = (pxX / rect.width) * VB_W;
            let closest = 0, minDist = Infinity;
            labels.forEach((_, i) => {
              const bx = PAD_LEFT + i * groupW + groupW / 2;
              const d = Math.abs(bx - vbX);
              if (d < minDist) { minDist = d; closest = i; }
            });
            setHoveredIdx(closest);
            setTooltipPixel({ x: pxX, y: e.clientY - rect.top });
          }}
          onMouseLeave={handleMouseLeave}
        >
          {/* Y grid lines */}
          {yTicks.map(({ val, y }) => (
            <g key={val}>
              <line x1={PAD_LEFT} y1={y} x2={VB_W - PAD_RIGHT} y2={y} stroke="#e2e8f0" strokeWidth="1" />
              <text x={PAD_LEFT - 4} y={y + 3.5} textAnchor="end" fontSize="9" fill="#94a3b8">
                {formatYLabel(val)}
              </text>
            </g>
          ))}
          {/* X grid lines */}
          {labels
            .filter((_, i) => labels.length <= 8 || i % Math.ceil(labels.length / 8) === 0)
            .map((label, fi) => {
              const i = labels.indexOf(label);
              const x = PAD_LEFT + i * groupW + groupW / 2;
              return (
                <line key={`xg-${fi}`} x1={x} y1={PAD_TOP} x2={x} y2={PAD_TOP + chartH} stroke="#e2e8f0" strokeWidth="1" />
              );
            })}
          {/* Grouped bars — each series scaled to its own max */}
          {labels.map((label, gi) => (
            <g key={label}>
              {activeSeries.map((s, si) => {
                const point = s.points[gi];
                if (!point) return null;
                const sMax = seriesMaxMap.get(s.key) ?? 1;
                const barH = (point.value / sMax) * chartH;
                const x = PAD_LEFT + gi * groupW + groupPad + si * barW;
                const y = PAD_TOP + chartH - barH;
                const isHovered = hoveredIdx === gi;
                return (
                  <rect key={s.key} x={x} y={Math.max(y, PAD_TOP)} width={barW - 1} height={Math.max(barH, 2)} rx="2"
                    fill={s.color} fillOpacity={isHovered ? 1 : 0.75} />
                );
              })}
            </g>
          ))}
          {/* X labels — evenly spaced, max 8 */}
          {labels
            .filter((_, i) => labels.length <= 8 || i % Math.ceil(labels.length / 8) === 0)
            .map((label, fi) => {
              const i = labels.indexOf(label);
              const x = PAD_LEFT + i * groupW + groupW / 2;
              return (
                <text key={fi} x={x} y={VB_H - 4} textAnchor="middle" fontSize="9" fill="#94a3b8">
                  {label}
                </text>
              );
            })}
        </svg>
        {/* Hover tooltip */}
        {hoveredIdx !== null && tooltipPixel !== null && labels[hoveredIdx] ? (
          <ChartTooltip
            label={labels[hoveredIdx]!}
            entries={activeSeries.map((s) => ({ color: s.color, name: s.label, value: s.points[hoveredIdx!]?.value ?? 0 }))}
            pixelX={tooltipPixel.x}
            pixelY={tooltipPixel.y}
          />
        ) : null}
        <div className="mt-2 flex flex-wrap gap-2 text-[10px] text-muted-foreground">
          {activeSeries.map((item) => (
            <span key={item.key} className="inline-flex items-center gap-1 rounded-full bg-[var(--adv-fill-2)] px-2 py-1">
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: item.color }} />
              {item.label}
            </span>
          ))}
          {numSeries > 1 && (
            <span className="rounded-full bg-[var(--adc-caution-bg)] px-2 py-1 text-[var(--adc-caution-fg)]">independently scaled</span>
          )}
        </div>
      </div>
    );
  }

  // Line chart — smart axis grouping
  const allLinePoints = activeSeries[0]?.points ?? [];
  const xLabelStep = allLinePoints.length <= 8 ? 1 : Math.ceil(allLinePoints.length / 8);

  // Group series by order of magnitude. Series within 2 orders of each other share an axis.
  // Left axis = the group with the highest max. Right axis = all other groups (each normalized independently).
  const seriesMaxes = activeSeries.map((s) => Math.max(...s.points.map((p) => p.value), 0));
  const overallMax = Math.max(...seriesMaxes, 1);

  // A series belongs to the "left" group if its max is at least 1/20 of the overall max
  const LEFT_THRESHOLD = overallMax / 20;
  const leftSeries = activeSeries.filter((_, i) => seriesMaxes[i]! >= LEFT_THRESHOLD);
  const rightSeries = activeSeries.filter((_, i) => seriesMaxes[i]! < LEFT_THRESHOLD && seriesMaxes[i]! > 0);
  const dualAxis = rightSeries.length > 0;

  const leftDomain = resolveChartDomain(
    leftSeries.flatMap((s) => s.points.map((p) => p.value)),
    {
      unit: "unknown",
      mode: axisMode,
      detailLevel: "report",
    }
  );
  const leftTicks = computeNiceAxisTicks(leftDomain.min, leftDomain.max, 4);
  const leftNiceMin = leftTicks[0] ?? leftDomain.min;
  const leftNiceMax = leftTicks[leftTicks.length - 1] ?? leftDomain.max;

  const firstRightSeries = rightSeries[0];
  const rightDomain = dualAxis
    ? resolveChartDomain(
        rightSeries.flatMap((s) => s.points.map((p) => p.value)),
        {
          unit: "unknown",
          mode: axisMode,
          detailLevel: "report",
        }
      )
    : null;
  const rightTicks = dualAxis && rightDomain
    ? computeNiceAxisTicks(rightDomain.min, rightDomain.max, 4)
    : [];
  const rightNiceMin = rightTicks[0] ?? rightDomain?.min ?? 0;
  const rightNiceMax = rightTicks[rightTicks.length - 1] ?? rightDomain?.max ?? 1;

  const PAD_RIGHT_AXIS = dualAxis ? 38 : PAD_RIGHT;
  const chartWAdj = VB_W - PAD_LEFT - PAD_RIGHT_AXIS;

  function ptY(value: number, min: number, max: number) {
    const range = max - min || 1;
    return PAD_TOP + chartH - ((value - min) / range) * chartH;
  }
  function ptX(i: number, total: number) {
    return total === 1 ? PAD_LEFT + chartWAdj / 2 : PAD_LEFT + (i / (total - 1)) * chartWAdj;
  }
  function seriesDomain(item: typeof activeSeries[number]) {
    if (!rightSeries.includes(item) || !rightDomain) {
      return { min: leftNiceMin, max: leftNiceMax };
    }
    return { min: rightNiceMin, max: rightNiceMax };
  }

  const hoveredVbX = hoveredIdx !== null && allLinePoints.length > 0
    ? ptX(hoveredIdx, allLinePoints.length)
    : null;

  return (
    <div className="relative w-full h-full flex flex-col">
      <svg
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        className="w-full flex-1 min-h-0"
        preserveAspectRatio="none"
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const pxX = e.clientX - rect.left;
          const vbX = (pxX / rect.width) * VB_W;
          const pts = activeSeries[0]?.points ?? [];
          if (!pts.length) return;
          let closest = 0, minDist = Infinity;
          pts.forEach((_, i) => {
            const d = Math.abs(ptX(i, pts.length) - vbX);
            if (d < minDist) { minDist = d; closest = i; }
          });
          setHoveredIdx(closest);
          setTooltipPixel({ x: pxX, y: e.clientY - rect.top });
        }}
        onMouseLeave={handleMouseLeave}
        style={{ cursor: "crosshair" }}
      >
        {/* Left Y grid lines + labels */}
        {(() => {
          const leftLabelColor = leftSeries.length === 1 ? leftSeries[0]!.color : "#94a3b8";
          return leftTicks.map((val) => {
            const y = ptY(val, leftNiceMin, leftNiceMax);
            return (
              <g key={`ly-${val}`}>
                <line x1={PAD_LEFT} y1={y} x2={VB_W - PAD_RIGHT_AXIS} y2={y} stroke="#e2e8f0" strokeWidth="1" />
                <text x={PAD_LEFT - 4} y={y + 3.5} textAnchor="end" fontSize="9" fill={leftLabelColor}>
                  {formatYLabel(val)}
                </text>
              </g>
            );
          });
        })()}

        {/* Right Y labels — based on first right series only */}
        {dualAxis && firstRightSeries && rightTicks.map((val) => {
          const y = ptY(val, rightNiceMin, rightNiceMax);
          return (
            <text key={`ry-${val}`} x={VB_W - PAD_RIGHT_AXIS + 4} y={y + 3.5}
              textAnchor="start" fontSize="9" fill={firstRightSeries.color}>
              {formatYLabel(val)}
            </text>
          );
        })}

        {/* X axis base line */}
        <line x1={PAD_LEFT} y1={PAD_TOP + chartH} x2={VB_W - PAD_RIGHT_AXIS} y2={PAD_TOP + chartH} stroke="#e2e8f0" strokeWidth="1" />

        {/* X grid lines */}
        {allLinePoints.map((pt, i) => {
          if (i % xLabelStep !== 0) return null;
          const x = ptX(i, allLinePoints.length);
          return <line key={`xg-${pt.label}`} x1={x} y1={PAD_TOP} x2={x} y2={PAD_TOP + chartH} stroke="#e2e8f0" strokeWidth="1" />;
        })}

        {/* Vertical crosshair */}
        {hoveredVbX !== null && (
          <line x1={hoveredVbX} y1={PAD_TOP} x2={hoveredVbX} y2={PAD_TOP + chartH}
            stroke="#94a3b8" strokeWidth="1" strokeDasharray="3 2" />
        )}

        {/* Series lines + dots */}
        {activeSeries.map((item) => {
          const pts = item.points;
          if (!pts.length) return null;
          const itemDomain = seriesDomain(item);
          const coords = pts.map((pt, i) => ({
            x: ptX(i, pts.length),
            y: ptY(pt.value, itemDomain.min, itemDomain.max),
          }));
          const d = coords.map((c, i) => `${i === 0 ? "M" : "L"} ${c.x.toFixed(1)} ${c.y.toFixed(1)}`).join(" ");
          const showDots = pts.length <= 20;
          return (
            <g key={item.key}>
              <path d={d} fill="none" stroke={item.color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              {showDots && coords.map((c, i) => (
                <circle key={i} cx={c.x} cy={c.y} r="2.5" fill="white" stroke={item.color} strokeWidth="1.5" />
              ))}
              {hoveredIdx !== null && coords[hoveredIdx] && (
                <circle cx={coords[hoveredIdx]!.x} cy={coords[hoveredIdx]!.y} r="4"
                  fill="white" stroke={item.color} strokeWidth="2" />
              )}
            </g>
          );
        })}

        {/* X labels */}
        {allLinePoints.map((pt, i) => {
          if (i % xLabelStep !== 0) return null;
          return (
            <text key={pt.label} x={ptX(i, allLinePoints.length)} y={VB_H - 4}
              textAnchor="middle" fontSize="9" fill="#94a3b8">
              {pt.label}
            </text>
          );
        })}
      </svg>

      {/* Hover tooltip */}
      {hoveredIdx !== null && tooltipPixel !== null && allLinePoints[hoveredIdx] ? (
        <ChartTooltip
          label={allLinePoints[hoveredIdx]!.label}
          entries={activeSeries.map((item) => ({
            color: item.color,
            name: item.label,
            value: item.points[hoveredIdx]?.value ?? 0,
          }))}
          pixelX={tooltipPixel.x}
          pixelY={tooltipPixel.y}
        />
      ) : null}

      {activeSeries.length > 1 && (
        <div className="mt-2 flex flex-wrap gap-2 text-[10px] text-muted-foreground shrink-0">
          {activeSeries.map((item) => (
            <span key={item.key} className="inline-flex items-center gap-1 rounded-full bg-[var(--adv-fill-2)] px-2 py-1">
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: item.color }} />
              {item.label}
              {dualAxis && rightSeries.includes(item) && (
                <span className="text-[9px] opacity-50" title="Shared right-axis scale">~</span>
              )}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export function ReportWidgetCard({ widget, embedded }: { widget: RenderedReportWidget; embedded?: boolean }) {
  if (widget.type === "section") {
    return (
      <article className={embedded ? "p-4 h-full" : "rounded-xl border border-[var(--adv-border)] bg-white p-6"}>
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-[var(--adv-ink-4)]">
              Section
            </p>
            <h2 className="mt-2 text-2xl font-semibold tracking-tight text-[var(--adv-ink)]">
              {widget.title}
            </h2>
            {widget.subtitle ? (
              <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--adv-ink-2)]">{widget.subtitle}</p>
            ) : null}
          </div>
        </div>
      </article>
    );
  }

  return (
    <article className={embedded ? "p-4 h-full flex flex-col overflow-hidden" : "rounded-xl border border-[var(--adv-border)] bg-white p-4 h-full flex flex-col"}>
      <div className="flex items-start justify-between gap-3 shrink-0">
        <div>
          <h3 className="text-sm font-semibold text-[var(--adv-ink)]">{widget.title}</h3>
          {widget.subtitle ? (
            <p className="mt-1 text-xs text-[var(--adv-ink-3)]">{widget.subtitle}</p>
          ) : null}
        </div>
        {widget.errorMessage ? (
          <span className="rounded-full bg-[var(--adc-danger-bg)] px-2 py-1 text-[10px] font-medium text-[var(--adc-danger-fg)]">
            Failed to load
          </span>
        ) : widget.warning ? (
          <span className="rounded-full bg-[var(--adc-caution-bg)] px-2 py-1 text-[10px] font-medium text-[var(--adc-caution-fg)]">
            Warning
          </span>
        ) : null}
      </div>

      {widget.type === "metric" ? (
        <div className="mt-6 shrink-0">
          <div className="text-3xl font-semibold tracking-tight text-[var(--adv-ink)]">
            {widget.value ?? "-"}
          </div>
          {widget.deltaLabel ? (
            <div className="mt-2 text-xs text-[var(--adv-ink-3)]">{widget.deltaLabel}</div>
          ) : null}
        </div>
      ) : null}

      {(widget.type === "trend" || widget.type === "bar") && widget.points ? (
        <div className="mt-3 -mx-1 flex-1 min-h-0">
          <MiniChart
            points={widget.points}
            series={widget.series}
            tone={widget.type === "bar" ? "bar" : "line"}
            axisMode={widget.type === "bar" ? "zero_based" : widget.axisMode ?? "adaptive"}
          />
        </div>
      ) : null}

      {widget.type === "table" ? (
        <div className="mt-5 overflow-hidden rounded-xl border flex flex-col min-h-0 flex-1">
          <div className="overflow-auto flex-1">
            <table className="min-w-full text-sm">
              <thead className="bg-[var(--adv-fill)] sticky top-0 z-10">
                <tr>
                  {(widget.columns ?? []).map((column) => (
                    <th
                      key={column}
                      className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-[var(--adv-ink-3)]"
                    >
                      {getColumnLabel(column)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(widget.rows ?? []).map((row, index) => (
                  <tr key={index} className="border-t">
                    {(widget.columns ?? []).map((column) => (
                      <td key={column} className="px-3 py-2 text-[var(--adv-ink-2)]">
                        {String(row[column] ?? "-")}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {widget.type === "text" ? (
        <div className="mt-5 whitespace-pre-wrap text-sm leading-6 text-[var(--adv-ink-2)]">
          {widget.text || "Add commentary, summary, or next steps here."}
        </div>
      ) : null}

      {/* A widget that failed says so. It never borrows the empty-state voice,
          which would read as "this period had no data". */}
      {widget.errorMessage ? (
        <p className="mt-4 text-xs text-[var(--adc-danger-fg)]">{widget.errorMessage}</p>
      ) : (
        <>
          {widget.emptyMessage && !widget.rows?.length && !widget.points?.length && !widget.value ? (
            <p className="mt-4 text-xs text-[var(--adv-ink-4)]">{widget.emptyMessage}</p>
          ) : null}
          {widget.warning ? <p className="mt-4 text-xs text-[var(--adc-caution-fg)]">{widget.warning}</p> : null}
        </>
      )}
    </article>
  );
}

export function ReportCanvas({ report }: { report: RenderedReportPayload }) {
  return (
    <section
      className="grid gap-4"
      style={{ gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gridAutoRows: "minmax(180px, auto)" }}
    >
      {report.widgets.map((widget) => (
        <div key={widget.id} style={slotStyle(widget.slot, widget)} className="h-full">
          <ReportWidgetCard widget={widget} />
        </div>
      ))}
    </section>
  );
}
