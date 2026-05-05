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
let mockCreativeRows: Array<Record<string, unknown>> = [];
let mockDecisionEngineV3Data: Record<string, unknown> | undefined;
let mockSelectedV3Labels: Set<string> | null = null;
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

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: <T,>(initialState: T | (() => T)) => {
      if (initialState instanceof Set && mockSelectedV3Labels !== null) {
        return [mockSelectedV3Labels, vi.fn()] as unknown as [
          T,
          React.Dispatch<React.SetStateAction<T>>,
        ];
      }
      return actual.useState(initialState);
    },
  };
});

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
      return baseQueryState({ data: { status: "ok", rows: mockCreativeRows } });
    }
    if (key === "creative-decision-engine-v3") {
      return baseQueryState({ data: mockDecisionEngineV3Data });
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

vi.mock("@/components/creatives/CreativeDecisionEngineV3Surface", () => ({
  CreativeDecisionEngineV3Surface: () =>
    React.createElement("div", null, "v3-surface"),
}));

vi.mock("@/components/creatives/CreativesTableSection", () => ({
  CreativesTableSection: (props: { rows: Array<{ name: string }> }) =>
    React.createElement(
      "div",
      null,
      `table:${props.rows.map((row) => row.name).join("|")}`,
    ),
}));

vi.mock("@/components/creatives/CreativesTopSection", () => ({
  CreativesTopSection: (props: {
    actionsPrefix?: React.ReactNode;
    belowToolbar?: React.ReactNode;
    filterBarSlot?: React.ReactNode;
    selectedRows?: Array<{ name: string }>;
  }) =>
    React.createElement(
      "section",
      null,
      props.filterBarSlot,
      React.createElement(
        "div",
        null,
        `grid:${props.selectedRows?.map((row) => row.name).join("|") ?? ""}`,
      ),
      props.actionsPrefix,
      props.belowToolbar,
    ),
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

function makeCreativeRow(id: string, name: string): Record<string, unknown> {
  return {
    id,
    creativeId: id,
    name,
    previewUrl: null,
    thumbnailUrl: null,
    imageUrl: null,
    previewState: "unavailable",
    isCatalog: false,
    spend: 100,
    purchaseValue: 200,
  };
}

function makeDecision(
  creativeId: string,
  label: string,
): Record<string, unknown> {
  return {
    creativeId,
    creativeName: creativeId,
    label,
  };
}

function makeDecisionEngineData(
  decisions: Array<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    decisions,
    flags: {
      enabled: true,
      surfaceVisible: true,
    },
    engineVersion: "v3-test",
    dataSource: "warehouse",
    dataHealth: null,
    accountProfile: null,
  };
}

function arrangeV3FilterFixture(selectedLabels: string[]) {
  mockSelectedV3Labels = new Set(selectedLabels);
  mockCreativeRows = [
    makeCreativeRow("creative_scale_1", "Scale One"),
    makeCreativeRow("creative_scale_2", "Scale Two"),
    makeCreativeRow("creative_cut_1", "Cut One"),
    makeCreativeRow("creative_refresh_1", "Refresh One"),
  ];
  mockDecisionEngineV3Data = makeDecisionEngineData([
    makeDecision("creative_scale_1", "scale"),
    makeDecision("creative_scale_2", "scale"),
    makeDecision("creative_cut_1", "cut"),
    makeDecision("creative_refresh_1", "refresh"),
  ]);
}

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
    mockCreativeRows = [];
    mockDecisionEngineV3Data = undefined;
    mockSelectedV3Labels = null;
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

  it("narrows the grid and table to scale-labeled creatives when the scale chip is selected", () => {
    arrangeV3FilterFixture(["scale"]);

    const html = renderToStaticMarkup(React.createElement(CreativesPage));

    expect(html).toContain("Scale (2)");
    expect(html).toContain("grid:Scale One|Scale Two");
    expect(html).toContain("table:Scale One|Scale Two");
    expect(html).not.toContain("Cut One");
    expect(html).not.toContain("Refresh One");
  });

  it("shows the union of scale and cut rows when both chips are selected", () => {
    arrangeV3FilterFixture(["scale", "cut"]);

    const html = renderToStaticMarkup(React.createElement(CreativesPage));

    expect(html).toContain("grid:Scale One|Scale Two|Cut One");
    expect(html).toContain("table:Scale One|Scale Two|Cut One");
    expect(html).not.toContain("Refresh One");
  });

  it("returns all rows after the v3 chip selection is cleared", () => {
    arrangeV3FilterFixture([]);

    const html = renderToStaticMarkup(React.createElement(CreativesPage));

    expect(html).toContain("grid:Scale One|Scale Two|Cut One|Refresh One");
    expect(html).toContain("table:Scale One|Scale Two|Cut One|Refresh One");
  });

});
