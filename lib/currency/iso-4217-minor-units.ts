/**
 * D081-C — versioned ISO-4217 minor-unit authority.
 *
 * D080B proved that no column anywhere in the schema names a currency
 * exponent, minor unit, currency scale or currency decimal, so
 * `unit_exponent_unknown` blocked 100% of 247,050 historical proposals. The
 * repository invariant asserts Meta budget values are provider minor units,
 * but an assertion is not a per-currency exponent: JPY has exponent 0 and KWD
 * has exponent 3, so a blanket `/100` is wrong for both.
 *
 * This module is the missing authority. It is provider-neutral, versioned, and
 * fails closed: a currency it does not know cannot be converted at all, rather
 * than silently defaulting to two decimals.
 */

/** Bumped whenever an entry changes, and bound into every intent that used it. */
export const ISO_4217_REGISTRY_VERSION = "iso4217.minor-units.2026-09-01" as const;
export const ISO_4217_REGISTRY_SOURCE =
  "ISO 4217 published minor units, transcribed per currency. No exponent is inferred from another currency." as const;

export type MinorUnitExponent = 0 | 2 | 3;

interface RegistryEntry {
  exponent: MinorUnitExponent;
  /** Present only for codes that must never be silently accepted. */
  retired?: string;
}

/**
 * Exponents are transcribed per code. The registry deliberately does NOT cover
 * every ISO code: an absent code fails closed, which is correct, whereas a
 * guessed exponent is a silent 100x error in live money.
 */
const REGISTRY: Readonly<Record<string, RegistryEntry>> = Object.freeze({
  // --- zero-decimal ---
  BIF: { exponent: 0 }, CLP: { exponent: 0 }, DJF: { exponent: 0 }, GNF: { exponent: 0 },
  ISK: { exponent: 0 }, JPY: { exponent: 0 }, KMF: { exponent: 0 }, KRW: { exponent: 0 },
  PYG: { exponent: 0 }, RWF: { exponent: 0 }, UGX: { exponent: 0 }, UYI: { exponent: 0 },
  VND: { exponent: 0 }, VUV: { exponent: 0 }, XAF: { exponent: 0 }, XOF: { exponent: 0 },
  XPF: { exponent: 0 },
  // --- three-decimal ---
  BHD: { exponent: 3 }, IQD: { exponent: 3 }, JOD: { exponent: 3 }, KWD: { exponent: 3 },
  LYD: { exponent: 3 }, OMR: { exponent: 3 }, TND: { exponent: 3 },
  // --- two-decimal (the common case, still transcribed, never assumed) ---
  AED: { exponent: 2 }, ARS: { exponent: 2 }, AUD: { exponent: 2 }, BGN: { exponent: 2 },
  BRL: { exponent: 2 }, CAD: { exponent: 2 }, CHF: { exponent: 2 }, CNY: { exponent: 2 },
  COP: { exponent: 2 }, CZK: { exponent: 2 }, DKK: { exponent: 2 }, EGP: { exponent: 2 },
  EUR: { exponent: 2 }, GBP: { exponent: 2 }, HKD: { exponent: 2 }, HUF: { exponent: 2 },
  IDR: { exponent: 2 }, ILS: { exponent: 2 }, INR: { exponent: 2 }, MAD: { exponent: 2 },
  MXN: { exponent: 2 }, MYR: { exponent: 2 }, NGN: { exponent: 2 }, NOK: { exponent: 2 },
  NZD: { exponent: 2 }, PEN: { exponent: 2 }, PHP: { exponent: 2 }, PLN: { exponent: 2 },
  QAR: { exponent: 2 }, RON: { exponent: 2 }, RSD: { exponent: 2 }, SAR: { exponent: 2 },
  SEK: { exponent: 2 }, SGD: { exponent: 2 }, THB: { exponent: 2 }, TRY: { exponent: 2 },
  TWD: { exponent: 2 }, UAH: { exponent: 2 }, USD: { exponent: 2 }, ZAR: { exponent: 2 },
  // --- retired or ambiguous: named so they fail LOUDLY, not silently ---
  TRL: { exponent: 2, retired: "redenominated to TRY in 2005; a TRL amount is not a TRY amount" },
  ROL: { exponent: 2, retired: "redenominated to RON in 2005" },
  ZWD: { exponent: 2, retired: "withdrawn; no stable minor unit" },
});

