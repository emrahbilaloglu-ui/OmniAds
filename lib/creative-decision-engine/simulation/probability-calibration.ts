import {
  actionSpecificCalibration,
  type ActionCalibrationOptions,
  type ActionCalibrationSummary,
} from "./action-calibration";
import { normalizePostgresDate } from "./calendar-date";
import { stableConfigHash } from "./stable-config";

export const H10_PROBABILITY_CALIBRATION_CONTRACT_VERSION =
  "h10-probability-calibration.v1" as const;

export const H10_BAYESIAN_SENSITIVITY_CONTRACT_VERSION =
  "h10-bayesian-walk-forward-sensitivity.v1" as const;

export const H10_PROBABILITY_CALIBRATION_VARIANTS = [
  { method: "identity", pooling: "global" },
  { method: "identity", pooling: "action_account_hierarchical" },
  { method: "equal_mass_histogram", pooling: "global" },
  {
    method: "equal_mass_histogram",
    pooling: "action_account_hierarchical",
  },
  { method: "isotonic_pav", pooling: "global" },
  { method: "isotonic_pav", pooling: "action_account_hierarchical" },
  { method: "platt", pooling: "global" },
  { method: "platt", pooling: "action_account_hierarchical" },
] as const;

export type ProbabilityCalibrationMethod =
  (typeof H10_PROBABILITY_CALIBRATION_VARIANTS)[number]["method"];
export type ProbabilityCalibrationPooling =
  (typeof H10_PROBABILITY_CALIBRATION_VARIANTS)[number]["pooling"];

export interface ProbabilityCalibrationCellSupportRequirement {
  minimumKnown: number;
  minimumPositive: number;
  minimumNegative: number;
}

export interface ProbabilityCalibrationSupportConfig {
  global: ProbabilityCalibrationCellSupportRequirement;
  action: ProbabilityCalibrationCellSupportRequirement;
  actionAccount: ProbabilityCalibrationCellSupportRequirement;
  /** Pseudo-observation support assigned to the global parent. */
  actionPriorStrength: number;
  /** Pseudo-observation support assigned to the pooled action parent. */
  actionAccountPriorStrength: number;
}

export interface EqualMassHistogramConfig {
  requestedBinCount: number;
  minimumBinSize: number;
  minimumBins: number;
}

export interface PlattCalibrationConfig {
  probabilityEpsilon: number;
  l2Regularization: number;
  maximumIterations: number;
  convergenceTolerance: number;
  minimumLineSearchStep: number;
  /** Prevents a calibrator from reversing the engine's confidence ordering. */
  enforceNonDecreasing: boolean;
}

export interface ProbabilityCalibrationSharedConfig {
  support: ProbabilityCalibrationSupportConfig;
  histogram: EqualMassHistogramConfig;
  platt: PlattCalibrationConfig;
  evaluation: Required<ActionCalibrationOptions>;
}

export interface ProbabilityCalibrationConfig extends ProbabilityCalibrationSharedConfig {
  method: ProbabilityCalibrationMethod;
  pooling: ProbabilityCalibrationPooling;
}

export function buildH10ProbabilityCalibrationConfigs(
  shared: ProbabilityCalibrationSharedConfig,
): ProbabilityCalibrationConfig[] {
  return H10_PROBABILITY_CALIBRATION_VARIANTS.map((variant) => ({
    ...variant,
    support: {
      ...shared.support,
      global: { ...shared.support.global },
      action: { ...shared.support.action },
      actionAccount: { ...shared.support.actionAccount },
    },
    histogram: { ...shared.histogram },
    platt: { ...shared.platt },
    evaluation: { ...shared.evaluation },
  }));
}

export interface ProbabilityCalibrationProtocol {
  calibrationStartDate: string;
  calibrationEndDate: string;
  calibrationOutcomeCutoffDate: string;
  lockedTestStartDate: string;
  lockedTestEndDate: string;
  lockedTestOutcomeCutoffDate: string;
}

export interface DatedProbabilityCalibrationObservation<
  Action extends string = string,
> {
  id: string | number;
  action: Action;
  accountId: string;
  decisionDate: string;
  probability: number;
  outcome: boolean | 0 | 1 | null;
  /** Date on which this outcome first became eligible for the replay. */
  outcomeObservedDate: string | null;
}

export interface ProbabilityCalibrationSupportCounts {
  observationCount: number;
  knownOutcomeCount: number;
  unknownOutcomeCount: number;
  positiveOutcomeCount: number;
  negativeOutcomeCount: number;
}

export interface HistogramCalibrationBin {
  index: number;
  count: number;
  positiveCount: number;
  minimumProbability: number;
  maximumProbability: number;
  upperBoundary: number;
  observedRate: number;
}

export interface IsotonicCalibrationBlock {
  index: number;
  count: number;
  positiveCount: number;
  minimumProbability: number;
  maximumProbability: number;
  upperBoundary: number;
  fittedProbability: number;
}

export type ProbabilityCalibrationModelParameters =
  | { method: "identity" }
  | {
      method: "equal_mass_histogram";
      requestedBinCount: number;
      effectiveBinCount: number;
      bins: HistogramCalibrationBin[];
    }
  | {
      method: "isotonic_pav";
      blocks: IsotonicCalibrationBlock[];
    }
  | {
      method: "platt";
      intercept: number;
      slope: number;
      iterations: number;
      converged: true;
      constrainedToNonDecreasing: boolean;
    };

export type ProbabilityCalibrationCellLevel =
  "global" | "action" | "action_account";

export interface ProbabilityCalibrationCellFit<Action extends string = string> {
  level: ProbabilityCalibrationCellLevel;
  action: Action | null;
  accountId: string | null;
  status: "fitted" | "unsupported";
  reason: string | null;
  support: ProbabilityCalibrationSupportCounts;
  parameters: ProbabilityCalibrationModelParameters | null;
}

export interface ProbabilityCalibrationFitProvenance<
  Action extends string = string,
> {
  contractVersion: typeof H10_PROBABILITY_CALIBRATION_CONTRACT_VERSION;
  variantId: string;
  configHash: string;
  calibrationDataHash: string;
  fitHash: string;
  protocol: ProbabilityCalibrationProtocol;
  counts: ProbabilityCalibrationSupportCounts;
  cellFits: ProbabilityCalibrationCellFit<Action>[];
}

export interface ProbabilityCalibrationContribution {
  level: ProbabilityCalibrationCellLevel;
  knownOutcomeCount: number;
  finalWeight: number;
}

