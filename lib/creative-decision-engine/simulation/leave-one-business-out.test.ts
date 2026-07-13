import { describe, expect, it } from "vitest";
import {
  leaveOneBusinessOut,
  summarizeLeaveOneBusinessOutMetric,
} from "./leave-one-business-out";

interface Row {
  business: string;
  value: number;
  weight?: number;
}

describe("leaveOneBusinessOut", () => {
  it("produces deterministic folds without mutating observation order", () => {
    const rows: Row[] = [
      { business: "zeta", value: 3 },
      { business: "alpha", value: 1 },
      { business: "alpha", value: 2 },
    ];
    const original = [...rows];
    const result = leaveOneBusinessOut(rows, {
      getBusinessId: (row) => row.business,
      summarize: (included) => included.map((row) => row.value).join(","),
    });

    expect(result.businessIds).toEqual(["alpha", "zeta"]);
    expect(result.fullSummary).toBe("3,1,2");
    expect(result.folds).toEqual([
      {
        heldOutBusinessId: "alpha",
        heldOutObservationCount: 2,
        includedBusinessIds: ["zeta"],
        includedObservationCount: 1,
        summary: "3",
      },
      {
        heldOutBusinessId: "zeta",
        heldOutObservationCount: 1,
        includedBusinessIds: ["alpha"],
        includedObservationCount: 2,
        summary: "1,2",
      },
    ]);
    expect(rows).toEqual(original);
  });
});

describe("summarizeLeaveOneBusinessOutMetric", () => {
  it("reports weighted fold means and worst leave-one-business shift", () => {
    const result = summarizeLeaveOneBusinessOutMetric<Row>(
      [
        { business: "a", value: 1, weight: 1 },
        { business: "b", value: 3, weight: 1 },
        { business: "c", value: 5, weight: 2 },
      ],
      {
        getBusinessId: (row) => row.business,
        getValue: (row) => row.value,
        getWeight: (row) => row.weight ?? 1,
      },
    );

    expect(result.fullSummary).toMatchObject({
      observationCount: 3,
      totalWeight: 4,
      mean: 3.5,
    });
    expect(result.folds.map((fold) => fold.summary.mean)).toEqual([
      13 / 3,
      11 / 3,
      2,
    ]);
    expect(result.minimumFoldMean).toBe(2);
    expect(result.maximumFoldMean).toBeCloseTo(13 / 3, 12);
    expect(result.maximumAbsoluteShiftFromFullMean).toBe(1.5);
    expect(result.foldDirection).toBe("positive");
  });

  it("keeps empty held-out complements explicit", () => {
    const result = summarizeLeaveOneBusinessOutMetric(
      [{ business: "only", value: 2 }],
      {
        getBusinessId: (row) => row.business,
        getValue: (row) => row.value,
      },
    );

    expect(result.folds[0].summary.mean).toBeNull();
    expect(result.foldDirection).toBe("unavailable");
    expect(result.maximumAbsoluteShiftFromFullMean).toBeNull();
  });

  it("rejects invalid identifiers, values, and weights", () => {
    expect(() =>
      summarizeLeaveOneBusinessOutMetric([{ business: " ", value: 1 }], {
        getBusinessId: (row) => row.business,
        getValue: (row) => row.value,
      }),
    ).toThrow("business id cannot be empty");
    expect(() =>
      summarizeLeaveOneBusinessOutMetric(
        [{ business: "a", value: Number.NaN }],
        {
          getBusinessId: (row) => row.business,
          getValue: (row) => row.value,
        },
      ),
    ).toThrow("LOBO metric values must be finite");
    expect(() =>
      summarizeLeaveOneBusinessOutMetric(
        [{ business: "a", value: 1, weight: -1 }],
        {
          getBusinessId: (row) => row.business,
          getValue: (row) => row.value,
          getWeight: (row) => row.weight ?? 1,
        },
      ),
    ).toThrow("LOBO metric weights must be finite and non-negative");
  });
});
