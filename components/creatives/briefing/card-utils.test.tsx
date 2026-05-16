import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  BadgeChip,
  buildEvidenceSections,
} from "@/components/creatives/briefing/card-utils";
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

    const funnel = buildEvidenceSections(card).find(
      (section) => section.key === "funnel",
    );
    const html = renderToStaticMarkup(<>{funnel?.content}</>);

    expect(html).toContain("4,310");
    expect(html).toContain("52");
    expect(html).toContain("3");
    expect(html).toContain("1");
    expect(html).not.toContain("124,300");
  });

  it("renders provenance from real card fields without fake audit strings", () => {
    const card: BriefingCreativeCard = {
      id: "creative_1",
      creativeId: "creative_1",
      name: "Creative One",
      campaign: "ASC Main",
      label: "scale",
      confidence: 88,
      reason: "Above account winner benchmark.",
      primary: { kind: "scale_budget", label: "Scale budget" },
      engineVersion: "v3-2026-05-16-phase-h2",
      sourceAsOf: "2026-05-16",
      sourceDataSource: "warehouse",
      profileScope: "account:biz_1",
    };

    const html = renderToStaticMarkup(
      <>{buildEvidenceSections(card).map((section) => section.content)}</>,
    );

    expect(html).toContain("v3-2026-05-16-phase-h2");
    expect(html).toContain("2026-05-16");
    expect(html).toContain("warehouse");
    expect(html).toContain("account:biz_1");
    expect(html).not.toMatch(
      /Erhan|2026-04-28|2026-05-01|v3\.2\.4|Q2-2026|graph v19|Standard \+ Conversions API/,
    );
  });
});

describe("BadgeChip", () => {
  it("renders engine scale-readiness badges without falling back to decision labels", () => {
    const html = renderToStaticMarkup(
      <>
        <BadgeChip label="scale_readiness_blocked" />
        <BadgeChip label="scale_calibration_thin" />
      </>,
    );

    expect(html).toContain("near scale");
    expect(html).toContain("scale sample");
    expect(html).not.toContain("out of scope");
  });
});
