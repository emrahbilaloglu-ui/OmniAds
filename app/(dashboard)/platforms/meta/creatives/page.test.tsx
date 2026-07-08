import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import CreativesPage from "./page";

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
  it("renders the analysis-only Creative Studio library surface", () => {
    const html = renderPage();

    expect(html).toContain("data-testid=\"creative-studio-page\"");
    expect(html).toContain("Creative Studio");
    expect(html).toContain("Analysis only");
    expect(html).toContain("href=\"/platforms/meta\"");
    expect(html).not.toContain("creatives-briefing-page");
  });
});
