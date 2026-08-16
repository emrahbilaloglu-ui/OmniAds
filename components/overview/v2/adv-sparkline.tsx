"use client";

import { useId, useState } from "react";

export interface SparkPoint {
  date: string;
  value: number;
}

/** Design geometry: a 100×26 user-space box with the series inset to 3…23. */
const VB_W = 100;
const VB_H = 26;
const Y_TOP = 3;
const Y_SPAN = 20;

/**
 * Both series share one scale so the dashed comparison reads against the same
 * baseline as the current period — scaling them independently would make a
 * lower previous period look identical to the current one.
 */
function buildGeometry(points: SparkPoint[], previous?: SparkPoint[]) {
  const values = points.map((point) => point.value);
  const previousValues = (previous ?? []).map((point) => point.value);
  const scaleValues = [...values, ...previousValues];
  const min = Math.min(...scaleValues);
  const max = Math.max(...scaleValues);
  const step = points.length > 1 ? VB_W / (points.length - 1) : VB_W;
  const project = (value: number) => {
    const normalized = max === min ? 0.5 : (value - min) / (max - min);
    return Y_TOP + Y_SPAN - normalized * Y_SPAN;
  };
  const toPath = (series: number[], seriesStep: number) =>
    series
      .map((value, index) =>
        `${index ? "L" : "M"}${(index * seriesStep).toFixed(1)} ${project(value).toFixed(1)}`,
      )
      .join(" ");

  const ys = values.map(project);
  const path = toPath(values, step);
  const previousPath =
    previousValues.length > 1
      ? toPath(previousValues, VB_W / (previousValues.length - 1))
      : null;
  return { ys, step, path, previousPath, area: `${path} L${VB_W} ${VB_H} L0 ${VB_H} Z` };
}

function formatDay(iso: string) {
  const parsed = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export interface AdvSparklineProps {
  points: SparkPoint[];
  /** Optional previous-period series, drawn as the design's dashed comparison. */
  previousPoints?: SparkPoint[];
  /** Stroke colour for the trend line and the hover dot. */
  line: string;
  /** Fill under the line. */
  fill: string;
  height: number;
  /** Formats the hovered value for the tooltip. */
  format: (value: number) => string;
  /** Inverted styling for the accent hero card. */
  tone?: "light" | "dark";
  strokeWidth?: number;
  ariaLabel?: string;
}

/**
 * The scrubbing sparkline the design uses on every metric surface: an area
 * chart with a crosshair, a point marker and a value tooltip that follow the
 * pointer. Renders nothing when the series is empty so a missing trend stays
 * blank instead of drawing a fabricated flat line.
 */
export function AdvSparkline({
  points,
  previousPoints,
  line,
  fill,
  height,
  format,
  tone = "dark",
  strokeWidth = 1.5,
  ariaLabel,
}: AdvSparklineProps) {
  const [hover, setHover] = useState<number | null>(null);
  const id = useId();

  if (points.length < 2) {
    return <div style={{ height }} aria-hidden="true" />;
  }

  const { ys, step, path, previousPath, area } = buildGeometry(points, previousPoints);
  const index = hover ?? points.length - 1;
  const leftPct = `${((index * step) / VB_W) * 100}%`;
  const boxLeftPct = `${Math.max(16, Math.min(84, ((index * step) / VB_W) * 100))}%`;
  const dotTopPct = `${(ys[index]! / VB_H) * 100}%`;
  const light = tone === "light";

  function handleMove(event: React.MouseEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width === 0) return;
    const ratio = (event.clientX - rect.left) / rect.width;
    const next = Math.max(
      0,
      Math.min(points.length - 1, Math.round(ratio * (points.length - 1))),
    );
    setHover((current) => (current === next ? current : next));
  }

  return (
    <div className="relative" style={{ marginTop: 0 }}>
      <svg
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        preserveAspectRatio="none"
        style={{ display: "block", width: "100%", height }}
        role="img"
        aria-label={ariaLabel}
        aria-describedby={id}
      >
        <path d={area} fill={fill} />
        {previousPath ? (
          <path
            d={previousPath}
            fill="none"
            stroke={light ? "rgba(255,255,255,0.55)" : "#98A4BA"}
            strokeWidth={light ? 1.2 : 1.1}
            strokeDasharray="3 3"
            opacity={light ? 1 : 0.85}
            vectorEffect="non-scaling-stroke"
          />
        ) : null}
        <path
          d={path}
          fill="none"
          stroke={line}
          strokeWidth={strokeWidth}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      {hover !== null ? (
        <>
          <span
            style={{
              position: "absolute",
              top: 0,
              bottom: 0,
              left: leftPct,
              width: 1,
              background: light ? "rgba(255,255,255,0.6)" : "var(--adv-scroll-thumb)",
              pointerEvents: "none",
            }}
          />
          <span
            style={{
              position: "absolute",
              left: leftPct,
              top: dotTopPct,
              width: light ? 9 : 8,
              height: light ? 9 : 8,
              borderRadius: 9999,
              background: light ? "#ffffff" : line,
              border: light ? "2px solid rgba(30,79,214,0.9)" : "2px solid #ffffff",
              transform: "translate(-50%,-50%)",
              pointerEvents: "none",
              boxShadow: light ? undefined : "0 1px 4px rgba(11,16,32,0.3)",
            }}
          />
          <span
            id={id}
            style={{
              position: "absolute",
              left: boxLeftPct,
              bottom: "calc(100% + 6px)",
              transform: "translateX(-50%)",
              whiteSpace: "nowrap",
              borderRadius: 7,
              background: light ? "#ffffff" : "var(--adv-rail)",
              color: light ? "var(--adv-ink)" : "#ffffff",
              padding: "4px 9px",
              fontSize: light ? 11.5 : 11,
              fontWeight: 600,
              fontVariantNumeric: "tabular-nums",
              boxShadow: light
                ? "0 6px 18px rgba(11,16,32,0.35)"
                : "0 6px 16px rgba(11,16,32,0.3)",
              pointerEvents: "none",
              zIndex: 2,
            }}
          >
            {formatDay(points[index]!.date)} · {format(points[index]!.value)}
          </span>
        </>
      ) : null}
      <div
        onMouseMove={handleMove}
        onMouseLeave={() => setHover(null)}
        style={{ position: "absolute", inset: 0, cursor: "crosshair" }}
      />
    </div>
  );
}
