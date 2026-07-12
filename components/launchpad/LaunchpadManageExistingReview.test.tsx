import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { MetaCreativeRow } from "@/components/creatives/metricConfig";
import { LaunchpadManageExistingReview } from "@/components/launchpad/LaunchpadManageExistingReview";

function makeAd(id: string, status: "ACTIVE" | "PAUSED") {
  return {
    id,
    realAdId: id,
    creativeId: `creative_${id}`,
    name: `Ad ${id}`,
    campaignName: "Campaign",
    effectiveStatus: status,
  } as MetaCreativeRow;
}

describe("LaunchpadManageExistingReview", () => {
  it("keeps PAUSE current while rendering ACTIVE only as contract-required", () => {
    const html = renderToStaticMarkup(
      <LaunchpadManageExistingReview
        selectedCreatives={[makeAd("ad_active", "ACTIVE"), makeAd("ad_paused", "PAUSED")]}
        onRun={vi.fn()}
      />,
    );

    expect(html).toContain("Pause selected (1)");
    expect(html).toContain("Resume / Publish ACTIVE");
    expect(html).toContain("Proposed/contract required");
    expect(html).toContain("Activation is unavailable");
    expect(html).toContain("No one-click control is rendered");
    expect(html).not.toContain("Resume selected");
  });
});
