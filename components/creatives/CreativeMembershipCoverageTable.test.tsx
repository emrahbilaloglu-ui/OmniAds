import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { CreativeMembershipCoverageTable } from "./CreativeMembershipCoverageTable";
import { buildCreativeMembershipCoverage } from "@/lib/meta/creative-membership-coverage";
const scope = { businessId: "biz_1", providerAccountId: "act_1", startDate: "2026-09-18", endDate: "2026-09-19" };
const coverage = buildCreativeMembershipCoverage({ ...scope, verified: [], provisional: [], withheld: [{ date: scope.startDate, accountCurrency: "USD", spend: 19, conversions: 2 }] });
it("renders withheld economics separately with a missing observation instead of zero", () => {
  const html = renderToStaticMarkup(<CreativeMembershipCoverageTable {...scope} coverage={coverage} />);
  expect(html).toContain("19 / 2");
  expect(html).toContain("cannot be assigned to this creative");
  expect(html).toContain("0 · — / —");
  expect(html).toContain("2026-09-19");
});
it.each([{ businessId: "biz_2" }, { providerAccountId: "act_2" }, { startDate: "2026-09-17" }, { endDate: "2026-09-20" }])("hides another scope's retained coverage %j", (other) => {
  expect(renderToStaticMarkup(<CreativeMembershipCoverageTable {...scope} {...other} coverage={coverage} />)).toBe("");
});
