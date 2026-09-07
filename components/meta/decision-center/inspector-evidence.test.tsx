// @vitest-environment jsdom
/**
 * The compact decision inspector keeps the evidence dates, one buyer-facing
 * reason, and its close/action controls. Diagnostic gaps, raw blocker lists and
 * brief-contract internals stay out of the primary workflow.
 */
import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MetaDecisionCenterExact,
  type MetaDecisionCenterExactViewModel,
} from "./MetaDecisionCenterExact";

afterEach(() => {
  document.body.innerHTML = "";
});

function viewModel(
  inspector: MetaDecisionCenterExactViewModel["inspector"],
): MetaDecisionCenterExactViewModel {
  return {
    actionRows: [
      { id: "row_1", name: "Prospecting", selected: true, onOpen: () => {} },
    ],
    inspector,
  };
}

describe("the panel states what the verdict was measured over", () => {
  it("draws the as-of and the evidence window as two separate facts", () => {
    render(
      <MetaDecisionCenterExact
        viewModel={viewModel({
          entityName: "Prospecting",
          asOf: "2026-08-17 06:00:00.123456+00",
          evidenceWindow: "2026-07-21 to 2026-08-17",
        })}
      />,
    );

    const asOf = document.querySelector('[data-el="asof-row"]');
    const window = document.querySelector('[data-el="evidence-window"]');
    expect(asOf?.textContent).toBe("Aug 17, 2026, 6:00 AM UTC");
    expect(window?.textContent).toBe("Jul 21, 2026 – Aug 17, 2026");
    // Two elements, never one: the whole point is that they can disagree.
    expect(asOf).not.toBe(window);
  });

  it("does not expose diagnostic metric-gap prose", () => {
    render(
      <MetaDecisionCenterExact
        viewModel={viewModel({
          entityName: "Prospecting",
          asOf: "2026-08-17T06:00:00.000Z",
          evidenceWindow: "2026-07-21 to 2026-08-17",
          provenanceGaps: [
            "CPA — not served at the campaign or adset grain",
            "CTR — not served at the campaign or adset grain",
          ],
        })}
      />,
    );

    expect(document.querySelector('[data-el="provenance-gap"]')).toBeNull();
    expect(document.body.textContent).not.toContain("not served at");
  });

  it("draws no provenance band when the payload stated neither fact", () => {
    render(
      <MetaDecisionCenterExact viewModel={viewModel({ entityName: "X" })} />,
    );
    expect(document.querySelector('[data-el="asof-row"]')).toBeNull();
    expect(document.querySelector('[data-el="provenance-gap"]')).toBeNull();
  });
});

describe("the panel keeps one useful reason instead of internal blocker prose", () => {
  it("shows the buyer reason and omits the raw blocker list", () => {
    render(
      <MetaDecisionCenterExact
        viewModel={viewModel({
          entityName: "Prospecting",
          blockers:
            "Snapshot is stale · Commercial target is missing · Executor is disabled",
          blockerTone: "warning",
          reasons: ["Review the campaign target before making this change."],
        })}
      />,
    );

    expect(
      screen.getByText("Review the campaign target before making this change."),
    ).toBeTruthy();
    expect(screen.queryByText("Blockers")).toBeNull();
    expect(document.body.textContent).not.toContain("Executor is disabled");
  });
});

describe("the panel can be put away", () => {
  it("offers no close control when the caller supplies no handler", () => {
    render(
      <MetaDecisionCenterExact viewModel={viewModel({ entityName: "X" })} />,
    );
    // Drawn-and-inert is worse than absent: it teaches that the control is
    // broken rather than that the caller does not offer one.
    expect(document.querySelector('[data-ctl="live:close"]')).toBeNull();
  });

  it("closes and hands focus back to the row that opened it", () => {
    const onClose = vi.fn();
    render(
      <MetaDecisionCenterExact
        onCloseInspector={onClose}
        viewModel={viewModel({ entityName: "Prospecting" })}
      />,
    );

    const close = screen.getByRole("button", {
      name: "Close the evidence inspector",
    });
    expect(close.getAttribute("data-ctl")).toBe("live:close");
    fireEvent.click(close);

    expect(onClose).toHaveBeenCalledTimes(1);
    const row = document.querySelector(
      '[data-meta-exact-selected="true"] [data-meta-exact-card-open]',
    );
    expect(document.activeElement).toBe(row);
  });
});

describe("the inspector omits brief-contract controls", () => {
  it("does not add a second route when a brief link is supplied", () => {
    render(
      <MetaDecisionCenterExact
        viewModel={viewModel({
          entityName: "Creative",
          brief: { href: "/c/biz/creative/briefs?creativeId=c1" },
        })}
      />,
    );

    expect(
      document.querySelector('[data-ctl="live:CREATIVE-07 brief"]'),
    ).toBeNull();
    expect(document.body.innerHTML).not.toContain("creativeId=c1");
  });

  it("does not expose a raw refusal reason", () => {
    render(
      <MetaDecisionCenterExact
        viewModel={viewModel({
          entityName: "Campaign",
          brief: {
            refusalReason:
              "A brief is created from a creative decision. This row is a campaign, so it carries no creative snapshot to derive one from.",
          },
        })}
      />,
    );

    expect(
      document.querySelector('[data-ctl="live:CREATIVE-07 brief"]'),
    ).toBeNull();
    expect(document.body.textContent).not.toContain(
      "creative snapshot to derive one from",
    );
  });

  it("draws no control at all when the caller offers no brief route", () => {
    render(
      <MetaDecisionCenterExact viewModel={viewModel({ entityName: "X" })} />,
    );
    expect(
      document.querySelector('[data-ctl="live:CREATIVE-07 brief"]'),
    ).toBeNull();
  });
});
