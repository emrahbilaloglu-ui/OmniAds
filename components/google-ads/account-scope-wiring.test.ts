import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  "components/google-ads/GoogleAdsIntelligenceDashboard.tsx",
  "utf8",
);

/**
 * Canonical `/c` and `/app` routes now carry one server-authorized account. The
 * preserved legacy entry may still expose its explicit picker, but it cannot
 * replace canonical scope or silently choose the first account in a portfolio.
 */
describe("Google account scope is explicit", () => {
  it("derives scope from the shared, tested resolver", () => {
    expect(source).toContain("resolveGoogleAccountScope({");
    expect(source).toContain('from "@/lib/google-ads/account-scope"');
  });

  it("treats server scope presence, including null, as authoritative", () => {
    expect(source).toContain("const resolvedProviderAccountId = authorizedScope");
    expect(source).toContain("? authorizedScope.providerAccountId");
    expect(source).toContain("const advisorExecutionAccountId = resolvedProviderAccountId;");
  });

  it("keeps the local account picker on the legacy entry only", () => {
    expect(source).toContain("setSelectedGoogleAccountId");
    expect(source).toContain("All assigned accounts (blended)");
    expect(source).toContain("!authorizedScope && accountScope.mode !== \"none\"");
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

  it("withholds canonical reporting reads until an account is resolved", () => {
    expect(source).toContain("enabled: Boolean(businessId) && hasResolvedReadScope");
    expect(source).toContain("enabled: needsTrendData && hasResolvedReadScope");
    expect(source).toContain("accountId: resolvedProviderAccountId");
  });
});
