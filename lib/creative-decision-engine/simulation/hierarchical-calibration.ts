export const H1_RECENCY_HALF_LIFE_DAYS = [14, 28, 56, 90] as const;
export const H1_SHRINKAGE_KAPPA = [8, 16, 32, 64] as const;
export const H1_QUANTILES = [
  0.1, 0.2, 0.25, 0.3, 0.5, 0.6, 0.7, 0.75, 0.8,
] as const;

export const H1_CANDIDATE_GRID = {
  recencyHalfLifeDays: H1_RECENCY_HALF_LIFE_DAYS,
  shrinkageKappa: H1_SHRINKAGE_KAPPA,
  quantiles: H1_QUANTILES,
} as const;

export interface WeightedObservation {
  value: number;
  weight: number;
}

export interface ShrinkageResult {
  value: number;
  localWeight: number;
  parentWeight: number;
}

export type HierarchicalCalibrationDomain = "positive_ratio" | "bounded_rate";

export interface HierarchicalCalibrationLevel {
  source: string;
  estimate: number | null;
  sampleSize: number;
  effectiveSampleSize: number;
}

export interface HierarchicalCalibrationContribution {
  source: string;
  sampleSize: number;
  effectiveSampleSize: number;
  role: "anchor" | "local";
  localWeight: number;
}

export interface HierarchicalCalibrationResolution {
  value: number;
  source: string;
  anchorSource: string;
  sampleSize: number;
  effectiveSampleSize: number;
  contributions: HierarchicalCalibrationContribution[];
}

const DEFAULT_LOGIT_EPSILON = 1e-6;
const SAMPLE_TOLERANCE = 1e-9;

function finiteNonNegative(value: number) {
  return Number.isFinite(value) && value >= 0;
}

function validPositiveRatio(value: number) {
  return Number.isFinite(value) && value > 0;
}

