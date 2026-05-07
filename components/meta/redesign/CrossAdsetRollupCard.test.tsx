import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CrossAdsetRollupCard } from "@/components/meta/redesign/CrossAdsetRollupCard";
import { metaRec } from "@/components/meta/redesign/test-fixtures";

describe("CrossAdsetRollupCard", () => {
  it("renders stacked adset rows for mixed decisions", () => {
    const recs = [
      metaRec({ id: "a", level: "adset", adsetId: "adset_1", adsetName: "Broad 1", campaignId: "cmp_1" }),
      metaRec({ id: "b", level: "adset", adsetId: "adset_2", adsetName: "Broad 2", campaignId: "cmp_1" }),
    ];
    const html = renderToStaticMarkup(<CrossAdsetRollupCard campaignName="ASC" recs={recs} />);
    expect(html).toContain("Cross-adset rollup");
    expect(html).toContain("Broad 1");
    expect(html).toContain("Mixed");
  });
});
