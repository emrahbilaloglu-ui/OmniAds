import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MetaActionCard } from "@/components/meta/redesign/MetaActionCard";
import { metaAnomaly, metaRec } from "@/components/meta/redesign/test-fixtures";

describe("MetaActionCard lean decision row", () => {
  it("renders the entity, server decision label, chips, and a single confidence band pill", () => {
    const html = renderToStaticMarkup(<MetaActionCard rec={metaRec()} selected onSelect={() => undefined} />);
    // Entity name (scope), not the long engine title, leads the row.
    expect(html).toContain("ASC Prospecting");
    expect(html).not.toContain("ASC Prospecting needs a cleaner rebuild");
    // Server decision label rendered verbatim (rebuild -> "Rebuild").
    expect(html).toContain('data-decision-label="rebuild"');
    // Descriptor chips stay on the row, capped.
    expect(html).toContain("Prospecting Scale");
    expect(html).toContain("Lowest Cost");
    // ONE confidence band pill carrying the server band + score.
    expect(html).toContain('data-confidence-band="high"');
    expect(html).toContain("High");
    expect(html).toContain("0.82");
    // Heavy card affordances are gone from the row.
    expect(html).not.toContain("metric-strip");
    expect(html).toContain('data-card="meta-action"');
  });

  it("caps visible descriptor chips at three with a +N overflow", () => {
    const html = renderToStaticMarkup(
      <MetaActionCard
        rec={metaRec({ campaignRole: "prospecting_scale", bidRegime: "lowest_cost", cohort: "upper_funnel" })}
      />,
    );
    // role + bidRegime + cohort = 3 visible, no overflow badge.
    expect(html).toContain("Prospecting Scale");
    expect(html).toContain("Lowest Cost");
    expect(html).toContain('data-cohort-chip="upper_funnel"');
    expect(html).not.toMatch(/>\+\d+</);
  });

  it("states money at stake from structured metrics against the pulse target", () => {
    const html = renderToStaticMarkup(
      <MetaActionCard
        moneyCurrency="EUR"
        targetRoas={2}
        rec={metaRec({ metrics: { spend: 412, roas: 0.6, cpa: 38, purchases: 10, frequency: 3.8 } })}
      />,
    );
    expect(html).toContain("data-money-at-stake");
    expect(html).toContain("412");
    expect(html).toContain("0.60×");
    expect(html).toContain("2.00× target");
  });

  it("never fabricates a money figure — missing metrics render an em dash", () => {
    const html = renderToStaticMarkup(<MetaActionCard rec={metaRec({ metrics: null })} />);
    const start = html.indexOf("data-money-at-stake");
    const stake = html.slice(start, html.indexOf("</span>", start));
    expect(stake).toContain("—");
  });

  it("uses structured metrics for the money line and ignores stale display strings", () => {
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
    expect(html).toContain("3.20×");
    expect(html).not.toContain("STALE DISPLAY");
    expect(html).not.toContain("0.01x STALE");
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

  it("renders server-owned row blocker and protection warning without deriving the action in UI", () => {
    const html = renderToStaticMarkup(
      <MetaActionCard
        rec={metaRec({
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
        })}
      />,
    );
    expect(html).toContain('data-row-signal="blocker"');
    expect(html).toContain("No Empirical Outcome Model");
    expect(html).toContain("data-row-warn-line");
    expect(html).toContain("Automation blocked");
    expect(html).not.toContain("data-automation-readiness");
  });

  it("renders the reference row thumb, account badge, and compact auto pill only from rowPresentation", () => {
    const html = renderToStaticMarkup(
      <MetaActionCard
        rec={metaRec({
          rowPresentation: {
            accountBadge: "act_12345",
            thumbLabel: "VID",
            signal: "shield",
            shieldLabel: "Operator protection active",
            autoBadge: true,
            warnLine: "Operator protection active · verified server-side.",
          },
          automationReadiness: {
            contractVersion: "meta-automation-readiness.v1",
            tier: "auto_execute",
            autoExecuteEligible: true,
            operatorReviewRequired: false,
            decisionLabel: "scale",
            blockers: [],
            missingEvidence: [],
            requiredEvidence: ["commercial_anchor"],
            reason: "All automation checks passed.",
          },
        })}
      />,
    );
    expect(html).toContain('data-row-signal="shield"');
    expect(html).toContain('data-row-thumb="VID"');
    expect(html).toContain("act_12345");
    expect(html).toContain('data-automation-tier="auto_execute"');
    expect(html).toContain(">auto<");
    expect(html).toContain("verified server-side");
  });

  it("renders anomaly rows in diagnostic mode", () => {
    const html = renderToStaticMarkup(
      <MetaActionCard
        anomaly={metaAnomaly({
          diagnosticLadder: [{ step: 1, label: "Tracking", detail: "Check events first." }],
        })}
      />,
    );
    expect(html).toContain("Policy delivery block");
    expect(html).toContain("Open diagnostic");
    expect(html).toContain("Tracking");
    expect(html).toContain("Check events first.");
  });

  it("renders non-purchase cohort chips on recommendation rows", () => {
    const html = renderToStaticMarkup(<MetaActionCard rec={metaRec({ cohort: "upper_funnel" })} />);
    expect(html).toContain("Upper Funnel");
    expect(html).toContain('data-cohort-chip="upper_funnel"');
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
