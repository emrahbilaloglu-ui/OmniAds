import { describe, expect, it } from "vitest";
import {
  DEFAULT_LANGUAGE,
  LANGUAGE_OPTIONS,
  TRANSLATED_LANGUAGES,
  getTranslations,
  isTranslatedLanguage,
  translations,
} from "@/lib/i18n";

/**
 * `AppLanguage` is wider than what is translated. A user can sign up in Turkish
 * and carry `language: "tr"` into the app, where there is no Turkish dictionary
 * to serve. The risk is not the fallback itself — it is offering a language in
 * the UI that silently does nothing.
 */
describe("the product only offers languages it can actually render", () => {
  it("never offers a language it has no dictionary for", () => {
    for (const option of LANGUAGE_OPTIONS) {
      expect(
        isTranslatedLanguage(option.value),
        `${option.value} is offered in the UI but has no dictionary`,
      ).toBe(true);
    }
  });

  it("derives the translated set from the dictionaries themselves", () => {
    expect(TRANSLATED_LANGUAGES.sort()).toEqual(Object.keys(translations).sort());
  });

  it("can always render the default language", () => {
    expect(isTranslatedLanguage(DEFAULT_LANGUAGE)).toBe(true);
  });
});

describe("getTranslations", () => {
  it("serves the dictionary for a translated language", () => {
    expect(getTranslations("en")).toBe(translations.en);
  });

  it("falls back to the default for a language it cannot render", () => {
    expect(getTranslations("tr")).toBe(translations[DEFAULT_LANGUAGE]);
  });

  it("falls back for missing or unknown values instead of throwing", () => {
    expect(getTranslations(undefined)).toBe(translations[DEFAULT_LANGUAGE]);
    expect(getTranslations("de" as never)).toBe(translations[DEFAULT_LANGUAGE]);
  });

  it("returns real copy, not an empty object", () => {
    expect(Object.keys(getTranslations("en")).length).toBeGreaterThan(0);
  });
});

describe("isTranslatedLanguage", () => {
  it("recognises a shipped dictionary", () => {
    expect(isTranslatedLanguage("en")).toBe(true);
  });

  it("rejects a language with no dictionary, including null and empty", () => {
    expect(isTranslatedLanguage("tr")).toBe(false);
    expect(isTranslatedLanguage(null)).toBe(false);
    expect(isTranslatedLanguage(undefined)).toBe(false);
    expect(isTranslatedLanguage("")).toBe(false);
  });
});
