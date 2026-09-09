/**
 * THE HISTORICAL CALIBRATION FORMULAS, TAKEN FROM THE BLOBS THAT MINTED THEM.
 *
 * Round 10, item 2. Round 9 routed `.v1`, `.v2` and `.v3` through ONE
 * `.v3`-era cell formula and gave every version a batch formula that included
 * `spendUnitAuthority`. Both claims are false, and `git show` says so:
 *
 *   6d7b54ce3  mints `engine-v3-native-ad-calibration.v1`
 *   8147d5e27  mints `engine-v3-native-ad-calibration.v2`
 *   f07105197  mints `engine-v3-native-ad-calibration.v3`
 *
 * What actually differs:
 *
 *   - BATCH generation content. `.v1` and `.v2` have NO `spendUnitAuthority`
 *     key. The member first appears in the `.v3` blob. An absent key and a
 *     present-but-undefined key are different digests, so a `.v1` batch
 *     recomputed under the Round 9 rule could never have matched.
 *   - CELL manifest. `.v1` and `.v2` digested an entirely different object:
 *     `{contractVersion, policyVersion, engineVersion, key, asOfDate,
 *      asOfCutoff, sampleWindowStart, sampleWindowEnd,
 *      targetAuthority: purchase ? … : null, qualityStatus,
 *      metricSampleCounts, actionReadiness, observations}`
 *     — no `computedAt`, no counts, no `accountCalibration`, no
 *     `funnelCalibration`, no source dates, no batch/source manifest hashes,
 *     no `qualityCounts`. The `.v3` shape has all of those and no
 *     `observations`.
 *
 * ## Provenance of the fixtures below — stated plainly
 *
 * They are SYNTHETIC and OFFLINE. No captured production `.v1` or `.v2` row
 * exists in this repository, and none can be manufactured: the calibration
 * table has no `observations` column, so a durable row cannot carry the input
 * those formulas digest. The fixtures are built here from the literal formula
 * implementations, and what they prove is that the three formulas are DISTINCT
 * and that each is reproducible — not that any row on a real database was ever
 * written with them.
 *
 * That limitation is the reason `nativeAdCalibrationDurablyRecomputable`
 * answers false for `.v1`/`.v2` and the reason durable pre-stamp rows stay
 * `legacy_unknown` and fail closed rather than being relabelled.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { canonicalSha256 } from "../../canonical-evaluation";
import {
  NATIVE_AD_CALIBRATION_CONTRACT_VERSION,
  NATIVE_AD_CALIBRATION_LEGACY_UNKNOWN_CONTRACT,
  nativeAdCalibrationCellInputManifestContentV1V2,
  nativeAdCalibrationDurablyRecomputable,
  recomputeNativeAdCalibrationCellInputManifestHash,
  type NativeAdCalibrationCell,
} from "../../jobs/ad-calibration-job";

// The `.v3`-stamped synthetic batch, which carries real observations and real
// target clocks — the material both historical formulas need.
const FROZEN = JSON.parse(
  readFileSync(
    join(
      __dirname,
      "../fixtures/native-ad-spend-unit-authority.v3.frozen.json",
    ),
    "utf8",
  ),
) as {
  contractVersion: string;
  policyVersion: string;
  engineVersion: string;
  observations: unknown[];
  cells: NativeAdCalibrationCell[];
  targetAuthority: NativeAdCalibrationCell["targetAuthority"];
};

/** One cell's `.v1`/`.v2` manifest, built through the exported formula. */
function historicalCellManifest(
  version:
    | "engine-v3-native-ad-calibration.v1"
    | "engine-v3-native-ad-calibration.v2",
  over: { purchase?: boolean } = {},
) {
  const cell = FROZEN.cells[0]!;
  return nativeAdCalibrationCellInputManifestContentV1V2({
    contractVersion: version,
    policyVersion: cell.policyVersion,
    engineVersion: cell.engineVersion,
    key: cell.key,
    asOfDate: cell.asOfDate,
    asOfCutoff: cell.asOfCutoff,
    sampleWindowStart: cell.sampleWindowStart,
    sampleWindowEnd: cell.sampleWindowEnd,
    targetAuthority: cell.targetAuthority,
    purchase: over.purchase ?? true,
    qualityStatus: cell.qualityStatus,
    metricSampleCounts: cell.metricSampleCounts,
    actionReadiness: cell.actionReadiness,
    observations: FROZEN.observations,
  });
}

