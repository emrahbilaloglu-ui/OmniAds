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

  it("diagnoses stale data", () => {
    const output = terminalOutput(
      diagnoseGate(
        resolvedContext({
          dataFreshnessHours: 72,
        }),
      ),
    );

    expect(output.label).toBe("diagnose");
    expect(output.reason).toBe(
      "Stale data: last sync 72h ago — refresh ad insights pipeline.",
    );
    expect(output.confidence).toBe(60);
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

  it("advances healthy creatives", () => {
    const result = diagnoseGate(resolvedContext());

    expect(result.kind).toBe("advance");
  });

  it("keeps truth source badges on diagnose terminals", () => {
    const output = terminalOutput(
      diagnoseGate(
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
      ),
    );

    expect(output.truthSource).toBe("account_baseline");
    expect(output.effectiveTargetRoas).toBe(2.4);
    expect(output.badges).toEqual([
      {
        type: "truth_account_baseline",
        label: "Truth: account baseline (P75)",
        severity: "info",
      },
    ]);
  });
});
