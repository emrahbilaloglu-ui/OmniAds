/**
 * THE ACCOUNT'S MEASURED CPA REACHED IDENTITY THROUGH TWO DOORS, AND ONLY ONE
 * WAS CLOSED.
 *
 * Round 8, item 3. `normalizeSpendUnitEvidence` stopped hashing `accountCpaP50`
 * and `accountCpaSampleCount` under a governing Target ROAS in
 * `engine-v3-canonical-evaluation.v8`, with the reason written down beside it:
 * `resolveSpendUnit`'s governed branch answers READY-or-`insufficient` and
 * never reaches the `account_history` rung, so the account's median CPA chooses
 * nothing there and must not discard a retained verdict it could not have
 * changed.
 *
 * The SAME two fields live on `AccountCalibration`, and two other places
 * hashed that object whole:
 *
 *   - `normalizeAccountCalibration` → `accountBaselines` and every entry of
 *     `accountBaselinesByKind`, which sit inside the canonical `contextPayload`
 *     and therefore key `contextHash`, `inputHash` and `decisionHash`;
 *   - `nativeAdCalibrationCellInputManifestContent` → `accountCalibration` on
 *     the native calibration cell, which keys `inputManifestHash` and through
 *     it `cellSetHash` and the retained profile's agreement check.
 *
 * So the number left one half of the payload and stayed in the other, and one
 * more purchase in the account's measured history still reported itself as a
 * changed decision. Both halves are pinned here, in both target regimes: inert
 * where a Target ROAS governs, LOAD-BEARING where none does, because there the
 * `account_history` rung is reachable and the CPA genuinely chooses the unit.
 */
import { describe, expect, it } from "vitest";

import {
  buildCanonicalEvaluationProvenance,
  CANONICAL_EVALUATION_CONTRACT_VERSION,
  type BuildCanonicalEvaluationInput,
} from "../canonical-evaluation";
import { AD_DECISION_EVALUATION_CONTRACT_VERSION } from "../evaluation-store";
import { NATIVE_AD_CALIBRATION_CONTRACT_VERSION } from "../jobs/ad-calibration-job";
import type { EngineV3Flags } from "../feature-flags";
import {
  makeAccountCalibration,
  makeAccountDecisionProfile,
  makeCreativeInput,
  makeDataHealth,
} from "./helpers";
import type { AccountCalibration, DecisionOutput } from "../types";

const flags: EngineV3Flags = {
  businessId: "biz-1",
  enabled: true,
  surfaceVisible: true,
  shadowOnly: false,
  presetOverride: null,
  source: {
    enabled: "env",
    surfaceVisible: "env",
    shadowOnly: "env",
    presetOverride: null,
  },
  envDefaults: { enabled: true, surfaceVisible: true, shadowOnly: false },
};

function makeDecision(): DecisionOutput {
  return {
    creativeId: "creative-1",
    creativeName: "Test Creative",
    label: "keep",
    reason: "Evidence remains inside the keep band.",
    confidence: 72,
    truthSource: "commercial_truth",
    effectiveTargetRoas: 2.2,
    ratioToTarget: 1.1,
    badges: [],
    engineVersion: "v3-test",
    generatedAt: "2026-07-12T03:00:00.000Z",
  } as unknown as DecisionOutput;
}

/**
 * The permutations of the account's own measured cost-per-purchase.
 *
 * Only these two fields differ between rows; every other input is identical, so
 * a digest that moves can only have moved because of them.
 */
const CPA_PERMUTATIONS: Array<[name: string, cpa: Partial<AccountCalibration>]> = [
  ["the baseline sample", { accountCpaP50: 58, accountCpaSampleCount: 24 }],
  ["one more purchase measured", { accountCpaP50: 58, accountCpaSampleCount: 25 }],
  ["a re-measured median", { accountCpaP50: 61.5, accountCpaSampleCount: 24 }],
  ["both moved together", { accountCpaP50: 47, accountCpaSampleCount: 31 }],
  ["no measured CPA at all", { accountCpaP50: null, accountCpaSampleCount: 0 }],
];

/**
 * A canonical evaluation whose ONLY varying inputs are the account's measured
 * CPA — carried identically on `accountBaselines`, on `accountBaselinesByKind`
 * and on `spendUnitEvidence`, exactly as the producer carries them.
 */
