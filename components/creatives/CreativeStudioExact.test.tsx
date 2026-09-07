// @vitest-environment jsdom

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import { CreativeStudioExact } from "./CreativeStudioExact";
import studioStyles from "./CreativeStudioExact.module.css";
import type {
  CreativeAssetMetricId,
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
    deliveryStatus: "Active",
    marketingAngle: null,
    currency: "USD",
    metrics: {
      spend,
      impressions: spend * 100,
      revenue: spend * roas,
      clicks: spend * 2,
      linkClicks: spend * 1.5,
      landingPageViews: spend,
      addToCart: spend / 4,
      initiateCheckout: spend / 6,
      purchases: spend / 10,
      roas,
      cpa: 12,
      cpm: 8,
      cpcLink: 0.42,
      aov: 72,
      ctr: 1.42,
      thumbstop: 31,
      frequency: 2.2,
      atcRate: 8.2,
      atcToPurchase: 14.5,
      cvr: 3.1,
      // A measured age. The projector, not this component, decides which clock
      // and which end (see the Assets projection suite in
      // `app/(dashboard)/platforms/meta/creatives/page.test.tsx`); what the
      // table owes it is a column, a neutral cell and an honest zero.
      ageDays: 16,
    },
  };
}

/**
 * Every metric the catalogue knows, all measured, on one row.
 *
 * A preset column that renders an em dash against THIS row is blank because of
 * the surface, not because of the data — which is the whole point of the
 * permanent-em-dash law below.
 */
const EVERY_METRIC_ID = [
  "ageDays",
  "spend",
  "impressions",
  "revenue",
  "clicks",
  "linkClicks",
  "landingPageViews",
  "addToCart",
  "initiateCheckout",
  "purchases",
  "roas",
  "cpa",
  "cpm",
  "cpcLink",
  "aov",
  "ctr",
  "thumbstop",
  "frequency",
  "atcRate",
  "atcToPurchase",
  "cvr",
  // `satisfies` so a typo or a retired id is a compile error rather than a
  // silently weaker assertion. The count check in the law below is the other
  // direction: it catches an id added to the catalogue and forgotten here.
] as const satisfies readonly CreativeAssetMetricId[];

