import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { buildEvidenceSections } from "@/components/creatives/briefing/card-utils";
import type { BriefingCreativeCard } from "@/components/creatives/briefing/types";

describe("buildEvidenceSections", () => {
  it("renders briefing funnel counts from the card payload", () => {
    const card: BriefingCreativeCard = {
      id: "creative_1",
      creativeId: "creative_1",
      name: "Creative One",
      label: "test_more",
      confidence: 75,
      reason: "Let the creative accumulate signal.",
      primary: { kind: "fresh_test", label: "Launch new test" },
      spend: 74.35,
      roas: 4.23,
      ctr: 1.22,
      cpa: 74.35,
      purchases: 1,
      impressions: 4310,
      linkClicks: 52,
      addToCart: 3,
      frequency: 1.1,
      status: "ACTIVE",
      ageDays: 0,
    };

    const funnel = buildEvidenceSections(card).find((section) => section.key === "funnel");
    const html = renderToStaticMarkup(<>{funnel?.content}</>);

    expect(html).toContain("4,310");
    expect(html).toContain("52");
    expect(html).toContain("3");
    expect(html).toContain("1");
    expect(html).not.toContain("124,300");
  });
});
