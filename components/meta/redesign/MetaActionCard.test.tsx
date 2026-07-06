import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MetaActionCard } from "@/components/meta/redesign/MetaActionCard";
import { metaAnomaly, metaRec } from "@/components/meta/redesign/test-fixtures";

describe("MetaActionCard", () => {
  it("renders campaign role, bid regime, confidence, and evidence", () => {
    const html = renderToStaticMarkup(<MetaActionCard rec={metaRec()} selected />);
    expect(html).toContain("ASC Prospecting needs a cleaner rebuild");
    expect(html).toContain("Prospecting Scale");
    expect(html).toContain("Lowest Cost");
    expect(html).toContain("82%");
    expect(html).toContain("account · 28d_history");
    expect(html).toContain("ready · cap high");
    expect(html).toContain("metric-strip");
    expect(html).toContain("What does Defer 24h do?");
  });

  it("renders operator response telemetry badges", () => {
    const acted = renderToStaticMarkup(<MetaActionCard rec={metaRec()} responseState="acted" />);
    expect(acted).toContain('data-operator-response="acted"');
    expect(acted).toContain("Acted");

    const ignored = renderToStaticMarkup(<MetaActionCard rec={metaRec()} responseState="ignored" />);
    expect(ignored).toContain('data-operator-response="ignored"');
    expect(ignored).toContain("Ignored");
  });

  it("disables the primary action after a verified acted response", () => {
    const html = renderToStaticMarkup(
      <MetaActionCard rec={metaRec({ type: "adset_cut_spend" })} responseState="acted" />,
    );

    expect(html).toContain('disabled=""');
    expect(html).toContain("Paused");
  });

  it("offers resume for a paused ad set response when a resume handler is available", () => {
    const html = renderToStaticMarkup(
      <MetaActionCard
        rec={metaRec({
          level: "adset",
          adsetId: "adset_1",
          adsetName: "Paused Adset",
          type: "adset_cut_spend",
          operatorResponseSubtype: "pause",
        })}
        responseState="acted"
        onResume={() => undefined}
      />,
    );

    expect(html).toContain("Resume adset");
    expect(html).not.toContain('disabled=""');
  });

  it("renders action feedback next to the primary controls", () => {
    const html = renderToStaticMarkup(
      <MetaActionCard
        rec={metaRec({ type: "adset_cut_spend" })}
        actionFeedback={{ tone: "success", title: "Ad set paused in Meta.", detail: "Meta verified the ad set status." }}
      />,
    );

    expect(html).toContain('data-meta-action-feedback="success"');
    expect(html).toContain("Ad set paused in Meta.");
    expect(html).toContain("Meta verified the ad set status.");
  });

  it("renders backend-provided automation readiness without deriving the action in UI", () => {
    const html = renderToStaticMarkup(<MetaActionCard rec={metaRec({
      automationReadiness: {
        contractVersion: "meta-automation-readiness.v1",
        tier: "backtest_candidate",
        autoExecuteEligible: false,
        operatorReviewRequired: true,
        decisionLabel: "scale",
        blockers: ["no_empirical_outcome_model"],
        missingEvidence: ["empirical_outcome_backtest"],
        requiredEvidence: ["empirical_outcome_backtest"],
        reason: "Empirical outcome backtesting is required before automation.",
      },
    })} />);

    expect(html).toContain('data-automation-readiness');
    expect(html).toContain("Backtest needed");
  });

  it("renders anomaly cards in diagnostic mode", () => {
    const html = renderToStaticMarkup(<MetaActionCard anomaly={metaAnomaly({
      diagnosticLadder: [{ step: 1, label: "Tracking", detail: "Check events first." }],
    })} />);
    expect(html).toContain("Policy delivery block");
    expect(html).toContain("Open diagnostic");
    expect(html).toContain("Tracking");
    expect(html).toContain("Check events first.");
  });

  it("renders non-purchase cohort chips on recommendation cards", () => {
    const html = renderToStaticMarkup(<MetaActionCard rec={metaRec({ cohort: "upper_funnel" })} />);
    expect(html).toContain("Upper Funnel");
    expect(html).toContain('data-cohort-chip="upper_funnel"');
  });

  it("uses backend evidence instead of empty metric placeholders", () => {
    const html = renderToStaticMarkup(
      <MetaActionCard
        rec={metaRec({
          evidence: [
            { label: "Defensive bid band", value: "$107.76-$136.41", tone: "positive" },
            { label: "Scale bid band", value: "$113.15-$156.87", tone: "neutral" },
            { label: "ROAS band", value: "0.70x-0.83x", tone: "positive" },
            { label: "Campaign label", value: "Missing", tone: "warning" },
          ],
        })}
      />,
    );

    expect(html).toContain("Defensive bid band");
    expect(html).toContain("$107.76-$136.41");
    expect(html).toContain("Campaign label");
    expect(html).toContain("Missing");
    expect(html).not.toContain(">—<");
  });

  it("does not render cohort chip for purchase recommendations", () => {
    const html = renderToStaticMarkup(<MetaActionCard rec={metaRec({ cohort: "purchase" })} />);
    expect(html).not.toContain("data-cohort-chip");
  });

  it("does not render cohort chip when cohort is missing", () => {
    const html = renderToStaticMarkup(<MetaActionCard rec={metaRec({ cohort: undefined })} />);
    expect(html).not.toContain("data-cohort-chip");
  });
});

describe("card KPI strip uses structured metrics", () => {
  it("renders server metrics with the account currency, ignoring display strings", () => {
    const html = renderToStaticMarkup(
      <MetaActionCard
        moneyCurrency="TRY"
        rec={metaRec({
          metrics: { spend: 1250, roas: 3.2, cpa: 21.5, purchases: 44, frequency: 1.8 },
          evidence: [
            { label: "Spend", value: "$999,999 STALE DISPLAY", tone: "neutral" },
            { label: "ROAS", value: "0.01x STALE", tone: "warning" },
          ],
        })}
      />,
    );
    expect(html).toContain("TRY");
    expect(html).toContain("3.20x");
    expect(html).not.toContain("STALE DISPLAY");
    expect(html).not.toContain("0.01x STALE");
  });

  it("falls back to evidence display strings only when metrics are absent", () => {
    const html = renderToStaticMarkup(
      <MetaActionCard
        rec={metaRec({
          metrics: null,
          evidence: [{ label: "Spend", value: "$1,200", tone: "neutral" }],
        })}
      />,
    );
    expect(html).toContain("$1,200");
  });
});
