import React from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/store/app-store", () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      selectedBusinessId: "biz",
      businesses: [{ id: "biz", name: "IwaStore", currency: "USD" }],
    }),
}));

vi.mock("@/app/(dashboard)/creatives/page-support", () => ({
  fetchCreativeDecisionEngineV3: vi.fn(),
  fetchMetaCreatives: vi.fn(),
  mapApiRowToUiRow: (row: unknown) => row,
}));

const { default: MetaLaunchpadPage } = await import("./page");

describe("MetaLaunchpadPage", () => {
  it("renders the wizard shell with Launchpad steps and initial navigation gate", () => {
    const html = renderToStaticMarkup(<MetaLaunchpadPage />);

    expect(html).toContain("Meta Launchpad");
    expect(html).toContain("Launch new campaign");
    expect(html).toContain("Add to existing campaign");
    expect(html).toContain("Creative selection");
    expect(html).toContain("Templates");
    expect(html).toContain("Ad sets");
    expect(html).toContain("Review");
    expect(html).toContain("Next");
    expect(html).toContain("disabled");
  });
});
