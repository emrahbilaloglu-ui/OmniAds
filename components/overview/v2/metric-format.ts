import type { OverviewMetricCardData } from "@/src/types/models";

export const OVERVIEW_MISSING_VALUE = "—";

type MetricIdentity = Pick<OverviewMetricCardData, "id" | "title" | "unit">;

function withUnicodeMinus(value: string) {
  return value.replace(/^-/, "−");
}

function formatNumber(value: number, minimumFractionDigits: number, maximumFractionDigits: number) {
  return Math.abs(value).toLocaleString("en-US", {
    minimumFractionDigits,
    maximumFractionDigits,
  });
}

function signedPrefix(value: number) {
  return value < 0 ? "−" : "";
}

function isLtvToCac(metric: MetricIdentity) {
  const title = metric.title.toLowerCase().replace(/\s+/g, "");
  return metric.id === "ltv-cac" || title === "ltv:cac" || title === "ltv/cac";
}

function formatDuration(value: number) {
  const absolute = Math.abs(value);
  const minutes = Math.floor(absolute / 60);
  const seconds = Math.round(absolute % 60);
  return `${signedPrefix(value)}${minutes}m ${seconds}s`;
}

function formatCurrency(value: number, currencySymbol: string) {
  if (!currencySymbol) return OVERVIEW_MISSING_VALUE;
  const absolute = Math.abs(value);
  const fractionDigits = absolute < 100 ? 2 : 0;
  return `${signedPrefix(value)}${currencySymbol}${formatNumber(absolute, fractionDigits, fractionDigits)}`;
}

function formatThousands(value: number, prefix = "") {
  return `${signedPrefix(value)}${prefix}${(Math.abs(value) / 1_000).toFixed(1)}k`;
}

function formatPercent(value: number) {
  const digits = Math.abs(value) >= 10 ? 1 : 2;
  return `${signedPrefix(value)}${formatNumber(value, digits, digits)}%`;
}

/**
 * Formats real Overview values with the precision and glyphs fixed by the
 * canonical dashboard. It never supplies a fallback number: absent or
 * non-finite input remains an em dash.
 */
export function formatOverviewMetricValue(
  metric: MetricIdentity,
  value: number | null | undefined,
  currencySymbol: string
) {
  if (value == null || !Number.isFinite(value)) return OVERVIEW_MISSING_VALUE;

  if (metric.unit === "currency") return formatCurrency(value, currencySymbol);
  if (metric.unit === "count") {
    return `${signedPrefix(value)}${Math.round(Math.abs(value)).toLocaleString("en-US")}`;
  }
  if (metric.unit === "ratio") {
    return isLtvToCac(metric)
      ? `${signedPrefix(value)}${formatNumber(value, 1, 1)}x`
      : `${signedPrefix(value)}${formatNumber(value, 2, 2)}`;
  }
  if (metric.unit === "percent") return formatPercent(value);
  if (metric.unit === "duration_seconds") return formatDuration(value);
  return withUnicodeMinus(String(value));
}

/** The chart model uses compact daily values while the KPI face stays exact. */
export function formatOverviewSparklineValue(metric: MetricIdentity, value: number, currencySymbol: string) {
  if (!Number.isFinite(value)) return OVERVIEW_MISSING_VALUE;

  const id = metric.id.toLowerCase();
  const integer = `${signedPrefix(value)}${Math.round(Math.abs(value))}`;
  const needsCurrency =
    id === "pins-revenue" ||
    id === "pins-spend" ||
    /^(meta|google)-(spend|revenue|cpa)$/.test(id) ||
    id === "store-aov";
  if (needsCurrency && !currencySymbol) return OVERVIEW_MISSING_VALUE;

  if (id === "pins-revenue") return `${formatThousands(value, currencySymbol)} revenue`;
  if (id === "pins-spend") return `${formatThousands(value, currencySymbol)} spend`;
  if (id === "pins-blended-roas") return `ROAS ${signedPrefix(value)}${formatNumber(value, 2, 2)}`;
  if (id === "pins-orders") return `${integer} orders`;
  if (id === "pins-conversion-rate") return `${signedPrefix(value)}${formatNumber(value, 2, 2)}% CVR`;

  if (/^(meta|google)-(spend|revenue)$/.test(id)) return formatThousands(value, currencySymbol);
  if (/^(meta|google)-purchases$/.test(id) || id === "store-new-customers") return integer;
  if (/^(meta|google)-cpa$/.test(id) || id === "store-aov") {
    return currencySymbol
      ? `${signedPrefix(value)}${currencySymbol}${Math.abs(value).toFixed(2)}`
      : OVERVIEW_MISSING_VALUE;
  }
  if (/^(meta|google)-roas$/.test(id)) return `${signedPrefix(value)}${formatNumber(value, 2, 2)}`;
  if (id === "ltv-repeat-rate" || id === "web-engagement-rate") {
    return `${signedPrefix(value)}${formatNumber(value, 1, 1)}%`;
  }
  if (id === "ltv-cac") return `${signedPrefix(value)}${formatNumber(value, 1, 1)}x`;
  if (id === "web-sessions") return formatThousands(value);
  if (id === "web-session-duration") return formatDuration(value);
  if (id === "web-conversion-rate") return `${signedPrefix(value)}${formatNumber(value, 2, 2)}%`;

  return formatOverviewMetricValue(metric, value, currencySymbol);
}

export function formatOverviewDelta(changePct: number | null | undefined) {
  if (changePct == null || !Number.isFinite(changePct)) return OVERVIEW_MISSING_VALUE;
  const sign = changePct > 0 ? "+" : changePct < 0 ? "−" : "";
  return `${sign}${Math.abs(changePct).toFixed(1)}%`;
}
