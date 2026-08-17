import { describe, expect, it } from "vitest";

import { isGoogleAdsReadComplete } from "@/lib/google-ads/read-completeness";

describe("Google Ads read completeness", () => {
  it("accepts a proven complete read, including a proven empty result", () => {
    expect(
      isGoogleAdsReadComplete({
        dataState: "ready",
        partial: false,
        isPartial: false,
        completion: { evidenceAvailable: true, state: "converging" },
      }),
    ).toBe(true);
  });

  it("accepts an explicitly identified successful current-day provider read", () => {
    expect(
      isGoogleAdsReadComplete({
        dataState: "ready",
        partial: false,
        isPartial: false,
        readSource: "live_overlay_current_day",
      }),
    ).toBe(true);
  });

  it.each([
    undefined,
    { dataState: "partial", partial: true, isPartial: true },
    { dataState: "ready", partial: false, isPartial: true },
    { dataState: "ready", partial: false, isPartial: false },
    { dataState: "ready", partial: false, isPartial: false, completion: null },
    {
      dataState: "ready",
      partial: false,
      isPartial: false,
      completion: { evidenceAvailable: false, state: "unknown" },
    },
  ])("refuses unread or incomplete provenance %#", (meta) => {
    expect(isGoogleAdsReadComplete(meta)).toBe(false);
  });
});
