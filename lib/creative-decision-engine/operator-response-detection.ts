import type { DecisionLabel } from "./types";

export type OperatorResponseType =
  | "scaled"
  | "scaled_natural_saturation"
  | "ignored"
  | "paused"
  | "creative_archived"
  | "budget_decreased"
  | "unknown"
  | "no_recommendation";

export interface OperatorResponseInput {
  creativeId: string;
  businessId: string;
  asOf: string;
  recentRecommendations: Array<{
    decisionDate: string;
    label: DecisionLabel;
    confidence: number;
  }>;
  adsetBudgetHistory: Array<{
    capturedAt: string;
    dailyBudget: number | null;
    lifetimeBudget: number | null;
  }>;
  campaignBudgetHistory: Array<{
    capturedAt: string;
    dailyBudget: number | null;
    lifetimeBudget: number | null;
  }>;
  dailySpend: Array<{
    date: string;
    spend: number;
    purchases: number;
    effectiveStatus: string | null;
  }>;
  actionJournal: Array<{
    createdAt: string;
    eventType: string;
    actionTitle: string;
    metadata: Record<string, unknown>;
  }>;
  lifecyclePosition: string | null;
  recent7dRoas: number | null;
  cumulative28dRoas: number | null;
  recent7dFrequency: number | null;
  cumulative28dFrequency: number | null;
}

export interface OperatorResponseResult {
  responseType: OperatorResponseType;
  decisionRecommendedAt: string | null;
  operatorResponseDetectedAt: string | null;
  confidence: number;
  evidence: string[];
  promoteLifecyclePosition?: "past_peak_inaction";
  signals: {
    spendSlope7d: number | null;
    budgetChangeAmount: number | null;
    actionJournalReceiptCount: number;
    statusChanged: boolean;
    roasDecayPct: number | null;
    frequencyRosePct: number | null;
  };
}

interface BudgetChange {
  amount: number | null;
  previousBudget: number | null;
  source: "adset" | "campaign" | null;
  detectedAt: string | null;
}

interface ResponseSignals {
  spendSlope7d: number | null;
  spendRose: boolean;
  meanSpend: number | null;
  budgetChange: BudgetChange;
  journalReceipts: OperatorResponseInput["actionJournal"];
  statusChanged: boolean;
  lastStatus: string | null;
  roasDecayPct: number | null;
  frequencyRosePct: number | null;
}

const HARD_RECOMMENDATION_LABELS = new Set<DecisionLabel>([
  "scale",
  "refresh",
]);

const ACTIVE_STATUS = "ACTIVE";
const PAUSED_STATUS = "PAUSED";
const DELETED_STATUS = "DELETED";

