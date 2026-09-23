/**
 * The provider's currency offset, and the places it disagrees with ISO.
 *
 * Every case here is a currency where reading the wrong authority moves a
 * displayed or proposed amount by 10x or 100x. The divergent set is asserted
 * from the exported table rather than from a comment, so a future edit to the
 * registry that silently re-aligns them fails here.
 */
import { describe, expect, it } from "vitest";

import {
  META_CURRENCY_OFFSET_REGISTRY_VERSION,
  META_CURRENCY_OFFSET_SOURCE,
  META_ISO_OFFSET_DIVERGENCES,
  metaKnownCurrencies,
  metaMinorUnitsToMajor,
  resolveMetaCurrencyOffset,
} from "@/lib/currency/meta-currency-offsets";
import { resolveMinorUnitExponent } from "@/lib/currency/iso-4217-minor-units";

describe("the provider's own currency offset", () => {
  it("reads offset 100 as two subdivision digits", () => {
    expect(resolveMetaCurrencyOffset("USD")).toMatchObject({
      status: "resolved", offset: 100, subdivisionDigits: 2,
    });
  });

  it("reads offset 1 as whole units, which is where a blanket /100 breaks", () => {
    /* A ¥12,000 bid stored as 12000 is ¥12,000, not ¥120. */
    expect(resolveMetaCurrencyOffset("JPY")).toMatchObject({
      status: "resolved", offset: 1, subdivisionDigits: 0,
    });
    expect(metaMinorUnitsToMajor({ minorUnits: 12_000, currency: "JPY" }))
      .toEqual({ ok: true, majorUnits: 12_000, subdivisionDigits: 0 });
    expect(metaMinorUnitsToMajor({ minorUnits: 12_000, currency: "USD" }))
      .toEqual({ ok: true, majorUnits: 120, subdivisionDigits: 2 });
  });

  it("is case and whitespace tolerant on the code, and nothing else", () => {
    expect(resolveMetaCurrencyOffset("  usd ").status).toBe("resolved");
    expect(resolveMetaCurrencyOffset("US").status).toBe("unknown_currency");
    expect(resolveMetaCurrencyOffset("").status).toBe("unknown_currency");
    expect(resolveMetaCurrencyOffset(null).status).toBe("unknown_currency");
    expect(resolveMetaCurrencyOffset(42).status).toBe("unknown_currency");
  });

  it("never defaults to 100 for a code it does not hold", () => {
    /* The whole safety property. A guessed offset is a silent 100x error. */
    expect(resolveMetaCurrencyOffset("ZZZ")).toEqual({
      status: "unknown_currency", currency: "ZZZ",
    });
    expect(metaMinorUnitsToMajor({ minorUnits: 12_000, currency: "ZZZ" }))
      .toEqual({ ok: false, refusal: "currency_unknown_to_provider" });
  });

  it("refuses an absent amount separately from an unknown currency", () => {
    expect(metaMinorUnitsToMajor({ minorUnits: null, currency: "USD" }))
      .toEqual({ ok: false, refusal: "amount_absent" });
    expect(metaMinorUnitsToMajor({ minorUnits: Number.NaN, currency: "USD" }))
      .toEqual({ ok: false, refusal: "amount_absent" });
  });

  it("binds a version so a converted amount can name its authority", () => {
    expect(META_CURRENCY_OFFSET_REGISTRY_VERSION).toBe(
      "meta.currency-offsets.2026-09-22.2",
    );
    /* The source line must not re-acquire a count the page does not state. An
       earlier revision claimed "the page states 103 currencies"; it states no
       count at all, and repeating an invented number as provenance is how a
       reader comes to trust a gap that is not there. */
    expect(META_CURRENCY_OFFSET_SOURCE).not.toMatch(/103/);
    expect(META_CURRENCY_OFFSET_SOURCE).toContain("66");
    expect(resolveMetaCurrencyOffset("USD")).toMatchObject({
      registryVersion: META_CURRENCY_OFFSET_REGISTRY_VERSION,
    });
  });
});

describe("the transcription is the whole table, not part of it", () => {
  /*
    Re-verified 2026-09-22 against
    https://developers.facebook.com/docs/marketing-api/currencies/ by two
    independent reads. The table has 66 rows; both reads returned the same
    11-code offset-1 set and neither found an offset outside {1, 100}.

    The count is asserted because the difference between "partial" and
    "complete" changes what a REFUSAL means. While the reading was believed
    partial, an absent code meant "untranscribed". Now it means the page does
    not list it — which is what makes the KWD/OMR/TND/IQD/LYD refusals below
    evidence rather than caution.
  */
  it("holds exactly the 66 rows the page publishes", () => {
    expect(metaKnownCurrencies()).toHaveLength(66);
  });

  it("holds exactly the 11 offset-1 codes, and no other offset exists", () => {
    const byOffset = metaKnownCurrencies().reduce<Record<string, string[]>>(
      (acc, code) => {
        const resolved = resolveMetaCurrencyOffset(code);
        if (resolved.status !== "resolved") throw new Error(`unresolved ${code}`);
        (acc[String(resolved.offset)] ??= []).push(code);
        return acc;
      },
      {},
    );
    expect(Object.keys(byOffset).sort()).toEqual(["1", "100"]);
    expect(byOffset["1"]).toEqual([
      "CLP", "COP", "CRC", "HUF", "IDR", "ISK", "JPY", "KRW", "PYG", "TWD", "VND",
    ]);
    expect(byOffset["100"]).toHaveLength(55);
  });

  it("carries FBZ, because the source does and the exclusion cannot be proved", () => {
    /*
      FBZ's Name column reads "credits" — Facebook Credits, retired in September
      2013 — and it is not an ISO-4217 code. It was dropped from the first
      transcription as an obvious non-currency. That was an editorial judgement
      the source does not support: the page presents its table as the
      currencies ad accounts support, lists FBZ in it, publishes 100 for it, and
      marks no row as unusable. A registry whose job is "what does the provider
      publish" does not get to overrule the provider on a hunch.
    */
    expect(resolveMetaCurrencyOffset("FBZ")).toMatchObject({
      status: "resolved", offset: 100, subdivisionDigits: 2,
    });
    expect(metaMinorUnitsToMajor({ minorUnits: 1_234, currency: "FBZ" }))
      .toMatchObject({ ok: true, majorUnits: 12.34 });
  });

  it("does not break a display path on the one non-ISO code it carries", () => {
    /* FBZ has no ISO entry, so `Intl` has no symbol for it. It formats as a
       plain code prefix rather than throwing, which is why carrying it costs
       nothing. */
    expect(resolveMinorUnitExponent("FBZ").status).toBe("unknown_currency");
    expect(() =>
      (12.34).toLocaleString("en", { style: "currency", currency: "FBZ" }),
    ).not.toThrow();
  });
});

