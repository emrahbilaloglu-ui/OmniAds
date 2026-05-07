import type { MetaCampaignRow } from "@/app/api/meta/campaigns/route";
import type { MetaAdSetData } from "@/lib/api/meta";
import {
  historicalBidCandidates,
  type MetaRecommendation,
  type MetaRecommendationConfidence,
  type MetaRecommendationTimeframeContext,
  type MetaRecommendationWindows,
} from "@/lib/meta/recommendations";

type NumericBand = { low: number; mid: number; high: number };

export interface MetaAdsetDecisionAccountContext {
  accountMedianRoas: number;
  accountP10Roas: number;
  accountP75Cpa: number;
  accountMedianCpm: number;
  selectedRangeDays: number;
  currency: string | null;
  historicalBidBand?: NumericBand | null;
  audienceRoasByLabel?: Record<string, number>;
}

export interface MetaAdsetDecisionWindow {
  adset: MetaAdSetData;
  parentCampaign: MetaCampaignRow | null;
  previousAdset?: MetaAdSetData | null;
}

export interface MetaCampaignFamilyWindow {
  campaign: MetaCampaignRow | null;
  adsets: MetaAdSetData[];
  accountContext: MetaAdsetDecisionAccountContext;
}

const CONFIDENCE_SCORE: Record<MetaRecommendationConfidence, number> = {
  high: 0.8,
  medium: 0.62,
  low: 0.38,
};

function n(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function positive(value: number | null | undefined) {
  const numeric = n(value);
  return numeric != null && numeric > 0 ? numeric : null;
}

function r2(value: number) {
  return Math.round(value * 100) / 100;
}

function pct(value: number) {
  return `${Math.round(value * 100)}%`;
}

function fmtRoas(value: number) {
  return `${value.toFixed(2)}x`;
}

function fmtCurrency(value: number, currency: string | null) {
  return currency ? `${currency} ${value.toFixed(2)}` : value.toFixed(2);
}

function parentScope(window: MetaAdsetDecisionWindow) {
  const parent = window.parentCampaign;
  if (!parent) return null;
  return {
    campaignId: parent.id,
    campaignName: parent.name,
    parentCampaignId: parent.id,
    parentCampaignName: parent.name,
  };
}

function isActiveAdset(adset: MetaAdSetData) {
  return adset.status.toUpperCase() === "ACTIVE";
}

function isLearningPhase(adset: MetaAdSetData) {
  return adset.status.toUpperCase().includes("LEARNING");
}

function confidenceFor(input: {
  conversions: number | null;
  supportingSignals?: boolean;
  missingRequired?: boolean;
}) {
  if (input.missingRequired) return "low" as const;
  if ((input.conversions ?? 0) >= 30) return "high" as const;
  if (input.supportingSignals) return "medium" as const;
  return "low" as const;
}

function decisionStateFor(confidence: MetaRecommendationConfidence) {
  if (confidence === "high") return "act" as const;
  if (confidence === "medium") return "test" as const;
  return "watch" as const;
}

function adsetTimeframe(
  coreVerdict: string,
  selectedRangeOverlay: string,
  historicalSupport: string,
  note: string | null = null,
): MetaRecommendationTimeframeContext {
  return {
    coreVerdict,
    selectedRangeOverlay,
    historicalSupport,
    seasonalityFlag: "none",
    note,
  };
}

function resolveCurrency(window: MetaAdsetDecisionWindow, context: MetaAdsetDecisionAccountContext) {
  return window.adset.currency ?? window.parentCampaign?.currency ?? context.currency ?? null;
}

function currentCurrencyBidValue(adset: MetaAdSetData) {
  if (positive(adset.manualBidAmount) != null) return positive(adset.manualBidAmount);
  if (adset.bidValueFormat === "currency") return positive(adset.bidValue);
  return null;
}

function isBidConstrained(adset: MetaAdSetData) {
  const raw = `${adset.bidStrategyType ?? ""} ${adset.bidStrategyLabel ?? ""}`.toLowerCase();
  return (
    raw.includes("bid_cap") ||
    raw.includes("bid cap") ||
    raw.includes("cost_cap") ||
    raw.includes("cost cap") ||
    raw.includes("manual") ||
    currentCurrencyBidValue(adset) != null
  );
}

function bidBandFromCandidates(candidates: number[]) {
  const values = candidates
    .map((value) => Math.round(value))
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b);
  if (values.length === 0) return null;
  const low = values[0];
  const high = values[values.length - 1];
  const mid = values[Math.floor(values.length / 2)];
  return { low, mid, high };
}

