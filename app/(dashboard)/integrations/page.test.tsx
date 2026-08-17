// @vitest-environment jsdom

import { useQuery } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

import { buildDefaultProviderDomains } from "@/store/integrations-support";
import type { GoogleAdsStatusResponse } from "@/lib/google-ads/status-types";
import type { GoogleAnalyticsStatusResponse } from "@/lib/google-analytics-status";
import type { MetaStatusResponse } from "@/lib/meta/status-types";
import type { SearchConsoleStatusResponse } from "@/lib/search-console-status";
import type { ShopifyStatusResponse } from "@/lib/shopify/status";
import type { IntegrationProvider } from "@/store/integrations-store";

const appState = vi.hoisted(() => ({
  hasHydrated: true,
  authBootstrapStatus: "ready" as string,
  businesses: [{ id: "biz_1", name: "Aurora Supply Co." }],
  selectedBusinessId: "biz_1" as string | null,
}));

const integrationsState = vi.hoisted(() => ({
  byBusinessId: {} as Record<string, unknown>,
  domainsByBusinessId: {} as Record<string, unknown>,
  assignedAccountsByBusiness: {} as Record<string, unknown>,
  setConnected: vi.fn(),
  disconnect: vi.fn(),
  setAssignedAccounts: vi.fn(),
  setProviderAccounts: vi.fn(),
}));

const statusState = vi.hoisted(() => ({
  meta: undefined as unknown,
  google: undefined as unknown,
  shopify: undefined as unknown,
  ga4: undefined as unknown,
  searchConsole: undefined as unknown,
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/integrations",
  useSearchParams: () => new URLSearchParams(""),
}));

vi.mock("@/store/app-store", () => ({
  useAppStore: (selector: (state: typeof appState) => unknown) => selector(appState),
}));

vi.mock("@/store/integrations-store", async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    "@/store/integrations-store",
  );
  return {
    ...actual,
    useIntegrationsStore: (selector: (state: typeof integrationsState) => unknown) =>
      selector(integrationsState),
  };
});

vi.mock("@tanstack/react-query", () => ({
  useQuery: vi.fn(),
}));

vi.mock("@/components/states/useTierZeroFreshness", () => ({
  useTierZeroFreshness: vi.fn(),
}));

vi.mock("@/hooks/use-business-integrations-bootstrap", () => ({
  useBusinessIntegrationsBootstrap: () => ({ isBootstrapping: false }),
}));

vi.mock("@/components/integrations/provider-assignment-drawer", () => ({
  ProviderAssignmentDrawer: ({ open, provider }: { open: boolean; provider: string | null }) =>
    open ? <div data-testid="assignment-drawer">{provider}</div> : null,
}));

vi.mock("@/components/integrations/ga4-property-picker", () => ({
  GA4PropertyPicker: ({ open }: { open: boolean }) =>
    open ? <div data-testid="ga4-picker" /> : null,
}));

vi.mock("@/lib/auth-diagnostics", () => ({ logClientAuthEvent: vi.fn() }));
vi.mock("@/lib/product-instrumentation-client", () => ({
  emitProductInstrumentation: vi.fn(),
}));

const IntegrationsPage = (await import("@/app/(dashboard)/integrations/legacy-page"))
  .default;
const useQueryMock = vi.mocked(useQuery);

/**
 * A complete connection: the row, plus whatever else its read gate demands.
 * GA4 needs a selected property and Search Console a selected site, and
 * Search Console also borrows the `google` grant — so connecting it connects
 * Google with the webmasters scope, which is the only shape that can import.
 */
