/**
 * The typed report source catalog (H37–H40).
 *
 * Read from the vendored `report-catalog.json`, not restated from memory:
 * **exactly 5 renderable sources and 4 coming-soon**, nine rows total. The
 * counts are asserted, because a source silently added or dropped changes what
 * a report can claim to contain.
 *
 * Rules the catalog itself encodes:
 *
 * - A coming-soon source is **disabled, never hidden**. Hiding it would let a
 *   buyer conclude the data does not exist rather than that it is not wired.
 * - Search Console and Klaviyo are separate rows and must never be merged.
 * - CSV is table-only. Exporting a metric card or a trend line produces a file
 *   whose shape does not match what the operator was looking at.
 */

export type SourceKind = "renderable" | "coming_soon";

export interface ReportSource {
  id: string;
  label: string;
  kind: SourceKind;
  /** Widget grammar, from the catalog. Empty for coming-soon rows. */
  widget: string;
  emptyGrammar: string | null;
  errorGrammar: string | null;
  /** Exact server copy for an unavailable source. */
  reason: string | null;
  /** Only table widgets may be exported. */
  csvEligible: boolean;
}

/** The nine catalog rows, in catalog order. */
export const REPORT_SOURCES: readonly ReportSource[] = [
  {
    id: "overview_summary",
    label: "Overview — summary",
    kind: "renderable",
    widget: "metric cards",
    emptyGrammar:
      "No summary rows served for this window — widget renders the empty grammar, never zeros.",
    errorGrammar: "Summary source failed — per-widget error + retry; the page never blanks.",
    reason: null,
    csvEligible: false,
  },
  {
    id: "overview_trend",
    label: "Overview — trend",
    kind: "renderable",
    widget: "trend line/bars",
    emptyGrammar: "No trend points served — axis renders with 'no data in window' note.",
    errorGrammar: "Trend source failed — error + retry inside the widget frame.",
    reason: null,
    csvEligible: false,
  },
  {
    id: "channel_attribution",
    label: "Channel attribution",
    kind: "renderable",
    widget: "attribution table",
    emptyGrammar: "No attributed channels in this window — table renders header + empty grammar.",
    errorGrammar: "Attribution source failed — error + retry; other widgets unaffected.",
    reason: null,
    csvEligible: true,
  },
  {
    id: "meta_campaigns",
    label: "Meta campaigns",
    kind: "renderable",
    widget: "campaign table (CSV-eligible)",
    emptyGrammar: "No Meta campaigns served for the selected account/window.",
    errorGrammar: "Meta campaign source failed — error + retry per widget.",
    reason: null,
    csvEligible: true,
  },
  {
    id: "google_campaigns",
    label: "Google campaigns",
    kind: "renderable",
    widget: "campaign table (CSV-eligible)",
    emptyGrammar: "No Google campaigns served — requires a connected, assigned Google Ads account.",
    errorGrammar: "Google campaign source failed — error + retry per widget.",
    reason: null,
    csvEligible: true,
  },
  {
    id: "shopify_data",
    label: "Shopify",
    kind: "coming_soon",
    widget: "—",
    emptyGrammar: null,
    errorGrammar: null,
    reason: "Coming soon",
    csvEligible: false,
  },
  {
    id: "ga4_data",
    label: "GA4",
    kind: "coming_soon",
    widget: "—",
    emptyGrammar: null,
    errorGrammar: null,
    reason: "Coming soon",
    csvEligible: false,
  },
  {
    id: "search_console_data",
    label: "Search Console",
    kind: "coming_soon",
    widget: "—",
    emptyGrammar: null,
    errorGrammar: null,
    reason: "Coming soon",
    csvEligible: false,
  },
  {
    id: "klaviyo_data",
    label: "Klaviyo",
    kind: "coming_soon",
    widget: "—",
    emptyGrammar: null,
    errorGrammar: null,
    reason: "Coming soon",
    csvEligible: false,
  },
];

export const RENDERABLE_SOURCES = REPORT_SOURCES.filter((s) => s.kind === "renderable");
export const COMING_SOON_SOURCES = REPORT_SOURCES.filter((s) => s.kind === "coming_soon");

export function sourceById(id: string): ReportSource | null {
  return REPORT_SOURCES.find((source) => source.id === id) ?? null;
}

/**
 * Whether a source may be added to a report.
 *
 * Coming-soon rows are selectable-but-refused so the operator learns the source
 * exists and is not yet wired, which is a different fact from it not existing.
 */
export function canAddSource(id: string): { ok: true } | { ok: false; reason: string } {
  const source = sourceById(id);
  if (!source) return { ok: false, reason: "That source is not in the catalog." };
  if (source.kind === "coming_soon") {
    return { ok: false, reason: `${source.label}: ${source.reason}` };
  }
  return { ok: true };
}

/** CSV is table-only; a card or a chart has no rows to export. */
export function canExportCsv(id: string): { ok: true } | { ok: false; reason: string } {
  const source = sourceById(id);
  if (!source) return { ok: false, reason: "That source is not in the catalog." };
  if (!source.csvEligible) {
    return {
      ok: false,
      reason: `${source.label} is not a table. CSV export would produce a file that does not match what you are looking at.`,
    };
  }
  return { ok: true };
}

/* --------------------------------------------------------- safe breakdowns */

/**
 * Breakdowns that cannot be aggregated without double counting.
 *
 * Summing a metric across a breakdown that shares entities inflates it. The
 * control is disabled with the reason rather than silently producing a total
 * nobody can reconcile.
 */
export const UNSAFE_AGGREGATE_BREAKDOWNS = ["placement", "device", "age_gender", "country"] as const;

export function canAggregate(breakdown: string): { ok: true } | { ok: false; reason: string } {
  if ((UNSAFE_AGGREGATE_BREAKDOWNS as readonly string[]).includes(breakdown)) {
    return {
      ok: false,
      reason: `Totals across ${breakdown} would double count: one entity appears in more than one row.`,
    };
  }
  return { ok: true };
}
