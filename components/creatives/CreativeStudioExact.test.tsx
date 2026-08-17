// @vitest-environment jsdom

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { CreativeStudioExact } from "./CreativeStudioExact";
import type {
  CreativeStudioAssetRow,
  CreativeStudioAssetsModel,
  CreativeStudioCopiesModel,
  CreativeStudioExactProps,
  CreativeStudioTabId,
} from "./creative-studio-exact-types";

const TAB_HREFS: CreativeStudioExactProps["tabHrefs"] = {
  assets: "/app/creative/performance",
  copies: "/app/creative/copies",
  "landing-pages": "/app/creative/landing-pages",
  inbox: "/app/creative/inbox",
  audiences: "/app/creative/audiences",
};

function asset(
  id: string,
  name: string,
  spend: number,
  roas: number,
): CreativeStudioAssetRow {
  return {
    id,
    name,
    kind: "video · 9:16",
    imageUrl: null,
    status: "Server status",
    statusTone: "positive",
    marketingAngle: null,
    currency: "USD",
    metrics: {
      spend,
      impressions: spend * 100,
      clicks: spend * 2,
      purchases: spend / 10,
      roas,
      cpa: 12,
      cpm: 8,
      aov: 72,
      ctr: 1.42,
      thumbstop: 31,
      hold: 12,
      frequency: 2.2,
      atcRate: 8.2,
      cvr: 3.1,
    },
  };
}

function assetsModel(
  overrides: Partial<CreativeStudioAssetsModel> = {},
): CreativeStudioAssetsModel {
  return {
    state: "ready",
    message: null,
    syncedCount: 2,
    rows: [asset("asset-a", "Alpha asset", 100, 5.2), asset("asset-b", "Beta asset", 500, 2.1)],
    ...overrides,
  };
}

function baseProps(
  activeTab: CreativeStudioTabId,
  overrides: Partial<CreativeStudioExactProps> = {},
): CreativeStudioExactProps {
  return {
    activeTab,
    tabHrefs: TAB_HREFS,
    counts: { assets: 2, copies: 0, "landing-pages": 0, inbox: null, audiences: 0 },
    assets: assetsModel(),
    copies: { state: "empty", message: null, angles: [], angleCoverage: null, angleGaps: [], insight: null, rows: [] },
    landingPages: { state: "empty", message: null, rows: [], gaps: [], tests: [], history: [] },
    inbox: { state: "empty", message: null, columns: [] },
    audiences: { state: "empty", message: null, summaries: [], breakdowns: [], matrixColumns: [], matrixRows: [] },
    ...overrides,
  };
}

function renderStudio(
  activeTab: CreativeStudioTabId,
  overrides: Partial<CreativeStudioExactProps> = {},
) {
  return render(<CreativeStudioExact {...baseProps(activeTab, overrides)} />);
}

function textOf(selector: string): string[] {
  return Array.from(document.querySelectorAll(selector)).map((node) => node.textContent?.trim() ?? "");
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("CreativeStudioExact canonical shared anatomy", () => {
  it("renders the single canonical header, tab order, Assets board and heat-table controls", () => {
    renderStudio("assets");

    const root = document.querySelector('[data-screen-label="Creative Studio"]');
    expect(root).toBeTruthy();
    expect(screen.getByText("Meta · Analysis-first — writes stay in Launchpad")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1, name: "Creative Studio" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Export CSV" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Share with client" })).toBeDisabled();
    expect(textOf("[data-creative-studio-tab]")).toEqual([
      "Assets2",
      "Copies",
      "Landing Pages",
      "Inbox—",
      "Audiences",
    ]);

    expect(screen.getByText("visual assets · heat table + comparison board")).toBeTruthy();
    expect(screen.getByRole("option", { name: "Sort: Spend" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Sort: ROAS" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Sort: Thumbstop" })).toBeTruthy();
    expect(screen.getByPlaceholderText("Search creatives…")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "Comparison board" })).toBeTruthy();
    expect(screen.getByText("Board is empty")).toBeTruthy();
    expect(screen.getByText("2 synced · Meta")).toBeTruthy();

    expect(textOf("table th")).toEqual([
      "",
      "Creative",
      "Status",
      "Marketing angle",
      "Spend",
      "Purchases",
      "ROAS ↑",
      "CPA ↓",
      "AOV ↑",
      "",
    ]);
    expect(root?.textContent).not.toContain("Analyzing");
    expect(root?.textContent).not.toContain("Optimization");
    expect(root?.textContent).not.toContain("Lifecycle role");
    expect(root?.textContent).not.toContain("More");
    expect(root?.textContent).not.toContain("Usage map");
  });

  it("keeps header actions callback-only", () => {
    const onExport = vi.fn();
    const onShare = vi.fn();
    renderStudio("assets", { onExport, onShare });

    fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    fireEvent.click(screen.getByRole("button", { name: "Share with client" }));
    expect(onExport).toHaveBeenCalledOnce();
    expect(onShare).toHaveBeenCalledOnce();
  });
});

