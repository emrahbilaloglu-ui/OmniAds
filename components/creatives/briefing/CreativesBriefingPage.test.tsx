import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLOSED_LAUNCHPAD_OVERLAY_STATE,
  CreativesBriefingPage,
  attachDecisionCenterRowsToAssetLibraryRows,
  chooseDefaultCreativeLane,
  decisionVisibilitySummary,
  isDecisionCenterUiEnabled,
  normalizeCreativesBriefingPayload,
  requestMetaInsightsRefresh,
  selectedCardsForActionItems,
  selectedCardsForCards,
  filterRemovedActionItems,
  filterSelectedIdsForLane,
  getAssetLibraryEmptyMessage,
  getCreativeDataSetupNotice,
  launchpadHrefFromOverlayState,
  openLaunchpadOverlayState,
  cardMatchesActionFilter,
} from "@/components/creatives/briefing/CreativesBriefingPage";
import { buildEvidenceSections } from "@/components/creatives/briefing/card-utils";

const mockState = vi.hoisted(() => ({
  queryKeys: [] as unknown[][],
  queryFns: [] as Array<() => unknown>,
  routerPush: vi.fn(),
  routerReplace: vi.fn(),
  searchParams: new URLSearchParams(),
  briefingData: {} as any,
  assetLibraryData: [] as any,
  metaStatusData: null as any,
  appStore: {
    selectedBusinessId: "biz_1",
    businesses: [
      {
        id: "biz_1",
        name: "TheSwaf",
        timezone: "UTC",
        currency: "USD",
      },
    ],
  },
}));

function baseQueryState(overrides: Record<string, unknown> = {}) {
  return {
    data: undefined,
    isLoading: false,
    isError: false,
    error: null,
    ...overrides,
  };
}

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: vi.fn(() => ({
    invalidateQueries: vi.fn(),
  })),
  useQuery: vi.fn((input: { queryKey: unknown[]; queryFn?: () => unknown }) => {
    mockState.queryKeys.push(input.queryKey);
    if (input.queryFn) mockState.queryFns.push(input.queryFn);
    const key = String(input.queryKey[0]);
    if (key === "creatives-briefing") {
      return baseQueryState({ data: mockState.briefingData });
    }
    if (key === "creatives-briefing-meta-summary-today") {
      return baseQueryState({ data: { totals: { spend: 820, roas: 2.1 } } });
    }
    if (key === "creatives-briefing-meta-summary-7d") {
      return baseQueryState({ data: { totals: { spend: 6120, roas: 3.2 } } });
    }
    if (key === "creatives-briefing-meta-trends-7d") {
      return baseQueryState({
        data: {
          points: [
            { date: "2026-05-13", roas: 0.68 },
            { date: "2026-05-14", roas: 0.72 },
            { date: "2026-05-15", roas: 0.77 },
            { date: "2026-05-16", roas: 1.65 },
            { date: "2026-05-17", roas: 2.14 },
            { date: "2026-05-18", roas: 1.52 },
            { date: "2026-05-19", roas: 1.51 },
          ],
        },
      });
    }
    if (key === "creatives-briefing-meta-status") {
      return baseQueryState({
        data: mockState.metaStatusData ?? {
          state: "ready",
          connected: true,
          assignedAccountIds: ["act_1"],
          latestSync: { finishedAt: new Date().toISOString() },
        },
      });
    }
    if (key === "creatives-briefing-asset-library") {
      return baseQueryState({ data: mockState.assetLibraryData });
    }
    if (key === "triage-state") {
      return baseQueryState({
        data: {
          rows: [{ scopeType: "creative", scopeId: "cr_deferred", action: "deferred" }],
          deferredCount: 3,
        },
      });
    }
    return baseQueryState();
  }),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/platforms/meta/creatives",
  useRouter: () => ({ push: mockState.routerPush, replace: mockState.routerReplace }),
  useSearchParams: () => mockState.searchParams,
}));

