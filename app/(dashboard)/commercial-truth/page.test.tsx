import React from "react";
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
  selectedBusinessId: "biz_1",
};

vi.mock("@/components/business/BusinessEmptyState", () => ({
  BusinessEmptyState: () => React.createElement("div", null, "business-empty"),
}));

vi.mock("@/components/settings/commercial-truth-settings", () => ({
  CommercialTruthSettingsSection: (props: { businessId: string }) =>
    React.createElement("div", null, `commercial-truth-settings:${props.businessId}`),
}));

vi.mock("@/components/settings/settings-section", () => ({
  SettingsStat: (props: { label: string; value: string }) =>
    React.createElement("div", null, `${props.label}:${props.value}`),
}));

vi.mock("@/store/app-store", () => ({
  useAppStore: (selector: (state: typeof mockAppState) => unknown) => selector(mockAppState),
}));

vi.mock("@/store/preferences-store", () => ({
  usePreferencesStore: (selector: (state: { language: "en" }) => unknown) =>
    selector({ language: "en" }),
}));

describe("CommercialTruthPage", () => {
  beforeEach(() => {
    mockAppState.businesses = [
      {
        id: "biz_1",
        name: "Workspace One",
        timezone: "America/Los_Angeles",
        currency: "USD",
      },
    ];
    mockAppState.selectedBusinessId = "biz_1";
  });

  it("renders the dedicated page header and section for the active business", async () => {
    const { default: CommercialTruthPage } = await import(
      "@/app/(dashboard)/commercial-truth/legacy-page"
    );

    const html = renderToStaticMarkup(React.createElement(CommercialTruthPage));

    expect(html).toContain("Commercial Truth");
    expect(html).toContain("commercial-truth-settings:biz_1");
    expect(html).toContain("Workspace:Workspace One");
    expect(html).toContain("Currency:USD");
  });

  it("falls back to the business empty state when no workspace is selected", async () => {
    mockAppState.selectedBusinessId = null as never;

    const { default: CommercialTruthPage } = await import(
      "@/app/(dashboard)/commercial-truth/legacy-page"
    );

    const html = renderToStaticMarkup(React.createElement(CommercialTruthPage));

    expect(html).toContain("business-empty");
  });
});