export function detectOperatorResponse(
  input: OperatorResponseInput,
): OperatorResponseResult {
  const firstRecommendation = [...input.recentRecommendations]
    .filter((recommendation) =>
      HARD_RECOMMENDATION_LABELS.has(recommendation.label),
    )
    .sort((left, right) =>
      left.decisionDate.localeCompare(right.decisionDate),
    )[0];

  if (firstRecommendation === undefined) {
    return result({
      responseType: "no_recommendation",
      confidence: 1,
      evidence: ["engine never produced scale/refresh in window"],
      signals: emptySignals(),
    });
  }

  const recommendationDate = toIsoDateOnly(firstRecommendation.decisionDate);
  if (recommendationDate === null) {
    return result({
      responseType: "unknown",
      confidence: 0,
      evidence: ["recommendation date is invalid"],
      signals: emptySignals(),
    });
  }
  const daysSinceRecommendation = daysBetween(recommendationDate, input.asOf);
  if (daysSinceRecommendation < 3) {
    return result({
      responseType: "unknown",
      decisionRecommendedAt: recommendationDate,
      confidence: 0,
      evidence: ["recommendation too recent (<3 days)"],
      signals: emptySignals(),
    });
  }

  const signals = computeSignals(input, recommendationDate);
  const actionJournalReceiptCount = signals.journalReceipts.length;
  const signalPayload = toResultSignals(signals);
  const journalArchiveReceipt = signals.journalReceipts.some(isArchiveReceipt);
  const journalPauseReceipt = signals.journalReceipts.some(isPauseReceipt);
  const journalBudgetDecreaseReceipt =
    signals.journalReceipts.some(isBudgetDecreaseReceipt);
  const journalScaleReceipt = signals.journalReceipts.some(isScaleReceipt);
  const statusDeleted = signals.lastStatus === DELETED_STATUS;
  const statusPaused = signals.lastStatus === PAUSED_STATUS;
  const budgetChangeAmount = signals.budgetChange.amount;
  const budgetIncreaseSignal =
    budgetChangeAmount !== null && budgetChangeAmount > 0;
  const budgetDecreaseSignal =
    budgetChangeAmount !== null &&
    budgetChangeAmount < 0 &&
    isMaterialBudgetMove(signals.budgetChange);
  const scaledSignal =
    signals.spendRose || budgetIncreaseSignal || journalScaleReceipt;

  if (journalPauseReceipt && scaledSignal && !statusPaused && !statusDeleted) {
    return result({
      responseType: "unknown",
      decisionRecommendedAt: recommendationDate,
      operatorResponseDetectedAt: firstSignalAt(signals, recommendationDate),
      confidence: applyJournalConfidenceMultiplier(0.4, signals.journalReceipts),
      evidence: [
        "mixed signals: spend or budget rose after recommendation, but journal indicates pause",
      ],
      signals: signalPayload,
    });
  }

  if (statusDeleted || journalArchiveReceipt) {
    return result({
      responseType: "creative_archived",
      decisionRecommendedAt: recommendationDate,
      operatorResponseDetectedAt:
        firstJournalReceiptAt(signals.journalReceipts, isArchiveReceipt) ??
        firstNonActiveStatusAt(input.dailySpend, recommendationDate) ??
        input.asOf,
      confidence: applyJournalConfidenceMultiplier(
        statusDeleted && journalArchiveReceipt ? 0.9 : 0.8,
        signals.journalReceipts,
      ),
      evidence: [
        statusDeleted ? "latest creative status is DELETED" : null,
        journalArchiveReceipt ? "archive action journal receipt found" : null,
      ].filter(isNonNullString),
      signals: signalPayload,
    });
  }

  if (statusPaused || journalPauseReceipt) {
    return result({
      responseType: "paused",
      decisionRecommendedAt: recommendationDate,
      operatorResponseDetectedAt:
        firstJournalReceiptAt(signals.journalReceipts, isPauseReceipt) ??
        firstNonActiveStatusAt(input.dailySpend, recommendationDate) ??
        input.asOf,
      confidence: applyJournalConfidenceMultiplier(
        statusPaused && journalPauseReceipt ? 0.85 : 0.75,
        signals.journalReceipts,
      ),
      evidence: [
        statusPaused ? "latest creative status is PAUSED" : null,
        journalPauseReceipt ? "pause action journal receipt found" : null,
      ].filter(isNonNullString),
      signals: signalPayload,
    });
  }

  if (budgetDecreaseSignal || journalBudgetDecreaseReceipt) {
    return result({
      responseType: "budget_decreased",
      decisionRecommendedAt: recommendationDate,
      operatorResponseDetectedAt:
        signals.budgetChange.detectedAt ??
        firstJournalReceiptAt(signals.journalReceipts, isBudgetDecreaseReceipt) ??
        input.asOf,
      confidence: applyJournalConfidenceMultiplier(
        budgetDecreaseSignal ? 0.7 : 0.65,
        signals.journalReceipts,
      ),
      evidence: [
        budgetDecreaseSignal && budgetChangeAmount !== null
          ? `${signals.budgetChange.source ?? "budget"} budget reduced by ${Math.abs(
              budgetChangeAmount,
            ).toFixed(0)}`
          : null,
        journalBudgetDecreaseReceipt
          ? "budget decrease action journal receipt found"
          : null,
      ].filter(isNonNullString),
      signals: signalPayload,
    });
  }

  if (scaledSignal) {
    const saturationSignal =
      (signals.roasDecayPct !== null && signals.roasDecayPct > 0.2) ||
      (signals.frequencyRosePct !== null && signals.frequencyRosePct > 0.3);
    const evidence = [
      signals.spendRose ? "spend rose after recommendation" : null,
      budgetIncreaseSignal && budgetChangeAmount !== null
        ? `${signals.budgetChange.source ?? "budget"} budget increased by ${budgetChangeAmount.toFixed(
            0,
          )}`
        : null,
      journalScaleReceipt ? "scale action journal receipt found" : null,
      saturationSignal
        ? "scale acted on, then ROAS decayed >20% or frequency rose >30%"
        : null,
    ].filter(isNonNullString);

    return result({
      responseType: saturationSignal ? "scaled_natural_saturation" : "scaled",
      decisionRecommendedAt: recommendationDate,
      operatorResponseDetectedAt: firstSignalAt(signals, recommendationDate),
      confidence: applyJournalConfidenceMultiplier(
        saturationSignal ? 0.75 : 0.8,
        signals.journalReceipts,
      ),
      evidence,
      signals: signalPayload,
    });
  }

  if (
    daysSinceRecommendation >= 7 &&
    !signals.statusChanged &&
    actionJournalReceiptCount === 0 &&
    signals.lastStatus === ACTIVE_STATUS
  ) {
    return result({
      responseType: "ignored",
      decisionRecommendedAt: recommendationDate,
      operatorResponseDetectedAt: input.asOf,
      confidence: 0.7,
      evidence: [
        `engine recommended scale/refresh ${daysSinceRecommendation}d ago`,
        "no spend rise, no budget change, no action receipt",
        "status still ACTIVE",
      ],
      promoteLifecyclePosition:
        input.lifecyclePosition === "past_peak_unclear"
          ? "past_peak_inaction"
          : undefined,
      signals: signalPayload,
    });
  }

  return result({
    responseType: "unknown",
    decisionRecommendedAt: recommendationDate,
    operatorResponseDetectedAt:
      actionJournalReceiptCount > 0 ? signals.journalReceipts[0]?.createdAt ?? null : null,
    confidence: 0.4,
    evidence: ["mixed signals - manual review recommended"],
    signals: signalPayload,
  });
}

