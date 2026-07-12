import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MetaCampaignLabelsSection } from "@/components/meta/redesign/MetaCampaignLabelsSection";

const state = vi.hoisted(() => ({
  queryKeys: [] as unknown[][],
  campaigns: [
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
    {
      id: "cmp_paused",
      accountId: "act_1",
      name: "Paused Campaign",
      status: "PAUSED",
      spend: 100,
      roas: 1,
    },
  ],
  labels: [
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
  ],
}));

function queryState(data: unknown) {
  return {
    data,
    isLoading: false,
    isError: false,
    error: null,
  };
}

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useQuery: (input: { queryKey: unknown[] }) => {
    state.queryKeys.push(input.queryKey);
    const key = String(input.queryKey[0]);
    if (key === "meta-campaigns-for-labels")
      return queryState({ rows: state.campaigns });
    if (key === "meta-campaign-labels")
      return queryState({ labels: state.labels });
    return queryState(null);
  },
}));

describe("MetaCampaignLabelsSection", () => {
  beforeEach(() => {
    state.queryKeys = [];
    state.campaigns = [
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
      {
        id: "cmp_paused",
        accountId: "act_1",
        name: "Paused Campaign",
        status: "PAUSED",
        spend: 100,
        roas: 1,
      },
    ];
  });

  it("renders active campaigns with current label state", () => {
    const html = renderToStaticMarkup(
      <MetaCampaignLabelsSection businessId="biz_1" />,
    );

    expect(html).toContain("data-meta-campaign-labels-section");
    expect(html).toContain("Main ASC");
    expect(html).toContain("Creative Test");
    expect(html).not.toContain("Paused Campaign");
    expect(html).toContain("Context corrections");
    expect(html).toContain("1 unresolved");
    expect(html).toContain('data-campaign-kind="main"');
    expect(html).toContain('data-campaign-kind="unlabeled"');
    expect(state.queryKeys).toContainEqual([
      "meta-campaigns-for-labels",
      "biz_1",
    ]);
  });

  it("still renders recent campaigns when no campaign is active", () => {
    state.campaigns = [
      {
        id: "cmp_paused",
        accountId: "act_1",
        name: "Paused Campaign",
        status: "PAUSED",
        spend: 100,
        roas: 1,
      },
    ];

    const html = renderToStaticMarkup(
      <MetaCampaignLabelsSection businessId="biz_1" />,
    );

    expect(html).toContain("data-meta-campaign-labels-section");
    expect(html).toContain("Paused Campaign");
    expect(html).toContain("No active campaigns were returned");
    expect(html).toContain("1 recent");
    expect(state.queryKeys).toContainEqual([
      "meta-campaign-labels",
      "biz_1",
      "cmp_paused",
    ]);
  });
});
