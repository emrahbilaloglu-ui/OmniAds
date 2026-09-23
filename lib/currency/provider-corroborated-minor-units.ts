/**
 * One minor-unit exponent that BOTH authorities stand behind.
 *
 * ## The problem this solves
 *
 * The Meta decision, write and preview chain carries a `currencyExponent`
 * through contracts, idempotency keys, dry-run receipts, retained budget facts
 * and state-history rows. Every one of those values is resolved from
 * `iso-4217-minor-units.ts` — the ISO-4217 registry, which answers a BANK
 * question. The amounts it scales are PROVIDER amounts, and Meta publishes its
 * own per-currency `offset` (`meta-currency-offsets.ts`) that disagrees on six
 * codes and is silent on five more:
 *
 *   COP, HUF, IDR, TWD   Meta offset 1 (0 digits) vs ISO exponent 2  -> 100x
 *   BHD, JOD             Meta offset 100 (2 digits) vs ISO exponent 3 -> 10x
 *   KWD, OMR, TND, IQD, LYD  ISO resolves at 3; Meta's table omits them, and
 *                        Meta publishes no offset above 100 anywhere.
 *
 * ## Why this corroborates rather than replaces
 *
 * Swapping the ISO registry out for the provider one across that whole chain
 * would have to move, together and atomically: every producer, every validator
 * that re-derives and compares, every idempotency key that hashes the exponent,
 * every persisted `currency_registry_version` column and every served receipt.
 * Change one end and the other fails closed on something that works today.
 *
 * The exponent is also not the thing most of those sites scale WITH. The
 * percent arithmetic (`applyPercentToMinorUnits`) is scale-free: it takes
 * minor units in and gives minor units out, and never needs a currency at all.
 * In most of the chain the exponent is carried as provenance and hashed into a
 * key — not used to multiply.
 *
 * So instead of replacing the number, this makes it TRUE. An exponent may only
 * enter the chain when the provider's own offset implies the same number of
 * subdivision digits. Where the two agree the resolved value, the registry
 * version and therefore every downstream key are byte-identical to what they
 * were — USD, TRY, GBP, JPY, KRW and every other shared code included. Where
 * they disagree, or where the provider publishes nothing, the currency is
 * refused with a named reason instead of proceeding on a number one authority
 * denies.
 *
 * ## The invariant this buys downstream
 *
 * After this gate, a carried `currencyExponent` means "ISO says this AND Meta
 * does not contradict it". That is what makes it safe for the few sites that
 * really do scale with it — `bid-sizing-policy.ts` raises 10 to it — to keep
 * doing so. Without the gate, those sites were multiplying by a number the
 * provider disagreed with.
 *
 * ## What this deliberately does NOT do
 *
 * It does not touch non-provider money. Shopify order values, internal
 * accounting figures and bank amounts are ISO amounts and `resolveMinorUnitExponent`
 * remains the right authority for them. Corroborating those against Meta's
 * advertising-currency table would refuse real currencies for no reason.
 */
import {
  ISO_4217_REGISTRY_SOURCE,
  ISO_4217_REGISTRY_VERSION,
  resolveMinorUnitExponent,
  type MinorUnitExponent,
} from "@/lib/currency/iso-4217-minor-units";
import {
  META_CURRENCY_OFFSET_REGISTRY_VERSION,
  metaKnownCurrencies,
  resolveMetaCurrencyOffset,
  type MetaCurrencyOffset,
} from "@/lib/currency/meta-currency-offsets";

/**
 * Bumped when the corroboration RULE changes — not when either registry
 * changes. A consumer that records this alongside an exponent is recording
 * which agreement test the number passed.
 */
export const PROVIDER_CORROBORATED_MINOR_UNITS_VERSION =
  "meta.provider-corroborated-minor-units.v1" as const;

export type ProviderCorroboratedExponentRefusal =
  /** Neither registry could name the code, or it was absent/malformed. */
  | "currency_unresolvable"
  /** ISO knows it; Meta's published offset table does not list it. */
  | "provider_offset_unpublished"
  /** Both know it and they imply a different number of subdivision digits. */
  | "provider_offset_disagrees_with_iso";

