/**
 * CODEX repair 2 — a persisted `.v3` spend-unit authority still verifies, and
 * still cannot authorize.
 *
 * `nativeAdSpendUnitAuthorityGenerationContent` and
 * `nativeAdCalibrationActionReadinessManifestContent` asked
 * `contractVersion === NATIVE_AD_SPEND_UNIT_AUTHORITY_CONTRACT_VERSION` to
 * decide whether the store observation is part of the hashed content. The
 * moment `.v4` was minted, every persisted `.v3` row answered "no" to that and
 * was reclassified as LEGACY — so the Shopify evidence went back into its
 * generation and manifest content, which is exactly the hashing rule `.v3` was
 * created to remove. Its stored `generationContentHash`, `inputManifestHash`
 * and `cellSetHash` stopped recomputing, and a historical batch became
 * unverifiable.
 *
 * WHY THE FIXTURE IS FROZEN AND CARRIES A STORE OBSERVATION. A row restamped
 * inside the test would be hashed by whatever the code does today, so it could
 * not detect the code changing. And an authority with NO
 * `observedShopifyAovEvidence` hashes identically whether the rule includes it
 * or not — a fixture without one would pass under either behaviour. These bytes
 * were produced once by the real producer, carry a real observation, and are
 * committed; the assertions below recompute them with production code.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  NATIVE_AD_SPEND_UNIT_AUTHORITY_CONTRACT_VERSION,
  computeNativeAdCalibrationBatch,
  computeNativeAdCalibrationCellSetHash,
  recomputeNativeAdCalibrationBatchGenerationHashes,
  recomputeNativeAdCalibrationCellInputManifestHash,
  recomputeNativeAdSpendUnitAuthorityHash,
  type NativeAdCalibrationBatch,
  type NativeAdCalibrationSourceRow,
} from "@/lib/creative-decision-engine/jobs/ad-calibration-job";

/**
 * The WHOLE batch, not just its cells.
 *
 * Round 6, item 9: the fixture used to be `{ cellSetHash, cells }`, so the only
 * batch-level digest reachable from it was `batchInputManifestHash` — a value
 * the cells CARRY. Every assertion therefore accepted the generation hash
 * rather than proving it, and a change to the generation content's shape could
 * not be detected here at all. The frozen bytes now carry the source
 * provenance, the target and spend-unit authorities, the observations, the
 * quality counts and every stored hash, so all four families are recomputed
 * from the fixture and compared with what the producer wrote.
 */
const FROZEN = JSON.parse(
  readFileSync(
    path.join(
      process.cwd(),
      "lib/creative-decision-engine/__tests__/fixtures/native-ad-spend-unit-authority.v3.frozen.json",
    ),
    "utf8",
  ),
) as NativeAdCalibrationBatch;

/**
 * Source rows shaped like the frozen fixture's, for the producer-drift check.
 *
 * Deliberately NOT the frozen bytes: the point is to run the CURRENT producer
 * end to end and hand its output to the shared recompute, so a drift between
 * the two is caught without a frozen artifact having to be regenerated first.
 */