function fallbackBidBand(currentBid: number) {
  const low = Math.max(1, Math.round(currentBid * 0.85));
  const high = Math.max(low, Math.round(currentBid * 1.15));
  return { low, mid: Math.round(currentBid), high };
}

function clamp(value: number, low: number, high: number) {
  return Math.min(Math.max(value, low), high);
}

function rangeWindowDays(context: MetaAdsetDecisionAccountContext) {
  return Math.max(1, Math.round(context.selectedRangeDays || 1));
}

function deriveDailyTargetImpressions(adset: MetaAdSetData, context: MetaAdsetDecisionAccountContext) {
  const explicit = positive(adset.dailyTargetImpressions);
  if (explicit != null) return explicit;
  const budget = positive(adset.dailyBudget);
  const cpm = positive(adset.cpm);
  if (budget == null || cpm == null) return null;
  return (budget / 100 / cpm) * 1000 * rangeWindowDays(context);
}

function resolveWinRate(adset: MetaAdSetData, context: MetaAdsetDecisionAccountContext) {
  const explicit = n(adset.winRate);
  if (explicit != null) return explicit;
  const targetImpressions = deriveDailyTargetImpressions(adset, context);
  const impressions = n(adset.impressions);
  if (targetImpressions == null || targetImpressions <= 0 || impressions == null) return null;
  return Math.max(0, Math.min(1.2, impressions / targetImpressions));
}

function resolveAgeDays(adset: MetaAdSetData, context: MetaAdsetDecisionAccountContext) {
  return positive(adset.ageDays) ?? rangeWindowDays(context);
}

function normalizeAudienceLabel(label: string) {
  const text = label.toLowerCase();
  if (text.includes("retarget") || text.includes("remarket") || text.includes("visitor") || text.includes("cart")) {
    return "retargeting";
  }
  if (text.includes("lal") || text.includes("lookalike")) {
    if (text.includes("1%") || text.includes("1pct") || text.includes("1 pct")) return "lookalike_1";
    if (text.includes("3%") || text.includes("3pct") || text.includes("3 pct")) return "lookalike_3";
    return "lookalike";
  }
  if (text.includes("broad") || text.includes("wide") || text.includes("open") || text.includes("advantage")) {
    return "broad";
  }
  if (text.includes("interest")) return "interest";
  if (text.includes("custom")) return "custom";
  return "unknown";
}

function audienceLabel(adset: MetaAdSetData) {
  return normalizeAudienceLabel(adset.audienceLabel ?? adset.name);
}

function displayAudienceLabel(label: string) {
  const labels: Record<string, string> = {
    broad: "Broad",
    lookalike: "Lookalike",
    lookalike_1: "LAL 1%",
    lookalike_3: "LAL 3%",
    retargeting: "Retargeting",
    interest: "Interest",
    custom: "Custom",
    unknown: "Unknown audience",
  };
  return labels[label] ?? label;
}

function peerAudienceSwap(current: string, context: MetaAdsetDecisionAccountContext) {
  const currentScore = context.audienceRoasByLabel?.[current] ?? 0;
  const betterPeer = Object.entries(context.audienceRoasByLabel ?? {})
    .filter(([label, roas]) => label !== current && roas > currentScore)
    .sort((a, b) => b[1] - a[1])[0]?.[0];
  if (betterPeer) return betterPeer;
  const fallback: Record<string, string> = {
    broad: "lookalike_1",
    lookalike_1: "lookalike_3",
    lookalike: "lookalike_3",
    lookalike_3: "broad",
    retargeting: "lookalike_3",
    interest: "broad",
    custom: "broad",
    unknown: "broad",
  };
  return fallback[current] ?? "broad";
}

function broaderAudience(current: string) {
  const fallback: Record<string, string> = {
    lookalike_1: "lookalike_3",
    lookalike: "broad",
    lookalike_3: "broad",
    retargeting: "broad",
    interest: "broad",
    custom: "broad",
    unknown: "broad",
    broad: "broad",
  };
  return fallback[current] ?? "broad";
}

function normalizedEvent(event: string | null | undefined) {
  return (event ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "_");
}

