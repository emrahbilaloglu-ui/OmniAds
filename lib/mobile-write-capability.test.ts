import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  mobileWriteCapabilityForPath,
  shouldClaimMobileReadOnly,
} from "@/lib/mobile-write-capability";

/**
 * The route/capability matrix behind the mobile banner.
 *
 * The shell claimed "mobile read-only / Writes stay on desktop" on every route
 * without its own mobile surface, which included Settings and Integrations —
 * both of which render working write controls at the same width. An operator
 * who believes the banner stops trying to save, and the product looks broken
 * while working correctly.
 */
describe("routes that accept writes make no read-only claim", () => {
  for (const path of [
    "/settings",
    "/integrations",
    "/team",
    "/reports",
    "/security",
  ]) {
    it(`${path} is write-capable on a phone`, () => {
      expect(mobileWriteCapabilityForPath(path)).toBe("writes_allowed");
      expect(
        shouldClaimMobileReadOnly(path),
        `${path} renders working write controls and would be told writes stay on desktop`,
      ).toBe(false);
    });
  }
});

describe("provider surfaces keep the claim, because it is true there", () => {
  for (const path of [
    "/platforms/meta",
    "/platforms/meta/automation",
    "/platforms/google",
    "/app/meta/decisions",
    "/app/creative/performance",
    "/app/google/overview",
    "/c/biz_1/meta/launchpad",
    "/c/biz_1/google/plan",
  ]) {
    it(`${path} is read-only on a phone`, () => {
      expect(mobileWriteCapabilityForPath(path)).toBe("read_only");
      expect(shouldClaimMobileReadOnly(path)).toBe(true);
    });
  }
});

describe("readable and scoped workspace routes keep their real mobile capability", () => {
  for (const path of [
    "/app/home",
    "/app/analytics/seo",
    "/app/reports",
    "/app/manage/integrations",
    "/c/biz_1/manage/team",
  ]) {
    it(`${path} remains write-capable on a phone`, () => {
      expect(mobileWriteCapabilityForPath(path)).toBe("writes_allowed");
      expect(shouldClaimMobileReadOnly(path)).toBe(false);
    });
  }
});

describe("an unknown route says nothing rather than the wrong thing", () => {
  it.each([
    "/something-new",
    "/app/metadata",
    "/app/creative-writing",
    "/app/googleish",
    "/c/biz_1/metadata",
  ])("does not claim read-only for unknown route %s", (path) => {
    // Silence is recoverable; a false read-only claim over a working form is
    // not.
    expect(mobileWriteCapabilityForPath(path)).toBe("writes_allowed");
    expect(shouldClaimMobileReadOnly(path)).toBe(false);
  });

  it("keeps a missing pathname write-capable", () => {
    expect(shouldClaimMobileReadOnly(null)).toBe(false);
  });
});

describe("the shell actually uses the matrix", () => {
  it("gates the banner on capability, not on owning a mobile surface", () => {
    const frame = readFileSync("components/layout/dashboard-frame.tsx", "utf8");
    expect(frame).toContain("shouldClaimMobileReadOnly");
    expect(
      /\{!routeOwnsMobileSurface \? \(\s*<div className="ad-console-mobile-readonly"/.test(
        frame,
      ),
      "the banner still renders from surface ownership rather than write capability",
    ).toBe(false);
  });
});
