/**
 * View model for the Dashboard v2 "Commercial Truth" screen.
 *
 * The design (markup 2618-2814, model 4213-4315) draws exactly seven blocks:
 * header, the navy "Single source" band, a 1.45fr/1fr grid holding Target pack +
 * "Where $100 of revenue goes" on the left and "Consumed by" + "Change history"
 * on the right, the "Spend × ROAS scenario guide", and "Where spend sits against
 * these targets". Nothing else belongs to this screen.
 *
 * Every string on this model is already presentation-ready. A fact the providers
 * do not supply arrives as the em dash so the component never has to decide what
 * an absence looks like.
 */

export const TRUTH_DASH = "—";

/** The eight fields the design's target pack renders, in the design's order. */
export type CommercialTruthFieldId =
  | "targetRoas"
  | "breakevenRoas"
  | "grossMargin"
  | "aovFloor"
  | "shippingCost"
  | "paymentFees"
  | "cpaCeiling"
  | "fixedCosts";

export interface CommercialTruthFieldModel {
  id: CommercialTruthFieldId;
  label: string;
  /** Formatted current value, or the em dash when nothing supplies it. */
  value: string;
  hint: string;
  /**
   * The design paints the two ROAS anchors with a #9DB4E8 border and the rest
   * with the neutral #E4E8F0 — that grouping is part of the specification.
   */
  accent: boolean;
  /** False when no write path exists for this field on this workspace. */
  editable: boolean;
}

export interface CommercialTruthStatModel {
  key: string;
  value: string;
}

export interface CommercialTruthSegmentModel {
  key: string;
  /** Formatted share of $100, e.g. "$38". */
  value: string;
  /** CSS width, e.g. "38%". */
  width: string;
  background: string;
}

export interface CommercialTruthConsumerModel {
  dot: string;
  name: string;
  note: string;
  reads: string;
  /** Last observed read. The em dash when the app does not log reads. */
  last: string;
}

export interface CommercialTruthLogEntryModel {
  id: string;
  time: string;
  change: string;
  why: string;
  actor: string;
}

export interface CommercialTruthBandModel {
  name: string;
  tone: string;
  verdict: string;
  count: number;
  range: string;
  spend: string;
  share: string;
}

export interface CommercialTruthSpendRowModel {
  id: string;
  name: string;
  platform: string;
  level: string;
  logo: string;
  spend: string;
  share: string;
  shareWidth: string;
  tone: string;
  revenue: string;
  roas: string;
  roasBackground: string;
  roasForeground: string;
  delta: string;
  deltaForeground: string;
  verdict: string;
  verdictBackground: string;
  verdictForeground: string;
}

export interface CommercialTruthTotalsModel {
  spend: string;
  revenue: string;
  roas: string;
  roasBackground: string;
  roasForeground: string;
  delta: string;
  deltaForeground: string;
  /** Rendered as "vs target {targetRoas}" in the tfoot. */
  targetRoas: string;
}

/**
 * Everything the scenario guide needs to recompute itself as the operator edits
 * spend and ROAS. Null members mean the pack does not supply that economics, in
 * which case the affected rows render the em dash rather than a guess.
 */
export interface CommercialTruthScenarioBasisModel {
  /** Variable costs as a share of revenue (COGS + shipping + fees). */
  variableCostRatio: number | null;
  /** Monthly fixed base, in the workspace currency. */
  fixedCost: number | null;
  targetRoas: number | null;
  /** "COGS 38% + shipping 8% + fees 3%", or the em dash. */
  variableCostSubLabel: string;
  /** "51% of revenue", or the em dash. */
  contributionSubLabel: string;
  /** Spend column defaults, as the design seeds them. */
  defaultSpends: string[];
}

export interface CommercialTruthPackMetaModel {
  /** "last updated {date} by {actor}", or the em dash. */
  lastUpdated: string;
  canEdit: boolean;
  saving: boolean;
  dirty: boolean;
  error: string | null;
}

export interface CommercialTruthExactModel {
  eyebrow: string;
  title: string;
  lede: string;
  bandNote: string;
  stats: CommercialTruthStatModel[];
  fields: CommercialTruthFieldModel[];
  pack: CommercialTruthPackMetaModel;
  segments: CommercialTruthSegmentModel[];
  /** The paragraph under the revenue split, already resolved against real data. */
  splitNote: string;
  consumers: CommercialTruthConsumerModel[];
  log: CommercialTruthLogEntryModel[];
  scenario: CommercialTruthScenarioBasisModel;
  bands: CommercialTruthBandModel[];
  coverage: string;
  spendRows: CommercialTruthSpendRowModel[];
  totals: CommercialTruthTotalsModel;
  /** Formatted unlabeled spend for the closing footnote. */
  unlabeledSpend: string;
  currencyCode: string;
  /**
   * The symbol the money formatter itself prints — "$" for USD, "₺" for TRY.
   *
   * The scenario spend chip is the one place a bare currency marker is drawn
   * next to an input rather than a formatted amount; taking it from the same
   * `Intl` formatter as every cell keeps one notation in one table.
   */
  currencySymbol: string;
}
