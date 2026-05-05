import { getOpenAI } from "@/lib/openai";
import {
  buildCreativeDecisionOs,
  mapCreativeDecisionOsToLegacyDecisions,
} from "@/lib/creative-decision-os";

const AI_MODEL = "gpt-5-nano";
const CREATIVE_DECISION_BATCH_SIZE = 220;
const CREATIVE_DECISION_MAX_TOKENS = 9000;
const CREATIVE_DECISION_RETRY_BATCH_SIZE = 4;
const CREATIVE_DECISION_RETRY_MAX_TOKENS = 1800;
const CREATIVE_DECISION_REPAIR_BATCH_SIZE = 10;
const CREATIVE_DECISION_REPAIR_ATTEMPTS = 2;

export type CreativeDecisionAction = "scale_hard" | "scale" | "watch" | "test_more" | "pause" | "kill";
export type CreativeLifecycleState =
  | "stable_winner"
  | "emerging_winner"
  | "volatile"
  | "fatigued_winner"
  | "test_only"
  | "blocked";

export interface CreativeDecisionInputRow {
  creativeId: string;
  name: string;
  creativeFormat?: "image" | "video" | "catalog";
  creativeAgeDays: number;
  spendVelocity: number;
  frequency: number;
  spend: number;
  purchaseValue: number;
  roas: number;
  cpa: number;
  ctr: number;
  cpm: number;
  cpc: number;
  purchases: number;
  impressions: number;
  linkClicks: number;
  hookRate: number;
  holdRate: number;
  video25Rate: number;
  watchRate: number;
  video75Rate: number;
  clickToPurchaseRate: number;
  atcToPurchaseRate: number;
  copyText?: string | null;
  copyVariants?: string[];
  headlineVariants?: string[];
  descriptionVariants?: string[];
  objectStoryId?: string | null;
  effectiveObjectStoryId?: string | null;
  postId?: string | null;
  accountId?: string | null;
  accountName?: string | null;
  campaignId?: string | null;
  campaignName?: string | null;
  adSetId?: string | null;
  adSetName?: string | null;
  taxonomyPrimaryLabel?: string | null;
  taxonomySecondaryLabel?: string | null;
  taxonomyVisualFormat?: string | null;
  aiTags?: Partial<Record<string, string[]>>;
  historicalWindows?: CreativeDecisionHistoricalWindows | null;
}

export interface CreativeDecisionHistoricalWindow {
  spend: number;
  purchaseValue: number;
  roas: number;
  cpa: number;
  ctr: number;
  purchases: number;
  impressions: number;
  linkClicks: number;
  hookRate: number;
  holdRate: number;
  video25Rate: number;
  watchRate: number;
  video75Rate: number;
  clickToPurchaseRate: number;
  atcToPurchaseRate: number;
}

export interface CreativeDecisionHistoricalWindows {
  last3?: CreativeDecisionHistoricalWindow | null;
  last7?: CreativeDecisionHistoricalWindow | null;
  last14?: CreativeDecisionHistoricalWindow | null;
  last30?: CreativeDecisionHistoricalWindow | null;
  last90?: CreativeDecisionHistoricalWindow | null;
  allHistory?: CreativeDecisionHistoricalWindow | null;
}

export interface GenerateCreativeDecisionsInput {
  businessId: string;
  currency: string;
  creatives: CreativeDecisionInputRow[];
}
export const CREATIVE_DECISION_ENGINE_VERSION = "2026-04-10-creative-decision-os-v1";

export interface CreativeDecisionResult {
  creativeId: string;
  action: CreativeDecisionAction;
  lifecycleState: CreativeLifecycleState;
  score: number;
  confidence: number;
  scoringFactors: string[];
  reasons: string[];
  nextStep: string;
}

interface ParsedAiDecisionPayload {
  decisions: Array<{
    creativeId?: string;
    action?: string;
    classification?: string;
    score?: number;
    confidence?: number;
    confidenceLevel?: string;
    reasons?: unknown;
    analysis?: string;
    nextStep?: string;
  }>;
}

