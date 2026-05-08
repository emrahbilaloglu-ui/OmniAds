import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MetaHealthyRow } from "@/components/meta/redesign/MetaHealthyRow";
import { metaHealthy } from "@/components/meta/redesign/test-fixtures";

describe("MetaHealthyRow", () => {
  it("renders compact stable entity metrics", () => {
    const html = renderToStaticMarkup(
      <MetaHealthyRow
        row={metaHealthy({
          optimizationGoal: "Purchase",
          bidStrategyLabel: "Cost Cap",
          bidValue: 1200,
          bidValueFormat: "currency",
          previousBidValue: 1000,
          previousBidValueFormat: "currency",
          previousBidValueCapturedAt: "2026-04-01T00:00:00.000Z",
        })}
      />,
    );
    expect(html).toContain("Healthy ASC");
    expect(html).toContain("$820");
    expect(html).toContain("Optimization");
    expect(html).toContain("Purchase");
    expect(html).toContain("Cost Cap");
    expect(html).toContain("$12");
    expect(html).toContain("Prev");
    expect(html).toContain("$10");
    expect(html).toContain("changed Apr 1, 2026");
  });

  it("marks nested adset rows for campaign hierarchy", () => {
    const html = renderToStaticMarkup(
      <MetaHealthyRow
        row={metaHealthy({
          id: "adset_1",
          level: "adset",
          name: "Healthy Broad",
          campaignName: "Healthy ASC",
        })}
        depth="child"
        hideCampaignName
      />,
    );

    expect(html).toContain('data-healthy-level="adset"');
    expect(html).toContain('data-healthy-depth="child"');
    expect(html).not.toContain("Healthy ASC");
  });

  it("marks mixed optimization and bid configuration", () => {
    const html = renderToStaticMarkup(
      <MetaHealthyRow
        row={metaHealthy({
          isOptimizationGoalMixed: true,
          isBidStrategyMixed: true,
          isBidValueMixed: true,
        })}
      />,
    );

    expect(html).toContain("Mixed goals");
    expect(html).toContain("Mixed strategies");
    expect(html).toContain("Mixed bids");
  });

  it("falls back to manual bid fields when display bid values are absent", () => {
    const html = renderToStaticMarkup(
      <MetaHealthyRow
        row={metaHealthy({
          optimizationGoal: "LINK_CLICK",
          bidStrategyType: "lowest_cost_without_cap",
          bidValue: null,
          manualBidAmount: 1500,
          previousBidValue: null,
          previousManualBidAmount: 1200,
          previousBidValueCapturedAt: "2026-04-02T00:00:00.000Z",
        })}
      />,
    );

    expect(html).toContain("Link Click");
    expect(html).toContain("Lowest Cost Without Cap");
    expect(html).toContain("$15");
    expect(html).toContain("$12");
    expect(html).toContain("changed Apr 2, 2026");
  });

  it("shows the previous bid change timestamp when the previous value was unset", () => {
    const html = renderToStaticMarkup(
      <MetaHealthyRow
        row={metaHealthy({
          optimizationGoal: "Purchase",
          bidStrategyLabel: "Cost Cap",
          bidValue: 3000,
          bidValueFormat: "currency",
          previousBidValue: null,
          previousManualBidAmount: null,
          previousBidValueCapturedAt: "2026-05-08T04:15:38.152Z",
        })}
      />,
    );

    expect(html).toContain("Prev");
    expect(html).toContain("No bid");
    expect(html).toContain("changed May 8, 2026");
  });
});