function liveSourceRows(): NativeAdCalibrationSourceRow[] {
  return ["ad-1", "ad-2", "ad-3", "ad-4", "ad-5"].flatMap((adId) =>
    ["2026-07-09", "2026-07-10", "2026-07-11"].map((date) => ({
      sourceRowId: `${adId}-${date}`,
      businessId: FROZEN.businessId,
      providerAccountRefId: FROZEN.providerAccountRefId,
      providerAccountId: FROZEN.providerAccountId,
      date,
      campaignId: "campaign-1",
      adsetId: "adset-1",
      adId,
      accountTimezone: "Europe/Istanbul",
      accountCurrency: "USD",
      sourceAccountTimezone: "Europe/Istanbul",
      sourceAccountCurrency: "USD",
      metricSchemaVersion: 2,
      objective: "OUTCOME_SALES",
      optimizationGoal: "PURCHASE",
      customEventType: "PURCHASE",
      spend: 100,
      impressions: 10_000,
      clicks: 300,
      linkClicks: 250,
      conversions: 2,
      revenue: 240,
      landingPageViews: 200,
      addToCart: 50,
      initiateCheckout: 20,
      thumbstop: 0.3,
      truthState: "finalized",
      validationStatus: "passed",
      finalizedAt: "2026-07-12T01:00:00.000Z",
      createdAt: "2026-07-12T01:00:00.000Z",
      updatedAt: "2026-07-12T02:00:00.000Z",
      campaignSourceRowId: `campaign-source-${date}`,
      campaignTruthState: "finalized",
      campaignValidationStatus: "passed",
      campaignCreatedAt: "2026-07-12T01:00:00.000Z",
      campaignUpdatedAt: "2026-07-12T02:00:00.000Z",
      adsetSourceRowId: `adset-source-${date}`,
      adsetTruthState: "finalized",
      adsetValidationStatus: "passed",
      adsetCreatedAt: "2026-07-12T01:00:00.000Z",
      adsetUpdatedAt: "2026-07-12T02:00:00.000Z",
    })) as NativeAdCalibrationSourceRow[],
  );
}

