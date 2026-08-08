import { describe, expect, it } from "vitest";
import {
  resolveGoogleAccountScope,
  scopeSupportsAccountLinks,
} from "@/lib/google-ads/account-scope";

describe("a single assigned account", () => {
  it("scopes to it without asking", () => {
    const scope = resolveGoogleAccountScope({ assignedAccountIds: ["122-487-7195"] });
    expect(scope.mode).toBe("single");
    expect(scope.accountId).toBe("122-487-7195");
    expect(scope.notice).toBeNull();
  });

  it("supports deep links and comparable money", () => {
    const scope = resolveGoogleAccountScope({ assignedAccountIds: ["122-487-7195"] });
    expect(scopeSupportsAccountLinks(scope)).toBe(true);
    expect(scope.moneyComparable).toBe(true);
  });
});

describe("several accounts with no choice made", () => {
  it("blends, but says that it is blending", () => {
    const scope = resolveGoogleAccountScope({ assignedAccountIds: ["a", "b"] });
    expect(scope.mode).toBe("blended");
    expect(scope.notice).toContain("Blended across 2 accounts");
  });

  it("refuses deep links, which need exactly one account", () => {
    const scope = resolveGoogleAccountScope({ assignedAccountIds: ["a", "b"] });
    expect(scopeSupportsAccountLinks(scope)).toBe(false);
    expect(scope.accountId).toBeNull();
  });

  it("treats one shared currency as comparable money", () => {
    const scope = resolveGoogleAccountScope({
      assignedAccountIds: ["a", "b"],
      currencyByAccountId: { a: "USD", b: "usd" },
    });
    expect(scope.mixedCurrency).toBe(false);
    expect(scope.moneyComparable).toBe(true);
  });

  it("refuses to present one money figure across different currencies", () => {
    const scope = resolveGoogleAccountScope({
      assignedAccountIds: ["a", "b"],
      currencyByAccountId: { a: "USD", b: "TRY" },
    });
    expect(scope.mixedCurrency).toBe(true);
    expect(scope.moneyComparable).toBe(false);
    expect(scope.notice).toContain("not comparable");
  });

  it("treats an unknown currency as not comparable rather than assuming it matches", () => {
    const scope = resolveGoogleAccountScope({
      assignedAccountIds: ["a", "b"],
      currencyByAccountId: { a: "USD" },
    });
    expect(scope.mixedCurrency).toBe(true);
    expect(scope.moneyComparable).toBe(false);
  });
});

describe("an explicit choice", () => {
  it("scopes to the chosen account and restores deep links", () => {
    const scope = resolveGoogleAccountScope({
      assignedAccountIds: ["a", "b", "c"],
      selectedAccountId: "b",
    });
    expect(scope.mode).toBe("single");
    expect(scope.accountId).toBe("b");
    expect(scopeSupportsAccountLinks(scope)).toBe(true);
    expect(scope.notice).toBeNull();
  });

  it("ignores a selection that is not assigned rather than trusting it", () => {
    const scope = resolveGoogleAccountScope({
      assignedAccountIds: ["a", "b"],
      selectedAccountId: "not-mine",
    });
    expect(scope.mode).toBe("blended");
    expect(scope.accountId).toBeNull();
  });
});

describe("no accounts", () => {
  it("says so instead of rendering an empty dashboard", () => {
    const scope = resolveGoogleAccountScope({ assignedAccountIds: [] });
    expect(scope.mode).toBe("none");
    expect(scope.notice).toContain("No Google account is assigned");
    expect(scope.moneyComparable).toBe(false);
  });

  it("ignores blank ids", () => {
    expect(resolveGoogleAccountScope({ assignedAccountIds: ["", "  "] }).mode).toBe("none");
  });
});
