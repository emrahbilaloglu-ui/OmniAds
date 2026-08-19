// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DateRangeValue } from "@/components/date-range/DateRangePicker";

/**
 * The shell's date control used to write a preferences store and nothing else.
 * A store is invisible to a server-rendered surface and was read by only three
 * of the nine Meta surfaces, so the control at the top of the screen changed a
 * label and left every request underneath it alone.
 *
 * The URL is the authority now. These are the rules that follow from that: a
 * stated window outranks the stored one, moving the control states a window,
 * and a window that is not a window states nothing at all.
 */
const routerReplace = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

const { usePersistentDateRange, useCanonicalDateWindowUrl } = await import(
  "@/hooks/use-persistent-date-range"
);
const { usePreferencesStore } = await import("@/store/preferences-store");

function Probe({ referenceDate }: { referenceDate?: string }) {
  const [value, setValue] = usePersistentDateRange(referenceDate);
  return (
    <div>
      <span data-testid="preset">{value.rangePreset}</span>
      <span data-testid="start">{value.customStart}</span>
      <span data-testid="end">{value.customEnd}</span>
      <button
        type="button"
        onClick={() =>
          setValue({
            rangePreset: "7d",
            customStart: "",
            customEnd: "",
            comparisonPreset: "previousPeriod",
            comparisonStart: "",
            comparisonEnd: "",
          })
        }
      >
        pick 7d
      </button>
    </div>
  );
}

/**
 * The shell, in miniature: the picker and the one canonicalizer that states
 * its window, mounted together. They are always mounted together in the real
 * tree — `AppTopbar` renders both — which is what makes "the URL is the
 * authority" a fact rather than a hope.
 */
function ShellProbe({
  referenceDate,
  enabled = true,
}: {
  referenceDate: string;
  enabled?: boolean;
}) {
  useCanonicalDateWindowUrl({
    referenceDate,
    enabled,
    navigate: routerReplace,
  });
  return <Probe referenceDate={referenceDate} />;
}

const storedCustom: DateRangeValue = {
  rangePreset: "custom",
  customStart: "2026-05-01",
  customEnd: "2026-05-28",
  comparisonPreset: "previousPeriod",
  comparisonStart: "",
  comparisonEnd: "",
};

