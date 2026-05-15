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
    expect(html).toContain("Calibration");
    expect(html).toContain("account · 28d_history");
    expect(html).toContain("Signals");
    expect(html).toContain("ready · cap high");
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
    expect(html).toContain("Auto");
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
    expect(html).toContain("Upper-funnel");
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
