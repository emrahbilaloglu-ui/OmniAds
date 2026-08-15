import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const mockUseQuery = vi.fn();
const mockUseMutation = vi.fn();
const mockGetPresetDatesForReferenceDate = vi.fn();
const mockGetTodayIsoForTimeZone = vi.fn();
const capturedPickerProps: Array<Record<string, unknown>> = [];

vi.mock("@tanstack/react-query", () => ({
  useQuery: (input: { queryKey: unknown[] }) => mockUseQuery(input),
  useMutation: () => mockUseMutation(),
}));

vi.mock("@/components/date-range/DateRangePicker", () => ({
  DateRangePicker: (props: Record<string, unknown>) => {
    capturedPickerProps.push(props);
    return React.createElement("div", null, "date-range-picker");
  },
  getPresetDatesForReferenceDate: (
    ...args: [string, string, string | undefined, string | undefined]
  ) => mockGetPresetDatesForReferenceDate(...args),
  getTodayIsoForTimeZone: (...args: [string]) => mockGetTodayIsoForTimeZone(...args),
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

vi.mock("@/components/ui/skeleton", () => ({
  Skeleton: () => React.createElement("div", null, "skeleton"),
}));
vi.mock("@/components/overview/MiniTrendAreaChart", () => ({
  MiniTrendAreaChart: () => React.createElement("div", null, "mini-trend"),
}));
vi.mock("@/components/sync/sync-status-pill", () => ({
  SyncStatusPill: () => React.createElement("div", null, "sync-pill"),
  SyncStatusPillSkeleton: () => React.createElement("div", null, "sync-pill-skeleton"),
}));
vi.mock("@/components/states/empty-state", () => ({
  EmptyState: () => React.createElement("div", null, "empty-state"),
}));
vi.mock("@/components/states/error-state", () => ({
  ErrorState: () => React.createElement("div", null, "error-state"),
}));
vi.mock("@/components/google/google-advisor-panel", () => ({
  GoogleAdvisorPanel: () => React.createElement("div", null, "advisor-panel"),
}));
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: (props: { children: React.ReactNode }) => React.createElement("div", null, props.children),
  DropdownMenuCheckboxItem: (props: { children: React.ReactNode }) => React.createElement("div", null, props.children),
  DropdownMenuContent: (props: { children: React.ReactNode }) => React.createElement("div", null, props.children),
  DropdownMenuItem: (props: { children: React.ReactNode }) => React.createElement("div", null, props.children),
  DropdownMenuLabel: (props: { children: React.ReactNode }) => React.createElement("div", null, props.children),
  DropdownMenuSeparator: () => React.createElement("div", null, "separator"),
  DropdownMenuTrigger: (props: { children: React.ReactNode }) => React.createElement("div", null, props.children),
}));

