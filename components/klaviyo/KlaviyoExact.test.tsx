// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

import { KlaviyoExact } from "@/components/klaviyo/KlaviyoExact";
import { buildKlaviyoExactModel } from "@/components/klaviyo/klaviyo-exact-adapter";

afterEach(() => cleanup());

describe("KlaviyoExact", () => {
  it("draws the eyebrow, title and BETA badge", () => {
    render(
      <KlaviyoExact model={buildKlaviyoExactModel({ domain: null, flows: null })} />,
    );
    expect(screen.getByText("Klaviyo · Email & SMS")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1, name: "Lifecycle" })).toBeTruthy();
    expect(screen.getByText("BETA — read-only analysis")).toBeTruthy();
  });

  it("renders the four tab pills with Flows selected", () => {
    render(
      <KlaviyoExact model={buildKlaviyoExactModel({ domain: null, flows: null })} />,
    );
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      "Flows",
      "Campaigns",
      "Templates",
      "Segments",
    ]);
    expect(tabs[0]!.getAttribute("aria-selected")).toBe("true");
    expect(tabs[3]!.getAttribute("aria-selected")).toBe("false");
  });

  it("lists the design's five column headers in order", () => {
    const { container } = render(
      <KlaviyoExact model={buildKlaviyoExactModel({ domain: null, flows: null })} />,
    );
    expect(
      Array.from(container.querySelectorAll("thead th")).map((th) => th.textContent),
    ).toEqual(["Flow", "Status", "Revenue · 28d", "Open rate", "Recipients"]);
  });

  it("keeps the row geometry and renders an em-dash when nothing serves flows", () => {
    const { container } = render(
      <KlaviyoExact model={buildKlaviyoExactModel({ domain: null, flows: null })} />,
    );
    const rows = container.querySelectorAll("tbody tr");
    expect(rows).toHaveLength(1);
    const cells = rows[0]!.querySelectorAll("td");
    expect(cells).toHaveLength(5);
    expect(Array.from(cells).map((cell) => cell.textContent)).toEqual([
      "—",
      "—",
      "—",
      "—",
      "—",
    ]);
  });

  it("renders served rows with a status chip", () => {
    render(
      <KlaviyoExact
        model={buildKlaviyoExactModel({
          domain: null,
          flows: [
            {
              id: "flow_1",
              name: "Welcome Series",
              status: "Live",
              revenue: "$18,420",
              openRate: "54%",
              recipients: "12,480",
            },
          ],
        })}
      />,
    );
    const row = screen.getByText("Welcome Series").closest("tr")!;
    expect(within(row).getByText("Live")).toBeTruthy();
    expect(within(row).getByText("$18,420")).toBeTruthy();
  });

  it("closes with the design's monospace footer sentence", () => {
    const { container } = render(
      <KlaviyoExact model={buildKlaviyoExactModel({ domain: null, flows: null })} />,
    );
    const note = container.querySelector("section > p:last-child")!;
    expect(note.textContent).toContain(
      'The Overview opportunity "win-back flow for 60-day lapsed buyers" starts here',
    );
  });
});

describe("KlaviyoExact source", () => {
  const css = readFileSync("components/klaviyo/KlaviyoExact.module.css", "utf8");
  const source = readFileSync("components/klaviyo/KlaviyoExact.tsx", "utf8");

  it("keeps tabular figures and a wrapping header row", () => {
    expect(css).toContain("font-variant-numeric: tabular-nums");
    expect(css).toContain("flex-wrap: wrap");
  });

  it("sets the footer sentence in IBM Plex Mono", () => {
    expect(css).toMatch(
      /\.footNote \{[^}]*--font-ibm-plex-mono/,
    );
  });

  it("does not clamp the screen the way ad-workspace-page did", () => {
    expect(source).not.toContain("ad-workspace-page");
    expect(css).not.toContain("max-width: 1060px");
  });
});
