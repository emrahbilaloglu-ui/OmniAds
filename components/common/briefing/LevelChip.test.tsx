import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LevelChip } from "@/components/common/briefing/LevelChip";
import type { DecisionLevel } from "@/components/common/briefing/types";

describe("LevelChip", () => {
  it("renders every level with the prototype tone classes", () => {
    const levels: DecisionLevel[] = ["account", "campaign", "adset", "creative"];
    const html = renderToStaticMarkup(
      <>
        {levels.map((level) => (
          <LevelChip key={level} level={level} />
        ))}
      </>,
    );

    expect(html).toContain("Account");
    expect(html).toContain("Campaign");
    expect(html).toContain("Adset");
    expect(html).toContain("Creative");
    expect(html).toContain("border-blue-200 bg-blue-50 text-blue-700");
    expect(html).toContain("border-violet-200 bg-violet-50 text-violet-700");
  });

  it("passes through className for edge placement tweaks", () => {
    const html = renderToStaticMarkup(<LevelChip level="campaign" className="shrink-0" />);

    expect(html).toContain("shrink-0");
  });
});