function computeSignals(
  input: OperatorResponseInput,
  recommendationDate: string,
): ResponseSignals {
  const postRecommendationSpend = input.dailySpend
    .filter((row) => isAfterDate(row.date, recommendationDate))
    .sort((left, right) => left.date.localeCompare(right.date));
  const spendSlope7d = computeSlope(
    postRecommendationSpend.slice(-7).flatMap((row) => {
      const x = dayNumber(row.date);
      return x === null ? [] : [{ x, y: finiteNumberOrZero(row.spend) }];
    }),
  );
  const meanSpend =
    postRecommendationSpend.length > 0
      ? mean(postRecommendationSpend.map((row) => finiteNumberOrZero(row.spend)))
      : null;
  const spendRose = hasSpendRise(postRecommendationSpend, spendSlope7d, meanSpend);
  const budgetChange = computeBudgetChange(
    input.adsetBudgetHistory,
    input.campaignBudgetHistory,
    recommendationDate,
    input.asOf,
  );
  const journalReceipts = input.actionJournal
    .filter((entry) => isAfterDateTime(entry.createdAt, recommendationDate))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const lastStatus = normalizeStatus(lastDailySpend(input.dailySpend)?.effectiveStatus);
  const roasDecayPct = computeRoasDecay(
    input.recent7dRoas,
    input.cumulative28dRoas,
  );
  const frequencyRosePct = computeFrequencyRise(
    input.recent7dFrequency,
    input.cumulative28dFrequency,
  );

  return {
    spendSlope7d,
    spendRose,
    meanSpend,
    budgetChange,
    journalReceipts,
    statusChanged: lastStatus !== null && lastStatus !== ACTIVE_STATUS,
    lastStatus,
    roasDecayPct,
    frequencyRosePct,
  };
}

