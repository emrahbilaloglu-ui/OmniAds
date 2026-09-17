// @vitest-environment jsdom

import React, { useState } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { OverviewMetricCardData, OverviewMetricCatalogEntry } from "@/src/types/models";
import { CustomizableKpiBand } from "./customizable-kpi-band";

function metric(
  id: string,
  title: string,
  overrides: Partial<OverviewMetricCardData> = {},
): OverviewMetricCardData {
  return {
    id,
    title,
    value: 100,
    previousValue: 90,
    changePct: 11.1,
    sparklineData: [
      { date: "2026-09-01", value: 90 },
      { date: "2026-09-02", value: 100 },
    ],
    previousSparklineData: [],
    trendDirection: "up",
    trendSentiment: "positive",
    dataSource: { key: "shopify", label: "Shopify" },
    status: "available",
    unit: "count",
    ...overrides,
  };
}

function entry(
  key: string,
  title: string,
  section = "pins",
  overrides: Partial<OverviewMetricCardData> = {},
): OverviewMetricCatalogEntry {
  return { key, title, section, metric: metric(`metric-${key}`, title, overrides) };
}

const REVENUE = entry("revenue", "Revenue", "pins", { unit: "currency" });
const SPEND = entry("spend", "Ad Spend", "pins", { unit: "currency" });
const ORDERS = entry("orders", "Orders");
const AOV = entry("aov", "Average Order Value", "storeMetrics", { unit: "currency" });
const SESSIONS = entry("sessions", "Sessions", "webAnalytics");
const MER = {
  ...entry("mer", "MER", "pins", { unit: "ratio", subtitle: "Store revenue ÷ total ad spend" }),
  metric: metric("pins-mer", "MER", { unit: "ratio", subtitle: "Store revenue ÷ total ad spend" }),
};
const LTV = entry("ltv-90d", "90-day LTV", "ltv", {
  value: null,
  status: "unavailable",
  helperText: "Needs 90 days of Shopify orders",
  unit: "currency",
});

/** A stateful host so draft changes re-render like the page does. */
function DraftHost({
  catalog,
  initialKeys,
  defaultKeys = initialKeys,
  onChange,
}: {
  catalog: OverviewMetricCatalogEntry[];
  initialKeys: string[];
  defaultKeys?: string[];
  onChange?: (keys: string[]) => void;
}) {
  const [keys, setKeys] = useState(initialKeys);
  return (
    <CustomizableKpiBand
      catalog={catalog}
      keys={keys}
      defaultKeys={defaultKeys}
      currencySymbol="$"
      editing
      onKeysChange={(next) => {
        setKeys(next);
        onChange?.(next);
      }}
    />
  );
}

function addMetricButtons() {
  return screen.getAllByRole("button", { name: /Add metric/ });
}

function renderedKeys(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLElement>("[data-kpi-key]"), (node) => node.dataset.kpiKey);
}

afterEach(cleanup);

