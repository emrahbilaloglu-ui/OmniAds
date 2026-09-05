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

function render(rows: MetaCreativeRow[], onRun = vi.fn()) {
  return {
    html: renderToStaticMarkup(
      <LaunchpadManageExistingReview selectedCreatives={rows} onRun={onRun} />,
    ),
    onRun,
  };
}

describe("LaunchpadManageExistingReview", () => {
  /*
    Rewritten from "ACTIVE is contract-required" to "ACTIVE is offered".

    The panel used to describe the activation contract as the reason it
    rendered no control: a fresh preflight, verified parents, a halt on drift.
    Every one of those checks is implemented and runs on this request
    (`validateMetaBulkResumePreflight` re-reads the ad, its creative and both
    parents from Meta before any write), so the honest surface is a button and
    a sentence about what will be checked.
  */
  it("offers both directions, each counting only the rows it applies to", () => {
    const { html } = render([
      makeAd("ad_active", "ACTIVE"),
      makeAd("ad_paused", "PAUSED"),
      makeAd("ad_paused_2", "PAUSED"),
    ]);

    expect(html).toContain("Pause selected (1)");
    expect(html).toContain("Activate selected (2)");
    // The panel no longer explains the absence of a control it now renders.
    expect(html).not.toContain("No one-click control is rendered");
    expect(html).not.toContain("Activation is unavailable");
  });

  it("says what the server verifies rather than what someone would have to build", () => {
    const { html } = render([makeAd("ad_paused", "PAUSED")]);
    expect(html).toContain("creative identity");
    expect(html).toContain("effective status");
    // The specific failure an operator would otherwise misread as published.
    expect(html).toContain("refused by name rather than left");
  });

  it("offers neither direction for a row with no provider identity", () => {
    /*
      `resolveLaunchpadAdActionId` falls back to the row's own id, so a
      discovery row has to be made identity-less to reach the warning. Both
      buttons must go dead together: an unmapped row is not more writable in
      one direction than the other.
    */
    const orphan = {
      ...makeAd("ad_paused", "PAUSED"), realAdId: null, id: "",
    } as MetaCreativeRow;
    const { html } = render([makeAd("ad_active", "ACTIVE"), orphan]);
    expect(html).toContain("cannot be mapped to a Meta ad id");
    expect(html.match(/disabled=""/g) ?? []).toHaveLength(2);
  });

  it("offers nothing at all for an empty selection", () => {
    const { html } = render([]);
    expect(html).toContain("Pause selected (0)");
    expect(html).toContain("Activate selected (0)");
    expect(html.match(/disabled=""/g) ?? []).toHaveLength(2);
  });
});
