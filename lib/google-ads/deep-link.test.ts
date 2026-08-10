import { describe, expect, it } from "vitest";

import {
  buildGoogleAdsDeepLink,
  describeGoogleAdsDeepLink,
} from "@/lib/google-ads/deep-link";

describe("a deep link names its destination exactly or is refused", () => {
  it("scopes every link to the account in view", () => {
    const link = buildGoogleAdsDeepLink({
      accountId: "123-456-7890",
      target: { kind: "search_terms" },
    });
    expect(link).toContain("ocid=1234567890");
    expect(link).toContain("/keywords/searchterms");
  });

  it("refuses a link it cannot scope rather than guessing", () => {
    // Landing on the wrong account is worse than no link: the operator acts,
    // and acts on someone else's data.
    for (const accountId of [null, undefined, "", "abc", "12345"]) {
      expect(
        buildGoogleAdsDeepLink({ accountId, target: { kind: "account" } }),
        `accountId ${String(accountId)} must not produce a link`,
      ).toBeNull();
    }
  });

  it("refuses a campaign link with no campaign", () => {
    // An account link wearing a campaign label is a lie about where it goes.
    expect(
      buildGoogleAdsDeepLink({
        accountId: "1234567890",
        target: { kind: "campaign", campaignId: "" },
      }),
    ).toBeNull();
  });

  it("includes the campaign when it has one", () => {
    const link = buildGoogleAdsDeepLink({
      accountId: "1234567890",
      target: { kind: "campaign", campaignId: "555" },
    });
    expect(link).toContain("campaignId=555");
  });

  it("labels each link with where it actually goes", () => {
    expect(describeGoogleAdsDeepLink({ kind: "search_terms" })).toContain(
      "search terms",
    );
    expect(describeGoogleAdsDeepLink({ kind: "account" })).toContain("account");
  });

  it("never sends the operator anywhere but Google Ads", () => {
    const link = buildGoogleAdsDeepLink({
      accountId: "1234567890",
      target: { kind: "keywords" },
    });
    expect(link?.startsWith("https://ads.google.com/aw")).toBe(true);
  });
});
