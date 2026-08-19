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

  // The warning was unreachable until the page supplied the business target
  // pack's configured target CPA; these pin both sides of the threshold.
  it.each([
    ["19", true],
    ["20", false],
    ["55", false],
  ] as const)(
    "flags a %s daily budget against a 40 target CPA: %s",
    (amount, warned) => {
      const html = renderToStaticMarkup(
        <LaunchpadBudget
          value={{
            mode: "CBO",
            schedule: "daily",
            amount,
            bidStrategy: "LOWEST_COST_WITHOUT_CAP",
            bidAmount: "",
          }}
          currency="USD"
          expectedCpa={40}
          onChange={vi.fn()}
        />,
      );

      expect(html.includes("Daily budget is below 0.5x expected CPA")).toBe(
        warned,
      );
    },
  );

  it("stays silent when no target CPA is configured", () => {
    const html = renderToStaticMarkup(
      <LaunchpadBudget
        value={{
          mode: "CBO",
          schedule: "daily",
          amount: "1",
          bidStrategy: "LOWEST_COST_WITHOUT_CAP",
          bidAmount: "",
        }}
        currency="USD"
        expectedCpa={null}
        onChange={vi.fn()}
      />,
    );

    expect(html).not.toContain("Daily budget is below 0.5x expected CPA");
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
