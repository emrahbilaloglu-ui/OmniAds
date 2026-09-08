/**
 * THE WINDOW ENDS WHERE THE ADVERTISER'S DAY ENDS, NOT WHERE THE DATABASE
 * SESSION SAYS IT DOES.
 *
 * Round 10, item 4. Two historical readers bounded a `timestamptz` column
 * against a bare date:
 *
 *     AND outcome_log.occurred_at < (${cutoff}::date + 1)
 *     AND captured_at             < (${cutoff}::date + 1)
 *
 * PostgreSQL casts that `date` to `timestamptz` using the SESSION's `TimeZone`.
 * So "the end of the served day" was a property of the connection. Against a
 * Los Angeles account on a UTC session the window closed seven or eight hours
 * early and silently discarded the last third of the advertiser's own day;
 * against an Istanbul account it closed three hours late and pulled in the next
 * day's evidence. Both feed a confidence signal that can carry a recommendation
 * into the act lane, so both directions are wrong in the direction that matters.
 */
import { describe, expect, it } from "vitest";

import {
  isSupportedIanaTimeZone,
  providerLocalDayEndExclusive,
  resolveMetaProviderLocalDayEnd,
} from "@/lib/meta/provider-local-day";

const iso = (value: Date | null) => value?.toISOString() ?? null;

describe("the exclusive end of a provider-local day", () => {
  it("closes a Los Angeles day at 07:00Z during PDT", () => {
    // 2026-09-05 is inside US daylight time: UTC-7, so the next local midnight
    // is 07:00Z on the 6th.
    expect(
      iso(
        providerLocalDayEndExclusive({
          day: "2026-09-05",
          timeZone: "America/Los_Angeles",
        }),
      ),
    ).toBe("2026-09-06T07:00:00.000Z");
  });

  it("closes a Los Angeles day at 08:00Z during PST", () => {
    // The same account, five months later: UTC-8. A fixed offset would be wrong
    // for half the year, which is why a bare `+HH:MM` string is refused.
    expect(
      iso(
        providerLocalDayEndExclusive({
          day: "2026-01-15",
          timeZone: "America/Los_Angeles",
        }),
      ),
    ).toBe("2026-01-16T08:00:00.000Z");
  });

  it("closes an Istanbul day at 21:00Z, year round", () => {
    // Türkiye has observed permanent UTC+3 since 2016, so both samples agree —
    // and both are three hours EARLIER than a UTC session would have closed it.
    expect(
      iso(
        providerLocalDayEndExclusive({
          day: "2026-09-05",
          timeZone: "Europe/Istanbul",
        }),
      ),
    ).toBe("2026-09-05T21:00:00.000Z");
    expect(
      iso(
        providerLocalDayEndExclusive({
          day: "2026-01-15",
          timeZone: "Europe/Istanbul",
        }),
      ),
    ).toBe("2026-01-15T21:00:00.000Z");
  });

  it("lands the boundary correctly ACROSS a DST transition", () => {
    /*
      2026-11-01 is the US fall-back day: the local day is 25 hours long and the
      offset in force at its END (UTC-8) is not the offset in force at its start
      (UTC-7). A single-pass offset lookup taken at the naive guess would place
      this an hour off, which is why the resolution samples twice.
    */
    expect(
      iso(
        providerLocalDayEndExclusive({
          day: "2026-11-01",
          timeZone: "America/Los_Angeles",
        }),
      ),
    ).toBe("2026-11-02T08:00:00.000Z");
    // And the spring-forward day, 23 hours long.
    expect(
      iso(
        providerLocalDayEndExclusive({
          day: "2026-03-08",
          timeZone: "America/Los_Angeles",
        }),
      ),
    ).toBe("2026-03-09T07:00:00.000Z");
  });

  it("differs from the UTC reading, which is the whole defect", () => {
    /*
      The control. If the advertiser boundary happened to coincide with the UTC
      one, `(date + 1)` on a UTC session would have been harmless.
    */
    const utcBoundary = "2026-09-06T00:00:00.000Z";
    for (const timeZone of ["America/Los_Angeles", "Europe/Istanbul"]) {
      expect(
        iso(providerLocalDayEndExclusive({ day: "2026-09-05", timeZone })),
      ).not.toBe(utcBoundary);
    }
  });

  it("refuses a day or a zone it cannot resolve", () => {
    // An impossible calendar day is refused rather than rolled into March —
    // the same guard the commercial-target instant parser carries.
    for (const bad of ["", "2026-9-5", "not-a-day", "2026-02-30", "2026-13-01", "2026-09-00"]) {
      expect(
        providerLocalDayEndExclusive({ day: bad, timeZone: "UTC" }),
      ).toBeNull();
    }
    for (const zone of ["", "+03:00", "PST", "Mars/Olympus", null, 3]) {
      expect(
        providerLocalDayEndExclusive({
          day: "2026-09-05",
          timeZone: zone as never,
        }),
      ).toBeNull();
    }
  });
});

