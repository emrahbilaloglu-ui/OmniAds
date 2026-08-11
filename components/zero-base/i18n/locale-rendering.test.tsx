// @vitest-environment jsdom

/**
 * WP-26 step 7 — mounted proof that a Turkish surface renders Turkish.
 *
 * The catalogue tests prove the strings exist and keep the glossary. This file
 * proves the wiring: a component under a Turkish provider must render Turkish
 * copy, not English, and must still render the non-translatable identifiers
 * exactly as the provider spells them.
 */
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { ZeroBaseCopyProvider } from "@/components/zero-base/i18n/copy-provider";
import {
  ErrorState,
  LoadingState,
  UnavailableState,
} from "@/components/zero-base/states/surface-state";
import { ZERO_BASE_COPY } from "@/lib/zero-base/copy";

function renderIn(language: "en" | "tr", node: React.ReactNode) {
  return render(<ZeroBaseCopyProvider language={language}>{node}</ZeroBaseCopyProvider>);
}

afterEach(cleanup);

describe("the state grammar renders in the active language", () => {
  it("REGRESSION: an unavailable surface says so in Turkish", () => {
    renderIn("tr", <UnavailableState reason="GA4 okunamadı." />);
    expect(screen.getByText(ZERO_BASE_COPY.tr.unavailable)).toBeTruthy();
    // The English word must not be on a Turkish surface.
    expect(screen.queryByText(ZERO_BASE_COPY.en.unavailable)).toBeNull();
  });

  it("renders English when the provider says English", () => {
    renderIn("en", <UnavailableState reason="GA4 could not be read." />);
    expect(screen.getByText(ZERO_BASE_COPY.en.unavailable)).toBeTruthy();
  });

  it("translates the retry affordance", () => {
    renderIn("tr", <ErrorState reason="Okuma başarısız." onRetry={() => {}} />);
    expect(screen.getByRole("button", { name: ZERO_BASE_COPY.tr.retry })).toBeTruthy();
  });

  it("translates the loading label but honours an explicit one", () => {
    const { unmount } = renderIn("tr", <LoadingState />);
    expect(screen.getByText(ZERO_BASE_COPY.tr.loading)).toBeTruthy();
    unmount();
    // A caller-supplied label is content, not grammar, and is left alone.
    renderIn("tr", <LoadingState label="Kararlar yükleniyor" />);
    expect(screen.getByText("Kararlar yükleniyor")).toBeTruthy();
  });

  it("falls back to English with no provider rather than rendering blanks", () => {
    render(<UnavailableState reason="No provider above this." />);
    expect(screen.getByText(ZERO_BASE_COPY.en.unavailable)).toBeTruthy();
  });
});

describe("non-translatable terms survive on a Turkish surface", () => {
  it("keeps provider and metric identifiers exactly", () => {
    renderIn("tr", <UnavailableState reason="ROAS ve CPA için Meta verisi yok." />);
    const text = document.body.textContent ?? "";
    for (const term of ["ROAS", "CPA", "Meta"]) {
      expect(text, `${term} was altered on a Turkish surface`).toContain(term);
    }
  });
});