export interface TransformedProbabilityCalibrationObservation<
  Action extends string = string,
> extends DatedProbabilityCalibrationObservation<Action> {
  calibratedProbability: number | null;
  status: "transformed" | "unsupported";
  unsupportedReason: string | null;
  contributions: ProbabilityCalibrationContribution[];
}

export interface ProbabilityCalibrationEvaluation<Action extends string> {
  raw: ActionCalibrationSummary<Action>[];
  calibrated: ActionCalibrationSummary<Action>[];
}

export interface ProbabilityCalibrationRun<Action extends string = string> {
  config: ProbabilityCalibrationConfig;
  provenance: ProbabilityCalibrationFitProvenance<Action>;
  counts: {
    calibration: ProbabilityCalibrationSupportCounts;
    lockedTest: ProbabilityCalibrationSupportCounts;
    transformedObservationCount: number;
    unsupportedObservationCount: number;
    transformedKnownOutcomeCount: number;
  };
  transformed: TransformedProbabilityCalibrationObservation<Action>[];
  evaluation: ProbabilityCalibrationEvaluation<Action>;
}

export interface BayesianWalkForwardSensitivityConfig {
  /** Strength of the identity-centred Beta prior, in pseudo-observations. */
  priorStrength: number;
  /** Triangular kernel radius on the [0, 1] probability scale. */
  probabilityBandwidth: number;
  /** Contiguous calendar folds used for strictly earlier-fold predictions. */
  foldCount: number;
  /** Below this local weight, the prediction stays identity/prior-only. */
  minimumEffectiveWeight: number;
  evaluation: Required<ActionCalibrationOptions>;
}

export interface BayesianWalkForwardPrediction<
  Action extends string = string,
> extends DatedProbabilityCalibrationObservation<Action> {
  calibratedProbability: number;
  status: "empirical" | "prior_only";
  trainingKnownCount: number;
  trainingPositiveCount: number;
  effectiveLocalWeight: number;
  weightedPositiveCount: number;
  trainingCutoffDate: string;
}

export interface BayesianWalkForwardSensitivityRun<
  Action extends string = string,
> {
  contractVersion: typeof H10_BAYESIAN_SENSITIVITY_CONTRACT_VERSION;
  descriptiveOnly: true;
  automationEligible: false;
  config: BayesianWalkForwardSensitivityConfig;
  protocol: ProbabilityCalibrationProtocol;
  provenance: {
    variantId: string;
    configHash: string;
    calibrationDataHash: string;
    resultHash: string;
  };
  counts: {
    calibration: ProbabilityCalibrationSupportCounts;
    lockedTest: ProbabilityCalibrationSupportCounts;
    crossFittedEmpirical: number;
    crossFittedPriorOnly: number;
    lockedTestEmpirical: number;
    lockedTestPriorOnly: number;
  };
  crossFittedCalibration: BayesianWalkForwardPrediction<Action>[];
  lockedTest: BayesianWalkForwardPrediction<Action>[];
  evaluation: {
    crossFitted: ProbabilityCalibrationEvaluation<Action>;
    lockedTest: ProbabilityCalibrationEvaluation<Action>;
  };
}

interface NormalizedObservation<Action extends string> extends Omit<
  DatedProbabilityCalibrationObservation<Action>,
  "outcome" | "decisionDate" | "outcomeObservedDate"
> {
  idKey: string;
  decisionDate: string;
  outcome: 0 | 1 | null;
  outcomeObservedDate: string | null;
}

interface FittedCell<Action extends string> {
  public: ProbabilityCalibrationCellFit<Action>;
  predict: ((probability: number) => number) | null;
}

interface KnownFitObservation {
  idKey: string;
  probability: number;
  outcome: 0 | 1;
}

const FLOAT_TOLERANCE = 1e-12;

function positiveInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
}

function nonNegativeInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
}

