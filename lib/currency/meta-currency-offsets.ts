/**
 * Meta's OWN per-currency offset — the provider's answer, not ISO's.
 *
 * ## Why this exists beside `iso-4217-minor-units.ts`
 *
 * That module resolves the ISO-4217 minor-unit exponent and opens by saying
 * "The repository invariant asserts Meta budget values are provider minor
 * units". The first half is right and the second half is the trap: a PROVIDER
 * minor unit is defined by the PROVIDER, and Meta publishes its own table.
 *
 * Meta's number is an `offset`, and it is a MULTIPLIER, not an exponent. The
 * page states the mechanic with two worked examples: a bid of 1 on a USD
 * account (offset 100) is 0.01 USD, and a bid of 1 on a JPY account (offset 1)
 * is 1 JPY. So `10 ** offset` is not merely wrong, it is catastrophic — it
 * would raise 10 to the 100th power.
 *
 *   — https://developers.facebook.com/docs/marketing-api/currencies/
 *
 * ## The transcription, and a correction to what this file used to claim
 *
 * Re-verified 2026-09-22 by two independent reads of the page, and the reading
 * is now COMPLETE: the table has **66 rows** and all 66 are here. Both reads
 * returned the identical offset-1 set and neither found any offset other than
 * 1 or 100.
 *
 * An earlier version of this note said the page "states it lists 103
 * currencies" and that 66 of them had been transcribed. **That was wrong on
 * both halves.** The page states no count at all, and 66 was never a partial
 * reading — it was the whole table minus one row (FBZ, below). The claim was
 * not in the source; it should not have been written down as if it were.
 *
 * ## What an absent code now means
 *
 * This matters more than it looks. While the transcription was believed
 * partial, a code missing from this registry meant only "nobody transcribed
 * it". Now the registry is the page, so a missing code means the page does not
 * list it — and the page introduces its table as covering the currencies ad
 * accounts support.
 *
 * That upgrades the refusals below from caution to evidence. Callers must still
 * render an absence rather than a number, for the same reason as before: a
 * guessed offset is a silent 100x error in live money, a missing amount is a
 * visible gap.
 *
 * ## Where Meta and ISO disagree, transcribed rather than assumed
 *
 * Meta offset 1 while `iso-4217-minor-units.ts` has exponent 2 — reading the
 * ISO value would divide by 100 that should not be divided at all:
 *
 *     COP, HUF, IDR, TWD
 *
 * CRC is Meta offset 1 and absent from the ISO registry, so it is not a
 * divergence: the ISO path already fails closed there. It is listed in this
 * registry because Meta does serve it. FBZ is a second such code.
 *
 * Meta offset 100 while the ISO registry has exponent 3 — a tenfold error:
 *
 *     BHD, JOD
 *
 * Meta lists no offset above 100 at all, which is the structural reason the
 * three-decimal ISO codes cannot be carried over. The ISO registry also holds
 * KWD, OMR, TND, IQD and LYD at exponent 3 and Meta's table does not list them,
 * so this module refuses them.
 *
 * The currencies this product actually runs today — USD, TRY, GBP — agree
 * between the two authorities, and so do JPY and KRW. The divergence is latent,
 * not currently active, and it is written down here so it stays that way.
 */

/** Bumped whenever an entry changes, and reportable beside any converted value. */
export const META_CURRENCY_OFFSET_REGISTRY_VERSION =
  "meta.currency-offsets.2026-09-22.2" as const;
export const META_CURRENCY_OFFSET_SOURCE =
  "https://developers.facebook.com/docs/marketing-api/currencies/ — complete transcription of all 66 table rows, re-verified 2026-09-22 by two independent reads. An absent code is refused, never defaulted." as const;

/** Meta publishes exactly two offsets. There is no 1000. */
export type MetaCurrencyOffset = 1 | 100;

/**
 * Codes Meta lists with offset 1: the stored integer IS whole units.
 *
 * Read twice, independently, on 2026-09-22 and identical both times — 11 codes
 * both times. Four of these — COP, HUF, IDR, TWD — are exponent 2 in the ISO
 * registry, which is the 100x divergence this module exists to stop. CRC is a
 * fifth offset-1 code that the ISO registry does not hold at all.
 */
const OFFSET_ONE = [
  "CLP", "COP", "CRC", "HUF", "IDR", "ISK", "JPY", "KRW", "PYG", "TWD", "VND",
] as const;

/**
 * Codes Meta lists with offset 100 — the other 55 rows, and the whole rest of
 * the table.
 *
 * BHD and JOD are here deliberately: the ISO registry calls them exponent 3 and
 * Meta calls them 100.
 *
 * FBZ is here on the source's own authority, not because it is plausible. Its
 * Name column reads "credits" — Facebook Credits, the virtual currency retired
 * in September 2013 — and it is not an ISO-4217 code. It was left out of the
 * first transcription as an obvious non-currency, which is exactly the kind of
 * silent editorial judgement this registry must not make: the page introduces
 * the table as the currencies ad accounts support, lists FBZ in it, and
 * publishes 100 for it. Nothing on the page marks any row as unusable. Since
 * the exclusion cannot be proved from the source and the source affirmatively
 * includes it, the registry answers what the provider answers.
 *
 * The cost of being wrong here is asymmetric and small: no live account is
 * denominated in FBZ, and if one ever were, 100 is the provider's own number.
 * `Intl.NumberFormat` renders it as a plain "FBZ" prefix rather than throwing,
 * so no display path breaks.
 */
