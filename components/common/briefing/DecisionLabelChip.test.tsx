import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DecisionLabelChip } from "@/components/common/briefing/DecisionLabelChip";
import { DECISION_LABELS } from "@/components/common/briefing/decision-label-palette";

describe("DecisionLabelChip", () => {
  it("renders every decision label with creative palette defaults", () => {
    const html = renderToStaticMarkup(
      <>
        {DECISION_LABELS.map((label) => (
          <DecisionLabelChip key={label} label={label} />
        ))}
      </>,
    );

    expect(html).toContain("scale");
    expect(html).toContain("review placements");
    expect(html).toContain("text-emerald-700 bg-emerald-500/15 border-emerald-200");
    expect(html).toContain("text-rose-700 bg-rose-500/15 border-rose-200");
  });

  it("renders meta surface and small size with source classes", () => {
    const html = renderToStaticMarkup(<DecisionLabelChip label="rebuild" surface="meta" size="sm" />);

    expect(html).toContain("px-1.5 py-0 rounded-md border font-semibold uppercase tracking-wider text-[9.5px]");
    expect(html).toContain("bg-rose-50 text-rose-700 border-rose-200");
  });

  it("supports unstyled wrapping for legacy surfaces", () => {
    const html = renderToStaticMarkup(
      <DecisionLabelChip label="scale" appearance="unstyled" className="legacy-class">
        Scale
      </DecisionLabelChip>,
    );

    expect(html).toContain("legacy-class");
    expect(html).toContain(">Scale<");
    expect(html).not.toContain("uppercase tracking-wider");
  });
});
