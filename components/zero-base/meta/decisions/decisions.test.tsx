// @vitest-environment jsdom

/**
 * Decisions rendering rules.
 *
 * The load-bearing assertion is text equality: what the surface prints for a
 * verdict must be exactly what the server served. A surface that reformats a
 * verdict is a surface that can disagree with the resolver, which the Decision
 * Center's invariants forbid.
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { DecisionsView } from "@/components/zero-base/meta/decisions/decisions-view";
import { ZeroBasePortalHost } from "@/components/zero-base/portal/portal-host";
import { buildDecisionsViewModel } from "@/lib/zero-base/meta/decisions-presentation";
import { ZERO_BASE_ROOT_ATTRIBUTE, ZERO_BASE_ROOT_VALUE } from "@/lib/design/ledger-tokens";
import type { MetaRecommendation } from "@/lib/meta/recommendations";
import type { MetaLanePayload } from "@/components/meta/redesign/types";
import type { DecisionsUrlState } from "@/lib/zero-base/meta/decisions-url-state";

afterEach(cleanup);

const VERDICT = "Scale up — 7-day ROAS 3.4 vs target 2.6";

function recommendation(overrides: Partial<MetaRecommendation> = {}): MetaRecommendation {
  return {
    id: "d1",
    level: "campaign",
    type: "campaign_state",
    lens: "profitability",
    priority: "high",
    confidence: "high",
    decisionState: "act",
    decision: VERDICT,
    title: "Prospecting — Broad US",
    why: "Seven-day ROAS is above target and pace is +18%.",
    summary: "",
    recommendedAction: "Raise the daily budget by 20%.",
    expectedImpact: "",
    evidence: [],
    timeframeContext: {} as MetaRecommendation["timeframeContext"],
    campaignName: "Prospecting — Broad US",
    ...overrides,
  } as MetaRecommendation;
}

function lane(rows: MetaRecommendation[]): MetaLanePayload {
  return {
    businessId: "biz_1",
    startDate: "2026-08-01",
    endDate: "2026-08-07",
    sourceModel: "v3",
    snapshotDate: "2026-08-07",
    snapshotCreatedAt: "2026-08-11T06:00:00Z",
    actionNow: rows,
    watching: [],
    healthy: [],
    nonSales: [],
    archive: [],
    deferredIds: [],
    counts: { actionNow: rows.length, watching: 0, healthy: 0, nonSales: 0, archive: 0 },
  } as MetaLanePayload;
}

const viewer = { role: "collaborator" as const, isReviewer: false, readOnly: false, readOnlyReason: null };
const state = { lane: "act" as const, levels: [], search: "", selected: null };

function renderView(options: {
  rows?: MetaRecommendation[];
  demo?: boolean;
  selected?: string | null;
  viewerOverride?: typeof viewer | null;
  banners?: MetaLanePayload extends never ? never : Parameters<typeof buildDecisionsViewModel>[0]["banners"];
} = {}) {
  const rows = options.rows ?? [recommendation()];
  const model = buildDecisionsViewModel({
    lane: lane(rows),
    banners: options.banners ?? [],
    viewer: options.viewerOverride === undefined ? viewer : options.viewerOverride,
    state: { ...state, selected: options.selected ?? null },
  });
  const onStateChange = vi.fn();
  const utils = render(
    <div {...{ [ZERO_BASE_ROOT_ATTRIBUTE]: ZERO_BASE_ROOT_VALUE }}>
      <ZeroBasePortalHost>
        <DecisionsView
          model={model}
          state={{ ...state, selected: options.selected ?? null }}
          demo={options.demo ?? false}
          onStateChange={onStateChange}
          adsManagerHref="https://adsmanager.facebook.com/"
        />
      </ZeroBasePortalHost>
    </div>,
  );
  return { ...utils, onStateChange, model };
}

describe("served text is the authority", () => {
  it("prints the verdict exactly as served", () => {
    renderView();
    const verdict = document.querySelector('[data-verdict="d1"]')!;
    expect(verdict.textContent).toBe(VERDICT);
  });

  it("prints the served why in the inspector unchanged", async () => {
    renderView({ selected: "d1" });
    const inspector = await screen.findByRole("dialog");
    expect(within(inspector).getByText("Seven-day ROAS is above target and pace is +18%.")).toBeVisible();
    expect(document.querySelector("[data-inspector-verdict]")!.textContent).toBe(VERDICT);
  });
});

describe("action count", () => {
  it("is zero for a held decision and states why", () => {
    renderView({ rows: [recommendation({ recommendedAction: "", stateReason: "Authority blocked." })] });
    expect(document.querySelector('[data-action-count="0"]')).not.toBeNull();
    expect(screen.getByText("Authority blocked.")).toBeVisible();
  });

  it("is zero for a reviewer", () => {
    renderView({ viewerOverride: { ...viewer, isReviewer: true } });
    expect(document.querySelector('[data-action-count="0"]')).not.toBeNull();
    expect(document.querySelector('[data-action-count="1"]')).toBeNull();
  });

  it("is zero on a demo business", () => {
    renderView({ demo: true });
    expect(document.querySelector('[data-action-count="1"]')).toBeNull();
  });

  it("is zero in the inspector too, not just the row", async () => {
    renderView({ demo: true, selected: "d1" });
    await screen.findByRole("dialog");
    expect(document.querySelector('[data-inspector-action-count="0"]')).not.toBeNull();
  });
});

describe("evidence window and snapshot time are distinct", () => {
  it("draws them as two separate labelled facts", () => {
    renderView();
    const window = document.querySelector("[data-evidence-window]")!;
    const snapshot = document.querySelector("[data-snapshot-time]")!;
    expect(window.textContent).toContain("2026-08-01");
    expect(window.textContent).toContain("2026-08-07");
    expect(snapshot.textContent).toContain("2026-08-11T06:00:00Z");
    expect(window.textContent).not.toBe(snapshot.textContent);
  });
});

describe("banners", () => {
  it("shows blocking and advisory together", () => {
    renderView({
      banners: [
        { id: "b1", tone: "warning", title: "Partial", detail: "GA4 incomplete.", blocking: false },
        { id: "b2", tone: "danger", title: "Hard", detail: "Token expired.", blocking: true },
      ],
    });
    expect(document.querySelector('[data-banner="hard"]')).not.toBeNull();
    expect(document.querySelector('[data-banner="partial"]')).not.toBeNull();
  });
});

describe("selection", () => {
  it("opens the inspector for the URL-selected row", async () => {
    renderView({ selected: "d1" });
    expect(await screen.findByRole("dialog")).toBeVisible();
    expect(document.querySelector('[data-decision-inspector="d1"]')).not.toBeNull();
  });

  it("says so when the URL names a row this lane no longer serves", () => {
    renderView({ selected: "d_missing" });
    expect(document.querySelector("[data-row-gone]")).not.toBeNull();
    expect(screen.getByTestId("state-unavailable")).toHaveTextContent("no longer served");
  });

  it("returns focus to the row that opened the inspector", async () => {
    const user = userEvent.setup();

    // Driven by real state, as a route would: with a spy parent the controlled
    // sheet never closes and its focus trap correctly keeps focus inside, so
    // the assertion would be about the harness rather than the surface.
    function Harness() {
      const [current, setCurrent] = React.useState<DecisionsUrlState>({
        ...state,
        selected: null,
      });
      const model = buildDecisionsViewModel({
        lane: lane([recommendation()]),
        banners: [],
        viewer,
        state: current,
      });
      return (
        <div {...{ [ZERO_BASE_ROOT_ATTRIBUTE]: ZERO_BASE_ROOT_VALUE }}>
          <ZeroBasePortalHost>
            <DecisionsView model={model} state={current} demo={false} onStateChange={setCurrent} />
          </ZeroBasePortalHost>
        </div>
      );
    }
    render(<Harness />);

    const trigger = screen.getByRole("button", { name: "Prospecting — Broad US" });
    await user.click(trigger);
    await screen.findByRole("dialog");

    await user.keyboard("{Escape}");

    // Without focus return a keyboard user lands at the top of the table and
    // has to find their place again.
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});

describe("Ads Manager link is a link", () => {
  it("is labelled as opening Meta and says nothing changed", async () => {
    renderView({ selected: "d1" });
    await screen.findByRole("dialog");
    const link = document.querySelector("[data-ads-manager-link]") as HTMLAnchorElement;
    expect(link.textContent).toBe("Open Meta Ads Manager");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(screen.getByText(/Nothing is changed by following it/)).toBeVisible();
  });

  it("never sits where an action would, and carries no action count", () => {
    renderView({ selected: "d1" });
    const link = document.querySelector("[data-ads-manager-link]");
    expect(link?.closest("[data-action-count]")).toBeNull();
  });
});

describe("filters", () => {
  it("reports a level change without selecting a row", async () => {
    const user = userEvent.setup();
    const { onStateChange } = renderView();
    await user.click(document.querySelector('[data-level-filter="adset"]') as HTMLElement);
    expect(onStateChange).toHaveBeenCalledWith(
      expect.objectContaining({ levels: ["adset"], selected: null }),
    );
  });

  it("clears the selection when the search changes", async () => {
    const user = userEvent.setup();
    // No inspector open: with one open the background is correctly inert.
    const { onStateChange } = renderView();
    await user.type(screen.getByLabelText("Find a decision"), "a");
    expect(onStateChange).toHaveBeenCalledWith(expect.objectContaining({ selected: null }));
  });
});
