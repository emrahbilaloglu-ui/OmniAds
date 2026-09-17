// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { AdvSparkline } from "./adv-sparkline";

const current = [
  { date: "2026-08-01", value: 100 },
  { date: "2026-08-02", value: 120 },
  { date: "2026-08-03", value: 150 },
];
const previous = [
  { date: "2026-07-01", value: 80 },
  { date: "2026-07-02", value: 100 },
  { date: "2026-07-03", value: 200 },
];

afterEach(cleanup);

function renderSparkline(variant: "hero" | "tile" | "compact" = "compact") {
  return render(
    <AdvSparkline
      points={current}
      previousPoints={previous}
      line="#B45309"
      fill="rgba(180,83,9,0.07)"
      height={variant === "hero" ? 44 : variant === "tile" ? 38 : 26}
      tone={variant === "hero" ? "light" : "dark"}
      variant={variant}
      format={(value) => `$${value.toFixed(0)}`}
      ariaLabel="Revenue trend"
    />
  );
}

function hoverLastPoint(container: HTMLElement) {
  const scrubber = container.querySelector<HTMLElement>("[data-sparkline-scrubber]");
  if (!scrubber) throw new Error("sparkline scrubber was not rendered");
  Object.defineProperty(scrubber, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ left: 0, width: 100 }),
  });
  fireEvent.mouseMove(scrubber, { clientX: 100 });
}

