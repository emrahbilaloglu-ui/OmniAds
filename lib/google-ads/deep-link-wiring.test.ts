import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Where the Google Ads deep link may and may not appear.
 *
 * The canonical `Google Ads · Search` screen has no escape hatch: the reference
 * markup's only interactive elements are the two tab pills and the four filter
 * pills, so the Copy negatives / Download CSV / "Open in Google Ads" card that
 * used to sit above the table was removed rather than restyled.
 *
 * The builder itself is unchanged and still refuses rather than guesses, so a
 * future caller inherits the same refusal. `deep-link.test.ts` proves the URL
 * rules; this file proves that the removed render site stayed removed, and that
 * the refusal contract the render site depended on is still in force.
 */
const dashboard = readFileSync(
  "components/google-ads/GoogleAdsIntelligenceDashboard.tsx",
  "utf8",
);
const searchScreen = readFileSync(
  "components/google-ads/GoogleSearchExact.tsx",
  "utf8",
);

describe("the canonical Search screen offers no escape hatch", () => {
  it("renders no Google Ads deep link anywhere in the Google workspace", () => {
    expect(dashboard).not.toContain("buildGoogleAdsDeepLink");
    expect(dashboard).not.toContain("describeGoogleAdsDeepLink");
    expect(searchScreen).not.toContain("buildGoogleAdsDeepLink");
  });

  it("renders no export controls the reference does not draw", () => {
    expect(dashboard).not.toContain("Copy negatives");
    expect(dashboard).not.toContain("Download CSV");
    expect(dashboard).not.toContain("Escape hatch");
    expect(searchScreen).not.toContain("Escape hatch");
  });

  it("reports no deep-link usage from a link that is no longer rendered", () => {
    expect(dashboard).not.toContain('eventName: "google_deep_link_used"');
    expect(dashboard).not.toContain('eventName: "google_copy_used"');
    expect(dashboard).not.toContain('eventName: "google_csv_used"');
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