vi.mock("@/store/app-store", () => ({
  useAppStore: (selector: (state: typeof mockState.appStore) => unknown) =>
    selector(mockState.appStore),
}));

function makeBriefingData() {
  return {
    deferredCount: 3,
    pulse: {
      matureCount: 18,
      spendTarget: 1000,
      spendHistory: [420, 560, 680],
      rolling7dRoasTarget: 3,
      engineVersion: "Engine v3",
      calibratedAgo: "2d ago",
      trackingAnomalyActive: true,
    },
    actionNow: [
      {
        id: "cr_action",
        name: "Scale Hero",
        brand: "TheSwaf",
        campaign: "ASC",
        adset: "Broad",
        label: "scale",
        confidence: 88,
        reason: "ROAS above target.",
        spend: 1200,
        roas: 3.4,
        ctr: 1.8,
        purchases: 30,
        sparkline: [2.4, 3.1, 3.4],
        ctrFunnel: { value: 1.8, p50: 1.1 },
        primary: { kind: "promote", label: "Promote to main" },
      },
      {
        id: "rollup_1",
        mixed: true,
        primaryRec: {
          id: "cr_rollup",
          name: "Mixed Catalog",
          brand: "IwaStore",
          label: "scale",
          confidence: 82,
          reason: "Family signal positive.",
          spend: 2400,
          roas: 2.7,
          ctr: 1.4,
          purchases: 64,
          sparkline: [2.1, 2.4, 2.7],
          ctrFunnel: { value: 1.4, p50: 1.1 },
          primary: { kind: "promote", label: "Promote best placement" },
        },
        placementList: [
          { id: "p1", campaign: "DPA", adset: "Lookalike-1%", label: "scale", status: "ACTIVE", spend: 1800, roas: 3.6 },
          { id: "p2", campaign: "DPA", adset: "Lookalike-3%", label: "cut", status: "ACTIVE", spend: 600, roas: 0.8 },
        ],
      },
    ],
    watching: [
      {
        id: "cr_watch",
        name: "Watcher A",
        brand: "TheSwaf",
        campaign: "ABO",
        adset: "AdSet",
        label: "diagnose",
        watchingSubBucket: "diagnostic" as const,
        confidence: 38,
        reason: "Low confidence.",
      },
      {
        id: "cr_watch_near",
        name: "Near Scale Watch",
        brand: "TheSwaf",
        campaign: "ABO",
        adset: "AdSet",
        label: "keep",
        watchingSubBucket: "near_action" as const,
        confidence: 62,
        reason: "Scale readiness blocked.",
      },
    ],
    healthy: [
      {
        id: "cr_health",
        name: "Healthy A",
        brand: "TheSwaf",
        label: "keep",
        spend: 900,
        roas: 2.1,
      },
    ],
    source: {
      laneSummary: {
        actionNow: 2,
        watching: {
          total: 2,
          nearAction: 1,
          testMaturing: 0,
          diagnostic: 1,
          waitingOnLabels: 0,
          other: 0,
        },
        healthy: 1,
        deferred: 3,
        totalDecisions: 5,
        coveragePct: 1,
      },
      aggregateSuppressionTrace: {
        candidateCount: 1,
        emittedCount: 0,
        suppressedCount: 1,
        suppressed: [
          {
            index: 0,
            action: "unused_approved_creatives",
            scope: "page" as const,
            familyId: null,
            reason: "missing_required_data",
            missingRequiredData: ["creative_review_status"],
            candidateMissingData: [],
            prerequisites: [
              { field: "creative_review_status", availableNow: false },
            ],
          },
        ],
      },
    },
  };
}

