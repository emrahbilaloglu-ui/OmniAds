/**
 * The Insights screen's outer chrome, as the v2 design defines it.
 *
 * Design source: `Adsecute Dashboard v2.dc.html` markup lines 1735-1751 (the
 * page head and the outer pill row) and script line 3902
 * (`insSections = mkTabs([['analytics','Analytics'],['seo','SEO Intelligence'],
 * ['geo','AI Visibility']], …)`), whose array order *is* the tab order.
 */

export type InsightsSectionId = "analytics" | "seo" | "geo";

export type InsightsSourceProvider = "ga4" | "search_console";

export type InsightsSourceTone = "positive" | "warning" | "neutral";

export interface InsightsSectionTabModel {
  id: InsightsSectionId;
  label: string;
  href: string;
  active: boolean;
}

export interface InsightsSourceChipModel {
  id: InsightsSourceProvider;
  label: string;
  /** 14×14 platform mark, first child of the chip (design line 1742-1743). */
  iconSrc: string;
  /** The real connection state — never a hardcoded "connected". */
  stateLabel: string;
  tone: InsightsSourceTone;
}

export interface InsightsShellExactModel {
  eyebrow: string;
  title: string;
  tabs: InsightsSectionTabModel[];
  sources: InsightsSourceChipModel[];
}
