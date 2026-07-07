import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LaneHeader } from "@/components/common/briefing/LaneHeader";

describe("LaneHeader", () => {
  it("renders the creative lane header with count and collapse control", () => {
    const html = renderToStaticMarkup(
      <LaneHeader laneKey="action" title="Action Now" count={4} subtitle="High-confidence calls" />,
    );

    expect(html).toContain("Action Now");
    expect(html).toContain("High-confidence calls");
    expect(html).toContain("bg-rose-500");
    expect(html).toContain("Collapse");
    expect(html).toContain("data-toggle-lane=\"action\"");
  });

  it("renders meta and audience variants", () => {
    const html = renderToStaticMarkup(
      <>
        <LaneHeader laneKey="watching" title="Watching" count={6} variant="meta" collapsed />
        <LaneHeader laneKey="audience" title="Audience builder" count={0} collapsed />
      </>,
    );

    expect(html).toContain("text-[13px] font-semibold text-neutral-900 uppercase tracking-wider");
    expect(html).toContain("bg-sky-500");
    expect(html).toContain("bg-cyan-400");
    expect(html).toContain("Expand");
  });
});
