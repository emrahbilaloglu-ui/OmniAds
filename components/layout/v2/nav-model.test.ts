import { describe, expect, it } from "vitest";

import {
  getRailModel,
  isPlatformFamilyActive,
  isRailLinkActive,
} from "@/components/layout/v2/nav-model";

describe("Dashboard v2 rail route families", () => {
  const model = getRailModel("en", { showKlaviyo: true });

  it("lights the same row for legacy, readable and scoped URLs", () => {
    const meta = model.platforms.find((platform) => platform.id === "meta")!;
    const decisions = meta.children.find((link) => link.id === "pulse")!;

    expect(isRailLinkActive(decisions, "/platforms/meta")).toBe(true);
    expect(isRailLinkActive(decisions, "/app/meta/decisions")).toBe(true);
    expect(isRailLinkActive(decisions, "/c/biz_1/meta/decisions")).toBe(true);
    expect(isPlatformFamilyActive(meta, "/c/biz_1/creative/performance")).toBe(
      true,
    );
  });

  it("keeps coming-soon providers out of the rail", () => {
    expect(model.platforms.map((platform) => platform.id)).toEqual([
      "meta",
      "google",
      "klaviyo",
    ]);
  });

  it("keeps connected Klaviyo on its additive app and business aliases", () => {
    const klaviyo = model.platforms.find(
      (platform) => platform.id === "klaviyo",
    )!;

    expect(isPlatformFamilyActive(klaviyo, "/app/klaviyo")).toBe(true);
    expect(isPlatformFamilyActive(klaviyo, "/c/biz_1/klaviyo")).toBe(true);
  });

  it("keeps every Insights alias on the Insights row", () => {
    const insights = model.growth.find((link) => link.id === "insights")!;
    expect(isRailLinkActive(insights, "/app/analytics/landing-pages")).toBe(
      true,
    );
    expect(isRailLinkActive(insights, "/c/biz_1/analytics/landing-pages")).toBe(
      true,
    );
  });
});
