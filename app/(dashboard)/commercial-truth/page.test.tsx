import React from "react";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const mockAppState = {
  businesses: [
    {
      id: "biz_1",
      name: "Workspace One",
      timezone: "America/Los_Angeles",
      currency: "USD",
    },
  ],
  selectedBusinessId: "biz_1" as string | null,
};

vi.mock("@/components/business/BusinessEmptyState", () => ({
  BusinessEmptyState: () => React.createElement("div", null, "business-empty"),
}));

vi.mock("@/store/app-store", () => ({
  useAppStore: (selector: (state: typeof mockAppState) => unknown) => selector(mockAppState),
}));

// The screen reads five endpoints; SSR here only covers the route shell.
const originalFetch = globalThis.fetch;

describe("/commercial-truth", () => {
  beforeEach(() => {
    mockAppState.selectedBusinessId = "biz_1";
    globalThis.fetch = (() =>
      Promise.resolve({ ok: false, json: () => Promise.resolve(null) })) as unknown as typeof fetch;
  });

  it("renders the exact Commercial Truth screen for the active workspace", async () => {
    const { default: CommercialTruthPage } = await import(
      "@/app/(dashboard)/commercial-truth/legacy-page"
    );
    const html = renderToStaticMarkup(React.createElement(CommercialTruthPage));

    expect(html).toContain('data-screen-label="Commercial Truth"');
    expect(html).toContain("Single source");
    expect(html).toContain("Target pack");
    expect(html).toContain("Where spend sits against these targets");
    globalThis.fetch = originalFetch;
  });

  it("falls back to the business empty state when no workspace is selected", async () => {
    mockAppState.selectedBusinessId = null;
    const { default: CommercialTruthPage } = await import(
      "@/app/(dashboard)/commercial-truth/legacy-page"
    );
    const html = renderToStaticMarkup(React.createElement(CommercialTruthPage));
    expect(html).toContain("business-empty");
    globalThis.fetch = originalFetch;
  });
});

describe("every route family that reaches Commercial Truth uses one component", () => {
  it("the legacy body mounts the exact screen", () => {
    const source = readFileSync("app/(dashboard)/commercial-truth/legacy-page.tsx", "utf8");
    expect(source).toContain("CommercialTruthScreen");
    // The five sections the design has no equivalent of are gone from the route.
    expect(source).not.toContain("CommercialTruthSettingsSection");
    expect(source).not.toContain("commercial-truth-blocks");
  });

  it("the /c/[businessId]/manage/business leaf mounts the same body", () => {
    // `/commercial-truth` redirects here, so the two must not diverge. The leaf
    // mounts the preserved legacy body itself rather than embedding the screen
    // inside the zero-base business ledger, so it carries its own header and
    // none of the five sections the design has no equivalent of.
    const source = readFileSync("app/c/[businessId]/manage/business/page.tsx", "utf8");
    expect(source).toContain('@/app/(dashboard)/commercial-truth/legacy-page');
    expect(source).not.toContain("BusinessClient");
    expect(source).not.toContain("showHeader");
  });
});
