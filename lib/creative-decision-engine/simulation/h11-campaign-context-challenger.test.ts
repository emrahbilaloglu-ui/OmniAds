import { describe, expect, it } from "vitest";
import {
  H11_CONTEXT_POLICIES,
  cyclicAccountLabelPlacebo,
  evaluateH11Acceptance,
  h11H1CalibrationParent,
  selectH11PolicyOnCalibration,
  summarizeH11Evaluation,
  type H11ScoredObservation,
} from "./h11-campaign-context-challenger";

function row(
  overrides: Partial<H11ScoredObservation> = {},
): H11ScoredObservation {
  return {
    id: "b:a:c:2026-06-27",
    businessId: "b",
    accountId: "a",
    campaignId: "c",
    date: "2026-06-27",
    manualKind: "main",
    predictedKind: "main",
    confidenceClass: "high",
    ...overrides,
  };
}

describe("H11 predeclared policy matrix", () => {
  it("contains the complete fixed 4x2 signal-by-threshold matrix", () => {
    expect(H11_CONTEXT_POLICIES).toHaveLength(8);
    expect(new Set(H11_CONTEXT_POLICIES.map((policy) => policy.id)).size).toBe(
      8,
    );
    expect(
      new Set(H11_CONTEXT_POLICIES.map((policy) => policy.configHash)).size,
    ).toBe(8);
    expect(
      H11_CONTEXT_POLICIES.map(
        (policy) => `${policy.signalProfile}:${policy.thresholdRegime}`,
      ).sort(),
    ).toEqual(
      ["production", "no_lineage", "no_naming", "no_lineage_no_naming"]
        .flatMap((signal) =>
          ["production", "conservative"].map(
            (threshold) => `${signal}:${threshold}`,
          ),
        )
        .sort(),
    );
    for (const policy of H11_CONTEXT_POLICIES) {
      const total = Object.values(policy.config.familyWeights).reduce(
        (sum, value) => sum + value,
        0,
      );
      expect(total).toBeCloseTo(1, 12);
    }
  });

  it("makes each reliability challenger literal rather than cosmetic", () => {
    const noLineage = H11_CONTEXT_POLICIES.find((policy) =>
      policy.id.includes("no_lineage"),
    )!;
    const noNaming = H11_CONTEXT_POLICIES.find((policy) =>
      policy.id.includes("no_naming"),
    )!;
    const combined = H11_CONTEXT_POLICIES.find(
      (policy) =>
        policy.signalProfile === "no_lineage_no_naming" &&
        policy.thresholdRegime === "production",
    )!;
    const conservative = H11_CONTEXT_POLICIES.find(
      (policy) =>
        policy.signalProfile === "production" &&
        policy.thresholdRegime === "conservative",
    )!;
    const baseline = H11_CONTEXT_POLICIES.find((policy) => policy.baseline)!;

    expect(noLineage.includeLineage).toBe(false);
    expect(noLineage.config.familyWeights.lineage).toBe(0);
    expect(noNaming.config.familyWeights.naming).toBe(0);
    expect(noNaming.config.testNameTokens).toEqual([]);
    expect(noNaming.config.mainNameTokens).toEqual([]);
    expect(combined.includeLineage).toBe(false);
    expect(combined.config.familyWeights.lineage).toBe(0);
    expect(combined.config.familyWeights.naming).toBe(0);
    expect(conservative.config.thresholds.highMarginTest).toBeGreaterThan(
      baseline.config.thresholds.highMarginTest,
    );
    expect(
      conservative.config.thresholds.highMinAgreeingFamilies,
    ).toBeGreaterThan(baseline.config.thresholds.highMinAgreeingFamilies);
  });

  it("lets H1 use a kind parent only when published context has full authority", () => {
    expect(
      h11H1CalibrationParent({
        publishedKind: "test",
        publishedClass: "high",
      }),
    ).toBe("test");
    for (const publishedClass of [
      "medium",
      "low",
      "unknown",
      "conflict",
    ] as const) {
      expect(
        h11H1CalibrationParent({
          publishedKind: "test",
          publishedClass,
        }),
      ).toBe("all");
    }
    expect(
      h11H1CalibrationParent({
        publishedKind: null,
        publishedClass: "high",
      }),
    ).toBe("all");
  });
});

describe("H11 evaluation", () => {
  it("keeps abstention separate from classified accuracy", () => {
    const summary = summarizeH11Evaluation([
      row(),
      row({
        id: "b:a:d:2026-06-27",
        campaignId: "d",
        predictedKind: null,
        confidenceClass: "unknown",
      }),
      row({
        id: "b:a:e:2026-06-27",
        campaignId: "e",
        manualKind: "test",
        predictedKind: "main",
        confidenceClass: "medium",
      }),
    ]);

    expect(summary.labeledObservations).toBe(3);
    expect(summary.classifiedObservations).toBe(2);
    expect(summary.exactAccuracy).toBe(0.5);
    expect(summary.allLabelAccuracy).toBeCloseTo(1 / 3);
    expect(summary.labelCoverage).toBeCloseTo(2 / 3);
    expect(summary.missedTest).toBe(1);
    expect(summary.testRecall).toBe(0);
    expect(summary.testRecallWilson95?.upper).toBeGreaterThan(0);
  });

  it("locks calibration selection deterministically regardless of input order", () => {
    const summaries = H11_CONTEXT_POLICIES.map((policy, index) => ({
      policyId: policy.id,
      summary: summarizeH11Evaluation([
        row({
          id: `${policy.id}:1`,
          predictedKind: index === 0 ? "test" : "main",
        }),
      ]),
    }));
    const forward = selectH11PolicyOnCalibration(summaries);
    const reverse = selectH11PolicyOnCalibration([...summaries].reverse());
    expect(forward?.policyId).toBe(reverse?.policyId);
    expect(forward?.summary.falseTestAny).toBe(0);
  });

  it("fails closed when high-confidence evidence is below the fixed floor", () => {
    const summary = summarizeH11Evaluation([row()]);
    const acceptance = evaluateH11Acceptance({
      summary,
      pairedAccuracyImprovement: {
        point: 0,
        lower: 0,
        upper: 0,
        sampleSize: 1,
        polarity: "positive_is_candidate_improvement",
      },
      publishedFlipRatePer100Days: 0,
      maximumAllowedFlipRatePer100Days: 0,
      collapsedAccountCount: 0,
      invariantViolationCount: 0,
    });
    expect(acceptance.accepted).toBe(false);
    expect(acceptance.status).toBe("insufficient_evidence");
    expect(acceptance.insufficientRequiredGateIds).toContain(
      "h11_high_confidence_unique_campaigns",
    );
  });
});

describe("H11 label placebo", () => {
  it("is deterministic and preserves the per-account label multiset", () => {
    const rows = [
      row({ id: "1", campaignId: "1", manualKind: "main" }),
      row({ id: "2", campaignId: "2", manualKind: "test" }),
      row({ id: "3", campaignId: "3", manualKind: "mixed" }),
    ];
    const first = cyclicAccountLabelPlacebo(rows, 7);
    const second = cyclicAccountLabelPlacebo(rows, 7);
    expect(first).toEqual(second);
    expect(first.map((item) => item.manualKind).sort()).toEqual(
      rows.map((item) => item.manualKind).sort(),
    );
    expect(first.map((item) => item.manualKind)).not.toEqual(
      rows.map((item) => item.manualKind),
    );
  });

  it("rejects invalid iteration ids", () => {
    expect(() => cyclicAccountLabelPlacebo([row()], 0)).toThrow(
      "placebo iteration must be a positive integer",
    );
  });
});
