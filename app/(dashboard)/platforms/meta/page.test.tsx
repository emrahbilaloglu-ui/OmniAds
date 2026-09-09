import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import MetaPage from "@/app/(dashboard)/platforms/meta/legacy-page";

vi.mock("@/components/business/BusinessEmptyState", () => ({
  BusinessEmptyState: () => React.createElement("div", null, "business-empty"),
}));

vi.mock("@/components/meta/redesign/MetaPlatformPage", () => ({
  MetaPlatformPage: (props: {
    businessId: string;
    businessName?: string | null;
    currency?: string | null;
    accountSelection?: "shared" | "local";
  }) =>
    React.createElement(
      "div",
      null,
      `meta-platform:${props.businessId}:${props.businessName ?? ""}:${props.currency ?? ""}:${props.accountSelection ?? ""}`,
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
  it("renders the full five-lane Decision Center for the selected business, with its scope", () => {
    expect(renderToStaticMarkup(<MetaPage />)).toContain(
      "meta-platform:biz_1:TheSwaf:USD:local",
    );
  });

  it("uses the server-authorized route scope instead of a different selected-store business", () => {
    expect(
      renderToStaticMarkup(
        <MetaPage
          businessId="biz_route"
          businessName="Route Business"
          currency="TRY"
          accountSelection="shared"
        />,
      ),
    ).toContain("meta-platform:biz_route:Route Business:TRY:shared");
  });
});