describe("the IANA zone predicate", () => {
  it("accepts real zones and UTC", () => {
    for (const zone of [
      "America/Los_Angeles",
      "Europe/Istanbul",
      "Australia/Sydney",
      "UTC",
    ]) {
      expect(isSupportedIanaTimeZone(zone)).toBe(true);
    }
  });

  it("refuses fixed offsets, abbreviations and junk", () => {
    /*
      A fixed offset cannot express a DST rule, and an abbreviation is
      ambiguous across regions. Both would silently produce a wrong boundary
      rather than a refusal, which is the failure mode this whole item removes.
    */
    for (const zone of ["+03:00", "-0700", "PST", "EST5EDT?", "", null, {}]) {
      expect(isSupportedIanaTimeZone(zone as never)).toBe(false);
    }
  });
});

describe("the account-scoped resolution", () => {
  const query = (rows: Array<Record<string, unknown>>) => {
    const calls: Array<{ text: string; params: unknown[] }> = [];
    const fn = async (text: string, params: unknown[]) => {
      calls.push({ text, params });
      return rows;
    };
    return { fn, calls };
  };

  it("reads the zone through the business binding, not the account alone", async () => {
    const { fn, calls } = query([{ timezone: "Europe/Istanbul" }]);
    const resolved = await resolveMetaProviderLocalDayEnd({
      businessId: "biz_1",
      providerAccountId: "act_1",
      day: "2026-09-05",
      query: fn,
    });
    expect(iso(resolved)).toBe("2026-09-05T21:00:00.000Z");
    /*
      CROSS-ACCOUNT EXCLUSION. The join goes through
      `business_provider_accounts` and matches the physical binding columns, so
      one business cannot have its window bounded by another's advertiser zone.
    */
    expect(calls[0]?.text).toContain("business_provider_accounts");
    expect(calls[0]?.text).toContain("binding.provider_account_id = $2");
    expect(calls[0]?.params).toEqual(["biz_1", "act_1"]);
  });

  it("fails closed on no binding, a null zone and an unresolvable zone", async () => {
    for (const rows of [
      [],
      [{ timezone: null }],
      [{ timezone: "   " }],
      [{ timezone: "Mars/Olympus" }],
      // Two bindings is ambiguity, not a choice to make.
      [{ timezone: "UTC" }, { timezone: "Europe/Istanbul" }],
    ]) {
      const { fn } = query(rows);
      expect(
        await resolveMetaProviderLocalDayEnd({
          businessId: "biz_1",
          providerAccountId: "act_1",
          day: "2026-09-05",
          query: fn,
        }),
      ).toBeNull();
    }
  });

  it("fails closed when the zone read rejects", async () => {
    expect(
      await resolveMetaProviderLocalDayEnd({
        businessId: "biz_1",
        providerAccountId: "act_1",
        day: "2026-09-05",
        query: async () => {
          throw new Error("provider_accounts read failed");
        },
      }),
    ).toBeNull();
  });

  it("is independent of this process's own timezone", async () => {
    /*
      The DB-session analogue, at the layer this code owns. The resolution is
      computed entirely from `Intl` with an explicit `timeZone`, so nothing here
      reads the ambient zone — which is what made the SQL form depend on the
      connection in the first place.
    */
    const { fn } = query([{ timezone: "America/Los_Angeles" }]);
    const resolved = await resolveMetaProviderLocalDayEnd({
      businessId: "biz_1",
      providerAccountId: "act_1",
      day: "2026-09-05",
      query: fn,
    });
    expect(iso(resolved)).toBe("2026-09-06T07:00:00.000Z");
  });
});