function proposedUpperFunnelEvent(current: string | null | undefined) {
  const event = normalizedEvent(current);
  if (event.includes("purchase") || event.includes("value")) return "Add To Cart";
  if (event.includes("checkout")) return "Add To Cart";
  return null;
}

function percentile(values: number[], p: number) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return sorted[index];
}

function median(values: number[]) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

export function buildMetaAdsetDecisionAccountContext(input: {
  adsets: MetaAdSetData[];
  selectedCampaigns: MetaCampaignRow[];
  windows?: MetaRecommendationWindows | null;
  selectedRangeDays: number;
}): MetaAdsetDecisionAccountContext {
  const activeRows = input.adsets.filter((adset) => isActiveAdset(adset) && positive(adset.spend) != null);
  const roasValues = activeRows.map((adset) => n(adset.roas)).filter((value): value is number => value != null);
  const cpaValues = activeRows
    .map((adset) => positive(adset.cpa))
    .filter((value): value is number => value != null);
  const cpmValues = activeRows
    .map((adset) => positive(adset.cpm))
    .filter((value): value is number => value != null);
  const audienceStats = new Map<string, { spend: number; revenue: number }>();
  for (const adset of activeRows) {
    const label = audienceLabel(adset);
    const current = audienceStats.get(label) ?? { spend: 0, revenue: 0 };
    current.spend += adset.spend;
    current.revenue += adset.revenue;
    audienceStats.set(label, current);
  }

  return {
    accountMedianRoas: median(roasValues),
    accountP10Roas: percentile(roasValues, 0.1),
    accountP75Cpa: percentile(cpaValues, 0.75),
    accountMedianCpm: median(cpmValues),
    selectedRangeDays: Math.max(1, input.selectedRangeDays),
    currency: input.selectedCampaigns.find((campaign) => campaign.currency)?.currency ?? input.adsets.find((adset) => adset.currency)?.currency ?? null,
    historicalBidBand: input.windows ? bidBandFromCandidates(historicalBidCandidates(input.windows)) : null,
    audienceRoasByLabel: Object.fromEntries(
      [...audienceStats.entries()].map(([label, stats]) => [
        label,
        stats.spend > 0 ? stats.revenue / stats.spend : 0,
      ]),
    ),
  };
}

/**
 * Threshold: trigger when delivery win-rate proxy is below 0.50 and ROAS is at
 * least the account median, or when win-rate is above 0.80 and CPA is above
 * account p75. Reasoning: capped adsets can be either too tight to deliver a
 * good ROAS pocket or loose enough to overpay; the proposed bid stays inside
 * the account's historical bid band.
 */