function connectDomains(
  providers: IntegrationProvider[],
  overrides: { status?: string; connectedAt?: string } = {},
) {
  const domains = buildDefaultProviderDomains();
  const connect = (provider: IntegrationProvider) => {
    domains[provider] = {
      ...domains[provider],
      connection: {
        status: (overrides.status ?? "connected") as "connected" | "expired",
        connectedAt: overrides.connectedAt ?? "2026-03-02T00:00:00.000Z",
        lastSyncAt: new Date().toISOString(),
        providerAccountId: "acct_1",
        providerAccountName: "aurora-supply.myshopify.com",
        selectedEntityId: provider === "ga4" ? "12345678" : "sc-domain:aurora.example",
        scopes:
          "https://www.googleapis.com/auth/adwords https://www.googleapis.com/auth/webmasters.readonly",
      },
    };
  };
  for (const provider of providers) {
    connect(provider);
    if (provider === "search_console") connect("google");
  }
  return domains;
}

/** A connection made minutes ago, so a first import can still be running. */
function justConnectedAt() {
  return new Date(Date.now() - 10 * 60 * 1000).toISOString();
}

beforeEach(() => {
  vi.clearAllMocks();
  appState.selectedBusinessId = "biz_1";
  appState.hasHydrated = true;
  appState.authBootstrapStatus = "ready";
  statusState.meta = undefined;
  statusState.google = undefined;
  statusState.shopify = undefined;
  statusState.ga4 = undefined;
  statusState.searchConsole = undefined;
  integrationsState.byBusinessId = { biz_1: {} };
  integrationsState.domainsByBusinessId = { biz_1: buildDefaultProviderDomains() };
  integrationsState.assignedAccountsByBusiness = { biz_1: {} };

  useQueryMock.mockImplementation((options: unknown) => {
    const key = (options as { queryKey: unknown[] }).queryKey[0];
    const data =
      key === "meta-sync-status"
        ? statusState.meta
        : key === "google-ads-sync-status"
          ? statusState.google
          : key === "ga4-sync-status"
            ? statusState.ga4
            : key === "search-console-sync-status"
              ? statusState.searchConsole
              : statusState.shopify;
    return {
      data,
      isLoading: false,
      isFetching: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    } as never;
  });
});

afterEach(() => cleanup());

