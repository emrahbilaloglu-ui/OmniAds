import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import MetaPage from "@/app/(dashboard)/platforms/meta/legacy-page";

vi.mock("@/components/business/BusinessEmptyState", () => ({
  BusinessEmptyState: () => React.createElement("div", null, "business-empty"),
}));

// The route renders the Dashboard v2 Decision Center, superseding both
// MetaPlatformPage and the Meta OS DecisionsOsView.
vi.mock("@/components/meta/decision-center/DecisionCenterView", () => ({
  DecisionCenterView: (props: {
    businessId: string;
    businessName?: string | null;
    currency?: string | null;
  }) =>
    React.createElement(
      "div",
      null,
      `decision-center:${props.businessId}:${props.businessName ?? ""}:${props.currency ?? ""}`,
    ),
}));

vi.mock("@/store/app-store", () => ({
  useAppStore: (
    selector: (state: {
      selectedBusinessId: string | null;
      businesses: Array<{ id: string; name: string; currency: string }>;
    }) => unknown,
  ) =>
    selector({
      selectedBusinessId: "biz_1",
      businesses: [{ id: "biz_1", name: "TheSwaf", currency: "USD" }],
    }),
}));

describe("MetaPage", () => {
  /**
   * The business scope is not decoration: every decision, and the money on it,
   * is account-scoped beneath it. A route that mounted the view without the
   * selected business would read someone else's queue.
   */
  it("renders the Decision Center for the selected business, with its scope", () => {
    expect(renderToStaticMarkup(<MetaPage />)).toContain("decision-center:biz_1:TheSwaf:USD");
  });
});
