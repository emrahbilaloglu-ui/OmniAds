import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import MetaPage from "@/app/(dashboard)/platforms/meta/legacy-page";

vi.mock("@/components/business/BusinessEmptyState", () => ({
  BusinessEmptyState: () => React.createElement("div", null, "business-empty"),
}));

// The route now supersedes MetaPlatformPage with the Meta OS DecisionsOsView.
vi.mock("@/components/meta/os/DecisionsOsView", () => ({
  DecisionsOsView: (props: { businessId: string; businessName?: string | null }) =>
    React.createElement("div", null, `decisions-os:${props.businessId}:${props.businessName ?? ""}`),
}));

vi.mock("@/store/app-store", () => ({
  useAppStore: (selector: (state: { selectedBusinessId: string | null; businesses: Array<{ id: string; name: string; currency: string }> }) => unknown) =>
    selector({
      selectedBusinessId: "biz_1",
      businesses: [{ id: "biz_1", name: "TheSwaf", currency: "USD" }],
    }),
}));

describe("MetaPage", () => {
  it("renders the Meta OS decisions view for the selected business", () => {
    expect(renderToStaticMarkup(<MetaPage />)).toContain("decisions-os:biz_1:TheSwaf");
  });
});
