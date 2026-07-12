import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  metaAnomaly,
  metaHealthy,
  metaLanePayload,
  metaPulse,
  metaRec,
} from "@/components/meta/redesign/test-fixtures";
import {
  MetaPlatformPage,
  META_MONITOR_PAGE_SIZE,
  paginateMetaMonitorRows,
  campaignKindMatchesMetaLabelFilter,
  metaActionFailureMessage,
  metaAdsetPauseNotice,
  metaBidApplyNotice,
  isTrackingWriteBlocked,
  compareItemForRec,
  trackingConfirmLabelForRec,
  metaRecSearchMatch,
  sortMetaRecs,
} from "@/components/meta/redesign/MetaPlatformPage";

const state = vi.hoisted(() => ({
  routerPush: vi.fn(),
  routerReplace: vi.fn(),
  queryKeys: [] as unknown[][],
  lanePayload: null as any,
  pulsePayload: null as any,
  labelCampaigns: [] as any[],
  campaignLabels: [] as any[],
  search: "window=28d",
  storeBusinesses: [] as Array<{ id: string; name: string; currency: string }>,
  workspaceBanners: [] as any[],
  workspaceViewer: null as any,
  providerAccounts: [
    {
      id: "act_1",
      name: "Main Meta",
      currency: "USD",
      timezone: "Europe/Istanbul",
    },
  ] as any[],
  decisionReadModel: null as any,
  selectBusiness: vi.fn(),
  queryOverrides: {} as Record<
    string,
    { data?: unknown; isLoading?: boolean; error?: Error | null }
  >,
}));

function queryState(
  data: unknown,
  override?: { data?: unknown; isLoading?: boolean; error?: Error | null },
) {
  const hasDataOverride =
    override && Object.prototype.hasOwnProperty.call(override, "data");
  const error = override?.error ?? null;
  return {
    data: hasDataOverride ? override?.data : data,
    isLoading: override?.isLoading ?? false,
    isError: Boolean(error),
    error,
  };
}

function workspacePayload() {
  const pulse = state.pulsePayload ?? metaPulse();
  const lanes = state.lanePayload ?? metaLanePayload();
  return {
    businessId: pulse.businessId,
    window: pulse.window,
    statusFilter: pulse.statusFilter,
    startDate: pulse.startDate,
    endDate: pulse.endDate,
    pulse,
    lanes,
    queue: {
      groups: [
        { key: "action", label: "Action Now", count: lanes.counts.actionNow },
        { key: "watching", label: "Watching", count: lanes.counts.watching },
        { key: "healthy", label: "Healthy", count: lanes.counts.healthy },
        { key: "nonSales", label: "Non-sales", count: lanes.counts.nonSales },
        { key: "archive", label: "Archive", count: lanes.counts.archive },
      ],
      actionStates: {
        executablePause: 0,
        executableBid: 0,
        executableResume: 0,
        launchpadRoutes: 0,
        reviewOnly: 0,
        missingActionKind: 0,
      },
    },
    system: {
      trackingBlocked:
        pulse.trackingAnomalyActive === true ||
        pulse.trackingHealth.status === "blocked" ||
        pulse.trackingHealth.status === "degraded",
      dataReadiness: pulse.dataReadiness ?? null,
      snapshotHealth: pulse.snapshotHealth ?? lanes.snapshotHealth ?? null,
      laneSnapshotDate: lanes.snapshotDate,
      laneSnapshotCreatedAt: lanes.snapshotCreatedAt ?? null,
      engineVersion: pulse.engineVersion,
      currency: pulse.currency ?? null,
      killSwitchEngaged: false,
      killSwitchReason: null,
    },
    viewer: state.workspaceViewer,
    banners: state.workspaceBanners,
    digest: {
      snapshotDate: lanes.snapshotDate,
      unavailableReason: null,
      labelFlips: {
        count: 2,
        publishedCount: 2,
        items: [
          {
            id: "flip_1",
            title: "Retargeting 30d",
            previousLabel: "watch",
            currentLabel: "act",
            status: "published",
            occurredAt: "2026-05-07",
          },
        ],
      },
      actions: {
        verifiedCount: 1,
        silentFailureCount: 1,
        items: [
          {
            id: "action_1",
            action: "pause",
            target: "Broad LAL 2",
            actor: "Autopilot",
            status: "verified",
            occurredAt: "2026-05-07T06:41:00.000Z",
            detail: null,
          },
          {
            id: "action_2",
            action: "pause",
            target: "Broad Test 01",
            actor: "Deniz",
            status: "silent_failure",
            occurredAt: "2026-05-07T06:52:00.000Z",
            detail: "Meta verification disagreed.",
          },
        ],
      },
      anomalies: {
        openedCount: 1,
        items: [
          {
            id: "anom_1",
            title: "Purchase-event drop",
            status: "open",
            occurredAt: "2026-05-07T05:12:00.000Z",
          },
        ],
      },
      deferrals: {
        dueCount: 1,
        items: [
          {
            id: "rec_deferred",
            title: "Creator Test 03",
            dueAt: "2026-05-07T06:00:00.000Z",
            detail: "let_cook_24h",
          },
        ],
      },
    },
    decisionReadModel:
      state.decisionReadModel ?? emptyCanonicalDecisionReadModel(),
  };
}

function emptyCanonicalSection(key: string): any {
  return {
    key,
    label: key,
    topN: 5,
    preCapCount: 0,
    selectedCount: 0,
    rankablePreCapCount: 0,
    unrankablePreCapCount: 0,
    items: [],
    exposureDigest: {
      basis: "pre_cap",
      byCurrency: [],
      unavailableCount: 0,
      crossCurrencyTotal: null,
    },
    suppressionReceipt: {
      receiptId: `receipt_${key}`,
      selectionVersion: "meta-decisions-section-selection.v1",
      topN: 5,
      preCapCount: 0,
      selectedCount: 0,
      suppressedCount: 0,
      reasons: [],
    },
  };
}

function emptyCanonicalDecisionReadModel(): any {
  return {
    contractVersion: "meta-decisions-workspace.read.v1",
    status: "available",
    generatedAt: "2026-07-10T12:00:00.000Z",
    scope: {
      businessId: "biz_1",
      providerAccountId: "act_1",
      decisionMode: "current",
      metricsRangeAffectsDecisionSnapshot: false,
    },
    unavailable: null,
    source: {
      status: "available",
      table: "engine_v3_decision_snapshots_daily",
      snapshotAsOf: "2026-05-07",
      computedAt: "2026-05-07T06:00:00.000Z",
      engineVersion: "v3-test",
    },
    queue: {
      deduplicationGrain: "creative",
      sourcePreCapCount: 0,
      queuedPreCapCount: 0,
      sections: {
        integrity_fires: emptyCanonicalSection("integrity_fires"),
        money_moves: emptyCanonicalSection("money_moves"),
        creative_rotation: emptyCanonicalSection("creative_rotation"),
      },
      omittedFromQueue: { count: 0, reasons: [] },
    },
    capabilities: {},
  };
}

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: state.routerPush, replace: state.routerReplace }),
  useSearchParams: () => new URLSearchParams(state.search),
}));

