import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MetaScopeChip } from "@/components/meta/redesign/MetaScopeChip";

describe("MetaScopeChip", () => {
  it("renders level-aware scope labels", () => {
    const html = renderToStaticMarkup(<MetaScopeChip level="campaign" />);
    expect(html).toContain("Campaign");
    expect(html).toContain("data-scope-chip=\"campaign\"");
  });
});
