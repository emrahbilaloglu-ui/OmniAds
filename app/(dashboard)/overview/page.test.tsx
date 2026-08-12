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
vi.mock("@/components/ui/badge", () => ({
  Badge: (props: { children: React.ReactNode }) => React.createElement("div", null, props.children),
}));
vi.mock("@/components/ui/button", () => ({
  Button: (props: { children: React.ReactNode }) => React.createElement("button", null, props.children),
}));
vi.mock("@/components/overview/SummaryMetricCard", () => ({
  SummaryMetricCard: () => React.createElement("div", null, "summary-metric-card"),
}));
vi.mock("@/components/overview/SummarySection", () => ({
  SummarySection: (props: { children: React.ReactNode }) => React.createElement("section", null, props.children),
}));
vi.mock("@/components/overview/SummaryAttributionTable", () => ({
  SummaryAttributionTable: () => React.createElement("div", null, "summary-attribution-table"),
}));
vi.mock("@/components/overview/AiDailyBrief", () => ({
  AiDailyBrief: () => React.createElement("div", null, "ai-daily-brief"),
}));
vi.mock("@/components/overview/PinsSection", () => ({
  PinsSection: () => React.createElement("div", null, "pins-section"),
}));
vi.mock("@/components/overview/CostModelSheet", () => ({
  CostModelSheet: () => React.createElement("div", null, "cost-model-sheet"),
}));
vi.mock("@/components/sync/sync-status-pill", () => ({
  SyncStatusPill: () => React.createElement("div", null, "sync-status-pill"),
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

    expect(capturedPickerProps).toHaveLength(1);
    expect(capturedPickerProps[0]?.referenceDate).toBe("2026-04-07");
    expect(capturedPickerProps[0]?.timeZoneLabel).toBe("America/Los_Angeles");
  });
});
