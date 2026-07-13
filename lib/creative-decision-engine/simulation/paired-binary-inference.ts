export interface WilsonInterval {
  successes: number;
  total: number;
  estimate: number;
  lower: number;
  upper: number;
  confidenceLevel: number;
  zScore: number;
}

export interface PairedBinaryObservation<Id extends string | number = string> {
  id: Id;
  baselineCorrect: boolean | 0 | 1;
  candidateCorrect: boolean | 0 | 1;
}

export interface McNemarCounts {
  bothCorrect: number;
  baselineOnlyCorrect: number;
  candidateOnlyCorrect: number;
  bothWrong: number;
}

export interface McNemarResult extends McNemarCounts {
  pairedSampleSize: number;
  discordantPairs: number;
  candidateNetWins: number;
  candidateWinRateAmongDiscordant: number | null;
  adjustedCandidateToBaselineOddsRatio: number | null;
  continuityCorrectedChiSquare: number | null;
  asymptoticPValue: number;
  exactPValue: number;
  pValue: number;
  pValueMethod: "none" | "exact_binomial" | "continuity_corrected_chi_square";
}

export interface McNemarOptions {
  /** Exact two-sided binomial test is selected at or below this count. */
  exactDiscordantThreshold?: number;
}

function assertCount(value: number, field: string) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
}

// Peter J. Acklam's inverse-normal approximation, sufficient for CI work.
function inverseStandardNormal(probability: number): number {
  if (!(probability > 0 && probability < 1)) {
    throw new Error("normal quantile probability must be between 0 and 1");
  }

  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
    1.38357751867269e2, -3.066479806614716e1, 2.506628277459239,
  ];
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
    6.680131188771972e1, -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
    -2.549732539343734, 4.374664141464968, 2.938163982698783,
  ];
  const d = [
    7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996,
    3.754408661907416,
  ];
  const lowerTail = 0.02425;
  const upperTail = 1 - lowerTail;

  if (probability < lowerTail) {
    const q = Math.sqrt(-2 * Math.log(probability));
    return (
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
  if (probability > upperTail) {
    const q = Math.sqrt(-2 * Math.log(1 - probability));
    return -(
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }

  const q = probability - 0.5;
  const r = q * q;
  return (
    ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) *
      q) /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
  );
}

export function wilsonScoreInterval(
  successes: number,
  total: number,
  confidenceLevel = 0.95,
): WilsonInterval | null {
  assertCount(successes, "successes");
  assertCount(total, "total");
  if (successes > total) throw new Error("successes cannot exceed total");
  if (!(confidenceLevel > 0 && confidenceLevel < 1)) {
    throw new Error("confidenceLevel must be between 0 and 1");
  }
  if (total === 0) return null;

  const estimate = successes / total;
  const zScore = inverseStandardNormal(0.5 + confidenceLevel / 2);
  const zSquared = zScore * zScore;
  const denominator = 1 + zSquared / total;
  const center = (estimate + zSquared / (2 * total)) / denominator;
  const halfWidth =
    (zScore / denominator) *
    Math.sqrt(
      (estimate * (1 - estimate)) / total + zSquared / (4 * total * total),
    );

  return {
    successes,
    total,
    estimate,
    lower: Math.max(0, center - halfWidth),
    upper: Math.min(1, center + halfWidth),
    confidenceLevel,
    zScore,
  };
}

function logAddExp(left: number, right: number): number {
  if (left === Number.NEGATIVE_INFINITY) return right;
  if (right === Number.NEGATIVE_INFINITY) return left;
  const maximum = Math.max(left, right);
  return (
    maximum + Math.log(Math.exp(left - maximum) + Math.exp(right - maximum))
  );
}

function exactTwoSidedBinomialPValue(
  leftWins: number,
  rightWins: number,
): number {
  const trials = leftWins + rightWins;
  if (trials === 0) return 1;

  const tailMaximum = Math.min(leftWins, rightWins);
  let logTerm = -trials * Math.log(2);
  let logTail = Number.NEGATIVE_INFINITY;
  for (let successes = 0; successes <= tailMaximum; successes += 1) {
    if (successes > 0) {
      logTerm += Math.log(trials - successes + 1) - Math.log(successes);
    }
    logTail = logAddExp(logTail, logTerm);
  }
  return Math.min(1, 2 * Math.exp(logTail));
}

