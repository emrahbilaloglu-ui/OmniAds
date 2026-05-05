import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

let mockDateRange = {
  preset: "last14Days",
  customStart: "2026-04-01",
  customEnd: "2026-04-14",
  lastDays: 14,
  sinceDate: "",
};
let mockMetaReferenceState: Record<string, unknown> = {};
let observedQueryKeys: Record<string, unknown[]> = {};
let observedQueryOptions: Record<string, { enabled?: boolean }> = {};
const mockInvalidateQueries = vi.fn();

function baseQueryState(overrides: Record<string, unknown> = {}) {
  return {
    data: undefined,
    isLoading: false,
    isError: false,
    error: null,
    isFetching: false,
    refetch: vi.fn(),
    ...overrides,
  };
}

vi.mock("@tanstack/react-query", () => ({
  useQueries: vi.fn(() => []),
  useMutation: vi.fn(() => ({
    mutate: vi.fn(),
    isPending: false,
  })),
  useQueryClient: vi.fn(() => ({
    invalidateQueries: mockInvalidateQueries,
  })),
  useQuery: vi.fn((input: { queryKey: unknown[]; enabled?: boolean }) => {
    const key = Array.isArray(input.queryKey) ? String(input.queryKey[0]) : String(input.queryKey);
    observedQueryKeys[key] = input.queryKey;
    observedQueryOptions[key] = { enabled: input.enabled };
    if (key === "meta-creatives-creatives-metadata") {
      return baseQueryState({ data: { status: "ok", rows: [] } });
    }
    if (key === "meta-creatives-reference") {
      return baseQueryState({
        data: {
          currentDateInTimezone: "2026-04-14",
          primaryAccountTimezone: "UTC",
        },
        isSuccess: true,
        ...mockMetaReferenceState,
      });
    }
    return baseQueryState();
  }),
}));

vi.mock("next/dynamic", () => ({
  default: () => () => null,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@/components/business/BusinessEmptyState", () => ({
  BusinessEmptyState: () => React.createElement("div", null, "business-empty"),
}));

vi.mock("@/components/states/empty-state", () => ({
  EmptyState: (props: { title: string }) =>
    React.createElement("div", null, `empty:${props.title}`),
}));

vi.mock("@/components/states/IntegrationEmptyState", () => ({
  IntegrationEmptyState: (props: { title: string }) =>
    React.createElement("div", null, `integration-empty:${props.title}`),
}));

vi.mock("@/components/states/LockedFeatureCard", () => ({
  LockedFeatureCard: (props: { description: string }) =>
    React.createElement("div", null, `locked:${props.description}`),
}));

vi.mock("@/components/states/error-state", () => ({
  ErrorState: (props: { title: string }) =>
    React.createElement("div", null, `error:${props.title}`),
}));

vi.mock("@/components/states/loading-skeleton", () => ({
  LoadingSkeleton: (props: { title: string }) =>
    React.createElement("div", null, `loading:${props.title}`),
}));

vi.mock("@/components/ui/button", () => ({
  Button: (props: { children: React.ReactNode; onClick?: () => void; disabled?: boolean }) =>
    React.createElement(
      "button",
      { disabled: props.disabled, onClick: props.onClick },
      props.children,
    ),
}));

vi.mock("@/components/creatives/CreativesTableSection", () => ({
  CreativesTableSection: () => React.createElement("div", null, "creative-table"),
}));

vi.mock("@/components/creatives/CreativesTopSection", () => ({
  CreativesTopSection: (props: {
    actionsPrefix?: React.ReactNode;
    belowToolbar?: React.ReactNode;
  }) => React.createElement("section", null, props.actionsPrefix, props.belowToolbar),
  applyCreativeFilters: (rows: unknown[]) => rows,
  formatCreativeDateLabel: () => "Last 14 days",
  mapCreativeGroupByToApi: () => "creative",
  resolveCreativeDateRange: (value: typeof mockDateRange) => ({
    start: value.customStart,
    end: value.customEnd,
  }),
}));

vi.mock("@/hooks/use-persistent-date-range", () => ({
  usePersistentCreativeDateRange: () => [mockDateRange, vi.fn()],
}));