const SYSTEM_PROMPT = `You are a senior ecommerce performance marketing media buyer responsible for evaluating advertising creatives.

Your task is to analyze advertising creative performance using marketing funnel metrics and classify each creative into one of the following operational states:

SCALE HARD
SCALE
WATCH
TEST MORE
PAUSE
KILL

These classifications represent real budget allocation decisions used by professional media buyers managing performance campaigns.

Your goal is to determine which creatives deserve aggressive scaling, which should continue testing, and which should be paused or completely stopped.

Never rely on a single metric. Always analyze creative performance holistically across the entire marketing funnel.

CREATIVE LIFECYCLE MODEL

Creatives move through a lifecycle in performance marketing:

TEST -> WATCH -> SCALE -> SCALE HARD -> FATIGUE -> PAUSE -> KILL

Your job is to identify where the creative currently sits in this lifecycle based on the provided performance metrics.

INPUT METRICS

You may receive metrics including:

creativeAgeDays
spendVelocity
frequency

impressions
spend
roas
cpa
purchaseValue
purchases

ctr
cpc
cpm
linkClicks

hookRate
holdRate
watchRate

video25Rate
video75Rate

clickToPurchaseRate
atcToPurchaseRate

creativeFormat

accountAverageRoas
accountAverageCpa
accountAverageCTR
accountAverageConversionRate

CREATIVE ANALYSIS FRAMEWORK

Evaluate creatives through five funnel layers:

1. Attention Layer
2. Engagement Layer
3. Click Intent Layer
4. Conversion Layer
5. Revenue Efficiency Layer

Strong creatives perform well across multiple funnel layers.

RELATIVE PERFORMANCE ANALYSIS

Always compare creative performance against account averages when available.

Important comparisons:

creative ROAS vs accountAverageRoas
creative CPA vs accountAverageCpa
creative CTR vs accountAverageCTR
creative conversion rate vs accountAverageConversionRate

Relative performance is often more important than absolute numbers.

CRITICAL DECISION CONSTRAINT

Never use fixed absolute ROAS thresholds (like "ROAS below 5") as a direct pause/kill rule.
Decisions must be relative to account context first.
If ROAS is above accountAverageRoas and CPA is not meaningfully worse than accountAverageCpa,
PAUSE/KILL is usually inconsistent unless another severe risk is clearly present.

CREATIVE FORMAT CONTEXT

If creativeFormat = video:

Engagement metrics become more important:
watchRate
holdRate
video completion

If creativeFormat = image:

CTR and conversion signals matter more.

DATA SUFFICIENCY RULES

Avoid aggressive decisions when data is insufficient.

Low impressions, low spend, or very few conversions should bias toward TEST MORE or WATCH.

Do not kill or scale aggressively when statistical confidence is low.

CREATIVE SCORING MODEL

Produce a creative performance score between 0 and 100.

Score interpretation:

90-100 exceptional
80-89 strong
65-79 good
50-64 moderate
35-49 weak
0-34 poor

The score should reflect funnel health, revenue efficiency, engagement strength, statistical confidence, and relative performance vs account averages.

IMPORTANT RULES

Do not hallucinate metrics.
Only analyze the data provided.
Do not invent numbers.
Always reference relevant metrics in your reasoning.

OUTPUT CONTRACT FOR THIS API

Return ONLY valid JSON in this exact structure:
{
  "decisions": [
    {
      "creativeId": "string",
      "classification": "SCALE HARD | SCALE | WATCH | TEST MORE | PAUSE | KILL",
      "score": 0,
      "confidence": "LOW | MEDIUM | HIGH",
      "analysis": "short explanation",
      "nextStep": "string"
    }
  ]
}

Each creativeId must appear exactly once.`;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function sanitizeReasonList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .slice(0, 2)
    .map((item) => item.trim());
}

function normalizeAction(action: string | undefined): CreativeDecisionAction | null {
  if (!action) return null;
  const normalized = action.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (normalized === "scale_hard") return "scale_hard";
  if (normalized === "scale") return "scale";
  if (normalized === "watch") return "watch";
  if (normalized === "test_more") return "test_more";
  if (normalized === "pause") return "pause";
  if (normalized === "kill") return "kill";
  return null;
}

function mapConfidenceToNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return clamp(value, 0, 1);
  }
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "low") return 0.42;
  if (normalized === "medium") return 0.64;
  if (normalized === "high") return 0.84;
  return null;
}

function chunkRows<T>(rows: T[], size: number): T[][] {
  if (size <= 0) return [rows];
  const chunks: T[][] = [];
  for (let index = 0; index < rows.length; index += size) {
    chunks.push(rows.slice(index, index + size));
  }
  return chunks;
}

function computeWeightedRoas(rows: CreativeDecisionInputRow[]): number {
  let totalSpend = 0;
  let totalPurchaseValue = 0;

  for (const row of rows) {
    const spend = Number.isFinite(row.spend) ? row.spend : 0;
    const purchaseValue = Number.isFinite(row.purchaseValue) ? row.purchaseValue : 0;
    if (spend > 0) {
      totalSpend += spend;
      totalPurchaseValue += purchaseValue;
    }
  }

  if (totalSpend <= 0) return 0;
  return totalPurchaseValue / totalSpend;
}

function computeWeightedCpa(rows: CreativeDecisionInputRow[]): number {
  let totalSpend = 0;
  let totalPurchases = 0;
  for (const row of rows) {
    const spend = Number.isFinite(row.spend) ? row.spend : 0;
    const purchases = Number.isFinite(row.purchases) ? row.purchases : 0;
    if (spend > 0) {
      totalSpend += spend;
    }
    if (purchases > 0) {
      totalPurchases += purchases;
    }
  }
  if (totalPurchases <= 0) return 0;
  return totalSpend / totalPurchases;
}

function computeWeightedCtr(rows: CreativeDecisionInputRow[]): number {
  let totalImpressions = 0;
  let totalLinkClicks = 0;
  for (const row of rows) {
    const impressions = Number.isFinite(row.impressions) ? row.impressions : 0;
    const linkClicks = Number.isFinite(row.linkClicks) ? row.linkClicks : 0;
    if (impressions > 0) {
      totalImpressions += impressions;
    }
    if (linkClicks > 0) {
      totalLinkClicks += linkClicks;
    }
  }
  if (totalImpressions <= 0) return 0;
  return (totalLinkClicks / totalImpressions) * 100;
}

