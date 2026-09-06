import { describe, expect, it } from "vitest";

import { nativeAdShadowSlotStart } from "@/lib/creative-decision-engine/jobs/native-ad-scheduled";

/*
  The native chain produces twice a day now, and the reason is arithmetic: a
  native `cut` is withheld when its inputs are older than 12 hours, and a
  single 03:00 UTC production means everything after 15:00 is past that. The
  threshold was never the problem. Producing once was.
*/
describe("nativeAdShadowSlotStart", () => {
  it("is closed before the first slot", () => {
    expect(nativeAdShadowSlotStart(new Date("2026-05-08T02:59:00.000Z")))
      .toBeNull();
  });

  it("returns the window start, not the tick's own time", () => {
    // The window start is what a run is compared against: a run that finished
    // at 03:05 belongs to the 03 slot, however late this tick is.
    expect(nativeAdShadowSlotStart(new Date("2026-05-08T09:41:00.000Z"))?.toISOString())
      .toBe("2026-05-08T03:00:00.000Z");
  });

  it("moves to the afternoon window at 15:00", () => {
    expect(nativeAdShadowSlotStart(new Date("2026-05-08T15:00:00.000Z"))?.toISOString())
      .toBe("2026-05-08T15:00:00.000Z");
    expect(nativeAdShadowSlotStart(new Date("2026-05-08T23:59:00.000Z"))?.toISOString())
      .toBe("2026-05-08T15:00:00.000Z");
  });
});
