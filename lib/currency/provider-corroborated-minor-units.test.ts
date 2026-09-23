/**
 * The gate that decides whether an ISO exponent may be used for a Meta amount.
 *
 * The whole value of this module is a pair of properties that pull in opposite
 * directions, so both are asserted from the registries rather than restated:
 *
 *   1. It must change NOTHING for a currency the two authorities agree on.
 *      Every idempotency key, receipt and retained fact downstream hashes the
 *      exponent, so a different number for USD would silently re-key live
 *      operations.
 *   2. It must refuse, with a distinguishable reason, exactly where the
 *      provider disagrees or publishes nothing.
 */
import { describe, expect, it } from "vitest";

import {
  PROVIDER_CORROBORATED_MINOR_UNITS_VERSION,
  providerCorroboratedCurrencies,
  resolveProviderCorroboratedExponent,
} from "@/lib/currency/provider-corroborated-minor-units";
import {
  ISO_4217_REGISTRY_VERSION,
  resolveMinorUnitExponent,
} from "@/lib/currency/iso-4217-minor-units";
import {
  META_ISO_OFFSET_DIVERGENCES,
  metaKnownCurrencies,
  resolveMetaCurrencyOffset,
} from "@/lib/currency/meta-currency-offsets";

describe("an exponent both authorities stand behind", () => {
  it("splits the provider's 66 currencies into exactly three known groups", () => {
    /*
      The honest shape of the answer, pinned so it cannot drift silently.

      41 admitted. 6 refused because the two authorities disagree. 19 refused
      because the ISO registry in this repository does not hold the code at
      all — it is deliberately partial ("an absent code fails closed") and it
      is the NARROWER of the two here.

      That 19 matters and is not caused by this gate: `resolveMinorUnitExponent`
      already refuses every one of them today, so a Meta account in PKR, RUB,
      KES or BDT could not carry a budget or bid intent before this change
      either. The gate reclassifies the reason; it does not remove a
      capability. Widening it would mean minting an exponent from the provider
      table while the emitted `currencyRegistry.version` still names ISO — a
      provenance claim the contract could not support — so the 19 stay closed
      and are reported instead.
    */
    const agreed = providerCorroboratedCurrencies();
    const byRefusal: Record<string, string[]> = {};
    for (const code of metaKnownCurrencies()) {
      const gated = resolveProviderCorroboratedExponent(code);
      if (gated.status === "refused") (byRefusal[gated.refusal] ??= []).push(code);
    }

    expect(agreed).toEqual([
      "AED", "ARS", "AUD", "BGN", "BRL", "CAD", "CHF", "CLP", "CNY", "CZK",
      "DKK", "EGP", "EUR", "GBP", "HKD", "ILS", "INR", "ISK", "JPY", "KRW",
      "MXN", "MYR", "NGN", "NOK", "NZD", "PEN", "PHP", "PLN", "PYG", "QAR",
      "RON", "RSD", "SAR", "SEK", "SGD", "THB", "TRY", "UAH", "USD", "VND",
      "ZAR",
    ]);
    expect(byRefusal.provider_offset_disagrees_with_iso).toEqual([
      "BHD", "COP", "HUF", "IDR", "JOD", "TWD",
    ]);
    /* Meta publishes these and our ISO transcription does not hold them. Each
       one is a real advertising currency this product cannot currently carry
       an intent for — the list is the cost of keeping the gate strict. */
    expect(byRefusal.currency_unresolvable).toEqual([
      "BDT", "BOB", "CRC", "DZD", "FBZ", "GTQ", "HNL", "HRK", "KES", "LTL",
      "LVL", "MOP", "NIO", "PKR", "RUB", "SKK", "UYU", "VEF", "VES",
    ]);
    expect(
      agreed.length +
        byRefusal.provider_offset_disagrees_with_iso.length +
        byRefusal.currency_unresolvable.length,
    ).toBe(66);
  });

  it("does not refuse anything the ISO registry alone would have admitted", () => {
    /*
      The no-regression property, and the one that decides whether this can
      land at all. Every code the chain can carry an intent for TODAY must
      still be carryable — except the six where the provider actively
      contradicts ISO, which is the whole point of the gate.
    */
    const divergent = new Set(Object.keys(META_ISO_OFFSET_DIVERGENCES));
    for (const code of metaKnownCurrencies()) {
      const iso = resolveMinorUnitExponent(code);
      if (iso.status !== "resolved") continue;
      const gated = resolveProviderCorroboratedExponent(code);
      if (divergent.has(code)) {
        expect(gated.status, code).toBe("refused");
      } else {
        expect(gated.status, code).toBe("resolved");
      }
    }
  });

  it("returns the ISO exponent unchanged wherever the provider agrees", () => {
    /*
      Property 1, asserted over the WHOLE agreed set rather than a sample. The
      resolved exponent must be identical to what `resolveMinorUnitExponent`
      would have returned on its own — this gate filters, it never substitutes.
      If it ever substituted, every downstream idempotency key would move.
    */
    const agreed = providerCorroboratedCurrencies();
    for (const code of agreed) {
      const gated = resolveProviderCorroboratedExponent(code);
      const iso = resolveMinorUnitExponent(code);
      expect(gated.status, code).toBe("resolved");
      expect(iso.status, code).toBe("resolved");
      if (gated.status === "resolved" && iso.status === "resolved") {
        expect(gated.exponent, code).toBe(iso.exponent);
        expect(gated.registryVersion, code).toBe(iso.registryVersion);
      }
    }
  });

  it("admits every currency this product actually runs, unchanged", () => {
    for (const [code, exponent] of [
      ["USD", 2], ["TRY", 2], ["GBP", 2], ["JPY", 0], ["KRW", 0], ["EUR", 2],
    ] as const) {
      const gated = resolveProviderCorroboratedExponent(code);
      expect(gated.status, code).toBe("resolved");
      if (gated.status === "resolved") {
        expect(gated.exponent, code).toBe(exponent);
        /* The persisted provenance string must not move either: it is written
           into `budget_currency_registry_version` and into dry-run receipts. */
        expect(gated.registryVersion, code).toBe(ISO_4217_REGISTRY_VERSION);
      }
    }
  });

  it("refuses where the two registries imply different subdivision digits", () => {
    /*
      Derived from the exported divergence table, so a registry edit that
      re-aligns them cannot leave this passing for the wrong reason.
    */
    const codes = Object.keys(META_ISO_OFFSET_DIVERGENCES);
    expect(codes.length).toBeGreaterThan(0);
    for (const code of codes) {
      const gated = resolveProviderCorroboratedExponent(code);
      expect(gated.status, code).toBe("refused");
      if (gated.status === "refused") {
        expect(gated.refusal, code).toBe("provider_offset_disagrees_with_iso");
        /* Both numbers are reported, because a blocker that says only
           "refused" cannot be acted on. */
        expect(gated.isoExponent, code).not.toBeNull();
        expect(gated.providerSubdivisionDigits, code).not.toBeNull();
        expect(gated.isoExponent, code).not.toBe(gated.providerSubdivisionDigits);
        expect(gated.reason, code).toContain(code);
      }
    }
  });

  it("refuses a code ISO resolves and the provider does not publish", () => {
    for (const code of ["KWD", "OMR", "TND", "IQD", "LYD"]) {
      expect(resolveMinorUnitExponent(code).status, code).toBe("resolved");
      expect(resolveMetaCurrencyOffset(code).status, code).toBe("unknown_currency");
      const gated = resolveProviderCorroboratedExponent(code);
      expect(gated.status, code).toBe("refused");
      if (gated.status === "refused") {
        expect(gated.refusal, code).toBe("provider_offset_unpublished");
        /* Distinguishable from a disagreement: there is an ISO answer and no
           provider answer, which is a different fact and a different fix. */
        expect(gated.isoExponent, code).not.toBeNull();
        expect(gated.providerSubdivisionDigits, code).toBeNull();
      }
    }
  });

  it("refuses a code the provider publishes and ISO does not", () => {
    /*
      The mirror case, and the reason the refusal reasons are separate. CRC and
      FBZ are in Meta's table and not in the ISO registry. There is no ISO
      exponent to corroborate, so no exponent may enter the chain — even though
      `metaMinorUnitsToMajor` can still DISPLAY those currencies perfectly well
      from the provider offset alone. Scaling for display and minting a hashed
      contract value are different bars.
    */
    for (const code of ["CRC", "FBZ"]) {
      expect(resolveMetaCurrencyOffset(code).status, code).toBe("resolved");
      expect(resolveMinorUnitExponent(code).status, code).toBe("unknown_currency");
      const gated = resolveProviderCorroboratedExponent(code);
      expect(gated.status, code).toBe("refused");
      if (gated.status === "refused") {
        expect(gated.refusal, code).toBe("currency_unresolvable");
      }
    }
  });

  it("refuses an absent, malformed or unknown code", () => {
    for (const value of [null, undefined, "", "US", "ZZZ", 42, {}]) {
      const gated = resolveProviderCorroboratedExponent(value);
      expect(gated.status).toBe("refused");
      if (gated.status === "refused") {
        expect(gated.refusal).toBe("currency_unresolvable");
      }
    }
  });

  it("admits strictly fewer currencies than either registry alone", () => {
    /*
      The honest shape of the answer: corroboration is an INTERSECTION, so it
      must be smaller than the provider table. A gate that admitted everything
      would not be a gate.
    */
    const agreed = providerCorroboratedCurrencies();
    const provider = metaKnownCurrencies();
    expect(agreed.length).toBeLessThan(provider.length);
    for (const code of agreed) {
      expect(provider, code).toContain(code);
    }
    /* And every provider code it drops is dropped for a nameable reason. */
    for (const code of provider.filter((c) => !agreed.includes(c))) {
      const gated = resolveProviderCorroboratedExponent(code);
      expect(gated.status, code).toBe("refused");
      if (gated.status === "refused") {
        expect(
          ["currency_unresolvable", "provider_offset_disagrees_with_iso"],
          code,
        ).toContain(gated.refusal);
      }
    }
  });

  it("binds a version for the RULE, separate from either registry's", () => {
    expect(PROVIDER_CORROBORATED_MINOR_UNITS_VERSION).toBe(
      "meta.provider-corroborated-minor-units.v1",
    );
    const gated = resolveProviderCorroboratedExponent("USD");
    expect(gated.status).toBe("resolved");
    if (gated.status === "resolved") {
      /* Three separate versions, none of them collapsed into another: what ISO
         said, what the provider said, and which agreement test was applied. */
      expect(gated.registryVersion).toBe(ISO_4217_REGISTRY_VERSION);
      expect(gated.providerRegistryVersion).toMatch(/^meta\.currency-offsets\./);
      expect(gated.corroborationVersion).toBe(
        PROVIDER_CORROBORATED_MINOR_UNITS_VERSION,
      );
    }
  });
});