function buildUserPrompt(input: GenerateCreativeDecisionsInput): string {
  const safeCreatives = sanitizeInputRows(input.creatives);
  const coreRows = safeCreatives.map((row) => ({
    row,
    core: buildWeightedCreativeSnapshot(row),
    history: historicalSupportSummary(row, 0, 0),
  }));

  const spendValues = coreRows
    .map(({ core }) => core.spend)
    .filter((value) => value >= 0)
    .sort((a, b) => a - b);
  const roasValues = coreRows
    .map(({ core }) => core.roas)
    .filter((value) => value >= 0)
    .sort((a, b) => a - b);
  const cpaValues = coreRows
    .map(({ core }) => core.cpa)
    .filter((value) => value > 0)
    .sort((a, b) => a - b);
  const totalSpend = coreRows.reduce((sum, { core }) => sum + core.spend, 0);
  const spendMedian = percentile(spendValues, 0.5);
  const spendP25 = percentile(spendValues, 0.25);
  const spendP75 = percentile(spendValues, 0.75);
  const roasMedian = percentile(roasValues, 0.5);
  const weightedRoas = totalSpend > 0
    ? coreRows.reduce((sum, { core }) => sum + core.purchaseValue, 0) / totalSpend
    : 0;
  const weightedCpa = (() => {
    const purchases = coreRows.reduce((sum, { core }) => sum + core.purchases, 0);
    return purchases > 0 ? totalSpend / purchases : 0;
  })();
  const weightedCtr = (() => {
    const impressions = coreRows.reduce((sum, { core }) => sum + core.impressions, 0);
    const clicks = coreRows.reduce((sum, { core }) => sum + core.linkClicks, 0);
    return impressions > 0 ? (clicks / impressions) * 100 : 0;
  })();
  const accountAverageRoas =
    weightedRoas > 0
      ? weightedRoas
      : roasValues.length > 0
        ? roasValues.reduce((sum, value) => sum + value, 0) / roasValues.length
        : 0;
  const accountAverageCpa =
    weightedCpa > 0
      ? weightedCpa
      : cpaValues.length > 0
        ? cpaValues.reduce((sum, value) => sum + value, 0) / cpaValues.length
        : 0;
  const ctrValues = coreRows
    .map(({ core }) => core.ctr)
    .filter((value) => value >= 0);
  const accountAverageCTR =
    weightedCtr > 0
      ? weightedCtr
      : ctrValues.length > 0
        ? ctrValues.reduce((sum, value) => sum + value, 0) / ctrValues.length
        : 0;
  const totalImpressions = coreRows.reduce((sum, { core }) => sum + core.impressions, 0);
  const totalPurchases = coreRows.reduce((sum, { core }) => sum + core.purchases, 0);
  const accountAverageConversionRate =
    totalImpressions > 0 ? (totalPurchases / totalImpressions) * 100 : 0;

  const safePctDelta = (value: number, baseline: number, inverse = false): number => {
    if (!(baseline > 0)) return 0;
    const delta = ((value - baseline) / baseline) * 100;
    return Number((inverse ? -delta : delta).toFixed(3));
  };

  const rows = coreRows.map(({ row, core, history }) => ({
    creativeId: row.creativeId,
    name: row.name,
    creativeFormat: row.creativeFormat ?? "image",
    creativeAgeDays: Number(row.creativeAgeDays.toFixed(2)),
    spendVelocity: Number(row.spendVelocity.toFixed(4)),
    frequency: Number(row.frequency.toFixed(4)),
    spend: Number(row.spend.toFixed(2)),
    roas: Number(row.roas.toFixed(4)),
    cpa: Number(row.cpa.toFixed(4)),
    ctr: Number(row.ctr.toFixed(4)),
    purchases: row.purchases,
    purchaseValue: Number(row.purchaseValue.toFixed(2)),
    coreSpend: Number(core.spend.toFixed(2)),
    coreRoas: Number(core.roas.toFixed(4)),
    coreCpa: Number(core.cpa.toFixed(4)),
    coreCtr: Number(core.ctr.toFixed(4)),
    corePurchases: Number(core.purchases.toFixed(2)),
    spendSharePct: totalSpend > 0 ? Number(((core.spend / totalSpend) * 100).toFixed(3)) : 0,
    spendVsMedian: spendMedian > 0 ? Number((core.spend / spendMedian).toFixed(3)) : 0,
    roasDeltaVsAccountPct: safePctDelta(core.roas, accountAverageRoas, false),
    cpaDeltaVsAccountPct: safePctDelta(core.cpa, accountAverageCpa, true),
    ctrDeltaVsAccountPct: safePctDelta(core.ctr, accountAverageCTR, false),
    conversionRatePct: core.impressions > 0 ? Number(((core.purchases / core.impressions) * 100).toFixed(6)) : 0,
    conversionDeltaVsAccountPct:
      core.impressions > 0
        ? safePctDelta((core.purchases / core.impressions) * 100, accountAverageConversionRate, false)
        : 0,
    cpm: Number(row.cpm.toFixed(4)),
    cpc: Number(row.cpc.toFixed(4)),
    impressions: row.impressions,
    linkClicks: row.linkClicks,
    hookRate: Number(row.hookRate.toFixed(4)),
    holdRate: Number(row.holdRate.toFixed(4)),
    video25Rate: Number(row.video25Rate.toFixed(4)),
    watchRate: Number(row.watchRate.toFixed(4)),
    video75Rate: Number(row.video75Rate.toFixed(4)),
    clickToPurchaseRate: Number(row.clickToPurchaseRate.toFixed(4)),
    atcToPurchaseRate: Number(row.atcToPurchaseRate.toFixed(4)),
    historicalSupport: {
      totalWindows: history.total,
      strongWindows: history.strongCount,
      weakWindows: history.weakCount,
      baselineRoas: Number(history.baselineRoas.toFixed(4)),
      selectedVsBaselineDeltaPct: Number((history.selectedVsBaselineDelta * 100).toFixed(2)),
      seasonalSpike: history.seasonalSpike,
      fatigueSignal: history.fatigueSignal,
    },
  }));

  return JSON.stringify({
    businessId: input.businessId,
    currency: input.currency,
    accountContext: {
      creativeCount: safeCreatives.length,
      totalSpend: Number(totalSpend.toFixed(2)),
      spendMedian: Number(spendMedian.toFixed(2)),
      spendP25: Number(spendP25.toFixed(2)),
      spendP75: Number(spendP75.toFixed(2)),
      accountAverageRoas: Number(accountAverageRoas.toFixed(4)),
      accountAverageCpa: Number(accountAverageCpa.toFixed(4)),
      accountAverageCTR: Number(accountAverageCTR.toFixed(4)),
      accountAverageConversionRate: Number(accountAverageConversionRate.toFixed(6)),
      roasMedian: Number(roasMedian.toFixed(4)),
    },
    creatives: rows,
    instructions:
      "Classify every creativeId exactly once. Treat coreSpend/coreRoas/coreCpa/coreCtr/corePurchases as the primary weighted verdict built from recent-to-historical windows. Treat spend/roas/cpa/ctr/purchases as selected-range overlay only. Do not let a short selected-range spike fully override weak history, and do not let a short selected-range drop fully erase a historically proven winner. Focus on commercial materiality: avoid aggressive stop decisions on tiny-spend rows unless downside evidence is strong and meaningful.",
  });
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (sorted.length - 1) * p;
  const low = Math.floor(idx);
  const high = Math.ceil(idx);
  if (low === high) return sorted[low];
  const weight = idx - low;
  return sorted[low] * (1 - weight) + sorted[high] * weight;
}

