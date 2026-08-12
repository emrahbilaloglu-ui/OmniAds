/**
 * WP-26 step 7 — glossary, parity and real-length checks.
 *
 * These are contract tests over the catalogue itself. The rendered-length half
 * (does a Turkish label clip at 320 px?) lives in the responsive suite, because
 * only a browser can answer it.
 */
import { describe, expect, it } from "vitest";

import {
  NON_TRANSLATABLE_TERMS,
  ZERO_BASE_COPY,
  preservesGlossary,
  zeroBaseCopy,
} from "@/lib/zero-base/copy";
import { LANGUAGE_OPTIONS, isAppLanguage } from "@/lib/i18n";

const EN = ZERO_BASE_COPY.en;
const TR = ZERO_BASE_COPY.tr;
// Product identifiers are not natural-language copy. The visual wordmark must
// remain byte-identical wherever the surrounding language changes.
const IDENTICAL_COPY_EXEMPTIONS = new Set(["brandName"]);

describe("EN/TR parity", () => {
  it("every English key has a Turkish counterpart and vice versa", () => {
    expect(Object.keys(TR).sort()).toEqual(Object.keys(EN).sort());
  });

  it("no string is empty or left as its own key name", () => {
    for (const [key, value] of Object.entries({ ...EN })) {
      expect(String(value).trim().length, `en.${key} is empty`).toBeGreaterThan(0);
      expect(String(value), `en.${key} is a placeholder`).not.toBe(key);
    }
    for (const [key, value] of Object.entries({ ...TR })) {
      expect(String(value).trim().length, `tr.${key} is empty`).toBeGreaterThan(0);
      expect(String(value), `tr.${key} is a placeholder`).not.toBe(key);
    }
  });

  it("REGRESSION: Turkish is actually translated, not English copied across", () => {
    // A catalogue that "supports" TR by duplicating English is the failure this
    // whole work package exists to remove.
    // Compared as strings: the literal types already prove no overlap at
    // compile time, which is a stronger guarantee, but the runtime check is
    // what keeps the property true if the catalogue is ever widened.
    const identical = Object.keys(EN).filter(
      (key) =>
        !IDENTICAL_COPY_EXEMPTIONS.has(key) &&
        String(EN[key as keyof typeof EN]) === String(TR[key as keyof typeof TR]),
    );
    expect(identical, `these TR strings are byte-identical to EN: ${identical.join(", ")}`).toEqual([]);
  });
});

describe("the glossary survives translation", () => {
  it("preserves every non-translatable term the English string used", () => {
    for (const key of Object.keys(EN) as Array<keyof typeof EN>) {
      const missing = preservesGlossary(EN[key], TR[key]);
      expect(missing, `tr.${String(key)} dropped ${missing.join(", ")}`).toEqual([]);
    }
  });

  it("treats ambiguous terms as identifiers only when capitalised", () => {
    // "Search" capitalised is the Google Ads campaign type and must survive.
    expect(preservesGlossary("Search campaigns", "Kampanyalar")).toEqual(["Search"]);
    // Lowercase it is an ordinary noun; forcing it through would be nonsense.
    expect(preservesGlossary("Clear search", "Aramayı temizle")).toEqual([]);
  });

  it("detects a dropped term rather than passing everything", () => {
    // Negative control: the checker must actually fail when a term is lost.
    expect(preservesGlossary("Target ROAS for Meta", "Meta için hedef YG")).toEqual(["ROAS"]);
    expect(preservesGlossary("Target ROAS for Meta", "Meta için hedef ROAS")).toEqual([]);
  });

  it("keeps provider and metric identifiers out of the translated forms", () => {
    // Spot-check the ones most likely to be "helpfully" localized.
    for (const term of ["ROAS", "CTR", "CPA", "Meta", "Google Ads", "GA4", "Shopify"]) {
      expect(NON_TRANSLATABLE_TERMS).toContain(term as (typeof NON_TRANSLATABLE_TERMS)[number]);
    }
  });
});

describe("real-length behaviour", () => {
  /**
   * Turkish runs longer than English for the same idea. The catalogue is not
   * required to be short — the layout is required to survive the length — so
   * this records the true ratio and fails only on a runaway string that would
   * certainly break a 320 px surface.
   */
  it("no Turkish string is disproportionately longer than its English original", () => {
    const offenders: string[] = [];
    for (const key of Object.keys(EN) as Array<keyof typeof EN>) {
      const en = EN[key].length;
      const tr = TR[key].length;
      if (tr > en * 2 + 12) offenders.push(`${String(key)}: ${en} → ${tr}`);
    }
    expect(offenders).toEqual([]);
  });

  it("exposes the longest strings, which are what the 320px layout must hold", () => {
    const longest = (Object.keys(TR) as Array<keyof typeof TR>)
      .map((key) => ({ key: String(key), length: TR[key].length }))
      .sort((a, b) => b.length - a.length)[0];
    // Not an assertion about copy: a guard that the catalogue is real enough to
    // be worth testing against a narrow viewport.
    expect(longest.length).toBeGreaterThan(20);
  });
});

describe("language resolution", () => {
  it("returns Turkish for tr and English for everything else", () => {
    expect(zeroBaseCopy("tr").save).toBe(TR.save);
    expect(zeroBaseCopy("en").save).toBe(EN.save);
    // Explicit fallback rather than a blank or a thrown error.
    expect(zeroBaseCopy(null).save).toBe(EN.save);
    expect(zeroBaseCopy(undefined).save).toBe(EN.save);
  });

  it("both catalogue languages are languages the app recognises", () => {
    for (const language of Object.keys(ZERO_BASE_COPY)) {
      expect(isAppLanguage(language), `${language} is not an AppLanguage`).toBe(true);
    }
  });

  it("REGRESSION: a language offered in the UI must have a zero-base catalogue", () => {
    // The same rule lib/i18n.test.ts applies to the legacy dictionary. Offering
    // a language whose product surfaces render English is the silent-drop bug.
    for (const option of LANGUAGE_OPTIONS) {
      expect(
        Object.keys(ZERO_BASE_COPY),
        `${option.value} is offered in the UI but has no zero-base catalogue`,
      ).toContain(option.value);
    }
  });
});