vi.mock("@/store/app-store", () => ({
  useAppStore: (selector: (input: unknown) => unknown) =>
    selector({
      businesses: state.storeBusinesses,
      selectBusiness: state.selectBusiness,
    }),
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useQuery: (input: { queryKey: unknown[] }) => {
    state.queryKeys.push(input.queryKey);
    const key = String(input.queryKey[0]);
    const override = state.queryOverrides[key];
    if (key === "meta-decisions-workspace")
      return queryState(workspacePayload(), override);
    if (key === "meta-provider-accounts")
      return queryState(state.providerAccounts, override);
    if (key === "meta-anomalies") {
      return queryState(
        { anomalies: [metaAnomaly()], snapshotDate: "2026-05-07", count: 1 },
        override,
      );
    }
    if (key === "meta-campaigns-for-labels")
      return queryState({ rows: state.labelCampaigns }, override);
    if (key === "meta-campaign-labels")
      return queryState({ labels: state.campaignLabels }, override);
    if (key === "triage-state")
      return queryState({ rows: [], deferredCount: 0 }, override);
    return queryState(null, override);
  },
}));

function countText(html: string, text: string) {
  return html.split(text).length - 1;
}

function sectionHtml(html: string, id: string, nextId: string) {
  const start = html.indexOf(`id="${id}"`);
  const end = html.indexOf(`id="${nextId}"`);
  return html.slice(start, end === -1 ? undefined : end);
}

