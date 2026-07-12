const CURRENCY_CODE_REGEX = /^[A-Z]{3}$/;
const CURRENCY_DEBUG_ENV_KEY = "NEXT_PUBLIC_CREATIVE_CURRENCY_DEBUG";
export const CURRENCY_UNAVAILABLE_LABEL = "Currency unavailable";

const CURRENCY_LOCALE_MAP: Record<string, string> = {
  TRY: "tr-TR",
  USD: "en-US",
  EUR: "de-DE",
  GBP: "en-GB",
};

const seenCurrencyDebugKeys = new Set<string>();

export function normalizeCurrencyCode(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;

  const code = value.trim().toUpperCase();
  return CURRENCY_CODE_REGEX.test(code) ? code : null;
}

function shouldLogCurrencyDebug(): boolean {
  return (
    process.env.NODE_ENV !== "production" &&
    process.env[CURRENCY_DEBUG_ENV_KEY] === "1"
  );
}

export function resolveCreativeCurrency(
  rowCurrency: string | null | undefined,
  defaultCurrency: string | null | undefined
): string | null {
  const normalizedRowCurrency = normalizeCurrencyCode(rowCurrency);
  if (normalizedRowCurrency) return normalizedRowCurrency;

  const normalizedDefaultCurrency = normalizeCurrencyCode(defaultCurrency);
  return normalizedDefaultCurrency ?? null;
}

function resolveCurrencyLocale(currency: string): string | undefined {
  return CURRENCY_LOCALE_MAP[currency] ?? undefined;
}

function logCurrencyDebug(
  rowCurrency: string | null | undefined,
  defaultCurrency: string | null | undefined,
  resolvedCurrency: string | null
): void {
  if (!shouldLogCurrencyDebug()) return;

  const debugKey = `${rowCurrency ?? "null"}|${defaultCurrency ?? "null"}|${resolvedCurrency ?? "null"}`;
  if (seenCurrencyDebugKeys.has(debugKey)) return;

  seenCurrencyDebugKeys.add(debugKey);

  console.log("[creatives] currency formatter", {
    row_currency: rowCurrency ?? null,
    default_currency: defaultCurrency ?? null,
    resolved_currency: resolvedCurrency,
  });
}

export function formatMoney(
  value: number,
  rowCurrency: string | null | undefined,
  defaultCurrency: string | null | undefined
): string {
  const resolvedCurrency = resolveCreativeCurrency(rowCurrency, defaultCurrency);

  logCurrencyDebug(rowCurrency, defaultCurrency, resolvedCurrency);

  if (!resolvedCurrency) {
    const unitless = value.toLocaleString(undefined, {
      maximumFractionDigits: 2,
    });
    return `${unitless} (${CURRENCY_UNAVAILABLE_LABEL})`;
  }

  return value.toLocaleString(resolveCurrencyLocale(resolvedCurrency), {
    style: "currency",
    currency: resolvedCurrency,
    maximumFractionDigits: 2,
  });
}