describe("CreativeStudioExact Assets interaction state", () => {
  it("sorts, searches, pins from the whole row and exposes pin changes to the controller", async () => {
    const onPinnedIdsChange = vi.fn();
    renderStudio("assets", {
      assets: assetsModel({ onPinnedIdsChange }),
    });

    expect(textOf("[data-creative-studio-asset-row]").map((text) => text.includes("Beta asset"))).toEqual([
      true,
      false,
    ]);

    fireEvent.change(screen.getByRole("combobox", { name: "Sort creatives" }), {
      target: { value: "roas" },
    });
    expect(textOf("[data-creative-studio-asset-row]").map((text) => text.includes("Alpha asset"))).toEqual([
      true,
      false,
    ]);

    fireEvent.click(document.querySelector('[data-creative-studio-asset-row="asset-a"]')!);
    expect(document.querySelector('[data-pinned-asset="asset-a"]')).toBeTruthy();
    await waitFor(() => {
      expect(onPinnedIdsChange).toHaveBeenLastCalledWith(["asset-a"]);
    });

    fireEvent.change(screen.getByRole("searchbox", { name: "Search creatives" }), {
      target: { value: "beta" },
    });
    expect(document.querySelector('[data-creative-studio-asset-row="asset-a"]')).toBeNull();
    expect(document.querySelector('[data-creative-studio-asset-row="asset-b"]')).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Unpin Alpha asset" }));
    expect(screen.getByText("Board is empty")).toBeTruthy();
    await waitFor(() => {
      expect(onPinnedIdsChange).toHaveBeenLastCalledWith([]);
    });
  });

  it("opens the exact metric picker and saves edits into the Custom set", () => {
    renderStudio("assets");

    fireEvent.click(screen.getByRole("button", { name: "+ Edit metrics" }));
    expect(document.querySelector("[data-creative-studio-metric-picker]")).toBeTruthy();
    expect(screen.getByText("edits save as the Custom set")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Impressions" }));

    expect(screen.getByRole("button", { name: "Custom · 6" })).toHaveAttribute("aria-pressed", "true");
    expect(textOf("table th")).toContain("Impressions");
    expect(textOf("table th")).toContain("ROAS ↑");
  });

  it("loads and saves the optional per-operator pin and Custom-metric state safely", async () => {
    const persistenceKey = "test:creative-studio:operator-a";
    window.localStorage.setItem(
      persistenceKey,
      JSON.stringify({
        version: 1,
        pinnedIds: ["asset-a"],
        customMetrics: ["impressions", "roas"],
      }),
    );
    const view = renderStudio("assets", {
      assets: assetsModel({ persistenceKey }),
    });

    await waitFor(() => {
      expect(document.querySelector('[data-pinned-asset="asset-a"]')).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "Custom" }));
    expect(textOf("table th")).toEqual([
      "",
      "Creative",
      "Status",
      "Marketing angle",
      "Impressions",
      "ROAS ↑",
      "",
    ]);

    fireEvent.click(document.querySelector('[data-creative-studio-asset-row="asset-b"]')!);
    await waitFor(() => {
      const persisted = JSON.parse(window.localStorage.getItem(persistenceKey) ?? "{}") as {
        pinnedIds?: string[];
      };
      expect(persisted.pinnedIds).toEqual(["asset-a", "asset-b"]);
    });

    view.unmount();
    renderStudio("assets", { assets: assetsModel({ persistenceKey }) });
    await waitFor(() => {
      expect(document.querySelectorAll("[data-pinned-asset]")).toHaveLength(2);
    });
  });
});

