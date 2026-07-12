import type {
  BriefingActionItem,
  BriefingCreativeCard,
  CreativesBriefingResponse,
} from "@/components/creatives/briefing/types";
import type { MetaCreativeRow } from "@/components/creatives/metricConfig";
import {
  CREATOR_TIER_0_SHARE_METRIC_KEYS,
  SHARE_METRIC_KEYS,
  type ShareAudience,
  type ShareMetricKey,
} from "@/components/creatives/shareCreativeTypes";

export type CreativeStudioWorkspaceView = "assets" | "winner_eras" | "fatigue_brief";
export type CreativeStudioAssetView = "gallery" | "table";
export type CreativeStudioFormatFilter = "all" | "image" | "video" | "catalog";
export type CreativeStudioSort = "spend" | "roas" | "newest" | "name";

export interface ServerDecisionBadge {
  label: string;
  servedAction: string;
  confidenceBand: string;
  source: "decision_center";
}

export type WinnerQualificationReason =
  | "qualified"
  | "not_winner_action"
  | "decision_contract_missing"
  | "global_default_truth"
  | "thin_account_truth"
  | "stale_commercial_truth"
  | "truth_source_missing"
  | "threshold_not_ready"
  | "decision_evidence_missing"
  | "low_confidence"
  | "engine_provenance_missing";

export interface WinnerQualification {
  candidate: boolean;
  qualified: boolean;
  reason: WinnerQualificationReason;
  explanation: string;
}

export interface CurrentWinnerEvidence {
  qualified: BriefingCreativeCard[];
  withheld: Array<{
    card: BriefingCreativeCard;
    qualification: WinnerQualification;
  }>;
}

interface HistoricalDecisionEntryWithProvenance {
  date: string;
  previousLabel: string | null;
  currentLabel: string;
  realizedOutcome7d?: string | null;
  engineVersion?: string | null;
  truthSource?: string | null;
  thresholdQuality?: string | null;
}

export interface HistoricalTransitionEvidence {
  creativeId: string;
  creativeName: string;
  entry: HistoricalDecisionEntryWithProvenance;
}

export type HistoricalWinnerEraState =
  | {
      status: "missing";
      reason: string;
      eras: [];
      transitions: [];
    }
  | {
      status: "provenance_incomplete";
      reason: string;
      eras: [];
      transitions: HistoricalTransitionEvidence[];
    }
  | {
      status: "available";
      reason: null;
      eras: Array<{
        engineVersion: string;
        entries: HistoricalTransitionEvidence[];
      }>;
      transitions: HistoricalTransitionEvidence[];
    };

export interface FatigueEvidenceGroup {
  key: string;
  campaignLabel: string;
  cards: BriefingCreativeCard[];
}

export interface CreativeInboxScopeResult<T extends BriefingCreativeCard> {
  cards: T[];
  excludedBusinessCount: number;
  excludedAccountCount: number;
  missingAccountCount: number;
}

export interface CreativeStudioSharePolicy {
  metrics: ShareMetricKey[];
  includeCampaignNames: boolean;
  includeDecisionLanguage: boolean;
  allowCsv: boolean;
  creatorTier0: boolean;
}

const WINNER_ACTIONS = new Set(["scale", "protect"]);
const HISTORICAL_WINNER_LABELS = new Set(["scale", "protect"]);
const SHARE_METRIC_SET = new Set<string>(SHARE_METRIC_KEYS);

function safeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function cardKey(card: BriefingCreativeCard): string {
  return safeText(card.creativeId) || safeText(card.id);
}

function isBriefingRollup(item: BriefingActionItem): item is Extract<BriefingActionItem, { primaryRec: unknown }> {
  return Boolean(
    item &&
      typeof item === "object" &&
      "primaryRec" in item &&
      item.primaryRec &&
      typeof item.primaryRec === "object",
  );
}

