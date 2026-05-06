import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { META_PAGE_OPTIONAL_SURFACES } from "@/lib/meta/page-contract";
import type { MetaStatusResponse } from "@/lib/meta/status-types";

const mockPush = vi.fn();
let mockSearchParams = new URLSearchParams();

let mockMetaView = {
  status: "ready",
  isConnected: true,
};

let mockBootstrap = {
  isBootstrapping: false,
  bootstrapStatus: "ready",
};

let mockDateRange = {
  rangePreset: "today",
  customStart: "2026-04-05",
  customEnd: "2026-04-05",
  comparisonPreset: "none",
  comparisonStart: null,
  comparisonEnd: null,
};

let mockQueries: Record<string, Record<string, unknown>>;
let mockSyncPill: { visible: boolean; label: string; tone: "info" | "success" | "warning"; percent: number | null; state: "syncing" | "active" | "needs_attention"; } | null = null;
let observedQueryOptions: Record<string, { enabled?: boolean }> = {};

function baseStatus(overrides: Partial<MetaStatusResponse> = {}): MetaStatusResponse {
  return {
    state: "ready",
    connected: true,
    assignedAccountIds: ["act_1"],
    readinessLevel: "ready",
    domainReadiness: {
      summary: "Provider connection is healthy.",
    } as never,
    currentDateInTimezone: "2026-04-05",
    primaryAccountTimezone: "UTC",
    pageReadiness: {
      state: "ready",
      usable: true,
      complete: true,
      selectedRangeMode: "historical_warehouse",
      reason: null,
      missingRequiredSurfaces: [],
      requiredSurfaces: {
        summary: { state: "ready", blocking: true, countsForPageCompleteness: true, truthClass: "historical_warehouse", reason: null },
        campaigns: { state: "ready", blocking: true, countsForPageCompleteness: true, truthClass: "historical_warehouse", reason: null },
        "breakdowns.age": { state: "ready", blocking: true, countsForPageCompleteness: true, truthClass: "historical_warehouse", reason: null },
        "breakdowns.location": { state: "ready", blocking: true, countsForPageCompleteness: true, truthClass: "historical_warehouse", reason: null },
        "breakdowns.placement": { state: "ready", blocking: true, countsForPageCompleteness: true, truthClass: "historical_warehouse", reason: null },
      },
      optionalSurfaces: {
        adsets: { state: "ready", blocking: false, countsForPageCompleteness: false, truthClass: "conditional_drilldown", reason: null },
        recommendations: { state: "ready", blocking: false, countsForPageCompleteness: false, truthClass: "deterministic_decision_engine", reason: null },
        operating_mode: { state: "ready", blocking: false, countsForPageCompleteness: false, truthClass: "deterministic_decision_engine", reason: null },
        decision_os: { state: "ready", blocking: false, countsForPageCompleteness: false, truthClass: "deterministic_decision_engine", reason: null },
      },
    },
    ...overrides,
  };
}

function campaignRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "cmp_1",
    name: "Campaign One",
    status: "ACTIVE",
    objective: "Sales",
    budgetLevel: "campaign",
    spend: 120,
    purchases: 6,
    revenue: 360,
    roas: 3,
    cpa: 20,
    ctr: 1.2,
    cpm: 8,
    cpc: 2,
    cpp: 0,
    impressions: 1000,
    reach: 800,
    frequency: 1.2,
    clicks: 50,
    uniqueClicks: 48,
    uniqueCtr: 1.1,
    inlineLinkClickCtr: 1.0,
    outboundClicks: 20,
    outboundCtr: 0.5,
    uniqueOutboundClicks: 18,
    uniqueOutboundCtr: 0.4,
    landingPageViews: 14,
    costPerLandingPageView: 3,
    addToCart: 4,
    addToCartValue: 60,
    costPerAddToCart: 30,
    initiateCheckout: 2,
    initiateCheckoutValue: 40,
    costPerCheckoutInitiated: 60,
    leads: 0,
    leadsValue: 0,
    costPerLead: 0,
    registrationsCompleted: 0,
    registrationsCompletedValue: 0,
    costPerRegistrationCompleted: 0,
    searches: 0,
    searchesValue: 0,
    costPerSearch: 0,
    addPaymentInfo: 0,
    addPaymentInfoValue: 0,
    costPerAddPaymentInfo: 0,
    pageLikes: 0,
    costPerPageLike: 0,
    postEngagement: 0,
    costPerEngagement: 0,
    postReactions: 0,
    costPerReaction: 0,
    postComments: 0,
    costPerPostComment: 0,
    postShares: 0,
    costPerPostShare: 0,
    messagingConversationsStarted: 0,
    costPerMessagingConversationStarted: 0,
    appInstalls: 0,
    costPerAppInstall: 0,
    contentViews: 0,
    contentViewsValue: 0,
    costPerContentView: 0,
    videoViews3s: 0,
    videoViews15s: 0,
    videoViews25: 0,
    videoViews50: 0,
    videoViews75: 0,
    videoViews95: 0,
    videoViews100: 0,
    costPerVideoView: 0,
    currency: "USD",
    optimizationGoal: null,
    bidStrategyType: null,
    bidStrategyLabel: null,
    manualBidAmount: null,
    previousManualBidAmount: null,
    bidValue: null,
    bidValueFormat: null,
    previousBidValue: null,
    previousBidValueFormat: null,
    previousBidValueCapturedAt: null,
    dailyBudget: 5000,
    lifetimeBudget: null,
    previousDailyBudget: null,
    previousLifetimeBudget: null,
    previousBudgetCapturedAt: null,
    isBudgetMixed: false,
    isConfigMixed: false,
    isOptimizationGoalMixed: false,
    isBidStrategyMixed: false,
    isBidValueMixed: false,
    ...overrides,
  };
}

function baseQueryState(overrides: Record<string, unknown> = {}) {
  return {
    data: undefined,
    isLoading: false,
    isError: false,
    error: null,
    isSuccess: true,
    isFetching: false,
    refetch: vi.fn(),
    state: { data: undefined },
    ...overrides,
  };
}

vi.mock("@tanstack/react-query", () => ({
  useQuery: vi.fn((input: { queryKey: unknown[]; enabled?: boolean }) => {
    const key = Array.isArray(input.queryKey) ? String(input.queryKey[0]) : String(input.queryKey);
    observedQueryOptions[key] = { enabled: input.enabled as boolean | undefined };
    return mockQueries[key] ?? baseQueryState();
  }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush, replace: vi.fn() }),
  usePathname: () => "/platforms/meta",
  useSearchParams: () => mockSearchParams,
}));

vi.mock("@/components/business/BusinessEmptyState", () => ({
  BusinessEmptyState: () => React.createElement("div", null, "business-empty"),
}));

vi.mock("@/components/states/IntegrationEmptyState", () => ({
  IntegrationEmptyState: (props: { title: string; description: string }) =>
    React.createElement("div", null, `integration-empty:${props.title}|${props.description}`),
}));

vi.mock("@/components/states/loading-skeleton", () => ({
  LoadingSkeleton: (props: { title: string; description: string }) =>
    React.createElement("div", null, `loading:${props.title}|${props.description}`),
}));

vi.mock("@/components/states/DataEmptyState", () => ({
  DataEmptyState: (props: { title: string; description: string }) =>
    React.createElement("div", null, `data-empty:${props.title}|${props.description}`),
}));

vi.mock("@/components/ui/button", () => ({
  Button: (props: { children: React.ReactNode }) => React.createElement("button", null, props.children),
}));

vi.mock("@/components/date-range/DateRangePicker", () => ({
  DateRangePicker: () => React.createElement("div", null, "date-range-picker"),
  getPresetDates: vi.fn(),
  getPresetDatesForReferenceDate: vi.fn(),
}));

vi.mock("@/hooks/use-persistent-date-range", () => ({
  usePersistentMetaDateRange: () => [mockDateRange, vi.fn()],
}));

vi.mock("@/hooks/use-currency", () => ({
  useCurrencySymbol: () => "$",
}));

vi.mock("@/store/app-store", () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      businesses: [{ id: "biz", name: "Biz", timezone: "UTC", currency: "USD" }],
      selectedBusinessId: "biz",
    }),
}));

