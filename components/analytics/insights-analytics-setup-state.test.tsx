// @vitest-environment jsdom

import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What Grandmix actually sees: GA4 connected, no property selected.
 *
 * The route answers 422 `no_property_selected` with `action: "select_property"`,
 * and both of these screens used to render that through the generic error card —
 * "Something went wrong", with a Retry that can never resolve a setup step.
 */
const push = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
  usePathname: () => "/insights/analytics",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/store/app-store", () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({ businesses: [], selectedBusinessId: "biz-1", workspaceResolved: true }),
}));

vi.mock("@/store/integrations-store", () => ({
  useIntegrationsStore: (selector: (state: unknown) => unknown) =>
    selector({ domainsByBusinessId: { "biz-1": { ga4: {} } } }),
}));

vi.mock("@/store/integrations-support", () => ({
  buildDefaultProviderDomains: () => ({ ga4: {} }),
  deriveProviderViewState: () => ({ isConnected: true, status: "ready" }),
}));

vi.mock("@/hooks/use-business-integrations-bootstrap", () => ({
  useBusinessIntegrationsBootstrap: () => ({
    isBootstrapping: false,
    bootstrapStatus: "ready",
  }),
}));

vi.mock("@/hooks/use-persistent-date-range", () => ({
  usePersistentDateRange: () => [
    { rangePreset: "28d", comparisonPreset: "previous_period" },
    () => {},
  ],
}));

vi.mock("@/components/analytics/InsightsAnalyticsExact", () => ({
  InsightsAnalyticsExact: () => <div data-testid="analytics-exact" />,
}));

vi.mock("@/components/geo/InsightsGeoExact", () => ({
  InsightsGeoExact: () => <div data-testid="geo-exact" />,
}));

const { InsightsAnalyticsScreen } = await import(
  "@/components/analytics/InsightsAnalyticsScreen"
);
const { InsightsGeoScreen } = await import("@/components/geo/InsightsGeoScreen");

function respondWith(body: Record<string, unknown>, status: number) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  );
}

function renderScreen(node: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

beforeEach(() => {
  push.mockClear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Insights Analytics: GA4 property never selected", () => {
  beforeEach(() => {
    respondWith(
      {
        error: "no_property_selected",
        message: "GA4 is connected but no property is selected for this business.",
        action: "select_property",
      },
      422,
    );
  });

  it("does not announce a crash", async () => {
    renderScreen(<InsightsAnalyticsScreen />);
    await screen.findByText("Select a GA4 property to unlock Analytics");
    expect(screen.queryByText("Something went wrong")).toBeNull();
  });

  it("offers the action that actually resolves it instead of Retry", async () => {
    renderScreen(<InsightsAnalyticsScreen />);
    await screen.findByText("Select a GA4 property to unlock Analytics");
    expect(screen.getByRole("button", { name: "Open Integrations" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("keeps the server's own sentence", async () => {
    renderScreen(<InsightsAnalyticsScreen />);
    const description = await screen.findByText(/no property is selected/);
    expect(description.textContent).toContain(
      "Select a GA4 property in Integrations to continue.",
    );
  });
});

describe("Insights Analytics: a real failure", () => {
  it("keeps the error card and its Retry", async () => {
    respondWith({ error: "ga4_fetch_failed", message: "GA4 reporting is unavailable." }, 502);
    renderScreen(<InsightsAnalyticsScreen />);
    await screen.findByText("Something went wrong");
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });
});

describe("Insights AI Visibility: GA4 property never selected", () => {
  it("renders the same setup state rather than the generic error card", async () => {
    respondWith(
      {
        error: "no_property_selected",
        message: "GA4 is connected but no property is selected for this business.",
        action: "select_property",
      },
      422,
    );
    renderScreen(<InsightsGeoScreen />);
    await screen.findByText("Select a GA4 property to unlock AI Visibility");
    expect(screen.queryByText("Something went wrong")).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("reads the setup state from the error code alone", async () => {
    // Proof the screen is not relying on a route remembering to forward the
    // action: the code by itself is enough.
    respondWith(
      {
        error: "no_property_selected",
        message: "GA4 is connected but no property is selected for this business.",
      },
      422,
    );
    renderScreen(<InsightsGeoScreen />);
    await screen.findByText("Select a GA4 property to unlock AI Visibility");
  });
});
