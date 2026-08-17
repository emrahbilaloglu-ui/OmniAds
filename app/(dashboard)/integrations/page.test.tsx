// @vitest-environment jsdom

import { useQuery } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

import { buildDefaultProviderDomains } from "@/store/integrations-support";
import type { GoogleAdsStatusResponse } from "@/lib/google-ads/status-types";
import type { MetaStatusResponse } from "@/lib/meta/status-types";
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

function connectDomains(providers: IntegrationProvider[]) {
  const domains = buildDefaultProviderDomains();
  for (const provider of providers) {
    domains[provider] = {
      ...domains[provider],
      connection: {
        status: "connected",
        connectedAt: "2026-03-02T00:00:00.000Z",
        lastSyncAt: "2026-08-17T11:56:00.000Z",
        providerAccountId: "acct_1",
        providerAccountName: "aurora-supply.myshopify.com",
      },
    };
  }
  return domains;
}

beforeEach(() => {
  vi.clearAllMocks();
  appState.selectedBusinessId = "biz_1";
  appState.hasHydrated = true;
  appState.authBootstrapStatus = "ready";
  statusState.meta = undefined;
  statusState.google = undefined;
  statusState.shopify = undefined;
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
    expect(card.textContent).toContain("no authorization flow available yet");
  });

  it("drives the first-sync block from the served Meta status, not a timer", () => {
    integrationsState.domainsByBusinessId = { biz_1: connectDomains(["meta"]) };
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

  it("never shows a first-sync block for a provider with no served status", () => {
    integrationsState.domainsByBusinessId = { biz_1: connectDomains(["shopify"]) };
    statusState.shopify = { connected: false } as unknown as ShopifyStatusResponse;
    const { container } = render(<IntegrationsPage />);
    const card = container.querySelector('article[data-provider="shopify"]')!;
    expect(within(card as HTMLElement).queryByTestId("integration-first-sync")).toBeNull();
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
