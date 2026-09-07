import { describe, expect, it } from "vitest";
import {
  getLayer1Items,
  getLayer3Items,
  getPlatformLayer2Items,
  platformsRegistry,
} from "@/components/layout/nav-items";
import { metaRailSurfaces } from "@/lib/meta/surface-registry";

describe("shell navigation items", () => {
  it("places Commercial Truth in the Workspace layer", () => {
    const navItems = getLayer1Items("en");

    const commercialTruth = navItems.find(
      (item) => item.href === "/commercial-truth",
    );

    expect(commercialTruth).toMatchObject({
      label: "Commercial Truth",
      group: "Workspace",
      requiredPlan: "growth",
    });
  });

  it("keeps Settings in Manage and separate from Commercial Truth", () => {
    const navItems = getLayer3Items("en");

    expect(navItems.find((item) => item.href === "/settings")).toMatchObject({
      label: "Settings",
      group: "Manage",
    });
  });

  it("carries only usable Meta destinations in their fixed order", () => {
    const metaItems = getPlatformLayer2Items("meta", "en");

    expect(metaItems.map((item) => item.href)).toEqual([
      "/platforms/meta",
      "/platforms/meta/creatives",
      "/platforms/meta/launchpad",
      "/platforms/meta/automation",
      "/platforms/meta/history",
    ]);
    expect(metaItems[1]).toMatchObject({
      id: "creative-studio",
      label: "Creative Studio",
      activeHrefs: [
        "/platforms/meta/copies",
        "/platforms/meta/landing-pages",
        "/platforms/meta/creative-inbox",
        "/platforms/meta/audiences",
        // Sub-surfaces with no rail row of their own; without these the whole
        // Meta group went inactive the moment a brief was opened.
        "/app/creative/briefs",
        "/app/creative/shares",
      ],
    });
  });

  it("orders the Meta rail exactly as the surface registry does", () => {
    // The registry is the single semantic authority (plan §3 rank 5). This is
    // the assertion that keeps the rail from drifting away from it.
    const metaItems = getPlatformLayer2Items("meta", "en");
    expect(metaItems.map((item) => item.label)).toEqual(
      metaRailSurfaces().map((surface) => surface.label),
    );
  });

  it("uses Decisions as the visible queue label while preserving stable pulse route ids", () => {
    const metaItems = getPlatformLayer2Items("meta", "en");
    const googleItems = getPlatformLayer2Items("google", "en");

    expect(metaItems[0]).toMatchObject({
      id: "pulse",
      label: "Decisions",
      href: "/platforms/meta",
    });
    // History used to be listed as an active href for Decisions, so reading
    // History lit up Decisions (plan §5.1 finding 4). It owns its own row now,
    // and a row must not claim a surface it does not own.
    expect(metaItems[0]!.activeHrefs ?? []).not.toContain(
      "/platforms/meta/history",
    );
    expect(metaItems.at(-1)).toMatchObject({
      id: "meta-history",
      label: "History",
      href: "/platforms/meta/history",
    });
    expect(googleItems[0]).toMatchObject({
      id: "google-overview",
      label: "Overview",
      href: "/platforms/google",
    });
    expect(
      metaItems.find((item) => item.href === "/platforms/meta/automation"),
    ).toMatchObject({
      label: "Automation",
    });
  });

  it("surfaces Klaviyo as beta and Google as a live platform", () => {
    expect(platformsRegistry.klaviyo.status).toBe("beta");
    // Google Ads is fully built (self-contained intelligence dashboard), so it is live.
    expect(platformsRegistry.google.status).toBe("live");
  });

  it("routes the Google Layer-2 nav to the six v2 workspace surfaces", () => {
    const googleItems = getPlatformLayer2Items("google", "en");
    expect(googleItems.map((item) => item.href)).toEqual([
      "/platforms/google",
      "/platforms/google/advisor",
      "/platforms/google/search",
      "/platforms/google/products",
      "/platforms/google/assets",
      "/platforms/google/plan",
    ]);
    expect(googleItems.map((item) => item.label)).toEqual([
      "Overview",
      "Advisor",
      "Search",
      "Products",
      "Assets & Audiences",
      "Plan & Activity",
    ]);
    // The root entry stays exact so the child routes do not light it up too.
    expect(googleItems[0]).toMatchObject({
      id: "google-overview",
      exact: true,
    });
  });
});