function sanitizeInputRows(rows: CreativeDecisionInputRow[]): CreativeDecisionInputRow[] {
  const sanitizeHistoricalWindow = (
    window: CreativeDecisionHistoricalWindow | null | undefined
  ): CreativeDecisionHistoricalWindow | null => {
    if (!window) return null;
    return {
      spend: Number.isFinite(window.spend) ? window.spend : 0,
      purchaseValue: Number.isFinite(window.purchaseValue) ? window.purchaseValue : 0,
      roas: Number.isFinite(window.roas) ? window.roas : 0,
      cpa: Number.isFinite(window.cpa) ? window.cpa : 0,
      ctr: Number.isFinite(window.ctr) ? window.ctr : 0,
      purchases: Number.isFinite(window.purchases) ? window.purchases : 0,
      impressions: Number.isFinite(window.impressions) ? window.impressions : 0,
      linkClicks: Number.isFinite(window.linkClicks) ? window.linkClicks : 0,
      hookRate: Number.isFinite(window.hookRate) ? window.hookRate : 0,
      holdRate: Number.isFinite(window.holdRate) ? window.holdRate : 0,
      video25Rate: Number.isFinite(window.video25Rate) ? window.video25Rate : 0,
      watchRate: Number.isFinite(window.watchRate) ? window.watchRate : 0,
      video75Rate: Number.isFinite(window.video75Rate) ? window.video75Rate : 0,
      clickToPurchaseRate: Number.isFinite(window.clickToPurchaseRate) ? window.clickToPurchaseRate : 0,
      atcToPurchaseRate: Number.isFinite(window.atcToPurchaseRate) ? window.atcToPurchaseRate : 0,
    };
  };

  return rows.map((row) => ({
    ...row,
    creativeFormat: row.creativeFormat ?? "image",
    creativeAgeDays: Number.isFinite(row.creativeAgeDays) ? row.creativeAgeDays : 0,
    spendVelocity: Number.isFinite(row.spendVelocity) ? row.spendVelocity : 0,
    frequency: Number.isFinite(row.frequency) ? row.frequency : 0,
    spend: Number.isFinite(row.spend) ? row.spend : 0,
    purchaseValue: Number.isFinite(row.purchaseValue) ? row.purchaseValue : 0,
    roas: Number.isFinite(row.roas) ? row.roas : 0,
    cpa: Number.isFinite(row.cpa) ? row.cpa : 0,
    ctr: Number.isFinite(row.ctr) ? row.ctr : 0,
    cpm: Number.isFinite(row.cpm) ? row.cpm : 0,
    cpc: Number.isFinite(row.cpc) ? row.cpc : 0,
    purchases: Number.isFinite(row.purchases) ? row.purchases : 0,
    impressions: Number.isFinite(row.impressions) ? row.impressions : 0,
    linkClicks: Number.isFinite(row.linkClicks) ? row.linkClicks : 0,
    hookRate: Number.isFinite(row.hookRate) ? row.hookRate : 0,
    holdRate: Number.isFinite(row.holdRate) ? row.holdRate : 0,
    video25Rate: Number.isFinite(row.video25Rate) ? row.video25Rate : 0,
    watchRate: Number.isFinite(row.watchRate) ? row.watchRate : 0,
    video75Rate: Number.isFinite(row.video75Rate) ? row.video75Rate : 0,
    clickToPurchaseRate: Number.isFinite(row.clickToPurchaseRate) ? row.clickToPurchaseRate : 0,
    atcToPurchaseRate: Number.isFinite(row.atcToPurchaseRate) ? row.atcToPurchaseRate : 0,
    historicalWindows: row.historicalWindows
      ? {
          last3: sanitizeHistoricalWindow(row.historicalWindows.last3),
          last7: sanitizeHistoricalWindow(row.historicalWindows.last7),
          last14: sanitizeHistoricalWindow(row.historicalWindows.last14),
          last30: sanitizeHistoricalWindow(row.historicalWindows.last30),
          last90: sanitizeHistoricalWindow(row.historicalWindows.last90),
          allHistory: sanitizeHistoricalWindow(row.historicalWindows.allHistory),
        }
      : null,
  }));
}

