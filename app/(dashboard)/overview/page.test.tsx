import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const mockUseQuery = vi.fn();
const mockGetTodayIsoForTimeZone = vi.fn();
const mockGetPresetDatesForReferenceDate = vi.fn();
const capturedPickerProps: Array<Record<string, unknown>> = [];

vi.mock("@tanstack/react-query", () => ({
  useQuery: (input: { queryKey: unknown[] }) => mockUseQuery(input),
}));

vi.mock("@/components/date-range/DateRangePicker", () => ({
  DateRangePicker: (props: Record<string, unknown>) => {
    capturedPickerProps.push(props);
    return React.createElement("div", null, "date-range-picker");
  },
  getTodayIsoForTimeZone: (...args: [string]) => mockGetTodayIsoForTimeZone(...args),
  getPresetDatesForReferenceDate: (
    ...args: [string, string, string | undefined, string | undefined]
  ) => mockGetPresetDatesForReferenceDate(...args),
}));

vi.mock("@/components/business/BusinessEmptyState", () => ({
  BusinessEmptyState: () => React.createElement("div", null, "business-empty"),
}));
vi.mock("@/components/states/error-state", () => ({
  ErrorState: () => React.createElement("div", null, "error-state"),
}));
vi.mock("@/components/overview/CostModelSheet", () => ({
  CostModelSheet: () => React.createElement("div", null, "cost-model-sheet"),
}));

vi.mock("@/hooks/use-persistent-date-range", () => ({
  usePersistentDateRange: () => [
    {
      rangePreset: "today",
      customStart: "",
      customEnd: "",
      comparisonPreset: "none",
      comparisonStart: "",
      comparisonEnd: "",
    },
    vi.fn(),
  ],
}));

vi.mock("@/lib/overview-metric-catalog", () => ({
  buildOverviewMetricCatalog: () => [],
  DEFAULT_PINNED_METRICS: ["revenue"],
}));
vi.mock("@/store/preferences-store", () => ({
  usePreferencesStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      language: "en",
      overviewPinsByContext: {},
      setOverviewPins: vi.fn(),
      pinOverviewMetric: vi.fn(),
      unpinOverviewMetric: vi.fn(),
      moveOverviewMetric: vi.fn(),
    }),
}));
vi.mock("@/lib/business-mode", () => ({
  isDemoBusinessSelected: () => false,
}));
vi.mock("@/store/app-store", () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      businesses: [
        {
          id: "biz",
          name: "Biz",
          timezone: "America/Los_Angeles",
          currency: "USD",
        },
      ],
      selectedBusinessId: "biz",
      workspaceOwnerId: "owner_1",
    }),
}));
vi.mock("@/store/integrations-support", () => ({
  buildDefaultProviderDomains: () => ({ ga4: {} }),
  deriveProviderViewState: () => ({ isConnected: false }),
}));
vi.mock("@/store/integrations-store", () => ({
  useIntegrationsStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      domainsByBusinessId: {},
      ensureBusiness: vi.fn(),
    }),
}));
vi.mock("@/lib/sync/sync-status-pill", () => ({
  resolveProviderSyncStatusPill: () => null,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/overview",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/components/layout/v2/use-shell-signals", () => ({
  useMetaActionNowCount: () => null,
  useWorkspaceSyncState: () => ({ tone: "fresh", label: "Synced 12m ago" }),
}));
vi.mock("@/src/services", () => ({
  getOverviewSummary: vi.fn(),
  getOverviewSparklines: vi.fn(),
  getLatestAiInsight: vi.fn(),
  generateAiInsight: vi.fn(),
  upsertBusinessCostModel: vi.fn(),
}));

function baseQueryState(overrides: Record<string, unknown> = {}) {
  return {
    data: undefined,
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
    state: { data: undefined },
    ...overrides,
  };
}

describe("OverviewPage timezone date selection", () => {
  beforeEach(() => {
    capturedPickerProps.length = 0;
    mockUseQuery.mockReset();
    mockGetTodayIsoForTimeZone.mockReset();
    mockGetPresetDatesForReferenceDate.mockReset();
    mockGetTodayIsoForTimeZone.mockReturnValue("2026-04-07");
    mockGetPresetDatesForReferenceDate.mockReturnValue({
      start: "2026-04-07",
      end: "2026-04-07",
    });
    mockUseQuery.mockImplementation(({ queryKey }: { queryKey: unknown[] }) => {
      const key = String(queryKey[0]);
      if (key === "overview-summary") {
        return baseQueryState({
          data: {
            comparison: { startDate: null, endDate: null },
            storeMetrics: [],
            ltv: [],
            expenses: [],
            customMetrics: [],
            webAnalytics: [],
            platforms: [],
            attribution: [],
            costModel: { configured: false, values: null },
            shopifyServing: null,
          },
        });
      }
      return baseQueryState();
    });
  });

  it("uses workspace timezone for overview preset resolution and picker props", async () => {
    const { default: OverviewPage } = await import("@/app/(dashboard)/overview/legacy-page");

    renderToStaticMarkup(React.createElement(OverviewPage));

    expect(mockGetTodayIsoForTimeZone).toHaveBeenCalledWith("America/Los_Angeles");
    expect(mockGetPresetDatesForReferenceDate).toHaveBeenCalledWith(
      "today",
      "2026-04-07",
      "",
      ""
    );

    const overviewSummaryCall = mockUseQuery.mock.calls.find((call) => {
      const input = call[0] as { queryKey: unknown[] } | undefined;
      return input?.queryKey?.[0] === "overview-summary";
    });
    expect(overviewSummaryCall?.[0].queryKey).toEqual([
      "overview-summary",
      "biz",
      "2026-04-07",
      "2026-04-07",
      "none",
    ]);

    // Dashboard v2 moves the range control into the shell topbar, so the page
    // itself must not render a second picker.
    expect(capturedPickerProps).toHaveLength(0);
  });

  it("keeps the shell topbar picker resolving against the workspace timezone", async () => {
    const { AppTopbar } = await import("@/components/layout/v2/app-topbar");

    renderToStaticMarkup(
      React.createElement(AppTopbar, { userName: "Reviewer", onOpenNav: () => {} }),
    );

    expect(mockGetTodayIsoForTimeZone).toHaveBeenCalledWith("America/Los_Angeles");
    expect(capturedPickerProps).toHaveLength(1);
    expect(capturedPickerProps[0]?.referenceDate).toBe("2026-04-07");
    expect(capturedPickerProps[0]?.timeZoneLabel).toBe("America/Los_Angeles");
    expect(capturedPickerProps[0]?.variant).toBe("v2");
  });
});