export function maybeAdsetBidCapAdjust(
  adsetWindow: MetaAdsetDecisionWindow,
  accountContext: MetaAdsetDecisionAccountContext,
): MetaRecommendation | null {
  const adset = adsetWindow.adset;
  const scope = parentScope(adsetWindow);
  if (!scope || !isActiveAdset(adset) || isLearningPhase(adset) || !isBidConstrained(adset)) return null;
  const currentBid = currentCurrencyBidValue(adset);
  const winRate = resolveWinRate(adset, accountContext);
  const roas = n(adset.roas);
  const cpa = positive(adset.cpa);
  const medianRoas = positive(accountContext.accountMedianRoas);
  const p75Cpa = positive(accountContext.accountP75Cpa);
  if (currentBid == null || winRate == null || roas == null || medianRoas == null) return null;

  const loosen = winRate < 0.5 && roas >= medianRoas;
  const tighten = p75Cpa != null && winRate > 0.8 && cpa != null && cpa > p75Cpa;
  if (!loosen && !tighten) return null;

  const acceptableRange = accountContext.historicalBidBand ?? fallbackBidBand(currentBid);
  const proposedBid = loosen
    ? clamp(Math.round(currentBid * 1.15), acceptableRange.low, acceptableRange.high)
    : clamp(Math.round(currentBid * 0.9), acceptableRange.low, acceptableRange.high);
  if (proposedBid === currentBid) return null;

  const confidence = confidenceFor({
    conversions: n(adset.purchases),
    supportingSignals: positive(adset.spend) != null && !adset.isBidValueMixed,
    missingRequired: accountContext.historicalBidBand == null,
  });
  const currency = resolveCurrency(adsetWindow, accountContext);
  return {
    id: `adset:${adset.id}:bid_cap_adjust`,
    level: "adset",
    ...scope,
    adsetId: adset.id,
    adsetName: adset.name,
    type: "adset_bid_cap_adjust",
    lens: loosen ? "volume" : "profitability",
    priority: "medium",
    confidence,
    decisionState: decisionStateFor(confidence),
    decision: loosen ? "Loosen this adset bid cap" : "Tighten this adset bid cap",
    title: `${adset.name}: ${loosen ? "bid cap may be limiting delivery" : "bid cap may be overpaying"}`,
    why: loosen
      ? "The adset is under-delivering against its budget-derived impression target while ROAS is still at or above the account median."
      : "The adset is winning delivery but CPA is above the account p75, so a tighter cap is the cleaner first lever.",
    summary: `Delivery win-rate proxy is ${pct(winRate)} with ROAS ${fmtRoas(roas)} and current bid ${fmtCurrency(currentBid / 100, currency)}.`,
    recommendedAction: `Test ${loosen ? "raising" : "lowering"} the bid from ${fmtCurrency(currentBid / 100, currency)} to ${fmtCurrency(proposedBid / 100, currency)} before changing budget.`,
    expectedImpact: loosen
      ? "More delivery from a proven adset without moving outside the historical bid band."
      : "Lower acquisition cost while keeping the adset inside the historical bid band.",
    evidence: [
      { label: "Win-rate proxy", value: pct(winRate), tone: loosen ? "warning" : "positive" },
      { label: "Adset ROAS", value: fmtRoas(roas), tone: roas >= medianRoas ? "positive" : "warning" },
      { label: "Account median ROAS", value: fmtRoas(medianRoas), tone: "neutral" },
      { label: "Bid band", value: `${fmtCurrency(acceptableRange.low / 100, currency)}-${fmtCurrency(acceptableRange.high / 100, currency)}`, tone: "neutral" },
    ],
    timeframeContext: adsetTimeframe(
      "Bid recommendation is capped to the historical bid band.",
      "Selected-range delivery and efficiency pass the bid-adjustment gate.",
      "Historical bid candidates provide the acceptable range.",
    ),
    strategyLayer: "bidding",
    currentBidValue: currentBid,
    proposedBidValue: proposedBid,
    acceptableRange,
    bidCurrency: currency ?? undefined,
  };
}

/**
 * Threshold: trigger when frequency is above 4.0 and 14-day CTR decay is worse
 * than -25%. Reasoning: high frequency plus sharp CTR decay points to audience
 * fatigue, so the safest read-only recommendation is to test a peer audience
 * class that has better account-level ROAS or a broader fallback class.
 */
export function maybeAdsetAudienceSwap(
  adsetWindow: MetaAdsetDecisionWindow,
  accountContext: MetaAdsetDecisionAccountContext,
): MetaRecommendation | null {
  const adset = adsetWindow.adset;
  const scope = parentScope(adsetWindow);
  if (!scope || !isActiveAdset(adset) || isLearningPhase(adset)) return null;
  const frequency = positive(adset.frequency);
  const ctrDecay = n(adset.ctrDecay14d);
  if (frequency == null || ctrDecay == null || frequency <= 4 || ctrDecay >= -0.25) return null;
  const currentLabel = audienceLabel(adset);
  const proposedLabel = peerAudienceSwap(currentLabel, accountContext);
  if (proposedLabel === currentLabel) return null;
  const confidence = confidenceFor({
    conversions: n(adset.purchases),
    supportingSignals: positive(adset.clicks) != null && adset.clicks >= 100,
  });
  return {
    id: `adset:${adset.id}:audience_swap`,
    level: "adset",
    ...scope,
    adsetId: adset.id,
    adsetName: adset.name,
    type: "adset_audience_swap",
    lens: "structure",
    priority: "medium",
    confidence,
    decisionState: decisionStateFor(confidence),
    decision: "Test a peer audience class",
    title: `${adset.name}: audience fatigue is showing up`,
    why: "Frequency is above the fatigue threshold and CTR has decayed sharply versus the previous comparison window.",
    summary: `${displayAudienceLabel(currentLabel)} is running at ${frequency.toFixed(2)} frequency with ${pct(Math.abs(ctrDecay))} CTR decay.`,
    recommendedAction: `Duplicate the adset into ${displayAudienceLabel(proposedLabel)} and keep budget controlled until CTR stabilizes.`,
    expectedImpact: "Cleaner reach and click quality without stacking multiple edits onto the current adset.",
    evidence: [
      { label: "Frequency", value: frequency.toFixed(2), tone: "warning" },
      { label: "CTR decay", value: pct(ctrDecay), tone: "warning" },
      { label: "Current audience", value: displayAudienceLabel(currentLabel), tone: "neutral" },
      { label: "Proposed audience", value: displayAudienceLabel(proposedLabel), tone: "positive" },
    ],
    timeframeContext: adsetTimeframe(
      "Audience swap is gated by frequency and CTR decay.",
      "Selected-range frequency is above the fatigue threshold.",
      "Previous-window CTR supplies the decay signal.",
    ),
    strategyLayer: "structure",
    currentAudienceLabel: displayAudienceLabel(currentLabel),
    proposedAudienceLabel: displayAudienceLabel(proposedLabel),
  };
}