describe("the .v1 / .v2 cell formula is a different object entirely", () => {
  it("digests observations, which the .v3 shape does not carry", () => {
    const manifest = historicalCellManifest(
      "engine-v3-native-ad-calibration.v1",
    );
    expect(Object.keys(manifest)).toEqual([
      "contractVersion",
      "policyVersion",
      "engineVersion",
      "key",
      "asOfDate",
      "asOfCutoff",
      "sampleWindowStart",
      "sampleWindowEnd",
      "targetAuthority",
      "qualityStatus",
      "metricSampleCounts",
      "actionReadiness",
      "observations",
    ]);
    // The fields the `.v3` shape added, absent here.
    for (const key of [
      "computedAt",
      "sourceAdCount",
      "accountCalibration",
      "funnelCalibration",
      "batchInputManifestHash",
      "sourceManifestHash",
      "qualityCounts",
    ]) {
      expect(manifest).not.toHaveProperty(key);
    }
  });

  it("nulls the target authority for a non-purchase cohort", () => {
    // `targetAuthority: purchase ? batch.targetAuthority : null` — verbatim
    // from both blobs, and a real discriminator in the digest.
    expect(
      historicalCellManifest("engine-v3-native-ad-calibration.v1", {
        purchase: false,
      }).targetAuthority,
    ).toBeNull();
    expect(
      canonicalSha256(
        historicalCellManifest("engine-v3-native-ad-calibration.v1", {
          purchase: false,
        }),
      ),
    ).not.toBe(
      canonicalSha256(
        historicalCellManifest("engine-v3-native-ad-calibration.v1"),
      ),
    );
  });

  it("makes .v1 and .v2 DISTINCT digests, never inferred from each other", () => {
    /*
      The two share a formula but not a `contractVersion`, which the formula
      itself digests. A recompute that inferred one from the other would
      collapse these, and a `.v2` row verified as `.v1` would read as corrupt.
    */
    const v1 = canonicalSha256(
      historicalCellManifest("engine-v3-native-ad-calibration.v1"),
    );
    const v2 = canonicalSha256(
      historicalCellManifest("engine-v3-native-ad-calibration.v2"),
    );
    expect(v1).not.toBe(v2);
  });

  it("is a DIFFERENT digest from the .v3 formula on the same cell", () => {
    /*
      The control that makes the whole item mean something. If the historical
      formula happened to agree with the `.v3` one, Round 9's single-formula
      shortcut would have been harmless.
    */
    const historical = canonicalSha256(
      historicalCellManifest("engine-v3-native-ad-calibration.v1"),
    );
    const v3 = recomputeNativeAdCalibrationCellInputManifestHash(
      FROZEN.cells[0]!,
      "engine-v3-native-ad-calibration.v3",
    );
    expect(historical).not.toBe(v3);
  });
});

