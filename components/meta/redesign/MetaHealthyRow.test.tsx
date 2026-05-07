import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MetaHealthyRow } from "@/components/meta/redesign/MetaHealthyRow";
import { metaHealthy } from "@/components/meta/redesign/test-fixtures";

describe("MetaHealthyRow", () => {
  it("renders compact stable entity metrics", () => {
    const html = renderToStaticMarkup(<MetaHealthyRow row={metaHealthy()} />);
    expect(html).toContain("Healthy ASC");
    expect(html).toContain("$820");
  });
});
