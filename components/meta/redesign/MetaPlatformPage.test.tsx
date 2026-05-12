import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { metaAnomaly, metaHealthy, metaLanePayload, metaPulse, metaRec } from "@/components/meta/redesign/test-fixtures";
import { MetaPlatformPage } from "@/components/meta/redesign/MetaPlatformPage";

const state = vi.hoisted(() => ({
  routerPush: vi.fn(),
  routerReplace: vi.fn(),
  queryKeys: [] as unknown[][],
  lanePayload: null as any,
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
    if (key === "meta-account-pulse") return queryState(metaPulse());
    if (key === "meta-lanes") return queryState(state.lanePayload ?? metaLanePayload());
    if (key === "meta-anomalies") {
      return queryState({ anomalies: [metaAnomaly()], snapshotDate: "2026-05-07", count: 1 });
    }
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
    state.search = "window=28d";
    state.routerPush.mockClear();
    state.routerReplace.mockClear();
  });

  it("renders pulse, alerts strip, lanes, and cards from snapshot payloads", () => {
    const html = renderToStaticMarkup(
      <MetaPlatformPage businessId="biz_1" businessName="TheSwaf" currency="USD" />,
    );
    expect(html).toContain("Meta Decision Center");
    expect(html).toContain("Policy delivery block");
    expect(html).toContain("Action Now");
    expect(html).toContain("Watching");
    expect(html).toContain("Healthy ASC");
    expect(html).toContain('id="non-sales"');
    expect(html).toContain("Out of Sales Scope");
    expect(html).toContain("Archive");
    expect(html).toContain("Audience Builder");
    expect(html).toContain("data-meta-audience-builder");
    expect(state.queryKeys.map((key) => key[0])).toContain("meta-lanes");
    expect(state.queryKeys).toContainEqual(["meta-account-pulse", "biz_1", "28d", "active"]);
    expect(state.queryKeys).toContainEqual(["meta-lanes", "biz_1", "28d", "active"]);
  });

  it("threads the selected status filter into Pulse and lane queries", () => {
    state.search = "window=28d&status_filter=all";

    const html = renderToStaticMarkup(
      <MetaPlatformPage businessId="biz_1" businessName="TheSwaf" currency="USD" />,
    );

    expect(html).toContain('data-status-filter-option="all"');
    expect(state.queryKeys).toContainEqual(["meta-account-pulse", "biz_1", "28d", "all"]);
    expect(state.queryKeys).toContainEqual(["meta-lanes", "biz_1", "28d", "all"]);
  });

  it("renders closed entities in the archive surface without action cards", () => {
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
      ],
      counts: { actionNow: 1, watching: 1, healthy: 1, nonSales: 0, archive: 1 },
    });

    const html = renderToStaticMarkup(
      <MetaPlatformPage businessId="biz_1" businessName="TheSwaf" currency="USD" />,
    );

    expect(html).toContain("data-meta-archive");
    expect(html).toContain("Paused ASC");
    expect(html).toContain("Paused 12d");
    expect(html).toContain("$640");
  });

  it("renders the Out of Sales Scope lane when nonSales entries are present", () => {
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
    const nonSalesSection = sectionHtml(html, "non-sales", "archive");

    expect(nonSalesSection).toContain('id="non-sales"');
    expect(nonSalesSection).toContain("Out of Sales Scope");
    expect(nonSalesSection).toContain("Video Views");
  });

  it("renders an empty Out of Sales Scope lane with a zero count", () => {
    state.lanePayload = metaLanePayload({
      nonSales: [],
      counts: { actionNow: 1, watching: 1, healthy: 1, nonSales: 0, archive: 0 },
    });

    const html = renderToStaticMarkup(
      <MetaPlatformPage businessId="biz_1" businessName="TheSwaf" currency="USD" />,
    );
    const nonSalesSection = sectionHtml(html, "non-sales", "archive");

    expect(nonSalesSection).toContain("Out of Sales Scope");
    expect(nonSalesSection).toContain(">0</span>");
    expect(nonSalesSection).toContain("No non-purchase entities in the current window.");
  });

  it("renders the cohort chip inside the Out of Sales Scope lane", () => {
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
    const nonSalesSection = sectionHtml(html, "non-sales", "archive");

    expect(nonSalesSection).toContain('data-cohort-chip="upper_funnel"');
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
