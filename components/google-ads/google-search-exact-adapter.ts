import type { SearchIntelligenceRow } from "@/components/google-ads/google-ads-dashboard-support";
import type { GoogleAdsKeywordInsightCounts } from "@/lib/google-ads/keyword-insights";

/**
 * Pure view model for the canonical `Google Ads · Search` screen.
 *
 * Every string this emits is already formatted for the DOM; the component
 * renders it and nothing else. A fact the provider did not serve becomes the
 * em dash, never a substituted metric and never a zero.
 */

const DASH = "—";

export type GoogleSearchExactTab = "terms" | "keywords";

export type GoogleSearchTermFilterKey =
  | "all"
  | "wasteful"
  | "opportunity"
  | "high";

export type GoogleSearchExactChipTone =
  | "positive"
  | "info"
  | "auto"
  | "warning"
  | "negative"
  | "neutral";

export type GoogleSearchExactStatTone = "waste" | "opportunity" | "high";

export type GoogleSearchExactKeywordStatTone = "warning" | "info" | "auto";

export type GoogleSearchExactQualityTone = "positive" | "negative" | "neutral";

export interface GoogleSearchExactIdentity {
  accountId?: string | null;
  currencyCode?: string | null;
  windowLabel?: string | null;
  syncLabel?: string | null;
}

export interface GoogleSearchExactTabViewModel {
  key: GoogleSearchExactTab;
  label: string;
  active: boolean;
}

export interface GoogleSearchExactStatViewModel {
  key: GoogleSearchExactStatTone;
  value: string;
  label: string;
}

export interface GoogleSearchExactFilterViewModel {
  key: GoogleSearchTermFilterKey;
  label: string;
  count: string;
  active: boolean;
}

export interface GoogleSearchExactTermRowViewModel {
  key: string;
  term: string;
  intent: string;
  intentTone: GoogleSearchExactChipTone;
  keywordOpportunity: boolean;
  campaign: string;
  clicks: string;
  conversions: string;
  cpa: string;
  value: string;
  roas: string;
  roasTone: GoogleSearchExactChipTone;
  ctr: string;
  spend: string;
  /** The design bolds and reddens only the spend of a wasteful term. */
  spendWasteful: boolean;
}

export interface GoogleSearchExactKeywordStatViewModel {
  key: GoogleSearchExactKeywordStatTone;
  count: string;
  label: string;
}

export interface GoogleSearchExactKeywordRowViewModel {
  key: string;
  keyword: string;
  matchType: string;
  matchTone: GoogleSearchExactChipTone;
  components: string;
  campaign: string;
  spend: string;
  conversions: string;
  cpa: string;
  roas: string;
  roasTone: GoogleSearchExactChipTone;
  qualityScore: string;
  qualityTone: GoogleSearchExactQualityTone;
  impressionShare: string;
  ctr: string;
}

export interface GoogleSearchExactViewModel {
  eyebrow: string;
  syncLabel: string;
  tabs: GoogleSearchExactTabViewModel[];
  stats: GoogleSearchExactStatViewModel[];
  filters: GoogleSearchExactFilterViewModel[];
  termRows: GoogleSearchExactTermRowViewModel[];
  keywordStats: GoogleSearchExactKeywordStatViewModel[];
  keywordRows: GoogleSearchExactKeywordRowViewModel[];
}

/** The keyword report shape the Search screen reads, as the route serves it. */
export interface GoogleSearchExactKeywordSource {
  criterionId?: string | null;
  keywordText?: string | null;
  keyword?: string | null;
  matchType?: string | null;
  campaignName?: string | null;
  campaign?: string | null;
  spend?: number | null;
  conversions?: number | null;
  cpa?: number | null;
  roas?: number | null;
  /** Percentage, as both Google readers emit it: `5.8` means 5.8%. */
  ctr?: number | null;
  /** Fraction, as both Google readers emit it: `0.41` means 41%. */
  impressionShare?: number | null;
  qualityScore?: number | null;
  expectedCtr?: string | null;
  adRelevance?: string | null;
  landingPageExperience?: string | null;
}