describe("the frozen v3 batch", () => {
  it("is a real v3 batch carrying a real store observation", () => {
    expect(FROZEN.cells.length).toBeGreaterThan(1);
    for (const cell of FROZEN.cells) {
      const authority = cell.actionReadiness.spendUnitAuthority;
      expect(authority.contractVersion).toBe(
        "engine-v3-native-ad-spend-unit-authority.v3",
      );
      // Not the version being minted — otherwise this asserts nothing about
      // historical compatibility.
      expect(authority.contractVersion).not.toBe(
        NATIVE_AD_SPEND_UNIT_AUTHORITY_CONTRACT_VERSION,
      );
      // The observation is present, which is what makes the include/exclude
      // rule observable in the hashes at all.
      expect(authority.observedShopifyAovEvidence?.aovMinor).toBe(5_804);
    }
  });

  it("recomputes every stored authorityHash exactly", () => {
    for (const cell of FROZEN.cells) {
      const authority = cell.actionReadiness.spendUnitAuthority;
      expect(
        recomputeNativeAdSpendUnitAuthorityHash(authority),
        cell.key.optimizationContext,
      ).toBe(authority.authorityHash);
    }
  });

  it("recomputes every stored inputManifestHash exactly", () => {
    /*
      This is the assertion that fails when `.v3` is treated as legacy: the
      manifest content then carries the store observation again and the digest
      moves. `inputManifestHash` is taken over the generation content, so this
      covers the generation hash too.
    */
    for (const cell of FROZEN.cells) {
      expect(
        /*
          UNDER THE BATCH'S OWN CONTRACT, not today's.

          `.v5` projects the account's measured CPA out of the cell manifest;
          `.v4` — which is what this batch is — hashed `accountCalibration`
          whole. Recomputing a historical row under the current formula would
          fail it for a rule it was never written with, so the recompute is
          version-scoped and this passes the version the row actually carries.
        */
        recomputeNativeAdCalibrationCellInputManifestHash(
          cell,
          FROZEN.contractVersion,
        ),
        cell.key.optimizationContext,
      ).toBe(cell.inputManifestHash);
    }
  });

  it("does NOT recompute the frozen cells under the current contract", () => {
    /*
      The control that makes the version scoping mean something. If `.v5` and
      `.v4` produced the same bytes there would be nothing to scope, the
      version bump would be decorative, and the assertion above would pass for
      the wrong reason.
    */
    const differing = FROZEN.cells.filter(
      (cell) =>
        recomputeNativeAdCalibrationCellInputManifestHash(cell) !==
        cell.inputManifestHash,
    );
    expect(differing.length).toBeGreaterThan(0);
  });

  it("recomputes the stored cellSetHash exactly", () => {
    expect(
      computeNativeAdCalibrationCellSetHash(
        FROZEN.cells,
        FROZEN.contractVersion,
      ),
    ).toBe(FROZEN.cellSetHash);
  });

  it("recomputes the BATCH generation and input manifest hashes independently", () => {
    /*
      The assertion the cell-only fixture could not make. `generationContentHash`
      is where `nativeAdSpendUnitAuthorityGenerationContent` decides whether the
      store observation is part of the content, so this is the digest the
      `.v3`/`.v4` include-exclude switch actually moves. Recomputed from the
      frozen source provenance, authorities, observations and quality counts —
      nothing here is supplied by the value being checked.
    */
    const recomputed = recomputeNativeAdCalibrationBatchGenerationHashes(FROZEN);
    expect(recomputed.generationContentHash).toBe(FROZEN.generationContentHash);
    expect(recomputed.inputManifestHash).toBe(FROZEN.inputManifestHash);
  });

  it("moves the batch generation hash when the store rule is treated as legacy", () => {
    /*
      The discriminating half: if `.v3` were classified as a version that HASHES
      the store observation, this is the digest that would move. Restamping the
      authority to `.v2` is the cheapest way to ask the switch that question,
      and the answer must be "different".
    */
    const asLegacy = {
      ...FROZEN,
      spendUnitAuthority: {
        ...FROZEN.spendUnitAuthority,
        contractVersion: "engine-v3-native-ad-spend-unit-authority.v2" as const,
      },
    };
    expect(
      recomputeNativeAdCalibrationBatchGenerationHashes(asLegacy)
        .generationContentHash,
    ).not.toBe(FROZEN.generationContentHash);
  });

  it("agrees with the REAL producer, so a producer drift fails here", () => {
    /*
      ROUND 6 AUDIT ITEM 4. The recompute used to be a THIRD copy of the batch
      generation formula, beside the producer's and the durable-write
      validator's. Three copies is three chances for a field to be added to one
      and not the others, and the frozen fixture — the only check a historical
      batch gets — would then quietly verify different content than the
      producer mints.

      All three now digest `nativeAdCalibrationBatchGenerationContent`. This
      case closes the loop from the other side: a batch the producer computes
      RIGHT NOW is handed to the same recompute, and the two must agree. If a
      future edit changes the producer without changing the shared builder,
      this fails before any frozen byte is consulted.
    */
    const live = computeNativeAdCalibrationBatch({
      businessId: FROZEN.businessId,
      providerAccountRefId: FROZEN.providerAccountRefId,
      providerAccountId: FROZEN.providerAccountId,
      asOf: FROZEN.asOfDate,
      computationCutoff: FROZEN.asOfCutoff,
      sourceRows: liveSourceRows(),
      targetAuthority: {
        sourceRowId: FROZEN.targetAuthority.sourceRowId,
        operation: "upsert",
        targetCpa: FROZEN.targetAuthority.targetCpa,
        targetRoas: FROZEN.targetAuthority.targetRoas,
        breakEvenCpa: FROZEN.targetAuthority.breakEvenCpa,
        breakEvenRoas: FROZEN.targetAuthority.breakEvenRoas,
        operatorAovAssumption: FROZEN.targetAuthority.operatorAovAssumption,
        defaultRiskPosture: FROZEN.targetAuthority.defaultRiskPosture,
        effectiveAt: FROZEN.targetAuthority.effectiveAt,
        recordedAt: FROZEN.targetAuthority.recordedAt,
      },
      observedShopifyAovEvidence:
        FROZEN.spendUnitAuthority.observedShopifyAovEvidence,
    });

    const recomputed = recomputeNativeAdCalibrationBatchGenerationHashes(live);
    expect(recomputed.generationContentHash).toBe(live.generationContentHash);
    expect(recomputed.inputManifestHash).toBe(live.inputManifestHash);
    // And the live batch is the CURRENT mint, which is what makes this a
    // producer-drift check rather than a second reading of the frozen bytes.
    expect(live.spendUnitAuthority.contractVersion).toBe(
      NATIVE_AD_SPEND_UNIT_AUTHORITY_CONTRACT_VERSION,
    );
    expect(live.generationContentHash).not.toBe(FROZEN.generationContentHash);
  });

  it("carries the batch-level provenance every recompute above needs", () => {
    // Guards the fixture itself: a future regeneration that dropped one of
    // these would make the recomputes silently weaker rather than failing.
    expect(FROZEN.sourceProvenance).toBeTruthy();
    expect(FROZEN.observations.length).toBeGreaterThan(0);
    expect(FROZEN.qualityCounts).toBeTruthy();
    expect(FROZEN.sourceManifestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(FROZEN.generationContentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(FROZEN.inputManifestHash).toMatch(/^[0-9a-f]{64}$/);
    // Every cell's stored batch manifest hash agrees with the batch's own.
    for (const cell of FROZEN.cells) {
      expect(cell.batchInputManifestHash).toBe(FROZEN.inputManifestHash);
    }
  });
});

describe("readable is not the same as authoritative", () => {
  it("still hashes v1/v2 WITH the store observation, so legacy rows are untouched", () => {
    /*
      The other side of the switch. `.v1` and `.v2` genuinely hashed the store
      observation and must keep doing so, or every row minted under them stops
      verifying. Same bytes, only the version string differs: if `.v2` were
      also excluding the observation the two digests would coincide.
    */
    const cell = FROZEN.cells[0]!;
    const v3 = cell.actionReadiness.spendUnitAuthority;
    const asV2 = {
      ...v3,
      contractVersion: "engine-v3-native-ad-spend-unit-authority.v2" as const,
    };
    const v3Hash = recomputeNativeAdSpendUnitAuthorityHash(v3);
    const v2Hash = recomputeNativeAdSpendUnitAuthorityHash(asV2);
    expect(v3Hash).toBe(v3.authorityHash);
    expect(v2Hash).not.toBe(v3Hash);
  });

  it("refuses to let the frozen v3 cell authorize a current decision", async () => {
    /*
      Structurally valid and hash-verified above; still not authoritative. The
      current-authority gate is keyed on the minted contract, so a historical
      row is refused BEFORE its rungs are compared — judging an old row by
      today's ladder could either grant hard action on a retired rung or fail
      the whole native job closed.
    */
    const { resolveNativeAdAccountDecisionProfile } = await import(
      "@/lib/creative-decision-engine/ad-account-decision-profile"
    );
    /*
      STAMPED AS A PERSISTED ROW WOULD BE.

      `computeNativeAdCalibrationBatch` leaves `batchId` null and
      `batchCompleteness` unset until the row is written, and `validateCell`
      refuses on either — so an unstamped fixture is refused for a STRUCTURAL
      persistence reason and never reaches the version gate at all. Stamping
      those two (and only those two) is what makes this case exercise the
      question it is named for. Every hash on the cell is untouched, and the
      recompute above already proved they verify.
    */
    const cell = {
      ...FROZEN.cells.find(
        (candidate) => candidate.key.cellScope === "objective_cohort_context",
      )!,
      batchId: "00000000-0000-4000-8000-0000000007f3",
      batchCompleteness: "complete" as const,
      /*
        ROUND 9 ITEM 5. A persisted row now carries its own contract stamp, and
        this batch is a `.v3` one — which is precisely what the refusal below is
        about. Taken from the fixture rather than written literally, so the
        stamp cannot drift away from the formula the hashes were built with.
      */
      contractVersion: FROZEN.contractVersion,
    };
    const result = await resolveNativeAdAccountDecisionProfile({
      businessId: cell.key.businessId,
      providerAccountId: cell.key.providerAccountId,
      accountTimezone: cell.key.accountTimezone,
      accountCurrency: cell.key.accountCurrency,
      objective: cell.key.objective,
      optimizationGoal: "PURCHASE",
      customEventType: "PURCHASE",
      cohort: "purchase",
      asOf: cell.asOfDate,
      dataSource: {
        getNativeAdCalibrationCell: async () => cell,
        getNativeTargetAuthorityAsOf: async () => ({
          sourceRowId: "00000000-0000-4000-8000-000000000753",
          operation: "upsert",
          targetCpa: 50,
          targetRoas: 2,
          breakEvenCpa: 70,
          breakEvenRoas: 1.5,
          operatorAovAssumption: 100,
          defaultRiskPosture: "balanced",
          effectiveAt: "2026-07-01T00:00:00.000Z",
          recordedAt: "2026-07-01T00:00:01.000Z",
        }),
      } as never,
      flags: {
        businessId: cell.key.businessId,
        enabled: true,
        surfaceVisible: false,
        shadowOnly: false,
        presetOverride: null,
        source: {
          enabled: "env",
          surfaceVisible: "env",
          shadowOnly: "env",
          presetOverride: null,
        },
        envDefaults: { enabled: true, surfaceVisible: false, shadowOnly: false },
      } as never,
    });
    /*
      THE EXACT REFUSAL, NOT MERELY "NOT READY".

      `status !== "ready"` is satisfied by every refusal the resolver has,
      including ones that have nothing to do with the historical version — a
      missing cell, an unreadable target, a currency admission failure. What
      must be true here is specific: this cell is refused BECAUSE it is
      historical, and the reason names which contract makes it so.

      ROUND 8 MOVED WHICH GATE ANSWERS FIRST, and the reason moved with it.
      Under Round 6 this batch was current-calibration (`.v4`) and historical
      only in its SPEND-UNIT AUTHORITY (`.v3`), so it passed `validateCell` and
      was refused at the target-authority gate with
      `native_target_authority_mismatch`. Round 8 moved the calibration
      contract to `.v5` (the account CPA left the cell manifest, Cut readiness
      now holds outright without a ready spend unit, and the target row's
      clocks are read strictly), so this batch is now historical on BOTH axes
      and the FIRST gate answers: `validateCell` recomputes the manifest under
      the current contract, gets a different digest, and refuses with
      `native_calibration_contract_invalid`.

      That is the correct refusal and not a weaker one: a persisted cell that
      cannot be re-derived under the contract in force must not authorize a
      current decision, whatever its authority version says. It is also
      provably VERSION-caused rather than a structural defect — the two cases
      above show the same cell recomputing exactly under `.v4` and differing
      under `.v5`.

      `native_target_authority_mismatch` keeps its own direct coverage, on
      cells that are current-calibration and therefore reach that gate:
      `aov-native-meta-basis-authority.test.ts` and
      `ad-account-decision-profile.test.ts` both drive it.
    */
    expect(result.status).toBe("fail_closed");
    /*
      ROUND 9 ITEM 5 CHANGED THE NAME, AND THAT IS THE POINT.

      Round 8 reported `native_calibration_contract_invalid` — "this row does
      not verify" — for a row that verifies perfectly under its own contract and
      is merely OLD. The runtime had no stored version, so it recomputed with
      today's formula and could not tell the two apart; an operator debugging a
      fail-closed account was told their data was broken.

      The row now carries `.v3`, `validateCell` re-derives it under the `.v3`
      formula (which succeeds — proven by the recompute cases above), and only
      then refuses it for the real reason: this deployment does not mint `.v3`.
    */
    expect(result.reason).toBe("native_calibration_contract_superseded");
    expect(result.profile).toBeNull();
    expect(result.hardActionEligibility).toMatchObject({
      scale: false,
      cut: false,
      refresh: false,
    });
  });
});
