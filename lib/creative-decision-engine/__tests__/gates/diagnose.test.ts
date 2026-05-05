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
  it("diagnoses active creatives with no recent spend but prior spend", () => {
    const output = terminalOutput(
      diagnoseGate(
        resolvedContext({
          effectiveStatus: "ACTIVE",
          recent7dSpend: 0,
          spend: 500,
        }),
      ),
    );

    expect(output.label).toBe("diagnose");
    expect(output.reason).toBe(
      "Active creative — 0 spend in last 7d, 28d total $500 — check delivery (ad set status, budget, audience size, frequency caps).",
    );
    expect(output.confidence).toBe(65);
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

  it("does not diagnose tracking anomaly when add-to-cart is missing", () => {
    const result = diagnoseGate(
      resolvedContext({
        spend: 500,
        impressions: 5000,
        linkClicks: 100,
        landingPageViews: 80,
        addToCart: 0,
        initiateCheckout: 0,
        purchases: 0,
      }),
    );

    expect(result.kind).toBe("advance");
  });

  it("diagnoses tracking anomaly through funnel diagnosis", () => {
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
    expect(output.reason).toContain("Tracking anomaly:");
    expect(output.badges).toContainEqual({
      type: "tracking_anomaly",
      label: "Tracking anomaly",
      severity: "warning",
    });
    expect(output.confidence).toBe(85);
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
