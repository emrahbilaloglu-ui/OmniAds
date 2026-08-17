/**
 * The Insights → Analytics tab, exactly as the v2 design defines it.
 *
 * Design source: `Adsecute Dashboard v2.dc.html` markup lines 1752-1950 and
 * script lines 3903-3971 (`mkU`, `heat`, `anaTabs`, `anaKpis`, `nvCards`,
 * `anaCallouts`, `prodRows`, `landRows`, `chanRows`, `DEMO`, `demoChips`,
 * `demoRows`, `retPill`, `cohortRows`, `monthRows`, `anaOppCards`).
 *
 * Every value on this model is already a rendered string. A fact the provider
 * does not supply is the em-dash, never a zero and never a design seed value.
 */

export type AnalyticsTabId =
  | "overview"
  | "products"
  | "landing"
  | "audience"
  | "demo"
  | "cohorts"
  | "opps";

/** `C` in the design's script (line 3237). */
export type AnalyticsTone = "positive" | "warning" | "negative" | "info" | "neutral";

export interface AnalyticsSubTabModel {
  id: AnalyticsTabId;
  label: string;
  active: boolean;
}

export interface AnalyticsKpiModel {
  key: string;
  /** mono 9.5px uppercase label (design line 1761). */
  label: string;
  /** Space Grotesk 22px/700 value (line 1762). */
  value: string;
  /** 11.5px/600 third line (line 1763). */
  delta: string;
  deltaTone: "positive" | "warning" | "neutral";
}

export interface AnalyticsSegmentCardModel {
  id: "new" | "returning";
  label: string;
  /** Right-aligned pill in the card's header row; absent on the new card. */
  badge: string | null;
  sessions: string;
  engagement: string;
  cvr: string;
  /** The design paints only the better card's CVR green. */
  cvrHighlighted: boolean;
}

export interface AnalyticsCalloutModel {
  id: string;
  /** "Positive" | "Warning" | "Info" — a text chip, not an icon. */
  kind: string;
  tone: AnalyticsTone;
  text: string;
}

export interface AnalyticsProductRowModel {
  id: string;
  name: string;
  views: string;
  addToCart: string;
  checkout: string;
  purchases: string;
  atcRate: string;
  atcHeat: string;
  checkoutRate: string;
  checkoutHeat: string;
  purchaseRate: string;
  purchaseHeat: string;
  revenue: string;
}

export interface AnalyticsSignalModel {
  label: string;
  tone: AnalyticsTone;
}

export interface AnalyticsLandingRowModel {
  id: string;
  page: string;
  sessions: string;
  engagement: string;
  purchases: string;
  cvr: string;
  signal: AnalyticsSignalModel | null;
}

export interface AnalyticsChannelRowModel {
  id: string;
  sourceMedium: string;
  sessions: string;
  engagementRate: string;
  engagementHeat: string;
  purchases: string;
  cvr: string;
  cvrHeat: string;
  revenue: string;
}

export interface AnalyticsDemoChipModel {
  id: string;
  label: string;
  active: boolean;
}

export interface AnalyticsDemoRowModel {
  id: string;
  value: string;
  sessions: string;
  engagementRate: string;
  engagementHeat: string;
  purchases: string;
  cvr: string;
  cvrHeat: string;
  revenue: string;
}

export interface AnalyticsCohortWeekModel {
  id: string;
  week: string;
  newSessions: string;
  returningSessions: string;
  retention: string;
  retentionBg: string;
  retentionFg: string;
  newPurchases: string;
  returningPurchases: string;
}

export interface AnalyticsCohortMonthModel {
  id: string;
  month: string;
  newUsers: string;
  activeUsers: string;
  sessions: string;
  purchases: string;
  cvr: string;
  revenue: string;
}

export interface AnalyticsOpportunityModel {
  id: string;
  /** "Opportunity" | "Strong" | "Warning". */
  kind: string;
  tone: AnalyticsTone;
  title: string;
  description: string;
}

export interface InsightsAnalyticsExactModel {
  tabs: AnalyticsSubTabModel[];
  activeTab: AnalyticsTabId;
  kpis: AnalyticsKpiModel[];
  segments: AnalyticsSegmentCardModel[];
  callouts: AnalyticsCalloutModel[];
  products: AnalyticsProductRowModel[];
  productsNote: string;
  landing: AnalyticsLandingRowModel[];
  landingNote: string;
  channels: AnalyticsChannelRowModel[];
  demoChips: AnalyticsDemoChipModel[];
  demoColumn: string;
  demoSummary: string | null;
  demoRows: AnalyticsDemoRowModel[];
  cohortWeeks: AnalyticsCohortWeekModel[];
  cohortMonths: AnalyticsCohortMonthModel[];
  opportunities: AnalyticsOpportunityModel[];
}
