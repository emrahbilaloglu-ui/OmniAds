import { reportingDayCount } from "./reporting-period";

type SourceDay = { date: string; accountCurrency: string; spend: number; conversions: number };
export interface CreativeWindowCoverage {
  businessId: string; providerAccountId: string; creativeId: string;
  startDate: string; endDate: string;
  requestedDays: number | null;
  verifiedDays: number; unknownDays: number; withheldDays: number;
  provisionalDays: number; verifiedAbsentDays: number;
  unknownDates: string[];
  totalsBasis: "verified_creative_days" | "verified_and_provisional_creative_days";
  sourceObservedAt: string | null;
}

/** Coverage is about dated creative membership, not whether an Ad/account has
 * rows. No absent-day claim can be made without a separate dated proof. */
export function buildCreativeWindowCoverage(input: {
  businessId: string; providerAccountId: string; creativeId: string;
  startDate: string; endDate: string;
  verified: readonly { date: string; updatedAt?: string }[];
  provisional: readonly { date: string; updatedAt?: string }[];
  withheld: readonly { date: string; updatedAt?: string }[];
}): CreativeWindowCoverage {
  const span = reportingDayCount(input.startDate, input.endDate);
  const bounded = span !== null && span <= 366;
  const sets = [input.verified, input.provisional, input.withheld].map((rows) => new Set(rows.map((row) => row.date)));
  let verifiedDays = 0, provisionalDays = 0, withheldDays = 0;
  const unknownDates: string[] = [];
  if (bounded) for (let i = 0; i < span; i += 1) {
    const date = new Date(Date.parse(input.startDate + "T00:00:00Z") + i * 86_400_000).toISOString().slice(0, 10);
    if (sets[2]!.has(date)) withheldDays += 1;
    else if (sets[1]!.has(date)) provisionalDays += 1;
    else if (sets[0]!.has(date)) verifiedDays += 1;
    else unknownDates.push(date);
  }
  const observed = [...input.verified, ...input.provisional, ...input.withheld]
    .filter((row) => row.date >= input.startDate && row.date <= input.endDate)
    .map((row) => Date.parse(row.updatedAt ?? "")).filter(Number.isFinite);
  return { businessId: input.businessId, providerAccountId: input.providerAccountId, creativeId: input.creativeId,
    startDate: input.startDate, endDate: input.endDate, requestedDays: bounded ? span : null,
    verifiedDays, provisionalDays, withheldDays, unknownDays: unknownDates.length, unknownDates,
    // This reader has no creative absence receipts. Missing is never absent.
    verifiedAbsentDays: 0,
    totalsBasis: provisionalDays ? "verified_and_provisional_creative_days" : "verified_creative_days",
    sourceObservedAt: observed.length ? new Date(Math.max(...observed)).toISOString() : null };
}

export function creativeWindowCoverageText(c: CreativeWindowCoverage | undefined): string {
  if (!c || c.requestedDays === null) return "Creative-day coverage unknown; totals cover available source rows only.";
  return `${c.verifiedDays}/${c.requestedDays} creative days verified · ${c.unknownDays} unknown${c.unknownDates.length ? ` (${c.unknownDates.join(", ")})` : ""}${c.withheldDays ? ` · ${c.withheldDays} withheld` : ""}${c.provisionalDays ? ` · ${c.provisionalDays} provisional` : ""}. Totals cover ${c.totalsBasis === "verified_creative_days" ? "verified creative days" : "verified and provisional creative days"} only.`;
}
export interface CreativeMembershipCoverage {
  businessId: string;
  providerAccountId: string;
  startDate: string;
  endDate: string;
  basis: "source_rows_before_format_filter";
  days: Array<{
    date: string; currency: string | null;
    verifiedRows: number; provisionalRows: number; withheldRows: number;
    verifiedSpend: number | null; provisionalSpend: number | null; withheldSpend: number | null;
    verifiedPurchases: number | null; provisionalPurchases: number | null; withheldPurchases: number | null;
  }>;
}

/** Withheld amounts describe candidate source rows, never an attributed
 * creative total. Empty/missing observations are null, not measured zero. */
export function buildCreativeMembershipCoverage(input: {
  businessId: string; providerAccountId: string; startDate: string; endDate: string;
  verified: readonly SourceDay[]; provisional: readonly SourceDay[]; withheld: readonly SourceDay[];
}): CreativeMembershipCoverage {
  const span = reportingDayCount(input.startDate, input.endDate);
  const days: CreativeMembershipCoverage["days"] = [];
  const sum = (rows: readonly SourceDay[], field: "spend" | "conversions") =>
    rows.length && rows.every((row) => typeof row[field] === "number" && Number.isFinite(row[field]) && row[field] >= 0)
      ? rows.reduce((total, row) => total + row[field], 0) : null;
  // Report API ranges are bounded; never expand an arbitrary date into memory.
  if (span !== null && span <= 366) for (let i = 0; i < span; i += 1) {
    const date = new Date(Date.parse(input.startDate + "T00:00:00Z") + i * 86_400_000).toISOString().slice(0, 10);
    const groups = [input.verified, input.provisional, input.withheld].map((rows) => rows.filter((row) => row.date === date));
    const currencies = [...new Set(groups.flat().map((row) => row.accountCurrency || null))];
    for (const currency of currencies.length ? currencies : [null]) {
      const [verified, provisional, withheld] = groups.map((rows) => rows.filter((row) => (row.accountCurrency || null) === currency));
      days.push({ date, currency, verifiedRows: verified!.length, provisionalRows: provisional!.length, withheldRows: withheld!.length,
        verifiedSpend: sum(verified!, "spend"), provisionalSpend: sum(provisional!, "spend"), withheldSpend: sum(withheld!, "spend"),
        verifiedPurchases: sum(verified!, "conversions"), provisionalPurchases: sum(provisional!, "conversions"), withheldPurchases: sum(withheld!, "conversions") });
    }
  }
  return { businessId: input.businessId, providerAccountId: input.providerAccountId, startDate: input.startDate, endDate: input.endDate,
    basis: "source_rows_before_format_filter", days };
}
