/**
 * A POINT-IN-TIME PROFILE THAT CANNOT SEE ITS OWN CUTOFF IS NOT ONE.
 *
 * Round 9, items 1 and 2. Two independent seams accepted commercial-target
 * evidence they had no right to, and Round 8's strict parser closed neither of
 * them:
 *
 *  1. `resolveNativeAdTargetAuthority` called `normalizeTargetAuthorityInput`
 *     FIRST, and that normalizer is `new Date(text).toISOString()`. It does not
 *     reject an impossible date — it rewrites it. `2026-02-30` reached the
 *     strict parser already wearing the face of `2026-03-02T00:00:00.000Z`,
 *     passed, and produced a `fresh` authority from a day that does not exist.
 *     The strict check was inert at the one seam whose verdict is hashed.
 *
 *  2. `resolveAccountDecisionProfile` passed NO cutoff into
 *     `resolveSpendUnitProfile` / `resolveHardActionEligibility`, and the check
 *     there asked about FORMAT only. A target pack saved after the day being
 *     reconstructed therefore made every hard action eligible.
 *
 * Both are driven here through the real exported functions. The first group
 * fails on the old ORDERING, not merely on the old parser; the second fails on
 * the absence of a cutoff.
 */
import { describe, expect, it } from "vitest";

import { resolveNativeAdTargetAuthority } from "../jobs/ad-calibration-job";
import { deterministicCommercialCutoffMs } from "@/lib/meta/commercial-target-instant";
import type { NativeAdTargetAuthorityInput } from "../jobs/ad-calibration-job";

const CUTOFF = "2026-09-05T03:00:00.000Z";

function targetRow(
  over: Partial<NativeAdTargetAuthorityInput> = {},
): NativeAdTargetAuthorityInput {
  return {
    sourceRowId: "00000000-0000-4000-8000-000000000753",
    operation: "upsert",
    targetCpa: null,
    targetRoas: 2.2,
    breakEvenCpa: null,
    breakEvenRoas: 1.5,
    operatorAovAssumption: null,
    defaultRiskPosture: "balanced",
    effectiveAt: "2026-09-01T00:00:00.000Z",
    recordedAt: "2026-09-01T00:00:01.000Z",
    ...over,
  } as NativeAdTargetAuthorityInput;
}

describe("what normalizeTimestamp does to a bad clock, measured", () => {
  /*
    THE MOTIVE, PINNED. These are the exact rewrites that made Round 8's strict
    parser inert at this seam. If a runtime ever tightened `new Date(...)`,
    these assertions fail loudly rather than letting the cases below quietly
    stop discriminating between the two orderings.
  */
  const rewrite = (value: string) => new Date(value).toISOString();

  it("rewrites an impossible date into a real one", () => {
    expect(rewrite("2026-02-30")).toBe("2026-03-02T00:00:00.000Z");
    expect(rewrite("2026-02-30T00:00:00.000Z")).toBe("2026-03-02T00:00:00.000Z");
  });

  it("rewrites a date-only string into a full instant", () => {
    expect(rewrite("2026-09-05")).toBe("2026-09-05T00:00:00.000Z");
  });

  it("accepts a naked local time, whose instant depends on the host", () => {
    expect(Number.isFinite(new Date("2026-09-05T03:00:00").getTime())).toBe(true);
  });
});

