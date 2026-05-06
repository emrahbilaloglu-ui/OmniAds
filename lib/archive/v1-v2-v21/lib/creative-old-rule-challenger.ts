import type {
  CreativeDecisionAction,
  CreativeDecisionInputRow,
  CreativeLifecycleState,
} from "@/lib/ai/generate-creative-decisions";

export interface CreativeOldRuleChallengerResult {
  creativeId: string;
  challengerAction: CreativeDecisionAction;
  lifecycleState: CreativeLifecycleState;
  reason: string;
  metricsUsed: string[];
  confidence: number;
  score: number;
  source: "legacy_rule_challenger";
  notPolicyAuthoritative: true;
  queueEligible: false;
  canApply: false;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function hasNumber(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function percentile(sortedValues: number[], p: number) {
  if (sortedValues.length === 0) return 0;
  if (sortedValues.length === 1) return sortedValues[0] ?? 0;
  const index = (sortedValues.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const weight = index - lower;
  const lowerValue = sortedValues[lower] ?? sortedValues[sortedValues.length - 1] ?? 0;
  const upperValue = sortedValues[upper] ?? sortedValues[sortedValues.length - 1] ?? 0;
  return lowerValue + (upperValue - lowerValue) * weight;
}

function sanitizeRows(rows: CreativeDecisionInputRow[]) {
  return rows
    .filter((row) => row.creativeId)
    .map((row) => ({
      ...row,
      creativeFormat: row.creativeFormat ?? "image",
      spend: hasNumber(row.spend) ? row.spend : 0,
      purchaseValue: hasNumber(row.purchaseValue) ? row.purchaseValue : 0,
      roas: hasNumber(row.roas) ? row.roas : 0,
      cpa: hasNumber(row.cpa) ? row.cpa : 0,
      ctr: hasNumber(row.ctr) ? row.ctr : 0,
      purchases: hasNumber(row.purchases) ? row.purchases : 0,
      impressions: hasNumber(row.impressions) ? row.impressions : 0,
      linkClicks: hasNumber(row.linkClicks) ? row.linkClicks : 0,
      clickToPurchaseRate: hasNumber(row.clickToPurchaseRate)
        ? row.clickToPurchaseRate
        : 0,
    }));
}

function weightedRoas(rows: CreativeDecisionInputRow[]) {
  const spend = rows.reduce((sum, row) => sum + Math.max(0, row.spend), 0);
  const purchaseValue = rows.reduce(
    (sum, row) => sum + Math.max(0, row.purchaseValue),
    0,
  );
  return spend > 0 ? purchaseValue / spend : 0;
}

function weightedCpa(rows: CreativeDecisionInputRow[]) {
  const spend = rows.reduce((sum, row) => sum + Math.max(0, row.spend), 0);
  const purchases = rows.reduce(
    (sum, row) => sum + Math.max(0, row.purchases),
    0,
  );
  return purchases > 0 ? spend / purchases : 0;
}

function lifecycleFor(action: CreativeDecisionAction): CreativeLifecycleState {
  if (action === "scale_hard" || action === "scale") return "emerging_winner";
  if (action === "test_more") return "test_only";
  if (action === "pause") return "blocked";
  if (action === "kill") return "blocked";
  return "volatile";
}

export function buildCreativeOldRuleChallenger(
  rows: CreativeDecisionInputRow[],
): CreativeOldRuleChallengerResult[] {
  const safeRows = sanitizeRows(rows);
  if (safeRows.length === 0) return [];

  const spendValues = safeRows
    .map((row) => row.spend)
    .filter((value) => value > 0)
    .sort((left, right) => left - right);
  const conversionQualityValues = safeRows
    .map((row) => row.clickToPurchaseRate)
    .filter((value) => value > 0);
  const roasAvg =
    weightedRoas(safeRows) ||
    safeRows.reduce((sum, row) => sum + Math.max(0, row.roas), 0) /
      Math.max(1, safeRows.length);
  const cpaAvg =
    weightedCpa(safeRows) ||
    safeRows.reduce((sum, row) => sum + Math.max(0, row.cpa), 0) /
      Math.max(1, safeRows.length);
  const spendP50 = percentile(spendValues, 0.5);
  const spendP80 = percentile(spendValues, 0.8);
  const avgConversionQuality =
    conversionQualityValues.length > 0
      ? conversionQualityValues.reduce((sum, value) => sum + value, 0) /
        conversionQualityValues.length
      : 0;

  return safeRows.map((row) => {
    const reliabilityScore =
      (row.spend >= Math.max(50, spendP50 * 0.5) ? 4 : 0) +
      (row.purchases >= 3 ? 5 : row.purchases >= 1 ? 2 : 0) +
      (row.impressions >= 5_000 ? 3 : row.impressions >= 1_000 ? 1 : 0) +
      (row.linkClicks >= 100 ? 3 : row.linkClicks >= 30 ? 1 : 0);
    const conversionQualityRatio =
      avgConversionQuality > 0
        ? row.clickToPurchaseRate / avgConversionQuality
        : row.purchases >= 3
          ? 1
          : 0;
    const strongConversionQuality = conversionQualityRatio >= 1.05;
    const acceptableConversionQuality = conversionQualityRatio >= 0.9;

    let action: CreativeDecisionAction = "watch";
    if (reliabilityScore < 7) {
      action = "test_more";
    } else if (reliabilityScore < 10) {
      action = "watch";
    } else if (
      roasAvg > 0 &&
      row.roas >= roasAvg * 1.45 &&
      row.spend >= Math.max(1, spendP50) &&
      row.purchases >= 3 &&
      strongConversionQuality
    ) {
      action = "scale_hard";
    } else if (
      roasAvg > 0 &&
      row.roas >= roasAvg * 1.2 &&
      acceptableConversionQuality
    ) {
      action = "scale";
    } else if (
      roasAvg > 0 &&
      row.roas < roasAvg * 0.55 &&
      row.spend >= Math.max(1, spendP80) &&
      row.purchases === 0
    ) {
      action = "kill";
    } else if (roasAvg > 0 && row.roas < roasAvg * 0.8) {
      action = "pause";
    }

    const confidenceBase =
      reliabilityScore < 7 ? 0.4 : row.spend >= spendP50 ? 0.72 : 0.58;
    const confidence = clamp(
      action === "watch" || action === "test_more"
        ? confidenceBase - 0.06
        : confidenceBase,
      0.3,
      0.88,
    );
    const actionBaseScore =
      action === "scale_hard"
        ? 90
        : action === "scale"
          ? 80
          : action === "watch"
            ? 60
            : action === "test_more"
              ? 52
              : action === "pause"
                ? 34
                : 18;
    const roasLift = roasAvg > 0 ? (row.roas / roasAvg - 1) * 18 : 0;
    const reliabilityAdj =
      reliabilityScore < 7 ? -8 : row.purchases >= 3 ? 5 : row.purchases >= 1 ? 2 : -2;
    const spendAdj = row.spend >= spendP50 ? 2 : -2;
    const score = Math.round(
      clamp(actionBaseScore + roasLift + reliabilityAdj + spendAdj, 0, 100),
    );
    const metricsUsed = [
      `ROAS ${row.roas.toFixed(2)} vs account ${roasAvg.toFixed(2)}`,
      `CPA ${row.cpa.toFixed(2)} vs account ${cpaAvg.toFixed(2)}`,
      `Spend ${row.spend.toFixed(2)} vs median ${spendP50.toFixed(2)}`,
      `Purchases ${row.purchases.toFixed(0)}`,
    ];
    const reason =
      action === "scale_hard"
        ? "Old-rule challenger sees top relative ROAS, conversion quality, and spend depth."
        : action === "scale"
          ? "Old-rule challenger sees account-relative upside with acceptable conversion quality."
          : action === "pause" || action === "kill"
            ? "Old-rule challenger sees account-relative downside with enough spend pressure."
            : action === "test_more"
              ? "Old-rule challenger sees insufficient evidence for a confident decision."
              : "Old-rule challenger sees mixed signals versus account baseline.";

    return {
      creativeId: row.creativeId,
      challengerAction: action,
      lifecycleState: lifecycleFor(action),
      reason,
      metricsUsed,
      confidence,
      score,
      source: "legacy_rule_challenger",
      notPolicyAuthoritative: true,
      queueEligible: false,
      canApply: false,
    };
  });
}
