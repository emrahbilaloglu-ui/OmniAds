// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OverviewMetricCardData } from "@/src/types/models";

const { mockPush } = vi.hoisted(() => ({ mockPush: vi.fn() }));

vi.mock("next/navigation", () => ({
  usePathname: () => "/overview",
  useRouter: () => ({ push: mockPush }),
}));

vi.mock("./adv-sparkline", () => ({
  AdvSparkline: ({ ariaLabel }: { ariaLabel?: string }) => <div aria-label={ariaLabel} data-mocked-sparkline="true" />,
}));

import { PlatformMiniDashboard } from "./platform-card";

function metric(
  id: string,
  title: string,
  value: number | null,
  unit: OverviewMetricCardData["unit"] = "count"
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
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("PlatformMiniDashboard", () => {
  it("renders exactly the five canonical stat shells in fixed order", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-17T12:12:00.000Z"));
    const { container } = render(
      <PlatformMiniDashboard
        provider="meta"
        title="Provider title must not replace canonical label"
        currencySymbol="$"
        metrics={[
          metric("meta-cpa", "CPA", 18, "currency"),
          metric("meta-conversions", "Conversions", 42),
          metric("meta-revenue", "Revenue", 900, "currency"),
          metric("meta-spend", "Spend", 300, "currency"),
          metric("meta-roas", "ROAS", 3, "ratio"),
          metric("meta-clicks", "Clicks", 1_000),
        ]}
        latestSync={{ finishedAt: "2026-08-17T12:00:00.000Z", status: "succeeded" }}
      />
    );

    expect(screen.getByRole("img", { name: "Meta Ads" })).toBeTruthy();
    const cta = screen.getByText("Open Decisions →");
    expect(cta.tagName).toBe("SPAN");
    fireEvent.click(cta);
    expect(mockPush).toHaveBeenCalledWith("/platforms/meta");

    const article = container.querySelector("article");
    expect(article).not.toBeNull();
    const statsGrid = article!.children[1] as HTMLElement;
    const statTiles = Array.from(statsGrid.children) as HTMLElement[];
    expect(statTiles).toHaveLength(5);
    expect(statTiles.map((tile) => tile.children[0]?.textContent)).toEqual([
      "Spend",
      "Revenue",
      "ROAS",
      "Purchases",
      "CPA",
    ]);
    expect(container.textContent).not.toContain("Clicks");
    expect(screen.getByText("$18.00")).toBeTruthy();
    expect(statTiles[0]!.children[0]!.className).toContain("text-[9px]");
    expect(statTiles[0]!.children[1]!.className).not.toContain("adv-num");
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

    expect(screen.getByText("Synced —")).toBeTruthy();
  });

  it("keeps all five shells and uses em dashes when provider fields are absent", () => {
    const unavailableRevenue = metric("google-revenue", "Revenue", 999, "currency");
    unavailableRevenue.status = "unavailable";

    render(
      <PlatformMiniDashboard
        provider="google"
        title="Google Ads"
        currencySymbol="$"
        metrics={[metric("google-spend", "Spend", 100, "currency"), unavailableRevenue]}
      />
    );

    expect(screen.getAllByText("—")).toHaveLength(4);
    expect(screen.queryByText("$999")).toBeNull();
    expect(screen.getAllByLabelText(/Google Ads .* trend/)).toHaveLength(5);
    expect(screen.getByText("Synced —")).toBeTruthy();
  });
});
