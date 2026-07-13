import { describe, expect, it } from "vitest";
import {
  actionSpecificCalibration,
  type ActionCalibrationObservation,
} from "./action-calibration";

function observations(
  action: string,
  values: Array<[probability: number, outcome: 0 | 1 | null]>,
): ActionCalibrationObservation[] {
  return values.map(([probability, outcome], index) => ({
    id: `${action}-${index}`,
    action,
    probability,
    outcome,
  }));
}

describe("actionSpecificCalibration", () => {
  it("builds deterministic equal-mass bins and computes ECE and Brier", () => {
    const result = actionSpecificCalibration(
      observations("cut_ad", [
        [0.1, 0],
        [0.2, 0],
        [0.3, 0],
        [0.4, 1],
        [0.5, 0],
        [0.6, 1],
        [0.7, 1],
        [0.8, 1],
        [0.9, 1],
        [1, 1],
      ]),
      { requestedBinCount: 3, minimumBinSize: 3, minimumBins: 2 },
    )[0];

    expect(result.evidenceSufficient).toBe(true);
    expect(result.bins.map((bin) => bin.count)).toEqual([4, 3, 3]);
    expect(result.bins[0]).toMatchObject({
      minimumProbability: 0.1,
      maximumProbability: 0.4,
      averageProbability: 0.25,
      observedRate: 0.25,
      absoluteGap: 0,
      weight: 0.4,
    });
    expect(result.expectedCalibrationError).toBeCloseTo(0.05, 12);
    expect(result.brierScore).toBeCloseTo(0.105, 12);
  });

  it("never pools calibration evidence across actions", () => {
    const result = actionSpecificCalibration(
      [
        ...observations("cut_ad", [
          [0.9, 1],
          [0.8, 1],
          [0.7, 1],
          [0.6, 1],
        ]),
        ...observations("promote_to_main", [
          [0.9, 0],
          [0.8, 0],
          [0.7, 0],
          [0.6, 0],
        ]),
      ],
      { requestedBinCount: 2, minimumBinSize: 2, minimumBins: 2 },
    );

    expect(result.map((entry) => entry.action)).toEqual([
      "cut_ad",
      "promote_to_main",
    ]);
    expect(result[0].expectedCalibrationError).toBeCloseTo(0.25, 12);
    expect(result[1].expectedCalibrationError).toBeCloseTo(0.75, 12);
  });

  it("withholds ECE below minimum-bin evidence while retaining descriptive Brier", () => {
    const result = actionSpecificCalibration(
      observations("cut_ad", [
        [0.8, 1],
        [0.7, 0],
        [0.6, null],
      ]),
      { requestedBinCount: 2, minimumBinSize: 2, minimumBins: 2 },
    )[0];

    expect(result).toMatchObject({
      observationCount: 3,
      knownOutcomeCount: 2,
      unknownOutcomeCount: 1,
      effectiveBinCount: 1,
      evidenceSufficient: false,
      expectedCalibrationError: null,
    });
    expect(result.brierScore).toBeCloseTo(0.265, 12);
    expect(result.bins).toHaveLength(1);
  });

  it("rejects invalid probabilities, duplicate action identities, and impossible bin contracts", () => {
    expect(() =>
      actionSpecificCalibration([
        { id: "bad", action: "cut_ad", probability: 1.1, outcome: 1 },
      ]),
    ).toThrow("probability must be finite and within [0, 1]");
    expect(() =>
      actionSpecificCalibration([
        { id: "same", action: "cut_ad", probability: 0.8, outcome: 1 },
        { id: "same", action: "cut_ad", probability: 0.7, outcome: 0 },
      ]),
    ).toThrow("duplicate calibration observation id for cut_ad: same");
    expect(() =>
      actionSpecificCalibration([], {
        requestedBinCount: 2,
        minimumBinSize: 2,
        minimumBins: 3,
      }),
    ).toThrow("minimumBins cannot exceed requestedBinCount");
  });
});