export interface GoogleSearchExactInput {
  identity?: GoogleSearchExactIdentity;
  tab: GoogleSearchExactTab;
  termFilter: GoogleSearchTermFilterKey;
  /** Null means the search-term report has not been read, not that it is empty. */
  terms: SearchIntelligenceRow[] | null;
  keywords: GoogleSearchExactKeywordSource[] | null;
  /** Server-computed tallies; null renders the design's shells with `—`. */
  keywordInsights: GoogleAdsKeywordInsightCounts | null;
  /**
   * The operator's own ROAS target from the commercial truth pack. A tint is a
   * verdict, so without a target every ROAS chip stays neutral rather than
   * claiming a row is winning or losing.
   */
  roasTarget: number | null;
  /** The pack's break-even ROAS, the design's second boundary. */
  roasBreakEven?: number | null;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function numeric(value: unknown): number {
  return finite(value) ?? 0;
}

function clean(value: string | null | undefined): string {
  const normalized = value?.trim();
  return normalized ? normalized : DASH;
}

function currency(
  value: number | null,
  currencyCode: string | null | undefined,
  digits: 0 | 2,
): string {
  const code = currencyCode?.trim();
  if (value === null || !code) return DASH;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: code,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(value);
  } catch {
    return DASH;
  }
}

function count(value: number | null): string {
  if (value === null) return DASH;
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
}

function percentFromPercentage(value: number | null): string {
  return value === null ? DASH : `${value.toFixed(1)}%`;
}

function percentFromFraction(value: number | null): string {
  return value === null ? DASH : `${Math.round(value * 100)}%`;
}

function roasText(value: number | null): string {
  return value === null || value <= 0 ? DASH : value.toFixed(2);
}

/**
 * The canonical ROAS tint, read against the operator's own target.
 *
 * Break-even is the second boundary the design draws; when the pack has not
 * declared one, 80% of target stands in for "within reach of target". Below a
 * ROAS of 1 the media has not returned its own cost, which is the design's red.
 */
export function googleSearchRoasTone(
  value: number | null,
  target: number | null,
  breakEven: number | null = null,
): GoogleSearchExactChipTone {
  if (value === null || value <= 0) return "neutral";
  if (target === null || target <= 0) return "neutral";
  const floor = breakEven !== null && breakEven > 0 ? breakEven : target * 0.8;
  if (value >= target) return "positive";
  if (value >= floor) return "neutral";
  if (value >= 1) return "warning";
  return "negative";
}

const INTENT_TONE: Record<string, GoogleSearchExactChipTone> = {
  transactional: "positive",
  commercial: "info",
  informational: "auto",
  navigational: "neutral",
};

function intentView(row: SearchIntelligenceRow): {
  label: string;
  tone: GoogleSearchExactChipTone;
} {
  // `intent` is the design's taxonomy — the server fills it from
  // classifySearchIntent. `ownershipClass` answers a different question and is
  // not what this chip names.
  const raw = row.intent?.trim().toLowerCase();
  if (!raw) return { label: DASH, tone: "neutral" };
  const tone = INTENT_TONE[raw] ?? "neutral";
  return { label: `${raw.charAt(0).toUpperCase()}${raw.slice(1)}`, tone };
}

const MATCH_TONE: Record<string, GoogleSearchExactChipTone> = {
  exact: "info",
  phrase: "warning",
  broad: "neutral",
};

function matchView(raw: string | null | undefined): {
  label: string;
  tone: GoogleSearchExactChipTone;
} {
  const normalized = raw?.replace(/_/g, " ").trim();
  if (!normalized) return { label: DASH, tone: "neutral" };
  const lower = normalized.toLowerCase();
  const label = `${lower.charAt(0).toUpperCase()}${lower.slice(1)}`;
  return { label, tone: MATCH_TONE[lower] ?? "neutral" };
}