function decisionCenterRow(overrides: Record<string, unknown> = {}) {
  return {
    scope: "creative",
    creativeId: "cr_action",
    rowId: "cr_action",
    identityGrain: "creative",
    familyId: null,
    engine: {
      contractVersion: "creative-decision-os.v2.1",
      engineVersion: "test-engine",
      primaryDecision: "Scale",
      actionability: "review_only",
      problemClass: "performance",
      confidence: 88,
      maturity: "mature",
      priority: "high",
      reasonTags: ["v3_scale"],
      evidenceSummary: "Server supplied evidence.",
      blockerReasons: [],
      missingData: [],
      queueEligible: false,
      applyEligible: false,
    },
    buyerAction: "scale",
    buyerLabel: "Scale review",
    uiBucket: "scale",
    executionAction: "promote_to_main",
    sourceDecision: "v3:scale",
    confidenceBand: "high",
    priority: "high",
    oneLine: "Server supplied V2.1 decision.",
    reasons: ["above_target"],
    nextStep: "Review the scale move.",
    missingData: [],
    ...overrides,
  };
}

function emptyDecisionCenterActionBoard() {
  return {
    scale: [],
    cut: [],
    refresh: [],
    protect: [],
    test_more: [],
    watch_launch: [],
    fix_delivery: [],
    fix_policy: [],
    diagnose_data: [],
  };
}

function decisionCenterSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    todayBrief: [],
    actionBoard: emptyDecisionCenterActionBoard(),
    rowDecisions: [],
    ...overrides,
  };
}

