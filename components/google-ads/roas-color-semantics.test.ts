import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  "components/google-ads/GoogleAdsIntelligenceDashboard.tsx",
  "utf8",
);

/**
 * A campaign with no ROAS is not a campaign performing badly. Comparing an
 * absent value against the account average made it fail the comparison and
 * render in the loss colour, so "we have no data for this" was displayed
 * identically to "this is losing money".
 */
describe("Google campaign ROAS colouring", () => {
  it("decides colour from whether a ROAS exists, not from a bare comparison", () => {
    expect(source).toContain("const hasRoas =");
    expect(source).toMatch(/const roasColor = !hasRoas\s*\?\s*undefined/);
  });

  it("no longer colours every campaign either green or red unconditionally", () => {
    expect(source).not.toMatch(
      /valueColor=\{roasUp \? "text-emerald-700" : "text-rose-600"\}/,
    );
  });

  it("renders a missing ROAS through the shared missing-value constant", () => {
    expect(source).toContain("hasRoas ? fmtRoas(campaign.roas) : MISSING_VALUE");
    expect(source).toContain('import { MISSING_VALUE } from "@/lib/metric-format"');
  });

  it("still distinguishes above-average from below-average when ROAS is real", () => {
    expect(source).toContain('campaign.roas >= accountAvgRoas');
    expect(source).toContain('"text-emerald-700"');
    expect(source).toContain('"text-rose-600"');
  });
});
