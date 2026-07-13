export interface LeaveOneBusinessOutFold<Summary> {
  heldOutBusinessId: string;
  heldOutObservationCount: number;
  includedBusinessIds: string[];
  includedObservationCount: number;
  summary: Summary;
}

export interface LeaveOneBusinessOutResult<Summary> {
  businessIds: string[];
  observationCount: number;
  fullSummary: Summary;
  folds: Array<LeaveOneBusinessOutFold<Summary>>;
}

export interface LeaveOneBusinessOutOptions<T, Summary> {
  getBusinessId: (observation: T) => string;
  summarize: (observations: readonly T[]) => Summary;
}

export interface WeightedMetricSummary {
  observationCount: number;
  positiveWeightObservationCount: number;
  totalWeight: number;
  mean: number | null;
}

export interface LeaveOneBusinessOutMetricFold extends LeaveOneBusinessOutFold<WeightedMetricSummary> {
  shiftFromFullMean: number | null;
}

export interface LeaveOneBusinessOutMetricResult {
  businessIds: string[];
  observationCount: number;
  fullSummary: WeightedMetricSummary;
  folds: LeaveOneBusinessOutMetricFold[];
  minimumFoldMean: number | null;
  maximumFoldMean: number | null;
  maximumAbsoluteShiftFromFullMean: number | null;
  foldDirection: "positive" | "negative" | "mixed_or_zero" | "unavailable";
}

export interface LeaveOneBusinessOutMetricOptions<T> {
  getBusinessId: (observation: T) => string;
  getValue: (observation: T) => number;
  getWeight?: (observation: T) => number;
}

function businessId(value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error("business id cannot be empty");
  return normalized;
}

export function leaveOneBusinessOut<T, Summary>(
  observations: readonly T[],
  options: LeaveOneBusinessOutOptions<T, Summary>,
): LeaveOneBusinessOutResult<Summary> {
  const tagged = observations.map((observation) => ({
    observation,
    businessId: businessId(options.getBusinessId(observation)),
  }));
  const businessIds = Array.from(
    new Set(tagged.map((entry) => entry.businessId)),
  ).sort((left, right) => left.localeCompare(right));

  return {
    businessIds,
    observationCount: observations.length,
    fullSummary: options.summarize(observations),
    folds: businessIds.map((heldOutBusinessId) => {
      const included = tagged
        .filter((entry) => entry.businessId !== heldOutBusinessId)
        .map((entry) => entry.observation);
      return {
        heldOutBusinessId,
        heldOutObservationCount: observations.length - included.length,
        includedBusinessIds: businessIds.filter(
          (id) => id !== heldOutBusinessId,
        ),
        includedObservationCount: included.length,
        summary: options.summarize(included),
      };
    }),
  };
}

function weightedSummary<T>(
  observations: readonly T[],
  options: LeaveOneBusinessOutMetricOptions<T>,
): WeightedMetricSummary {
  let weightedValue = 0;
  let totalWeight = 0;
  let positiveWeightObservationCount = 0;

  for (const observation of observations) {
    const value = options.getValue(observation);
    const weight = options.getWeight?.(observation) ?? 1;
    if (!Number.isFinite(value)) {
      throw new Error("LOBO metric values must be finite");
    }
    if (!Number.isFinite(weight) || weight < 0) {
      throw new Error("LOBO metric weights must be finite and non-negative");
    }
    if (weight === 0) continue;
    weightedValue += value * weight;
    totalWeight += weight;
    positiveWeightObservationCount += 1;
  }

  return {
    observationCount: observations.length,
    positiveWeightObservationCount,
    totalWeight,
    mean: totalWeight > 0 ? weightedValue / totalWeight : null,
  };
}

export function summarizeLeaveOneBusinessOutMetric<T>(
  observations: readonly T[],
  options: LeaveOneBusinessOutMetricOptions<T>,
): LeaveOneBusinessOutMetricResult {
  const result = leaveOneBusinessOut(observations, {
    getBusinessId: options.getBusinessId,
    summarize: (included) => weightedSummary(included, options),
  });
  const folds = result.folds.map((fold) => ({
    ...fold,
    shiftFromFullMean:
      fold.summary.mean === null || result.fullSummary.mean === null
        ? null
        : fold.summary.mean - result.fullSummary.mean,
  }));
  const foldMeans = folds
    .map((fold) => fold.summary.mean)
    .filter((value): value is number => value !== null);
  const shifts = folds
    .map((fold) => fold.shiftFromFullMean)
    .filter((value): value is number => value !== null);
  const foldDirection =
    foldMeans.length === 0
      ? "unavailable"
      : foldMeans.every((value) => value > 0)
        ? "positive"
        : foldMeans.every((value) => value < 0)
          ? "negative"
          : "mixed_or_zero";

  return {
    businessIds: result.businessIds,
    observationCount: result.observationCount,
    fullSummary: result.fullSummary,
    folds,
    minimumFoldMean: foldMeans.length > 0 ? Math.min(...foldMeans) : null,
    maximumFoldMean: foldMeans.length > 0 ? Math.max(...foldMeans) : null,
    maximumAbsoluteShiftFromFullMean:
      shifts.length > 0
        ? Math.max(...shifts.map((value) => Math.abs(value)))
        : null,
    foldDirection,
  };
}