function finiteNonNegative(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be finite and non-negative`);
  }
}

function calendarDate(value: string, field: string): string {
  const normalized = normalizePostgresDate(value);
  if (normalized === null || normalized !== value) {
    throw new Error(`${field} must be a valid ISO calendar date`);
  }
  return normalized;
}

function validateProtocol(
  protocol: ProbabilityCalibrationProtocol,
): ProbabilityCalibrationProtocol {
  const normalized = {
    calibrationStartDate: calendarDate(
      protocol.calibrationStartDate,
      "protocol.calibrationStartDate",
    ),
    calibrationEndDate: calendarDate(
      protocol.calibrationEndDate,
      "protocol.calibrationEndDate",
    ),
    calibrationOutcomeCutoffDate: calendarDate(
      protocol.calibrationOutcomeCutoffDate,
      "protocol.calibrationOutcomeCutoffDate",
    ),
    lockedTestStartDate: calendarDate(
      protocol.lockedTestStartDate,
      "protocol.lockedTestStartDate",
    ),
    lockedTestEndDate: calendarDate(
      protocol.lockedTestEndDate,
      "protocol.lockedTestEndDate",
    ),
    lockedTestOutcomeCutoffDate: calendarDate(
      protocol.lockedTestOutcomeCutoffDate,
      "protocol.lockedTestOutcomeCutoffDate",
    ),
  };

  if (normalized.calibrationStartDate > normalized.calibrationEndDate) {
    throw new Error("calibration date range is reversed");
  }
  if (normalized.lockedTestStartDate > normalized.lockedTestEndDate) {
    throw new Error("locked-test date range is reversed");
  }
  if (normalized.calibrationEndDate >= normalized.lockedTestStartDate) {
    throw new Error(
      "calibration and locked-test decision ranges must not overlap",
    );
  }
  if (
    normalized.calibrationOutcomeCutoffDate >= normalized.lockedTestStartDate
  ) {
    throw new Error(
      "calibration outcome cutoff must precede the locked-test window",
    );
  }
  if (
    normalized.calibrationOutcomeCutoffDate < normalized.calibrationStartDate
  ) {
    throw new Error(
      "calibration outcome cutoff precedes calibration decisions",
    );
  }
  if (normalized.lockedTestOutcomeCutoffDate < normalized.lockedTestStartDate) {
    throw new Error(
      "locked-test outcome cutoff precedes locked-test decisions",
    );
  }
  return normalized;
}

function validateSupportRequirement(
  requirement: ProbabilityCalibrationCellSupportRequirement,
  field: string,
): void {
  positiveInteger(requirement.minimumKnown, `${field}.minimumKnown`);
  nonNegativeInteger(requirement.minimumPositive, `${field}.minimumPositive`);
  nonNegativeInteger(requirement.minimumNegative, `${field}.minimumNegative`);
}

function validateConfig(
  config: ProbabilityCalibrationConfig,
): ProbabilityCalibrationConfig {
  if (
    !H10_PROBABILITY_CALIBRATION_VARIANTS.some(
      (variant) =>
        variant.method === config.method && variant.pooling === config.pooling,
    )
  ) {
    throw new Error("unsupported H10 probability calibration variant");
  }
  validateSupportRequirement(config.support.global, "support.global");
  validateSupportRequirement(config.support.action, "support.action");
  validateSupportRequirement(
    config.support.actionAccount,
    "support.actionAccount",
  );
  finiteNonNegative(
    config.support.actionPriorStrength,
    "support.actionPriorStrength",
  );
  finiteNonNegative(
    config.support.actionAccountPriorStrength,
    "support.actionAccountPriorStrength",
  );
  positiveInteger(
    config.histogram.requestedBinCount,
    "histogram.requestedBinCount",
  );
  positiveInteger(config.histogram.minimumBinSize, "histogram.minimumBinSize");
  positiveInteger(config.histogram.minimumBins, "histogram.minimumBins");
  if (config.histogram.minimumBins > config.histogram.requestedBinCount) {
    throw new Error("histogram.minimumBins cannot exceed requestedBinCount");
  }
  if (
    !Number.isFinite(config.platt.probabilityEpsilon) ||
    config.platt.probabilityEpsilon <= 0 ||
    config.platt.probabilityEpsilon >= 0.5
  ) {
    throw new Error("platt.probabilityEpsilon must be within (0, 0.5)");
  }
  finiteNonNegative(config.platt.l2Regularization, "platt.l2Regularization");
  positiveInteger(config.platt.maximumIterations, "platt.maximumIterations");
  if (
    !Number.isFinite(config.platt.convergenceTolerance) ||
    config.platt.convergenceTolerance <= 0
  ) {
    throw new Error("platt.convergenceTolerance must be finite and positive");
  }
  if (
    !Number.isFinite(config.platt.minimumLineSearchStep) ||
    config.platt.minimumLineSearchStep <= 0 ||
    config.platt.minimumLineSearchStep > 1
  ) {
    throw new Error("platt.minimumLineSearchStep must be within (0, 1]");
  }
  positiveInteger(
    config.evaluation.requestedBinCount,
    "evaluation.requestedBinCount",
  );
  positiveInteger(
    config.evaluation.minimumBinSize,
    "evaluation.minimumBinSize",
  );
  positiveInteger(config.evaluation.minimumBins, "evaluation.minimumBins");
  if (config.evaluation.minimumBins > config.evaluation.requestedBinCount) {
    throw new Error("evaluation.minimumBins cannot exceed requestedBinCount");
  }
  return config;
}

function normalizedOutcome(value: boolean | 0 | 1 | null): 0 | 1 | null {
  if (value === null) return null;
  if (value === true || value === 1) return 1;
  if (value === false || value === 0) return 0;
  throw new Error("outcome must be boolean, 0, 1, or null");
}

function typedIdKey(id: string | number): string {
  if (typeof id === "number" && !Number.isFinite(id)) {
    throw new Error("observation id numbers must be finite");
  }
  return `${typeof id}:${String(id)}`;
}

function compareObservation<Action extends string>(
  left: NormalizedObservation<Action>,
  right: NormalizedObservation<Action>,
): number {
  return (
    left.decisionDate.localeCompare(right.decisionDate) ||
    left.action.localeCompare(right.action) ||
    left.accountId.localeCompare(right.accountId) ||
    left.idKey.localeCompare(right.idKey)
  );
}

function normalizeObservations<Action extends string>(input: {
  rows: readonly DatedProbabilityCalibrationObservation<Action>[];
  role: "calibration" | "locked_test";
  startDate: string;
  endDate: string;
  outcomeCutoffDate: string;
  seenIds: Set<string>;
}): NormalizedObservation<Action>[] {
  return input.rows
    .map((row, index) => {
      if (!row.action.trim())
        throw new Error(`${input.role}[${index}].action is empty`);
      if (!row.accountId.trim()) {
        throw new Error(`${input.role}[${index}].accountId is empty`);
      }
      if (
        !Number.isFinite(row.probability) ||
        row.probability < 0 ||
        row.probability > 1
      ) {
        throw new Error(
          `${input.role}[${index}].probability must be within [0, 1]`,
        );
      }
      const idKey = typedIdKey(row.id);
      if (input.seenIds.has(idKey)) {
        throw new Error(
          `duplicate probability calibration observation id: ${idKey}`,
        );
      }
      input.seenIds.add(idKey);
      const decisionDate = calendarDate(
        row.decisionDate,
        `${input.role}[${index}].decisionDate`,
      );
      if (decisionDate < input.startDate || decisionDate > input.endDate) {
        throw new Error(
          `${input.role}[${index}] decision date is outside its fold`,
        );
      }
      const outcome = normalizedOutcome(row.outcome);
      const outcomeObservedDate =
        row.outcomeObservedDate === null
          ? null
          : calendarDate(
              row.outcomeObservedDate,
              `${input.role}[${index}].outcomeObservedDate`,
            );
      if (outcome === null && outcomeObservedDate !== null) {
        throw new Error(
          `${input.role}[${index}] unknown outcome cannot have an observed date`,
        );
      }
      if (outcome !== null && outcomeObservedDate === null) {
        throw new Error(
          `${input.role}[${index}] known outcome requires an observed date`,
        );
      }
      if (outcomeObservedDate !== null && outcomeObservedDate < decisionDate) {
        throw new Error(
          `${input.role}[${index}] outcome cannot precede its decision`,
        );
      }
      if (
        outcomeObservedDate !== null &&
        outcomeObservedDate > input.outcomeCutoffDate
      ) {
        throw new Error(
          `${input.role}[${index}] outcome was not available by its fold cutoff`,
        );
      }
      return {
        ...row,
        idKey,
        decisionDate,
        outcome,
        outcomeObservedDate,
      };
    })
    .sort(compareObservation);
}

function supportCounts<Action extends string>(
  rows: readonly NormalizedObservation<Action>[],
): ProbabilityCalibrationSupportCounts {
  let positiveOutcomeCount = 0;
  let negativeOutcomeCount = 0;
  let unknownOutcomeCount = 0;
  for (const row of rows) {
    if (row.outcome === 1) positiveOutcomeCount += 1;
    else if (row.outcome === 0) negativeOutcomeCount += 1;
    else unknownOutcomeCount += 1;
  }
  return {
    observationCount: rows.length,
    knownOutcomeCount: positiveOutcomeCount + negativeOutcomeCount,
    unknownOutcomeCount,
    positiveOutcomeCount,
    negativeOutcomeCount,
  };
}

function unsupportedReason(
  counts: ProbabilityCalibrationSupportCounts,
  requirement: ProbabilityCalibrationCellSupportRequirement,
): string | null {
  if (counts.knownOutcomeCount < requirement.minimumKnown) {
    return "minimum_known_not_met";
  }
  if (counts.positiveOutcomeCount < requirement.minimumPositive) {
    return "minimum_positive_not_met";
  }
  if (counts.negativeOutcomeCount < requirement.minimumNegative) {
    return "minimum_negative_not_met";
  }
  return null;
}

function knownRows<Action extends string>(
  rows: readonly NormalizedObservation<Action>[],
): KnownFitObservation[] {
  return rows
    .filter(
      (row): row is NormalizedObservation<Action> & { outcome: 0 | 1 } =>
        row.outcome !== null,
    )
    .map((row) => ({
      idKey: row.idKey,
      probability: row.probability,
      outcome: row.outcome,
    }))
    .sort(
      (left, right) =>
        left.probability - right.probability ||
        left.idKey.localeCompare(right.idKey),
    );
}

function withUpperBoundaries<
  T extends { minimumProbability: number; maximumProbability: number },
>(rows: readonly T[]): Array<T & { upperBoundary: number }> {
  return rows.map((row, index) => ({
    ...row,
    upperBoundary:
      index === rows.length - 1
        ? 1
        : (row.maximumProbability + rows[index + 1]!.minimumProbability) / 2,
  }));
}

function fitHistogram(
  rows: readonly KnownFitObservation[],
  config: EqualMassHistogramConfig,
):
  | {
      parameters: Extract<
        ProbabilityCalibrationModelParameters,
        { method: "equal_mass_histogram" }
      >;
      predict: (value: number) => number;
    }
  | { reason: string } {
  const supportedBinCount = Math.min(
    config.requestedBinCount,
    Math.floor(rows.length / config.minimumBinSize),
  );
  if (supportedBinCount < config.minimumBins) {
    return { reason: "histogram_minimum_bins_not_met" };
  }
  const baseSize = Math.floor(rows.length / supportedBinCount);
  const remainder = rows.length % supportedBinCount;
  const initial: Array<
    Omit<HistogramCalibrationBin, "index" | "upperBoundary">
  > = [];
  let offset = 0;
  for (let index = 0; index < supportedBinCount; index += 1) {
    const count = baseSize + (index < remainder ? 1 : 0);
    const binRows = rows.slice(offset, offset + count);
    offset += count;
    const positiveCount = binRows.reduce((sum, row) => sum + row.outcome, 0);
    initial.push({
      count,
      positiveCount,
      minimumProbability: binRows[0]!.probability,
      maximumProbability: binRows[binRows.length - 1]!.probability,
      observedRate: positiveCount / count,
    });
  }

  const tieSafe: typeof initial = [];
  for (const bin of initial) {
    const previous = tieSafe[tieSafe.length - 1];
    if (previous && previous.maximumProbability >= bin.minimumProbability) {
      previous.count += bin.count;
      previous.positiveCount += bin.positiveCount;
      previous.maximumProbability = Math.max(
        previous.maximumProbability,
        bin.maximumProbability,
      );
      previous.observedRate = previous.positiveCount / previous.count;
    } else {
      tieSafe.push({ ...bin });
    }
  }
  if (tieSafe.length < config.minimumBins) {
    return { reason: "histogram_distinct_bins_not_met" };
  }
  const bins = withUpperBoundaries(tieSafe).map((bin, index) => ({
    index,
    ...bin,
  }));
  const parameters = {
    method: "equal_mass_histogram" as const,
    requestedBinCount: config.requestedBinCount,
    effectiveBinCount: bins.length,
    bins,
  };
  return {
    parameters,
    predict: (value) =>
      (bins.find((bin) => value <= bin.upperBoundary) ?? bins[bins.length - 1]!)
        .observedRate,
  };
}

function fitIsotonic(rows: readonly KnownFitObservation[]): {
  parameters: Extract<
    ProbabilityCalibrationModelParameters,
    { method: "isotonic_pav" }
  >;
  predict: (value: number) => number;
} {
  const grouped: Array<{
    count: number;
    positiveCount: number;
    minimumProbability: number;
    maximumProbability: number;
  }> = [];
  for (const row of rows) {
    const previous = grouped[grouped.length - 1];
    if (previous && previous.maximumProbability === row.probability) {
      previous.count += 1;
      previous.positiveCount += row.outcome;
    } else {
      grouped.push({
        count: 1,
        positiveCount: row.outcome,
        minimumProbability: row.probability,
        maximumProbability: row.probability,
      });
    }
  }

  const pooled: typeof grouped = [];
  for (const group of grouped) {
    pooled.push({ ...group });
    while (pooled.length >= 2) {
      const right = pooled[pooled.length - 1]!;
      const left = pooled[pooled.length - 2]!;
      if (
        left.positiveCount / left.count <=
        right.positiveCount / right.count + FLOAT_TOLERANCE
      ) {
        break;
      }
      pooled.splice(pooled.length - 2, 2, {
        count: left.count + right.count,
        positiveCount: left.positiveCount + right.positiveCount,
        minimumProbability: left.minimumProbability,
        maximumProbability: right.maximumProbability,
      });
    }
  }

  const blocks = withUpperBoundaries(pooled).map((block, index) => ({
    index,
    ...block,
    fittedProbability: block.positiveCount / block.count,
  }));
  return {
    parameters: { method: "isotonic_pav", blocks },
    predict: (value) =>
      (
        blocks.find((block) => value <= block.upperBoundary) ??
        blocks[blocks.length - 1]!
      ).fittedProbability,
  };
}

function logistic(value: number): number {
  if (value >= 0) {
    const expNegative = Math.exp(-value);
    return 1 / (1 + expNegative);
  }
  const expValue = Math.exp(value);
  return expValue / (1 + expValue);
}

function logit(value: number): number {
  return Math.log(value / (1 - value));
}

function softplus(value: number): number {
  return value > 0
    ? value + Math.log1p(Math.exp(-value))
    : Math.log1p(Math.exp(value));
}

function fitPlatt(
  rows: readonly KnownFitObservation[],
  config: PlattCalibrationConfig,
):
  | {
      parameters: Extract<
        ProbabilityCalibrationModelParameters,
        { method: "platt" }
      >;
      predict: (value: number) => number;
    }
  | { reason: string } {
  const clamp = (value: number) =>
    Math.min(
      1 - config.probabilityEpsilon,
      Math.max(config.probabilityEpsilon, value),
    );
  const values = rows.map((row) => ({
    x: logit(clamp(row.probability)),
    y: row.outcome,
  }));
  const positiveCount = rows.reduce((sum, row) => sum + row.outcome, 0);
  let intercept = logit(clamp((positiveCount + 0.5) / (rows.length + 1)));
  let slope = 1;
  let iterations = 0;
  let converged = false;

  const objective = (nextIntercept: number, nextSlope: number) =>
    values.reduce((sum, row) => {
      const score = nextIntercept + nextSlope * row.x;
      return sum + softplus(score) - row.y * score;
    }, 0) +
    (config.l2Regularization / 2) *
      (nextIntercept * nextIntercept + nextSlope * nextSlope);

  for (
    let iteration = 1;
    iteration <= config.maximumIterations;
    iteration += 1
  ) {
    iterations = iteration;
    let gradientIntercept = config.l2Regularization * intercept;
    let gradientSlope = config.l2Regularization * slope;
    let hessianIntercept = config.l2Regularization;
    let hessianCross = 0;
    let hessianSlope = config.l2Regularization;
    for (const row of values) {
      const fitted = logistic(intercept + slope * row.x);
      const residual = fitted - row.y;
      const weight = fitted * (1 - fitted);
      gradientIntercept += residual;
      gradientSlope += residual * row.x;
      hessianIntercept += weight;
      hessianCross += weight * row.x;
      hessianSlope += weight * row.x * row.x;
    }
    const determinant =
      hessianIntercept * hessianSlope - hessianCross * hessianCross;
    if (!Number.isFinite(determinant) || determinant <= FLOAT_TOLERANCE) {
      return { reason: "platt_singular_hessian" };
    }
    const deltaIntercept =
      (gradientIntercept * hessianSlope - gradientSlope * hessianCross) /
      determinant;
    const deltaSlope =
      (gradientSlope * hessianIntercept - gradientIntercept * hessianCross) /
      determinant;
    if (
      Math.max(Math.abs(deltaIntercept), Math.abs(deltaSlope)) <=
      config.convergenceTolerance
    ) {
      converged = true;
      break;
    }

    const currentObjective = objective(intercept, slope);
    let step = 1;
    let accepted = false;
    while (step >= config.minimumLineSearchStep) {
      const candidateIntercept = intercept - step * deltaIntercept;
      const candidateSlope = slope - step * deltaSlope;
      const candidateObjective = objective(candidateIntercept, candidateSlope);
      if (
        Number.isFinite(candidateObjective) &&
        candidateObjective <= currentObjective + FLOAT_TOLERANCE
      ) {
        intercept = candidateIntercept;
        slope = candidateSlope;
        accepted = true;
        break;
      }
      step /= 2;
    }
    if (!accepted) return { reason: "platt_line_search_failed" };
    if (
      step * Math.max(Math.abs(deltaIntercept), Math.abs(deltaSlope)) <=
      config.convergenceTolerance
    ) {
      converged = true;
      break;
    }
  }
  if (!converged) return { reason: "platt_did_not_converge" };

  let constrainedToNonDecreasing = false;
  if (config.enforceNonDecreasing && slope < 0) {
    constrainedToNonDecreasing = true;
    slope = 0;
    intercept = logit(clamp(positiveCount / rows.length));
  }
  if (!Number.isFinite(intercept) || !Number.isFinite(slope)) {
    return { reason: "platt_non_finite_parameters" };
  }
  const parameters = {
    method: "platt" as const,
    intercept,
    slope,
    iterations,
    converged: true as const,
    constrainedToNonDecreasing,
  };
  return {
    parameters,
    predict: (value) => logistic(intercept + slope * logit(clamp(value))),
  };
}

function fitCell<Action extends string>(input: {
  method: ProbabilityCalibrationMethod;
  level: ProbabilityCalibrationCellLevel;
  action: Action | null;
  accountId: string | null;
  rows: readonly NormalizedObservation<Action>[];
  requirement: ProbabilityCalibrationCellSupportRequirement;
  histogram: EqualMassHistogramConfig;
  platt: PlattCalibrationConfig;
}): FittedCell<Action> {
  const support = supportCounts(input.rows);
  const reason = unsupportedReason(support, input.requirement);
  const base = {
    level: input.level,
    action: input.action,
    accountId: input.accountId,
    support,
  };
  if (reason !== null) {
    return {
      public: {
        ...base,
        status: "unsupported",
        reason,
        parameters: null,
      },
      predict: null,
    };
  }

  const rowsKnown = knownRows(input.rows);
  if (input.method === "identity") {
    return {
      public: {
        ...base,
        status: "fitted",
        reason: null,
        parameters: { method: "identity" },
      },
      predict: (probability) => probability,
    };
  }
  const fitted =
    input.method === "equal_mass_histogram"
      ? fitHistogram(rowsKnown, input.histogram)
      : input.method === "isotonic_pav"
        ? fitIsotonic(rowsKnown)
        : fitPlatt(rowsKnown, input.platt);
  if ("reason" in fitted) {
    return {
      public: {
        ...base,
        status: "unsupported",
        reason: fitted.reason,
        parameters: null,
      },
      predict: null,
    };
  }
  return {
    public: {
      ...base,
      status: "fitted",
      reason: null,
      parameters: fitted.parameters,
    },
    predict: fitted.predict,
  };
}

function actionAccountKey(action: string, accountId: string): string {
  return JSON.stringify([action, accountId]);
}

function finalCellOrder<Action extends string>(
  left: ProbabilityCalibrationCellFit<Action>,
  right: ProbabilityCalibrationCellFit<Action>,
): number {
  const rank: Record<ProbabilityCalibrationCellLevel, number> = {
    global: 0,
    action: 1,
    action_account: 2,
  };
  return (
    rank[left.level] - rank[right.level] ||
    (left.action ?? "").localeCompare(right.action ?? "") ||
    (left.accountId ?? "").localeCompare(right.accountId ?? "")
  );
}

function buildCells<Action extends string>(
  rows: readonly NormalizedObservation<Action>[],
  config: ProbabilityCalibrationConfig,
): {
  global: FittedCell<Action>;
  actions: Map<Action, FittedCell<Action>>;
  actionAccounts: Map<string, FittedCell<Action>>;
  ordered: FittedCell<Action>[];
} {
  const global = fitCell({
    method: config.method,
    level: "global",
    action: null,
    accountId: null,
    rows,
    requirement: config.support.global,
    histogram: config.histogram,
    platt: config.platt,
  });
  const actions = new Map<Action, FittedCell<Action>>();
  const actionAccounts = new Map<string, FittedCell<Action>>();
  const ordered = [global];
  if (config.pooling === "global") {
    return { global, actions, actionAccounts, ordered };
  }

  const rowsByAction = new Map<Action, NormalizedObservation<Action>[]>();
  const rowsByActionAccount = new Map<
    string,
    { action: Action; accountId: string; rows: NormalizedObservation<Action>[] }
  >();
  for (const row of rows) {
    const actionRows = rowsByAction.get(row.action) ?? [];
    actionRows.push(row);
    rowsByAction.set(row.action, actionRows);
    const key = actionAccountKey(row.action, row.accountId);
    const cell = rowsByActionAccount.get(key) ?? {
      action: row.action,
      accountId: row.accountId,
      rows: [],
    };
    cell.rows.push(row);
    rowsByActionAccount.set(key, cell);
  }

  for (const [action, actionRows] of Array.from(rowsByAction.entries()).sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    const cell = fitCell({
      method: config.method,
      level: "action",
      action,
      accountId: null,
      rows: actionRows,
      requirement: config.support.action,
      histogram: config.histogram,
      platt: config.platt,
    });
    actions.set(action, cell);
    ordered.push(cell);
  }
  for (const [key, entry] of Array.from(rowsByActionAccount.entries()).sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    const cell = fitCell({
      method: config.method,
      level: "action_account",
      action: entry.action,
      accountId: entry.accountId,
      rows: entry.rows,
      requirement: config.support.actionAccount,
      histogram: config.histogram,
      platt: config.platt,
    });
    actionAccounts.set(key, cell);
    ordered.push(cell);
  }
  ordered.sort((left, right) => finalCellOrder(left.public, right.public));
  return { global, actions, actionAccounts, ordered };
}

function unsupportedTransformation<Action extends string>(
  row: NormalizedObservation<Action>,
  reason: string,
): TransformedProbabilityCalibrationObservation<Action> {
  return {
    id: row.id,
    action: row.action,
    accountId: row.accountId,
    decisionDate: row.decisionDate,
    probability: row.probability,
    outcome: row.outcome,
    outcomeObservedDate: row.outcomeObservedDate,
    calibratedProbability: null,
    status: "unsupported",
    unsupportedReason: reason,
    contributions: [],
  };
}

function transformRow<Action extends string>(input: {
  row: NormalizedObservation<Action>;
  config: ProbabilityCalibrationConfig;
  cells: ReturnType<typeof buildCells<Action>>;
}): TransformedProbabilityCalibrationObservation<Action> {
  const global = input.cells.global;
  if (global.predict === null) {
    return unsupportedTransformation(
      input.row,
      `global_fit_unsupported:${global.public.reason ?? "missing"}`,
    );
  }
  const globalEstimate = global.predict(input.row.probability);
  if (input.config.pooling === "global") {
    return {
      ...unsupportedTransformation(input.row, ""),
      calibratedProbability: globalEstimate,
      status: "transformed",
      unsupportedReason: null,
      contributions: [
        {
          level: "global",
          knownOutcomeCount: global.public.support.knownOutcomeCount,
          finalWeight: 1,
        },
      ],
    };
  }

  const action = input.cells.actions.get(input.row.action);
  if (!action || action.predict === null) {
    return unsupportedTransformation(
      input.row,
      `action_fit_unsupported:${action?.public.reason ?? "missing_cell"}`,
    );
  }
  const actionAccount = input.cells.actionAccounts.get(
    actionAccountKey(input.row.action, input.row.accountId),
  );
  if (!actionAccount || actionAccount.predict === null) {
    return unsupportedTransformation(
      input.row,
      `action_account_fit_unsupported:${actionAccount?.public.reason ?? "missing_cell"}`,
    );
  }

  const actionLocalWeight =
    action.public.support.knownOutcomeCount /
    (action.public.support.knownOutcomeCount +
      input.config.support.actionPriorStrength);
  const pooledActionEstimate =
    actionLocalWeight * action.predict(input.row.probability) +
    (1 - actionLocalWeight) * globalEstimate;
  const accountLocalWeight =
    actionAccount.public.support.knownOutcomeCount /
    (actionAccount.public.support.knownOutcomeCount +
      input.config.support.actionAccountPriorStrength);
  const calibratedProbability =
    accountLocalWeight * actionAccount.predict(input.row.probability) +
    (1 - accountLocalWeight) * pooledActionEstimate;

  return {
    ...unsupportedTransformation(input.row, ""),
    calibratedProbability,
    status: "transformed",
    unsupportedReason: null,
    contributions: [
      {
        level: "global",
        knownOutcomeCount: global.public.support.knownOutcomeCount,
        finalWeight: (1 - accountLocalWeight) * (1 - actionLocalWeight),
      },
      {
        level: "action",
        knownOutcomeCount: action.public.support.knownOutcomeCount,
        finalWeight: (1 - accountLocalWeight) * actionLocalWeight,
      },
      {
        level: "action_account",
        knownOutcomeCount: actionAccount.public.support.knownOutcomeCount,
        finalWeight: accountLocalWeight,
      },
    ],
  };
}

function hashableObservation<Action extends string>(
  row: NormalizedObservation<Action>,
) {
  return {
    idType: typeof row.id,
    id: row.id,
    action: row.action,
    accountId: row.accountId,
    decisionDate: row.decisionDate,
    probability: row.probability,
    outcome: row.outcome,
    outcomeObservedDate: row.outcomeObservedDate,
  };
}

/**
 * Fits exactly one H10 challenger on the calibration fold and evaluates it on
 * a disjoint locked-test fold. Any unsupported hierarchical cell returns a
 * null calibrated probability instead of silently borrowing another action.
 */
export function fitAndEvaluateProbabilityCalibration<
  Action extends string,
>(input: {
  config: ProbabilityCalibrationConfig;
  protocol: ProbabilityCalibrationProtocol;
  calibrationObservations: readonly DatedProbabilityCalibrationObservation<Action>[];
  lockedTestObservations: readonly DatedProbabilityCalibrationObservation<Action>[];
}): ProbabilityCalibrationRun<Action> {
  const config = validateConfig({
    ...input.config,
    support: {
      ...input.config.support,
      global: { ...input.config.support.global },
      action: { ...input.config.support.action },
      actionAccount: { ...input.config.support.actionAccount },
    },
    histogram: { ...input.config.histogram },
    platt: { ...input.config.platt },
    evaluation: { ...input.config.evaluation },
  });
  const protocol = validateProtocol(input.protocol);
  const seenIds = new Set<string>();
  const calibration = normalizeObservations({
    rows: input.calibrationObservations,
    role: "calibration",
    startDate: protocol.calibrationStartDate,
    endDate: protocol.calibrationEndDate,
    outcomeCutoffDate: protocol.calibrationOutcomeCutoffDate,
    seenIds,
  });
  const lockedTest = normalizeObservations({
    rows: input.lockedTestObservations,
    role: "locked_test",
    startDate: protocol.lockedTestStartDate,
    endDate: protocol.lockedTestEndDate,
    outcomeCutoffDate: protocol.lockedTestOutcomeCutoffDate,
    seenIds,
  });
  const cells = buildCells(calibration, config);
  const transformed = lockedTest.map((row) =>
    transformRow({ row, config, cells }),
  );
  const calibrationCounts = supportCounts(calibration);
  const lockedTestCounts = supportCounts(lockedTest);
  const configHash = stableConfigHash(config);
  const calibrationDataHash = stableConfigHash(
    calibration.map(hashableObservation),
  );
  const cellFits = cells.ordered.map((cell) => cell.public);
  const fitHash = stableConfigHash({
    contractVersion: H10_PROBABILITY_CALIBRATION_CONTRACT_VERSION,
    configHash,
    calibrationDataHash,
    protocol,
    counts: calibrationCounts,
    cellFits,
  });
  const calibratedRows = transformed.filter(
    (
      row,
    ): row is TransformedProbabilityCalibrationObservation<Action> & {
      calibratedProbability: number;
    } => row.calibratedProbability !== null,
  );
  const rawEvaluation = actionSpecificCalibration(
    lockedTest.map((row) => ({
      id: row.id,
      action: row.action,
      probability: row.probability,
      outcome: row.outcome,
    })),
    config.evaluation,
  );
  const calibratedEvaluation = actionSpecificCalibration(
    calibratedRows.map((row) => ({
      id: row.id,
      action: row.action,
      probability: row.calibratedProbability,
      outcome: row.outcome,
    })),
    config.evaluation,
  );

  return {
    config,
    provenance: {
      contractVersion: H10_PROBABILITY_CALIBRATION_CONTRACT_VERSION,
      variantId: `${config.method}:${config.pooling}`,
      configHash,
      calibrationDataHash,
      fitHash,
      protocol,
      counts: calibrationCounts,
      cellFits,
    },
    counts: {
      calibration: calibrationCounts,
      lockedTest: lockedTestCounts,
      transformedObservationCount: calibratedRows.length,
      unsupportedObservationCount: transformed.length - calibratedRows.length,
      transformedKnownOutcomeCount: calibratedRows.filter(
        (row) => row.outcome !== null,
      ).length,
    },
    transformed,
    evaluation: {
      raw: rawEvaluation,
      calibrated: calibratedEvaluation,
    },
  };
}

function addCalendarDays(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function validateBayesianSensitivityConfig(
  config: BayesianWalkForwardSensitivityConfig,
): BayesianWalkForwardSensitivityConfig {
  if (!Number.isFinite(config.priorStrength) || config.priorStrength <= 0) {
    throw new Error("priorStrength must be finite and positive");
  }
  if (
    !Number.isFinite(config.probabilityBandwidth) ||
    config.probabilityBandwidth <= 0 ||
    config.probabilityBandwidth > 1
  ) {
    throw new Error("probabilityBandwidth must be within (0, 1]");
  }
  positiveInteger(config.foldCount, "foldCount");
  if (config.foldCount < 2) {
    throw new Error("foldCount must be at least 2");
  }
  if (
    !Number.isFinite(config.minimumEffectiveWeight) ||
    config.minimumEffectiveWeight < 0
  ) {
    throw new Error("minimumEffectiveWeight must be finite and non-negative");
  }
  positiveInteger(
    config.evaluation.requestedBinCount,
    "evaluation.requestedBinCount",
  );
  positiveInteger(
    config.evaluation.minimumBinSize,
    "evaluation.minimumBinSize",
  );
  positiveInteger(config.evaluation.minimumBins, "evaluation.minimumBins");
  if (config.evaluation.minimumBins > config.evaluation.requestedBinCount) {
    throw new Error("evaluation.minimumBins cannot exceed requestedBinCount");
  }
  return {
    ...config,
    evaluation: { ...config.evaluation },
  };
}

function bayesianPrediction<Action extends string>(input: {
  row: NormalizedObservation<Action>;
  trainingRows: readonly NormalizedObservation<Action>[];
  trainingCutoffDate: string;
  config: BayesianWalkForwardSensitivityConfig;
}): BayesianWalkForwardPrediction<Action> {
  let trainingKnownCount = 0;
  let trainingPositiveCount = 0;
  let effectiveLocalWeight = 0;
  let weightedPositiveCount = 0;
  for (const candidate of input.trainingRows) {
    if (candidate.action !== input.row.action || candidate.outcome === null) {
      continue;
    }
    trainingKnownCount += 1;
    trainingPositiveCount += candidate.outcome;
    const distance = Math.abs(candidate.probability - input.row.probability);
    const weight = Math.max(
      0,
      1 - distance / input.config.probabilityBandwidth,
    );
    effectiveLocalWeight += weight;
    weightedPositiveCount += weight * candidate.outcome;
  }
  const empirical =
    effectiveLocalWeight + FLOAT_TOLERANCE >=
    input.config.minimumEffectiveWeight;
  const calibratedProbability = empirical
    ? (input.config.priorStrength * input.row.probability +
        weightedPositiveCount) /
      (input.config.priorStrength + effectiveLocalWeight)
    : input.row.probability;
  return {
    id: input.row.id,
    action: input.row.action,
    accountId: input.row.accountId,
    decisionDate: input.row.decisionDate,
    probability: input.row.probability,
    outcome: input.row.outcome,
    outcomeObservedDate: input.row.outcomeObservedDate,
    calibratedProbability: Math.max(0, Math.min(1, calibratedProbability)),
    status: empirical ? "empirical" : "prior_only",
    trainingKnownCount,
    trainingPositiveCount,
    effectiveLocalWeight,
    weightedPositiveCount,
    trainingCutoffDate: input.trainingCutoffDate,
  };
}

function evaluateBayesianPredictions<Action extends string>(
  rows: readonly BayesianWalkForwardPrediction<Action>[],
  options: Required<ActionCalibrationOptions>,
): ProbabilityCalibrationEvaluation<Action> {
  return {
    raw: actionSpecificCalibration(
      rows.map((row) => ({
        id: row.id,
        action: row.action,
        probability: row.probability,
        outcome: row.outcome,
      })),
      options,
    ),
    calibrated: actionSpecificCalibration(
      rows.map((row) => ({
        id: row.id,
        action: row.action,
        probability: row.calibratedProbability,
        outcome: row.outcome,
      })),
      options,
    ),
  };
}

/**
 * Low-sample H10 sensitivity only. Calendar folds are contiguous and each
 * cross-fitted prediction sees outcomes observed strictly before its fold.
 * Locked-test outcomes are never used for fitting. The identity-centred Beta
 * prior keeps estimates bounded, while unsupported local cells fail closed to
 * the original probability. This run can never grant automation authority.
 */
export function fitBayesianWalkForwardSensitivity<
  Action extends string,
>(input: {
  config: BayesianWalkForwardSensitivityConfig;
  protocol: ProbabilityCalibrationProtocol;
  calibrationObservations: readonly DatedProbabilityCalibrationObservation<Action>[];
  lockedTestObservations: readonly DatedProbabilityCalibrationObservation<Action>[];
}): BayesianWalkForwardSensitivityRun<Action> {
  const config = validateBayesianSensitivityConfig(input.config);
  const protocol = validateProtocol(input.protocol);
  const seenIds = new Set<string>();
  const calibration = normalizeObservations({
    rows: input.calibrationObservations,
    role: "calibration",
    startDate: protocol.calibrationStartDate,
    endDate: protocol.calibrationEndDate,
    outcomeCutoffDate: protocol.calibrationOutcomeCutoffDate,
    seenIds,
  });
  const lockedTest = normalizeObservations({
    rows: input.lockedTestObservations,
    role: "locked_test",
    startDate: protocol.lockedTestStartDate,
    endDate: protocol.lockedTestEndDate,
    outcomeCutoffDate: protocol.lockedTestOutcomeCutoffDate,
    seenIds,
  });
  const uniqueDates = Array.from(
    new Set(calibration.map((row) => row.decisionDate)),
  ).sort();
  const foldByDate = new Map(
    uniqueDates.map((date, index) => [
      date,
      Math.min(
        config.foldCount - 1,
        Math.floor(
          (index * config.foldCount) / Math.max(1, uniqueDates.length),
        ),
      ),
    ]),
  );
  const foldStartDates = new Map<number, string>();
  for (const date of uniqueDates) {
    const fold = foldByDate.get(date)!;
    if (!foldStartDates.has(fold)) foldStartDates.set(fold, date);
  }
  const crossFittedCalibration = calibration.map((row) => {
    const fold = foldByDate.get(row.decisionDate)!;
    const foldStart = foldStartDates.get(fold)!;
    const trainingCutoffDate = addCalendarDays(foldStart, -1);
    const trainingRows = calibration.filter(
      (candidate) =>
        candidate.decisionDate < foldStart &&
        candidate.outcomeObservedDate !== null &&
        candidate.outcomeObservedDate <= trainingCutoffDate,
    );
    return bayesianPrediction({
      row,
      trainingRows,
      trainingCutoffDate,
      config,
    });
  });
  const lockedTrainingRows = calibration.filter(
    (row) =>
      row.outcomeObservedDate !== null &&
      row.outcomeObservedDate <= protocol.calibrationOutcomeCutoffDate,
  );
  const lockedTestPredictions = lockedTest.map((row) =>
    bayesianPrediction({
      row,
      trainingRows: lockedTrainingRows,
      trainingCutoffDate: protocol.calibrationOutcomeCutoffDate,
      config,
    }),
  );
  const configHash = stableConfigHash(config);
  const calibrationDataHash = stableConfigHash(
    calibration.map(hashableObservation),
  );
  const resultHash = stableConfigHash({
    contractVersion: H10_BAYESIAN_SENSITIVITY_CONTRACT_VERSION,
    configHash,
    calibrationDataHash,
    protocol,
    crossFittedCalibration,
    lockedTest: lockedTestPredictions,
  });
  return {
    contractVersion: H10_BAYESIAN_SENSITIVITY_CONTRACT_VERSION,
    descriptiveOnly: true,
    automationEligible: false,
    config,
    protocol,
    provenance: {
      variantId: `beta_kernel_bw${config.probabilityBandwidth}_prior${config.priorStrength}_folds${config.foldCount}`,
      configHash,
      calibrationDataHash,
      resultHash,
    },
    counts: {
      calibration: supportCounts(calibration),
      lockedTest: supportCounts(lockedTest),
      crossFittedEmpirical: crossFittedCalibration.filter(
        (row) => row.status === "empirical",
      ).length,
      crossFittedPriorOnly: crossFittedCalibration.filter(
        (row) => row.status === "prior_only",
      ).length,
      lockedTestEmpirical: lockedTestPredictions.filter(
        (row) => row.status === "empirical",
      ).length,
      lockedTestPriorOnly: lockedTestPredictions.filter(
        (row) => row.status === "prior_only",
      ).length,
    },
    crossFittedCalibration,
    lockedTest: lockedTestPredictions,
    evaluation: {
      crossFitted: evaluateBayesianPredictions(
        crossFittedCalibration,
        config.evaluation,
      ),
      lockedTest: evaluateBayesianPredictions(
        lockedTestPredictions,
        config.evaluation,
      ),
    },
  };
}
