import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import MetaPage from "@/app/(dashboard)/platforms/meta/page";

vi.mock("@/components/business/BusinessEmptyState", () => ({
  BusinessEmptyState: () => React.createElement("div", null, "business-empty"),
}));

vi.mock("@/components/meta/redesign/MetaPlatformPage", () => ({
  MetaPlatformPage: (props: { businessId: string; businessName?: string | null }) =>
    React.createElement("div", null, `meta-platform:${props.businessId}:${props.businessName ?? ""}`),
}));

vi.mock("@/store/app-store", () => ({
  useAppStore: (selector: (state: { selectedBusinessId: string | null; businesses: Array<{ id: string; name: string; currency: string }> }) => unknown) =>
    selector({
      selectedBusinessId: "biz_1",
      businesses: [{ id: "biz_1", name: "TheSwaf", currency: "USD" }],
    }),
}));

describe("MetaPage", () => {
  it("renders the redesigned Meta platform page for the selected business", () => {
    expect(renderToStaticMarkup(<MetaPage />)).toContain("meta-platform:biz_1:TheSwaf");
  });
});