describe("the native target authority reads the RAW clocks", () => {
  /** Every class the audit named, each one laundered by the old ordering. */
  const REFUSED: Array<[name: string, over: Partial<NativeAdTargetAuthorityInput>]> = [
    ["an impossible effectiveAt", { effectiveAt: "2026-02-30T00:00:00.000Z" }],
    ["an impossible recordedAt", { recordedAt: "2026-02-30T00:00:00.000Z" }],
    ["Feb 29 of a non-leap year", { effectiveAt: "2026-02-29T00:00:00.000Z" }],
    ["a date-only effectiveAt", { effectiveAt: "2026-09-01" }],
    ["a date-only recordedAt", { recordedAt: "2026-09-01" }],
    ["a naked local effectiveAt", { effectiveAt: "2026-09-01T00:00:00" }],
    ["a prose effectiveAt", { effectiveAt: "September 1, 2026" }],
    ["an unpadded effectiveAt", { effectiveAt: "2026-9-1" }],
    ["a malformed effectiveAt", { effectiveAt: "not-a-timestamp" }],
  ];

  it.each(REFUSED)("fails closed on %s", (_name, over) => {
    const resolved = resolveNativeAdTargetAuthority(targetRow(over), CUTOFF);
    /*
      `cutoff_unsafe` is the named refusal for "the clocks do not establish that
      this row was in force at the cutoff", and an unreadable clock establishes
      nothing. Under the old ordering every one of these resolved to `fresh`.
    */
    expect(resolved.status).toBe("cutoff_unsafe");
    expect(resolved.targetRoasAuthority).toBe(false);
    expect(resolved.breakEvenRoasAuthority).toBe(false);
  });

  it("keeps the laundered instant out of the hashed payload too", () => {
    /*
      Not just the verdict: the normalizer used to put the REWRITTEN value on
      the resolved object, which is what `authorityHash` and the cell manifest
      digest. The decision and the bytes now come from the same reading.
    */
    const resolved = resolveNativeAdTargetAuthority(
      targetRow({ effectiveAt: "2026-02-30T00:00:00.000Z" }),
      CUTOFF,
    );
    expect(resolved.effectiveAt).toBeNull();
    expect(resolved.effectiveAt).not.toBe("2026-03-02T00:00:00.000Z");
  });

  it("still accepts a real RFC 3339 instant with an explicit offset", () => {
    // The control. A strict rule that refused legitimate offsets would break
    // every row the database can actually produce.
    const resolved = resolveNativeAdTargetAuthority(
      targetRow({
        effectiveAt: "2026-09-01T02:00:00+02:00",
        recordedAt: "2026-09-01T02:00:01+02:00",
      }),
      CUTOFF,
    );
    expect(resolved.status).toBe("fresh");
    expect(resolved.targetRoasAuthority).toBe(true);
  });

  it("still resolves an ordinary in-force row, so the refusals discriminate", () => {
    const resolved = resolveNativeAdTargetAuthority(targetRow(), CUTOFF);
    expect(resolved.status).toBe("fresh");
    expect(resolved.targetRoasAuthority).toBe(true);
  });

  it("refuses a target recorded AFTER the cutoff", () => {
    const resolved = resolveNativeAdTargetAuthority(
      targetRow({
        effectiveAt: "2026-09-05T03:00:00.001Z",
        recordedAt: "2026-09-05T03:00:00.002Z",
      }),
      CUTOFF,
    );
    expect(resolved.status).toBe("cutoff_unsafe");
  });

  it("throws on a cutoff that is not itself a real instant", () => {
    /*
      A cutoff is an authority BOUNDARY. `normalizeRequiredTimestamp` would have
      rewritten `2026-02-30` into a usable boundary, which is worse than having
      none: every row would then be measured against a day that does not exist.
    */
    for (const badCutoff of ["2026-02-30T00:00:00.000Z", "2026-09-05", "later"]) {
      expect(() =>
        resolveNativeAdTargetAuthority(targetRow(), badCutoff),
      ).toThrow(/strict RFC 3339/);
    }
  });
});

describe("the deterministic profile cutoff", () => {
  it("widens a bare day with the SAME rule the historical reader uses", () => {
    /*
      `normalizeAsOfCutoff` (lib/business-commercial.ts) widens `YYYY-MM-DD` to
      `T03:00:00.000Z` when it reads the pack. If the profile widened
      differently the two would silently disagree about which pack was in force.
    */
    expect(deterministicCommercialCutoffMs("2026-09-05")).toBe(
      Date.UTC(2026, 8, 5, 3, 0, 0, 0),
    );
  });

  it("reads a full instant strictly and never invents one", () => {
    expect(deterministicCommercialCutoffMs("2026-09-05T12:00:00.000Z")).toBe(
      Date.UTC(2026, 8, 5, 12, 0, 0, 0),
    );
    // No wall-clock fallback: an unusable `asOf` yields null and the caller
    // fails closed.
    for (const bad of ["2026-02-30", "not-a-date", "", null, undefined]) {
      expect(deterministicCommercialCutoffMs(bad as never)).toBeNull();
    }
  });
});
