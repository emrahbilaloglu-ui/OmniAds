import React from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  LaunchpadBudget,
  nextLaunchpadBudgetForMode,
} from "@/components/launchpad/LaunchpadBudget";

describe("LaunchpadBudget", () => {
  it("shows campaign budget inputs only for CBO", () => {
    const cboHtml = renderToStaticMarkup(
      <LaunchpadBudget
        value={{
          mode: "CBO",
          schedule: "daily",
          amount: "50",
          bidStrategy: "LOWEST_COST_WITHOUT_CAP",
          bidAmount: "",
        }}
        currency="USD"
        expectedCpa={null}
        onChange={vi.fn()}
      />,
    );
    const aboHtml = renderToStaticMarkup(
      <LaunchpadBudget
        value={{
          mode: "ABO",
          schedule: undefined,
          amount: undefined,
          bidStrategy: undefined,
          bidAmount: undefined,
        }}
        currency="USD"
        expectedCpa={null}
        onChange={vi.fn()}
      />,
    );

    expect(cboHtml).toContain("Campaign amount");
    expect(cboHtml).toContain("Campaign bid strategy");
    expect(aboHtml).not.toContain("Campaign amount");
    expect(aboHtml).toContain("ABO uses budgets on each ad set");
  });

  it("resets hidden campaign fields when switching to ABO", () => {
    expect(
      nextLaunchpadBudgetForMode(
        {
          mode: "CBO",
          schedule: "daily",
          amount: "100",
          bidStrategy: "COST_CAP",
          bidAmount: "12",
        },
        "ABO",
      ),
    ).toEqual({
      mode: "ABO",
      schedule: undefined,
      amount: undefined,
      bidStrategy: undefined,
      bidAmount: undefined,
    });
  });
});
