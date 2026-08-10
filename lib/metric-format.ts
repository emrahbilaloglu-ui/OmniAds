export type MetricUnit =
  | "currency"
  | "count"
  | "ratio"
  | "percent"
  | "duration_seconds"
  | "unknown";

/**
 * The single rendering for a value we do not have. A missing number is never a
 * zero: a fabricated `0` reads as a real measurement and has caused budget
 * decisions to be made against data that was never there.
 */
export const MISSING_VALUE = "—";

/**
 * Format money from an ISO 4217 currency code.
 *
 * There is deliberately no default currency. Money whose currency is unknown
 * renders as a missing value rather than silently claiming USD, per MR-D064-01
 * (provider currencies must round-trip with no USD or dollar fallback).
 */
export function formatMoneyIso(
  value: number | null | undefined,
  options: { currency: string | null | undefined; locale?: string; compactLarge?: boolean },
): string {
  if (value == null || !Number.isFinite(value)) return MISSING_VALUE;

  const currency = options.currency?.trim().toUpperCase();
  if (!currency || currency.length !== 3) return MISSING_VALUE;

  const locale = options.locale;
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  const compactLarge = options.compactLarge ?? false;

  if (compactLarge && abs >= 1_000) {
    const scaled = abs >= 1_000_000 ? abs / 1_000_000 : abs / 1_000;
    const suffix = abs >= 1_000_000 ? "M" : "K";
    const compact = new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    }).format(scaled);
    return `${sign}${compact}${suffix}`.replace(/^-\s*/, "-");
  }

  const fractionDigits = abs >= 100 ? 0 : 2;
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(value);
}

export function formatCurrencySmart(
  value: number,
  currencySymbol: string,
  options: { compactLarge?: boolean } = {}
): string {
  if (!Number.isFinite(value)) return MISSING_VALUE;

  const compactLarge = options.compactLarge ?? true;
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";

  if (compactLarge && abs >= 1_000_000) {
    return `${sign}${currencySymbol}${(abs / 1_000_000).toFixed(1)}M`;
  }
  if (compactLarge && abs >= 1_000) {
    return `${sign}${currencySymbol}${(abs / 1_000).toFixed(1)}K`;
  }

  const fractionDigits = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
  return `${sign}${currencySymbol}${abs.toLocaleString(undefined, {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  })}`;
}

export function formatPercentSmart(value: number): string {
  if (!Number.isFinite(value)) return MISSING_VALUE;

  const abs = Math.abs(value);
  const fractionDigits = abs >= 10 ? 1 : abs >= 1 ? 1 : 2;
  return `${value.toLocaleString(undefined, {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  })}%`;
}

export function formatPercentFromRatioSmart(value: number): string {
  if (!Number.isFinite(value)) return MISSING_VALUE;
  return formatPercentSmart(value * 100);
}

export function formatMetricValue(
  value: number | null,
  unit: MetricUnit,
  currencySymbol: string
): string {
  if (value === null || !Number.isFinite(value)) return MISSING_VALUE;
  if (unit === "currency") return formatCurrencySmart(value, currencySymbol);
  if (unit === "count") return Math.round(value).toLocaleString();
  if (unit === "ratio") return value.toFixed(2);
  if (unit === "percent") return formatPercentSmart(value);
  if (unit === "duration_seconds") return `${Math.round(value)}s`;
  return String(value);
}