/**
 * Threshold: trigger when ROAS is below account p10, spend is above 200, and
 * the adset is older than 14 days. Reasoning: this is the hard underperformer
 * guardrail; thin or young adsets are excluded to avoid premature pause calls.
 */
export function maybeAdsetPauseUnderperformer(
  adsetWindow: MetaAdsetDecisionWindow,
  accountContext: MetaAdsetDecisionAccountContext,
): MetaRecommendation | null {
  const adset = adsetWindow.adset;
  const scope = parentScope(adsetWindow);
  if (!scope || !isActiveAdset(adset) || isLearningPhase(adset)) return null;
  const roas = n(adset.roas);
  const spend = positive(adset.spend);
  const ageDays = resolveAgeDays(adset, accountContext);
  const p10 = positive(accountContext.accountP10Roas);
  if (roas == null || spend == null || ageDays == null || p10 == null) return null;
  if (!(roas < p10 && spend > 200 && ageDays > 14)) return null;
  const confidence = confidenceFor({
    conversions: n(adset.purchases),
    supportingSignals: positive(adset.cpa) != null && positive(accountContext.accountP75Cpa) != null && adset.cpa > accountContext.accountP75Cpa,
    missingRequired: adset.ageDays == null,
  });
  return {
    id: `adset:${adset.id}:pause_underperformer`,
    level: "adset",
    ...scope,
    adsetId: adset.id,
    adsetName: adset.name,
    type: "adset_pause_underperformer",
    lens: "profitability",
    priority: "high",
    confidence,
    decisionState: decisionStateFor(confidence),
    decision: "Pause this underperforming adset",
    title: `${adset.name}: below account floor with mature spend`,
    why: "The adset is below the account p10 ROAS floor after enough spend and age to avoid a learning-phase false positive.",
    summary: `ROAS is ${fmtRoas(roas)} versus account p10 ${fmtRoas(p10)} after ${fmtCurrency(spend, resolveCurrency(adsetWindow, accountContext))} spend.`,
    recommendedAction: "Pause or materially reduce this adset before moving budget into cleaner adset opportunities.",
    expectedImpact: "Less wasted spend and a cleaner budget pool for stronger adsets.",
    evidence: [
      { label: "Adset ROAS", value: fmtRoas(roas), tone: "warning" },
      { label: "Account p10 ROAS", value: fmtRoas(p10), tone: "neutral" },
      { label: "Spend", value: fmtCurrency(spend, resolveCurrency(adsetWindow, accountContext)), tone: "warning" },
      { label: "Age", value: `${Math.round(ageDays)} days`, tone: "neutral" },
    ],
    timeframeContext: adsetTimeframe(
      "Pause gate requires poor ROAS, mature spend, and enough age.",
      "Selected-range spend is above the action floor.",
      "No high confidence is emitted when age is inferred from the selected range.",
      adset.ageDays == null ? "Adset age was not available, so confidence is capped." : null,
    ),
    strategyLayer: "budget",
  };
}

/**
 * Threshold: inside an ABO campaign family, trigger when one adset ROAS is
 * above family median * 1.3 and another is below median * 0.7. Reasoning:
 * move a small 25% slice from the weakest adset's daily budget into the
 * strongest sibling instead of changing campaign structure.
 */