describe("CreativesBriefingPage", () => {
  beforeEach(() => {
    mockState.queryKeys = [];
    mockState.queryFns = [];
    mockState.routerPush.mockReset();
    mockState.routerReplace.mockReset();
    mockState.searchParams = new URLSearchParams();
    mockState.briefingData = makeBriefingData();
    mockState.assetLibraryData = [];
    mockState.metaStatusData = null;
  });

  it("renders pulse, action lane, and collapsed secondary lanes from briefing data", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-09T12:00:00.000Z"));
    const briefing = makeBriefingData();
    mockState.briefingData = {
      ...briefing,
      pulse: {
        ...briefing.pulse,
        engineVersion: "v3-2026-05-16-phase-h2",
        calibratedAgo: "2026-05-04T12:00:00.000Z",
      },
    };

    const html = renderToStaticMarkup(<CreativesBriefingPage />);
    vi.useRealTimers();

    expect(html).toContain('data-testid="creative-platform-page"');
    expect(html).toContain("Creative · Decision Center");
    expect(html).toContain("Spend · today");
    expect(html).toContain("Action gated");
    expect(html).not.toContain("2026-05-04T12:00:00");
    expect(html).toContain("Account profile");
    expect(html).toContain("Insights data");
    expect(html).toContain("Refresh insights");
    expect(html).not.toContain("3 hidden");
    expect(html).not.toContain("Saved 2s ago");
    expect(html).toContain("Tracking is currently in anomaly.");
    expect(html).toContain("Action Now");
    expect(html).toContain("Deferred 3");
    expect(html).toContain("Scale Hero");
    expect(html).toContain("Mixed Catalog");
    expect(html).toContain("Watching");
    expect(html).not.toContain("Watcher A");
    expect(html).not.toContain("Healthy A");
    expect(html).toContain("Asset Library");
  });

  it("queues a read-only Meta insights refresh through the sync refresh endpoint", async () => {
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, status: "started", provider: "meta" }),
    }));
    vi.stubGlobal("fetch", fetchSpy);

    try {
      const payload = await requestMetaInsightsRefresh("biz_1");

      expect(payload.status).toBe("started");
      expect(fetchSpy).toHaveBeenCalledWith("/api/sync/refresh", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ businessId: "biz_1", provider: "meta" }),
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("renders Asset Library as a URL-addressable workspace tab", () => {
    mockState.searchParams = new URLSearchParams("tab=library");

    const html = renderToStaticMarkup(<CreativesBriefingPage />);

    expect(html).toContain("Asset Library");
    expect(html).toContain("data-asset-library");
    expect(html).not.toContain("ccard-grid");
  });

  it("uses the briefing and existing pulse endpoints", () => {
    renderToStaticMarkup(<CreativesBriefingPage />);

    expect(mockState.queryKeys.map((key) => key[0])).toEqual([
      "creatives-briefing",
      "creatives-briefing-meta-summary-today",
      "creatives-briefing-meta-summary-7d",
      "creatives-briefing-meta-trends-7d",
      "creatives-briefing-meta-status",
      "creatives-briefing-asset-library",
      "triage-state",
    ]);
    expect(mockState.queryKeys[0]).toEqual(["creatives-briefing", "biz_1", true]);
  });

  it("enables Decision Center by default and isolates the opt-out query cache", () => {
    renderToStaticMarkup(<CreativesBriefingPage />);

    expect(mockState.queryKeys[0]).toEqual(["creatives-briefing", "biz_1", true]);
    expect(isDecisionCenterUiEnabled(new URLSearchParams("decision_center=true"))).toBe(
      true,
    );
    expect(isDecisionCenterUiEnabled(new URLSearchParams("decisionCenter=0"))).toBe(
      false,
    );
    expect(isDecisionCenterUiEnabled(new URLSearchParams("decision_center=off"))).toBe(
      false,
    );

    mockState.queryKeys = [];
    mockState.queryFns = [];
    mockState.searchParams = new URLSearchParams("decisionCenter=0");
    renderToStaticMarkup(<CreativesBriefingPage />);
    expect(mockState.queryKeys[0]).toEqual(["creatives-briefing", "biz_1", false]);
  });

  it("sends no request flag by default and sends decisionCenter=0 when opted out", async () => {
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      json: async () => makeBriefingData(),
    }));
    vi.stubGlobal("fetch", fetchSpy);

    try {
      renderToStaticMarkup(<CreativesBriefingPage />);
      await mockState.queryFns[0]();
      expect(fetchSpy).toHaveBeenLastCalledWith(
        "/api/creatives/briefing?businessId=biz_1",
        expect.any(Object),
      );

      mockState.queryKeys = [];
      mockState.queryFns = [];
      mockState.searchParams = new URLSearchParams("decisionCenter=0");
      renderToStaticMarkup(<CreativesBriefingPage />);
      await mockState.queryFns[0]();
      expect(fetchSpy).toHaveBeenLastCalledWith(
        "/api/creatives/briefing?businessId=biz_1&decisionCenter=0",
        expect.any(Object),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not render the retired Decision Center brief or action board surfaces", () => {
    mockState.searchParams = new URLSearchParams("decisionCenter=1");
    mockState.briefingData = {
      ...makeBriefingData(),
      decisionCenter: decisionCenterSnapshot({
        todayBrief: [
          {
            id: "brief_retired",
            priority: "high",
            text: "Retired brief should stay hidden.",
            rowIds: ["cr_action"],
          },
        ],
        actionBoard: {
          ...emptyDecisionCenterActionBoard(),
          cut: ["cr_action"],
        },
        rowDecisions: [
          decisionCenterRow({
            buyerLabel: "Retired board row should stay hidden.",
          }),
        ],
      }),
    } as any;

    const html = renderToStaticMarkup(<CreativesBriefingPage />);

    expect(html).not.toContain('data-testid="decision-center-today-brief"');
    expect(html).not.toContain('data-testid="decision-center-action-board"');
    expect(html).not.toContain("Decision Center Today Brief");
    expect(html).not.toContain("Decision Center Action Board");
    expect(html).not.toContain("Server-supplied shadow preview");
    expect(html).not.toContain("Server-supplied shadow buckets");
    expect(html).not.toContain("shadow preview");
    expect(html).not.toContain("Retired brief should stay hidden.");
    expect(html).not.toContain("Retired board row should stay hidden.");
  });

  it("renders structured decision blocker predicates in evidence sections", () => {
    const sections = buildEvidenceSections({
      id: "creative_1",
      creativeId: "creative_1",
      name: "Creative 1",
      label: "keep",
      confidence: 82,
      reason: "[near scale] ROAS above target but blocked by scale readiness.",
      primary: { kind: "review", label: "Review" },
      blockers: [
        {
          predicate: "scale_purchase_depth",
          observed: 2,
          threshold: 5,
          status: "failed",
          severity: "warning",
          reason: "purchases 2 below scale floor",
        },
        {
          predicate: "scale_recent_hold",
          observed: 1.8,
          threshold: 2.2,
          status: "failed",
          severity: "warning",
          reason: "recent 7d ROAS below target",
        },
      ],
    } as any);
    const blockers = sections.find((section) => section.key === "blockers");

    expect(blockers).toBeTruthy();
    const html = renderToStaticMarkup(<>{blockers?.content}</>);
    expect(html).toContain("scale_purchase_depth");
    expect(html).toContain("scale_recent_hold");
    expect(html).toContain("2");
    expect(html).toContain("5");
    expect(html).toContain("1.8");
    expect(html).toContain("2.2");
  });

  it("attaches server-supplied decisionCenter rows without crashing on null or missing snapshots", () => {
    const briefing = makeBriefingData();
    const normalizedMissing = normalizeCreativesBriefingPayload(briefing);
    expect(
      (normalizedMissing?.actionNow[0] as any).decisionCenterRow,
    ).toBeUndefined();

    const normalizedNull = normalizeCreativesBriefingPayload({
      ...briefing,
      decisionCenter: null,
    } as any);
    expect((normalizedNull?.actionNow[0] as any).decisionCenterRow).toBeUndefined();

    const normalizedHappy = normalizeCreativesBriefingPayload({
      ...briefing,
      watching: [
        {
          ...briefing.watching[0],
          creativeId: "creative_watch",
        },
      ],
      decisionCenter: {
        rowDecisions: [
          decisionCenterRow(),
          decisionCenterRow({
            creativeId: "creative_watch",
            rowId: "orphan_row_id",
            buyerAction: "diagnose_data",
            buyerLabel: "Diagnose data",
            uiBucket: "diagnose_data",
            executionAction: null,
          }),
          decisionCenterRow({
            creativeId: "orphan_creative",
            rowId: "orphan_row",
          }),
        ],
      },
    } as any);

    expect((normalizedHappy?.actionNow[0] as any).decisionCenterRow?.buyerAction).toBe(
      "scale",
    );
    expect(normalizedHappy?.watching[0]?.decisionCenterRow?.buyerAction).toBe(
      "diagnose_data",
    );
    expect(normalizedHappy?.healthy[0]?.decisionCenterRow).toBeUndefined();
  });

  it("enriches Asset Library rows from Decision Center rows only behind the UI flag", () => {
    const rows = [
      { id: "row_id_match", creativeId: "cr_unmatched" },
      { id: "row_unmatched", creativeId: "cr_match" },
      { id: "row_missing", creativeId: "cr_missing" },
    ] as any[];
    const snapshot = decisionCenterSnapshot({
      rowDecisions: [
        decisionCenterRow({
          rowId: "row_id_match",
          creativeId: "cr_other",
          buyerAction: "scale",
          buyerLabel: "Scale",
          uiBucket: "scale",
        }),
        decisionCenterRow({
          rowId: "row_other",
          creativeId: "cr_match",
          buyerAction: "cut",
          buyerLabel: "Cut",
          uiBucket: "cut",
        }),
      ],
    });

    const flagOff = attachDecisionCenterRowsToAssetLibraryRows(
      rows,
      snapshot as any,
      false,
    );
    expect(flagOff).toBe(rows);
    expect((flagOff[0] as any).decisionCenterRow).toBeUndefined();

    const missingSnapshot = attachDecisionCenterRowsToAssetLibraryRows(
      rows,
      null,
      true,
    );
    expect(missingSnapshot).toBe(rows);

    const flagOn = attachDecisionCenterRowsToAssetLibraryRows(
      rows,
      snapshot as any,
      true,
    );
    expect(flagOn).not.toBe(rows);
    expect((flagOn[0] as any).decisionCenterRow?.buyerAction).toBe("scale");
    expect((flagOn[1] as any).decisionCenterRow?.buyerAction).toBe("cut");
    expect((flagOn[2] as any).decisionCenterRow).toBeUndefined();
  });

  it("draws the 7d ROAS spark from live trend data instead of a synthetic curve", () => {
    const html = renderToStaticMarkup(<CreativesBriefingPage />);

    const sparkSection = html.split('class="cell"')[2] ?? "";
    expect(sparkSection).toContain('class="spark"');
    expect(sparkSection).not.toContain("0,7.6 L10,4.65 L20,5.83");
    expect(sparkSection).toContain('d="M');
  });

  it("filters selected IDs by lane for future bulk toolbar ownership", () => {
    expect(filterSelectedIdsForLane(["cr_action", "cr_watch", "missing"], ["cr_watch"])).toEqual([
      "cr_watch",
    ]);
  });

  it("renders the Action Now empty state when there are no visible action items", () => {
    mockState.briefingData = {
      ...makeBriefingData(),
      actionNow: [],
      trackingAnomalyActive: false,
      pulse: {
        ...makeBriefingData().pulse,
        trackingAnomalyActive: false,
      },
    };

    const html = renderToStaticMarkup(<CreativesBriefingPage />);

    expect(html).toContain("Nothing for you to do right now.");
    expect(html).toContain("18 mature creatives · 2 watching · Data is loaded in the lanes below");
    expect(html).toContain("Expand Watching below");
    expect(html).toContain("Launch a new test");
    expect(html).not.toContain("Scale Hero");
    expect(html).not.toContain("data-tracking-blocker");
  });

  it("defaults to Watching when Action Now is sparse and most decisions are watch items", () => {
    expect(
      chooseDefaultCreativeLane({
        actionCount: 1,
        watchingCount: 67,
        healthyCount: 0,
      }),
    ).toBe("watching");
    expect(
      chooseDefaultCreativeLane({
        actionCount: 4,
        watchingCount: 39,
        healthyCount: 3,
      }),
    ).toBe("watching");
    expect(
      chooseDefaultCreativeLane({
        actionCount: 0,
        watchingCount: 1,
        healthyCount: 0,
      }),
    ).toBe("action");
    expect(
      decisionVisibilitySummary({
        actionCount: 4,
        watchingCount: 39,
        healthyCount: 3,
        activeLane: "watching",
      }),
    ).toMatchObject({
      total: 46,
      activeCount: 39,
      isSparseActionDefault: true,
    });
  });

  it("renders the server-supplied all view and watching subgroups without deriving buyerAction", () => {
    mockState.searchParams = new URLSearchParams("lane=all");

    const html = renderToStaticMarkup(<CreativesBriefingPage />);

    expect(html).toContain("Server lane summary");
    expect(html).toContain("Near action 1, test maturing 0, diagnostic 1, labels 0");
    expect(html).toContain("Aggregate decisions not available");
    expect(html).toContain("Scale Hero");
    expect(html).toContain("Watcher A");
    expect(html).toContain("Near Scale Watch");
    expect(html).toContain("Healthy A");
    expect(html).not.toContain("buyerAction");
  });

  it("groups Watching cards by the server-supplied watchingSubBucket", () => {
    mockState.searchParams = new URLSearchParams("lane=watching");

    const html = renderToStaticMarkup(<CreativesBriefingPage />);

    expect(html).toContain("Near action");
    expect(html).toContain("Diagnostic");
    expect(html).toContain("Near Scale Watch");
    expect(html).toContain("Watcher A");
  });

  it("renders a setup notice instead of a silent empty page when no Meta ad account is assigned", () => {
    mockState.metaStatusData = {
      state: "connected_no_assignment",
      connected: true,
      assignedAccountIds: [],
      latestSync: null,
    };
    mockState.assetLibraryData = {
      status: "no_accounts_assigned",
      message: null,
      rows: [],
    };
    mockState.briefingData = {
      ...makeBriefingData(),
      actionNow: [],
      watching: [],
      healthy: [],
      trackingAnomalyActive: false,
      pulse: {
        ...makeBriefingData().pulse,
        matureCount: 0,
        trackingAnomalyActive: false,
      },
    };

    const html = renderToStaticMarkup(<CreativesBriefingPage />);

    expect(html).toContain("Meta ad account assignment is missing.");
    expect(html).toContain("no Meta ad account is assigned");
    expect(html).not.toContain("Nothing for you to do right now.");
    expect(html).not.toContain("Launch a new test");
  });

  it("does not render the good-day empty state during a tracking anomaly", () => {
    mockState.briefingData = {
      ...makeBriefingData(),
      actionNow: [],
      trackingAnomalyActive: true,
      pulse: {
        ...makeBriefingData().pulse,
        trackingAnomalyActive: true,
      },
    };

    const html = renderToStaticMarkup(<CreativesBriefingPage />);

    expect(html).toContain("Tracking is currently in anomaly.");
    expect(html).toContain("Tracking needs attention before action triage.");
    expect(html).not.toContain("Nothing for you to do right now.");
    expect(html).toContain("data-tracking-blocker");
  });

  it("keeps the page available when optional briefing arrays are malformed", () => {
    mockState.briefingData = {
      ...makeBriefingData(),
      actionNow: "not-an-array",
      watching: null,
      healthy: { bad: true },
      pulse: {
        ...makeBriefingData().pulse,
        spendHistory: "not-an-array",
        trackingAnomalyActive: false,
      },
      trackingAnomalyActive: false,
    } as any;

    const html = renderToStaticMarkup(<CreativesBriefingPage />);

    expect(html).toContain("Creatives");
    expect(html).toContain("Nothing for you to do right now.");
    expect(html).toContain("Asset Library");
    expect(html).not.toContain("This page is temporarily unavailable");
  });

  it("does not convert placement-count-only cards into empty rollups", () => {
    mockState.briefingData = {
      ...makeBriefingData(),
      actionNow: [
        {
          id: "cr_multi",
          name: "Multi placement without strip",
          brand: "TheSwaf",
          label: "scale",
          confidence: 80,
          reason: "Server did not provide placement rows.",
          placements: 3,
          spend: 500,
          roas: 3,
          purchases: 8,
        },
      ],
      trackingAnomalyActive: false,
      pulse: {
        ...makeBriefingData().pulse,
        trackingAnomalyActive: false,
      },
    };

    const html = renderToStaticMarkup(<CreativesBriefingPage />);

    expect(html).toContain("Multi placement without strip");
    expect(html).not.toContain("data-rollup=\"cross-placement\"");
    expect(html).not.toContain("Placements (0)");
  });

  it("filters cut action rows after the animation completes", () => {
    const remaining = filterRemovedActionItems(
      [
        { key: "cr_action", type: "card", card: { id: "cr_action" } },
        { key: "cr_keep", type: "card", card: { id: "cr_keep" } },
      ],
      ["cr_action"],
    );

    expect(remaining.map((item) => item.key)).toEqual(["cr_keep"]);
  });

  it("resolves selected Action Now cards for bulk toolbar ownership", () => {
    const selectedCards = selectedCardsForActionItems(
      [
        {
          key: "cr_action",
          type: "card",
          card: { id: "cr_action", creativeId: "creative_action", name: "Action" },
        },
        {
          key: "rollup_1",
          type: "rollup",
          rollup: {
            id: "rollup_1",
            primaryRec: { id: "cr_rollup", creativeId: "creative_rollup", name: "Rollup" },
            mixed: false,
            placementList: [{ id: "p1", creativeId: "creative_p1", label: "scale" }],
          },
        },
      ],
      ["cr_action", "cr_rollup"],
    );

    expect(selectedCards.map((card) => card.id)).toEqual(["cr_action", "cr_rollup"]);
    expect(selectedCards[1]?.placementList?.[0]?.creativeId).toBe("creative_p1");
  });

  it("resolves selected Watching cards for lane-scoped bulk actions", () => {
    const selectedCards = selectedCardsForCards(
      [
        { id: "cr_watch_1", creativeId: "creative_watch_1", name: "Watch 1", label: "test_more" },
        { id: "cr_watch_2", creativeId: "creative_watch_2", name: "Watch 2", label: "diagnose" },
      ],
      ["cr_watch_2", "missing"],
    );

    expect(selectedCards.map((card) => card.id)).toEqual(["cr_watch_2"]);
    expect(selectedCards[0]?.label).toBe("diagnose");
  });

  it("builds page-level Launchpad overlay state and confirm href", () => {
    const card = makeBriefingData().actionNow[0] as any;
    const openState = openLaunchpadOverlayState({ card, mode: "promote" });

    expect(openState.open).toBe(true);
    expect(openState.mode).toBe("promote");
    expect(launchpadHrefFromOverlayState(openState)).toBe(
      "/platforms/meta/launchpad?creativeIds=cr_action&mode=promote&fromBriefing=true",
    );
    expect(launchpadHrefFromOverlayState(CLOSED_LAUNCHPAD_OVERLAY_STATE)).toBeNull();
  });

  it("maps creative data setup and library empty states from backend status", () => {
    expect(
      getCreativeDataSetupNotice({
        metaStatus: { state: "connected_no_assignment", connected: true, assignedAccountIds: [] } as any,
        assetLibraryStatus: null,
      })?.title,
    ).toBe("Meta ad account assignment is missing.");
    expect(getAssetLibraryEmptyMessage({ status: "no_access_token", message: null })).toBe(
      "Meta connection is missing an access token. Reconnect Meta to load creative data.",
    );
  });
});

