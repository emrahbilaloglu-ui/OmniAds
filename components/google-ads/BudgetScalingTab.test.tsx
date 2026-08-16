import React from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { BudgetScalingTab } from "@/components/google-ads/BudgetScalingTab";

describe("BudgetScalingTab", () => {
  it("uses row-backed weighted ROAS when a stale summary reports zero", () => {
    const markup = renderToStaticMarkup(
      React.createElement(BudgetScalingTab, {
        isLoading: false,
        accountAvgRoas: 0,
        totalSpend: 100,
        recommendations: [],
        campaigns: [
          {
            id: "campaign-1",
            name: "Campaign 1",
            dailyBudget: 20,
            spend: 100,
            conversions: 4,
            revenue: 250,
            roas: 2.5,
            cpa: 25,
            impressions: 1000,
            clicks: 100,
            impressionShare: null,
            lostIsBudget: null,
          },
        ],
      }),
    );

    expect(markup).toContain("2.50x");
    expect(markup).not.toContain("0.00x");
  });
});