describe("the shell date window", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/platforms/meta");
    usePreferencesStore.setState({ dashboardDateRange: null });
    routerReplace.mockReset();
  });

  afterEach(() => cleanup());

  it("reproduces the window a pasted link names, over the one this browser stored", () => {
    usePreferencesStore.getState().setDashboardDateRange(storedCustom);
    window.history.replaceState(
      null,
      "",
      "/platforms/meta?window=custom&startDate=2026-07-01&endDate=2026-07-14",
    );

    render(<Probe />);

    expect(screen.getByTestId("start").textContent).toBe("2026-07-01");
    expect(screen.getByTestId("end").textContent).toBe("2026-07-14");
    expect(screen.getByTestId("preset").textContent).toBe("custom");
  });

  /**
   * REWRITTEN for ITEM 10. This test used to assert that with no window on the
   * URL the hook answers with the stored range — and it passed, because that
   * is exactly what the code did. That behaviour is the defect, not the
   * contract: a store is invisible to `MetaPlatformPage`\'s
   * `parseMetaWindow(null)` and to the server-rendered Intelligence route, both
   * of which mean 28 days by an unstated window, so a persisted 90 days made
   * the picker name one window while the body measured another in the same
   * paint. One workspace does not get two windows.
   *
   * The selection is still carried across a query-dropping navigation — but by
   * being STATED on the URL where every surface can read it, not by being
   * answered beside it.
   */
  it("carries the operator's selection by stating it on the URL, not beside it", () => {
    usePreferencesStore.getState().setDashboardDateRange(storedCustom);

    const view = render(<ShellProbe referenceDate="2026-08-17" />);

    const params = new URLSearchParams(window.location.search);
    expect(params.get("startDate")).toBe("2026-05-01");
    expect(params.get("endDate")).toBe("2026-05-28");
    expect(params.get("window")).toBe("custom");
    // Server-rendered surfaces cannot see a `replaceState`, so the same window
    // is also navigated to.
    expect(routerReplace).toHaveBeenCalledWith(
      "/platforms/meta?window=custom&startDate=2026-05-01&endDate=2026-05-28",
    );
    // The App Router re-renders on `replaceState`; the stub `useSearchParams`
    // above only re-reads `window.location` when something renders, so the
    // re-read is triggered explicitly here.
    view.rerender(<ShellProbe referenceDate="2026-08-17" />);
    expect(screen.getByTestId("preset").textContent).toBe("custom");
    expect(screen.getByTestId("start").textContent).toBe("2026-05-01");
    expect(screen.getByTestId("end").textContent).toBe("2026-05-28");
  });

  it("means the shared unstated window until its selection has been stated", () => {
    usePreferencesStore.getState().setDashboardDateRange(storedCustom);

    // Canonicalization gated off is the shell before it has confirmed which
    // workspace — and therefore which clock — this is. The honest reading then
    // is the one every body already means by an unstated window: 28 days. The
    // alternative is the ITEM 10 defect: a control naming 2026-05-01..05-28
    // over a body measuring 28 days.
    render(<ShellProbe referenceDate="2026-08-17" enabled={false} />);

    expect(window.location.search).toBe("");
    expect(routerReplace).not.toHaveBeenCalled();
    expect(screen.getByTestId("preset").textContent).toBe("28d");
  });

  it("states a link's own preset against the workspace clock, not the stored range", () => {
    usePreferencesStore.getState().setDashboardDateRange(storedCustom);
    window.history.replaceState(null, "", "/platforms/meta?window=7d");

    const view = render(<ShellProbe referenceDate="2026-08-17" />);

    const params = new URLSearchParams(window.location.search);
    expect(params.get("startDate")).toBe("2026-08-10");
    expect(params.get("endDate")).toBe("2026-08-16");
    view.rerender(<ShellProbe referenceDate="2026-08-17" />);
    expect(screen.getByTestId("preset").textContent).toBe("7d");
  });

  it("restates nothing when the URL already names an exact window", () => {
    usePreferencesStore.getState().setDashboardDateRange(storedCustom);
    window.history.replaceState(
      null,
      "",
      "/platforms/meta?window=custom&startDate=2026-07-01&endDate=2026-07-14",
    );

    render(<ShellProbe referenceDate="2026-08-17" />);

    expect(routerReplace).not.toHaveBeenCalled();
    expect(screen.getByTestId("start").textContent).toBe("2026-07-01");
    expect(screen.getByTestId("end").textContent).toBe("2026-07-14");
  });

  it("states the picked window on the URL and preserves the scope parameters", () => {
    window.history.replaceState(
      null,
      "",
      "/platforms/meta?businessId=biz_1&providerAccountId=act_1",
    );

    render(<Probe referenceDate="2026-08-17" />);
    fireEvent.click(screen.getByRole("button", { name: "pick 7d" }));

    const params = new URLSearchParams(window.location.search);
    expect(params.get("startDate")).toBe("2026-08-10");
    expect(params.get("endDate")).toBe("2026-08-16");
    expect(params.get("window")).toBe("7d");
    expect(params.get("businessId")).toBe("biz_1");
    expect(params.get("providerAccountId")).toBe("act_1");
    // Still persisted, because that is what survives a link with no window.
    expect(usePreferencesStore.getState().dashboardDateRange?.rangePreset).toBe(
      "7d",
    );
  });

  it("names the preset when the stated dates are exactly that preset's", () => {
    window.history.replaceState(
      null,
      "",
      "/platforms/meta?window=custom&startDate=2026-08-10&endDate=2026-08-16",
    );

    render(<Probe referenceDate="2026-08-17" />);

    // Labelled "7d" only because those are the very dates 7d resolves to on
    // this clock; the dates themselves are what every read uses.
    expect(screen.getByTestId("preset").textContent).toBe("7d");
    expect(screen.getByTestId("start").textContent).toBe("2026-08-10");
    expect(screen.getByTestId("end").textContent).toBe("2026-08-16");
  });

  /**
   * REWRITTEN for ITEM 10, same reason as above: "falls back to the stored
   * range" was the second authority. What survives from the original test is
   * the part that still holds — a broken link is never repaired into a
   * plausible-looking window out of its readable half. The stored selection is
   * stated over it instead, so the control and every body read one window.
   */
  it("never invents a window from a broken link; it states the real one over it", () => {
    usePreferencesStore.getState().setDashboardDateRange(storedCustom);
    window.history.replaceState(
      null,
      "",
      "/platforms/meta?startDate=last-week&endDate=2026-07-14",
    );

    const view = render(<ShellProbe referenceDate="2026-08-17" />);

    const params = new URLSearchParams(window.location.search);
    // Not "2026-07-14 minus something": the readable half is discarded, not
    // completed.
    expect(params.get("startDate")).toBe("2026-05-01");
    expect(params.get("endDate")).toBe("2026-05-28");
    view.rerender(<ShellProbe referenceDate="2026-08-17" />);
    expect(screen.getByTestId("start").textContent).toBe("2026-05-01");
    expect(screen.getByTestId("end").textContent).toBe("2026-05-28");
  });
});