export type ExponentResolution =
  | {
      status: "resolved";
      currency: string;
      exponent: MinorUnitExponent;
      registryVersion: typeof ISO_4217_REGISTRY_VERSION;
      registrySource: typeof ISO_4217_REGISTRY_SOURCE;
    }
  | { status: "unknown_currency"; currency: string | null; reason: string }
  | { status: "retired_currency"; currency: string; reason: string };

/**
 * Resolves a currency to its exponent, or refuses. There is no default branch:
 * an unlisted code is `unknown_currency`, never "probably two".
 */
export function resolveMinorUnitExponent(currency: unknown): ExponentResolution {
  if (typeof currency !== "string") {
    return { status: "unknown_currency", currency: null, reason: "currency is not a string" };
  }
  const code = currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) {
    return { status: "unknown_currency", currency: code || null, reason: "not a three-letter ISO 4217 alphabetic code" };
  }
  const entry = REGISTRY[code];
  if (!entry) {
    return { status: "unknown_currency", currency: code, reason: "no transcribed ISO 4217 minor unit for this code; refusing rather than assuming two decimals" };
  }
  if (entry.retired) {
    return { status: "retired_currency", currency: code, reason: entry.retired };
  }
  return {
    status: "resolved", currency: code, exponent: entry.exponent,
    registryVersion: ISO_4217_REGISTRY_VERSION, registrySource: ISO_4217_REGISTRY_SOURCE,
  };
}

/** Every code the registry can resolve. Retired codes are excluded. */
export function knownCurrencies(): string[] {
  return Object.entries(REGISTRY).filter(([, e]) => !e.retired).map(([code]) => code).sort();
}

/** The largest minor-unit amount this module will handle, kept inside 2^53-1. */
export const MAX_MINOR_UNITS = 9_007_199_254_740_990;

export type MinorUnitResult =
  | { status: "ok"; minorUnits: number; roundingApplied: boolean; roundingRule: "half_up_away_from_zero" }
  | { status: "invalid"; reason: string };

/**
 * Applies a percentage to an integer minor-unit amount.
 *
 * Money never touches floating-point equality here: the percentage is applied
 * as an integer ratio and the single rounding step is explicit, recorded, and
 * half-up away from zero so a +10% and a -10% of the same base round
 * symmetrically rather than drifting toward zero.
 */
export function applyPercentToMinorUnits(
  currentMinorUnits: number,
  percent: number,
  direction: "increase" | "decrease",
): MinorUnitResult {
  if (!Number.isInteger(currentMinorUnits)) {
    return { status: "invalid", reason: "the current amount is not an integer number of minor units" };
  }
  if (currentMinorUnits <= 0) {
    return { status: "invalid", reason: "the current amount must be a positive number of minor units" };
  }
  if (currentMinorUnits > MAX_MINOR_UNITS) {
    return { status: "invalid", reason: "the current amount exceeds the safe integer range for minor units" };
  }
  if (!Number.isFinite(percent) || !Number.isInteger(percent) || percent <= 0 || percent >= 100_000) {
    return { status: "invalid", reason: "the percentage must be a positive whole number below 100000" };
  }
  const signed = direction === "increase" ? percent : -percent;
  // numerator/denominator keeps the arithmetic in integers until one rounding.
  const numerator = currentMinorUnits * (100 + signed);
  if (!Number.isSafeInteger(numerator)) {
    return { status: "invalid", reason: "the proposed amount overflows the safe integer range" };
  }
  const exact = numerator / 100;
  const rounded = Math.sign(exact) * Math.round(Math.abs(exact));
  if (rounded <= 0) {
    return { status: "invalid", reason: "the proposed amount rounds to zero or below, which is not a budget" };
  }
  if (rounded > MAX_MINOR_UNITS) {
    return { status: "invalid", reason: "the proposed amount exceeds the safe integer range for minor units" };
  }
  return {
    status: "ok", minorUnits: rounded,
    roundingApplied: rounded * 100 !== numerator,
    roundingRule: "half_up_away_from_zero",
  };
}

/**
 * Formats minor units for display only. Never used for comparison, and never
 * fed back into arithmetic.
 */
export function formatMinorUnitsForDisplay(minorUnits: number, exponent: MinorUnitExponent): string {
  const negative = minorUnits < 0;
  const digits = String(Math.abs(minorUnits)).padStart(exponent + 1, "0");
  const whole = exponent === 0 ? digits : digits.slice(0, digits.length - exponent);
  const frac = exponent === 0 ? "" : `.${digits.slice(digits.length - exponent)}`;
  return `${negative ? "-" : ""}${whole}${frac}`;
}