function cardFromActionItem(item: BriefingActionItem): BriefingCreativeCard {
  if (!isBriefingRollup(item)) return item;
  const placementList = Array.isArray(item.placementList) ? item.placementList : [];
  return {
    ...item.primaryRec,
    id: item.primaryRec.id || item.id || item.primaryRec.creativeId || "unknown",
    placementList,
    placements: placementList.length,
    mixed: item.mixed ?? item.primaryRec.mixed,
  };
}

export function flattenCreativeStudioBriefingCards(
  payload: CreativesBriefingResponse | null | undefined,
): BriefingCreativeCard[] {
  if (!payload) return [];

  const candidates = [
    ...(Array.isArray(payload.actionNow) ? payload.actionNow.map(cardFromActionItem) : []),
    ...(Array.isArray(payload.watching) ? payload.watching : []),
    ...(Array.isArray(payload.healthy) ? payload.healthy : []),
  ];
  const seen = new Set<string>();

  return candidates.filter((card) => {
    const key = cardKey(card);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function indexCreativeStudioBriefingCards(
  cards: BriefingCreativeCard[],
): Map<string, BriefingCreativeCard> {
  const index = new Map<string, BriefingCreativeCard>();
  for (const card of cards) {
    const keys = [
      card.id,
      card.creativeId,
      card.adId,
      card.realAdId,
      card.metaAdId,
      card.effectiveAdId,
    ];
    for (const key of keys) {
      const normalized = safeText(key);
      if (normalized && !index.has(normalized)) index.set(normalized, card);
    }
  }
  return index;
}

export function findCreativeStudioCard(
  row: Pick<MetaCreativeRow, "id" | "creativeId">,
  index: Map<string, BriefingCreativeCard>,
): BriefingCreativeCard | null {
  const creativeId = safeText(row.creativeId);
  const exact = creativeId ? index.get(creativeId) : null;
  if (exact) return exact;

  const rowId = safeText(row.id);
  const fallback = rowId ? index.get(rowId) : null;
  if (!fallback) return null;

  // Grouped row ids can be reused when Meta replaces a creative under the
  // same ad/name. Never attach an older creative's decision to the new asset.
  const fallbackCreativeId = safeText(fallback.creativeId);
  if (creativeId && fallbackCreativeId && creativeId !== fallbackCreativeId) {
    return null;
  }
  return fallback;
}

export function resolveServerDecisionBadge(
  card: BriefingCreativeCard | null | undefined,
): ServerDecisionBadge | null {
  const row = card?.decisionCenterRow;
  const label = safeText(row?.buyerLabel);
  if (!row || !label) return null;

  return {
    label,
    servedAction: row.buyerAction,
    confidenceBand: row.confidenceBand,
    source: "decision_center",
  };
}

function winnerCandidate(card: BriefingCreativeCard | null | undefined): boolean {
  return Boolean(card?.decisionCenterRow && WINNER_ACTIONS.has(card.decisionCenterRow.buyerAction));
}

export function qualifyCurrentWinner(
  card: BriefingCreativeCard | null | undefined,
): WinnerQualification {
  if (!card?.decisionCenterRow) {
    return {
      candidate: false,
      qualified: false,
      reason: "decision_contract_missing",
      explanation: "The server decision row is missing, so Studio does not infer a winner.",
    };
  }
  if (!winnerCandidate(card)) {
    return {
      candidate: false,
      qualified: false,
      reason: "not_winner_action",
      explanation: "The server action is not a winner-qualified action.",
    };
  }
  if (card.truthSource === "global_default") {
    return {
      candidate: true,
      qualified: false,
      reason: "global_default_truth",
      explanation: "Winner language is withheld because the engine used a global default.",
    };
  }
  if (card.truthSource === "account_baseline_thin") {
    return {
      candidate: true,
      qualified: false,
      reason: "thin_account_truth",
      explanation: "Winner language is withheld because the account baseline is thin.",
    };
  }
  if (card.truthSource === "commercial_truth_stale") {
    return {
      candidate: true,
      qualified: false,
      reason: "stale_commercial_truth",
      explanation: "Winner language is withheld because the commercial target is stale.",
    };
  }
  if (card.truthSource !== "commercial_truth" && card.truthSource !== "account_baseline") {
    return {
      candidate: true,
      qualified: false,
      reason: "truth_source_missing",
      explanation: "Winner language is withheld because the truth source is unavailable.",
    };
  }
  if (card.thresholdQuality !== "ready") {
    return {
      candidate: true,
      qualified: false,
      reason: "threshold_not_ready",
      explanation: "Winner language is withheld because threshold quality is not ready.",
    };
  }
  if ((card.decisionCenterRow.missingData?.length ?? 0) > 0) {
    return {
      candidate: true,
      qualified: false,
      reason: "decision_evidence_missing",
      explanation: "Winner language is withheld because required decision evidence is missing.",
    };
  }
  if (card.decisionCenterRow.confidenceBand === "low") {
    return {
      candidate: true,
      qualified: false,
      reason: "low_confidence",
      explanation: "Winner language is withheld because server confidence is low.",
    };
  }
  if (!safeText(card.engineVersion) || !safeText(card.sourceAsOf) || !safeText(card.sourceDataSource)) {
    return {
      candidate: true,
      qualified: false,
      reason: "engine_provenance_missing",
      explanation: "Winner language is withheld because engine-era provenance is incomplete.",
    };
  }

  return {
    candidate: true,
    qualified: true,
    reason: "qualified",
    explanation: "Server action, truth source, threshold quality, confidence, and engine era are present.",
  };
}

export function buildCurrentWinnerEvidence(cards: BriefingCreativeCard[]): CurrentWinnerEvidence {
  const evidence: CurrentWinnerEvidence = { qualified: [], withheld: [] };
  for (const card of cards) {
    const qualification = qualifyCurrentWinner(card);
    if (!qualification.candidate) continue;
    if (qualification.qualified) evidence.qualified.push(card);
    else evidence.withheld.push({ card, qualification });
  }
  return evidence;
}

function historicalEntryHasWinnerProvenance(
  entry: HistoricalDecisionEntryWithProvenance,
): entry is HistoricalDecisionEntryWithProvenance & {
  engineVersion: string;
  truthSource: "commercial_truth" | "account_baseline";
  thresholdQuality: "ready";
} {
  return Boolean(
    safeText(entry.engineVersion) &&
      (entry.truthSource === "commercial_truth" || entry.truthSource === "account_baseline") &&
      entry.thresholdQuality === "ready",
  );
}

export function buildHistoricalWinnerEraState(
  cards: BriefingCreativeCard[],
): HistoricalWinnerEraState {
  const transitions = cards.flatMap<HistoricalTransitionEvidence>((card) =>
    (card.decisionHistory ?? []).map((entry) => ({
      creativeId: cardKey(card),
      creativeName: safeText(card.creativeName) || safeText(card.name) || cardKey(card),
      entry: entry as HistoricalDecisionEntryWithProvenance,
    })),
  );

  if (transitions.length === 0) {
    return {
      status: "missing",
      reason: "No server decision-transition history is available for this account and window.",
      eras: [],
      transitions: [],
    };
  }

  const winnerTransitions = transitions.filter((item) =>
    HISTORICAL_WINNER_LABELS.has(item.entry.currentLabel),
  );
  if (
    transitions.some((item) => !safeText(item.entry.engineVersion)) ||
    winnerTransitions.some((item) => !historicalEntryHasWinnerProvenance(item.entry))
  ) {
    return {
      status: "provenance_incomplete",
      reason:
        "Historical events omit per-event engine version or truth qualification. Studio shows the transitions but does not call them historical winners.",
      eras: [],
      transitions,
    };
  }

  const erasByVersion = new Map<string, HistoricalTransitionEvidence[]>();
  for (const item of winnerTransitions) {
    if (!historicalEntryHasWinnerProvenance(item.entry)) continue;
    const list = erasByVersion.get(item.entry.engineVersion) ?? [];
    list.push(item);
    erasByVersion.set(item.entry.engineVersion, list);
  }

  return {
    status: "available",
    reason: null,
    eras: Array.from(erasByVersion, ([engineVersion, entries]) => ({
      engineVersion,
      entries,
    })),
    transitions,
  };
}

export function groupServerFatigueEvidence(
  cards: BriefingCreativeCard[],
): FatigueEvidenceGroup[] {
  const groups = new Map<string, FatigueEvidenceGroup>();
  for (const card of cards) {
    if (card.fatigue !== true) continue;
    const campaignLabel = safeText(card.campaignName) || safeText(card.campaign) || "Campaign unavailable";
    const key = campaignLabel.toLowerCase();
    const group = groups.get(key) ?? { key, campaignLabel, cards: [] };
    group.cards.push(card);
    groups.set(key, group);
  }
  return Array.from(groups.values()).sort(
    (left, right) => right.cards.length - left.cards.length || left.campaignLabel.localeCompare(right.campaignLabel),
  );
}

export function scopeCreativeInboxCards<T extends BriefingCreativeCard & { businessId?: string }>(
  cards: T[],
  input: { businessId: string; providerAccountId: string },
): CreativeInboxScopeResult<T> {
  const result: CreativeInboxScopeResult<T> = {
    cards: [],
    excludedBusinessCount: 0,
    excludedAccountCount: 0,
    missingAccountCount: 0,
  };
  for (const card of cards) {
    if (safeText(card.businessId) !== input.businessId) {
      result.excludedBusinessCount += 1;
      continue;
    }
    const accountId = safeText(card.providerAccountId) || safeText(card.accountId) || safeText(card.metaAccountId);
    if (!accountId) {
      result.missingAccountCount += 1;
      continue;
    }
    if (accountId !== input.providerAccountId) {
      result.excludedAccountCount += 1;
      continue;
    }
    result.cards.push(card);
  }
  return result;
}

export function resolveCreativeStudioSharePolicy(input: {
  audience: ShareAudience;
  selectedMetricIds: string[];
  buyerDecisionLanguage: boolean;
  allowCsv: boolean;
  anonymizeCampaignNames: boolean;
}): CreativeStudioSharePolicy {
  if (input.audience !== "buyer") {
    return {
      metrics: [...CREATOR_TIER_0_SHARE_METRIC_KEYS],
      includeCampaignNames: false,
      includeDecisionLanguage: false,
      allowCsv: false,
      creatorTier0: true,
    };
  }

  const selectedMetrics = input.selectedMetricIds.filter(
    (metricId): metricId is ShareMetricKey => SHARE_METRIC_SET.has(metricId),
  );
  return {
    metrics: selectedMetrics.length > 0 ? selectedMetrics : ["spend", "roas", "purchases"],
    includeCampaignNames: !input.anonymizeCampaignNames,
    includeDecisionLanguage: input.buyerDecisionLanguage,
    allowCsv: input.allowCsv,
    creatorTier0: false,
  };
}

function rowFormat(row: MetaCreativeRow): CreativeStudioFormatFilter {
  if (row.isCatalog || row.format === "catalog") return "catalog";
  if (row.format === "video" || row.creativeVisualFormat === "video") return "video";
  return "image";
}

function timeValue(value: string | null | undefined): number {
  const parsed = value ? new Date(value).getTime() : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

export function filterAndSortCreativeStudioRows(
  rows: MetaCreativeRow[],
  input: {
    search: string;
    format: CreativeStudioFormatFilter;
    sort: CreativeStudioSort;
  },
): MetaCreativeRow[] {
  const query = input.search.trim().toLowerCase();
  const filtered = rows.filter((row) => {
    if (input.format !== "all" && rowFormat(row) !== input.format) return false;
    if (!query) return true;
    return [row.name, row.campaignName, row.adSetName, row.copyText, row.creativePrimaryLabel]
      .some((value) => safeText(value).toLowerCase().includes(query));
  });

  return [...filtered].sort((left, right) => {
    if (input.sort === "spend") return right.spend - left.spend || left.name.localeCompare(right.name);
    if (input.sort === "roas") return right.roas - left.roas || right.spend - left.spend;
    if (input.sort === "newest") return timeValue(right.launchDate) - timeValue(left.launchDate);
    return left.name.localeCompare(right.name);
  });
}
