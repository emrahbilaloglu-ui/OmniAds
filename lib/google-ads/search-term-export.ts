/**
 * Client-side exports for Google search-term work.
 *
 * Google Ads has no write path in this product, so the analysis here ends in
 * manual transcription: the operator reads a waste list on one screen and
 * retypes it term by term into Google Ads. These helpers turn the same
 * server-derived rows into something that can be pasted or opened in a
 * spreadsheet. They read existing facts and mutate nothing.
 */

export type NegativeMatchType = "broad" | "phrase" | "exact";

export interface SearchTermExportRow {
  searchTerm: string;
  campaignName?: string | null;
  campaignId?: string | null;
  adGroupName?: string | null;
  spend?: number | null;
  conversions?: number | null;
  revenue?: number | null;
  roas?: number | null;
  clicks?: number | null;
  impressions?: number | null;
  recommendation?: string | null;
  wasteFlag?: boolean | null;
  negativeKeywordFlag?: boolean | null;
  keywordOpportunityFlag?: boolean | null;
  matchType?: string | null;
}

export interface SearchTermExportScope {
  businessName?: string | null;
  accountLabel?: string | null;
  currency?: string | null;
  windowStart?: string | null;
  windowEnd?: string | null;
}

function normalizeTerm(term: string): string {
  return term.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Render one term in Google Ads negative-keyword syntax.
 *
 * Broad stays bare, phrase is quoted, exact is bracketed. Any quotes or
 * brackets already inside the term are stripped so the result cannot produce a
 * malformed entry when pasted into the bulk editor.
 */
export function formatNegativeKeyword(term: string, matchType: NegativeMatchType): string {
  const cleaned = normalizeTerm(term).replace(/["[\]]/g, "");
  if (!cleaned) return "";
  if (matchType === "phrase") return `"${cleaned}"`;
  if (matchType === "exact") return `[${cleaned}]`;
  return cleaned;
}

/**
 * Build a paste-ready negative keyword list.
 *
 * Terms are de-duplicated after normalization, because the same query can
 * appear under several campaigns and pasting it twice creates duplicate
 * negatives in the destination account.
 */
export function buildNegativeKeywordList(
  rows: SearchTermExportRow[],
  matchType: NegativeMatchType = "phrase",
): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const row of rows) {
    const formatted = formatNegativeKeyword(row.searchTerm ?? "", matchType);
    if (!formatted || seen.has(formatted)) continue;
    seen.add(formatted);
    lines.push(formatted);
  }
  return lines.join("\n");
}

function csvCell(value: unknown): string {
  if (value == null) return "";
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const CSV_COLUMNS = [
  "search_term",
  "match_type_intent",
  "campaign",
  "campaign_id",
  "ad_group",
  "spend",
  "clicks",
  "impressions",
  "conversions",
  "revenue",
  "roas",
  "reason",
  "waste_flag",
  "opportunity_flag",
  "account",
  "currency",
  "window_start",
  "window_end",
] as const;

/**
 * Build a machine-readable CSV.
 *
 * Numbers are exported as raw values, never as display strings: a spreadsheet
 * cannot sum "$1,234" or "12.5K", and an export that has to be re-typed to be
 * usable is not an export.
 */
export function buildSearchTermCsv(
  rows: SearchTermExportRow[],
  scope: SearchTermExportScope = {},
  matchType: NegativeMatchType = "phrase",
): string {
  const header = CSV_COLUMNS.join(",");
  const body = rows.map((row) =>
    [
      csvCell(normalizeTerm(row.searchTerm ?? "")),
      csvCell(matchType),
      csvCell(row.campaignName),
      csvCell(row.campaignId),
      csvCell(row.adGroupName),
      csvCell(row.spend ?? ""),
      csvCell(row.clicks ?? ""),
      csvCell(row.impressions ?? ""),
      csvCell(row.conversions ?? ""),
      csvCell(row.revenue ?? ""),
      csvCell(row.roas ?? ""),
      csvCell(row.recommendation),
      csvCell(row.wasteFlag === true || row.negativeKeywordFlag === true),
      csvCell(row.keywordOpportunityFlag === true),
      csvCell(scope.accountLabel),
      csvCell(scope.currency),
      csvCell(scope.windowStart),
      csvCell(scope.windowEnd),
    ].join(","),
  );
  return [header, ...body].join("\n");
}

export const SEARCH_TERM_CSV_COLUMNS = CSV_COLUMNS;