export function maybeAdsetBudgetShiftWithinCampaign(
  campaignFamilyWindow: MetaCampaignFamilyWindow,
): MetaRecommendation | null {
  const campaign = campaignFamilyWindow.campaign;
  if (!campaign) return null;
  const active = campaignFamilyWindow.adsets.filter((adset) => isActiveAdset(adset) && !isLearningPhase(adset));
  if (active.length < 2) return null;
  const isAboFamily = campaign.budgetLevel === "adset" || active.some((adset) => adset.budgetLevel === "adset");
  if (!isAboFamily) return null;
  const medianRoas = median(active.map((adset) => n(adset.roas)).filter((value): value is number => value != null));
  if (medianRoas <= 0) return null;
  const high = active
    .filter((adset) => n(adset.roas) != null && adset.roas > medianRoas * 1.3 && positive(adset.dailyBudget) != null)
    .sort((a, b) => b.roas - a.roas)[0];
  const low = active
    .filter((adset) => n(adset.roas) != null && adset.roas < medianRoas * 0.7 && positive(adset.dailyBudget) != null)
    .sort((a, b) => a.roas - b.roas)[0];
  if (!high || !low || high.id === low.id) return null;
  const sourceBudget = positive(low.dailyBudget);
  const currentBudget = positive(high.dailyBudget);
  if (sourceBudget == null || currentBudget == null) return null;
  const shiftAmount = Math.max(1, Math.round(sourceBudget * 0.25));
  const proposedBudget = currentBudget + shiftAmount;
  const confidence = confidenceFor({
    conversions: (n(high.purchases) ?? 0) + (n(low.purchases) ?? 0),
    supportingSignals: positive(high.spend) != null && positive(low.spend) != null,
  });
  const currency = high.currency ?? campaign.currency ?? campaignFamilyWindow.accountContext.currency ?? null;
  return {
    id: `adset:${high.id}:budget_shift_within_campaign`,
    level: "adset",
    campaignId: campaign.id,
    campaignName: campaign.name,
    parentCampaignId: campaign.id,
    parentCampaignName: campaign.name,
    adsetId: high.id,
    adsetName: high.name,
    type: "adset_budget_shift_within_campaign",
    lens: "volume",
    priority: "high",
    confidence,
    decisionState: decisionStateFor(confidence),
    decision: "Shift adset budget inside this campaign",
    title: `${campaign.name}: move budget toward the stronger adset`,
    why: "This ABO campaign has a clear sibling split: one adset is materially above family median ROAS while another is materially below it.",
    summary: `${high.name} is at ${fmtRoas(high.roas)} ROAS; ${low.name} is at ${fmtRoas(low.roas)} versus family median ${fmtRoas(medianRoas)}.`,
    recommendedAction: `Move 25% of ${low.name}'s daily budget into ${high.name}.`,
    expectedImpact: "More volume in the best current adset while reducing spend on the weakest sibling.",
    evidence: [
      { label: "Family median ROAS", value: fmtRoas(medianRoas), tone: "neutral" },
      { label: "Recipient adset", value: `${high.name} (${fmtRoas(high.roas)})`, tone: "positive" },
      { label: "Source adset", value: `${low.name} (${fmtRoas(low.roas)})`, tone: "warning" },
      { label: "Shift amount", value: fmtCurrency(shiftAmount / 100, currency), tone: "neutral" },
    ],
    timeframeContext: adsetTimeframe(
      "Budget shift requires a clear high/low split within one ABO campaign.",
      "Selected-range sibling ROAS spread passes the shift threshold.",
      "No account-level reorder is needed because this stays inside the parent campaign.",
    ),
    strategyLayer: "budget",
    currentDailyBudget: currentBudget,
    proposedDailyBudget: proposedBudget,
    sourceAdsetIds: [low.id],
  };
}

/**
 * Threshold: trigger when conversions are below 50 over the comparison window
 * and CPA is above account p75. Reasoning: a purchase/value event can starve
 * learning when signal density is weak; temporarily moving to Add To Cart
 * increases signal density until purchase volume returns.
 */