function getHistoricalWindows(row: CreativeDecisionInputRow) {
  return [
    row.historicalWindows?.last3,
    row.historicalWindows?.last7,
    row.historicalWindows?.last14,
    row.historicalWindows?.last30,
    row.historicalWindows?.last90,
    row.historicalWindows?.allHistory,
  ].filter((window): window is CreativeDecisionHistoricalWindow => Boolean(window));
}

function historicalSupportSummary(row: CreativeDecisionInputRow, roasAvg: number, cpaAvg: number) {
  const windows = getHistoricalWindows(row);
  if (windows.length === 0) {
    return {
      total: 0,
      strongCount: 0,
      weakCount: 0,
      baselineRoas: 0,
      baselineCtr: 0,
      selectedVsBaselineDelta: 0,
      seasonalSpike: false,
      fatigueSignal: false,
    };
  }

  const baselineRoas = windows.reduce((sum, window) => sum + window.roas, 0) / windows.length;
  const baselineCtr = windows.reduce((sum, window) => sum + window.ctr, 0) / windows.length;
  const strongCount = windows.filter(
    (window) =>
      window.roas >= Math.max(roasAvg * 1.05, 0.1) &&
      (window.purchases >= 2 || window.spend >= Math.max(row.spend * 0.35, 1))
  ).length;
  const weakCount = windows.filter(
    (window) =>
      window.roas > 0 &&
      window.roas <= Math.max(roasAvg * 0.8, 0.1) &&
      (cpaAvg <= 0 || window.cpa >= cpaAvg * 1.1 || window.purchases <= 1)
  ).length;
  const selectedVsBaselineDelta = baselineRoas > 0 ? (row.roas - baselineRoas) / baselineRoas : 0;

  return {
    total: windows.length,
    strongCount,
    weakCount,
    baselineRoas,
    baselineCtr,
    selectedVsBaselineDelta,
    seasonalSpike: baselineRoas > 0 && row.roas >= baselineRoas * 1.45 && row.purchases <= Math.max(2, windows[0]?.purchases ?? 0),
    fatigueSignal: baselineRoas > 0 && row.roas <= baselineRoas * 0.72 && strongCount >= 2,
  };
}

type WeightedCreativeSnapshot = {
  spend: number;
  purchaseValue: number;
  roas: number;
  cpa: number;
  ctr: number;
  purchases: number;
  impressions: number;
  linkClicks: number;
  hookRate: number;
  holdRate: number;
  video25Rate: number;
  watchRate: number;
  video75Rate: number;
  clickToPurchaseRate: number;
  atcToPurchaseRate: number;
  selectedInfluence: number;
};

function buildWeightedCreativeSnapshot(row: CreativeDecisionInputRow): WeightedCreativeSnapshot {
  const windows: Array<{ weight: number; value: CreativeDecisionHistoricalWindow }> = [];
  const pushWindow = (weight: number, value: CreativeDecisionHistoricalWindow | null | undefined) => {
    if (!value) return;
    windows.push({ weight, value });
  };

  pushWindow(0.18, {
    spend: row.spend,
    purchaseValue: row.purchaseValue,
    roas: row.roas,
    cpa: row.cpa,
    ctr: row.ctr,
    purchases: row.purchases,
    impressions: row.impressions,
    linkClicks: row.linkClicks,
    hookRate: row.hookRate,
    holdRate: row.holdRate,
    video25Rate: row.video25Rate,
    watchRate: row.watchRate,
    video75Rate: row.video75Rate,
    clickToPurchaseRate: row.clickToPurchaseRate,
    atcToPurchaseRate: row.atcToPurchaseRate,
  });
  pushWindow(0.24, row.historicalWindows?.last3);
  pushWindow(0.22, row.historicalWindows?.last7);
  pushWindow(0.18, row.historicalWindows?.last14);
  pushWindow(0.1, row.historicalWindows?.last30);
  pushWindow(0.05, row.historicalWindows?.last90);
  pushWindow(0.03, row.historicalWindows?.allHistory);

  if (windows.length === 0) {
    return {
      spend: row.spend,
      purchaseValue: row.purchaseValue,
      roas: row.roas,
      cpa: row.cpa,
      ctr: row.ctr,
      purchases: row.purchases,
      impressions: row.impressions,
      linkClicks: row.linkClicks,
      hookRate: row.hookRate,
      holdRate: row.holdRate,
      video25Rate: row.video25Rate,
      watchRate: row.watchRate,
      video75Rate: row.video75Rate,
      clickToPurchaseRate: row.clickToPurchaseRate,
      atcToPurchaseRate: row.atcToPurchaseRate,
      selectedInfluence: 1,
    };
  }

  const totalWeight = windows.reduce((sum, item) => sum + item.weight, 0);
  const weighted = <K extends keyof CreativeDecisionHistoricalWindow>(key: K) =>
    windows.reduce((sum, item) => sum + item.value[key] * item.weight, 0) / totalWeight;

  return {
    spend: weighted("spend"),
    purchaseValue: weighted("purchaseValue"),
    roas: weighted("roas"),
    cpa: weighted("cpa"),
    ctr: weighted("ctr"),
    purchases: weighted("purchases"),
    impressions: weighted("impressions"),
    linkClicks: weighted("linkClicks"),
    hookRate: weighted("hookRate"),
    holdRate: weighted("holdRate"),
    video25Rate: weighted("video25Rate"),
    watchRate: weighted("watchRate"),
    video75Rate: weighted("video75Rate"),
    clickToPurchaseRate: weighted("clickToPurchaseRate"),
    atcToPurchaseRate: weighted("atcToPurchaseRate"),
    selectedInfluence: totalWeight > 0 ? 0.18 / totalWeight : 1,
  };
}