vi.mock("@/store/preferences-store", () => ({
  usePreferencesStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      language: "en",
    }),
}));

vi.mock("@/store/integrations-store", () => ({
  useIntegrationsStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      domainsByBusinessId: { biz: { meta: {} } },
    }),
}));

vi.mock("@/store/integrations-support", () => ({
  deriveProviderViewState: () => mockMetaView,
}));

vi.mock("@/lib/business-mode", () => ({
  isDemoBusinessSelected: () => false,
}));

vi.mock("@/hooks/use-business-integrations-bootstrap", () => ({
  useBusinessIntegrationsBootstrap: () => mockBootstrap,
}));

vi.mock("@/components/pricing/PlanGate", () => ({
  PlanGate: (props: { children: React.ReactNode }) => React.createElement(React.Fragment, null, props.children),
}));

vi.mock("@/components/meta/meta-campaign-list", () => ({
  MetaCampaignList: (props: { campaigns: Array<{ name: string }> }) =>
    React.createElement("div", null, `campaign-list:${props.campaigns.map((row) => row.name).join(",")}`),
}));

vi.mock("@/components/meta/meta-campaign-detail", () => ({
  MetaCampaignDetail: (props: { campaign: { name: string } | null }) =>
    React.createElement("div", null, props.campaign ? `campaign-detail:${props.campaign.name}` : "campaign-detail:overview"),
}));

vi.mock("@/components/sync/provider-readiness-indicator", () => ({
  ProviderReadinessIndicator: (props: { readinessLevel?: string; domainReadiness?: { summary?: string } | null }) =>
    React.createElement("div", null, `provider-indicator:${props.readinessLevel ?? "none"}:${props.domainReadiness?.summary ?? ""}`),
}));

vi.mock("@/components/sync/sync-status-pill", () => ({
  SyncStatusPill: (props: { pill: { label: string } | null }) =>
    React.createElement("div", null, `sync-pill:${props.pill?.label ?? "none"}`),
  SyncStatusPillSkeleton: () => React.createElement("div", null, "sync-pill-skeleton"),
}));

vi.mock("@/lib/pricing/usePlan", () => ({
  usePlanState: () => ({ plan: "growth" }),
}));

vi.mock("@/lib/meta/campaign-lanes", () => ({
  buildMetaCampaignLaneSignals: () => new Map(),
}));

vi.mock("@/lib/meta/date", () => ({
  getMetaPresetDates: () => ({
    start: mockDateRange.customStart,
    end: mockDateRange.customEnd,
  }),
}));

vi.mock("@/lib/meta/ui", async () => {
  const actual = await vi.importActual<typeof import("@/lib/meta/ui")>("@/lib/meta/ui");
  return {
    ...actual,
    formatMetaDate: (value: string | null | undefined) => value ?? null,
  };
});

vi.mock("@/lib/sync/sync-status-pill", async () => {
  const actual = await vi.importActual<typeof import("@/lib/sync/sync-status-pill")>("@/lib/sync/sync-status-pill");
  return {
    ...actual,
    resolveMetaSyncStatusPill: () => mockSyncPill,
  };
});

const { default: MetaPage } = await import("@/app/(dashboard)/platforms/meta/page");

