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
