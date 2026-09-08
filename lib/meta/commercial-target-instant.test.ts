/**
 * `Date.parse` WAS THE VALIDATOR, AND IT ACCEPTS DAYS THAT DO NOT EXIST.
 *
 * Round 8, item 2. Four independent places asked
 * `Number.isFinite(Date.parse(targetPack.updatedAt))` to decide whether an
 * operator's commercial targets carry a trustworthy clock — and that boolean
 * is what `freshness`, `commercialTruthTimestampTrusted`,
 * `commercialThresholdEligible`, the native `cutoff_unsafe` verdict and the
 * `commercialTargetProvenanceState` digest all hang off.
 *
 * The first half of this file pins the parser's actual behaviour on this
 * runtime, so the cases below are measured rather than asserted from memory,
 * and so a future runtime change cannot quietly make them vacuous. The second
 * half drives the replacement.
 */
import { describe, expect, it } from "vitest";

import {
  commercialTargetInstantMs,
  isCommercialTargetInstant,
  isCommercialTargetInstantWithinCutoff,
} from "@/lib/meta/commercial-target-instant";

/** Every invalid class the audit named, plus what `Date.parse` did with it. */
const INVALID: Array<[name: string, value: unknown]> = [
  ["an impossible rollover date", "2026-02-30T00:00:00.000Z"],
  ["a bare impossible rollover date", "2026-02-30"],
  ["Feb 29 in a non-leap year", "2026-02-29T00:00:00.000Z"],
  ["a date-only string", "2026-09-05"],
  ["a naked local time with no zone", "2026-09-05T03:00:00"],
  ["a prose date", "September 5, 2026"],
  ["an unpadded date", "2026-9-5"],
  ["a basic-format date", "20260905"],
  ["a month past twelve", "2026-13-01T00:00:00.000Z"],
  ["a day zero", "2026-09-00T00:00:00.000Z"],
  ["an hour past twenty-three", "2026-09-05T24:00:00.000Z"],
  ["a minute past fifty-nine", "2026-09-05T03:60:00.000Z"],
  ["a second past fifty-nine", "2026-09-05T03:00:60.000Z"],
  ["an out-of-range offset", "2026-09-05T03:00:00.000+25:00"],
  ["an empty string", ""],
  ["whitespace only", "   "],
  ["a number", 1_788_577_200_000],
  ["a Date object", new Date("2026-09-05T03:00:00.000Z")],
  ["null", null],
  ["undefined", undefined],
  ["an object", { updatedAt: "2026-09-05T03:00:00.000Z" }],
  ["a two-digit year", "0099-09-05T03:00:00.000Z"],
];

/** Shapes the database actually produces, which must survive untouched. */
const VALID: Array<[value: string, ms: number]> = [
  ["2026-09-05T03:00:00.000Z", Date.UTC(2026, 8, 5, 3, 0, 0, 0)],
  ["2026-09-05T03:00:00Z", Date.UTC(2026, 8, 5, 3, 0, 0, 0)],
  ["2026-09-05T03:00:00.123456Z", Date.UTC(2026, 8, 5, 3, 0, 0, 123)],
  ["2026-09-05T03:00:00+02:00", Date.UTC(2026, 8, 5, 1, 0, 0, 0)],
  ["2026-09-05T03:00:00-05:00", Date.UTC(2026, 8, 5, 8, 0, 0, 0)],
  // A real leap day in a real leap year.
  ["2028-02-29T12:00:00.000Z", Date.UTC(2028, 1, 29, 12, 0, 0, 0)],
];

describe("what Date.parse actually did, measured here", () => {
  /*
    THE MOTIVE, PINNED. If a runtime ever tightened `Date.parse` these
    assertions would fail loudly rather than letting the cases below quietly
    stop discriminating between the old rule and the new one.
  */
  it("silently rolls 2026-02-30 into March", () => {
    const rolled = Date.parse("2026-02-30");
    expect(Number.isFinite(rolled)).toBe(true);
    expect(new Date(rolled).toISOString().slice(0, 10)).toBe("2026-03-02");
  });

  it("silently rolls Feb 29 of a non-leap year into March", () => {
    const rolled = Date.parse("2026-02-29T00:00:00.000Z");
    expect(Number.isFinite(rolled)).toBe(true);
    expect(new Date(rolled).toISOString().slice(0, 10)).toBe("2026-03-01");
  });

  it("accepts a date-only string, a prose date and a naked local time", () => {
    for (const value of ["2026-09-05", "September 5, 2026", "2026-09-05T03:00:00"]) {
      expect(Number.isFinite(Date.parse(value))).toBe(true);
    }
  });
});

describe("the strict commercial-target instant", () => {
  it.each(INVALID)("refuses %s", (_name, value) => {
    expect(commercialTargetInstantMs(value)).toBeNull();
    expect(isCommercialTargetInstant(value)).toBe(false);
  });

  it.each(VALID)("accepts %s and resolves it to the exact instant", (value, ms) => {
    expect(commercialTargetInstantMs(value)).toBe(ms);
    expect(isCommercialTargetInstant(value)).toBe(true);
  });

  it("tolerates transport whitespace around an otherwise valid instant", () => {
    expect(commercialTargetInstantMs("  2026-09-05T03:00:00.000Z  ")).toBe(
      Date.UTC(2026, 8, 5, 3, 0, 0, 0),
    );
  });

  it("truncates sub-millisecond precision rather than rounding it", () => {
    /*
      Rounding could move an instant ACROSS a cutoff, and a cutoff comparison
      must not depend on how a fraction was rendered.
    */
    expect(commercialTargetInstantMs("2026-09-05T03:00:00.999999Z")).toBe(
      Date.UTC(2026, 8, 5, 3, 0, 0, 999),
    );
  });

  it("reads the same instant identically however its offset is written", () => {
    // The two spellings of one instant must not become two facts.
    expect(commercialTargetInstantMs("2026-09-05T05:00:00.000Z")).toBe(
      commercialTargetInstantMs("2026-09-05T07:00:00.000+02:00"),
    );
  });
});

describe("the cutoff comparison", () => {
  const CUTOFF = Date.UTC(2026, 8, 5, 3, 0, 0, 0);

  it("accepts an instant at the cutoff", () => {
    expect(
      isCommercialTargetInstantWithinCutoff("2026-09-05T03:00:00.000Z", CUTOFF),
    ).toBe(true);
  });

  it("accepts an instant before the cutoff", () => {
    expect(
      isCommercialTargetInstantWithinCutoff("2026-09-04T23:59:59.999Z", CUTOFF),
    ).toBe(true);
  });

  it("refuses an instant one millisecond after the cutoff", () => {
    // The boundary itself, so a future widening has to face this line.
    expect(
      isCommercialTargetInstantWithinCutoff("2026-09-05T03:00:00.001Z", CUTOFF),
    ).toBe(false);
  });

  it("refuses a future instant however far out", () => {
    expect(
      isCommercialTargetInstantWithinCutoff("2027-01-01T00:00:00.000Z", CUTOFF),
    ).toBe(false);
  });

  it("refuses an invalid instant regardless of the cutoff", () => {
    expect(
      isCommercialTargetInstantWithinCutoff("2026-02-30T00:00:00.000Z", CUTOFF),
    ).toBe(false);
  });

  it("refuses when the cutoff itself is not a number", () => {
    expect(
      isCommercialTargetInstantWithinCutoff("2026-09-05T03:00:00.000Z", NaN),
    ).toBe(false);
  });
});
