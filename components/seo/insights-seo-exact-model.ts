/**
 * The Insights → SEO Intelligence tab, exactly as the v2 design defines it.
 *
 * Design source: `Adsecute Dashboard v2.dc.html` markup lines 1951-2119 (the
 * `insSEO` block: the KPI band, the sub-tab strip and all six sub-tab bodies)
 * and script lines 3968-4027 (`seoTabs2`, `seoKpis`, `seoAiReads`,
 * `seoAiChanged`, `seoAiCauses`, `seoAiPlan`, `mv`/`seoMovers`,
 * `seoQueryRows`, `seoPageRows`, `seoActionGroups`, `seoTechCards`,
 * `seoExcluded`, `seoFindings`).
 *
 * Every value on this model is already a rendered string. A fact the provider
 * does not supply is the em-dash — never a zero and never a design seed value.
 */

export type SeoTabId =
  | "ai"
  | "traffic"
  | "queries"
  | "pages"
  | "actions"
  | "technical";

/** `C` in the design's script (line 3237). */
export type SeoTone = "positive" | "warning" | "negative" | "info" | "neutral";

export interface SeoSubTabModel {
  id: SeoTabId;
  label: string;
  active: boolean;
}

/** L1955-1960 — label, big value, delta pill, mono "prev N" line. */
export interface SeoKpiModel {
  key: string;
  label: string;
  value: string;
  delta: string;
  deltaTone: SeoTone;
  previous: string;
}

/** L1971-1979 — the Monthly AI card's head. */
export interface SeoMonthlyHeadModel {
  title: string;
  /** The real analysis status word: "available" / "not generated" / "failed". */
  statusLabel: string;
  statusTone: SeoTone;
  /** mono meta line: generated … · window … · saved as the team's planning artifact */
  meta: string;
  /** The disabled right-hand chip (L1979). */
  cadence: string;
  /**
   * Replaces the cadence chip when — and only when — no analysis exists for
   * this window and the server allows a run. `null` in the state the design
   * draws.
   */
  generate: SeoMonthlyGenerateModel | null;
}

/**
 * The pre-generation control.
 *
 * The design draws only the state *after* a monthly analysis exists, so it
 * models no generate affordance at all — its cadence chip (L1979) is
 * `cursor:not-allowed` and is therefore not the trigger. This control takes
 * that chip's slot and geometry and is present **only** in a state the design
 * never draws: the analysis for the current window has not been produced (or
 * failed) and the server says a run is allowed. Whenever an analysis exists,
 * this is `null` and the design's own disabled cadence chip renders unchanged.
 */
export interface SeoMonthlyGenerateModel {
  label: string;
}

export interface SeoNumberedItemModel {
  id: string;
  /** "01", "02", … (L4100). */
  ordinal: string;
  text: string;
}

/** L1969-2009 — the whole Monthly AI body. */
export interface SeoMonthlyModel {
  head: SeoMonthlyHeadModel;
  /** The mono "reads" chips (L1981-1983). */
  reads: string[];
  /** The 14.5px/600 lead paragraph (L1985). */
  summary: string;
  whatChanged: string[];
  likelyCauses: string[];
  plan: SeoNumberedItemModel[];
}

export interface SeoMoverRowModel {
  id: string;
  label: string;
  current: string;
  delta: string;
  deltaTone: SeoTone;
}

export interface SeoMoverCardModel {
  id: string;
  title: string;
  rows: SeoMoverRowModel[];
}

export interface SeoQueryRowModel {
  id: string;
  query: string;
  clicks: string;
  impressions: string;
  ctr: string;
  position: string;
  /** The design's "Δ pos" chip — positive means the query moved up. */
  positionDelta: string;
  positionDeltaTone: SeoTone;
}

export interface SeoPageRowModel {
  id: string;
  page: string;
  clicks: string;
  impressions: string;
  ctr: string;
  position: string;
}

export interface SeoActionItemModel {
  id: string;
  title: string;
  why: string;
  impact: string;
  effort: string;
}

export interface SeoActionGroupModel {
  id: string;
  /** "Quick wins" / "Strategic" / "Supporting" (script L4003-4012). */
  tone: SeoTone;
  toneLabel: string;
  items: SeoActionItemModel[];
}

export interface SeoTechCardModel {
  key: string;
  label: string;
  value: string;
  tone: SeoTone;
}

export interface SeoExcludedRowModel {
  id: string;
  url: string;
  reason: string;
  tone: SeoTone;
}

export interface SeoFindingModel {
  id: string;
  severity: string;
  tone: SeoTone;
  title: string;
  detail: string;
}

export interface SeoTechnicalModel {
  cards: SeoTechCardModel[];
  /** "URL Inspection · 5 of 5" (L2097) — absent when never measured. */
  inspectionHint: string;
  excluded: SeoExcludedRowModel[];
  findings: SeoFindingModel[];
}

export interface InsightsSeoExactModel {
  tabs: SeoSubTabModel[];
  activeTab: SeoTabId;
  kpis: SeoKpiModel[];
  monthly: SeoMonthlyModel;
  movers: SeoMoverCardModel[];
  queries: SeoQueryRowModel[];
  pages: SeoPageRowModel[];
  actionGroups: SeoActionGroupModel[];
  technical: SeoTechnicalModel;
}
