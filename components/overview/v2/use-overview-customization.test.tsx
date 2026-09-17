// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { defaultOverviewLayout, type LayoutEntry } from "./overview-layout";
import { useOverviewCustomization } from "./use-overview-customization";

type Props = {
  context: string;
  savedKpiKeys: string[];
  defaultKpiKeys: string[];
  savedLayout: LayoutEntry[];
};

function setup(initial: Partial<Props> = {}) {
  const onSaveKpis = vi.fn();
  const onRestoreKpiDefaults = vi.fn();
  const onSaveLayout = vi.fn();
  const initialProps: Props = {
    context: "owner:biz-a",
    savedKpiKeys: ["revenue", "spend"],
    defaultKpiKeys: ["revenue", "spend"],
    savedLayout: defaultOverviewLayout(),
    ...initial,
  };
  const hook = renderHook(
    (props: Props) => useOverviewCustomization({ ...props, onSaveKpis, onRestoreKpiDefaults, onSaveLayout }),
    { initialProps },
  );
  return { ...hook, initialProps, onSaveKpis, onRestoreKpiDefaults, onSaveLayout };
}

afterEach(cleanup);

describe("useOverviewCustomization", () => {
  it("shows saved values until a session starts and edits only the draft", () => {
    const { result, onSaveKpis, onSaveLayout } = setup();
    expect(result.current.editing).toBe(false);
    expect(result.current.kpiKeys).toEqual(["revenue", "spend"]);

    // Draft setters are inert outside a session.
    act(() => result.current.setKpiKeys(["orders"]));
    expect(result.current.editing).toBe(false);
    expect(result.current.kpiKeys).toEqual(["revenue", "spend"]);

    act(() => result.current.start());
    act(() => result.current.setKpiKeys(["spend", "revenue", "spend"]));
    expect(result.current.kpiKeys).toEqual(["spend", "revenue"]);
    expect(result.current.dirty).toBe(true);
    expect(onSaveKpis).not.toHaveBeenCalled();
    expect(onSaveLayout).not.toHaveBeenCalled();
  });

  it("discards everything on cancel", () => {
    const { result, onSaveKpis, onRestoreKpiDefaults, onSaveLayout } = setup();
    act(() => result.current.start());
    act(() => result.current.setKpiKeys(["orders"]));
    act(() => result.current.setLayout(defaultOverviewLayout().reverse()));
    act(() => result.current.cancel());

    expect(result.current.editing).toBe(false);
    expect(result.current.kpiKeys).toEqual(["revenue", "spend"]);
    expect(result.current.layout).toEqual(defaultOverviewLayout());
    expect(onSaveKpis).not.toHaveBeenCalled();
    expect(onRestoreKpiDefaults).not.toHaveBeenCalled();
    expect(onSaveLayout).not.toHaveBeenCalled();
  });

  it("saves only the parts that changed", () => {
    const { result, onSaveKpis, onSaveLayout } = setup();
    act(() => result.current.start());
    act(() => result.current.setKpiKeys(["spend", "revenue"]));
    act(() => result.current.save());
    expect(onSaveKpis).toHaveBeenCalledWith(["spend", "revenue"]);
    expect(onSaveLayout).not.toHaveBeenCalled();
    expect(result.current.editing).toBe(false);

    const second = setup();
    const reversed = defaultOverviewLayout().reverse();
    act(() => second.result.current.start());
    act(() => second.result.current.setLayout(reversed));
    act(() => second.result.current.save());
    expect(second.onSaveLayout).toHaveBeenCalledWith(reversed);
    expect(second.onSaveKpis).not.toHaveBeenCalled();
  });

  it("treats edits that return to the starting state as no change", () => {
    const { result, onSaveKpis, onSaveLayout } = setup();
    act(() => result.current.start());
    act(() => result.current.setKpiKeys(["spend", "revenue"]));
    act(() => result.current.setKpiKeys(["revenue", "spend"]));
    expect(result.current.dirty).toBe(false);
    act(() => result.current.save());
    expect(onSaveKpis).not.toHaveBeenCalled();
    expect(onSaveLayout).not.toHaveBeenCalled();
  });

  it("never saves because live defaults moved underneath an untouched session", () => {
    // No stored pins: the saved keys are the live defaults, and a refetch changes them mid-session.
    const { result, rerender, initialProps, onSaveKpis, onRestoreKpiDefaults } = setup({
      savedKpiKeys: ["revenue", "spend"],
      defaultKpiKeys: ["revenue", "spend"],
    });
    act(() => result.current.start());
    rerender({
      ...initialProps,
      savedKpiKeys: ["revenue", "spend", "conversion_rate"],
      defaultKpiKeys: ["revenue", "spend", "conversion_rate"],
    });
    expect(result.current.dirty).toBe(false);
    act(() => result.current.save());
    expect(onSaveKpis).not.toHaveBeenCalled();
    expect(onRestoreKpiDefaults).not.toHaveBeenCalled();
  });

  it("clears stored pins instead of freezing a copy when the owner restores defaults", () => {
    const { result, onSaveKpis, onRestoreKpiDefaults } = setup({
      savedKpiKeys: ["aov", "orders"],
      defaultKpiKeys: ["revenue", "spend"],
    });
    act(() => result.current.start());
    act(() => result.current.restoreKpiDefaults());
    expect(result.current.kpiKeys).toEqual(["revenue", "spend"]);
    act(() => result.current.save());
    expect(onRestoreKpiDefaults).toHaveBeenCalledTimes(1);
    expect(onSaveKpis).not.toHaveBeenCalled();

    // Editing after a restore makes it an explicit choice again.
    const edited = setup({ savedKpiKeys: ["aov"], defaultKpiKeys: ["revenue", "spend"] });
    act(() => edited.result.current.start());
    act(() => edited.result.current.restoreKpiDefaults());
    act(() => edited.result.current.setKpiKeys(["spend", "revenue"]));
    act(() => edited.result.current.save());
    expect(edited.onSaveKpis).toHaveBeenCalledWith(["spend", "revenue"]);
    expect(edited.onRestoreKpiDefaults).not.toHaveBeenCalled();
  });

  it("drops a session when the business changes and does not resume it on the way back", () => {
    const { result, rerender, initialProps, onSaveKpis } = setup();
    act(() => result.current.start());
    act(() => result.current.setKpiKeys(["orders"]));

    rerender({ ...initialProps, context: "owner:biz-b" });
    expect(result.current.editing).toBe(false);
    act(() => result.current.save());

    rerender(initialProps);
    expect(result.current.editing).toBe(false);
    expect(result.current.kpiKeys).toEqual(["revenue", "spend"]);
    expect(onSaveKpis).not.toHaveBeenCalled();
  });
});
