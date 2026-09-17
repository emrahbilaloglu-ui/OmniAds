// @vitest-environment jsdom

import React, { useState } from "react";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  OVERVIEW_LAYOUT_STORAGE_PREFIX,
  OverviewLayout,
  defaultOverviewLayout,
  packOverviewLayout,
  parseOverviewLayout,
  sameOverviewLayout,
  useOverviewLayoutPreference,
  type LayoutEntry,
  type OverviewLayoutContent,
} from "./overview-layout";

const items: OverviewLayoutContent[] = [
  { id: "trend", content: <div>Trend content</div> },
  { id: "attribution", content: <div>Attribution content</div> },
];

function LayoutHost({
  initial = defaultOverviewLayout(),
  onChange,
  layoutItems = items,
}: {
  initial?: LayoutEntry[];
  onChange?: (next: LayoutEntry[]) => void;
  layoutItems?: OverviewLayoutContent[];
}) {
  const [layout, setLayout] = useState(initial);
  return (
    <OverviewLayout
      layout={layout}
      editing
      items={layoutItems}
      onLayoutChange={(next) => {
        setLayout(next);
        onChange?.(next);
      }}
    />
  );
}

function renderedIds(container: HTMLElement) {
  return Array.from(container.querySelectorAll("[data-layout-id]"), (node) => node.getAttribute("data-layout-id"));
}

beforeEach(() => window.localStorage.clear());
afterEach(cleanup);

describe("Overview layout parsing and packing", () => {
  it("repairs malformed entries, ignores the retired source tile, and normalizes fixed platform widths", () => {
    const repaired = parseOverviewLayout(
      JSON.stringify({
        version: 1,
        entries: [
          { id: "source-readiness", size: "compact" },
          { id: "trend", size: "full" },
          { id: "attribution", size: "compact" },
          { id: "meta-platform", size: "half" },
          { id: "google-platform", size: "half" },
          { id: "trend", size: "half" },
        ],
      }),
    );
    expect(repaired?.find((entry) => entry.id === "attribution")).toEqual({
      id: "attribution",
      size: "full",
    });
    expect(repaired?.filter((entry) => entry.id === "trend")).toHaveLength(1);
    expect(repaired?.find((entry) => entry.id === "meta-platform")?.size).toBe("full");
    expect(repaired?.find((entry) => entry.id === "google-platform")?.size).toBe("full");
    expect(repaired?.some((entry) => (entry.id as string) === "source-readiness")).toBe(false);

    const parsed = parseOverviewLayout(
      JSON.stringify({ version: 1, entries: [{ id: "trend", size: "full" }] }),
    );
    expect(parsed?.[0]).toEqual({ id: "trend", size: "full" });
    expect(parsed?.some((entry) => entry.id === "web-analytics")).toBe(true);
    expect(parsed!.findIndex((entry) => entry.id === "meta-morning")).toBeLessThan(
      parsed!.findIndex((entry) => entry.id === "attribution"),
    );
  });

  it("fills incomplete visual rows without changing DOM order", () => {
    expect(
      packOverviewLayout([
        { id: "meta-morning", size: "compact" },
        { id: "trend", size: "half" },
        { id: "economics", size: "full" },
      ]),
    ).toEqual([
      { id: "meta-morning", size: "compact", span: 4 },
      { id: "trend", size: "half", span: 8 },
      { id: "economics", size: "full", span: 12 },
    ]);
  });

  it("compares layouts by order and size", () => {
    const layout = defaultOverviewLayout();
    expect(sameOverviewLayout(layout, defaultOverviewLayout())).toBe(true);
    expect(sameOverviewLayout(layout, [...layout].reverse())).toBe(false);
    expect(sameOverviewLayout(layout, layout.map((entry, index) => (index === 0 ? { ...entry, size: "full" } : entry)))).toBe(false);
  });
});

describe("OverviewLayout editor", () => {
  it("sends moves and widths to the draft without touching storage", () => {
    const onChange = vi.fn();
    const { container } = render(<LayoutHost onChange={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: "Move Spend & ROAS later" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Attribution by channel width" }), {
      target: { value: "wide" },
    });

    expect(renderedIds(container)).toEqual(["attribution", "trend"]);
    expect(container.querySelector('[data-layout-id="attribution"]')).toHaveAttribute("data-layout-size", "wide");
    const movedControl = screen.getByRole("button", { name: "Move Spend & ROAS later" });
    expect(movedControl).toHaveAttribute("aria-disabled", "true");
    expect(document.activeElement).toBe(movedControl);
    fireEvent.click(movedControl);
    expect(screen.getByRole("status")).toHaveTextContent("Spend & ROAS is already last.");
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(window.localStorage.length).toBe(0);
  });

  it("restores the default layout into the draft, once", () => {
    const moved = defaultOverviewLayout().reverse();
    const onChange = vi.fn();
    const { container } = render(<LayoutHost initial={moved} onChange={onChange} />);

    const restore = screen.getByRole("button", { name: "Restore default layout" });
    expect(restore).not.toHaveAttribute("aria-disabled");
    fireEvent.click(restore);
    expect(renderedIds(container)).toEqual(["trend", "attribution"]);
    expect(restore).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(restore);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(window.localStorage.length).toBe(0);
  });

  it("renders no editor controls outside a customize session", () => {
    render(
      <OverviewLayout layout={defaultOverviewLayout()} editing={false} items={items} onLayoutChange={vi.fn()} />,
    );
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("shows fixed platform width as text instead of a one-option selector", () => {
    render(<LayoutHost layoutItems={[{ id: "meta-platform", content: <div>Meta platform</div> }]} />);

    expect(screen.getByText("Full width")).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Meta Ads dashboard width" })).toBeNull();
  });
});

describe("useOverviewLayoutPreference", () => {
  it("reads per business, writes only on save, and clears storage when saving the default", () => {
    const keyA = `${OVERVIEW_LAYOUT_STORAGE_PREFIX}business-a`;
    const moved = defaultOverviewLayout().reverse();
    window.localStorage.setItem(`${OVERVIEW_LAYOUT_STORAGE_PREFIX}business-b`, JSON.stringify({ version: 1, entries: moved }));

    const { result, rerender } = renderHook(({ businessId }) => useOverviewLayoutPreference(businessId), {
      initialProps: { businessId: "business-a" },
    });
    expect(result.current.layout).toEqual(defaultOverviewLayout());
    expect(window.localStorage.getItem(keyA)).toBeNull();

    act(() => result.current.saveLayout(moved));
    expect(result.current.layout).toEqual(moved);
    expect(window.localStorage.getItem(keyA)).toContain('"entries"');

    rerender({ businessId: "business-b" });
    expect(result.current.layout[0]?.id).toBe(moved[0]?.id);

    rerender({ businessId: "business-a" });
    act(() => result.current.saveLayout(defaultOverviewLayout()));
    expect(window.localStorage.getItem(keyA)).toBeNull();
    expect(result.current.layout).toEqual(defaultOverviewLayout());
  });
});