function assetsModel(
  overrides: Partial<CreativeStudioAssetsModel> = {},
): CreativeStudioAssetsModel {
  return {
    state: "ready",
    message: null,
    syncedCount: 2,
    rows: [
      asset("asset-a", "Alpha asset", 100, 5.2),
      asset("asset-b", "Beta asset", 500, 2.1),
    ],
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
    counts: {
      assets: 2,
      copies: 0,
      "landing-pages": 0,
      inbox: null,
      audiences: 0,
    },
    assets: assetsModel(),
    copies: {
      state: "empty",
      message: null,
      angles: [],
      angleCoverage: null,
      angleGaps: [],
      insight: null,
      rows: [],
    },
    landingPages: {
      state: "empty",
      message: null,
      rows: [],
      gaps: [],
      tests: [],
      history: [],
    },
    inbox: { state: "empty", message: null, columns: [] },
    audiences: {
      state: "empty",
      message: null,
      summaries: [],
      breakdowns: [],
      matrixColumns: [],
      matrixRows: [],
    },
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
  return Array.from(document.querySelectorAll(selector)).map(
    (node) => node.textContent?.trim() ?? "",
  );
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("CreativeStudioExact canonical shared anatomy", () => {
  it("shows the served decision segment and never leaves a legacy status blank", () => {
    const served = {
      ...asset("asset-served", "Served decision", 100, 2),
      status: "Cut held",
      statusTone: "warning" as const,
      decisionSegment: "Blocked",
      statusDetail: "Held: cut",
    };
    const legacyBlank = {
      ...asset("asset-blank", "Legacy blank", 50, 1),
      status: null,
      decisionSegment: null,
    };

    renderStudio("assets", {
      assets: assetsModel({ rows: [served, legacyBlank] }),
    });

    const statusCells = Array.from(
      document.querySelectorAll<HTMLElement>("[data-creative-classification]"),
    );
    expect(statusCells.map((cell) => cell.textContent?.trim())).toEqual([
      "Blocked · Cut held",
      "Not evaluated",
    ]);
    expect(statusCells[0]).toHaveAttribute(
      "data-creative-decision-segment",
      "Blocked",
    );
    expect(statusCells[0]).toHaveAttribute("title", "Held: cut");
  });

  it("renders the single canonical header, tab order, Assets board and heat-table controls", () => {
    renderStudio("assets");

    const root = document.querySelector(
      '[data-screen-label="Creative Studio"]',
    );
    expect(root).toBeTruthy();
    expect(
      screen.queryByText("Meta · Analysis-first — writes stay in Launchpad"),
    ).toBeNull();
    expect(
      screen.getByRole("heading", { level: 1, name: "Creative Studio" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Export CSV" })).toBeNull();
    expect(
      screen.queryByRole("button", {
        name: "Share selected creatives with client",
      }),
    ).toBeNull();
    expect(textOf("[data-creative-studio-tab]")).toEqual([
      "Assets2",
      "Copies",
      "Landing Pages",
      "Audiences",
    ]);

    expect(
      screen.queryByText("visual assets · heat table + comparison board"),
    ).toBeNull();
    expect(screen.getByRole("option", { name: "Sort: Spend" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Sort: ROAS" })).toBeTruthy();
    expect(
      screen.getByRole("option", { name: "Sort: Thumbstop" }),
    ).toBeTruthy();
    expect(screen.getByPlaceholderText("Search creatives…")).toBeTruthy();
    expect(
      screen.queryByRole("heading", { level: 2, name: "Comparison board" }),
    ).toBeNull();
    expect(screen.queryByText("Board is empty")).toBeNull();
    expect(screen.getByText("2 creatives")).toBeTruthy();

    // "Spend▼" is the sort indicator, not a stray glyph: Spend is the default
    // sort column and the header says so in the same place a person looks to
    // change it. `aria-sort` carries the identical fact for a screen reader
    // and is asserted in the sorting suite below.
    // The Performance set, in its own reading order: the evidence base, the
    // outcome, the ROAS decomposition and the decay signal. Columns render in
    // the PRESET's order, not the catalogue's, so this list is the argument a
    // buyer reads left to right.
    expect(textOf("table th")).toEqual([
      "",
      "Creative",
      "Status",
      "Marketing angle",
      // Movement 1 of the Performance argument, "can I judge it at all?", now
      // has both halves. The header names its clock: an age counted from the
      // creative's creation, never a bare "Days live" over the same number.
      "Age (days since created)",
      "Spend▼",
      "Impressions",
      "Revenue",
      "ROAS ↑",
      "Purchases",
      "CPA ↓",
      "CPM ↓",
      "CTR (link) ↑",
      "CVR (link clicks) ↑",
      "AOV ↑",
      "Frequency (daily avg) ↓",
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
    // Share requires a real selection to reach onShare at all — see the nudge
    // test below for the zero-selection path.
    renderStudio("assets", { onExport, onShare, shareSelectedCount: 2 });

    fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    fireEvent.click(
      screen.getByRole("button", {
        name: "Share selected creatives with client",
      }),
    );
    expect(onExport).toHaveBeenCalledOnce();
    expect(onShare).toHaveBeenCalledOnce();
  });

  it("labels and colours the Share button by the live selection count", () => {
    renderStudio("assets", { onShare: vi.fn(), shareSelectedCount: 3 });
    const button = screen.getByRole("button", {
      name: "Share selected creatives with client",
    });
    expect(button.textContent).toBe("Share with client · 3");
  });

  it("nudges instead of opening Share when nothing is selected", () => {
    const onShare = vi.fn();
    renderStudio("assets", { onShare, shareSelectedCount: 0 });

    fireEvent.click(
      screen.getByRole("button", {
        name: "Share selected creatives with client",
      }),
    );

    expect(onShare).not.toHaveBeenCalled();
    expect(
      screen.getByText("Select at least one creative to share."),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(
      screen.queryByText("Select at least one creative to share."),
    ).toBeNull();
  });

  it("shows the served shared-links count and opens the manager on click", () => {
    const onOpenSharedLinks = vi.fn();
    renderStudio("assets", { onOpenSharedLinks, sharedLinksCount: 4 });

    const button = screen.getByRole("button", { name: /Shared links/ });
    expect(button.textContent).toBe("Shared links4");
    fireEvent.click(button);
    expect(onOpenSharedLinks).toHaveBeenCalledOnce();
  });

  it("hides the shared-links count while unread", () => {
    renderStudio("assets", {
      onOpenSharedLinks: vi.fn(),
      sharedLinksCount: null,
    });
    expect(
      screen.getByRole("button", { name: /Shared links/ }).textContent,
    ).toBe("Shared links");
  });
});

describe("CreativeStudioExact Assets interaction state", () => {
  it("sorts, searches, pins from the whole row and exposes pin changes to the controller", async () => {
    const onPinnedIdsChange = vi.fn();
    renderStudio("assets", {
      assets: assetsModel({ onPinnedIdsChange }),
    });

    expect(
      textOf("[data-creative-studio-asset-row]").map((text) =>
        text.includes("Beta asset"),
      ),
    ).toEqual([true, false]);

    fireEvent.change(screen.getByRole("combobox", { name: "Sort creatives" }), {
      target: { value: "roas" },
    });
    expect(
      textOf("[data-creative-studio-asset-row]").map((text) =>
        text.includes("Alpha asset"),
      ),
    ).toEqual([true, false]);

    fireEvent.click(
      document.querySelector('[data-creative-studio-asset-row="asset-a"]')!,
    );
    expect(
      document.querySelector('[data-pinned-asset="asset-a"]'),
    ).toBeTruthy();
    await waitFor(() => {
      expect(onPinnedIdsChange).toHaveBeenLastCalledWith(["asset-a"]);
    });

    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search creatives" }),
      {
        target: { value: "beta" },
      },
    );
    expect(
      document.querySelector('[data-creative-studio-asset-row="asset-a"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-creative-studio-asset-row="asset-b"]'),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Unpin Alpha asset" }));
    expect(document.querySelector('[data-pinned-asset="asset-a"]')).toBeNull();
    await waitFor(() => {
      expect(onPinnedIdsChange).toHaveBeenLastCalledWith([]);
    });
  });

  /**
   * ITEM 18 / CREATIVE-42 — an Assets row is the PIN, and only the pin.
   *
   * The canonical Dashboard v2 reference defines no Assets detail drawer.
   * `docs/dashboard-v2-parity-defects.md:1286` quotes the design directly:
   * "The Assets row's sole handler is `r.toggle` at line 758; the dedicated
   * checkbox and full row both represent the pin state. The only Studio drawer
   * trigger is the Copies row handler at line 813." The closed verdict at
   * :1023 says the same in the other direction: "An Assets row performs only
   * the canonical pin toggle; the old asset usage/evidence drawer path is not
   * mounted from this screen."
   *
   * So the absence of `onOpenRow` on `CreativeStudioAssetsModel` is a DESIGN
   * DECISION, not an unfinished feature — and this test is what stops it being
   * quietly undone. A stray handler is passed in deliberately: even when the
   * field reappears on the model, the surface must not honour it, because the
   * row already means something else. The Copies row keeps its opener, which is
   * the asymmetry the design draws.
   */
  it("keeps an Assets row bound to the pin alone, honouring no detail opener", async () => {
    const strayOpener = vi.fn();
    const onPinnedIdsChange = vi.fn();
    renderStudio("assets", {
      assets: {
        ...assetsModel({ onPinnedIdsChange }),
        onOpenRow: strayOpener,
      } as unknown as CreativeStudioAssetsModel,
    });

    fireEvent.click(
      document.querySelector('[data-creative-studio-asset-row="asset-a"]')!,
    );

    // The pin happened...
    expect(
      document.querySelector('[data-pinned-asset="asset-a"]'),
    ).toBeTruthy();
    await waitFor(() => {
      expect(onPinnedIdsChange).toHaveBeenLastCalledWith(["asset-a"]);
    });
    // ...and nothing else did.
    expect(strayOpener).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("opens the exact metric picker and saves edits into the Custom set", () => {
    renderStudio("assets");

    fireEvent.click(screen.getByRole("button", { name: "+ Edit metrics" }));
    expect(
      document.querySelector("[data-creative-studio-metric-picker]"),
    ).toBeTruthy();
    expect(screen.getByText("edits save as the Custom set")).toBeTruthy();
    // Scoped to the picker: a catalogue label is now also a column header
    // button whenever the visible preset already carries it, so an unscoped
    // role query can match two controls.
    const picker = document.querySelector(
      "[data-creative-studio-metric-picker]",
    )!;
    const option = (label: string) =>
      Array.from(picker.querySelectorAll("button[aria-pressed]")).find(
        (button) => button.textContent?.replace(/[✓↑↓]/g, "").trim() === label,
      )!;

    // "Adds to cart" is not in the Performance set the table opens on, so this
    // is an ADDITION to the twelve already ticked. Twelve, not eleven: the
    // Performance preset gained `Age (days since created)` at the head of its
    // evidence movement.
    fireEvent.click(option("Adds to cart"));

    expect(screen.getByRole("button", { name: "Custom · 13" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(textOf("table th")).toContain("Adds to cart");
    expect(textOf("table th")).toContain("ROAS ↑");

    // ...and a second click removes it again, leaving the twelve the preset had.
    fireEvent.click(option("Adds to cart"));
    expect(screen.getByRole("button", { name: "Custom · 12" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(textOf("table th")).not.toContain("Adds to cart");
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
      expect(
        document.querySelector('[data-pinned-asset="asset-a"]'),
      ).toBeTruthy();
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

    fireEvent.click(
      document.querySelector('[data-creative-studio-asset-row="asset-b"]')!,
    );
    await waitFor(() => {
      const persisted = JSON.parse(
        window.localStorage.getItem(persistenceKey) ?? "{}",
      ) as {
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

/**
 * The four laws that decide whether this table can be read by hand.
 *
 * Each one is written so that it FAILS on a specific defect this surface
 * shipped, not so that it describes the current code:
 *
 *   1. `hold` was a DEFAULT column (Engagement preset and the default Custom
 *      set) whose value the projector hardcoded to `null`, so it was an em dash
 *      in every row of every account.
 *   2. "CVR", "CTR", "ATC rate" and "Clicks" sat in the same table naming no
 *      denominator, while an all-clicks counter and a link-clicks counter are
 *      both plausible and rank creatives differently.
 *   3. Volume columns must stay out of the heat ramp; colouring spend by rank
 *      tells a buyer that the biggest spender is the best creative.
 *   4. A measured zero is a zero and an absence is an em dash, and the two must
 *      never be swapped in either direction.
 */
/**
 * A saved column set survives the catalogue change.
 *
 * The record an operator's browser is holding right now was written by version
 * 1 of this component, whose catalogue had `hold` in it. Two things must not
 * happen when they next open the Studio: a column that no longer exists must
 * not be honoured, and a set that this change emptied must not leave them
 * staring at a table with no metrics in it.
 */
describe("Creative Studio custom-metric persistence across the catalogue change", () => {
  const persistenceKey = "test:creative-studio:migration";

  function storedColumns(): string[] {
    fireEvent.click(screen.getByRole("button", { name: /^Custom/ }));
    return textOf("table th")
      .slice(4, -1)
      .map((text) => text.replace(/[▲▼↑↓]/g, "").trim());
  }

  it("keeps the still-valid half of a version-1 set and drops the retired id", async () => {
    window.localStorage.setItem(
      persistenceKey,
      JSON.stringify({
        version: 1,
        pinnedIds: [],
        customMetrics: ["spend", "hold", "roas"],
      }),
    );
    renderStudio("assets", { assets: assetsModel({ persistenceKey }) });

    await waitFor(() => {
      expect(storedColumns()).toEqual(["Spend", "ROAS"]);
    });
    expect(storedColumns()).not.toContain("Hold 15s");
  });

  it("falls back to the defaults when the catalogue change emptied the whole set", async () => {
    // An operator whose saved view was ONLY the retired metric. Filtering alone
    // would hand them a table with no metric columns at all — this change
    // breaking their view rather than fixing it.
    window.localStorage.setItem(
      persistenceKey,
      JSON.stringify({ version: 1, pinnedIds: [], customMetrics: ["hold"] }),
    );
    renderStudio("assets", { assets: assetsModel({ persistenceKey }) });

    await waitFor(() => {
      expect(storedColumns()).toEqual([
        "Spend",
        "Revenue",
        "ROAS",
        "CPA",
        "CTR (link)",
      ]);
    });
  });

  it("honours a version-2 operator who deliberately un-ticked every metric", async () => {
    // The same `[]` means the opposite thing once the record was written by
    // this version: it is a choice, not an artefact, and it is honoured.
    window.localStorage.setItem(
      persistenceKey,
      JSON.stringify({ version: 2, pinnedIds: [], customMetrics: [] }),
    );
    renderStudio("assets", { assets: assetsModel({ persistenceKey }) });

    await waitFor(() => {
      expect(storedColumns()).toEqual([]);
    });
    // The table is still a table: identity, status and angle remain, so the
    // operator can find the control that puts columns back.
    expect(textOf("table th")).toEqual([
      "",
      "Creative",
      "Status",
      "Marketing angle",
      "",
    ]);
  });

  it("rewrites a migrated record at the current version so it migrates only once", async () => {
    window.localStorage.setItem(
      persistenceKey,
      JSON.stringify({
        version: 1,
        pinnedIds: ["asset-a"],
        customMetrics: ["spend", "hold"],
      }),
    );
    renderStudio("assets", { assets: assetsModel({ persistenceKey }) });

    await waitFor(() => {
      const persisted = JSON.parse(
        window.localStorage.getItem(persistenceKey) ?? "{}",
      ) as {
        version?: number;
        pinnedIds?: string[];
        customMetrics?: string[];
      };
      expect(persisted.version).toBe(2);
      expect(persisted.customMetrics).toEqual(["spend"]);
      // The pinned working set is a list of creative ids, which this change did
      // not touch. Dropping it to migrate a column list would lose a fact.
      expect(persisted.pinnedIds).toEqual(["asset-a"]);
    });
  });
});

describe("Creative Studio column honesty laws", () => {
  const CLASS_OF = studioStyles as unknown as Record<string, string>;

  function headersFor(set: "Performance" | "Engagement" | "Funnel"): string[] {
    fireEvent.click(screen.getByRole("button", { name: set }));
    return textOf("table th")
      .slice(4, -1)
      .map((text) => text.replace(/[▲▼]/g, "").trim());
  }

  function cellsFor(
    set: "Performance" | "Engagement" | "Funnel",
    rowId: string,
  ): string[] {
    fireEvent.click(screen.getByRole("button", { name: set }));
    const row = document.querySelector(
      `[data-creative-studio-asset-row="${rowId}"]`,
    );
    expect(row, `no row ${rowId} on screen`).not.toBeNull();
    return Array.from(row!.querySelectorAll("td"))
      .slice(4, -1)
      .map((cell) => cell.textContent?.trim() ?? "");
  }

  it("puts no metric in a default set that the row shape cannot carry", () => {
    // A row that measured EVERYTHING the catalogue knows. Any em dash below is
    // therefore the surface's doing, not the account's — which is exactly what
    // a permanently blank column is.
    renderStudio("assets");

    for (const set of ["Performance", "Engagement", "Funnel"] as const) {
      const headers = headersFor(set);
      const cells = cellsFor(set, "asset-a");
      expect(headers.length, `${set} has no metric columns`).toBeGreaterThan(0);
      expect(cells).toHaveLength(headers.length);
      const blank = headers.filter((_, index) => cells[index] === "—");
      expect(
        blank,
        `${set} columns blank against a fully measured row`,
      ).toEqual([]);
    }
  });

  it("keeps every default column inside the catalogue and every catalogue id renderable", () => {
    // The other half of the same law: a preset may not name an id the
    // catalogue dropped (it would silently vanish), and the catalogue may not
    // hold an id the row shape cannot express.
    renderStudio("assets");
    const catalogue = new Set<string>();
    fireEvent.click(screen.getByRole("button", { name: "+ Edit metrics" }));
    for (const option of Array.from(
      document.querySelectorAll(
        "[data-creative-studio-metric-picker] button[aria-pressed]",
      ),
    )) {
      catalogue.add(option.textContent?.replace(/[✓↑↓]/g, "").trim() ?? "");
    }
    fireEvent.click(
      screen.getByRole("button", { name: "Close metric picker" }),
    );

    for (const set of ["Performance", "Engagement", "Funnel"] as const) {
      for (const header of headersFor(set)) {
        const label = header.replace(/[↑↓]/g, "").trim();
        expect(
          catalogue,
          `${set} column "${label}" is not in the picker`,
        ).toContain(label);
      }
    }
    expect(catalogue.size).toBe(EVERY_METRIC_ID.length);
    expect(catalogue).not.toContain("Hold 15s");
  });

  it("names the denominator of every rate that has more than one plausible one", () => {
    renderStudio("assets");

    // The Funnel set puts an all-clicks counter and a link-clicks counter in
    // the same row, so a bare "CVR" or "ATC rate" would be a lie by omission.
    const funnel = headersFor("Funnel").map((header) =>
      header.replace(/[↑↓]/g, "").trim(),
    );
    expect(funnel).toContain("CVR (link clicks)");
    expect(funnel).toContain("ATC rate (link clicks)");
    expect(funnel).toContain("CTR (link)");
    expect(funnel).toContain("Link clicks");

    const engagement = headersFor("Engagement").map((h) =>
      h.replace(/[↑↓]/g, "").trim(),
    );
    expect(engagement).toContain("Clicks (all)");
    expect(engagement).toContain("CPC (link)");
    expect(engagement).toContain("CTR (link)");

    // No column anywhere may carry the ambiguous bare name.
    const everyHeader = [
      ...headersFor("Performance"),
      ...headersFor("Engagement"),
      ...headersFor("Funnel"),
    ].map((header) => header.replace(/[↑↓]/g, "").trim());
    for (const ambiguous of [
      "CVR",
      "CTR",
      "Clicks",
      "ATC rate",
      "CPC",
      "Frequency",
    ]) {
      expect(everyHeader, `"${ambiguous}" names no denominator`).not.toContain(
        ambiguous,
      );
    }
  });

  it("never colours a volume column as though more is better", () => {
    renderStudio("assets");

    const heatOf = (
      set: "Performance" | "Engagement" | "Funnel",
      rowId: string,
    ) => {
      fireEvent.click(screen.getByRole("button", { name: set }));
      const headers = headersFor(set).map((header) =>
        header.replace(/[↑↓]/g, "").trim(),
      );
      const row = document.querySelector(
        `[data-creative-studio-asset-row="${rowId}"]`,
      )!;
      const classes = Array.from(row.querySelectorAll("td"))
        .slice(4, -1)
        .map((cell) => cell.firstElementChild?.className ?? "");
      return new Map(
        headers.map((header, index) => [header, classes[index] ?? ""]),
      );
    };

    // asset-b outspends and out-earns asset-a; asset-a has the better ROAS.
    const ranked = new Set([
      CLASS_OF.heatLag,
      CLASS_OF.heatLow,
      CLASS_OF.heatMiddle,
      CLASS_OF.heatGood,
      CLASS_OF.heatLead,
    ]);
    const performance = heatOf("Performance", "asset-b");
    // `Age (days since created)` sits in this list for a different reason from
    // the volumes, and it is the reason that matters: AGE RANKS NOBODY. A
    // 40-day creative is not better or worse than a 2-day one — a warm colour
    // would tell a buyer to scale whatever has survived longest, and a cool one
    // would tell them the newest creative is the winner. Either sign is a
    // verdict this column may not hand anybody, so it is never coloured.
    for (const volume of [
      "Age (days since created)",
      "Spend",
      "Impressions",
      "Revenue",
      "Purchases",
    ]) {
      expect(performance.get(volume), `${volume} is ranked like a score`).toBe(
        CLASS_OF.heatNeutral,
      );
      expect(ranked.has(performance.get(volume) ?? "")).toBe(false);
    }
    // ...while a genuine efficiency column IS ranked, so the assertion above is
    // not passing because nothing is ever coloured.
    expect(ranked.has(performance.get("ROAS") ?? "")).toBe(true);

    const funnel = heatOf("Funnel", "asset-b");
    for (const volume of [
      "Link clicks",
      "Landing page views",
      "Adds to cart",
      "Checkouts",
    ]) {
      expect(funnel.get(volume), `${volume} is ranked like a score`).toBe(
        CLASS_OF.heatNeutral,
      );
    }
  });

  /*
   * The SIGN of every ranked column, pinned per metric.
   *
   * The guard above pins the volume columns to neutral and ROAS to the ranked
   * set. That left the DIRECTION of every efficiency column unpinned, and an
   * adversarial check proved the gap: flipping `cpcLink` from -1 to 1 — the
   * surface claiming the most EXPENSIVE link click is the best — passed all 42
   * files and 517 tests. CPC (link) appears only in the Engagement preset, so
   * even the pinned Performance header list never covered it.
   *
   * A wrong sign does not blank a cell or crash a page: it paints the worst
   * creative green and tells a buyer to scale it. That is the most expensive
   * thing this table can get wrong.
   *
   * This builds its OWN two rows because the shared fixture hands every row
   * the same cpa/cpm/cpcLink/aov/frequency, so a comparison against it would
   * silently assert nothing.
   */
  it("paints every ranked column in the direction the metric actually means", () => {
    const spread = (
      id: string,
      metrics: Partial<Record<CreativeAssetMetricId, number>>,
    ): CreativeStudioAssetRow => ({
      ...asset(id, id, 200, 3),
      id,
      metrics: { ...asset(id, id, 200, 3).metrics, ...metrics },
    });
    // "good" holds the better value of every ranked pair; "bad" the worse.
    const good = spread("row-good", {
      roas: 5,
      aov: 120,
      ctr: 5,
      cvr: 4,
      atcRate: 10,
      atcToPurchase: 40,
      cpa: 5,
      cpm: 4,
      cpcLink: 0.2,
      frequency: 1.1,
    });
    const bad = spread("row-bad", {
      roas: 1,
      aov: 25,
      ctr: 2.25,
      cvr: 0.5,
      atcRate: 6,
      atcToPurchase: 7.5,
      cpa: 73.3,
      cpm: 19,
      cpcLink: 0.44,
      frequency: 4.4,
    });
    render(
      <CreativeStudioExact
        {...baseProps("assets", { assets: assetsModel({ rows: [good, bad] }) })}
      />,
    );

    const RAMP = [
      CLASS_OF.heatLag,
      CLASS_OF.heatLow,
      CLASS_OF.heatMiddle,
      CLASS_OF.heatGood,
      CLASS_OF.heatLead,
    ];
    const rungOf = (
      set: "Performance" | "Engagement" | "Funnel",
      rowId: string,
      label: string,
    ) => {
      fireEvent.click(screen.getByRole("button", { name: set }));
      const headers = headersFor(set).map((header) =>
        header.replace(/[↑↓]/g, "").trim(),
      );
      const index = headers.indexOf(label);
      expect(
        index,
        `${set} has no column named ${label}`,
      ).toBeGreaterThanOrEqual(0);
      const row = document.querySelector(
        `[data-creative-studio-asset-row="${rowId}"]`,
      )!;
      const cells = Array.from(row.querySelectorAll("td")).slice(4, -1);
      const className = cells[index]?.firstElementChild?.className ?? "";
      const rung = RAMP.indexOf(className);
      expect(rung, `${label} is not on the heat ramp`).toBeGreaterThanOrEqual(
        0,
      );
      return rung;
    };

    const CASES: ReadonlyArray<
      [set: "Performance" | "Engagement" | "Funnel", label: string]
    > = [
      ["Performance", "ROAS"],
      ["Performance", "AOV"],
      ["Performance", "CPA"],
      ["Performance", "CPM"],
      ["Engagement", "CPC (link)"],
    ];
    let asserted = 0;
    for (const [set, label] of CASES) {
      const better = rungOf(set, "row-good", label);
      const worse = rungOf(set, "row-bad", label);
      expect(
        better,
        `${label}: the row holding the better value is painted no warmer than the worse one`,
      ).toBeGreaterThan(worse);
      asserted += 1;
    }
    // Guards the guard: a rename that made every label miss would otherwise
    // leave this test asserting nothing.
    expect(asserted).toBe(CASES.length);
  });

  /*
   * A column where every creative shares one value is not a column where every
   * creative is failing. `buildRankLookup` scored a value by how many rows it
   * strictly beats, so a total tie scored 0 and painted the WHOLE column
   * `heatLag`. The shared fixture gives both rows the same CPA, CPM, CPC, AOV
   * and Frequency, so five columns were painting worst-on-every-row in every
   * test in this file and nothing noticed.
   */
  it("does not paint a whole column as worst when every creative ties", () => {
    renderStudio("assets");
    fireEvent.click(screen.getByRole("button", { name: "Performance" }));
    const headers = headersFor("Performance").map((header) =>
      header.replace(/[↑↓]/g, "").trim(),
    );
    for (const label of ["CPA", "CPM"]) {
      const index = headers.indexOf(label);
      expect(
        index,
        `Performance has no column named ${label}`,
      ).toBeGreaterThanOrEqual(0);
      for (const rowId of ["asset-a", "asset-b"]) {
        const row = document.querySelector(
          `[data-creative-studio-asset-row="${rowId}"]`,
        )!;
        const cells = Array.from(row.querySelectorAll("td")).slice(4, -1);
        expect(
          cells[index]?.firstElementChild?.className,
          `${label} on ${rowId} painted worst although every creative ties`,
        ).toBe(CLASS_OF.heatMiddle);
      }
    }
  });

  it("prints a measured zero as 0 and omits wholly unmeasured metric columns", () => {
    const measuredZero: CreativeStudioAssetRow = {
      ...asset("asset-zero", "Zero asset", 0, 0),
      currency: "USD",
      metrics: {
        // Measured: the creative really did earn nothing on real delivery.
        spend: 0,
        impressions: 0,
        // Measured: created on the last day this window covers. Zero days have
        // elapsed since, and that is a fact — the strongest "do not judge this
        // yet" signal the table carries. An em dash here would delete it.
        ageDays: 0,
        revenue: 0,
        clicks: 0,
        linkClicks: 0,
        addToCart: 0,
        purchases: 0,
        // Unmeasured: the producer served no figure at all.
        landingPageViews: null,
        initiateCheckout: null,
        roas: null,
        cpa: null,
        cpm: null,
        cpcLink: null,
        aov: null,
        ctr: null,
        thumbstop: null,
        frequency: null,
        atcRate: null,
        atcToPurchase: null,
        cvr: null,
      },
    };
    renderStudio("assets", {
      assets: assetsModel({ rows: [measuredZero], syncedCount: 1 }),
    });

    const performance = new Map(
      headersFor("Performance").map((header, index) => [
        header.replace(/[↑↓]/g, "").trim(),
        cellsFor("Performance", "asset-zero")[index],
      ]),
    );
    expect(performance.get("Spend")).toBe("$0");
    expect(performance.get("Impressions")).toBe("0");
    expect(performance.get("Age (days since created)")).toBe("0");
    // Revenue is the column this pass added; a measured zero revenue is a fact
    // about the creative, and blanking it would hide the failure.
    expect(performance.get("Revenue")).toBe("$0");
    expect(performance.get("Purchases")).toBe("0");
    expect(performance.has("ROAS")).toBe(false);
    expect(performance.has("CPA")).toBe(false);

    const funnel = new Map(
      headersFor("Funnel").map((header, index) => [
        header.replace(/[↑↓]/g, "").trim(),
        cellsFor("Funnel", "asset-zero")[index],
      ]),
    );
    expect(funnel.get("Link clicks")).toBe("0");
    expect(funnel.get("Adds to cart")).toBe("0");
    // Never served, so the table does not create empty metric columns.
    expect(funnel.has("Landing page views")).toBe(false);
    expect(funnel.has("Checkouts")).toBe(false);
    expect(funnel.has("ATC to purchase")).toBe(false);

    // The same column, the other way round: a creative whose launch date the
    // payload never supplied has NO age, and printing 0 for it would claim it
    // was created on the day the window closed. 0 and the em dash are one
    // character apart on screen and opposite claims in a scale/keep/cut call.
    //
    // A fresh mount rather than a second one alongside the first: two Studios
    // in one document give every control a duplicate and `getByRole` stops
    // being able to name one.
    cleanup();
    renderStudio("assets", {
      assets: assetsModel({
        rows: [
          {
            ...measuredZero,
            id: "asset-ageless",
            metrics: { ...measuredZero.metrics, ageDays: null },
          },
        ],
        syncedCount: 1,
      }),
    });
    const ageless = new Map(
      headersFor("Performance").map((header, index) => [
        header.replace(/[↑↓]/g, "").trim(),
        cellsFor("Performance", "asset-ageless")[index],
      ]),
    );
    expect(ageless.has("Age (days since created)")).toBe(false);
    // ...and the measured zeros beside it are untouched, so only the absent
    // age column is withheld.
    expect(ageless.get("Spend")).toBe("$0");
    expect(ageless.get("Impressions")).toBe("0");
  });

  it("keeps money on the row's own currency and refuses a bare number without one", () => {
    const noCurrency: CreativeStudioAssetRow = {
      ...asset("asset-nc", "No currency", 250, 3.1),
      currency: null,
    };
    renderStudio("assets", {
      assets: assetsModel({ rows: [noCurrency], syncedCount: 1 }),
    });

    const cells = new Map(
      headersFor("Performance").map((header, index) => [
        header.replace(/[↑↓]/g, "").trim(),
        cellsFor("Performance", "asset-nc")[index],
      ]),
    );
    for (const money of ["Spend", "Revenue", "CPA", "CPM", "AOV"]) {
      expect(
        cells.get(money),
        `${money} printed a bare number with no currency`,
      ).toBe("—");
    }
    // The non-money columns are unaffected: an absent currency withholds money,
    // not measurement.
    // `formatNumber` compacts at 10k, so this is the compacted count, not a
    // truncated one.
    expect(cells.get("Impressions")).toBe("25k");
    expect(cells.get("ROAS")).toBe("3.1");
    // An age is a count of days, not an amount of money, so no currency is
    // needed to state it.
    expect(cells.get("Age (days since created)")).toBe("16");
  });
});

describe("CreativeStudioExact source-backed tab shapes", () => {
  it("shows the Copies table without empty angle placeholders", () => {
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

    expect(document.querySelectorAll("[data-copy-angle]")).toHaveLength(0);
    expect(screen.queryByText("Angle coverage")).toBeNull();
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

  it("keeps the Meta-only Landing table without empty companion panels", () => {
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
    expect(screen.queryByText("What’s missing")).toBeNull();
    expect(screen.queryByText("What to try")).toBeNull();
    expect(screen.queryByText("Destination history")).toBeNull();
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

  /**
   * THE INBOX SEGMENTS ARE THE ENGINE'S OWN SERVED SECTIONS.
   *
   * The lanes this replaces were Requested / In production / Delivered / Live —
   * a creative-production pipeline with no producer anywhere in the product (no
   * workflow status, owner, due date, version or approval is recorded; see
   * `CreativeInboxColumnId` for the greps). Four columns named after that
   * pipeline asserted it existed no matter what caption sat beneath them.
   *
   * What is pinned here now:
   *
   *   1. three segments, named after the briefing authority's own served
   *      sections, drawn in the authority's own order;
   *   2. a served card renders the engine's label and one-line summary and its
   *      measured facts — and an unmeasured fact is an em dash, not a zero;
   *   3. no owner avatar, no due date, and no action button, because none of
   *      those is a thing this product records or can do from here;
   *   4. no upload drop zone, because there is no multipart handler and no
   *      storage dependency in this tree.
   */
  it("draws the three served briefing segments and no workflow affordance", () => {
    renderStudio("inbox", {
      inbox: {
        state: "ready",
        message: null,
        columns: [
          {
            id: "watching",
            name: "Watching",
            tone: "info",
            cards: [
              {
                id: "served-card",
                source: "Watch",
                sourceTone: "info",
                name: "Served creative",
                note: "Spend is below the review floor.",
                facts: [
                  { label: "Spend", value: "$1,204" },
                  { label: "ROAS", value: null },
                ],
              },
            ],
          },
        ],
      },
    });

    expect(
      textOf("[data-inbox-column] > div:first-child").map((text) =>
        text.replace(/\d+$/, ""),
      ),
    ).toEqual(["Action now", "Watching", "Healthy"]);
    // The card lands in the segment the authority served it in.
    expect(
      document.querySelector(
        '[data-inbox-column="watching"] [data-inbox-card="served-card"]',
      ),
    ).toBeTruthy();
    expect(screen.getByText("Served creative")).toBeTruthy();
    expect(screen.getByText("Spend is below the review floor.")).toBeTruthy();
    // Measured value printed; unmeasured value is an em dash, never a zero.
    expect(
      document.querySelector('[data-inbox-fact="Spend"]')?.textContent,
    ).toContain("$1,204");
    expect(
      document.querySelector('[data-inbox-fact="ROAS"]')?.textContent,
    ).toContain("—");
    expect(
      document.querySelector('[data-inbox-fact="ROAS"]')?.textContent,
    ).not.toContain("0");

    // Nothing on this surface claims a request, version, approval or handoff.
    expect(screen.queryByText("Drop new exports here")).toBeNull();
    expect(screen.queryByRole("button", { name: /Browse files/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /approve/i })).toBeNull();
    expect(document.body.textContent).not.toContain("are not built");
  });

  it("shows one useful Audience state without empty summary or matrix placeholders", () => {
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

    expect(document.querySelectorAll("[data-audience-summary]")).toHaveLength(
      0,
    );
    expect(document.querySelectorAll("[data-audience-breakdown]")).toHaveLength(
      0,
    );
    expect(screen.queryByText("Creative × audience matrix")).toBeNull();
    expect(textOf("table th")).toEqual([]);
    expect(screen.getByText("Select a Meta account to continue.")).toBeTruthy();
    expect(
      screen.queryByText("Audience dimensions were not served."),
    ).toBeNull();
    expect(document.body.textContent).not.toContain("Broad US");
    expect(document.body.textContent).not.toContain("Retarg 7d");
    expect(document.body.textContent).not.toContain("Carousel — 5 SKUs");
  });
});
