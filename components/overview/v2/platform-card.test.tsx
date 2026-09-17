// @vitest-environment jsdom

import React from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OverviewMetricCardData } from "@/src/types/models";
import { SYNC_AGE_UNKNOWN_LABEL } from "@/lib/provider-sync-vocabulary";

vi.mock("next/navigation", () => ({
  usePathname: () => "/overview",
}));

vi.mock("./adv-sparkline", () => ({
  AdvSparkline: ({
    ariaLabel,
    points,
    previousPoints,
  }: {
    ariaLabel?: string;
    points: unknown[];
    previousPoints?: unknown[];
  }) => (
    <div
      aria-label={ariaLabel}
      data-mocked-sparkline="true"
      data-points={points.length}
      data-previous-points={previousPoints?.length ?? 0}
    />
  ),
}));

import { PlatformMiniDashboard } from "./platform-card";

function metric(
  id: string,
  title: string,
  value: number | null,
  unit: OverviewMetricCardData["unit"] = "count",
  overrides: Partial<OverviewMetricCardData> = {},
): OverviewMetricCardData {
  return {
    id,
    title,
    value,
    previousValue: null,
    changePct: null,
    sparklineData: [],
    previousSparklineData: [],
    trendDirection: "neutral",
    dataSource: { key: "meta", label: "Meta Ads" },
    status: value === null ? "unavailable" : "available",
    unit,
    ...overrides,
  };
}