vi.mock("@/components/google-ads/google-ads-dashboard-support", () => ({
  ACTION_CONFIG: [],
  fmtCurrency: (value: number) => String(value),
  fmtCurrencyPrecise: (value: number) => String(value),
  fmtNumber: (value: number) => String(value),
  fmtPct: (value: number) => String(value),
  fmtRoas: (value: number) => String(value),
  isCampaignActive: () => true,
  mapRangePresetToApi: (preset: string) => (preset === "today" ? "custom" : preset),
  normaliseBudgetRecommendations: () => [],
  ASSET_VIEWS: [],
  PANEL_ITEMS: [],
  resolveTrendTimeline: () => ({ labelMode: "day" }),
}));
vi.mock("@/lib/google-ads/advisor-ux", () => ({
  canOpenGoogleAdsAdvisor: () => false,
  getGoogleAdsAdvisorButtonLabel: () => "Analyze",
  getGoogleAdsAdvisorCtaState: () => "blocked",
  getGoogleAdsAdvisorHelperText: () => "Helper",
  getGoogleAdsAdvisorIdleState: () => ({
    title: "Advisor unavailable",
    description: "Advisor is unavailable for this test.",
  }),
}));
vi.mock("@/lib/sync/sync-status-pill", () => ({
  resolveGoogleAdsSyncStatusPill: () => null,
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

describe("GoogleAdsIntelligenceDashboard timezone date selection", () => {
  beforeEach(() => {
    capturedPickerProps.length = 0;
    mockUseQuery.mockReset();
    mockUseMutation.mockReset();
    mockGetPresetDatesForReferenceDate.mockReset();
    mockGetTodayIsoForTimeZone.mockReset();

    mockUseMutation.mockReturnValue({
      mutate: vi.fn(),
      isPending: false,
      isError: false,
    });
    mockGetPresetDatesForReferenceDate.mockReturnValue({
      start: "2026-04-07",
      end: "2026-04-07",
    });
    mockGetTodayIsoForTimeZone.mockReturnValue("2026-04-08");

    mockUseQuery.mockImplementation(({ queryKey }: { queryKey: unknown[] }) => {
      const key = String(queryKey[0]);
      if (key === "gads-status-base") {
        return baseQueryState({
          data: {
            state: "ready",
            connected: true,
            assignedAccountIds: ["acc_1"],
            primaryAccountTimezone: "America/Los_Angeles",
            currentDateInTimezone: "2026-04-07",
          },
          state: {
            data: {
              state: "ready",
            },
          },
        });
      }
      if (key === "gads-status") {
        return baseQueryState({
          data: {
            state: "ready",
            connected: true,
            assignedAccountIds: ["acc_1"],
          },
          state: {
            data: {
              state: "ready",
            },
          },
        });
      }
      return baseQueryState();
    });
  });

  it("uses provider timezone from base status for picker props and selected-range queries", async () => {
    const { GoogleAdsIntelligenceDashboard } = await import(
      "@/components/google-ads/GoogleAdsIntelligenceDashboard"
    );

    renderToStaticMarkup(
      React.createElement(GoogleAdsIntelligenceDashboard, { businessId: "biz" })
    );

    expect(mockGetPresetDatesForReferenceDate).toHaveBeenCalledWith(
      "today",
      "2026-04-07",
      "",
      ""
    );
    expect(mockGetTodayIsoForTimeZone).not.toHaveBeenCalled();

    const statusBaseCall = mockUseQuery.mock.calls.find((call) => {
      const input = call[0] as { queryKey: unknown[] } | undefined;
      return input?.queryKey?.[0] === "gads-status-base";
    });
    expect(statusBaseCall?.[0].queryKey).toEqual(["gads-status-base", "biz"]);

    const campaignsCall = mockUseQuery.mock.calls.find((call) => {
      const input = call[0] as { queryKey: unknown[] } | undefined;
      return input?.queryKey?.[0] === "gads-campaigns";
    });
    expect(campaignsCall?.[0].queryKey).toEqual([
      "gads-campaigns",
      "biz",
      "2026-04-07",
      "2026-04-07",
      "none",
    ]);

    expect(capturedPickerProps).toHaveLength(1);
    expect(capturedPickerProps[0]?.referenceDate).toBe("2026-04-07");
    expect(capturedPickerProps[0]?.timeZoneLabel).toBe("America/Los_Angeles");
  });

  it("shows a persistent reconnect banner when Google Ads access requires action", async () => {
    mockUseQuery.mockImplementation(({ queryKey }: { queryKey: unknown[] }) => {
      const key = String(queryKey[0]);
      if (key === "gads-status-base") {
        return baseQueryState({
          data: {
            state: "action_required",
            connected: true,
            assignedAccountIds: ["acc_1"],
            primaryAccountTimezone: "America/Los_Angeles",
            currentDateInTimezone: "2026-04-07",
          },
          state: {
            data: {
              state: "action_required",
            },
          },
        });
      }
      if (key === "gads-status") {
        return baseQueryState({
          data: {
            state: "action_required",
            connected: true,
            assignedAccountIds: ["acc_1"],
            actionRequired: {
              reconnectCta: true,
              partitions: 3,
              blockingPartitions: 3,
              scopes: ["product_daily", "keyword_daily"],
              blockingScopes: ["product_daily"],
            },
          },
          state: {
            data: {
              state: "action_required",
            },
          },
        });
      }
      return baseQueryState();
    });

    const { GoogleAdsIntelligenceDashboard } = await import(
      "@/components/google-ads/GoogleAdsIntelligenceDashboard"
    );

    const html = renderToStaticMarkup(
      React.createElement(GoogleAdsIntelligenceDashboard, { businessId: "biz" })
    );

    expect(html).toContain("Reconnect Google Ads");
    expect(html).toContain(
      "Google Ads access is blocking sync for: product_daily. Reconnect the affected account before those surfaces can refresh."
    );
  });
});
