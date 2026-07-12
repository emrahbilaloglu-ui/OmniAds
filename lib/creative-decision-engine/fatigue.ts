import {
  FATIGUE_SIGNIFICANT_DECAY_THRESHOLD,
  FATIGUE_SPEND_CONCENTRATION_THRESHOLD,
  FATIGUE_STRONG_WINDOW_FALLBACK_ROAS,
} from "./config-values";

/**
 * Creative fatigue helper - computes fatigueStatus from per-creative historical
 * metrics. Logic mirrors the V1 fatigue motor (decay signals + winnerMemory
 * gate) but fixes the bestWindow selection bug: short windows (last3, last7)
 * are excluded to prevent lucky-day baseline pollution.
 */

export type FatigueStatus = "none" | "watch" | "fatigued" | "unknown";

export interface HistoricalWindow {
  spend: number;
  ctr: number;
  roas: number;
  clickToPurchaseRate: number;
  purchases: number;
}

export interface FatigueInput {
  // Current cumulative metrics (28d).
  ctr: number | null;
  roas: number | null;
  clickToPurchaseRate: number | null;
  effectiveTargetRoas?: number | null;
  breakevenRoas?: number | null;
  winnerMemoryMinSpend?: number | null;
  winnerMemoryMinPurchases?: number | null;

  historicalWindows: {
    // Legacy short windows can be passed by callers, but are intentionally
    // ignored for bestWindow selection.
    last3?: HistoricalWindow | null;
    last7?: HistoricalWindow | null;
    last14?: HistoricalWindow | null;
    /** Directly preceding disjoint comparison period. Callers must not
     * synthesize this from cumulative rates without their denominators. */
    prior14?: HistoricalWindow | null;
    last30?: HistoricalWindow | null;
    last90?: HistoricalWindow | null;
    allHistory?: HistoricalWindow | null;
  };

  // Pressure signals.
  spendConcentration: number | null;
  frequency: number | null;
  frequencyPressureThreshold?: number | null;

  // Benchmark trend. Warehouse v3 Phase 2.1 passes null; later phases can wire
  // account benchmark trend logic without changing this helper.
  benchmarkRoasStatus: "better" | "same" | "worse" | null;
  benchmarkClickToPurchaseStatus: "better" | "same" | "worse" | null;
}

export interface FatigueOutput {
  status: FatigueStatus;
  confidence: number;
  /**
   * Strong-window count over disjoint period bands derived from cumulative
   * spend, purchase, and revenue totals. This is the authority basis for
   * winnerMemory; nested cumulative windows are not independent evidence.
   */
  disjointStrongWindows: number;
  disjointWinnerMemory: boolean;
  ctrDecay: number | null;
  clickToPurchaseDecay: number | null;
  roasDecay: number | null;
  spendConcentration: number | null;
  frequencyPressure: number | null;
  winnerMemory: boolean;
  evidence: string[];
  missingContext: string[];
}

function roundMetric(value: number | null, precision: number) {
  return value === null ? null : Number(value.toFixed(precision));
}

