import { describe, expect, it } from "vitest";
import {
  evaluateCandidateAcceptance,
  normalizeCandidateMinusBaseline,
  type ImprovementEstimate,
} from "./candidate-gates";

function improvement(
  point: number,
  lower: number,
  upper: number,
): ImprovementEstimate {
  return {
    point,
    lower,
    upper,
    sampleSize: 500,
    polarity: "positive_is_candidate_improvement",
  };
}

describe("normalizeCandidateMinusBaseline", () => {
  it("keeps higher-is-better deltas and reverses lower-is-better intervals", () => {
    expect(
      normalizeCandidateMinusBaseline({
        point: 0.03,
        lower: 0.01,
        upper: 0.05,
        sampleSize: 100,
        direction: "higher_is_better",
      }),
    ).toMatchObject({ point: 0.03, lower: 0.01, upper: 0.05 });
    expect(
      normalizeCandidateMinusBaseline({
        point: -0.03,
        lower: -0.05,
        upper: -0.01,
        sampleSize: 100,
        direction: "lower_is_better",
      }),
    ).toMatchObject({ point: 0.03, lower: 0.01, upper: 0.05 });
  });
});

describe("evaluateCandidateAcceptance", () => {
  it("accepts only when every required evidence, safety, and improvement gate passes", () => {
    const result = evaluateCandidateAcceptance([
      {
        id: "known-cut-evidence",
        metric: "cut_precision",
        kind: "minimum_evidence",
        observed: 500,
        minimum: 200,
      },
      {
        id: "zero-safety-violations",
        metric: "safety_violations",
        kind: "maximum_count",
        observed: 0,
        maximum: 0,
      },
      {
        id: "recall-noninferior",
        metric: "opportunity_recall",
        kind: "non_inferiority",
        improvement: improvement(0.01, -0.01, 0.03),
        margin: 0.02,
      },
      {
        id: "precision-superior",
        metric: "hard_precision",
        kind: "superiority",
        improvement: improvement(0.03, 0.01, 0.05),
        minimumImprovement: 0,
      },
    ]);

    expect(result).toMatchObject({
      status: "accept",
      accepted: true,
      requiredGateCount: 4,
      passedRequiredGateCount: 4,
      failedRequiredGateIds: [],
      insufficientRequiredGateIds: [],
    });
  });

  it("rejects a measured safety failure", () => {
    const result = evaluateCandidateAcceptance([
      {
        id: "zero-safety-violations",
        metric: "safety_violations",
        kind: "maximum_count",
        observed: 1,
        maximum: 0,
      },
      {
        id: "precision-superior",
        metric: "hard_precision",
        kind: "superiority",
        improvement: improvement(0.1, 0.05, 0.15),
        minimumImprovement: 0,
      },
    ]);

    expect(result).toMatchObject({
      status: "reject",
      accepted: false,
      failedRequiredGateIds: ["zero-safety-violations"],
    });
  });

  it("does not turn a missing confidence bound into a pass", () => {
    const result = evaluateCandidateAcceptance([
      {
        id: "precision-floor",
        metric: "hard_precision",
        kind: "minimum",
        estimate: { point: 0.8, lower: null, upper: null, sampleSize: 20 },
        minimum: 0.7,
        conservativeBound: "lower",
      },
    ]);

    expect(result).toMatchObject({
      status: "insufficient_evidence",
      accepted: false,
      insufficientRequiredGateIds: ["precision-floor"],
    });
  });

  it("does not let missing secondary evidence hide a measured required failure", () => {
    const result = evaluateCandidateAcceptance([
      {
        id: "safety-failure",
        metric: "safety_violations",
        kind: "maximum_count",
        observed: 1,
        maximum: 0,
      },
      {
        id: "missing-interval",
        metric: "recall",
        kind: "non_inferiority",
        improvement: null,
        margin: 0.02,
      },
    ]);

    expect(result.status).toBe("reject");
    expect(result.failedRequiredGateIds).toEqual(["safety-failure"]);
    expect(result.insufficientRequiredGateIds).toEqual(["missing-interval"]);
  });

  it("keeps optional diagnostics outside the acceptance decision", () => {
    const result = evaluateCandidateAcceptance([
      {
        id: "required",
        metric: "precision",
        kind: "minimum",
        estimate: { point: 0.8, lower: 0.75, upper: 0.85, sampleSize: 100 },
        minimum: 0.7,
        conservativeBound: "lower",
      },
      {
        id: "optional",
        metric: "secondary",
        kind: "maximum_count",
        observed: 2,
        maximum: 0,
        required: false,
      },
    ]);

    expect(result.status).toBe("accept");
    expect(result.gates[1].status).toBe("fail");
  });

  it("rejects malformed intervals and duplicate gates", () => {
    expect(() =>
      normalizeCandidateMinusBaseline({
        point: 0,
        lower: 1,
        upper: -1,
        sampleSize: 1,
        direction: "higher_is_better",
      }),
    ).toThrow(
      "candidateMinusBaseline.lower cannot exceed candidateMinusBaseline.upper",
    );
    expect(() =>
      evaluateCandidateAcceptance([
        {
          id: "same",
          metric: "one",
          kind: "maximum_count",
          observed: 0,
          maximum: 0,
        },
        {
          id: "same",
          metric: "two",
          kind: "maximum_count",
          observed: 0,
          maximum: 0,
        },
      ]),
    ).toThrow("duplicate candidate gate id: same");
  });
});
