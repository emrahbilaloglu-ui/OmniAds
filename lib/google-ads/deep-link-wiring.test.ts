import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The deep link is rendered, scoped, and reports itself.
 *
 * `deep-link.test.ts` proves the URL builder refuses rather than guesses. This
 * proves the refusal is honoured at the render site, because a builder that
 * returns null is only safe if the caller renders nothing rather than an anchor
 * with `href="undefined"` — a dead link that looks live is the same failure as
 * a wrong one.
 */
const dashboard = readFileSync(
  "components/google-ads/GoogleAdsIntelligenceDashboard.tsx",
  "utf8",
);

describe("the link is only offered when it can be aimed", () => {
  it("renders the anchor only when a link could be built", () => {
    // The guard and the href call the same builder with the same target, so a
    // refused link cannot render as an anchor pointing nowhere.
    expect(dashboard).toContain("{buildGoogleAdsDeepLink({");
    expect(dashboard).toContain("target: { kind: \"search_terms\" },\n                        }) ? (");
  });

  it("never renders an anchor with an undefined destination", () => {
    expect(dashboard).not.toMatch(/href=\{[^}]*\?\?\s*""\s*\}/);
    // `?? undefined` on an href that only renders inside a truthy guard is
    // type narrowing, not a fallback destination.
    expect(dashboard).toContain("}) ?? undefined\n                            }");
  });

  it("opens in a new tab without handing the opener over", () => {
    expect(dashboard).toContain('rel="noopener noreferrer"');
  });

  it("scopes the link to the account the operator is actually looking at", () => {
    expect(dashboard).toContain("accountId: advisorExecutionAccountId");
  });
});

describe("using it is reported as a business-scoped Google event", () => {
  it("emits google_deep_link_used on click", () => {
    expect(dashboard).toContain('eventName: "google_deep_link_used"');
    expect(dashboard).toContain('surface: "google_ads"');
    expect(dashboard).toContain('provider: "google"');
    expect(dashboard).toContain('scope: "business"');
    expect(dashboard).toContain("businessId,");
  });

  it("reports the click, not the render", () => {
    // Emitting on render would count every page view as a deep-link use and
    // make the escape hatch look far more used than it is.
    const emitIndex = dashboard.indexOf('eventName: "google_deep_link_used"');
    const handlerIndex = dashboard.lastIndexOf("onClick={() =>", emitIndex);
    expect(handlerIndex).toBeGreaterThan(-1);
    expect(emitIndex - handlerIndex).toBeLessThan(400);
  });
});

describe("the builder it depends on still refuses", () => {
  const builder = readFileSync("lib/google-ads/deep-link.ts", "utf8");

  it("requires a plausible numeric customer id", () => {
    // A link that lands on the wrong account is worse than no link: the
    // operator acts, and acts on someone else's data.
    expect(builder).toContain("digits.length >= 8 ? digits : null");
  });

  it("refuses a campaign link with no campaign rather than downgrading it", () => {
    expect(builder).toContain("if (!campaignId) return null;");
  });
});
