import React from "react";
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

  it("renders math proof and priority fields when supplied by the server", () => {
    const card: BriefingCreativeCard = {
      id: "creative_1",
      creativeId: "creative_1",
      name: "Creative One",
      campaign: "ASC Main",
      label: "cut",
      confidence: 82,
      reason: "Loss-budget maturity reached.",
      primary: { kind: "cut", label: "Cut" },
      spend: 140,
      roas: 0.46,
      explainability: {
        targetRoas: 2.5,
        ratioToTarget: 0.2,
        thresholdSource: "commercial_truth",
        thresholdQuality: "ready",
        calibrationComputedAt: "2026-05-25T06:00:00.000Z",
        spendUnit: 36,
        commercialMaturitySpend: 72,
        hardCutSpend: 288,
        scaleMinPurchases: 1,
        historicalPrecision: 0.91,
        historicalRecall: 0.86,
        expectedCalibrationError: 0.04,
        empiricalSampleSize: 120,
        missingEvidence: ["current_version_outcome_window"],
      },
      priorityScore: {
        score: 91.84,
        band: "medium",
        reason:
          "medium priority from spend at risk, confidence, and loss severity.",
        inputs: {
          spend: 140,
          ratioToTarget: 0.2,
          confidenceFactor: 0.82,
          spendAtRisk: 112,
          opportunityValue: 0,
          severityWeight: 1,
          actionWeight: 1,
        },
      },
    };

    const html = renderToStaticMarkup(
      <>
        {buildEvidenceSections(card).map((section) => (
          <React.Fragment key={section.key}>{section.content}</React.Fragment>
        ))}
      </>,
    );

    expect(html).toContain("Target ROAS");
    expect(html).toContain("2.50×");
    expect(html).toContain("commercial truth");
    expect(html).toContain("Priority medium");
    expect(html).toContain("Missing proof: current version outcome window");
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
