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
      currency: "TRY",
    },
    {
      id: "cmp_test",
      accountId: "act_1",
      name: "Creative Test",
      status: "ACTIVE",
      spend: 240,
      roas: 1.4,
      currency: "EUR",
    },
    {
      id: "cmp_paused",
      accountId: "act_1",
      name: "Paused Campaign",
      status: "PAUSED",
      spend: 100,
      roas: 1,
      currency: "USD",
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
        currency: "TRY",
      },
      {
        id: "cmp_test",
        accountId: "act_1",
        name: "Creative Test",
        status: "ACTIVE",
        spend: 240,
        roas: 1.4,
        currency: "EUR",
      },
      {
        id: "cmp_paused",
        accountId: "act_1",
        name: "Paused Campaign",
        status: "PAUSED",
        spend: 100,
        roas: 1,
        currency: "USD",
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
    expect(html).toContain("1 automatic");
    expect(html).toContain("₺1.200,00");
    expect(html).toMatch(/240,00(?:\u00a0|&nbsp;)€/);
    expect(html).toContain('data-campaign-kind="main"');
    expect(html).toContain('data-campaign-kind="automatic"');
    /**
     * The account is part of the key now.
     *
     * Both reads were business-scoped only, so on a business with several
     * assigned Meta accounts this section listed every account's campaigns
     * under a Decisions surface that names one — and the cache key could not
     * tell the accounts apart, so switching served the previous account's rows.
     * That is the plan's rollback trigger 3. `null` here is "no single account
     * resolved", which is a distinct cache entry from any real account.
     */
    expect(state.queryKeys).toContainEqual([
      "meta-campaigns-for-labels",
      "biz_1",
      null,
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
        currency: "USD",
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
      null,
      "cmp_paused",
    ]);
  });
});

function renderSection() {
  return renderToStaticMarkup(<MetaCampaignLabelsSection businessId="biz_1" />);
}

describe("the label writer is not offered from Decisions", () => {
  /**
   * §18: "Decisions label writer — Decisions'tan kaldır."
   *
   * A campaign's kind selects the calibration cell the resolver grades against,
   * so editing a label from the Decisions surface changes the baseline the
   * decisions on that same screen were produced under — and the write then
   * invalidates and re-fetches them, so the operator watches the verdicts move
   * because of an input they just changed.
   */
  it("renders every label control disabled, with the reason on it", () => {
    const html = renderSection();

    // Every kind and dimension select on the section, refused — not just the
    // first one. A per-row control that stayed live would be the whole defect.
    const selects = html.match(/<select\b[^>]*>/g) ?? [];
    expect(selects.length).toBeGreaterThan(0);
    for (const select of selects) {
      expect(select, select).toContain("disabled");
      // The reason travels on the control itself, so a pointer user reaches it
      // where the refusal is.
      expect(select, select).toContain("read-only here");
    }

    // Stated, not hidden: a control that vanishes reads as "this product
    // cannot label campaigns", and leaves a campaign_label_missing blocker
    // with no visible way to clear it.
    expect(html).toContain("data-campaign-label-write-notice");
    expect(html).toContain('role="note"');
  });

  it("still shows which campaigns are unlabelled", () => {
    // The coverage READ is decision-relevant (GC-036, GC-042) and stays.
    const html = renderSection();
    expect(html).toContain('data-campaign-kind="automatic"');
    expect(html).toContain("data-meta-campaign-labels-section");
  });
});
