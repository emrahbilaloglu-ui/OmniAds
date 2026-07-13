import { describe, expect, it } from "vitest";
import {
  pairedMcNemar,
  pairedMcNemarFromCounts,
  wilsonScoreInterval,
} from "./paired-binary-inference";

describe("wilsonScoreInterval", () => {
  it("matches the standard 95% Wilson interval", () => {
    const interval = wilsonScoreInterval(81, 100);

    expect(interval?.estimate).toBe(0.81);
    expect(interval?.lower).toBeCloseTo(0.7222, 4);
    expect(interval?.upper).toBeCloseTo(0.8749, 4);
    expect(interval?.zScore).toBeCloseTo(1.959964, 5);
  });

  it("keeps all-success and no-success intervals inside probability bounds", () => {
    expect(wilsonScoreInterval(0, 10)).toMatchObject({
      estimate: 0,
      lower: 0,
    });
    expect(wilsonScoreInterval(10, 10)).toMatchObject({
      estimate: 1,
      upper: 1,
    });
    expect(wilsonScoreInterval(0, 0)).toBeNull();
  });

  it("rejects invalid count and confidence contracts", () => {
    expect(() => wilsonScoreInterval(3, 2)).toThrow(
      "successes cannot exceed total",
    );
    expect(() => wilsonScoreInterval(1.5, 2)).toThrow(
      "successes must be a non-negative integer",
    );
    expect(() => wilsonScoreInterval(1, 2, 1)).toThrow(
      "confidenceLevel must be between 0 and 1",
    );
  });
});

describe("pairedMcNemar", () => {
  it("counts only paired disagreements and keeps candidate direction explicit", () => {
    const result = pairedMcNemar([
      { id: "both-right", baselineCorrect: true, candidateCorrect: true },
      { id: "baseline", baselineCorrect: true, candidateCorrect: false },
      { id: "candidate-1", baselineCorrect: false, candidateCorrect: true },
      { id: "candidate-2", baselineCorrect: 0, candidateCorrect: 1 },
      { id: "both-wrong", baselineCorrect: false, candidateCorrect: false },
    ]);

    expect(result).toMatchObject({
      pairedSampleSize: 5,
      bothCorrect: 1,
      baselineOnlyCorrect: 1,
      candidateOnlyCorrect: 2,
      bothWrong: 1,
      discordantPairs: 3,
      candidateNetWins: 1,
      candidateWinRateAmongDiscordant: 2 / 3,
      pValueMethod: "exact_binomial",
    });
    expect(result.exactPValue).toBe(1);
  });

  it("uses the exact two-sided binomial probability for sparse disagreements", () => {
    const result = pairedMcNemarFromCounts({
      bothCorrect: 20,
      baselineOnlyCorrect: 0,
      candidateOnlyCorrect: 5,
      bothWrong: 10,
    });

    expect(result.exactPValue).toBeCloseTo(0.0625, 12);
    expect(result.pValue).toBeCloseTo(0.0625, 12);
    expect(result.adjustedCandidateToBaselineOddsRatio).toBe(11);
  });

  it("switches deterministically to the corrected asymptotic test above the threshold", () => {
    const result = pairedMcNemarFromCounts(
      {
        bothCorrect: 100,
        baselineOnlyCorrect: 10,
        candidateOnlyCorrect: 40,
        bothWrong: 50,
      },
      { exactDiscordantThreshold: 25 },
    );

    expect(result.pValueMethod).toBe("continuity_corrected_chi_square");
    expect(result.continuityCorrectedChiSquare).toBeCloseTo(16.82, 10);
    expect(result.pValue).toBeLessThan(0.0001);
  });

  it("returns a neutral result with no discordant pairs", () => {
    expect(
      pairedMcNemarFromCounts({
        bothCorrect: 12,
        baselineOnlyCorrect: 0,
        candidateOnlyCorrect: 0,
        bothWrong: 3,
      }),
    ).toMatchObject({
      discordantPairs: 0,
      candidateNetWins: 0,
      pValue: 1,
      pValueMethod: "none",
    });
  });

  it("rejects duplicate pair identities", () => {
    expect(() =>
      pairedMcNemar([
        { id: "same", baselineCorrect: true, candidateCorrect: true },
        { id: "same", baselineCorrect: false, candidateCorrect: true },
      ]),
    ).toThrow("duplicate paired observation id: same");
  });
});
