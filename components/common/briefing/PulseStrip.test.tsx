import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PulseStrip } from "@/components/common/briefing/PulseStrip";

describe("PulseStrip", () => {
  it("renders creative pulse slots", () => {
    const html = renderToStaticMarkup(
      <PulseStrip
        left={<button type="button">Scope</button>}
        center={<span>Spend today</span>}
        right={<span>Saved 2s ago</span>}
        jumpNav={<a href="#one">One</a>}
      />,
    );

    expect(html).toContain("account-pulse");
    expect(html).toContain("bg-white/95 backdrop-blur");
    expect(html).toContain("Spend today");
    expect(html).toContain("Saved 2s ago");
    expect(html).toContain("overflow-x-auto");
  });

  it("renders meta pulse with KPI band", () => {
    const html = renderToStaticMarkup(
      <PulseStrip variant="meta" kpiBand={<div>Spend 7d</div>} />,
    );

    expect(html).toContain("id=\"pulse\"");
    expect(html).toContain("bg-white border-b border-neutral-200");
    expect(html).toContain("grid grid-cols-4 gap-0");
  });
});
