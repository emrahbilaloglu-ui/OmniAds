export interface ActionCalibrationObservation<Action extends string = string> {
  id: string | number;
  action: Action;
  probability: number;
  outcome: boolean | 0 | 1 | null;
}

export interface EqualMassCalibrationBin {
  index: number;
  count: number;
  minimumProbability: number;
  maximumProbability: number;
  averageProbability: number;
  observedRate: number;
  absoluteGap: number;
  weight: number;
}

export interface ActionCalibrationSummary<Action extends string = string> {
  action: Action;
  observationCount: number;
  knownOutcomeCount: number;
  unknownOutcomeCount: number;
  requestedBinCount: number;
  effectiveBinCount: number;
  minimumBinSize: number;
  minimumBins: number;
  evidenceSufficient: boolean;
  expectedCalibrationError: number | null;
  brierScore: number | null;
  bins: EqualMassCalibrationBin[];
}

export interface ActionCalibrationOptions {
  requestedBinCount?: number;
  minimumBinSize?: number;
  minimumBins?: number;
}

interface KnownCalibrationObservation {
  idKey: string;
  probability: number;
  outcome: 0 | 1;
}

function positiveInteger(value: number, field: string) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
}

function normalizedOutcome(value: boolean | 0 | 1 | null): 0 | 1 | null {
  if (value === null) return null;
  if (value === true || value === 1) return 1;
  if (value === false || value === 0) return 0;
  throw new Error("outcome must be boolean, 0, 1, or null");
}

function buildEqualMassBins(
  observations: readonly KnownCalibrationObservation[],
  binCount: number,
): EqualMassCalibrationBin[] {
  if (binCount === 0) return [];

  const sorted = [...observations].sort(
    (left, right) =>
      left.probability - right.probability ||
      left.idKey.localeCompare(right.idKey),
  );
  const baseSize = Math.floor(sorted.length / binCount);
  const remainder = sorted.length % binCount;
  const bins: EqualMassCalibrationBin[] = [];
  let offset = 0;

  for (let index = 0; index < binCount; index += 1) {
    const count = baseSize + (index < remainder ? 1 : 0);
    const rows = sorted.slice(offset, offset + count);
    offset += count;
    const averageProbability =
      rows.reduce((sum, row) => sum + row.probability, 0) / count;
    const observedRate =
      rows.reduce((sum, row) => sum + row.outcome, 0) / count;

    bins.push({
      index,
      count,
      minimumProbability: rows[0].probability,
      maximumProbability: rows[rows.length - 1].probability,
      averageProbability,
      observedRate,
      absoluteGap: Math.abs(averageProbability - observedRate),
      weight: count / sorted.length,
    });
  }

  return bins;
}

/**
 * Computes calibration independently for each action. Brier remains available
 * as a descriptive score for any known sample; ECE is withheld until the
 * requested minimum evidence exists in every equal-mass bin.
 */
export function actionSpecificCalibration<Action extends string>(
  observations: readonly ActionCalibrationObservation<Action>[],
  options: ActionCalibrationOptions = {},
): ActionCalibrationSummary<Action>[] {
  const requestedBinCount = options.requestedBinCount ?? 10;
  const minimumBinSize = options.minimumBinSize ?? 20;
  const minimumBins = options.minimumBins ?? 2;
  positiveInteger(requestedBinCount, "requestedBinCount");
  positiveInteger(minimumBinSize, "minimumBinSize");
  positiveInteger(minimumBins, "minimumBins");
  if (minimumBins > requestedBinCount) {
    throw new Error("minimumBins cannot exceed requestedBinCount");
  }

  const byAction = new Map<
    Action,
    {
      total: number;
      unknown: number;
      known: KnownCalibrationObservation[];
      ids: Set<string>;
    }
  >();

  for (const observation of observations) {
    if (
      !Number.isFinite(observation.probability) ||
      observation.probability < 0 ||
      observation.probability > 1
    ) {
      throw new Error("probability must be finite and within [0, 1]");
    }
    const action = observation.action;
    if (!action) throw new Error("action cannot be empty");
    const group = byAction.get(action) ?? {
      total: 0,
      unknown: 0,
      known: [],
      ids: new Set<string>(),
    };
    const idKey = `${typeof observation.id}:${String(observation.id)}`;
    if (group.ids.has(idKey)) {
      throw new Error(
        `duplicate calibration observation id for ${action}: ${String(observation.id)}`,
      );
    }
    group.ids.add(idKey);
    group.total += 1;
    const outcome = normalizedOutcome(observation.outcome);
    if (outcome === null) group.unknown += 1;
    else {
      group.known.push({
        idKey,
        probability: observation.probability,
        outcome,
      });
    }
    byAction.set(action, group);
  }

  return Array.from(byAction.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([action, group]) => {
      const maximumSupportedBins = Math.floor(
        group.known.length / minimumBinSize,
      );
      const effectiveBinCount = Math.min(
        requestedBinCount,
        maximumSupportedBins,
      );
      const bins = buildEqualMassBins(group.known, effectiveBinCount);
      const evidenceSufficient = effectiveBinCount >= minimumBins;
      const brierScore =
        group.known.length === 0
          ? null
          : group.known.reduce(
              (sum, row) => sum + (row.probability - row.outcome) ** 2,
              0,
            ) / group.known.length;
      const expectedCalibrationError = evidenceSufficient
        ? bins.reduce((sum, bin) => sum + bin.weight * bin.absoluteGap, 0)
        : null;

      return {
        action,
        observationCount: group.total,
        knownOutcomeCount: group.known.length,
        unknownOutcomeCount: group.unknown,
        requestedBinCount,
        effectiveBinCount,
        minimumBinSize,
        minimumBins,
        evidenceSufficient,
        expectedCalibrationError,
        brierScore,
        bins,
      };
    });
}
