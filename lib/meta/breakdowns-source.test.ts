import { describe, expect, it } from "vitest";

import {
  resolveMetaBreakdownEmptyEvidence,
  resolveMetaBreakdownEmptyPublication,
} from "@/lib/meta/breakdowns-source";

const verified = {
  verificationState: "finalized_verified",
  sourceFetchedAt: "2026-04-02T00:00:00.000Z",
  publishedAt: "2026-04-02T00:05:00.000Z",
  asOf: "2026-04-02T00:05:00.000Z",
};

describe("resolveMetaBreakdownEmptyEvidence", () => {
  it("admits only a timestamped, finalized, complete zero-row slice", () => {
    expect(
      resolveMetaBreakdownEmptyEvidence({
        isPartial: false,
        hasRelevantBreakdownRows: false,
        verification: verified,
      }),
    ).toEqual({
      observed: true,
      observedAt: "2026-04-02T00:05:00.000Z",
    });
  });

  it.each([
    ["partial", true, false, verified],
    ["has rows", false, true, verified],
    [
      "not finalized",
      false,
      false,
      { ...verified, verificationState: "processing" },
    ],
    [
      "no observation instant",
      false,
      false,
      { ...verified, sourceFetchedAt: null, publishedAt: null, asOf: null },
    ],
  ])(
    "withholds %s as empty proof",
    (_label, isPartial, hasRows, verification) => {
      expect(
        resolveMetaBreakdownEmptyEvidence({
          isPartial: Boolean(isPartial),
          hasRelevantBreakdownRows: Boolean(hasRows),
          verification,
        }),
      ).toEqual({ observed: false, observedAt: null });
    },
  );
});

describe("resolveMetaBreakdownEmptyPublication", () => {
  it("withholds empty proof and marks an ok response partial while a not-ready reason exists", () => {
    expect(
      resolveMetaBreakdownEmptyPublication({
        status: "ok",
        isPartial: false,
        notReadyReason: "Breakdown warehouse data is still being prepared.",
        evidence: {
          observed: true,
          observedAt: "2026-04-02T00:05:00.000Z",
        },
      }),
    ).toEqual({
      isPartial: true,
      emptyObserved: false,
      emptyObservedAt: null,
    });
  });

  it("publishes only complete timestamped empty evidence on an ok response", () => {
    expect(
      resolveMetaBreakdownEmptyPublication({
        status: "ok",
        isPartial: false,
        notReadyReason: null,
        evidence: {
          observed: true,
          observedAt: "2026-04-02T00:05:00.000Z",
        },
      }),
    ).toEqual({
      isPartial: false,
      emptyObserved: true,
      emptyObservedAt: "2026-04-02T00:05:00.000Z",
    });
  });
});