describe("Meta page render contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPush.mockReset();
    mockSearchParams = new URLSearchParams();
    mockMetaView = { status: "ready", isConnected: true };
    mockBootstrap = { isBootstrapping: false, bootstrapStatus: "ready" };
    mockDateRange = {
      rangePreset: "today",
      customStart: "2026-04-05",
      customEnd: "2026-04-05",
      comparisonPreset: "none",
      comparisonStart: null,
      comparisonEnd: null,
    };
    mockSyncPill = null;
    observedQueryOptions = {};
    const readyStatus = baseStatus();
    mockQueries = {
      "meta-page-reference": baseQueryState({ data: readyStatus, state: { data: readyStatus } }),
      "meta-page-status": baseQueryState({ data: readyStatus, state: { data: readyStatus } }),
      "meta-campaigns": baseQueryState({ data: { status: "ok", rows: [campaignRow()] } }),
      "meta-campaigns-prev": baseQueryState({ data: { rows: [] } }),
      "meta-warehouse-summary": baseQueryState({ data: undefined }),
      "meta-recommendations-v8": baseQueryState({
        data: { status: "ok", summary: {}, recommendations: [] },
        isFetching: false,
      }),
      "meta-decision-os": baseQueryState({ data: null }),
      "meta-campaigns-compare": baseQueryState({ data: { rows: [] } }),
      "meta-warehouse-summary-compare": baseQueryState({ data: null }),
    };
  });

  it("renders the disconnected integration path without pretending the page is preparing", () => {
    mockMetaView = { status: "disconnected", isConnected: false };

    const html = renderToStaticMarkup(React.createElement(MetaPage));

    expect(html).toContain("integration-empty:Finish connecting Meta");
    expect(html).not.toContain("Current-day Meta data is preparing");
    expect(html).not.toContain("Selected range is preparing");
  });

  it("renders the no-accounts-assigned path without using preparing copy", () => {
    const status = baseStatus({
      assignedAccountIds: [],
      pageReadiness: {
        ...baseStatus().pageReadiness!,
        state: "not_connected",
        usable: false,
        complete: false,
      },
    });
    mockQueries["meta-page-status"] = baseQueryState({ data: status, state: { data: status } });
    mockQueries["meta-campaigns"] = baseQueryState({ data: { status: "no_accounts_assigned", rows: [] } });

    const html = renderToStaticMarkup(React.createElement(MetaPage));

    expect(html).toContain("No Meta ad accounts assigned");
    expect(html).not.toContain("Campaign data is still being prepared");
  });

  it("renders current-day preparing copy from the centralized messaging model and masks KPI copy", () => {
    const status = baseStatus({
      state: "syncing",
      pageReadiness: {
        ...baseStatus().pageReadiness!,
        state: "syncing",
        usable: false,
        complete: false,
        selectedRangeMode: "current_day_live",
        reason: "Campaign data for the current Meta account day is still preparing.",
        missingRequiredSurfaces: ["summary", "campaigns"],
        requiredSurfaces: {
          ...baseStatus().pageReadiness!.requiredSurfaces,
          summary: { state: "syncing", blocking: true, countsForPageCompleteness: true, truthClass: "current_day_live", reason: "Campaign data for the current Meta account day is still preparing." },
          campaigns: { state: "syncing", blocking: true, countsForPageCompleteness: true, truthClass: "current_day_live", reason: "Campaign data for the current Meta account day is still preparing." },
        },
      },
    });
    mockQueries["meta-page-status"] = baseQueryState({ data: status, state: { data: status } });
    mockQueries["meta-campaigns"] = baseQueryState({ data: { status: "ok", rows: [] } });

    const html = renderToStaticMarkup(React.createElement(MetaPage));

    expect(html).toContain("Current-day Meta data is preparing");
    expect(html).toContain("Cards will unlock as current-day data becomes available");
    expect(html).not.toContain("No campaigns were found for this range");
  });

  it("renders the actual comparison preset label for KPI deltas", () => {
    mockDateRange = {
      rangePreset: "30d",
      customStart: "2026-03-08",
      customEnd: "2026-04-06",
      comparisonPreset: "previousMonth",
      comparisonStart: null,
      comparisonEnd: null,
    };
    mockQueries["meta-campaigns-compare"] = baseQueryState({
      data: { rows: [campaignRow({ spend: 200, revenue: 500, purchases: 10 })] },
    });
    mockQueries["meta-warehouse-summary-compare"] = baseQueryState({
      data: { totals: { spend: 200, revenue: 500, cpa: 20, roas: 2.5 } },
    });

    const html = renderToStaticMarkup(React.createElement(MetaPage));

    expect(html).toContain("vs previous month");
    expect(html).not.toContain("vs previous period");
  });

  it("keeps provider-scoped and page-scoped messaging separate during historical syncing", () => {
    const status = baseStatus({
      state: "partial",
      readinessLevel: "ready",
      domainReadiness: { summary: "Provider connection is healthy." } as never,
      pageReadiness: {
        ...baseStatus().pageReadiness!,
        state: "syncing",
        usable: false,
        complete: false,
        selectedRangeMode: "historical_warehouse",
        reason: "Campaign warehouse data is still being prepared for the selected range.",
        missingRequiredSurfaces: ["campaigns"],
        requiredSurfaces: {
          ...baseStatus().pageReadiness!.requiredSurfaces,
          campaigns: { state: "syncing", blocking: true, countsForPageCompleteness: true, truthClass: "historical_warehouse", reason: "Campaign warehouse data is still being prepared for the selected range." },
        },
      },
    });
    mockSyncPill = {
      visible: true,
      label: "Preparing range",
      tone: "info",
      percent: 40,
      state: "syncing",
    };
    mockDateRange = { ...mockDateRange, rangePreset: "7d", customStart: "2026-04-01", customEnd: "2026-04-05" };
    mockQueries["meta-page-status"] = baseQueryState({ data: status, state: { data: status } });
    mockQueries["meta-campaigns"] = baseQueryState({ data: { status: "ok", rows: [] } });

    const html = renderToStaticMarkup(React.createElement(MetaPage));

    expect(html).toContain("provider-indicator:ready:Provider connection is healthy.");
    expect(html).toContain("sync-pill:Preparing range");
    expect(html).toContain("Selected range is preparing");
    expect(html).not.toContain("Finish connecting Meta");
  });

  it("renders usable sections when the page is partial and optional surfaces stay optional", () => {
    expect(META_PAGE_OPTIONAL_SURFACES).toEqual([
      "adsets",
      "recommendations",
      "operating_mode",
      "decision_os",
    ]);
    const status = baseStatus({
      state: "partial",
      pageReadiness: {
        ...baseStatus().pageReadiness!,
        state: "partial",
        usable: true,
        complete: false,
        selectedRangeMode: "historical_warehouse",
        reason: "Placement breakdown data is still being prepared for the selected range.",
        missingRequiredSurfaces: ["breakdowns.placement"],
        requiredSurfaces: {
          ...baseStatus().pageReadiness!.requiredSurfaces,
          "breakdowns.placement": {
            state: "syncing",
            blocking: true,
            countsForPageCompleteness: true,
            truthClass: "historical_warehouse",
            reason: "Placement breakdown data is still being prepared for the selected range.",
          },
        },
        optionalSurfaces: {
          adsets: { state: "partial", blocking: false, countsForPageCompleteness: false, truthClass: "conditional_drilldown", reason: "Ad sets open after campaign drilldown." },
          recommendations: { state: "partial", blocking: false, countsForPageCompleteness: false, truthClass: "deterministic_decision_engine", reason: "Recommendations are optional." },
          operating_mode: { state: "partial", blocking: false, countsForPageCompleteness: false, truthClass: "deterministic_decision_engine", reason: "Operating mode is optional." },
          decision_os: { state: "partial", blocking: false, countsForPageCompleteness: false, truthClass: "deterministic_decision_engine", reason: "Decision OS is optional." },
        },
      },
    });
    mockSyncPill = {
      visible: true,
      label: "Partially ready",
      tone: "info",
      percent: 75,
      state: "syncing",
    };
    mockDateRange = { ...mockDateRange, rangePreset: "7d", customStart: "2026-04-01", customEnd: "2026-04-05" };
    mockQueries["meta-page-status"] = baseQueryState({ data: status, state: { data: status } });
    mockQueries["meta-campaigns"] = baseQueryState({ data: { status: "ok", rows: [campaignRow()] } });
    mockQueries["meta-recommendations-v8"] = baseQueryState({ data: undefined, isFetching: false });

    const html = renderToStaticMarkup(React.createElement(MetaPage));

    expect(html).toContain("Meta page is partially ready");
    expect(html).toContain("campaign-list:Campaign One");
    expect(html).not.toContain("data-empty:");
  });

  it("renders ready-but-empty separately from preparing states", () => {
    const status = baseStatus({
      state: "ready",
      pageReadiness: {
        ...baseStatus().pageReadiness!,
        state: "ready",
        usable: true,
        complete: true,
        selectedRangeMode: "historical_warehouse",
        reason: null,
        missingRequiredSurfaces: [],
      },
    });
    mockDateRange = { ...mockDateRange, rangePreset: "7d", customStart: "2026-04-01", customEnd: "2026-04-05" };
    mockQueries["meta-page-status"] = baseQueryState({ data: status, state: { data: status } });
    mockQueries["meta-campaigns"] = baseQueryState({ data: { status: "ok", rows: [] } });

    const html = renderToStaticMarkup(React.createElement(MetaPage));

    expect(html).toContain("No campaigns were found for this range");
    expect(html).not.toContain("Campaign data is still being prepared");
    expect(html).not.toContain("Current-day Meta data is preparing");
  });

  it("renders ready data without empty-state or preparing-state UI", () => {
    const status = baseStatus();
    mockQueries["meta-page-status"] = baseQueryState({ data: status, state: { data: status } });
    mockQueries["meta-campaigns"] = baseQueryState({ data: { status: "ok", rows: [campaignRow()] } });

    const html = renderToStaticMarkup(React.createElement(MetaPage));

    expect(html).toContain("campaign-list:Campaign One");
    expect(html).toContain("campaign-detail:overview");
    expect(html).not.toContain("data-empty:");
    expect(html).not.toContain("Selected range is preparing");
  });

  it("keeps snapshot analysis manual and exposes a run-analysis action in the header", () => {
    const status = baseStatus();
    mockQueries["meta-page-status"] = baseQueryState({ data: status, state: { data: status } });
    mockQueries["meta-campaigns"] = baseQueryState({ data: { status: "ok", rows: [campaignRow()] } });

    const html = renderToStaticMarkup(React.createElement(MetaPage));

    expect(observedQueryOptions["meta-decision-os"]).toBeUndefined();
    expect(observedQueryOptions["meta-recommendations-v8"]?.enabled).toBe(false);
    expect(html).toContain("Run analysis");
    expect(html).toContain("Analysis status");
    expect(html).toContain("Decision OS: Archived");
  });

  it("shows running analysis status while manual analysis queries are fetching", () => {
    const status = baseStatus();
    mockQueries["meta-page-status"] = baseQueryState({ data: status, state: { data: status } });
    mockQueries["meta-campaigns"] = baseQueryState({ data: { status: "ok", rows: [campaignRow()] } });
    mockQueries["meta-recommendations-v8"] = baseQueryState({
      data: undefined,
      isFetching: true,
    });
    const html = renderToStaticMarkup(React.createElement(MetaPage));

    expect(html).toContain("Analysis: Running");
    expect(html).toContain("Decision OS: Archived");
    expect(html).not.toContain("Decision OS: Running");
    expect(html).toContain("Analysis is running for the selected range.");
  });

  it("does not say Decision OS is running when only recommendations are fetching", () => {
    const status = baseStatus();
    mockQueries["meta-page-status"] = baseQueryState({ data: status, state: { data: status } });
    mockQueries["meta-campaigns"] = baseQueryState({ data: { status: "ok", rows: [campaignRow()] } });
    mockQueries["meta-recommendations-v8"] = baseQueryState({
      data: undefined,
      isFetching: true,
    });

    const html = renderToStaticMarkup(React.createElement(MetaPage));

    expect(html).toContain("Analysis: Running");
    expect(html).toContain("Decision OS: Archived");
    expect(html).not.toContain("Decision OS: Running");
  });

  it("shows snapshot fallback recommendation context without restoring the archived surface", () => {
    const status = baseStatus();
    mockQueries["meta-page-status"] = baseQueryState({ data: status, state: { data: status } });
    mockQueries["meta-campaigns"] = baseQueryState({ data: { status: "ok", rows: [campaignRow()] } });
    mockQueries["meta-recommendations-v8"] = baseQueryState({
      data: {
        status: "ok",
        businessId: "biz",
        startDate: "2026-04-05",
        endDate: "2026-04-05",
        summary: {},
        recommendations: [{ id: "rec_1" }],
        sourceModel: "snapshot_heuristics",
        analysisSource: {
          system: "snapshot_fallback",
          decisionOsAvailable: false,
          fallbackReason: "legacy_decision_os_archived_phase_4_1",
        },
      },
      isFetching: false,
    });

    const html = renderToStaticMarkup(React.createElement(MetaPage));

    expect(html).toContain("Decision OS: Archived");
    expect(html).toContain("Recommendation source: Snapshot fallback");
    expect(html).toContain("Presentation: Fallback context");
    expect(html).toContain("legacy_decision_os_archived_phase_4_1");
    expect(html).not.toContain("Decision OS: Ready");
    expect(html).not.toContain("Presentation: No guidance");
  });

  it("keeps supporting and comparison queries deferred on the initial today load", () => {
    const status = baseStatus({
      pageReadiness: {
        ...baseStatus().pageReadiness!,
        selectedRangeMode: "current_day_live",
      },
    });
    mockQueries["meta-page-status"] = baseQueryState({ data: status, state: { data: status } });
    mockQueries["meta-campaigns"] = baseQueryState({ data: { status: "ok", rows: [campaignRow()] } });

    renderToStaticMarkup(React.createElement(MetaPage));

    expect(observedQueryOptions["meta-warehouse-summary"]?.enabled).toBe(false);
    expect(observedQueryOptions["meta-campaigns-prev"]?.enabled).toBe(false);
    expect(observedQueryOptions["meta-campaigns-compare"]?.enabled).toBe(false);
    expect(observedQueryOptions["meta-warehouse-summary-compare"]?.enabled).toBe(false);
    expect(observedQueryOptions["meta-breakdowns"]).toBeUndefined();
  });

  it("waits for the Meta account day before enabling ranged core queries", () => {
    mockQueries["meta-page-reference"] = baseQueryState({
      data: undefined,
      isLoading: true,
      isSuccess: false,
      state: { data: undefined },
    });
    mockQueries["meta-page-status"] = baseQueryState({
      data: undefined,
      isLoading: false,
      isSuccess: false,
      state: { data: undefined },
    });
    mockQueries["meta-campaigns"] = baseQueryState({
      data: undefined,
      isLoading: false,
      isSuccess: false,
      state: { data: undefined },
    });
    mockQueries["meta-warehouse-summary"] = baseQueryState({
      data: undefined,
      isLoading: false,
      isSuccess: false,
      state: { data: undefined },
    });

    const html = renderToStaticMarkup(React.createElement(MetaPage));

    expect(observedQueryOptions["meta-page-status"]?.enabled).toBe(false);
    expect(observedQueryOptions["meta-campaigns"]?.enabled).toBe(false);
    expect(observedQueryOptions["meta-warehouse-summary"]?.enabled).toBe(false);
    expect(html).toContain("loading:Loading campaign performance|Campaign, breakdown, and recovery surfaces will appear as sync finishes.");
  });

  it("renders summary KPIs while campaign drilldown is still loading", () => {
    const status = baseStatus();
    mockDateRange = {
      rangePreset: "7d",
      customStart: "2026-04-13",
      customEnd: "2026-04-19",
      comparisonPreset: "none",
      comparisonStart: null,
      comparisonEnd: null,
    };
    mockQueries["meta-page-status"] = baseQueryState({ data: status, state: { data: status } });
    mockQueries["meta-warehouse-summary"] = baseQueryState({
      data: { totals: { spend: 1776.83, revenue: 3291.76, cpa: 126.92, roas: 1.85 } },
    });
    mockQueries["meta-campaigns"] = baseQueryState({
      isLoading: true,
      isSuccess: false,
      data: undefined,
    });

    const html = renderToStaticMarkup(React.createElement(MetaPage));

    expect(html).toContain("$1.8k");
    expect(html).toContain("$3.3k");
    expect(html).toContain("$126.92");
    expect(html).toContain("1.85×");
    expect(html).toContain("Campaign drilldown is loading");
    expect(html).toContain("loading:Loading campaign drilldown|Summary truth is ready. Campaign rows are still loading in the background.");
    expect(html).not.toContain("Campaign, breakdown, and recovery surfaces will appear as sync finishes.");
  });

});