function tiles(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLElement>("[data-provider-metric-id]"));
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("PlatformMiniDashboard", () => {
  it("renders Meta's eight KPIs in the fixed order inside heading and list semantics", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-17T12:12:00.000Z"));
    const { container } = render(
      <PlatformMiniDashboard
        provider="meta"
        title="Provider title must not replace canonical label"
        currencySymbol="$"
        metrics={[
          // Deliberately shuffled, with a stray metric the card must ignore.
          metric("meta-cpc", "All-click CPC", 0.42, "currency"),
          metric("meta-cpa", "CPA", 18, "currency"),
          metric("meta-conversions", "Conversions", 42),
          metric("meta-revenue", "Revenue", 900, "currency"),
          metric("meta-spend", "Spend", 300, "currency"),
          metric("meta-roas", "ROAS", 3, "ratio"),
          metric("meta-purchases", "Purchases", 42),
          metric("meta-cpm", "CPM", 12.5, "currency"),
          metric("meta-ctr", "All-click CTR", 1.84, "percent"),
          metric("meta-clicks", "Clicks", 1_000),
        ]}
        latestSync={{ finishedAt: "2026-08-17T12:00:00.000Z", status: "succeeded" }}
      />
    );

    // The logo is decorative: the h2 names the provider, so there is no
    // second "Meta Ads" image announcement.
    expect(screen.queryByRole("img", { name: "Meta Ads" })).toBeNull();
    const logo = container.querySelector<HTMLElement>('[style*="Meta.png"]');
    expect(logo?.closest('[aria-hidden="true"]')).not.toBeNull();
    const heading = screen.getByRole("heading", { level: 2, name: "Meta Ads" });
    expect(container.querySelector("article")?.getAttribute("aria-labelledby")).toBe(heading.id);

    const cta = screen.getByRole("link", { name: /Open Decisions/ });
    expect(cta.getAttribute("href")).toBe("/platforms/meta");

    const list = screen.getByRole("list", { name: "Meta Ads metrics" });
    const items = Array.from(list.querySelectorAll("li"));
    expect(items).toHaveLength(8);
    expect(tiles(container).map((tile) => tile.getAttribute("data-provider-metric-id"))).toEqual([
      "meta-spend",
      "meta-revenue",
      "meta-roas",
      "meta-purchases",
      "meta-cpa",
      "meta-cpm",
      "meta-ctr",
      "meta-cpc",
    ]);
    expect(items.map((item) => item.querySelector("p")?.textContent)).toEqual([
      "Spend",
      "Revenue",
      "ROAS",
      "Purchases",
      "CPA",
      "CPM",
      "All-click CTR",
      "All-click CPC",
    ]);
    expect(container.textContent).not.toContain("Clicks");
    expect(container.textContent).not.toContain("Link");
    expect(screen.getByText("$18.00")).toBeTruthy();
    expect(screen.getByText("$12.50")).toBeTruthy();
    expect(screen.getByText("1.84%")).toBeTruthy();
    expect(screen.getByText("$0.42")).toBeTruthy();
  });

  it("renders Google's eight KPIs with conversion vocabulary and fractional conversions", () => {
    const { container } = render(
      <PlatformMiniDashboard
        provider="google"
        title="Google Ads"
        currencySymbol="$"
        metrics={[
          metric("google-spend", "Spend", 60, "currency"),
          metric("google-revenue", "Revenue", 120, "currency"),
          metric("google-roas", "ROAS", 2, "ratio"),
          metric("google-purchases", "Purchases", 12.5),
          metric("google-cpa", "CPA", 4.8, "currency"),
          metric("google-ctr", "CTR", 4.1, "percent"),
          metric("google-cpc", "CPC", 0.75, "currency"),
          metric("google-conversion-rate", "Conversion rate", 15.63, "percent"),
          // A Meta-only metric id must never fill a Google slot.
          metric("google-cpm", "CPM", 9, "currency"),
        ]}
      />
    );

    expect(screen.getByRole("link", { name: /Open workspace/ }).getAttribute("href")).toBe("/platforms/google");
    const items = tiles(container);
    expect(items.map((tile) => tile.getAttribute("data-provider-metric-id"))).toEqual([
      "google-spend",
      "google-revenue",
      "google-roas",
      "google-purchases",
      "google-cpa",
      "google-ctr",
      "google-cpc",
      "google-conversion-rate",
    ]);
    expect(items.map((tile) => tile.querySelector("p")?.textContent)).toEqual([
      "Spend",
      "Conversion value",
      "ROAS",
      "Conversions",
      "Cost / conv.",
      "CTR",
      "CPC",
      "Conversion rate",
    ]);
    expect(container.textContent).not.toMatch(/Purchases|Revenue|CPA|CPM/);
    expect(items[3]?.textContent).toContain("12.5");
    // The shared percent formatter keeps one decimal at 10% and above.
    expect(items[7]?.textContent).toContain("15.6%");
  });

  it("shows a signed, sentiment-coloured delta and both sparklines for every available tile", () => {
    render(
      <PlatformMiniDashboard
        provider="meta"
        title="Meta Ads"
        currencySymbol="$"
        metrics={[
          metric("meta-cpm", "CPM", 11, "currency", {
            previousValue: 8,
            changePct: 37.5,
            trendDirection: "up",
            trendSentiment: "negative",
            sparklineData: [
              { date: "2026-03-01", value: 10 },
              { date: "2026-03-02", value: 11 },
            ],
            previousSparklineData: [
              { date: "2026-02-01", value: 8 },
              { date: "2026-02-02", value: 8 },
              { date: "2026-02-03", value: 8 },
            ],
          }),
          metric("meta-ctr", "All-click CTR", 2.5, "percent", {
            previousValue: 1.6,
            changePct: 56.2,
            trendDirection: "up",
            trendSentiment: "positive",
          }),
          metric("meta-cpc", "All-click CPC", 0.44, "currency", {
            previousValue: 0.5,
            changePct: -12,
            trendDirection: "down",
            trendSentiment: "positive",
          }),
          metric("meta-spend", "Spend", 110, "currency", {
            previousValue: 100,
            changePct: 10,
            trendDirection: "up",
            trendSentiment: "neutral",
          }),
          // Comparison off / unavailable: no badge at all.
          metric("meta-roas", "ROAS", 3, "ratio"),
        ]}
      />
    );

    const cpm = document.querySelector<HTMLElement>('[data-provider-metric-id="meta-cpm"]')!;
    const cpmDelta = cpm.querySelector<HTMLElement>("[data-provider-metric-delta]")!;
    expect(cpmDelta.textContent).toBe("+37.5% vs previous period");
    expect((cpmDelta.firstElementChild as HTMLElement).style.color).toBe("rgb(225, 29, 72)");
    const cpmSparkline = cpm.querySelector<HTMLElement>("[data-mocked-sparkline]")!;
    expect(cpmSparkline.getAttribute("aria-label")).toBe("Meta Ads CPM trend");
    expect(cpmSparkline.getAttribute("data-points")).toBe("2");
    expect(cpmSparkline.getAttribute("data-previous-points")).toBe("3");

    const ctrDelta = document.querySelector('[data-provider-metric-id="meta-ctr"] [data-provider-metric-delta]')!;
    expect(ctrDelta.textContent).toBe("+56.2% vs previous period");
    expect((ctrDelta.firstElementChild as HTMLElement).style.color).toBe("rgb(11, 121, 84)");

    const cpcDelta = document.querySelector('[data-provider-metric-id="meta-cpc"] [data-provider-metric-delta]')!;
    expect(cpcDelta.textContent).toBe("−12.0% vs previous period");
    expect((cpcDelta.firstElementChild as HTMLElement).style.color).toBe("rgb(11, 121, 84)");

    const spendDelta = document.querySelector('[data-provider-metric-id="meta-spend"] [data-provider-metric-delta]')!;
    expect((spendDelta.firstElementChild as HTMLElement).style.color).toBe("rgb(85, 93, 109)");

    expect(document.querySelector('[data-provider-metric-id="meta-roas"] [data-provider-metric-delta]')).toBeNull();
  });

  it("uses the canonical sync-pill spacing, padding, and tone", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-17T12:26:00.000Z"));
    render(
      <PlatformMiniDashboard
        provider="google"
        title="Google"
        currencySymbol="$"
        metrics={[]}
        latestSync={{ finishedAt: "2026-08-17T12:00:00.000Z", status: "completed" }}
      />
    );

    const pill = screen.getByText("Synced 26m ago");
    expect(pill.style.gap).toBe("5px");
    expect(pill.style.padding).toBe("2px 9px");
    expect(pill.style.background).toBe("rgb(231, 246, 240)");
    // The success ink moved from #0e9f6e to #0b7954: white on the old value
    // measured 3.39:1 and the old value on this same #e7f6f0 fill measured
    // 3.04:1, both below AA, and both were among the 253 serious contrast
    // findings axe reported against the mounted routes.
    expect(pill.style.color).toBe("rgb(11, 121, 84)");
  });

  it("does not call a failed or unknown completion a sync", () => {
    render(
      <PlatformMiniDashboard
        provider="meta"
        title="Meta Ads"
        currencySymbol="$"
        metrics={[]}
        latestSync={{ finishedAt: "2026-08-17T12:00:00.000Z", status: "failed" }}
      />
    );

    expect(screen.getByText(SYNC_AGE_UNKNOWN_LABEL)).toBeTruthy();
  });

  /**
   * The pill was success-green for every status, so a failed, missing or
   * unparseable sync still read as a completed one after the copy was fixed.
   * Tone is asserted through `data-sync-tone` rather than colour alone, so the
   * contract survives a palette change.
   */
  it.each([
    ["a failed completion", { finishedAt: "2026-08-17T12:00:00.000Z", status: "failed" }],
    ["a null sync", null],
    ["an unparseable timestamp", { finishedAt: "not-a-date", status: "completed" }],
    ["a missing timestamp", { finishedAt: null, status: "completed" }],
  ])("renders %s as a neutral pill, not a positive one", (_case, latestSync) => {
    const { container } = render(
      <PlatformMiniDashboard
        provider="meta"
        title="Meta Ads"
        currencySymbol="$"
        metrics={[]}
        latestSync={latestSync as never}
      />
    );

    const pill = container.querySelector("[data-sync-tone]") as HTMLElement;
    expect(pill.getAttribute("data-sync-tone")).toBe("neutral");
    expect(pill.textContent).toContain(SYNC_AGE_UNKNOWN_LABEL);
    expect(pill.textContent).not.toContain("Synced");
    // Neutral must not reuse the success fill or ink.
    expect(pill.style.background).not.toBe("rgb(231, 246, 240)");
    expect(pill.style.color).not.toBe("rgb(11, 121, 84)");
  });

  it("still renders a genuinely completed sync as a positive pill", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-17T12:26:00.000Z"));
    const { container } = render(
      <PlatformMiniDashboard
        provider="google"
        title="Google"
        currencySymbol="$"
        metrics={[]}
        latestSync={{ finishedAt: "2026-08-17T12:00:00.000Z", status: "completed" }}
      />
    );

    const pill = container.querySelector("[data-sync-tone]") as HTMLElement;
    expect(pill.getAttribute("data-sync-tone")).toBe("positive");
    expect(pill.textContent).toContain("Synced 26m ago");
    expect(pill.style.background).toBe("rgb(231, 246, 240)");
    expect(pill.style.color).toBe("rgb(11, 121, 84)");
  });

  it("keeps all eight shells truthful when provider fields are absent or undefined", () => {
    const unavailableRevenue = metric("google-revenue", "Conversion value", 999, "currency", {
      status: "unavailable",
      changePct: 12,
    });
    const noClicks = metric("google-cpc", "CPC", null, "currency", {
      helperText: "No clicks in this window",
      changePct: 5,
      sparklineData: [
        { date: "2026-03-01", value: 1 },
        { date: "2026-03-02", value: 2 },
      ],
    });

    const { container } = render(
      <PlatformMiniDashboard
        provider="google"
        title="Google Ads"
        currencySymbol="$"
        metrics={[metric("google-spend", "Spend", 100, "currency"), unavailableRevenue, noClicks]}
      />
    );

    const items = tiles(container);
    expect(items).toHaveLength(8);
    expect(screen.getAllByText("—")).toHaveLength(7);
    expect(screen.queryByText("$999")).toBeNull();
    expect(items.filter((tile) => tile.getAttribute("data-metric-state") === "unavailable")).toHaveLength(7);
    // Unavailable tiles never show a delta or a trend, even if one was supplied.
    expect(container.querySelectorAll("[data-provider-metric-delta]")).toHaveLength(0);
    expect(screen.getAllByLabelText(/Google Ads .* trend/)).toHaveLength(1);
    const cpc = container.querySelector('[data-provider-metric-id="google-cpc"]')!;
    expect(cpc.textContent).toContain("No clicks in this window");
    expect(container.querySelector('[data-provider-metric-id="google-ctr"]')?.textContent).toContain(
      "No verified data for this window",
    );
    expect(screen.getByText(SYNC_AGE_UNKNOWN_LABEL)).toBeTruthy();
  });

  it("pins the responsive contract to the card's own width: 4 above 879px, 2 from 340px, 1 below 340px", () => {
    const css = readFileSync(join(process.cwd(), "components/overview/v2/platform-card.module.css"), "utf8");
    const compact = css.replace(/\s+/g, " ");

    // The size container wraps the padded card, so queries see the card width.
    expect(compact).toMatch(/\.cardContainer \{ container: platform-card \/ inline-size;/);
    expect(compact).not.toMatch(/\.card \{[^}]*container:/);
    expect(compact).toMatch(/\.stats \{ display: grid; grid-template-columns: repeat\(4, minmax\(0, 1fr\)\);/);

    const twoColumn = compact.match(
      /@container platform-card \(width <= (\d+)px\) \{ \.stats \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/,
    );
    const oneColumn = compact.match(
      /@container platform-card \(width < (\d+)px\) \{ \.stats \{ grid-template-columns: minmax\(0, 1fr\);/,
    );
    expect(twoColumn?.[1]).toBe("879");
    expect(oneColumn?.[1]).toBe("340");

    const columnsFor = (cardWidth: number) =>
      cardWidth < Number(oneColumn![1]) ? 1 : cardWidth <= Number(twoColumn![1]) ? 2 : 4;
    // 14-inch laptop: 1512px viewport → 1198px card.
    expect(columnsFor(1198)).toBe(4);
    expect(columnsFor(880)).toBe(4);
    expect(columnsFor(879)).toBe(2);
    // Browser-verified: a 390px viewport renders a 366px card at two columns.
    expect(columnsFor(366)).toBe(2);
    expect(columnsFor(340)).toBe(2);
    expect(columnsFor(339)).toBe(1);

    // The retired 5-stat spanning rules must not come back.
    expect(css).not.toContain("nth-last-child");
    expect(css).not.toContain("repeat(5");
  });

  it("wraps the card in its size container without adding a landmark or text", () => {
    const { container } = render(
      <PlatformMiniDashboard provider="meta" title="Meta Ads" currencySymbol="$" metrics={[]} />
    );

    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.hasAttribute("data-platform-card-container")).toBe(true);
    expect(wrapper.children).toHaveLength(1);
    expect(wrapper.firstElementChild?.tagName).toBe("ARTICLE");
  });
});
