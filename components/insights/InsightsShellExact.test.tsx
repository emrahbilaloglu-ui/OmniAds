// @vitest-environment jsdom

import React from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: React.ComponentProps<"a">) =>
    React.createElement("a", { href, ...rest }, children),
}));

const { InsightsShellExact } = await import("./InsightsShellExact");
const { buildInsightsShellExactModel } = await import("./insights-shell-exact-adapter");

function model(pathname = "/insights/analytics") {
  return buildInsightsShellExactModel({
    pathname,
    ga4: { isConnected: true, status: "connected" },
    searchConsole: { isConnected: false, status: "not_connected" },
  });
}

afterEach(cleanup);

describe("InsightsShellExact", () => {
  it("draws one page head: eyebrow, h1, and the chip cluster", () => {
    render(
      <InsightsShellExact model={model()}>
        <p>body</p>
      </InsightsShellExact>,
    );
    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading.textContent).toBe("Insights");
    expect(screen.getByText("Growth · GA4 + Search Console")).toBeTruthy();
    // The design's head has no description paragraph under the h1.
    expect(
      screen.queryByText(/share the same workspace context/i),
    ).toBeNull();
  });

  it("orders the outer tabs Analytics, SEO Intelligence, AI Visibility", () => {
    render(
      <InsightsShellExact model={model()}>
        <p>body</p>
      </InsightsShellExact>,
    );
    const tabs = within(screen.getByRole("tablist")).getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      "Analytics",
      "SEO Intelligence",
      "AI Visibility",
    ]);
    expect(tabs[0]?.getAttribute("data-active")).toBe("true");
    expect(tabs[1]?.getAttribute("data-active")).toBe("false");
  });

  it("gives each source chip its 14px platform mark and the real state", () => {
    const { container } = render(
      <InsightsShellExact model={model()}>
        <p>body</p>
      </InsightsShellExact>,
    );
    const marks = Array.from(container.querySelectorAll("img"));
    expect(marks.map((mark) => mark.getAttribute("src"))).toEqual([
      "/platform-logos/GA4.svg",
      "/platform-logos/searchconsole.svg",
    ]);
    expect(marks.every((mark) => mark.getAttribute("width") === "14")).toBe(true);
    expect(screen.getByText("connected")).toBeTruthy();
    expect(screen.getByText("not connected")).toBeTruthy();
  });

  it("mounts the date control as the first head chip", () => {
    const { container } = render(
      <InsightsShellExact
        model={model()}
        dateControl={<button type="button">Jul 18 - Aug 14</button>}
      >
        <p>body</p>
      </InsightsShellExact>,
    );
    const chips = container.querySelectorAll("[class*='chips'] > *");
    expect(chips.length).toBe(3);
    expect(chips[0]?.textContent).toBe("Jul 18 - Aug 14");
  });
});
