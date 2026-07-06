import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { metaAnomaly, metaHealthy, metaLanePayload, metaPulse, metaRec } from "@/components/meta/redesign/test-fixtures";
import {
  MetaPlatformPage,
  campaignKindMatchesMetaLabelFilter,
  metaActionFailureMessage,
  metaAdsetPauseNotice,
  metaBidApplyNotice,
  isTrackingWriteBlocked,
  compareItemForRec,
  trackingConfirmLabelForRec,
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
}));

function queryState(data: unknown) {
  return {
    data,
    isLoading: false,
    isError: false,
    error: null,
  };
}

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: state.routerPush, replace: state.routerReplace }),
  useSearchParams: () => new URLSearchParams(state.search),
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useQuery: (input: { queryKey: unknown[] }) => {
    state.queryKeys.push(input.queryKey);
    const key = String(input.queryKey[0]);
    if (key === "meta-account-pulse") return queryState(state.pulsePayload ?? metaPulse());
    if (key === "meta-lanes") return queryState(state.lanePayload ?? metaLanePayload());
    if (key === "meta-anomalies") {
      return queryState({ anomalies: [metaAnomaly()], snapshotDate: "2026-05-07", count: 1 });
    }
    if (key === "meta-campaigns-for-labels") return queryState({ rows: state.labelCampaigns });
    if (key === "meta-campaign-labels") return queryState({ labels: state.campaignLabels });
    if (key === "triage-state") return queryState({ rows: [], deferredCount: 0 });
    return queryState(null);
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
    state.routerPush.mockClear();
    state.routerReplace.mockClear();
  });

  it("renders pulse, alerts strip, lanes, and cards from snapshot payloads", () => {
    const html = renderToStaticMarkup(
      <MetaPlatformPage businessId="biz_1" businessName="TheSwaf" currency="USD" />,
    );
    expect(html).toContain("Meta · Decision Center");
    expect(html).toContain("Policy delivery block");
    expect(html).toContain("Action Now");
    expect(html).toContain("Watching");
    expect(html).toContain("Healthy");
    expect(html).toContain("Non-sales");
    expect(html).toContain("Archive");
    // Fixture endDate is historical, so the honest label names the day.
    expect(html).toContain("Spend · 2026-05-07");
    expect(html).toContain("avg $350/day");
    expect(html).toContain("+15%");
    expect(html).toContain("7d avg 2/day");
    expect(html).toContain("Run snapshot");
    expect(state.queryKeys.map((key) => key[0])).toContain("meta-lanes");
    expect(state.queryKeys).toContainEqual(["meta-account-pulse", "biz_1", "28d", "active", expect.any(String), expect.any(String)]);
    expect(state.queryKeys).toContainEqual(["meta-lanes", "biz_1", "28d", "active", expect.any(String), expect.any(String)]);
  });

  it("exposes campaign label management as a modal trigger without rendering the manager inline", () => {
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
      <MetaPlatformPage businessId="biz_1" businessName="TheSwaf" currency="USD" />,
    );

    expect(html).toContain("Manage labels");
    expect(html).toContain('aria-label="Manage campaign labels"');
    expect(html).not.toContain('href="#campaign-labels"');
    expect(html).not.toContain("data-meta-campaign-labels-section");
    expect(html).not.toContain("data-meta-label-management-modal");
    expect(html).not.toContain("Main ASC");
    expect(html).not.toContain("Creative Test");
    expect(html).toContain("1 unlabeled");
    expect(state.queryKeys.map((key) => key[0])).not.toContain("meta-campaigns-for-labels");
    expect(state.queryKeys.map((key) => key[0])).not.toContain("meta-campaign-labels");
  });

  it("formats verified ad set pause success without duplicating the action name", () => {
    expect(metaAdsetPauseNotice("PAUSED")).toBe("Ad set paused in Meta.");
    expect(metaAdsetPauseNotice(undefined)).toBe("Ad set paused in Meta.");
    expect(metaAdsetPauseNotice("ACTIVE")).toBe("Ad set pause verified with status ACTIVE.");
    expect(metaAdsetPauseNotice("ACTIVE", true)).toBe("Dry run: ad set would pause.");
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
    ).toBe("Meta writes are temporarily disabled (kill switch). Try again later.");
  });

  it("matches Main/Test/Mixed filters from campaignKind instead of recommendation text", () => {
    expect(campaignKindMatchesMetaLabelFilter("main", "main")).toBe(true);
    expect(campaignKindMatchesMetaLabelFilter("test", "main")).toBe(false);
    expect(campaignKindMatchesMetaLabelFilter("mixed", "mixed")).toBe(true);
    expect(campaignKindMatchesMetaLabelFilter(null, "mixed")).toBe(false);
    expect(campaignKindMatchesMetaLabelFilter(null, "main")).toBe(false);
  });

  it("renders persisted acted ad set recommendations with a resume affordance", () => {
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
      counts: { actionNow: 1, watching: 0, healthy: 1, nonSales: 0, archive: 0 },
    });

    const html = renderToStaticMarkup(
      <MetaPlatformPage businessId="biz_1" businessName="TheSwaf" currency="USD" />,
    );

    expect(html).toContain('data-operator-response="acted"');
    expect(html).toContain("Resume adset");
    expect(html).not.toContain('disabled=""');
  });

  it("threads the selected status filter into Pulse and lane queries", () => {
    state.search = "window=28d&status_filter=all";

    const html = renderToStaticMarkup(
      <MetaPlatformPage businessId="biz_1" businessName="TheSwaf" currency="USD" />,
    );

    expect(html).toContain('data-status-filter-option="all"');
    expect(state.queryKeys).toContainEqual(["meta-account-pulse", "biz_1", "28d", "all", expect.any(String), expect.any(String)]);
    expect(state.queryKeys).toContainEqual(["meta-lanes", "biz_1", "28d", "all", expect.any(String), expect.any(String)]);
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
      <MetaPlatformPage businessId="biz_1" businessName="TheSwaf" currency="USD" />,
    );

    expect(html).toContain("ROAS · custom");
    expect(html).toContain("4.20×");
    expect(html).not.toContain("1.10×");
    expect(state.queryKeys).toContainEqual(["meta-account-pulse", "biz_1", "custom", "active", "2026-05-01", "2026-05-07"]);
  });

  it("renders closed entities in the archive surface without action cards", () => {
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
      counts: { actionNow: 1, watching: 1, healthy: 1, nonSales: 0, archive: 2 },
    });

    const html = renderToStaticMarkup(
      <MetaPlatformPage businessId="biz_1" businessName="TheSwaf" currency="USD" />,
    );

    expect(html).toContain("data-meta-archive");
    expect(html).toContain("Paused ASC");
    expect(html).toContain("Paused 12d");
    expect(html).toContain("Resume campaign");
    expect(html).toContain("Archived Adset");
    expect(html).not.toContain("Resume adset");
    expect(html).toContain("$640");
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
      counts: { actionNow: 1, watching: 1, healthy: 1, nonSales: 1, archive: 0 },
    });

    const html = renderToStaticMarkup(
      <MetaPlatformPage businessId="biz_1" businessName="TheSwaf" currency="USD" />,
    );
    expect(html).toContain("Non-sales");
    expect(html).toContain("Video Views");
    expect(html).not.toContain('type="checkbox"');
  });

  it("renders an empty Out of Sales Scope lane with a zero count", () => {
    state.search = "window=28d&lane=nonSales";
    state.lanePayload = metaLanePayload({
      nonSales: [],
      counts: { actionNow: 1, watching: 1, healthy: 1, nonSales: 0, archive: 0 },
    });

    const html = renderToStaticMarkup(
      <MetaPlatformPage businessId="biz_1" businessName="TheSwaf" currency="USD" />,
    );
    expect(html).toContain("Non-sales");
    expect(html).toContain(">0</span>");
    expect(html).toContain("No non-purchase entities in the current window.");
  });

  it("renders the cohort chip inside the Out of Sales Scope lane", () => {
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
      counts: { actionNow: 1, watching: 1, healthy: 1, nonSales: 1, archive: 0 },
    });

    const html = renderToStaticMarkup(
      <MetaPlatformPage businessId="biz_1" businessName="TheSwaf" currency="USD" />,
    );
    expect(html).toContain('data-cohort-chip="upper_funnel"');
  });

  it("renders upper-funnel nonSales entries with the informational card", () => {
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
      counts: { actionNow: 1, watching: 1, healthy: 1, nonSales: 1, archive: 0 },
    });

    const html = renderToStaticMarkup(
      <MetaPlatformPage businessId="biz_1" businessName="TheSwaf" currency="USD" />,
    );
    expect(html).toContain('data-card="meta-upper-funnel-informational"');
  });

  it("keeps non-upper-funnel nonSales entries on MetaActionCard", () => {
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
      counts: { actionNow: 1, watching: 1, healthy: 1, nonSales: 1, archive: 0 },
    });

    const html = renderToStaticMarkup(
      <MetaPlatformPage businessId="biz_1" businessName="TheSwaf" currency="USD" />,
    );
    expect(html).toContain('data-card="meta-action"');
    expect(html).not.toContain('data-card="meta-upper-funnel-informational"');
  });

  it("rolls mixed adset decisions up without duplicating individual cards", () => {
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
      <MetaPlatformPage businessId="biz_1" businessName="TheSwaf" currency="USD" />,
    );

    expect(html).toContain("data-card=\"cross-adset-rollup\"");
    expect(html).toContain("Weak Adset");
    expect(html).toContain("Strong Adset");
    expect(html).not.toContain("Cut weak adset");
    expect(html).not.toContain("Scale strong adset");
  });

  it("nests healthy adsets under their campaign group", () => {
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
      counts: { actionNow: 1, watching: 1, healthy: 3, nonSales: 0, archive: 0 },
    });

    const html = renderToStaticMarkup(
      <MetaPlatformPage businessId="biz_1" businessName="TheSwaf" currency="USD" />,
    );

    expect(html).toContain('data-healthy-campaign-group="cmp_parent"');
    expect(html).toContain('data-healthy-adsets-for-campaign="cmp_parent"');
    expect(html).toContain('data-healthy-row="adset_child_a"');
    expect(html).toContain('data-healthy-depth="child"');
    expect(html.indexOf('data-healthy-row="cmp_parent"')).toBeLessThan(
      html.indexOf('data-healthy-row="adset_child_a"'),
    );
  });

  it("shows uniform optimization and bid strategy only on the campaign row while keeping adset bid values", () => {
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
      counts: { actionNow: 1, watching: 1, healthy: 3, nonSales: 0, archive: 0 },
    });

    const html = renderToStaticMarkup(
      <MetaPlatformPage businessId="biz_1" businessName="TheSwaf" currency="USD" />,
    );

    expect(countText(html, ">Optimization</span>")).toBe(1);
    expect(countText(html, ">Purchase</span>")).toBe(1);
    expect(countText(html, ">Cost Cap</span>")).toBe(1);
    expect(countText(html, ">$30</span>")).toBe(2);
  });

  it("marks mixed optimization at campaign level and shows each adset event", () => {
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
      counts: { actionNow: 1, watching: 1, healthy: 3, nonSales: 0, archive: 0 },
    });

    const html = renderToStaticMarkup(
      <MetaPlatformPage businessId="biz_1" businessName="TheSwaf" currency="USD" />,
    );

    expect(countText(html, ">Optimization</span>")).toBe(3);
    expect(html).toContain(">Mix</span>");
    expect(html).toContain(">Purchase</span>");
    expect(html).toContain(">Add to Cart</span>");
  });

  it("marks mixed bid strategy at campaign level and keeps adset strategy details", () => {
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
      counts: { actionNow: 1, watching: 1, healthy: 3, nonSales: 0, archive: 0 },
    });

    const html = renderToStaticMarkup(
      <MetaPlatformPage businessId="biz_1" businessName="TheSwaf" currency="USD" />,
    );

    expect(countText(html, ">Optimization</span>")).toBe(1);
    expect(html).toContain(">Mix</span>");
    expect(html).toContain(">Cost Cap</span>");
    expect(html).toContain(">Bid Cap</span>");
    expect(html).toContain(">$30</span>");
    expect(html).toContain(">$24</span>");
  });

  it("shows uniform optimization on synthetic campaign headers inferred from adsets", () => {
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
      counts: { actionNow: 1, watching: 1, healthy: 1, nonSales: 0, archive: 0 },
    });

    const html = renderToStaticMarkup(
      <MetaPlatformPage businessId="biz_1" businessName="IwaStore" currency="USD" />,
    );

    expect(html).toContain('data-healthy-synthetic-campaign="cmp_adtc"');
    expect(html).toContain(">ADTC</div>");
    expect(html).toContain(">Add to Cart</span>");
    expect(countText(html, ">Optimization</span>")).toBe(1);
    expect(html).toContain(">Lowest Cost</span>");
    expect(html).toContain(">1 adset</div>");
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
      metrics: { spend: 812.5, roas: 2.4, cpa: 18, ctr: 1.3, purchases: 44, frequency: 2.1 },
      evidence: [
        { label: "Spend", value: "$812.50", tone: "neutral" },
        { label: "ROAS", value: "2.40x", tone: "positive" },
      ],
    });
    const reformatted = metaRec({
      metrics: { spend: 812.5, roas: 2.4, cpa: 18, ctr: 1.3, purchases: 44, frequency: 2.1 },
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
      <MetaPlatformPage businessId="biz_1" businessName="TheSwaf" currency="USD" />,
    );
    expect(html).toContain("Data is not fully ready.");
    expect(html).toContain("No Meta ad account is assigned");
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