describe("/integrations route", () => {
  it("renders the design's six live cards in order with no banner between header and grid", () => {
    const { container } = render(<IntegrationsPage />);
    const cards = container.querySelectorAll("article[data-provider]");
    expect(
      Array.from(cards)
        .slice(0, 6)
        .map((card) => card.getAttribute("data-provider")),
    ).toEqual(["shopify", "meta", "google", "ga4", "search_console", "klaviyo"]);
    // The header ends at the sync-behaviour sentence: no business-name line,
    // no demo-fixtures chip, no toast band.
    expect(screen.queryByText("Aurora Supply Co.")).toBeNull();
    expect(screen.queryByText("demo fixtures")).toBeNull();
  });

  it("does not call Search Console connected when its borrowed Google grant is gone", () => {
    // BskTR in production: `search_console` connected with a site chosen,
    // `google` disconnected. Every Search Console read 401s, so the card that
    // sends the operator to the fix must not paint the source as working.
    const domains = connectDomains(["search_console"]);
    domains.google = buildDefaultProviderDomains().google;
    integrationsState.domainsByBusinessId = { biz_1: domains };

    const { container } = render(<IntegrationsPage />);
    const card = container.querySelector('article[data-provider="search_console"]')!;
    expect(card.textContent).toContain("Action required");
    expect(card.textContent).not.toContain("Connected");
  });

  it("does not call GA4 connected when no property has been selected", () => {
    const domains = connectDomains(["ga4"]);
    domains.ga4 = {
      ...domains.ga4,
      connection: { ...domains.ga4.connection, selectedEntityId: null },
    };
    integrationsState.domainsByBusinessId = { biz_1: domains };

    const { container } = render(<IntegrationsPage />);
    const card = container.querySelector('article[data-provider="ga4"]')!;
    expect(card.textContent).toContain("Needs setup");
    expect(card.textContent).not.toContain("Connected");
  });

  it("gives a connected card one Manage button that opens the assignment drawer", () => {
    integrationsState.domainsByBusinessId = { biz_1: connectDomains(["meta"]) };
    const { container } = render(<IntegrationsPage />);
    const card = container.querySelector('article[data-provider="meta"]')!;
    const buttons = card.querySelectorAll("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.textContent).toBe("Manage");
    fireEvent.click(buttons[0]!);
    expect(screen.getByTestId("assignment-drawer").textContent).toBe("meta");
  });

  it("sends Connect straight to the provider handshake with no interstitial dialog", () => {
    const assign = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { get href() { return ""; }, set href(value: string) { assign(value); } },
    });
    const { container } = render(<IntegrationsPage />);
    const card = container.querySelector('article[data-provider="google"]')!;
    fireEvent.click(within(card as HTMLElement).getByRole("button", { name: "Connect" }));
    expect(screen.queryByText("Requested permissions")).toBeNull();
    expect(assign).toHaveBeenCalledWith(
      expect.stringContaining("/api/oauth/google/start?businessId=biz_1"),
    );
  });

  it("gives Klaviyo no button at all, because its OAuth route answers 501", () => {
    const { container } = render(<IntegrationsPage />);
    const card = container.querySelector('article[data-provider="klaviyo"]')!;
    expect(card.querySelectorAll("button")).toHaveLength(0);
    expect(card.textContent).toContain("no data pulled yet");
  });

  it("drives the first-sync block from the served Meta status, not a timer", () => {
    integrationsState.domainsByBusinessId = {
      biz_1: connectDomains(["meta"], { connectedAt: justConnectedAt() }),
    };
    statusState.meta = {
      state: "syncing",
      connected: true,
      assignedAccountIds: ["act_1"],
      priorityWindow: { completedDays: 14, totalDays: 28 },
      coreReadiness: { complete: false },
    } as unknown as MetaStatusResponse;

    const { container } = render(<IntegrationsPage />);
    const card = container.querySelector('article[data-provider="meta"]')!;
    const block = within(card as HTMLElement).getByTestId("integration-first-sync");
    expect(within(block).getByText("First sync")).toBeTruthy();
    expect(within(block).getByText("59%")).toBeTruthy();
    expect(within(block).getByText("Backfill 28 days")).toBeTruthy();
    expect(card.querySelectorAll("button")).toHaveLength(0);
    expect(card.textContent).toContain("first import running");
  });

  it("hides the first-sync block once the provider reports a landed snapshot", () => {
    integrationsState.domainsByBusinessId = { biz_1: connectDomains(["google"]) };
    statusState.google = {
      state: "ready",
      connected: true,
      assignedAccountIds: ["493-118-2201"],
    } as unknown as GoogleAdsStatusResponse;

    const { container } = render(<IntegrationsPage />);
    const card = container.querySelector('article[data-provider="google"]')!;
    expect(within(card as HTMLElement).queryByTestId("integration-first-sync")).toBeNull();
  });

  it("never calls a months-old broken Google connection a first import", () => {
    integrationsState.domainsByBusinessId = {
      biz_1: connectDomains(["google"], { status: "expired" }),
    };
    // Backfill long finished; the token was revoked afterwards.
    statusState.google = {
      state: "action_required",
      connected: true,
      assignedAccountIds: ["493-118-2201"],
      historicalProgress: { percent: 100, visible: true, summary: "" },
    } as unknown as GoogleAdsStatusResponse;

    const { container } = render(<IntegrationsPage />);
    const card = container.querySelector('article[data-provider="google"]')!;
    expect(within(card as HTMLElement).queryByTestId("integration-first-sync")).toBeNull();
    expect(card.textContent).not.toContain("First sync");
    expect(card.textContent).not.toContain("first import running");
    expect(card.textContent).toContain("Action required");
  });

  it("never shows a first-sync block for a provider with no served status", () => {
    integrationsState.domainsByBusinessId = { biz_1: connectDomains(["shopify"]) };
    statusState.shopify = { connected: false } as unknown as ShopifyStatusResponse;
    const { container } = render(<IntegrationsPage />);
    const card = container.querySelector('article[data-provider="shopify"]')!;
    expect(within(card as HTMLElement).queryByTestId("integration-first-sync")).toBeNull();
  });

  it("drives the GA4 card's block from the served GA4 status", () => {
    integrationsState.domainsByBusinessId = {
      biz_1: connectDomains(["ga4"], { connectedAt: justConnectedAt() }),
    };
    statusState.ga4 = {
      provider: "ga4",
      connected: true,
      state: "syncing",
      propertyReady: true,
      backfillPercent: null,
      snapshotReady: false,
    } as unknown as GoogleAnalyticsStatusResponse;

    const { container } = render(<IntegrationsPage />);
    const card = container.querySelector('article[data-provider="ga4"]')!;
    const block = within(card as HTMLElement).getByTestId("integration-first-sync");
    expect(within(block).getByText("First sync")).toBeTruthy();
    // GA4 exposes no share of the backfill window, so the bar parks at the
    // start of that stage instead of approximating one.
    expect(within(block).getByText("35%")).toBeTruthy();
    expect(within(block).getByText("Backfill 28 days")).toBeTruthy();
    expect(card.textContent).toContain("first import running");
  });

  it("drives the Search Console card's block from the served Search Console status", () => {
    integrationsState.domainsByBusinessId = {
      biz_1: connectDomains(["search_console"], { connectedAt: justConnectedAt() }),
    };
    statusState.searchConsole = {
      provider: "search_console",
      connected: true,
      state: "syncing",
      siteReady: true,
      googleAuthority: { connected: true, hasSearchConsoleScope: true },
      backfillPercent: null,
      snapshotReady: false,
    } as unknown as SearchConsoleStatusResponse;

    const { container } = render(<IntegrationsPage />);
    const card = container.querySelector('article[data-provider="search_console"]')!;
    expect(
      within(within(card as HTMLElement).getByTestId("integration-first-sync")).getByText("35%"),
    ).toBeTruthy();
  });

  it("shows no block for a GA4 property that has been connected for months", () => {
    integrationsState.domainsByBusinessId = { biz_1: connectDomains(["ga4"]) };
    statusState.ga4 = {
      provider: "ga4",
      connected: true,
      state: "syncing",
      propertyReady: true,
      backfillPercent: null,
      snapshotReady: false,
    } as unknown as GoogleAnalyticsStatusResponse;

    const { container } = render(<IntegrationsPage />);
    const card = container.querySelector('article[data-provider="ga4"]')!;
    expect(within(card as HTMLElement).queryByTestId("integration-first-sync")).toBeNull();
    expect(card.textContent).not.toContain("first import running");
  });

  it("shows no block for a Search Console card whose Google authority is broken", () => {
    integrationsState.domainsByBusinessId = {
      biz_1: connectDomains(["search_console"], { connectedAt: justConnectedAt() }),
    };
    statusState.searchConsole = {
      provider: "search_console",
      connected: true,
      state: "action_required",
      siteReady: true,
      googleAuthority: { connected: false, hasSearchConsoleScope: false },
      backfillPercent: null,
      snapshotReady: false,
    } as unknown as SearchConsoleStatusResponse;

    const { container } = render(<IntegrationsPage />);
    const card = container.querySelector('article[data-provider="search_console"]')!;
    expect(within(card as HTMLElement).queryByTestId("integration-first-sync")).toBeNull();
    expect(card.textContent).not.toContain("first import running");
  });

  it("lists the three roadmap providers under a single Coming soon heading", () => {
    render(<IntegrationsPage />);
    const headings = screen.getAllByRole("heading", { level: 2 });
    expect(headings).toHaveLength(1);
    expect(headings[0]!.textContent).toBe("Coming soon");
    expect(screen.getByText("TikTok Ads")).toBeTruthy();
    expect(screen.getByText("Pinterest")).toBeTruthy();
    expect(screen.getByText("Snapchat")).toBeTruthy();
  });
});
