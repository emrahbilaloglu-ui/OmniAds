import { describe, expect, it } from "vitest";
import {
  H10_PROBABILITY_CALIBRATION_VARIANTS,
  buildH10ProbabilityCalibrationConfigs,
  fitBayesianWalkForwardSensitivity,
  fitAndEvaluateProbabilityCalibration,
  type DatedProbabilityCalibrationObservation,
  type ProbabilityCalibrationConfig,
  type ProbabilityCalibrationMethod,
  type ProbabilityCalibrationPooling,
  type ProbabilityCalibrationProtocol,
  type ProbabilityCalibrationSharedConfig,
} from "./probability-calibration";

type Action = "cut_ad" | "promote_to_main";

const PROTOCOL: ProbabilityCalibrationProtocol = {
  calibrationStartDate: "2026-04-01",
  calibrationEndDate: "2026-05-31",
  calibrationOutcomeCutoffDate: "2026-05-31",
  lockedTestStartDate: "2026-06-01",
  lockedTestEndDate: "2026-07-05",
  lockedTestOutcomeCutoffDate: "2026-07-12",
};

const SHARED_CONFIG: ProbabilityCalibrationSharedConfig = {
  support: {
    global: { minimumKnown: 4, minimumPositive: 1, minimumNegative: 1 },
    action: { minimumKnown: 2, minimumPositive: 1, minimumNegative: 1 },
    actionAccount: {
      minimumKnown: 2,
      minimumPositive: 1,
      minimumNegative: 1,
    },
    actionPriorStrength: 2,
    actionAccountPriorStrength: 2,
  },
  histogram: {
    requestedBinCount: 2,
    minimumBinSize: 2,
    minimumBins: 2,
  },
  platt: {
    probabilityEpsilon: 1e-6,
    l2Regularization: 0.1,
    maximumIterations: 100,
    convergenceTolerance: 1e-10,
    minimumLineSearchStep: 1 / 1024,
    enforceNonDecreasing: true,
  },
  evaluation: {
    requestedBinCount: 2,
    minimumBinSize: 1,
    minimumBins: 1,
  },
};

function config(
  method: ProbabilityCalibrationMethod,
  pooling: ProbabilityCalibrationPooling = "global",
  shared: ProbabilityCalibrationSharedConfig = SHARED_CONFIG,
): ProbabilityCalibrationConfig {
  return buildH10ProbabilityCalibrationConfigs(shared).find(
    (candidate) => candidate.method === method && candidate.pooling === pooling,
  )!;
}

function calibrationRow(
  id: string,
  probability: number,
  outcome: 0 | 1 | null,
  action: Action = "cut_ad",
  accountId = "account-a",
): DatedProbabilityCalibrationObservation<Action> {
  return {
    id,
    action,
    accountId,
    decisionDate: "2026-04-15",
    probability,
    outcome,
    outcomeObservedDate: outcome === null ? null : "2026-04-22",
  };
}

function testRow(
  id: string,
  probability: number,
  outcome: 0 | 1 | null,
  action: Action = "cut_ad",
  accountId = "account-a",
): DatedProbabilityCalibrationObservation<Action> {
  return {
    id,
    action,
    accountId,
    decisionDate: "2026-06-15",
    probability,
    outcome,
    outcomeObservedDate: outcome === null ? null : "2026-06-22",
  };
}

const BASE_CALIBRATION = [
  calibrationRow("cal-1", 0.1, 0),
  calibrationRow("cal-2", 0.2, 0),
  calibrationRow("cal-3", 0.8, 1),
  calibrationRow("cal-4", 0.9, 1),
];

