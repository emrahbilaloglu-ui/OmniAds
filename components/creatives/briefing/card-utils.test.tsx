import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  BadgeChip,
  buildEvidenceSections,
  cardCampaignRoleStatus,
  cardCurrentRowScaleAction,
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
        thresholdProvenance: {
          calibrationComputedAt: "2026-05-25T06:00:00.000Z",
          refitDueAt: "2026-08-23T06:00:00.000Z",
          source: "operator_target",
        },
        spendUnit: 36,
        commercialMaturitySpend: 72,
        hardCutSpend: 288,
        scaleMinPurchases: 1,
        nearMisses: ["Needs 3 more purchases."],
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
    expect(html).toContain("Calibration");
    expect(html).toContain("2026-08-23");
    expect(html).toContain("What would flip this decision?");
    expect(html).toContain("Needs 3 more purchases.");
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

describe("calibration honesty copy", () => {
  const baseCard = (empiricalSampleSize: number | null): BriefingCreativeCard => ({
    id: "creative_n",
    creativeId: "creative_n",
    name: "Creative N",
    campaign: "ASC Main",
    label: "cut",
    confidence: 82,
    reason: "Loss-budget maturity reached.",
    primary: { kind: "cut", label: "Cut" },
    spend: 140,
    roas: 0.46,
    explainability: {
      targetRoas: 2.5,
      historicalPrecision: 0.9,
      historicalRecall: 0.8,
      expectedCalibrationError: 0.04,
      empiricalSampleSize,
    },
  });

  const renderExplainability = (card: BriefingCreativeCard) =>
    renderToStaticMarkup(
      <>{buildEvidenceSections(card).map((section) => section.content)}</>,
    );

  it("flags calibration as not proven below 30 realized outcomes", () => {
    const html = renderExplainability(baseCard(12));
    expect(html).toContain("Calibration not proven");
    expect(html).toContain("only 12 hard-action outcomes");
    expect(html).toContain("directional, not proof");
  });

  it("flags a missing outcome window explicitly", () => {
    const html = renderExplainability(baseCard(null));
    expect(html).toContain("no realized-outcome window");
  });

  it("stays silent at or above the reliable-sample floor", () => {
    const html = renderExplainability(baseCard(120));
    expect(html).not.toContain("Calibration not proven");
  });
});

describe("observed rate at confidence", () => {
  it("renders the bucket's empirical track record next to confidence", () => {
    const card: BriefingCreativeCard = {
      id: "creative_b",
      creativeId: "creative_b",
      name: "Creative B",
      campaign: "ASC Main",
      label: "cut",
      confidence: 74,
      reason: "Loss-budget maturity reached.",
      primary: { kind: "cut", label: "Cut" },
      spend: 100,
      roas: 0.5,
      explainability: {
        targetRoas: 2.0,
        bucketObservedRate: 0.62,
        bucketObservedSampleSize: 64,
        empiricalSampleSize: 64,
      },
    };
    const html = renderToStaticMarkup(
      <>{buildEvidenceSections(card).map((section) => section.content)}</>,
    );
    expect(html).toContain("Obs. @ conf");
    expect(html).toContain("62% (n=64)");
  });

  it("marks thin buckets explicitly", () => {
    const card: BriefingCreativeCard = {
      id: "creative_t",
      creativeId: "creative_t",
      name: "Creative T",
      campaign: "ASC Main",
      label: "cut",
      confidence: 74,
      reason: "r",
      primary: { kind: "cut", label: "Cut" },
      spend: 100,
      roas: 0.5,
      explainability: {
        targetRoas: 2.0,
        bucketObservedRate: 0.5,
        bucketObservedSampleSize: 8,
        empiricalSampleSize: 8,
      },
    };
    const html = renderToStaticMarkup(
      <>{buildEvidenceSections(card).map((section) => section.content)}</>,
    );
    expect(html).toContain("50% (n=8, thin)");
  });
});

describe("cardCampaignRoleStatus (D074b acceptance correction)", () => {
  it("renders a current automatic role only for uncontradicted canonical resolved status", () => {
    expect(
      cardCampaignRoleStatus({ campaignRoleStatus: "resolved", campaignLabelStatus: undefined }),
    ).toBe("resolved");
    expect(
      cardCampaignRoleStatus({ campaignRoleStatus: "resolved", campaignLabelStatus: "labeled" }),
    ).toBe("resolved");
  });

  it("fails closed on legacy-only labeled, missing, and contradictory statuses", () => {
    // Pre-correction: legacy-only "labeled" returned "resolved" and missing
    // returned null (letting chips fall through to campaignKind display).
    expect(
      cardCampaignRoleStatus({ campaignRoleStatus: undefined, campaignLabelStatus: "labeled" }),
    ).toBe("unresolved");
    expect(
      cardCampaignRoleStatus({ campaignRoleStatus: undefined, campaignLabelStatus: undefined }),
    ).toBe("unresolved");
    expect(
      cardCampaignRoleStatus({ campaignRoleStatus: "resolved", campaignLabelStatus: "unlabeled" }),
    ).toBe("unresolved");
    expect(
      cardCampaignRoleStatus({ campaignRoleStatus: undefined, campaignLabelStatus: "no_campaign" }),
    ).toBe("no_campaign");
  });
});

