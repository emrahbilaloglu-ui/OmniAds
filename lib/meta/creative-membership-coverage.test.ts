import { expect, it } from "vitest";
import { buildCreativeMembershipCoverage } from "./creative-membership-coverage";
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
