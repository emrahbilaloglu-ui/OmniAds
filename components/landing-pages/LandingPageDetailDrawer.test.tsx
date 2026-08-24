import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { LandingPagePerformanceRow } from "@/src/types/landing-pages";

vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children }: { children: React.ReactNode }) => <button type="button">{children}</button>,
}));

vi.mock("@tanstack/react-query", () => ({
  /**
   * Mounted pages hand this to `placeholderData` so a key change keeps the
   * previous rows on screen instead of blanking them to a skeleton. These
   * mocks never read it; the export just has to exist for the page to mount.
   */
  keepPreviousData: Symbol.for("keepPreviousData"),
  useQuery: () => ({
    data: undefined,
    isLoading: false,
    isFetching: false,
    isError: false,
    refetch: vi.fn(),
  }),
}));

vi.mock("@/store/preferences-store", () => ({
  usePreferencesStore: (selector: (state: { language: "en" }) => unknown) =>
    selector({ language: "en" }),
}));

const { LandingPageDetailDrawer } = await import("./LandingPageDetailDrawer");

function strongRow(): LandingPagePerformanceRow {
  return {
    path: "/products/winner",
    title: "Product page",
    sessions: 2000,
    engagementRate: 0.75,
    scrollRate: 0.7,
    viewItem: 1500,
    addToCarts: 400,
    checkouts: 260,
    addShippingInfo: 220,
    addPaymentInfo: 190,
    purchases: 120,
    totalRevenue: 24000,
    averagePurchaseRevenue: 200,
    sessionToViewItemRate: 0.75,
    viewItemToCartRate: 0.267,
    cartToCheckoutRate: 0.65,
    checkoutToShippingRate: 0.846,
    shippingToPaymentRate: 0.864,
    paymentToPurchaseRate: 0.632,
    sessionToPurchaseRate: 0.06,
    largestDropOffStep: "view_item",
    largestDropOffRate: 0.25,
    dataCompleteness: "complete",
  };
}

describe("LandingPageDetailDrawer truth boundary", () => {
  it("presents the client rule as a GA4 heuristic, not a Meta decision", () => {
    const html = renderToStaticMarkup(
      <LandingPageDetailDrawer
        businessId="biz_1"
        row={strongRow()}
        open
        currency="USD"
        siteBaseUrl="https://example.com"
        onOpenChange={vi.fn()}
      />,
    );

    expect(html).toContain("GA4 funnel heuristic");
    expect(html).toContain("Diagnostic only");
    expect(html).toContain("not a Meta buyerAction");
    expect(html).toContain("href=\"/platforms/meta?businessId=biz_1&amp;landingPage=%2Fproducts%2Fwinner\"");
    expect(html).not.toContain("Ready for controlled scale");
  });
});