function qualityView(score: number | null): {
  label: string;
  tone: GoogleSearchExactQualityTone;
} {
  if (score === null) return { label: DASH, tone: "neutral" };
  const tone: GoogleSearchExactQualityTone =
    score >= 8 ? "positive" : score <= 4 ? "negative" : "neutral";
  return { label: `${score}/10`, tone };
}

const FILTER_LABELS: Array<{ key: GoogleSearchTermFilterKey; label: string }> = [
  { key: "all", label: "All terms" },
  { key: "wasteful", label: "Wasteful" },
  { key: "opportunity", label: "KW opportunity" },
  { key: "high", label: "High performing" },
];

/**
 * The tag set behind both the pill count and the rows the pill produces.
 *
 * `wasteful` and `opportunity` are server flags — the screen tallies what the
 * search-intelligence report already decided. `high` is the only tag derived
 * here, and it is derived once, so a pill reading "High performing 11" always
 * opens on exactly eleven rows.
 */
export function googleSearchTermTags(
  row: SearchIntelligenceRow,
  highPerformingThreshold: number | null,
): GoogleSearchTermFilterKey[] {
  const tags: GoogleSearchTermFilterKey[] = [];
  if (row.wasteFlag === true) tags.push("wasteful");
  if (row.keywordOpportunityFlag === true) tags.push("opportunity");
  const roas = finite(row.roas);
  if (
    numeric(row.conversions) > 0 &&
    roas !== null &&
    highPerformingThreshold !== null &&
    highPerformingThreshold > 0 &&
    roas >= highPerformingThreshold
  ) {
    tags.push("high");
  }
  return tags;
}

function eyebrowText(identity: GoogleSearchExactIdentity) {
  return `Google Ads · ${clean(identity.accountId)} · ${clean(
    identity.currencyCode,
  )} · ${clean(identity.windowLabel)} window`;
}

