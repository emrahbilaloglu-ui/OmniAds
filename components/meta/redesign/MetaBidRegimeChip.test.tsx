import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MetaBidRegimeChip } from "@/components/meta/redesign/MetaBidRegimeChip";

describe("MetaBidRegimeChip", () => {
  it("renders the bid regime label", () => {
    const html = renderToStaticMarkup(<MetaBidRegimeChip regime="minimum_roas" />);
    expect(html).toContain("Minimum ROAS");
    expect(html).toContain("data-bid-regime=\"minimum_roas\"");
  });
});
