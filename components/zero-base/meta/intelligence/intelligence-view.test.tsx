// @vitest-environment jsdom

/**
 * Account Intelligence — the parts of the surface that make claims.
 *
 * Every assertion here is about a statement the page makes on its own behalf:
 * how many sources are serving, which labels exist, and what the evidence
 * window covers. Each one was previously printed from the wrong array, which
 * is worse than printing nothing: it reads as a measurement.
 */
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { IntelligenceView } from "@/components/zero-base/meta/intelligence/intelligence-view";

afterEach(cleanup);

const SOURCES = [
  {
    key: "status",
    label: "Connection & account",
    state: "serving" as const,
    reason: null,
    observedAt: "2026-08-11T12:00:00.000Z",
    facts: [{ label: "Meta connection", value: "Connected" }],
  },
  {
    key: "labels",
    label: "Campaign labels",
    state: "serving" as const,
    reason: null,
    observedAt: "2026-08-11T12:00:00.000Z",
    facts: [
      { label: "Labelled campaigns", value: "2" },
      { label: "Prospecting — broad", value: "Main" },
      { label: "Creative test 04", value: "Test" },
    ],
  },
  {
    key: "structure",
    label: "Structure & recommendations",
    state: "unavailable" as const,
    reason: "No verified native decision generation exists for this account.",
    observedAt: null,
    facts: [],
  },
];

describe("the served count is a count of what is serving", () => {
  it("does not report an unavailable source as served", () => {
    render(<IntelligenceView sources={SOURCES} />);
    // Three rows are listed; only two of them serve. Printing the row count
    // told the operator the account was healthier than it is.
    expect(screen.getByText("2 sources served")).toBeTruthy();
    expect(screen.queryByText("3 sources served")).toBeNull();
  });
});

describe("campaign labels show labels", () => {
  it("chips the labels authority's own facts, not the pulse tiles'", () => {
    render(<IntelligenceView sources={SOURCES} />);
    const chips = document.querySelector("[data-el='label-chips']")!;
    expect(within(chips as HTMLElement).getByText(/Prospecting — broad · Main/)).toBeTruthy();
    expect(within(chips as HTMLElement).getByText(/Creative test 04 · Test/)).toBeTruthy();
    // The connection fact belongs to a different authority and used to leak in.
    expect(within(chips as HTMLElement).queryByText(/Meta connection/)).toBeNull();
  });

  it("says nothing was served rather than borrowing another source's facts", () => {
    render(<IntelligenceView sources={[SOURCES[0]]} />);
    const chips = document.querySelector("[data-el='label-chips']")!;
    expect(within(chips as HTMLElement).getByText("Nothing served")).toBeTruthy();
  });
});

describe("the tabs switch panels", () => {
  it("opens the evidence window with the window and each source's observation", async () => {
    const user = userEvent.setup();
    render(
      <IntelligenceView
        sources={SOURCES}
        window={{ startDate: "2026-07-15", endDate: "2026-08-11" }}
      />,
    );
    // Before the panel existed the tab was decorative: it took focus and
    // changed nothing on screen.
    expect(document.querySelector("[data-intelligence-evidence]")).toBeNull();

    await user.click(screen.getByRole("tab", { name: "Evidence window" }));

    const panel = document.querySelector("[data-intelligence-evidence]") as HTMLElement;
    expect(panel).not.toBeNull();
    expect(within(panel).getByText("2026-07-15 – 2026-08-11")).toBeTruthy();
    expect(
      within(panel).getAllByText(/Observed: 2026-08-11T12:00:00.000Z/),
    ).toHaveLength(2);
    // A source nobody observed says so rather than showing a blank cell.
    expect(within(panel).getByText(/Observed: Not recorded/)).toBeTruthy();
    // The sources panel is the other tab's panel, not a second copy on screen.
    expect(document.querySelector("[data-el='intel-recs']")).toBeNull();
  });

  it("returns to the sources panel", async () => {
    const user = userEvent.setup();
    render(<IntelligenceView sources={SOURCES} />);
    await user.click(screen.getByRole("tab", { name: "Evidence window" }));
    await user.click(screen.getByRole("tab", { name: "Intelligence sources" }));
    expect(document.querySelector("[data-el='intel-recs']")).not.toBeNull();
  });

  it("says the window was not served rather than printing an empty range", async () => {
    const user = userEvent.setup();
    render(<IntelligenceView sources={SOURCES} />);
    await user.click(screen.getByRole("tab", { name: "Evidence window" }));
    const panel = document.querySelector("[data-intelligence-evidence]") as HTMLElement;
    expect(within(panel).getByText("Nothing served")).toBeTruthy();
  });
});
