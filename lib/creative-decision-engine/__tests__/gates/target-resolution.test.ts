import { describe, expect, it } from "vitest";
import { defaultBusinessConfig } from "../../config";
import { targetResolutionGate } from "../../gates/target-resolution";
import {
  makeAccountCalibration,
  makeCreativeInput,
  makeGateContext,
} from "../helpers";

function advanceContext(result: ReturnType<typeof targetResolutionGate>) {
  if (result.kind !== "advance") {
    throw new Error("Target resolution should always advance.");
  }
  return result.context;
}

describe("targetResolutionGate", () => {
  it("uses commercial truth when input targetRoas is finite and positive", () => {
    const ctx = advanceContext(
      targetResolutionGate(
        makeGateContext({
          input: makeCreativeInput({ targetRoas: 2.2 }),
        }),
      ),
    );

    expect(ctx.truthSource).toBe("commercial_truth");
    expect(ctx.effectiveTargetRoas).toBe(2.2);
    expect(ctx.badges).toEqual([]);
    expect(ctx.confidenceDeltas).toEqual([]);
  });

  it("falls back to mature account P75 baseline", () => {
    const ctx = advanceContext(
      targetResolutionGate(
        makeGateContext({
          input: makeCreativeInput({ targetRoas: null }),
          calibration: makeAccountCalibration({
            matureCreativeCount: 35,
            roasP75: 2.4,
          }),
        }),
      ),
    );

    expect(ctx.truthSource).toBe("account_baseline");
    expect(ctx.effectiveTargetRoas).toBe(2.4);
    expect(ctx.badges).toEqual([
      {
        type: "truth_account_baseline",
        label: "Truth: account baseline (P75)",
        severity: "info",
      },
    ]);
    expect(ctx.confidenceDeltas).toEqual([-5]);
  });

  it("falls back to thin account P60 baseline", () => {
    const ctx = advanceContext(
      targetResolutionGate(
        makeGateContext({
          input: makeCreativeInput({ targetRoas: null }),
          calibration: makeAccountCalibration({
            matureCreativeCount: 12,
            roasP75: null,
            roasP60: 1.9,
          }),
        }),
      ),
    );

    expect(ctx.truthSource).toBe("account_baseline_thin");
    expect(ctx.effectiveTargetRoas).toBe(1.9);
    expect(ctx.badges).toEqual([
      {
        type: "truth_account_baseline_thin",
        label: "Truth: thin account baseline (P60)",
        severity: "warning",
      },
    ]);
    expect(ctx.confidenceDeltas).toEqual([-15]);
  });

  it("falls back to global default when commercial and account truth are missing", () => {
    const businessConfig = defaultBusinessConfig("biz-1");
    const ctx = advanceContext(
      targetResolutionGate(
        makeGateContext({
          input: makeCreativeInput({ targetRoas: null }),
          businessConfig,
          calibration: makeAccountCalibration({
            matureCreativeCount: 5,
            roasP75: null,
            roasP60: null,
          }),
        }),
      ),
    );

    expect(ctx.truthSource).toBe("global_default");
    expect(ctx.effectiveTargetRoas).toBe(
      businessConfig.globalDefaultTargetRoas,
    );
    expect(ctx.badges).toEqual([
      {
        type: "truth_global_default",
        label: "Truth: global default (operator review)",
        severity: "warning",
      },
    ]);
    expect(ctx.confidenceDeltas).toEqual([-25]);
  });

  it("computes ratioToTarget when roas is present", () => {
    const ctx = advanceContext(
      targetResolutionGate(
        makeGateContext({
          input: makeCreativeInput({ roas: 3.0, targetRoas: 2.2 }),
        }),
      ),
    );

    expect(ctx.ratioToTarget).toBeCloseTo(3.0 / 2.2, 5);
  });

  it("keeps ratioToTarget null when roas is null", () => {
    const ctx = advanceContext(
      targetResolutionGate(
        makeGateContext({
          input: makeCreativeInput({ roas: null, targetRoas: 2.2 }),
        }),
      ),
    );

    expect(ctx.ratioToTarget).toBeNull();
  });
});