function isFinitePositive(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * Derive disjoint period bands from the cumulative windows. Only the fields
 * strong-window counting needs (spend, purchases, roas) are derivable:
 * band spend/purchases are cumulative differences and band revenue is
 * roas*spend differences. ctr/clickToPurchaseRate are NOT derivable and are
 * set to 0 - callers must not use bands for decay math.
 */
export function deriveDisjointWindows(windows: {
  last14?: HistoricalWindow | null;
  last30?: HistoricalWindow | null;
  last90?: HistoricalWindow | null;
  allHistory?: HistoricalWindow | null;
}): HistoricalWindow[] {
  const ordered = [
    windows.last14 ?? null,
    windows.last30 ?? null,
    windows.last90 ?? null,
    windows.allHistory ?? null,
  ];
  const bands: HistoricalWindow[] = [];
  let previous: HistoricalWindow | null = null;
  for (const window of ordered) {
    if (window === null) continue;
    if (previous === null) {
      bands.push(window);
      previous = window;
      continue;
    }
    const spend = window.spend - previous.spend;
    const purchases = window.purchases - previous.purchases;
    const revenue = window.roas * window.spend - previous.roas * previous.spend;
    // Negative diffs mean inconsistent aggregates (or identical windows);
    // skip rather than fabricate a band.
    if (spend <= 0 || purchases < 0) {
      previous = window;
      continue;
    }
    bands.push({
      spend,
      purchases,
      roas: revenue > 0 ? revenue / spend : 0,
      ctr: 0,
      clickToPurchaseRate: 0,
    });
    previous = window;
  }
  return bands;
}

function isStrongHistoricalWindow(
  window: HistoricalWindow,
  effectiveTargetRoas: number | null | undefined,
  breakevenRoas: number | null | undefined,
  winnerMemoryMinSpend: number,
  winnerMemoryMinPurchases: number,
): boolean {
  if (!Number.isFinite(window.spend) || window.spend < winnerMemoryMinSpend) {
    return false;
  }
  if (
    !Number.isFinite(window.purchases) ||
    window.purchases < winnerMemoryMinPurchases
  ) {
    return false;
  }

  const targetThresholds: number[] = [];
  if (isFinitePositive(effectiveTargetRoas)) {
    targetThresholds.push(effectiveTargetRoas * 0.85);
  }
  if (isFinitePositive(breakevenRoas)) {
    targetThresholds.push(breakevenRoas * 1.1);
  }

  if (targetThresholds.length > 0) {
    return window.roas >= Math.max(...targetThresholds);
  }

  return window.roas >= FATIGUE_STRONG_WINDOW_FALLBACK_ROAS;
}

export function computeFatigue(input: FatigueInput): FatigueOutput {
  const winnerMemoryMinSpend =
    isFinitePositive(input.winnerMemoryMinSpend) ? input.winnerMemoryMinSpend : 0;
  const winnerMemoryMinPurchases = isFinitePositive(
    input.winnerMemoryMinPurchases,
  )
    ? input.winnerMemoryMinPurchases
    : 1;
  const eligibleWindows = [
    input.historicalWindows.last14,
    input.historicalWindows.last30,
    input.historicalWindows.last90,
    input.historicalWindows.allHistory,
  ].filter((window): window is HistoricalWindow => window != null);

  const disjointStrongWindows = deriveDisjointWindows(
    input.historicalWindows,
  ).filter((window) =>
    isStrongHistoricalWindow(
      window,
      input.effectiveTargetRoas,
      input.breakevenRoas,
      winnerMemoryMinSpend,
      winnerMemoryMinPurchases,
    ),
  ).length;
  const disjointWinnerMemory = disjointStrongWindows >= 2;
  // Nested cumulative windows let one strong stretch satisfy the >=2 rule by
  // itself; status and output both use the disjoint count.
  const winnerMemory = disjointWinnerMemory;
  // Decay baseline must clear the same spend/purchase floors as winner
  // memory: without a floor, a low-spend lucky window becomes the max-ROAS
  // baseline and ordinary mean reversion reads as decay (math review
  // 2026-07-02). If no window qualifies, decay is not assessable against a
  // trustworthy baseline.
  const recentWindowCandidate = input.historicalWindows.last14 ?? null;
  const clearsEvidenceFloor = (window: HistoricalWindow) =>
    Number.isFinite(window.spend) &&
    window.spend >= winnerMemoryMinSpend &&
    Number.isFinite(window.purchases) &&
    window.purchases >= winnerMemoryMinPurchases;
  const recentWindow =
    recentWindowCandidate && clearsEvidenceFloor(recentWindowCandidate)
      ? recentWindowCandidate
      : null;
  const explicitPriorWindow = input.historicalWindows.prior14 ?? null;
  const baselineCandidates = eligibleWindows.filter(
    (window) =>
      window !== recentWindowCandidate && clearsEvidenceFloor(window),
  );
  // When a recent 14-day endpoint exists, only a directly preceding disjoint
  // period is a valid decay baseline. Comparing recent14 with overlapping
  // last30/90 maxima labels recovery from an old peak as fatigue. If the
  // disjoint period is unavailable, decay is deliberately not assessable.
  const bestWindow = recentWindow
    ? explicitPriorWindow && clearsEvidenceFloor(explicitPriorWindow)
      ? explicitPriorWindow
      : null
    : [...baselineCandidates].sort((a, b) => b.roas - a.roas)[0] ?? null;

  const currentCtr = recentWindow?.ctr ?? input.ctr;
  const currentClickToPurchaseRate =
    recentWindow?.clickToPurchaseRate ?? input.clickToPurchaseRate;
  const currentRoas = recentWindow?.roas ?? input.roas;

  const ctrDecay =
    bestWindow && bestWindow.ctr > 0 && currentCtr != null
      ? (bestWindow.ctr - currentCtr) / bestWindow.ctr
      : null;
  const clickToPurchaseDecay =
    bestWindow &&
    bestWindow.clickToPurchaseRate > 0 &&
    currentClickToPurchaseRate != null
      ? (bestWindow.clickToPurchaseRate - currentClickToPurchaseRate) /
        bestWindow.clickToPurchaseRate
      : null;
  const roasDecay =
    bestWindow && bestWindow.roas > 0 && currentRoas != null
      ? (bestWindow.roas - currentRoas) / bestWindow.roas
      : null;

  const decaySignals = [ctrDecay, clickToPurchaseDecay, roasDecay].filter(
    (value): value is number =>
      typeof value === "number" && Number.isFinite(value),
  );
  const significantDecayCount = decaySignals.filter(
    (value) => value >= FATIGUE_SIGNIFICANT_DECAY_THRESHOLD,
  ).length;

  const pressureSignals =
    (input.spendConcentration != null &&
    input.spendConcentration >= FATIGUE_SPEND_CONCENTRATION_THRESHOLD
      ? 1
      : 0) +
    (input.frequency != null &&
    input.frequencyPressureThreshold != null &&
    Number.isFinite(input.frequencyPressureThreshold) &&
    input.frequencyPressureThreshold > 0 &&
    input.frequency >= input.frequencyPressureThreshold
      ? 1
      : 0);

  const benchmarkWeakening =
    input.benchmarkRoasStatus === "worse" &&
    input.benchmarkClickToPurchaseStatus === "worse";
  const hasFatiguePressure = pressureSignals >= 1 || benchmarkWeakening;

  let status: FatigueStatus = "none";
  if (!winnerMemory && eligibleWindows.length === 0) {
    status = "unknown";
  } else if (
    !winnerMemory &&
    significantDecayCount >= 2 &&
    hasFatiguePressure
  ) {
    status = "watch";
  } else if (
    winnerMemory &&
    significantDecayCount >= 2 &&
    hasFatiguePressure
  ) {
    status = "fatigued";
  } else if (
    winnerMemory &&
    hasFatiguePressure &&
    significantDecayCount >= 1
  ) {
    status = "watch";
  }

  const evidence: string[] = [];
  if (ctrDecay !== null) {
    evidence.push(
      `CTR decay ${Math.round(ctrDecay * 100)}% vs prior winner window.`,
    );
  }
  if (clickToPurchaseDecay !== null) {
    evidence.push(
      `Click-to-purchase decay ${Math.round(clickToPurchaseDecay * 100)}%.`,
    );
  }
  if (roasDecay !== null) {
    evidence.push(`ROAS decay ${Math.round(roasDecay * 100)}%.`);
  }
  if (input.spendConcentration !== null) {
    evidence.push(
      `Carries ${Math.round(input.spendConcentration * 100)}% of family spend.`,
    );
  }
  if (input.frequency !== null) {
    evidence.push(
      input.frequencyPressureThreshold != null
        ? `Frequency ${input.frequency.toFixed(2)} vs account p75 ${input.frequencyPressureThreshold.toFixed(2)}.`
        : `Frequency ${input.frequency.toFixed(2)}; account-relative pressure threshold unavailable.`,
    );
  }

  const missingContext: string[] = [];
  if (eligibleWindows.length === 0) {
    missingContext.push("Historical winner window unavailable");
  } else if (bestWindow === null) {
    missingContext.push(
      recentWindow
        ? "Directly preceding disjoint window unavailable or below evidence floor; decay not assessable"
        : "No historical window clears the winner-memory spend/purchase floor; decay not assessable",
    );
  }
  if (input.frequency == null) {
    missingContext.push("Frequency unavailable");
  } else if (
    input.frequencyPressureThreshold == null ||
    !Number.isFinite(input.frequencyPressureThreshold) ||
    input.frequencyPressureThreshold <= 0
  ) {
    missingContext.push("Account-relative frequency pressure threshold unavailable");
  }

  let confidence = 0.48;
  if (winnerMemory) confidence += 0.16;
  if (significantDecayCount >= 2) confidence += 0.14;
  if (pressureSignals >= 1) confidence += 0.08;
  if (missingContext.length > 0) confidence -= 0.08;
  confidence = Math.max(0.32, Math.min(0.9, Number(confidence.toFixed(2))));

  return {
    status,
    confidence,
    disjointStrongWindows,
    disjointWinnerMemory,
    ctrDecay: roundMetric(ctrDecay, 4),
    clickToPurchaseDecay: roundMetric(clickToPurchaseDecay, 4),
    roasDecay: roundMetric(roasDecay, 4),
    spendConcentration: roundMetric(input.spendConcentration, 4),
    frequencyPressure: roundMetric(input.frequency, 4),
    winnerMemory,
    evidence: evidence.slice(0, 4),
    missingContext,
  };
}
