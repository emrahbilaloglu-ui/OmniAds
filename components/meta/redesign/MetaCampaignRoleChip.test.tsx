import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MetaCampaignRoleChip } from "@/components/meta/redesign/MetaCampaignRoleChip";

describe("MetaCampaignRoleChip", () => {
  it("renders the engine-driven role tone and label", () => {
    const html = renderToStaticMarkup(<MetaCampaignRoleChip role="prospecting_scale" />);
    expect(html).toContain("Prospecting Scale");
    expect(html).toContain("emerald");
  });
});