describe("H10 probability calibration", () => {
  it("enumerates exactly four methods by two pooling modes", () => {
    const configs = buildH10ProbabilityCalibrationConfigs(SHARED_CONFIG);

    expect(H10_PROBABILITY_CALIBRATION_VARIANTS).toHaveLength(8);
    expect(
      configs.map(({ method, pooling }) => `${method}:${pooling}`),
    ).toEqual([
      "identity:global",
      "identity:action_account_hierarchical",
      "equal_mass_histogram:global",
      "equal_mass_histogram:action_account_hierarchical",
      "isotonic_pav:global",
      "isotonic_pav:action_account_hierarchical",
      "platt:global",
      "platt:action_account_hierarchical",
    ]);
    expect(new Set(configs.map((entry) => JSON.stringify(entry))).size).toBe(8);
  });

  it("fits and transforms all eight bounded variants", () => {
    const calibration: DatedProbabilityCalibrationObservation<Action>[] = [];
    const lockedTest: DatedProbabilityCalibrationObservation<Action>[] = [];
    for (const action of ["cut_ad", "promote_to_main"] as const) {
      for (const accountId of ["account-a", "account-b"]) {
        for (const [index, probability, outcome] of [
          [0, 0.1, 0],
          [1, 0.2, 0],
          [2, 0.8, 1],
          [3, 0.9, 1],
        ] as const) {
          calibration.push(
            calibrationRow(
              `${action}-${accountId}-${index}`,
              probability,
              outcome,
              action,
              accountId,
            ),
          );
        }
        lockedTest.push(
          testRow(`test-${action}-${accountId}`, 0.7, 1, action, accountId),
        );
      }
    }

    const runs = buildH10ProbabilityCalibrationConfigs(SHARED_CONFIG).map(
      (candidate) =>
        fitAndEvaluateProbabilityCalibration({
          config: candidate,
          protocol: PROTOCOL,
          calibrationObservations: calibration,
          lockedTestObservations: lockedTest,
        }),
    );

    expect(runs).toHaveLength(8);
    expect(new Set(runs.map((run) => run.provenance.configHash)).size).toBe(8);
    for (const run of runs) {
      expect(run.counts.transformedObservationCount).toBe(4);
      expect(run.counts.unsupportedObservationCount).toBe(0);
      expect(
        run.transformed.every(
          (row) =>
            row.calibratedProbability !== null &&
            row.calibratedProbability >= 0 &&
            row.calibratedProbability <= 1,
        ),
      ).toBe(true);
    }
  });

  it("keeps identity exact and returns deterministic fit provenance and action metrics", () => {
    const lockedTest = [
      testRow("test-1", 0.15, 0),
      testRow("test-2", 0.35, 0),
      testRow("test-3", 0.65, 1),
      testRow("test-4", 0.85, 1),
      testRow("test-unknown", 0.5, null),
    ];
    const first = fitAndEvaluateProbabilityCalibration({
      config: config("identity"),
      protocol: PROTOCOL,
      calibrationObservations: BASE_CALIBRATION,
      lockedTestObservations: lockedTest,
    });
    const reordered = fitAndEvaluateProbabilityCalibration({
      config: config("identity"),
      protocol: PROTOCOL,
      calibrationObservations: [...BASE_CALIBRATION].reverse(),
      lockedTestObservations: [...lockedTest].reverse(),
    });

    expect(first.transformed.map((row) => row.calibratedProbability)).toEqual([
      0.15, 0.35, 0.65, 0.85, 0.5,
    ]);
    expect(first.provenance).toMatchObject({
      variantId: "identity:global",
      counts: {
        observationCount: 4,
        knownOutcomeCount: 4,
        positiveOutcomeCount: 2,
        negativeOutcomeCount: 2,
      },
    });
    expect(first.provenance.configHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.provenance.calibrationDataHash).toBe(
      reordered.provenance.calibrationDataHash,
    );
    expect(first.provenance.fitHash).toBe(reordered.provenance.fitHash);
    expect(first.transformed).toEqual(reordered.transformed);
    expect(first.evaluation.raw[0].knownOutcomeCount).toBe(4);
    expect(first.evaluation.raw[0].unknownOutcomeCount).toBe(1);
    expect(first.evaluation.raw[0].brierScore).toBeCloseTo(
      first.evaluation.calibrated[0].brierScore!,
      12,
    );
    expect(first.evaluation.raw[0].expectedCalibrationError).toBeCloseTo(
      first.evaluation.calibrated[0].expectedCalibrationError!,
      12,
    );
  });

  it("fits deterministic equal-mass histogram bins and never splits tied scores", () => {
    const histogram = fitAndEvaluateProbabilityCalibration({
      config: config("equal_mass_histogram"),
      protocol: PROTOCOL,
      calibrationObservations: BASE_CALIBRATION,
      lockedTestObservations: [
        testRow("test-low", 0.3, 0),
        testRow("test-high", 0.7, 1),
      ],
    });
    const parameters = histogram.provenance.cellFits[0].parameters;

    expect(parameters?.method).toBe("equal_mass_histogram");
    if (parameters?.method !== "equal_mass_histogram") {
      throw new Error("expected histogram parameters");
    }
    expect(parameters.bins).toEqual([
      {
        index: 0,
        count: 2,
        positiveCount: 0,
        minimumProbability: 0.1,
        maximumProbability: 0.2,
        upperBoundary: 0.5,
        observedRate: 0,
      },
      {
        index: 1,
        count: 2,
        positiveCount: 2,
        minimumProbability: 0.8,
        maximumProbability: 0.9,
        upperBoundary: 1,
        observedRate: 1,
      },
    ]);
    expect(
      Object.fromEntries(
        histogram.transformed.map((row) => [row.id, row.calibratedProbability]),
      ),
    ).toEqual({ "test-low": 0, "test-high": 1 });

    const tied = fitAndEvaluateProbabilityCalibration({
      config: config("equal_mass_histogram"),
      protocol: PROTOCOL,
      calibrationObservations: [
        calibrationRow("tie-1", 0.5, 0),
        calibrationRow("tie-2", 0.5, 0),
        calibrationRow("tie-3", 0.5, 1),
        calibrationRow("tie-4", 0.5, 1),
      ],
      lockedTestObservations: [testRow("tie-test", 0.5, 1)],
    });
    expect(tied.provenance.cellFits[0]).toMatchObject({
      status: "unsupported",
      reason: "histogram_distinct_bins_not_met",
    });
    expect(tied.transformed[0]).toMatchObject({
      status: "unsupported",
      calibratedProbability: null,
      unsupportedReason:
        "global_fit_unsupported:histogram_distinct_bins_not_met",
    });
  });

  it("runs deterministic isotonic PAV and emits a non-decreasing mapping", () => {
    const result = fitAndEvaluateProbabilityCalibration({
      config: config("isotonic_pav"),
      protocol: PROTOCOL,
      calibrationObservations: [
        calibrationRow("iso-1", 0.1, 0),
        calibrationRow("iso-2", 0.2, 1),
        calibrationRow("iso-3", 0.3, 0),
        calibrationRow("iso-4", 0.4, 1),
      ],
      lockedTestObservations: [
        testRow("iso-test-1", 0.1, 0),
        testRow("iso-test-2", 0.2, 1),
        testRow("iso-test-3", 0.3, 0),
        testRow("iso-test-4", 0.4, 1),
      ],
    });
    const parameters = result.provenance.cellFits[0].parameters;
    if (parameters?.method !== "isotonic_pav") {
      throw new Error("expected isotonic parameters");
    }

    expect(parameters.blocks.map((block) => block.fittedProbability)).toEqual([
      0, 0.5, 1,
    ]);
    const predictions = result.transformed.map(
      (row) => row.calibratedProbability!,
    );
    expect(predictions).toEqual([0, 0.5, 0.5, 1]);
    expect(
      predictions.every(
        (probability, index) =>
          index === 0 || probability >= predictions[index - 1],
      ),
    ).toBe(true);
  });

  it("fits dependency-free Platt scaling deterministically and preserves ordering", () => {
    const calibration = Array.from({ length: 20 }, (_, index) => {
      const probability = (index + 1) / 21;
      return calibrationRow(`platt-${index}`, probability, index >= 10 ? 1 : 0);
    });
    const lockedTest = [
      testRow("platt-test-1", 0, 0),
      testRow("platt-test-2", 0.25, 0),
      testRow("platt-test-3", 0.5, 1),
      testRow("platt-test-4", 0.75, 1),
      testRow("platt-test-5", 1, 1),
    ];
    const first = fitAndEvaluateProbabilityCalibration({
      config: config("platt"),
      protocol: PROTOCOL,
      calibrationObservations: calibration,
      lockedTestObservations: lockedTest,
    });
    const second = fitAndEvaluateProbabilityCalibration({
      config: config("platt"),
      protocol: PROTOCOL,
      calibrationObservations: calibration,
      lockedTestObservations: lockedTest,
    });
    const parameters = first.provenance.cellFits[0].parameters;
    if (parameters?.method !== "platt") {
      throw new Error("expected Platt parameters");
    }

    expect(parameters.converged).toBe(true);
    expect(parameters.slope).toBeGreaterThan(0);
    expect(parameters.constrainedToNonDecreasing).toBe(false);
    const probabilities = first.transformed.map(
      (row) => row.calibratedProbability!,
    );
    expect(probabilities.every((value) => value >= 0 && value <= 1)).toBe(true);
    expect(
      probabilities.every(
        (value, index) => index === 0 || value >= probabilities[index - 1],
      ),
    ).toBe(true);
    expect(first.provenance.fitHash).toBe(second.provenance.fitHash);
    expect(first.transformed).toEqual(second.transformed);
  });

  it("constrains inverse Platt evidence to a non-decreasing constant", () => {
    const calibration = Array.from({ length: 20 }, (_, index) => {
      const probability = (index + 1) / 21;
      return calibrationRow(
        `inverse-${index}`,
        probability,
        index < 10 ? 1 : 0,
      );
    });
    const result = fitAndEvaluateProbabilityCalibration({
      config: config("platt"),
      protocol: PROTOCOL,
      calibrationObservations: calibration,
      lockedTestObservations: [
        testRow("inverse-low", 0.1, 1),
        testRow("inverse-high", 0.9, 0),
      ],
    });
    const parameters = result.provenance.cellFits[0].parameters;
    if (parameters?.method !== "platt") {
      throw new Error("expected Platt parameters");
    }

    expect(parameters.constrainedToNonDecreasing).toBe(true);
    expect(parameters.slope).toBe(0);
    expect(result.transformed[0].calibratedProbability).toBeCloseTo(
      result.transformed[1].calibratedProbability!,
      12,
    );
  });

  it("shrinks action-account estimates through action and global support", () => {
    const oneBinShared: ProbabilityCalibrationSharedConfig = {
      ...SHARED_CONFIG,
      histogram: {
        requestedBinCount: 1,
        minimumBinSize: 1,
        minimumBins: 1,
      },
    };
    const calibration = [
      calibrationRow("a-1", 0.5, 1, "cut_ad", "account-a"),
      calibrationRow("a-2", 0.5, 1, "cut_ad", "account-a"),
      calibrationRow("a-3", 0.5, 1, "cut_ad", "account-a"),
      calibrationRow("a-4", 0.5, 0, "cut_ad", "account-a"),
      calibrationRow("b-1", 0.5, 0, "cut_ad", "account-b"),
      calibrationRow("b-2", 0.5, 0, "cut_ad", "account-b"),
      calibrationRow("b-3", 0.5, 0, "cut_ad", "account-b"),
      calibrationRow("b-4", 0.5, 1, "cut_ad", "account-b"),
    ];
    const result = fitAndEvaluateProbabilityCalibration({
      config: config(
        "equal_mass_histogram",
        "action_account_hierarchical",
        oneBinShared,
      ),
      protocol: PROTOCOL,
      calibrationObservations: calibration,
      lockedTestObservations: [
        testRow("known-cell", 0.5, 1, "cut_ad", "account-a"),
        testRow("missing-cell", 0.5, 0, "cut_ad", "account-c"),
      ],
    });

    expect(result.transformed[0].calibratedProbability).toBeCloseTo(2 / 3, 12);
    expect(result.transformed[0].contributions).toEqual([
      {
        level: "global",
        knownOutcomeCount: 8,
        finalWeight: expect.closeTo(1 / 15, 12),
      },
      {
        level: "action",
        knownOutcomeCount: 8,
        finalWeight: expect.closeTo(4 / 15, 12),
      },
      {
        level: "action_account",
        knownOutcomeCount: 4,
        finalWeight: expect.closeTo(2 / 3, 12),
      },
    ]);
    expect(
      result.transformed[0].contributions.reduce(
        (sum, contribution) => sum + contribution.finalWeight,
        0,
      ),
    ).toBeCloseTo(1, 12);
    expect(result.transformed[1]).toMatchObject({
      status: "unsupported",
      calibratedProbability: null,
      unsupportedReason: "action_account_fit_unsupported:missing_cell",
    });
    expect(result.counts).toMatchObject({
      transformedObservationCount: 1,
      unsupportedObservationCount: 1,
      transformedKnownOutcomeCount: 1,
    });
  });

  it("fails closed when support or a method-specific fit is insufficient", () => {
    const sparse = fitAndEvaluateProbabilityCalibration({
      config: config("identity"),
      protocol: PROTOCOL,
      calibrationObservations: [
        calibrationRow("sparse-1", 0.2, 0),
        calibrationRow("sparse-2", 0.8, 1),
      ],
      lockedTestObservations: [testRow("sparse-test", 0.5, 1)],
    });
    expect(sparse.provenance.cellFits[0]).toMatchObject({
      status: "unsupported",
      reason: "minimum_known_not_met",
    });
    expect(sparse.transformed[0].calibratedProbability).toBeNull();
    expect(sparse.evaluation.calibrated).toEqual([]);

    const singularConfig = config("platt");
    singularConfig.platt.l2Regularization = 0;
    const singular = fitAndEvaluateProbabilityCalibration({
      config: singularConfig,
      protocol: PROTOCOL,
      calibrationObservations: [
        calibrationRow("constant-1", 0.5, 0),
        calibrationRow("constant-2", 0.5, 0),
        calibrationRow("constant-3", 0.5, 1),
        calibrationRow("constant-4", 0.5, 1),
      ],
      lockedTestObservations: [testRow("constant-test", 0.5, 1)],
    });
    expect(singular.provenance.cellFits[0]).toMatchObject({
      status: "unsupported",
      reason: "platt_singular_hessian",
    });
    expect(singular.transformed[0].calibratedProbability).toBeNull();
  });

  it("rejects fold leakage, invalid dates, duplicate identities, and malformed configs", () => {
    expect(() =>
      fitAndEvaluateProbabilityCalibration({
        config: config("identity"),
        protocol: PROTOCOL,
        calibrationObservations: [
          {
            ...calibrationRow("leak", 0.5, 1),
            outcomeObservedDate: "2026-06-01",
          },
          ...BASE_CALIBRATION.slice(1),
        ],
        lockedTestObservations: [testRow("test", 0.5, 1)],
      }),
    ).toThrow("outcome was not available by its fold cutoff");

    expect(() =>
      fitAndEvaluateProbabilityCalibration({
        config: config("identity"),
        protocol: { ...PROTOCOL, lockedTestStartDate: "2026-05-31" },
        calibrationObservations: BASE_CALIBRATION,
        lockedTestObservations: [],
      }),
    ).toThrow("decision ranges must not overlap");

    expect(() =>
      fitAndEvaluateProbabilityCalibration({
        config: config("identity"),
        protocol: PROTOCOL,
        calibrationObservations: BASE_CALIBRATION,
        lockedTestObservations: [testRow("cal-1", 0.5, 1)],
      }),
    ).toThrow("duplicate probability calibration observation id");

    const malformed = config("identity");
    malformed.support.global.minimumKnown = 0;
    expect(() =>
      fitAndEvaluateProbabilityCalibration({
        config: malformed,
        protocol: PROTOCOL,
        calibrationObservations: BASE_CALIBRATION,
        lockedTestObservations: [],
      }),
    ).toThrow("support.global.minimumKnown must be a positive integer");

    expect(() =>
      fitAndEvaluateProbabilityCalibration({
        config: config("identity"),
        protocol: PROTOCOL,
        calibrationObservations: [
          { ...calibrationRow("bad-date", 0.5, 1), decisionDate: "2026-02-30" },
          ...BASE_CALIBRATION.slice(1),
        ],
        lockedTestObservations: [],
      }),
    ).toThrow("must be a valid ISO calendar date");
  });

  it("produces deterministic bounded Bayesian walk-forward sensitivity without using locked outcomes", () => {
    const calibration = [
      {
        ...calibrationRow("wf-early", 0.2, 0),
        decisionDate: "2026-04-01",
        outcomeObservedDate: "2026-04-05",
      },
      {
        ...calibrationRow("wf-middle", 0.7, 1),
        decisionDate: "2026-04-15",
        outcomeObservedDate: "2026-04-20",
      },
      {
        ...calibrationRow("wf-late", 0.8, 1),
        decisionDate: "2026-05-01",
        outcomeObservedDate: "2026-05-08",
      },
    ];
    const locked = [
      testRow("wf-test", 0.6, 1),
      testRow("wf-other-action", 0.9, 0, "promote_to_main"),
    ];
    const config = {
      priorStrength: 4,
      probabilityBandwidth: 0.75,
      foldCount: 3,
      minimumEffectiveWeight: 0.1,
      evaluation: {
        requestedBinCount: 2,
        minimumBinSize: 1,
        minimumBins: 1,
      },
    };
    const first = fitBayesianWalkForwardSensitivity({
      config,
      protocol: PROTOCOL,
      calibrationObservations: calibration,
      lockedTestObservations: locked,
    });
    const reordered = fitBayesianWalkForwardSensitivity({
      config,
      protocol: PROTOCOL,
      calibrationObservations: [...calibration].reverse(),
      lockedTestObservations: [...locked].reverse(),
    });
    const flippedLockedOutcomes = fitBayesianWalkForwardSensitivity({
      config,
      protocol: PROTOCOL,
      calibrationObservations: calibration,
      lockedTestObservations: locked.map((row) => ({
        ...row,
        outcome: row.outcome === 1 ? (0 as const) : (1 as const),
      })),
    });

    expect(first.descriptiveOnly).toBe(true);
    expect(first.automationEligible).toBe(false);
    expect(first.provenance.resultHash).toBe(reordered.provenance.resultHash);
    expect(first.crossFittedCalibration).toEqual(
      reordered.crossFittedCalibration,
    );
    expect(first.lockedTest).toEqual(reordered.lockedTest);
    expect(first.lockedTest.map((row) => row.calibratedProbability)).toEqual(
      flippedLockedOutcomes.lockedTest.map((row) => row.calibratedProbability),
    );
    expect(first.crossFittedCalibration.map((row) => row.status)).toEqual([
      "prior_only",
      "empirical",
      "empirical",
    ]);
    expect(first.lockedTest[0]).toMatchObject({
      status: "empirical",
      trainingKnownCount: 3,
    });
    expect(first.lockedTest[1]).toMatchObject({
      status: "prior_only",
      calibratedProbability: 0.9,
      trainingKnownCount: 0,
    });
    expect(
      [...first.crossFittedCalibration, ...first.lockedTest].every(
        (row) =>
          row.calibratedProbability >= 0 && row.calibratedProbability <= 1,
      ),
    ).toBe(true);
  });

  it("fails closed to the identity prior when earlier outcomes were not yet observable", () => {
    const result = fitBayesianWalkForwardSensitivity({
      config: {
        priorStrength: 2,
        probabilityBandwidth: 1,
        foldCount: 2,
        minimumEffectiveWeight: 0.1,
        evaluation: {
          requestedBinCount: 1,
          minimumBinSize: 1,
          minimumBins: 1,
        },
      },
      protocol: PROTOCOL,
      calibrationObservations: [
        {
          ...calibrationRow("late-outcome", 0.1, 1),
          decisionDate: "2026-04-01",
          outcomeObservedDate: "2026-04-25",
        },
        {
          ...calibrationRow("second-fold", 0.8, 0),
          decisionDate: "2026-04-15",
          outcomeObservedDate: "2026-04-20",
        },
      ],
      lockedTestObservations: [testRow("locked", 0.5, 1)],
    });

    expect(result.crossFittedCalibration[1]).toMatchObject({
      status: "prior_only",
      trainingKnownCount: 0,
      calibratedProbability: 0.8,
      trainingCutoffDate: "2026-04-14",
    });
    expect(result.automationEligible).toBe(false);
  });
});
