import { expect, it } from "vitest";
import { buildCreativeMembershipCoverage, buildCreativeWindowCoverage, creativeWindowCoverageText } from "./creative-membership-coverage";
const scope = { businessId: "biz_1", providerAccountId: "act_1", startDate: "2026-09-18", endDate: "2026-09-20" };
it("reconciles verified, withheld and missing days without assigning unknown membership or inventing zero", () => {
  const coverage = buildCreativeMembershipCoverage({ ...scope,
    verified: [{ date: "2026-09-18", accountCurrency: "USD", spend: 38.01, conversions: 0 }], provisional: [],
    withheld: [{ date: "2026-09-19", accountCurrency: "USD", spend: 109.26, conversions: 2 }] });
  expect(coverage.days).toMatchObject([
    { verifiedSpend: 38.01, verifiedPurchases: 0, withheldSpend: null },
    { verifiedSpend: null, verifiedPurchases: null, withheldSpend: 109.26, withheldPurchases: 2 },
    { verifiedRows: 0, withheldRows: 0, verifiedSpend: null, withheldSpend: null },
  ]);
});
it("keeps currencies and provisional membership separate", () => {
  const coverage = buildCreativeMembershipCoverage({ ...scope, verified: [{ date: scope.startDate, accountCurrency: "USD", spend: 0, conversions: 0 }], withheld: [],
    provisional: [{ date: scope.startDate, accountCurrency: "TRY", spend: 25, conversions: 1 }] });
  expect(coverage.days[0]).toMatchObject({ currency: "USD", verifiedSpend: 0, provisionalSpend: null });
  expect(coverage.days[1]).toMatchObject({ currency: "TRY", verifiedSpend: null, provisionalSpend: 25 });
});
it("does not total missing or nonfinite metrics and bounds date expansion", () => {
  expect(buildCreativeMembershipCoverage({ ...scope, verified: [{ date: scope.startDate, accountCurrency: "USD", spend: NaN, conversions: undefined as never }], withheld: [], provisional: [] }).days[0]).toMatchObject({ verifiedSpend: null, verifiedPurchases: null });
  expect(buildCreativeMembershipCoverage({ ...scope, startDate: "2000-01-01", verified: [], withheld: [], provisional: [] }).days).toEqual([]);
});

it("qualifies a seven-day creative total with five verified days and two unknown days", () => {
  const c = buildCreativeWindowCoverage({ ...scope, creativeId: "crt_1", startDate: "2026-09-29", endDate: "2026-10-05",
    verified: ["2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-05"].map((date) => ({ date, updatedAt: "2026-10-06T22:40:10.787Z" })), provisional: [], withheld: [] });
  expect(c).toMatchObject({ requestedDays: 7, verifiedDays: 5, unknownDays: 2, unknownDates: ["2026-09-29", "2026-10-04"],
    verifiedAbsentDays: 0, totalsBasis: "verified_creative_days", sourceObservedAt: "2026-10-06T22:40:10.787Z" });
  expect(creativeWindowCoverageText(c)).toContain("5/7 creative days verified · 2 unknown (2026-09-29, 2026-10-04)");
});
it("never treats other-Ad delivery or complete source IDs as dated creative absence", () => {
  const c = buildCreativeWindowCoverage({ ...scope, creativeId: "crt_1", verified: [], provisional: [], withheld: [] });
  expect(c).toMatchObject({ verifiedDays: 0, unknownDays: 3, verifiedAbsentDays: 0, sourceObservedAt: null });
  expect(c).not.toHaveProperty("spend");
});
it("keeps mixed verified/withheld and provisional days out of verified-day coverage", () => {
  const c = buildCreativeWindowCoverage({ ...scope, creativeId: "crt_1", verified: [{ date: scope.startDate }],
    withheld: [{ date: scope.startDate }], provisional: [{ date: "2026-09-19" }] });
  expect(c).toMatchObject({ requestedDays: 3, verifiedDays: 0, withheldDays: 1, provisionalDays: 1, unknownDays: 1,
    totalsBasis: "verified_and_provisional_creative_days", sourceObservedAt: null });
  expect(creativeWindowCoverageText(undefined)).toContain("unknown");
});
