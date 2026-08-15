import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import CreativesPage from "./legacy-page";

vi.mock("@/store/app-store", () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      selectedBusinessId: "biz_1",
      businesses: [{ id: "biz_1", name: "Nordventure", currency: "EUR" }],
    }),
}));

vi.mock("@/hooks/use-persistent-date-range", () => ({
  usePersistentCreativeDateRange: () => [
    {
      preset: "last30Days",
      customStart: "",
      customEnd: "",
      lastDays: 30,
      sinceDate: "",
    },
    vi.fn(),
  ],
}));

vi.mock("@/lib/pricing/usePlan", () => ({
  usePlanState: () => ({ plan: "growth", isLoading: false, isReady: true }),
}));

function renderPage() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <CreativesPage />
    </QueryClientProvider>,
  );
}

describe("/platforms/meta/creatives page", () => {
  it("renders the scoped Creative Studio OS surface", () => {
    const html = renderPage();

    expect(html).toContain("data-testid=\"creative-studio-page\"");
    expect(html).toContain("data-testid=\"creative-studio-os\"");
    expect(html).toContain("Creative Studio");
    // The Studio renders inside the app frame and owns no primary navigation.
    // A fixed mobile drawer is allowed, but the route root itself is responsive.
    expect(html).toContain('data-responsive-studio="true"');
    expect(html).toContain('data-provider-writes="none"');
    expect(html).not.toContain('aria-label="Primary"');
    expect(html).not.toContain("data-studio-nav-rail");
    // With no resolved provider account the surface withholds performance.
    expect(html).toContain("data-testid=\"creative-studio-account-required\"");
    expect(html).not.toContain("creatives-briefing-page");
  });
});