describe("MetaPlatformPage", () => {
  beforeEach(() => {
    state.queryKeys = [];
    state.lanePayload = null;
    state.pulsePayload = null;
    state.labelCampaigns = [];
    state.campaignLabels = [];
    state.search = "window=28d";
    state.storeBusinesses = [];
    state.workspaceBanners = [];
    state.workspaceViewer = null;
    state.providerAccounts = [
      {
        id: "act_1",
        name: "Main Meta",
        currency: "USD",
        timezone: "Europe/Istanbul",
      },
    ];
    state.decisionReadModel = null;
    state.queryOverrides = {};
    state.selectBusiness.mockClear();
    state.routerPush.mockClear();
    state.routerReplace.mockClear();
  });

  it("keeps a 300-row Monitor lane within the 48-row DOM window", () => {
    const rows = Array.from({ length: 300 }, (_, index) => index + 1);

    expect(META_MONITOR_PAGE_SIZE).toBe(48);
    expect(paginateMetaMonitorRows(rows, 1)).toEqual(rows.slice(0, 48));
    expect(paginateMetaMonitorRows(rows, 7)).toEqual(rows.slice(288, 300));
    expect(paginateMetaMonitorRows(rows, 0)).toEqual(rows.slice(0, 48));
  });

  it("renders the Decisions operating surface and permanent Act Now sections", () => {
    const html = renderToStaticMarkup(
      <MetaPlatformPage
        businessId="biz_1"
        businessName="TheSwaf"
        currency="USD"
      />,
    );
    expect(html).toContain("Meta operating system");
    expect(html).toContain("<h1>Decisions</h1>");
    expect(html).toContain("Policy delivery block");
    expect(html).toContain("Act Now");
    expect(html).toContain("Monitor");
    expect(html).toContain("History");
    // Fixture endDate is historical, so the honest label names the day.
    expect(html).toContain("Spend · 2026-05-07");
    expect(html).toContain("avg $350.00/day");
    expect(html).toContain("+15%");
    expect(html).toContain('data-testid="meta-business-strip"');
    expect(html).toContain('data-testid="meta-overnight-digest"');
    expect(html).toContain("Since last snapshot");
    expect(html).toContain("2 label flips (2 published)");
    expect(html).toContain("1 action verified");
    expect(html).toContain(">Scope</button>");
    expect(html).not.toContain('data-testid="meta-scope-rail"');
    expect(html).toContain('data-testid="meta-decision-board"');
    expect(html).toContain("Integrity fires");
    expect(html).toContain("Money moves");
    expect(html).toContain("Creative rotation");
    expect(html).toContain("Run snapshot");
    expect(html).toContain('data-testid="meta-mobile-decisions"');
    expect(html).toContain("TheSwaf · Act now 2");
    expect(html).toContain("Policy delivery block");
    expect(html).toContain("ASC Prospecting");
    expect(html).toContain("Writes are desktop-only");
    expect(html).not.toContain("Mobile diagnostic summary unavailable");
    expect(state.queryKeys).toContainEqual([
      "meta-decisions-workspace",
      "biz_1",
      "act_1",
      "28d",
      "active",
      expect.any(String),
      expect.any(String),
    ]);
    expect(state.queryKeys.map((key) => key[0])).not.toContain(
      "meta-account-pulse",
    );
    expect(state.queryKeys.map((key) => key[0])).not.toContain("meta-lanes");
  });

  it("renders creative rotation only from the server-selected canonical section", () => {
    const model = emptyCanonicalDecisionReadModel();
    model.queue.sections.creative_rotation = {
      ...emptyCanonicalSection("creative_rotation"),
      preCapCount: 8,
      selectedCount: 1,
      rankablePreCapCount: 7,
      unrankablePreCapCount: 1,
      items: [
        {
          decisionId: "mdd_1",
          episodeId: "mde_1",
          episodeStartedAt: "2026-07-08",
          providerAccountId: "act_1",
          identityGrain: "creative",
          sourceSnapshotId: "snapshot_1",
          sourceDecision: {
            label: "scale",
            rawLabel: "scale",
            reason: "Fresh commercial truth supports the call.",
            confidence: 87,
            confidenceBand: "high",
            truthSource: "commercial_truth",
            engineVersion: "v3-test",
            snapshotAsOf: "2026-07-10",
            computedAt: "2026-07-10T05:00:00.000Z",
            badges: [],
            provenance: {},
          },
          parentChain: {
            account: { id: "act_1", name: "Main Meta" },
            campaign: { id: "cmp_1", name: "Prospecting" },
            adset: { id: "adset_1", name: "Broad" },
            ad: { id: "ad_1", name: "UGC 1" },
            creative: { id: "creative_1", name: "Hook Variant A" },
            provenance: {},
          },
          media: {
            state: "missing",
            missingMedia: true,
            thumbnail: { state: "missing", url: null },
            provenance: {},
          },
          classification: {
            overlayVersion: "meta-decisions-classification-overlay.v2",
            queueSection: "creative_rotation",
            lifecycleRole: { value: "test" },
            assessment: { value: "proven_winner" },
            buyerAction: "scale",
            buyerLabel: "Scale",
            executionAction: "promote_to_main",
            blockers: [],
            provenance: {},
          },
          riskTier: null,
          confirmationCeremony: "highest",
          riskTierProvenance: {},
          promotionBasis: {},
          metrics: {
            spend: 250,
            purchases: 6,
            roas: 3.2,
            recent7dRoas: 3.4,
            effectiveTargetRoas: 2.4,
            ratioToTarget: 1.33,
            currency: "USD",
            attribution: "meta_attributed",
            provenance: {},
          },
          exposure: null,
          exposureUnavailableReason: null,
          history: {
            responses: { status: "unavailable" },
            providerWrites: { status: "unavailable" },
          },
        },
      ],
      suppressionReceipt: {
        ...emptyCanonicalSection("creative_rotation").suppressionReceipt,
        preCapCount: 8,
        selectedCount: 1,
        suppressedCount: 7,
      },
    };
    state.decisionReadModel = model;

    const html = renderToStaticMarkup(
      <MetaPlatformPage businessId="biz_1" businessName="TheSwaf" />,
    );
    expect(html).toContain("Hook Variant A");
    expect(html).toContain("Scale · Promote To Main");
    expect(html).toContain("high confidence");
    expect(html).toContain("Server selected 1 of 8");
    expect(html).not.toContain("87% confidence");
    expect(state.queryKeys.map((key) => key[0])).not.toContain(
      "meta-decisions-creative-engine",
    );
  });

  it("withholds Decisions until a provider account is explicit when multiple are assigned", () => {
    state.providerAccounts = [
      { id: "act_1", name: "US", currency: "USD", timezone: "UTC" },
      { id: "act_2", name: "EU", currency: "EUR", timezone: "UTC" },
    ];

    const unscoped = renderToStaticMarkup(
      <MetaPlatformPage businessId="biz_1" businessName="TheSwaf" />,
    );
    expect(unscoped).toContain('data-testid="meta-account-required"');
    expect(unscoped).toContain("Decisions stay withheld");

    state.search = "window=28d&providerAccountId=act_2";
    renderToStaticMarkup(
      <MetaPlatformPage businessId="biz_1" businessName="TheSwaf" />,
    );
    expect(state.queryKeys).toContainEqual([
      "meta-decisions-workspace",
      "biz_1",
      "act_2",
      "28d",
      "active",
      expect.any(String),
      expect.any(String),
    ]);
  });

  it("withholds false summary zeros while the pulse and lane briefing are loading", () => {
    state.queryOverrides = {
      "meta-decisions-workspace": { data: undefined, isLoading: true },
      "meta-anomalies": { data: undefined, isLoading: true },
    };

    const html = renderToStaticMarkup(
      <MetaPlatformPage
        businessId="biz_1"
        businessName="TheSwaf"
        currency="USD"
      />,
    );

    expect(html).toContain('data-testid="meta-pulse-loading"');
    expect(html).toContain("briefing loading");
    expect(html).toContain("Loading the latest persisted decision snapshot");
    expect(html).toContain("<b>—</b>");
    expect(html).not.toContain("Snapshot missing");
    expect(html).not.toContain("sync unknown snapshot — engine");
  });

  it("surfaces workspace query errors before rendering briefing summaries", () => {
    state.queryOverrides = {
      "meta-decisions-workspace": {
        data: undefined,
        error: new Error("workspace request failed"),
      },
    };

    const html = renderToStaticMarkup(
      <MetaPlatformPage
        businessId="biz_1"
        businessName="TheSwaf"
        currency="USD"
      />,
    );

    expect(html).toContain('data-testid="meta-briefing-error"');
    expect(html).toContain('data-testid="meta-pulse-error"');
    expect(html).toContain("briefing unavailable");
    expect(html).toContain("workspace request failed");
    expect(html).toContain("<b>—</b>");
    expect(html).not.toContain("queue reflects");
  });

  it("surfaces anomaly query errors without hiding a healthy pulse and lane briefing", () => {
    state.queryOverrides = {
      "meta-anomalies": {
        data: undefined,
        error: new Error("anomaly scan failed"),
      },
    };

    const html = renderToStaticMarkup(
      <MetaPlatformPage
        businessId="biz_1"
        businessName="TheSwaf"
        currency="USD"
      />,
    );

    expect(html).toContain("Snapshot 2026-05-07");
    expect(html).toContain("Spend · 2026-05-07");
    expect(html).toContain("anomaly scan failed");
    expect(html).not.toContain('data-testid="meta-briefing-error"');
    expect(html).not.toContain('data-testid="meta-pulse-error"');
    expect(html).not.toContain("briefing unavailable");
    expect(html).not.toContain("act —");
  });

  it("renders server-owned action authority, automation tier, and evidence affordance on decision rows", () => {
    state.lanePayload = metaLanePayload({
      actionNow: [
        metaRec({
          id: "rec_pause",
          level: "adset",
          adsetId: "adset_1",
          adsetName: "Cold Prospecting - Broad",
          type: "adset_cut_spend",
          actionKind: "execute_pause",
          primaryActionLabel: "Pause adset",
          automationReadiness: {
            contractVersion: "meta-automation-readiness.v1",
            tier: "manual_review",
            autoExecuteEligible: false,
            operatorReviewRequired: true,
            decisionLabel: "cut",
            blockers: ["missing_live_preflight"],
            missingEvidence: ["live_preflight"],
            requiredEvidence: ["commercial_anchor", "live_preflight"],
            reason: "Live preflight is required before execution.",
          },
          evidenceTrail: {
            roas_history: [0.8, 0.7, 0.6],
            peer_comparison: { p10: 0.5, p50: 1.2, p90: 2.2, this_value: 0.6 },
            regime_stability: 0.7,
            age_days: 9,
            recent_changes: [],
          },
        }),
      ],
      watching: [],
      counts: {
        actionNow: 1,
        watching: 0,
        healthy: 1,
        nonSales: 0,
        archive: 0,
      },
    });

    const html = renderToStaticMarkup(
      <MetaPlatformPage
        businessId="biz_1"
        businessName="TheSwaf"
        currency="USD"
      />,
    );

    // The board keeps server-owned action authority and a stable spend anchor;
    // opening the card still routes to the evidence drawer.
    expect(html).toContain('data-testid="meta-decision-board"');
    expect(html).toContain('data-card="meta-action"');
    expect(html).toContain('data-layout="board"');
    expect(html).toContain('data-action-authority="execute"');
    expect(html).toContain('data-action-kind="execute_pause"');
    expect(html).toContain('data-spend-anchor="true"');
    expect(html).toContain("Pause adset");
    expect(html).toContain("Cold Prospecting - Broad");
  });

  it("exposes automatic context exceptions without rendering the correction manager inline", () => {
    state.pulsePayload = metaPulse({
      labelCoverage: {
        activeCampaigns: 2,
        labeledCampaigns: 1,
        unlabeledCampaigns: 1,
        latestUpdatedAt: "2026-05-15T10:00:00.000Z",
      },
    });
    state.labelCampaigns = [
      {
        id: "cmp_main",
        accountId: "act_1",
        name: "Main ASC",
        status: "ACTIVE",
        spend: 1200,
        roas: 3.1,
      },
      {
        id: "cmp_test",
        accountId: "act_1",
        name: "Creative Test",
        status: "ACTIVE",
        spend: 240,
        roas: 1.4,
      },
    ];
    state.campaignLabels = [
      {
        businessId: "biz_1",
        campaignId: "cmp_main",
        kind: "main",
        testDimension: null,
        source: "user",
        providerAccountId: "act_1",
        campaignName: "Main ASC",
        labeledBy: "user_1",
        labeledAt: "2026-05-15T10:00:00.000Z",
        updatedAt: "2026-05-15T10:00:00.000Z",
      },
    ];

    const html = renderToStaticMarkup(
      <MetaPlatformPage
        businessId="biz_1"
        businessName="TheSwaf"
        currency="USD"
      />,
    );

    expect(html).toContain("Review exceptions");
    expect(html).toContain('aria-label="Review campaign context exceptions"');
    expect(html).not.toContain('href="#campaign-labels"');
    expect(html).not.toContain("data-meta-campaign-labels-section");
    expect(html).not.toContain("data-meta-label-management-modal");
    expect(html).not.toContain("Main ASC");
    expect(html).not.toContain("Creative Test");
    expect(html).toContain("campaign context 1/2");
    expect(state.queryKeys.map((key) => key[0])).not.toContain(
      "meta-campaigns-for-labels",
    );
    expect(state.queryKeys.map((key) => key[0])).not.toContain(
      "meta-campaign-labels",
    );
  });

  it("formats verified ad set pause success without duplicating the action name", () => {
    expect(metaAdsetPauseNotice("PAUSED")).toBe("Ad set paused in Meta.");
    expect(metaAdsetPauseNotice(undefined)).toBe("Ad set paused in Meta.");
    expect(metaAdsetPauseNotice("ACTIVE")).toBe(
      "Ad set pause verified with status ACTIVE.",
    );
    expect(metaAdsetPauseNotice("ACTIVE", true)).toBe(
      "Dry run: ad set would pause.",
    );
  });

  it("keeps apply-bid dry-run feedback distinct from a real write", () => {
    expect(metaBidApplyNotice({ dryRun: true, bidAmountMinor: 2200 })).toEqual({
      tone: "info",
      title: "Dry run: bid cap would apply at $22.",
      detail: "No Meta write was performed; Meta verification completed.",
    });
    expect(metaBidApplyNotice({ bidAmountMinor: 2200 })).toEqual({
      tone: "success",
      title: "Bid cap applied at $22.",
      detail: "Meta verified the ad set bid.",
    });
  });

  it("surfaces kill-switch failures with operator-specific copy", () => {
    expect(
      metaActionFailureMessage(
        {
          error: {
            code: "kill_switch_engaged",
            message: "Meta writes are disabled by kill switch.",
          },
        },
        "Action failed.",
      ),
    ).toBe(
      "Meta writes are temporarily disabled (kill switch). Try again later.",
    );
  });

  it("matches Main/Test/Mixed filters from campaignKind instead of recommendation text", () => {
    expect(campaignKindMatchesMetaLabelFilter("main", "main")).toBe(true);
    expect(campaignKindMatchesMetaLabelFilter("test", "main")).toBe(false);
    expect(campaignKindMatchesMetaLabelFilter("mixed", "mixed")).toBe(true);
    expect(campaignKindMatchesMetaLabelFilter(null, "mixed")).toBe(false);
    expect(campaignKindMatchesMetaLabelFilter(null, "main")).toBe(false);
  });

  it("renders persisted acted ad set recommendations as resumable decision cards", () => {
    state.lanePayload = metaLanePayload({
      actionNow: [
        metaRec({
          id: "rec_acted",
          level: "adset",
          adsetId: "adset_1",
          adsetName: "Paused Adset",
          type: "adset_cut_spend",
          operatorResponseState: "acted",
        }),
      ],
      watching: [],
      counts: {
        actionNow: 1,
        watching: 0,
        healthy: 1,
        nonSales: 0,
        archive: 0,
      },
    });

    const html = renderToStaticMarkup(
      <MetaPlatformPage
        businessId="biz_1"
        businessName="TheSwaf"
        currency="USD"
      />,
    );

    expect(html).toContain('data-testid="meta-decision-board"');
    expect(html).toContain('data-card="meta-action"');
    expect(html).toContain("Paused Adset");
    expect(html).toContain('data-operator-response="acted"');
    expect(html).toContain("Resume adset");
  });

  it("threads the selected status filter into the Decisions workspace query", () => {
    state.search = "window=28d&status_filter=all";

    const html = renderToStaticMarkup(
      <MetaPlatformPage
        businessId="biz_1"
        businessName="TheSwaf"
        currency="USD"
      />,
    );

    expect(html).toContain('data-status-filter-option="all"');
    expect(state.queryKeys).toContainEqual([
      "meta-decisions-workspace",
      "biz_1",
      "act_1",
      "28d",
      "all",
      expect.any(String),
      expect.any(String),
    ]);
  });

  it("uses endpoint-provided selected ROAS for custom ranges", () => {
    state.search = "window=custom&startDate=2026-05-01&endDate=2026-05-07";
    state.pulsePayload = metaPulse({
      window: "custom",
      startDate: "2026-05-01",
      endDate: "2026-05-07",
      roas: {
        selected: 4.2,
        d7: 1.4,
        d14: 1.2,
        d28: 1.1,
        target: 2.5,
        median: 2.1,
        target_source: "commercial_truth",
      },
    });

    const html = renderToStaticMarkup(
      <MetaPlatformPage
        businessId="biz_1"
        businessName="TheSwaf"
        currency="USD"
      />,
    );

    expect(html).toContain("ROAS · custom");
    expect(html).toContain("4.20×");
    expect(html).not.toContain("1.10×");
    expect(state.queryKeys).toContainEqual([
      "meta-decisions-workspace",
      "biz_1",
      "act_1",
      "custom",
      "active",
      "2026-05-01",
      "2026-05-07",
    ]);
  });

  it("surfaces stale commercial targets with reduced authority", () => {
    state.pulsePayload = metaPulse({
      roas: {
        selected: 3.2,
        d7: 2.8,
        d14: 3,
        d28: 3.2,
        target: 2.5,
        median: 2.1,
        target_source: "commercial_truth_stale",
        targetFreshness: "stale",
        targetUpdatedAt: "2026-01-01T00:00:00.000Z",
      },
      targetAnchor: {
        configured: true,
        source: "configured_targets",
        targetRoas: 2.5,
        breakEvenRoas: 1.7,
        targetCpa: null,
        breakEvenCpa: null,
        freshness: "stale",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    });

    const html = renderToStaticMarkup(
      <MetaPlatformPage businessId="biz_1" businessName="TheSwaf" />,
    );

    expect(html).toContain("Target stale - reduced authority");
    expect(html).toContain("Review target pack");
    expect(html).toContain('data-target-freshness="stale"');
  });

  it("routes closed structures to the additive History surface", () => {
    state.search = "window=28d&lane=archive";
    state.lanePayload = metaLanePayload({
      archive: [
        {
          id: "cmp_paused",
          level: "campaign",
          name: "Paused ASC",
          status: "PAUSED",
          statusLabel: "Paused 12d",
          spend: 640,
          roas: 1.4,
          cpa: 91,
          purchases: 7,
          lastKnownWindow: "28d",
          diagnosticNote: null,
        },
        {
          id: "adset_archived",
          level: "adset",
          name: "Archived Adset",
          campaignId: "cmp_paused",
          campaignName: "Paused ASC",
          status: "ARCHIVED",
          statusLabel: "Archived",
          spend: 0,
          roas: 0,
          cpa: null,
          purchases: 0,
          lastKnownWindow: "28d",
          diagnosticNote: null,
        },
      ],
      counts: {
        actionNow: 1,
        watching: 1,
        healthy: 1,
        nonSales: 0,
        archive: 2,
      },
    });

    const html = renderToStaticMarkup(
      <MetaPlatformPage
        businessId="biz_1"
        businessName="TheSwaf"
        currency="USD"
      />,
    );

    expect(html).toContain("Closed structures now live in History.");
    expect(html).toContain('href="/platforms/meta/history?kind=structures"');
    expect(html).not.toContain("data-meta-archive");
    expect(html).not.toContain('data-quiet-row="archive"');
  });

  it("renders the Out of Sales Scope lane when nonSales entries are present", () => {
    state.search = "window=28d&lane=nonSales";
    state.lanePayload = metaLanePayload({
      nonSales: [
        metaRec({
          id: "rec_upper",
          campaignId: "cmp_upper",
          campaignName: "Video Views",
          title: "Video Views is out of sales scope",
          cohort: "upper_funnel",
        }),
      ],
      counts: {
        actionNow: 1,
        watching: 1,
        healthy: 1,
        nonSales: 1,
        archive: 0,
      },
    });

    const html = renderToStaticMarkup(
      <MetaPlatformPage
        businessId="biz_1"
        businessName="TheSwaf"
        currency="USD"
      />,
    );
    expect(html).toContain("Out of sales scope");
    expect(html).toContain("Video Views");
    expect(html).not.toContain('type="checkbox"');
  });

  it("renders an empty Out of Sales Scope lane with a zero count", () => {
    state.search = "window=28d&lane=nonSales";
    state.lanePayload = metaLanePayload({
      nonSales: [],
      counts: {
        actionNow: 1,
        watching: 1,
        healthy: 1,
        nonSales: 0,
        archive: 0,
      },
    });

    const html = renderToStaticMarkup(
      <MetaPlatformPage
        businessId="biz_1"
        businessName="TheSwaf"
        currency="USD"
      />,
    );
    expect(html).toContain("Out of sales scope · 0");
    expect(html).toContain(
      "No out-of-sales-scope entities match the current filters.",
    );
  });

  it("renders nonSales entries without selection controls", () => {
    state.search = "window=28d&lane=nonSales";
    state.lanePayload = metaLanePayload({
      nonSales: [
        metaRec({
          id: "rec_upper",
          campaignId: "cmp_upper",
          campaignName: "Video Views",
          cohort: "upper_funnel",
        }),
      ],
      counts: {
        actionNow: 1,
        watching: 1,
        healthy: 1,
        nonSales: 1,
        archive: 0,
      },
    });

    const html = renderToStaticMarkup(
      <MetaPlatformPage
        businessId="biz_1"
        businessName="TheSwaf"
        currency="USD"
      />,
    );
    expect(html).toContain('data-card="meta-upper-funnel-informational"');
    expect(html).toContain("Video Views");
    expect(html).not.toContain('type="checkbox"');
  });

  it("renders upper-funnel nonSales entries as informational cards", () => {
    state.search = "window=28d&lane=nonSales";
    state.lanePayload = metaLanePayload({
      nonSales: [
        metaRec({
          id: "rec_upper",
          level: "adset",
          campaignId: "cmp_upper",
          campaignName: "Video Views",
          adsetId: "adset_upper",
          adsetName: "ThruPlay Broad",
          cohort: "upper_funnel",
          targetValue: {
            spend: 84,
            impressions: 1000,
            thruplayActions: 42,
            videoViews3s: 100,
            frequency: 1.7,
          },
        }),
      ],
      counts: {
        actionNow: 1,
        watching: 1,
        healthy: 1,
        nonSales: 1,
        archive: 0,
      },
    });

    const html = renderToStaticMarkup(
      <MetaPlatformPage
        businessId="biz_1"
        businessName="TheSwaf"
        currency="USD"
      />,
    );
    expect(html).toContain("ThruPlay Broad");
    expect(html).toContain('data-card="meta-upper-funnel-informational"');
    expect(html).not.toContain('type="checkbox"');
  });

  it("renders non-upper-funnel nonSales entries as evidence cards", () => {
    state.search = "window=28d&lane=nonSales";
    state.lanePayload = metaLanePayload({
      nonSales: [
        metaRec({
          id: "rec_mid",
          level: "adset",
          campaignId: "cmp_mid",
          campaignName: "ATC",
          adsetId: "adset_mid",
          adsetName: "ATC Broad",
          cohort: "mid_funnel",
        }),
      ],
      counts: {
        actionNow: 1,
        watching: 1,
        healthy: 1,
        nonSales: 1,
        archive: 0,
      },
    });

    const html = renderToStaticMarkup(
      <MetaPlatformPage
        businessId="biz_1"
        businessName="TheSwaf"
        currency="USD"
      />,
    );
    expect(html).toContain('data-card="meta-action"');
    expect(html).toContain('data-layout="board"');
    expect(html).toContain("ATC Broad");
    expect(html).not.toContain('data-card="meta-upper-funnel-informational"');
  });

  it("renders each mixed ad set as its own decision card", () => {
    state.lanePayload = metaLanePayload({
      actionNow: [
        metaRec({
          id: "rec_cut",
          level: "adset",
          campaignId: "cmp_mixed",
          campaignName: "Mixed Campaign",
          adsetId: "adset_cut",
          adsetName: "Weak Adset",
          type: "adset_cut_spend",
          title: "Cut weak adset",
        }),
        metaRec({
          id: "rec_scale",
          level: "adset",
          campaignId: "cmp_mixed",
          campaignName: "Mixed Campaign",
          adsetId: "adset_scale",
          adsetName: "Strong Adset",
          type: "adset_scale_budget",
          title: "Scale strong adset",
        }),
      ],
    });

    const html = renderToStaticMarkup(
      <MetaPlatformPage
        businessId="biz_1"
        businessName="TheSwaf"
        currency="USD"
      />,
    );

    expect(html).toContain('data-testid="meta-decision-board"');
    expect(countText(html, 'data-card="meta-action"')).toBe(2);
    expect(countText(html, 'data-layout="board"')).toBe(2);
    expect(html).toContain("Weak Adset");
    expect(html).toContain("Strong Adset");
    expect(html).not.toContain('data-card="cross-adset-rollup"');
  });

  it("renders healthy campaign and adsets as compact quiet rows", () => {
    state.search = "window=28d&lane=healthy";
    state.lanePayload = metaLanePayload({
      healthy: [
        {
          id: "cmp_parent",
          level: "campaign",
          name: "Parent Campaign",
          spend: 476,
          roas: 1.99,
          cpa: 22,
          status: "ACTIVE",
        },
        {
          id: "adset_child_a",
          level: "adset",
          name: "Bathroom-USA-BC",
          campaignId: "cmp_parent",
          campaignName: "Parent Campaign",
          spend: 188,
          roas: 0.79,
          cpa: 31,
          status: "ACTIVE",
        },
        {
          id: "adset_child_b",
          level: "adset",
          name: "Claude-MAF-G1-LP",
          campaignId: "cmp_parent",
          campaignName: "Parent Campaign",
          spend: 168,
          roas: 0.8,
          cpa: 28,
          status: "ACTIVE",
        },
      ],
      counts: {
        actionNow: 1,
        watching: 1,
        healthy: 3,
        nonSales: 0,
        archive: 0,
      },
    });

    const html = renderToStaticMarkup(
      <MetaPlatformPage
        businessId="biz_1"
        businessName="TheSwaf"
        currency="USD"
      />,
    );

    expect(countText(html, 'data-quiet-row="healthy"')).toBe(3);
    expect(html).toContain(">CMP</span>");
    expect(html).toContain(">SET</span>");
    expect(html).toContain("Parent Campaign");
    expect(html).toContain("Bathroom-USA-BC");
    expect(html).toContain("Claude-MAF-G1-LP");
    expect(countText(html, ">Healthy</span>")).toBe(3);
    expect(html.indexOf("Parent Campaign")).toBeLessThan(
      html.indexOf("Bathroom-USA-BC"),
    );
  });

  it("renders every healthy entity as its own quiet row", () => {
    state.search = "window=28d&lane=healthy";
    state.lanePayload = metaLanePayload({
      healthy: [
        metaHealthy({
          id: "cmp_uniform",
          level: "campaign",
          name: "Uniform Campaign",
          spend: 210,
          customEventType: "PURCHASE",
          bidStrategyType: "cost_cap",
          bidStrategyLabel: "Cost Cap",
          bidValue: 3000,
          bidValueFormat: "currency",
        }),
        metaHealthy({
          id: "adset_uniform_a",
          level: "adset",
          name: "Uniform Adset A",
          campaignId: "cmp_uniform",
          campaignName: "Uniform Campaign",
          spend: 101,
          customEventType: "PURCHASE",
          bidStrategyType: "cost_cap",
          bidStrategyLabel: "Cost Cap",
          bidValue: 3000,
          bidValueFormat: "currency",
        }),
        metaHealthy({
          id: "adset_uniform_b",
          level: "adset",
          name: "Uniform Adset B",
          campaignId: "cmp_uniform",
          campaignName: "Uniform Campaign",
          spend: 102,
          customEventType: "PURCHASE",
          bidStrategyType: "cost_cap",
          bidStrategyLabel: "Cost Cap",
          bidValue: 3000,
          bidValueFormat: "currency",
        }),
      ],
      counts: {
        actionNow: 1,
        watching: 1,
        healthy: 3,
        nonSales: 0,
        archive: 0,
      },
    });

    const html = renderToStaticMarkup(
      <MetaPlatformPage
        businessId="biz_1"
        businessName="TheSwaf"
        currency="USD"
      />,
    );

    expect(countText(html, 'data-quiet-row="healthy"')).toBe(3);
    expect(html).toContain("Uniform Campaign");
    expect(html).toContain("Uniform Adset A");
    expect(html).toContain("Uniform Adset B");
    expect(countText(html, ">Healthy</span>")).toBe(3);
  });

  it("renders each healthy adset of a mixed-optimization campaign as a quiet row", () => {
    state.search = "window=28d&lane=healthy";
    state.lanePayload = metaLanePayload({
      healthy: [
        metaHealthy({
          id: "cmp_mixed_events",
          level: "campaign",
          name: "Mixed Event Campaign",
          customEventType: null,
          isCustomEventTypeMixed: true,
          bidStrategyType: "lowest_cost",
          bidStrategyLabel: "Lowest Cost",
        }),
        metaHealthy({
          id: "adset_purchase",
          level: "adset",
          name: "Purchase Adset",
          campaignId: "cmp_mixed_events",
          campaignName: "Mixed Event Campaign",
          customEventType: "PURCHASE",
          bidStrategyType: "lowest_cost",
          bidStrategyLabel: "Lowest Cost",
        }),
        metaHealthy({
          id: "adset_atc",
          level: "adset",
          name: "ATC Adset",
          campaignId: "cmp_mixed_events",
          campaignName: "Mixed Event Campaign",
          customEventType: "ADD_TO_CART",
          bidStrategyType: "lowest_cost",
          bidStrategyLabel: "Lowest Cost",
        }),
      ],
      counts: {
        actionNow: 1,
        watching: 1,
        healthy: 3,
        nonSales: 0,
        archive: 0,
      },
    });

    const html = renderToStaticMarkup(
      <MetaPlatformPage
        businessId="biz_1"
        businessName="TheSwaf"
        currency="USD"
      />,
    );

    expect(countText(html, 'data-quiet-row="healthy"')).toBe(3);
    expect(html).toContain("Mixed Event Campaign");
    expect(html).toContain("Purchase Adset");
    expect(html).toContain("ATC Adset");
    expect(countText(html, ">Healthy</span>")).toBe(3);
  });

  it("renders each healthy adset of a mixed-bid campaign as a quiet row", () => {
    state.search = "window=28d&lane=healthy";
    state.lanePayload = metaLanePayload({
      healthy: [
        metaHealthy({
          id: "cmp_mixed_bid",
          level: "campaign",
          name: "Mixed Bid Campaign",
          customEventType: "PURCHASE",
          bidStrategyType: null,
          bidStrategyLabel: null,
          isBidStrategyMixed: true,
        }),
        metaHealthy({
          id: "adset_cost_cap",
          level: "adset",
          name: "Cost Cap Adset",
          campaignId: "cmp_mixed_bid",
          campaignName: "Mixed Bid Campaign",
          customEventType: "PURCHASE",
          bidStrategyType: "cost_cap",
          bidStrategyLabel: "Cost Cap",
          bidValue: 3000,
          bidValueFormat: "currency",
        }),
        metaHealthy({
          id: "adset_bid_cap",
          level: "adset",
          name: "Bid Cap Adset",
          campaignId: "cmp_mixed_bid",
          campaignName: "Mixed Bid Campaign",
          customEventType: "PURCHASE",
          bidStrategyType: "bid_cap",
          bidStrategyLabel: "Bid Cap",
          bidValue: 2400,
          bidValueFormat: "currency",
        }),
      ],
      counts: {
        actionNow: 1,
        watching: 1,
        healthy: 3,
        nonSales: 0,
        archive: 0,
      },
    });

    const html = renderToStaticMarkup(
      <MetaPlatformPage
        businessId="biz_1"
        businessName="TheSwaf"
        currency="USD"
      />,
    );

    expect(countText(html, 'data-quiet-row="healthy"')).toBe(3);
    expect(html).toContain("Mixed Bid Campaign");
    expect(html).toContain("Cost Cap Adset");
    expect(html).toContain("Bid Cap Adset");
    expect(countText(html, ">Healthy</span>")).toBe(3);
  });

  it("renders an orphan healthy adset as a quiet row with its campaign as context", () => {
    state.search = "window=28d&lane=healthy";
    state.lanePayload = metaLanePayload({
      healthy: [
        metaHealthy({
          id: "adset_atc_only",
          level: "adset",
          name: "25Video",
          campaignId: "cmp_adtc",
          campaignName: "ADTC",
          spend: 541,
          roas: 0.13,
          customEventType: "ADD_TO_CART",
          bidStrategyType: "lowest_cost",
          bidStrategyLabel: "Lowest Cost",
        }),
      ],
      counts: {
        actionNow: 1,
        watching: 1,
        healthy: 1,
        nonSales: 0,
        archive: 0,
      },
    });

    const html = renderToStaticMarkup(
      <MetaPlatformPage
        businessId="biz_1"
        businessName="IwaStore"
        currency="USD"
      />,
    );

    // No synthetic campaign header: the orphan ad set remains a single row.
    expect(html).not.toContain("data-healthy-synthetic-campaign");
    expect(html).toContain('data-quiet-row="healthy"');
    expect(html).toContain(">SET</span>");
    expect(html).toContain(">25Video<");
    expect(html).toContain("ADTC");
    expect(countText(html, ">Healthy</span>")).toBe(1);
  });
});

describe("header as-of cluster and queue-scope note", () => {
  beforeEach(() => {
    state.lanePayload = null;
    state.pulsePayload = null;
    state.search = "window=28d";
    state.storeBusinesses = [];
  });

  it("surfaces the real synced / snapshot / engine as-of from the payloads", () => {
    state.pulsePayload = metaPulse({ lastSyncAt: "2020-01-01T00:00:00.000Z" });

    const html = renderToStaticMarkup(
      <MetaPlatformPage
        businessId="biz_1"
        businessName="TheSwaf"
        currency="USD"
      />,
    );

    expect(html).toContain('data-testid="meta-asof-cluster"');
    expect(html).toContain("synced");
    expect(html).toContain("ago");
    expect(html).toContain("snapshot 2026-05-07");
    expect(html).toContain("engine v3.6.0-meta-taxonomy");
    expect(html).toContain("03:00 UTC");
  });

  it("renders sync unknown when ingest freshness is absent, never a fabricated time", () => {
    const html = renderToStaticMarkup(
      <MetaPlatformPage
        businessId="biz_1"
        businessName="TheSwaf"
        currency="USD"
      />,
    );

    expect(html).toContain("sync unknown");
  });

  it("pins the queue to the served snapshot date, scoping metrics not decisions", () => {
    const html = renderToStaticMarkup(
      <MetaPlatformPage
        businessId="biz_1"
        businessName="TheSwaf"
        currency="USD"
      />,
    );

    expect(html).toContain('data-testid="meta-queue-scope-note"');
    expect(html).toContain("Snapshot 2026-05-07");
    expect(html).toContain("2026-05-07");
    expect(html).toContain("date range scopes metrics, not decisions");
  });
});

describe("decision row sort and search", () => {
  it("renders the sort control and free-text search over the lanes", () => {
    const html = renderToStaticMarkup(
      <MetaPlatformPage
        businessId="biz_1"
        businessName="TheSwaf"
        currency="USD"
      />,
    );
    expect(html).toContain('data-testid="meta-row-sort"');
    expect(html).toContain('data-testid="meta-row-search"');
    expect(html).toContain('data-spend-anchor="true"');
  });

  it("sorts by money at stake and keeps missing-metric rows last", () => {
    const rows = [
      metaRec({ id: "a", metrics: { spend: 100 } }),
      metaRec({ id: "b", metrics: null }),
      metaRec({ id: "c", metrics: { spend: 900 } }),
      metaRec({ id: "d", metrics: { spend: 400 } }),
    ];
    const ids = sortMetaRecs(rows, "money").map((rec) => rec.id);
    expect(ids).toEqual(["c", "d", "a", "b"]);
  });

  it("sorts by priority with unknown priority last and stable ties", () => {
    const rows = [
      metaRec({ id: "lo", priority: "low" }),
      metaRec({ id: "hi1", priority: "high" }),
      metaRec({ id: "mid", priority: "medium" }),
      metaRec({ id: "hi2", priority: "high" }),
    ];
    expect(sortMetaRecs(rows, "priority").map((rec) => rec.id)).toEqual([
      "hi1",
      "hi2",
      "mid",
      "lo",
    ]);
  });

  it("matches search across entity name, campaign, and decision label", () => {
    const rec = metaRec({
      campaignName: "Prospecting ASC",
      adsetName: "Broad EU",
      decisionLabel: "cut",
    });
    expect(metaRecSearchMatch(rec, "")).toBe(true);
    expect(metaRecSearchMatch(rec, "broad")).toBe(true);
    expect(metaRecSearchMatch(rec, "CUT")).toBe(true);
    expect(metaRecSearchMatch(rec, "nonsense-token")).toBe(false);
  });
});

describe("tracking write gate (regression: dismissal must not unlock writes)", () => {
  it("blocks on server verdict and takes no dismissal input at all", () => {
    expect(
      isTrackingWriteBlocked({
        trackingAnomalyActive: true,
        trackingHealth: { status: "healthy", detail: "" },
      }),
    ).toBe(true);
    expect(
      isTrackingWriteBlocked({
        trackingAnomalyActive: undefined as never,
        trackingHealth: { status: "blocked", detail: "" },
      }),
    ).toBe(true);
    expect(
      isTrackingWriteBlocked({
        trackingAnomalyActive: false,
        trackingHealth: { status: "blocked", detail: "" },
      }),
    ).toBe(false);
    expect(isTrackingWriteBlocked(null)).toBe(false);
    // Signature-level proof: the gate accepts only the server payload -
    // client dismissal state cannot influence it.
    expect(isTrackingWriteBlocked.length).toBe(1);
  });
});

describe("compare math uses structured metrics, never display strings", () => {
  it("keeps numbers identical when formatted evidence strings change arbitrarily", () => {
    const base = metaRec({
      metrics: {
        spend: 812.5,
        roas: 2.4,
        cpa: 18,
        ctr: 1.3,
        purchases: 44,
        frequency: 2.1,
      },
      evidence: [
        { label: "Spend", value: "$812.50", tone: "neutral" },
        { label: "ROAS", value: "2.40x", tone: "positive" },
      ],
    });
    const reformatted = metaRec({
      metrics: {
        spend: 812.5,
        roas: 2.4,
        cpa: 18,
        ctr: 1.3,
        purchases: 44,
        frequency: 2.1,
      },
      evidence: [
        { label: "Spend", value: "₺99.999,99 !!", tone: "neutral" },
        { label: "ROAS", value: "banded 0.70x-0.83x", tone: "warning" },
      ],
    });
    const left = compareItemForRec(base);
    const right = compareItemForRec(reformatted);
    expect(right.spend).toBe(left.spend);
    expect(right.roas).toBe(left.roas);
    expect(right.cpa).toBe(left.cpa);
    expect(right.purchases).toBe(left.purchases);
  });

  it("excludes metric-less recs from numeric math instead of guessing zero", () => {
    const item = compareItemForRec(
      metaRec({
        metrics: null,
        evidenceTrail: undefined,
        evidence: [{ label: "Spend", value: "$9,999.00", tone: "neutral" }],
      }),
    );
    expect(item.spend).toBeUndefined();
    // roas comes only from the TYPED evidence trail (peer comparison) or
    // structured metrics - never from display strings.
    expect(item.roas).toBeUndefined();
  });
});

describe("data readiness banner", () => {
  it("surfaces not-ready data instead of silent zeros", () => {
    state.pulsePayload = metaPulse({
      dataReadiness: {
        status: "no_accounts_assigned",
        isPartial: false,
        notReadyReason: "No Meta ad account is assigned to this workspace.",
        evidenceSource: "unknown",
      },
    });
    const html = renderToStaticMarkup(
      <MetaPlatformPage
        businessId="biz_1"
        businessName="TheSwaf"
        currency="USD"
      />,
    );
    expect(html).toContain("Data is not fully ready.");
    expect(html).toContain("No Meta ad account is assigned");
  });
});

describe("workspace posture banners", () => {
  it("renders server posture banners in reference priority without implying dismissed tracking unlocks writes", () => {
    state.workspaceBanners = [
      {
        id: "tracking_write_gate",
        tone: "warning",
        title: "Tracking degraded — purchase signal may be incomplete.",
        detail: "Purchase signal is incomplete.",
        blocking: true,
      },
      {
        id: "meta_write_kill_switch",
        tone: "danger",
        title: "Kill switch engaged.",
        detail:
          "All active Meta write endpoints are blocked by META_ADS_WRITE_KILL_SWITCH.",
        blocking: true,
      },
    ];

    const html = renderToStaticMarkup(
      <MetaPlatformPage
        businessId="biz_1"
        businessName="TheSwaf"
        currency="USD"
      />,
    );

    expect(html).toContain('data-testid="meta-posture-banners"');
    expect(html).toContain('data-banner-id="meta_write_kill_switch"');
    expect(html).toContain('data-banner-id="tracking_write_gate"');
    expect(html.indexOf("Kill switch engaged.")).toBeLessThan(
      html.indexOf("Tracking degraded"),
    );
    expect(html).toContain('href="/platforms/meta/automation"');
    expect(html).toContain("System Status");
    expect(html).toContain("Hiding this banner does not unlock writes");
  });

  it("downgrades write controls to evidence review when the server marks the viewer read-only", () => {
    state.workspaceViewer = {
      role: "collaborator",
      isReviewer: true,
      readOnly: true,
      readOnlyReason:
        "You have read-only access: all evidence is visible, write controls are downgraded to review.",
    };
    state.workspaceBanners = [
      {
        id: "reviewer_read_only",
        tone: "info",
        title: "Reviewer access is read-only.",
        detail:
          "You have read-only access: all evidence is visible, write controls are downgraded to review.",
        blocking: false,
      },
    ];
    state.lanePayload = metaLanePayload({
      actionNow: [
        metaRec({
          id: "pause-rec",
          actionKind: "execute_pause",
          type: "adset_cut_spend",
          adsetId: "as_1",
          operatorResponseState: "deferred",
        }),
      ],
      watching: [],
      healthy: [],
      nonSales: [],
      archive: [],
      counts: {
        actionNow: 1,
        watching: 0,
        healthy: 0,
        nonSales: 0,
        archive: 0,
      },
    });

    const html = renderToStaticMarkup(<MetaPlatformPage businessId="biz_1" />);

    expect(html).toContain('data-banner-id="reviewer_read_only"');
    expect(html).toContain("Reviewer access is read-only.");
    expect(html).toContain('data-testid="meta-decision-board"');
    expect(html).toContain('data-action-authority="review"');
    expect(html).toContain('data-read-only-action="true"');
    expect(html).toContain("Review evidence");
    expect(html).not.toContain('data-action-authority="execute"');
    expect(html).toContain("Snapshot read-only");
    expect(html).not.toContain(">Run snapshot<");
    expect(html).not.toContain('data-action="undefer"');
    expect(html).not.toContain(">Pause weakest<");
  });
});

describe("tracking confirm label follows the server actionKind", () => {
  it("never shows Rebuild anyway for an apply-bid action", () => {
    const bidRec = metaRec({
      type: "bid_value_guidance",
      level: "adset",
      proposedAction: { kind: "apply_bid", bidAmountMinor: 500 },
    });
    expect(bidRec.actionKind).toBe("execute_bid");
    expect(trackingConfirmLabelForRec(bidRec)).toBe("Apply bid anyway");
    expect(trackingConfirmLabelForRec(bidRec)).not.toBe("Rebuild anyway");
  });

  it("maps every gated action to copy naming what confirming does", () => {
    expect(
      trackingConfirmLabelForRec(metaRec({ type: "adset_cut_spend" })),
    ).toBe("Pause anyway");
    expect(
      trackingConfirmLabelForRec(metaRec({ type: "rebuild_with_constraints" })),
    ).toBe("Rebuild anyway");
    expect(trackingConfirmLabelForRec(null)).toBe("Continue anyway");
  });
});