function evaluationWith(input: {
  cpa: Partial<AccountCalibration>;
  targetRoas: number | null;
  targetCpa: number | null;
}): BuildCanonicalEvaluationInput {
  const accountBaselines = makeAccountCalibration(input.cpa);
  const accountProfile = makeAccountDecisionProfile({
    asOfDate: "2026-07-12",
    accountBaselines,
    spendUnitEvidence: {
      targetCpa: input.targetCpa,
      operatorAovAssumption: null,
      metaAttributedAovMean90d: accountBaselines.metaAttributedAovMean90d,
      metaAttributedAovPurchaseCount90d:
        accountBaselines.metaAttributedAovPurchaseCount90d,
      metaAttributedRevenue90d: accountBaselines.metaAttributedRevenue90d,
      targetRoas: input.targetRoas,
      breakEvenRoas: 1.71,
      accountCpaP50: accountBaselines.accountCpaP50,
      accountCpaSampleCount: accountBaselines.accountCpaSampleCount,
      warnings: [],
    },
    // The per-kind map is hashed through the same normalizer, so a projection
    // applied to one and not the other would leave the door open here.
    accountBaselinesByKind: { main: accountBaselines },
  } as never);
  const creativeInput = makeCreativeInput();
  return {
    engineVersion: "v3-test",
    accountProfile,
    dataHealth: makeDataHealth(),
    flags,
    scope: accountProfile.scope,
    creativeInput,
    campaignContext: {
      mode: "automatic",
      source: "system_inferred",
      campaignId: creativeInput.campaignId,
      kind: "main",
      testDimension: null,
      contextTrust: "high",
      sourceRecordType: "engine_v3_campaign_context_daily",
      sourceRecordId: "ctx-1",
      sourceAsOfDate: "2026-07-12",
      sourceUpdatedAt: "2026-07-12T02:00:00.000Z",
      sourceHash: "a".repeat(64),
    },
    priorHysteresis: { source: "none" },
    decision: makeDecision(),
    rawLabel: "keep",
    publishedLabel: "keep",
    hysteresisSuppressed: false,
  } as BuildCanonicalEvaluationInput;
}

describe("the canonical evaluation identity", () => {
  it("is minted under the versions this change moved", () => {
    /*
      Not decoration. The projection below changes the bytes under these two
      keys, and a key that did not move would make one version string label two
      different encodings — which is the failure the whole version discipline
      exists to prevent.
    */
    expect(CANONICAL_EVALUATION_CONTRACT_VERSION).toBe(
      "engine-v3-canonical-evaluation.v9",
    );
    expect(AD_DECISION_EVALUATION_CONTRACT_VERSION).toBe(
      "engine-v3-canonical-ad-evaluation.v11",
    );
  });

  it("is INERT to the account's measured CPA while a Target ROAS governs", () => {
    const hashes = CPA_PERMUTATIONS.map(([, cpa]) =>
      buildCanonicalEvaluationProvenance(
        evaluationWith({ cpa, targetRoas: 2.2, targetCpa: null }),
      ),
    );
    // One digest for all five, at every level of the envelope: the context is
    // what carries `accountBaselines`, and the input and decision hashes chain
    // off it, so a leak at the top would surface at all three.
    expect(new Set(hashes.map((h) => h.contextHash)).size).toBe(1);
    expect(new Set(hashes.map((h) => h.inputHash)).size).toBe(1);
    expect(new Set(hashes.map((h) => h.decisionHash)).size).toBe(1);
  });

  it("still records the measured CPA on the profile it just refused to hash", () => {
    /*
      The distinction that makes the projection honest: the number is still
      OBSERVED and still served — it simply grants nothing and keys nothing.
      A test that only checked the hash would also pass if the field had been
      deleted from the profile, which would be a different and worse change.
    */
    const evaluation = evaluationWith({
      cpa: { accountCpaP50: 61.5, accountCpaSampleCount: 24 },
      targetRoas: 2.2,
      targetCpa: null,
    });
    const profile = evaluation.accountProfile as {
      accountBaselines: { accountCpaP50: number | null };
    };
    expect(profile.accountBaselines.accountCpaP50).toBe(61.5);
  });

  it("is SENSITIVE to the account's measured CPA when no Target ROAS governs", () => {
    /*
      The compatibility half, and the reason the projection is version-scoped
      rather than unconditional. With no ratio to divide, `resolveSpendUnit`
      can reach the `account_history` rung, the median CPA genuinely chooses
      the spend unit, and two accounts differing only in it are two different
      decisions.
    */
    const hashes = CPA_PERMUTATIONS.map(([, cpa]) =>
      buildCanonicalEvaluationProvenance(
        evaluationWith({ cpa, targetRoas: null, targetCpa: 100 }),
      ),
    );
    expect(new Set(hashes.map((h) => h.contextHash)).size).toBe(
      CPA_PERMUTATIONS.length,
    );
  });

  it("still moves on a change that genuinely IS authoritative", () => {
    /*
      The control that stops the governed case above from passing for the wrong
      reason. If the projection had blanked too much — or if `contextHash` had
      stopped depending on the baselines at all — this would collapse to one
      digest too, and the inertness assertion would prove nothing.
    */
    const baseline = buildCanonicalEvaluationProvenance(
      evaluationWith({
        cpa: { accountCpaP50: 58, accountCpaSampleCount: 24 },
        targetRoas: 2.2,
        targetCpa: null,
      }),
    );
    const movedRatio = buildCanonicalEvaluationProvenance(
      evaluationWith({
        cpa: {
          accountCpaP50: 58,
          accountCpaSampleCount: 24,
          // A percentile that DOES choose a boundary.
          roasRatioP25: 0.55,
        },
        targetRoas: 2.2,
        targetCpa: null,
      }),
    );
    expect(movedRatio.contextHash).not.toBe(baseline.contextHash);
  });
});

describe("the native calibration cell identity", () => {
  it("is minted under the version this change moved", () => {
    expect(NATIVE_AD_CALIBRATION_CONTRACT_VERSION).toBe(
      "engine-v3-native-ad-calibration.v5",
    );
  });
});