describe("CreativeStudioExact source-backed tab shapes", () => {
  it("keeps four Copies angle slots and the exact table shell without prototype seeds", () => {
    const onOpenRow = vi.fn();
    const copies: CreativeStudioCopiesModel = {
      state: "ready",
      message: null,
      angles: [],
      angleCoverage: null,
      angleGaps: [],
      insight: null,
      rows: [
        {
          id: "copy-real",
          text: "Served account copy",
          kind: "Primary",
          chars: 19,
          angle: null,
          tone: "neutral",
          ads: null,
          currency: "USD",
          spend: 125,
          seeMore: null,
          ctr: 1.2,
          engagement: null,
          cvr: null,
          roas: 3.4,
        },
      ],
      onOpenRow,
    };
    renderStudio("copies", { copies });

    expect(document.querySelectorAll("[data-copy-angle]")).toHaveLength(4);
    expect(screen.getByText("Angle coverage")).toBeTruthy();
    expect(textOf("table th")).toEqual([
      "Copy",
      "Angle",
      "Ads",
      "Spend",
      "See more",
      "CTR",
      "Engage",
      "CVR",
      "ROAS",
    ]);
    fireEvent.click(document.querySelector('[data-copy-row="copy-real"]')!);
    expect(onOpenRow).toHaveBeenCalledWith("copy-real");
    expect(document.body.textContent).not.toContain("I replaced three bags");
    expect(document.body.textContent).not.toContain("UGC voice");
    expect(document.body.textContent).not.toContain("Summer sale ends Sunday");
  });

  it("keeps the Meta-only Landing table, missing, test and history shapes", () => {
    renderStudio("landing-pages", {
      landingPages: {
        state: "empty",
        message: "No Meta destination rows were served.",
        rows: [],
        gaps: [],
        tests: [],
        history: [],
      },
    });

    expect(screen.getByText("Destinations behind ads")).toBeTruthy();
    expect(screen.getByText("What’s missing")).toBeTruthy();
    expect(screen.getByText("What to try")).toBeTruthy();
    expect(screen.getByText("Destination history")).toBeTruthy();
    expect(textOf("table th")).toEqual([
      "Destination",
      "Ads",
      "Spend",
      "Link clicks",
      "LP view rate",
      "CVR",
      "CPA",
      "ROAS",
      "Signal",
    ]);
    expect(document.body.textContent).not.toContain("GA4");
    expect(document.body.textContent).not.toContain("Sessions");
  });

  it("keeps all four Inbox lanes and fails closed when upload or card actions have no callback", () => {
    renderStudio("inbox", {
      inbox: {
        state: "ready",
        message: null,
        columns: [
          {
            id: "delivered",
            name: "Delivered",
            tone: "automation",
            cards: [
              {
                id: "served-card",
                source: "Served source",
                sourceTone: "neutral",
                name: "Served file",
                note: null,
                ownerInitials: null,
                ownerTone: "neutral",
                due: null,
                actionLabel: "Review & approve",
              },
            ],
          },
        ],
      },
    });

    expect(textOf("[data-inbox-column] > div:first-child").map((text) => text.replace(/\d+$/, ""))).toEqual([
      "Requested",
      "In production",
      "Delivered",
      "Live",
    ]);
    expect(screen.getByText("Drop new exports here")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Browse files" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Review & approve" })).toBeDisabled();
  });

  it("keeps four Audience summary slots, five fixed breakdowns and the matrix shell when unavailable", () => {
    renderStudio("audiences", {
      audiences: {
        state: "account_required",
        message: "Audience dimensions were not served.",
        summaries: [],
        breakdowns: [],
        matrixColumns: [],
        matrixRows: [],
      },
    });

    expect(document.querySelectorAll("[data-audience-summary]")).toHaveLength(4);
    expect(textOf("[data-audience-breakdown]").map((text) => text.split("—")[0]?.trim())).toEqual([
      "Frequencyexposures / user",
      "Agespend share · ROAS",
      "Genderspend share · ROAS",
      "Placementspend share · ROAS",
      "Platformspend share · ROAS",
    ]);
    expect(screen.getByText("Creative × audience matrix")).toBeTruthy();
    expect(textOf("table th")).toEqual(["Creative", "—", "—", "—", "—"]);
    expect(screen.getAllByText("Audience dimensions were not served.")).toHaveLength(2);
    expect(document.body.textContent).not.toContain("Broad US");
    expect(document.body.textContent).not.toContain("Retarg 7d");
    expect(document.body.textContent).not.toContain("Carousel — 5 SKUs");
  });
});
