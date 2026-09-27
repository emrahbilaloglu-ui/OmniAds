import { reportingDayCount } from "./reporting-period";

type SourceDay = { date: string; accountCurrency: string; spend: number; conversions: number };
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