function computeSlope(points: Array<{ x: number; y: number }>) {
  if (points.length < 2) return null;
  const xMean = mean(points.map((point) => point.x));
  const yMean = mean(points.map((point) => point.y));
  let numerator = 0;
  let denominator = 0;
  for (const point of points) {
    const xDelta = point.x - xMean;
    numerator += xDelta * (point.y - yMean);
    denominator += xDelta * xDelta;
  }
  if (denominator === 0) return null;
  const slope = numerator / denominator;
  return Number.isFinite(slope) ? slope : null;
}

function hasSpendRise(
  rows: OperatorResponseInput["dailySpend"],
  spendSlope7d: number | null,
  meanSpend: number | null,
) {
  if (rows.length < 3 || meanSpend === null || meanSpend <= 0) return false;
  const first = finiteNumberOrZero(rows[0]?.spend);
  const last = finiteNumberOrZero(rows[rows.length - 1]?.spend);
  const slopeSignal =
    spendSlope7d !== null && spendSlope7d > Math.max(1, meanSpend * 0.05);
  const liftSignal =
    first <= 0 ? last > 0 : last >= first * 1.15 && last - first >= meanSpend * 0.1;
  return slopeSignal || liftSignal;
}

function computeBudgetChange(
  adsetHistory: OperatorResponseInput["adsetBudgetHistory"],
  campaignHistory: OperatorResponseInput["campaignBudgetHistory"],
  recommendationDate: string,
  asOf: string,
): BudgetChange {
  const adsetChange = computeBudgetChangeForHistory(
    adsetHistory,
    recommendationDate,
    asOf,
    "adset",
  );
  const campaignChange = computeBudgetChangeForHistory(
    campaignHistory,
    recommendationDate,
    asOf,
    "campaign",
  );
  if (adsetChange.amount === null) return campaignChange;
  if (campaignChange.amount === null) return adsetChange;
  return Math.abs(adsetChange.amount) >= Math.abs(campaignChange.amount)
    ? adsetChange
    : campaignChange;
}

function computeBudgetChangeForHistory(
  history: OperatorResponseInput["adsetBudgetHistory"],
  recommendationDate: string,
  asOf: string,
  source: "adset" | "campaign",
): BudgetChange {
  const snapshots = history
    .map((snapshot) => ({
      capturedAt: snapshot.capturedAt,
      budget: effectiveBudget(snapshot),
    }))
    .filter(
      (snapshot): snapshot is { capturedAt: string; budget: number } =>
        snapshot.budget !== null &&
        isOnOrBeforeDate(snapshot.capturedAt, asOf),
    )
    .sort((left, right) => left.capturedAt.localeCompare(right.capturedAt));

  if (snapshots.length < 2) {
    return { amount: null, previousBudget: null, source: null, detectedAt: null };
  }

  const baseline =
    [...snapshots]
      .reverse()
      .find((snapshot) =>
        isOnOrBeforeDate(snapshot.capturedAt, recommendationDate),
      ) ?? snapshots[0];
  const latest =
    [...snapshots]
      .reverse()
      .find((snapshot) => isAfterDate(snapshot.capturedAt, recommendationDate)) ??
    snapshots[snapshots.length - 1];

  if (baseline === undefined || latest === undefined) {
    return { amount: null, previousBudget: null, source: null, detectedAt: null };
  }

  return {
    amount: latest.budget - baseline.budget,
    previousBudget: baseline.budget,
    source,
    detectedAt: latest.capturedAt,
  };
}

function effectiveBudget(input: {
  dailyBudget: number | null;
  lifetimeBudget: number | null;
}) {
  if (input.dailyBudget !== null && Number.isFinite(input.dailyBudget)) {
    return input.dailyBudget;
  }
  if (input.lifetimeBudget !== null && Number.isFinite(input.lifetimeBudget)) {
    return input.lifetimeBudget;
  }
  return null;
}

function isMaterialBudgetMove(change: BudgetChange) {
  if (change.amount === null || change.previousBudget === null) return false;
  if (change.previousBudget <= 0) return Math.abs(change.amount) > 0;
  return Math.abs(change.amount) > change.previousBudget * 0.15;
}

