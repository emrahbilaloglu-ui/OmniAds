import { describe, expect, it } from "vitest";
import {
  clampCreativeDecisionOsDrawerWidth,
  CREATIVE_DECISION_OS_DRAWER_DEFAULT_WIDTH,
  CREATIVE_DECISION_OS_DRAWER_MIN_WIDTH,
} from "@/components/creatives/CreativeDecisionOsDrawer";

describe("clampCreativeDecisionOsDrawerWidth", () => {
  it("keeps the default width when the viewport has room", () => {
    expect(
      clampCreativeDecisionOsDrawerWidth(CREATIVE_DECISION_OS_DRAWER_DEFAULT_WIDTH, 1600),
    ).toBe(CREATIVE_DECISION_OS_DRAWER_DEFAULT_WIDTH);
  });

  it("respects the standard minimum width on wide viewports", () => {
    expect(clampCreativeDecisionOsDrawerWidth(640, 1400)).toBe(
      CREATIVE_DECISION_OS_DRAWER_MIN_WIDTH,
    );
  });

  it("falls back to viewport-safe width on narrow screens", () => {
    expect(clampCreativeDecisionOsDrawerWidth(1240, 900)).toBe(852);
  });
});
