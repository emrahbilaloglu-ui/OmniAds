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

  it("marks nested adset rows for campaign hierarchy", () => {
    const html = renderToStaticMarkup(
      <MetaHealthyRow
        row={metaHealthy({
          id: "adset_1",
          level: "adset",
          name: "Healthy Broad",
          campaignName: "Healthy ASC",
        })}
        depth="child"
        hideCampaignName
      />,
    );

    expect(html).toContain('data-healthy-level="adset"');
    expect(html).toContain('data-healthy-depth="child"');
    expect(html).not.toContain("Healthy ASC");
  });
});