describe("canonical comparison sparkline", () => {
  it("keeps the canonical wrapper and SVG shell when trend data is absent", () => {
    const { container } = render(
      <AdvSparkline
        points={[]}
        line="#B45309"
        fill="rgba(180,83,9,0.07)"
        height={26}
        marginTop={8}
        format={(value) => String(value)}
        ariaLabel="Unavailable trend"
      />
    );

    expect(container.children).toHaveLength(1);
    expect(container.firstElementChild?.tagName).toBe("DIV");
    expect((container.firstElementChild as HTMLElement).style.marginTop).toBe("8px");
    expect(container.querySelector("svg")?.getAttribute("aria-label")).toBe("Unavailable trend");
    expect(container.querySelectorAll("path")).toHaveLength(0);
  });

  it("draws current and dashed previous series against one scale", () => {
    const { container } = renderSparkline();
    const paths = container.querySelectorAll("path");

    expect(paths).toHaveLength(3);
    expect(container.querySelector('path[stroke-dasharray="3 3"]')).not.toBeNull();
    // The previous maximum owns y=3.0; the current maximum therefore stays
    // lower on the same scale instead of being independently normalised.
    expect(paths[2]?.getAttribute("d")).toContain("L100.0 11.3");
  });

  it("shows date/current and previous/delta on two tooltip lines", () => {
    const { container } = renderSparkline();
    hoverLastPoint(container);

    expect(screen.getByText(/Aug 3 · \$150/)).toBeTruthy();
    expect(screen.getByText("prev $200 · −25.0%")).toBeTruthy();
  });

  it("never claims a +0.0% change against a zero or missing previous baseline", () => {
    const zeroBaseline = render(
      <AdvSparkline
        points={current}
        previousPoints={[
          { date: "2026-07-01", value: 0 },
          { date: "2026-07-02", value: 0 },
          { date: "2026-07-03", value: 0 },
        ]}
        line="#2a5fe2"
        fill="rgba(47,107,255,0.08)"
        height={30}
        format={(value) => `$${value.toFixed(0)}`}
        ariaLabel="CPM trend"
      />
    );
    hoverLastPoint(zeroBaseline.container);
    const zeroTooltip = zeroBaseline.container.querySelector("[data-sparkline-tooltip]")!;
    expect(zeroTooltip.textContent).toContain("prev $0");
    expect(zeroTooltip.textContent).not.toContain("%");
    zeroBaseline.unmount();

    const noBaseline = render(
      <AdvSparkline
        points={current}
        line="#2a5fe2"
        fill="rgba(47,107,255,0.08)"
        height={30}
        format={(value) => `$${value.toFixed(0)}`}
        ariaLabel="CPM trend"
      />
    );
    hoverLastPoint(noBaseline.container);
    const noTooltip = noBaseline.container.querySelector("[data-sparkline-tooltip]")!;
    expect(noTooltip.textContent).toBe("Aug 3 · $150");
  });

  it("signs a real comparison delta against a negative baseline by its magnitude", () => {
    const { container } = render(
      <AdvSparkline
        points={[
          { date: "2026-08-01", value: -50 },
          { date: "2026-08-02", value: -50 },
        ]}
        previousPoints={[
          { date: "2026-07-01", value: -100 },
          { date: "2026-07-02", value: -100 },
        ]}
        line="#2a5fe2"
        fill="rgba(47,107,255,0.08)"
        height={30}
        format={(value) => String(value)}
        ariaLabel="Net trend"
      />
    );
    hoverLastPoint(container);
    expect(container.querySelector("[data-sparkline-tooltip]")?.textContent).toContain("prev -100 · +50.0%");
  });

  it("spaces dated points by calendar day so an omitted date leaves a gap, without plotting a value for it", () => {
    const { container } = render(
      <AdvSparkline
        points={[
          { date: "2026-03-01", value: 10 },
          { date: "2026-03-02", value: 20 },
          // 2026-03-03 and 2026-03-04 had no provider row.
          { date: "2026-03-05", value: 30 },
        ]}
        dateDomain={{ startDate: "2026-02-28", endDate: "2026-03-06" }}
        line="#2a5fe2"
        fill="rgba(47,107,255,0.08)"
        height={30}
        format={(value) => String(value)}
        ariaLabel="Dated trend"
      />
    );

    const paths = container.querySelectorAll("path");
    const line = paths[paths.length - 1]?.getAttribute("d");
    // The selected window includes one unreported day at each edge. The line
    // and fill stop at the first/last measured dates instead of stretching
    // the partial series across the full card.
    expect(line).toBe("M16.7 23.0 L33.3 13.0 L83.3 3.0");
    expect(paths[0]?.getAttribute("d")).toContain("L83.3 26 L16.7 26 Z");

    // Hovering between day 2 and day 5, nearer day 5, selects the real nearest point.
    const scrubber = container.querySelector<HTMLElement>("[data-sparkline-scrubber]")!;
    Object.defineProperty(scrubber, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ left: 0, width: 100 }),
    });
    fireEvent.mouseMove(scrubber, { clientX: 70 });
    expect(container.querySelector("[data-sparkline-tooltip]")?.textContent).toBe("Mar 5 · 30");
    fireEvent.mouseMove(scrubber, { clientX: 50 });
    expect(container.querySelector("[data-sparkline-tooltip]")?.textContent).toBe("Mar 2 · 20");
  });

  it("keeps even index spacing for points that are not strictly increasing calendar dates", () => {
    const { container } = render(
      <AdvSparkline
        points={[
          { date: "Mar 01", value: 10 },
          { date: "Mar 02", value: 20 },
          { date: "Mar 05", value: 30 },
        ]}
        line="#2a5fe2"
        fill="rgba(47,107,255,0.08)"
        height={30}
        format={(value) => String(value)}
        ariaLabel="Labelled trend"
      />
    );

    const paths = container.querySelectorAll("path");
    expect(paths[paths.length - 1]?.getAttribute("d")).toBe("M0.0 23.0 L50.0 13.0 L100.0 3.0");
  });

  it("aligns the previous point by position within its own dated window", () => {
    const { container } = render(
      <AdvSparkline
        points={[
          { date: "2026-03-01", value: 10 },
          { date: "2026-03-02", value: 20 },
          { date: "2026-03-05", value: 30 },
        ]}
        previousPoints={[
          { date: "2026-02-25", value: 5 },
          { date: "2026-02-28", value: 8 },
          { date: "2026-03-01", value: 20 },
        ]}
        dateDomain={{ startDate: "2026-02-28", endDate: "2026-03-06" }}
        previousDateDomain={{ startDate: "2026-02-24", endDate: "2026-03-02" }}
        line="#2a5fe2"
        fill="rgba(47,107,255,0.08)"
        height={30}
        format={(value) => String(value)}
        ariaLabel="Compared trend"
      />
    );

    const scrubber = container.querySelector<HTMLElement>("[data-sparkline-scrubber]")!;
    Object.defineProperty(scrubber, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ left: 0, width: 100 }),
    });
    // Mar 2 sits one-third into the selected current window. In the selected
    // previous window, Feb 25 is nearest that relative position; normalizing
    // only to observed endpoints would hide both edge gaps and choose Feb 28.
    fireEvent.mouseMove(scrubber, { clientX: 33 });
    expect(container.querySelector("[data-sparkline-tooltip]")?.textContent).toBe("Mar 2 · 20prev 5 · +300.0%");
  });

  it("uses the compact crosshair, dot and tooltip geometry", () => {
    const { container } = renderSparkline("compact");
    hoverLastPoint(container);

    const dot = container.querySelector<HTMLElement>("[data-sparkline-dot]");
    const tooltip = container.querySelector<HTMLElement>("[data-sparkline-tooltip]");
    expect(dot?.style.width).toBe("7px");
    expect(dot?.style.height).toBe("7px");
    expect(dot?.style.boxShadow).toBe("");
    expect(tooltip?.style.bottom).toBe("calc(100% + 5px)");
    expect(tooltip?.style.borderRadius).toBe("6px");
    expect(tooltip?.style.fontSize).toBe("10.5px");
    expect(tooltip?.style.padding).toBe("3px 8px");
  });

  it("uses the hero dot and tooltip geometry", () => {
    const { container } = renderSparkline("hero");
    hoverLastPoint(container);

    const dot = container.querySelector<HTMLElement>("[data-sparkline-dot]");
    const tooltip = container.querySelector<HTMLElement>("[data-sparkline-tooltip]");
    expect(dot?.style.width).toBe("9px");
    expect(tooltip?.style.bottom).toBe("calc(100% + 6px)");
    expect(tooltip?.style.borderRadius).toBe("7px");
    expect(tooltip?.style.fontSize).toBe("11.5px");
  });
});
