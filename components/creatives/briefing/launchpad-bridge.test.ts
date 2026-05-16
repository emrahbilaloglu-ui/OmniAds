import { describe, expect, it } from "vitest";
import {
  buildLaunchpadBridgeHref,
  buildLaunchpadOverlayItem,
  getLaunchpadBridgeCreativeIds,
  mapBriefingPrimaryToLaunchpadMode,
} from "@/components/creatives/briefing/launchpad-bridge";
import type { BriefingCreativeCard } from "@/components/creatives/briefing/types";

function card(overrides: Partial<BriefingCreativeCard> = {}): BriefingCreativeCard {
  return {
    id: "row_1",
    creativeId: "creative_1",
    name: "Aphrodite Hook",
    brand: "TheSwaf",
    campaign: "ASC | Worldwide",
    adset: "Broad",
    label: "scale",
    primary: { kind: "promote", label: "Promote to main" },
    ...overrides,
  };
}

describe("launchpad briefing bridge", () => {
  it("builds the Launchpad prefill URL for supported single-card modes", () => {
    expect(buildLaunchpadBridgeHref(card(), "promote")).toBe(
      "/platforms/meta/launchpad?creativeIds=creative_1&mode=promote&fromBriefing=true",
    );
    expect(buildLaunchpadBridgeHref(card({ creativeId: "creative_2" }), "demote")).toBe(
      "/platforms/meta/launchpad?creativeIds=creative_2&mode=demote&fromBriefing=true",
    );
    expect(buildLaunchpadBridgeHref(card({ creativeId: "creative_3" }), "fresh_test")).toBe(
      "/platforms/meta/launchpad?creativeIds=creative_3&mode=fresh_test&fromBriefing=true",
    );
    expect(buildLaunchpadBridgeHref(card({ creativeId: "creative_4" }), "add_existing")).toBe(
      "/platforms/meta/launchpad?creativeIds=creative_4&mode=add_existing&fromBriefing=true",
    );
  });

  it("builds multi-card Launchpad prefill URLs", () => {
    expect(
      buildLaunchpadBridgeHref(
        [
          card({ creativeId: "creative_1" }),
          card({ id: "row_2", creativeId: "creative_2" }),
          card({ id: "row_3", creativeId: "creative_1" }),
        ],
        "demote",
      ),
    ).toBe("/platforms/meta/launchpad?creativeIds=creative_1,creative_2&mode=demote&fromBriefing=true");
  });

  it("uses every placement creative id for non-mixed rollups", () => {
    const rollup = card({
      id: "rollup_1",
      creativeId: "creative_primary",
      mixed: false,
      placementList: [
        { id: "placement_1", creativeId: "creative_a", label: "scale" },
        { id: "placement_2", creativeId: "creative_b", label: "scale" },
        { id: "placement_3", creativeId: "creative_a", label: "scale" },
      ],
    });

    expect(getLaunchpadBridgeCreativeIds(rollup)).toEqual(["creative_a", "creative_b"]);
    expect(buildLaunchpadBridgeHref(rollup, "promote")).toBe(
      "/platforms/meta/launchpad?creativeIds=creative_a,creative_b&mode=promote&fromBriefing=true",
    );
  });

  it("falls back to the primary creative id for mixed rollups", () => {
    const rollup = card({
      id: "rollup_1",
      creativeId: "creative_primary",
      mixed: true,
      placementList: [
        { id: "placement_1", creativeId: "creative_a", label: "scale" },
        { id: "placement_2", creativeId: "creative_b", label: "cut" },
      ],
    });

    expect(getLaunchpadBridgeCreativeIds(rollup)).toEqual(["creative_primary"]);
    expect(buildLaunchpadBridgeHref(rollup, "promote")).toBe(
      "/platforms/meta/launchpad?creativeIds=creative_primary&mode=promote&fromBriefing=true",
    );
  });

  it("maps primary action kinds and conservative label fallbacks", () => {
    expect(mapBriefingPrimaryToLaunchpadMode(card({ primary: { kind: "promote", label: "Promote" } }))).toBe("promote");
    expect(mapBriefingPrimaryToLaunchpadMode(card({ primary: { kind: "demote", label: "Demote" } }))).toBe("demote");
    expect(mapBriefingPrimaryToLaunchpadMode(card({ primary: { kind: "fresh_test", label: "Add to fresh test" } }))).toBe("fresh_test");
    expect(
      mapBriefingPrimaryToLaunchpadMode(card({ primary: null, label: "scale", campaignKind: "test" })),
    ).toBe("promote");
    expect(
      mapBriefingPrimaryToLaunchpadMode(card({ primary: null, label: "scale", campaignKind: "main" })),
    ).toBeNull();
    expect(
      mapBriefingPrimaryToLaunchpadMode(card({ primary: { kind: "scale_budget", label: "Scale budget" }, label: "scale" })),
    ).toBeNull();
    expect(mapBriefingPrimaryToLaunchpadMode(card({ primary: null, label: "test_more" }))).toBe("fresh_test");
    expect(mapBriefingPrimaryToLaunchpadMode(card({ primary: null, label: "cut" }))).toBeNull();
    expect(mapBriefingPrimaryToLaunchpadMode(card({ primary: { kind: "review", label: "Review" }, label: "out_of_scope" }))).toBeNull();
  });

  it("adapts briefing cards to the Phase 1 overlay item shape", () => {
    expect(buildLaunchpadOverlayItem(card())).toEqual({
      id: "creative_1",
      name: "Aphrodite Hook",
      scopeName: "Broad",
      brand: "TheSwaf",
      campaign: "ASC | Worldwide",
      label: "scale",
    });
  });
});