vi.mock("@/app/(dashboard)/creatives/page-support", () => ({
  CreativesTableShell: () => React.createElement("div", null, "table-shell"),
  buildCreativeHistoryById: () => ({}),
  fetchCreativeDecisionEngineV3: vi.fn(),
  fetchMetaCreatives: vi.fn(),
  fetchMetaCreativesHistory: vi.fn(),
  getPreviewPollingInterval: () => false,
  hasRenderablePreview: () => false,
  mapApiRowToUiRow: (row: unknown) => row,
  PLATFORM_LABELS: { meta: "Meta" },
  SHARE_METRIC_IDS: new Set(["spend", "roas"]),
  shouldPollForPreviewReadiness: () => false,
  toCsv: () => "",
  toSharedCreative: (row: unknown) => row,
}));

vi.mock("@/hooks/use-business-integrations-bootstrap", () => ({
  useBusinessIntegrationsBootstrap: () => ({
    bootstrapStatus: "ready",
    isBootstrapping: false,
  }),
}));

vi.mock("@/components/pricing/PlanGate", () => ({
  PlanGate: (props: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, props.children),
}));

vi.mock("@/lib/pricing/usePlan", () => ({
  usePlanState: () => ({ plan: "growth" }),
}));

vi.mock("@/lib/pricing/plans", () => ({
  PRICING_PLANS: { growth: { limits: { analyticsHistoryDays: 365 } } },
}));

vi.mock("@/lib/meta/history", () => ({
  META_WAREHOUSE_HISTORY_DAYS: 365,
  META_CREATIVE_WAREHOUSE_HISTORY_DAYS: 455,
  addDaysToIsoDate: (value: string) => value,
  dayCountInclusive: () => 14,
}));

vi.mock("@/lib/meta/creatives-preview", () => ({
  getCreativeStaticPreviewState: () => "missing",
}));

vi.mock("@/store/app-store", () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      selectedBusinessId: "biz",
      businesses: [{ id: "biz", currency: "USD" }],
    }),
}));

vi.mock("@/store/integrations-store", () => ({
  useIntegrationsStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      domainsByBusinessId: { biz: { meta: {} } },
      assignedAccountsByBusiness: { biz: { meta: ["act_1"] } },
    }),
}));

vi.mock("@/store/preferences-store", () => ({
  usePreferencesStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ language: "en" }),
}));

vi.mock("@/store/integrations-support", () => ({
  buildDefaultProviderDomains: () => ({ meta: {} }),
  deriveProviderViewState: () => ({ isConnected: true, status: "ready" }),
}));

vi.mock("@/lib/business-mode", () => ({
  isDemoBusinessSelected: () => false,
}));

const { default: CreativesPage } = await import("@/app/(dashboard)/creatives/page");
const retiredCreativeQueryKeys = [
  `creative-${"decision"}-os-snapshot`,
  `creative-${"decision"}-os`,
  `creative-${"decision"}-os-v2-preview`,
];

describe("Creatives page render contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInvalidateQueries.mockClear();
    observedQueryKeys = {};
    observedQueryOptions = {};
    mockDateRange = {
      preset: "last14Days",
      customStart: "2026-04-01",
      customEnd: "2026-04-14",
      lastDays: 14,
      sinceDate: "",
    };
    mockMetaReferenceState = {};
  });

  it("does not load or render decision UI while preserving the creatives shell", () => {
    const html = renderToStaticMarkup(React.createElement(CreativesPage));

    for (const queryKey of retiredCreativeQueryKeys) {
      expect(observedQueryKeys[queryKey]).toBeUndefined();
    }
    expect(html).not.toContain("Decision OS");
    expect(html).not.toContain("Decision Center");
    expect(html).not.toContain("Run Creative Analysis");
    expect(html).not.toContain("benchmark-scope-control");

    mockDateRange = {
      preset: "last30Days",
      customStart: "2026-03-16",
      customEnd: "2026-04-14",
      lastDays: 30,
      sinceDate: "",
    };
    observedQueryKeys = {};

    renderToStaticMarkup(React.createElement(CreativesPage));

    expect(observedQueryKeys[retiredCreativeQueryKeys[0]]).toBeUndefined();
    expect(observedQueryKeys["meta-creatives-creatives-metadata"]).toContain("2026-03-16");
  });

  it("keeps the table in loading state while waiting for the Meta reference day", () => {
    mockMetaReferenceState = {
      data: undefined,
      isLoading: true,
      isFetching: true,
      isSuccess: false,
    };

    const html = renderToStaticMarkup(React.createElement(CreativesPage));

    expect(observedQueryOptions["meta-creatives-creatives-metadata"]?.enabled).toBe(false);
    expect(html).toContain("table-shell");
    expect(html).not.toContain("No creative performance data found for the selected range");
  });

});
