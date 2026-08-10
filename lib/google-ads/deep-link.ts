/**
 * Scoped deep links into the Google Ads UI.
 *
 * The zero-risk escape hatches let an operator take work *out* of the product;
 * this one takes them to the exact place in Google Ads where the change is
 * made. It writes nothing and needs no additional permission — it is a URL —
 * but it must still be exact, because a link that lands on the wrong account is
 * worse than no link at all: the operator acts, and acts on someone else's data.
 *
 * So the account is always required and always numeric, and a link is refused
 * rather than guessed. `null` means "we cannot name the destination", which the
 * caller renders as no link.
 */

const GOOGLE_ADS_BASE = "https://ads.google.com/aw";

/** Google customer ids are digits; dashes are a display convention. */
function normalizeCustomerId(accountId: string | null | undefined): string | null {
  if (!accountId) return null;
  const digits = accountId.replace(/[^0-9]/g, "");
  return digits.length >= 8 ? digits : null;
}

export type GoogleAdsDeepLinkTarget =
  | { kind: "account" }
  | { kind: "campaign"; campaignId: string }
  | { kind: "search_terms" }
  | { kind: "keywords" };

export function buildGoogleAdsDeepLink(input: {
  accountId: string | null | undefined;
  target: GoogleAdsDeepLinkTarget;
}): string | null {
  const customerId = normalizeCustomerId(input.accountId);
  if (!customerId) return null;

  const params = new URLSearchParams({ ocid: customerId });

  switch (input.target.kind) {
    case "account":
      return `${GOOGLE_ADS_BASE}/overview?${params.toString()}`;
    case "search_terms":
      return `${GOOGLE_ADS_BASE}/keywords/searchterms?${params.toString()}`;
    case "keywords":
      return `${GOOGLE_ADS_BASE}/keywords/reportview?${params.toString()}`;
    case "campaign": {
      const campaignId = input.target.campaignId.replace(/[^0-9]/g, "");
      // A campaign link without a campaign is an account link wearing the wrong
      // label. Refuse rather than silently downgrade the destination.
      if (!campaignId) return null;
      params.set("campaignId", campaignId);
      return `${GOOGLE_ADS_BASE}/campaigns?${params.toString()}`;
    }
  }
}

/** What the link is called, so the label matches where it goes. */
export function describeGoogleAdsDeepLink(
  target: GoogleAdsDeepLinkTarget,
): string {
  switch (target.kind) {
    case "account":
      return "Open account in Google Ads";
    case "search_terms":
      return "Open search terms in Google Ads";
    case "keywords":
      return "Open keywords in Google Ads";
    case "campaign":
      return "Open campaign in Google Ads";
  }
}