export function maybeAdsetOptimizationEventSwitch(
  adsetWindow: MetaAdsetDecisionWindow,
  accountContext: MetaAdsetDecisionAccountContext,
): MetaRecommendation | null {
  const adset = adsetWindow.adset;
  const scope = parentScope(adsetWindow);
  if (!scope || !isActiveAdset(adset) || isLearningPhase(adset)) return null;
  const conversions = n(adset.purchases);
  const cpa = positive(adset.cpa);
  const p75 = positive(accountContext.accountP75Cpa);
  const proposedEvent = proposedUpperFunnelEvent(adset.optimizationGoal);
  if (conversions == null || cpa == null || p75 == null || !proposedEvent) return null;
  if (!(conversions < 50 && cpa > p75)) return null;
  const confidence = confidenceFor({
    conversions,
    supportingSignals: conversions >= 10,
  });
  return {
    id: `adset:${adset.id}:optimization_event_switch`,
    level: "adset",
    ...scope,
    adsetId: adset.id,
    adsetName: adset.name,
    type: "adset_optimization_event_switch",
    lens: "profitability",
    priority: "medium",
    confidence,
    decisionState: decisionStateFor(confidence),
    decision: "Switch to a higher-signal optimization event",
    title: `${adset.name}: purchase signal is too sparse`,
    why: "The current lower-funnel event is not collecting enough conversions and CPA is above the account p75.",
    summary: `${adset.optimizationGoal ?? "Current event"} has ${Math.round(conversions)} conversions with CPA ${fmtCurrency(cpa, resolveCurrency(adsetWindow, accountContext))}.`,
    recommendedAction: `Test ${proposedEvent} optimization until purchase signal density returns above 50 conversions.`,
    expectedImpact: "More stable learning signals and less wasted spend while purchase volume is sparse.",
    evidence: [
      { label: "Conversions", value: String(Math.round(conversions)), tone: "warning" },
      { label: "Adset CPA", value: fmtCurrency(cpa, resolveCurrency(adsetWindow, accountContext)), tone: "warning" },
      { label: "Account p75 CPA", value: fmtCurrency(p75, resolveCurrency(adsetWindow, accountContext)), tone: "neutral" },
      { label: "Proposed event", value: proposedEvent, tone: "positive" },
    ],
    timeframeContext: adsetTimeframe(
      "Optimization switch is gated by sparse conversion volume and high CPA.",
      "Selected-range CPA is above the account p75.",
      "The proposed event is a temporary signal-density move, not a permanent downgrade.",
    ),
    strategyLayer: "structure",
    currentEvent: adset.optimizationGoal ?? "Unknown",
    proposedEvent,
  };
}

/**
 * Threshold: trigger when impressions are below 70% of the budget-derived
 * target and CPM is below the account median. Reasoning: cheap but shallow
 * delivery usually points to an audience ceiling, so the next read-only action
 * is controlled broadening rather than a budget increase.
 */
export function maybeAdsetAudienceExpansion(
  adsetWindow: MetaAdsetDecisionWindow,
  accountContext: MetaAdsetDecisionAccountContext,
): MetaRecommendation | null {
  const adset = adsetWindow.adset;
  const scope = parentScope(adsetWindow);
  if (!scope || !isActiveAdset(adset) || isLearningPhase(adset)) return null;
  const impressions = n(adset.impressions);
  const target = deriveDailyTargetImpressions(adset, accountContext);
  const cpm = positive(adset.cpm);
  const medianCpm = positive(accountContext.accountMedianCpm);
  if (impressions == null || target == null || cpm == null || medianCpm == null) return null;
  if (!(impressions < target * 0.7 && cpm < medianCpm)) return null;
  const currentLabel = audienceLabel(adset);
  const proposedLabel = broaderAudience(currentLabel);
  const confidence = confidenceFor({
    conversions: n(adset.purchases),
    supportingSignals: positive(adset.spend) != null && !adset.isConfigMixed,
    missingRequired: adset.dailyTargetImpressions == null && (adset.dailyBudget == null || adset.cpm == null),
  });
  return {
    id: `adset:${adset.id}:audience_expansion`,
    level: "adset",
    ...scope,
    adsetId: adset.id,
    adsetName: adset.name,
    type: "adset_audience_expansion",
    lens: "volume",
    priority: "medium",
    confidence,
    decisionState: decisionStateFor(confidence),
    decision: "Broaden this adset audience",
    title: `${adset.name}: cheap delivery is not reaching enough people`,
    why: "The adset is below its impression target while CPM is still cheaper than the account median.",
    summary: `Impressions are ${Math.round(impressions).toLocaleString()} versus a ${Math.round(target).toLocaleString()} target, with CPM ${fmtCurrency(cpm, resolveCurrency(adsetWindow, accountContext))}.`,
    recommendedAction: `Broaden from ${displayAudienceLabel(currentLabel)} toward ${displayAudienceLabel(proposedLabel)} before adding budget.`,
    expectedImpact: "More available reach while preserving the current low CPM advantage.",
    evidence: [
      { label: "Impressions", value: Math.round(impressions).toLocaleString(), tone: "warning" },
      { label: "Target impressions", value: Math.round(target).toLocaleString(), tone: "neutral" },
      { label: "Adset CPM", value: fmtCurrency(cpm, resolveCurrency(adsetWindow, accountContext)), tone: "positive" },
      { label: "Account median CPM", value: fmtCurrency(medianCpm, resolveCurrency(adsetWindow, accountContext)), tone: "neutral" },
    ],
    timeframeContext: adsetTimeframe(
      "Audience expansion is gated by low reach against target and cheap CPM.",
      "Selected-range CPM is below the account median.",
      "No bid or budget target is emitted for this read-only broadening recommendation.",
    ),
    strategyLayer: "structure",
  };
}