describe("the .v1 / .v2 BATCH formula has no spend-unit authority", () => {
  /*
    The other half of item 2, and the one a cell-level assertion cannot see.
    `nativeAdCalibrationBatchGenerationContent` is what `generationContentHash`
    digests, and the `spendUnitAuthority` member first appears in the `.v3`
    blob. Round 9 gave every version the key.
  */
  const batchFacts = (version: string) => ({
    ...FROZEN,
    contractVersion: version,
  });

  it("omits the key entirely for .v1 and .v2", async () => {
    const { nativeAdCalibrationBatchGenerationContent } = await import(
      "../../jobs/ad-calibration-job"
    );
    for (const version of [
      "engine-v3-native-ad-calibration.v1",
      "engine-v3-native-ad-calibration.v2",
    ]) {
      const content = nativeAdCalibrationBatchGenerationContent(
        batchFacts(version) as never,
      );
      // ABSENT, not present-and-undefined: the two are different digests.
      expect(Object.keys(content)).not.toContain("spendUnitAuthority");
    }
  });

  it("includes it for .v3 and the current version", async () => {
    const { nativeAdCalibrationBatchGenerationContent } = await import(
      "../../jobs/ad-calibration-job"
    );
    for (const version of [
      "engine-v3-native-ad-calibration.v3",
      NATIVE_AD_CALIBRATION_CONTRACT_VERSION,
    ]) {
      expect(
        Object.keys(
          nativeAdCalibrationBatchGenerationContent(batchFacts(version) as never),
        ),
      ).toContain("spendUnitAuthority");
    }
  });

  it("produces a DIFFERENT generation digest for .v2 than for .v3", async () => {
    /*
      The discriminating assertion. If the member's presence did not move the
      digest, Round 9's uniform formula would have been harmless — and a `.v2`
      batch recomputed under it would still have matched.
    */
    const { nativeAdCalibrationBatchGenerationContent } = await import(
      "../../jobs/ad-calibration-job"
    );
    const v2 = canonicalSha256(
      nativeAdCalibrationBatchGenerationContent(
        batchFacts("engine-v3-native-ad-calibration.v2") as never,
      ),
    );
    const v3 = canonicalSha256(
      nativeAdCalibrationBatchGenerationContent(
        batchFacts("engine-v3-native-ad-calibration.v3") as never,
      ),
    );
    expect(v2).not.toBe(v3);
  });
});

describe("durable readability is claimed only where it is true", () => {
  it("refuses to recompute .v1 / .v2 from a durable row", () => {
    for (const version of [
      "engine-v3-native-ad-calibration.v1",
      "engine-v3-native-ad-calibration.v2",
    ] as const) {
      expect(nativeAdCalibrationDurablyRecomputable(version)).toBe(false);
      expect(() =>
        recomputeNativeAdCalibrationCellInputManifestHash(
          FROZEN.cells[0]!,
          version,
        ),
      ).toThrow(/cannot be recomputed from durable columns/);
    }
  });

  it("DOES recompute .v3 and the current version from durable columns", () => {
    for (const version of [
      "engine-v3-native-ad-calibration.v3",
      NATIVE_AD_CALIBRATION_CONTRACT_VERSION,
    ] as const) {
      expect(nativeAdCalibrationDurablyRecomputable(version)).toBe(true);
      expect(
        recomputeNativeAdCalibrationCellInputManifestHash(
          FROZEN.cells[0]!,
          version,
        ),
      ).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("verifies the .v3 fixture against its own stored hash, with real clocks", () => {
    /*
      The `.v3` half IS durably verifiable, and this is the fixture the audit
      asked for: non-null `effectiveAt` / `recordedAt` on the target authority,
      which the `.v3` formula keeps and the `.v5` formula projects out.
    */
    expect(FROZEN.contractVersion).toBe("engine-v3-native-ad-calibration.v3");
    const cell = FROZEN.cells[0]!;
    expect(cell.targetAuthority.effectiveAt).not.toBeNull();
    expect(cell.targetAuthority.recordedAt).not.toBeNull();
    expect(
      recomputeNativeAdCalibrationCellInputManifestHash(
        cell,
        "engine-v3-native-ad-calibration.v3",
      ),
    ).toBe(cell.inputManifestHash);
  });

  it("keeps an unstamped durable row at legacy_unknown, not relabelled", () => {
    // The sentinel is not one of the recomputable versions, and nothing in this
    // module maps it onto one.
    expect(NATIVE_AD_CALIBRATION_LEGACY_UNKNOWN_CONTRACT).toBe(
      "legacy_unknown",
    );
    expect(() =>
      nativeAdCalibrationDurablyRecomputable(
        NATIVE_AD_CALIBRATION_LEGACY_UNKNOWN_CONTRACT as never,
      ),
    ).toThrow(/Unsupported native ad calibration contract/);
  });
});