describe("cardMatchesActionFilter (decision-center contract)", () => {
  const rowCard = (row: Record<string, unknown> | null, legacy: Record<string, unknown> = {}) =>
    ({
      id: "cr_1",
      name: "Creative 1",
      // Legacy fields deliberately contradict the decision-center row so the
      // test proves which source wins.
      primary: { kind: "cut", label: "Cut now" },
      label: "cut",
      decisionCenterRow: row,
      ...legacy,
    }) as never;

  it("uses buyerAction from the decision-center row over legacy card kind", () => {
    const card = rowCard(decisionCenterRow({ buyerAction: "scale" }));
    expect(cardMatchesActionFilter(card, "scale")).toBe(true);
    expect(cardMatchesActionFilter(card, "cut")).toBe(false);
  });

  it("matches promote via executionAction promote_to_main only", () => {
    expect(
      cardMatchesActionFilter(
        rowCard(decisionCenterRow({ executionAction: "promote_to_main" })),
        "promote",
      ),
    ).toBe(true);
    expect(
      cardMatchesActionFilter(
        rowCard(decisionCenterRow({ executionAction: "scale_budget" })),
        "promote",
      ),
    ).toBe(false);
  });

  it("maps fresh_test to test_more and watch_launch buyer actions", () => {
    expect(
      cardMatchesActionFilter(
        rowCard(decisionCenterRow({ buyerAction: "test_more" })),
        "fresh_test",
      ),
    ).toBe(true);
    expect(
      cardMatchesActionFilter(
        rowCard(decisionCenterRow({ buyerAction: "watch_launch" })),
        "fresh_test",
      ),
    ).toBe(true);
    expect(
      cardMatchesActionFilter(
        rowCard(decisionCenterRow({ buyerAction: "scale" })),
        "fresh_test",
      ),
    ).toBe(false);
  });

  it("keeps add_existing on the legacy card-kind match even with a row present", () => {
    const card = rowCard(decisionCenterRow({ buyerAction: "scale" }), {
      primary: { kind: "add_existing", label: "Add existing" },
    });
    expect(cardMatchesActionFilter(card, "add_existing")).toBe(true);
  });

  it("falls back to legacy substring matching without a decision-center row", () => {
    const card = rowCard(null);
    expect(cardMatchesActionFilter(card, "cut")).toBe(true);
    expect(cardMatchesActionFilter(card, "scale")).toBe(false);
  });

  it("always matches the all filter", () => {
    expect(cardMatchesActionFilter(rowCard(null), "all")).toBe(true);
  });
});