export function buildGoogleSearchExactViewModel(
  input: GoogleSearchExactInput,
): GoogleSearchExactViewModel {
  const identity = input.identity ?? {};
  const currencyCode = identity.currencyCode ?? null;
  const windowLabel = identity.windowLabel?.trim() || DASH;
  const terms = input.terms ?? [];
  const keywords = input.keywords ?? [];

  // "High performing" needs a bar. The operator's target is the honest one; the
  // window's own blended return stands in when no target pack exists, because a
  // tally against the account's own average is a description, not a verdict.
  const totalSpend = terms.reduce((sum, row) => sum + numeric(row.spend), 0);
  const totalRevenue = terms.reduce((sum, row) => sum + numeric(row.revenue), 0);
  const blendedRoas = totalSpend > 0 ? totalRevenue / totalSpend : null;
  const highPerformingThreshold = input.roasTarget ?? blendedRoas;

  const tagged = terms.map((row) => ({
    row,
    tags: googleSearchTermTags(row, highPerformingThreshold),
  }));

  const zeroConversionSpend = terms
    .filter((row) => numeric(row.conversions) === 0)
    .reduce((sum, row) => sum + numeric(row.spend), 0);

  const stats: GoogleSearchExactStatViewModel[] = [
    {
      key: "waste",
      value: input.terms === null ? DASH : currency(zeroConversionSpend, currencyCode, 0),
      label: `wasted on zero-conv terms · ${windowLabel}`,
    },
    {
      key: "opportunity",
      value:
        input.terms === null
          ? DASH
          : String(tagged.filter((entry) => entry.tags.includes("opportunity")).length),
      label: "converting terms not yet keywords",
    },
    {
      key: "high",
      value:
        input.terms === null
          ? DASH
          : String(tagged.filter((entry) => entry.tags.includes("high")).length),
      label: "high-performing terms",
    },
  ];

  const filters: GoogleSearchExactFilterViewModel[] = FILTER_LABELS.map(
    (filter) => ({
      key: filter.key,
      label: filter.label,
      count:
        input.terms === null
          ? DASH
          : String(
              filter.key === "all"
                ? tagged.length
                : tagged.filter((entry) => entry.tags.includes(filter.key)).length,
            ),
      active: input.termFilter === filter.key,
    }),
  );

  const visibleTerms =
    input.termFilter === "all"
      ? tagged
      : tagged.filter((entry) => entry.tags.includes(input.termFilter));

  const termRows: GoogleSearchExactTermRowViewModel[] = visibleTerms.map(
    ({ row, tags }, index) => {
      const conversions = numeric(row.conversions);
      const spend = numeric(row.spend);
      const intent = intentView(row);
      const roas = finite(row.roas);
      return {
        key: row.key ?? `${row.searchTerm}-${row.campaign ?? ""}-${index}`,
        term: clean(row.searchTerm),
        intent: intent.label,
        intentTone: intent.tone,
        keywordOpportunity: row.keywordOpportunityFlag === true,
        campaign: clean(row.campaign),
        clicks: count(finite(row.clicks)),
        conversions: count(conversions),
        cpa: conversions > 0 ? currency(spend / conversions, currencyCode, 2) : DASH,
        value: currency(finite(row.revenue), currencyCode, 0),
        roas: roasText(roas),
        roasTone: googleSearchRoasTone(roas, input.roasTarget, input.roasBreakEven ?? null),
        ctr: percentFromPercentage(finite(row.ctr)),
        spend: currency(finite(row.spend), currencyCode, 0),
        spendWasteful: tags.includes("wasteful"),
      };
    },
  );

  const keywordStats: GoogleSearchExactKeywordStatViewModel[] = [
    {
      key: "warning",
      count:
        input.keywordInsights === null
          ? DASH
          : String(input.keywordInsights.highCtrLowConvCount),
      label: "keywords: high CTR, zero conversions",
    },
    {
      key: "info",
      count:
        input.keywordInsights === null
          ? DASH
          : String(input.keywordInsights.highConvLowBudgetCount),
      label: "with conversions but low impression share",
    },
    {
      key: "auto",
      count:
        input.keywordInsights === null
          ? DASH
          : String(input.keywordInsights.deserveOwnAdGroupCount),
      label: "may deserve their own ad group",
    },
  ];

  const keywordRows: GoogleSearchExactKeywordRowViewModel[] = keywords.map(
    (row, index) => {
      const spend = numeric(row.spend);
      const conversions = numeric(row.conversions);
      const servedCpa = finite(row.cpa);
      const cpa =
        servedCpa !== null && servedCpa > 0
          ? servedCpa
          : conversions > 0
            ? spend / conversions
            : null;
      const match = matchView(row.matchType);
      const quality = qualityView(finite(row.qualityScore));
      const roas = finite(row.roas);
      const components = [
        row.expectedCtr,
        row.adRelevance,
        row.landingPageExperience,
      ]
        .map((part) => part?.trim())
        .filter((part): part is string => Boolean(part))
        .join(" · ");
      return {
        key: row.criterionId ?? `${row.keywordText ?? row.keyword ?? ""}-${index}`,
        keyword: clean(row.keywordText ?? row.keyword),
        matchType: match.label,
        matchTone: match.tone,
        components: components || DASH,
        campaign: clean(row.campaignName ?? row.campaign),
        spend: currency(finite(row.spend), currencyCode, 0),
        conversions: count(conversions),
        cpa: currency(cpa, currencyCode, 2),
        roas: roasText(roas),
        roasTone: googleSearchRoasTone(roas, input.roasTarget, input.roasBreakEven ?? null),
        qualityScore: quality.label,
        qualityTone: quality.tone,
        impressionShare: percentFromFraction(finite(row.impressionShare)),
        ctr: percentFromPercentage(finite(row.ctr)),
      };
    },
  );

  return {
    eyebrow: eyebrowText(identity),
    syncLabel: clean(identity.syncLabel),
    tabs: [
      { key: "terms", label: "Search terms", active: input.tab === "terms" },
      { key: "keywords", label: "Keywords", active: input.tab === "keywords" },
    ],
    stats,
    filters,
    termRows,
    keywordStats,
    keywordRows,
  };
}
