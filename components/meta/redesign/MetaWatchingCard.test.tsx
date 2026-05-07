import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MetaWatchingCard } from "@/components/meta/redesign/MetaWatchingCard";
import { metaRec } from "@/components/meta/redesign/test-fixtures";

describe("MetaWatchingCard", () => {
  it("renders a watch recommendation with defer control", () => {
    const html = renderToStaticMarkup(
      <MetaWatchingCard rec={metaRec({ decisionState: "watch", confidenceScore: 0.44 })} />,
    );
    expect(html).toContain("Let cook");
    expect(html).toContain("44%");
  });
});