function deriveLifecycleState(input: {
  action: CreativeDecisionAction;
  confidence: number;
  historicalStrongCount: number;
  fatigueSignal: boolean;
  selectedVsCoreDelta: number;
}): CreativeLifecycleState {
  if (input.action === "scale_hard") {
    return input.historicalStrongCount >= 2 ? "stable_winner" : "emerging_winner";
  }
  if (input.action === "scale") {
    return input.historicalStrongCount >= 3 || input.confidence >= 0.74
      ? "stable_winner"
      : "emerging_winner";
  }
  if (input.action === "test_more") {
    return "test_only";
  }
  if (input.action === "kill") {
    return "blocked";
  }
  if (input.action === "pause") {
    return input.fatigueSignal || input.historicalStrongCount >= 2
      ? "fatigued_winner"
      : "blocked";
  }
  return input.fatigueSignal || (input.historicalStrongCount >= 2 && input.selectedVsCoreDelta < -0.15)
    ? "fatigued_winner"
    : "volatile";
}

export function buildHeuristicCreativeDecisions(
  rows: CreativeDecisionInputRow[]
): CreativeDecisionResult[] {
  if (rows.length === 0) return [];
  const safeRows = sanitizeInputRows(rows);
  const payload = buildCreativeDecisionOs({
    businessId: "compatibility",
    startDate: "1970-01-01",
    endDate: "1970-01-01",
    rows: safeRows.map((row) => ({
      creativeId: row.creativeId,
      name: row.name,
      creativeFormat: row.creativeFormat ?? "image",
      creativeAgeDays: row.creativeAgeDays,
      spendVelocity: row.spendVelocity,
      frequency: row.frequency,
      spend: row.spend,
      purchaseValue: row.purchaseValue,
      roas: row.roas,
      cpa: row.cpa,
      ctr: row.ctr,
      cpm: row.cpm,
      cpc: row.cpc,
      purchases: row.purchases,
      impressions: row.impressions,
      linkClicks: row.linkClicks,
      hookRate: row.hookRate,
      holdRate: row.holdRate,
      video25Rate: row.video25Rate,
      watchRate: row.watchRate,
      video75Rate: row.video75Rate,
      clickToPurchaseRate: row.clickToPurchaseRate,
      atcToPurchaseRate: row.atcToPurchaseRate,
      copyText: row.copyText ?? null,
      copyVariants: row.copyVariants ?? [],
      headlineVariants: row.headlineVariants ?? [],
      descriptionVariants: row.descriptionVariants ?? [],
      objectStoryId: row.objectStoryId ?? null,
      effectiveObjectStoryId: row.effectiveObjectStoryId ?? null,
      postId: row.postId ?? null,
      accountId: row.accountId ?? null,
      accountName: row.accountName ?? null,
      campaignId: row.campaignId ?? null,
      campaignName: row.campaignName ?? null,
      adSetId: row.adSetId ?? null,
      adSetName: row.adSetName ?? null,
      taxonomyPrimaryLabel: row.taxonomyPrimaryLabel ?? null,
      taxonomySecondaryLabel: row.taxonomySecondaryLabel ?? null,
      taxonomyVisualFormat: row.taxonomyVisualFormat ?? null,
      aiTags: row.aiTags ?? {},
      historicalWindows: row.historicalWindows ?? null,
    })),
  });
  return mapCreativeDecisionOsToLegacyDecisions(payload);
}

