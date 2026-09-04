// @vitest-environment jsdom
/**
 * The evidence inspector's provenance band, close control and brief route.
 *
 * Three separate defects, all of them in one panel:
 *
 * 1. **No provenance.** The panel printed a verdict, a money figure and a
 *    confidence with no statement of what any of it was measured over. A
 *    verdict without its window is unfalsifiable, and the snapshot's write time
 *    is a second fact — a snapshot written this morning can describe a window
 *    that ended three days ago, so printing one as the other makes a stale read
 *    look current.
 * 2. **No close control.** `inspectorOpen` is computed by the page and is
 *    unconditionally true on the Action lane, so an operator who opened a row
 *    could not put the panel away.
 * 3. **No route to a brief.** `canCreateBrief` and the Briefs surface's URL
 *    lineage have existed all along, and nothing in the product minted a link
 *    carrying it — the brief-from-decision flow was reachable only by
 *    hand-writing a URL.
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
          asOf: "2026-08-17T06:00:00.000Z",
          evidenceWindow: "2026-07-21 to 2026-08-17",
        })}
      />,
    );

    const asOf = document.querySelector('[data-el="asof-row"]');
    const window = document.querySelector('[data-el="evidence-window"]');
    expect(asOf?.textContent).toBe("2026-08-17T06:00:00.000Z");
    expect(window?.textContent).toBe("2026-07-21 to 2026-08-17");
    // Two elements, never one: the whole point is that they can disagree.
    expect(asOf).not.toBe(window);
  });

  it("names the metrics the payload did not serve at this grain", () => {
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

    const gap = document.querySelector('[data-el="provenance-gap"]');
    expect(gap?.textContent).toContain("CPA");
    expect(gap?.textContent).toContain("CTR");
    /*
     * A missing metric is named, not zeroed. The invariant is explicit:
     * "Optional Meta event metrics remain null when no source payload key was
     * observed. Source absence must not be converted to a measured zero."
     */
    expect(gap?.textContent).not.toContain("0");
  });

  it("draws no provenance band when the payload stated neither fact", () => {
    render(<MetaDecisionCenterExact viewModel={viewModel({ entityName: "X" })} />);
    expect(document.querySelector('[data-el="asof-row"]')).toBeNull();
    expect(document.querySelector('[data-el="provenance-gap"]')).toBeNull();
  });
});

describe("the panel keeps long safety evidence readable", () => {
  it("shows the first blocker and collapses the remaining exact checks", () => {
    render(
      <MetaDecisionCenterExact
        viewModel={viewModel({
          entityName: "Prospecting",
          blockers:
            "Snapshot is stale · Commercial target is missing · Executor is disabled",
          blockerTone: "warning",
        })}
      />,
    );

    const blockerGroup = screen.getByText("Blockers").parentElement;
    const primary = blockerGroup?.querySelector("p:nth-of-type(2)");
    const details = blockerGroup?.querySelector(
      "details",
    ) as HTMLDetailsElement | null;
    expect(primary?.textContent).toBe("Snapshot is stale");
    expect(details?.open).toBe(false);
    expect(details?.querySelector("summary")?.textContent).toBe(
      "Show 2 additional safety checks",
    );
    expect(details?.querySelectorAll("li")).toHaveLength(2);
    expect(details?.textContent).toContain("Commercial target is missing");
    expect(details?.textContent).toContain("Executor is disabled");
  });
});

describe("the panel can be put away", () => {
  it("offers no close control when the caller supplies no handler", () => {
    render(<MetaDecisionCenterExact viewModel={viewModel({ entityName: "X" })} />);
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

describe("the brief control is a route or a reason, never a broken link", () => {
  it("links when the row carries a creative decision snapshot", () => {
    render(
      <MetaDecisionCenterExact
        viewModel={viewModel({
          entityName: "Creative",
          brief: { href: "/c/biz/creative/briefs?creativeId=c1" },
        })}
      />,
    );

    const control = document.querySelector('[data-ctl="live:CREATIVE-07 brief"]');
    expect(control?.tagName).toBe("A");
    expect(control?.getAttribute("href")).toBe(
      "/c/biz/creative/briefs?creativeId=c1",
    );
    expect(
      document.querySelector('[data-el="row-action"]'),
    ).toBeTruthy();
  });

  it("refuses in the brief contract's own words when the row cannot mint one", () => {
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

    const control = document.querySelector('[data-ctl="live:CREATIVE-07 brief"]');
    /*
     * Present and refusing, with the reason attached — not absent, and not a
     * link that would be refused after the navigation.
     *
     * A BUTTON rather than a `role="link"` span: the fidelity gate grades a
     * marked control's tag and reports `not-a-control` for a span, and it is
     * right to — a refused control that is not a control cannot be reached by
     * keyboard to read its own reason.
     */
    expect(control?.tagName).toBe("BUTTON");
    expect(control?.getAttribute("aria-disabled")).toBe("true");
    expect(control?.textContent).toContain("creative decision");
    expect(control?.getAttribute("href")).toBeNull();
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
