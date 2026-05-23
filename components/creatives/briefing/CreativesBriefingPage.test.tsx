import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLOSED_LAUNCHPAD_OVERLAY_STATE,
  CreativesBriefingPage,
  decisionCenterActionBoardSections,
  decisionCenterTodayBriefItems,
  isDecisionCenterUiRequested,
  normalizeCreativesBriefingPayload,
  selectedCardsForActionItems,
  selectedCardsForCards,
  filterRemovedActionItems,
  filterSelectedIdsForLane,
  getAssetLibraryEmptyMessage,
  getCreativeDataSetupNotice,
  launchpadHrefFromOverlayState,
  openLaunchpadOverlayState,
} from "@/components/creatives/briefing/CreativesBriefingPage";

const mockState = vi.hoisted(() => ({
  queryKeys: [] as unknown[][],
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
  useQuery: vi.fn((input: { queryKey: unknown[] }) => {
    mockState.queryKeys.push(input.queryKey);
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
        confidence: 38,
        reason: "Low confidence.",
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

function decisionCenterTodayBrief(overrides: Record<string, unknown> = {}) {
  return {
    id: "brief_1",
    priority: "medium",
    text: "Server supplied brief.",
    rowIds: ["cr_action"],
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

function decisionCenterSnapshotWithTodayBrief(todayBrief: unknown) {
  return decisionCenterSnapshot({ todayBrief });
}

function extractDecisionCenterTodayBriefPanel(html: string) {
  const start = html.indexOf('data-testid="decision-center-today-brief"');
  expect(start).toBeGreaterThanOrEqual(0);
  const actionBoardStart = html.indexOf(
    'data-testid="decision-center-action-board"',
    start,
  );
  const laneTabsStart = html.indexOf('<div class="lane-tabs"', start);
  const end =
    actionBoardStart > start && actionBoardStart < laneTabsStart
      ? actionBoardStart
      : laneTabsStart;
  expect(end).toBeGreaterThan(start);
  return html.slice(start, end);
}

function extractDecisionCenterActionBoardPanel(html: string) {
  const start = html.indexOf('data-testid="decision-center-action-board"');
  expect(start).toBeGreaterThanOrEqual(0);
  const end = html.indexOf('<div class="lane-tabs"', start);
  expect(end).toBeGreaterThan(start);
  return html.slice(start, end);
}

function extractDecisionCenterActionBoardBucket(html: string, bucketKey: string) {
  const marker = `data-bucket-key="${bucketKey}"`;
  const start = html.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const nextBucket = html.indexOf('data-bucket-key="', start + marker.length);
  const panelEnd = html.indexOf("</section>", start);
  const end =
    nextBucket > start && nextBucket < panelEnd ? nextBucket : panelEnd;
  expect(end).toBeGreaterThan(start);
  return html.slice(start, end);
}

describe("CreativesBriefingPage", () => {
  beforeEach(() => {
    mockState.queryKeys = [];
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
    expect(mockState.queryKeys[0]).toEqual(["creatives-briefing", "biz_1", false]);
  });

  it("requests decisionCenter rows only behind the explicit URL flag", () => {
    mockState.searchParams = new URLSearchParams("decisionCenter=1");

    renderToStaticMarkup(<CreativesBriefingPage />);

    expect(mockState.queryKeys[0]).toEqual(["creatives-briefing", "biz_1", true]);
    expect(isDecisionCenterUiRequested(new URLSearchParams("decision_center=true"))).toBe(
      true,
    );
    expect(isDecisionCenterUiRequested(new URLSearchParams("decisionCenter=0"))).toBe(
      false,
    );
  });

  it("renders nothing for the Decision Center Today Brief when the URL flag is off", () => {
    mockState.briefingData = {
      ...makeBriefingData(),
      decisionCenter: decisionCenterSnapshotWithTodayBrief([
        decisionCenterTodayBrief({ text: "Flag-off brief should stay hidden." }),
      ]),
    } as any;

    const html = renderToStaticMarkup(<CreativesBriefingPage />);

    expect(decisionCenterTodayBriefItems(mockState.briefingData.decisionCenter, false)).toEqual(
      [],
    );
    expect(html).not.toContain('data-testid="decision-center-today-brief"');
    expect(html).not.toContain("Flag-off brief should stay hidden.");
  });

  it("renders server-supplied Decision Center Today Brief entries in server order", () => {
    mockState.searchParams = new URLSearchParams("decisionCenter=1");
    mockState.briefingData = {
      ...makeBriefingData(),
      decisionCenter: decisionCenterSnapshotWithTodayBrief([
        decisionCenterTodayBrief({
          id: "brief_low",
          priority: "low",
          text: "Low priority first from server.",
          rowIds: ["cr_low"],
          aggregateIds: ["agg_1"],
        }),
        decisionCenterTodayBrief({
          id: "brief_critical",
          priority: "critical",
          text: "Critical priority second from server.",
          rowIds: ["cr_critical"],
        }),
      ]),
    } as any;

    const html = renderToStaticMarkup(<CreativesBriefingPage />);
    const panel = extractDecisionCenterTodayBriefPanel(html);

    expect(panel).toContain("Decision Center Today Brief");
    expect(panel).toContain("low");
    expect(panel).toContain("critical");
    expect(panel).toContain("1 row");
    expect(panel).toContain("1 aggregate");
    expect(panel.indexOf("Low priority first from server.")).toBeLessThan(
      panel.indexOf("Critical priority second from server."),
    );
  });

  it("does not truncate, filter, or top-N Decision Center Today Brief entries", () => {
    mockState.searchParams = new URLSearchParams("decisionCenter=1");
    const entries = Array.from({ length: 12 }, (_, index) =>
      decisionCenterTodayBrief({
        id: `brief_${index}`,
        priority: "medium",
        text: `Server brief ${index}`,
        rowIds: [`row_${index}`],
      }),
    );
    mockState.briefingData = {
      ...makeBriefingData(),
      decisionCenter: decisionCenterSnapshotWithTodayBrief(entries),
    } as any;

    const html = renderToStaticMarkup(<CreativesBriefingPage />);
    const panel = extractDecisionCenterTodayBriefPanel(html);

    expect(panel.match(/data-testid="decision-center-brief-entry"/g)).toHaveLength(12);
    expect(panel).toContain("Server brief 0");
    expect(panel).toContain("Server brief 11");
  });

  it("does not render buyer action or write controls in the Today Brief panel", () => {
    mockState.searchParams = new URLSearchParams("decision_center=true");
    mockState.briefingData = {
      ...makeBriefingData(),
      decisionCenter: decisionCenterSnapshotWithTodayBrief([
        decisionCenterTodayBrief({
          id: "brief_review",
          priority: "high",
          text: "Today brief content.",
          rowIds: ["row_1"],
        }),
      ]),
    } as any;

    const html = renderToStaticMarkup(<CreativesBriefingPage />);
    const panel = extractDecisionCenterTodayBriefPanel(html).toLowerCase();

    expect(panel).not.toMatch(
      /\b(apply|queue|pause|promote|scale|cut|refresh|buyeraction|executionaction|primarydecision)\b/,
    );
  });

  it("keeps the Decision Center Today Brief crash-safe for null or malformed snapshots", () => {
    expect(decisionCenterTodayBriefItems(null as any, true)).toEqual([]);
    expect(
      decisionCenterTodayBriefItems(
        decisionCenterSnapshotWithTodayBrief("not-an-array") as any,
        true,
      ),
    ).toEqual([]);
    expect(
      decisionCenterTodayBriefItems(
        decisionCenterSnapshotWithTodayBrief([
          decisionCenterTodayBrief({ id: "", text: "Missing id." }),
          decisionCenterTodayBrief({ id: "missing_text", text: "" }),
          null,
        ]) as any,
        true,
      ),
    ).toEqual([]);

    mockState.searchParams = new URLSearchParams("decisionCenter=1");
    mockState.briefingData = {
      ...makeBriefingData(),
      decisionCenter: decisionCenterSnapshotWithTodayBrief("not-an-array"),
    } as any;

    const html = renderToStaticMarkup(<CreativesBriefingPage />);
    const panel = extractDecisionCenterTodayBriefPanel(html);

    expect(panel).toContain("No server-supplied Decision Center brief yet.");
    expect(panel).not.toContain('data-testid="decision-center-brief-entry"');
  });

  it("renders nothing for the Decision Center Action Board when the URL flag is off", () => {
    mockState.briefingData = {
      ...makeBriefingData(),
      decisionCenter: decisionCenterSnapshot({
        actionBoard: {
          ...emptyDecisionCenterActionBoard(),
          scale: ["cr_action"],
        },
      }),
    } as any;

    const html = renderToStaticMarkup(<CreativesBriefingPage />);

    expect(
      decisionCenterActionBoardSections(
        mockState.briefingData.decisionCenter,
        false,
      ),
    ).toEqual([]);
    expect(html).not.toContain('data-testid="decision-center-action-board"');
    expect(html).not.toContain("Decision Center Action Board");
  });

  it("renders all Decision Center Action Board buckets in canonical order", () => {
    mockState.searchParams = new URLSearchParams("decisionCenter=1");
    mockState.briefingData = {
      ...makeBriefingData(),
      decisionCenter: decisionCenterSnapshot({
        actionBoard: {
          diagnose_data: [],
          fix_policy: [],
          fix_delivery: [],
          watch_launch: [],
          test_more: [],
          protect: [],
          refresh: [],
          cut: [],
          scale: ["cr_action"],
        },
        rowDecisions: [
          decisionCenterRow({
            buyerLabel: "Server scale review",
          }),
        ],
      }),
    } as any;

    const html = renderToStaticMarkup(<CreativesBriefingPage />);
    const panel = extractDecisionCenterActionBoardPanel(html);
    const bucketKeys = Array.from(
      panel.matchAll(/data-bucket-key="([^"]+)"/g),
      (match) => match[1],
    );

    expect(bucketKeys).toEqual([
      "scale",
      "cut",
      "refresh",
      "protect",
      "test_more",
      "watch_launch",
      "fix_delivery",
      "fix_policy",
      "diagnose_data",
    ]);
    expect(
      panel.match(/data-testid="decision-center-action-board-bucket"/g),
    ).toHaveLength(9);
    expect(panel).toContain("0 rows");
    expect(panel).toContain("1 row");
  });

  it("preserves server row order inside Action Board buckets without top-N truncation", () => {
    mockState.searchParams = new URLSearchParams("decisionCenter=1");
    const rowIds = Array.from({ length: 12 }, (_, index) => `row_${11 - index}`);
    mockState.briefingData = {
      ...makeBriefingData(),
      decisionCenter: decisionCenterSnapshot({
        actionBoard: {
          ...emptyDecisionCenterActionBoard(),
          scale: rowIds,
        },
      }),
    } as any;

    const html = renderToStaticMarkup(<CreativesBriefingPage />);
    const scaleBucket = extractDecisionCenterActionBoardBucket(html, "scale");

    expect(
      scaleBucket.match(/data-testid="decision-center-action-board-row"/g),
    ).toHaveLength(12);
    expect(scaleBucket.indexOf("row_11")).toBeLessThan(
      scaleBucket.indexOf("row_10"),
    );
    expect(scaleBucket).toContain("row_0");
  });

  it("uses only server Action Board membership and ignores legacy card labels", () => {
    mockState.searchParams = new URLSearchParams("decisionCenter=1");
    const briefing = makeBriefingData();
    mockState.briefingData = {
      ...briefing,
      actionNow: [
        {
          ...(briefing.actionNow[0] as any),
          label: "cut",
          primary: { kind: "cut", label: "Cut" },
        },
      ],
      decisionCenter: decisionCenterSnapshot({
        actionBoard: {
          ...emptyDecisionCenterActionBoard(),
          scale: ["cr_action"],
          cut: [],
        },
        rowDecisions: [
          decisionCenterRow({
            buyerLabel: "Server bucket label",
          }),
        ],
      }),
    } as any;

    const html = renderToStaticMarkup(<CreativesBriefingPage />);
    const scaleBucket = extractDecisionCenterActionBoardBucket(html, "scale");
    const cutBucket = extractDecisionCenterActionBoardBucket(html, "cut");

    expect(scaleBucket).toContain("cr_action");
    expect(cutBucket).not.toContain("cr_action");
  });

  it("does not derive Action Board membership from rowDecisions", () => {
    mockState.searchParams = new URLSearchParams("decisionCenter=1");
    mockState.briefingData = {
      ...makeBriefingData(),
      decisionCenter: decisionCenterSnapshot({
        actionBoard: emptyDecisionCenterActionBoard(),
        rowDecisions: [
          decisionCenterRow({
            rowId: "row_from_row_decisions_only",
            creativeId: "creative_from_row_decisions_only",
            buyerLabel: "Row-only label",
          }),
        ],
      }),
    } as any;

    const html = renderToStaticMarkup(<CreativesBriefingPage />);
    const panel = extractDecisionCenterActionBoardPanel(html);

    expect(panel).not.toContain("row_from_row_decisions_only");
    expect(
      panel.match(/data-testid="decision-center-action-board-bucket"/g),
    ).toHaveLength(9);
    expect(
      panel.match(/data-testid="decision-center-action-board-row"/g),
    ).toBeNull();
  });

  it("does not render unknown Action Board buckets from malformed snapshots", () => {
    mockState.searchParams = new URLSearchParams("decisionCenter=1");
    mockState.briefingData = {
      ...makeBriefingData(),
      decisionCenter: decisionCenterSnapshot({
        actionBoard: {
          ...emptyDecisionCenterActionBoard(),
          scale: ["cr_action"],
          brief_variation: ["row_unknown"],
          promote_to_main: ["row_execution_action"],
        },
      }),
    } as any;

    const html = renderToStaticMarkup(<CreativesBriefingPage />);
    const panel = extractDecisionCenterActionBoardPanel(html);
    const bucketKeys = Array.from(
      panel.matchAll(/data-bucket-key="([^"]+)"/g),
      (match) => match[1],
    );

    expect(bucketKeys).toHaveLength(9);
    expect(bucketKeys).not.toContain("brief_variation");
    expect(bucketKeys).not.toContain("promote_to_main");
    expect(panel).not.toContain("row_unknown");
    expect(panel).not.toContain("row_execution_action");
  });

  it("does not render write controls in the Action Board panel", () => {
    mockState.searchParams = new URLSearchParams("decisionCenter=1");
    mockState.briefingData = {
      ...makeBriefingData(),
      decisionCenter: decisionCenterSnapshot({
        actionBoard: {
          ...emptyDecisionCenterActionBoard(),
          protect: ["cr_action"],
        },
        rowDecisions: [
          decisionCenterRow({
            buyerLabel: "Audit only label",
          }),
        ],
      }),
    } as any;

    const html = renderToStaticMarkup(<CreativesBriefingPage />);
    const panel = extractDecisionCenterActionBoardPanel(html).toLowerCase();

    expect(panel).not.toContain("<button");
    expect(panel).not.toMatch(
      /\b(apply|queue|pause|launchpad|meta write|duplicate|executionaction|primarydecision)\b/,
    );
  });

  it("keeps the Decision Center Action Board crash-safe for null or malformed snapshots", () => {
    expect(decisionCenterActionBoardSections(null as any, true)).toEqual([]);
    expect(
      decisionCenterActionBoardSections(
        decisionCenterSnapshot({ actionBoard: "not-an-object" }) as any,
        true,
      ),
    ).toEqual([]);

    mockState.searchParams = new URLSearchParams("decisionCenter=1");
    mockState.briefingData = {
      ...makeBriefingData(),
      decisionCenter: decisionCenterSnapshot({ actionBoard: "not-an-object" }),
    } as any;

    const html = renderToStaticMarkup(<CreativesBriefingPage />);
    const panel = extractDecisionCenterActionBoardPanel(html);

    expect(panel).toContain(
      "No server-supplied Decision Center action board yet.",
    );
    expect(panel).not.toContain(
      'data-testid="decision-center-action-board-bucket"',
    );
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
    expect(html).toContain("18 mature creatives · 1 watching · Data is loaded in the lanes below");
    expect(html).toContain("Expand Watching below");
    expect(html).toContain("Launch a new test");
    expect(html).not.toContain("Scale Hero");
    expect(html).not.toContain("data-tracking-blocker");
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
