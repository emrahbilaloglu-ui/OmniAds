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

  it("does not diagnose tracking anomaly below minimum spend", () => {
    const result = diagnoseGate(
      resolvedContext({
        spend: 30,
        impressions: 5000,
        linkClicks: 0,
        purchases: 0,
      }),
    );

    expect(result.kind).toBe("advance");
  });

  it("does not diagnose tracking anomaly below minimum impressions", () => {
    const result = diagnoseGate(
      resolvedContext({
        spend: 100,
        impressions: 500,
        linkClicks: 0,
        purchases: 0,
      }),
    );

    expect(result.kind).toBe("advance");
  });

  it("does not diagnose tracking anomaly for awareness objectives", () => {
    const result = diagnoseGate(
      resolvedContext({
        objective: "OUTCOME_AWARENESS",
        spend: 100,
        impressions: 5000,
        linkClicks: 0,
        purchases: 0,
      }),
    );

    expect(result.kind).toBe("advance");
  });

  it("diagnoses tracking anomaly when spend, impressions, and objective match", () => {
    const output = terminalOutput(
      diagnoseGate(
        resolvedContext({
          objective: "OUTCOME_SALES",
          spend: 100,
          impressions: 5000,
          linkClicks: 0,
          purchases: 0,
        }),
      ),
    );

    expect(output.label).toBe("diagnose");
    expect(output.reason).toBe(
      "Spend $100 on 5000 impressions in last 28 days, but 0 clicks and 0 purchases — possible tracking anomaly (pixel/CAPI). Verify event firing before acting.",
    );
    expect(output.confidence).toBe(55);
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