function computeRoasDecay(recent7dRoas: number | null, cumulative28dRoas: number | null) {
  if (
    recent7dRoas === null ||
    cumulative28dRoas === null ||
    recent7dRoas < 0 ||
    cumulative28dRoas <= 0
  ) {
    return null;
  }
  return (cumulative28dRoas - recent7dRoas) / cumulative28dRoas;
}

function computeFrequencyRise(
  recent7dFrequency: number | null,
  cumulative28dFrequency: number | null,
) {
  if (
    recent7dFrequency === null ||
    cumulative28dFrequency === null ||
    recent7dFrequency <= 0 ||
    cumulative28dFrequency <= 0
  ) {
    return null;
  }
  return (recent7dFrequency - cumulative28dFrequency) / cumulative28dFrequency;
}

function firstSignalAt(signals: ResponseSignals, fallback: string) {
  const journalAt = signals.journalReceipts[0]?.createdAt ?? null;
  const budgetAt =
    signals.budgetChange.amount !== null && signals.budgetChange.amount !== 0
      ? signals.budgetChange.detectedAt
      : null;
  return earliestTimestamp([journalAt, budgetAt]) ?? fallback;
}

function firstJournalReceiptAt(
  receipts: OperatorResponseInput["actionJournal"],
  predicate: (entry: OperatorResponseInput["actionJournal"][number]) => boolean,
) {
  return receipts.find(predicate)?.createdAt ?? null;
}

function firstNonActiveStatusAt(
  rows: OperatorResponseInput["dailySpend"],
  recommendationDate: string,
) {
  return (
    rows
      .filter((row) => isAfterDate(row.date, recommendationDate))
      .sort((left, right) => left.date.localeCompare(right.date))
      .find((row) => {
        const status = normalizeStatus(row.effectiveStatus);
        return status !== null && status !== ACTIVE_STATUS;
      })?.date ?? null
  );
}

function earliestTimestamp(values: Array<string | null>) {
  const sorted = values
    .filter(isNonNullString)
    .sort((left, right) => left.localeCompare(right));
  return sorted[0] ?? null;
}

function isArchiveReceipt(entry: OperatorResponseInput["actionJournal"][number]) {
  const text = journalSearchText(entry);
  return (
    text.includes("archive") ||
    text.includes("archived") ||
    text.includes("delete") ||
    text.includes("deleted")
  );
}

function isPauseReceipt(entry: OperatorResponseInput["actionJournal"][number]) {
  const text = journalSearchText(entry);
  return text.includes("pause") || text.includes("paused");
}

function isScaleReceipt(entry: OperatorResponseInput["actionJournal"][number]) {
  const text = journalSearchText(entry);
  return (
    text.includes("scale") ||
    text.includes("scaled") ||
    text.includes("budget_increased") ||
    text.includes("budget increased") ||
    text.includes("increase budget") ||
    text.includes("increased budget")
  );
}

function isBudgetDecreaseReceipt(entry: OperatorResponseInput["actionJournal"][number]) {
  const text = journalSearchText(entry);
  return (
    text.includes("budget_decreased") ||
    text.includes("budget decreased") ||
    text.includes("budget_cut") ||
    text.includes("budget cut") ||
    text.includes("reduced budget") ||
    text.includes("decrease budget")
  );
}

function journalSearchText(entry: OperatorResponseInput["actionJournal"][number]) {
  return [
    entry.eventType,
    entry.actionTitle,
    ...metadataTextValues(entry.metadata),
  ]
    .join(" ")
    .toLowerCase();
}

function metadataTextValues(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (typeof value === "string") return [value];
  if (typeof value === "number" || typeof value === "boolean") {
    return [String(value)];
  }
  if (Array.isArray(value)) return value.flatMap(metadataTextValues);
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(
      ([key, nestedValue]) => [key, ...metadataTextValues(nestedValue)],
    );
  }
  return [];
}

