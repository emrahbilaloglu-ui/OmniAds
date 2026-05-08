import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { metaAnomaly, metaLanePayload, metaPulse, metaRec } from "@/components/meta/redesign/test-fixtures";
import { MetaPlatformPage } from "@/components/meta/redesign/MetaPlatformPage";

const state = vi.hoisted(() => ({
  routerPush: vi.fn(),
  routerReplace: vi.fn(),
  queryKeys: [] as unknown[][],
  lanePayload: null as any,
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
  useSearchParams: () => new URLSearchParams("window=28d"),
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

describe("MetaPlatformPage", () => {
  beforeEach(() => {
    state.queryKeys = [];
    state.lanePayload = null;
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
    expect(html).toContain("Audience Builder");
    expect(html).toContain("data-meta-audience-builder");
    expect(state.queryKeys.map((key) => key[0])).toContain("meta-lanes");
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
      counts: { actionNow: 1, watching: 1, healthy: 3 },
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
});
