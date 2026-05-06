import React from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CommandCenterHistoricalIntelligencePanel } from "@/components/command-center/CommandCenterHistoricalIntelligencePanel";

describe("CommandCenterHistoricalIntelligencePanel", () => {
  it("renders campaign families, decision quality, degraded guidance, and calibration suggestions", () => {
    const html = renderToStaticMarkup(
      <CommandCenterHistoricalIntelligencePanel
        intelligence={{
          selectedWindow: {
            startDate: "2026-02-01",
            endDate: "2026-02-10",
            note:
              "Analysis only. Live decisions and queue selection continue to use the primary decision window.",
          },
          campaignFamilies: [
            {
              family: "purchase_value",
              familyLabel: "purchase/value",
              campaignCount: 2,
              activeCampaignCount: 1,
              spend: 640,
              purchases: 18,
              roas: 3.1,
              summary:
                "purchase/value ran 2 campaign(s), 1 active, with 640 spend and 3.10x blended ROAS in the selected period.",
            },
          ],
          decisionQuality: {
            actionableCount: 8,
            selectedCount: 5,
            overflowCount: 3,
            queueGapCount: 2,
            feedbackCount: 6,
            falsePositiveCount: 2,
            falseNegativeCount: 2,
            badRecommendationCount: 1,
            suppressionRates: {
              actionCore: 0.5,
              watchlist: 0.25,
              archive: 0.15,
              degraded: 0.2,
            },
            falsePositiveHotspots: [
              {
                key: "meta_adset_decision",
                label: "Meta ad set decisions",
                count: 2,
                summary: "2 false-positive report(s) landed on meta ad set decisions.",
              },
            ],
            falseNegativeHotspots: [
              {
                key: "creative:today_priorities",
                label: "Creative - Today Priorities",
                count: 2,
                summary: "2 queue-gap report(s) suggest missing work in today priorities.",
              },
            ],
          },
          degradedGuidance: {
            degradedActionCount: 2,
            missingInputs: ["target pack", "country economics"],
            reasons: ["Target pack missing", "Country economics missing"],
            summary:
              "Missing truth still caps 2 surfaced action(s). Fill target pack and country economics before raising action aggressiveness.",
          },
          calibrationSuggestions: [
            {
              key: "missing_truth_inputs",
              priority: "high",
              title: "Fill missing commercial truth first",
              detail:
                "The largest calibration gain still comes from completing missing business truth.",
              evidence: "Missing inputs: target pack, country economics.",
            },
          ],
        }}
      />,
    );

    expect(html).toContain("Historical Intelligence");
    expect(html).toContain("Selected-period Meta campaign families");
    expect(html).toContain("Decision quality");
    expect(html).toContain("Degraded guidance");
    expect(html).toContain("Deterministic calibration suggestions");
    expect(html).toContain("Meta ad set decisions");
    expect(html).toContain("Fill missing commercial truth first");
  });
});