const OFFSET_HUNDRED = [
  "AED", "ARS", "AUD", "BDT", "BGN", "BHD", "BOB", "BRL", "CAD", "CHF", "CNY",
  "CZK", "DKK", "DZD", "EGP", "EUR", "FBZ", "GBP", "GTQ", "HKD", "HNL", "HRK",
  "ILS", "INR", "JOD", "KES", "LTL", "LVL", "MOP", "MXN", "MYR", "NGN", "NIO",
  "NOK", "NZD", "PEN", "PHP", "PKR", "PLN", "QAR", "RON", "RSD", "RUB", "SAR",
  "SEK", "SGD", "SKK", "THB", "TRY", "UAH", "USD", "UYU", "VEF", "VES", "ZAR",
] as const;

const REGISTRY: Readonly<Record<string, MetaCurrencyOffset>> = Object.freeze({
  ...Object.fromEntries(OFFSET_ONE.map((code) => [code, 1 as const])),
  ...Object.fromEntries(OFFSET_HUNDRED.map((code) => [code, 100 as const])),
});

export type MetaCurrencyOffsetResolution =
  | {
      status: "resolved";
      currency: string;
      offset: MetaCurrencyOffset;
      /** How many digits the offset hides. 100 -> 2, 1 -> 0. Never 3. */
      subdivisionDigits: 0 | 2;
      registryVersion: typeof META_CURRENCY_OFFSET_REGISTRY_VERSION;
    }
  | { status: "unknown_currency"; currency: string | null };

/**
 * The provider's offset for a currency, or an explicit refusal.
 *
 * Never falls back to 100, never consults ISO, never infers from a neighbour.
 */
export function resolveMetaCurrencyOffset(
  currency: unknown,
): MetaCurrencyOffsetResolution {
  const code = typeof currency === "string" ? currency.trim().toUpperCase() : "";
  if (!code) return { status: "unknown_currency", currency: null };
  const offset = REGISTRY[code];
  if (!offset) return { status: "unknown_currency", currency: code };
  return {
    status: "resolved",
    currency: code,
    offset,
    subdivisionDigits: offset === 100 ? 2 : 0,
    registryVersion: META_CURRENCY_OFFSET_REGISTRY_VERSION,
  };
}

export type MetaMajorUnitsResult =
  | { ok: true; majorUnits: number; subdivisionDigits: 0 | 2 }
  | { ok: false; refusal: "amount_absent" | "currency_unknown_to_provider" };

/**
 * Provider minor units -> the number a person reads, at the PROVIDER's scale.
 *
 * This replaces the hard-coded `/ 100` that is correct only for offset-100
 * currencies. On JPY it would have shown 100x too little; on HUF, IDR, TWD and
 * COP — which the ISO registry calls two-decimal — it would have done the same
 * while looking correct to a reader checking against ISO.
 *
 * It refuses rather than guessing, because a visibly missing amount is a far
 * cheaper mistake than a confidently wrong one.
 */
export function metaMinorUnitsToMajor(input: {
  minorUnits: number | null | undefined;
  currency: unknown;
}): MetaMajorUnitsResult {
  if (typeof input.minorUnits !== "number" || !Number.isFinite(input.minorUnits)) {
    return { ok: false, refusal: "amount_absent" };
  }
  const resolved = resolveMetaCurrencyOffset(input.currency);
  if (resolved.status !== "resolved") {
    return { ok: false, refusal: "currency_unknown_to_provider" };
  }
  return {
    ok: true,
    majorUnits: input.minorUnits / resolved.offset,
    subdivisionDigits: resolved.subdivisionDigits,
  };
}

/** Codes this registry knows, for tests and diagnostics. */
export function metaKnownCurrencies(): string[] {
  return Object.keys(REGISTRY).sort();
}

/**
 * Codes where Meta's offset implies a different number of subdivision digits
 * than the ISO-4217 exponent the client registry carries.
 *
 * Only codes BOTH registries hold. A code one of them omits is a fail-closed,
 * not a disagreement, and listing it here would be a claim neither registry
 * supports — CRC was in this table until a test derived the comparison from
 * both registries and found the ISO side absent.
 *
 * Exported so a test can assert the list rather than a comment claiming it, and
 * so a diagnostic can show an operator which accounts are exposed.
 */
export const META_ISO_OFFSET_DIVERGENCES: Readonly<
  Record<string, { metaSubdivisionDigits: 0 | 2; isoExponent: number }>
> = Object.freeze({
  COP: { metaSubdivisionDigits: 0, isoExponent: 2 },
  HUF: { metaSubdivisionDigits: 0, isoExponent: 2 },
  IDR: { metaSubdivisionDigits: 0, isoExponent: 2 },
  TWD: { metaSubdivisionDigits: 0, isoExponent: 2 },
  BHD: { metaSubdivisionDigits: 2, isoExponent: 3 },
  JOD: { metaSubdivisionDigits: 2, isoExponent: 3 },
});