describe("CustomizableKpiBand reading mode", () => {
  it("renders saved KPIs in order, first as primary, with balanced spans for every width tier", () => {
    const catalog = [AOV, REVENUE, SPEND, ORDERS, SESSIONS];
    const { container } = render(
      <CustomizableKpiBand
        catalog={catalog}
        keys={catalog.map((item) => item.key)}
        defaultKeys={[]}
        currencySymbol="$"
        onKeysChange={vi.fn()}
      />,
    );
    const slots = Array.from(container.querySelectorAll<HTMLElement>("[data-overview-kpi-slot]"));

    expect(slots.map((slot) => slot.dataset.overviewKpiSlot)).toEqual([
      "primary",
      "supporting",
      "supporting",
      "supporting",
      "supporting",
    ]);
    expect(
      slots.map((slot) => slot.querySelector("[data-overview-metric-id]")?.getAttribute("data-overview-metric-id")),
    ).toEqual(catalog.map((item) => item.metric.id));
    // Five cards: 3 + 2 on wide and medium (no stretched single card), 2 + 2 + 1 on phones.
    expect(slots.map((slot) => slot.style.getPropertyValue("--kpi-span-wide"))).toEqual(["4", "4", "4", "6", "6"]);
    expect(slots.map((slot) => slot.style.getPropertyValue("--kpi-span-medium"))).toEqual(["4", "4", "4", "6", "6"]);
    expect(slots.map((slot) => slot.style.getPropertyValue("--kpi-span-small"))).toEqual(["6", "6", "6", "6", "12"]);
    expect(slots.map((slot) => slot.style.getPropertyValue("--kpi-span-narrow"))).toEqual(["12", "12", "12", "12", "12"]);
    expect(container.querySelector('[data-kpi-value="primary"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-kpi-value="tile"]')).toHaveLength(4);
  });

  it("is read-only outside a customize session: no second entry point and no edit controls", () => {
    const { container } = render(
      <CustomizableKpiBand
        catalog={[REVENUE, SPEND, ORDERS]}
        keys={["revenue", "spend", "orders"]}
        defaultKeys={["revenue", "spend", "orders"]}
        currencySymbol="$"
        onKeysChange={vi.fn()}
      />,
    );

    expect(screen.getByText("3 metrics")).toBeInTheDocument();
    // The page header's Customize is the only way in; the band adds no button of its own.
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(container.querySelector("[draggable]")).toBeNull();
    expect(screen.queryByText("Restore defaults")).toBeNull();
  });

  it("keeps an unavailable saved KPI visible with its reason and source instead of a zero", () => {
    const conversion = entry("conversion_rate", "Conversion rate", "pins", {
      value: null,
      previousValue: null,
      changePct: null,
      sparklineData: [],
      status: "unavailable",
      helperText: "Shopify session tracking is unavailable for this period",
      unit: "percent",
    });
    const { container } = render(
      <CustomizableKpiBand
        catalog={[REVENUE, conversion]}
        keys={["revenue", "conversion_rate", "retired_metric"]}
        defaultKeys={[]}
        currencySymbol="$"
        onKeysChange={vi.fn()}
      />,
    );

    expect(screen.getByText("Shopify session tracking is unavailable for this period")).toBeInTheDocument();
    expect(screen.getByText("Source · Shopify")).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "Conversion rate trend" })).toBeNull();
    // A key the catalog no longer serves stays on the band, honestly unavailable.
    expect(renderedKeys(container)).toEqual(["revenue", "conversion_rate", "retired_metric"]);
    expect(screen.getByText("This saved metric is not available from the current data source.")).toBeInTheDocument();
  });

  it("points an empty band at Customize instead of adding a duplicate button", () => {
    render(
      <CustomizableKpiBand catalog={[]} keys={[]} defaultKeys={[]} currencySymbol="$" onKeysChange={vi.fn()} />,
    );
    expect(screen.getByText("No headline KPIs selected")).toBeInTheDocument();
    expect(screen.getByText("Use Customize above to choose metrics.")).toBeInTheDocument();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("shows skeleton cards while the first summary loads", () => {
    const { container } = render(
      <CustomizableKpiBand
        catalog={[]}
        keys={[]}
        defaultKeys={[]}
        currencySymbol="$"
        loading
        onKeysChange={vi.fn()}
      />,
    );
    expect(container.querySelector('[data-el="home-kpis"]')).toHaveAttribute("aria-busy", "true");
    expect(screen.getByText("Loading")).toBeInTheDocument();
    expect(screen.queryByText("No headline KPIs selected")).toBeNull();
  });
});