function applyDecisionGuardrails(
  rows: CreativeDecisionInputRow[],
  decisions: CreativeDecisionResult[]
): CreativeDecisionResult[] {
  if (rows.length === 0 || decisions.length === 0) return decisions;

  const roasValues = rows
    .map((r) => r.roas)
    .filter((v) => Number.isFinite(v) && v >= 0)
    .sort((a, b) => a - b);
  const cpaValues = rows
    .map((r) => r.cpa)
    .filter((v) => Number.isFinite(v) && v > 0)
    .sort((a, b) => a - b);
  const spendValues = rows
    .map((r) => r.spend)
    .filter((v) => Number.isFinite(v) && v > 0)
    .sort((a, b) => a - b);

  const weightedRoas = computeWeightedRoas(rows);
  const roasAvg =
    weightedRoas > 0
      ? weightedRoas
      : roasValues.length > 0
        ? roasValues.reduce((a, b) => a + b, 0) / roasValues.length
        : 0;
  const weightedCpa = computeWeightedCpa(rows);
  const cpaAvg = weightedCpa > 0 ? weightedCpa : cpaValues.length > 0 ? cpaValues.reduce((a, b) => a + b, 0) / cpaValues.length : 0;
  const spendP60 = percentile(spendValues, 0.6);
  const spendP75 = percentile(spendValues, 0.75);
  const spendP35 = percentile(spendValues, 0.35);

  const rowById = new Map(rows.map((row) => [row.creativeId, row]));

  return decisions.map((decision) => {
    const row = rowById.get(decision.creativeId);
    if (!row) return decision;

    const highSpend = row.spend >= Math.max(1, spendP60);
    const veryHighSpend = row.spend >= Math.max(1, spendP75);
    const weakRoas = roasAvg > 0 && row.roas <= roasAvg * 0.65;
    const weakCpa = cpaAvg > 0 && row.cpa >= cpaAvg * 1.45;
    const lowConv = row.purchases <= 1;

    // Guardrail: prevent high-spend underperformers from staying on WATCH.
    if ((decision.action === "watch" || decision.action === "test_more") && highSpend && weakRoas && (weakCpa || !lowConv)) {
      return {
        ...decision,
        action: "pause",
        lifecycleState: "blocked",
        score: Math.min(decision.score, veryHighSpend ? 36 : 42),
        confidence: Math.max(decision.confidence, veryHighSpend ? 0.82 : 0.74),
        scoringFactors: [
          `High spend pressure: ${row.spend.toFixed(2)} (>= p60 ${spendP60.toFixed(2)}).`,
          `ROAS ${row.roas.toFixed(2)} is weak vs avg ${roasAvg.toFixed(2)}.`,
          weakCpa
            ? `CPA ${row.cpa.toFixed(2)} is above avg ${cpaAvg.toFixed(2)}.`
            : "Conversion output is weak for current spend.",
        ],
        reasons: [
          "Spend is high relative to this account while ROAS is significantly below average.",
          weakCpa
            ? "CPA is materially above account baseline, indicating inefficient spend."
            : "Conversion output is too weak for the current spend level.",
        ],
        nextStep: "Pause this creative and shift budget to stronger variants.",
      };
    }

    // Guardrail: avoid false SCALE when economics are clearly poor.
    if ((decision.action === "scale" || decision.action === "scale_hard") && weakRoas && weakCpa) {
      return {
        ...decision,
        action: "watch",
        lifecycleState: "volatile",
        score: Math.min(decision.score, 58),
        confidence: Math.min(decision.confidence, 0.56),
        scoringFactors: [
          `ROAS ${row.roas.toFixed(2)} underperforms avg ${roasAvg.toFixed(2)}.`,
          `CPA ${row.cpa.toFixed(2)} exceeds avg ${cpaAvg.toFixed(2)}.`,
          "Scale confidence reduced until efficiency recovers.",
        ],
        reasons: [
          "Efficiency signals are weaker than account baseline.",
          "Hold budget increase until ROAS/CPA stabilizes.",
        ],
        nextStep: "Keep budget flat and reassess after more reliable performance.",
      };
    }

    return decision;
  });
}

