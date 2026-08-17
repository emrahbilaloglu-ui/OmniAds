import { describe, expect, it } from "vitest";

import {
  buildCommercialTruthWindow,
  TRUTH_WINDOW_DAYS,
} from "@/components/commercial-truth/commercial-truth-window";

describe("buildCommercialTruthWindow", () => {
  it("is the 28 days the screen's labels claim, inclusive of both ends", () => {
    expect(TRUTH_WINDOW_DAYS).toBe(28);
    const window = buildCommercialTruthWindow("UTC", new Date("2026-08-17T10:00:00.000Z"));
    expect(window.endDate).toBe("2026-08-17");
    expect(window.startDate).toBe("2026-07-21");
    expect(window.days).toBe(28);

    const span =
      (Date.parse(`${window.endDate}T00:00:00Z`) - Date.parse(`${window.startDate}T00:00:00Z`)) /
        86_400_000 +
      1;
    expect(span).toBe(28);
  });

  it("is not the 30-day window every route defaults to", () => {
    const window = buildCommercialTruthWindow("UTC", new Date("2026-08-17T10:00:00.000Z"));
    // `lib/meta/campaigns-source.ts` would have started at nDaysAgo(29).
    expect(window.startDate).not.toBe("2026-07-19");
  });

  it("ends on the workspace's own day, not the runtime's", () => {
    // 22:30 UTC is already the next day in Istanbul (UTC+3).
    const at = new Date("2026-08-17T22:30:00.000Z");
    expect(buildCommercialTruthWindow("Europe/Istanbul", at).endDate).toBe("2026-08-18");
    expect(buildCommercialTruthWindow("UTC", at).endDate).toBe("2026-08-17");
    // 02:30 UTC is still the previous day in Los Angeles (UTC-7).
    const early = new Date("2026-08-17T02:30:00.000Z");
    expect(buildCommercialTruthWindow("America/Los_Angeles", early).endDate).toBe("2026-08-16");
  });

  it("still produces a window when the stored timezone is unusable", () => {
    const window = buildCommercialTruthWindow("Not/AZone", new Date("2026-08-17T10:00:00.000Z"));
    expect(window.days).toBe(28);
    expect(window.endDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(window.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
