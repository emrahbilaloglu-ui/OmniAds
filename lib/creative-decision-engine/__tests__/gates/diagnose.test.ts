import { describe, expect, it } from "vitest";
import { targetResolutionGate } from "../../gates/target-resolution";
import { diagnoseGate } from "../../gates/diagnose";
import {
  makeAccountCalibration,
  makeCreativeInput,
  makeGateContext,
} from "../helpers";

function resolvedContext(
  inputOverrides: Parameters<typeof makeCreativeInput>[0] = {},
  calibrationOverrides: Parameters<typeof makeAccountCalibration>[0] = {},
) {
  const result = targetResolutionGate(
    makeGateContext({
      input: makeCreativeInput(inputOverrides),
      calibration: makeAccountCalibration(calibrationOverrides),
    }),
  );

  if (result.kind !== "advance") {
    throw new Error("Target resolution should always advance.");
  }

  return result.context;
}

function terminalOutput(result: ReturnType<typeof diagnoseGate>) {
  if (result.kind !== "terminal") {
    throw new Error("Expected terminal diagnose result.");
  }
  return result.output;
}

describe("diagnoseGate", () => {
  it("diagnoses unknown delivery status instead of allowing performance actions", () => {
    const output = terminalOutput(
      diagnoseGate(
        resolvedContext({
          effectiveStatus: null,
          purchases: 0,
          spend: 300,
          ageDays: 14,
        }),
      ),
    );

    expect(output.label).toBe("diagnose");
    expect(output.reason).toContain("Delivery status is unavailable");
    expect(output.badges).toContainEqual({
      type: "delivery_status_unknown",
      label: "Delivery status unavailable",
      severity: "warning",
    });
  });

  it("preserves explicit policy proof when delivery status is unknown", () => {
    const output = terminalOutput(
      diagnoseGate(
        resolvedContext({
          effectiveStatus: null,
          policyReason: "Creative has prohibited claims",
          spend: 300,
        }),
      ),
    );

    expect(output.label).toBe("diagnose");
    expect(output.reason).toContain("Policy reject");
    expect(output.badges).toContainEqual(
      expect.objectContaining({ type: "policy_blocked" }),
    );
    expect(output.badges).not.toContainEqual(
      expect.objectContaining({ type: "delivery_status_unknown" }),
    );
  });

  it("preserves disapproved review proof when delivery status is unknown", () => {
    const output = terminalOutput(
      diagnoseGate(
        resolvedContext({
          effectiveStatus: null,
          reviewStatus: "DISAPPROVED",
          spend: 300,
        }),
      ),
    );

    expect(output.badges).toContainEqual(
      expect.objectContaining({ type: "policy_blocked" }),
    );
  });

  it("adds a warning but does not diagnose active creatives with no recent spend", () => {
    const result = diagnoseGate(
      resolvedContext({
        effectiveStatus: "ACTIVE",
        recent7dSpend: 0,
        spend: 500,
      }),
    );

    expect(result.kind).toBe("advance");
    if (result.kind === "advance") {
      expect(result.context.badges).toContainEqual({
        type: "delivery_limited",
        label:
          "Active creative has 0 spend in last 7d after $500 28d spend; treat as low-delivery warning, not creative failure",
        severity: "info",
      });
      expect(result.context.confidenceDeltas).toContain(-5);
    }
  });

  it("diagnoses active creatives only when 24h no-delivery proof exists", () => {
    const output = terminalOutput(
      diagnoseGate(
        resolvedContext({
          effectiveStatus: "ACTIVE",
          recent7dSpend: 0,
          spend24h: 0,
          impressions24h: 0,
          spend: 500,
        }),
      ),
    );

    expect(output.label).toBe("diagnose");
    expect(output.reason).toContain("verified 0 spend and 0 impressions");
    expect(output.badges).toContainEqual({
      type: "delivery_no_spend_24h",
      label:
        "Active creative has verified 0 spend and 0 impressions in the latest daily delivery window.",
      severity: "warning",
    });
  });

  it("does not emit fix-delivery proof from stale latest-window data", () => {
    const result = diagnoseGate(
      resolvedContext({
        effectiveStatus: "ACTIVE",
        spend24h: 0,
        impressions24h: 0,
        spend: 500,
        dataFreshnessHours: 72,
      }),
    );

    expect(result.kind).toBe("advance");
    if (result.kind === "advance") {
      expect(result.context.badges).toContainEqual({
        type: "stale_evidence",
        label:
          "Stale evidence: last sync 72h ago - refresh pipeline before applying.",
        severity: "warning",
      });
      expect(result.context.badges).not.toContainEqual(
        expect.objectContaining({ type: "delivery_no_spend_24h" }),
      );
    }
  });

  it("keeps stale data as evidence and suppresses lower-confidence delivery warnings", () => {
    const result = diagnoseGate(
      resolvedContext({
        effectiveStatus: "ACTIVE",
        recent7dSpend: 0,
        spend: 500,
        dataFreshnessHours: 72,
      }),
    );

    expect(result.kind).toBe("advance");
    if (result.kind === "advance") {
      expect(result.context.badges).toContainEqual(
        expect.objectContaining({ type: "stale_evidence" }),
      );
      expect(result.context.badges).not.toContainEqual(
        expect.objectContaining({ type: "delivery_limited" }),
      );
    }
  });

  it("marks unknown freshness and suppresses lower-confidence delivery warnings", () => {
    const result = diagnoseGate(
      resolvedContext({
        effectiveStatus: "ACTIVE",
        recent7dSpend: 0,
        spend: 500,
        dataFreshnessHours: null,
      }),
    );

    expect(result.kind).toBe("advance");
    if (result.kind === "advance") {
      expect(result.context.badges).toContainEqual({
        type: "unknown_freshness",
        label:
          "Unknown freshness: source sync age is unavailable - refresh pipeline before applying.",
        severity: "warning",
      });
      expect(result.context.badges).not.toContainEqual(
        expect.objectContaining({ type: "delivery_limited" }),
      );
    }
  });

  it("diagnoses rejected creatives with policy fallback reason", () => {
    const output = terminalOutput(
      diagnoseGate(
        resolvedContext({
          effectiveStatus: "REJECTED",
          policyReason: null,
        }),
      ),
    );

    expect(output.label).toBe("diagnose");
    expect(output.reason).toBe(
      "Policy rejection detected — review and resubmit.",
    );
    expect(output.confidence).toBe(75);
    expect(output.badges).toContainEqual({
      type: "policy_blocked",
      label: "Policy/review block detected",
      severity: "warning",
    });
  });

  it("diagnoses non-empty policy reasons regardless of active or paused status", () => {
    const activeOutput = terminalOutput(
      diagnoseGate(
        resolvedContext({
          effectiveStatus: "ACTIVE",
          policyReason: "Creative has prohibited claims",
        }),
      ),
    );
    const pausedOutput = terminalOutput(
      diagnoseGate(
        resolvedContext({
          effectiveStatus: "PAUSED",
          policyReason: "Image text issue",
        }),
      ),
    );

    expect(activeOutput.reason).toBe(
      "Policy reject: Creative has prohibited claims",
    );
    expect(pausedOutput.reason).toBe("Policy reject: Image text issue");
  });

  it("keeps policy proof visible with stale evidence and capped confidence", () => {
    const output = terminalOutput(
      diagnoseGate(
        resolvedContext({
          effectiveStatus: "REJECTED",
          policyReason: "Creative has prohibited claims",
          dataFreshnessHours: 72,
        }),
      ),
    );

    expect(output.reason).toBe("Policy reject: Creative has prohibited claims");
    expect(output.confidence).toBe(65);
    expect(output.badges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "stale_evidence" }),
        expect.objectContaining({ type: "policy_blocked" }),
      ]),
    );
  });

  it("uses exact review status membership for policy blocks", () => {
    const blocked = terminalOutput(
      diagnoseGate(
        resolvedContext({
          reviewStatus: "DISAPPROVED",
        }),
      ),
    );
    const passed = diagnoseGate(
      resolvedContext({
        reviewStatus: "ad rejected_review_passed",
      }),
    );

    expect(blocked.badges).toContainEqual({
      type: "policy_blocked",
      label: "Policy/review block detected",
      severity: "warning",
    });
    expect(passed.kind).toBe("advance");
  });

  it("does not treat issue-only review statuses as policy blocks", () => {
    const withIssues = diagnoseGate(
      resolvedContext({
        reviewStatus: "WITH_ISSUES",
      }),
    );
    const pendingBilling = diagnoseGate(
      resolvedContext({
        reviewStatus: "PENDING_BILLING_INFO",
      }),
    );

    expect(withIssues.kind).toBe("advance");
    expect(pendingBilling.kind).toBe("advance");
  });

  it("does not terminally diagnose stale data by itself", () => {
    const result = diagnoseGate(
      resolvedContext({
        dataFreshnessHours: 72,
      }),
    );

    expect(result.kind).toBe("advance");
    if (result.kind === "advance") {
      expect(result.context.badges).toContainEqual({
        type: "stale_evidence",
        label:
          "Stale evidence: last sync 72h ago - refresh pipeline before applying.",
        severity: "warning",
      });
    }
  });

  it("does not diagnose tracking anomaly without healthy upstream funnel activity", () => {
    const result = diagnoseGate(
      resolvedContext({
        spend: 500,
        impressions: 5000,
        linkClicks: 0,
        landingPageViews: 0,
        addToCart: 0,
        initiateCheckout: 0,
        purchases: 0,
      }),
    );

    expect(result.kind).toBe("advance");
  });

  it("diagnoses landing-page funnel issues when add-to-cart collapses after clicks", () => {
    const output = terminalOutput(
      diagnoseGate(
        resolvedContext({
          spend: 500,
          roas: 1,
          impressions: 5000,
          linkClicks: 100,
          landingPageViews: 80,
          addToCart: 0,
          initiateCheckout: 0,
          purchases: 0,
        }),
      ),
    );

    expect(output.label).toBe("diagnose");
    expect(output.reason).toContain("Landing page issue:");
    expect(output.badges).toContainEqual({
      type: "landing_page_issue",
      label: "Landing page issue",
      severity: "warning",
    });
  });

  it("diagnoses checkout breakdown through funnel diagnosis", () => {
    const output = terminalOutput(
      diagnoseGate(
        resolvedContext({
          objective: "OUTCOME_SALES",
          spend: 500,
          roas: 1,
          impressions: 5000,
          linkClicks: 100,
          landingPageViews: 80,
          addToCart: 20,
          initiateCheckout: 10,
          purchases: 0,
        }),
      ),
    );

    expect(output.label).toBe("diagnose");
    expect(output.reason).toContain("Checkout breakdown:");
    expect(output.badges).toContainEqual({
      type: "checkout_breakdown",
      label: "Checkout breakdown",
      severity: "warning",
    });
    expect(output.confidence).toBe(70);
  });

  it("keeps funnel weakness secondary when ROAS is inside the economic keep band", () => {
    const result = diagnoseGate(
      resolvedContext({
        spend: 500,
        roas: 2.1,
        targetRoas: 2.2,
        impressions: 5000,
        linkClicks: 100,
        landingPageViews: 80,
        addToCart: 0,
        initiateCheckout: 0,
        purchases: 4,
      }),
    );

    expect(result.kind).toBe("advance");
    if (result.kind === "advance") {
      expect(result.context.badges).toContainEqual({
        type: "landing_page_issue",
        label: "Landing page issue",
        severity: "warning",
      });
    }
  });

  it("keeps funnel weakness secondary when economic evidence is in the scale zone", () => {
    const result = diagnoseGate(
      resolvedContext({
        spend: 500,
        roas: 3.3,
        targetRoas: 2.2,
        impressions: 5000,
        linkClicks: 100,
        landingPageViews: 80,
        addToCart: 0,
        initiateCheckout: 0,
        purchases: 20,
      }),
    );

    expect(result.kind).toBe("advance");
    if (result.kind === "advance") {
      expect(result.context.badges).toContainEqual(
        expect.objectContaining({ type: "landing_page_issue" }),
      );
    }
  });

  it("advances healthy creatives", () => {
    const result = diagnoseGate(resolvedContext());

    expect(result.kind).toBe("advance");
  });

  it("keeps truth source badges when stale evidence advances", () => {
    const result = diagnoseGate(
      resolvedContext(
        {
          targetRoas: null,
          dataFreshnessHours: 72,
        },
        {
          matureCreativeCount: 35,
          roasP75: 2.4,
        },
      ),
    );

    expect(result.kind).toBe("advance");
    if (result.kind === "advance") {
      expect(result.context.truthSource).toBe("account_baseline");
      expect(result.context.effectiveTargetRoas).toBe(2.4);
      expect(result.context.badges).toEqual([
        {
          type: "truth_account_baseline",
          label: "Truth: account baseline (P75)",
          severity: "info",
        },
        {
          type: "stale_evidence",
          label:
            "Stale evidence: last sync 72h ago - refresh pipeline before applying.",
          severity: "warning",
        },
      ]);
    }
  });
});
