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
  it("renders the Launchpad index with mode cards and endpoint-backed library sections", () => {
    const html = renderToStaticMarkup(<MetaLaunchpadPage />);

    expect(html).toContain("Launchpad · Meta");
    expect(html).toContain("Launch new campaign");
    expect(html).toContain("Add ads to existing");
    expect(html).toContain("Manage existing ads");
    expect(html).toContain("Will launch as PAUSED");
    expect(html).toContain("Drafts");
    expect(html).toContain("Templates");
    expect(html).toContain("No drafts yet.");
    expect(html).toContain("No templates yet.");
  });
});