function complementaryErrorFunction(value: number): number {
  const sign = value < 0 ? -1 : 1;
  const absolute = Math.abs(value);
  const t = 1 / (1 + 0.3275911 * absolute);
  const polynomial =
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) *
      t +
      0.254829592) *
    t *
    Math.exp(-absolute * absolute);
  const erf = sign * (1 - polynomial);
  return 1 - erf;
}

function binary(value: boolean | 0 | 1, field: string): boolean {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  throw new Error(`${field} must be boolean, 0, or 1`);
}

export function pairedMcNemarFromCounts(
  counts: McNemarCounts,
  options: McNemarOptions = {},
): McNemarResult {
  assertCount(counts.bothCorrect, "bothCorrect");
  assertCount(counts.baselineOnlyCorrect, "baselineOnlyCorrect");
  assertCount(counts.candidateOnlyCorrect, "candidateOnlyCorrect");
  assertCount(counts.bothWrong, "bothWrong");
  const exactThreshold = options.exactDiscordantThreshold ?? 100;
  assertCount(exactThreshold, "exactDiscordantThreshold");

  const discordantPairs =
    counts.baselineOnlyCorrect + counts.candidateOnlyCorrect;
  const pairedSampleSize =
    counts.bothCorrect + discordantPairs + counts.bothWrong;
  const candidateNetWins =
    counts.candidateOnlyCorrect - counts.baselineOnlyCorrect;
  const exactPValue = exactTwoSidedBinomialPValue(
    counts.baselineOnlyCorrect,
    counts.candidateOnlyCorrect,
  );

  if (discordantPairs === 0) {
    return {
      ...counts,
      pairedSampleSize,
      discordantPairs,
      candidateNetWins,
      candidateWinRateAmongDiscordant: null,
      adjustedCandidateToBaselineOddsRatio: null,
      continuityCorrectedChiSquare: null,
      asymptoticPValue: 1,
      exactPValue,
      pValue: 1,
      pValueMethod: "none",
    };
  }

  const correctedDifference = Math.max(0, Math.abs(candidateNetWins) - 1);
  const continuityCorrectedChiSquare =
    (correctedDifference * correctedDifference) / discordantPairs;
  const asymptoticPValue = Math.max(
    0,
    Math.min(
      1,
      complementaryErrorFunction(Math.sqrt(continuityCorrectedChiSquare / 2)),
    ),
  );
  const useExact = discordantPairs <= exactThreshold;

  return {
    ...counts,
    pairedSampleSize,
    discordantPairs,
    candidateNetWins,
    candidateWinRateAmongDiscordant:
      counts.candidateOnlyCorrect / discordantPairs,
    adjustedCandidateToBaselineOddsRatio:
      (counts.candidateOnlyCorrect + 0.5) / (counts.baselineOnlyCorrect + 0.5),
    continuityCorrectedChiSquare,
    asymptoticPValue,
    exactPValue,
    pValue: useExact ? exactPValue : asymptoticPValue,
    pValueMethod: useExact
      ? "exact_binomial"
      : "continuity_corrected_chi_square",
  };
}

export function pairedMcNemar<Id extends string | number>(
  observations: readonly PairedBinaryObservation<Id>[],
  options: McNemarOptions = {},
): McNemarResult {
  const ids = new Set<string>();
  const counts: McNemarCounts = {
    bothCorrect: 0,
    baselineOnlyCorrect: 0,
    candidateOnlyCorrect: 0,
    bothWrong: 0,
  };

  for (const observation of observations) {
    const normalizedId = `${typeof observation.id}:${String(observation.id)}`;
    if (ids.has(normalizedId)) {
      throw new Error(
        `duplicate paired observation id: ${String(observation.id)}`,
      );
    }
    ids.add(normalizedId);

    const baselineCorrect = binary(
      observation.baselineCorrect,
      "baselineCorrect",
    );
    const candidateCorrect = binary(
      observation.candidateCorrect,
      "candidateCorrect",
    );
    if (baselineCorrect && candidateCorrect) counts.bothCorrect += 1;
    else if (baselineCorrect) counts.baselineOnlyCorrect += 1;
    else if (candidateCorrect) counts.candidateOnlyCorrect += 1;
    else counts.bothWrong += 1;
  }

  return pairedMcNemarFromCounts(counts, options);
}