function toResultSignals(signals: ResponseSignals): OperatorResponseResult["signals"] {
  return {
    spendSlope7d: signals.spendSlope7d,
    budgetChangeAmount: signals.budgetChange.amount,
    actionJournalReceiptCount: signals.journalReceipts.length,
    statusChanged: signals.statusChanged,
    roasDecayPct: signals.roasDecayPct,
    frequencyRosePct: signals.frequencyRosePct,
  };
}

function applyJournalConfidenceMultiplier(
  baseConfidence: number,
  receipts: OperatorResponseInput["actionJournal"],
) {
  const multipliers = receipts
    .map((receipt) => receipt.metadata.operator_response_confidence_multiplier)
    .filter(
      (value): value is number =>
        typeof value === "number" && Number.isFinite(value) && value > 0,
    );
  if (multipliers.length === 0) return baseConfidence;
  return baseConfidence * Math.min(...multipliers);
}

function emptySignals(): OperatorResponseResult["signals"] {
  return {
    spendSlope7d: null,
    budgetChangeAmount: null,
    actionJournalReceiptCount: 0,
    statusChanged: false,
    roasDecayPct: null,
    frequencyRosePct: null,
  };
}

function result(
  input: Omit<
    OperatorResponseResult,
    "decisionRecommendedAt" | "operatorResponseDetectedAt"
  > & {
    decisionRecommendedAt?: string | null;
    operatorResponseDetectedAt?: string | null;
  },
): OperatorResponseResult {
  return {
    responseType: input.responseType,
    decisionRecommendedAt: input.decisionRecommendedAt ?? null,
    operatorResponseDetectedAt: input.operatorResponseDetectedAt ?? null,
    confidence: clamp01(input.confidence),
    evidence: input.evidence,
    promoteLifecyclePosition: input.promoteLifecyclePosition,
    signals: input.signals,
  };
}

function lastDailySpend(rows: OperatorResponseInput["dailySpend"][number][]) {
  return [...rows].sort((left, right) => right.date.localeCompare(left.date))[0];
}

function mean(values: number[]) {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function finiteNumberOrZero(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function normalizeStatus(value: string | null) {
  if (value === null) return null;
  const normalized = value.trim().toUpperCase();
  return normalized ? normalized : null;
}

function daysBetween(start: string, end: string) {
  const startDay = dayNumber(start);
  const endDay = dayNumber(end);
  if (startDay === null || endDay === null) return 0;
  return Math.max(0, Math.floor(endDay - startDay));
}

function isAfterDate(left: string, right: string) {
  const leftDay = dayNumber(left);
  const rightDay = dayNumber(right);
  return leftDay !== null && rightDay !== null && leftDay > rightDay;
}

function isOnOrBeforeDate(left: string, right: string) {
  const leftDay = dayNumber(left);
  const rightDay = dayNumber(right);
  return leftDay !== null && rightDay !== null && leftDay <= rightDay;
}

function isAfterDateTime(left: string, right: string) {
  const leftTime = timestampMillis(left);
  const rightTime = timestampMillis(right);
  return leftTime !== null && rightTime !== null && leftTime > rightTime;
}

function dayNumber(value: string | null | undefined) {
  const date = toIsoDateOnly(value);
  if (date === null) return null;
  const [year, month, day] = date.split("-").map(Number);
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    !Number.isFinite(year) ||
    !Number.isFinite(month) ||
    !Number.isFinite(day)
  ) {
    return null;
  }
  return Date.UTC(year, month - 1, day) / 86_400_000;
}

function timestampMillis(value: string | null | undefined) {
  if (value === null || value === undefined) return null;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? `${value}T00:00:00.000Z`
    : value;
  const parsed = new Date(dateOnly).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function toIsoDateOnly(value: string | null | undefined) {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const datePrefix = /^\d{4}-\d{2}-\d{2}/.exec(trimmed)?.[0] ?? null;
  if (datePrefix !== null) return datePrefix;
  const parsed = new Date(trimmed);
  if (!Number.isFinite(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function clamp01(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function isNonNullString(value: string | null): value is string {
  return value !== null;
}