describe("cardCurrentRowScaleAction (D074b acceptance corrections 2+3)", () => {
  const staleRow = (executionAction: string, buyerAction = "scale") =>
    ({ buyerAction, executionAction }) as never;
  const base = {
    campaignRoleStatus: "resolved" as const,
    campaignLabelStatus: undefined,
    blockedActionType: null,
    authorityBlocker: null,
  };

  it("returns the row action only when the server current primary confirms it", () => {
    expect(
      cardCurrentRowScaleAction({
        ...base,
        decisionCenterRow: staleRow("promote_to_main"),
        campaignKind: "test",
        primary: { kind: "promote", label: "Promote to main" },
      }),
    ).toBe("promote_to_main");
    expect(
      cardCurrentRowScaleAction({
        ...base,
        decisionCenterRow: staleRow("scale_budget"),
        campaignKind: "main",
        primary: { kind: "scale_budget", label: "Scale budget" },
      }),
    ).toBe("scale_budget");
    expect(
      cardCurrentRowScaleAction({
        ...base,
        decisionCenterRow: staleRow("controlled_scale"),
        campaignKind: "mixed",
        primary: { kind: "controlled_scale", label: "Review structure & scale" },
      }),
    ).toBe("controlled_scale");
  });

  it("resolved role/kind is NOT sufficient: any non-agreeing current primary wins (D074b correction 3)", () => {
    // Correction 2 returned "promote_to_main" for every one of these — the
    // helper restored a hard CTA over the server's current review/cut/
    // refresh/diagnose primary.
    const primaries = [
      { kind: "review", label: "Refresh evidence" },
      { kind: "cut", label: "Cut" },
      { kind: "fresh_test", label: "Launch fresh test" },
      { kind: "review", label: "Open evidence" },
      { kind: "scale_budget", label: "Scale budget" },
      null,
      undefined,
    ];
    for (const primary of primaries) {
      expect(
        cardCurrentRowScaleAction({
          ...base,
          decisionCenterRow: staleRow("promote_to_main"),
          campaignKind: "test",
          primary: primary as never,
        }),
        JSON.stringify(primary ?? null),
      ).toBeNull();
    }
    // Held/blocked state fails closed even when the primary would agree.
    expect(
      cardCurrentRowScaleAction({
        ...base,
        blockedActionType: "scale",
        decisionCenterRow: staleRow("promote_to_main"),
        campaignKind: "test",
        primary: { kind: "promote", label: "Promote to main" },
      }),
    ).toBeNull();
    expect(
      cardCurrentRowScaleAction({
        ...base,
        authorityBlocker: "source_freshness",
        decisionCenterRow: staleRow("promote_to_main"),
        campaignKind: "test",
        primary: { kind: "promote", label: "Promote to main" },
      }),
    ).toBeNull();
  });

  it("fails closed on missing, legacy-only, contradictory status and kind mismatch", () => {
    // Pre-correction-2 ActionNowCard read row.executionAction directly for
    // every one of these shapes. An agreeing primary is supplied so these
    // pins keep targeting the role/kind gates specifically.
    const agreeing = { primary: { kind: "promote", label: "Promote to main" } };
    expect(
      cardCurrentRowScaleAction({
        ...base,
        ...agreeing,
        decisionCenterRow: staleRow("promote_to_main"),
        campaignKind: "test",
        campaignRoleStatus: undefined,
      }),
    ).toBeNull();
    expect(
      cardCurrentRowScaleAction({
        ...base,
        ...agreeing,
        decisionCenterRow: staleRow("promote_to_main"),
        campaignKind: "test",
        campaignRoleStatus: undefined,
        campaignLabelStatus: "labeled",
      }),
    ).toBeNull();
    expect(
      cardCurrentRowScaleAction({
        ...base,
        ...agreeing,
        decisionCenterRow: staleRow("promote_to_main"),
        campaignKind: "test",
        campaignLabelStatus: "unlabeled",
      }),
    ).toBeNull();
    expect(
      cardCurrentRowScaleAction({
        ...base,
        ...agreeing,
        decisionCenterRow: staleRow("promote_to_main"),
        campaignKind: "main",
      }),
    ).toBeNull();
    expect(
      cardCurrentRowScaleAction({
        ...base,
        ...agreeing,
        decisionCenterRow: staleRow("promote_to_main", "cut"),
        campaignKind: "test",
      }),
    ).toBeNull();
    expect(
      cardCurrentRowScaleAction({
        ...base,
        ...agreeing,
        decisionCenterRow: null,
        campaignKind: "test",
      }),
    ).toBeNull();
  });
});
