import { createHash } from "node:crypto";

export interface PairedActionPermutationObservation {
  id: string;
  stratumId: string;
  baselineEmitted: boolean;
  candidateEmitted: boolean;
  outcomeSupported: boolean;
}

export interface PairedActionPermutationResult {
  seed: string;
  iterations: number;
  observationCount: number;
  discordantActionCount: number;
  permutableStrata: number;
  fixedStrata: number;
  observedNetCorrectDelta: number;
  observedMeanDelta: number | null;
  nullMean: number | null;
  nullLower: number | null;
  nullMedian: number | null;
  nullUpper: number | null;
  oneSidedPValue: number | null;
}

function seededUnitInterval(seed: string) {
  let state = createHash("sha256").update(seed).digest().readUInt32LE(0) || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function percentile(sorted: readonly number[], probability: number) {
  if (sorted.length === 0) return null;
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const weight = position - lower;
  return sorted[lower]! * (1 - weight) + sorted[upper]! * weight;
}

function actionUtility(
  baselineEmitted: boolean,
  candidateEmitted: boolean,
  outcomeSupported: boolean,
) {
  const supportValue = outcomeSupported ? 1 : -1;
  return (
    Number(candidateEmitted) * supportValue -
    Number(baselineEmitted) * supportValue
  );
}

/**
 * Permutes outcomes only within predeclared strata while preserving each
 * policy's dated action pattern. The statistic rewards added supported actions
 * and removed refuted actions, and penalizes the inverse.
 */
export function pairedActionStratifiedPermutationTest(
  observations: readonly PairedActionPermutationObservation[],
  options: { seed: string; iterations?: number },
): PairedActionPermutationResult {
  const iterations = options.iterations ?? 10_000;
  if (!Number.isInteger(iterations) || iterations <= 0) {
    throw new Error("iterations must be a positive integer");
  }

  const rows = [...observations].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
  if (new Set(rows.map((row) => row.id)).size !== rows.length) {
    throw new Error("observation ids must be unique");
  }
  const discordant = rows.filter(
    (row) => row.baselineEmitted !== row.candidateEmitted,
  );
  const observedNetCorrectDelta = discordant.reduce(
    (sum, row) =>
      sum +
      actionUtility(
        row.baselineEmitted,
        row.candidateEmitted,
        row.outcomeSupported,
      ),
    0,
  );
  if (discordant.length === 0) {
    return {
      seed: options.seed,
      iterations,
      observationCount: rows.length,
      discordantActionCount: 0,
      permutableStrata: 0,
      fixedStrata: 0,
      observedNetCorrectDelta: 0,
      observedMeanDelta: null,
      nullMean: null,
      nullLower: null,
      nullMedian: null,
      nullUpper: null,
      oneSidedPValue: null,
    };
  }

  const strata = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = strata.get(row.stratumId) ?? [];
    list.push(row);
    strata.set(row.stratumId, list);
  }
  const random = seededUnitInterval(options.seed);
  const nullMeans: number[] = [];
  let atLeastObserved = 0;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let net = 0;
    for (const stratumRows of strata.values()) {
      const outcomes = stratumRows.map((row) => row.outcomeSupported);
      for (let index = outcomes.length - 1; index > 0; index -= 1) {
        const swapIndex = Math.floor(random() * (index + 1));
        [outcomes[index], outcomes[swapIndex]] = [
          outcomes[swapIndex]!,
          outcomes[index]!,
        ];
      }
      for (let index = 0; index < stratumRows.length; index += 1) {
        const row = stratumRows[index]!;
        net += actionUtility(
          row.baselineEmitted,
          row.candidateEmitted,
          outcomes[index]!,
        );
      }
    }
    if (net >= observedNetCorrectDelta) atLeastObserved += 1;
    nullMeans.push(net / discordant.length);
  }
  nullMeans.sort((left, right) => left - right);
  const nullMean =
    nullMeans.reduce((sum, value) => sum + value, 0) / nullMeans.length;

  return {
    seed: options.seed,
    iterations,
    observationCount: rows.length,
    discordantActionCount: discordant.length,
    permutableStrata: [...strata.values()].filter((rows) => rows.length > 1)
      .length,
    fixedStrata: [...strata.values()].filter((rows) => rows.length <= 1).length,
    observedNetCorrectDelta,
    observedMeanDelta: observedNetCorrectDelta / discordant.length,
    nullMean,
    nullLower: percentile(nullMeans, 0.025),
    nullMedian: percentile(nullMeans, 0.5),
    nullUpper: percentile(nullMeans, 0.975),
    oneSidedPValue: (atLeastObserved + 1) / (iterations + 1),
  };
}
