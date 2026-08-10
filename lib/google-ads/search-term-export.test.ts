import { describe, expect, it } from "vitest";
import {
  buildNegativeKeywordList,
  buildSearchTermCsv,
  formatNegativeKeyword,
  SEARCH_TERM_CSV_COLUMNS,
  type SearchTermExportRow,
} from "@/lib/google-ads/search-term-export";

const rows: SearchTermExportRow[] = [
  {
    searchTerm: "free backpack",
    campaignName: "Generic Search",
    campaignId: "c-1",
    spend: 82.4,
    clicks: 140,
    impressions: 5300,
    conversions: 0,
    revenue: 0,
    roas: 0,
    recommendation: "Add as negative",
    wasteFlag: true,
  },
  {
    searchTerm: "  Free   Backpack ",
    campaignName: "Brand",
    campaignId: "c-2",
    spend: 12,
    conversions: 0,
    wasteFlag: true,
  },
  {
    searchTerm: 'cheap "travel" bag',
    campaignName: "Generic Search",
    campaignId: "c-1",
    spend: 40.5,
    conversions: 1,
    revenue: 30,
    roas: 0.74,
    negativeKeywordFlag: true,
  },
];

describe("formatNegativeKeyword", () => {
  it("renders each match type in the syntax Google Ads expects", () => {
    expect(formatNegativeKeyword("free backpack", "broad")).toBe("free backpack");
    expect(formatNegativeKeyword("free backpack", "phrase")).toBe('"free backpack"');
    expect(formatNegativeKeyword("free backpack", "exact")).toBe("[free backpack]");
  });

  it("cannot emit a malformed entry from a term containing quotes or brackets", () => {
    expect(formatNegativeKeyword('cheap "travel" bag', "phrase")).toBe('"cheap travel bag"');
    expect(formatNegativeKeyword("[boots]", "exact")).toBe("[boots]");
  });

  it("normalizes spacing and case so pasted lists are consistent", () => {
    expect(formatNegativeKeyword("  Free   Backpack ", "phrase")).toBe('"free backpack"');
  });

  it("drops a term that is empty once cleaned", () => {
    expect(formatNegativeKeyword('  ""  ', "phrase")).toBe("");
    expect(formatNegativeKeyword("", "broad")).toBe("");
  });
});

describe("buildNegativeKeywordList", () => {
  it("produces a paste-ready list, one term per line", () => {
    const list = buildNegativeKeywordList(rows, "phrase");
    expect(list.split("\n")).toEqual(['"free backpack"', '"cheap travel bag"']);
  });

  it("de-duplicates the same query appearing under several campaigns", () => {
    const list = buildNegativeKeywordList(rows, "phrase");
    expect(list.split("\n").filter((line) => line === '"free backpack"')).toHaveLength(1);
  });

  it("preserves the requested match-type intent", () => {
    expect(buildNegativeKeywordList(rows, "exact").split("\n")[0]).toBe("[free backpack]");
    expect(buildNegativeKeywordList(rows, "broad").split("\n")[0]).toBe("free backpack");
  });

  it("returns an empty string rather than a stray newline for no rows", () => {
    expect(buildNegativeKeywordList([], "phrase")).toBe("");
  });
});

describe("buildSearchTermCsv", () => {
  it("exports raw numeric values a spreadsheet can actually sum", () => {
    const csv = buildSearchTermCsv(rows, {}, "phrase");
    const firstRow = csv.split("\n")[1];
    expect(firstRow).toContain("82.4");
    expect(firstRow).not.toContain("$");
    expect(firstRow).not.toContain("K");
  });

  it("carries scope and window metadata so the export is self-describing", () => {
    const csv = buildSearchTermCsv(rows, {
      accountLabel: "122-487-7195",
      currency: "USD",
      windowStart: "2026-07-01",
      windowEnd: "2026-07-28",
    });
    expect(csv).toContain("122-487-7195");
    expect(csv).toContain("2026-07-01");
    expect(csv).toContain("2026-07-28");
    expect(csv).toContain("USD");
  });

  it("includes reason and flag columns, not just the term", () => {
    expect(SEARCH_TERM_CSV_COLUMNS).toContain("reason");
    expect(SEARCH_TERM_CSV_COLUMNS).toContain("waste_flag");
    expect(SEARCH_TERM_CSV_COLUMNS).toContain("match_type_intent");
    expect(buildSearchTermCsv(rows).split("\n")[1]).toContain("Add as negative");
  });

  it("escapes a term containing a comma or quote without breaking the row", () => {
    const csv = buildSearchTermCsv(
      [{ searchTerm: 'bag, "large"', spend: 1 }],
      {},
    );
    const dataRow = csv.split("\n")[1];
    expect(dataRow.startsWith('"bag, ""large"""')).toBe(true);
    expect(csv.split("\n")).toHaveLength(2);
  });

  it("emits a header even with no rows so the file is still valid", () => {
    const csv = buildSearchTermCsv([]);
    expect(csv).toBe(SEARCH_TERM_CSV_COLUMNS.join(","));
  });
});
