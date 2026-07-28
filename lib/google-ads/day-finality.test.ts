import { describe, expect, it } from "vitest";
import {
  GOOGLE_ADS_CONVERSION_LOOKBACK_DAYS,
  GOOGLE_ADS_METRICS_SETTLE_HOURS,
  GOOGLE_ADS_TIER_REFRESH_MINUTES,
  hoursIntoAccountDay,
  resolveAccountDayClosedAt,
  resolveGoogleAdsFreshnessTier,
} from "./day-finality";

/**
 * Google publishes no instant at which a date stops changing: clicks/cost carry
 * ~1h freshness, last-click conversions ~3h and other models ~15h, reports are
 * revised "one or more days" later for invalid traffic and late conversions,
 * and a conversion can be attributed back to its click date for the whole
 * conversion window — 1 to 90 days, default 30.
 *
 * So these tests pin a model with NO terminal state. The strongest thing any
 * tier asserts is "past the configured lookback", which is a policy horizon we
 * chose, not a provider guarantee.
 */
describe("resolveGoogleAdsFreshnessTier", () => {
  const accountToday = "2026-07-28";
  const closedAt = new Date("2026-07-27T21:00:00Z"); // Istanbul close of 07-27

  it("treats the account's own day as open, however many rows exist", () => {
    expect(
      resolveGoogleAdsFreshnessTier({
        date: accountToday,
        accountToday,
        dayClosedAt: null,
        now: new Date("2026-07-28T23:00:00Z"),
      }),
    ).toBe("open");
  });

  it("keeps a just-closed day settling until the metrics lag elapses", () => {
    // Google reports up to ~15h for non-last-click attribution models.
    expect(
      resolveGoogleAdsFreshnessTier({
        date: "2026-07-27",
        accountToday,
        dayClosedAt: closedAt,
        now: new Date(closedAt.getTime() + (GOOGLE_ADS_METRICS_SETTLE_HOURS - 1) * 3_600_000),
      }),
    ).toBe("settling");
  });

  it("moves to converging once metrics settle — NOT to a terminal state", () => {
    const tier = resolveGoogleAdsFreshnessTier({
      date: "2026-07-27",
      accountToday,
      dayClosedAt: closedAt,
      now: new Date(closedAt.getTime() + (GOOGLE_ADS_METRICS_SETTLE_HOURS + 1) * 3_600_000),
    });
    expect(tier).toBe("converging");
    // The point of the model: settled metrics do not mean settled conversions.
    expect(tier).not.toBe("aged");
  });

  it("stays converging for the whole conversion window, because late conversions land", () => {
    const almostExhausted = new Date(
      closedAt.getTime() + (GOOGLE_ADS_CONVERSION_LOOKBACK_DAYS * 24 - 1) * 3_600_000,
    );
    expect(
      resolveGoogleAdsFreshnessTier({
        date: "2026-07-27",
        accountToday,
        dayClosedAt: closedAt,
        now: almostExhausted,
      }),
    ).toBe("converging");
  });

  it("only ages a date past the configured lookback, and even then keeps a heartbeat", () => {
    expect(
      resolveGoogleAdsFreshnessTier({
        date: "2026-07-27",
        accountToday,
        dayClosedAt: closedAt,
        now: new Date(
          closedAt.getTime() + (GOOGLE_ADS_CONVERSION_LOOKBACK_DAYS * 24 + 1) * 3_600_000,
        ),
      }),
    ).toBe("aged");
    // Finite on purpose: "aged" is a horizon, not immutability.
    expect(Number.isFinite(GOOGLE_ADS_TIER_REFRESH_MINUTES.aged)).toBe(true);
    expect(GOOGLE_ADS_TIER_REFRESH_MINUTES.aged).toBeGreaterThan(0);
  });

  it("never claims settlement when the day close is unknown", () => {
    // No close proof means we cannot reason about elapsed time at all.
    expect(
      resolveGoogleAdsFreshnessTier({
        date: "2026-07-01",
        accountToday,
        dayClosedAt: null,
        now: new Date("2026-07-28T12:00:00Z"),
      }),
    ).toBe("settling");
  });

  it("honours the documented 1-90 day conversion window bound", () => {
    expect(GOOGLE_ADS_CONVERSION_LOOKBACK_DAYS).toBeGreaterThanOrEqual(1);
    expect(GOOGLE_ADS_CONVERSION_LOOKBACK_DAYS).toBeLessThanOrEqual(90);
  });

  it("refreshes hotter tiers more often than colder ones", () => {
    const { open, settling, converging, aged } = GOOGLE_ADS_TIER_REFRESH_MINUTES;
    expect(open).toBeLessThan(settling);
    expect(settling).toBeLessThan(converging);
    expect(converging).toBeLessThan(aged);
  });
});

describe("account-clock helpers", () => {
  it("reads the hour from the account's own zone, not the server's", () => {
    const reference = new Date("2026-07-28T02:30:00Z");
    expect(hoursIntoAccountDay("Europe/Istanbul", reference)).toBeCloseTo(5.5, 1);
    expect(hoursIntoAccountDay("America/Los_Angeles", reference)).toBeCloseTo(19.5, 1);
  });

  it("resolves the closing instant of a day in the account's zone", () => {
    expect(
      resolveAccountDayClosedAt({ date: "2026-07-27", timeZone: "Europe/Istanbul" })!.toISOString(),
    ).toBe("2026-07-27T21:00:00.000Z");
  });

  it("resolves the closing instant across a DST spring-forward", () => {
    // 2026-03-08 is a 23-hour day in Los Angeles.
    expect(
      resolveAccountDayClosedAt({
        date: "2026-03-08",
        timeZone: "America/Los_Angeles",
      })!.toISOString(),
    ).toBe("2026-03-09T07:00:00.000Z");
  });

  it("resolves the closing instant across a DST fall-back", () => {
    // 2026-11-01 is a 25-hour day in Los Angeles.
    expect(
      resolveAccountDayClosedAt({
        date: "2026-11-01",
        timeZone: "America/Los_Angeles",
      })!.toISOString(),
    ).toBe("2026-11-02T08:00:00.000Z");
  });

  it("REFUSES an invalid timezone rather than silently using UTC", () => {
    // Silently defaulting to UTC would finalize a Los Angeles account's day
    // seven hours early. Returning null forces the caller to fail closed.
    expect(resolveAccountDayClosedAt({ date: "2026-07-27", timeZone: "Not/AZone" })).toBeNull();
    expect(resolveAccountDayClosedAt({ date: "2026-07-27", timeZone: "" })).toBeNull();
    expect(resolveAccountDayClosedAt({ date: "2026-07-27", timeZone: "   " })).toBeNull();
  });
});