export async function generateCreativeDecisions(
  input: GenerateCreativeDecisionsInput
): Promise<CreativeDecisionResult[]> {
  const creatives = sanitizeInputRows(input.creatives).slice(0, 220);

  const openai = getOpenAI();
  const byCreativeId = new Map<string, CreativeDecisionResult>();
  const batchErrors: string[] = [];

  const requestBatch = async (
    batchRows: CreativeDecisionInputRow[],
    maxTokens: number
  ): Promise<{ decisions: CreativeDecisionResult[]; error: string | null }> => {
    try {
      const response = await openai.chat.completions.create({
        model: AI_MODEL,
        temperature: 0.1,
        max_tokens: maxTokens,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: buildUserPrompt({
              ...input,
              creatives: batchRows,
            }),
          },
        ],
      });

      const choice = response.choices[0];
      const content = choice?.message?.content ?? null;
      if (!content) {
        return { decisions: [], error: "empty response" };
      }

      let parsed: ParsedAiDecisionPayload;
      try {
        parsed = JSON.parse(content) as ParsedAiDecisionPayload;
      } catch {
        return { decisions: [], error: "invalid JSON" };
      }

      if (!parsed || !Array.isArray(parsed.decisions)) {
        return { decisions: [], error: "schema mismatch" };
      }

      const allowedIds = new Set(batchRows.map((row) => row.creativeId));
      const decisions: CreativeDecisionResult[] = [];
      for (const item of parsed.decisions) {
        const creativeId = typeof item.creativeId === "string" ? item.creativeId : "";
        const action = normalizeAction(item.action) ?? normalizeAction(item.classification);
        if (!creativeId || !action || !allowedIds.has(creativeId)) continue;

        const mappedConfidence =
          mapConfidenceToNumber(item.confidence) ??
          mapConfidenceToNumber(item.confidenceLevel) ??
          0.5;
        const analysisText = typeof item.analysis === "string" ? item.analysis.trim() : "";
        const reasonsFromAnalysis = analysisText.length > 0 ? [analysisText] : [];
        const reasons = sanitizeReasonList(item.reasons);
        const score =
          typeof item.score === "number" && Number.isFinite(item.score)
            ? Math.round(clamp(item.score, 0, 100))
            : action === "scale_hard"
              ? 88
              : action === "scale"
                ? 74
                : action === "watch"
                  ? 58
                  : action === "test_more"
                    ? 52
                    : action === "pause"
                      ? 38
                      : 24;
        const reasonsForOutput = reasons.length > 0 ? reasons : reasonsFromAnalysis;
        const scoringFactors =
          reasonsForOutput.length > 0
            ? reasonsForOutput.slice(0, 4)
            : ["Score derived from normalized action and confidence."];

        decisions.push({
          creativeId,
          action,
          lifecycleState:
            action === "scale_hard"
              ? "stable_winner"
              : action === "scale"
                ? "emerging_winner"
                : action === "test_more"
                  ? "test_only"
                  : action === "pause"
                    ? "fatigued_winner"
                    : action === "kill"
                      ? "blocked"
                      : "volatile",
          score,
          confidence: mappedConfidence,
          scoringFactors,
          reasons: reasonsForOutput,
          nextStep:
            typeof item.nextStep === "string" && item.nextStep.trim().length > 0
              ? item.nextStep.trim()
              : "Monitor next 3 days before changing budget.",
        });
      }

      if (choice?.finish_reason === "length" && decisions.length < batchRows.length) {
        return { decisions, error: "response truncated by max tokens" };
      }

      return { decisions, error: null };
    } catch (error) {
      const message =
        error instanceof Error && error.message.trim().length > 0
          ? error.message.trim()
          : "request failed";
      return { decisions: [], error: message };
    }
  };

  for (let index = 0; index < creatives.length; index += CREATIVE_DECISION_BATCH_SIZE) {
    const batch = creatives.slice(index, index + CREATIVE_DECISION_BATCH_SIZE);
    const batchNumber = Math.floor(index / CREATIVE_DECISION_BATCH_SIZE) + 1;
    const initial = await requestBatch(batch, CREATIVE_DECISION_MAX_TOKENS);
    for (const decision of initial.decisions) {
      byCreativeId.set(decision.creativeId, decision);
    }

    const missingIds = batch
      .map((row) => row.creativeId)
      .filter((creativeId) => !byCreativeId.has(creativeId));

    if (initial.error) {
      batchErrors.push(`batch ${batchNumber}: ${initial.error}`);
    }

    if (missingIds.length > 0) {
      const missingRows = batch.filter((row) => missingIds.includes(row.creativeId));
      const retryChunks = chunkRows(missingRows, CREATIVE_DECISION_RETRY_BATCH_SIZE);
      for (let retryIndex = 0; retryIndex < retryChunks.length; retryIndex += 1) {
        const retryBatch = retryChunks[retryIndex];
        const retried = await requestBatch(retryBatch, CREATIVE_DECISION_RETRY_MAX_TOKENS);
        for (const decision of retried.decisions) {
          byCreativeId.set(decision.creativeId, decision);
        }

        const retryMissingCount = retryBatch.filter((row) => !byCreativeId.has(row.creativeId)).length;
        if (retried.error || retryMissingCount > 0) {
          batchErrors.push(
            `batch ${batchNumber} retry ${retryIndex + 1}: ${retried.error ?? `${retryMissingCount} missing decision(s)`}`
          );
        }
      }
    }
  }

  // Final repair pass: ask only for missing IDs before falling back to heuristics upstream.
  const missingAfterPass = creatives.filter((row) => !byCreativeId.has(row.creativeId));
  if (missingAfterPass.length > 0) {
    for (let attempt = 1; attempt <= CREATIVE_DECISION_REPAIR_ATTEMPTS; attempt += 1) {
      let remaining = creatives.filter((row) => !byCreativeId.has(row.creativeId));
      if (remaining.length === 0) break;
      const currentChunks = chunkRows(remaining, CREATIVE_DECISION_REPAIR_BATCH_SIZE);
      for (let chunkIndex = 0; chunkIndex < currentChunks.length; chunkIndex += 1) {
        const chunk = currentChunks[chunkIndex];
        const repaired = await requestBatch(chunk, CREATIVE_DECISION_RETRY_MAX_TOKENS);
        for (const decision of repaired.decisions) {
          byCreativeId.set(decision.creativeId, decision);
        }
        const stillMissing = chunk.filter((row) => !byCreativeId.has(row.creativeId)).length;
        if (repaired.error || stillMissing > 0) {
          batchErrors.push(
            `repair attempt ${attempt} chunk ${chunkIndex + 1}: ${repaired.error ?? `${stillMissing} missing decision(s)`}`
          );
        }
      }
      remaining = creatives.filter((row) => !byCreativeId.has(row.creativeId));
      if (remaining.length === 0) break;
    }
  }

  if (byCreativeId.size === 0) {
    const reason = batchErrors.length > 0 ? batchErrors.join(" | ") : "no usable decisions";
    throw new Error(`All creative decision batches failed: ${reason}`);
  }

  const raw = creatives
    .map((row) => byCreativeId.get(row.creativeId))
    .filter((item): item is CreativeDecisionResult => Boolean(item));

  return raw;
}
