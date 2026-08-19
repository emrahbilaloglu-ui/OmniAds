import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  savedViewsByScope: {} as Record<string, unknown[]>,
  saveView: vi.fn(),
  deleteSavedView: vi.fn(),
}));

vi.mock("@/store/preferences-store", () => ({
  usePreferencesStore: (selector: (s: unknown) => unknown) => selector(state),
}));

import { SavedViewsMenu } from "@/components/views/SavedViewsMenu";

const source = readFileSync("components/views/SavedViewsMenu.tsx", "utf8");

function render(props: Partial<React.ComponentProps<typeof SavedViewsMenu>> = {}) {
  return renderToStaticMarkup(
    <SavedViewsMenu
      surface="meta-decisions"
      businessId="biz-1"
      currentConfig={{ lane: "act" }}
      onApply={() => {}}
      {...props}
    />,
  );
}

describe("saved views are reachable from a surface", () => {
  // Not mounted anywhere today. The only mount was the pre-redesign Decisions
  // screen, which the reference toolbar replaced with lane pills, Deferred,
  // sort and search; the menu itself still holds its scope and applicability
  // laws for whichever surface adopts it next.
  it("renders a control", () => {
    expect(render()).toContain("Views");
  });

  it("renders nothing without a business, rather than an unscoped menu", () => {
    expect(render({ businessId: "" })).toBe("");
  });
});

describe("the menu respects scope", () => {
  it("reads and writes through the scope key", () => {
    expect(source).toContain("savedViewScopeKey(surface, businessId)");
    expect(source).toContain("selectSavedViews(scoped, surface, businessId)");
  });

  it("checks applicability before offering to restore a view", () => {
    expect(source).toContain("isSavedViewApplicable(view, availableAccountIds)");
    expect(source).toContain("disabled={!applicable}");
  });

  it("explains why an unavailable view cannot be applied", () => {
    expect(source).toContain("title={reason ?? undefined}");
    expect(source).toContain("— unavailable");
  });

  it("validates the name instead of silently refusing to save", () => {
    expect(source).toContain("validateSavedViewName(name, views)");
    expect(source).toContain("describeSavedViewError(problem)");
  });

  it("takes the account list from its caller so applicability is real", () => {
    expect(source).toContain("availableAccountIds");
    expect(source).toContain("isSavedViewApplicable(view, availableAccountIds)");
  });
});
