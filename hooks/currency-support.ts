import type { Business } from "@/store/app-store";

export const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: "$",
  EUR: "€",
  GBP: "£",
  TRY: "₺",
  JPY: "¥",
  CAD: "CA$",
  AUD: "A$",
  CHF: "Fr",
  SEK: "kr",
  NOK: "kr",
  DKK: "kr",
  PLN: "zł",
  CZK: "Kč",
  HUF: "Ft",
  RON: "lei",
  BRL: "R$",
  MXN: "MX$",
  INR: "₹",
  ZAR: "R",
  AED: "د.إ",
  SAR: "﷼",
};

/**
 * The symbol for the selected workspace's configured currency, or `null` when
 * the workspace has not configured one.
 *
 * There is deliberately no default. This returned `"$"` for every workspace
 * without a configured currency (`business?.currency ?? "USD"`), which is the
 * exact substitution INVARIANTS.md forbids: "Missing currency must not
 * silently become USD, $, TRY, or EUR." Callers must render `MISSING_VALUE`
 * for the whole money value rather than pair a real number with a guessed
 * symbol — a wrong symbol is a wrong measurement, not a cosmetic default.
 */
export function resolveCurrencySymbol(
  businesses: Business[],
  selectedBusinessId: string | null
): string | null {
  const business = businesses.find((entry) => entry.id === selectedBusinessId);
  const code = business?.currency?.trim().toUpperCase();
  if (!code) return null;
  return CURRENCY_SYMBOLS[code] ?? code;
}
