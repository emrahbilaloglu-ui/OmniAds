"use client";

/** Spend and platform-attributed ROAS in one compact, interactive chart. */
import { useMemo, useState } from "react";
import { useCopy } from "@/components/zero-base/i18n/copy-provider";
import styles from "./trend-panel.module.css";

export interface TrendPoint {
  date: string;
  /** Null means missing data, never zero. */
  spend: number | null;
  /** Null means the return could not be derived for the day. */
  roas: number | null;
}

const PLOT_HEIGHT = 200;
const AXIS_INTERVALS = 3;

function formatSpend(value: number, currency: string | null): string {
  if (!currency) return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return `${value.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${currency}`;
  }
}

function formatSpendTick(value: number, currency: string | null): string {
  const options: Intl.NumberFormatOptions = {
    notation: value >= 1_000 ? "compact" : "standard",
    maximumFractionDigits: value >= 1_000 ? 1 : 0,
  };
  if (!currency) return new Intl.NumberFormat(undefined, options).format(value);
  try {
    return new Intl.NumberFormat(undefined, { ...options, style: "currency", currency }).format(value);
  } catch {
    return `${new Intl.NumberFormat(undefined, options).format(value)} ${currency}`;
  }
}

function shortDate(value: string): string {
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function niceStep(rawStep: number): number {
  if (!Number.isFinite(rawStep) || rawStep <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  const nice = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10;
  return nice * magnitude;
}

function buildAxis(maxValue: number): { max: number; ticks: number[] } {
  if (!Number.isFinite(maxValue) || maxValue <= 0) {
    return { max: 1, ticks: [0, 1 / 3, 2 / 3, 1] };
  }
  const step = niceStep(maxValue / AXIS_INTERVALS);
  const max = Math.ceil(maxValue / step) * step;
  return {
    max,
    ticks: Array.from({ length: Math.round(max / step) + 1 }, (_, index) => index * step),
  };
}

function xTickIndexes(length: number): number[] {
  if (length <= 0) return [];
  if (length <= 5) return Array.from({ length }, (_, index) => index);
  return Array.from(
    new Set([
      0,
      Math.round((length - 1) * 0.25),
      Math.round((length - 1) * 0.5),
      Math.round((length - 1) * 0.75),
      length - 1,
    ]),
  );
}

export function TrendPanel({
  title,
  points,
  currency,
  targetRoas,
  surface,
}: {
  title: string;
  points: readonly TrendPoint[];
  currency: string | null;
  targetRoas: number | null;
  surface: string;
}) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const copy = useCopy();
  const chart = useMemo(() => {
    const spends = points.map((point) => point.spend).filter((value): value is number => value !== null);
    const roasValues = points.map((point) => point.roas).filter((value): value is number => value !== null);
    return {
      spendAxis: buildAxis(Math.max(...spends, 0)),
      roasAxis: buildAxis(Math.max(...roasValues, targetRoas ?? 0, 0)),
      hasData: spends.length > 0 || roasValues.length > 0,
      xTicks: xTickIndexes(points.length),
    };
  }, [points, targetRoas]);

  return (
    <section data-trend-panel={surface} aria-label={title} className={styles.panel}>
      <div data-trend-chart="" aria-label={`${title}: spend bars and ROAS line`} className={styles.chart}>
        <div className={styles.legend} aria-hidden="true">
          <span><i className={styles.spendSwatch} />Spend ({currency ?? "currency unknown"})</span>
          <span><i className={styles.roasSwatch} />ROAS</span>
          {targetRoas !== null ? <span><i className={styles.targetSwatch} />Target {targetRoas.toFixed(2)}x</span> : null}
        </div>

        {!chart.hasData ? (
          <div className={styles.emptyState}>
            <strong>No daily trend data</strong>
            <span>Spend and ROAS will appear here when the selected period has source data.</span>
          </div>
        ) : (
          <div className={styles.chartFrame}>
            <div className={styles.axisTitleLeft} aria-hidden="true">Spend</div>
            <div className={styles.axisTitleRight} aria-hidden="true">ROAS</div>

            <div className={styles.leftAxis} aria-hidden="true">
              {chart.spendAxis.ticks.map((tick) => (
                <span key={tick} style={{ bottom: `${(tick / chart.spendAxis.max) * 100}%` }}>
                  {formatSpendTick(tick, currency)}
                </span>
              ))}
            </div>

            <div className={styles.plot}>
              {chart.spendAxis.ticks.map((tick) => (
                <span
                  key={tick}
                  className={styles.gridLine}
                  style={{ bottom: `${(tick / chart.spendAxis.max) * 100}%` }}
                />
              ))}

              {targetRoas !== null ? (
                <>
                  <span
                    className={styles.targetLine}
                    style={{ bottom: `${Math.min(100, (targetRoas / chart.roasAxis.max) * 100)}%` }}
                  />
                  <span
                    className={styles.targetPill}
                    style={{
                      bottom: `clamp(4px, calc(${Math.min(100, (targetRoas / chart.roasAxis.max) * 100)}% + 5px), calc(100% - 23px))`,
                    }}
                  >
                    Target {targetRoas.toFixed(2)}x
                  </span>
                </>
              ) : null}

              <div className={styles.bars}>
                {points.map((point, index) => {
                  const height = point.spend === null ? 0 : (point.spend / chart.spendAxis.max) * 100;
                  const label = `${point.date}; spend ${point.spend === null ? "no data" : formatSpend(point.spend, currency)}; ROAS ${point.roas === null ? "no data" : `${point.roas.toFixed(2)}x`}`;
                  return (
                    <button
                      type="button"
                      key={point.date}
                      data-trend-bar={point.date}
                      data-active={activeIndex === index ? "true" : undefined}
                      aria-label={label}
                      onMouseEnter={() => setActiveIndex(index)}
                      onMouseLeave={() => setActiveIndex(null)}
                      onFocus={() => setActiveIndex(index)}
                      onBlur={() => setActiveIndex(null)}
                      className={styles.barSlot}
                    >
                      {point.spend === null ? (
                        <span className={styles.missingMark} aria-hidden="true" />
                      ) : (
                        <span
                          className={styles.bar}
                          style={{ height: `${Math.max(height, point.spend === 0 ? 1 : 2)}%` }}
                          aria-hidden="true"
                        />
                      )}
                    </button>
                  );
                })}
              </div>

              <svg
                aria-hidden="true"
                viewBox={`0 0 1000 ${PLOT_HEIGHT}`}
                preserveAspectRatio="none"
                className={styles.lineChart}
              >
                {points.slice(1).map((point, index) => {
                  const previous = points[index];
                  if (previous.roas === null || point.roas === null) return null;
                  return (
                    <line
                      key={`${previous.date}-${point.date}`}
                      x1={((index + 0.5) / Math.max(points.length, 1)) * 1000}
                      y1={PLOT_HEIGHT - (previous.roas / chart.roasAxis.max) * PLOT_HEIGHT}
                      x2={((index + 1.5) / Math.max(points.length, 1)) * 1000}
                      y2={PLOT_HEIGHT - (point.roas / chart.roasAxis.max) * PLOT_HEIGHT}
                      className={styles.roasLine}
                    />
                  );
                })}
                {points.map((point, index) => point.roas === null ? null : (
                  <circle
                    key={point.date}
                    cx={((index + 0.5) / Math.max(points.length, 1)) * 1000}
                    cy={PLOT_HEIGHT - (point.roas / chart.roasAxis.max) * PLOT_HEIGHT}
                    r={activeIndex === index ? 5 : 3.25}
                    className={activeIndex === index ? styles.roasPointActive : styles.roasPoint}
                  />
                ))}
              </svg>

              {activeIndex !== null && points[activeIndex] ? (
                <>
                  <span
                    className={styles.activeGuide}
                    aria-hidden="true"
                    style={{ left: `${((activeIndex + 0.5) / Math.max(points.length, 1)) * 100}%` }}
                  />
                  <div
                    role="tooltip"
                    data-trend-tooltip=""
                    className={styles.tooltip}
                    style={{
                      left: `clamp(94px, ${((activeIndex + 0.5) / Math.max(points.length, 1)) * 100}%, calc(100% - 94px))`,
                      top: `clamp(8px, calc(${(1 - Math.max(
                        points[activeIndex].spend === null ? 0 : points[activeIndex].spend / chart.spendAxis.max,
                        points[activeIndex].roas === null ? 0 : points[activeIndex].roas / chart.roasAxis.max,
                      )) * 100}% - 92px), calc(100% - 96px))`,
                    }}
                  >
                    <div
                      className={styles.tooltipDate}
                      data-trend-tooltip-date=""
                      data-date={points[activeIndex].date}
                    >
                      {shortDate(points[activeIndex].date)}
                    </div>
                    <span><i className={styles.spendDot} />{copy.spend}<strong>{points[activeIndex].spend === null ? "No data" : formatSpend(points[activeIndex].spend, currency)}</strong></span>
                    <span><i className={styles.roasDot} />ROAS<strong>{points[activeIndex].roas === null ? "No data" : `${points[activeIndex].roas.toFixed(2)}x`}</strong></span>
                    {targetRoas !== null && points[activeIndex].roas !== null ? (
                      <small>{Math.abs(points[activeIndex].roas - targetRoas).toFixed(2)}x {points[activeIndex].roas >= targetRoas ? "above" : "below"} target</small>
                    ) : null}
                  </div>
                </>
              ) : null}
            </div>

            <div className={styles.rightAxis} aria-hidden="true">
              {chart.roasAxis.ticks.map((tick) => (
                <span key={tick} style={{ bottom: `${(tick / chart.roasAxis.max) * 100}%` }}>
                  {tick.toFixed(tick % 1 === 0 ? 0 : 1)}x
                </span>
              ))}
            </div>

            <div className={styles.xAxis} aria-hidden="true">
              {chart.xTicks.map((index, tickPosition) => (
                <span
                  key={points[index].date}
                  data-edge={tickPosition === 0 ? "start" : tickPosition === chart.xTicks.length - 1 ? "end" : undefined}
                  data-intermediate={tickPosition > 0 && tickPosition < chart.xTicks.length - 1 ? "true" : undefined}
                  style={{ left: `${((index + 0.5) / Math.max(points.length, 1)) * 100}%` }}
                >
                  {shortDate(points[index].date)}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