describe("where the provider disagrees with the ISO registry", () => {
  /*
    These are the codes where reading `iso-4217-minor-units.ts` for a PROVIDER
    amount is wrong. The test derives the disagreement from both registries
    rather than trusting the table, so neither can drift without failing.
  */
  it.each(Object.entries(META_ISO_OFFSET_DIVERGENCES))(
    "%s really does disagree, in the direction recorded",
    (code, expected) => {
      const meta = resolveMetaCurrencyOffset(code);
      const iso = resolveMinorUnitExponent(code);
      expect(meta.status).toBe("resolved");
      expect(iso.status).toBe("resolved");
      const metaDigits = meta.status === "resolved" ? meta.subdivisionDigits : -1;
      const isoExponent = iso.status === "resolved" ? iso.exponent : -1;
      expect(metaDigits).toBe(expected.metaSubdivisionDigits);
      expect(isoExponent).toBe(expected.isoExponent);
      expect(metaDigits).not.toBe(isoExponent);
    },
  );

  it("puts a real number on the COP divergence", () => {
    /* ISO calls COP two-decimal; Meta calls it whole units. A 50,000 COP bid
       read through ISO would be shown as 500 COP. */
    expect(metaMinorUnitsToMajor({ minorUnits: 50_000, currency: "COP" }))
      .toMatchObject({ ok: true, majorUnits: 50_000 });
    const iso = resolveMinorUnitExponent("COP");
    expect(iso.status === "resolved" && 50_000 / 10 ** iso.exponent).toBe(500);
  });

  it("puts a real number on the BHD divergence", () => {
    /* ISO calls BHD three-decimal; Meta calls it two. A 1,500 BHD bid read
       through ISO would be shown as 1.5 instead of 15. */
    expect(metaMinorUnitsToMajor({ minorUnits: 1_500, currency: "BHD" }))
      .toMatchObject({ ok: true, majorUnits: 15 });
    const iso = resolveMinorUnitExponent("BHD");
    expect(iso.status === "resolved" && 1_500 / 10 ** iso.exponent).toBe(1.5);
  });

  it("refuses the three-decimal codes the provider does not list", () => {
    /*
      The ISO registry holds these at exponent 3. Meta's table does not list
      them, and the transcription is now complete — so this is not a gap in the
      reading, it is the page. Meta publishes no offset above 100 anywhere, and
      the two three-decimal currencies it DOES list, BHD and JOD, are both
      mapped to 100. An ISO-derived divide-by-1000 here was therefore more
      likely wrong than right, quite apart from being unsourced.
    */
    for (const code of ["KWD", "OMR", "TND", "IQD", "LYD"]) {
      expect(resolveMetaCurrencyOffset(code).status, code).toBe("unknown_currency");
      expect(resolveMinorUnitExponent(code).status, code).toBe("resolved");
    }
  });

  it("agrees on every currency this product actually runs", () => {
    /* USD, TRY and GBP are the account currencies observed in the warehouse.
       The divergence is latent, and this is the case that says so. */
    for (const code of ["USD", "TRY", "GBP", "JPY", "KRW"]) {
      const meta = resolveMetaCurrencyOffset(code);
      const iso = resolveMinorUnitExponent(code);
      expect(meta.status, code).toBe("resolved");
      expect(iso.status, code).toBe("resolved");
      if (meta.status === "resolved" && iso.status === "resolved") {
        expect(meta.subdivisionDigits, code).toBe(iso.exponent);
      }
    }
  });

  it("holds no offset above 100, which is why no three-decimal code survives", () => {
    for (const code of metaKnownCurrencies()) {
      const resolved = resolveMetaCurrencyOffset(code);
      expect(resolved.status === "resolved" && resolved.offset, code)
        .toSatisfy?.((v: unknown) => v === 1 || v === 100) ??
        expect([1, 100]).toContain(resolved.status === "resolved" ? resolved.offset : null);
      expect(resolved.status === "resolved" && resolved.subdivisionDigits, code)
        .not.toBe(3);
    }
  });
});
