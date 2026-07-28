import { describe, expect, it } from "vitest";
import {
  GOOGLE_ADS_DAY_SETTLE_HOURS,
  GOOGLE_ADS_FINALITY_REREAD_WINDOW_DAYS,
  hoursIntoAccountDay,
  resolveAccountDayClosedAt,
  resolveGoogleAdsDateTruthState,
  resolveGoogleAdsRereadDates,
} from "./day-finality";

/**
 * Google Ads coverage is `SELECT DISTINCT date` — mere row existence. A date
 * read once at 01:40 becomes "covered", every later tick that day skips it, and
 * the D+1 path then marks it finalize-complete without calling Google. These
 * tests pin the state machine that replaces "a row exists and time passed" with
 * "the provider was fetched after this account's day closed".
 *
 * Pure functions only. The database invariant — that finality cannot be
 * recorded without a closed-day proof — is enforced by a CHECK constraint and
 * proven against real PostgreSQL in
 * scripts/ephemeral-postgres-google-ads-finality-seam.ts.
 */
describe("resolveGoogleAdsDateTruthState", () => {
  const accountToday = "2026-07-28";

  it("treats the account's own today as provisional, always", () => {
    // The intraday freeze starts here: today must never be finalizable, no
    // matter how many rows already exist for it.
    expect(
      resolveGoogleAdsDateTruthState({
        date: accountToday,
        accountToday,
        hoursIntoAccountToday: 23.9,
      }),
    ).toBe("provisional");
  });

  it("treats a future date as provisional rather than settled", () => {
    expect(
      resolveGoogleAdsDateTruthState({
        date: "2026-07-29",
        accountToday,
        hoursIntoAccountToday: 12,
      }),
    ).toBe("provisional");
  });

  it("keeps the just-closed day provisional until the settle delay elapses", () => {
    // Google restates a just-closed day for a while. Finalizing at 00:00:01
    // would record a number that is about to change.
    expect(
      resolveGoogleAdsDateTruthState({
        date: "2026-07-27",
        accountToday,
        hoursIntoAccountToday: GOOGLE_ADS_DAY_SETTLE_HOURS - 0.1,
      }),
    ).toBe("provisional");
  });

  it("settles the just-closed day once the settle delay has elapsed", () => {
    expect(
      resolveGoogleAdsDateTruthState({
        date: "2026-07-27",
        accountToday,
        hoursIntoAccountToday: GOOGLE_ADS_DAY_SETTLE_HOURS,
      }),
    ).toBe("settled");
  });

  it("treats older dates as settled regardless of the hour", () => {
    expect(
      resolveGoogleAdsDateTruthState({
        date: "2026-07-20",
        accountToday,
        hoursIntoAccountToday: 0,
      }),
    ).toBe("settled");
  });
});

describe("resolveGoogleAdsRereadDates", () => {
  const accountToday = "2026-07-28";

  it("is bounded by the window whatever the state of history", () => {
    // The whole point of a bounded window: no amount of unfinalized history can
    // make one pass re-read more than this.
    const dates = resolveGoogleAdsRereadDates({ accountToday, finalDates: [] });
    expect(dates).toHaveLength(GOOGLE_ADS_FINALITY_REREAD_WINDOW_DAYS);
    expect(dates[0]).toBe(accountToday);
  });

  it("always includes today, because today is always mutable", () => {
    // Even if something wrongly recorded today as final, it must be re-read.
    const dates = resolveGoogleAdsRereadDates({
      accountToday,
      finalDates: ["2026-07-27", "2026-07-26"],
    });
    expect(dates).toContain(accountToday);
  });

  it("skips dates that already carry finality evidence", () => {
    const dates = resolveGoogleAdsRereadDates({
      accountToday,
      finalDates: ["2026-07-27"],
    });
    expect(dates).not.toContain("2026-07-27");
    expect(dates).toContain("2026-07-26");
  });

  it("re-reads a date with NO finality record, which is how pre-existing days recover", () => {
    // Absence is a third state: never tracked. It is neither trusted as final
    // nor an obligation to re-read all history — the window bounds it.
    const dates = resolveGoogleAdsRereadDates({ accountToday, finalDates: [] });
    expect(dates).toEqual(["2026-07-28", "2026-07-27", "2026-07-26"]);
  });

  it("honours an explicit window and never returns fewer than one day", () => {
    expect(
      resolveGoogleAdsRereadDates({ accountToday, finalDates: [], windowDays: 7 }),
    ).toHaveLength(7);
    expect(
      resolveGoogleAdsRereadDates({ accountToday, finalDates: [], windowDays: 0 }),
    ).toHaveLength(1);
  });
});

describe("account-clock helpers", () => {
  it("reads the hour from the account's own zone, not the server's", () => {
    // 2026-07-28T02:30Z is 05:30 in Istanbul and 19:30 the previous day in LA.
    const reference = new Date("2026-07-28T02:30:00Z");
    expect(hoursIntoAccountDay("Europe/Istanbul", reference)).toBeCloseTo(5.5, 1);
    expect(hoursIntoAccountDay("America/Los_Angeles", reference)).toBeCloseTo(19.5, 1);
  });

  it("resolves the closing instant of a day in the account's zone", () => {
    // Istanbul is UTC+3 year-round: 2026-07-27 closes at 2026-07-27T21:00Z.
    const closed = resolveAccountDayClosedAt({
      date: "2026-07-27",
      timeZone: "Europe/Istanbul",
    });
    expect(closed).not.toBeNull();
    expect(closed!.toISOString()).toBe("2026-07-27T21:00:00.000Z");
  });

  it("resolves the closing instant across a DST spring-forward", () => {
    // America/Los_Angeles springs forward on 2026-03-08 (a 23-hour day), so
    // 2026-03-08 closes at 07:00Z rather than 08:00Z.
    const closed = resolveAccountDayClosedAt({
      date: "2026-03-08",
      timeZone: "America/Los_Angeles",
    });
    expect(closed).not.toBeNull();
    expect(closed!.toISOString()).toBe("2026-03-09T07:00:00.000Z");
  });

  it("resolves the closing instant across a DST fall-back", () => {
    // 2026-11-01 is a 25-hour day in Los Angeles; it closes at 08:00Z.
    const closed = resolveAccountDayClosedAt({
      date: "2026-11-01",
      timeZone: "America/Los_Angeles",
    });
    expect(closed).not.toBeNull();
    expect(closed!.toISOString()).toBe("2026-11-02T08:00:00.000Z");
  });

  it("never claims a day closed in the future relative to its own zone", () => {
    // The closing instant must be after the day started, in every zone tested.
    for (const timeZone of [
      "Europe/Istanbul",
      "America/Los_Angeles",
      "Australia/Sydney",
      "UTC",
    ]) {
      const closed = resolveAccountDayClosedAt({ date: "2026-07-27", timeZone });
      expect(closed, timeZone).not.toBeNull();
      expect(closed!.getTime(), timeZone).toBeGreaterThan(
        new Date("2026-07-27T00:00:00Z").getTime() - 15 * 3600_000,
      );
    }
  });
});