export type ProviderCorroboratedExponent =
  | {
      status: "resolved";
      currency: string;
      /**
       * The agreed exponent. Identical to the ISO one by construction — this
       * gate never substitutes a different number, it only decides whether the
       * ISO number may be used.
       */
      exponent: MinorUnitExponent;
      /** The provider's multiplier, for callers that want it directly. */
      providerOffset: MetaCurrencyOffset;
      /** Unchanged from the ISO resolution, so persisted provenance is stable. */
      registryVersion: typeof ISO_4217_REGISTRY_VERSION;
      registrySource: typeof ISO_4217_REGISTRY_SOURCE;
      providerRegistryVersion: typeof META_CURRENCY_OFFSET_REGISTRY_VERSION;
      corroborationVersion: typeof PROVIDER_CORROBORATED_MINOR_UNITS_VERSION;
    }
  | {
      status: "refused";
      refusal: ProviderCorroboratedExponentRefusal;
      currency: string | null;
      /** Present when both registries answered and disagreed. */
      isoExponent: MinorUnitExponent | null;
      providerSubdivisionDigits: 0 | 2 | null;
      /** A sentence a blocker code or a receipt can carry verbatim. */
      reason: string;
    };

/**
 * The minor-unit exponent for a PROVIDER (Meta) amount, or an explicit refusal.
 *
 * Use this anywhere a Meta amount's scale is decided, recorded or hashed. Use
 * `resolveMinorUnitExponent` directly only for money that is not a Meta amount.
 */
export function resolveProviderCorroboratedExponent(
  currency: unknown,
): ProviderCorroboratedExponent {
  const iso = resolveMinorUnitExponent(currency);
  const provider = resolveMetaCurrencyOffset(currency);

  if (iso.status !== "resolved") {
    return {
      status: "refused",
      refusal: "currency_unresolvable",
      currency: provider.status === "resolved" ? provider.currency : null,
      isoExponent: null,
      providerSubdivisionDigits:
        provider.status === "resolved" ? provider.subdivisionDigits : null,
      reason: `no ISO-4217 minor-unit exponent is known for ${JSON.stringify(currency)}`,
    };
  }

  if (provider.status !== "resolved") {
    return {
      status: "refused",
      refusal: "provider_offset_unpublished",
      currency: iso.currency,
      isoExponent: iso.exponent,
      providerSubdivisionDigits: null,
      reason:
        `the provider publishes no currency offset for ${iso.currency}, so its ` +
        `ISO exponent ${iso.exponent} is not a scale any provider document supports`,
    };
  }

  if (provider.subdivisionDigits !== iso.exponent) {
    return {
      status: "refused",
      refusal: "provider_offset_disagrees_with_iso",
      currency: iso.currency,
      isoExponent: iso.exponent,
      providerSubdivisionDigits: provider.subdivisionDigits,
      reason:
        `the provider's offset for ${iso.currency} implies ` +
        `${provider.subdivisionDigits} subdivision digits and ISO-4217 says ` +
        `${iso.exponent}; an amount cannot be scaled at two different scales`,
    };
  }

  return {
    status: "resolved",
    currency: iso.currency,
    exponent: iso.exponent,
    providerOffset: provider.offset,
    registryVersion: ISO_4217_REGISTRY_VERSION,
    registrySource: ISO_4217_REGISTRY_SOURCE,
    providerRegistryVersion: META_CURRENCY_OFFSET_REGISTRY_VERSION,
    corroborationVersion: PROVIDER_CORROBORATED_MINOR_UNITS_VERSION,
  };
}

/**
 * Every currency this gate admits, sorted. For tests and diagnostics.
 *
 * It is the intersection of the two registries restricted to codes they agree
 * on — smaller than either, and the honest answer to "which currencies can this
 * product carry a Meta amount for".
 *
 * The candidates come from the PROVIDER registry rather than the ISO one on
 * purpose: a corroborated currency must be one Meta serves, so iterating the
 * advertising-currency table is both correct and cheaper than walking every
 * code ISO has ever minted.
 */
export function providerCorroboratedCurrencies(): string[] {
  return metaKnownCurrencies()
    .filter((code) => resolveProviderCorroboratedExponent(code).status === "resolved")
    .sort();
}
