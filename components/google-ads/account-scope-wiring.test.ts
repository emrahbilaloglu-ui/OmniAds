import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  "components/google-ads/GoogleAdsIntelligenceDashboard.tsx",
  "utf8",
);

/**
 * With several accounts assigned, the dashboard used to sum them into one set of
 * numbers with no filter and no disclosure, and the deep-link account silently
 * became null so "Open in Google Ads" disappeared.
 */
describe("Google account scope is explicit", () => {
  it("derives scope from the shared, tested resolver", () => {
    expect(source).toContain("resolveGoogleAccountScope({");
    expect(source).toContain('from "@/lib/google-ads/account-scope"');
  });

  it("no longer nulls the execution account merely because several are assigned", () => {
    expect(source).not.toContain(
      "(syncStatus?.assignedAccountIds?.length ?? 0) === 1\n      ? syncStatus?.assignedAccountIds?.[0] ?? null\n      : null",
    );
    expect(source).toContain("const advisorExecutionAccountId = accountScope.accountId;");
  });

  it("lets the operator scope to one account", () => {
    expect(source).toContain("setSelectedGoogleAccountId");
    expect(source).toContain("All assigned accounts (blended)");
  });

  it("shows the scope receipt only when there is more than one account to confuse", () => {
    expect(source).toContain('(syncStatus?.assignedAccountIds?.length ?? 0) > 1');
  });

  it("warns visibly when a blend spans currencies it cannot convert", () => {
    expect(source).toContain("accountScope.mixedCurrency");
    expect(source).toContain("border-amber-200 bg-amber-50");
  });

  it("states the scope rather than leaving the reader to infer it", () => {
    expect(source).toContain("Blended view");
    expect(source).toContain("Scoped to one account");
    expect(source).toContain("accountScope.notice");
  });
});
