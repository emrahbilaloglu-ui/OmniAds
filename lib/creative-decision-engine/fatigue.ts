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

  historicalWindows: {
    // Legacy short windows can be passed by callers, but are intentionally
    // ignored for bestWindow selection.
    last3?: HistoricalWindow | null;
    last7?: HistoricalWindow | null;
    last14?: HistoricalWindow | null;
    last30?: HistoricalWindow | null;
    last90?: HistoricalWindow | null;
    allHistory?: HistoricalWindow | null;
  };

  // Pressure signals.
  spendConcentration: number | null;
  frequency: number | null;

  // Benchmark trend. Warehouse v3 Phase 2.1 passes null; later phases can wire
  // account benchmark trend logic without changing this helper.
  benchmarkRoasStatus: "better" | "same" | "worse" | null;
  benchmarkClickToPurchaseStatus: "better" | "same" | "worse" | null;
}

export interface FatigueOutput {
  status: FatigueStatus;
  confidence: number;
  ctrDecay: number | null;
  clickToPurchaseDecay: number | null;
  roasDecay: number | null;
  spendConcentration: number | null;
  frequencyPressure: number | null;
  winnerMemory: boolean;
  evidence: string[];
  missingContext: string[];
}

const SIGNIFICANT_DECAY_THRESHOLD = 0.18;
const SPEND_CONCENTRATION_THRESHOLD = 0.55;
const FREQUENCY_PRESSURE_THRESHOLD = 2.5;
const STRONG_WINDOW_ROAS = 1.5;
const STRONG_WINDOW_PURCHASES = 1;

function roundMetric(value: number | null, precision: number) {
  return value === null ? null : Number(value.toFixed(precision));
}

export function computeFatigue(input: FatigueInput): FatigueOutput {
  const eligibleWindows = [
    input.historicalWindows.last14,
    input.historicalWindows.last30,
    input.historicalWindows.last90,
    input.historicalWindows.allHistory,
  ].filter((window): window is HistoricalWindow => window != null);

  const strongCount = eligibleWindows.filter(
    (window) =>
      window.roas >= STRONG_WINDOW_ROAS &&
      window.purchases >= STRONG_WINDOW_PURCHASES,
  ).length;
  const winnerMemory = strongCount >= 2;
  const bestWindow =
    [...eligibleWindows].sort((a, b) => b.roas - a.roas)[0] ?? null;

  const ctrDecay =
    bestWindow && bestWindow.ctr > 0 && input.ctr != null
      ? (bestWindow.ctr - input.ctr) / bestWindow.ctr
      : null;
  const clickToPurchaseDecay =
    bestWindow &&
    bestWindow.clickToPurchaseRate > 0 &&
    input.clickToPurchaseRate != null
      ? (bestWindow.clickToPurchaseRate - input.clickToPurchaseRate) /
        bestWindow.clickToPurchaseRate
      : null;
  const roasDecay =
    bestWindow && bestWindow.roas > 0 && input.roas != null
      ? (bestWindow.roas - input.roas) / bestWindow.roas
      : null;

  const decaySignals = [ctrDecay, clickToPurchaseDecay, roasDecay].filter(
    (value): value is number =>
      typeof value === "number" && Number.isFinite(value),
  );
  const significantDecayCount = decaySignals.filter(
    (value) => value >= SIGNIFICANT_DECAY_THRESHOLD,
  ).length;

  const pressureSignals =
    (input.spendConcentration != null &&
    input.spendConcentration >= SPEND_CONCENTRATION_THRESHOLD
      ? 1
      : 0) +
    (input.frequency != null && input.frequency >= FREQUENCY_PRESSURE_THRESHOLD
      ? 1
      : 0);

  const benchmarkWeakening =
    input.benchmarkRoasStatus === "worse" &&
    input.benchmarkClickToPurchaseStatus === "worse";

  let status: FatigueStatus = "none";
  if (!winnerMemory && eligibleWindows.length === 0) {
    status = "unknown";
  } else if (
    winnerMemory &&
    significantDecayCount >= 2 &&
    (pressureSignals >= 1 || benchmarkWeakening)
  ) {
    status = "fatigued";
  } else if (
    winnerMemory &&
    (significantDecayCount >= 1 || benchmarkWeakening)
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
    evidence.push(`Frequency ${input.frequency.toFixed(2)}.`);
  }

  const missingContext: string[] = [];
  if (eligibleWindows.length === 0) {
    missingContext.push("Historical winner window unavailable");
  }
  if (input.frequency == null) {
    missingContext.push("Frequency unavailable");
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
