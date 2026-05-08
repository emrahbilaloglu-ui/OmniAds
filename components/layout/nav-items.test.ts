import { describe, expect, it } from "vitest";
import {
  getLayer1Items,
  getLayer3Items,
  getPlatformLayer2Items,
  platformsRegistry,
} from "@/components/layout/nav-items";

describe("shell navigation items", () => {
  it("places Commercial Truth in the Workspace layer", () => {
    const navItems = getLayer1Items("en");

    const commercialTruth = navItems.find((item) => item.href === "/commercial-truth");

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

  it("uses per-platform Meta routes after the hard migration", () => {
    const metaItems = getPlatformLayer2Items("meta", "en");

    expect(metaItems.map((item) => item.href)).toEqual([
      "/platforms/meta",
      "/platforms/meta/creatives",
      "/platforms/meta/copies",
      "/platforms/meta/landing-pages",
      "/platforms/meta/launchpad",
      "/platforms/meta/audiences",
    ]);
  });

  it("surfaces Klaviyo and Google as beta platforms", () => {
    expect(platformsRegistry.klaviyo.status).toBe("beta");
    expect(platformsRegistry.google.status).toBe("beta");
  });
});