function attachCtrDecay(adset: MetaAdSetData, previous: MetaAdSetData | null | undefined) {
  if (adset.ctrDecay14d != null) return adset;
  const previousCtr = positive(previous?.inlineLinkClickCtr ?? previous?.ctr);
  const currentCtr = n(adset.inlineLinkClickCtr ?? adset.ctr);
  if (previousCtr == null || currentCtr == null) return adset;
  return {
    ...adset,
    ctrDecay14d: (currentCtr - previousCtr) / previousCtr,
  };
}

export function scoreAdsetRecommendation(recommendation: MetaRecommendation) {
  const impact = recommendation.priority === "high" ? 3 : recommendation.priority === "medium" ? 2 : 1;
  return impact * CONFIDENCE_SCORE[recommendation.confidence];
}

export function buildMetaAdsetRecommendations(input: {
  adsets: MetaAdSetData[];
  previousAdsets?: MetaAdSetData[];
  selectedCampaigns: MetaCampaignRow[];
  windows?: MetaRecommendationWindows | null;
  selectedRangeDays: number;
}) {
  const selectedCampaignsById = new Map(input.selectedCampaigns.map((campaign) => [campaign.id, campaign]));
  const previousById = new Map((input.previousAdsets ?? []).map((adset) => [adset.id, adset]));
  const context = buildMetaAdsetDecisionAccountContext({
    adsets: input.adsets,
    selectedCampaigns: input.selectedCampaigns,
    windows: input.windows ?? null,
    selectedRangeDays: input.selectedRangeDays,
  });

  const recommendations: MetaRecommendation[] = [];
  const windows = input.adsets.map((adset) => {
    const previousAdset = previousById.get(adset.id) ?? null;
    return {
      adset: attachCtrDecay(adset, previousAdset),
      previousAdset,
      parentCampaign: selectedCampaignsById.get(adset.campaignId) ?? null,
    };
  });

  for (const window of windows) {
    const candidates = [
      maybeAdsetBidCapAdjust(window, context),
      maybeAdsetAudienceSwap(window, context),
      maybeAdsetPauseUnderperformer(window, context),
      maybeAdsetOptimizationEventSwitch(window, context),
      maybeAdsetAudienceExpansion(window, context),
    ];
    for (const recommendation of candidates) {
      if (recommendation) recommendations.push(recommendation);
    }
  }

  const adsetsByCampaign = new Map<string, MetaAdSetData[]>();
  for (const window of windows) {
    if (!window.parentCampaign) continue;
    const list = adsetsByCampaign.get(window.parentCampaign.id) ?? [];
    list.push(window.adset);
    adsetsByCampaign.set(window.parentCampaign.id, list);
  }

  for (const [campaignId, adsets] of adsetsByCampaign.entries()) {
    const budgetShift = maybeAdsetBudgetShiftWithinCampaign({
      campaign: selectedCampaignsById.get(campaignId) ?? null,
      adsets,
      accountContext: context,
    });
    if (budgetShift) recommendations.push(budgetShift);
  }

  return recommendations
    .filter((recommendation, index, list) => list.findIndex((item) => item.id === recommendation.id) === index)
    .sort((a, b) => scoreAdsetRecommendation(b) - scoreAdsetRecommendation(a));
}
