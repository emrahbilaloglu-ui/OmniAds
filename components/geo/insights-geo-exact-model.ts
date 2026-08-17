/**
 * The Insights → AI Visibility (GEO) tab, exactly as the v2 design defines it.
 *
 * Design source: `Adsecute Dashboard v2.dc.html` markup lines 2121-2319 (the
 * `insGEO` block: the explainer band, the sub-tab strip, all six sub-tab bodies
 * and the always-on methodology accordion) and script lines 4028-4095
 * (`geoTabs`, `geoKpis`, `geoPris`, `geoHls`, `geoCallouts`, `EC`/`VAL`/`MOM`,
 * `gsrc`/`geoSourceRows`, `scorePill`/`geoPageRows2`, `GQ`/`geoFilters`/`dotC`/
 * `geoQRows`, `covC`/`geoTopics`, `geoPlays`, `methodPs`).
 *
 * Every value on this model is already a rendered string. A fact no provider
 * supplies is the em-dash — never a zero and never a design seed value.
 */

export type GeoTabId = "overview" | "sources" | "pages" | "queries" | "topics" | "plays";

/** `C` in the design's script (line 3237) plus the violet `auto` ramp. */
export type GeoTone =
  | "positive"
  | "warning"
  | "negative"
  | "info"
  | "violet"
  | "neutral";

export interface GeoSubTabModel {
  id: GeoTabId;
  label: string;
  active: boolean;
}

/** L2130-2136 — six stat cards; the score card gets the blue-tinted body. */
export interface GeoKpiModel {
  key: string;
  label: string;
  value: string;
  sub: string;
  subTone: GeoTone;
  /** Only the GEO opportunity score card is highlighted (script L4032). */
  highlighted: boolean;
}

/** L2138-2142 — "N of M ranking queries have AI / answer intent". */
export interface GeoIntentBandModel {
  aiQueries: string;
  totalQueries: string;
  /** CSS width for the violet fill, e.g. "18.6%" — "0%" when unknown. */
  barWidth: string;
}

/** L2143-2151 — the three priority cards. */
export interface GeoPriorityModel {
  id: string;
  priorityLabel: string;
  tone: GeoTone;
  title: string;
  detail: string;
  impact: string;
  effort: string;
}

/** L2153-2163 — the three highlight cards. */
export interface GeoHighlightModel {
  id: string;
  label: string;
  tone: GeoTone;
  main: string;
  pill: string;
  sub: string;
}

/** L2165-2172 — the callout row, same shape as the Analytics tab's. */
export interface GeoCalloutModel {
  id: string;
  kind: string;
  tone: GeoTone;
  text: string;
}

/** L2174-2196 — the nine-column AI traffic sources table. */
export interface GeoSourceRowModel {
  id: string;
  engine: string;
  engineTone: GeoTone;
  /** "elite · 82" — the real value label and score (script L4054-4061). */
  value: string;
  valueTone: GeoTone;
  momentum: string;
  momentumTone: GeoTone;
  sessions: string;
  engagement: string;
  engagementHeat: string;
  purchases: string;
  cvr: string;
  cvrHeat: string;
  revenue: string;
  recommendation: string;
}

/** L2197-2216 — the six-column AI content winners table. */
export interface GeoPageRowModel {
  id: string;
  page: string;
  aiSessions: string;
  engagement: string;
  cvr: string;
  /** "AIV 84" (script L4063). */
  score: string;
  scoreTone: GeoTone;
  /** The design's "Sourced by" column: the engines that referred this page. */
  sourcedBy: string;
}

export interface GeoQueryFilterModel {
  id: string;
  label: string;
  count: string;
  active: boolean;
}

export interface GeoScoreBarModel {
  key: string;
  label: string;
  value: string;
  width: string;
}

/** L2217-2250 — the eight-column query intelligence table. */
export interface GeoQueryRowModel {
  id: string;
  /** Priority dot colour tier — `dotC`, script L4075. */
  priorityTone: GeoTone;
  query: string;
  /** "✦ " when the query is answer-engine shaped, else "". */
  star: string;
  /** "Informational · How-to" — intent and format in one badge. */
  intent: string;
  intentTone: GeoTone;
  momentum: string;
  momentumTone: GeoTone;
  score: string;
  scoreTone: GeoTone;
  bars: GeoScoreBarModel[];
  impressions: string;
  ctr: string;
  position: string;
  positionTone: GeoTone;
  recommendation: string;
}

export interface GeoTopicModel {
  id: string;
  topic: string;
  coverage: string;
  coverageTone: GeoTone;
  momentum: string;
  momentumTone: GeoTone;
  priority: string;
  priorityTone: GeoTone;
  /** "↑ High gap" / "↗ Gap opp" / "" (script L4078-4083). */
  gap: string;
  gapTone: GeoTone;
  queryCount: string;
  /** Coverage bar width relative to the strongest cluster's impressions. */
  barWidth: string;
  chips: string[];
  recommendationTitle: string;
  recommendationImpact: string;
  recommendationEffort: string;
  score: string;
  scoreTone: GeoTone;
  impressions: string;
  clicks: string;
  position: string;
  authority: string;
}

export interface GeoPlayChipModel {
  label: string;
  tone: GeoTone;
}

export interface GeoPlayModel {
  id: string;
  ordinal: string;
  title: string;
  why: string;
  outcome: string;
  chips: GeoPlayChipModel[];
}

/** L2306-2318 — four paragraphs, each a bold lead plus the rest. */
export interface GeoMethodologyParagraphModel {
  id: string;
  lead: string;
  rest: string;
}

export interface InsightsGeoExactModel {
  tabs: GeoSubTabModel[];
  activeTab: GeoTabId;
  kpis: GeoKpiModel[];
  intentBand: GeoIntentBandModel;
  priorities: GeoPriorityModel[];
  highlights: GeoHighlightModel[];
  callouts: GeoCalloutModel[];
  sources: GeoSourceRowModel[];
  pages: GeoPageRowModel[];
  filters: GeoQueryFilterModel[];
  queries: GeoQueryRowModel[];
  /** The footnote's "counts reflect the full N-query dataset". */
  queryDatasetSize: string;
  topics: GeoTopicModel[];
  plays: GeoPlayModel[];
  methodology: GeoMethodologyParagraphModel[];
}