function validBoundedRate(value: number) {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function validEpsilon(value: number) {
  return Number.isFinite(value) && value > 0 && value < 0.5;
}

function clampRate(value: number, epsilon: number) {
  return Math.min(1 - epsilon, Math.max(epsilon, value));
}

function logit(value: number) {
  return Math.log(value / (1 - value));
}

function logistic(value: number) {
  if (value >= 0) {
    const expNegative = Math.exp(-value);
    return 1 / (1 + expNegative);
  }
  const expValue = Math.exp(value);
  return expValue / (1 + expValue);
}

export function recencyWeight(
  ageDays: number,
  halfLifeDays: number,
): number | null {
  if (!finiteNonNegative(ageDays) || !validPositiveRatio(halfLifeDays)) {
    return null;
  }
  return Math.exp((-Math.LN2 * ageDays) / halfLifeDays);
}

export function effectiveSampleSize(weights: readonly number[]): number | null {
  if (
    weights.length === 0 ||
    weights.some((weight) => !finiteNonNegative(weight))
  ) {
    return null;
  }
  const positiveWeights = weights.filter((weight) => weight > 0);
  if (positiveWeights.length === 0) return null;
  const sum = positiveWeights.reduce((total, weight) => total + weight, 0);
  const sumSquares = positiveWeights.reduce(
    (total, weight) => total + weight * weight,
    0,
  );
  if (
    !Number.isFinite(sum) ||
    !Number.isFinite(sumSquares) ||
    sumSquares <= 0
  ) {
    return null;
  }
  return (sum * sum) / sumSquares;
}

export function weightedQuantile(
  observations: readonly WeightedObservation[],
  quantile: number,
): number | null {
  if (
    observations.length === 0 ||
    !Number.isFinite(quantile) ||
    quantile < 0 ||
    quantile > 1 ||
    observations.some(
      ({ value, weight }) =>
        !Number.isFinite(value) || !finiteNonNegative(weight),
    )
  ) {
    return null;
  }
  const sorted = observations
    .filter(({ weight }) => weight > 0)
    .map((observation, index) => ({ ...observation, index }))
    .sort(
      (left, right) => left.value - right.value || left.index - right.index,
    );
  if (sorted.length === 0) return null;
  const totalWeight = sorted.reduce((total, item) => total + item.weight, 0);
  if (!Number.isFinite(totalWeight) || totalWeight <= 0) return null;
  if (quantile === 0) return sorted[0]!.value;

  const targetWeight = quantile * totalWeight;
  let cumulativeWeight = 0;
  for (const item of sorted) {
    cumulativeWeight += item.weight;
    if (cumulativeWeight >= targetWeight) return item.value;
  }
  return sorted[sorted.length - 1]!.value;
}

function shrinkTransformed(input: {
  localTransformed: number;
  parentTransformed: number;
  localEffectiveSampleSize: number;
  kappa: number;
  inverse: (value: number) => number;
}): ShrinkageResult | null {
  if (
    !Number.isFinite(input.localTransformed) ||
    !Number.isFinite(input.parentTransformed) ||
    !finiteNonNegative(input.localEffectiveSampleSize) ||
    !validPositiveRatio(input.kappa)
  ) {
    return null;
  }
  const localWeight =
    input.localEffectiveSampleSize /
    (input.localEffectiveSampleSize + input.kappa);
  const value = input.inverse(
    localWeight * input.localTransformed +
      (1 - localWeight) * input.parentTransformed,
  );
  if (!Number.isFinite(value)) return null;
  return { value, localWeight, parentWeight: 1 - localWeight };
}

export function shrinkPositiveRatioLogSpace(input: {
  local: number;
  parent: number;
  localEffectiveSampleSize: number;
  kappa: number;
}): ShrinkageResult | null {
  if (!validPositiveRatio(input.local) || !validPositiveRatio(input.parent)) {
    return null;
  }
  return shrinkTransformed({
    localTransformed: Math.log(input.local),
    parentTransformed: Math.log(input.parent),
    localEffectiveSampleSize: input.localEffectiveSampleSize,
    kappa: input.kappa,
    inverse: Math.exp,
  });
}

export function shrinkBoundedRateLogitSpace(input: {
  local: number;
  parent: number;
  localEffectiveSampleSize: number;
  kappa: number;
  epsilon?: number;
}): ShrinkageResult | null {
  const epsilon = input.epsilon ?? DEFAULT_LOGIT_EPSILON;
  if (
    !validBoundedRate(input.local) ||
    !validBoundedRate(input.parent) ||
    !validEpsilon(epsilon)
  ) {
    return null;
  }
  return shrinkTransformed({
    localTransformed: logit(clampRate(input.local, epsilon)),
    parentTransformed: logit(clampRate(input.parent, epsilon)),
    localEffectiveSampleSize: input.localEffectiveSampleSize,
    kappa: input.kappa,
    inverse: logistic,
  });
}

function validLevel(level: HierarchicalCalibrationLevel) {
  return (
    level.source.trim().length > 0 &&
    Number.isInteger(level.sampleSize) &&
    level.sampleSize >= 0 &&
    finiteNonNegative(level.effectiveSampleSize) &&
    level.effectiveSampleSize <= level.sampleSize + SAMPLE_TOLERANCE
  );
}

export function resolveHierarchicalCalibration(input: {
  domain: HierarchicalCalibrationDomain;
  levels: readonly HierarchicalCalibrationLevel[];
  kappa: number;
  minimumAnchorEffectiveSampleSize: number;
  epsilon?: number;
}): HierarchicalCalibrationResolution | null {
  if (
    input.levels.length === 0 ||
    !validPositiveRatio(input.kappa) ||
    !finiteNonNegative(input.minimumAnchorEffectiveSampleSize) ||
    input.levels.some((level) => !validLevel(level))
  ) {
    return null;
  }

  const validEstimate =
    input.domain === "positive_ratio" ? validPositiveRatio : validBoundedRate;
  if (
    input.levels.some(
      (level) => level.estimate !== null && !validEstimate(level.estimate),
    )
  ) {
    return null;
  }

  let anchorIndex = -1;
  for (let index = input.levels.length - 1; index >= 0; index -= 1) {
    const level = input.levels[index]!;
    if (
      level.estimate !== null &&
      level.effectiveSampleSize >= input.minimumAnchorEffectiveSampleSize
    ) {
      anchorIndex = index;
      break;
    }
  }
  if (anchorIndex < 0) return null;

  const anchor = input.levels[anchorIndex]!;
  let value = anchor.estimate!;
  let source = anchor.source;
  let sampleSize = anchor.sampleSize;
  let effectiveSize = anchor.effectiveSampleSize;
  const contributions: HierarchicalCalibrationContribution[] = [
    {
      source: anchor.source,
      sampleSize: anchor.sampleSize,
      effectiveSampleSize: anchor.effectiveSampleSize,
      role: "anchor",
      localWeight: 1,
    },
  ];

  for (let index = anchorIndex - 1; index >= 0; index -= 1) {
    const local = input.levels[index]!;
    if (local.estimate === null || local.effectiveSampleSize === 0) continue;
    const shrunk =
      input.domain === "positive_ratio"
        ? shrinkPositiveRatioLogSpace({
            local: local.estimate,
            parent: value,
            localEffectiveSampleSize: local.effectiveSampleSize,
            kappa: input.kappa,
          })
        : shrinkBoundedRateLogitSpace({
            local: local.estimate,
            parent: value,
            localEffectiveSampleSize: local.effectiveSampleSize,
            kappa: input.kappa,
            epsilon: input.epsilon,
          });
    if (shrunk === null) return null;
    value = shrunk.value;
    source = local.source;
    sampleSize = local.sampleSize;
    effectiveSize = local.effectiveSampleSize;
    contributions.push({
      source: local.source,
      sampleSize: local.sampleSize,
      effectiveSampleSize: local.effectiveSampleSize,
      role: "local",
      localWeight: shrunk.localWeight,
    });
  }

  return {
    value,
    source,
    anchorSource: anchor.source,
    sampleSize,
    effectiveSampleSize: effectiveSize,
    contributions,
  };
}