describe("CustomizableKpiBand customize mode", () => {
  it("allows layout work against honest catalog placeholders while the data read is still loading", () => {
    const unavailableRevenue = entry("revenue", "Revenue", "pins", {
      value: null,
      status: "unavailable",
      helperText: "No verified data for this window",
      unit: "currency",
    });
    const { container } = render(
      <CustomizableKpiBand
        catalog={[unavailableRevenue, SPEND]}
        keys={["revenue", "spend"]}
        defaultKeys={["revenue", "spend"]}
        currencySymbol="$"
        loading
        editing
        onKeysChange={vi.fn()}
      />,
    );

    expect(renderedKeys(container)).toEqual(["revenue", "spend"]);
    expect(screen.getByText("No verified data for this window")).toBeInTheDocument();
    expect(addMetricButtons()).toHaveLength(1);
    expect(container.querySelector('[data-el="home-kpis"]')).not.toHaveAttribute("aria-busy");
  });

  it("moves a card with its buttons, keeps focus on the pressed control, and announces the result", () => {
    const onChange = vi.fn();
    const { container } = render(
      <DraftHost catalog={[REVENUE, SPEND, ORDERS]} initialKeys={["revenue", "spend", "orders"]} onChange={onChange} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Move Revenue later" }));
    expect(renderedKeys(container)).toEqual(["spend", "revenue", "orders"]);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Move Revenue later" }));
    expect(screen.getByRole("status")).toHaveTextContent("Revenue moved to position 2 of 3.");
    // The first card is always the primary one, whichever metric it is.
    expect(container.querySelector('[data-overview-kpi-slot="primary"]')).toHaveAttribute("data-kpi-key", "spend");

    const earliest = screen.getByRole("button", { name: "Move Ad Spend earlier" });
    expect(earliest).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(earliest);
    expect(renderedKeys(container)).toEqual(["spend", "revenue", "orders"]);
    expect(screen.getByRole("status")).toHaveTextContent("Ad Spend is already first.");
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("gives each card exactly one control per action and a single add path", () => {
    const { container } = render(
      <DraftHost catalog={[REVENUE, SPEND, ORDERS, AOV]} initialKeys={["revenue", "spend", "orders"]} />,
    );

    const revenueControls = within(screen.getByRole("group", { name: "Revenue, position 1 of 3" }));
    expect(revenueControls.getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual([
      "Move Revenue earlier",
      "Move Revenue later",
      "Remove Revenue",
    ]);
    // The grip is decorative; it is not another focusable reorder control.
    expect(container.querySelectorAll("[data-kpi-control]")).toHaveLength(9);
    expect(addMetricButtons()).toHaveLength(1);
    expect(addMetricButtons()[0]).toHaveAttribute("data-kpi-add-tile");
    expect(screen.getAllByRole("button", { name: "Restore defaults" })).toHaveLength(1);
    expect(within(container).getByRole("list", { name: "KPI order" }).lastElementChild).toHaveAttribute(
      "data-kpi-add-item",
    );
  });

  it("reorders by drag and drop", () => {
    const { container } = render(
      <DraftHost catalog={[REVENUE, SPEND, ORDERS]} initialKeys={["revenue", "spend", "orders"]} />,
    );
    const items = () => Array.from(container.querySelectorAll<HTMLElement>("[data-kpi-key]"));
    const dataTransfer = { effectAllowed: "", dropEffect: "", setData: vi.fn(), getData: () => "orders" };

    fireEvent.dragStart(items()[2]!, { dataTransfer });
    fireEvent.dragOver(items()[0]!, { dataTransfer });
    expect(items()[0]).toHaveAttribute("data-drop-target", "true");
    fireEvent.drop(items()[0]!, { dataTransfer });

    expect(renderedKeys(container)).toEqual(["orders", "revenue", "spend"]);
    expect(container.querySelector("[data-drop-target]")).toBeNull();
    expect(container.querySelector("[data-dragging]")).toBeNull();
  });

  it("removes a card and moves focus to the neighbouring remove button, then to the add tile", () => {
    const { container } = render(<DraftHost catalog={[REVENUE, SPEND]} initialKeys={["revenue", "spend"]} />);

    fireEvent.click(screen.getByRole("button", { name: "Remove Revenue" }));
    expect(renderedKeys(container)).toEqual(["spend"]);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Remove Ad Spend" }));
    expect(screen.getByRole("status")).toHaveTextContent("Revenue removed. 1 KPI left.");

    fireEvent.click(screen.getByRole("button", { name: "Remove Ad Spend" }));
    expect(renderedKeys(container)).toEqual([]);
    expect(document.activeElement).toHaveAttribute("data-kpi-add-tile");
    // Customize mode never shows the reading-mode empty state; the add tile is the way back.
    expect(screen.queryByText("No headline KPIs selected")).toBeNull();
  });

  it("adds a metric from a searchable, grouped picker that explains blocked options", async () => {
    const onChange = vi.fn();
    const { container } = render(
      <DraftHost
        catalog={[REVENUE, SPEND, AOV, SESSIONS, MER, LTV]}
        initialKeys={["revenue", "spend"]}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Add metric" }));
    const picker = await screen.findByRole("dialog", { name: "Add a KPI" });
    expect(within(picker).getByRole("group", { name: "Shopify store" })).toBeInTheDocument();
    expect(within(picker).getByRole("group", { name: "Web analytics" })).toBeInTheDocument();

    const revenueOption = within(picker).getByRole("button", { name: /Revenue/ });
    expect(revenueOption).toHaveAttribute("aria-disabled", "true");
    expect(revenueOption).toHaveTextContent("Already on the band");
    fireEvent.click(revenueOption);
    expect(onChange).not.toHaveBeenCalled();

    const ltvOption = within(picker).getByRole("button", { name: /90-day LTV/ });
    expect(ltvOption).toHaveAttribute("aria-disabled", "true");
    expect(ltvOption).toHaveTextContent("Needs 90 days of Shopify orders");
    // Blended ROAS and MER carry their definitions so they are never confused.
    expect(within(picker).getByRole("button", { name: /MER/ })).toHaveTextContent("Store revenue ÷ total ad spend");

    fireEvent.change(within(picker).getByRole("searchbox", { name: "Search metrics" }), {
      target: { value: "order val" },
    });
    expect(within(picker).queryByRole("button", { name: /Sessions/ })).toBeNull();
    fireEvent.click(within(picker).getByRole("button", { name: /Average Order Value/ }));

    expect(renderedKeys(container)).toEqual(["revenue", "spend", "aov"]);
    expect(screen.queryByRole("dialog", { name: "Add a KPI" })).toBeNull();
    // The new card lands last, so focus waits on the move that is useful next.
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Move Average Order Value earlier" }));
    expect(screen.getByRole("status")).toHaveTextContent("Average Order Value added at position 3.");
  });

  it("says when no metric matches the search", async () => {
    render(<DraftHost catalog={[REVENUE, SPEND]} initialKeys={["revenue"]} />);
    fireEvent.click(screen.getByRole("button", { name: "Add metric" }));
    const picker = await screen.findByRole("dialog", { name: "Add a KPI" });
    fireEvent.change(within(picker).getByRole("searchbox", { name: "Search metrics" }), {
      target: { value: "zzz" },
    });
    expect(within(picker).getByText("No metrics match “zzz”.")).toBeInTheDocument();
  });

  it("restores defaults into the draft and disables the action once at defaults", () => {
    const onChange = vi.fn();
    const { container } = render(
      <DraftHost
        catalog={[REVENUE, SPEND, ORDERS, AOV]}
        initialKeys={["aov", "orders"]}
        defaultKeys={["revenue", "spend", "orders"]}
        onChange={onChange}
      />,
    );

    const restore = screen.getByRole("button", { name: "Restore defaults" });
    expect(restore).not.toHaveAttribute("aria-disabled");
    fireEvent.click(restore);
    expect(renderedKeys(container)).toEqual(["revenue", "spend", "orders"]);
    expect(restore).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(restore);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("balances the add tile into the grid and drops phones to one card per row", () => {
    const { container } = render(
      <DraftHost catalog={[REVENUE, SPEND, ORDERS]} initialKeys={["revenue", "spend", "orders"]} />,
    );
    const gridItems = Array.from(container.querySelectorAll<HTMLElement>('[data-el="home-kpis"] > *'));
    expect(gridItems).toHaveLength(4);
    expect(gridItems.map((node) => node.style.getPropertyValue("--kpi-span-wide"))).toEqual(["3", "3", "3", "3"]);
    expect(gridItems.map((node) => node.style.getPropertyValue("--kpi-span-small"))).toEqual([
      "12",
      "12",
      "12",
      "12",
    ]);
    expect(within(container).getByRole("list", { name: "KPI order" })).toBeInTheDocument();
  });
});
