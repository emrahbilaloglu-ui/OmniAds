import { describe, expect, it } from "vitest";
import { resolveGoogleAdsCompletion } from "./completion-semantics";

/**
 * Roughly forty status fields used to derive "ready", "100%", "Active" and
 * "stop polling" from row existence alone, so a day captured at 01:40 and never
 * refreshed rendered as a green, non-refreshing, complete workspace. This is
 * the one decision they now share.
 */
describe("resolveGoogleAdsCompletion", () => {
  const base = {
    totalDays: 7,
    coveredDays: 7,
    postCloseObservedDays: 7,
    lookbackExhaustedDays: 7,
    includesOpenDay: false,
  };

  it("never reports complete when a day has rows but was never re-read after closing", () => {
    // The exact frozen-day case: fully covered, never observed post-close.
    const verdict = resolveGoogleAdsCompletion({
      ...base,
      postCloseObservedDays: 0,
      lookbackExhaustedDays: 0,
    });
    expect(verdict.state).toBe("provisional");
    expect(verdict.complete).toBe(false);
    expect(verdict.percent).toBeLessThan(100);
    expect(verdict.mayStopPolling).toBe(false);
  });

  it("computes percent from post-close observations, not coverage", () => {
    const verdict = resolveGoogleAdsCompletion({
      ...base,
      postCloseObservedDays: 3,
      lookbackExhaustedDays: 0,
    });
    // 3/7 = 42%, not the 100% that covered days would have produced.
    expect(verdict.percent).toBe(42);
  });

  it("never reaches 100 while the range includes the open day", () => {
    const verdict = resolveGoogleAdsCompletion({ ...base, includesOpenDay: true });
    expect(verdict.percent).toBeLessThan(100);
    expect(verdict.complete).toBe(false);
    expect(verdict.detail).toMatch(/today/i);
  });

  it("caps at 99 while conversions can still arrive", () => {
    // Every day re-read after closing, but inside the conversion window.
    const verdict = resolveGoogleAdsCompletion({ ...base, lookbackExhaustedDays: 2 });
    expect(verdict.state).toBe("converging");
    expect(verdict.percent).toBe(99);
    expect(verdict.complete).toBe(false);
    expect(verdict.mayStopPolling).toBe(false);
  });

  it("only settles once every day is observed post-close AND past the lookback", () => {
    const verdict = resolveGoogleAdsCompletion(base);
    expect(verdict.state).toBe("settled");
    expect(verdict.percent).toBe(100);
    expect(verdict.complete).toBe(true);
    expect(verdict.mayStopPolling).toBe(true);
  });

  it("reports missing before provisional when data is absent", () => {
    const verdict = resolveGoogleAdsCompletion({
      ...base,
      coveredDays: 4,
      postCloseObservedDays: 4,
      lookbackExhaustedDays: 4,
    });
    expect(verdict.state).toBe("missing");
    expect(verdict.detail).toMatch(/no data/i);
  });

  it("never allows polling to stop short of settled", () => {
    for (const partial of [
      { ...base, coveredDays: 1 },
      { ...base, postCloseObservedDays: 1, lookbackExhaustedDays: 0 },
      { ...base, lookbackExhaustedDays: 0 },
      { ...base, includesOpenDay: true },
    ]) {
      const verdict = resolveGoogleAdsCompletion(partial);
      expect(verdict.mayStopPolling, JSON.stringify(partial)).toBe(false);
    }
  });

  it("cannot be pushed over 100 by inconsistent counts", () => {
    const verdict = resolveGoogleAdsCompletion({
      totalDays: 5,
      coveredDays: 99,
      postCloseObservedDays: 99,
      lookbackExhaustedDays: 99,
      includesOpenDay: false,
    });
    expect(verdict.percent).toBe(100);
    expect(verdict.state).toBe("settled");
  });
});
